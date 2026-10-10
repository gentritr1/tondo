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
const { RoomManager } = require('../server/rooms');
const { saveToCrew } = require('../server/crew-actions');
const { createIpBudgets } = require('../server/limits');
await db.start();

const sock = () => ({ readyState: 1, sent: [], send(d) { this.sent.push(JSON.parse(d)); }, terminate() {}, close() {} });
const dev = () => crypto.randomBytes(16).toString('hex');

/** A finished pie at a 3-human + 1-bot table, scored by hand. */
function finishedTable() {
  const manager = new RoomManager({ crewsStatus: () => db.publicStatus() });
  manager.stop();
  const devices = [dev(), dev(), dev()];
  const made = manager.createRoom('Gent', sock(), { deviceHash: crews.hashDevice(devices[0]) });
  const room = made.room;
  const arta = manager.joinRoom(room.code, 'Arta', sock(), undefined, { deviceHash: crews.hashDevice(devices[1]) }).seat;
  const dren = manager.joinRoom(room.code, 'Dren', sock(), undefined, { deviceHash: crews.hashDevice(devices[2]) }).seat;
  const chef = room.addSeat({ name: 'Chef Bot', isBot: true });
  room.pie.scores = {
    [made.seat.id]: { points: 212, roundsWon: 2 }, [arta.id]: { points: 180, roundsWon: 1 },
    [chef.id]: { points: 40, roundsWon: 1 }, [dren.id]: { points: 0, roundsWon: 0 },
  };
  room.pie.round = 4;
  room.pie.complete = true;
  room.pie.championIds = room.leaders();
  return { manager, room, host: made.seat, arta, dren, chef, devices };
}
const budgets = () => createIpBudgets();

test('refused before the pie is complete, from a bot, and with a malformed crew id', async () => {
  const t = finishedTable();
  t.room.pie.complete = false;
  assert(saveToCrew({ room: t.room, seat: t.host, message: { newCrewName: 'X' }, ip: 'a', budgets: budgets() }).refuse === 'Finish the pie first.', 'incomplete');
  t.room.pie.complete = true;
  assert(saveToCrew({ room: t.room, seat: t.chef, message: { newCrewName: 'X' }, ip: 'a', budgets: budgets() }).refuse === 'Bots do not save pies.', 'bot');
  assert(saveToCrew({ room: t.room, seat: t.host, message: { crewId: '../../etc' }, ip: 'a', budgets: budgets() }).refuse === 'That crew link is not right.', 'bad id');
});

test('refused when crews are not on', () => {
  const t = finishedTable();
  const out = saveToCrew({ room: t.room, seat: t.host, message: { newCrewName: 'X' }, ip: 'a', budgets: budgets(), status: () => 'failing' });
  assert(out.refuse === db.PLAYER_MESSAGE, out.refuse);
});

test('a save records server scores, ignores client-sent scores, sets savedTo and room.crew', async () => {
  const t = finishedTable();
  const out = saveToCrew({ room: t.room, seat: t.arta, message: { newCrewName: 'Friday Pie', points: 99999, standings: [] }, ip: 'a', budgets: budgets() });
  assert(out.started && t.room.pie.saving === true, 'saving');
  const r = await out.started;
  assert(r.ok && t.room.pie.saving === false && t.room.pie.savedTo.name === 'Friday Pie', JSON.stringify(r));
  assert(t.room.crew && t.room.crew.id === t.room.pie.savedTo.id, 'room remembers its crew');
  const crew = await crews.readCrew(r.crew.id, crews.hashDevice(t.devices[0]));
  assert(crew.members.length === 3 && crew.members[0].name === 'Gent' && crew.members[0].wins === 1, JSON.stringify(crew.members));
  assert(!JSON.stringify(crew).includes('99999'), 'client scores ignored');
  const snap = t.room.snapshotFor(t.host.id);
  assert(snap.crews === 'on' && snap.crew.id === r.crew.id && snap.match.savedTo.id === r.crew.id && snap.match.saving === false, JSON.stringify({ crews: snap.crews, crew: snap.crew, m: snap.match.savedTo }));
});

test('concurrent saves: two seats tapping at once -> one pie row, no error', async () => {
  const t = finishedTable();
  const first = saveToCrew({ room: t.room, seat: t.host, message: { newCrewName: 'Race' }, ip: 'a', budgets: budgets() });
  const second = saveToCrew({ room: t.room, seat: t.arta, message: { newCrewName: 'Race' }, ip: 'b', budgets: budgets() });
  assert(first.started && second.noop === true, `second: ${JSON.stringify(second)}`);
  const r = await first.started;
  const again = saveToCrew({ room: t.room, seat: t.dren, message: { crewId: r.crew.id }, ip: 'c', budgets: budgets() });
  assert(again.noop === true, 'same crew after save is a no-op');
  assert((await crews.readCrew(r.crew.id, null)).pies === 1, 'one pie');
});

test('a second crew for the same pie is refused by name', async () => {
  const t = finishedTable();
  const r = await saveToCrew({ room: t.room, seat: t.host, message: { newCrewName: 'First' }, ip: 'a', budgets: budgets() }).started;
  const other = saveToCrew({ room: t.room, seat: t.host, message: { newCrewName: 'Second' }, ip: 'a', budgets: budgets() });
  assert(other.refuse === 'This pie is already saved to First.', other.refuse);
  assert(r.ok, 'first ok');
});

test('a dead crew id comes back as the store message, and saving clears', async () => {
  const t = finishedTable();
  const r = await saveToCrew({ room: t.room, seat: t.host, message: { crewId: 'zzzzzzzzzz' }, ip: 'a', budgets: budgets() }).started;
  assert(!r.ok && r.message === 'That crew is gone.' && t.room.pie.saving === false && t.room.pie.savedTo === null, JSON.stringify(r));
});

test('a newRound during the save: the record and savedTo belong to the pie that was saved', async () => {
  const t = finishedTable();
  const old = t.room.pie;
  const out = saveToCrew({ room: t.room, seat: t.host, message: { newCrewName: 'Mid Flight' }, ip: 'a', budgets: budgets() });
  assert(out.started, 'started');
  assert(t.room.startRound().ok && t.room.pie !== old, 'a new pie replaced room.pie while the save was in flight');
  const r = await out.started;
  assert(r.ok, JSON.stringify(r));
  assert(old.saving === false && old.savedTo && old.savedTo.id === r.crew.id, 'the SAVED pie got savedTo and had saving cleared');
  assert(t.room.pie.savedTo === null && t.room.pie.saving === false, 'the new pie is untouched');
  const crew = await crews.readCrew(r.crew.id, null);
  const gent = crew.recent[0].players.find((p) => p.name === 'Gent');
  assert(gent && gent.points === 212, `recorded the finished pie's scores: ${JSON.stringify(crew.recent[0].players)}`);
});

test('the crew-creation budget is spent per address', async () => {
  const b = budgets();
  for (let i = 0; i < 10; i++) b.crewCreate.take('z');
  const t = finishedTable();
  const out = saveToCrew({ room: t.room, seat: t.host, message: { newCrewName: 'Eleventh' }, ip: 'z', budgets: b });
  assert(out.refuse === 'You have started enough crews for now. Try again later.', out.refuse);
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
