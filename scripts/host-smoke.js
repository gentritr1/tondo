'use strict';

/**
 * Smoke client: hosts a table, fills it with three bots and plays its own turns
 * with the dumbest legal strategy until somebody wins.
 *
 *   node server/index.js &        # then
 *   node scripts/host-smoke.js
 *
 * Exit 0 with a winner printed, 1 on any server error or after 90 seconds.
 */

const WebSocket = require('ws');

const URL = process.env.TONDO_URL || `ws://localhost:${process.env.PORT || 4600}`;
const ws = new WebSocket(URL);
let me = null;
let fingerprint = '';

const timeout = setTimeout(() => fail('no winner within 90s'), 90000);

function fail(why) {
  console.error(`SMOKE FAIL: ${why}`);
  process.exit(1);
}
function send(msg) {
  ws.send(JSON.stringify(msg));
}
function play(g, cardId) {
  const card = g.hand.find((c) => c.id === cardId);
  send(card && card.value === 'WILD' ? { type: 'play', cardId, suit: 'cheese' } : { type: 'play', cardId });
}

ws.on('open', () => send({ type: 'createRoom', name: 'Smoke' }));
ws.on('error', (err) => fail(`socket: ${err.message}`));
ws.on('close', () => fail('the server closed the socket'));

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'error') return fail(msg.message);

  if (msg.type === 'joined') {
    me = msg.youId;
    console.log(`joined ${msg.roomCode} as ${me}`);
    for (let i = 0; i < 3; i++) send({ type: 'addBot' });
    return send({ type: 'startGame' });
  }
  if (msg.type !== 'state' || !msg.game) return;
  const g = msg.game;

  if (msg.phase === 'roundOver') {
    const winner = g.players.find((p) => p.id === g.winnerId);
    clearTimeout(timeout);
    console.log(g.log.slice(-5).join('\n'));
    console.log(`WINNER: ${winner ? winner.name : g.winnerId} (${g.winnerId})`);
    ws.removeAllListeners('close');
    ws.close();
    return process.exit(0);
  }
  if (msg.phase !== 'playing') return;

  // Act once per genuinely new situation: repeat snapshots must not move twice.
  const fp = JSON.stringify([g.turnPlayerId, g.hand.map((c) => c.id), g.drawnDecisionCardId, g.topCard.id, g.canDeclareTondo]);
  if (fp === fingerprint) return;
  fingerprint = fp;

  if (g.canDeclareTondo) return send({ type: 'tondo' });
  if (g.turnPlayerId !== me) return;
  if (g.drawnDecisionCardId) {
    return g.playableCardIds.includes(g.drawnDecisionCardId)
      ? play(g, g.drawnDecisionCardId)
      : send({ type: 'pass' });
  }
  if (g.playableCardIds.length) return play(g, g.playableCardIds[0]);
  send({ type: 'draw' });
});
