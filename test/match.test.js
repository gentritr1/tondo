'use strict';

/**
 * The pie: round scoring and the four-slice match layer.
 *
 * Runner matches rules.test.js. Every test names the behaviour it pins; the
 * forfeit test in particular guards a trap that existed the moment scoring was
 * introduced — `removePlayer` returns a leaving hand to the deck BEFORE it can
 * end the round, so the naive implementation scores those cards as zero.
 */

const game = require('../server/game');
const { RoomManager, NEXT_SLICE_MS } = require('../server/rooms');

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed++; } catch (err) { failures.push({ name, err }); }
}
function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}
function eq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function fakeSocket() {
  return { readyState: 1, sent: [], send(payload) { this.sent.push(JSON.parse(payload)); } };
}

/** A room with one human host and `bots` bot seats, mid-round. */
function seatedRoom(bots = 2) {
  const manager = new RoomManager();
  const { room } = manager.createRoom('Gent', fakeSocket());
  for (let i = 0; i < bots; i++) room.addSeat({ name: `Bot${i + 1}`, isBot: true });
  return { manager, room };
}

/**
 * Banks one finished round on the room's pie without running a whole round.
 * The match layer only ever reads `game.roundResult`, so a stub is enough —
 * but `snapshotFor` also calls `game.viewFor`, which needs a real state, so
 * `readMatch` below drops the stub before snapshotting.
 */
function bankRound(room, winnerId, points) {
  room.game = { roundResult: { winnerId, points, forfeited: 0, breakdown: [] }, status: 'roundOver' };
  room.phase = 'playing';
  room.finishRoundIfOver();
}

/** The `match` block of a snapshot, taken with the round stub cleared away. */
function readMatch(room, seatId) {
  room.game = null;
  return room.snapshotFor(seatId).match;
}

/** Replaces a player's hand outright so a round can be ended on demand. */
function setHand(state, playerId, cards) {
  game.findPlayer(state, playerId).hand = cards.map((c, i) => ({
    id: `set-${playerId}-${i}`, suit: c.suit, value: c.value,
  }));
}

// ---------------------------------------------------------------------------
// Card values
// ---------------------------------------------------------------------------

test('card values follow the UNO scale players already know', () => {
  eq(game.cardPoints({ suit: 'basil', value: '0' }), 0, 'zero');
  eq(game.cardPoints({ suit: 'basil', value: '7' }), 7, 'number is face value');
  eq(game.cardPoints({ suit: 'basil', value: '9' }), 9, 'nine');
  eq(game.cardPoints({ suit: 'basil', value: 'SKIP' }), 20, 'skip');
  eq(game.cardPoints({ suit: 'basil', value: 'PLUS2' }), 20, 'plus2');
  eq(game.cardPoints({ suit: 'basil', value: 'REVERSE' }), 20, 'reverse');
  eq(game.cardPoints({ suit: null, value: 'WILD' }), 50, 'wild');
  eq(game.cardPoints(null), 0, 'a missing card is worth nothing, not NaN');
});

test('handPoints sums a hand and copes with an empty one', () => {
  eq(game.handPoints([{ value: '5' }, { value: 'SKIP' }, { value: 'WILD' }]), 75);
  eq(game.handPoints([]), 0);
  eq(game.handPoints(undefined), 0);
});

// ---------------------------------------------------------------------------
// Round result
// ---------------------------------------------------------------------------

test('the winner banks every card left in every other hand', () => {
  const state = game.createGame(
    [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }, { id: 'p3', name: 'C' }],
    { seed: 3 },
  );
  const mover = game.currentPlayer(state).id;
  const others = state.players.filter((p) => p.id !== mover);
  setHand(state, others[0].id, [{ suit: 'basil', value: '9' }, { suit: null, value: 'WILD' }]); // 59
  setHand(state, others[1].id, [{ suit: 'cheese', value: 'SKIP' }]);                            // 20

  const win = { id: 'win-card', suit: game.topCard(state).suit, value: '4' };
  game.findPlayer(state, mover).hand = [win];
  assert(game.playCard(state, mover, win.id).ok, 'winning card played');

  const r = state.roundResult;
  assert(r, 'a round result was recorded');
  eq(r.winnerId, mover, 'winner');
  eq(r.points, 79, '59 + 20');
  eq(r.breakdown.length, 2, 'one row per loser');
  eq(r.breakdown.reduce((n, b) => n + b.points, 0), 79, 'breakdown sums to the total');
});

test('the winner is not charged for their own empty hand', () => {
  const state = game.createGame([{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }], { seed: 11 });
  const mover = game.currentPlayer(state).id;
  const other = state.players.find((p) => p.id !== mover).id;
  setHand(state, other, [{ suit: 'basil', value: '3' }]);
  const win = { id: 'w', suit: game.topCard(state).suit, value: '8' };
  game.findPlayer(state, mover).hand = [win];
  game.playCard(state, mover, win.id);
  eq(state.roundResult.points, 3, 'only the loser is counted');
});

test('FORFEIT: a hand returned to the deck is still scored', () => {
  // The trap: removePlayer splices the leaving hand into the draw pile before
  // it ends the round, so reading hands at endRound time counts them as zero.
  const state = game.createGame([{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }], { seed: 5 });
  setHand(state, 'p2', [{ suit: null, value: 'WILD' }, { suit: 'basil', value: 'SKIP' }]); // 70
  const r = game.removePlayer(state, 'p2');
  assert(r.ok, 'removal accepted');
  eq(state.status, 'roundOver', 'the last player standing ends the round');
  eq(state.winnerId, 'p1', 'the remaining player wins');
  eq(state.roundResult.points, 70, 'the forfeited hand was banked before it was shuffled away');
  eq(state.roundResult.forfeited, 70, 'and is attributed as forfeited');
});

// ---------------------------------------------------------------------------
// The pie
// ---------------------------------------------------------------------------

test('a fresh room starts on slice zero of four with an empty scoreboard', () => {
  const { room } = seatedRoom(2);
  const snap = room.snapshotFor(room.seats[0].id);
  eq(snap.match.roundsPerPie, 4, 'four slices');
  eq(snap.match.round, 0, 'none played');
  eq(snap.match.complete, false, 'not complete');
  eq(snap.match.standings.length, 3, 'every seat is on the board');
  eq(snap.match.standings.every((r) => r.points === 0), true, 'all on zero');
  eq(snap.match.leaderIds.length, 0, 'nobody leads a scoreless pie');
});

test('finishing a round banks its points and advances the slice', () => {
  const { room } = seatedRoom(2);
  assert(room.startRound().ok, 'round started');
  const winner = room.seats[1].id;
  const others = room.seats.filter((s) => s.id !== winner);
  setHand(room.game, others[0].id, [{ suit: 'basil', value: '9' }]);
  setHand(room.game, others[1].id, [{ suit: null, value: 'WILD' }]);
  game.findPlayer(room.game, winner).hand = [];
  room.game.status = 'roundOver';
  // endRound is what computes the result; drive it the way the engine does.
  room.game.roundResult = null;
  room.game.status = 'playing';
  const win = { id: 'w', suit: game.topCard(room.game).suit, value: '2' };
  game.findPlayer(room.game, winner).hand = [win];
  room.game.turnIndex = room.game.players.findIndex((p) => p.id === winner);
  assert(game.playCard(room.game, winner, win.id).ok, 'winning play');
  room.finishRoundIfOver();

  eq(room.phase, 'roundOver', 'phase moved');
  eq(room.pie.round, 1, 'one slice down');
  eq(room.scoreFor(winner).points, 59, '9 + 50');
  eq(room.scoreFor(winner).roundsWon, 1, 'one round win');
  eq(room.leaders()[0], winner, 'and they lead');
});

test('the pie completes after exactly four slices and crowns the leader', () => {
  const { room } = seatedRoom(1); // two seats
  const a = room.seats[0].id;
  const b = room.seats[1].id;
  // Slices 1-3 to `a`, slice 4 to `b` — `a` still takes the pie on points.
  for (const [winner, points] of [[a, 40], [a, 30], [b, 10], [a, 20]]) bankRound(room, winner, points);
  eq(room.pie.round, 4, 'four slices');
  eq(room.pie.complete, true, 'pie complete');
  eq(room.scoreFor(a).points, 90, 'a banked 90');
  eq(room.scoreFor(b).points, 10, 'b banked 10');
  eq(room.pie.championIds.join(','), a, 'a is champion');
});

test('a tie on points is broken by round wins', () => {
  const { room } = seatedRoom(1);
  const a = room.seats[0].id;
  const b = room.seats[1].id;
  for (const [winner, points] of [[a, 30], [a, 30], [b, 60], [b, 0]]) bankRound(room, winner, points);
  eq(room.scoreFor(a).points, 60, 'a on 60');
  eq(room.scoreFor(b).points, 60, 'b on 60');
  eq(room.scoreFor(a).roundsWon, 2, 'a won two');
  eq(room.scoreFor(b).roundsWon, 2, 'b won two');
  // Equal on both: a genuine tie is shared rather than resolved by seat order.
  eq(room.pie.championIds.length, 2, 'both crowned');
});

test('dealing again after a finished pie starts a new one; dealing mid-pie does not', () => {
  const { room } = seatedRoom(1);
  const a = room.seats[0].id;
  for (let i = 0; i < 3; i++) bankRound(room, a, 25);
  eq(room.pie.round, 3, 'three slices in');
  assert(room.startRound().ok, 'deal slice four');
  eq(room.pie.round, 3, 'a mid-pie deal keeps the score');
  eq(room.scoreFor(a).points, 75, 'points survive the deal');

  bankRound(room, a, 25);
  eq(room.pie.complete, true, 'now complete');

  assert(room.startRound().ok, 'deal again');
  eq(room.pie.round, 0, 'a completed pie resets on the next deal');
  eq(room.scoreFor(a).points, 0, 'and the scoreboard is cleared');
  eq(room.pie.complete, false, 'not complete');
});

test('the finished scoreboard survives roundOver so it can be read', () => {
  const { room } = seatedRoom(1);
  const a = room.seats[0].id;
  for (let i = 0; i < 4; i++) bankRound(room, a, 10);
  const match = readMatch(room, a);
  eq(match.complete, true, 'still complete in the snapshot');
  eq(match.standings[0].points, 40, 'and the totals are still there');
  eq(match.lastRound.points, 10, 'with the last round attached');
});

test('a seat added mid-pie starts on zero rather than breaking the board', () => {
  const { room } = seatedRoom(1);
  const a = room.seats[0].id;
  bankRound(room, a, 40);
  room.addSeat({ name: 'Latecomer', isBot: true });
  const match = readMatch(room, a);
  eq(match.standings.length, 3, 'three rows');
  eq(match.standings[match.standings.length - 1].points, 0, 'newcomer on zero');
  eq(match.leaderIds[0], a, 'the leader is unchanged');
});

test('a seat that leaves drops off the board without corrupting it', () => {
  const { room } = seatedRoom(2);
  const a = room.seats[0].id;
  const gone = room.seats[2].id;
  bankRound(room, gone, 90);
  eq(room.leaders()[0], gone, 'they led while seated');
  room.phase = 'lobby';
  room.game = null;
  room.removeSeat(gone);
  const match = readMatch(room, a);
  eq(match.standings.length, 2, 'only the seats still here');
  eq(match.standings.some((r) => r.id === gone), false, 'no ghost row');
});

// ---------------------------------------------------------------------------
// The between-slices clock — nobody waits for the host
// ---------------------------------------------------------------------------

test('finishing a slice arms the countdown', () => {
  const { room } = seatedRoom(2);
  const t0 = Date.now();
  bankRound(room, room.seats[1].id, 40);
  assert(room.nextDueAt >= t0 + NEXT_SLICE_MS - 50, 'armed roughly one window out');
  assert(room.nextDueAt <= Date.now() + NEXT_SLICE_MS, 'and not further');
  eq(room.held, false, 'not held');
});

test('a FINISHED pie never arms the countdown — that boundary earns a pause', () => {
  const { room } = seatedRoom(1);
  const a = room.seats[0].id;
  for (let i = 0; i < 4; i++) bankRound(room, a, 25);
  eq(room.pie.complete, true, 'pie complete');
  eq(room.nextDueAt, 0, 'no countdown');
  eq(room.canAutoDeal(), false, 'and it cannot arm');
});

test('holding stops the clock, and the hold is sticky across re-arms', () => {
  const { room } = seatedRoom(2);
  bankRound(room, room.seats[0].id, 30);
  assert(room.nextDueAt > 0, 'armed');
  room.holdNextSlice();
  eq(room.nextDueAt, 0, 'cleared');
  eq(room.held, true, 'held');
  room.armNextSlice();
  eq(room.nextDueAt, 0, 'a hold survives a re-arm — it is not a snooze');
});

test('dealing spends the hold and the clock', () => {
  const { room } = seatedRoom(2);
  bankRound(room, room.seats[0].id, 30);
  room.holdNextSlice();
  assert(room.startRound().ok, 'dealt');
  eq(room.nextDueAt, 0, 'clock cleared');
  eq(room.held, false, 'hold spent');
});

test('the countdown does not arm with no connected human at the table', () => {
  const { room } = seatedRoom(2);
  room.seats[0].connected = false; // the only human
  bankRound(room, room.seats[1].id, 30);
  eq(room.canAutoDeal(), false, 'cannot auto-deal into a room nobody is in');
  eq(room.nextDueAt, 0, 'not armed');
});

test('the clock is published so the client can render it without server ticks', () => {
  const { room } = seatedRoom(2);
  bankRound(room, room.seats[1].id, 30);
  const armed = room.nextDueAt;
  const match = readMatch(room, room.seats[0].id);
  eq(match.nextDueAt, armed, 'absolute epoch ms on the wire');
  eq(match.held, false, 'and the hold flag');
});

test('a finished pie publishes a null clock rather than a stale one', () => {
  const { room } = seatedRoom(1);
  for (let i = 0; i < 4; i++) bankRound(room, room.seats[0].id, 10);
  eq(readMatch(room, room.seats[0].id).nextDueAt, null, 'null, not 0 or stale');
});

// ---------------------------------------------------------------------------

if (failures.length) {
  for (const f of failures) {
    console.error(`\n  FAIL  ${f.name}\n        ${f.err && f.err.message}`);
  }
  console.error(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(1);
}
console.log(`\n${passed} passed, 0 failed\n`);
