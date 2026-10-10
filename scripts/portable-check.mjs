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
smoke.stdout.on('data', (d) => { out += d; process.stderr.write(d); });
smoke.once('exit', (code) => {
  const result = out.trim().split('\n').filter((l) => l.startsWith('CREW ')).pop() || '';
  finish(code === 0 ? 0 : 1, code === 0 ? `portable-check OK: ${result} with env keys ${Object.keys(env).join(',')}` : `portable-check FAIL: crew-smoke exited ${code}\n${logs}`);
});
