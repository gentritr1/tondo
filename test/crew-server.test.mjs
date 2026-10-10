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

/** The server opens its port before the book finishes connecting, so a test that
 *  needs the book waits for /health to stop saying `starting` (100 ms polls, 6 s cap). */
async function settled(srv, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    const h = await (await fetch(`${srv.http}/health`)).json();
    if (h.crews.status !== 'starting' || Date.now() > end) return h;
    await new Promise((r) => setTimeout(r, 100));
  }
}

let server = await spawnServer(env);
await settled(server);
const get = (path, headers = {}) => fetch(server.http + path, { headers: { 'X-Forwarded-For': '203.0.113.50', ...headers } });

test('/health reports crews on without touching the database', async () => {
  const h = await (await get('/health')).json();
  assert(h.ok && h.crews.status === 'on' && h.crews.ready === true, JSON.stringify(h));
});

test('/health never queries the database; /health/crews does (the log line is the probe)', async () => {
  for (let i = 0; i < 3; i++) await get('/health');
  assert(!/\bping\b/.test(server.logs()), `/health touched the database:\n${server.logs()}`);
  const r = await get('/health/crews');
  assert(r.status === 200 && (await r.json()).ok === true, `status ${r.status}`);
  assert(/\[crews\] ping ok/.test(server.logs()), 'the positive control: /health/crews does ping');
  const q = await get('/health/crews?probe=1');
  assert(q.status === 200 && (await q.json()).ok === true, `a query string does not hide the route: ${q.status}`);
});

test('the per-address read budget answers 429 once spent', async () => {
  const codes = [];
  for (let i = 0; i < 72; i++) codes.push((await get('/api/crew/zzzzzzzzzz', { 'X-Forwarded-For': '203.0.113.60' })).status);
  const first429 = codes.indexOf(429);
  assert(first429 >= 58 && first429 <= 64, `first 429 at ${first429}: ${codes.join(',')}`);
  assert(codes.slice(0, first429).every((c) => c === 404), 'before the budget ran out: 404');
  assert((await get('/api/crew/zzzzzzzzzz', { 'X-Forwarded-For': '203.0.113.61' })).status === 404, 'another address is unaffected');
});

test('the table-open crew lookup spends the read budget too: over it, the table opens without its crew', async () => {
  const xff = '203.0.113.70';
  const codes = [];
  for (let i = 0; i < 62; i++) codes.push((await get('/api/crew/zzzzzzzzzz', { 'X-Forwarded-For': xff })).status);
  assert(codes[61] === 429, `budget drained: ${codes.slice(55).join(',')}`);
  const c = client(server.ws, { 'X-Forwarded-For': xff });
  await c.open();
  c.send({ type: 'createRoom', name: 'Gent', device, crewId: seeded.id });
  const first = await c.next((m) => m.type === 'state');
  assert(first.crews === 'on' && first.crew === null, 'the table opened');
  let gained = null;
  try { gained = await c.next((m) => m.type === 'state' && m.crew, 600); } catch { /* expected: no crew arrives */ }
  assert(gained === null, `the lookup should have been skipped: ${JSON.stringify(gained && gained.crew)}`);
  await c.close();
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
  await settled(server);
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
  try {
    await settled(off);
    const r = await fetch(`${off.http}/api/crew/${seeded.id}`);
    assert(r.status === 503 && (await r.json()).reason === 'not configured', `status ${r.status}`);
    const hc = await fetch(`${off.http}/health/crews`);
    assert(hc.status === 503 && (await hc.json()).ok === false, `health/crews status ${hc.status}`);
    const c = client(off.ws); await c.open();
    try {
      c.send({ type: 'createRoom', name: 'Gent', device });
      const s = await c.next((m) => m.type === 'state');
      assert(s.crews === 'off', s.crews);
    } finally { await c.close(); }
  } finally { await off.stop(); }
});

test('database unreachable: crews failing with the reason, game unaffected (drill: unknown host)', async () => {
  const bad = await spawnServer({ DATABASE_URL: 'postgres://u:p@nope.invalid:5432/db', TONDO_DB_RETRY_MS: '60000' });
  try {
    const h = await settled(bad);
    assert(h.crews.status === 'failing' && h.crews.reason === 'unknown host', JSON.stringify(h.crews));
    const c = client(bad.ws); await c.open();
    try {
      c.send({ type: 'createRoom', name: 'Gent', device });
      const s = await c.next((m) => m.type === 'state');
      assert(s.crews === 'failing' && s.phase === 'lobby', JSON.stringify({ crews: s.crews, phase: s.phase }));
    } finally { await c.close(); }
  } finally { await bad.stop(); }
});

let passed = 0;
const failures = [];
for (const [name, fn] of tests) {
  try { await fn(); passed++; } catch (err) { failures.push({ name, err }); }
}
await server.stop();
// The server's goodbye reaches pglite-socket from another process, so its
// connection-close handler can run a tick AFTER we close the engine under it
// (an uncaught TypeError in the library). Let it land first.
await new Promise((r) => setTimeout(r, 150));
await pgsrv.stop();
if (failures.length) {
  for (const f of failures) console.error(`\n  FAIL  ${f.name}\n        ${f.err && f.err.stack}`);
  console.error(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(1);
}
console.log(`\n${passed} passed, 0 failed\n`);
