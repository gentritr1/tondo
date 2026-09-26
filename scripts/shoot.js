'use strict';

/**
 * Tondo capture harness — headless Chrome over CDP.
 *
 * Why this exists: the Browser pane cannot be trusted for motion work. A hidden
 * or unfocused surface throttles rAF to zero, freezes CSS transitions and WAAPI
 * mid-flight, and has been observed to composite the wrong colour. Every claim
 * about an animation therefore has to come from a surface we know is visible and
 * ticking — this one asserts `document.hidden === false` before it captures.
 *
 * Usage:
 *   node scripts/shoot.js --out docs/qa --scene game
 *   node scripts/shoot.js --out /tmp/shots --scene game --w 390 --h 844 --tag mobile
 *   node scripts/shoot.js --out /tmp/shots --scene game --reduced
 *   node scripts/shoot.js --probe "document.getAnimations().length"
 *   node scripts/shoot.js --out /tmp/shots --scene mock:yourTurn --probe "…" --no-settle --wait 480
 *   node scripts/shoot.js --scene none --path "/?code=BASIL-4821" --storage-json '{"tondo.name":"Gent"}'
 *   node scripts/shoot.js --scene mock:yourTurn --prelude scripts/probes/haptics-stub.js --query novibrate
 *   node scripts/shoot.js --scene mock:pieComplete --clipboard --probe "…navigator.clipboard.readText()…"
 *
 * Scenes: home, lobby, game, roundOver, pieComplete, mock:<name>, none.
 *   `none` loads the page and stops — no driving at all, for the screens that
 *   ARE the thing under test (the home card, an invite link seating itself).
 *
 * --path <p>          navigate to ORIGIN + p instead of ORIGIN, so a probe can
 *                     be handed a real query string ("/?code=BASIL-4821").
 *                     A missing leading slash is added. Ignored by mock:
 *                     scenes, which build their own URL.
 * --storage-json <j>  a JSON object installed into localStorage BEFORE the app
 *                     boots (Page.addScriptToEvaluateOnNewDocument), every set
 *                     wrapped in try/catch. Values are stored as strings, so a
 *                     JSON value goes in as a JSON string:
 *                     '{"tondo.name":"Gent","tondo.lastTable":"{\"code\":…}"}'
 * --prelude <file>    a JS file evaluated on the NEW document, before the first
 *                     line of app.js runs (Page.addScriptToEvaluateOnNewDocument).
 *                     `--storage-json` seeds VALUES the app will read; this
 *                     replaces APIs the app will call — a recording stub for
 *                     `navigator.vibrate` has to be installed before the module
 *                     that captures it is even fetched, so a stub written after
 *                     navigation is not the same test.
 * --query <q>         a raw query fragment appended to the target URL, so a
 *                     prelude can branch on `location.search` ("novibrate").
 *                     A mock scene already carries `?mock=1&scene=…`, so it is
 *                     joined with `&`; any other target gets `?` unless it has
 *                     one already.
 * --clipboard         grants `clipboardReadWrite` + `clipboardSanitizedWrite`
 *                     for the target origin (CDP Browser.grantPermissions)
 *                     before navigating, so a probe can call
 *                     `navigator.clipboard.readText()` and get back what a
 *                     click actually wrote, not just that the click happened.
 *                     Grant, not stub: this exercises the real Clipboard API.
 *                     Also calls `Page.bringToFront` right before the probe
 *                     runs: the Clipboard API throws `NotAllowedError:
 *                     Document is not focused` on a freshly-navigated
 *                     headless page otherwise, permissions granted or not —
 *                     this bit an early run of --clipboard and is worth not
 *                     rediscovering.
 *                     To prove the ABSENT-clipboard fallback instead, delete
 *                     `navigator.clipboard` from inside the --probe itself,
 *                     before it clicks — that is a page-side condition, not a
 *                     CDP one, so there is no separate flag for it.
 *
 * The server must already be running (npm start on :4600, or TONDO_URL).
 */

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const WebSocket = require('ws');

const CHROME = process.env.CHROME_BIN
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
/* A FIXED debug port is a trap: a previous run's Chrome can outlive its
   launcher (headless=new detaches a process tree), and the next run then
   attaches to a zombie still sitting on about:blank. That looked exactly like
   a broken driver — 628 no-op ticks against a browser that had never
   navigated. Chrome is started on port 0 instead and reports the port it
   actually took in DevToolsActivePort, so every run owns its own browser. */
const ORIGIN = process.env.TONDO_URL || 'http://localhost:4600';

// --------------------------------------------------------------------- args
function parseArgs(argv) {
  const a = { out: null, scene: 'game', w: 1440, h: 900, dsf: 2, tag: '', reduced: false, probe: null, bots: 3, keep: false, settle: true, wait: 0, path: null, storage: null, prelude: null, query: null, clipboard: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--out') a.out = argv[++i];
    else if (k === '--scene') a.scene = argv[++i];
    else if (k === '--w') a.w = Number(argv[++i]);
    else if (k === '--h') a.h = Number(argv[++i]);
    else if (k === '--dsf') a.dsf = Number(argv[++i]);
    else if (k === '--tag') a.tag = argv[++i];
    else if (k === '--bots') a.bots = Number(argv[++i]);
    else if (k === '--reduced') a.reduced = true;
    else if (k === '--keep') a.keep = true;
    else if (k === '--clipboard') a.clipboard = true;
    else if (k === '--probe') a.probe = argv[++i];
    // A specific URL, and storage that exists before the first line of app.js
    // runs: the two things a "what does this page do on load" probe needs.
    else if (k === '--path') {
      // `--path foo` would otherwise concatenate into "http://host:4707foo".
      const v = argv[++i];
      a.path = (v && !v.startsWith('/')) ? '/' + v : v;
    }
    else if (k === '--storage-json') a.storage = argv[++i];
    // The other half of "before the app boots": code, not values. A stub for a
    // browser API the app captures at import time has to exist on the new
    // document or the app never sees it.
    else if (k === '--prelude') a.prelude = argv[++i];
    else if (k === '--query') {
      // A leading ?/& is tolerated; the separator is decided against the real
      // target below, not guessed here.
      const v = argv[++i];
      a.query = v ? v.replace(/^[?&]+/, '') : v;
    }
    // A mid-animation frame: skip the finish-every-animation settle, and hold
    // for a fixed time after the probe so the capture lands at a known moment.
    else if (k === '--no-settle') a.settle = false;
    else if (k === '--wait') a.wait = Number(argv[++i]);
  }
  return a;
}

// ---------------------------------------------------------------- CDP client
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }

  static async attach(port) {
    // A fresh Chrome profile takes a while before /json answers. Poll.
    const deadline = Date.now() + 90000;
    let target = null;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json`);
        const list = await res.json();
        target = list.find((t) => t.type === 'page');
        if (target && target.webSocketDebuggerUrl) break;
      } catch { /* not up yet */ }
      await sleep(250);
    }
    if (!target) throw new Error(`no CDP page target on :${port} after 60s`);
    const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
    await new Promise((ok, bad) => { ws.once('open', ok); ws.once('error', bad); });
    const cdp = new Cdp(ws);
    ws.on('message', (raw) => cdp._onMessage(raw));
    return cdp;
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data || '')})`));
      else resolve(msg.result);
    } else if (msg.method) {
      this.events.push(msg);
    }
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} timed out`)); }
      }, 30000);
    });
  }

  /** Evaluate an expression in the page and return its value (awaits promises). */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`page eval threw: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    }
    return r.result.value;
  }

  /** Poll an expression until it is truthy. Returns the value. */
  async until(expression, { timeout = 20000, every = 100, what = expression } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const v = await this.eval(expression).catch(() => undefined);
      if (v) return v;
      await sleep(every);
    }
    throw new Error(`timed out waiting for: ${what}`);
  }

  /** Uncaught exceptions and console.error output seen since attach. */
  pageErrors() {
    const out = [];
    for (const m of this.events) {
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params && m.params.exceptionDetails;
        out.push((d && (d.exception?.description || d.text)) || 'unknown exception');
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        out.push((m.params.args || []).map((a) => a.value ?? a.description ?? '?').join(' '));
      } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        out.push(m.params.entry.text);
      }
    }
    return out;
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------- boot
/** Reads the port Chrome actually bound, written once it is listening. */
async function readDevToolsPort(userDataDir) {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      const first = fs.readFileSync(file, 'utf8').split('\n')[0].trim();
      if (first) return Number(first);
    } catch { /* not written yet */ }
    await sleep(150);
  }
  throw new Error('Chrome never wrote DevToolsActivePort — it failed to start');
}

async function launchChrome(userDataDir) {
  const child = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--force-device-scale-factor=1',
    '--hide-scrollbars',
    // Headless has no speakers, but an AudioContext still has to reach the
    // 'running' state for sound wiring to be observable at all.
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ], { stdio: 'ignore' });
  return child;
}

/**
 * Kill only THIS run's browser.
 *
 * The obvious version — `process.kill(-child.pid)` — kills a process GROUP, and
 * a group id is just a pid: if the browser has already exited and the OS has
 * recycled its pid, that signal lands on whatever now owns it. Matching on the
 * per-run `--user-data-dir` instead cannot be ambiguous, because that path is
 * freshly generated for every run.
 */
function killTree(child, userDataDir) {
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  try {
    const out = execSync(`pgrep -f ${JSON.stringify(userDataDir)} || true`, { encoding: 'utf8' });
    for (const pid of out.split('\n').map((n) => Number(n.trim())).filter(Boolean)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone between listing and killing */ }
    }
  } catch { /* pgrep unavailable; the SIGTERM above is the fallback */ }
}

/**
 * Drives a real bot game to the requested scene. Scripted rather than mocked:
 * `?mock=1` snapshots cannot prove anything about the live socket path.
 */
async function driveTo(cdp, scene, bots) {
  await cdp.until(`document.readyState === 'complete'`, { what: 'page load' });
  // `mock:<name>` pins the client to one scripted beat via public/js/mock.js —
  // the only way to reach a specific bar/layout state deterministically.
  if (scene.startsWith('mock:')) {
    await cdp.until(`document.body.dataset.screen === 'game'`, { what: 'mock game screen' });
    return;
  }
  // The socket takes a moment; the create button rejects until it is open.
  await cdp.until(
    `(() => { const n = document.getElementById('name-input'); if (!n) return false;
      n.value = 'Gent'; n.dispatchEvent(new Event('input', {bubbles:true}));
      document.getElementById('create-btn').click();
      return document.body.dataset.screen === 'lobby'; })()`,
    { timeout: 20000, what: 'lobby (socket open + room created)' },
  );
  if (scene === 'lobby') return;

  for (let i = 0; i < bots; i++) {
    await cdp.eval(`document.getElementById('addbot-btn').click()`);
    await sleep(180);
  }
  await cdp.until(
    `document.querySelectorAll('#seat-list li').length >= ${bots + 1}`,
    { what: `${bots} bots seated` },
  );
  await cdp.eval(`document.getElementById('start-btn').click()`);
  await cdp.until(`document.body.dataset.screen === 'game'`, { what: 'game screen' });
  await cdp.until(`document.querySelectorAll('#hand-row .card').length > 0`, { what: 'hand dealt' });
  if (scene === 'game') return;

  if (scene === 'roundOver' || scene === 'pieComplete') {
    // pieComplete keeps dealing until the four-slice match is finished.
    const wantPie = scene === 'pieComplete';
    // Play greedily whenever it is our turn; the bots do the rest. A full round
    // is bounded — if it has not ended in 120s something is wrong, and saying so
    // is better than capturing a half-state and calling it "round over".
    // One round runs 60-90s against bots that pause 1.4-2.6s per move, so a
    // whole four-slice pie needs roughly four times the budget.
    const deadline = Date.now() + (wantPie ? 900000 : 240000);
    const trace = [];
    while (Date.now() < deadline) {
      const done = await cdp.eval(`(() => {
        // Round over is ONLY the win banner (tone class 'win') together with the
        // host's "New round" button. The same banner element also carries
        // "YOUR TURN", and treating that as the transition captured a mid-round
        // screen and labelled it roundOver.
        const b = document.getElementById('banner');
        const nr = document.getElementById('newround-btn');
        if (b && !b.hidden && b.classList.contains('win') && nr && !nr.hidden) return 'over';
        // The wild picker MUST be handled before the drawn-card bar. Playing a
        // drawn WILD opens the picker while the drawn bar is still showing, so
        // checking drawn first re-clicks "Play it" forever and the round never
        // advances — 1855 no-op clicks in one run before this was fixed.
        const wild = document.getElementById('wild-bar');
        if (wild && !wild.hidden) {
          const opt = wild.querySelector('#wild-grid button');
          if (opt) { opt.click(); return 'wild'; }
        }
        const drawn = document.getElementById('drawn-bar');
        if (drawn && !drawn.hidden) {
          const p = document.getElementById('drawn-play');
          if (p && !p.disabled && p.offsetParent !== null) { p.click(); return 'drawn-play'; }
          document.getElementById('drawn-keep').click(); return 'drawn-keep';
        }
        const t = document.getElementById('tondo-btn');
        if (t && t.offsetParent !== null && !document.getElementById('tondo-bar').hidden) t.click();
        const c = document.querySelector('#hand-row .card.is-playable');
        if (c) { c.click(); return 'play'; }
        // The draw affordance moves between breakpoints: the tray's Draw button
        // is display:none on desktop (styles.css:1844) where the deck beside the
        // hand takes over, and the deck is display:none in the phone band. Try
        // both — driving only the button stalled every desktop run at 'wait'.
        const d = document.getElementById('draw-btn');
        if (d && !d.disabled && !d.hidden && d.offsetParent !== null) { d.click(); return 'draw'; }
        const deck = document.getElementById('deck');
        if (deck && !deck.disabled && deck.offsetParent !== null) { deck.click(); return 'draw-deck'; }
        return 'wait';
      })()`);
      if (done === 'over') {
        if (!wantPie) return;
        const complete = await cdp.eval(
          `(() => { const t = document.getElementById('score-title');
            return !!(t && /takes the pie|shared/i.test(t.textContent)); })()`);
        if (complete) return;
        // Deal the next slice and carry on.
        await cdp.eval(`(() => { const b = document.getElementById('newround-btn');
          if (b && !b.hidden && !b.disabled) b.click(); return true; })()`);
        await sleep(700);
        trace.push('next-slice');
        continue;
      }
      trace.push(done);
      await sleep(380);
    }
    // Report WHAT the loop was doing, not just that it failed: a driver stuck on
    // 'wait' is a different bug from one that played 200 cards without a winner.
    const tally = trace.reduce((m, k) => (m[k] = (m[k] || 0) + 1, m), {});
    throw new Error(`${wantPie ? 'pie' : 'round'} did not finish in time — driver actions: ${JSON.stringify(tally)}`);
  }
}

// ------------------------------------------------------------------ capture
async function shoot(cdp, file, { settle = true } = {}) {
  // A hidden surface throttles rAF to zero and freezes transitions mid-flight:
  // a screenshot taken there is not evidence. Assert, do not assume.
  const hidden = await cdp.eval(`document.hidden`);
  if (hidden) throw new Error('document.hidden === true — refusing to capture (rAF is throttled; the image would not be evidence)');
  if (settle) {
    await cdp.eval(`document.getAnimations().forEach(a => { try { a.finish(); } catch {} }); true`);
    await sleep(120);
  }
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  const kb = (fs.statSync(file).size / 1024).toFixed(0);
  return `${file} (${kb}KB)`;
}

// --------------------------------------------------------------------- main
async function main() {
  const a = parseArgs(process.argv.slice(2));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tondo-cdp-'));
  const chrome = await launchChrome(userDataDir);
  let cdp;
  try {
    const port = await readDevToolsPort(userDataDir);
    cdp = await Cdp.attach(port);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable').catch(() => { /* older builds */ });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: a.w, height: a.h, deviceScaleFactor: a.dsf, mobile: a.w < 768,
    });
    if (a.reduced) {
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
    }
    if (a.clipboard) {
      // Headless Chrome otherwise prompts (and hangs) on the first real
      // clipboard write; granting it up front is what lets a probe read back
      // the TEXT that reached the clipboard instead of only observing that a
      // click occurred.
      await cdp.send('Browser.grantPermissions', {
        origin: ORIGIN,
        permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
      });
      console.log(`clipboard permissions granted for ${ORIGIN}`);
    }
    if (a.storage) {
      let entries;
      try { entries = Object.entries(JSON.parse(a.storage)); }
      catch (err) { throw new Error(`--storage-json is not a JSON object: ${err.message}`); }
      // Installed on the NEW document, so the values are already there when
      // app.js reads them at boot — setting them after navigate would be a
      // different test. Guarded: a private window throws on the first touch.
      const sets = entries
        .map(([k, v]) => `localStorage.setItem(${JSON.stringify(String(k))}, ${JSON.stringify(String(v))});`)
        .join(' ');
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { ${sets} } catch (e) {}` });
      console.log(`seeded ${entries.length} localStorage key(s): ${entries.map(([k]) => k).join(', ')}`);
    }
    if (a.prelude) {
      // Read here rather than passed as a string: a stub is a file that can be
      // reviewed and diffed, and a typo in it should fail the run loudly.
      let source;
      try { source = fs.readFileSync(a.prelude, 'utf8'); }
      catch (err) { throw new Error(`--prelude cannot be read: ${err.message}`); }
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
      console.log(`prelude installed on new document: ${a.prelude} (${source.length} bytes)`);
    }
    const matched = await (async () => {
      let target = a.scene.startsWith('mock:')
        ? `${ORIGIN}/?mock=1&scene=${a.scene.slice(5)}`
        : (a.path ? ORIGIN + a.path : ORIGIN);
      if (a.query) target += (target.includes('?') ? '&' : '?') + a.query;
      await cdp.send('Page.navigate', { url: target });
      console.log(`navigating to ${target}`);
      await cdp.until(`document.readyState === 'complete'`, { what: 'load' });
      return cdp.eval(`matchMedia('(prefers-reduced-motion: reduce)').matches`);
    })();
    if (a.reduced && !matched) throw new Error('reduced-motion emulation did not take — the capture would be an invalid control');
    console.log(`chrome ${a.w}x${a.h}@${a.dsf}x  reduced-motion=${matched}`);

    // `none` is the page as it loads itself: driving it would destroy the
    // very behaviour a boot-time probe is there to watch.
    if (a.scene === 'none') await cdp.until(`document.readyState === 'complete'`, { what: 'page load' });
    else await driveTo(cdp, a.scene, a.bots);

    if (a.clipboard) {
      // The Clipboard API refuses readText/writeText on an unfocused document
      // ("Document is not focused"), and a freshly-navigated headless page is
      // not focused by default.
      await cdp.send('Page.bringToFront').catch(() => { /* older builds lack it */ });
    }
    if (a.probe) {
      const v = await cdp.eval(a.probe);
      console.log(JSON.stringify(v, null, 2));
    }
    if (a.wait) await sleep(a.wait);
    if (a.out) {
      const tag = [a.scene.replace(':', '-'), a.tag, `${a.w}x${a.h}`, a.reduced ? 'reduced' : ''].filter(Boolean).join('-');
      console.log('wrote ' + await shoot(cdp, path.join(a.out, `${tag}.png`), { settle: a.settle }));
    }
    // A screenshot of a page that threw is not evidence of anything. Errors
    // are reported after the capture so the image is still written, but they
    // are never silent.
    const errors = cdp.pageErrors();
    if (errors.length) {
      console.error(`\n${errors.length} page error(s):`);
      for (const e of errors.slice(0, 10)) console.error('  ' + e);
      process.exitCode = 2;
    } else {
      console.log('no page errors');
    }
    if (a.keep) { console.log('keeping browser open; ctrl-c to exit'); await sleep(600000); }
  } finally {
    if (cdp) cdp.close();
    killTree(chrome, userDataDir);
    // Chrome keeps writing its cache for a moment after SIGTERM; a failed rmdir
    // here would mask the real result of the run, so it never throws.
    if (!a.keep) {
      await sleep(300);
      try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
      catch { /* the OS will reap it */ }
    }
  }
}

main().catch((err) => { console.error('FAILED:', err.message); process.exit(1); });
