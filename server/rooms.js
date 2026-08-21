'use strict';

/**
 * Rooms: seating, reconnect tokens and the two clocks the table runs on (a
 * bot's think pause and an away player's turn). The rules live in game.js;
 * nothing here decides whether a move is legal.
 */

const crypto = require('crypto');

const game = require('./game');
const bot = require('./bot');

const CODE_WORDS = [
  'PIZZA', 'DOUGH', 'CRUST', 'BASIL', 'OLIVE',
  'PESTO', 'SAUCE', 'SLICE', 'OVEN', 'TONDO',
];

const TICK_MS = 250;
const BOT_FOLLOWUP_MS = 900; // a shout does not end the turn; a beat, then the move
const BOT_CALLOUT_MS = 1400; // a human gets a beat to remember TONDO first
const AWAY_TURN_MS = 10000; // resolve the turn of a player whose socket went
const EMPTY_ROOM_TTL_MS = 60000;
const MAX_NAME_LENGTH = 16;
const MAX_ROOMS = 500;

let seatCounter = 0;

function nextSeatId() {
  seatCounter += 1;
  return `p${seatCounter}`;
}

function cleanName(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

// ---------------------------------------------------------------------------

class Room {
  constructor(code) {
    this.code = code;
    this.seats = []; // { id, name, isBot, token, socket, connected, disconnectedAt }
    this.hostId = null;
    this.phase = 'lobby'; // 'lobby' | 'playing' | 'roundOver'
    this.game = null;
    this.botDueAt = 0;
    this.awayDueAt = 0;
    this.timedTurnSerial = -1;
    // One 35% roll per bot per open window, and the callouts it produced.
    this.rolledFor = new Set();
    this.calloutPlans = [];
    this.emptySince = 0;
    this.roundCount = 0;
  }

  // -- seats ---------------------------------------------------------------

  humanSeats() {
    return this.seats.filter((s) => !s.isBot);
  }

  connectedHumanSeats() {
    return this.humanSeats().filter((s) => s.connected);
  }

  findSeat(id) {
    return this.seats.find((s) => s.id === id) || null;
  }

  findSeatByToken(token) {
    if (!token) return null;
    const key = String(token);
    return this.seats.find((s) => s.token && s.token === key) || null;
  }

  addSeat({ name, isBot = false, socket = null }) {
    const seat = {
      id: nextSeatId(),
      name,
      isBot,
      // Proves a later socket is the same player. It goes to that one client
      // and nowhere else. A bot has no client, so it needs no token.
      token: isBot ? null : crypto.randomBytes(16).toString('hex'),
      socket,
      connected: isBot ? true : Boolean(socket),
      disconnectedAt: null,
    };
    this.seats.push(seat);
    if (!this.hostId) this.hostId = seat.id;
    return seat;
  }

  /**
   * The host is the first seat. When they go, it passes to the next remaining
   * human — a bot host would be a room nobody can start, since bots have no
   * socket to send `startGame` from.
   */
  reassignHost() {
    if (this.hostId && this.findSeat(this.hostId)) return;
    const next = this.humanSeats()[0] || null;
    this.hostId = next ? next.id : null;
  }

  /**
   * Host powers follow the host while they are here. A host whose socket is
   * gone mid-game keeps the title (they may come back) but must not be able
   * to freeze the table: while they are away any seated human may deal.
   */
  isActingHost(seatId) {
    if (this.hostId === seatId) return true;
    const host = this.findSeat(this.hostId);
    return !host || host.isBot || !host.connected;
  }

  removeSeat(seatId) {
    const index = this.seats.findIndex((s) => s.id === seatId);
    if (index === -1) return;
    const [seat] = this.seats.splice(index, 1);
    if (this.game && this.phase !== 'lobby') {
      game.removePlayer(this.game, seat.id);
      this.finishRoundIfOver();
    }
    this.reassignHost();
    this.scheduleTimers(true);
  }

  // -- round ---------------------------------------------------------------

  startRound() {
    if (this.seats.length < game.MIN_PLAYERS) {
      return { ok: false, error: `You need at least ${game.MIN_PLAYERS} players.` };
    }
    if (this.seats.length > game.MAX_PLAYERS) {
      return { ok: false, error: `A table holds at most ${game.MAX_PLAYERS} players.` };
    }
    this.game = game.createGame(
      this.seats.map((s) => ({ id: s.id, name: s.name, isBot: s.isBot })),
      // The lead rotates round by round so the host does not open every deal.
      { startIndex: this.roundCount++ % this.seats.length }
    );
    this.phase = 'playing';
    this.rolledFor.clear();
    this.calloutPlans = [];
    this.syncConnectionFlags();
    this.scheduleTimers(true);
    return { ok: true };
  }

  finishRoundIfOver() {
    if (this.phase === 'playing' && this.game && this.game.status === 'roundOver') {
      this.phase = 'roundOver';
    }
  }

  /** Copies socket state into the game so every client can show who is here. */
  syncConnectionFlags() {
    if (!this.game) return;
    for (const player of this.game.players) {
      const seat = this.findSeat(player.id);
      player.connected = seat ? seat.connected : false;
    }
  }

  // -- clocks --------------------------------------------------------------

  isLive() {
    return this.phase === 'playing' && this.game && this.game.status === 'playing';
  }

  /** Re-arms the bot pause and the away clock whenever the turn changes. */
  scheduleTimers(force = false) {
    if (!this.isLive()) {
      this.botDueAt = 0;
      this.awayDueAt = 0;
      return;
    }
    const serialChanged = this.game.turnSerial !== this.timedTurnSerial;
    if (!force && !serialChanged) return;
    this.timedTurnSerial = this.game.turnSerial;

    const current = game.currentPlayer(this.game);
    const seat = current ? this.findSeat(current.id) : null;
    const now = Date.now();
    // A forced re-arm inside the same turn keeps a clock that is already
    // running: an unrelated player's disconnect must not rewind the ten
    // seconds an away player has left, or postpone a bot forever.
    const wantBot = Boolean(seat && seat.isBot);
    const wantAway = Boolean(seat && !seat.isBot && !seat.connected);
    this.botDueAt = wantBot ? (serialChanged || !this.botDueAt ? now + bot.thinkMs() : this.botDueAt) : 0;
    this.awayDueAt = wantAway ? (serialChanged || !this.awayDueAt ? now + AWAY_TURN_MS : this.awayDueAt) : 0;
  }

  /**
   * Opens a callout window for every player who just became vulnerable, and
   * closes the ones that are over. The 35% is rolled once per bot per window,
   * so a window nobody won never gets a second chance on the next tick.
   */
  reconcileCallouts(now) {
    if (!this.isLive()) {
      this.rolledFor.clear();
      this.calloutPlans = [];
      return;
    }
    const vulnerable = new Set(
      this.game.players
        .filter((p) => !p.left && p.vulnerable && p.hand.length === 1)
        .map((p) => p.id)
    );
    for (const id of [...this.rolledFor]) if (!vulnerable.has(id)) this.rolledFor.delete(id);
    this.calloutPlans = this.calloutPlans.filter((plan) => vulnerable.has(plan.targetId));

    for (const targetId of vulnerable) {
      if (this.rolledFor.has(targetId)) continue;
      this.rolledFor.add(targetId);
      for (const seat of this.seats) {
        if (!seat.isBot || seat.id === targetId) continue;
        if (bot.wantsCallout()) {
          this.calloutPlans.push({ targetId, botId: seat.id, dueAt: now + BOT_CALLOUT_MS });
        }
      }
    }
  }

  // -- per seat view -------------------------------------------------------

  snapshotFor(seatId) {
    return {
      type: 'state',
      phase: this.phase,
      roomCode: this.code,
      youId: seatId,
      hostId: this.hostId,
      isHost: this.isActingHost(seatId),
      seats: this.seats.map((s) => ({
        id: s.id,
        name: s.name,
        isBot: s.isBot,
        connected: s.connected,
      })),
      game: this.game ? game.viewFor(this.game, seatId) : null,
    };
  }

  broadcast() {
    this.syncConnectionFlags();
    for (const seat of this.seats) {
      if (!seat.socket || seat.socket.readyState !== 1) continue;
      // One broken socket must not cost the other players their state.
      try {
        seat.socket.send(JSON.stringify(this.snapshotFor(seat.id)));
      } catch (err) {
        console.error('[tondo] broadcast failed:', err && err.message);
      }
    }
  }
}

// ---------------------------------------------------------------------------

class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  generateCode() {
    for (let attempt = 0; attempt < 200; attempt++) {
      const word = CODE_WORDS[Math.floor(Math.random() * CODE_WORDS.length)];
      const digits = String(Math.floor(1000 + Math.random() * 9000));
      const code = `${word}-${digits}`;
      if (!this.rooms.has(code)) return code;
    }
    return `PIZZA-${Date.now().toString().slice(-4)}`;
  }

  getRoom(code) {
    return this.rooms.get(String(code || '').trim().toUpperCase()) || null;
  }

  createRoom(name, socket) {
    const cleaned = cleanName(name);
    if (!cleaned) return { ok: false, error: 'Enter your name first.' };
    if (this.rooms.size >= MAX_ROOMS) {
      return { ok: false, error: 'The pizzeria is full. Try again in a minute.' };
    }
    const room = new Room(this.generateCode());
    this.rooms.set(room.code, room);
    const seat = room.addSeat({ name: cleaned, socket });
    return { ok: true, room, seat };
  }

  joinRoom(code, name, socket, token) {
    const cleaned = cleanName(name);
    if (!cleaned) return { ok: false, error: 'Enter your name first.' };
    const room = this.getRoom(code);
    if (!room) return { ok: false, error: 'No table has that code.' };

    // A token is the key to one seat. Only the client that was given it may
    // sit back down, so nobody can walk into another player's hand. The token
    // outranks a lingering socket: after a half-open drop the server can
    // believe the old socket is alive for up to a heartbeat, and refusing the
    // rightful owner for that long would cost them their seat. Take it over.
    const claimed = room.findSeatByToken(token);
    if (claimed) {
      const ghost = claimed.socket;
      if (claimed.connected && ghost && ghost !== socket) {
        claimed.socket = null; // detach first so the ghost's close is a no-op
        try { ghost.terminate(); } catch { /* already dead */ }
      }
      claimed.socket = socket;
      claimed.connected = true;
      claimed.disconnectedAt = null;
      room.emptySince = 0;
      room.syncConnectionFlags();
      room.scheduleTimers(true);
      return { ok: true, room, seat: claimed, reconnected: true };
    }

    if (room.phase === 'playing') {
      return { ok: false, error: 'That round is being played. Wait for the next one.' };
    }
    if (room.seats.length >= game.MAX_PLAYERS) {
      return { ok: false, error: 'That table is full.' };
    }
    // Lobby or round over: either way there is a seat to take before the deal.
    const seat = room.addSeat({ name: cleaned, socket });
    room.emptySince = 0;
    return { ok: true, room, seat };
  }

  /** A socket closed. In the lobby the seat goes; mid-game it waits. */
  handleDisconnect(room, seat, socket = null) {
    if (!room || !seat) return;
    // A close event can arrive after a reconnect took the seat over. Only the
    // socket that still holds the seat may vacate it.
    if (socket && seat.socket && seat.socket !== socket) return;
    seat.socket = null;
    seat.connected = false;
    seat.disconnectedAt = Date.now();

    if (room.phase === 'lobby') room.removeSeat(seat.id);
    else room.scheduleTimers(true);

    if (room.connectedHumanSeats().length === 0) room.emptySince = Date.now();
    room.broadcast();
    this.cleanupIfEmpty(room);
  }

  /** Drops a room with no human seats left at all. */
  cleanupIfEmpty(room) {
    if (room.humanSeats().length > 0) return false;
    // Codes come back into use, so only ever delete this very room.
    if (this.rooms.get(room.code) === room) this.rooms.delete(room.code);
    return true;
  }

  // -- moves ---------------------------------------------------------------

  applyAction(room, seatId, message) {
    if (!room.game) return { ok: false, error: 'The round has not started.' };
    const state = room.game;
    let result;

    switch (message.type || message.action) {
      case 'play':
        result = game.playCard(state, seatId, message.cardId, message.suit);
        break;
      case 'draw':
        result = game.drawCard(state, seatId);
        break;
      case 'pass':
        result = game.passTurn(state, seatId);
        break;
      case 'tondo':
        result = game.declareTondo(state, seatId);
        break;
      case 'callout':
        result = game.callOut(state, seatId, message.targetId);
        break;
      default:
        return { ok: false, error: 'Unknown action.' };
    }

    if (result.ok) {
      room.finishRoundIfOver();
      room.scheduleTimers();
      room.reconcileCallouts(Date.now());
    }
    return result;
  }

  // -- clocks --------------------------------------------------------------

  tick() {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      // One bad table must never stop the clocks of every other table.
      try {
        this.tickRoom(room, now);
      } catch (err) {
        console.error('[tondo] room tick failed:', err);
      }
    }
  }

  tickRoom(room, now) {
    if (room.humanSeats().length === 0) {
      this.cleanupIfEmpty(room);
      return;
    }
    // The TTL is armed here, from observed state, so no seat-removal path can
    // forget it: a room with humans on paper but none connected is counting
    // down, and one reconnect resets the count.
    if (room.connectedHumanSeats().length === 0) {
      if (!room.emptySince) room.emptySince = now;
    } else {
      room.emptySince = 0;
    }
    if (room.emptySince && now - room.emptySince > EMPTY_ROOM_TTL_MS) {
      if (this.rooms.get(room.code) === room) this.rooms.delete(room.code);
      return;
    }
    if (!room.isLive()) return;

    let changed = false;
    room.scheduleTimers();
    room.reconcileCallouts(now);

    // A bot notices a missed TONDO, one second after the window opened.
    for (const plan of [...room.calloutPlans]) {
      if (now < plan.dueAt) continue;
      room.calloutPlans = room.calloutPlans.filter((p) => p !== plan);
      // The bot decides from its own view, exactly like a human would.
      const view = game.viewFor(room.game, plan.botId);
      if (!view.calloutTargets.includes(plan.targetId)) continue;
      if (this.applyAction(room, plan.botId, { type: 'callout', targetId: plan.targetId }).ok) {
        changed = true;
      }
    }

    // A bot takes its turn.
    if (room.isLive() && room.botDueAt && now >= room.botDueAt) {
      room.botDueAt = 0;
      const current = game.currentPlayer(room.game);
      const before = room.game.turnSerial;
      const move = bot.decide(game.viewFor(room.game, current.id));
      if (move) this.applyAction(room, current.id, { type: move.action, ...move });
      else game.drawCard(room.game, current.id);
      room.finishRoundIfOver();
      room.scheduleTimers(true);
      // A TONDO shout leaves the turn where it was, so wind the pause back up
      // or the bot would sit there for ever.
      if (room.isLive() && room.game.turnSerial === before) {
        room.botDueAt = now + BOT_FOLLOWUP_MS;
      }
      changed = true;
    }

    // The player on turn is gone: draw one, keep it, move on.
    if (room.isLive() && room.awayDueAt && now >= room.awayDueAt) {
      room.awayDueAt = 0;
      const current = game.currentPlayer(room.game);
      game.autoTurn(room.game, current.id);
      room.finishRoundIfOver();
      room.scheduleTimers(true);
      changed = true;
    }

    if (changed) room.broadcast();
  }
}

module.exports = {
  Room,
  RoomManager,
  CODE_WORDS,
  TICK_MS,
  AWAY_TURN_MS,
  EMPTY_ROOM_TTL_MS,
  BOT_CALLOUT_MS,
};
