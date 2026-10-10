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

test('start() against an unknown host is failing with that reason', async () => {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A test's own bounded guard: a hang must fail the test, not the whole run. */
const within = (ms, p, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} did not finish within ${ms}ms`)), ms))]);
const withEnv = async (vars, fn) => {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { await fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } await db.stop(); }
};

test('start() retries with doubling gaps, goes failing, failing, on, and publicStatus ends on', () => withEnv(
  { DATABASE_URL: 'postgres://u:p@fake.invalid:5432/db', DATABASE_URL_DIRECT: undefined, TONDO_DB_RETRY_MS: '40', TONDO_DB_START_DEADLINE_MS: undefined },
  async () => {
    const calls = [];
    let finish;
    const done = new Promise((r) => { finish = r; });
    const migrateFn = async () => {
      calls.push({ at: Date.now(), status: db.state().status });
      if (calls.length <= 2) { const e = new Error('getaddrinfo ENOTFOUND fake.invalid'); e.code = 'ENOTFOUND'; throw e; }
      setTimeout(finish, 0);
      return [1];
    };
    await db.start({ migrateFn });
    assert(db.state().status === 'failing' && db.state().reason === 'unknown host', JSON.stringify(db.state()));
    await within(2000, done, 'the third attempt');
    await sleep(20);
    assert(calls.length === 3, `calls ${calls.length}`);
    assert(calls.map((c) => c.status).join() === 'starting,failing,failing', calls.map((c) => c.status).join());
    const g1 = calls[1].at - calls[0].at;
    const g2 = calls[2].at - calls[1].at;
    assert(Math.abs(g1 - 40) <= 30 && Math.abs(g2 - 80) <= 30, `gaps ${g1}ms then ${g2}ms, want ~40 then ~80`);
    assert(db.state().status === 'on' && db.state().reason === null && db.publicStatus() === 'on', JSON.stringify(db.state()));
  }));

test('start() hands migrateFn the DIRECT url when set, else DATABASE_URL', () => withEnv(
  { DATABASE_URL: 'postgres://pooled.invalid/db', DATABASE_URL_DIRECT: 'postgres://direct.invalid/db' },
  async () => {
    const seen = [];
    await db.start({ migrateFn: async (u) => { seen.push(u); return []; } });
    delete process.env.DATABASE_URL_DIRECT;
    await db.start({ migrateFn: async (u) => { seen.push(u); return []; } });
    assert(seen[0] === 'postgres://direct.invalid/db', `with direct: ${seen[0]}`);
    assert(seen[1] === 'postgres://pooled.invalid/db', `without direct: ${seen[1]}`);
  }));

test('start() resolves with failing/timeout when a migration never answers (deadline race)', () => withEnv(
  { DATABASE_URL: 'postgres://u:p@fake.invalid:5432/db', TONDO_DB_START_DEADLINE_MS: '100', TONDO_DB_RETRY_MS: '60000' },
  async () => {
    await within(2000, db.start({ migrateFn: () => new Promise(() => {}) }), 'start()');
    const s = db.state();
    assert(s.status === 'failing' && s.reason === 'timeout' && db.publicStatus() === 'failing', JSON.stringify(s));
  }));

// Generation counter: start() and stop() each open a new generation; a stale attempt must be inert.
test('an attempt that settles after stop() or a newer start() sets nothing and schedules nothing', () => withEnv(
  { DATABASE_URL: 'postgres://u:p@fake.invalid:5432/db', TONDO_DB_RETRY_MS: '30', TONDO_DB_START_DEADLINE_MS: undefined },
  async () => {
    // (1) a late SUCCESS after stop() must not make the store ready
    const late = db.start({ migrateFn: () => sleep(120).then(() => [1]) });
    await sleep(20);
    await db.stop();
    await within(2000, late, 'the stopped start()');
    await sleep(200);
    assert(db.state().ready === false && db.state().status !== 'on' && db.publicStatus() === 'failing', `late success after stop: ${JSON.stringify(db.state())}`);
    // (2) a late FAILURE after stop() must not schedule a retry
    let calls = 0;
    const failing = db.start({ migrateFn: async () => { calls++; await sleep(80); throw new Error('boom'); } });
    await sleep(20);
    await db.stop();
    await within(2000, failing, 'the stopped start()');
    await sleep(250);
    assert(calls === 1, `a retry ran after stop(): ${calls} calls`);
    // (3) a late success from a superseded start() must not override the newer one
    const old = db.start({ migrateFn: () => sleep(120).then(() => [1]) });
    await sleep(20);
    await db.start({ migrateFn: async () => { const e = new Error('x'); e.code = '28P01'; throw e; } });
    await within(2000, old, 'the superseded start()');
    await sleep(200);
    assert(db.state().ready === false && db.state().status === 'failing' && db.state().reason === 'wrong password', `superseded: ${JSON.stringify(db.state())}`);
  }));

test('migrate() sets lock and statement timeouts before taking the lock, and listens for connection errors', async () => {
  const seen = [];
  const orig = pg.Client.prototype.query;
  pg.Client.prototype.query = function (text, ...rest) {
    if (typeof text === 'string') seen.push({ text, listeners: this.listenerCount('error') });
    return orig.call(this, text, ...rest);
  };
  try {
    await migrate(pgsrv.url);
  } finally {
    pg.Client.prototype.query = orig;
  }
  const idx = (re) => seen.findIndex((q) => re.test(q.text));
  const lock = idx(/pg_advisory_lock/);
  assert(idx(/SET lock_timeout = '10s'/) >= 0 && idx(/SET lock_timeout = '10s'/) < lock, 'lock_timeout not set before the lock');
  assert(idx(/SET statement_timeout = '30s'/) >= 0 && idx(/SET statement_timeout = '30s'/) < lock, 'statement_timeout not set before the lock');
  assert(seen[0].listeners >= 1, 'the migrator client has no error listener');
});

test('every tx() runs under a 3s statement_timeout', async () => {
  process.env.DATABASE_URL = pgsrv.url;
  process.env.TONDO_DB_POOL_MAX = '1';
  await db.start();
  const v = await db.tx(async (c) => (await c.query('SHOW statement_timeout')).rows[0].statement_timeout);
  assert(v === '3s', `statement_timeout inside tx is ${v}`);
});

test('failure and refusal log lines put the reason first and the crew last, so grep "failed:" sees every failure', async () => {
  process.env.DATABASE_URL = pgsrv.url;
  process.env.TONDO_DB_POOL_MAX = '1';
  if (db.publicStatus() !== 'on') await db.start();
  const lines = [];
  const { warn, log } = console;
  console.warn = (m) => lines.push(String(m));
  console.log = (m) => lines.push(String(m));
  try {
    await db.run('probe', () => db.tx((c) => c.query('SELECT * FROM no_such_table')), { crew: 'k7m2q9xh3p' }).catch(() => {});
    await db.run('probe2', async () => { throw new db.CrewStoreError('not a member'); }, { crew: 'k7m2q9xh3p' }).catch(() => {});
  } finally { console.warn = warn; console.log = log; }
  assert(lines.includes('[crews] probe failed: missing table crew=k7m2q9xh3p'), JSON.stringify(lines));
  assert(lines.includes('[crews] probe2 refused: not a member crew=k7m2q9xh3p'), JSON.stringify(lines));
});

test('a connection dropped mid-transaction rejects with a CrewStoreError, does not crash the process, and the next op works', async () => {
  process.env.DATABASE_URL = pgsrv.url;
  process.env.TONDO_DB_POOL_MAX = '1';
  if (db.publicStatus() !== 'on') await db.start();
  const uncaught = [];
  const onUncaught = (err) => uncaught.push(err);
  process.on('uncaughtException', onUncaught);
  try {
    let caught = null;
    try {
      await db.run('probe', () => db.tx(async (c) => { c.connection.stream.destroy(); await c.query('SELECT 1'); }));
    } catch (err) { caught = err; }
    await sleep(100); // pg emits the 'error' event on a later tick
    assert(uncaught.length === 0, `uncaught exception: ${uncaught[0] && uncaught[0].message}`);
    assert(caught instanceof db.CrewStoreError, `rejected with ${caught && caught.constructor.name}`);
    assert(caught.reason === 'database error' || caught.reason === 'timeout', `reason ${caught.reason}`);
    assert(db.state().status === 'on', JSON.stringify(db.state()));
    await within(5000, db.run('probe', () => db.tx((c) => c.query('SELECT 1'))), 'the follow-up op');
  } finally {
    process.removeListener('uncaughtException', onUncaught);
  }
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
