'use strict';

/** IpBudget: a token bucket per address that survives the socket it was spent on. */

const { IpBudget, createIpBudgets, BUDGETS, budgetKey } = require('../server/limits');

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

test('budgetKey: IPv4 is unchanged; IPv6 collapses to its /64', () => {
  assert(budgetKey('203.0.113.7') === '203.0.113.7', 'IPv4 as-is');
  assert(budgetKey('::ffff:203.0.113.7') === '203.0.113.7', 'IPv4-mapped is the IPv4 address');
  assert(budgetKey('') === '' && budgetKey(undefined) === '', 'empty stays empty');
  assert(budgetKey('not-an-address') === 'not-an-address', 'unparseable is kept as it came');
  assert(budgetKey('2001:db8::1') === budgetKey('2001:db8:0:0::2'), 'compressed forms in one /64 share a key');
  assert(budgetKey('2001:db8::1') === budgetKey('2001:0db8:0000:0000:ffff:ffff:ffff:ffff'), 'fully expanded, upper half of the /64');
  assert(budgetKey('2001:DB8:0:0:1:2:3:4') === budgetKey('2001:db8::9'), 'case-insensitive');
  assert(budgetKey('2001:db8:0:1::1') !== budgetKey('2001:db8::1'), 'a different /64 is a different key');
  assert(budgetKey('2001:db8:0:0:0:0:0:0') === budgetKey('2001:db8::'), 'trailing :: expands');
  assert(budgetKey('::1') === budgetKey('0:0:0:0:0:0:0:5'), 'leading :: expands');
  assert(budgetKey('fe80::1%eth0') === budgetKey('fe80::2'), 'a zone id is not part of the key');
  assert(budgetKey('64:ff9b::1.2.3.4') === budgetKey('64:ff9b::102:304'), 'an embedded dotted quad is expanded');
  assert(budgetKey('1:2:3:4:5:6:7:8:9') === '1:2:3:4:5:6:7:8:9', 'too many groups: kept as it came');
  assert(budgetKey('1::2::3') === '1::2::3', 'two :: : kept as it came');
});

test('addresses in one /64 share a bucket; another /64 and IPv4 do not', () => {
  const b = new IpBudget({ burst: 2, perMs: 1e9 });
  assert(b.take('2001:db8::1', 0) && b.take('2001:db8:0:0::2', 0), 'two spent in the /64 by two addresses');
  assert(!b.take('2001:db8:0:0:1:2:3:4', 0), 'a third address in the same /64 is refused');
  assert(b.take('2001:db8:0:1::1', 0), 'a different /64 has its own budget');
  assert(b.take('203.0.113.7', 0) && b.take('203.0.113.8', 0), 'IPv4 addresses stay separate');
  assert(b.size() === 4, `buckets: ${b.size()}`);
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
