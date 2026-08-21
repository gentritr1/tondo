'use strict';

/**
 * Room lifecycle tests: seating, reconnect, host succession and the clocks.
 * These pin the fixes for bugs found in the 2026-08 review — each test names
 * the failure it guards against. Runner matches rules.test.js.
 */

const game = require('../server/game');
const { RoomManager, EMPTY_ROOM_TTL_MS, AWAY_TURN_MS } = require('../server/rooms');

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push({ name, err });
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}

function eq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Just enough socket for the rooms layer: readyState 1 and a send sink. */
function fakeSocket() {
  return {
    readyState: 1,
    sent: [],
    terminated: false,
    send(data) { this.sent.push(JSON.parse(data)); },
    terminate() { this.terminated = true; this.readyState = 3; },
    close() { this.readyState = 3; },
  };
}

/** A manager whose interval is stopped immediately; ticks are driven by hand. */
function makeManager() {
  const manager = new RoomManager();
  manager.stop();
  return manager;
}

/** Create a room with `humans` named players and start the round. */
function playingRoom(manager, humans) {
  const sockets = [];
  const first = fakeSocket();
  sockets.push(first);
  const created = manager.createRoom(humans[0], first);
  const room = created.room;
  const seats = [created.seat];
  for (let i = 1; i < humans.length; i++) {
    const s = fakeSocket();
    sockets.push(s);
    seats.push(manager.joinRoom(room.code, humans[i], s).seat);
  }
  const started = room.startRound();
  assert(started.ok, 'round should start');
  return { room, seats, sockets };
}

// ---------------------------------------------------------------------------
// Empty-room TTL (review finding: leaveRoom leaked rooms forever)
// ---------------------------------------------------------------------------

test('a room whose last human left while the other was disconnected is GC-ed by the tick', () => {
  const manager = makeManager();
  const { room, seats, sockets } = playingRoom(manager, ['Ana', 'Bob']);
  // Bob's socket dies mid-game: seat stays, connected=false.
  manager.handleDisconnect(room, seats[1], sockets[1]);
  // Ana leaves explicitly (the old leak: emptySince was never armed here).
  room.removeSeat(seats[0].id);
  manager.cleanupIfEmpty(room);
  assert(manager.rooms.has(room.code), 'room still has a human seat on paper');

  const now = Date.now();
  manager.tickRoom(room, now); // arms the TTL from observed state
  manager.tickRoom(room, now + EMPTY_ROOM_TTL_MS + 1000);
  eq(manager.rooms.has(room.code), false, 'room must be collected after the TTL');
});

test('a reconnect during the TTL countdown disarms it', () => {
  const manager = makeManager();
  const { room, seats, sockets } = playingRoom(manager, ['Ana', 'Bob']);
  manager.handleDisconnect(room, seats[0], sockets[0]);
  manager.handleDisconnect(room, seats[1], sockets[1]);
  const now = Date.now();
  manager.tickRoom(room, now);
  assert(room.emptySince > 0, 'TTL armed while nobody is connected');
  manager.joinRoom(room.code, 'Ana', fakeSocket(), seats[0].token);
  manager.tickRoom(room, now + 1000);
  eq(room.emptySince, 0, 'TTL disarmed by the reconnect');
  assert(manager.rooms.has(room.code), 'room survives');
});

// ---------------------------------------------------------------------------
// Seat takeover (review finding: a half-open socket destroyed the seat token)
// ---------------------------------------------------------------------------

test('a correct token reclaims the seat even while the old socket still looks alive', () => {
  const manager = makeManager();
  const { room, seats, sockets } = playingRoom(manager, ['Ana', 'Bob']);
  const fresh = fakeSocket();
  const result = manager.joinRoom(room.code, 'Ana', fresh, seats[0].token);
  assert(result.ok, `takeover must succeed, got: ${result.error}`);
  eq(result.reconnected, true, 'flagged as a reconnect');
  eq(result.seat.id, seats[0].id, 'same seat');
  eq(result.seat.socket, fresh, 'new socket holds the seat');
  eq(sockets[0].terminated, true, 'ghost socket terminated');
});

test('the ghost socket closing after a takeover cannot vacate the new owner', () => {
  const manager = makeManager();
  const { room, seats, sockets } = playingRoom(manager, ['Ana', 'Bob']);
  const fresh = fakeSocket();
  manager.joinRoom(room.code, 'Ana', fresh, seats[0].token);
  // The ghost's close event finally arrives, carrying the OLD socket.
  manager.handleDisconnect(room, seats[0], sockets[0]);
  eq(seats[0].connected, true, 'seat must stay connected to the new socket');
  eq(seats[0].socket, fresh, 'new socket untouched');
});

test('a wrong token cannot take over a connected seat', () => {
  const manager = makeManager();
  const { room } = playingRoom(manager, ['Ana', 'Bob']);
  const result = manager.joinRoom(room.code, 'Eve', fakeSocket(), 'not-a-token');
  eq(result.ok, false, 'refused');
});

// ---------------------------------------------------------------------------
// Host succession (review finding: a vanished host froze the table)
// ---------------------------------------------------------------------------

test('while the host is disconnected, another seated human holds host powers', () => {
  const manager = makeManager();
  const { room, seats, sockets } = playingRoom(manager, ['Ana', 'Bob']);
  eq(room.isActingHost(seats[1].id), false, 'Bob is not host while Ana is here');
  manager.handleDisconnect(room, seats[0], sockets[0]);
  eq(room.isActingHost(seats[1].id), true, 'Bob acts as host while Ana is away');
  eq(room.snapshotFor(seats[1].id).isHost, true, 'snapshot shows the acting host');
  manager.joinRoom(room.code, 'Ana', fakeSocket(), seats[0].token);
  eq(room.isActingHost(seats[1].id), false, 'powers snap back on reconnect');
  eq(room.hostId, seats[0].id, 'the title never moved');
});

// ---------------------------------------------------------------------------
// roundOver is not a dead end (review finding: 2-player table stuck forever)
// ---------------------------------------------------------------------------

test('a new player can take the empty seat between rounds', () => {
  const manager = makeManager();
  const { room, seats } = playingRoom(manager, ['Ana', 'Bob']);
  room.removeSeat(seats[1].id); // Bob leaves mid-round → round over, 1 seat
  eq(room.phase, 'roundOver', 'round ended when the table dropped to one');
  const joined = manager.joinRoom(room.code, 'Cleo', fakeSocket());
  assert(joined.ok, `joining between rounds must work, got: ${joined.error}`);
  const started = room.startRound();
  assert(started.ok, 'the next round can be dealt');
});

// ---------------------------------------------------------------------------
// Clocks (review finding: unrelated disconnects rewound the away clock)
// ---------------------------------------------------------------------------

test('an unrelated disconnect does not rewind the away turn clock', () => {
  const manager = makeManager();
  const { room, seats, sockets } = playingRoom(manager, ['Ana', 'Bob', 'Cleo']);
  const current = game.currentPlayer(room.game);
  const currentSeat = room.findSeat(current.id);
  const currentSocket = sockets[seats.indexOf(currentSeat)];
  manager.handleDisconnect(room, currentSeat, currentSocket);
  const deadline = room.awayDueAt;
  assert(deadline > 0, 'away clock armed for the absent current player');
  // Another player's socket blips ~everything else staying the same.
  const other = seats.find((s) => s !== currentSeat);
  const otherSocket = sockets[seats.indexOf(other)];
  manager.handleDisconnect(room, other, otherSocket);
  eq(room.awayDueAt, deadline, 'deadline must not move');
  assert(room.awayDueAt - Date.now() <= AWAY_TURN_MS, 'and never exceeds the full window');
});

// ---------------------------------------------------------------------------
// Rotation + view invariants
// ---------------------------------------------------------------------------

test('the opening seat rotates from round to round', () => {
  const manager = makeManager();
  const { room } = playingRoom(manager, ['Ana', 'Bob']);
  const first = game.currentPlayer(room.game).id;
  room.phase = 'roundOver';
  room.startRound();
  const second = game.currentPlayer(room.game).id;
  assert(first !== second, 'a different player opens the next round');
});

test('a finished round names no turn player and keeps the winner visible', () => {
  const seats = [{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Bob' }];
  const state = game.createGame(seats, { seed: 7 });
  const winner = game.currentPlayer(state);
  winner.hand = [state.drawPile.pop()];
  // Force a legal play of that last card.
  state.activeSuit = winner.hand[0].suit || state.activeSuit;
  if (game.isWild(winner.hand[0])) {
    game.playCard(state, winner.id, winner.hand[0].id, 'basil');
  } else {
    state.discardPile.push({ id: 'x', suit: winner.hand[0].suit, value: winner.hand[0].value });
    state.activeSuit = winner.hand[0].suit;
    game.playCard(state, winner.id, winner.hand[0].id);
  }
  eq(state.status, 'roundOver', 'round is over');
  const view = game.viewFor(state, 'b');
  eq(view.turnPlayerId, null, 'no turn player after the round');
  assert(view.players.some((p) => p.id === view.winnerId), 'winner is in players');
  game.removePlayer(state, winner.id);
  const after = game.viewFor(state, 'b');
  assert(after.players.some((p) => p.id === after.winnerId),
    'winner stays visible even after leaving');
});

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const failure of failures) {
  console.error(`\nFAIL ${failure.name}`);
  console.error(failure.err && failure.err.stack ? failure.err.stack : failure.err);
}
if (failures.length > 0) process.exit(1);
