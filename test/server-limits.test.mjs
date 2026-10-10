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
  // Refill is 1/s, so a slow run earns extra admissions: allow only for the
  // whole seconds actually elapsed (a fast run must refuse at exactly 65).
  const slack = Math.floor((Date.now() - t0) / 1000);
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
