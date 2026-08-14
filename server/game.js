'use strict';

/**
 * Tondo rules engine.
 *
 * Pure: this module knows nothing about sockets, rooms or timers. Every
 * function that changes the game takes the state first and returns either
 * `{ ok: true, ... }` or `{ ok: false, error: '...' }`. The RNG is seedable so
 * a round can be replayed exactly in the tests.
 *
 * See PROTOCOL.md — `viewFor()` produces the `game` object of the snapshot.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUITS = ['pepperoni', 'cheese', 'basil', 'anchovy'];
const NUMBERS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const ACTIONS = ['SKIP', 'PLUS2', 'REVERSE'];
const WILD = 'WILD';

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
const HAND_SIZE = 7;
const CALLOUT_PENALTY = 2;
const LOG_LIMIT = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** mulberry32. Without a seed the game just uses Math.random. */
function makeRng(seed) {
  if (seed === undefined || seed === null) return Math.random;
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(cards, rng = Math.random) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function isWild(card) {
  return Boolean(card) && card.value === WILD;
}

function isNumber(card) {
  return Boolean(card) && NUMBERS.includes(card.value);
}

/** Log lines are ALL CAPS, e.g. `CARMELA PLAYED BASIL 7`. */
function describeCard(card) {
  if (!card) return 'NOTHING';
  if (isWild(card)) return WILD;
  return `${String(card.suit).toUpperCase()} ${card.value}`;
}

function up(name) {
  return String(name == null ? '' : name).toUpperCase();
}

// ---------------------------------------------------------------------------
// Deck
// ---------------------------------------------------------------------------

/**
 * The 68 card deck: per suit one each of 0-9 plus two each of SKIP, PLUS2 and
 * REVERSE (16 a suit), and four WILD on top of that.
 */
function buildDeck() {
  const deck = [];
  let serial = 0;
  const add = (suit, value) => deck.push({ id: `c${serial++}`, suit, value });

  for (const suit of SUITS) {
    for (const value of NUMBERS) add(suit, value);
    for (const value of ACTIONS) {
      add(suit, value);
      add(suit, value);
    }
  }
  for (let i = 0; i < 4; i++) add(null, WILD);
  return deck;
}

// ---------------------------------------------------------------------------
// Round setup
// ---------------------------------------------------------------------------

/**
 * Starts a round.
 * @param {Array<{id:string,name:string,isBot?:boolean}>} seats 2-4 seats
 * @param {{seed?:number}} options
 */
function createGame(seats, options = {}) {
  if (seats.length < MIN_PLAYERS) throw new Error('Not enough players.');
  if (seats.length > MAX_PLAYERS) throw new Error('Too many players.');

  const rng = makeRng(options.seed);
  const state = {
    rng,
    players: seats.map((seat) => ({
      id: seat.id,
      name: seat.name,
      isBot: Boolean(seat.isBot),
      connected: true,
      left: false,
      hand: [],
      declaredTondo: false,
      vulnerable: false,
    })),
    drawPile: shuffle(buildDeck(), rng),
    discardPile: [],
    activeSuit: null,
    turnIndex: 0,
    direction: 1,
    drawnCard: null, // { playerId, cardId } while a drawn card may still be played
    status: 'playing', // 'playing' | 'roundOver'
    winnerId: null,
    log: [],
    turnSerial: 0, // internal; the room hangs its turn timers off it
  };

  for (let i = 0; i < HAND_SIZE; i++) {
    for (const player of state.players) player.hand.push(state.drawPile.pop());
  }

  // The starting card must be a number: an action card with nobody to act on
  // is a rule nobody wants to write down. Non-numbers go back to the bottom.
  let first = state.drawPile.pop();
  while (!isNumber(first)) {
    state.drawPile.unshift(first);
    first = state.drawPile.pop();
  }
  state.discardPile.push(first);
  state.activeSuit = first.suit;

  addLog(state, `ROUND START - TOP CARD ${describeCard(first)}`);
  addLog(state, `${up(currentPlayer(state).name)} IS UP FIRST`);
  return state;
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

function topCard(state) {
  return state.discardPile[state.discardPile.length - 1] || null;
}

function currentPlayer(state) {
  return state.players[state.turnIndex];
}

function findPlayer(state, playerId) {
  return state.players.find((p) => p.id === playerId) || null;
}

function activePlayers(state) {
  return state.players.filter((p) => !p.left);
}

/** Legal = WILD, or the active suit, or the top card's value. */
function canPlay(state, card) {
  const top = topCard(state);
  if (!top || !card) return false;
  if (isWild(card)) return true;
  if (card.suit === state.activeSuit) return true;
  return card.value === top.value;
}

/** Ids in a player's hand that may be played right now. */
function playableCardIds(state, playerId) {
  const player = findPlayer(state, playerId);
  if (!player || player.left || state.status !== 'playing') return [];
  if (currentPlayer(state).id !== playerId) return [];
  if (state.drawnCard) {
    // After a draw only the freshly drawn card is on the table.
    const card = player.hand.find((c) => c.id === state.drawnCard.cardId);
    return card && canPlay(state, card) ? [card.id] : [];
  }
  return player.hand.filter((c) => canPlay(state, c)).map((c) => c.id);
}

// ---------------------------------------------------------------------------
// Internal mutators
// ---------------------------------------------------------------------------

function addLog(state, text) {
  state.log.push(text);
  if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);
}

/** Refills the draw pile from the discard pile, keeping the top card. */
function refillDrawPile(state) {
  if (state.discardPile.length <= 1) return false;
  const top = state.discardPile.pop();
  const recycled = state.discardPile;
  state.discardPile = [top];
  state.drawPile = shuffle(recycled, state.rng);
  addLog(state, 'DISCARD PILE RESHUFFLED INTO THE DECK');
  return true;
}

/** Gives `count` cards to a player. Returns the cards actually dealt. */
function dealTo(state, player, count) {
  const dealt = [];
  for (let i = 0; i < count; i++) {
    if (state.drawPile.length === 0 && !refillDrawPile(state)) break;
    dealt.push(state.drawPile.pop());
  }
  player.hand.push(...dealt);
  // A bigger hand is no longer one card away, and past two the declaration is
  // spent: both flags follow the hand, never the other way round.
  if (player.hand.length > 1) player.vulnerable = false;
  if (player.hand.length > 2) player.declaredTondo = false;
  return dealt;
}

/** Index of the seat `steps` places away, skipping players who left. */
function seatAfter(state, fromIndex, steps) {
  const total = state.players.length;
  let index = fromIndex;
  let moved = 0;
  let guard = 0;
  while (moved < steps && guard++ < total * steps + total) {
    index = (index + state.direction + total) % total;
    if (!state.players[index].left) moved++;
  }
  return index;
}

function advanceTurn(state, steps = 1) {
  state.drawnCard = null;
  const from = state.turnIndex;
  const next = seatAfter(state, state.turnIndex, steps);
  state.turnIndex = next;
  state.turnSerial++;
  // A missed TONDO stays punishable until the start of that player's next
  // turn. A turn that lands straight back on the same seat (a SKIP at a table
  // of two) gave nobody a chance to speak, so it does not close the window.
  const player = state.players[next];
  if (player && next !== from) player.vulnerable = false;
}

function endRound(state, winner) {
  state.status = 'roundOver';
  state.winnerId = winner ? winner.id : null;
  state.drawnCard = null;
  if (winner) addLog(state, `${up(winner.name)} WINS THE ROUND`);
  else addLog(state, 'THE ROUND ENDED WITH NOBODY AT THE TABLE');
}

function assertTurn(state, playerId) {
  if (state.status !== 'playing') return { ok: false, error: 'The round is over.' };
  const player = findPlayer(state, playerId);
  if (!player) return { ok: false, error: 'Unknown player.' };
  if (player.left) return { ok: false, error: 'You left the table.' };
  if (currentPlayer(state).id !== playerId) return { ok: false, error: 'It is not your turn.' };
  return { ok: true, player };
}

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

/** Plays a card. `chosenSuit` is required for (and only for) WILD. */
function playCard(state, playerId, cardId, chosenSuit) {
  const turn = assertTurn(state, playerId);
  if (!turn.ok) return turn;
  const player = turn.player;

  const index = player.hand.findIndex((c) => c.id === cardId);
  if (index === -1) return { ok: false, error: 'That card is not in your hand.' };
  const card = player.hand[index];

  if (state.drawnCard && state.drawnCard.cardId !== cardId) {
    return { ok: false, error: 'You may only play the card you just drew, or pass.' };
  }
  if (!canPlay(state, card)) {
    return { ok: false, error: `${describeCard(card)} does not match.` };
  }
  if (isWild(card) && !SUITS.includes(chosenSuit)) {
    return { ok: false, error: 'Choose a suit for that wild card.' };
  }

  player.hand.splice(index, 1);
  state.discardPile.push(card);
  state.activeSuit = isWild(card) ? chosenSuit : card.suit;
  state.drawnCard = null;

  addLog(state, isWild(card)
    ? `${up(player.name)} PLAYED WILD AND CALLED ${up(chosenSuit)}`
    : `${up(player.name)} PLAYED ${describeCard(card)}`);

  // The win is checked before the card's effect: a last card that would make
  // somebody draw still ends the round.
  if (player.hand.length === 0) {
    endRound(state, player);
    return { ok: true, card };
  }

  if (player.hand.length === 1) {
    player.vulnerable = !player.declaredTondo;
    if (player.declaredTondo) addLog(state, `${up(player.name)} IS DOWN TO ONE CARD`);
  }

  applyCardEffect(state, card, player);
  return { ok: true, card };
}

function applyCardEffect(state, card, player) {
  const twoAtTheTable = activePlayers(state).length === 2;

  switch (card.value) {
    case 'SKIP': {
      const victim = state.players[seatAfter(state, state.turnIndex, 1)];
      addLog(state, `${up(victim.name)} WAS SKIPPED`);
      advanceTurn(state, 2);
      return;
    }
    case 'REVERSE': {
      if (twoAtTheTable) {
        addLog(state, `REVERSE ACTS AS A SKIP - ${up(player.name)} GOES AGAIN`);
        advanceTurn(state, 2);
      } else {
        state.direction *= -1;
        addLog(state, 'DIRECTION REVERSED');
        advanceTurn(state, 1);
      }
      return;
    }
    case 'PLUS2': {
      const victim = state.players[seatAfter(state, state.turnIndex, 1)];
      const dealt = dealTo(state, victim, 2);
      addLog(state, `${up(victim.name)} DREW ${dealt.length} AND LOST A TURN`);
      advanceTurn(state, 2);
      return;
    }
    default:
      advanceTurn(state, 1);
  }
}

/** Takes exactly one card. A playable one keeps the turn open for a decision. */
function drawCard(state, playerId) {
  const turn = assertTurn(state, playerId);
  if (!turn.ok) return turn;
  const player = turn.player;
  if (state.drawnCard) return { ok: false, error: 'Play the drawn card or pass.' };

  const dealt = dealTo(state, player, 1);
  if (dealt.length === 0) {
    addLog(state, `NO CARDS LEFT - ${up(player.name)} PASSED`);
    advanceTurn(state, 1);
    return { ok: true, card: null, playable: false };
  }

  const card = dealt[0];
  addLog(state, `${up(player.name)} DREW A CARD`);
  if (canPlay(state, card)) {
    state.drawnCard = { playerId, cardId: card.id };
    return { ok: true, card, playable: true };
  }
  advanceTurn(state, 1);
  return { ok: true, card, playable: false };
}

/** Keeps the drawn card and gives up the turn. */
function passTurn(state, playerId) {
  const turn = assertTurn(state, playerId);
  if (!turn.ok) return turn;
  if (!state.drawnCard || state.drawnCard.playerId !== playerId) {
    return { ok: false, error: 'You must draw a card before you pass.' };
  }
  addLog(state, `${up(turn.player.name)} KEPT THE CARD AND PASSED`);
  advanceTurn(state, 1);
  return { ok: true };
}

/**
 * Resolves the turn of a player who is not there: draw one, keep it, pass.
 * Used by the room's away clock, never by a client.
 */
function autoTurn(state, playerId) {
  const turn = assertTurn(state, playerId);
  if (!turn.ok) return turn;
  addLog(state, `${up(turn.player.name)} IS AWAY`);
  if (!state.drawnCard) {
    const drew = drawCard(state, playerId);
    if (!drew.ok) return drew;
  }
  if (state.drawnCard && state.drawnCard.playerId === playerId) {
    return passTurn(state, playerId);
  }
  return { ok: true };
}

/** The TONDO button. Legal on exactly two cards, once. */
function declareTondo(state, playerId) {
  if (state.status !== 'playing') return { ok: false, error: 'The round is over.' };
  const player = findPlayer(state, playerId);
  if (!player || player.left) return { ok: false, error: 'Unknown player.' };
  if (player.hand.length !== 2) {
    return { ok: false, error: 'You can only call TONDO holding exactly 2 cards.' };
  }
  if (player.declaredTondo) return { ok: false, error: 'You already called TONDO.' };

  player.declaredTondo = true;
  player.vulnerable = false;
  addLog(state, `${up(player.name)} DECLARED TONDO`);
  return { ok: true };
}

/** Punishes a player who went down to one card without calling it. */
function callOut(state, callerId, targetId) {
  if (state.status !== 'playing') return { ok: false, error: 'The round is over.' };
  const caller = findPlayer(state, callerId);
  const target = findPlayer(state, targetId);
  if (!caller || caller.left) return { ok: false, error: 'Unknown player.' };
  if (!target || target.left) return { ok: false, error: 'Unknown target.' };
  if (callerId === targetId) return { ok: false, error: 'You cannot call out yourself.' };
  if (!target.vulnerable || target.hand.length !== 1) {
    return { ok: false, error: `${target.name} cannot be called out right now.` };
  }

  target.vulnerable = false;
  const dealt = dealTo(state, target, CALLOUT_PENALTY);
  addLog(state, `${up(caller.name)} CALLED OUT ${up(target.name)} - DRAW ${dealt.length}`);
  return { ok: true };
}

/** Takes a player out for good. Their cards go back into the draw pile. */
function removePlayer(state, playerId) {
  const player = findPlayer(state, playerId);
  if (!player || player.left) return { ok: false, error: 'Unknown player.' };
  const wasTheirTurn = state.status === 'playing' && currentPlayer(state).id === playerId;

  player.left = true;
  state.drawPile.push(...player.hand.splice(0));
  shuffle(state.drawPile, state.rng);
  addLog(state, `${up(player.name)} LEFT THE TABLE`);

  if (state.status !== 'playing') return { ok: true };
  const remaining = activePlayers(state);
  if (remaining.length <= 1) {
    endRound(state, remaining[0] || null);
    return { ok: true };
  }
  if (wasTheirTurn) advanceTurn(state, 1);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Client view — exactly the `game` object of the snapshot in PROTOCOL.md
// ---------------------------------------------------------------------------

function viewFor(state, playerId) {
  const me = findPlayer(state, playerId);
  const seated = activePlayers(state);
  return {
    direction: state.direction,
    activeSuit: state.activeSuit,
    topCard: topCard(state),
    drawPileCount: state.drawPile.length,
    turnPlayerId: currentPlayer(state) ? currentPlayer(state).id : null,
    winnerId: state.winnerId,
    players: seated.map((p) => ({
      id: p.id,
      name: p.name,
      isBot: p.isBot,
      connected: p.connected,
      cardCount: p.hand.length,
      declaredTondo: p.declaredTondo,
      vulnerable: p.vulnerable,
    })),
    hand: me ? me.hand.map((c) => ({ id: c.id, suit: c.suit, value: c.value })) : [],
    playableCardIds: me ? playableCardIds(state, playerId) : [],
    drawnDecisionCardId:
      state.drawnCard && state.drawnCard.playerId === playerId ? state.drawnCard.cardId : null,
    canDeclareTondo: Boolean(
      me && !me.left && state.status === 'playing' && me.hand.length === 2 && !me.declaredTondo
    ),
    calloutTargets: seated
      .filter((p) => p.id !== playerId && p.vulnerable && p.hand.length === 1)
      .map((p) => p.id),
    log: state.log.slice(-LOG_LIMIT),
  };
}

module.exports = {
  SUITS,
  NUMBERS,
  ACTIONS,
  WILD,
  MIN_PLAYERS,
  MAX_PLAYERS,
  HAND_SIZE,
  CALLOUT_PENALTY,
  LOG_LIMIT,
  makeRng,
  shuffle,
  buildDeck,
  createGame,
  canPlay,
  playableCardIds,
  playCard,
  drawCard,
  passTurn,
  autoTurn,
  declareTondo,
  callOut,
  removePlayer,
  viewFor,
  topCard,
  currentPlayer,
  findPlayer,
  activePlayers,
  describeCard,
  isWild,
  isNumber,
};
