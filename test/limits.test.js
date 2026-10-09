'use strict';

/** IpBudget: a token bucket per address that survives the socket it was spent on. */

const { IpBudget, createIpBudgets, BUDGETS } = require('../server/limits');

let passed = 0;
const failures = [];
function test(name, fn) { try { fn(); passed++; } catch (err) { failures.push({ name, err }); } }
function assert(cond, message) { if (!cond) throw new Error(message || 'assertion failed'); }

test('a fresh address has the whole burst, then is refused', () => {
  const b = new IpBudget({ burst: 3, perMs: 1000 });
  assert(b.take('a', 0) && b.take('a', 0) && b.take('a', 0), 'three free');
  assert(!b.take('a', 0), 'fourth refused');
});

test('tokens refill at one per perMs, capped at the burst', () => {
  const b = new IpBudget({ burst: 2, perMs: 1000 });
  b.take('a', 0); b.take('a', 0);
  assert(!b.take('a', 999), 'not yet');
  assert(b.take('a', 1000), 'one back after 1s');
  assert(b.take('a', 60000) && b.take('a', 60000) && !b.take('a', 60000), 'capped at burst 2');
});

test('allow() never spends; spend() does', () => {
  const b = new IpBudget({ burst: 1, perMs: 1000 });
  assert(b.allow('a', 0) && b.allow('a', 0), 'allow is free');
  b.spend('a', 0);
  assert(!b.allow('a', 0), 'spent');
});

test('addresses do not share a bucket', () => {
  const b = new IpBudget({ burst: 1, perMs: 1000 });
  assert(b.take('a', 0) && b.take('b', 0), 'separate');
});

test('the LRU forgets the least recently used address past maxKeys', () => {
  const b = new IpBudget({ burst: 1, perMs: 1e9, maxKeys: 2 });
  b.take('a', 0); b.take('b', 0); b.take('c', 0); // a evicted
  assert(b.take('a', 0), 'a starts fresh after eviction');
  assert(b.size() <= 2, `size ${b.size()}`);
});

test('the shipped budgets match the spec table', () => {
  const s = (k) => `${BUDGETS[k].burst}/${BUDGETS[k].perMs}`;
  assert(s('connect') === '64/1000' && s('joinFail') === '10/2000'
    && s('crewRead') === '60/1000' && s('crewCreate') === '10/360000', JSON.stringify(BUDGETS));
  const all = createIpBudgets();
  assert(['connect', 'joinFail', 'crewRead', 'crewCreate'].every((k) => all[k] instanceof IpBudget), 'four budgets');
});

if (failures.length) {
  for (const f of failures) console.error(`\n  FAIL  ${f.name}\n        ${f.err && f.err.message}`);
  console.error(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(1);
}
console.log(`\n${passed} passed, 0 failed\n`);
