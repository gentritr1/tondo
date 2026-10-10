import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { startPg } from './helpers/pg.mjs';
import { freePort } from './helpers/net.mjs';
import { client } from './helpers/client.mjs';

/**
 * The wire path a finished pie cannot reach in a spawned server (a real pie
 * takes minutes of bot think time): the `device` secret on createRoom/joinRoom
 * becomes a seat's deviceHash, and a saveToCrew sent over a real socket records
 * those seats as crew members. The server runs IN this process so the test can
 * put the room into its finished state directly.
 */
const require = createRequire(import.meta.url);
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };

const pgsrv = await startPg();
const port = await freePort();
process.env.DATABASE_URL = pgsrv.url;
process.env.TONDO_DB_POOL_MAX = '1';
process.env.PORT = String(port);
const db = require('../server/db');
const crews = require('../server/crews');
const { server, manager } = require('../server/index');
for (let i = 0; i < 100 && db.publicStatus() !== 'on'; i++) await new Promise((r) => setTimeout(r, 100));
assert(db.publicStatus() === 'on', JSON.stringify(db.state()));
await new Promise((r) => (server.listening ? r() : server.once('listening', r)));

const url = `ws://127.0.0.1:${port}`;
const dev = () => crypto.randomBytes(16).toString('hex');
const open = async () => { const c = client(url); await c.open(); return c; };

function finish(room) {
  room.pie.scores = {};
  room.seats.forEach((s, i) => { room.pie.scores[s.id] = { points: 100 - i * 10, roundsWon: i === 0 ? 2 : 0 }; });
  room.pie.round = 3;
  room.recordRound(); // the real closing path: completes the pie and freezes who played it
}

test('device on createRoom, joinRoom and a token reclaim reaches the saved crew', async () => {
  const [d1, d2, d3] = [dev(), dev(), dev()];
  const host = await open();
  host.send({ type: 'createRoom', name: 'Gent', device: d1 });
  const hj = await host.next((m) => m.type === 'joined');
  const code = hj.roomCode;

  const guest = await open();
  guest.send({ type: 'joinRoom', code, name: 'Arta', device: d2 });
  await guest.next((m) => m.type === 'joined');

  // Joins WITHOUT a device (an old client), then a second socket reclaims the
  // seat by token WITH one (the token outranks the stale socket).
  const late = await open();
  late.send({ type: 'joinRoom', code, name: 'Dren' });
  const lj = await late.next((m) => m.type === 'joined');
  const back = await open();
  back.send({ type: 'joinRoom', code, name: 'Dren', token: lj.token, device: d3 });
  await back.next((m) => m.type === 'joined' && m.reconnected === true);

  // A device-less player at the same table: plays, but is never a member.
  const nobody = await open();
  nobody.send({ type: 'joinRoom', code, name: 'Guest' });
  await nobody.next((m) => m.type === 'joined');

  const room = manager.getRoom(code);
  finish(room);
  host.send({ type: 'saveToCrew', newCrewName: 'Wire Crew' });
  const saved = await host.next((m) => m.type === 'state' && m.match.savedTo, 5000);
  assert(saved.crews === 'on' && saved.crew.id === saved.match.savedTo.id && saved.match.saving === false, JSON.stringify(saved.match.savedTo));

  const crew = await crews.readCrew(saved.match.savedTo.id, crews.hashDevice(d1));
  const names = crew.members.map((m) => m.name).sort();
  assert(JSON.stringify(names) === JSON.stringify(['Arta', 'Dren', 'Gent']), `members: ${JSON.stringify(crew.members)}`);
  assert(crew.members.find((m) => m.name === 'Gent').you === true, 'your row is marked');
  assert(crew.recent[0].players.some((p) => p.kind === 'guest'), `the device-less seat is a guest: ${JSON.stringify(crew.recent[0].players)}`);
  for (const c of [host, guest, late, back, nobody]) await c.close();
});

let passed = 0;
const failures = [];
for (const [name, fn] of tests) {
  try { await fn(); passed++; } catch (err) { failures.push({ name, err }); }
}
manager.stop();
await new Promise((r) => setTimeout(r, 100));
await db.stop();
await new Promise((r) => setTimeout(r, 150));
await pgsrv.stop();
if (failures.length) {
  for (const f of failures) console.error(`\n  FAIL  ${f.name}\n        ${f.err && f.err.stack}`);
  console.error(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(1);
}
console.log(`\n${passed} passed, 0 failed\n`);
process.exit(0);
