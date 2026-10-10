import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { startPg } from './helpers/pg.mjs';

const require = createRequire(import.meta.url);
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };

const pgsrv = await startPg();
process.env.DATABASE_URL = pgsrv.url;
process.env.TONDO_DB_POOL_MAX = '1';
const db = require('../server/db');
const crews = require('../server/crews');
await db.start();
assert(db.publicStatus() === 'on', JSON.stringify(db.state()));

const dev = () => crypto.randomBytes(16).toString('hex');
const key = () => crypto.randomBytes(8).toString('hex');
const human = (device, name, points, won = false) => ({ kind: 'human', deviceHash: device ? crews.hashDevice(device) : null, name, points, won });
const bot = (name, points, won = false) => ({ kind: 'bot', name, points, won });

test('ids, names and device secrets are validated', () => {
  const id = crews.newCrewId();
  assert(crews.validCrewId(id) && id.length === 10, id);
  assert(!crews.validCrewId('k7m2q9xh3P') && !crews.validCrewId('k7m2q9xh3') && !crews.validCrewId('oooooooooo'), 'rejects bad ids');
  assert(crews.cleanCrewName('  Friday   Pie  ') === 'Friday Pie', 'collapses whitespace');
  assert(crews.cleanCrewName('x'.repeat(30)).length === 24, 'caps at 24');
  const edge = `${'a'.repeat(23)}\u{1F355}tail`; // the pizza emoji is 2 UTF-16 units and sits at character 24
  assert(crews.cleanCrewName(edge) === `${'a'.repeat(23)}\u{1F355}`, `an emoji at position 24 is kept whole, not split: ${JSON.stringify(crews.cleanCrewName(edge))}`);
  assert(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(crews.cleanCrewName('\u{1F355}'.repeat(30))), 'never a lone surrogate');
  assert(Array.from(crews.cleanCrewName('\u{1F355}'.repeat(30))).length === 24, 'caps at 24 characters');
  assert(crews.cleanCrewName('   ') === null && crews.cleanCrewName(null) === null, 'empty is null');
  assert(crews.hashDevice('a'.repeat(32)).length === 64 && crews.hashDevice('xyz') === null, 'hash or null');
  assert(crews.hashDevice('A'.repeat(32)) === null && crews.hashDevice('a'.repeat(31)) === null && crews.hashDevice('a'.repeat(33)) === null, 'device secret is exactly 32 lowercase hex');
});

test('a new crew with 3 humans + 1 bot: 3 members, bot only in history, tally derived', async () => {
  const [g, a, d] = [dev(), dev(), dev()];
  const saved = await crews.savePie({ newName: 'Friday Pie' }, { pieKey: key(), rounds: 4, players: [
    human(g, 'Gent', 212, true), human(a, 'Arta', 180), bot('Chef Bot', 40), human(d, 'Dren', 12),
  ] });
  assert(saved.name === 'Friday Pie' && crews.validCrewId(saved.id) && saved.duplicate === false, JSON.stringify(saved));
  const crew = await crews.readCrew(saved.id, crews.hashDevice(g));
  assert(crew.pies === 1 && crew.members.length === 3, JSON.stringify(crew));
  assert(crew.members[0].name === 'Gent' && crew.members[0].wins === 1 && crew.members[0].you === true, JSON.stringify(crew.members[0]));
  const kinds = crew.recent[0].players.map((p) => `${p.kind}:${p.name}`).join(',');
  assert(kinds === 'member:Gent,member:Arta,bot:Chef Bot,member:Dren', kinds);
});

test('saving the same pie twice records it once', async () => {
  const g = dev();
  const record = { pieKey: key(), rounds: 4, players: [human(g, 'Gent', 10, true), bot('Pina', 5)] };
  const first = await crews.savePie({ newName: 'Dupes' }, record);
  const again = await crews.savePie({ crewId: first.id }, record);
  assert(again.duplicate === true, 'second is a duplicate');
  assert((await crews.readCrew(first.id, null)).pies === 1, 'one pie');
});

test('same device in two seats (two tabs): the second seat is a guest, the save succeeds', async () => {
  const g = dev();
  const saved = await crews.savePie({ newName: 'Two Tabs' }, { pieKey: key(), rounds: 4, players: [
    human(g, 'Gent', 30, true), human(g, 'Gent', 20), bot('Pina', 5),
  ] });
  const crew = await crews.readCrew(saved.id, crews.hashDevice(g));
  assert(crew.members.length === 1, `members ${crew.members.length}`);
  const kinds = crew.recent[0].players.map((p) => p.kind).join(',');
  assert(kinds === 'member,guest,bot', kinds);
});

test('a seat with no device is a nameless guest', async () => {
  const saved = await crews.savePie({ newName: 'Guests' }, { pieKey: key(), rounds: 4, players: [human(dev(), 'Gent', 9, true), human(null, 'Old Client', 3)] });
  const crew = await crews.readCrew(saved.id, null);
  const guest = crew.recent[0].players.find((p) => p.kind === 'guest');
  assert(guest && guest.name === null && guest.points === 3, JSON.stringify(crew.recent[0]));
});

test('two different devices named Gent read back as Gent and Gent 2; a rename sticks', async () => {
  const [g1, g2] = [dev(), dev()];
  const saved = await crews.savePie({ newName: 'Gents' }, { pieKey: key(), rounds: 4, players: [human(g1, 'Gent', 9, true), human(g2, 'gent', 3)] });
  let names = (await crews.readCrew(saved.id, null)).members.map((m) => m.name).sort().join(',');
  assert(names === 'Gent,gent 2', names);
  await crews.savePie({ crewId: saved.id }, { pieKey: key(), rounds: 4, players: [human(g2, 'Vesa', 9, true), human(g1, 'Gent', 3)] });
  names = (await crews.readCrew(saved.id, null)).members.map((m) => m.name).sort().join(',');
  assert(names === 'Gent,Vesa', names);
});

test('leaving removes the name everywhere; past pies say former; rejoining is a new member', async () => {
  const [g, a] = [dev(), dev()];
  const saved = await crews.savePie({ newName: 'Leavers' }, { pieKey: key(), rounds: 4, players: [human(g, 'Gent', 9, true), human(a, 'Arta', 3)] });
  assert(await crews.leave(saved.id, crews.hashDevice(a)) === true, 'left');
  assert(await crews.leave(saved.id, crews.hashDevice(a)) === false, 'second leave is a no-op');
  const crew = await crews.readCrew(saved.id, crews.hashDevice(a));
  assert(crew.members.length === 1 && !crew.members.some((m) => m.you), JSON.stringify(crew.members));
  const former = crew.recent[0].players.find((p) => p.kind === 'former');
  assert(former && former.name === null, JSON.stringify(crew.recent[0]));
  const c = await db.tx((cl) => cl.query("SELECT count(*)::int AS n FROM members WHERE crew_id = $1 AND name = 'Arta'", [saved.id]));
  assert(c.rows[0].n === 0, 'no copy of the name remains');
});

test('unknown crew: read is null, save throws a clear refusal, crewName is null', async () => {
  assert(await crews.readCrew('zzzzzzzzzz', null) === null, 'read null');
  let err = null;
  try { await crews.savePie({ crewId: 'zzzzzzzzzz' }, { pieKey: key(), rounds: 4, players: [] }); } catch (e) { err = e; }
  assert(err && err.publicMessage === 'That crew is gone.', err && err.message);
  assert(await crews.crewName('zzzzzzzzzz') === null, 'crewName null');
});

test('recent is capped at 5, newest first, and members sort by wins then pies', async () => {
  const [g, a] = [dev(), dev()];
  const first = await crews.savePie({ newName: 'Busy' }, { pieKey: key(), rounds: 4, players: [human(g, 'Gent', 1, true), human(a, 'Arta', 0)] });
  for (let i = 0; i < 6; i++) {
    await crews.savePie({ crewId: first.id }, { pieKey: key(), rounds: 4, players: [human(g, 'Gent', 0), human(a, 'Arta', 100 + i, true)] });
  }
  const crew = await crews.readCrew(first.id, null);
  assert(crew.pies === 7 && crew.recent.length === 5, `pies ${crew.pies} recent ${crew.recent.length}`);
  assert(crew.recent[0].players[0].points === 105, 'newest first');
  assert(crew.members[0].name === 'Arta' && crew.members[0].wins === 6, JSON.stringify(crew.members));
});

test('members sort by wins before pies: one win outranks more pies without a win', async () => {
  const [g, a] = [dev(), dev()];
  const first = await crews.savePie({ newName: 'Wins First' }, { pieKey: key(), rounds: 4, players: [human(g, 'Gent', 1), human(a, 'Arta', 9, true)] });
  for (let i = 0; i < 2; i++) {
    await crews.savePie({ crewId: first.id }, { pieKey: key(), rounds: 4, players: [human(g, 'Gent', 5 + i)] });
  }
  const crew = await crews.readCrew(first.id, null);
  const gent = crew.members.find((m) => m.name === 'Gent');
  assert(gent.pies === 3 && gent.wins === 0, JSON.stringify(crew.members));
  assert(crew.members[0].name === 'Arta' && crew.members[0].pies === 1, JSON.stringify(crew.members));
});

test('a device that left can rejoin: it becomes a new member, and the old pie still says former', async () => {
  const [g, a] = [dev(), dev()];
  const saved = await crews.savePie({ newName: 'Rejoin' }, { pieKey: key(), rounds: 4, players: [human(g, 'Gent', 9, true), human(a, 'Arta', 3)] });
  assert(await crews.leave(saved.id, crews.hashDevice(a)) === true, 'left');
  const back = await crews.savePie({ crewId: saved.id }, { pieKey: key(), rounds: 4, players: [human(g, 'Gent', 4), human(a, 'Arta', 8, true)] });
  assert(back.duplicate === false, JSON.stringify(back));
  const crew = await crews.readCrew(saved.id, crews.hashDevice(a));
  assert(crew.members.length === 2, JSON.stringify(crew.members));
  const me = crew.members.filter((m) => m.you);
  assert(me.length === 1 && me[0].name === 'Arta' && me[0].pies === 1 && me[0].wins === 1, `the new member starts fresh: ${JSON.stringify(crew.members)}`);
  assert(crew.recent.length === 2, `recent ${crew.recent.length}`);
  const oldKinds = crew.recent[1].players.map((p) => p.kind).sort().join(',');
  assert(oldKinds === 'former,member', `old pie still says former: ${oldKinds}`);
  assert(crew.recent[0].players.every((p) => p.kind === 'member'), 'new pie lists both as members');
});

test('an empty or blank crew name is refused with a clear message, not "That crew is gone."', async () => {
  for (const newName of ['', '   ', '\n\t']) {
    let err = null;
    try { await crews.savePie({ newName }, { pieKey: key(), rounds: 4, players: [human(dev(), 'Gent', 1, true)] }); } catch (e) { err = e; }
    assert(err && err.publicMessage === 'Give the crew a name.', `${JSON.stringify(newName)} -> ${err && (err.publicMessage || err.message)}`);
  }
});

test('a save stamps last_pie_at on the crew', async () => {
  const saved = await crews.savePie({ newName: 'Stamped' }, { pieKey: key(), rounds: 4, players: [human(dev(), 'Gent', 1, true)] });
  const r = await db.tx((cl) => cl.query('SELECT last_pie_at FROM crews WHERE id = $1', [saved.id]));
  assert(r.rows[0].last_pie_at != null, 'last_pie_at is set after a save');
});

test('members tied on wins sort by pies desc, then by name asc', async () => {
  const [z, a, b, c] = [dev(), dev(), dev(), dev()];
  // Join order is Zed, Ann, Bob, Cal. Nobody wins, so wins tie at 0.
  const first = await crews.savePie({ newName: 'Ties' }, { pieKey: key(), rounds: 4, players: [human(z, 'Zed', 1), human(a, 'Ann', 1), human(b, 'Bob', 1), human(c, 'Cal', 1)] });
  await crews.savePie({ crewId: first.id }, { pieKey: key(), rounds: 4, players: [human(c, 'Cal', 1)] });
  const names = (await crews.readCrew(first.id, null)).members.map((m) => `${m.name}:${m.pies}`).join(',');
  assert(names === 'Cal:2,Ann:1,Bob:1,Zed:1', names);
});

test('the ok log line of a NEW crew carries its minted id, not a placeholder', async () => {
  const lines = [];
  const { log } = console;
  console.log = (m) => lines.push(String(m));
  let saved;
  try {
    saved = await crews.savePie({ newName: 'Logged' }, { pieKey: key(), rounds: 4, players: [human(dev(), 'Gent', 1, true)] });
  } finally { console.log = log; }
  const ok = lines.find((l) => /^\[crews\] save ok /.test(l));
  assert(ok && ok.startsWith(`[crews] save ok crew=${saved.id} ms=`), JSON.stringify(lines));
});

let passed = 0;
const failures = [];
for (const [name, fn] of tests) {
  try { await fn(); passed++; } catch (err) { failures.push({ name, err }); }
}
await db.stop();
await pgsrv.stop();
if (failures.length) {
  for (const f of failures) console.error(`\n  FAIL  ${f.name}\n        ${f.err && f.err.stack}`);
  console.error(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(1);
}
console.log(`\n${passed} passed, 0 failed\n`);
