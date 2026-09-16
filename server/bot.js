'use strict';

/**
 * Tondo bots.
 *
 * A bot is an ordinary seat. `decide()` is handed the very same view a human
 * client gets from `game.viewFor()` — no hidden hands, no privileged reads —
 * and returns one client message.
 */

const game = require('./game');

/**
 * Bots are people at the table, not a difficulty setting. Each has a declare
 * rate (how often they remember TONDO), a callout rate (how often they catch
 * someone who forgot) and a think range. STARTING values — tuned against
 * `node scripts/measure-scoring.js --callouts`, which must report >= 0.30
 * windows per round. Do not change one without re-running it.
 */
const PERSONALITIES = {
  Carmela: { tondoChance: 0.95, calloutChance: 0.60, think: [900, 1600] },  // quick, sharp-eyed
  Dominic: { tondoChance: 0.70, calloutChance: 0.35, think: [1100, 3000] }, // deliberate, forgetful
  Pina: { tondoChance: 0.60, calloutChance: 0.10, think: [2200, 3400] },    // slow, generous
  'Chef Bot': { tondoChance: 0.85, calloutChance: 0.35, think: [1400, 2600] },
};
const BOT_NAMES = ['Carmela', 'Dominic', 'Pina', 'Chef Bot'];

function personalityOf(name) {
  const key = String(name || '');
  if (PERSONALITIES[key]) return PERSONALITIES[key];
  return PERSONALITIES['Chef Bot'];
}

function pickBotName(usedNames) {
  const taken = new Set(usedNames.map((n) => String(n).toLowerCase()));
  const free = BOT_NAMES.find((n) => !taken.has(n.toLowerCase()));
  if (free) return free;
  let i = 2;
  while (taken.has(`chef bot ${i}`)) i++;
  return `Chef Bot ${i}`;
}

/** One roll of the missed-TONDO lottery, at this bot's own rate. */
function wantsCallout(name, rng = Math.random) {
  return rng() < personalityOf(name).calloutChance;
}

/**
 * How long this bot pauses. Timing carries information: a forced play (one
 * legal card) is quick, a real choice visibly takes longer. A little jitter
 * keeps two identical choices from ticking in lockstep.
 */
function thinkMs(name, view, rng = Math.random) {
  const [lo, hi] = personalityOf(name).think;
  const choices = view && Array.isArray(view.playableCardIds) ? view.playableCardIds.length : 1;
  const weight = Math.min(1, Math.max(0, (choices - 1) / 4));
  const jitter = (rng() - 0.5) * 0.1 * (hi - lo);
  return Math.round(Math.min(hi, Math.max(lo, lo + (hi - lo) * weight + jitter)));
}

/** The suit the bot holds most of, for a wild. Ties are broken at random. */
function bestSuit(hand, rng = Math.random) {
  const counts = Object.fromEntries(game.SUITS.map((s) => [s, 0]));
  for (const card of hand) if (card.suit) counts[card.suit]++;
  const top = Math.max(...Object.values(counts));
  const tied = game.SUITS.filter((s) => counts[s] === top);
  return tied[Math.floor(rng() * tied.length)];
}

/** Numbers first, then action cards, wilds last so they stay in reserve. */
function rank(card) {
  if (card.value === game.WILD) return 2;
  return game.NUMBERS.includes(card.value) ? 0 : 1;
}

function playMove(view, card, rng) {
  const move = { action: 'play', cardId: card.id };
  if (card.value === game.WILD) {
    move.suit = bestSuit(view.hand.filter((c) => c.id !== card.id), rng);
  }
  return move;
}

/**
 * @param {object} view a `game.viewFor()` result for this bot
 * @param {string} name the bot's seat name, which selects its personality
 * @param {() => number} [rng]
 */
function decide(view, name, rng = Math.random) {
  if (!view || view.winnerId) return null;

  // A bot remembers TONDO at its own rate. The misses are the game's hook:
  // "catch your friends forgetting TONDO" needs someone who forgets.
  if (view.canDeclareTondo && rng() < personalityOf(name).tondoChance) return { action: 'tondo' };

  const playable = view.hand.filter((c) => view.playableCardIds.includes(c.id));

  if (view.drawnDecisionCardId) {
    const drawn = playable.find((c) => c.id === view.drawnDecisionCardId);
    return drawn ? playMove(view, drawn, rng) : { action: 'pass' };
  }
  if (playable.length > 0) {
    // Shuffle, then a STABLE sort by rank: the shuffle order survives inside
    // each rank, which makes the tie-break a real coin toss. The old random
    // comparator was not one — it favoured deal order.
    game.shuffle(playable, rng);
    playable.sort((a, b) => rank(a) - rank(b));
    return playMove(view, playable[0], rng);
  }
  return { action: 'draw' };
}

module.exports = {
  decide,
  wantsCallout,
  pickBotName,
  thinkMs,
  bestSuit,
  personalityOf,
  PERSONALITIES,
  BOT_NAMES,
};
