'use strict';

/**
 * Tondo server: the client out of /public over http, and the authoritative
 * game over one WebSocket on the same port. See PROTOCOL.md.
 */

const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const game = require('./game');
const bot = require('./bot');
const { RoomManager } = require('./rooms');
const { Assets } = require('./assets');
const { SocketLimits, maxSocketsPerIp } = require('./limits');
const { clientIpFrom } = require('./clientip');

const PORT = Number(process.env.PORT) || 4600;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const manager = new RoomManager();
const assets = new Assets(PUBLIC_DIR);

/* The design reference (`_ref.html`, 1.7MB) and the concept pages are working
   material, not the product. They stay reachable while developing and are 404
   in production so they are never served to a player. */
const DEV_ONLY = /^\/(_ref\.html|_concept\/)/;
const IS_PROD = process.env.NODE_ENV === 'production';

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

/**
 * Static files: compressed, revalidated with an ETag, and — where the URL
 * carries the content hash the server itself stamped in — cached for a year.
 * See server/assets.js for why the hash is transitive.
 */
function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);

  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return notFound(res);
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return notFound(res);
  }
  if (pathname === '/') pathname = '/index.html';
  if (IS_PROD && DEV_ONLY.test(pathname)) return notFound(res);

  const filePath = path.join(PUBLIC_DIR, pathname);
  // `..` in a URL must never reach outside the public folder.
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return notFound(res);
  }
  const type = MIME[path.extname(filePath).toLowerCase()];
  if (!type) return notFound(res);

  const out = assets.serve(filePath, {
    accept: req.headers['accept-encoding'] || '',
    versionQuery: url.searchParams.get('v'),
  });
  if (!out) return notFound(res);

  // A matching ETag means the bytes the browser already holds are current:
  // answer 304 and send no body at all. This is the cheapest possible hit.
  const headers = {
    'Content-Type': type,
    'Cache-Control': out.cacheControl,
    ETag: out.etag,
    Vary: 'Accept-Encoding',
  };
  if (req.headers['if-none-match'] === out.etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  if (out.encoding) headers['Content-Encoding'] = out.encoding;
  headers['Content-Length'] = out.body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : out.body);
}

const server = http.createServer((req, res) => {
  try {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: manager.rooms.size }));
      return;
    }
    serveStatic(req, res);
  } catch (err) {
    console.error('[tondo] request failed:', err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Server error');
  }
});

/** The peer address, with IPv4-mapped IPv6 folded onto the plain form so
 *  127.0.0.1 and ::ffff:127.0.0.1 count as the same household. Behind a
 *  proxy, see server/clientip.js. */
function clientIp(req) {
  return clientIpFrom(req);
}

/**
 * Who may open a socket at all.
 *
 * There was no Origin check, so any page a player happened to visit could open
 * a socket to this server from inside their network — including to a LAN-only
 * instance that is not reachable from the internet at all — and drive it from
 * their browser: fill every room slot, flood it, sweep the room codes. A
 * WebSocket upgrade is not covered by CORS, so nothing else was stopping it.
 *
 * An ABSENT Origin is allowed: that is a native client, a test harness, the
 * smoke scripts and the probes — none of them is a browser being driven by a
 * page the player did not mean to trust. A PRESENT Origin must have the same
 * host:port the request was addressed to, which is what the game's own page
 * always sends, by IP as readily as by name — LAN play (a phone opening
 * http://192.168.1.7:4600) sends `Origin: http://192.168.1.7:4600` against
 * `Host: 192.168.1.7:4600` and matches.
 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return false; // an Origin we cannot even parse is not our own page
  }
  return Boolean(host) && host === req.headers.host;
}

/**
 * How many sockets this address already holds. Counted from the LIVE sockets
 * rather than from a tally kept by hand, so an upgrade that dies between
 * `verifyClient` and `connection` cannot leak a slot that never opened. ws
 * completes a synchronous `verifyClient` and emits `connection` in the same
 * call stack, so a socket admitted here is counted before the next upgrade is
 * judged — the measured proof is that 1,200 parallel connects from one address
 * yielded exactly 32 open sockets and 1,168 refusals.
 */
function socketsFromIp(ip) {
  let n = 0;
  for (const client of wss.clients) if (client.tondoIp === ip) n += 1;
  return n;
}

// A game message is a few hundred bytes. Anything larger is not a player.
const wss = new WebSocketServer({
  server,
  maxPayload: 16 * 1024,
  verifyClient: (info) => {
    if (!originAllowed(info.req)) {
      console.warn(`[tondo] upgrade refused: Origin ${info.req.headers.origin} != Host ${info.req.headers.host}`);
      return false;
    }
    const ip = clientIp(info.req);
    if (socketsFromIp(ip) >= maxSocketsPerIp()) {
      console.warn(`[tondo] upgrade refused: ${ip} already holds ${maxSocketsPerIp()} sockets`);
      return false;
    }
    return true;
  },
});

function send(socket, payload) {
  if (socket.readyState === 1) socket.send(JSON.stringify(payload));
}

function sendError(socket, message) {
  send(socket, { type: 'error', message });
}

/** PROTOCOL.md: a refused seated message ships an `error` plus a fresh
 *  snapshot, so a client that got out of step is put back in it. */
function refuse(socket, room, seatId, message) {
  sendError(socket, message);
  send(socket, room.snapshotFor(seatId));
}

wss.on('connection', (socket, req) => {
  // Every budget this connection has. Per socket, never per IP: four friends on
  // one phone network must not share a message allowance.
  const session = { room: null, seatId: null, limits: new SocketLimits() };
  socket.tondoIp = clientIp(req);

  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });

  socket.on('message', (raw) => {
    // The budget is spent BEFORE the frame is parsed, so a flood of garbage
    // costs the same as a flood of valid JSON.
    const verdict = session.limits.admit();
    if (verdict === 'close') {
      sendError(socket, 'Too many messages. Closing this connection.');
      socket.close(1008, 'rate limit');
      return;
    }
    if (verdict === 'slow') {
      if (session.limits.shouldAnswerRefusal()) sendError(socket, 'Slow down — too many messages at once.');
      return;
    }
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      sendError(socket, 'Malformed message.');
      return;
    }
    if (!message || typeof message.type !== 'string') {
      sendError(socket, 'Malformed message.');
      return;
    }
    try {
      handleMessage(socket, session, message);
    } catch (err) {
      console.error('[tondo] action failed:', err);
      sendError(socket, 'The kitchen had a problem with that.');
    }
  });

  socket.on('close', () => {
    const room = session.room;
    const seat = room ? room.findSeat(session.seatId) : null;
    session.room = null;
    session.seatId = null;
    if (!room || !seat) return;
    try {
      // The socket rides along so a close that arrives after a reconnect took
      // the seat over cannot vacate the new owner.
      manager.handleDisconnect(room, seat, socket);
    } catch (err) {
      console.error('[tondo] disconnect failed:', err);
    }
  });

  socket.on('error', () => { /* the close handler does the cleanup */ });
});

function handleMessage(socket, session, message) {
  // ---- joining ----------------------------------------------------------
  if (message.type === 'createRoom' || message.type === 'joinRoom') {
    const limits = session.limits;
    /* One socket used to be able to take every one of the 500 room slots in
       under half a second, and the rooms survived it leaving because a game in
       progress keeps its seats. A player creates one table. */
    if (message.type === 'createRoom' && !limits.canCreateRoom()) {
      return sendError(socket, 'You have opened enough tables. Join one instead.');
    }
    /* Wrong codes are rationed, which is what ends a sweep of the code space —
       and the refusal is deliberately the same whatever the code was, so it
       tells an attacker nothing a silent drop would not. */
    if (message.type === 'joinRoom' && !limits.canTryJoin()) {
      return sendError(socket, 'Too many wrong table codes. Wait a moment and try again.');
    }

    // The new table is granted BEFORE the old seat is torn down: a bad code
    // or a full house must not leave the sender seatless.
    const result = message.type === 'createRoom'
      ? manager.createRoom(message.name, socket)
      : manager.joinRoom(message.code, message.name, socket, message.token);

    if (!result.ok) {
      // Any failed join costs a token, not only "no such code": "that round is
      // being played" is just as good an oracle for "this table exists".
      if (message.type === 'joinRoom') limits.countJoinFailure();
      return sendError(socket, result.error);
    }
    if (message.type === 'createRoom') limits.countRoomCreated();

    const oldRoom = session.room;
    const oldSeat = oldRoom ? oldRoom.findSeat(session.seatId) : null;
    session.room = result.room;
    session.seatId = result.seat.id;
    if (oldRoom && oldSeat && (oldRoom !== result.room || oldSeat.id !== result.seat.id)) {
      manager.handleDisconnect(oldRoom, oldSeat);
    }
    send(socket, {
      type: 'joined',
      roomCode: result.room.code,
      youId: result.seat.id,
      token: result.seat.token,
      reconnected: Boolean(result.reconnected),
    });
    result.room.broadcast();
    return;
  }

  const room = session.room;
  const seatId = session.seatId;
  if (!room || !seatId) return sendError(socket, 'Join a table first.');
  const seat = room.findSeat(seatId);
  if (!seat) return sendError(socket, 'Your seat is gone. Please join again.');

  switch (message.type) {
    // ---- lobby (and between rounds) ------------------------------------
    case 'addBot': {
      if (!room.isActingHost(seatId)) return refuse(socket, room, seatId, 'Only the host can add a bot.');
      if (room.phase === 'playing') return refuse(socket, room, seatId, 'Bots join between rounds.');
      if (room.seats.length >= game.MAX_PLAYERS) return refuse(socket, room, seatId, 'The table is full.');
      room.addSeat({ name: bot.pickBotName(room.seats.map((s) => s.name)), isBot: true });
      break;
    }
    case 'removeSeat': {
      if (!room.isActingHost(seatId)) return refuse(socket, room, seatId, 'Only the host can remove a seat.');
      if (room.phase === 'playing') return refuse(socket, room, seatId, 'Seats only change between rounds.');
      const target = room.findSeat(message.seatId);
      if (!target) return refuse(socket, room, seatId, 'That seat is empty.');
      if (!target.isBot) return refuse(socket, room, seatId, 'You can only remove bots.');
      room.removeSeat(target.id);
      break;
    }
    case 'startGame': {
      if (!room.isActingHost(seatId)) return refuse(socket, room, seatId, 'Only the host can start the game.');
      if (room.phase !== 'lobby') return refuse(socket, room, seatId, 'The game already started.');
      const started = room.startRound();
      if (!started.ok) return refuse(socket, room, seatId, started.error);
      break;
    }
    case 'newRound': {
      /* ANY seated human may deal the next slice — not only the host. A table
         used to stall because one specific person had walked away from their
         phone, and everyone else was shown "waiting for the host" with no
         control at all. Dealing is not a destructive act and the round is
         already over; there is nothing here worth gating on a title. */
      if (seat.isBot) return refuse(socket, room, seatId, 'Bots do not deal.');
      if (room.phase !== 'roundOver') return refuse(socket, room, seatId, 'The round is not over.');
      const started = room.startRound();
      if (!started.ok) return refuse(socket, room, seatId, started.error);
      break;
    }
    case 'hold': {
      // "Not yet" — stops the between-slices countdown until somebody deals.
      if (seat.isBot) return refuse(socket, room, seatId, 'Bots do not hold the table.');
      if (room.phase !== 'roundOver') return refuse(socket, room, seatId, 'Nothing to hold.');
      room.holdNextSlice();
      break;
    }
    case 'leaveRoom': {
      room.removeSeat(seatId);
      session.room = null;
      session.seatId = null;
      send(socket, { type: 'left' });
      room.broadcast();
      manager.cleanupIfEmpty(room);
      return;
    }

    // ---- game moves ----------------------------------------------------
    case 'play':
    case 'draw':
    case 'pass':
    case 'tondo':
    case 'callout': {
      if (room.phase !== 'playing') return refuse(socket, room, seatId, 'The round is not running.');
      const result = manager.applyAction(room, seatId, message);
      if (!result.ok) return refuse(socket, room, seatId, result.error);
      break;
    }

    case 'sync':
      send(socket, room.snapshotFor(seatId));
      return;

    default:
      return refuse(socket, room, seatId, `Unknown message: ${message.type}`);
  }

  room.broadcast();
}

// Drop sockets that stopped answering.
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30000);
if (heartbeat.unref) heartbeat.unref();

/**
 * Brotli q11 is expensive (223ms for styles.css on a dev machine) and this one
 * process also holds every player's WebSocket, so paying for it lazily meant
 * the first visitor after a restart froze the whole game: a `sync` round-trip
 * sampled through the first compression of styles.css went from 0.03ms to
 * 230ms. Pay it here instead, before the port is even open — nobody is playing
 * yet, and the quality (and therefore the bytes) stays exactly the same.
 *
 * Only URLs this server would actually serve are warmed: the dev-only design
 * reference (`_ref.html`, 1.7MB) and the concept pages are left lazy so a dev
 * restart does not wait on 1.7MB of q11.
 */
function warmAssets() {
  const report = assets.warm((pathname) => {
    if (DEV_ONLY.test(pathname)) return false;
    return Boolean(MIME[path.extname(pathname).toLowerCase()]);
  });
  const note = report.failed.length ? ` — FAILED (served raw): ${report.failed.join(', ')}` : '';
  console.log(`  precompressed ${report.files} text files `
    + `(${report.br} br + ${report.gzip} gzip, ${report.raw} too small to compress) `
    + `in ${report.ms.toFixed(0)}ms${note}`);
}

try {
  warmAssets();
} catch (err) {
  // Warming is an optimisation. Never a reason not to open the pizzeria.
  console.error('[tondo] asset warm-up failed, falling back to lazy:', err && err.message);
}

server.listen(PORT, () => {
  console.log(`\n  Tondo is open. http://localhost:${PORT}\n`);
});

function shutdown() {
  clearInterval(heartbeat);
  manager.stop();
  for (const socket of wss.clients) socket.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { server, manager };
