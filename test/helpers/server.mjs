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
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`server did not open within 10s:\n${logs}`)); }, 10000);
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
