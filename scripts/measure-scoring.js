'use strict';

/**
 * Measures what a Tondo round is actually WORTH, so the match target is a
 * number derived from play rather than a number someone liked.
 *
 * It runs complete rounds through the real rules engine (`server/game.js`) with
 * the real bot AI (`server/bot.js`) making every decision, scores each round the
 * way the match layer will, and reports the distribution plus how many rounds
 * each candidate target would take to reach.
 *
 * Usage:
 *   node scripts/measure-scoring.js              # 2000 rounds at each seat count
 *   node scripts/measure-scoring.js --rounds 500
 *
 * The scoring rule under test: the winner banks the value of every card still
 * in everyone else's hands. Number cards score their face value, action cards
 * (SKIP / +2 / REVERSE) score 20, WILD scores 50 — the values UNO players
 * already know, which is worth more here than a bespoke scale.
 */

const game = require('../server/game');
const bot = require('../server/bot');

const ACTION_POINTS = 20;
const WILD_POINTS = 50;

function cardPoints(card) {
  if (!card) return 0;
  if (card.value === 'WILD') return WILD_POINTS;
  const n = Number(card.value);
  return Number.isInteger(n) ? n : ACTION_POINTS;
}

/** What the winner banks: every card left in every other hand. */
function scoreRound(state, winnerId) {
  let total = 0;
  for (const p of state.players) {
    if (p.id === winnerId || p.left) continue;
    for (const c of p.hand) total += cardPoints(c);
  }
  return total;
}

/** Plays one round to completion with bots in every seat. */
function playRound(seatCount, seed) {
  const seats = Array.from({ length: seatCount }, (_, i) => ({
    id: `p${i + 1}`, name: `Bot${i + 1}`, isBot: true,
  }));
  const state = game.createGame(seats, { seed });
  let steps = 0;
  while (state.status === 'playing' && steps < 3000) {
    const me = game.currentPlayer(state);
    if (!me) break;
    const view = game.viewFor(state, me.id);
    const move = bot.decide(view);
    if (!move) break;
    if (move.action === 'play') game.playCard(state, me.id, move.cardId, move.suit);
    else if (move.action === 'draw') game.drawCard(state, me.id);
    else if (move.action === 'pass') game.passTurn(state, me.id);
    else if (move.action === 'tondo') game.declareTondo(state, me.id);
    steps++;
  }
  if (state.status !== 'roundOver') return null;
  return { score: scoreRound(state, state.winnerId), steps };
}

function stats(values) {
  const s = [...values].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    n: s.length,
    min: s[0],
    p25: at(0.25),
    median: at(0.5),
    mean: Math.round(mean * 10) / 10,
    p75: at(0.75),
    p95: at(0.95),
    max: s[s.length - 1],
  };
}

/**
 * How many rounds a target takes, simulated by drawing real observed scores.
 * Uses the measured scores rather than the mean, because the spread is what
 * decides whether a match ends in three rounds or eight.
 */
function roundsToTarget(scores, target, trials = 20000) {
  const out = [];
  for (let t = 0; t < trials; t++) {
    let total = 0, rounds = 0;
    // One seat's running total: a player only banks the rounds they win, so a
    // 3-player table splits wins roughly evenly and needs proportionally more
    // rounds played at the table than any one player wins.
    while (total < target && rounds < 200) {
      total += scores[Math.floor(Math.random() * scores.length)];
      rounds++;
    }
    out.push(rounds);
  }
  return stats(out);
}

/**
 * Counts callout windows a human gets on a bot: a snapshot in which the human's
 * `calloutTargets` gains a bot id it did not hold one step earlier. The human
 * plays legally and always declares TONDO, so the only windows are bot misses.
 * Bot-on-bot callouts are timed (1400ms) in the real room and are ignored here:
 * the human always gets the first beat.
 */
function measureCallouts(rounds) {
  const seats = [
    { id: 'p1', name: 'Human' },
    { id: 'p2', name: 'Carmela', isBot: true },
    { id: 'p3', name: 'Dominic', isBot: true },
    { id: 'p4', name: 'Pina', isBot: true },
  ];
  const nameOf = Object.fromEntries(seats.map((s) => [s.id, s.name]));
  let windows = 0;
  let finished = 0;
  for (let r = 0; r < rounds; r++) {
    const state = game.createGame(seats, { seed: r * 104729 + 17, startIndex: r % 4 });
    let open = new Set();
    let steps = 0;
    while (state.status === 'playing' && steps < 3000) {
      const me = game.currentPlayer(state);
      const view = game.viewFor(state, me.id);
      if (me.id === 'p1') {
        if (view.canDeclareTondo) game.declareTondo(state, 'p1');
        else if (view.drawnDecisionCardId) {
          const card = view.hand.find((c) => c.id === view.drawnDecisionCardId);
          if (view.playableCardIds.includes(view.drawnDecisionCardId)) {
            game.playCard(state, 'p1', card.id, card.value === 'WILD' ? 'basil' : undefined);
          } else game.passTurn(state, 'p1');
        } else if (view.playableCardIds.length) {
          const card = view.hand.find((c) => c.id === view.playableCardIds[0]);
          game.playCard(state, 'p1', card.id, card.value === 'WILD' ? 'basil' : undefined);
        } else game.drawCard(state, 'p1');
      } else {
        const move = bot.decide(view, nameOf[me.id]);
        if (!move) break;
        if (move.action === 'play') game.playCard(state, me.id, move.cardId, move.suit);
        else if (move.action === 'draw') game.drawCard(state, me.id);
        else if (move.action === 'pass') game.passTurn(state, me.id);
        else if (move.action === 'tondo') game.declareTondo(state, me.id);
      }
      const now = new Set(game.viewFor(state, 'p1').calloutTargets.filter((id) => id !== 'p1'));
      for (const id of now) if (!open.has(id)) windows++;
      open = now;
      steps++;
    }
    if (state.status === 'roundOver') finished++;
  }
  return { rounds, finished, windows, perRound: windows / rounds };
}

function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--rounds');
  const ROUNDS = i >= 0 ? Number(argv[i + 1]) : 2000;

  if (argv.includes('--callouts')) {
    const n = i >= 0 ? Number(argv[i + 1]) : 2000;
    const m = measureCallouts(n);
    console.log(`\nCallout windows on bots — 1 legal human + Carmela, Dominic, Pina — ${m.rounds} rounds (${m.finished} finished)`);
    console.log(`  windows: ${m.windows}   per round: ${m.perRound.toFixed(2)}   per pie (x4): ${(m.perRound * 4).toFixed(2)}`);
    console.log(`  required: >= 0.30 per round  ->  ${m.perRound >= 0.30 ? 'PASS' : 'FAIL'}\n`);
    process.exitCode = m.perRound >= 0.30 ? 0 : 1;
    return;
  }

  console.log(`\nTondo round-value measurement — ${ROUNDS} complete rounds per seat count`);
  console.log(`scoring: numbers = face, SKIP/+2/REVERSE = ${ACTION_POINTS}, WILD = ${WILD_POINTS}\n`);

  const all = {};
  for (const seatCount of [2, 3, 4]) {
    const scores = [];
    const lengths = [];
    let failed = 0;
    for (let r = 0; r < ROUNDS; r++) {
      const res = playRound(seatCount, r * 7919 + seatCount);
      if (!res) { failed++; continue; }
      scores.push(res.score);
      lengths.push(res.steps);
    }
    all[seatCount] = scores;
    const s = stats(scores);
    const l = stats(lengths);
    console.log(`${seatCount} players — winner's score per round`);
    console.log(`  n=${s.n}${failed ? ` (${failed} unfinished)` : ''}  min ${s.min}  p25 ${s.p25}  median ${s.median}  mean ${s.mean}  p75 ${s.p75}  p95 ${s.p95}  max ${s.max}`);
    console.log(`  round length: median ${l.median} moves, p95 ${l.p95}\n`);
  }

  console.log('Rounds a single player needs to reach a target (using the measured spread):');
  console.log('  target | 2p median (p95) | 3p median (p95) | 4p median (p95)');
  for (const target of [100, 150, 200, 250, 300, 400, 500]) {
    const cells = [2, 3, 4].map((n) => {
      const r = roundsToTarget(all[n], target);
      return `${String(r.median).padStart(2)} (${String(r.p95).padStart(2)})`;
    });
    console.log(`  ${String(target).padStart(6)} | ${cells.map((c) => c.padEnd(15)).join(' | ')}`);
  }
  console.log('\nNote: a "round" here is one this player WON. At a 4-player table');
  console.log('they win roughly one round in four, so rounds PLAYED is about 4x.\n');
}

main();
