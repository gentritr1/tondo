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
 *   node scripts/shoot.js --check
 *   node scripts/shoot.js --check --update-docs
 *
 * --check         starts its own server on a free port (never :4600 or a
 *                 task's own port — this owns its whole lifecycle: spawn,
 *                 wait for GET /health, kill on exit whether the run passes
 *                 or fails), then runs the fixed regression suite below and
 *                 sets a non-zero exit code if anything fails. This is the
 *                 only mode `npm run shoot` invokes. It also captures every
 *                 mock scene at every reference viewport into the git-ignored
 *                 `.superpowers/qa-latest/`, so a failing run still leaves
 *                 something to look at.
 *                   tray-selector   `.stage.is-compressed ~ .tray` really
 *                                   matches AND its rule actually applies
 *                                   (`.tray`'s computed overflow-y is
 *                                   `auto`) — the DOM-sibling match alone
 *                                   stays true even when the stylesheet
 *                                   combinator regresses from `~` to `+`,
 *                                   because that is a fact about markup
 *                                   order, not about which CSS rule won; a
 *                                   `+` here once matched nothing, silently,
 *                                   and the Leave button it was written to
 *                                   save stayed unreachable for a full task
 *                                   cycle).
 *                   leave-reachable `#game-leave` is on screen after
 *                                   scrolling the GAME SCREEN'S OWN scroll
 *                                   container to the bottom. That container
 *                                   is `.tray` (styles.css:2260-2265,
 *                                   2382-2393), not the document — `html,
 *                                   body { overflow: hidden }` (364-367)
 *                                   makes `document.scrollingElement` report
 *                                   scrollHeight===clientHeight===0 always,
 *                                   which reads exactly like "trapped
 *                                   off-screen" and is not.
 *                   strip-fits      nothing in `.strip-inner` extends past the
 *                                   bar's content edge at 320/360/390/1280.
 *                                   The bar is one non-wrapping row, so a
 *                                   chip that grows pushes `?` — the only
 *                                   route into the rules — off the viewport,
 *                                   and nothing there scrolls. Asserted on
 *                                   the BUTTON'S right edge, because the
 *                                   standings clause was signed off by
 *                                   measuring the CHIP at 1280x800 and shipped
 *                                   `?` 17.2px off screen at 390x844.
 *                   seat-plaque-gap scripts/probes/seat-plaque-gap.js
 *                                   `pass: true` across the desktop/tablet
 *                                   widths it was written for.
 *                   banner-clear    the seat ring stands down at round over
 *                                   (`seatsVisible === 0`) AND the banner
 *                                   clears the seats in the states where they
 *                                   are on screen — YOUR TURN and all three
 *                                   context bars. Asserting "no overlap" at
 *                                   round over itself would pass against
 *                                   nothing: the seats are `display: none`
 *                                   there and a zero-size rect intersects
 *                                   nothing.
 *                   no-page-errors  zero page errors across every page this
 *                                   run loaded (assertions AND captures),
 *                                   except the one Chrome intervention
 *                                   message round-boundary.js's synthetic tap
 *                                   always produces (see the comment at its
 *                                   check, below) — not an application error.
 *                   contrast        `node scripts/check-contrast.js` exits 0.
 *                 One Chrome browser process is reused for the whole run
 *                 (spawning 70+ fresh Chrome processes serially would make
 *                 this too slow to run before every commit), but every
 *                 scene is a fresh `Page.navigate` — a full document reload,
 *                 not a re-render — and a script installed once with
 *                 `Page.addScriptToEvaluateOnNewDocument` clears
 *                 localStorage/sessionStorage before the app boots on every
 *                 one of those navigations. That is what "fresh page" means
 *                 here: no DOM, no timers, no monkey-patched prototype, and
 *                 no persisted `tondo.*` key survives from one scene into
 *                 the next, even though the browser process does.
 * --update-docs   with --check, also writes the curated 8-file set into
 *                 `docs/qa/` (the ones worth committing), on top of the full
 *                 capture into `.superpowers/qa-latest/`.
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

const { spawn, execSync, spawnSync } = require('node:child_process');
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
  const a = { out: null, scene: 'game', w: 1440, h: 900, dsf: 2, tag: '', reduced: false, probe: null, bots: 3, keep: false, settle: true, wait: 0, path: null, storage: null, prelude: null, query: null, clipboard: false, check: false, updateDocs: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--out') a.out = argv[++i];
    else if (k === '--check') a.check = true;
    else if (k === '--update-docs') a.updateDocs = true;
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

// ------------------------------------------------------------------- check
/** Finds a free TCP port by asking the OS for one and immediately releasing it. */
async function getFreePort() {
  const net = require('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** Polls GET /health until it answers `{ ok: true }` or the timeout expires. */
async function waitForHealth(origin, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/health`);
      if (res.ok) {
        const body = await res.json();
        if (body && body.ok) return body;
      }
    } catch (err) { lastErr = err; }
    await sleep(150);
  }
  throw new Error(`server never answered GET ${origin}/health within ${timeoutMs}ms`
    + (lastErr ? ` (last error: ${lastErr.message})` : ''));
}

// The 8 scenes and 5 reference viewports the full `.superpowers/qa-latest/`
// capture covers. Kept as one list so the capture and the assertions that
// reuse the same scenes cannot silently drift apart.
const CHECK_SCENES = ['yourTurn', 'opponents', 'tondo', 'callout', 'drawn', 'wild', 'roundOver', 'pieComplete'];
const CHECK_SIZES = [[320, 568], [360, 640], [390, 844], [852, 393], [1280, 800]];

// The curated set worth committing to docs/qa/ — the screens a reviewer
// actually needs, not every scene at every size.
const CURATED_QA = [
  ['yourTurn', 390, 844], ['yourTurn', 1280, 800],
  ['callout', 390, 844], ['callout', 1280, 800], ['callout', 360, 640],
  ['roundOver', 390, 844], ['roundOver', 1280, 800],
  ['pieComplete', 1280, 800],
];

/**
 * `--check`: the regression suite. Owns a server (its own free port) and one
 * Chrome browser for its whole lifetime, both torn down in `finally` whether
 * the run passes, fails, or throws. Returns nothing; sets `process.exitCode`.
 */
async function runCheck(a) {
  const root = path.join(__dirname, '..');
  const results = [];
  let hardError = null;

  const record = (group, label, pass, detail) => {
    results.push({ group, label, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${group.padEnd(16)}${label.padEnd(28)}${detail}`);
  };

  const port = await getFreePort();
  const origin = `http://localhost:${port}`;
  console.log(`--check: launching server on ${origin} (PORT=${port}, never :4600)`);
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: Object.assign({}, process.env, { PORT: String(port) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  let serverExitedEarly = false;
  server.once('exit', (code, sig) => {
    if (code !== 0 && code !== null) serverExitedEarly = true;
    if (code !== null && code !== 0) console.error(`server exited early: code=${code} sig=${sig}\n${serverLog}`);
  });

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tondo-check-'));
  const chrome = await launchChrome(userDataDir);
  let cdp;

  try {
    await waitForHealth(origin).catch((err) => {
      if (serverExitedEarly) throw new Error(`server exited before answering /health:\n${serverLog}`);
      throw err;
    });
    console.log(`server healthy at ${origin}`);

    const devPort = await readDevToolsPort(userDataDir);
    cdp = await Cdp.attach(devPort);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable').catch(() => { /* older builds */ });
    // "Fresh Chrome page" per scene without paying for 70+ fresh Chrome
    // PROCESSES: every Page.navigate below is a full document reload (new
    // globals, new listeners, nothing left running from the last scene), and
    // this script — installed once, evaluated before every one of those new
    // documents — clears the persisted `tondo.*` localStorage keys before
    // app.js ever reads them. Without it, the SAME profile persists
    // localStorage across navigations, so a later scene could silently
    // inherit a setting an earlier scene wrote.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}',
    });

    /** Navigates to a mock scene at a given viewport and waits for it to settle. */
    async function gotoScene(scene, w, h) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: w, height: h, deviceScaleFactor: 2, mobile: w < 768,
      });
      const url = `${origin}/?mock=1&scene=${scene}`;
      await cdp.send('Page.navigate', { url });
      await cdp.until(`document.readyState === 'complete'`, { what: `load ${scene}@${w}x${h}` });
      await cdp.until(`document.body.dataset.screen === 'game'`, { what: `mock game screen (${scene}@${w}x${h})` });
      // Finished animations and two settled frames, same discipline the
      // probes below already hold themselves to — a mid-transition read is
      // not where anything actually sits.
      await cdp.eval(`(() => { document.getAnimations().forEach(x => { try { x.finish(); } catch {} });
        return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); })()`);
    }

    // ---- tray-selector ---------------------------------------------------
    // The brief's own two conditions (is-compressed set, and the general-
    // sibling selector matches exactly one element) are necessary but proved
    // NOT sufficient while proving this check in the worktree at Step 3:
    // `querySelectorAll('.stage.is-compressed ~ .tray')` asks the DOM "is
    // `.tray` a later sibling of `#stage`?", which is a fact about MARKUP
    // ORDER and stays true even when the STYLESHEET rule is quietly reverted
    // from `~` to `+` — the DOM did not move, only the CSS combinator did.
    // Measured directly: sabotaging styles.css to `+` still returned
    // `matches=1` here, while `.tray`'s computed style silently reverted to
    // `overflow-y: visible; max-height: none` (its unconstrained default —
    // `.tray`'s base rule sets neither). The computed style is the runtime
    // truth the stylesheet rule is actually supposed to produce, so it is
    // asserted too; the DOM-order checks stay because they guard the
    // original 2026-08 bug (markup reordering could break the `~` combinator
    // the same way `+` broke it then).
    await gotoScene('callout', 360, 640);
    const compressed = await cdp.eval(`document.getElementById('stage').classList.contains('is-compressed')`);
    const trayMatches = await cdp.eval(`document.querySelectorAll('.stage.is-compressed ~ .tray').length`);
    const trayStyle = JSON.parse(await cdp.eval(`(() => { const t = document.querySelector('.tray'); if (!t) return JSON.stringify(null);
      const s = getComputedStyle(t); return JSON.stringify({ overflowY: s.overflowY, maxHeight: s.maxHeight }); })()`));
    record('tray-selector', 'mock:callout@360x640',
      compressed === true && trayMatches === 1 && !!trayStyle && trayStyle.overflowY === 'auto',
      `is-compressed=${compressed} domSiblingMatches=${trayMatches} `
      + `computedOverflowY=${trayStyle && trayStyle.overflowY} computedMaxHeight=${trayStyle && trayStyle.maxHeight}`);

    // ---- leave-reachable ---------------------------------------------------
    // The document does NOT scroll (html, body { overflow: hidden },
    // styles.css:364-367) — the game screen's own scroll container is
    // `.tray` (styles.css:2260-2265 at 360x640/320x568). Scrolling
    // `document.scrollingElement` measures nothing and would read as a false
    // "unreachable". Scroll `.tray` itself and judge reachability from what
    // is still outside the viewport at ITS scroll extreme.
    const LEAVE_PROBE = `(() => {
      const tray = document.querySelector('.tray');
      const leave = document.getElementById('game-leave');
      if (!tray || !leave) return JSON.stringify({ valid: false, reason: !tray ? 'no .tray in this scene' : 'no #game-leave in this scene' });
      const scrollableAmount = Math.round((tray.scrollHeight - tray.clientHeight) * 10) / 10;
      tray.scrollTop = tray.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);   // belt-and-braces; a no-op today
      const r = leave.getBoundingClientRect();
      // A display:none #game-leave still returns a rect -- a zero-size one at
      // (0,0), whose bottom (0) always clears innerHeight and reads as
      // "reachable". An invisible button is not a reachable one, so a real box
      // is the PREMISE (valid), not folded into pass: seat-plaque-gap.js and
      // round-boundary.js's atRoundOver.seats === SEATS make the same call.
      if (!(r.width > 0 && r.height > 0)) {
        return JSON.stringify({ valid: false, reason: '#game-leave has no visible box (' + r.width + 'x' + r.height + ') -- hidden?' });
      }
      return JSON.stringify({
        valid: true, container: '.tray', scrollableAmount,
        trayScrollTop: Math.round(tray.scrollTop * 10) / 10,
        leaveBottom: Math.round(r.bottom * 10) / 10,
        innerHeight,
        pass: r.bottom <= innerHeight + 1,
      });
    })()`;
    for (const [w, h] of [[360, 640], [320, 568]]) {
      for (const scene of ['tondo', 'callout', 'drawn', 'wild']) {
        await gotoScene(scene, w, h);
        const parsed = JSON.parse(await cdp.eval(LEAVE_PROBE));
        record('leave-reachable', `mock:${scene}@${w}x${h}`, parsed.valid === true && parsed.pass === true,
          parsed.valid
            ? `container=${parsed.container} scrollable=${parsed.scrollableAmount}px scrollTop=${parsed.trayScrollTop} leaveBottom=${parsed.leaveBottom} innerHeight=${parsed.innerHeight}`
            : `INVALID: ${parsed.reason}`);
      }
    }

    // ---- strip-fits --------------------------------------------------------
    // `.strip-inner` is one non-wrapping row, so anything that grows inside it
    // pushes the TRAILING controls off the right edge — and the last of those
    // is `?`, the only way into the rules. That is exactly how it broke: the
    // slice chip grew from 97.2px to 200.2px when the standings clause was
    // added, the clause was verified by measuring the CHIP at 1280x800, and at
    // 390x844 the help button ended 17.2px past the viewport with nothing
    // scrollable to reach it. So the assertion is on the BUTTON'S right edge
    // against the bar's content edge, never on the chip's own width.
    //
    // Two premises, asserted rather than assumed: the bar must have a real box,
    // and it must hold the controls this check exists to protect. Without the
    // second, a future refactor that moves the buttons elsewhere would leave
    // this passing over an empty row.
    const STRIP_PROBE = `(() => {
      const inner = document.querySelector('.strip-inner');
      if (!inner) return JSON.stringify({ valid: false, reason: 'no .strip-inner' });
      const ib = inner.getBoundingClientRect();
      if (!(ib.width > 0 && ib.height > 0)) return JSON.stringify({ valid: false, reason: '.strip-inner has no box' });
      const help = inner.querySelector('.strip-help');
      if (!help) return JSON.stringify({ valid: false, reason: 'no .strip-help inside .strip-inner' });
      const kids = [...inner.children].filter((e) => !e.hidden && e.getBoundingClientRect().width > 0);
      if (kids.length < 3) return JSON.stringify({ valid: false, reason: 'only ' + kids.length + ' visible strip children -- not the real bar' });
      const padRight = parseFloat(getComputedStyle(inner).paddingRight) || 0;
      const limit = Math.round((innerWidth - padRight) * 10) / 10;
      const past = kids
        .filter((e) => e.getBoundingClientRect().right > limit + 0.5)
        .map((e) => ((e.textContent || e.getAttribute('aria-label') || e.className).trim().slice(0, 18) || '?')
          + '@' + Math.round(e.getBoundingClientRect().right * 10) / 10);
      const hr = Math.round(help.getBoundingClientRect().right * 10) / 10;
      return JSON.stringify({
        valid: true, visibleChildren: kids.length, limit, helpRight: hr,
        slack: Math.round((limit - hr) * 10) / 10,
        chip: (document.getElementById('slice-chip') || {}).textContent || '(no chip)',
        past, pass: past.length === 0,
      });
    })()`;
    for (const [w, h] of [[320, 568], [360, 640], [390, 844], [1280, 800]]) {
      await gotoScene('yourTurn', w, h);
      const parsed = JSON.parse(await cdp.eval(STRIP_PROBE));
      record('strip-fits', `mock:yourTurn@${w}x${h}`, parsed.valid === true && parsed.pass === true,
        parsed.valid
          ? `children=${parsed.visibleChildren} chip="${parsed.chip}" helpRight=${parsed.helpRight} limit=${parsed.limit} slack=${parsed.slack}${parsed.past.length ? ' PAST: ' + parsed.past.join(', ') : ''}`
          : `INVALID: ${parsed.reason}`);
    }

    // ---- seat-plaque-gap ---------------------------------------------------
    const seatPlaqueSrc = fs.readFileSync(path.join(__dirname, 'probes', 'seat-plaque-gap.js'), 'utf8');
    for (const [w, h] of [[1024, 768], [1280, 800], [1440, 900]]) {
      for (const scene of ['tondo', 'callout', 'drawn', 'wild']) {
        await gotoScene(scene, w, h);
        const parsed = JSON.parse(await cdp.eval(seatPlaqueSrc));
        record('seat-plaque-gap', `mock:${scene}@${w}x${h}`, parsed.valid === true && parsed.pass === true,
          `valid=${parsed.valid} pass=${parsed.pass} gapY=${parsed.gapY} parts=${parsed.parts}`
          + (parsed.valid ? '' : ` reason=${parsed.reason}`));
      }
    }

    // ---- banner-clear ---------------------------------------------------
    const roundBoundarySrc = fs.readFileSync(path.join(__dirname, 'probes', 'round-boundary.js'), 'utf8');
    for (const [w, h] of [[390, 844], [1280, 800], [1440, 900]]) {
      await gotoScene('roundOver', w, h);
      const parsed = JSON.parse(await cdp.eval(roundBoundarySrc));
      const ar = parsed.atRoundOver || {};
      /* The seat ring stands down at round over (styles.css
         `.stage.is-over #seats`), so "the banner covers no seat" cannot be
         asked here any more — three `display: none` seats still answer
         querySelectorAll and a zero-size rect intersects nothing, so the old
         assertion would have passed against nothing at all. What this row pins
         now is that the ring really is down AND that the banner clears the
         seats in the state where they ARE on screen, which the probe measures
         as `bannerClearAtYourTurn` over YOUR TURN plus all three context bars. */
      const ok = parsed.valid === true && ar.bannerVisible === true
        && ar.seatsVisible === 0
        && parsed.checks.seatsStandDownAtRoundOver === true
        && parsed.checks.bannerClearAtYourTurn === true;
      record('banner-clear', `mock:roundOver@${w}x${h}`, ok,
        `valid=${parsed.valid} bannerVisible=${ar.bannerVisible} seatNodes=${ar.seats} seatsVisible=${ar.seatsVisible} `
        + `standDown=${parsed.checks.seatsStandDownAtRoundOver} clearAtYourTurn=${parsed.checks.bannerClearAtYourTurn}`
        // Without this, an invalid run says only that one of fourteen premises
        // did not hold, and every diagnosis costs a separate probe run — which
        // then passes, because the premises that go soft are the sample-count
        // floors and an isolated run has the machine to itself.
        + (parsed.valid ? '' : ` FAILED PREMISES: ${(parsed.failedPremises || ['(probe predates failedPremises)']).join(', ')}`
            + ` [frames next=${parsed.next && parsed.next.frames}/60 lobby=${parsed.lobby && parsed.lobby.frames}/45]`));
    }

    // ---- capture every mock scene at every reference viewport ----------
    const qaLatest = path.join(root, '.superpowers', 'qa-latest');
    fs.rmSync(qaLatest, { recursive: true, force: true });
    let shots = 0;
    for (const scene of CHECK_SCENES) {
      for (const [w, h] of CHECK_SIZES) {
        await gotoScene(scene, w, h);
        await shoot(cdp, path.join(qaLatest, `${scene}-${w}x${h}.png`), { settle: true });
        shots++;
      }
    }
    console.log(`captured ${shots} scene shots into ${qaLatest}`);

    // ---- curated docs/qa/ (only with --update-docs) ---------------------
    if (a.updateDocs) {
      const docsQa = path.join(root, 'docs', 'qa');
      fs.mkdirSync(docsQa, { recursive: true });
      for (const [scene, w, h] of CURATED_QA) {
        await gotoScene(scene, w, h);
        await shoot(cdp, path.join(docsQa, `${scene}-${w}x${h}.png`), { settle: true });
      }
      console.log(`wrote ${CURATED_QA.length} curated screenshots into ${docsQa}`);
    }

    // ---- no-page-errors ---------------------------------------------------
    // Read LAST and over the whole session: `cdp.events` accumulates every
    // Runtime/Log event since Page.enable/Runtime.enable above, across every
    // navigation this run made (assertions and captures alike), so this is
    // genuinely "every page loaded during the check", not just the last one.
    //
    // One exact message is excluded, narrowly, by exact text match: Chrome
    // refuses `navigator.vibrate()` without a prior TRUSTED user gesture, and
    // `scripts/probes/round-boundary.js`'s own tap test drives a synthetic
    // `.click()` — untrusted by definition — immediately before the app calls
    // `haptics.tap()`. task-9-report.md already flagged this exact policy
    // interaction as a known artifact of synthetic taps ("Chrome blocks
    // vibrate until the frame has been tapped, so the stub can OVER-report
    // versus a real browser"), not an application defect. Confirmed here by
    // running round-boundary.js alone against this build with every one of
    // its own checks green (`pass: true, valid: true`): it still produced
    // exactly this message, every time, three times per full --check run —
    // one per banner-clear viewport. Anything else Chrome or the app logs
    // still fails this assertion.
    const VIBRATE_BLOCKED = /^Blocked call to navigator\.vibrate because user hasn't tapped/;
    // Exactly one of these per banner-clear viewport (the `for (const [w, h] of
    // [[390, 844], [1280, 800], [1440, 900]])` loop above this one, each of
    // which drives round-boundary.js's own synthetic `.click()` once). This is
    // a count of a KNOWN, bounded artifact, not a wildcard: an unbounded
    // exclusion here is exactly how a regression that fires `haptics.tap()` on
    // every render would slip past this gate. If you add or remove a
    // banner-clear viewport, update this number in the same commit.
    const EXPECTED_VIBRATE_EXCLUSIONS = 3;
    const allErrors = cdp.pageErrors();
    const errors = allErrors.filter((e) => !VIBRATE_BLOCKED.test(e));
    const excludedCount = allErrors.length - errors.length;
    const excludedCountOk = excludedCount === EXPECTED_VIBRATE_EXCLUSIONS;
    record('no-page-errors', 'every page this run loaded', errors.length === 0 && excludedCountOk,
      `errors=${errors.length}`
      + ` excluded=${excludedCount} (expected ${EXPECTED_VIBRATE_EXCLUSIONS} known synthetic-tap vibrate-policy message(s), one per banner-clear viewport)`
      + (excludedCountOk ? '' : ` — MISMATCH: excluded count changed from the expected ${EXPECTED_VIBRATE_EXCLUSIONS}`
        + ' to ' + excludedCount + '; either a banner-clear viewport was added/removed (update EXPECTED_VIBRATE_EXCLUSIONS)'
        + ' or something new is calling navigator.vibrate() without a trusted tap')
      + (errors.length ? ` first="${errors[0]}"` : ''));
  } catch (err) {
    hardError = err;
  } finally {
    if (cdp) cdp.close();
    killTree(chrome, userDataDir);
    try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch { /* the OS will reap it */ }
    try { server.kill('SIGTERM'); } catch { /* already gone */ }
  }

  // ---- contrast --------------------------------------------------------
  // No browser needed; runs whether or not the Chrome-based checks above
  // threw, so one broken assertion never hides a contrast regression.
  const contrast = spawnSync(process.execPath, ['scripts/check-contrast.js'], { cwd: root, encoding: 'utf8' });
  if (contrast.stdout) process.stdout.write(contrast.stdout);
  if (contrast.stderr) process.stderr.write(contrast.stderr);
  record('contrast', 'node scripts/check-contrast.js', contrast.status === 0, `exit=${contrast.status}`);

  console.log('\n--- summary ---');
  const byGroup = new Map();
  for (const r of results) {
    if (!byGroup.has(r.group)) byGroup.set(r.group, []);
    byGroup.get(r.group).push(r);
  }
  let anyFail = false;
  for (const [group, rs] of byGroup) {
    const fails = rs.filter((r) => !r.pass).length;
    if (fails) anyFail = true;
    console.log(`${fails ? 'FAIL' : 'PASS'}  ${group.padEnd(16)}${rs.length - fails}/${rs.length} passed`);
  }
  if (hardError) {
    console.error(`\nHARD FAILURE (infra, not an assertion): ${hardError.message}`);
    anyFail = true;
  }
  process.exitCode = anyFail ? 1 : 0;
}

// --------------------------------------------------------------------- main
async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.check) { await runCheck(a); return; }
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
