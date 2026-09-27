'use strict';

/**
 * WCAG contrast check for the ink ladder against every surface it lands on.
 *
 * PRODUCT.md commits Tondo to WCAG 2.2 AA, and `--ink-1..4` in styles.css are
 * translucent cream: their real contrast depends entirely on what is behind
 * them. Change a surface token and every rung moves silently. This reads the
 * live values out of public/styles.css so the check can never drift from what
 * actually ships.
 *
 *   node scripts/check-contrast.js
 *   node scripts/check-contrast.js --against '#0B0908,#14100D,#100C0A'
 *
 * The ladder's own rules, from the comment block it is declared in:
 *   --ink-1 .92  loud secondary text
 *   --ink-2 .72  10-11px caps labels — small type, needs headroom
 *   --ink-3 .58  body-size muted text — THE FLOOR FOR WORDS
 *   --ink-4 .40  glyphs, rules, decoration — never words
 *
 * AA is 4.5:1 for body text and 3:1 for large text (>=18.66px bold or 24px).
 */

const fs = require('node:fs');
const path = require('node:path');

const CSS = path.join(__dirname, '..', 'public', 'styles.css');

const AA_BODY = 4.5;
const AA_LARGE = 3.0;

function hexToRgb(hex) {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

/** sRGB relative luminance, per WCAG 2.x. */
function luminance([r, g, b]) {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Flattens a translucent foreground onto an opaque background. */
function composite(fg, alpha, bg) {
  return fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha)));
}

/** Pulls `--name: #hex;` out of the stylesheet's :root block. */
function readToken(css, name) {
  const m = css.match(new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})\\s*;`));
  return m ? m[1] : null;
}

/** Pulls `--ink-N: rgba(r,g,b,a);` and returns [rgb, alpha]. */
function readInk(css, name) {
  const m = css.match(new RegExp(`--${name}\\s*:\\s*rgba\\(([^)]+)\\)\\s*;`));
  if (!m) return null;
  const parts = m[1].split(',').map((s) => Number(s.trim()));
  return { rgb: parts.slice(0, 3), alpha: parts[3] };
}

function main() {
  const css = fs.readFileSync(CSS, 'utf8');

  const argv = process.argv.slice(2);
  const at = argv.indexOf('--against');
  const surfaces = at >= 0
    ? argv[at + 1].split(',').map((s) => ({ name: s.trim(), hex: s.trim() }))
    : ['page', 'shell', 'tray-bg', 'page-glow'].map((n) => ({ name: n, hex: readToken(css, n) }));

  const rungs = ['ink-1', 'ink-2', 'ink-3', 'ink-4']
    .map((n) => ({ name: n, ...readInk(css, n) }))
    .filter((r) => r.rgb);

  if (!rungs.length) { console.error('could not read the ink ladder from styles.css'); process.exit(1); }

  console.log('\nInk ladder vs surfaces, read live from public/styles.css\n');
  const header = ['rung'.padEnd(12), ...surfaces.map((s) => `${s.name} ${s.hex}`.padEnd(20))].join('');
  console.log(header);
  console.log('-'.repeat(header.length));

  let failures = 0;
  for (const rung of rungs) {
    // --ink-4 is declared decoration-only, so it is reported but not gated.
    const isWords = rung.name !== 'ink-4';
    const floor = rung.name === 'ink-2' ? AA_BODY : (isWords ? AA_BODY : AA_LARGE);
    const cells = surfaces.map((s) => {
      if (!s.hex) return 'n/a'.padEnd(20);
      const bg = hexToRgb(s.hex);
      const r = ratio(composite(rung.rgb, rung.alpha, bg), bg);
      const ok = r >= floor;
      if (isWords && !ok) failures++;
      return `${r.toFixed(2)}:1 ${isWords ? (ok ? 'PASS' : 'FAIL') : '(deco)'}`.padEnd(20);
    });
    console.log(`${(rung.name + ' ' + rung.alpha).padEnd(12)}${cells.join('')}`);
  }

  console.log(`\nGate: ${AA_BODY}:1 for every rung that carries words (ink-1..3).`);
  console.log('ink-4 is declared decoration-only in styles.css and is reported, not gated.\n');

  if (failures) {
    console.error(`FAIL: ${failures} rung/surface combination(s) below AA.\n`);
    process.exit(1);
  }
  console.log('All word-carrying rungs clear AA on every surface.\n');
}

main();
