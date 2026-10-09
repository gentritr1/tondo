# Crew-lite Retention + Render Hosting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A group that finished a pie can save it to a durable "crew". Everyone at the table
gets a link that still works after the room is gone and after the server restarts. The server
can be deployed to Render free and moved to Fly without code changes.

**Architecture:**
- The game stays one Node process: static client, WebSocket and rooms in memory.
- A new crew store (`server/db.js`, `server/migrate.js`, `server/crews.js`) persists crews in
  Postgres (Neon in production, PGlite in tests) through the `pg` driver. The game never
  depends on it.
- Saving is a server-authoritative WS message (`saveToCrew`). Reading and leaving are two small
  HTTP routes.
- Per-address budgets that outlive a socket close the reconnect hole in the wrong-code
  throttle. The real client address is read from the proxy header when running behind
  Render's or Fly's load balancer.

**Tech stack:**
- Node 20 (`engines >=18`), `ws` 8, `pg` 8.23.x.
- Dev only: `@electric-sql/pglite` 0.5.x and `@electric-sql/pglite-socket` 0.2.x.
- Plain ES-module browser client, no build step.

**Spec:** `docs/superpowers/specs/2026-10-10-crew-retention-design.md`. Read it first; this
plan argues from it.

## Global Constraints

These come from the spec. Every task's requirements include them.

**Identity and ids**
- The device secret matches `/^[0-9a-f]{32}$/` and is stored server-side only as its
  `sha256` hex. It is never logged.
- A crew id is 10 characters from `0123456789abcdefghjkmnpqrstvwxyz`, matching
  `/^[0-9a-hjkmnp-tv-z]{10}$/`, generated server-side with `crypto.randomBytes`.
- A crew name is 1–24 characters after collapsing whitespace and trimming.

**Database**
- Pool settings: `max` from `TONDO_DB_POOL_MAX`, default 5; `connectionTimeoutMillis: 5000`;
  `idleTimeoutMillis: 10000`.
- Every transaction starts with `SET LOCAL statement_timeout = '3s'`.
- Migrations run over `DATABASE_URL_DIRECT`, falling back to `DATABASE_URL`, holding
  `pg_advisory_lock(7310)`.
- Boot retry starts at 30 s (`TONDO_DB_RETRY_MS` overrides it, for tests) and doubles to a
  600 s ceiling.

**Messages and logs**
- Players see exactly "Can't reach the crew book right now — your game is fine."
- Failure reasons are exactly: `not configured`, `wrong password`, `unknown host`, `timeout`,
  `missing table`, `over quota`, `database error`.
- Logs read `[crews] <op> ok crew=<id> ms=<n>` or `[crews] <op> failed: <reason>`. Never driver
  text, URLs or secrets.

**Crew status**
- The `crews` field in snapshots is `'off'` (no `DATABASE_URL`), `'on'` (migrations
  succeeded) or `'failing'` (configured, migrations not yet succeeded).
- A runtime query failure does not flip it, because a later success has to be able to
  recover. `/health` reports the last op's status and reason.

**Budgets** (`IpBudget`, an LRU of 10,000 addresses)

| Budget | Burst | Refill |
|---|---|---|
| connect | 64 | 1 per 1000 ms |
| joinFail | 10 | 1 per 2000 ms |
| crewRead | 60 | 1 per 1000 ms |
| crewCreate | 10 | 1 per 360000 ms |

**Environment variables:** `PORT`, `NODE_ENV`, `DATABASE_URL`, `DATABASE_URL_DIRECT`,
`TONDO_TRUST_PROXY`, `TONDO_CLIENT_IP_HEADER`. Test-only: `TONDO_DB_POOL_MAX`,
`TONDO_DB_RETRY_MS`.

**Rules that apply throughout**
- No host-specific code.
- PROTOCOL.md is updated **before** the code that changes the wire (its own rule).
- New text nodes are written with `textContent`, never `innerHTML`, for any server- or
  user-supplied string.
- Existing gates must stay green: `npm test` (116 at handoff), `npm run smoke` (needs a running
  server), `npm run shoot`, `npm run contrast`. A single red `shoot` run is re-run clean before
  concluding (memory `shoot-gate-load-flake.md`).
- Commits end with: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

**Deliberate deviations from the spec text** (each is additive):
- `schema_migrations` is created by `migrate.js` instead of inside `001_crews.sql`.
- `GET /api/crew/:id` also returns `pies` (the total count), for the crew page subtitle.
- The `crews: 'failing'` status means "configured but not yet migrated".
- The one-tap save also sets `room.crew` after the first save, so the next pie at the same
  table saves in one tap too.

## Review Focus

These are inputs the spec implies but no task's own feature tests would naturally hit. Each
line names the test that pins it.

1. **One device in two seats at one table.** Two tabs on one laptop is the owner's own test
   setup. The save must not fail on a duplicate `pie_players` key: the second seat is recorded
   as a guest. *Pinned in Task 4 ("same device in two seats").*
2. **Two players tapping Save in the same instant, or one player double-tapping.** This must
   produce exactly one `pies` row and no error to either player. *Pinned in Task 5
   ("concurrent saves").*
3. **A corrupted, foreign or oversized `tondo.crews` in localStorage.** It reads as the valid
   subset and never throws or deletes. *Pinned in Task 6 ("storage parsing").*
4. **A crew page opened on a server with crews off, or with the database down.** It shows a
   plain message and the game is unaffected. *Pinned in Task 5 (HTTP 503 test) and Task 8
   (mock `dead000000` fixture).*
5. **A crew or member name containing HTML (`<b>New</b> crew`).** It renders as literal text
   everywhere. *Pinned in Task 8 (mock `empty00000` fixture and DOM assertion).*

---

## File map

**Server**

| File | Change | Responsibility |
|---|---|---|
| `server/clientip.js` | create | real client address from proxy headers |
| `server/limits.js` | modify | adds `IpBudget` + `createIpBudgets()`; per-socket wrong-code budget removed |
| `server/db.js` | create | pool, `tx`, `run` (logging and classification), state machine, `start()` |
| `server/migrate.js` | create | ordered SQL migrations under an advisory lock |
| `server/migrations/001_crews.sql` | create | four tables + index |
| `server/crews.js` | create | crew store (only module touching crew tables) |
| `server/crew-actions.js` | create | `saveToCrew` decision logic (testable without a socket server) |
| `server/crew-http.js` | create | `/api/crew/:id`, `/api/crew/:id/leave`, `/health/crews` |
| `server/rooms.js` | modify | `pieKey`/`savedTo`/`saving`, `seat.deviceHash`, `room.crew`, `pieRecord()`, snapshot fields, `crewsStatus` option |
| `server/index.js` | modify | client IP, budgets, `saveToCrew`, crew HTTP, `/health`, `db.start()` |

**Client**

| File | Change | Responsibility |
|---|---|---|
| `public/js/crews.js` | create | device secret, `tondo.crews` list, crew link |
| `public/js/share.js` | modify | optional `crewUrl` |
| `public/js/net.js` | modify | `getDevice` on reconnect; `saveToCrew` is state-dependent |
| `public/js/app.js` | modify | device on join, Save + picker, crew view, home crews row, routing |
| `public/index.html` | modify | scoreboard save controls, `#screen-crew`, home crews row |
| `public/styles.css` | modify | crew screen + picker + row styles |
| `public/js/mock.js` | modify | `crews: 'on'`, `saveToCrew`, `/api/crew` fetch fixtures |

**Scripts and tests**
- `scripts/shoot.js` (modify): `crew-card-fits` check + crew captures.
- `scripts/household-storm.js` (create): limits measurement, zero false refusals.
- `scripts/crew-smoke.js` (create): a full real pie, saved to a crew (deploy smoke).
- `scripts/portable-check.mjs` (create): boots with only the portable env vars.
- `scripts/dev-db.mjs` (create): local PGlite for manual dev.
- `test/helpers/*.mjs` (create): free port, PGlite server, spawned server, WS client.
- New tests:
  - `test/clientip.test.js`, `test/limits.test.js`, `test/server-limits.test.mjs`
  - `test/db.test.mjs`, `test/crews.test.mjs`, `test/crew-actions.test.mjs`,
    `test/crew-server.test.mjs`
  - `test/crews-client.test.mjs`

**Docs and config**
- `PROTOCOL.md` (v1.4), `render.yaml`, `docs/DEPLOY.md`, `package.json`.

`npm test` stays dependency-free and fast. The database tests run under a new
`npm run test:db`.

---

### Task 1: The real client address behind a proxy

**Files:**
- Create: `server/clientip.js`, `test/clientip.test.js`
- Modify: `server/index.js:115-120` (replace `clientIp`), `package.json` (`test` script)

**Interfaces:**
- Produces: `clientIpFrom(req, env = process.env) -> string`, where `req` is `{ headers,
  socket: { remoteAddress } }`. IPv4-mapped IPv6 is folded (`::ffff:1.2.3.4` becomes
  `1.2.3.4`).

- [ ] **Step 1: Write the failing test** in `test/clientip.test.js`:

```js
'use strict';

/** Which address a request is charged to, with and without a trusted proxy. */

const { clientIpFrom } = require('../server/clientip');

let passed = 0;
const failures = [];
function test(name, fn) { try { fn(); passed++; } catch (err) { failures.push({ name, err }); } }
function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message || 'not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const req = (remoteAddress, headers = {}) => ({ headers, socket: { remoteAddress } });

test('with no proxy settings the socket address is used, ::ffff: folded', () => {
  eq(clientIpFrom(req('::ffff:10.0.0.5', { 'x-forwarded-for': '1.1.1.1' }), {}), '10.0.0.5');
});

test('TONDO_TRUST_PROXY=1 takes the RIGHTMOST forwarded entry, never a forged left one', () => {
  const r = req('10.9.9.9', { 'x-forwarded-for': '6.6.6.6, 203.0.113.7' });
  eq(clientIpFrom(r, { TONDO_TRUST_PROXY: '1' }), '203.0.113.7');
});

test('TONDO_TRUST_PROXY=2 skips one more hop from the right', () => {
  const r = req('10.9.9.9', { 'x-forwarded-for': '6.6.6.6, 203.0.113.7, 10.1.1.1' });
  eq(clientIpFrom(r, { TONDO_TRUST_PROXY: '2' }), '203.0.113.7');
});

test('trusting a proxy but receiving no header falls back to the socket address', () => {
  eq(clientIpFrom(req('10.9.9.9'), { TONDO_TRUST_PROXY: '1' }), '10.9.9.9');
});

test('a non-integer or zero TONDO_TRUST_PROXY is ignored', () => {
  const r = req('10.9.9.9', { 'x-forwarded-for': '203.0.113.7' });
  eq(clientIpFrom(r, { TONDO_TRUST_PROXY: '0' }), '10.9.9.9');
  eq(clientIpFrom(r, { TONDO_TRUST_PROXY: 'yes' }), '10.9.9.9');
});

test('TONDO_CLIENT_IP_HEADER wins over X-Forwarded-For (Fly-Client-IP)', () => {
  const r = req('10.9.9.9', { 'fly-client-ip': '198.51.100.4', 'x-forwarded-for': '6.6.6.6' });
  eq(clientIpFrom(r, { TONDO_CLIENT_IP_HEADER: 'Fly-Client-IP', TONDO_TRUST_PROXY: '1' }), '198.51.100.4');
});

test('an empty configured header falls through to the next rule', () => {
  const r = req('10.9.9.9', { 'x-forwarded-for': '203.0.113.7' });
  eq(clientIpFrom(r, { TONDO_CLIENT_IP_HEADER: 'Fly-Client-IP', TONDO_TRUST_PROXY: '1' }), '203.0.113.7');
});

if (failures.length) {
  for (const f of failures) console.error(`\n  FAIL  ${f.name}\n        ${f.err && f.err.message}`);
  console.error(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(1);
}
console.log(`\n${passed} passed, 0 failed\n`);
```

- [ ] **Step 2: Run it and confirm it fails.** Run `node test/clientip.test.js`. Expected:
  exit 1 with `Cannot find module '../server/clientip'`.

- [ ] **Step 3: Implement** `server/clientip.js`:

```js
'use strict';

/**
 * The address a request is charged to.
 *
 * Behind Render's or Fly's load balancer, `socket.remoteAddress` is the
 * balancer's, so every player in the world shares one address, and the
 * 32-socket cap in limits.js would refuse everyone once 32 sockets were open
 * anywhere. The platform tells us the real address in a header, but only the
 * entry IT appended can be trusted: anything further left in X-Forwarded-For
 * was written by the client and can say anything.
 *
 *   TONDO_CLIENT_IP_HEADER=<name>  a single-value header the platform sets
 *                                  (Fly: Fly-Client-IP)
 *   TONDO_TRUST_PROXY=<hops>       take the entry `hops` from the right of
 *                                  X-Forwarded-For (Render: 1)
 *   neither                        the socket address, as before
 */

const fold = (ip) => String(ip || '').trim().replace(/^::ffff:/, '');

function clientIpFrom(req, env = process.env) {
  const headers = (req && req.headers) || {};
  const named = String(env.TONDO_CLIENT_IP_HEADER || '').trim().toLowerCase();
  if (named) {
    const v = headers[named];
    const one = Array.isArray(v) ? v[0] : v;
    if (one && String(one).trim()) return fold(one);
  }
  const hops = Number(env.TONDO_TRUST_PROXY);
  if (Number.isInteger(hops) && hops >= 1) {
    const raw = headers['x-forwarded-for'];
    const list = String(Array.isArray(raw) ? raw.join(',') : raw || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length >= hops) return fold(list[list.length - hops]);
  }
  return fold(req && req.socket && req.socket.remoteAddress);
}

module.exports = { clientIpFrom };
```

- [ ] **Step 4: Wire it in.** In `server/index.js`:
  1. Add `const { clientIpFrom } = require('./clientip');` next to the other requires.
  2. Replace the body of `clientIp(req)` (lines 115-120) with `return clientIpFrom(req);`.
  3. Keep the function name and the doc comment, adding one line: "Behind a proxy, see
     server/clientip.js."

- [ ] **Step 5: Add to `npm test` and run it.** In `package.json`, insert
  `node test/clientip.test.js && ` after `node test/rooms.test.js && `. Run `npm test`.
  Expected: every file prints `0 failed`, and the total is 116 + 7.

- [ ] **Step 6: Commit**

```bash
git add server/clientip.js server/index.js test/clientip.test.js package.json
git commit -m "Charge a request to the player, not the load balancer in front of them

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Per-address budgets that outlive a socket

**Files:**
- Create: `test/limits.test.js`, `test/helpers/net.mjs`, `test/helpers/server.mjs`,
  `test/helpers/client.mjs`, `test/server-limits.test.mjs`, `scripts/household-storm.js`
- Modify:
  - `server/limits.js`: add `IpBudget`, `createIpBudgets`, `BUDGETS`; remove
    `canTryJoin`/`countJoinFailure`/`JOIN_FAIL_*`
  - `server/index.js`: `verifyClient` and the join branch
  - `PROTOCOL.md`: *Limits*
  - `package.json`

**Interfaces:**
- Consumes: `clientIpFrom` (Task 1).
- Produces:
  - `class IpBudget({ burst, perMs, maxKeys = 10000 })` with `allow(ip, now?) -> boolean`
    (no spend), `spend(ip, now?) -> void` and `take(ip, now?) -> boolean` (allow + spend).
  - `createIpBudgets() -> { connect, joinFail, crewRead, crewCreate }`.
  - `BUDGETS`, the constants table.
  - In `index.js`: a `budgets` object and a `session.ip` field, which Task 5 uses.
- Produces (test helpers, used by Tasks 5 and 9):
  - `freePort() -> Promise<number>`.
  - `spawnServer(env) -> Promise<{ port, http, ws, logs(), stop() }>`.
  - `client(url, headers?) -> { open(), send(msg), next(pred, ms?), close(), inbox }`.

- [ ] **Step 1: Write the failing unit test** in `test/limits.test.js`:

```js
'use strict';

/** IpBudget: a token bucket per address that survives the socket it was spent on. */

const { IpBudget, createIpBudgets, BUDGETS } = require('../server/limits');

let passed = 0;
const failures = [];
function test(name, fn) { try { fn(); passed++; } catch (err) { failures.push({ name, err }); } }
function assert(cond, message) { if (!cond) throw new Error(message || 'assertion failed'); }

test('a fresh address has the whole burst, then is refused', () => {
  const b = new IpBudget({ burst: 3, perMs: 1000 });
  assert(b.take('a', 0) && b.take('a', 0) && b.take('a', 0), 'three free');
  assert(!b.take('a', 0), 'fourth refused');
});

test('tokens refill at one per perMs, capped at the burst', () => {
  const b = new IpBudget({ burst: 2, perMs: 1000 });
  b.take('a', 0); b.take('a', 0);
  assert(!b.take('a', 999), 'not yet');
  assert(b.take('a', 1000), 'one back after 1s');
  assert(b.take('a', 60000) && b.take('a', 60000) && !b.take('a', 60000), 'capped at burst 2');
});

test('allow() never spends; spend() does', () => {
  const b = new IpBudget({ burst: 1, perMs: 1000 });
  assert(b.allow('a', 0) && b.allow('a', 0), 'allow is free');
  b.spend('a', 0);
  assert(!b.allow('a', 0), 'spent');
});

test('addresses do not share a bucket', () => {
  const b = new IpBudget({ burst: 1, perMs: 1000 });
  assert(b.take('a', 0) && b.take('b', 0), 'separate');
});

test('the LRU forgets the least recently used address past maxKeys', () => {
  const b = new IpBudget({ burst: 1, perMs: 1e9, maxKeys: 2 });
  b.take('a', 0); b.take('b', 0); b.take('c', 0); // a evicted
  assert(b.take('a', 0), 'a starts fresh after eviction');
  assert(b.size() <= 2, `size ${b.size()}`);
});

test('the shipped budgets match the spec table', () => {
  const s = (k) => `${BUDGETS[k].burst}/${BUDGETS[k].perMs}`;
  assert(s('connect') === '64/1000' && s('joinFail') === '10/2000'
    && s('crewRead') === '60/1000' && s('crewCreate') === '10/360000', JSON.stringify(BUDGETS));
  const all = createIpBudgets();
  assert(['connect', 'joinFail', 'crewRead', 'crewCreate'].every((k) => all[k] instanceof IpBudget), 'four budgets');
});

if (failures.length) {
  for (const f of failures) console.error(`\n  FAIL  ${f.name}\n        ${f.err && f.err.message}`);
  console.error(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(1);
}
console.log(`\n${passed} passed, 0 failed\n`);
```

- [ ] **Step 2: Run it and confirm it fails.** Run `node test/limits.test.js`. Expected:
  `IpBudget is not a constructor`.

- [ ] **Step 3: Implement it in `server/limits.js`.**
  1. Delete `JOIN_FAIL_BURST`, `JOIN_FAIL_REFILL_MS`, the `joinTokens`/`joinRefilledAt`
     constructor fields, `canTryJoin` and `countJoinFailure`, and remove them from
     `module.exports`. Nothing outside `index.js` used them; confirm with
     `grep -rn "canTryJoin\|JOIN_FAIL" server scripts test`, which must return nothing after
     Step 4.
  2. Add before `module.exports`:

```js
/**
 * Budgets kept per ADDRESS, which outlive any one socket.
 *
 * The wrong-code ration used to live on SocketLimits, created fresh per
 * connection — so "5 free wrong codes" really meant "5 per reconnect", and a
 * reconnect is free. These buckets are keyed by address (server/clientip.js)
 * and kept in a bounded LRU so one address cannot grow the map without limit.
 *
 * Every number is set from a scenario a real household produces, then checked
 * by scripts/household-storm.js (4 players on one network, 3 reconnects and 2
 * mistyped codes each), which must show zero refusals:
 *   connect     64 burst, 1/s    2x the 32-socket concurrent cap: a full
 *                                household can reconnect completely twice at once
 *   joinFail    10 burst, 1/2s   4 players x 2 mistypes, plus 2 spare
 *   crewRead    60 burst, 1/s    a household opening the crew link together and refreshing
 *   crewCreate  10 burst, 10/h   a player makes one crew; ten is generous
 */
const BUDGETS = {
  connect: { burst: 64, perMs: 1000 },
  joinFail: { burst: 10, perMs: 2000 },
  crewRead: { burst: 60, perMs: 1000 },
  crewCreate: { burst: 10, perMs: 360000 },
};

class IpBudget {
  constructor({ burst, perMs, maxKeys = 10000 }) {
    this.burst = burst;
    this.perMs = perMs;
    this.maxKeys = maxKeys;
    this.buckets = new Map(); // insertion order = recency (oldest first)
  }

  bucket(ip, now) {
    const key = String(ip || '');
    let b = this.buckets.get(key);
    if (b) {
      this.buckets.delete(key); // re-insert to mark as most recent
      b.tokens = Math.min(this.burst, b.tokens + Math.max(0, now - b.at) / this.perMs);
      b.at = now;
    } else {
      b = { tokens: this.burst, at: now };
      if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value);
    }
    this.buckets.set(key, b);
    return b;
  }

  allow(ip, now = Date.now()) { return this.bucket(ip, now).tokens >= 1; }

  spend(ip, now = Date.now()) {
    const b = this.bucket(ip, now);
    b.tokens = Math.max(0, b.tokens - 1);
  }

  take(ip, now = Date.now()) {
    const b = this.bucket(ip, now);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  size() { return this.buckets.size; }
}

function createIpBudgets() {
  return Object.fromEntries(Object.entries(BUDGETS).map(([k, v]) => [k, new IpBudget(v)]));
}
```

  3. Export `IpBudget`, `createIpBudgets` and `BUDGETS`.

- [ ] **Step 4: Wire it into `server/index.js`.**
  1. Import `createIpBudgets` from `./limits` and add `const budgets = createIpBudgets();`
     after `const assets = …`.
  2. Replace the `verifyClient` option with the callback form below. ws picks the form by
     arity (`length === 2`). Calling `done` synchronously keeps the "counted before the next
     upgrade is judged" property the comment above `socketsFromIp` relies on.

```js
  verifyClient: (info, done) => {
    if (!originAllowed(info.req)) {
      console.warn(`[tondo] upgrade refused: Origin ${info.req.headers.origin} != Host ${info.req.headers.host}`);
      return done(false, 401);
    }
    const ip = clientIp(info.req);
    // Attempts are budgeted before anything else is judged, so a refused
    // attempt costs the same as an admitted one.
    if (!budgets.connect.take(ip)) {
      console.warn(`[tondo] upgrade refused: ${ip} is reconnecting too fast`);
      return done(false, 429);
    }
    if (socketsFromIp(ip) >= maxSocketsPerIp()) {
      console.warn(`[tondo] upgrade refused: ${ip} already holds ${maxSocketsPerIp()} sockets`);
      return done(false, 401);
    }
    return done(true);
  },
```

  3. In `wss.on('connection')`, change the session to
     `const session = { room: null, seatId: null, limits: new SocketLimits(), ip: clientIp(req) };`
     and set `socket.tondoIp = session.ip;`.
  4. In `handleMessage`, replace the two wrong-code lines:
     - `if (message.type === 'joinRoom' && !limits.canTryJoin())` becomes
       `if (message.type === 'joinRoom' && !budgets.joinFail.allow(session.ip))`.
     - `if (message.type === 'joinRoom') limits.countJoinFailure();` becomes
       `if (message.type === 'joinRoom') budgets.joinFail.spend(session.ip);`.

     Update the comment above the first to say "per address, so a reconnect does not
     refill it".

- [ ] **Step 5: Write the test helpers.**

`test/helpers/net.mjs`:

```js
import net from 'node:net';

/** A TCP port nothing is listening on right now. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}
```

`test/helpers/server.mjs`:

```js
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { freePort } from './net.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Starts server/index.js on a free port with the given env and waits for its
 * "Tondo is open" line. DATABASE_URL defaults to empty so a developer's own
 * environment never leaks a real database into a test. Fails on exit or after
 * 10s, with the server's output in the error.
 */
export async function spawnServer(env = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: '', DATABASE_URL_DIRECT: '', ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  proc.stdout.on('data', (d) => { logs += d; });
  proc.stderr.on('data', (d) => { logs += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not open within 10s:\n${logs}`)), 10000);
    const onData = () => { if (logs.includes('Tondo is open')) { clearTimeout(timer); resolve(); } };
    proc.stdout.on('data', onData);
    proc.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}) before opening:\n${logs}`)); });
  });
  return {
    port,
    http: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}`,
    logs: () => logs,
    async stop() {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      const gone = new Promise((r) => proc.once('exit', r));
      proc.kill('SIGTERM');
      await gone;
    },
  };
}
```

`test/helpers/client.mjs`:

```js
import WebSocket from 'ws';

/** A WebSocket client that buffers every message so a test can await one by predicate. */
export function client(url, headers = {}) {
  const ws = new WebSocket(url, { headers });
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const w = waiters.find((x) => x.pred(msg));
    if (w) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); } else inbox.push(msg);
  });
  return {
    ws,
    inbox,
    open: () => new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once('error', reject);
    }),
    send: (msg) => ws.send(JSON.stringify(msg)),
    next(pred, ms = 5000) {
      const hit = inbox.find(pred);
      if (hit) { inbox.splice(inbox.indexOf(hit), 1); return Promise.resolve(hit); }
      return new Promise((resolve, reject) => {
        const w = { pred, resolve: (m) => { clearTimeout(t); resolve(m); } };
        const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`timed out after ${ms}ms`)); }, ms);
        waiters.push(w);
      });
    },
    close: () => new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      ws.once('close', resolve);
      ws.close();
    }),
  };
}
```

- [ ] **Step 6: Write the failing integration test** in `test/server-limits.test.mjs`. This is a
  defensive regression check against a local server the test itself starts. Each case uses its
  own documentation-range address (`203.0.113.x`) via `X-Forwarded-For` under
  `TONDO_TRUST_PROXY=1`, so the cases cannot drain each other's buckets.

```js
import { spawnServer } from './helpers/server.mjs';
import { client } from './helpers/client.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };

const server = await spawnServer({ TONDO_TRUST_PROXY: '1' });
const as = (ip) => client(server.ws, { 'X-Forwarded-For': ip });
const isError = (m) => m.type === 'error';

test('the wrong-code budget survives a reconnect (the handoff residual)', async () => {
  const ip = '203.0.113.10';
  let c = as(ip); await c.open();
  for (let i = 0; i < 10; i++) {
    c.send({ type: 'joinRoom', code: 'NOPE-0000', name: 'Probe' });
    const e = await c.next(isError);
    assert(e.message === 'No table has that code.', `attempt ${i + 1}: ${e.message}`);
  }
  await c.close();
  c = as(ip); await c.open();
  c.send({ type: 'joinRoom', code: 'NOPE-0000', name: 'Probe' });
  const e = await c.next(isError);
  assert(/Too many wrong table codes/.test(e.message), `11th after reconnect: ${e.message}`);
  await c.close();
});

test('another address is not charged for it', async () => {
  const c = as('203.0.113.11'); await c.open();
  c.send({ type: 'joinRoom', code: 'NOPE-0000', name: 'Probe' });
  const e = await c.next(isError);
  assert(e.message === 'No table has that code.', e.message);
  await c.close();
});

test('connection attempts past the burst are refused with 429', async () => {
  const ip = '203.0.113.12';
  let refusedAt = 0;
  const t0 = Date.now();
  for (let i = 1; i <= 100 && !refusedAt; i++) {
    const c = as(ip);
    try { await c.open(); await c.close(); } catch (err) { if (/HTTP 429/.test(err.message)) refusedAt = i; else throw err; }
  }
  // Refill is 1/s, so a slow run earns a few extra admissions: allow for the
  // elapsed seconds rather than pinning exactly 65.
  const slack = Math.ceil((Date.now() - t0) / 1000);
  assert(refusedAt > 0, `never refused within 100 attempts (${Date.now() - t0}ms)`);
  assert(refusedAt >= 65 && refusedAt <= 65 + slack, `refused at attempt ${refusedAt}, expected 65..${65 + slack}`);
});

let passed = 0;
const failures = [];
for (const [name, fn] of tests) {
  try { await fn(); passed++; } catch (err) { failures.push({ name, err }); }
}
await server.stop();
if (failures.length) {
  for (const f of failures) console.error(`\n  FAIL  ${f.name}\n        ${f.err && f.err.message}`);
  console.error(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(1);
}
console.log(`\n${passed} passed, 0 failed\n`);
```

- [ ] **Step 7: Reproduce the residual on the pre-fix code, then confirm the fix.**
  1. Stash **both** modified server files, so the server runs exactly as committed after
     Task 1: `git stash push server/limits.js server/index.js`.
  2. Run `node test/server-limits.test.mjs`. Expected: the wrong-code case FAILS with
     `11th after reconnect: No table has that code.` That is the handoff's reconnect hole,
     observed rather than inferred. The 429 case fails too, because nothing budgets
     connections yet.
  3. Run `git stash pop`.
  4. Run `node test/server-limits.test.mjs` again. Expected: `3 passed, 0 failed`.
  5. Put both outputs in the task report.

- [ ] **Step 8: Write the household measurement** in `scripts/household-storm.js`:

```js
'use strict';

/**
 * A real household, through one address: 4 players at one table, each
 * mistyping a code twice and reconnecting 3 times (closing the socket and
 * reclaiming the seat by token). Every budget in server/limits.js must let all
 * of it through. Prints the counts and exits 1 on ANY refusal.
 *
 *   node server/index.js &   then   node scripts/household-storm.js
 */

const WebSocket = require('ws');

const URL = process.env.TONDO_URL || `ws://localhost:${process.env.PORT || 4600}`;
const counts = { connects: 0, wrongCodes: 0, reconnects: 0, refusals: 0 };

function open() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.once('open', () => { counts.connects++; resolve(ws); });
    ws.once('unexpected-response', (_q, res) => { counts.refusals++; reject(new Error(`upgrade refused: HTTP ${res.statusCode}`)); });
    ws.once('error', reject);
  });
}
function next(ws, pred) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no answer in 5s')), 5000);
    const on = (raw) => { const m = JSON.parse(raw.toString()); if (pred(m)) { clearTimeout(t); ws.off('message', on); resolve(m); } };
    ws.on('message', on);
  });
}
const send = (ws, m) => ws.send(JSON.stringify(m));
const close = (ws) => new Promise((r) => { ws.once('close', r); ws.close(); });

(async () => {
  const host = await open();
  send(host, { type: 'createRoom', name: 'Host' });
  const made = await next(host, (m) => m.type === 'joined');
  const players = [{ ws: host, name: 'Host', token: made.token }];
  for (const name of ['Arta', 'Dren', 'Vesa']) {
    const ws = await open();
    send(ws, { type: 'joinRoom', code: made.roomCode, name });
    const j = await next(ws, (m) => m.type === 'joined' || m.type === 'error');
    if (j.type === 'error') throw new Error(`${name} could not join: ${j.message}`);
    players.push({ ws, name, token: j.token });
  }
  for (const p of players) {
    for (let i = 0; i < 2; i++) {
      const probe = await open();
      send(probe, { type: 'joinRoom', code: 'TYPO-0000', name: p.name });
      const e = await next(probe, (m) => m.type === 'error');
      if (e.message !== 'No table has that code.') { counts.refusals++; throw new Error(`${p.name} mistype refused: ${e.message}`); }
      counts.wrongCodes++;
      await close(probe);
    }
  }
  for (const p of players) {
    for (let i = 0; i < 3; i++) {
      await close(p.ws);
      p.ws = await open();
      send(p.ws, { type: 'joinRoom', code: made.roomCode, name: p.name, token: p.token });
      const j = await next(p.ws, (m) => m.type === 'joined' || m.type === 'error');
      if (j.type === 'error') { counts.refusals++; throw new Error(`${p.name} reconnect refused: ${j.message}`); }
      counts.reconnects++;
    }
  }
  console.log(`household-storm: ${JSON.stringify(counts)}`);
  for (const p of players) await close(p.ws);
  process.exit(counts.refusals ? 1 : 0);
})().catch((err) => {
  console.error(`household-storm FAIL: ${err.message} ${JSON.stringify(counts)}`);
  process.exit(1);
});
```

- [ ] **Step 9: Run the measurement and paste its output into the code.**
  1. Start the server with `run_in_background`: `PORT=4610 node server/index.js`.
  2. Run `PORT=4610 node scripts/household-storm.js`.
  3. Expected: `household-storm: {"connects":24,"wrongCodes":8,"reconnects":12,"refusals":0}`
     and exit 0. The 24 connects are 4 initial, 8 mistype probes and 12 reconnects.
  4. Paste that exact line into the `BUDGETS` comment, after "must show zero refusals", as
     `measured <date>: <line>`.
  5. Stop the server.

- [ ] **Step 10: Update PROTOCOL.md *Limits*.**
  1. Change the `failed joinRoom` row's value to `10 per address, then 1 per 2s (survives
     reconnects)`.
  2. Add a row: `connection attempts per address | 64, then 1/s | the upgrade is refused with
     HTTP 429`.
  3. Change the paragraph's "Everything except the last item is per socket" to "Message
     rate and table creation are per socket; wrong codes, connection attempts and concurrent
     sockets are per address (server/clientip.js decides the address behind a proxy)".
  4. Bump nothing yet; Task 5 makes this v1.4.

- [ ] **Step 11: Add the tests to `package.json` and run everything.**
  1. `test`: add `node test/limits.test.js && ` after the clientip test.
  2. New script: `"test:server": "node test/server-limits.test.mjs"`.
  3. Run `npm test && npm run test:server`. Expected: all `0 failed`.

- [ ] **Step 12: Commit**

```bash
git add server/limits.js server/index.js PROTOCOL.md package.json scripts/household-storm.js test/limits.test.js test/server-limits.test.mjs test/helpers
git commit -m "A reconnect no longer refills the wrong-code ration

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Database foundation (driver, migrations, state, PGlite test server)

**Files:**
- Create: `server/db.js`, `server/migrate.js`, `server/migrations/001_crews.sql`,
  `test/helpers/pg.mjs`, `test/db.test.mjs`, `scripts/dev-db.mjs`
- Modify: `package.json` (deps, `test:db`)

**Interfaces:**
- Produces from `server/db.js`:
  - `configured() -> boolean`.
  - `start({ migrateFn? }) -> Promise<void>`. Never rejects.
  - `state() -> { status: 'off'|'starting'|'on'|'failing', reason: string|null, since: string, ready: boolean }`.
  - `publicStatus() -> 'off'|'on'|'failing'`.
  - `tx(fn: (client) => Promise<T>) -> Promise<T>`.
  - `run(op: string, fn: () => Promise<T>, meta?: { crew?: string }) -> Promise<T>`. It logs
    and classifies; failures rethrow a `CrewStoreError` whose `.reason` is a reason string
    and whose `.publicMessage` is the plain player message.
  - `classify(err) -> reason`, `PLAYER_MESSAGE`, `ping() -> Promise<void>`, `stop()`.
- Produces from `server/migrate.js`: `migrate(url) -> Promise<number[]>` (the versions it
  applied).
- Produces from `test/helpers/pg.mjs`: `startPg() -> Promise<{ url, stop() }>`.

- [ ] **Step 1: Spike PGlite over the wire (5 minutes; throwaway).**
  1. Run `npm install pg@8.23.1 && npm install -D @electric-sql/pglite@0.5.8 @electric-sql/pglite-socket@0.2.11`.
  2. Write the spike to the session's scratchpad directory, not the repo:

```js
// spike.mjs: does the real `pg` driver talk to PGlite through pglite-socket?
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import pg from 'pg';
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: 5544, host: '127.0.0.1' });
await server.start();
const c = new pg.Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5544/postgres' });
await c.connect();
console.log((await c.query('SELECT 1 AS one')).rows);
await c.query('BEGIN'); await c.query("SET LOCAL statement_timeout = '3s'"); await c.query('COMMIT');
console.log((await c.query('SELECT pg_advisory_lock(7310)')).rowCount);
const c2 = new pg.Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5544/postgres' });
const second = c2.connect().then(() => 'second connection OK', (e) => `second connection: ${e.message}`);
console.log(await Promise.race([second, new Promise((r) => setTimeout(() => r('second connection: still waiting after 2s'), 2000))]));
await c.end(); await server.stop(); await db.close(); process.exit(0);
```

  3. Run it with `node <scratchpad>/spike.mjs` from the repo root (so `node_modules`
     resolves; set `NODE_PATH=$PWD/node_modules` if needed).
  4. Expected: `[ { one: 1 } ]`, `1`, and one line about a second connection.
  5. Record what the second-connection line says: pglite-socket may serve **one connection at
     a time**. If it does, every PGlite-backed process in the tests runs with
     `TONDO_DB_POOL_MAX=1`, and the migrator's own `Client` must end before the pool connects
     (it does; see `start()` below).
  6. **If `SELECT 1` fails, or the API names differ and can't be fixed from the package's
     README in `node_modules/@electric-sql/pglite-socket/README.md`, STOP and report to the
     owner.** The spec's fallback (Homebrew Postgres) needs their approval. Do not commit the
     spike.

- [ ] **Step 2: Write the PGlite helper** `test/helpers/pg.mjs`. Correct the API names to what
  the spike proved.

```js
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { freePort } from './net.mjs';

/** A real Postgres engine (PGlite) behind a real wire-protocol socket, so the
 *  `pg` driver and the real SQL are exercised with no account and no install.
 *  It does NOT model Neon's wake-from-suspend or its pooler: those are checked
 *  on a Neon branch (plan Task 10). */
export async function startPg() {
  const db = await PGlite.create();
  const port = await freePort();
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
  await server.start();
  return {
    url: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    async stop() { await server.stop(); await db.close(); },
  };
}
```

- [ ] **Step 3: Write the migration** `server/migrations/001_crews.sql`:

```sql
-- Crews: a durable group that outlives a room. See
-- docs/superpowers/specs/2026-10-10-crew-retention-design.md §3.
-- Human names live ONLY in members, so leaving (name := NULL) removes every
-- copy. The tally is derived from pie_players, never stored as a counter.

CREATE TABLE crews (
  id          text PRIMARY KEY,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 24),
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_pie_at timestamptz
);

CREATE TABLE members (
  id          bigserial PRIMARY KEY,
  crew_id     text NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
  device_hash text,
  name        text,
  joined_at   timestamptz NOT NULL DEFAULT now(),
  left_at     timestamptz,
  UNIQUE (crew_id, device_hash)
);

CREATE TABLE pies (
  id        bigserial PRIMARY KEY,
  crew_id   text NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
  pie_key   text NOT NULL,
  played_at timestamptz NOT NULL DEFAULT now(),
  rounds    smallint NOT NULL,
  bots      jsonb NOT NULL DEFAULT '[]',
  guests    jsonb NOT NULL DEFAULT '[]',
  UNIQUE (crew_id, pie_key)
);

CREATE TABLE pie_players (
  pie_id    bigint NOT NULL REFERENCES pies(id) ON DELETE CASCADE,
  member_id bigint NOT NULL REFERENCES members(id),
  points    int NOT NULL,
  won       boolean NOT NULL,
  PRIMARY KEY (pie_id, member_id)
);

CREATE INDEX pies_crew_played ON pies (crew_id, played_at DESC);
```

- [ ] **Step 4: Write the failing test** in `test/db.test.mjs`:

```js
import { createRequire } from 'node:module';
import pg from 'pg';
import { startPg } from './helpers/pg.mjs';

const require = createRequire(import.meta.url);
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };

const pgsrv = await startPg();
const { migrate } = require('../server/migrate');
const db = require('../server/db');

test('migrate applies 001 once and is a no-op the second time', async () => {
  const first = await migrate(pgsrv.url);
  assert(JSON.stringify(first) === '[1]', `first run applied ${JSON.stringify(first)}`);
  const second = await migrate(pgsrv.url);
  assert(second.length === 0, `second run applied ${JSON.stringify(second)}`);
  const c = new pg.Client({ connectionString: pgsrv.url });
  await c.connect();
  const t = await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1");
  await c.end();
  const names = t.rows.map((r) => r.table_name).join(',');
  assert(names === 'crews,members,pie_players,pies,schema_migrations', names);
});

test('classify maps driver failures to reasons in our own words', () => {
  const cases = [
    [{ code: '28P01', message: 'password authentication failed for user "x"' }, 'wrong password'],
    [{ code: '28000' }, 'wrong password'],
    [{ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND nope.invalid' }, 'unknown host'],
    [{ code: 'EAI_AGAIN' }, 'unknown host'],
    [{ code: 'ECONNREFUSED' }, 'timeout'],
    [{ code: '57014', message: 'canceling statement due to statement timeout' }, 'timeout'],
    [{ message: 'timeout expired' }, 'timeout'],
    [{ code: '42P01', message: 'relation "crews" does not exist' }, 'missing table'],
    [{ code: 'XX000', message: 'Your project has exceeded the compute time quota.' }, 'over quota'],
    [{ code: 'NOT_CONFIGURED' }, 'not configured'],
    [{ code: '23505' }, 'database error'],
    [null, 'database error'],
  ];
  for (const [err, want] of cases) assert(db.classify(err) === want, `${JSON.stringify(err)} -> ${db.classify(err)}, want ${want}`);
});

test('start() with no DATABASE_URL is off and never throws', async () => {
  delete process.env.DATABASE_URL;
  await db.start();
  const s = db.state();
  assert(s.status === 'off' && s.reason === 'not configured' && db.publicStatus() === 'off', JSON.stringify(s));
});

test('start() against an unknown host is failing with that reason, and keeps retrying', async () => {
  process.env.DATABASE_URL = 'postgres://u:p@nope.invalid:5432/db';
  process.env.TONDO_DB_RETRY_MS = '60000';
  await db.start();
  const s = db.state();
  assert(s.status === 'failing' && s.reason === 'unknown host' && db.publicStatus() === 'failing', JSON.stringify(s));
  await db.stop();
});

test('start() against PGlite becomes on; run() logs, tx() commits, ping() works', async () => {
  process.env.DATABASE_URL = pgsrv.url;
  process.env.TONDO_DB_POOL_MAX = '1';
  await db.start();
  assert(db.publicStatus() === 'on', JSON.stringify(db.state()));
  const n = await db.run('probe', () => db.tx(async (c) => (await c.query('SELECT 41 + 1 AS n')).rows[0].n), { crew: 'k7m2q9xh3p' });
  assert(n === 42, `got ${n}`);
  await db.ping();
});

test('run() turns a failure into a CrewStoreError with reason + player message, and records it', async () => {
  let caught = null;
  try { await db.run('probe', () => db.tx((c) => c.query('SELECT * FROM no_such_table'))); } catch (err) { caught = err; }
  assert(caught && caught.reason === 'missing table', caught && caught.reason);
  assert(caught.publicMessage === db.PLAYER_MESSAGE, caught.publicMessage);
  assert(db.state().reason === 'missing table' && db.publicStatus() === 'on', JSON.stringify(db.state()));
  await db.run('probe', () => db.tx((c) => c.query('SELECT 1')));
  assert(db.state().status === 'on' && db.state().reason === null, 'a later success recovers');
});

let passed = 0;
const failures = [];
for (const [name, fn] of tests) {
  try { await fn(); passed++; } catch (err) { failures.push({ name, err }); }
}
await db.stop();
await pgsrv.stop();
if (failures.length) {
  for (const f of failures) console.error(`\n  FAIL  ${f.name}\n        ${f.err && f.err.stack}`);
  console.error(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(1);
}
console.log(`\n${passed} passed, 0 failed\n`);
```

- [ ] **Step 5: Run it and confirm it fails.** Run `node test/db.test.mjs`. Expected:
  `Cannot find module '../server/migrate'`.

- [ ] **Step 6: Implement** `server/migrate.js`:

```js
'use strict';

/**
 * Applies server/migrations/NNN_*.sql in order, each in its own transaction,
 * while holding an advisory lock — Render starts the new instance before it
 * stops the old one, so two processes can boot against one database at once.
 * Runs over the DIRECT url: Neon's pooler multiplexes sessions, and a session
 * lock taken through it is not reliably held by "us" (playbook DATA-004).
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const DIR = path.join(__dirname, 'migrations');
const LOCK = 7310;

async function migrate(url) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK]);
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((r) => Number(r.version)));
    const files = fs.readdirSync(DIR).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
    const applied = [];
    for (const file of files) {
      const version = Number(file.slice(0, 3));
      if (done.has(version)) continue;
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(DIR, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
        applied.push(version);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => {});
    await client.end().catch(() => {});
  }
}

module.exports = { migrate };
```

- [ ] **Step 7: Implement** `server/db.js`:

```js
'use strict';

/**
 * The crew store's connection, and what the server knows about its health.
 *
 * The game must never depend on this. Without DATABASE_URL crews are 'off' and
 * nothing else changes; with one that fails, crews are 'failing' with a reason
 * in our own words (never driver text, never the URL) and the server keeps
 * retrying in the background while tables play on.
 *
 * Timeouts: connect 5s — Neon's first connection after scale-to-zero was
 * measured at 1.93s (playbook DATA-002); each statement 3s via SET LOCAL,
 * because the pooled URL may refuse startup options. Idle connections close
 * after 10s so an idle pool is not what keeps Neon awake (spec §8 item 12
 * measures whether that holds).
 */

const { Pool } = require('pg');
const { migrate } = require('./migrate');

const PLAYER_MESSAGE = "Can't reach the crew book right now — your game is fine.";

let pool = null;
let retryTimer = null;
let ready = false;
const current = { status: 'off', reason: 'not configured', since: Date.now() };

class CrewStoreError extends Error {
  constructor(reason, publicMessage = PLAYER_MESSAGE) {
    super(reason);
    this.reason = reason;
    this.publicMessage = publicMessage;
  }
}

function configured() { return Boolean(process.env.DATABASE_URL); }

function setState(status, reason) {
  if (current.status === status && current.reason === reason) return;
  current.status = status;
  current.reason = reason;
  current.since = Date.now();
}

function state() {
  return { status: current.status, reason: current.reason, since: new Date(current.since).toISOString(), ready };
}

/** What a client may know: crews off, usable, or configured but not migrated. */
function publicStatus() {
  if (!configured()) return 'off';
  return ready ? 'on' : 'failing';
}

function classify(err) {
  if (!err) return 'database error';
  const code = err.code;
  const msg = String(err.message || '');
  if (code === 'NOT_CONFIGURED') return 'not configured';
  if (code === '28P01' || code === '28000') return 'wrong password';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'unknown host';
  if (code === '42P01') return 'missing table';
  if (/compute time quota/i.test(msg)) return 'over quota';
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === '57014' || /timeout/i.test(msg)) return 'timeout';
  return 'database error';
}

function getPool() {
  if (!configured()) { const e = new Error('not configured'); e.code = 'NOT_CONFIGURED'; throw e; }
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.TONDO_DB_POOL_MAX) || 5,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
    });
    // An idle client dying (Neon suspending the compute) must not crash the process.
    pool.on('error', (err) => console.warn(`[crews] idle connection dropped: ${classify(err)}`));
  }
  return pool;
}

async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '3s'");
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** One store operation: timed, logged, classified. CrewStoreErrors pass through untouched. */
async function run(op, fn, meta = {}) {
  const t0 = Date.now();
  const crew = meta.crew ? ` crew=${meta.crew}` : '';
  try {
    const out = await fn();
    if (ready) setState('on', null);
    console.log(`[crews] ${op} ok${crew} ms=${Date.now() - t0}`);
    return out;
  } catch (err) {
    if (err instanceof CrewStoreError) {
      console.log(`[crews] ${op} refused${crew}: ${err.reason}`);
      throw err;
    }
    const reason = classify(err);
    // Once migrated, status stays 'on' (a later success must be able to
    // recover); the last op's failure reason stays visible in /health.
    setState(ready ? 'on' : 'failing', reason);
    console.warn(`[crews] ${op} failed${crew}: ${reason}`);
    throw new CrewStoreError(reason);
  }
}

async function ping() { await run('ping', () => tx((c) => c.query('SELECT 1'))); }

async function start({ migrateFn = migrate } = {}) {
  clearTimeout(retryTimer);
  if (!configured()) { ready = false; setState('off', 'not configured'); return; }
  setState('starting', null);
  let delay = Number(process.env.TONDO_DB_RETRY_MS) || 30000;
  const attempt = async () => {
    try {
      const applied = await migrateFn(process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL);
      ready = true;
      setState('on', null);
      console.log(`[crews] store ready${applied.length ? ` (applied ${applied.join(', ')})` : ''}`);
    } catch (err) {
      const reason = classify(err);
      setState('failing', reason);
      console.warn(`[crews] start failed: ${reason}; retrying in ${Math.round(delay / 1000)}s`);
      retryTimer = setTimeout(attempt, delay);
      if (retryTimer.unref) retryTimer.unref();
      delay = Math.min(delay * 2, 600000);
    }
  };
  await attempt();
}

/** Awaitable: a test (or a restart) that hands the database to another process
 *  must know the pool's connections are actually closed first. */
async function stop() {
  clearTimeout(retryTimer);
  retryTimer = null;
  const p = pool;
  pool = null;
  ready = false;
  if (p) await p.end().catch(() => {});
}

module.exports = { configured, start, stop, state, publicStatus, tx, run, ping, classify, CrewStoreError, PLAYER_MESSAGE };
```

  Note on `run`: a runtime failure keeps `status: 'on'` once migrated (with the reason
  visible), because `publicStatus` gates client controls on `ready`, not on the last op. This
  is the Global Constraints rule.

- [ ] **Step 8: Run it and confirm it passes.** Run `node test/db.test.mjs`. Expected:
  `6 passed, 0 failed`. If the unknown-host case reports `timeout` instead (some resolvers
  answer `.invalid` slowly), keep the assertion. Increase nothing, read the actual `err.code`
  printed by a temporary `console.log(err.code)` in `classify`, add that code to the
  `unknown host` line, and remove the log.

- [ ] **Step 9: Add the local dev database script** `scripts/dev-db.mjs`:

```js
// A local Postgres (PGlite) for trying crews by hand, no account needed:
//   node scripts/dev-db.mjs            (prints the DATABASE_URL to use)
//   DATABASE_URL=<that> TONDO_DB_POOL_MAX=1 npm start
// Data lives in memory and is gone when this process stops.
import { startPg } from '../test/helpers/pg.mjs';
const pg = await startPg();
console.log(`DATABASE_URL=${pg.url}`);
process.on('SIGINT', async () => { await pg.stop(); process.exit(0); });
```

- [ ] **Step 10: Add the `test:db` script and run it.** In `package.json` add
  `"test:db": "node test/db.test.mjs"`. Tasks 4-5 append to it. Run `npm run test:db`.
  Expected: `0 failed`.

- [ ] **Step 11: Commit**

```bash
git add server/db.js server/migrate.js server/migrations test/helpers/pg.mjs test/db.test.mjs scripts/dev-db.mjs package.json package-lock.json
git commit -m "A crew store the game never waits on: migrations, timeouts, reasons in our words

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The crew store

**Files:**
- Create: `server/crews.js`, `test/crews.test.mjs`
- Modify: `package.json` (`test:db`)

**Interfaces:**
- Consumes: `db.tx`, `db.run`, `db.CrewStoreError` (Task 3).
- Produces from `server/crews.js`:
  - `validCrewId(s) -> boolean`, `newCrewId() -> string`.
  - `hashDevice(device) -> string|null` (`null` unless `/^[0-9a-f]{32}$/`).
  - `cleanCrewName(raw) -> string|null`.
  - `savePie(target, record) -> Promise<{ id, name, duplicate: boolean }>`, where `target` is
    `{ crewId }` or `{ newName }` and `record` is
    `{ pieKey, rounds, players: Array<{ kind: 'human', deviceHash: string|null, name, points, won } | { kind: 'bot', name, points, won }> }`.
    It throws `CrewStoreError('not found', 'That crew is gone.')` for an unknown crew id.
  - `readCrew(id, deviceHash|null) -> Promise<null | { id, name, pies, members: [{ name, pies, wins, you }], recent: [{ playedAt, rounds, players: [{ name: string|null, points, won, kind }] }] }>`.
  - `leave(id, deviceHash) -> Promise<boolean>`.
  - `crewName(id) -> Promise<string|null>`.

- [ ] **Step 1: Write the failing test** in `test/crews.test.mjs`:

```js
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { startPg } from './helpers/pg.mjs';

const require = createRequire(import.meta.url);
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };

const pgsrv = await startPg();
process.env.DATABASE_URL = pgsrv.url;
process.env.TONDO_DB_POOL_MAX = '1';
const db = require('../server/db');
const crews = require('../server/crews');
await db.start();
assert(db.publicStatus() === 'on', JSON.stringify(db.state()));

const dev = () => crypto.randomBytes(16).toString('hex');
const key = () => crypto.randomBytes(8).toString('hex');
const human = (device, name, points, won = false) => ({ kind: 'human', deviceHash: device ? crews.hashDevice(device) : null, name, points, won });
const bot = (name, points, won = false) => ({ kind: 'bot', name, points, won });

test('ids, names and device secrets are validated', () => {
  const id = crews.newCrewId();
  assert(crews.validCrewId(id) && id.length === 10, id);
  assert(!crews.validCrewId('k7m2q9xh3P') && !crews.validCrewId('k7m2q9xh3') && !crews.validCrewId('oooooooooo'), 'rejects bad ids');
  assert(crews.cleanCrewName('  Friday   Pie  ') === 'Friday Pie', 'collapses whitespace');
  assert(crews.cleanCrewName('x'.repeat(30)).length === 24, 'caps at 24');
  assert(crews.cleanCrewName('   ') === null && crews.cleanCrewName(null) === null, 'empty is null');
  assert(crews.hashDevice('a'.repeat(32)).length === 64 && crews.hashDevice('xyz') === null, 'hash or null');
});

test('a new crew with 3 humans + 1 bot: 3 members, bot only in history, tally derived', async () => {
  const [g, a, d] = [dev(), dev(), dev()];
  const saved = await crews.savePie({ newName: 'Friday Pie' }, { pieKey: key(), rounds: 4, players: [
    human(g, 'Gent', 212, true), human(a, 'Arta', 180), bot('Chef Bot', 40), human(d, 'Dren', 12),
  ] });
  assert(saved.name === 'Friday Pie' && crews.validCrewId(saved.id) && saved.duplicate === false, JSON.stringify(saved));
  const crew = await crews.readCrew(saved.id, crews.hashDevice(g));
  assert(crew.pies === 1 && crew.members.length === 3, JSON.stringify(crew));
  assert(crew.members[0].name === 'Gent' && crew.members[0].wins === 1 && crew.members[0].you === true, JSON.stringify(crew.members[0]));
  const kinds = crew.recent[0].players.map((p) => `${p.kind}:${p.name}`).join(',');
  assert(kinds === 'member:Gent,member:Arta,bot:Chef Bot,member:Dren', kinds);
});

test('saving the same pie twice records it once', async () => {
  const g = dev();
  const record = { pieKey: key(), rounds: 4, players: [human(g, 'Gent', 10, true), bot('Pina', 5)] };
  const first = await crews.savePie({ newName: 'Dupes' }, record);
  const again = await crews.savePie({ crewId: first.id }, record);
  assert(again.duplicate === true, 'second is a duplicate');
  assert((await crews.readCrew(first.id, null)).pies === 1, 'one pie');
});

test('same device in two seats (two tabs): the second seat is a guest, the save succeeds', async () => {
  const g = dev();
  const saved = await crews.savePie({ newName: 'Two Tabs' }, { pieKey: key(), rounds: 4, players: [
    human(g, 'Gent', 30, true), human(g, 'Gent', 20), bot('Pina', 5),
  ] });
  const crew = await crews.readCrew(saved.id, crews.hashDevice(g));
  assert(crew.members.length === 1, `members ${crew.members.length}`);
  const kinds = crew.recent[0].players.map((p) => p.kind).join(',');
  assert(kinds === 'member,guest,bot', kinds);
});

test('a seat with no device is a nameless guest', async () => {
  const saved = await crews.savePie({ newName: 'Guests' }, { pieKey: key(), rounds: 4, players: [human(dev(), 'Gent', 9, true), human(null, 'Old Client', 3)] });
  const crew = await crews.readCrew(saved.id, null);
  const guest = crew.recent[0].players.find((p) => p.kind === 'guest');
  assert(guest && guest.name === null && guest.points === 3, JSON.stringify(crew.recent[0]));
});

test('two different devices named Gent read back as Gent and Gent 2; a rename sticks', async () => {
  const [g1, g2] = [dev(), dev()];
  const saved = await crews.savePie({ newName: 'Gents' }, { pieKey: key(), rounds: 4, players: [human(g1, 'Gent', 9, true), human(g2, 'gent', 3)] });
  let names = (await crews.readCrew(saved.id, null)).members.map((m) => m.name).sort().join(',');
  assert(names === 'Gent,gent 2', names);
  await crews.savePie({ crewId: saved.id }, { pieKey: key(), rounds: 4, players: [human(g2, 'Vesa', 9, true), human(g1, 'Gent', 3)] });
  names = (await crews.readCrew(saved.id, null)).members.map((m) => m.name).sort().join(',');
  assert(names === 'Gent,Vesa', names);
});

test('leaving removes the name everywhere; past pies say former; rejoining is a new member', async () => {
  const [g, a] = [dev(), dev()];
  const saved = await crews.savePie({ newName: 'Leavers' }, { pieKey: key(), rounds: 4, players: [human(g, 'Gent', 9, true), human(a, 'Arta', 3)] });
  assert(await crews.leave(saved.id, crews.hashDevice(a)) === true, 'left');
  assert(await crews.leave(saved.id, crews.hashDevice(a)) === false, 'second leave is a no-op');
  const crew = await crews.readCrew(saved.id, crews.hashDevice(a));
  assert(crew.members.length === 1 && !crew.members.some((m) => m.you), JSON.stringify(crew.members));
  const former = crew.recent[0].players.find((p) => p.kind === 'former');
  assert(former && former.name === null, JSON.stringify(crew.recent[0]));
  const c = await db.tx((cl) => cl.query("SELECT count(*)::int AS n FROM members WHERE name = 'Arta'"));
  assert(c.rows[0].n === 0, 'no copy of the name remains');
});

test('unknown crew: read is null, save throws a clear refusal, crewName is null', async () => {
  assert(await crews.readCrew('zzzzzzzzzz', null) === null, 'read null');
  let err = null;
  try { await crews.savePie({ crewId: 'zzzzzzzzzz' }, { pieKey: key(), rounds: 4, players: [] }); } catch (e) { err = e; }
  assert(err && err.publicMessage === 'That crew is gone.', err && err.message);
  assert(await crews.crewName('zzzzzzzzzz') === null, 'crewName null');
});

test('recent is capped at 5, newest first, and members sort by wins then pies', async () => {
  const [g, a] = [dev(), dev()];
  const first = await crews.savePie({ newName: 'Busy' }, { pieKey: key(), rounds: 4, players: [human(g, 'Gent', 1, true), human(a, 'Arta', 0)] });
  for (let i = 0; i < 6; i++) {
    await crews.savePie({ crewId: first.id }, { pieKey: key(), rounds: 4, players: [human(g, 'Gent', 0), human(a, 'Arta', 100 + i, true)] });
  }
  const crew = await crews.readCrew(first.id, null);
  assert(crew.pies === 7 && crew.recent.length === 5, `pies ${crew.pies} recent ${crew.recent.length}`);
  assert(crew.recent[0].players[0].points === 105, 'newest first');
  assert(crew.members[0].name === 'Arta' && crew.members[0].wins === 6, JSON.stringify(crew.members));
});

let passed = 0;
const failures = [];
for (const [name, fn] of tests) {
  try { await fn(); passed++; } catch (err) { failures.push({ name, err }); }
}
await db.stop();
await pgsrv.stop();
if (failures.length) {
  for (const f of failures) console.error(`\n  FAIL  ${f.name}\n        ${f.err && f.err.stack}`);
  console.error(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(1);
}
console.log(`\n${passed} passed, 0 failed\n`);
```

- [ ] **Step 2: Run it and confirm it fails.** Run `node test/crews.test.mjs`. Expected:
  `Cannot find module '../server/crews'`.

- [ ] **Step 3: Implement** `server/crews.js`:

```js
'use strict';

/**
 * The crew store — the only module that touches crew tables.
 *
 * Results are SERVER-SOURCED: savePie takes a record the room built from its
 * own pie (server/rooms.js pieRecord), never anything a client sent. Human
 * names live only in `members`, so leave() erasing name + device removes every
 * copy; the tally is derived from pie_players on read, so it cannot drift.
 */

const crypto = require('crypto');
const db = require('./db');

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const CREW_ID = /^[0-9a-hjkmnp-tv-z]{10}$/;
const DEVICE = /^[0-9a-f]{32}$/;
const RECENT = 5;

const validCrewId = (s) => typeof s === 'string' && CREW_ID.test(s);

function newCrewId() {
  return Array.from(crypto.randomBytes(10), (b) => ALPHABET[b & 31]).join('');
}

function hashDevice(device) {
  if (typeof device !== 'string' || !DEVICE.test(device)) return null;
  return crypto.createHash('sha256').update(device).digest('hex');
}

function cleanCrewName(raw) {
  const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, 24).trim();
  return s || null;
}

function savePie(target, record) {
  const crewLabel = target.crewId || 'new';
  return db.run('save', () => db.tx(async (c) => {
    let crew;
    if (target.newName) {
      const name = cleanCrewName(target.newName);
      if (!name) throw new db.CrewStoreError('bad name', 'Give the crew a name.');
      // 32^10 ids: a collision is astronomically unlikely, but retried rather than assumed away.
      for (let i = 0; i < 3 && !crew; i++) {
        const r = await c.query('INSERT INTO crews (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id, name', [newCrewId(), name]);
        crew = r.rows[0];
      }
      if (!crew) throw new Error('could not mint a crew id');
    } else {
      const r = await c.query('SELECT id, name FROM crews WHERE id = $1 FOR UPDATE', [target.crewId]);
      crew = r.rows[0];
      if (!crew) throw new db.CrewStoreError('not found', 'That crew is gone.');
    }

    // One device, one member row per pie: a second seat on the same device
    // (two tabs on one laptop) is recorded as a guest rather than violating
    // the (pie_id, member_id) key and losing the whole save.
    const seen = new Set();
    const members = [];
    const guests = [];
    const bots = [];
    for (const p of record.players) {
      if (p.kind === 'bot') bots.push({ name: String(p.name), points: p.points, won: !!p.won });
      else if (p.deviceHash && !seen.has(p.deviceHash)) { seen.add(p.deviceHash); members.push(p); }
      else guests.push({ points: p.points, won: !!p.won });
    }

    const pie = await c.query(
      `INSERT INTO pies (crew_id, pie_key, rounds, bots, guests) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (crew_id, pie_key) DO NOTHING RETURNING id`,
      [crew.id, record.pieKey, record.rounds, JSON.stringify(bots), JSON.stringify(guests)]);
    if (!pie.rows[0]) return { id: crew.id, name: crew.name, duplicate: true };
    const pieId = pie.rows[0].id;

    for (const p of members) {
      const m = await c.query(
        `INSERT INTO members (crew_id, device_hash, name) VALUES ($1, $2, $3)
         ON CONFLICT (crew_id, device_hash) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [crew.id, p.deviceHash, String(p.name)]);
      await c.query('INSERT INTO pie_players (pie_id, member_id, points, won) VALUES ($1, $2, $3, $4)',
        [pieId, m.rows[0].id, p.points, !!p.won]);
    }
    await c.query('UPDATE crews SET last_pie_at = now() WHERE id = $1', [crew.id]);
    return { id: crew.id, name: crew.name, duplicate: false };
  }), { crew: crewLabel });
}

/** "Gent", "Gent 2": collisions numbered by join order, case-insensitively, at read time. */
function displayNames(rows) {
  const counts = new Map();
  const out = new Map();
  for (const r of rows) {
    if (r.name == null) continue;
    const k = r.name.toLowerCase();
    const n = (counts.get(k) || 0) + 1;
    counts.set(k, n);
    out.set(String(r.id), n === 1 ? r.name : `${r.name} ${n}`);
  }
  return out;
}

function readCrew(id, deviceHash) {
  return db.run('read', () => db.tx(async (c) => {
    const crew = (await c.query('SELECT id, name FROM crews WHERE id = $1', [id])).rows[0];
    if (!crew) return null;
    const memberRows = (await c.query(
      `SELECT m.id, m.name, m.device_hash,
              count(pp.pie_id)::int AS pies,
              (count(pp.pie_id) FILTER (WHERE pp.won))::int AS wins
         FROM members m LEFT JOIN pie_players pp ON pp.member_id = m.id
        WHERE m.crew_id = $1
        GROUP BY m.id ORDER BY m.joined_at, m.id`, [id])).rows;
    const pieRows = (await c.query(
      `SELECT p.id, p.played_at, p.rounds, p.bots, p.guests,
              (SELECT count(*)::int FROM pies WHERE crew_id = $1) AS total,
              coalesce(json_agg(json_build_object('memberId', pp.member_id, 'points', pp.points, 'won', pp.won))
                       FILTER (WHERE pp.pie_id IS NOT NULL), '[]') AS players
         FROM pies p LEFT JOIN pie_players pp ON pp.pie_id = p.id
        WHERE p.crew_id = $1
        GROUP BY p.id ORDER BY p.played_at DESC, p.id DESC LIMIT ${RECENT}`, [id])).rows;

    const names = displayNames(memberRows);
    const members = memberRows
      .filter((r) => r.name != null)
      .map((r) => ({ name: names.get(String(r.id)), pies: r.pies, wins: r.wins, you: !!deviceHash && r.device_hash === deviceHash }))
      .sort((a, b) => b.wins - a.wins || b.pies - a.pies || a.name.localeCompare(b.name));
    const recent = pieRows.map((p) => ({
      playedAt: new Date(p.played_at).toISOString(),
      rounds: p.rounds,
      players: []
        .concat(p.players.map((x) => {
          const name = names.get(String(x.memberId));
          return { name: name || null, points: x.points, won: x.won, kind: name ? 'member' : 'former' };
        }))
        .concat(p.guests.map((g) => ({ name: null, points: g.points, won: g.won, kind: 'guest' })))
        .concat(p.bots.map((b) => ({ name: b.name, points: b.points, won: b.won, kind: 'bot' })))
        .sort((a, b) => b.points - a.points),
    }));
    return { id: crew.id, name: crew.name, pies: pieRows.length ? pieRows[0].total : 0, members, recent };
  }), { crew: id });
}

function leave(id, deviceHash) {
  return db.run('leave', () => db.tx(async (c) => {
    const r = await c.query(
      'UPDATE members SET name = NULL, device_hash = NULL, left_at = now() WHERE crew_id = $1 AND device_hash = $2 RETURNING id',
      [id, deviceHash]);
    return r.rowCount > 0;
  }), { crew: id });
}

function crewName(id) {
  return db.run('lookup', () => db.tx(async (c) => {
    const r = await c.query('SELECT name FROM crews WHERE id = $1', [id]);
    return r.rows[0] ? r.rows[0].name : null;
  }), { crew: id });
}

module.exports = { validCrewId, newCrewId, hashDevice, cleanCrewName, savePie, readCrew, leave, crewName };
```

  Note: in the first test the expected player order is
  `member:Gent,member:Arta,bot:Chef Bot,member:Dren`, which is by points
  (212, 180, 40, 12). That is the sort, not insertion order.

- [ ] **Step 4: Run it and confirm it passes.** Run `node test/crews.test.mjs`. Expected:
  `9 passed, 0 failed`.

- [ ] **Step 5: Extend `test:db`** to `node test/db.test.mjs && node test/crews.test.mjs`, then
  run `npm run test:db`. Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add server/crews.js test/crews.test.mjs package.json
git commit -m "The crew book: server-sourced results, a tally that cannot drift, leaving erases the name

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Server wiring (protocol v1.4)

**Files:**
- Create: `server/crew-actions.js`, `server/crew-http.js`, `test/crew-actions.test.mjs`,
  `test/crew-server.test.mjs`
- Modify:
  - `PROTOCOL.md`: header, Client→server, state shape, HTTP
  - `server/rooms.js`: `freshPie`, `Room` constructor, `addSeat`, `snapshotFor`, new
    `pieRecord`; `RoomManager` constructor, `createRoom`, `joinRoom`
  - `server/index.js`
  - `package.json`

**Interfaces:**
- Consumes: Task 2's `budgets` and `session.ip`; Task 3's `db.start`, `publicStatus`, `state`,
  `ping` and `PLAYER_MESSAGE`; Task 4's crews API.
- Produces (wire, which Tasks 6-8 rely on):
  - `createRoom { name, device?, crewId? }` and `joinRoom { code, name, token?, device? }`.
  - `saveToCrew { crewId } | { newCrewName }`.
  - Snapshot: `crews: 'off'|'on'|'failing'`, `crew: {id, name}|null`,
    `match.savedTo: {id, name}|null`, `match.saving: boolean`.
  - `GET /api/crew/:id` (header `X-Tondo-Device`) returns 200 with the `readCrew` shape, or
    404 `{ error: 'not found' }`, or 503 `{ reason }`, or 429.
  - `POST /api/crew/:id/leave` (body `{ device }`) returns 204, 400, 503 or 429.
  - `GET /health/crews` returns 200 `{ ok: true }` or 503 `{ ok: false, reason }`.
  - `GET /health` returns `{ ok, rooms, crews: db.state() }`.
- Produces in `server/rooms.js`:
  - `new RoomManager({ crewsStatus } = {})`.
  - `manager.createRoom(name, socket, { deviceHash } = {})`. The crew lookup for `crewId`
    lives in index.js, off the hot path.
  - `manager.joinRoom(code, name, socket, token, { deviceHash } = {})`.
  - `room.pieRecord()`.
  - `room.crew`.
- Produces in `server/crew-actions.js`:
  `saveToCrew({ room, seat, message, ip, budgets, store?, status? }) -> { refuse: string } | { noop: true } | { started: Promise<{ ok, crew?, message? }> }`.

- [ ] **Step 1: Update PROTOCOL.md first.**
  1. Title: `(v1.4)`. Add a header paragraph:

```markdown
**v1.4 (2026-10-10)** adds crews — a durable group that outlives a room — and
is purely ADDITIVE: every v1.3 message and field keeps its meaning, and a
client that ignores the new fields plays exactly as before. New: an optional
`device` on `createRoom`/`joinRoom`, an optional `crewId` on `createRoom`, the
`saveToCrew` message, four snapshot fields, and three HTTP routes. Limits gain
per-address budgets (see *Limits*).
```

  2. Under *Client → server*, add rows/lines:
     - `createRoom` / `joinRoom` take optional `device`, 32 lowercase hex characters, a
       per-browser secret the server stores only hashed. Without one the seat plays normally
       but is never a crew member.
     - `createRoom` takes optional `crewId`, which links the table to that crew.
     - `saveToCrew { crewId }` or `saveToCrew { newCrewName }`: from a seated human after the
       pie is complete. It carries no scores; the server records its own. One crew per pie:
       re-saving to the same crew is a no-op; another crew is refused.
  3. Under *`state` snapshot shape*, add:
     - `crews: 'off' | 'on' | 'failing'`.
     - `crew: {id, name} | null`, the crew this table belongs to.
     - `match.savedTo: {id, name} | null`.
     - `match.saving: boolean`.
  4. Under *HTTP*, add the three routes with their status codes (copy from Interfaces above),
     plus the `/health` `crews` field. Note that `/health` never queries the database, and
     why (Neon CU-hours, spec §4.2).

- [ ] **Step 2: Write the failing action test** in `test/crew-actions.test.mjs`. It uses a real
  `Room`, a real PGlite-backed store and fake sockets:

```js
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { startPg } from './helpers/pg.mjs';

const require = createRequire(import.meta.url);
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };

const pgsrv = await startPg();
process.env.DATABASE_URL = pgsrv.url;
process.env.TONDO_DB_POOL_MAX = '1';
const db = require('../server/db');
const crews = require('../server/crews');
const { RoomManager } = require('../server/rooms');
const { saveToCrew } = require('../server/crew-actions');
const { createIpBudgets } = require('../server/limits');
await db.start();

const sock = () => ({ readyState: 1, sent: [], send(d) { this.sent.push(JSON.parse(d)); }, terminate() {}, close() {} });
const dev = () => crypto.randomBytes(16).toString('hex');

/** A finished pie at a 3-human + 1-bot table, scored by hand. */
function finishedTable() {
  const manager = new RoomManager({ crewsStatus: () => db.publicStatus() });
  manager.stop();
  const devices = [dev(), dev(), dev()];
  const made = manager.createRoom('Gent', sock(), { deviceHash: crews.hashDevice(devices[0]) });
  const room = made.room;
  const arta = manager.joinRoom(room.code, 'Arta', sock(), undefined, { deviceHash: crews.hashDevice(devices[1]) }).seat;
  const dren = manager.joinRoom(room.code, 'Dren', sock(), undefined, { deviceHash: crews.hashDevice(devices[2]) }).seat;
  const chef = room.addSeat({ name: 'Chef Bot', isBot: true });
  room.pie.scores = {
    [made.seat.id]: { points: 212, roundsWon: 2 }, [arta.id]: { points: 180, roundsWon: 1 },
    [chef.id]: { points: 40, roundsWon: 1 }, [dren.id]: { points: 0, roundsWon: 0 },
  };
  room.pie.round = 4;
  room.pie.complete = true;
  room.pie.championIds = room.leaders();
  return { manager, room, host: made.seat, arta, dren, chef, devices };
}
const budgets = () => createIpBudgets();

test('refused before the pie is complete, from a bot, and with a malformed crew id', async () => {
  const t = finishedTable();
  t.room.pie.complete = false;
  assert(saveToCrew({ room: t.room, seat: t.host, message: { newCrewName: 'X' }, ip: 'a', budgets: budgets() }).refuse === 'Finish the pie first.', 'incomplete');
  t.room.pie.complete = true;
  assert(saveToCrew({ room: t.room, seat: t.chef, message: { newCrewName: 'X' }, ip: 'a', budgets: budgets() }).refuse === 'Bots do not save pies.', 'bot');
  assert(saveToCrew({ room: t.room, seat: t.host, message: { crewId: '../../etc' }, ip: 'a', budgets: budgets() }).refuse === 'That crew link is not right.', 'bad id');
});

test('refused when crews are not on', () => {
  const t = finishedTable();
  const out = saveToCrew({ room: t.room, seat: t.host, message: { newCrewName: 'X' }, ip: 'a', budgets: budgets(), status: () => 'failing' });
  assert(out.refuse === db.PLAYER_MESSAGE, out.refuse);
});

test('a save records server scores, ignores client-sent scores, sets savedTo and room.crew', async () => {
  const t = finishedTable();
  const out = saveToCrew({ room: t.room, seat: t.arta, message: { newCrewName: 'Friday Pie', points: 99999, standings: [] }, ip: 'a', budgets: budgets() });
  assert(out.started && t.room.pie.saving === true, 'saving');
  const r = await out.started;
  assert(r.ok && t.room.pie.saving === false && t.room.pie.savedTo.name === 'Friday Pie', JSON.stringify(r));
  assert(t.room.crew && t.room.crew.id === t.room.pie.savedTo.id, 'room remembers its crew');
  const crew = await crews.readCrew(r.crew.id, crews.hashDevice(t.devices[0]));
  assert(crew.members.length === 3 && crew.members[0].name === 'Gent' && crew.members[0].wins === 1, JSON.stringify(crew.members));
  assert(!JSON.stringify(crew).includes('99999'), 'client scores ignored');
  const snap = t.room.snapshotFor(t.host.id);
  assert(snap.crews === 'on' && snap.crew.id === r.crew.id && snap.match.savedTo.id === r.crew.id && snap.match.saving === false, JSON.stringify({ crews: snap.crews, crew: snap.crew, m: snap.match.savedTo }));
});

test('concurrent saves: two seats tapping at once -> one pie row, no error', async () => {
  const t = finishedTable();
  const first = saveToCrew({ room: t.room, seat: t.host, message: { newCrewName: 'Race' }, ip: 'a', budgets: budgets() });
  const second = saveToCrew({ room: t.room, seat: t.arta, message: { newCrewName: 'Race' }, ip: 'b', budgets: budgets() });
  assert(first.started && second.noop === true, `second: ${JSON.stringify(second)}`);
  const r = await first.started;
  const again = saveToCrew({ room: t.room, seat: t.dren, message: { crewId: r.crew.id }, ip: 'c', budgets: budgets() });
  assert(again.noop === true, 'same crew after save is a no-op');
  assert((await crews.readCrew(r.crew.id, null)).pies === 1, 'one pie');
});

test('a second crew for the same pie is refused by name', async () => {
  const t = finishedTable();
  const r = await saveToCrew({ room: t.room, seat: t.host, message: { newCrewName: 'First' }, ip: 'a', budgets: budgets() }).started;
  const other = saveToCrew({ room: t.room, seat: t.host, message: { newCrewName: 'Second' }, ip: 'a', budgets: budgets() });
  assert(other.refuse === 'This pie is already saved to First.', other.refuse);
  assert(r.ok, 'first ok');
});

test('a dead crew id comes back as the store message, and saving clears', async () => {
  const t = finishedTable();
  const r = await saveToCrew({ room: t.room, seat: t.host, message: { crewId: 'zzzzzzzzzz' }, ip: 'a', budgets: budgets() }).started;
  assert(!r.ok && r.message === 'That crew is gone.' && t.room.pie.saving === false && t.room.pie.savedTo === null, JSON.stringify(r));
});

test('the crew-creation budget is spent per address', async () => {
  const b = budgets();
  for (let i = 0; i < 10; i++) b.crewCreate.take('z');
  const t = finishedTable();
  const out = saveToCrew({ room: t.room, seat: t.host, message: { newCrewName: 'Eleventh' }, ip: 'z', budgets: b });
  assert(out.refuse === 'You have started enough crews for now. Try again later.', out.refuse);
});

let passed = 0;
const failures = [];
for (const [name, fn] of tests) {
  try { await fn(); passed++; } catch (err) { failures.push({ name, err }); }
}
await db.stop();
await pgsrv.stop();
if (failures.length) {
  for (const f of failures) console.error(`\n  FAIL  ${f.name}\n        ${f.err && f.err.stack}`);
  console.error(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(1);
}
console.log(`\n${passed} passed, 0 failed\n`);
```

- [ ] **Step 3: Run it and confirm it fails.** Run `node test/crew-actions.test.mjs`. Expected:
  `Cannot find module '../server/crew-actions'`.

- [ ] **Step 4: Change `server/rooms.js`.**
  1. `freshPie()`: add `pieKey: crypto.randomBytes(8).toString('hex'), savedTo: null,
     saving: false,` with a comment: "`pieKey` names this pie to the crew store so a double
     save is one row; it never goes on the wire".
  2. `Room` constructor: `constructor(code, { crewsStatus = () => 'off' } = {})`. Store
     `this.crewsStatus = crewsStatus;` and add `this.crew = null; // {id, name}: the crew this
     table was started from, or first saved to`.
  3. `addSeat({ name, isBot = false, socket = null, deviceHash = null })`: add
     `deviceHash: isBot ? null : deviceHash,` to the seat object, with a comment: "sha256 of
     the browser's device secret; it never goes on the wire".
  4. `snapshotFor`: add top-level `crews: this.crewsStatus(), crew: this.crew,` after
     `isHost`. In `match`, add `savedTo: this.pie.savedTo, saving: this.pie.saving,`.
  5. Add after `recordRound()`:

```js
  /**
   * The finished pie as the crew store records it — built from the server's
   * own standings, never from anything a client sent. Seats that left before
   * the end are not in standings(), exactly as the scoreboard shows.
   */
  pieRecord() {
    const champions = new Set(this.pie.championIds);
    return {
      pieKey: this.pie.pieKey,
      rounds: this.pie.roundsPerPie,
      players: this.standings().map((r) => {
        if (r.isBot) return { kind: 'bot', name: r.name, points: r.points, won: champions.has(r.id) };
        const seat = this.findSeat(r.id);
        return { kind: 'human', deviceHash: (seat && seat.deviceHash) || null, name: r.name, points: r.points, won: champions.has(r.id) };
      }),
    };
  }
```

  6. `RoomManager`: change the constructor to `constructor({ crewsStatus } = {})` and store
     `this.crewsStatus = crewsStatus || (() => 'off');`. In `createRoom`, change the signature
     to `createRoom(name, socket, { deviceHash = null } = {})`, build the room with
     `new Room(code, { crewsStatus: this.crewsStatus })`, and add the seat with
     `room.addSeat({ name: cleaned, socket, deviceHash })`.
  7. `joinRoom(code, name, socket, token, { deviceHash = null } = {})`. When reclaiming,
     `if (deviceHash && !claimed.deviceHash) claimed.deviceHash = deviceHash;`. When adding a
     new seat, pass `deviceHash`.
  8. Run `npm test`. Expected: 116+ still pass. The existing callers pass no options, so the
     defaults hold.

- [ ] **Step 5: Implement** `server/crew-actions.js`:

```js
'use strict';

/**
 * Whether a `saveToCrew` may run, and running it. Kept out of index.js so the
 * decision is testable with a real Room and a real store and no socket server.
 *
 * Returns { refuse } (send the refusal), { noop } (nothing to do — a save is
 * already running or already landed), or { started } (a promise that settles
 * after pie.saving is cleared; the caller broadcasts and reports an error).
 */

const crews = require('./crews');
const db = require('./db');

function saveToCrew({ room, seat, message, ip, budgets, store = crews, status = () => db.publicStatus() }) {
  if (seat.isBot) return { refuse: 'Bots do not save pies.' };
  const pie = room.pie;
  if (!pie.complete) return { refuse: 'Finish the pie first.' };
  if (status() !== 'on') return { refuse: db.PLAYER_MESSAGE };

  const wantNew = typeof message.newCrewName === 'string';
  const crewId = wantNew ? null : String(message.crewId || '');
  if (!wantNew && !store.validCrewId(crewId)) return { refuse: 'That crew link is not right.' };

  // One crew per pie: the same crew again is a no-op, any other is refused by name.
  if (pie.savedTo) {
    if (!wantNew && pie.savedTo.id === crewId) return { noop: true };
    return { refuse: `This pie is already saved to ${pie.savedTo.name}.` };
  }
  // A save already running (two players tapping at once): the snapshot will show it land.
  if (pie.saving) return { noop: true };

  const newName = wantNew ? store.cleanCrewName(message.newCrewName) : null;
  if (wantNew && !newName) return { refuse: 'Give the crew a name.' };
  if (wantNew && !budgets.crewCreate.take(ip)) return { refuse: 'You have started enough crews for now. Try again later.' };

  // Built NOW, from this pie: a newRound during the save replaces room.pie and
  // must not change what is recorded or where savedTo lands.
  const record = room.pieRecord();
  pie.saving = true;
  const started = store.savePie(wantNew ? { newName } : { crewId }, record).then(
    (saved) => {
      pie.saving = false;
      pie.savedTo = { id: saved.id, name: saved.name };
      if (!room.crew) room.crew = pie.savedTo;
      return { ok: true, crew: pie.savedTo };
    },
    (err) => {
      pie.saving = false;
      return { ok: false, message: (err && err.publicMessage) || db.PLAYER_MESSAGE };
    });
  return { started };
}

module.exports = { saveToCrew };
```

- [ ] **Step 6: Run the action test.** Run `node test/crew-actions.test.mjs`. Expected:
  `7 passed, 0 failed`.

- [ ] **Step 7: Implement** `server/crew-http.js`:

```js
'use strict';

/**
 * The crew's HTTP surface: read a crew, leave it, and a health check that
 * actually touches the database (for drills; the host's own health check is
 * /health, which never does — spec §4.2, Neon CU-hours).
 *
 * The device secret arrives in a header (read) or a JSON body (leave), never
 * in the URL, which ends up in logs and history.
 */

const crews = require('./crews');
const db = require('./db');

const ROUTE = /^\/api\/crew\/([^/?]+)(\/leave)?(?:\?.*)?$/;

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

function readBody(req, limit = 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function matches(url) {
  return url === '/health/crews' || ROUTE.test(url);
}

async function handle(req, res, { ip, budgets, store = crews }) {
  if (!budgets.crewRead.take(ip)) return json(res, 429, { error: 'slow down' });

  if (req.url === '/health/crews') {
    if (req.method !== 'GET') return json(res, 405, { error: 'method' });
    if (db.publicStatus() === 'off') return json(res, 503, { ok: false, reason: 'not configured' });
    try { await db.ping(); return json(res, 200, { ok: true }); } catch (err) { return json(res, 503, { ok: false, reason: err.reason || 'database error' }); }
  }

  const m = req.url.match(ROUTE);
  const id = m[1];
  if (!store.validCrewId(id)) return json(res, 404, { error: 'not found' });
  if (db.publicStatus() !== 'on') return json(res, 503, { reason: db.publicStatus() === 'off' ? 'not configured' : (db.state().reason || 'database error') });

  if (m[2]) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    let device = null;
    try { device = JSON.parse(await readBody(req)).device; } catch { return json(res, 400, { error: 'bad body' }); }
    const hash = store.hashDevice(device);
    if (!hash) return json(res, 400, { error: 'bad device' });
    try { await store.leave(id, hash); return json(res, 204); } catch (err) { return json(res, 503, { reason: err.reason || 'database error' }); }
  }

  if (req.method !== 'GET') return json(res, 405, { error: 'method' });
  const hash = store.hashDevice(String(req.headers['x-tondo-device'] || ''));
  try {
    const crew = await store.readCrew(id, hash);
    return crew ? json(res, 200, crew) : json(res, 404, { error: 'not found' });
  } catch (err) {
    return json(res, 503, { reason: err.reason || 'database error' });
  }
}

module.exports = { matches, handle };
```

- [ ] **Step 8: Wire `server/index.js`.**
  1. Requires: `const db = require('./db');`, `const crews = require('./crews');`,
     `const crewHttp = require('./crew-http');`, `const crewActions = require('./crew-actions');`.
  2. `const manager = new RoomManager({ crewsStatus: () => db.publicStatus() });`
  3. In the `http.createServer` handler, before `serveStatic`:

```js
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      // Never queries the database: the host polls this, and a poll that woke
      // Neon every few minutes would spend its free compute hours (spec §4.2).
      res.end(JSON.stringify({ ok: true, rooms: manager.rooms.size, crews: db.state() }));
      return;
    }
    if (crewHttp.matches(req.url)) {
      crewHttp.handle(req, res, { ip: clientIp(req), budgets }).catch((err) => {
        console.error('[crews] http failed:', err && err.message);
        if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"server"}'); }
      });
      return;
    }
```

     (This replaces the existing `/health` block.)
  4. In the `createRoom`/`joinRoom` branch, compute
     `const deviceHash = crews.hashDevice(message.device);` and pass `{ deviceHash }` as the
     extra argument to both `manager.createRoom(message.name, socket, { deviceHash })` and
     `manager.joinRoom(message.code, message.name, socket, message.token, { deviceHash })`.
     After a successful `createRoom` with a valid crew id, add:

```js
    if (message.type === 'createRoom' && crews.validCrewId(message.crewId) && db.publicStatus() === 'on') {
      const room = result.room;
      const crewId = message.crewId;
      // Looked up off the hot path: the table opens at once, and gains its
      // crew a moment later (or never, if the crew is gone or the book is down).
      crews.crewName(crewId).then((name) => {
        if (name && !room.crew) { room.crew = { id: crewId, name }; room.broadcast(); }
      }, () => {});
    }
```

  5. Add a case before `case 'sync':`:

```js
    case 'saveToCrew': {
      const out = crewActions.saveToCrew({ room, seat, message, ip: session.ip, budgets });
      if (out.refuse) return refuse(socket, room, seatId, out.refuse);
      if (out.started) {
        out.started.then((r) => {
          room.broadcast();
          if (!r.ok) sendError(socket, r.message);
        });
      }
      break; // the broadcast below shows `saving: true` at once
    }
```

  6. After `server.listen(...)`, add
     `db.start(); // never rejects; crews come up (or report why not) in the background`.
     In `shutdown()`, add `db.stop();`.

- [ ] **Step 9: Write the failing end-to-end server test** in `test/crew-server.test.mjs`.
  It uses a real spawned server and PGlite, and covers persistence across a restart, HTTP
  shapes, leave, 503s and the snapshot fields. A full real pie takes minutes with bot think
  times, so it is exercised by `scripts/crew-smoke.js` in Task 9, not here.

```js
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { startPg } from './helpers/pg.mjs';
import { spawnServer } from './helpers/server.mjs';
import { client } from './helpers/client.mjs';

const require = createRequire(import.meta.url);
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };

const pgsrv = await startPg();
const env = { DATABASE_URL: pgsrv.url, TONDO_DB_POOL_MAX: '1', TONDO_TRUST_PROXY: '1' };

// Seed one crew through the store in THIS process, then let the server read it.
process.env.DATABASE_URL = pgsrv.url;
process.env.TONDO_DB_POOL_MAX = '1';
const db = require('../server/db');
const crews = require('../server/crews');
await db.start();
const device = crypto.randomBytes(16).toString('hex');
const seeded = await crews.savePie({ newName: 'Friday Pie' }, { pieKey: 'seed', rounds: 4, players: [
  { kind: 'human', deviceHash: crews.hashDevice(device), name: 'Gent', points: 212, won: true },
  { kind: 'bot', name: 'Chef Bot', points: 40, won: false },
] });
await db.stop(); // one PGlite connection at a time: hand it to the server

let server = await spawnServer(env);
const get = (path, headers = {}) => fetch(server.http + path, { headers: { 'X-Forwarded-For': '203.0.113.50', ...headers } });

test('/health reports crews on without touching the database', async () => {
  const h = await (await get('/health')).json();
  assert(h.ok && h.crews.status === 'on' && h.crews.ready === true, JSON.stringify(h));
});

test('GET /api/crew/:id returns the tally with your row marked', async () => {
  const r = await get(`/api/crew/${seeded.id}`, { 'X-Tondo-Device': device });
  assert(r.status === 200 && r.headers.get('cache-control') === 'no-store', `status ${r.status}`);
  const crew = await r.json();
  assert(crew.name === 'Friday Pie' && crew.pies === 1 && crew.members[0].you === true && crew.members[0].wins === 1, JSON.stringify(crew));
});

test('restart persistence: kill the server, start a new one, the tally is unchanged', async () => {
  await server.stop();
  server = await spawnServer(env);
  const crew = await (await get(`/api/crew/${seeded.id}`)).json();
  assert(crew.pies === 1 && crew.members[0].name === 'Gent' && crew.members[0].wins === 1, JSON.stringify(crew));
});

test('unknown and malformed ids are 404', async () => {
  assert((await get('/api/crew/zzzzzzzzzz')).status === 404, 'unknown');
  assert((await get('/api/crew/..%2F..')).status === 404, 'malformed');
});

test('a table created with crewId gains its crew in a later snapshot; snapshots carry crews on', async () => {
  const c = client(server.ws, { 'X-Forwarded-For': '203.0.113.51' });
  await c.open();
  c.send({ type: 'createRoom', name: 'Gent', device, crewId: seeded.id });
  const s = await c.next((m) => m.type === 'state' && m.crew && m.crew.id === seeded.id, 5000);
  assert(s.crews === 'on' && s.crew.name === 'Friday Pie' && s.match.savedTo === null && s.match.saving === false, JSON.stringify({ crews: s.crews, crew: s.crew }));
  await c.close();
});

test('saveToCrew before the pie is over is refused over the wire', async () => {
  const c = client(server.ws, { 'X-Forwarded-For': '203.0.113.52' });
  await c.open();
  c.send({ type: 'createRoom', name: 'Gent', device });
  await c.next((m) => m.type === 'joined');
  c.send({ type: 'saveToCrew', newCrewName: 'Too Soon' });
  const e = await c.next((m) => m.type === 'error');
  assert(e.message === 'Finish the pie first.', e.message);
  await c.close();
});

test('leave: 204, then the member is gone and the name with it', async () => {
  const r = await fetch(`${server.http}/api/crew/${seeded.id}/leave`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.53' }, body: JSON.stringify({ device }),
  });
  assert(r.status === 204, `status ${r.status}`);
  const crew = await (await get(`/api/crew/${seeded.id}`, { 'X-Tondo-Device': device })).json();
  assert(crew.members.length === 0 && crew.recent[0].players.some((p) => p.kind === 'former'), JSON.stringify(crew));
});

test('crews off: /api/crew is 503 "not configured", snapshots say off, the game still seats you', async () => {
  const off = await spawnServer({ TONDO_TRUST_PROXY: '1' });
  const r = await fetch(`${off.http}/api/crew/${seeded.id}`);
  assert(r.status === 503 && (await r.json()).reason === 'not configured', `status ${r.status}`);
  const c = client(off.ws); await c.open();
  c.send({ type: 'createRoom', name: 'Gent', device });
  const s = await c.next((m) => m.type === 'state');
  assert(s.crews === 'off', s.crews);
  await c.close();
  await off.stop();
});

test('database unreachable: crews failing with the reason, game unaffected (drill: unknown host)', async () => {
  const bad = await spawnServer({ DATABASE_URL: 'postgres://u:p@nope.invalid:5432/db', TONDO_DB_RETRY_MS: '60000' });
  const h = await (await fetch(`${bad.http}/health`)).json();
  assert(h.crews.status === 'failing' && h.crews.reason === 'unknown host', JSON.stringify(h.crews));
  const c = client(bad.ws); await c.open();
  c.send({ type: 'createRoom', name: 'Gent', device });
  const s = await c.next((m) => m.type === 'state');
  assert(s.crews === 'failing' && s.phase === 'lobby', JSON.stringify({ crews: s.crews, phase: s.phase }));
  await c.close();
  await bad.stop();
});

let passed = 0;
const failures = [];
for (const [name, fn] of tests) {
  try { await fn(); passed++; } catch (err) { failures.push({ name, err }); }
}
await server.stop();
await pgsrv.stop();
if (failures.length) {
  for (const f of failures) console.error(`\n  FAIL  ${f.name}\n        ${f.err && f.err.stack}`);
  console.error(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(1);
}
console.log(`\n${passed} passed, 0 failed\n`);
```

  If the unknown-host case finds `status: 'starting'` because DNS is still resolving when
  `/health` is read, change it to poll `/health` every 100 ms for up to 6 s until the status
  is no longer `starting`. Do not loosen the expected reason.

- [ ] **Step 10: Run the end-to-end test.** Run `node test/crew-server.test.mjs`. Expected:
  `9 passed, 0 failed`.

- [ ] **Step 11: Extend scripts and run every gate.**
  1. Set `test:db` to
     `node test/db.test.mjs && node test/crews.test.mjs && node test/crew-actions.test.mjs && node test/crew-server.test.mjs`.
  2. Run `npm test && npm run test:server && npm run test:db`. Expected: all `0 failed`.
  3. Then run the existing smoke against a fresh server: start `PORT=4611 node server/index.js`
     with `run_in_background`, run `PORT=4611 npm run smoke`, and expect exit 0 (this proves
     protocol compatibility for clients that send no `device`). Stop the server.

- [ ] **Step 12: Commit**

```bash
git add PROTOCOL.md server/rooms.js server/index.js server/crew-actions.js server/crew-http.js test/crew-actions.test.mjs test/crew-server.test.mjs package.json
git commit -m "Save a finished pie to a crew; read and leave it over HTTP (protocol v1.4)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Client plumbing (device, crew list, share text)

**Files:**
- Create: `public/js/crews.js`, `test/crews-client.test.mjs`
- Modify: `public/js/share.js:92-135`, `public/js/net.js`, `public/js/app.js` (4 send sites +
  `new Connection`), `test/share.test.mjs`, `package.json`

**Interfaces:**
- Produces from `public/js/crews.js`:
  - `CREW_ID: RegExp`.
  - `getDevice() -> string` (`''` when storage is unavailable).
  - `readCrews() -> Array<{ id, name, at }>`.
  - `rememberCrew({ id, name }) -> void`, `forgetCrew(id) -> void`.
  - `crewLink(origin, id) -> string`.
  - `withDevice(payload) -> payload` with `device` added when available.
- Produces from `public/js/share.js`:
  `pieResultText(match, { origin, resolveName, crewUrl })`.

- [ ] **Step 1: Write the failing test** in `test/crews-client.test.mjs`:

```js
/** public/js/crews.js against a fake localStorage — including hostile contents. */

function fakeStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
    data,
  };
}
globalThis.localStorage = fakeStorage();
const { CREW_ID, getDevice, readCrews, rememberCrew, forgetCrew, crewLink, withDevice } = await import('../public/js/crews.js');

let passed = 0;
const failures = [];
const test = (name, fn) => { try { fn(); passed++; } catch (err) { failures.push({ name, err }); } };
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };

test('getDevice makes one 32-hex secret and keeps it', () => {
  globalThis.localStorage = fakeStorage();
  const a = getDevice();
  assert(/^[0-9a-f]{32}$/.test(a) && getDevice() === a, a);
});

test('getDevice replaces a malformed stored secret', () => {
  globalThis.localStorage = fakeStorage({ 'tondo.device': 'not-hex' });
  assert(/^[0-9a-f]{32}$/.test(getDevice()), 'replaced');
});

test('getDevice returns "" when storage throws (Safari private mode)', () => {
  globalThis.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert(getDevice() === '', 'empty');
  const p = withDevice({ type: 'createRoom', name: 'G' });
  assert(!('device' in p), 'no device field when there is none');
});

test('storage parsing: corrupt JSON, foreign shapes, bad ids and oversize lists read as the valid subset', () => {
  const good = (i) => ({ id: `k7m2q9xh${String(i).padStart(2, '0')}`.replace(/[^0-9a-hjkmnp-tv-z]/g, '0'), name: `Crew ${i}`, at: i });
  globalThis.localStorage = fakeStorage({ 'tondo.crews': '{not json' });
  assert(readCrews().length === 0, 'corrupt reads empty');
  assert(globalThis.localStorage.data.get('tondo.crews') === '{not json', 'and is never deleted');
  globalThis.localStorage = fakeStorage({ 'tondo.crews': JSON.stringify({ id: 'x' }) });
  assert(readCrews().length === 0, 'non-array reads empty');
  const mixed = [good(1), { id: 'BAD', name: 'x' }, { id: good(2).id, name: '' }, null, 7, good(1), ...Array.from({ length: 14 }, (_, i) => good(i + 3))];
  globalThis.localStorage = fakeStorage({ 'tondo.crews': JSON.stringify(mixed) });
  const list = readCrews();
  assert(list.length === 10, `capped at 10, got ${list.length}`);
  assert(new Set(list.map((c) => c.id)).size === list.length, 'deduped');
  assert(list.every((c) => CREW_ID.test(c.id) && c.name.length >= 1 && c.name.length <= 24), 'only valid entries');
});

test('rememberCrew puts the crew first, dedupes, caps at 10; forgetCrew removes it', () => {
  globalThis.localStorage = fakeStorage();
  for (let i = 0; i < 12; i++) rememberCrew({ id: `abcdefgh${String(i).padStart(2, '0')}`, name: `C${i}` });
  rememberCrew({ id: 'abcdefgh03', name: 'Renamed' });
  const list = readCrews();
  assert(list.length === 10 && list[0].id === 'abcdefgh03' && list[0].name === 'Renamed', JSON.stringify(list.slice(0, 2)));
  forgetCrew('abcdefgh03');
  assert(!readCrews().some((c) => c.id === 'abcdefgh03'), 'forgotten');
  rememberCrew({ id: 'BAD', name: 'x' });
  assert(!readCrews().some((c) => c.id === 'BAD'), 'invalid ids are never stored');
});

test('crewLink appends ?crew= to the app origin', () => {
  assert(crewLink('https://tondo.example/', 'k7m2q9xh3p') === 'https://tondo.example/?crew=k7m2q9xh3p', crewLink('https://tondo.example/', 'k7m2q9xh3p'));
});

if (failures.length) {
  for (const f of failures) console.error(`\n  FAIL  ${f.name}\n        ${f.err && f.err.message}`);
  console.error(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(1);
}
console.log(`\n${passed} passed, 0 failed\n`);
```

- [ ] **Step 2: Run it and confirm it fails.** Run `node test/crews-client.test.mjs`. Expected:
  `Cannot find module`.

- [ ] **Step 3: Implement** `public/js/crews.js`:

```js
/**
 * What this browser knows about crews: its device secret and the crews it has
 * played into. No accounts — clearing storage (or "Forget this device", which
 * wipes every `tondo.` key) means rejoining as a new member, which the crew
 * link still allows.
 *
 * Storage is a privilege, not a given (see app.js readLastTable): every touch
 * is guarded, and a value that will not parse reads as "nothing remembered" —
 * never deleted.
 */

const DEVICE_KEY = 'tondo.device';
const CREWS_KEY = 'tondo.crews';
const MAX_CREWS = 10;
export const CREW_ID = /^[0-9a-hjkmnp-tv-z]{10}$/;
const DEVICE = /^[0-9a-f]{32}$/;

function store() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function getDevice() {
  const s = store();
  if (!s) return '';
  let v = '';
  try { v = s.getItem(DEVICE_KEY) || ''; } catch { return ''; }
  if (DEVICE.test(v)) return v;
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  v = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  try { s.setItem(DEVICE_KEY, v); } catch { return ''; }
  return v;
}

export function withDevice(payload) {
  const device = getDevice();
  return device ? { ...payload, device } : payload;
}

export function readCrews() {
  const s = store();
  if (!s) return [];
  let raw = '';
  try { raw = s.getItem(CREWS_KEY) || ''; } catch { return []; }
  if (!raw) return [];
  let v;
  try { v = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  const out = [];
  for (const c of v) {
    if (!c || typeof c !== 'object') continue;
    const id = typeof c.id === 'string' ? c.id : '';
    const name = typeof c.name === 'string' ? c.name.trim().slice(0, 24) : '';
    if (!CREW_ID.test(id) || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, at: Number(c.at) || 0 });
    if (out.length >= MAX_CREWS) break;
  }
  return out;
}

function writeCrews(list) {
  const s = store();
  if (!s) return;
  try { s.setItem(CREWS_KEY, JSON.stringify(list.slice(0, MAX_CREWS))); } catch { /* nowhere to keep it */ }
}

export function rememberCrew({ id, name }) {
  if (!CREW_ID.test(String(id || '')) || !String(name || '').trim()) return;
  writeCrews([{ id, name: String(name).trim().slice(0, 24), at: Date.now() }].concat(readCrews().filter((c) => c.id !== id)));
}

export function forgetCrew(id) {
  writeCrews(readCrews().filter((c) => c.id !== id));
}

export function crewLink(origin, id) {
  return `${origin}?crew=${id}`;
}
```

- [ ] **Step 4: Run it and confirm it passes.** Run `node test/crews-client.test.mjs`.
  Expected: `6 passed, 0 failed`. If the "storage parsing" fixture's `good()` ids collide after
  the replace, fix the **fixture** to produce 16 distinct valid ids. Do not change `readCrews`.

- [ ] **Step 5: Add a failing share test.** Append to `test/share.test.mjs`, before the
  `if (failures.length)` footer:

```js
test('a pie saved to a crew links the crew, not a new table', () => {
  const text = pieResultText({ complete: true, championIds: ['p4'], standings }, { origin: 'https://tondo.example/', crewUrl: 'https://tondo.example/?crew=k7m2q9xh3p' });
  const last = text.split('\n')[2];
  assert(last === 'Four slices. See the crew: https://tondo.example/?crew=k7m2q9xh3p', last);
});

test('without crewUrl the text is byte-identical to before', () => {
  const a = pieResultText({ complete: true, championIds: ['p4'], standings }, { origin: 'https://tondo.example' });
  const b = pieResultText({ complete: true, championIds: ['p4'], standings }, { origin: 'https://tondo.example', crewUrl: '' });
  assert(a === b && a.endsWith('Four slices. Start a new table: https://tondo.example'), a);
});
```

  Run `node test/share.test.mjs`. Expected: the first new case FAILS.

- [ ] **Step 6: Implement it in `share.js`.**
  1. Change the signature to
     `export function pieResultText(match, { origin = '', resolveName, crewUrl = '' } = {})`.
  2. Replace the final `return` with:

```js
  // A saved pie points at the crew, which outlives the table; an unsaved one
  // still offers a NEW table, because its room code dies 60s after it empties.
  const tail = crewUrl ? `See the crew: ${crewUrl}` : `Start a new table: ${origin}`;
  return `🍕 TONDO — ${headline}\n${scores}\n${sliceSentence(sliceCount(match))} ${tail}`;
```

  3. Update the file's top comment: "…so an unsaved pie's link offers a NEW table, and a pie
     saved to a crew links the crew page, which does not die."
  4. Run `node test/share.test.mjs`. Expected: all pass, including the "no durable-link
     promise" tripwire, which runs without `crewUrl`.

- [ ] **Step 7: `net.js`.**
  1. Add `'saveToCrew'` to `STATE_DEPENDENT`.
  2. Constructor: `constructor({ onMessage, onStatus, getDevice })` and
     `this.getDevice = getDevice || (() => '');`.
  3. In the reconnect `joinRoom` payload add `device: this.getDevice() || undefined,` (undefined
     is dropped by `JSON.stringify`).

- [ ] **Step 8: `app.js` send sites.**
  1. Add
     `import { getDevice, withDevice, readCrews, rememberCrew, forgetCrew, crewLink, CREW_ID } from './crews.js';`
     after the share import.
  2. Change line 287 to
     `const conn = new Connection({ onMessage: handleMessage, onStatus: onNetStatus, getDevice });`.
  3. Run `grep -n "type: 'createRoom'\|type: 'joinRoom'" public/js/app.js`. It lists exactly 4
     sites at commit `061c8a0`: lines 504, 1421, 1429, 1461. Wrap each payload object in
     `withDevice(...)`, e.g. `send(withDevice({ type: 'createRoom', name }))`. If grep shows a
     different count, wrap every one it lists and note the count in the commit message.

- [ ] **Step 9: Add to `npm test` and run all gates.** Append
  `&& node test/crews-client.test.mjs` to `test`. Run `npm test`. Then run
  `npm run shoot`, using `run_in_background` and reading its output when notified. Expected:
  all green; nothing visible changed yet.

- [ ] **Step 10: Commit**

```bash
git add public/js/crews.js public/js/share.js public/js/net.js public/js/app.js test/crews-client.test.mjs test/share.test.mjs package.json
git commit -m "Each browser carries a device secret; a saved pie's share text links the crew

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Scoreboard — Save to crew and the picker

**Files:**
- Modify:
  - `public/index.html:306-313` (scoreboard)
  - `public/styles.css` (after `.score-share-msg`)
  - `public/js/app.js` (nodes list ~line 200, `renderMatch` ~2218, share handler ~1737, new
    handlers)
  - `public/js/mock.js` (`snapshot`, `matchBlock`, `route`)

**Interfaces:**
- Consumes: the snapshot fields from Task 5; `rememberCrew`, `readCrews` and `crewLink` from
  Task 6.
- Produces: `renderCrewSave(snap, over)` in app.js, and mock support for
  `saveToCrew`/`crews`/`crew`/`savedTo`, which Task 8's mock extends.

- [ ] **Step 1: Mock first, so the UI can be seen.** In `public/js/mock.js`:
  1. In `snapshot()`, add `crews: 'on', crew: table.crew || null,`.
  2. In `matchBlock()`, add `savedTo: table.savedTo || null, saving: false,`.
  3. In `route(msg)`, add a case:

```js
    case 'saveToCrew':
      // The real server records its own scores and answers with the crew; the
      // mock just names it, so the saved state can be shown.
      table.savedTo = msg.crewId
        ? { id: msg.crewId, name: (table.crew && table.crew.id === msg.crewId) ? table.crew.name : 'Friday Pie' }
        : { id: 'k7m2q9xh3p', name: String(msg.newCrewName || 'Crew').slice(0, 24) };
      if (!table.crew) table.crew = table.savedTo;
      emit(snapshot());
      return;
```

  4. Make sure `table` has `crew: null, savedTo: null` in its initial object. A query flag
     `?mockcrew=1` sets `table.crew = { id: 'k7m2q9xh3p', name: 'Friday Pie' }` at load, so the
     one-tap state can be captured. Add next to wherever `table` reads other query params; if
     there are none, add
     `if (new URLSearchParams(location.search).has('mockcrew')) table.crew = { id: 'k7m2q9xh3p', name: 'Friday Pie' };`
     right after `table` is declared.

- [ ] **Step 2: Markup.** In `public/index.html`, insert after the `share-btn` button (and
  before its comment and `#score-share-msg`):

```html
      <!-- Save to crew: only on a FINISHED pie and only when the server's crew
           book is on. With a crew already attached to the table it is one tap;
           otherwise it opens the picker in its place. -->
      <button id="crew-save-btn" type="button" class="btn btn-quiet score-share" hidden>Save to crew</button>
      <div id="crew-picker" class="crew-picker" hidden>
        <p class="field-label">Save this pie to</p>
        <div id="crew-picker-list" class="crew-picker-list"></div>
        <div class="join-row">
          <label class="field field-grow" for="crew-new-name">
            <span class="field-label">New crew</span>
            <input id="crew-new-name" class="input" type="text" maxlength="24" autocomplete="off" spellcheck="false">
          </label>
          <button id="crew-new-btn" type="button" class="btn">Save</button>
        </div>
      </div>
      <p id="crew-msg" class="score-share-msg"></p>
```

- [ ] **Step 3: Styles.** Append after the `.score-share-msg` rules in `public/styles.css`:

```css
/* Save to crew. The picker replaces the button in place, inside the scoreboard
   that already replaced the hand, so it adds no new layer to the table. */
.crew-picker { display: flex; flex-direction: column; gap: 8px; }
.crew-picker[hidden] { display: none; }
.crew-picker-list { display: flex; flex-direction: column; gap: 6px; }
.crew-picker-list:empty { display: none; }
```

  The `[hidden]` guard is required: memory `hidden-attr-defeated-by-display.md` says any
  `display` rule on a `hidden`-toggled element needs one.

- [ ] **Step 4: JS.** In `public/js/app.js`:
  1. Add `'crew-save-btn', 'crew-picker', 'crew-picker-list', 'crew-new-name', 'crew-new-btn', 'crew-msg',`
     to the `nodes` id list (the line with `'share-btn', 'score-share-msg',`).
  2. Add after `hideShareBtn()`:

```js
/* Save to crew. `crewPickerOpen` keeps the picker standing across snapshots
   (one arrives every time anyone at the table does anything); `crewSavedSaid`
   makes "Saved to …" announce once per pie, not once per snapshot. */
function renderCrewSave(snap, over) {
  const m = snap && snap.match;
  const btn = nodes['crew-save-btn'];
  const show = !!m && over && m.complete && snap.crews === 'on';
  if (!show) {
    btn.hidden = true;
    nodes['crew-picker'].hidden = true;
    app.crewPickerOpen = false;
    app.crewSavedSaid = false;
    setText(nodes['crew-msg'], '');
    return;
  }
  if (m.savedTo) {
    btn.hidden = true;
    nodes['crew-picker'].hidden = true;
    app.crewPickerOpen = false;
    rememberCrew(m.savedTo);
    setText(nodes['crew-msg'], `Saved to ${m.savedTo.name}`);
    if (!app.crewSavedSaid) {
      app.crewSavedSaid = true;
      // After this repaint, not during it: renderGame writes the same live
      // region later in the same pass (memory 2026-09-26-live-region-same-tick.md).
      setTimeout(() => announce(`Saved to ${m.savedTo.name}.`), 0);
    }
    return;
  }
  nodes['crew-picker'].hidden = !app.crewPickerOpen;
  btn.hidden = app.crewPickerOpen;
  btn.disabled = !!m.saving;
  btn.textContent = m.saving ? 'Saving…' : (snap.crew ? `Save to ${snap.crew.name}` : 'Save to crew');
}

function openCrewPicker() {
  const list = nodes['crew-picker-list'];
  list.textContent = '';
  for (const c of readCrews().slice(0, 3)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-block';
    b.textContent = c.name;
    b.addEventListener('click', () => {
      if (send({ type: 'saveToCrew', crewId: c.id })) { app.crewPickerOpen = false; renderCrewSave(app.snap, true); }
    });
    list.appendChild(b);
  }
  nodes['crew-new-name'].value = `${nicelyName(app.name || 'Our')}'s crew`.slice(0, 24);
  app.crewPickerOpen = true;
  renderCrewSave(app.snap, true);
  nodes['crew-new-name'].focus();
}

nodes['crew-save-btn'].addEventListener('click', () => {
  const s = app.snap;
  if (!s || !s.match || !s.match.complete) return;
  if (s.crew) { send({ type: 'saveToCrew', crewId: s.crew.id }); return; }
  openCrewPicker();
});

nodes['crew-new-btn'].addEventListener('click', () => {
  const name = nodes['crew-new-name'].value.replace(/\s+/g, ' ').trim();
  if (!name) { setText(nodes['crew-msg'], 'Give the crew a name.'); nodes['crew-new-name'].focus(); return; }
  if (send({ type: 'saveToCrew', newCrewName: name })) { app.crewPickerOpen = false; renderCrewSave(app.snap, true); }
});
nodes['crew-new-name'].addEventListener('keydown', (e) => { if (e.key === 'Enter') nodes['crew-new-btn'].click(); });
```

  3. In `renderMatch(snap, over)`, add `renderCrewSave(snap, over);` as the **first** line
     after `const m = snap.match;` (it handles a missing `m` itself), so every early return
     below still leaves the crew controls correct.
  4. In the share handler, replace the `pieResultText` call with:

```js
  const crewUrl = m.savedTo ? crewLink(origin, m.savedTo.id) : '';
  const text = pieResultText(m, { origin, resolveName: playerName, crewUrl });
```

- [ ] **Step 5: Verify in the browser pane.** Start the dev server (`preview_start` with the
  project's launch config; create `.claude/launch.json` with `npm start` on port 4600 if it
  doesn't exist).
  1. Navigate to `/?mock=1&scene=pieComplete`.
  2. `read_page`: `#crew-save-btn` is visible and reads "Save to crew".
  3. Click it: `#crew-picker` is visible and `#crew-new-name` has "You's crew" (the mock
     name).
  4. Click `#crew-new-btn`: `#crew-msg` reads "Saved to You's crew", the button is hidden, and
     `localStorage['tondo.crews']` (via `javascript_tool`, wrapped in an async IIFE) contains
     `k7m2q9xh3p`.
  5. Click Copy result. With clipboard permission unavailable in the pane, the fallback
     textarea appears; its value's last line contains `See the crew: …?crew=k7m2q9xh3p`.
  6. Navigate to `/?mock=1&scene=pieComplete&mockcrew=1`: the button reads
     "Save to Friday Pie", and one click shows "Saved to Friday Pie" with no picker.
  7. `read_console_messages` with `onlyErrors`: none.
  8. Per memory `browser-pane-click-flakiness.md`: if a pane click times out, re-verify with a
     JS-dispatched click before concluding anything.

- [ ] **Step 6: Eyeball captures for the owner (taste call, spec §5).** Using the shoot harness
  in non-check mode with `run_in_background`, capture into
  `.superpowers/qa-crew/` at 320×568, 390×844 and 1366×768:
  - the finished pie (`--scene mock:pieComplete`);
  - the one-tap state (`--path "/?mock=1&scene=pieComplete&mockcrew=1" --scene none`);
  - the open picker with two remembered crews (`--scene mock:pieComplete --storage-json
    '{"tondo.crews":"[{\"id\":\"abcdefgh01\",\"name\":\"Friday Pie\",\"at\":1},{\"id\":\"abcdefgh02\",\"name\":\"Uni Lads\",\"at\":2}]"}'
    --probe "document.getElementById('crew-save-btn').click()"`).

  Look at every image yourself first. The Save button must not overlap Copy result, the pips
  or the deal/hold row, and nothing may be clipped at 320×568. Fix anything visible before
  asking. Then **send the images to the owner with SendUserFile and ask for a yes or no on
  the placement.** Do not mark this task done without that answer. If the owner says no, take
  their direction, re-capture and ask again.

- [ ] **Step 7: Run all gates.** Run `npm test`, then `npm run shoot` and `npm run contrast`
  (both with `run_in_background`). Expected: green. A single red `banner-clear` is re-run once
  clean before concluding (memory `shoot-gate-load-flake.md`).

- [ ] **Step 8: Commit** (only after the owner's yes):

```bash
git add public/index.html public/styles.css public/js/app.js public/js/mock.js
git commit -m "Save a finished pie to a crew from the scoreboard, in one tap when the table has one

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Crew view, home row, routing and leave

**Files:**
- Modify:
  - `public/index.html`: home card after `#last-table`; new `#screen-crew` after the lobby
    section
  - `public/styles.css`: screen selectors at lines 631-632 and 649-650; crew styles
  - `public/js/app.js`: `SCREEN_TITLE`, `setScreen` announcement, nodes, `bootHome`, boot
    block, new functions
  - `public/js/mock.js`: `fetch` fixtures
  - `scripts/shoot.js`: `crew-card-fits` check + captures

**Interfaces:**
- Consumes: `GET /api/crew/:id` and `POST /api/crew/:id/leave` (Task 5); crews.js (Task 6).
- Produces: `openCrewView(id)`, `renderCrewsRow()` and the `crew` screen name.

- [ ] **Step 1: Mock fetch fixtures.** In `public/js/mock.js`, before `window.WebSocket =
  MockSocket;`:

```js
/* Crew pages, faked at the fetch layer the way the table is faked at the socket
   layer: the real app code runs unchanged. Three fixtures: a lived-in crew, an
   empty one whose name is HTML (it must render as literal text), and one whose
   book is down. */
const CREW_FIXTURES = {
  k7m2q9xh3p: { status: 200, body: {
    id: 'k7m2q9xh3p', name: 'Friday Pie', pies: 6,
    members: [
      { name: 'Gent', pies: 6, wins: 3, you: true },
      { name: 'Arta', pies: 6, wins: 2, you: false },
      { name: 'Dren', pies: 4, wins: 1, you: false },
      { name: 'Gent 2', pies: 1, wins: 0, you: false },
    ],
    recent: [
      { playedAt: '2026-10-09T19:40:00Z', rounds: 4, players: [
        { name: 'Gent', points: 212, won: true, kind: 'member' }, { name: 'Arta', points: 180, won: false, kind: 'member' },
        { name: 'Chef Bot', points: 40, won: false, kind: 'bot' }, { name: null, points: 12, won: false, kind: 'former' }] },
      { playedAt: '2026-10-02T20:10:00Z', rounds: 4, players: [
        { name: 'Arta', points: 166, won: true, kind: 'member' }, { name: 'Gent', points: 81, won: false, kind: 'member' },
        { name: null, points: 30, won: false, kind: 'guest' }] },
    ],
  } },
  empty00000: { status: 200, body: { id: 'empty00000', name: '<b>New</b> crew', pies: 0, members: [], recent: [] } },
  dead000000: { status: 503, body: { reason: 'timeout' } },
};
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  const m = url.pathname.match(/^\/api\/crew\/([^/]+)(\/leave)?$/);
  if (!m) return realFetch(input, init);
  await new Promise((r) => setTimeout(r, 120)); // a visible loading beat
  if (m[2]) return new Response(null, { status: 204 });
  const f = CREW_FIXTURES[m[1]];
  if (!f) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify(f.body), { status: f.status, headers: { 'Content-Type': 'application/json' } });
};
```

- [ ] **Step 2: Markup.**
  1. Home card, directly after the closing `</div>` of `#last-table`:

```html
    <!-- Crews this device has played into, newest first. Decided before first
         paint (read synchronously at boot), like the last-table row above. -->
    <div id="crews-row" class="last-table" hidden>
      <span class="field-label">Your crews</span>
      <div id="crews-list" class="crews-list"></div>
    </div>
```

  2. After the lobby `</section>`:

```html
<!-- ------------------------------------------------------------------ CREW -->
<section id="screen-crew" class="screen crew" role="main" aria-labelledby="crew-title">
  <div class="lobby-card crew-card">
    <h1 id="crew-title" class="crew-title" tabindex="-1">Your crew</h1>
    <p id="crew-sub" class="home-hook crew-sub"></p>
    <ol id="crew-rows" class="crew-rows"></ol>
    <div id="crew-recent" class="crew-recent"></div>
    <label id="crew-name-field" class="field" for="crew-name-input" hidden>
      <span class="field-label">Your name</span>
      <input id="crew-name-input" class="input" type="text" maxlength="14" autocomplete="nickname" placeholder="Chef">
    </label>
    <button id="crew-start" type="button" class="btn btn-primary btn-block">Start a table</button>
    <p id="crew-view-msg" class="msg" role="status" aria-live="polite"></p>
    <button id="crew-home" type="button" class="btn btn-tiny">Home</button>
    <button id="crew-leave" type="button" class="btn btn-tiny btn-forget" hidden>Leave this crew</button>
  </div>
</section>
```

- [ ] **Step 3: Styles.**
  1. Add `body[data-screen="crew"] #screen-crew` to both existing selector lists: the
     `display:flex` rule at lines 631-632 and the background rule at lines 649-650. Keep each
     list one selector per line, as written.
  2. Append:

```css
/* CREW — the lobby card's shell, a standings list and the last few pies. */
.crew-title { margin: 0; font-family: var(--font-display); font-weight: 800; font-size: 30px; line-height: 1.05; overflow-wrap: anywhere; }
.crew-sub { margin: 0; }
.crew-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.crew-rows:empty { display: none; }
.crew-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.crew-row-name { font-weight: 700; overflow-wrap: anywhere; }
.crew-row.is-you .crew-row-name::after { content: ' · you'; font-weight: 400; color: var(--ink-3); }
.crew-row-stat { font-family: var(--font-mono); font-size: 13px; color: var(--ink-3); white-space: nowrap; }
.crew-recent { display: flex; flex-direction: column; gap: 6px; }
.crew-recent:empty { display: none; }
.crew-pie { margin: 0; font-size: 14px; line-height: 1.4; color: var(--ink-3); overflow-wrap: anywhere; }
.crew-pie b { color: var(--ink-1); }
.crews-list { display: flex; flex-direction: column; gap: 6px; }
```

     These use only existing ink tokens (`--ink-1`, `--ink-3`), so the contrast gate's ladder
     is unchanged. `--ink-3` is the floor for words, per check-contrast.js.

- [ ] **Step 4: JS.** In `public/js/app.js`:
  1. `SCREEN_TITLE`: add `crew: 'crew-title'`.
  2. In `setScreen`, extend the `line` ternary:
     `: name === 'crew' ? 'Crew.'` before `: 'Game started.'`.
  3. Nodes: add `'crews-row', 'crews-list', 'crew-title', 'crew-sub', 'crew-rows', 'crew-recent', 'crew-name-field', 'crew-name-input', 'crew-start', 'crew-view-msg', 'crew-home', 'crew-leave',`.
  4. Add the functions near `renderLastTable`:

```js
/* ----------------------------------------------------------------- crews */

const CREW_DOWN = "Can't reach the crew book right now — try again in a minute.";

/** "Your crews" on the home card: up to three, newest first. */
function renderCrewsRow() {
  const list = readCrews().slice(0, 3);
  nodes['crews-row'].hidden = list.length === 0;
  const box = nodes['crews-list'];
  box.textContent = '';
  for (const c of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-block';
    b.textContent = c.name;
    b.addEventListener('click', () => {
      history.replaceState(null, '', `${location.pathname}?crew=${c.id}`);
      openCrewView(c.id);
    });
    box.appendChild(b);
  }
}

function crewPlayerName(p) {
  if (p.kind === 'former') return 'a former member';
  if (p.kind === 'guest') return 'a guest';
  return nicelyName(p.name);
}

function renderCrew(crew) {
  app.crewData = crew;
  nodes['crew-title'].textContent = crew.name;
  const n = crew.members.length;
  nodes['crew-sub'].textContent = crew.pies
    ? `${n} ${n === 1 ? 'member' : 'members'} · ${crew.pies} ${crew.pies === 1 ? 'pie' : 'pies'}`
    : 'No pies yet — play one and save it.';
  const rows = nodes['crew-rows'];
  rows.textContent = '';
  for (const m of crew.members) {
    const li = document.createElement('li');
    li.className = `crew-row${m.you ? ' is-you' : ''}`;
    const name = document.createElement('span');
    name.className = 'crew-row-name';
    name.textContent = nicelyName(m.name);
    const stat = document.createElement('span');
    stat.className = 'crew-row-stat';
    stat.textContent = `${m.wins} ${m.wins === 1 ? 'win' : 'wins'} · ${m.pies} ${m.pies === 1 ? 'pie' : 'pies'}`;
    li.append(name, stat);
    rows.appendChild(li);
  }
  const recent = nodes['crew-recent'];
  recent.textContent = '';
  for (const pie of crew.recent) {
    const p = document.createElement('p');
    p.className = 'crew-pie';
    const when = new Date(pie.playedAt).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    p.append(`${when} — `);
    pie.players.forEach((pl, i) => {
      if (i) p.append(' · ');
      const label = `${crewPlayerName(pl)} ${pl.points}`;
      if (pl.won) { const b = document.createElement('b'); b.textContent = label; p.append(b); } else p.append(label);
    });
    recent.appendChild(p);
  }
  const you = crew.members.some((m) => m.you);
  if (you) rememberCrew({ id: crew.id, name: crew.name });
  nodes['crew-leave'].hidden = !you;
  let stored = '';
  try { stored = localStorage.getItem('tondo.name') || ''; } catch { /* ignore */ }
  nodes['crew-name-field'].hidden = Boolean(stored);
  nodes['crew-start'].disabled = false;
}

async function openCrewView(id) {
  app.crewId = id;
  setScreen('crew');
  nodes['crew-title'].textContent = 'Your crew';
  nodes['crew-sub'].textContent = 'Opening the crew book…';
  nodes['crew-rows'].textContent = '';
  nodes['crew-recent'].textContent = '';
  nodes['crew-leave'].hidden = true;
  nodes['crew-start'].disabled = true;
  nodes['crew-view-msg'].textContent = '';
  let res = null;
  try { res = await fetch(`/api/crew/${id}`, { headers: { 'X-Tondo-Device': getDevice() } }); } catch { res = null; }
  if (app.crewId !== id) return; // the player moved on while this was in flight
  if (res && res.status === 404) {
    forgetCrew(id);
    nodes['crew-sub'].textContent = 'That crew does not exist — the link may have been cut short.';
    return;
  }
  const crew = res && res.ok ? await res.json().catch(() => null) : null;
  if (!crew) { nodes['crew-sub'].textContent = CREW_DOWN; return; }
  renderCrew(crew);
}

function leaveCrewView() {
  app.crewId = null;
  history.replaceState(null, '', location.pathname);
}

nodes['crew-home'].addEventListener('click', () => {
  leaveCrewView();
  renderCrewsRow();
  revealHome();
});

nodes['crew-start'].addEventListener('click', () => {
  const id = app.crewId;
  if (!id) return;
  let name = '';
  try { name = localStorage.getItem('tondo.name') || ''; } catch { /* ignore */ }
  if (!name) {
    name = (nodes['crew-name-input'].value || '').trim().slice(0, 14);
    if (!name) { nodes['crew-view-msg'].textContent = 'Put a name on the ticket first.'; nodes['crew-name-input'].focus(); return; }
    try { localStorage.setItem('tondo.name', name); } catch { /* ignore */ }
  }
  app.name = name;
  if (!send(withDevice({ type: 'createRoom', name, crewId: id }))) {
    nodes['crew-view-msg'].textContent = 'Not connected — try again in a moment.';
    return;
  }
  leaveCrewView(); // the `joined` reply takes the player to the lobby as usual
});

let crewLeaveTimer = 0;
nodes['crew-leave'].addEventListener('click', async () => {
  const btn = nodes['crew-leave'];
  if (!crewLeaveTimer) {
    btn.textContent = 'Tap again to leave';
    crewLeaveTimer = setTimeout(() => { crewLeaveTimer = 0; btn.textContent = 'Leave this crew'; }, FORGET_MS);
    return;
  }
  clearTimeout(crewLeaveTimer);
  crewLeaveTimer = 0;
  btn.textContent = 'Leave this crew';
  const id = app.crewId;
  let ok = false;
  try {
    const r = await fetch(`/api/crew/${id}/leave`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: getDevice() }),
    });
    ok = r.status === 204;
  } catch { ok = false; }
  if (!ok) { nodes['crew-view-msg'].textContent = CREW_DOWN; return; }
  forgetCrew(id);
  await openCrewView(id);
  nodes['crew-view-msg'].textContent = 'You left the crew.';
});
```

     `FORGET_MS` already exists for the Forget button. Confirm with
     `grep -n "FORGET_MS" public/js/app.js`; if it is declared later in the file than this
     code, move these functions below it.
  5. In `bootHome()`, after `renderLastTable();`, add:

```js
  renderCrewsRow();
  const crewParam = (params.get('crew') || '').trim().toLowerCase();
  if (crewParam) {
    if (CREW_ID.test(crewParam)) app.bootCrew = crewParam;
    else nodes['home-msg'].textContent = 'That crew link is not right.';
  }
```

  6. In the boot block at the end, after `setScreen('home');`, add
     `if (app.bootCrew) openCrewView(app.bootCrew);`.
  7. After a successful leave from the forget path (`wipeStore` clears `tondo.crews`), call
     `renderCrewsRow();` right after the two `wipeStore(...)` calls.

- [ ] **Step 5: Verify in the browser pane** (dev server running):
  1. `/?mock=1&crew=k7m2q9xh3p`:
     - `read_page` shows the title "Friday Pie", the sub "4 members · 6 pies" and 4 rows;
       Gent's row has class `is-you`.
     - Two recent pies; the first contains "a former member 12", the second "a guest 30".
     - "Leave this crew" is visible.
  2. `/?mock=1&crew=empty00000`:
     - `javascript_tool`:
       `(async () => document.getElementById('crew-title').textContent)()` returns the literal
       `<b>New</b> crew`.
     - `document.querySelector('#crew-title b')` is `null`. This is Review Focus 5.
     - The sub reads "No pies yet — play one and save it."
  3. `/?mock=1&crew=dead000000`: the sub reads the CREW_DOWN line and Start is disabled. This
     is Review Focus 4.
  4. `/?mock=1&crew=OOOOOOOOOO`: the home screen shows "That crew link is not right."
  5. From `k7m2q9xh3p`, with `tondo.name` unset: Start shows "Put a name on the ticket first."
     Type a name and press Start: the lobby appears (the mock seats you), and
     `location.search` is `''`.
  6. Leave: tap twice, then "You left the crew." appears.
  7. Home with `tondo.crews` seeded: the "Your crews" row lists them, and tapping one opens the
     view.
  8. `read_console_messages` with `onlyErrors`: none.

- [ ] **Step 6: Gate check `crew-card-fits` in `scripts/shoot.js`.** Inside the `--check`
  block, after the `banner-clear` loop and before "capture every mock scene", add:

```js
    // ---- crew-card-fits -------------------------------------------------
    // The crew page is a new screen at every reference size: nothing in the
    // card may stick out sideways (a long crew or member name must wrap, not
    // overflow), and "Start a table" must be reachable by scrolling the
    // SCREEN's own container (#screen-crew is overflow:auto; the document
    // never scrolls — html, body { overflow: hidden }).
    const CREW_FIT_PROBE = `(() => {
      const card = document.querySelector('.crew-card');
      const screen = document.getElementById('screen-crew');
      const start = document.getElementById('crew-start');
      if (!card || !screen || !start) return JSON.stringify({ valid: false, reason: 'crew screen missing' });
      const rows = document.getElementById('crew-rows').children.length;
      if (rows === 0) return JSON.stringify({ valid: false, reason: 'no rows rendered (fixture not loaded?)' });
      const c = card.getBoundingClientRect();
      const outside = [...card.querySelectorAll('*')].filter((n) => {
        const r = n.getBoundingClientRect();
        return r.width > 0 && (r.left < c.left - 1 || r.right > c.right + 1);
      }).map((n) => n.id || n.className).slice(0, 5);
      screen.scrollTop = screen.scrollHeight;
      const s = start.getBoundingClientRect();
      return JSON.stringify({ valid: true, rows, outside, startBottom: Math.round(s.bottom), innerHeight, pass: outside.length === 0 && s.bottom <= innerHeight + 1 && s.height > 0 });
    })()`;
    for (const [w, h] of [[320, 568], [390, 844], [1366, 768]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 768 });
      await cdp.send('Page.navigate', { url: `${origin}/?mock=1&crew=k7m2q9xh3p` });
      await cdp.until(`document.body.dataset.screen === 'crew' && document.getElementById('crew-rows').children.length > 0`, { what: `crew view @${w}x${h}` });
      await cdp.eval(`(() => { document.getAnimations().forEach(x => { try { x.finish(); } catch {} });
        return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); })()`);
      const parsed = JSON.parse(await cdp.eval(CREW_FIT_PROBE));
      record('crew-card-fits', `crew@${w}x${h}`, parsed.valid === true && parsed.pass === true,
        parsed.valid ? `rows=${parsed.rows} outside=[${parsed.outside.join(',')}] startBottom=${parsed.startBottom} innerHeight=${parsed.innerHeight}` : `INVALID: ${parsed.reason}`);
      // Its own folder: the capture block below clears qa-latest before it writes.
      await shoot(cdp, path.join(root, '.superpowers', 'qa-crew', `crew-${w}x${h}.png`), { settle: true });
    }
```

  Also document the check in the `--check` comment list at the top of the file, in the same
  style as the others.

- [ ] **Step 7: Prove the gate can fail (sabotage check).**
  1. Temporarily add `.crew-row-name { white-space: nowrap; }` to styles.css.
  2. Run `node scripts/shoot.js --check` (with `run_in_background`; read the output when
     notified). Expected: `crew-card-fits` FAILS at `320x568`, naming `crew-row-name`. If it
     does not fail, the probe is not measuring the card; fix the probe.
  3. Remove the sabotage and re-run. Expected: green.

- [ ] **Step 8: Eyeball captures for the owner.** Capture the crew view (filled, empty, down)
  and home with 3 crews at 320×568, 390×844 and 1366×768 into `.superpowers/qa-crew/`. Look at
  them yourself first, then send them to the owner with SendUserFile alongside Task 7's images
  if they are still pending, and ask for a yes or no. Do not mark done without the answer.

- [ ] **Step 9: Run all gates.** Run `npm test`, `npm run shoot` and `npm run contrast`, the
  last two with `run_in_background`. Expected: all green.

- [ ] **Step 10: Commit** (after the owner's yes):

```bash
git add public/index.html public/styles.css public/js/app.js public/js/mock.js scripts/shoot.js
git commit -m "The crew page: the standing tally, the last five pies, and Start a table

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Deploy config, runbook, portability and a real full-pie smoke

**Files:**
- Create: `render.yaml`, `docs/DEPLOY.md`, `scripts/crew-smoke.js`,
  `scripts/portable-check.mjs`
- Modify: `package.json` (`smoke:crew`, `check:portable`)

**Interfaces:**
- Consumes: everything above.
- Produces: `node scripts/crew-smoke.js` prints `CREW <id> PIES <n>` and exits 0.
  `node scripts/portable-check.mjs` exits 0 when the server boots, migrates and saves a crew
  with only the portable env vars.

- [ ] **Step 1: Write the full-pie smoke** `scripts/crew-smoke.js`:

```js
'use strict';

/**
 * A REAL pie, start to finish, saved to a new crew: host + 3 bots, the dumbest
 * legal strategy (same as host-smoke.js), dealing each next slice at once.
 * Then saves to a new crew and waits for the server to confirm it.
 *
 *   node scripts/crew-smoke.js          (TONDO_URL or PORT picks the server)
 *
 * Prints `CREW <id> PIES 1` and exits 0; exits 1 on any error or after 5 min.
 * Bots think at human speed, so this takes minutes — run it in the background.
 */

const crypto = require('crypto');
const WebSocket = require('ws');

const URL = process.env.TONDO_URL || `ws://localhost:${process.env.PORT || 4600}`;
const ws = new WebSocket(URL);
const device = crypto.randomBytes(16).toString('hex');
let me = null;
let fingerprint = '';
let saveSent = false;

const timeout = setTimeout(() => fail('no saved pie within 5 min'), 300000);
function fail(why) { console.error(`CREW SMOKE FAIL: ${why}`); process.exit(1); }
function send(msg) { ws.send(JSON.stringify(msg)); }
function play(g, cardId) {
  const card = g.hand.find((c) => c.id === cardId);
  send(card && card.value === 'WILD' ? { type: 'play', cardId, suit: 'cheese' } : { type: 'play', cardId });
}

ws.on('open', () => send({ type: 'createRoom', name: 'Smoke', device }));
ws.on('error', (err) => fail(`socket: ${err.message}`));
ws.on('close', () => fail('the server closed the socket'));

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'error') return fail(msg.message);
  if (msg.type === 'joined') {
    me = msg.youId;
    for (let i = 0; i < 3; i++) send({ type: 'addBot' });
    return send({ type: 'startGame' });
  }
  if (msg.type !== 'state') return;
  const m = msg.match;
  if (msg.crews !== 'on') return fail(`crews are ${msg.crews} on this server`);

  if (msg.phase === 'roundOver') {
    if (m.savedTo) {
      clearTimeout(timeout);
      console.log(`CREW ${m.savedTo.id} PIES 1`);
      ws.removeAllListeners('close');
      ws.close();
      return process.exit(0);
    }
    if (m.complete && !saveSent && !m.saving) { saveSent = true; return send({ type: 'saveToCrew', newCrewName: 'Smoke crew' }); }
    if (!m.complete) return send({ type: 'newRound' });
    return;
  }
  if (msg.phase !== 'playing' || !msg.game) return;
  const g = msg.game;
  const fp = JSON.stringify([g.turnPlayerId, g.hand.map((c) => c.id), g.drawnDecisionCardId, g.topCard.id, g.canDeclareTondo]);
  if (fp === fingerprint) return;
  fingerprint = fp;
  if (g.canDeclareTondo) return send({ type: 'tondo' });
  if (g.turnPlayerId !== me) return;
  if (g.drawnDecisionCardId) {
    return g.playableCardIds.includes(g.drawnDecisionCardId) ? play(g, g.drawnDecisionCardId) : send({ type: 'pass' });
  }
  if (g.playableCardIds.length) return play(g, g.playableCardIds[0]);
  send({ type: 'draw' });
});
```

- [ ] **Step 2: Write the portability check** `scripts/portable-check.mjs`:

```js
// Proves "we can switch hosts": the server boots, migrates and saves a crew
// from a REAL pie with ONLY the portable variables — no Render/Fly variables,
// nothing inherited from this shell beyond PATH. (spec §8 item 11)
import { spawn } from 'node:child_process';
import { startPg } from '../test/helpers/pg.mjs';
import { freePort } from '../test/helpers/net.mjs';

const pg = await startPg();
const port = await freePort();
const env = { PATH: process.env.PATH, PORT: String(port), NODE_ENV: 'production', DATABASE_URL: pg.url, DATABASE_URL_DIRECT: pg.url, TONDO_DB_POOL_MAX: '1' };
const server = spawn(process.execPath, ['server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
server.stdout.on('data', (d) => { logs += d; });
server.stderr.on('data', (d) => { logs += d; });
const finish = async (code, line) => { console.log(line); server.kill('SIGTERM'); await pg.stop(); process.exit(code); };
const ready = await new Promise((resolve) => {
  const t = setTimeout(() => resolve(false), 15000);
  server.stdout.on('data', () => { if (logs.includes('[crews] store ready')) { clearTimeout(t); resolve(true); } });
  server.once('exit', () => { clearTimeout(t); resolve(false); });
});
if (!ready) await finish(1, `portable-check FAIL: no "[crews] store ready" within 15s\n${logs}`);
const smoke = spawn(process.execPath, ['scripts/crew-smoke.js'], { env: { PATH: process.env.PATH, TONDO_URL: `ws://127.0.0.1:${port}` }, stdio: ['ignore', 'pipe', 'inherit'] });
let out = '';
smoke.stdout.on('data', (d) => { out += d; });
smoke.once('exit', (code) => finish(code === 0 ? 0 : 1, code === 0 ? `portable-check OK: ${out.trim()} with env keys ${Object.keys(env).join(',')}` : `portable-check FAIL: crew-smoke exited ${code}\n${logs}`));
```

- [ ] **Step 3: Run it.** Add `"check:portable": "node scripts/portable-check.mjs"` and
  `"smoke:crew": "node scripts/crew-smoke.js"` to `package.json`. Run
  `npm run check:portable` with `run_in_background`, since it takes minutes. Expected:
  `portable-check OK: CREW <id> PIES 1 with env keys PATH,PORT,NODE_ENV,DATABASE_URL,DATABASE_URL_DIRECT,TONDO_DB_POOL_MAX`
  and exit 0. That line is the evidence for spec §8 item 11; paste it into the task report.

- [ ] **Step 4: Write `render.yaml`:**

```yaml
# Render Blueprint — Tondo on the free plan (testing). Nothing in the server is
# Render-specific: these are the only settings it reads. To move to Fly, see
# docs/DEPLOY.md.
services:
  - type: web
    name: tondo
    runtime: node
    plan: free
    region: frankfurt
    buildCommand: npm ci --omit=dev
    startCommand: npm start
    healthCheckPath: /health
    envVars:
      - key: NODE_ENV
        value: production
      - key: NODE_VERSION
        value: "20"
      # Render's load balancer appends the real client address as the last
      # X-Forwarded-For entry. UNVERIFIED until the live check in DEPLOY.md.
      - key: TONDO_TRUST_PROXY
        value: "1"
      - key: DATABASE_URL
        sync: false
      - key: DATABASE_URL_DIRECT
        sync: false
```

- [ ] **Step 5: Write `docs/DEPLOY.md`.** It must be written for the owner, step by step, with
  no step assumed. Sections:

```markdown
# Deploying Tondo

Tondo is one Node process that serves the page AND the game's WebSocket from
the same address (the WebSocket refuses other origins — server/index.js
`originAllowed`). Crews live in Postgres (Neon), outside the host, so moving
hosts never moves data.

## Settings the server reads (all of them)
| Variable | Value |
|---|---|
| `PORT` | set by the host |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Neon **pooled** connection string (has `-pooler` in the host) |
| `DATABASE_URL_DIRECT` | Neon **direct** connection string (same, without `-pooler`) |
| `TONDO_TRUST_PROXY` | `1` on Render |
| `TONDO_CLIENT_IP_HEADER` | `Fly-Client-IP` on Fly (instead of TONDO_TRUST_PROXY) |

## 1. Neon (you do this; ~5 minutes)
1. Sign up at neon.tech. Create a project named `tondo`, Postgres 16+, region
   **AWS Europe Central 1 (Frankfurt)**.
2. Dashboard → Connect → copy the connection string with **Connection pooling
   ON** (→ DATABASE_URL) and again with it **OFF** (→ DATABASE_URL_DIRECT).
   The two must differ only by `-pooler` in the host name.
3. Keep them private. Paste them only into Render's settings (step 2.4) —
   never into chat, a file in this repo, or a URL.

## 2. Render (you do this; ~10 minutes)
1. Sign up at render.com with GitHub. Authorize access to `gentritr1/tondo`.
2. New → Blueprint → pick the repo → it reads `render.yaml` → Apply.
3. When it asks for `DATABASE_URL` and `DATABASE_URL_DIRECT`, paste the two
   strings from step 1.2.
4. Wait for the first deploy to say Live. Tell Claude the service URL.

## 3. Live checks (Claude does these once you share the URL)
1. `curl -s https://<service>/health` → `crews.status` is `on`.
2. Open the URL on a phone, play a quick pie, Save to crew, open the crew link
   from a different browser → the tally shows.
3. Proxy address: `curl -s -H 'X-Forwarded-For: 6.6.6.6' https://<service>/health`
   while watching Render → Logs; a request that hits a budget logs the REAL
   address, never 6.6.6.6. (Claude triggers one deliberate 429 on
   `/api/crew/zzzzzzzzzz` with 61 quick requests to make the address appear.)
4. Restart persistence: Render → Manual Deploy → Restart; reload the crew link
   → same tally.

## Render free: what to expect
- Sleeps after 15 min with no HTTP request or WebSocket message; the next
  visitor waits about a minute.
- A restart or sleep drops live tables (they are in memory). Crews survive.
- No alert reaches you when the crew book fails: check `/health` or Logs.
  Before going commercial, add a push alert (spec §7.3).

## Moving to Fly later
1. Install flyctl; `fly auth signup` (needs a card after the trial).
2. In the repo: `fly launch --no-deploy --name tondo --region fra` (accept the
   Node detection; it writes a fly.toml and a Dockerfile).
3. `fly secrets set DATABASE_URL='<pooled>' DATABASE_URL_DIRECT='<direct>' NODE_ENV=production TONDO_CLIENT_IP_HEADER=Fly-Client-IP`
4. In fly.toml set `internal_port = 4600` is NOT needed — the server reads
   `PORT`; set `[env] PORT = "8080"` and `internal_port = 8080`.
5. `fly deploy`, then run the live checks in section 3 against the Fly URL.
6. Point players at the new URL; shut the Render service down.
```

  The Fly section is a runbook, not tested here. Say so in its first line:
  "(Untested until we move; the portability check proves the server needs nothing else.)"

- [ ] **Step 6: Run all gates and commit.**
  1. Run `npm test`, `npm run test:server` and `npm run test:db`. Expected: green.
  2. Commit:

```bash
git add render.yaml docs/DEPLOY.md scripts/crew-smoke.js scripts/portable-check.mjs package.json
git commit -m "Ready to deploy: a Render blueprint, a runbook for Render and Fly, and proof the server needs nothing host-specific

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Live verification (owner-gated, outward-facing)

**This task does not start without the owner's explicit yes to deploy.** Each step that
touches a third party asks first.

- [ ] **Step 1: Ask the owner to do DEPLOY.md sections 1 and 2 and to share the service URL.**
  Ask them also to create a **Neon branch** named `ci` and share that branch's direct URL in a
  file at `.env.neon-ci`, which must be git-ignored first. Add `.env*` to `.gitignore` and
  commit that before asking. Never ask for credentials in chat.

- [ ] **Step 2: Run the database tests against the Neon branch** (spec §8 items 1, 5, 12):
  1. Run `DATABASE_URL=$(cat .env.neon-ci) node test/crews.test.mjs`. The test's own
     `startPg` is skipped by an `if (process.env.DATABASE_URL)` guard; add that guard in this
     step: when `DATABASE_URL` is preset, use it and skip PGlite.
  2. Wrong-password drill: the same command with the password in the URL altered. Expected:
     `db.state().reason === 'wrong password'`. Print it with a one-line node script.
  3. Hang drill: in one `psql`-less node session, `BEGIN; LOCK TABLE pies IN ACCESS EXCLUSIVE
     MODE;` and hold for 10 s. Meanwhile run a save from a second process. Expected: the save
     fails with reason `timeout` within about 3 s.
  4. Awake time: one save, then check 10 min later in the Neon console (Branches → `ci` →
     Compute) that the compute is **Idle/Suspended**. Record the time it suspended.
  5. Record every result, with the exact command, in the task report.

- [ ] **Step 3: Live checks on Render.** Run DEPLOY.md section 3, steps 1-4, recording each
  command and its output. Also run **spec §8 item 2 (the link outlives the room)**:
  1. After the saved pie, everyone leaves the table.
  2. Poll `/health` until `rooms` drops (it should after 60 s).
  3. Open the crew URL copied from the actual Share text in the browser pane. `read_page`
     must show the crew page with the tally. If the proxy check logs `6.6.6.6`, **stop**: `TONDO_TRUST_PROXY=1` is
  wrong for Render. Read the actual `X-Forwarded-For` shape from a logged request, set the
  right hop count, and redeploy (a settings change is a deploy).

- [ ] **Step 4: Run the full-pie smoke against the live service.** Run
  `TONDO_URL=wss://<service> node scripts/crew-smoke.js` with `run_in_background`. Expected:
  `CREW <id> PIES 1`.

- [ ] **Step 5: Run the monitoring drill on live (spec §7.5).** Ask the owner before changing
  any Render setting. With their yes, set `DATABASE_URL` to a wrong password, redeploy, and
  check that `/health` shows `crews.status: failing, reason: wrong password` and that a quick
  pie still plays. Restore it, redeploy, and check that `/health` is back to `on`. Record the
  incident-style note (what, when, how noticed, cause, fix) in `docs/DEPLOY.md` under a new
  "Drills" section.

- [ ] **Step 6: Report** with the CLAUDE.md §6 evidence block, filled. Close the open
  verification gaps from the spec: items 6 and 12 move from UNVERIFIED to VERIFIED, or stay
  open with the reason.
