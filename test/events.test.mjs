/**
 * Tests for public/js/events.js — the snapshot-delta event derivation.
 *
 * These deliberately do NOT use hand-written snapshot fixtures. A fixture only
 * proves the deriver agrees with my idea of the wire shape; driving the real
 * `server/game.js` and diffing the real `viewFor()` output proves it agrees
 * with the server. Every snapshot below came out of the actual rules engine,
 * seeded so the deal is identical on every run.
 *
 * Run: node test/events.test.mjs
 */

import { createRequire } from 'node:module';
import { deriveEvents, __test } from '../public/js/events.js';

const require = createRequire(import.meta.url);
const game = require('../server/game.js');

// ---------------------------------------------------------------------------
// Runner (same shape as test/rules.test.js)
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed++; } catch (err) { failures.push({ name, err }); }
}
function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}
function eq(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what || 'value'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------------
// Helpers: real engine in, client-shaped snapshots out
// ---------------------------------------------------------------------------

const SEATS = [
  { id: 'p1', name: 'Gent' },
  { id: 'p2', name: 'Carmela', isBot: true },
  { id: 'p3', name: 'Dominic', isBot: true },
];

/** A snapshot exactly as public/js/app.js receives it. */
function snapOf(state, youId = 'p1') {
  return {
    type: 'state',
    phase: state.status === 'roundOver' ? 'roundOver' : 'playing',
    youId,
    game: game.viewFor(state, youId),
  };
}

function newState(opts = {}) {
  return game.createGame(SEATS, { seed: opts.seed ?? 7, startIndex: opts.startIndex ?? 0 });
}

/** Forces a specific card into a player's hand so a rule can be exercised. */
function giveCard(state, playerId, suit, value) {
  const p = game.findPlayer(state, playerId);
  const card = { id: `forced-${playerId}-${value}-${p.hand.length}`, suit, value };
  p.hand.push(card);
  return card;
}

/** Makes `card` legal by aligning the active suit with it. */
function makeLegal(state, card) {
  state.activeSuit = card.suit;
  const top = game.topCard(state);
  if (top) top.suit = card.suit;
}

const types = (evs) => evs.map((e) => e.type);
const pick = (evs, t) => evs.find((e) => e.type === t);

// ---------------------------------------------------------------------------
// seatAfter — the primitive every action-card victim depends on
// ---------------------------------------------------------------------------

test('seatAfter walks forward, wraps, and follows direction', () => {
  const ps = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  eq(__test.seatAfter(ps, 'a', 1, 1), 'b', 'forward');
  eq(__test.seatAfter(ps, 'c', 1, 1), 'a', 'wrap forward');
  eq(__test.seatAfter(ps, 'a', -1, 1), 'c', 'backward wraps');
  eq(__test.seatAfter(ps, 'a', 1, 2), 'c', 'two steps');
});

test('seatAfter is null-safe on an unknown or empty seat list', () => {
  eq(__test.seatAfter([], 'a', 1, 1), null, 'empty');
  eq(__test.seatAfter([{ id: 'a' }], 'zz', 1, 1), null, 'unknown seat');
  eq(__test.seatAfter(null, 'a', 1, 1), null, 'null list');
});

// ---------------------------------------------------------------------------
// Phase transitions
// ---------------------------------------------------------------------------

test('a fresh round reports a deal and nothing else', () => {
  const state = newState();
  const evs = deriveEvents({ phase: 'lobby', youId: 'p1', game: null }, snapOf(state));
  eq(types(evs).join(','), 'deal', 'only a deal');
  eq(evs[0].handSize, game.HAND_SIZE, 'hand size');
  eq(evs[0].seats, 3, 'seat count');
});

test('no previous snapshot at all still yields a deal, not a crash', () => {
  const state = newState();
  const evs = deriveEvents(null, snapOf(state));
  eq(types(evs).join(','), 'deal');
});

test('an identical snapshot repainted produces no events', () => {
  const state = newState();
  const a = snapOf(state);
  const b = snapOf(state);
  eq(deriveEvents(a, b).length, 0, 'a repaint is not an event');
});

// ---------------------------------------------------------------------------
// Play and its consequences — driven through the real engine
// ---------------------------------------------------------------------------

test('playing a number card reports play + turn, and names the mover', () => {
  const state = newState();
  const mover = game.currentPlayer(state).id;
  const card = giveCard(state, mover, 'basil', '5');
  makeLegal(state, card);
  const before = snapOf(state);
  const r = game.playCard(state, mover, card.id);
  assert(r.ok, `play rejected: ${r.error}`);
  const evs = deriveEvents(before, snapOf(state));

  const play = pick(evs, 'play');
  assert(play, 'a play event');
  eq(play.playerId, mover, 'mover');
  eq(play.card.value, '5', 'card value');
  eq(play.isAction, false, 'a number is not an action');
  assert(pick(evs, 'turn'), 'the turn moved');
});

test('SKIP names the seat that was jumped — read from the pre-play order', () => {
  const state = newState();
  const mover = game.currentPlayer(state).id;
  const expectedVictim = __test.seatAfter(game.viewFor(state, 'p1').players, mover, state.direction, 1);
  const card = giveCard(state, mover, 'basil', 'SKIP');
  makeLegal(state, card);
  const before = snapOf(state);
  assert(game.playCard(state, mover, card.id).ok, 'SKIP played');
  const evs = deriveEvents(before, snapOf(state));

  const skip = pick(evs, 'skip');
  assert(skip, 'a skip event');
  eq(skip.victimId, expectedVictim, 'victim is the seat that lost its turn');
  assert(skip.victimId !== mover, 'the mover did not skip themselves');
});

test('PLUS2 names the victim and confirms the two cards actually landed', () => {
  const state = newState();
  const mover = game.currentPlayer(state).id;
  const expectedVictim = __test.seatAfter(game.viewFor(state, 'p1').players, mover, state.direction, 1);
  const countBefore = game.findPlayer(state, expectedVictim).hand.length;
  const card = giveCard(state, mover, 'basil', 'PLUS2');
  makeLegal(state, card);
  const before = snapOf(state);
  assert(game.playCard(state, mover, card.id).ok, 'PLUS2 played');
  const evs = deriveEvents(before, snapOf(state));

  const p2 = pick(evs, 'plus2');
  assert(p2, 'a plus2 event');
  eq(p2.victimId, expectedVictim, 'victim');
  eq(p2.byId, mover, 'attacker');
  eq(p2.cardsSeen, true, 'the +2 was observed in the delta');
  eq(game.findPlayer(state, expectedVictim).hand.length, countBefore + 2, 'engine really dealt 2');
});

test('a PLUS2 victim is NOT also reported as drawing — the growth is attributed once', () => {
  const state = newState();
  const mover = game.currentPlayer(state).id;
  const card = giveCard(state, mover, 'basil', 'PLUS2');
  makeLegal(state, card);
  const before = snapOf(state);
  game.playCard(state, mover, card.id);
  const evs = deriveEvents(before, snapOf(state));
  eq(evs.filter((e) => e.type === 'draw').length, 0, 'no phantom draw');
});

test('TWO PLAYERS: a REVERSE is reported as a skip, not a reversal', () => {
  // server/game.js:374-380 — at two seats REVERSE acts as a SKIP and never
  // touches `direction`. Reporting a reversal would announce a rule the server
  // did not apply, and would spin a direction sweep for nothing.
  const state = game.createGame([{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }], { seed: 9 });
  const mover = game.currentPlayer(state).id;
  const other = state.players.find((p) => p.id !== mover).id;
  const card = giveCard(state, mover, 'basil', 'REVERSE');
  makeLegal(state, card);
  const dirBefore = state.direction;
  const before = snapOf(state);
  assert(game.playCard(state, mover, card.id).ok, 'REVERSE played');
  eq(state.direction, dirBefore, 'the engine really did NOT flip direction');

  const evs = deriveEvents(before, snapOf(state));
  eq(pick(evs, 'reverse'), undefined, 'no reversal is announced');
  const skip = pick(evs, 'skip');
  assert(skip, 'it is reported as a skip instead');
  eq(skip.victimId, other, 'the other seat lost its turn');
  eq(skip.viaReverse, true, 'flagged as a reverse that acted as a skip');
});

test('THREE PLAYERS: a REVERSE really does reverse, and is reported as one', () => {
  const state = newState(); // three seats
  const mover = game.currentPlayer(state).id;
  const card = giveCard(state, mover, 'basil', 'REVERSE');
  makeLegal(state, card);
  const dirBefore = state.direction;
  const before = snapOf(state);
  assert(game.playCard(state, mover, card.id).ok, 'REVERSE played');
  eq(state.direction, -dirBefore, 'the engine flipped direction');

  const evs = deriveEvents(before, snapOf(state));
  const rev = pick(evs, 'reverse');
  assert(rev, 'a reverse event');
  eq(rev.direction, -dirBefore, 'new direction');
  eq(pick(evs, 'skip'), undefined, 'and it is not also a skip');
});

test('WILD reports the chosen suit', () => {
  const state = newState();
  const mover = game.currentPlayer(state).id;
  const card = giveCard(state, mover, null, 'WILD');
  const before = snapOf(state);
  assert(game.playCard(state, mover, card.id, 'anchovy').ok, 'WILD played');
  const evs = deriveEvents(before, snapOf(state));

  const wild = pick(evs, 'wild');
  assert(wild, 'a wild event');
  eq(wild.suit, 'anchovy', 'chosen suit');
});

// ---------------------------------------------------------------------------
// Draws, TONDO, callouts
// ---------------------------------------------------------------------------

test('a voluntary draw is reported as a draw of one', () => {
  const state = newState();
  const mover = game.currentPlayer(state).id;
  const before = snapOf(state);
  assert(game.drawCard(state, mover).ok, 'draw accepted');
  const evs = deriveEvents(before, snapOf(state));

  const draw = pick(evs, 'draw');
  assert(draw, 'a draw event');
  eq(draw.playerId, mover, 'drawer');
  eq(draw.count, 1, 'exactly one card');
  eq(pick(evs, 'plus2'), undefined, 'not mistaken for a penalty');
});

test('declaring TONDO is reported once, on the declaring seat', () => {
  const state = newState();
  const p = game.findPlayer(state, 'p1');
  p.hand = p.hand.slice(0, 2); // down to two cards, the declarable count
  const before = snapOf(state);
  assert(game.declareTondo(state, 'p1').ok, 'declare accepted');
  const after = snapOf(state);
  const evs = deriveEvents(before, after);

  const t = pick(evs, 'tondo');
  assert(t, 'a tondo event');
  eq(t.playerId, 'p1', 'declarer');
  eq(t.byYou, true, 'it was you');
  eq(deriveEvents(after, snapOf(state)).length, 0, 'and it does not repeat on the next repaint');
});

test('a callout is told apart from a +2: same growth, no card on the pile', () => {
  const state = newState();
  // p2 reaches one card without declaring, which is what makes them callable.
  const victim = game.findPlayer(state, 'p2');
  victim.hand = victim.hand.slice(0, 1);
  victim.declaredTondo = false;
  victim.vulnerable = true;
  const before = snapOf(state);
  const r = game.callOut(state, 'p1', 'p2');
  assert(r.ok, `callout rejected: ${r.error}`);
  const evs = deriveEvents(before, snapOf(state));

  const c = pick(evs, 'callout');
  assert(c, 'a callout event');
  eq(c.targetId, 'p2', 'target');
  eq(pick(evs, 'plus2'), undefined, 'not reported as a +2');
  eq(evs.filter((e) => e.type === 'draw').length, 0, 'not reported as a draw');
});

// ---------------------------------------------------------------------------
// Round end
// ---------------------------------------------------------------------------

test('emptying a hand reports a win naming the winner', () => {
  const state = newState();
  const mover = game.currentPlayer(state).id;
  const card = giveCard(state, mover, 'basil', '3');
  makeLegal(state, card);
  game.findPlayer(state, mover).hand = [card]; // one card left: this play wins
  const before = snapOf(state);
  assert(game.playCard(state, mover, card.id).ok, 'winning card played');
  const after = snapOf(state);
  eq(after.phase, 'roundOver', 'engine ended the round');

  const evs = deriveEvents(before, after);
  const win = pick(evs, 'win');
  assert(win, 'a win event');
  eq(win.playerId, mover, 'winner');
  eq(evs.length, 1, 'a win is reported alone, not buried under play/turn');
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

test('a lobby snapshot with no game produces no events and does not throw', () => {
  eq(deriveEvents({ phase: 'lobby', youId: 'p1', game: null }, { phase: 'lobby', youId: 'p1', game: null }).length, 0);
});

test('a full seeded round derives events on every step without throwing', () => {
  // The real end-to-end shape: play a whole round the way a table would, and
  // assert the deriver survives every transition the engine can produce.
  const state = newState({ seed: 42 });
  let prev = snapOf(state);
  let steps = 0;
  const seen = new Set();
  while (state.status === 'playing' && steps < 400) {
    const me = game.currentPlayer(state);
    if (!me) break;
    const playable = game.playableCardIds(state, me.id);
    if (playable.length) {
      const card = me.hand.find((c) => c.id === playable[0]);
      game.playCard(state, me.id, playable[0], card && card.value === 'WILD' ? 'basil' : undefined);
    } else {
      game.drawCard(state, me.id);
      if (state.drawnCard && state.drawnCard.playerId === me.id) game.passTurn(state, me.id);
    }
    const next = snapOf(state);
    for (const e of deriveEvents(prev, next)) seen.add(e.type);
    prev = next;
    steps++;
  }
  assert(steps > 5, `the round should take more than a few steps, took ${steps}`);
  assert(seen.has('play'), 'saw plays');
  assert(seen.has('turn'), 'saw turn changes');
  assert(state.status === 'roundOver', `round finished (status ${state.status} after ${steps} steps)`);
  assert(seen.has('win'), `saw the win (types seen: ${[...seen].join(',')})`);
});

test('a callout names its caller, read from the real engine\'s log line', () => {
  const state = newState();
  const victim = game.findPlayer(state, 'p2');
  victim.hand = victim.hand.slice(0, 1);
  victim.declaredTondo = false;
  victim.vulnerable = true;
  const before = snapOf(state);
  assert(game.callOut(state, 'p3', 'p2').ok, 'Dominic calls out Carmela');
  const evs = deriveEvents(before, snapOf(state));
  const c = pick(evs, 'callout');
  assert(c, 'a callout event');
  eq(c.targetId, 'p2', 'target');
  eq(c.callerId, 'p3', 'caller parsed from the log');
});

test('a callout whose log line cannot be matched reports a null caller, not a wrong one', () => {
  const state = newState();
  const victim = game.findPlayer(state, 'p2');
  victim.hand = victim.hand.slice(0, 1);
  victim.vulnerable = true;
  const before = snapOf(state);
  game.callOut(state, 'p3', 'p2');
  const after = snapOf(state);
  after.game.log = after.game.log.slice(0, -1).concat(['SOMETHING ELSE ENTIRELY']);
  const c = pick(deriveEvents(before, after), 'callout');
  eq(c.callerId, null, 'no guess');
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
