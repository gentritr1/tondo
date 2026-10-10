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
    // Order matters: a specific code/message keeps its reason even when the text also says "timeout".
    [{ code: '42P01', message: 'relation "crews" does not exist (after a connection timeout)' }, 'missing table'],
    [{ code: 'XX000', message: 'Your project has exceeded the compute time quota; statement timeout' }, 'over quota'],
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
  assert(db.state().reason === 'missing table' && db.state().status === 'on' && db.publicStatus() === 'on', JSON.stringify(db.state()));
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
