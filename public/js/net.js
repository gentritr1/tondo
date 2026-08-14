/**
 * WebSocket connection with automatic reconnect.
 *
 * The client keeps the name, the table code and the seat token, so a short
 * network drop puts the player back in the same seat without any action from
 * them. The token proves the seat is theirs and stays in this tab only:
 * `sessionStorage` survives a reload and is dropped when the tab closes.
 *
 * The four states, in order:
 *
 *   disconnected — no socket (first load, or waiting on the retry timer)
 *   connecting   — a socket is opening
 *   joining      — the socket is open and a `joinRoom` is in flight
 *   synchronized — a `joined` AND the first `state` after it have landed
 *
 * With no seat to reclaim (the home screen) an open socket goes straight to
 * `synchronized`: there is no table to be out of step with.
 *
 * Nothing is queued. Every message that only means something inside a
 * particular round is DROPPED while not synchronized, and `send` returns false
 * so the caller can say so. Replaying a card chosen in a round that has since
 * ended is worse than losing the tap.
 */

const RETRY_STEPS = [500, 1000, 2000, 3000, 5000];
const SEAT_KEY = 'tondo.seat.';

/** Wire names whose meaning depends on the state of a round or a lobby.
 *  `createRoom`, `joinRoom` and `sync` are how a client GETS synchronized. */
const STATE_DEPENDENT = new Set([
  'play', 'draw', 'pass', 'tondo', 'callout',
  'startGame', 'newRound', 'addBot', 'removeSeat', 'leaveRoom',
]);

const seatKey = (code) => SEAT_KEY + String(code || '').toUpperCase();

/** Storage is not always there (private windows), so every call is guarded. */
function readSeat(code) {
  try { return JSON.parse(sessionStorage.getItem(seatKey(code)) || 'null'); } catch { return null; }
}
function writeSeat(code, value) {
  try {
    if (value) sessionStorage.setItem(seatKey(code), JSON.stringify(value));
    else sessionStorage.removeItem(seatKey(code));
  } catch { /* nowhere to keep it */ }
}

export class Connection {
  constructor({ onMessage, onStatus }) {
    this.onMessage = onMessage;
    this.onStatus = onStatus || (() => {});
    this.socket = null;
    this.retry = 0;
    this.retryTimer = 0;
    this.credentials = null; // { name, code, token }
    this.state = 'disconnected';
    // Every socket owns one generation; replacing a socket invalidates its
    // late events, including a join reply for a table the player just left.
    this.generation = 0;
    // True between a `joined` and the first `state` after it. Only that pair,
    // in that order, closes the gate.
    this.awaitingFirstState = false;
  }

  setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.onStatus(next);
  }

  get synchronized() { return this.state === 'synchronized' && !this.awaitingFirstState; }

  get url() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}`;
  }

  connect() {
    clearTimeout(this.retryTimer);
    this.retryTimer = 0;
    this.awaitingFirstState = false;
    this.setState('connecting');

    const socket = new WebSocket(this.url);
    const generation = ++this.generation;
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (generation !== this.generation) return;
      this.retry = 0;
      if (this.credentials) {
        // Take the seat again. The board stays inert until the server answers.
        this.awaitingFirstState = false;
        this.setState('joining');
        socket.send(JSON.stringify({
          type: 'joinRoom',
          name: this.credentials.name,
          code: this.credentials.code,
          token: this.credentials.token,
        }));
        return;
      }
      this.setState('synchronized');
    });

    socket.addEventListener('message', (event) => {
      if (generation !== this.generation) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      const context = this.observe(message);
      try {
        this.onMessage(message, context);
      } finally {
        // The app clears the stale table first; then the refused seat is gone.
        if (context && context.rejoinRefused) this.forget();
      }
    });

    socket.addEventListener('close', () => {
      if (generation !== this.generation) return;
      this.socket = null;
      this.awaitingFirstState = false;
      const wait = RETRY_STEPS[Math.min(this.retry, RETRY_STEPS.length - 1)];
      this.retry += 1;
      this.setState('disconnected');
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => { this.retryTimer = 0; this.connect(); }, wait);
    });

    socket.addEventListener('error', () => { /* close follows */ });
  }

  /**
   * Reads the traffic the state machine cares about, before the app sees it.
   * `joined` alone is not enough: it carries the seat, not the table.
   */
  observe(message) {
    if (message.type === 'joined') { this.awaitingFirstState = true; return undefined; }
    if (message.type === 'state' && this.awaitingFirstState) {
      this.awaitingFirstState = false;
      this.setState('synchronized');
      return undefined;
    }
    if (message.type === 'left') { this.awaitingFirstState = false; this.setState('synchronized'); return undefined; }
    if (message.type === 'error' && this.state === 'joining' && !this.awaitingFirstState) {
      return { rejoinRefused: true };
    }
    return undefined;
  }

  /** Remembers how to get back into the room after a drop. */
  remember(name, code, token) {
    this.credentials = { name, code, token };
    writeSeat(code, { name, token, at: Date.now() });
  }

  /** Arms the seat a fresh page load should reclaim, BEFORE `connect()`. */
  restore(seat) {
    if (!seat || !seat.code || !seat.token || !seat.name) return false;
    this.credentials = { name: seat.name, code: seat.code, token: seat.token };
    return true;
  }

  /** The seat this tab holds for one particular table, if any. */
  seatFor(code) {
    const seat = readSeat(code);
    if (!seat || !seat.token || !seat.name) return null;
    return { code: String(code).toUpperCase(), name: seat.name, token: seat.token };
  }

  forget() {
    if (this.credentials) writeSeat(this.credentials.code, null);
    this.credentials = null;
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.awaitingFirstState = false;
      this.setState('synchronized');
    }
  }

  /**
   * Leaves a table whose join reply may already be in flight. Clearing the
   * credentials cannot retract bytes already sent, so the socket is replaced
   * and its generation invalidated.
   */
  abandon() {
    if (this.credentials) writeSeat(this.credentials.code, null);
    this.credentials = null;
    this.awaitingFirstState = false;
    const stale = this.socket;
    this.socket = null;
    this.generation += 1;
    if (stale && stale.readyState < WebSocket.CLOSING) stale.close();
    this.connect();
  }

  /** Sends, or drops. True only if the message actually went out. */
  send(payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    if (STATE_DEPENDENT.has(payload && payload.type) && !this.synchronized) return false;
    this.socket.send(JSON.stringify(payload));
    return true;
  }
}
