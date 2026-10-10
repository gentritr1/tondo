// A local Postgres (PGlite) for trying crews by hand, no account needed:
//   node scripts/dev-db.mjs            (prints the DATABASE_URL to use)
//   DATABASE_URL=<that> TONDO_DB_POOL_MAX=1 npm start
// Data lives in memory and is gone when this process stops.
import { startPg } from '../test/helpers/pg.mjs';
const pg = await startPg();
console.log(`DATABASE_URL=${pg.url}`);
process.on('SIGINT', async () => { await pg.stop(); process.exit(0); });
