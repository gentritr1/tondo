'use strict';

/**
 * Smoke client for the round boundary: two humans and a bot at one table,
 * playing until a slice ends, then checking the things a single client cannot.
 *
 *   node server/index.js &        # then
 *   node scripts/table-smoke.js
 *
 * What it asserts, all over a real WebSocket against the real server:
 *   1. The NON-HOST is told they may deal (`isHost` is false for them).
 *   2. The between-slices clock is published to both seats.
 *   3. The non-host's `newRound` is ACCEPTED — the table no longer stalls
 *      because one specific person put their phone down.
 *
 * Exit 0 on success, 1 on any failure or after 120 seconds.
 */

const WebSocket = require('ws');

const URL = process.env.TONDO_URL || `ws://localhost:${process.env.PORT || 4600}`;
const DEADLINE_MS = 120000;

const timeout = setTimeout(() => {
  // Report WHERE it stalled rather than only that it did.
  const d = (p) => (p && p.snap)
    ? `${p.name}: joined=${p.joined} phase=${p.snap.phase} turn=${p.snap.game && p.snap.game.turnPlayerId} you=${p.youId} seats=${p.snap.seats.length}`
    : `${p ? p.name : '?'}: no snapshot`;
  fail(`nothing finished within 120s — stage=${phase}\n  ${d(host)}\n  ${d(guest)}`);
}, DEADLINE_MS);

function fail(why) {
  console.error(`\nTABLE SMOKE FAIL: ${why}\n`);
  process.exit(1);
}
function ok(what) { console.log(`  ok  ${what}`); }

/** One connected player: a socket, its latest snapshot, and a send helper. */
function connect(name, onState, onJoined) {
  const ws = new WebSocket(URL);
  const p = { ws, name, snap: null, youId: null, joined: false };
  p.send = (msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
  ws.on('error', (err) => fail(`${name} socket: ${err.message}`));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'error') return fail(`${name} got server error: ${msg.message}`);
    if (msg.type === 'joined') {
      p.youId = msg.youId;
      p.joined = true;
      if (onJoined) onJoined(p, msg);
      return;
    }
    if (msg.type === 'state') {
      p.snap = msg;
      if (onState) onState(p, msg);
    }
  });
  return p;
}

/** Plays the dumbest legal move for whoever holds the turn. */
function takeTurn(p) {
  const g = p.snap && p.snap.game;
  if (!g || p.snap.phase !== 'playing') return;
  if (g.turnPlayerId !== p.youId) return;
  if (g.drawnDecisionCardId) {
    const c = g.hand.find((x) => x.id === g.drawnDecisionCardId);
    const playable = (g.playableCardIds || []).includes(g.drawnDecisionCardId);
    if (playable) p.send(c && c.value === 'WILD' ? { type: 'play', cardId: c.id, suit: 'cheese' } : { type: 'play', cardId: c.id });
    else p.send({ type: 'pass' });
    return;
  }
  if (g.canDeclareTondo) { p.send({ type: 'tondo' }); return; }
  const id = (g.playableCardIds || [])[0];
  if (id) {
    const card = g.hand.find((c) => c.id === id);
    p.send(card && card.value === 'WILD' ? { type: 'play', cardId: id, suit: 'cheese' } : { type: 'play', cardId: id });
  } else {
    p.send({ type: 'draw' });
  }
}

let phase = 'seating';
let host = null;
let guest = null;
let code = null;

function onAnyState(p) {
  const snap = p.snap;
  if (!snap) return;

  if (phase === 'playing') {
    takeTurn(p);
    if (snap.phase === 'roundOver') {
      phase = 'boundary';
      setTimeout(checkBoundary, 400); // let both clients settle on the snapshot
    }
    return;
  }
}

function checkBoundary() {
  const h = host.snap;
  const gsnap = guest.snap;
  if (!h || !gsnap) return fail('a client never received a snapshot');
  if (h.phase !== 'roundOver' || gsnap.phase !== 'roundOver') {
    return fail(`both seats should see roundOver (host ${h.phase}, guest ${gsnap.phase})`);
  }

  // 1. The guest really is not the host.
  if (gsnap.isHost) return fail('the guest should not be the acting host');
  ok('the guest is NOT the host');

  // 2. Both seats can see the clock.
  if (!h.match || !gsnap.match) return fail('match block missing from a snapshot');
  if (typeof gsnap.match.nextDueAt !== 'number') {
    return fail(`the guest should see a running clock, got ${JSON.stringify(gsnap.match.nextDueAt)}`);
  }
  ok(`both seats see the between-slices clock (${Math.round((gsnap.match.nextDueAt - Date.now()) / 1000)}s left)`);

  // 3. Hold, from the NON-HOST, must stop it.
  guest.send({ type: 'hold' });
  setTimeout(() => {
    if (guest.snap.match.nextDueAt !== null) return fail('the guest\'s hold did not stop the clock');
    if (host.snap.match.nextDueAt !== null) return fail('the hold did not reach the host');
    ok('the guest can hold the table, and the host sees it');

    // 4. The whole point: the NON-HOST deals the next slice.
    const roundBefore = guest.snap.match.round;
    guest.send({ type: 'newRound' });
    setTimeout(() => {
      if (guest.snap.phase !== 'playing') {
        return fail(`the guest's newRound was refused — still ${guest.snap.phase}`);
      }
      if (host.snap.phase !== 'playing') return fail('the deal did not reach the host');
      ok(`the NON-HOST dealt the next slice (slice ${roundBefore} -> ${roundBefore + 1})`);
      clearTimeout(timeout);
      console.log('\nTABLE SMOKE PASS — nobody waits for the host.\n');
      process.exit(0);
    }, 900);
  }, 700);
}

// --- seating ---------------------------------------------------------------

host = connect('Host', onAnyState, (p, msg) => {
  code = msg.roomCode;
  // One bot, so a two-human table still has a third seat and rounds end fast.
  p.send({ type: 'addBot' });
  guest = connect('Guest', onAnyState, () => {
    setTimeout(() => {
      phase = 'playing';
      host.send({ type: 'startGame' });
    }, 300);
  });
  setTimeout(() => guest.send({ type: 'joinRoom', code, name: 'Guest' }), 250);
});

host.ws.on('open', () => host.send({ type: 'createRoom', name: 'Host' }));
