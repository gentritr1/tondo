'use strict';

/**
 * Tondo server: the client out of /public over http, and the authoritative
 * game over one WebSocket on the same port. See PROTOCOL.md.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const game = require('./game');
const bot = require('./bot');
const { RoomManager } = require('./rooms');

const PORT = Number(process.env.PORT) || 4600;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const manager = new RoomManager();

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

/** Static files, and nothing clever: no gzip, no caching, no directory walk. */
function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return notFound(res);
  }
  if (pathname === '/') pathname = '/index.html';

  const filePath = path.join(PUBLIC_DIR, pathname);
  // `..` in a URL must never reach outside the public folder.
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return notFound(res);
  }
  const type = MIME[path.extname(filePath).toLowerCase()];
  if (!type) return notFound(res);

  fs.readFile(filePath, (err, body) => {
    if (err) return notFound(res);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
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

// A game message is a few hundred bytes. Anything larger is not a player.
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

function send(socket, payload) {
  if (socket.readyState === 1) socket.send(JSON.stringify(payload));
}

function sendError(socket, message) {
  send(socket, { type: 'error', message });
}

wss.on('connection', (socket) => {
  const session = { room: null, seatId: null };

  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });

  socket.on('message', (raw) => {
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
      manager.handleDisconnect(room, seat);
    } catch (err) {
      console.error('[tondo] disconnect failed:', err);
    }
  });

  socket.on('error', () => { /* the close handler does the cleanup */ });
});

function handleMessage(socket, session, message) {
  // ---- joining ----------------------------------------------------------
  if (message.type === 'createRoom' || message.type === 'joinRoom') {
    if (session.room) {
      const oldRoom = session.room;
      const oldSeat = oldRoom.findSeat(session.seatId);
      session.room = null;
      session.seatId = null;
      manager.handleDisconnect(oldRoom, oldSeat);
    }
    const result = message.type === 'createRoom'
      ? manager.createRoom(message.name, socket)
      : manager.joinRoom(message.code, message.name, socket, message.token);

    if (!result.ok) return sendError(socket, result.error);

    session.room = result.room;
    session.seatId = result.seat.id;
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
    // ---- lobby ---------------------------------------------------------
    case 'addBot': {
      if (room.hostId !== seatId) return sendError(socket, 'Only the host can add a bot.');
      if (room.phase !== 'lobby') return sendError(socket, 'Bots only join in the lobby.');
      if (room.seats.length >= game.MAX_PLAYERS) return sendError(socket, 'The table is full.');
      room.addSeat({ name: bot.pickBotName(room.seats.map((s) => s.name)), isBot: true });
      break;
    }
    case 'removeSeat': {
      if (room.hostId !== seatId) return sendError(socket, 'Only the host can remove a seat.');
      if (room.phase !== 'lobby') return sendError(socket, 'Seats only change in the lobby.');
      const target = room.findSeat(message.seatId);
      if (!target) return sendError(socket, 'That seat is empty.');
      if (!target.isBot) return sendError(socket, 'You can only remove bots.');
      room.removeSeat(target.id);
      break;
    }
    case 'startGame': {
      if (room.hostId !== seatId) return sendError(socket, 'Only the host can start the game.');
      if (room.phase !== 'lobby') return sendError(socket, 'The game already started.');
      const started = room.startRound();
      if (!started.ok) return sendError(socket, started.error);
      break;
    }
    case 'newRound': {
      if (room.hostId !== seatId) return sendError(socket, 'Only the host can deal again.');
      if (room.phase !== 'roundOver') return sendError(socket, 'The round is not over.');
      const started = room.startRound();
      if (!started.ok) return sendError(socket, started.error);
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
      if (room.phase !== 'playing') return sendError(socket, 'The round is not running.');
      const result = manager.applyAction(room, seatId, message);
      if (!result.ok) {
        sendError(socket, result.error);
        // Put the client's picture back in step with the server.
        send(socket, room.snapshotFor(seatId));
        return;
      }
      break;
    }

    case 'sync':
      send(socket, room.snapshotFor(seatId));
      return;

    default:
      return sendError(socket, `Unknown message: ${message.type}`);
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
