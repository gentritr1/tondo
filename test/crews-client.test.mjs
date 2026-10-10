/** public/js/crews.js against a fake localStorage — including hostile contents. */

function fakeStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
    data,
  };
}
globalThis.localStorage = fakeStorage();
const { CREW_ID, getDevice, readCrews, rememberCrew, forgetCrew, crewLink, withDevice } = await import('../public/js/crews.js');

let passed = 0;
const failures = [];
const test = (name, fn) => { try { fn(); passed++; } catch (err) { failures.push({ name, err }); } };
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };

test('getDevice makes one 32-hex secret and keeps it', () => {
  globalThis.localStorage = fakeStorage();
  const a = getDevice();
  assert(/^[0-9a-f]{32}$/.test(a) && getDevice() === a, a);
});

test('getDevice replaces a malformed stored secret', () => {
  globalThis.localStorage = fakeStorage({ 'tondo.device': 'not-hex' });
  assert(/^[0-9a-f]{32}$/.test(getDevice()), 'replaced');
});

test('getDevice returns "" when storage throws (Safari private mode)', () => {
  globalThis.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert(getDevice() === '', 'empty');
  const p = withDevice({ type: 'createRoom', name: 'G' });
  assert(!('device' in p), 'no device field when there is none');
});

test('storage parsing: corrupt JSON, foreign shapes, bad ids and oversize lists read as the valid subset', () => {
  const good = (i) => ({ id: `k7m2q9xh${String(i).padStart(2, '0')}`.replace(/[^0-9a-hjkmnp-tv-z]/g, '0'), name: `Crew ${i}`, at: i });
  globalThis.localStorage = fakeStorage({ 'tondo.crews': '{not json' });
  assert(readCrews().length === 0, 'corrupt reads empty');
  assert(globalThis.localStorage.data.get('tondo.crews') === '{not json', 'and is never deleted');
  globalThis.localStorage = fakeStorage({ 'tondo.crews': JSON.stringify({ id: 'x' }) });
  assert(readCrews().length === 0, 'non-array reads empty');
  const mixed = [good(1), { id: 'BAD', name: 'x' }, { id: good(2).id, name: '' }, null, 7, good(1), ...Array.from({ length: 14 }, (_, i) => good(i + 3))];
  globalThis.localStorage = fakeStorage({ 'tondo.crews': JSON.stringify(mixed) });
  const list = readCrews();
  assert(list.length === 10, `capped at 10, got ${list.length}`);
  assert(new Set(list.map((c) => c.id)).size === list.length, 'deduped');
  assert(list.every((c) => CREW_ID.test(c.id) && c.name.length >= 1 && c.name.length <= 24), 'only valid entries');
});

test('rememberCrew puts the crew first, dedupes, caps at 10; forgetCrew removes it', () => {
  globalThis.localStorage = fakeStorage();
  for (let i = 0; i < 12; i++) rememberCrew({ id: `abcdefgh${String(i).padStart(2, '0')}`, name: `C${i}` });
  rememberCrew({ id: 'abcdefgh03', name: 'Renamed' });
  const list = readCrews();
  assert(list.length === 10 && list[0].id === 'abcdefgh03' && list[0].name === 'Renamed', JSON.stringify(list.slice(0, 2)));
  forgetCrew('abcdefgh03');
  assert(!readCrews().some((c) => c.id === 'abcdefgh03'), 'forgotten');
  rememberCrew({ id: 'BAD', name: 'x' });
  assert(!readCrews().some((c) => c.id === 'BAD'), 'invalid ids are never stored');
});

test('names are clipped to 24 CHARACTERS: an emoji at position 24 is not cut in half, when written or read', () => {
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const edge = `${'a'.repeat(23)}\u{1F355}tail`;
  globalThis.localStorage = fakeStorage();
  rememberCrew({ id: 'abcdefgh01', name: edge });
  const written = JSON.parse(globalThis.localStorage.data.get('tondo.crews'))[0].name;
  assert(written === `${'a'.repeat(23)}\u{1F355}`, `written: ${JSON.stringify(written)}`);
  globalThis.localStorage = fakeStorage({ 'tondo.crews': JSON.stringify([{ id: 'abcdefgh02', name: edge, at: 1 }]) });
  const read = readCrews()[0].name;
  assert(read === `${'a'.repeat(23)}\u{1F355}` && !lone.test(read), `read: ${JSON.stringify(read)}`);
});

test('what is WRITTEN is already clean: capped at 10 and never holding an invalid id', () => {
  globalThis.localStorage = fakeStorage();
  for (let i = 0; i < 12; i++) rememberCrew({ id: `abcdefgh${String(i).padStart(2, '0')}`, name: `C${i}` });
  rememberCrew({ id: 'BAD', name: 'x' });
  const raw = JSON.parse(globalThis.localStorage.data.get('tondo.crews'));
  assert(raw.length === 10, `stored ${raw.length}`);
  assert(raw.every((c) => CREW_ID.test(c.id)), 'invalid id reached storage');
});

test('crewLink appends ?crew= to the app origin', () => {
  assert(crewLink('https://tondo.example/', 'k7m2q9xh3p') === 'https://tondo.example/?crew=k7m2q9xh3p', crewLink('https://tondo.example/', 'k7m2q9xh3p'));
});

if (failures.length) {
  for (const f of failures) console.error(`\n  FAIL  ${f.name}\n        ${f.err && f.err.message}`);
  console.error(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(1);
}
console.log(`\n${passed} passed, 0 failed\n`);
