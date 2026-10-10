'use strict';

/**
 * A REAL pie, start to finish, saved to a new crew: host + 3 bots, the dumbest
 * legal strategy (same as host-smoke.js), dealing each next slice at once.
 * Then saves to a new crew and waits for the server to confirm it.
 *
 *   node scripts/crew-smoke.js          (TONDO_URL or PORT picks the server)
 *
 * Prints `slice <n>/4 done` per finished slice, then `CREW <id> PIES 1` and
 * exits 0; exits 1 on any error or after 5 min.
 * Bots think at human speed, so this takes minutes — run it in the background.
 */

const crypto = require('crypto');
const WebSocket = require('ws');

const URL = process.env.TONDO_URL || `ws://localhost:${process.env.PORT || 4600}`;
const ws = new WebSocket(URL);
const device = crypto.randomBytes(16).toString('hex');
let me = null;
let fingerprint = '';
let saveSent = false;
let dealtFor = -1; // match.round (slices finished) we already sent newRound for
let reported = 0; // slices already announced on stdout

const timeout = setTimeout(() => fail('no saved pie within 5 min'), 300000);
function fail(why) { console.error(`CREW SMOKE FAIL: ${why}`); process.exit(1); }
function send(msg) { ws.send(JSON.stringify(msg)); }
function play(g, cardId) {
  const card = g.hand.find((c) => c.id === cardId);
  send(card && card.value === 'WILD' ? { type: 'play', cardId, suit: 'cheese' } : { type: 'play', cardId });
}

ws.on('open', () => send({ type: 'createRoom', name: 'Smoke', device }));
ws.on('error', (err) => fail(`socket: ${err.message}`));
ws.on('close', () => fail('the server closed the socket'));

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'error') {
    // Several snapshots arrive per round boundary and the server also deals the
    // next slice by itself after 10 s, so this one refusal is benign.
    if (msg.message === 'The round is not over.') return console.log(`benign refusal: ${msg.message}`);
    return fail(msg.message);
  }
  if (msg.type === 'joined') {
    me = msg.youId;
    for (let i = 0; i < 3; i++) send({ type: 'addBot' });
    return send({ type: 'startGame' });
  }
  if (msg.type !== 'state') return;
  const m = msg.match;
  if (msg.crews !== 'on') return fail(`crews are ${msg.crews} on this server`);

  if (msg.phase === 'roundOver') {
    if (m.round > reported) { reported = m.round; console.log(`slice ${m.round}/4 done`); }
    if (m.savedTo) {
      clearTimeout(timeout);
      console.log(`CREW ${m.savedTo.id} PIES 1`);
      ws.removeAllListeners('close');
      ws.close();
      return process.exit(0);
    }
    if (m.complete && !saveSent && !m.saving) { saveSent = true; return send({ type: 'saveToCrew', newCrewName: 'Smoke crew' }); }
    // Deal once per finished slice: repeat snapshots must not deal twice.
    if (!m.complete && m.round !== dealtFor) { dealtFor = m.round; return send({ type: 'newRound' }); }
    return;
  }
  if (msg.phase !== 'playing' || !msg.game) return;
  const g = msg.game;
  const fp = JSON.stringify([g.turnPlayerId, g.hand.map((c) => c.id), g.drawnDecisionCardId, g.topCard.id, g.canDeclareTondo]);
  if (fp === fingerprint) return;
  fingerprint = fp;
  if (g.canDeclareTondo) return send({ type: 'tondo' });
  if (g.turnPlayerId !== me) return;
  if (g.drawnDecisionCardId) {
    return g.playableCardIds.includes(g.drawnDecisionCardId) ? play(g, g.drawnDecisionCardId) : send({ type: 'pass' });
  }
  if (g.playableCardIds.length) return play(g, g.playableCardIds[0]);
  send({ type: 'draw' });
});
