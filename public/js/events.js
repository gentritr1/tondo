/**
 * What just happened, derived from two consecutive snapshots.
 *
 * The client repaints the whole screen from every `state` message, so nothing
 * in the render path knows the difference between "Carmela just dropped a +2 on
 * you" and "the same board, painted again". Anything that should fire once per
 * event — a sound, a one-shot animation, a spoken announcement — needs that
 * difference, and it is not on the wire: PROTOCOL.md v1 is frozen and carries
 * state, not events.
 *
 * It does not need to be. Every rules event is recoverable from the delta
 * between the previous snapshot and the new one, and recovering it that way
 * (rather than parsing `game.log`, which is human-readable prose that will
 * change wording) keeps the wire contract untouched.
 *
 * One fact is not in state at all: WHO made a callout. That one is read from
 * the server's log line (see calloutCaller), pinned by a test that drives the
 * real engine, and reported as null rather than guessed when it cannot be read.
 *
 * This module is deliberately pure: two snapshots in, a list of events out, no
 * DOM and no side effects, so it can be unit-tested off a browser. It is also
 * deliberately NOT reduced-motion aware — a player who has asked for less
 * movement still wants the sound and the announcement. Filtering belongs at
 * each consumer, not here.
 *
 * Ordering is narrative, not arbitrary: what was played, then what that did,
 * then whose turn it became. Consumers may rely on it.
 */

/** Values that are not numbers. Kept in step with PROTOCOL.md. */
const ACTION_VALUES = new Set(['SKIP', 'PLUS2', 'REVERSE', 'WILD']);

/**
 * The seat `steps` places after `fromId` in play order, counted over players
 * still holding a place at the table. Used to name the seat an action card
 * lands on — which the snapshot never states, because by the time it arrives
 * the turn has already moved past them.
 */
function seatAfter(players, fromId, direction, steps = 1) {
  if (!Array.isArray(players) || !players.length) return null;
  const order = players.filter((p) => !p.left);
  if (!order.length) return null;
  const at = order.findIndex((p) => p.id === fromId);
  if (at < 0) return null;
  const dir = direction === -1 ? -1 : 1;
  const n = order.length;
  const next = order[(((at + dir * steps) % n) + n) % n];
  return next ? next.id : null;
}

const byId = (players, id) => (players || []).find((p) => p.id === id) || null;

/**
 * Who made a callout. State does not carry it; the server's log line does, in
 * a fixed format written by server/game.js callOut():
 *   "<CALLER> CALLED OUT <TARGET> - DRAW <n>"   (names upper-cased)
 * test/events.test.mjs drives the real engine, so a wording change there fails
 * a test instead of silently dropping the effect. Unmatched -> null.
 */
function calloutCaller(g, targetId) {
  const target = byId(g.players, targetId);
  const line = [...(g.log || [])].reverse().find((l) => / CALLED OUT /.test(l));
  if (!target || !line) return null;
  const m = line.match(/^(.+) CALLED OUT (.+) - DRAW \d+$/);
  if (!m || m[2] !== String(target.name).toUpperCase()) return null;
  const caller = (g.players || []).find((p) => String(p.name).toUpperCase() === m[1] && p.id !== targetId);
  return caller ? caller.id : null;
}

/**
 * @param {object|null} prev the snapshot the screen currently shows
 * @param {object|null} snap the snapshot that just arrived
 * @returns {Array<{type: string, [k: string]: any}>}
 */
export function deriveEvents(prev, snap) {
  const out = [];
  if (!snap) return out;
  const g = snap.game;
  const pg = prev && prev.game;

  // ---- phase transitions ------------------------------------------------
  // A deal is the only event with no predecessor state to diff against, so it
  // is recognised by the phase move rather than by the cards.
  if (g && snap.phase === 'playing' && (!prev || prev.phase !== 'playing')) {
    out.push({
      type: 'deal',
      handSize: (g.hand || []).length,
      seats: (g.players || []).length,
      first: g.turnPlayerId,
      youFirst: g.turnPlayerId === snap.youId,
    });
    return out; // nothing before a deal is comparable
  }
  if (g && snap.phase === 'roundOver' && prev && prev.phase === 'playing') {
    out.push({
      type: 'win',
      playerId: g.winnerId,
      youWon: g.winnerId === snap.youId,
    });
    return out;
  }
  if (!g || !pg || snap.phase !== 'playing' || prev.phase !== 'playing') return out;

  // ---- the played card --------------------------------------------------
  const played = g.topCard && (!pg.topCard || pg.topCard.id !== g.topCard.id) ? g.topCard : null;
  // `pg.turnPlayerId` is the seat that was on the clock in the snapshot being
  // replaced, which is exactly whoever just moved.
  const mover = played ? pg.turnPlayerId : null;

  if (played) {
    out.push({
      type: 'play',
      playerId: mover,
      card: played,
      byYou: mover === snap.youId,
      isAction: ACTION_VALUES.has(played.value),
    });
  }

  // ---- what the card did ------------------------------------------------
  // The victim is read out of the PREVIOUS order: a REVERSE has already
  // flipped `direction` by the time this snapshot lands, and a SKIP has
  // already moved the turn past the seat it skipped.
  const grew = (id, n) => {
    const before = byId(pg.players, id);
    const after = byId(g.players, id);
    return Boolean(before && after && after.cardCount - before.cardCount === n);
  };

  if (played && played.value === 'SKIP') {
    const victimId = seatAfter(pg.players, mover, pg.direction, 1);
    if (victimId) out.push({ type: 'skip', victimId, byId: mover, youSkipped: victimId === snap.youId });
  }
  if (played && played.value === 'PLUS2') {
    const victimId = seatAfter(pg.players, mover, pg.direction, 1);
    if (victimId) {
      out.push({
        type: 'plus2',
        victimId,
        byId: mover,
        youHit: victimId === snap.youId,
        // A +2 whose two cards are not visible in the delta means the draw pile
        // and discard were both empty; the card still resolved, so the event is
        // reported either way and the flag says which happened.
        cardsSeen: grew(victimId, 2),
      });
    }
  }
  if (played && played.value === 'REVERSE') {
    if (g.direction !== pg.direction) {
      out.push({ type: 'reverse', direction: g.direction, byId: mover });
    } else {
      // At a two-player table a REVERSE acts as a SKIP and never touches
      // `direction` (server/game.js:374-380) — the turn simply comes back to
      // the player who played it. Reporting a reversal here would announce a
      // rule the server did not apply, and a direction sweep would spin for a
      // change that provably did not happen. Report what actually occurred:
      // the other seat lost its turn.
      const victimId = seatAfter(pg.players, mover, pg.direction, 1);
      if (victimId) {
        out.push({
          type: 'skip',
          victimId,
          byId: mover,
          youSkipped: victimId === snap.youId,
          viaReverse: true, // the card said REVERSE; the effect was a skip
        });
      }
    }
  }
  if (played && played.value === 'WILD') {
    out.push({ type: 'wild', suit: g.activeSuit, byId: mover, byYou: mover === snap.youId });
  }
  // A direction change with no REVERSE on the pile can still happen (a seat
  // leaving at a two-player table). Report it so the arrow is never silent.
  if (!played && g.direction !== pg.direction) {
    out.push({ type: 'reverse', direction: g.direction, byId: null });
  }

  // ---- TONDO and callouts ----------------------------------------------
  for (const p of g.players || []) {
    const before = byId(pg.players, p.id);
    if (!before) continue;
    if (!before.declaredTondo && p.declaredTondo) {
      out.push({ type: 'tondo', playerId: p.id, byYou: p.id === snap.youId });
    }
    // A callout is the only way a hand grows by two with no card on the pile:
    // a +2 always arrives together with the PLUS2 that caused it. Vulnerability
    // also ends quietly when the hand grows for any other reason, so the
    // +2-with-no-play test is what separates a punishment from a reprieve.
    if (before.vulnerable && !p.vulnerable && !played && p.cardCount - before.cardCount === 2) {
      out.push({ type: 'callout', targetId: p.id, youCaught: p.id === snap.youId, callerId: calloutCaller(g, p.id) });
    }
  }

  // ---- draws ------------------------------------------------------------
  // Whatever growth is left after a +2 and a callout have been accounted for is
  // somebody taking a card off the deck.
  const explained = new Set(
    out.filter((e) => e.type === 'plus2' || e.type === 'callout')
      .map((e) => e.victimId || e.targetId),
  );
  for (const p of g.players || []) {
    const before = byId(pg.players, p.id);
    if (!before || explained.has(p.id)) continue;
    const delta = p.cardCount - before.cardCount;
    if (delta > 0) {
      out.push({ type: 'draw', playerId: p.id, count: delta, byYou: p.id === snap.youId });
    }
  }

  // ---- the deck ---------------------------------------------------------
  // The draw pile only grows when the discard is shuffled back into it — or
  // when a player leaves and their hand is returned to it. The snapshot has no
  // `left` flag (viewFor already drops departed seats from `players`), so a
  // departure is read as the seat count falling.
  const someoneLeft = (g.players || []).length < (pg.players || []).length;
  if (g.drawPileCount > pg.drawPileCount && !someoneLeft) {
    out.push({ type: 'reshuffle', count: g.drawPileCount });
  }

  // ---- turn -------------------------------------------------------------
  if (g.turnPlayerId && g.turnPlayerId !== pg.turnPlayerId) {
    out.push({
      type: 'turn',
      playerId: g.turnPlayerId,
      yours: g.turnPlayerId === snap.youId,
      playable: (g.playableCardIds || []).length,
    });
  }

  // ---- presence ---------------------------------------------------------
  for (const p of g.players || []) {
    const before = byId(pg.players, p.id);
    if (!before || before.connected === p.connected) continue;
    out.push({ type: p.connected ? 'reconnect' : 'disconnect', playerId: p.id });
  }

  return out;
}

export const __test = { seatAfter };
