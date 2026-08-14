/**
 * Mock table — loaded only with `?mock=1`.
 *
 * Replaces the global WebSocket with a stub that speaks PROTOCOL.md, so the
 * real Connection, the real send() and the real render path all run unchanged;
 * only the far end is scripted. This is how the UI is verified without a
 * server.
 *
 * The script walks: lobby → your turn (6 cards, WILD + REVERSE) → an opponent
 * turn → you at two cards with canDeclareTondo → an opponent vulnerable with
 * calloutTargets → a drawn-card decision → a wild pick → roundOver.
 *
 * Deterministic entry points for screenshots:
 *   ?mock=1&scene=<name>   jump straight into a scene
 *   window.__mock.goto('<name>')
 * Scene names: lobby, yourTurn, opponents, tondo, callout, drawn, wild, roundOver.
 *
 * Mock convenience (not a protocol claim): `createRoom` seats you alone, while
 * `joinRoom` drops you into a table already filled with three bots so the lobby
 * and the game are one click away.
 */

const CODE = 'BASIL-4821';
const BOTS = [
  { id: 'p2', name: 'CARMELA', isBot: true, connected: true },
  { id: 'p3', name: 'DOMINIC', isBot: true, connected: true },
  { id: 'p4', name: 'PINA', isBot: true, connected: true },
];
const c = (id, suit, value) => ({ id, suit, value });

const table = {
  name: 'You',
  seats: [],
  phase: 'lobby',
  game: null,
  scene: 'lobby',
};

let sock = null;
let timer = 0;
const later = (ms, fn) => { clearTimeout(timer); timer = setTimeout(fn, ms); };

/** `?scene=` pins the table to one beat, so a reconnect or a rejoin (the tab
 *  remembers its seat) lands back on the same picture instead of the lobby. */
function bootScene() {
  const name = new URLSearchParams(location.search).get('scene');
  return name && SCENES[name] && name !== 'lobby' ? name : null;
}

/* ------------------------------------------------------------ snapshots */

function seatsWithYou() {
  return [{ id: 'p1', name: table.name, isBot: false, connected: true }].concat(table.seats.slice(1));
}

function snapshot() {
  return {
    type: 'state',
    phase: table.phase,
    roomCode: CODE,
    youId: 'p1',
    hostId: 'p1',
    isHost: true,
    seats: table.seats,
    game: table.game,
  };
}

function playersFrom(counts, extra) {
  return table.seats.map((s, i) => Object.assign({
    id: s.id, name: s.name, isBot: s.isBot, connected: s.connected,
    cardCount: counts[i], declaredTondo: false, vulnerable: false,
  }, (extra && extra[s.id]) || {}));
}

function fullTable() {
  table.seats = seatsWithYou().slice(0, 1).concat(BOTS.map((b) => Object.assign({}, b)));
}

/* --------------------------------------------------------------- scenes */

const SCENES = {
  lobby() {
    table.phase = 'lobby';
    table.game = null;
  },

  yourTurn() {
    fullTable();
    table.phase = 'playing';
    table.game = {
      direction: 1,
      activeSuit: 'basil',
      topCard: c('t1', 'basil', '7'),
      drawPileCount: 41,
      turnPlayerId: 'p1',
      winnerId: null,
      players: playersFrom([6, 5, 5, 5]),
      hand: [
        c('c1', 'basil', '4'), c('c2', 'cheese', '2'), c('c3', 'pepperoni', '7'),
        c('c4', 'anchovy', '9'), c('c5', 'basil', 'REVERSE'), c('c6', null, 'WILD'),
      ],
      playableCardIds: ['c1', 'c3', 'c5', 'c6'],
      drawnDecisionCardId: null,
      canDeclareTondo: false,
      calloutTargets: [],
      log: ['DEALT 7 CARDS EACH', 'THE PIE STARTS ON BASIL 7', 'YOUR TURN'],
    };
  },

  opponents() {
    fullTable();
    table.phase = 'playing';
    const g = table.game || {};
    table.game = {
      direction: 1,
      activeSuit: g.activeSuit || 'basil',
      topCard: g.topCard || c('t2', 'basil', '4'),
      drawPileCount: 40,
      turnPlayerId: 'p2',
      winnerId: null,
      players: playersFrom([5, 5, 5, 5]),
      hand: (g.hand || []).slice(0, 5),
      playableCardIds: [],
      drawnDecisionCardId: null,
      canDeclareTondo: false,
      calloutTargets: [],
      log: (g.log || []).slice(-3).concat(['CARMELA IS PLAYING']),
    };
    if (!table.game.hand.length) {
      table.game.hand = [c('c2', 'cheese', '2'), c('c3', 'pepperoni', '7'),
        c('c4', 'anchovy', '9'), c('c5', 'basil', 'REVERSE'), c('c6', null, 'WILD')];
    }
    later(2200, () => go('tondo'));
  },

  tondo() {
    fullTable();
    table.phase = 'playing';
    table.game = {
      direction: 1,
      activeSuit: 'basil',
      topCard: c('t3', 'basil', '9'),
      drawPileCount: 33,
      turnPlayerId: 'p1',
      winnerId: null,
      players: playersFrom([2, 4, 3, 5]),
      hand: [c('c1', 'basil', '4'), c('c2', 'cheese', '2')],
      playableCardIds: ['c1'],
      drawnDecisionCardId: null,
      canDeclareTondo: true,
      calloutTargets: [],
      log: ['PINA PLAYED BASIL 9', 'YOU ARE DOWN TO TWO CARDS'],
    };
  },

  callout() {
    fullTable();
    table.phase = 'playing';
    table.game = {
      direction: 1,
      activeSuit: 'basil',
      topCard: c('t3', 'basil', '9'),
      drawPileCount: 31,
      turnPlayerId: 'p1',
      winnerId: null,
      players: playersFrom([2, 4, 1, 5], {
        p1: { declaredTondo: true },
        p3: { cardCount: 1, declaredTondo: false, vulnerable: true },
      }),
      hand: [c('c1', 'basil', '4'), c('c2', 'cheese', '2')],
      playableCardIds: ['c1'],
      drawnDecisionCardId: null,
      canDeclareTondo: false,
      calloutTargets: ['p3'],
      log: ['YOU CALLED TONDO', 'DOMINIC PLAYED BASIL 9', 'DOMINIC HAS ONE CARD AND SAID NOTHING'],
    };
  },

  drawn() {
    fullTable();
    table.phase = 'playing';
    table.game = {
      direction: -1,
      activeSuit: 'basil',
      topCard: c('t4', 'basil', '5'),
      drawPileCount: 28,
      turnPlayerId: 'p1',
      winnerId: null,
      players: playersFrom([3, 4, 3, 5], { p1: { declaredTondo: false } }),
      hand: [c('c2', 'cheese', '2'), c('c4', 'anchovy', '9'), c('d1', 'basil', 'PLUS2')],
      playableCardIds: ['d1'],
      drawnDecisionCardId: 'd1',
      canDeclareTondo: false,
      calloutTargets: [],
      log: ['YOU CAUGHT DOMINIC — HE DREW 2', 'PLAY ORDER REVERSED', 'YOU DREW BASIL +2'],
    };
  },

  wild() {
    fullTable();
    table.phase = 'playing';
    table.game = {
      direction: -1,
      activeSuit: 'basil',
      topCard: c('t5', 'basil', '5'),
      drawPileCount: 26,
      turnPlayerId: 'p1',
      winnerId: null,
      players: playersFrom([3, 4, 4, 5]),
      hand: [c('c2', 'cheese', '2'), c('c4', 'anchovy', '9'), c('w2', null, 'WILD')],
      playableCardIds: ['w2'],
      drawnDecisionCardId: null,
      canDeclareTondo: false,
      calloutTargets: [],
      log: ['YOU KEPT THE CARD AND PASSED', 'CARMELA PLAYED BASIL 5', 'YOUR TURN'],
    };
  },

  roundOver() {
    fullTable();
    table.phase = 'roundOver';
    table.game = {
      direction: -1,
      activeSuit: 'cheese',
      topCard: c('t6', null, 'WILD'),
      drawPileCount: 24,
      turnPlayerId: 'p2',
      winnerId: 'p2',
      players: playersFrom([2, 0, 4, 5], { p2: { declaredTondo: true } }),
      hand: [c('c2', 'cheese', '2'), c('c4', 'anchovy', '9')],
      playableCardIds: [],
      drawnDecisionCardId: null,
      canDeclareTondo: false,
      calloutTargets: [],
      log: ['YOU PLAYED WILD → CHEESE', 'CARMELA PLAYED CHEESE 3', 'CARMELA IS OUT OF CARDS'],
    };
  },
};

const ORDER = ['yourTurn', 'opponents', 'tondo', 'callout', 'drawn', 'wild', 'roundOver'];

function go(name) {
  if (!SCENES[name]) return;
  table.scene = name;
  SCENES[name]();
  emit(snapshot());
}
function next() {
  const i = ORDER.indexOf(table.scene);
  go(i < 0 || i === ORDER.length - 1 ? ORDER[0] : ORDER[i + 1]);
}

/* --------------------------------------------------------------- routing */

function emit(message) {
  if (sock) sock.deliver(message);
}

function route(msg) {
  switch (msg.type) {
    case 'createRoom':
      table.name = msg.name || 'You';
      table.seats = [{ id: 'p1', name: table.name, isBot: false, connected: true }];
      table.phase = 'lobby';
      table.game = null;
      emit({ type: 'joined', roomCode: CODE, youId: 'p1', token: 'mock-token', reconnected: false });
      if (bootScene()) { go(bootScene()); return; }
      emit(snapshot());
      return;

    case 'joinRoom':
      table.name = msg.name || 'You';
      table.seats = [{ id: 'p1', name: table.name, isBot: false, connected: true }];
      fullTable();
      table.phase = 'lobby';
      table.game = null;
      emit({ type: 'joined', roomCode: CODE, youId: 'p1', token: 'mock-token', reconnected: !!msg.token });
      if (bootScene()) { go(bootScene()); return; }
      emit(snapshot());
      return;

    case 'addBot': {
      const nextBot = BOTS[table.seats.length - 1];
      if (!nextBot) { emit({ type: 'error', message: 'The table is full.' }); emit(snapshot()); return; }
      table.seats.push(Object.assign({}, nextBot));
      emit(snapshot());
      return;
    }

    case 'removeSeat':
      table.seats = table.seats.filter((s) => s.id !== msg.seatId);
      emit(snapshot());
      return;

    case 'startGame':
      if (table.seats.length < 2) { emit({ type: 'error', message: 'Two seats minimum.' }); emit(snapshot()); return; }
      go('yourTurn');
      return;

    case 'play': {
      const g = table.game;
      if (!g) return;
      const card = g.hand.find((x) => x.id === msg.cardId);
      if (!card || !g.playableCardIds.includes(msg.cardId)) {
        emit({ type: 'error', message: 'That card does not match.' });
        emit(snapshot());
        return;
      }
      // show the play landing, then walk on to the next scripted beat
      g.hand = g.hand.filter((x) => x.id !== msg.cardId);
      g.topCard = { id: card.id, suit: card.suit, value: card.value };
      g.activeSuit = card.value === 'WILD' ? (msg.suit || 'cheese') : card.suit;
      g.playableCardIds = [];
      g.drawnDecisionCardId = null;
      g.canDeclareTondo = false;
      g.turnPlayerId = 'p2';
      g.players = g.players.map((p) => (p.id === 'p1' ? Object.assign({}, p, { cardCount: g.hand.length }) : p));
      g.log = g.log.slice(-3).concat([
        'YOU PLAYED ' + describe(card) + (card.value === 'WILD' ? ' → ' + String(g.activeSuit).toUpperCase() : ''),
      ]);
      emit(snapshot());
      later(1300, next);
      return;
    }

    case 'draw': {
      const g = table.game;
      if (!g) return;
      if (table.scene === 'yourTurn') { go('drawn'); return; }
      g.drawPileCount = Math.max(0, g.drawPileCount - 1);
      g.log = g.log.slice(-3).concat(['YOU DREW — NO MATCH, TURN ENDS']);
      emit(snapshot());
      later(1200, next);
      return;
    }

    case 'pass':
      emit(snapshot());
      later(300, next);
      return;

    case 'tondo': {
      const g = table.game;
      if (!g) return;
      g.canDeclareTondo = false;
      g.players = g.players.map((p) => (p.id === 'p1' ? Object.assign({}, p, { declaredTondo: true }) : p));
      g.log = g.log.slice(-3).concat(['YOU CALLED TONDO']);
      emit(snapshot());
      later(900, () => go('callout'));
      return;
    }

    case 'callout': {
      const g = table.game;
      if (!g) return;
      g.calloutTargets = [];
      g.players = g.players.map((p) => (p.id === msg.targetId
        ? Object.assign({}, p, { vulnerable: false, cardCount: p.cardCount + 2 }) : p));
      g.log = g.log.slice(-3).concat(['YOU CAUGHT ' + nameOf(msg.targetId) + ' — THEY DREW 2']);
      emit(snapshot());
      later(1200, () => go('drawn'));
      return;
    }

    case 'newRound':
      go('yourTurn');
      return;

    case 'leaveRoom':
      table.phase = 'lobby';
      table.game = null;
      emit({ type: 'left' });
      return;

    case 'sync':
      emit(snapshot());
      return;

    default:
      emit({ type: 'error', message: 'Unknown message: ' + msg.type });
      emit(snapshot());
  }
}

function nameOf(id) {
  const s = table.seats.find((x) => x.id === id);
  return s ? s.name : 'THEM';
}
function describe(card) {
  if (card.value === 'WILD') return 'WILD';
  const suit = String(card.suit).toUpperCase();
  if (card.value === 'PLUS2') return '+2 ' + suit;
  if (card.value === 'SKIP') return 'SKIP ' + suit;
  if (card.value === 'REVERSE') return 'REVERSE ' + suit;
  return suit + ' ' + card.value;
}

/* --------------------------------------------------------- socket stub */

class MockSocket {
  constructor() {
    this.readyState = 0;
    this.listeners = { open: [], message: [], close: [], error: [] };
    sock = this;
    setTimeout(() => {
      this.readyState = 1;
      this.fire('open', {});
      const scene = bootScene();
      if (scene) {
        emit({ type: 'joined', roomCode: CODE, youId: 'p1', token: 'mock-token', reconnected: false });
        go(scene);
      }
    }, 30);
  }
  addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  fire(type, event) { (this.listeners[type] || []).forEach((fn) => fn(event)); }
  deliver(message) { this.fire('message', { data: JSON.stringify(message) }); }
  send(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    console.log('[mock] →', msg);
    setTimeout(() => route(msg), 40);
  }
  close() { this.readyState = 3; this.fire('close', {}); }
}
MockSocket.CONNECTING = 0;
MockSocket.OPEN = 1;
MockSocket.CLOSING = 2;
MockSocket.CLOSED = 3;

window.WebSocket = MockSocket;
// `emit` is exposed so a check can push a hand-written snapshot (a two- or
// three-seat table, say) through the same path the server would use.
window.__mock = { goto: go, next, scenes: Object.keys(SCENES), table, emit, snapshot };
