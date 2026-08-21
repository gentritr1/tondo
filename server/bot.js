'use strict';

/**
 * Tondo bots.
 *
 * A bot is an ordinary seat. `decide()` is handed the very same view a human
 * client gets from `game.viewFor()` — no hidden hands, no privileged reads —
 * and returns one client message.
 */

const game = require('./game');

const BOT_NAMES = ['Carmela', 'Dominic', 'Pina', 'Chef Bot'];

/** How often a bot notices a missed TONDO. Rolled once per open window. */
const CALLOUT_CHANCE = 0.35;

/** Bots pause this long before moving, so the table stays readable. A human
 * casual play lands around 1.5-3s; instant bot moves read as a glitch, not a
 * turn, so the pause has to be long enough to SEE whose turn it was. */
const THINK_MIN_MS = 1400;
const THINK_MAX_MS = 2600;

function pickBotName(usedNames) {
  const taken = new Set(usedNames.map((n) => String(n).toLowerCase()));
  const free = BOT_NAMES.find((n) => !taken.has(n.toLowerCase()));
  if (free) return free;
  let i = 2;
  while (taken.has(`chef bot ${i}`)) i++;
  return `Chef Bot ${i}`;
}

function thinkMs() {
  return Math.round(THINK_MIN_MS + Math.random() * (THINK_MAX_MS - THINK_MIN_MS));
}

/** One roll of the missed-TONDO lottery. */
function wantsCallout() {
  return Math.random() < CALLOUT_CHANCE;
}

/** The suit the bot holds most of, for a wild. */
function bestSuit(hand) {
  const counts = Object.create(null);
  for (const suit of game.SUITS) counts[suit] = 0;
  for (const card of hand) if (card.suit) counts[card.suit]++;
  return game.SUITS.reduce((best, s) => (counts[s] > counts[best] ? s : best), game.SUITS[0]);
}

/** Numbers first, then action cards, wilds last so they stay in reserve. */
function rank(card) {
  if (card.value === game.WILD) return 2;
  return game.NUMBERS.includes(card.value) ? 0 : 1;
}

function playMove(view, card) {
  const move = { action: 'play', cardId: card.id };
  if (card.value === game.WILD) {
    move.suit = bestSuit(view.hand.filter((c) => c.id !== card.id));
  }
  return move;
}

/**
 * @param {object} view a `game.viewFor()` result for this bot
 * @returns {{action:'play',cardId:string,suit?:string}|{action:'draw'}
 *          |{action:'pass'}|{action:'tondo'}|null}
 */
function decide(view) {
  if (!view || view.winnerId) return null;

  // Shout before the second to last card goes down.
  if (view.canDeclareTondo) return { action: 'tondo' };

  const playable = view.hand.filter((c) => view.playableCardIds.includes(c.id));

  if (view.drawnDecisionCardId) {
    const drawn = playable.find((c) => c.id === view.drawnDecisionCardId);
    return drawn ? playMove(view, drawn) : { action: 'pass' };
  }
  if (playable.length > 0) {
    // Rank, then a coin toss inside the rank so two bots do not play the same
    // way every round.
    playable.sort((a, b) => rank(a) - rank(b) || (Math.random() < 0.5 ? -1 : 1));
    return playMove(view, playable[0]);
  }
  return { action: 'draw' };
}

module.exports = {
  decide,
  wantsCallout,
  pickBotName,
  thinkMs,
  bestSuit,
  BOT_NAMES,
  CALLOUT_CHANCE,
  THINK_MIN_MS,
  THINK_MAX_MS,
};
