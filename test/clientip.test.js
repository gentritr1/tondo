'use strict';

/** Which address a request is charged to, with and without a trusted proxy. */

const { clientIpFrom } = require('../server/clientip');

let passed = 0;
const failures = [];
function test(name, fn) { try { fn(); passed++; } catch (err) { failures.push({ name, err }); } }
function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message || 'not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const req = (remoteAddress, headers = {}) => ({ headers, socket: { remoteAddress } });

test('with no proxy settings the socket address is used, ::ffff: folded', () => {
  eq(clientIpFrom(req('::ffff:10.0.0.5', { 'x-forwarded-for': '1.1.1.1' }), {}), '10.0.0.5');
});

test('TONDO_TRUST_PROXY=1 takes the RIGHTMOST forwarded entry, never a forged left one', () => {
  const r = req('10.9.9.9', { 'x-forwarded-for': '6.6.6.6, 203.0.113.7' });
  eq(clientIpFrom(r, { TONDO_TRUST_PROXY: '1' }), '203.0.113.7');
});

test('TONDO_TRUST_PROXY=2 skips one more hop from the right', () => {
  const r = req('10.9.9.9', { 'x-forwarded-for': '6.6.6.6, 203.0.113.7, 10.1.1.1' });
  eq(clientIpFrom(r, { TONDO_TRUST_PROXY: '2' }), '203.0.113.7');
});

test('trusting a proxy but receiving no header falls back to the socket address', () => {
  eq(clientIpFrom(req('10.9.9.9'), { TONDO_TRUST_PROXY: '1' }), '10.9.9.9');
});

test('a non-integer or zero TONDO_TRUST_PROXY is ignored', () => {
  const r = req('10.9.9.9', { 'x-forwarded-for': '203.0.113.7' });
  eq(clientIpFrom(r, { TONDO_TRUST_PROXY: '0' }), '10.9.9.9');
  eq(clientIpFrom(r, { TONDO_TRUST_PROXY: 'yes' }), '10.9.9.9');
});

test('TONDO_CLIENT_IP_HEADER wins over X-Forwarded-For (Fly-Client-IP)', () => {
  const r = req('10.9.9.9', { 'fly-client-ip': '198.51.100.4', 'x-forwarded-for': '6.6.6.6' });
  eq(clientIpFrom(r, { TONDO_CLIENT_IP_HEADER: 'Fly-Client-IP', TONDO_TRUST_PROXY: '1' }), '198.51.100.4');
});

test('an empty configured header falls through to the next rule', () => {
  const r = req('10.9.9.9', { 'x-forwarded-for': '203.0.113.7' });
  eq(clientIpFrom(r, { TONDO_CLIENT_IP_HEADER: 'Fly-Client-IP', TONDO_TRUST_PROXY: '1' }), '203.0.113.7');
});

if (failures.length) {
  for (const f of failures) console.error(`\n  FAIL  ${f.name}\n        ${f.err && f.err.message}`);
  console.error(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(1);
}
console.log(`\n${passed} passed, 0 failed\n`);
