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
 * Scene names: lobby, yourTurn, opponents, tondo, callout, drawn, wild, roundOver,
 * pieComplete.
 *
 * Mock convenience (not a protocol claim): `createRoom` seats you alone, while
 * `joinRoom` drops you into a table already filled with three bots so the lobby
 * and the game are one click away.
 */

const CODE = 'BASIL-4821';
/* Properly cased, matching server/bot.js's real BOT_NAMES — not ALL CAPS.
   A real bot's `.name` off the wire is never shouty (game.js's `up()` only
   uppercases LOG lines, a separate derived string, never the seat name
   itself); ALL-CAPS seat names here would be testing a shape the app never
   actually receives. The hardcoded log lines below (`'CARMELA IS PLAYING'`
   etc.) are correctly independent strings, not derived from `.name`, so
   they stay ALL CAPS on purpose, matching that same deliberate convention. */
const BOTS = [
  { id: 'p2', name: 'Carmela', isBot: true, connected: true },
  { id: 'p3', name: 'Dominic', isBot: true, connected: true },
  { id: 'p4', name: 'Pina', isBot: true, connected: true },
];
const c = (id, suit, value) => ({ id, suit, value });

const table = {
  name: 'You',
  seats: [],
  phase: 'lobby',
  game: null,
  scene: 'lobby',
  crew: null,
  savedTo: null,
  saving: false,
};
// `?mockcrew=1` puts a crew on the table at load, so the one-tap state can be seen.
if (new URLSearchParams(location.search).has('mockcrew')) table.crew = { id: 'k7m2q9xh3p', name: 'Friday Pie' };

let sock = null;
let timer = 0;
let saveTimer = 0; // its own timer: `later()` is one shared slot and a save must not cancel a scripted beat
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

/**
 * The pie, faked at a plausible mid-match position (PROTOCOL.md v1.1). The
 * scoreboard and the slice chip both read `match`, so a mock without one
 * renders neither — which silently hides the thing a round-boundary scene
 * exists to show.
 */
function matchBlock() {
  const over = table.phase === 'roundOver';
  // `pieComplete` reuses roundOver's table (same seats, same game-over banner)
  // but is the FOURTH slice, not a mid-pie boundary — the one state the share
  // button exists for.
  const pieDone = table.scene === 'pieComplete';
  const winnerId = table.game && table.game.winnerId;
  /* What each seat that did NOT win was still holding. The real server sends
     this as roundResult.breakdown (server/game.js, PROTOCOL.md), and this
     fixture used to send `breakdown: []` — which is part of why the client
     ignored the field for so long: no scene could show it, so nothing looked
     wrong. `points` is the SUM rather than a separate constant, so the figures
     the scoreboard adds up can never disagree with the total it prints. */
  const HELD = { p1: { cards: 2, points: 30 }, p2: { cards: 3, points: 34 },
                 p3: { cards: 4, points: 45 }, p4: { cards: 3, points: 32 } };
  const breakdown = (table.phase === 'roundOver' && winnerId)
    ? table.seats.filter((s) => s.id !== winnerId && HELD[s.id])
        .map((s) => ({ id: s.id, cards: HELD[s.id].cards, points: HELD[s.id].points }))
    : [];
  const points = breakdown.reduce((a, b) => a + b.points, 0);
  const scores = { p1: 81, p2: 166, p3: 0, p4: 0 };
  if (over && winnerId) scores[winnerId] = (scores[winnerId] || 0) + points;
  const standings = table.seats
    .map((s) => ({
      id: s.id, name: s.name, isBot: s.isBot,
      points: scores[s.id] || 0,
      roundsWon: (scores[s.id] || 0) > 0 ? 1 : 0,
    }))
    .sort((a, b) => b.points - a.points || b.roundsWon - a.roundsWon);
  const best = standings[0];
  return {
    roundsPerPie: 4,
    round: pieDone ? 4 : (over ? 2 : 1),
    complete: pieDone,
    championIds: pieDone ? ['p2'] : [],
    leaderIds: best && best.points ? [best.id] : [],
    standings,
    lastRound: over && winnerId
      ? { winnerId, points, forfeited: 0, breakdown }
      : null,
    // The scripted table has no server to deal for it, so the boundary clock
    // is shown at rest rather than counting toward a deal that cannot happen.
    nextDueAt: null,
    held: false,
    savedTo: table.savedTo || null, saving: table.saving,
  };
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
    match: matchBlock(),
    crews: 'on',
    crew: table.crew || null,
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

  /* Same table and banner as roundOver — this IS the round-over screen, just
     on the pie's fourth slice, with `matchBlock()` reading `table.scene` to
     mark the match complete and name Carmela (p2) champion. */
  pieComplete() {
    SCENES.roundOver();
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

/**
 * Emits one scripted BEFORE/AFTER pair so a check can watch exactly one event
 * land. `seats` picks the table size (2-4). `victim: 'you'` makes a skip, +2 or
 * callout land on you (p1), and makes a 3-4 seat reverse hand the turn to you;
 * otherwise it lands on a bot.
 * Resolves just after the AFTER snapshot is delivered.
 */
function transition(kind, { seats = 4, victim = 'bot' } = {}) {
  table.seats = seatsWithYou().slice(0, 1).concat(BOTS.slice(0, seats - 1).map((b) => Object.assign({}, b)));
  table.phase = 'playing';
  const ids = table.seats.map((s) => s.id);
  const hitsYou = victim === 'you';
  // A reversal "on you" is the one that hands you the turn: the seat after you
  // plays it, and the new order runs straight back to you.
  const actor = hitsYou ? (kind === 'reverse' && seats > 2 ? ids[1] : ids[ids.length - 1]) : 'p1';
  const target = hitsYou ? 'p1' : ids[1];
  const hand = [c('h1', 'basil', '4'), c('h2', 'cheese', '2'), c('h3', 'anchovy', '9'), c('h4', 'basil', '6'), c('h5', 'pepperoni', '1')];
  const counts = ids.map((id) => (id === 'p1' ? hand.length : 5));
  const base = (over) => Object.assign({
    direction: 1,
    activeSuit: 'basil',
    topCard: c('t-before', 'basil', '7'),
    drawPileCount: 30,
    turnPlayerId: actor,
    winnerId: null,
    players: playersFrom(counts),
    hand: hand.slice(),
    playableCardIds: actor === 'p1' ? ['h1', 'h4'] : [],
    drawnDecisionCardId: null,
    canDeclareTondo: false,
    calloutTargets: [],
    log: ['SCRIPTED BEFORE'],
  }, over || {});
  const after = (card, extra) => {
    const players = playersFrom(counts.map((n, i) => (ids[i] === actor ? n - 1 : n)), extra && extra.players);
    const handAfter = actor === 'p1' ? hand.slice(1) : hand.slice();
    return base(Object.assign({ topCard: card, players, hand: handAfter, log: ['SCRIPTED AFTER'] }, extra && extra.game));
  };
  const next = (steps) => ids[((ids.indexOf(actor) + steps) % ids.length + ids.length) % ids.length];

  let before = base();
  let afterGame;
  switch (kind) {
    case 'number':
      afterGame = after(c('t-num', 'basil', '3'), { game: { turnPlayerId: next(1) } });
      break;
    case 'skip':
      afterGame = after(c('t-skip', 'basil', 'SKIP'), { game: { turnPlayerId: next(2) } });
      break;
    case 'plus2': {
      const bumped = {};
      bumped[target] = { cardCount: counts[ids.indexOf(target)] + 2 };
      afterGame = after(c('t-plus2', 'basil', 'PLUS2'), { players: bumped, game: { turnPlayerId: next(2) } });
      if (target === 'p1') afterGame.hand = afterGame.hand.concat([c('d1', 'cheese', '5'), c('d2', 'anchovy', '8')]);
      break;
    }
    case 'reverse':
      // At two seats the server treats REVERSE as a skip and leaves direction alone.
      afterGame = seats === 2
        ? after(c('t-rev', 'basil', 'REVERSE'), { game: { turnPlayerId: actor } })
        : after(c('t-rev', 'basil', 'REVERSE'), { game: { direction: -1, turnPlayerId: ids[(ids.indexOf(actor) - 1 + ids.length) % ids.length] } });
      break;
    case 'wild':
      afterGame = after(c('t-wild', null, 'WILD'), { game: { activeSuit: 'anchovy', turnPlayerId: next(1) } });
      break;
    case 'tondo': {
      const declarer = hitsYou ? 'p1' : ids[1];
      before = base({ players: playersFrom(counts.map((n, i) => (ids[i] === declarer ? 2 : n))) });
      // The server's own wording (server/game.js declareTondo), so the rendered
      // log line names the declaration and a probe can tell it was delivered.
      afterGame = base({ players: playersFrom(counts.map((n, i) => (ids[i] === declarer ? 2 : n)), { [declarer]: { declaredTondo: true } }), log: ['SCRIPTED BEFORE', `${String(nameOf(declarer)).toUpperCase()} DECLARED TONDO`] });
      break;
    }
    case 'callout': {
      const caller = hitsYou ? ids[1] : 'p1';
      const vuln = {};
      vuln[target] = { cardCount: 1, vulnerable: true };
      before = base({ players: playersFrom(counts, vuln), calloutTargets: target === 'p1' ? [] : [target] });
      const caught = {};
      caught[target] = { cardCount: 3, vulnerable: false };
      // Upper-cased exactly as server/game.js writes it (`up(name)`), so the
      // caller can be read back from this line. nameOf('p1') is "You".
      const up = (id) => String(nameOf(id)).toUpperCase();
      afterGame = base({ players: playersFrom(counts, caught), log: ['SCRIPTED BEFORE', `${up(caller)} CALLED OUT ${up(target)} - DRAW 2`] });
      break;
    }
    default:
      return Promise.reject(new Error('unknown transition: ' + kind));
  }
  table.game = before;
  emit(snapshot());
  return new Promise((resolve) => setTimeout(() => {
    table.game = afterGame;
    emit(snapshot());
    setTimeout(resolve, 20);
  }, 120));
}

/* --------------------------------------------------------------- routing */

function emit(message) {
  if (sock) sock.deliver(message);
}

function route(msg) {
  switch (msg.type) {
    case 'createRoom':
      // `?mockrefuse=1` refuses a create the way the server does; `?mockdrop=1` never answers it.
      if (new URLSearchParams(location.search).has('mockdrop')) return;
      if (new URLSearchParams(location.search).has('mockrefuse')) { emit({ type: 'error', message: 'The table book is full right now.' }); return; }
      table.name = msg.name || 'You';
      table.savedTo = null; table.saving = false; clearTimeout(saveTimer);
      table.seats = [{ id: 'p1', name: table.name, isBot: false, connected: true }];
      table.phase = 'lobby';
      table.game = null;
      emit({ type: 'joined', roomCode: CODE, youId: 'p1', token: 'mock-token', reconnected: false });
      if (bootScene()) { go(bootScene()); return; }
      emit(snapshot());
      return;

    case 'joinRoom':
      // `?mockrefusejoin=1` refuses a join the way the server does for an unknown code.
      if (new URLSearchParams(location.search).has('mockrefusejoin')) { emit({ type: 'error', message: 'No table has that code.' }); return; }
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
      // Pick by id, not by count: removing a middle bot then adding one must
      // never seat the same id twice (the real server cannot).
      const seatedIds = new Set(table.seats.map((s) => s.id));
      const nextBot = BOTS.find((b) => !seatedIds.has(b.id));
      if (!nextBot || table.seats.length >= 4) {
        emit({ type: 'error', message: 'The table is full.' }); emit(snapshot()); return;
      }
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
      if (card.value === 'REVERSE') g.direction *= -1;
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
      // server/game.js callOut()'s exact format: events.js reads the caller
      // back out of it, so a looser wording here silently drops the lunge.
      g.log = g.log.slice(-3).concat([`${String(table.name).toUpperCase()} CALLED OUT ${String(nameOf(msg.targetId)).toUpperCase()} - DRAW 2`]);
      emit(snapshot());
      later(1200, () => go('drawn'));
      return;
    }

    case 'newRound':
      // A new pie is not the saved one: the server's room.pie is replaced, so savedTo is null again.
      table.savedTo = null; table.saving = false; clearTimeout(saveTimer);
      go('yourTurn');
      return;

    case 'leaveRoom':
      table.phase = 'lobby';
      table.game = null;
      emit({ type: 'left' });
      return;

    case 'saveToCrew': {
      // The real server records its own scores and answers with the crew; the
      // mock just names it, so the saved state can be shown.
      //   ?mocksaving=1    the save takes 1.5s: a snapshot with `saving: true` first
      //   ?mockfailsave=1  the save fails: `saving` clears, then the player-facing error
      const qs = new URLSearchParams(location.search);
      const land = () => {
        table.savedTo = msg.crewId
          ? { id: msg.crewId, name: (table.crew && table.crew.id === msg.crewId) ? table.crew.name : 'Friday Pie' }
          : { id: 'k7m2q9xh3p', name: String(msg.newCrewName || 'Crew').slice(0, 24) };
        if (!table.crew) table.crew = table.savedTo;
        table.saving = false;
        emit(snapshot());
      };
      if (qs.has('mockfailsave')) {
        table.saving = true;
        emit(snapshot());
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          table.saving = false;
          emit(snapshot());
          emit({ type: 'error', message: "Can't reach the crew book right now — your game is fine." });
        }, 600);
        return;
      }
      if (qs.has('mocksaving')) {
        table.saving = true;
        emit(snapshot());
        clearTimeout(saveTimer);
        saveTimer = setTimeout(land, 1500);
        return;
      }
      land();
      return;
    }

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

/* Crew pages, faked at the fetch layer the way the table is faked at the socket
   layer: the real app code runs unchanged. Three fixtures: a lived-in crew, an
   empty one whose name is HTML (it must render as literal text), and one whose
   book is down. */
const CREW_FIXTURES = {
  k7m2q9xh3p: { status: 200, body: {
    id: 'k7m2q9xh3p', name: 'Friday Pie', pies: 6,
    members: [
      { name: 'Gent', pies: 6, wins: 3, you: true },
      { name: 'Arta', pies: 6, wins: 2, you: false },
      { name: 'Dren', pies: 4, wins: 1, you: false },
      { name: 'Gent 2', pies: 1, wins: 0, you: false },
    ],
    recent: [
      { playedAt: '2026-10-09T19:40:00Z', rounds: 4, players: [
        { name: 'Gent', points: 212, won: true, kind: 'member' }, { name: 'Arta', points: 180, won: false, kind: 'member' },
        { name: 'Chef Bot', points: 40, won: false, kind: 'bot' }, { name: null, points: 12, won: false, kind: 'former' }] },
      { playedAt: '2026-10-02T20:10:00Z', rounds: 4, players: [
        { name: 'Arta', points: 166, won: true, kind: 'member' }, { name: 'Gent', points: 81, won: false, kind: 'member' },
        { name: null, points: 30, won: false, kind: 'guest' }] },
    ],
  } },
  empty00000: { status: 200, body: { id: 'empty00000', name: '<b>New</b> crew', pies: 0, members: [], recent: [] } },
  dead000000: { status: 503, body: { reason: 'timeout' } },
  // The widest names the server allows (24 for a crew, 14 for a player) in the
  // widest glyph, with no break opportunity: what `crew-card-fits` stresses.
  wwwwwwwwww: { status: 200, body: {
    id: 'wwwwwwwwww', name: 'W'.repeat(24), pies: 128,
    members: [
      { name: 'W'.repeat(14), pies: 128, wins: 99, you: true },
      { name: 'M'.repeat(14), pies: 126, wins: 21, you: false },
      { name: 'Q'.repeat(14), pies: 40, wins: 8, you: false },
    ],
    recent: [
      { playedAt: '2026-10-09T19:40:00Z', rounds: 4, players: [
        { name: 'W'.repeat(14), points: 1212, won: true, kind: 'member' }, { name: 'M'.repeat(14), points: 1180, won: false, kind: 'member' },
        { name: 'B'.repeat(14), points: 1040, won: false, kind: 'bot' }, { name: null, points: 112, won: false, kind: 'former' }] },
    ],
  } },
};
const crewsLeft = new Set(); // POST .../leave: the next GET no longer marks anyone `you`
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  const m = url.pathname.match(/^\/api\/crew\/([^/]+)(\/leave)?$/);
  if (!m) return realFetch(input, init);
  await new Promise((r) => setTimeout(r, 120)); // a visible loading beat
  if (m[2]) { crewsLeft.add(m[1]); return new Response(null, { status: 204 }); }
  const f = CREW_FIXTURES[m[1]];
  if (!f) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  const body = crewsLeft.has(m[1]) && f.body.members
    ? { ...f.body, members: f.body.members.map((x) => ({ ...x, you: false })) }
    : f.body;
  return new Response(JSON.stringify(body), { status: f.status, headers: { 'Content-Type': 'application/json' } });
};

window.WebSocket = MockSocket;
// `emit` is exposed so a check can push a hand-written snapshot (a two- or
// three-seat table, say) through the same path the server would use.
window.__mock = { goto: go, next, scenes: Object.keys(SCENES), table, emit, snapshot, transition };
