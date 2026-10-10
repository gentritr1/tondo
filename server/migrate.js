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
  // A dropped connection is re-emitted as 'error'; with no listener it is an
  // uncaught exception. The pending query still rejects, and start() retries.
  client.on('error', () => console.warn('[crews] migration connection dropped'));
  await client.connect();
  try {
    // Another instance may hold the lock (overlapping deploys): wait, but not forever.
    await client.query("SET lock_timeout = '10s'");
    await client.query("SET statement_timeout = '30s'");
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
