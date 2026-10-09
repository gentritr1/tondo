'use strict';

/**
 * A real household, through one address: 4 players at one table, each
 * mistyping a code twice and reconnecting 3 times (closing the socket and
 * reclaiming the seat by token). Every budget in server/limits.js must let all
 * of it through. Prints the counts and exits 1 on ANY refusal.
 *
 *   node server/index.js &   then   node scripts/household-storm.js
 */

const WebSocket = require('ws');

const URL = process.env.TONDO_URL || `ws://localhost:${process.env.PORT || 4600}`;
const counts = { connects: 0, wrongCodes: 0, reconnects: 0, refusals: 0 };

function open() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.once('open', () => { counts.connects++; resolve(ws); });
    ws.once('unexpected-response', (_q, res) => { counts.refusals++; reject(new Error(`upgrade refused: HTTP ${res.statusCode}`)); });
    ws.once('error', reject);
  });
}
function next(ws, pred) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no answer in 5s')), 5000);
    const on = (raw) => { const m = JSON.parse(raw.toString()); if (pred(m)) { clearTimeout(t); ws.off('message', on); resolve(m); } };
    ws.on('message', on);
  });
}
const send = (ws, m) => ws.send(JSON.stringify(m));
const close = (ws) => new Promise((r) => { ws.once('close', r); ws.close(); });

(async () => {
  const host = await open();
  send(host, { type: 'createRoom', name: 'Host' });
  const made = await next(host, (m) => m.type === 'joined');
  const players = [{ ws: host, name: 'Host', token: made.token }];
  for (const name of ['Arta', 'Dren', 'Vesa']) {
    const ws = await open();
    send(ws, { type: 'joinRoom', code: made.roomCode, name });
    const j = await next(ws, (m) => m.type === 'joined' || m.type === 'error');
    if (j.type === 'error') throw new Error(`${name} could not join: ${j.message}`);
    players.push({ ws, name, token: j.token });
  }
  for (const p of players) {
    for (let i = 0; i < 2; i++) {
      const probe = await open();
      send(probe, { type: 'joinRoom', code: 'TYPO-0000', name: p.name });
      const e = await next(probe, (m) => m.type === 'error');
      if (e.message !== 'No table has that code.') { counts.refusals++; throw new Error(`${p.name} mistype refused: ${e.message}`); }
      counts.wrongCodes++;
      await close(probe);
    }
  }
  for (const p of players) {
    for (let i = 0; i < 3; i++) {
      await close(p.ws);
      p.ws = await open();
      send(p.ws, { type: 'joinRoom', code: made.roomCode, name: p.name, token: p.token });
      const j = await next(p.ws, (m) => m.type === 'joined' || m.type === 'error');
      if (j.type === 'error') { counts.refusals++; throw new Error(`${p.name} reconnect refused: ${j.message}`); }
      counts.reconnects++;
    }
  }
  console.log(`household-storm: ${JSON.stringify(counts)}`);
  for (const p of players) await close(p.ws);
  process.exit(counts.refusals ? 1 : 0);
})().catch((err) => {
  console.error(`household-storm FAIL: ${err.message} ${JSON.stringify(counts)}`);
  process.exit(1);
});
