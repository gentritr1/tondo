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

test('an IPv6 /64 shares the wrong-code budget: rotating addresses inside it does not refill it', async () => {
  for (let i = 0; i < 10; i++) {
    const c = as(`2001:db8:5:5::${i + 1}`); await c.open();
    c.send({ type: 'joinRoom', code: 'NOPE-0000', name: 'Probe' });
    const e = await c.next(isError);
    assert(e.message === 'No table has that code.', `attempt ${i + 1}: ${e.message}`);
    await c.close();
  }
  const c = as('2001:db8:5:5:dead:beef:0:1'); await c.open();
  c.send({ type: 'joinRoom', code: 'NOPE-0000', name: 'Probe' });
  const e = await c.next(isError);
  assert(/Too many wrong table codes/.test(e.message), `11th from a NEW address in the same /64: ${e.message}`);
  await c.close();
  const other = as('2001:db8:5:6::1'); await other.open();
  other.send({ type: 'joinRoom', code: 'NOPE-0000', name: 'Probe' });
  assert((await other.next(isError)).message === 'No table has that code.', 'the next /64 is not charged');
  await other.close();
});

test('the concurrent-socket cap is counted per /64 too', async () => {
  const small = await spawnServer({ TONDO_TRUST_PROXY: '1', TONDO_MAX_SOCKETS_PER_IP: '2' });
  const open = [];
  try {
    for (const ip of ['2001:db8:7:7::1', '2001:db8:7:7::2']) { const c = client(small.ws, { 'X-Forwarded-For': ip }); await c.open(); open.push(c); }
    let refused = null;
    try { const c = client(small.ws, { 'X-Forwarded-For': '2001:db8:7:7::3' }); await c.open(); open.push(c); } catch (err) { refused = err.message; }
    assert(refused && /HTTP 401/.test(refused), `third socket in the /64 should be refused: ${refused}`);
    const c = client(small.ws, { 'X-Forwarded-For': '2001:db8:7:8::1' }); await c.open(); open.push(c);
  } finally {
    for (const c of open) await c.close().catch(() => {});
    await small.stop();
  }
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
