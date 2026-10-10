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
