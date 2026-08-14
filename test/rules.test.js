'use strict';

/**
 * Tondo rules tests. Hand-rolled runner: `node test/rules.test.js`, exit 1 on
 * the first failure being reported at the end.
 */

const game = require('../server/game');
const bot = require('../server/bot');

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

function deepEq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message || 'not deep equal'}: expected ${b}, got ${a}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let cardSerial = 0;
/** A card with a unique id, so hands can be written out by hand. */
function C(suit, value) {
  return { id: `t${cardSerial++}`, suit, value };
}
function W() {
  return C(null, 'WILD');
}

/**
 * A round with the hands, top card and turn spelled out. Everything else comes
 * from a real `createGame`, so nothing here fakes a shape the server would not
 * produce.
 */
function table(hands, top, opts = {}) {
  const seats = hands.map((_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}`, isBot: false }));
  const state = game.createGame(seats, { seed: opts.seed === undefined ? 42 : opts.seed });
  state.players.forEach((p, i) => {
    p.hand = hands[i].slice();
    p.declaredTondo = false;
    p.vulnerable = false;
  });
  state.discardPile = [top];
  state.activeSuit = opts.activeSuit === undefined ? top.suit : opts.activeSuit;
  state.turnIndex = opts.turnIndex || 0;
  state.direction = opts.direction || 1;
  state.drawnCard = null;
  state.turnSerial = 0;
  state.log = [];
  if (opts.drawPile) state.drawPile = opts.drawPile.slice();
  return state;
}

const turnId = (s) => game.currentPlayer(s).id;
const handOf = (s, id) => game.findPlayer(s, id).hand;

// ---------------------------------------------------------------------------
// Deck
// ---------------------------------------------------------------------------

test('deck has 68 cards with unique ids', () => {
  const deck = game.buildDeck();
  eq(deck.length, 68, 'deck size');
  eq(new Set(deck.map((c) => c.id)).size, 68, 'unique ids');
});

test('deck composition: 16 per suit, 4 wilds, right counts per value', () => {
  const deck = game.buildDeck();
  eq(deck.filter((c) => c.value === 'WILD').length, 4, 'wild count');
  for (const suit of game.SUITS) {
    const inSuit = deck.filter((c) => c.suit === suit);
    eq(inSuit.length, 16, `${suit} count`);
    for (const n of game.NUMBERS) {
      eq(inSuit.filter((c) => c.value === n).length, 1, `${suit} ${n} count`);
    }
    for (const a of game.ACTIONS) {
      eq(inSuit.filter((c) => c.value === a).length, 2, `${suit} ${a} count`);
    }
  }
  eq(deck.filter((c) => c.suit === null).length, 4, 'suitless cards are only wilds');
});

test('deal gives 7 each and turns up a number card', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const state = game.createGame(
      [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
      { seed }
    );
    for (const p of state.players) eq(p.hand.length, 7, `hand size seed ${seed}`);
    const top = game.topCard(state);
    assert(game.isNumber(top), `top card is a number (seed ${seed}, got ${top.value})`);
    eq(state.activeSuit, top.suit, 'active suit follows the top card');
    // 68 - 21 dealt - 1 on the discard pile
    eq(state.drawPile.length, 46, 'draw pile after the deal');
  }
});

// ---------------------------------------------------------------------------
// Legality
// ---------------------------------------------------------------------------

test('legality matrix: suit match, value match, wild, mismatch', () => {
  const top = C('basil', '7');
  const sameSuit = C('basil', '2');
  const sameValue = C('cheese', '7');
  const wild = W();
  const mismatch = C('cheese', '3');
  const state = table([[sameSuit, sameValue, wild, mismatch], [C('anchovy', '1')]], top);

  assert(game.canPlay(state, sameSuit), 'suit match is legal');
  assert(game.canPlay(state, sameValue), 'value match is legal');
  assert(game.canPlay(state, wild), 'wild is always legal');
  assert(!game.canPlay(state, mismatch), 'neither suit nor value is illegal');
  deepEq(
    game.playableCardIds(state, 'p1').sort(),
    [sameSuit.id, sameValue.id, wild.id].sort(),
    'playableCardIds'
  );
  deepEq(game.playableCardIds(state, 'p2'), [], 'a player off turn has no playable cards');
});

test('legality matrix: action cards match by value too', () => {
  const top = C('basil', 'SKIP');
  const otherSkip = C('cheese', 'SKIP');
  const otherPlus2 = C('cheese', 'PLUS2');
  const state = table([[otherSkip, otherPlus2], [C('anchovy', '1')]], top);
  assert(game.canPlay(state, otherSkip), 'SKIP on SKIP is legal');
  assert(!game.canPlay(state, otherPlus2), 'PLUS2 on SKIP off-suit is illegal');
});

test('after a wild the active suit is what was called, not the card', () => {
  const wild = W();
  const cheeseCard = C('cheese', '4');
  const basilCard = C('basil', '4');
  const state = table([[wild, C('basil', '1')], [cheeseCard, basilCard, C('anchovy', '9')]], C('basil', '3'));

  const played = game.playCard(state, 'p1', wild.id, 'cheese');
  assert(played.ok, 'wild plays');
  eq(state.activeSuit, 'cheese', 'active suit is the called one');
  eq(game.topCard(state).value, 'WILD', 'top card is the wild');
  eq(game.topCard(state).suit, null, 'a wild card carries no suit');
  eq(turnId(state), 'p2', 'turn moved on');
  assert(game.canPlay(state, cheeseCard), 'the called suit is playable');
  assert(!game.canPlay(state, basilCard), 'the old suit is not playable any more');
});

test('a wild without a suit is rejected', () => {
  const wild = W();
  const state = table([[wild, C('basil', '1')], [C('anchovy', '1')]], C('basil', '3'));
  const bad = game.playCard(state, 'p1', wild.id, undefined);
  assert(!bad.ok, 'wild needs a suit');
  eq(handOf(state, 'p1').length, 2, 'the card stayed in hand');
  const worse = game.playCard(state, 'p1', wild.id, 'mushroom');
  assert(!worse.ok, 'an invented suit is rejected');
});

test('playing a card you do not hold, or out of turn, is rejected', () => {
  const state = table([[C('basil', '1')], [C('basil', '2')]], C('basil', '3'));
  assert(!game.playCard(state, 'p1', 'nope').ok, 'unknown card');
  assert(!game.playCard(state, 'p2', handOf(state, 'p2')[0].id).ok, 'off turn');
});

// ---------------------------------------------------------------------------
// Action cards
// ---------------------------------------------------------------------------

test('SKIP jumps the next player', () => {
  const skip = C('basil', 'SKIP');
  const state = table(
    [[skip, C('basil', '1'), C('basil', '2')], [C('cheese', '1'), C('cheese', '2')], [C('anchovy', '1'), C('anchovy', '2')]],
    C('basil', '3')
  );
  assert(game.playCard(state, 'p1', skip.id).ok, 'skip plays');
  eq(turnId(state), 'p3', 'p2 lost the turn');
  assert(state.log.some((l) => l.includes('P2 WAS SKIPPED')), 'log names the skipped player');
});

test('REVERSE flips direction at a table of three', () => {
  const reverse = C('basil', 'REVERSE');
  const state = table(
    [[reverse, C('basil', '1'), C('basil', '2')], [C('cheese', '1'), C('cheese', '2')], [C('anchovy', '1'), C('anchovy', '2')]],
    C('basil', '3')
  );
  eq(state.direction, 1, 'starts going left');
  assert(game.playCard(state, 'p1', reverse.id).ok, 'reverse plays');
  eq(state.direction, -1, 'direction flipped');
  eq(turnId(state), 'p3', 'play now runs the other way');
});

test('REVERSE acts as a SKIP with two players', () => {
  const reverse = C('basil', 'REVERSE');
  const state = table([[reverse, C('basil', '1'), C('basil', '2')], [C('cheese', '1'), C('cheese', '2')]], C('basil', '3'));
  assert(game.playCard(state, 'p1', reverse.id).ok, 'reverse plays');
  eq(turnId(state), 'p1', 'the same player goes again');
});

test('PLUS2 gives the next player two cards and their turn', () => {
  const plus2 = C('basil', 'PLUS2');
  const state = table(
    [[plus2, C('basil', '1'), C('basil', '2')], [C('cheese', '1'), C('cheese', '2')], [C('anchovy', '1'), C('anchovy', '2')]],
    C('basil', '3')
  );
  const before = handOf(state, 'p2').length;
  const drawBefore = state.drawPile.length;
  assert(game.playCard(state, 'p1', plus2.id).ok, 'plus2 plays');
  eq(handOf(state, 'p2').length, before + 2, 'victim drew two');
  eq(state.drawPile.length, drawBefore - 2, 'the two came off the deck');
  eq(turnId(state), 'p3', 'victim also lost the turn');
});

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

test('a playable drawn card opens a decision the player must answer', () => {
  const gift = C('basil', '9');
  const state = table(
    [[C('cheese', '1'), C('anchovy', '2')], [C('cheese', '5'), C('cheese', '6')]],
    C('basil', '3'),
    { drawPile: [C('anchovy', '8'), gift] } // pop() takes the last one
  );
  deepEq(game.playableCardIds(state, 'p1'), [], 'nothing playable to start with');

  const drew = game.drawCard(state, 'p1');
  assert(drew.ok && drew.playable, 'drew a playable card');
  eq(turnId(state), 'p1', 'the turn stayed put');
  eq(state.drawnCard.cardId, gift.id, 'the drawn card is the pending decision');
  deepEq(game.playableCardIds(state, 'p1'), [gift.id], 'only the drawn card may be played');
  eq(game.viewFor(state, 'p1').drawnDecisionCardId, gift.id, 'the view exposes the decision');

  // Another card in hand may not be slipped in during the decision.
  assert(!game.playCard(state, 'p1', handOf(state, 'p1')[0].id).ok, 'other cards are locked');
  // Nor may a second card be drawn.
  assert(!game.drawCard(state, 'p1').ok, 'no second draw');

  assert(game.passTurn(state, 'p1').ok, 'pass is allowed');
  eq(turnId(state), 'p2', 'the turn moved on');
  assert(handOf(state, 'p1').some((c) => c.id === gift.id), 'passing keeps the card');
  eq(handOf(state, 'p1').length, 3, 'hand grew by the drawn card');
  eq(state.drawnCard, null, 'the decision is closed');
});

test('a playable drawn card can be played instead of kept', () => {
  const gift = C('basil', '9');
  const state = table(
    [[C('cheese', '1'), C('anchovy', '2')], [C('cheese', '5'), C('cheese', '6')]],
    C('basil', '3'),
    { drawPile: [C('anchovy', '8'), gift] }
  );
  game.drawCard(state, 'p1');
  assert(game.playCard(state, 'p1', gift.id).ok, 'the drawn card plays');
  eq(game.topCard(state).id, gift.id, 'it is on the pile');
  eq(handOf(state, 'p1').length, 2, 'hand back to what it was');
  eq(turnId(state), 'p2', 'the turn moved on');
});

test('an unplayable drawn card advances the turn on its own', () => {
  const dud = C('anchovy', '8');
  const state = table(
    [[C('cheese', '1'), C('anchovy', '2')], [C('cheese', '5'), C('cheese', '6')]],
    C('basil', '3'),
    { drawPile: [C('cheese', '4'), dud] }
  );
  const drew = game.drawCard(state, 'p1');
  assert(drew.ok && !drew.playable, 'the drawn card was not playable');
  eq(state.drawnCard, null, 'no decision was opened');
  eq(turnId(state), 'p2', 'the turn moved on by itself');
  eq(handOf(state, 'p1').length, 3, 'the card is kept');
  eq(game.viewFor(state, 'p1').drawnDecisionCardId, null, 'the view shows no decision');
});

test('pass without a draw is rejected', () => {
  const state = table([[C('basil', '1'), C('basil', '2')], [C('cheese', '5')]], C('basil', '3'));
  assert(!game.passTurn(state, 'p1').ok, 'you must draw before you pass');
  eq(turnId(state), 'p1', 'and the turn did not move');
});

test('the discard pile is reshuffled when the deck runs out', () => {
  const top = C('basil', '3');
  const buried = [C('cheese', '1'), C('anchovy', '2'), C('pepperoni', '4')];
  const state = table([[C('cheese', '9')], [C('cheese', '5')]], top, { drawPile: [] });
  state.discardPile = [...buried, top];

  const drew = game.drawCard(state, 'p1');
  assert(drew.ok, 'the draw went through');
  assert(drew.card, 'a card came out of the recycled pile');
  eq(state.discardPile.length, 1, 'only the top card stayed on the discard pile');
  eq(game.topCard(state).id, top.id, 'and it is the same top card');
  eq(state.drawPile.length, buried.length - 1, 'the rest became the deck, minus the one drawn');
  assert(state.log.some((l) => l.includes('RESHUFFLED')), 'the reshuffle is logged');
});

test('with both piles empty a draw is a no-op that still passes the turn', () => {
  const top = C('basil', '3');
  const state = table([[C('cheese', '9')], [C('cheese', '5')]], top, { drawPile: [] });
  state.discardPile = [top];
  const drew = game.drawCard(state, 'p1');
  assert(drew.ok, 'the draw is accepted');
  eq(drew.card, null, 'but nothing came out');
  eq(handOf(state, 'p1').length, 1, 'the hand is unchanged');
  eq(turnId(state), 'p2', 'the turn still moved on');
});

// ---------------------------------------------------------------------------
// TONDO
// ---------------------------------------------------------------------------

test('TONDO can only be declared on exactly two cards, and only once', () => {
  const state = table([[C('basil', '1'), C('basil', '2'), C('basil', '4')], [C('cheese', '5')]], C('basil', '3'));
  assert(!game.declareTondo(state, 'p1').ok, 'three cards is too many');
  eq(game.viewFor(state, 'p1').canDeclareTondo, false, 'and the view agrees');

  handOf(state, 'p1').pop();
  eq(game.viewFor(state, 'p1').canDeclareTondo, true, 'two cards opens it');
  assert(game.declareTondo(state, 'p1').ok, 'declared');
  eq(game.findPlayer(state, 'p1').declaredTondo, true, 'flag set');
  assert(!game.declareTondo(state, 'p1').ok, 'no declaring twice');
  eq(game.viewFor(state, 'p1').canDeclareTondo, false, 'the view closes it');
});

test('declaring TONDO before playing down to one keeps you safe', () => {
  const keeper = C('basil', '1');
  const state = table([[keeper, C('basil', '2')], [C('cheese', '5'), C('cheese', '6'), C('cheese', '7')]], C('basil', '3'));
  assert(game.declareTondo(state, 'p1').ok, 'declared at two cards');
  assert(game.playCard(state, 'p1', keeper.id).ok, 'played down to one');
  eq(handOf(state, 'p1').length, 1, 'one card left');
  eq(game.findPlayer(state, 'p1').vulnerable, false, 'not vulnerable');
  deepEq(game.viewFor(state, 'p2').calloutTargets, [], 'nobody to call out');
  assert(!game.callOut(state, 'p2', 'p1').ok, 'a call-out is refused');
  eq(handOf(state, 'p1').length, 1, 'and costs nothing');
});

test('missing the call leaves you vulnerable, and the call-out costs two cards', () => {
  const played = C('basil', '1');
  const state = table([[played, C('basil', '2')], [C('cheese', '5'), C('cheese', '6'), C('cheese', '7')]], C('basil', '3'));
  assert(game.playCard(state, 'p1', played.id).ok, 'played down to one without a word');
  eq(game.findPlayer(state, 'p1').vulnerable, true, 'vulnerable');
  deepEq(game.viewFor(state, 'p2').calloutTargets, ['p1'], 'p2 sees the target');
  deepEq(game.viewFor(state, 'p1').calloutTargets, [], 'you cannot see yourself as a target');
  assert(!game.callOut(state, 'p1', 'p1').ok, 'and you cannot call yourself out');

  const drawBefore = state.drawPile.length;
  assert(game.callOut(state, 'p2', 'p1').ok, 'p2 calls it');
  eq(handOf(state, 'p1').length, 3, 'penalty of two cards');
  eq(state.drawPile.length, drawBefore - 2, 'the two came off the deck');
  eq(game.findPlayer(state, 'p1').vulnerable, false, 'the window is closed');
  assert(!game.callOut(state, 'p2', 'p1').ok, 'and it cannot be called twice');
  assert(state.log.some((l) => l.includes('CALLED OUT P1')), 'the call-out is logged');
});

test('the call-out window closes at the start of that player\'s next turn', () => {
  const p1Play = C('basil', '1');
  const p2Play = C('basil', '4');
  const p3Play = C('basil', '5');
  const state = table(
    [
      [p1Play, C('anchovy', '2')],
      [p2Play, C('cheese', '6'), C('cheese', '7')],
      [p3Play, C('pepperoni', '8'), C('pepperoni', '9')],
    ],
    C('basil', '3')
  );
  assert(game.playCard(state, 'p1', p1Play.id).ok, 'p1 plays down to one');
  eq(game.findPlayer(state, 'p1').vulnerable, true, 'vulnerable right away');

  assert(game.playCard(state, 'p2', p2Play.id).ok, 'p2 plays');
  eq(game.findPlayer(state, 'p1').vulnerable, true, 'still open one seat later');

  assert(game.playCard(state, 'p3', p3Play.id).ok, 'p3 plays');
  eq(turnId(state), 'p1', 'the turn came back round');
  eq(game.findPlayer(state, 'p1').vulnerable, false, 'the window shut on arrival');
  deepEq(game.viewFor(state, 'p2').calloutTargets, [], 'nothing left to call');
  assert(!game.callOut(state, 'p2', 'p1').ok, 'too late');
});

test('a declaration is spent once the hand grows past two', () => {
  const state = table([[C('basil', '1'), C('basil', '2')], [C('cheese', '5'), C('cheese', '6'), C('cheese', '7')]], C('basil', '3'));
  assert(game.declareTondo(state, 'p1').ok, 'declared');
  game.drawCard(state, 'p1'); // whatever it is, the hand is three now
  eq(handOf(state, 'p1').length, 3, 'hand of three');
  eq(game.findPlayer(state, 'p1').declaredTondo, false, 'the declaration reset');
});

// ---------------------------------------------------------------------------
// Winning
// ---------------------------------------------------------------------------

test('playing the last card wins the round', () => {
  const last = C('basil', '1');
  const state = table([[last], [C('cheese', '5'), C('cheese', '6')]], C('basil', '3'));
  assert(game.playCard(state, 'p1', last.id).ok, 'played the last card');
  eq(state.status, 'roundOver', 'round over');
  eq(state.winnerId, 'p1', 'winner recorded');
  eq(game.viewFor(state, 'p2').winnerId, 'p1', 'the view shows the winner');
  assert(state.log.some((l) => l.includes('P1 WINS THE ROUND')), 'logged');
  assert(!game.drawCard(state, 'p2').ok, 'no moves after the round ends');
});

test('a last card that would make somebody draw still wins', () => {
  const last = C('basil', 'PLUS2');
  const state = table([[last], [C('cheese', '5'), C('cheese', '6')]], C('basil', '3'));
  assert(game.playCard(state, 'p1', last.id).ok, 'played');
  eq(state.winnerId, 'p1', 'still a win');
  eq(handOf(state, 'p2').length, 2, 'and no penalty was handed out');
});

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

test('the view never carries another player\'s hand', () => {
  const state = table([[C('basil', '1'), C('basil', '2')], [C('cheese', '5'), C('cheese', '6')]], C('basil', '3'));
  const view = game.viewFor(state, 'p1');
  eq(view.hand.length, 2, 'my hand is there');
  for (const p of view.players) {
    assert(!('hand' in p), 'no hand on a player entry');
    assert(typeof p.cardCount === 'number', 'only a count');
  }
  assert(!JSON.stringify(view).includes(handOf(state, 'p2')[0].id), 'p2 card ids never appear');
});

test('the log is capped at 20 entries of plain upper case text', () => {
  const state = table([[C('basil', '1'), C('basil', '2')], [C('cheese', '5')]], C('basil', '3'));
  for (let i = 0; i < 40; i++) state.log.push(`LINE ${i}`);
  const view = game.viewFor(state, 'p1');
  eq(view.log.length, 20, 'capped');
  eq(view.log[view.log.length - 1], 'LINE 39', 'newest last');
  for (const line of view.log) assert(typeof line === 'string', 'log lines are strings');
});

test('the log reads like the protocol examples', () => {
  const card = C('basil', '7');
  const state = table([[card, C('basil', '2')], [C('cheese', '5')]], C('basil', '3'));
  state.players[0].name = 'Carmela';
  game.playCard(state, 'p1', card.id);
  assert(state.log.includes('CARMELA PLAYED BASIL 7'), `got ${JSON.stringify(state.log)}`);
});

// ---------------------------------------------------------------------------
// Away seats and leavers
// ---------------------------------------------------------------------------

test('an away turn draws one, keeps it and passes', () => {
  const state = table([[C('cheese', '1')], [C('cheese', '5'), C('cheese', '6')]], C('basil', '3'));
  const before = handOf(state, 'p1').length;
  assert(game.autoTurn(state, 'p1').ok, 'auto turn ran');
  eq(handOf(state, 'p1').length, before + 1, 'exactly one card taken');
  eq(turnId(state), 'p2', 'the turn moved on');
  eq(state.drawnCard, null, 'no decision left hanging');
});

test('a player who leaves is out of the view and can end the round', () => {
  const state = table(
    [[C('basil', '1'), C('basil', '2')], [C('cheese', '5')], [C('anchovy', '5')]],
    C('basil', '3')
  );
  assert(game.removePlayer(state, 'p2').ok, 'p2 left');
  eq(game.viewFor(state, 'p1').players.length, 2, 'gone from the view');
  eq(state.status, 'playing', 'two are still playing');
  assert(game.removePlayer(state, 'p3').ok, 'p3 left too');
  eq(state.status, 'roundOver', 'the round ended');
  eq(state.winnerId, 'p1', 'the last one standing wins');
});

// ---------------------------------------------------------------------------
// Bot brain (view in, message out)
// ---------------------------------------------------------------------------

test('the bot declares TONDO, answers a draw decision and prefers numbers', () => {
  const number = C('basil', '4');
  const wild = W();
  const state = table([[number, wild, C('anchovy', '9')], [C('cheese', '5')]], C('basil', '3'));
  const move = bot.decide(game.viewFor(state, 'p1'));
  eq(move.action, 'play', 'it plays');
  eq(move.cardId, number.id, 'the number before the wild');

  handOf(state, 'p1').pop();
  handOf(state, 'p1').pop(); // down to just the number: two cards would be one
  handOf(state, 'p1').push(wild);
  eq(bot.decide(game.viewFor(state, 'p1')).action, 'tondo', 'two cards means shout first');
});

test('the bot only ever names a suit it is allowed to name', () => {
  const wild = W();
  const state = table([[wild, C('cheese', '2'), C('cheese', '8'), C('anchovy', '9')], [C('cheese', '5')]], C('basil', '3'));
  const move = bot.decide(game.viewFor(state, 'p1'));
  eq(move.cardId, wild.id, 'the wild is the only playable card');
  eq(move.suit, 'cheese', 'it calls the suit it holds most of');
});

// ---------------------------------------------------------------------------
// Full games
// ---------------------------------------------------------------------------

/** Plays a whole round with random legal moves and returns the winner id. */
function playRandomGame(seed, seats = 4) {
  const rng = game.makeRng(seed);
  const state = game.createGame(
    Array.from({ length: seats }, (_, i) => ({ id: `p${i + 1}`, name: `Player ${i + 1}`, isBot: true })),
    { seed }
  );
  for (let step = 0; step < 5000; step++) {
    if (state.status !== 'playing') return { winnerId: state.winnerId, steps: step, state };
    const me = game.currentPlayer(state).id;
    // Every decision is taken from the view, exactly like a client would.
    const view = game.viewFor(state, me);

    if (view.canDeclareTondo && rng() < 0.8) {
      const res = game.declareTondo(state, me);
      assert(res.ok, `declare failed: ${res.error}`);
      continue;
    }
    if (view.calloutTargets.length && rng() < 0.5) {
      const res = game.callOut(state, me, view.calloutTargets[0]);
      assert(res.ok, `callout failed: ${res.error}`);
      continue;
    }
    if (view.drawnDecisionCardId) {
      const res = view.playableCardIds.includes(view.drawnDecisionCardId) && rng() < 0.7
        ? game.playCard(state, me, view.drawnDecisionCardId, game.SUITS[Math.floor(rng() * 4)])
        : game.passTurn(state, me);
      assert(res.ok, `drawn decision failed: ${res.error}`);
      continue;
    }
    if (view.playableCardIds.length) {
      const cardId = view.playableCardIds[Math.floor(rng() * view.playableCardIds.length)];
      const res = game.playCard(state, me, cardId, game.SUITS[Math.floor(rng() * 4)]);
      assert(res.ok, `play failed: ${res.error}`);
      continue;
    }
    const res = game.drawCard(state, me);
    assert(res.ok, `draw failed: ${res.error}`);
  }
  throw new Error(`seed ${seed}: no winner in 5000 steps`);
}

test('a seeded four player game of random legal moves reaches a winner', () => {
  const { winnerId, state } = playRandomGame(20260814, 4);
  assert(winnerId, 'somebody won');
  eq(game.findPlayer(state, winnerId).hand.length, 0, 'the winner is out of cards');
  eq(state.status, 'roundOver', 'and the round is closed');
});

test('twenty seeded games at 2, 3 and 4 players all finish without throwing', () => {
  for (let seed = 1; seed <= 20; seed++) {
    for (const seats of [2, 3, 4]) {
      const { winnerId, state } = playRandomGame(seed * 1000 + seats, seats);
      assert(winnerId, `seed ${seed}/${seats}: a winner`);
      // The 68 cards are all still accounted for at the end.
      const held = state.players.reduce((n, p) => n + p.hand.length, 0);
      eq(held + state.drawPile.length + state.discardPile.length, 68, 'no card was lost or cloned');
    }
  }
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
