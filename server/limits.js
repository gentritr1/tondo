'use strict';

/**
 * What one socket is allowed to do.
 *
 * The threat is not a botnet. It is one connection, with no authentication,
 * doing something a player never does: 20,000 `sync` frames in 2.6s (300KB in,
 * 36.8MB out — 123x amplification), or `createRoom`+`addBot`+`startGame` in a
 * loop until all 500 room slots are gone and real friends are told the pizzeria
 * is full, or sweeping the whole room-code space in two seconds — which does
 * not merely DETECT other people's tables, it seats you at them.
 *
 * The shape of the defence is set by what this game is for: four friends in one
 * room, on their phones, behind ONE public IP. A per-IP limit sized for one
 * person would break the primary use case, which is worse than the attack it
 * prevents. So message rate and table creation are PER SOCKET, where a
 * legitimate player has enormous headroom and an attacker has none; wrong
 * codes, connection attempts and concurrent sockets are PER ADDRESS, because a
 * reconnect is free and would refill anything kept on the socket — and every
 * one of those numbers is sized for a household behind one NAT (see BUDGETS),
 * where a LAN party cannot reach it.
 *
 * Every budget below is a measured multiple of real play, not a guess:
 * `scripts/host-smoke.js` and `scripts/table-smoke.js` drive whole matches, and
 * the probes in `scripts/probes/` connect as real clients. A client sends on a
 * tap. The fastest burst a human can produce is a tap and its follow-up
 * snapshot — units of messages, not tens.
 */

/* 20 messages a second, bursting to 40. A player taps a card, maybe spams the
   draw pile; a client never exceeds a handful per second. 20/s is an order of
   magnitude above play and still two orders below a flood (the amplification
   attack put 20,000 frames on the wire in 323ms = 62,000/s). */
const MSG_RATE_PER_S = 20;
const MSG_BURST = 40;

/* Over budget we answer with the ordinary `error` message and keep the socket
   open, because a legitimate client that somehow got there should recover. But
   an error reply is itself bytes out: a flood answered one-for-one is still an
   amplifier, just a cheaper one. So we tell them the first few times and then
   drop silently. */
const REFUSAL_REPLIES = 10;

/* Sustained abuse closes the socket. 500 refused messages is 25 seconds of
   budget thrown away in one breath; a legitimate client never produces one. */
const REFUSALS_BEFORE_CLOSE = 500;

/* A legitimate player creates one table. Three is generous — it covers "I made
   it before my friend was ready" twice over. */
const MAX_ROOMS_PER_SOCKET = 3;

/* Concurrent sockets from one IP. NOT tighter, deliberately: the four friends
   this game exists for are in the same room sharing one NAT, a LAN party or a
   student flat is more, and every player's phone reconnects (a new socket) on
   every backgrounding, so the live count for one household is already several
   times the number of people. 32 is far above any real household and far below
   the 1,200 one attacker opened without being refused. Overridable with
   TONDO_MAX_SOCKETS_PER_IP for anyone running this behind a single proxy IP,
   where every player on earth looks like one address. */
const DEFAULT_MAX_SOCKETS_PER_IP = 32;

function maxSocketsPerIp() {
  const raw = Number(process.env.TONDO_MAX_SOCKETS_PER_IP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_SOCKETS_PER_IP;
}

/** One socket's budgets. Lives and dies with the connection. */
class SocketLimits {
  constructor(now = Date.now()) {
    this.msgTokens = MSG_BURST;
    this.msgRefilledAt = now;
    this.refusals = 0;
    this.refusalReplies = 0;
    this.roomsCreated = 0;
  }

  /**
   * One inbound message. 'ok' | 'slow' (refuse it, keep the socket) |
   * 'close' (sustained abuse). Called BEFORE the frame is even parsed, so a
   * flood of garbage is as cheap as a flood of JSON.
   */
  admit(now = Date.now()) {
    const elapsed = Math.max(0, now - this.msgRefilledAt);
    this.msgTokens = Math.min(MSG_BURST, this.msgTokens + (elapsed * MSG_RATE_PER_S) / 1000);
    this.msgRefilledAt = now;
    if (this.msgTokens >= 1) {
      this.msgTokens -= 1;
      return 'ok';
    }
    this.refusals += 1;
    return this.refusals >= REFUSALS_BEFORE_CLOSE ? 'close' : 'slow';
  }

  /** Whether this refusal is still worth answering, or should just be dropped. */
  shouldAnswerRefusal() {
    if (this.refusalReplies >= REFUSAL_REPLIES) return false;
    this.refusalReplies += 1;
    return true;
  }

  canCreateRoom() {
    return this.roomsCreated < MAX_ROOMS_PER_SOCKET;
  }

  countRoomCreated() {
    this.roomsCreated += 1;
  }
}

/**
 * Budgets kept per ADDRESS, which outlive any one socket.
 *
 * The wrong-code ration used to live on SocketLimits, created fresh per
 * connection — so "5 free wrong codes" really meant "5 per reconnect", and a
 * reconnect is free. These buckets are keyed by address (server/clientip.js)
 * and kept in a bounded LRU so one address cannot grow the map without limit.
 *
 * Every number is set from a scenario a real household produces, then checked
 * by scripts/household-storm.js (4 players on one network, 3 reconnects and 2
 * mistyped codes each), which must show zero refusals (measured 2026-10-10:
 * household-storm: {"connects":24,"wrongCodes":8,"reconnects":12,"refusals":0}):
 *   connect     64 burst, 1/s    2x the 32-socket concurrent cap: a full
 *                                household can reconnect completely twice at once
 *   joinFail    10 burst, 1/2s   4 players x 2 mistypes, plus 2 spare
 *   crewRead    60 burst, 1/s    a household opening the crew link together and refreshing
 *   crewCreate  10 burst, 10/h   a player makes one crew; ten is generous
 */
const BUDGETS = {
  connect: { burst: 64, perMs: 1000 },
  joinFail: { burst: 10, perMs: 2000 },
  crewRead: { burst: 60, perMs: 1000 },
  crewCreate: { burst: 10, perMs: 360000 },
};

class IpBudget {
  constructor({ burst, perMs, maxKeys = 10000 }) {
    this.burst = burst;
    this.perMs = perMs;
    this.maxKeys = maxKeys;
    this.buckets = new Map(); // insertion order = recency (oldest first)
  }

  bucket(ip, now) {
    const key = String(ip || '');
    let b = this.buckets.get(key);
    if (b) {
      this.buckets.delete(key); // re-insert to mark as most recent
      b.tokens = Math.min(this.burst, b.tokens + Math.max(0, now - b.at) / this.perMs);
      b.at = now;
    } else {
      b = { tokens: this.burst, at: now };
      if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value);
    }
    this.buckets.set(key, b);
    return b;
  }

  allow(ip, now = Date.now()) { return this.bucket(ip, now).tokens >= 1; }

  spend(ip, now = Date.now()) {
    const b = this.bucket(ip, now);
    b.tokens = Math.max(0, b.tokens - 1);
  }

  take(ip, now = Date.now()) {
    const b = this.bucket(ip, now);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  size() { return this.buckets.size; }
}

function createIpBudgets() {
  return Object.fromEntries(Object.entries(BUDGETS).map(([k, v]) => [k, new IpBudget(v)]));
}

module.exports = {
  SocketLimits,
  maxSocketsPerIp,
  MSG_RATE_PER_S,
  MSG_BURST,
  REFUSALS_BEFORE_CLOSE,
  MAX_ROOMS_PER_SOCKET,
  IpBudget,
  createIpBudgets,
  BUDGETS,
  DEFAULT_MAX_SOCKETS_PER_IP,
};
