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
  // pg re-emits a dropped connection as 'error' on a checked-out client; with no
  // listener that is an uncaught exception and takes the whole game down. The
  // failing query still rejects, and the pool discards the dead client.
  const onErr = (err) => console.warn(`[crews] connection dropped: ${classify(err)}`);
  client.on('error', onErr);
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
    client.removeListener('error', onErr);
    client.release();
  }
}

/** One store operation: timed, logged, classified. CrewStoreErrors pass through untouched. */
async function run(op, fn, meta = {}) {
  const t0 = Date.now();
  // Read at log time: a caller may fill meta.crew in once it knows the id (a new crew).
  const crewSuffix = () => (meta.crew ? ` crew=${meta.crew}` : '');
  try {
    const out = await fn();
    if (ready) setState('on', null);
    console.log(`[crews] ${op} ok${crewSuffix()} ms=${Date.now() - t0}`);
    return out;
  } catch (err) {
    if (err instanceof CrewStoreError) {
      console.log(`[crews] ${op} refused: ${err.reason}${crewSuffix()}`);
      throw err;
    }
    const reason = classify(err);
    // Once migrated, status stays 'on' (a later success must be able to
    // recover); the last op's failure reason stays visible in /health.
    setState(ready ? 'on' : 'failing', reason);
    console.warn(`[crews] ${op} failed: ${reason}${crewSuffix()}`);
    throw new CrewStoreError(reason);
  }
}

async function ping() { await run('ping', () => tx((c) => c.query('SELECT 1'))); }

// Each start() and stop() opens a new generation. An attempt that settles after
// its generation has passed (a raced-out migration finally answering, or a
// stop() mid-flight) must not set `ready` or schedule a timer.
let generation = 0;

/**
 * Never rejects. Each attempt is raced against TONDO_DB_START_DEADLINE_MS
 * (default 60s): pg_advisory_lock blocks while another instance migrates
 * (Render overlaps deploys) and a hung connect must not hold boot hostage.
 * A missed deadline is a failed attempt with reason 'timeout'.
 */
async function start({ migrateFn = migrate } = {}) {
  clearTimeout(retryTimer);
  const gen = ++generation;
  if (!configured()) { ready = false; setState('off', 'not configured'); return; }
  setState('starting', null);
  let delay = Number(process.env.TONDO_DB_RETRY_MS) || 30000;
  const deadlineMs = Number(process.env.TONDO_DB_START_DEADLINE_MS) || 60000;
  const attempt = async () => {
    let deadlineTimer;
    try {
      const url = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
      const applied = await new Promise((resolve, reject) => {
        deadlineTimer = setTimeout(() => {
          const e = new Error('start deadline exceeded');
          e.code = 'ETIMEDOUT';
          reject(e);
        }, deadlineMs);
        if (deadlineTimer.unref) deadlineTimer.unref();
        Promise.resolve().then(() => migrateFn(url)).then(resolve, reject);
      });
      clearTimeout(deadlineTimer);
      if (gen !== generation) return;
      ready = true;
      setState('on', null);
      console.log(`[crews] store ready${applied.length ? ` (applied ${applied.join(', ')})` : ''}`);
    } catch (err) {
      clearTimeout(deadlineTimer);
      if (gen !== generation) return;
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
  generation++;
  const p = pool;
  pool = null;
  ready = false;
  if (p) await p.end().catch(() => {});
}

module.exports = { configured, start, stop, state, publicStatus, tx, run, ping, classify, CrewStoreError, PLAYER_MESSAGE };
