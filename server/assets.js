'use strict';

/**
 * Static asset pipeline for a project with no build step.
 *
 * Three jobs, in the order they matter to the bill and to the player:
 *
 * 1. COMPRESSION. 242KB of HTML/CSS/JS shipped raw on every visit. Brotli takes
 *    that to roughly a quarter of the size. Encoded copies are built once, on
 *    first request, and kept in memory — there are five text files.
 *
 * 2. CONTENT HASHING, so the cache headers can be honest. The rule is: never
 *    ship an unhashed asset with a long max-age, and never ship a hashed one
 *    without it. With no bundler to rename files, the hash rides in a query
 *    string that the server itself stamps into the referring document — see
 *    `stamp()`. HTML is never hashed (it is the entry point, so it must
 *    revalidate); CSS/JS referenced from it are, and get a year of immutable.
 *
 *    The hash is TRANSITIVE. app.js imports net.js, so hashing app.js by its
 *    own bytes alone would leave a year-cached app.js pointing at a year-cached
 *    net.js — a change to net.js would never reach anyone. A file's hash
 *    therefore mixes in the hashes of everything it references.
 *
 * 3. REVALIDATION. Everything gets a strong ETag, so even the unhashed entry
 *    document costs a 304 and not a re-download.
 *
 * In dev (`TONDO_DEV=1`, or simply not production) files are re-read and
 * re-hashed whenever mtime moves, so editing a file still works without a
 * restart. In production each file is read once.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const TEXT_TYPES = new Set(['.html', '.css', '.js', '.svg', '.json', '.webmanifest']);

/* Only these are rewritten to carry a hash, and only these are scanned for
   references. Images are referenced from CSS, which is itself hashed, so a
   changed image reaches the client as soon as the CSS that names it does. */
const HASHABLE = new Set(['.css', '.js']);

/* Quoted relative references to a local .js/.css file: `href="./styles.css"`,
   `import x from './net.js'`, `import('./js/app.js')`. Deliberately narrow —
   it must never touch an absolute URL or a bare module specifier. */
const REF_RE = /(["'`])(\.{1,2}\/[A-Za-z0-9_./-]+?\.(?:js|css))\1/g;

const MAX_STAMP_DEPTH = 8;

class Assets {
  /**
   * @param {string} root absolute path of the directory served
   * @param {{dev?: boolean}} [opts]
   */
  constructor(root, opts = {}) {
    this.root = root;
    this.dev = opts.dev !== undefined ? opts.dev : process.env.NODE_ENV !== 'production';
    /** @type {Map<string, object>} keyed by absolute path */
    this.cache = new Map();
  }

  /** Reads a file and its metadata, re-reading in dev when mtime moves. */
  load(absPath) {
    let stat;
    try {
      stat = fs.statSync(absPath);
      if (!stat.isFile()) return null;
    } catch {
      return null;
    }
    const hit = this.cache.get(absPath);
    if (hit && (!this.dev || hit.mtimeMs === stat.mtimeMs)) return hit;

    let raw;
    try {
      raw = fs.readFileSync(absPath);
    } catch {
      return null;
    }
    const ext = path.extname(absPath).toLowerCase();
    const entry = {
      raw,
      ext,
      mtimeMs: stat.mtimeMs,
      ownHash: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12),
      // Filled lazily: stamping and compression cost nothing until asked for.
      hash: null,
      stamped: null,
      encoded: new Map(),
    };
    this.cache.set(absPath, entry);
    return entry;
  }

  /**
   * The hash a referrer should use for this file: its own bytes mixed with the
   * hashes of everything it references, so a change anywhere in the graph
   * changes the URL at the top of it. `seen` breaks reference cycles — a cycle
   * falls back to the file's own hash rather than recursing forever.
   */
  hashOf(absPath, seen = new Set()) {
    const entry = this.load(absPath);
    if (!entry) return null;
    if (entry.hash && !this.dev) return entry.hash;
    if (seen.has(absPath)) return entry.ownHash;
    seen.add(absPath);

    let hash = entry.ownHash;
    if (TEXT_TYPES.has(entry.ext)) {
      const deps = [];
      for (const [, , ref] of entry.raw.toString('utf8').matchAll(REF_RE)) {
        const target = this.resolve(absPath, ref);
        if (!target) continue;
        const dep = this.hashOf(target, seen);
        if (dep) deps.push(`${ref}:${dep}`);
      }
      if (deps.length) {
        hash = crypto.createHash('sha256')
          .update(entry.ownHash)
          .update(deps.sort().join('|'))
          .digest('hex')
          .slice(0, 12);
      }
    }
    entry.hash = hash;
    return hash;
  }

  /** Resolves a relative reference from a file, refusing to escape the root. */
  resolve(fromAbs, ref) {
    const target = path.resolve(path.dirname(fromAbs), ref.split(/[?#]/)[0]);
    if (target !== this.root && !target.startsWith(this.root + path.sep)) return null;
    return fs.existsSync(target) ? target : null;
  }

  /**
   * Rewrites local .js/.css references to carry `?v=<transitive hash>`, so the
   * things they point at can be cached immutably for a year and still change
   * the instant their content does.
   */
  stamp(absPath, depth = 0) {
    const entry = this.load(absPath);
    if (!entry) return null;
    if (entry.stamped && !this.dev) return entry.stamped;
    if (!TEXT_TYPES.has(entry.ext) || depth > MAX_STAMP_DEPTH) {
      entry.stamped = entry.raw;
      return entry.stamped;
    }
    const text = entry.raw.toString('utf8').replace(REF_RE, (whole, q, ref) => {
      const target = this.resolve(absPath, ref);
      if (!target || !HASHABLE.has(path.extname(target).toLowerCase())) return whole;
      const h = this.hashOf(target);
      if (!h) return whole;
      const sep = ref.includes('?') ? '&' : '?';
      return `${q}${ref}${sep}v=${h}${q}`;
    });
    entry.stamped = Buffer.from(text, 'utf8');
    return entry.stamped;
  }

  /**
   * Everything a response needs for one file, or null if it is not servable.
   * `hashed` is true when the request carried a `v=` that matches the file's
   * current hash — the only case where a long max-age is honest.
   */
  serve(absPath, { accept = '', versionQuery = null } = {}) {
    const entry = this.load(absPath);
    if (!entry) return null;

    const body = this.stamp(absPath);
    if (!body) return null;

    const hash = this.hashOf(absPath);
    const hashed = Boolean(versionQuery) && versionQuery === hash;
    const etag = `"${crypto.createHash('sha256').update(body).digest('hex').slice(0, 16)}"`;

    // A hashed URL can never go stale: its name changes when its bytes do.
    // Anything else must revalidate, which an ETag makes cheap (304, no body).
    const cacheControl = hashed
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=0, must-revalidate';

    const encoding = this.pickEncoding(entry, accept);
    const payload = encoding ? this.encode(entry, body, encoding) : body;

    return { body: payload, etag, cacheControl, encoding, ext: entry.ext };
  }

  /** Brotli where offered (it wins on text), gzip otherwise, raw for binaries. */
  pickEncoding(entry, accept) {
    if (!TEXT_TYPES.has(entry.ext)) return null;
    if (entry.raw.length < 1024) return null; // smaller than a packet; not worth it
    if (/\bbr\b/.test(accept)) return 'br';
    if (/\bgzip\b/.test(accept)) return 'gzip';
    return null;
  }

  encode(entry, body, encoding) {
    const key = `${encoding}:${body.length}`;
    const hit = entry.encoded.get(key);
    if (hit) return hit;
    const out = encoding === 'br'
      ? zlib.brotliCompressSync(body, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length,
        },
      })
      : zlib.gzipSync(body, { level: 9 });
    entry.encoded.set(key, out);
    return out;
  }
}

module.exports = { Assets };
