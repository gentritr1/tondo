/**
 * TONDO client.
 *
 * The server is authoritative: this file sends intent and repaints the whole
 * screen from each `state` snapshot. Nothing here decides whether a card is
 * legal — `playableCardIds`, `canDeclareTondo`, `calloutTargets` and
 * `drawnDecisionCardId` come off the wire and every affordance follows them.
 *
 * Visual language ported from docs/design/stone-oven-spec.md: the card
 * anatomy, flat topping marks, stone-oven table, seat tiles and animations
 * are the design's. Sizes live in CSS, scaled from one width per card.
 */

import { Connection } from './net.js';

/* ------------------------------------------------------------- constants */

/* `c` is the gradient's light stop, `deep` its dark stop and the flat mark
   colour, `edge` the 3D bottom lip and the ink used on cream. */
const SUITS = {
  pepperoni: { label: 'PEPPERONI', c: '#D9503A', deep: '#B33421', edge: '#7C2416', ink: '#7C2416', glyph: '●', abbr: 'PEP' },
  cheese:    { label: 'CHEESE',    c: '#F5CB5C', deep: '#E0A63C', edge: '#9A6C1C', ink: '#6B460C', glyph: '◆', abbr: 'CHZ' },
  basil:     { label: 'BASIL',     c: '#4ECB78', deep: '#2FA25B', edge: '#1C6B3C', ink: '#155230', glyph: '❧', abbr: 'BAS' },
  anchovy:   { label: 'ANCHOVY',   c: '#6E9EE0', deep: '#4A76BE', edge: '#2F4E82', ink: '#2F4E82', glyph: '≈', abbr: 'ANC' },
};
const SUIT_KEYS = ['pepperoni', 'cheese', 'basil', 'anchovy'];
const WILD_STOCK = { c: '#1E2E4C', deep: '#16233C', edge: '#0B1526', ink: '#0B1526' };
/* Short enough for the MATCH plaque, which sits inside the sauce. */
const ACTIONS = { SKIP: 'Skip', PLUS2: '+2', REVERSE: 'Flip' };

/* Seat tiles wear the four Stone Oven tones, in the design's order: you
   first, then the three other seats around the table. */
const TONES = {
  crust:   { bg: 'linear-gradient(155deg,#E8B45E,#C88B2E)', edge: '#96631C', solid: '#E8B45E' },
  sauce:   { bg: 'linear-gradient(155deg,#D9503A,#AE3320)', edge: '#7C2416', solid: '#D9503A' },
  basil:   { bg: 'linear-gradient(155deg,#4ECB78,#2E9A57)', edge: '#1C6B3C', solid: '#4ECB78' },
  anchovy: { bg: 'linear-gradient(155deg,#6E9EE0,#4571B8)', edge: '#2F4E82', solid: '#6E9EE0' },
};
const SEAT_TONES = ['basil', 'sauce', 'anchovy', 'crust'];
/* Two opponents sit opposite each other, not both crowding one side. */
const SLOTS = { 1: ['top'], 2: ['left', 'right'], 3: ['left', 'top', 'right'] };

/* Motion constants, kept in step with the tokens in styles.css. The WAAPI
   flights below cannot read a CSS custom property, so the one strong ease-out
   curve is written once here rather than inline at each call site. */
const EASE_OUT = 'cubic-bezier(.23, 1, .32, 1)';
/* The height the pile card falls through as it settles, and how oversized it
   is on that first frame. `@keyframes top-card-land` in styles.css reads both
   back as --land-rise / --land-scale (set on .top-card below), so the flight
   ghost lands on exactly that first frame: one value, two consumers, no drift
   to show up as a jump at the hand-off. */
const LAND_RISE = 10;
const LAND_SCALE = 1.04;
const MS = {
  land: 260,        // .top-card.is-landing
  flight: 260,      // played card → pile (220 on compact)
  deal: 240,        // deck → a hand
  dealStep: 55,     // stagger between cards of one deal (STANDARDS: 30–80ms)
  handIn: 190,      // a card arriving in your hand
  seatPop: 260,     // .plate.is-pop
  plaquePop: 200,   // .plaque.is-pop
  sweep: 280,       // .sauce-tint.is-sweeping
  flash: 220,       // .plaque.flash
  refuse: 161,      // .card.refuse
  bannerOut: 140,   // .banner.is-leaving
  textOut: 120,     // must equal --t-text-out in styles.css: the fade-out that
                    // setText() waits for before swapping a label's words
};

const isWild = (c) => !!c && c.value === 'WILD';
/** #RRGGBB + alpha → rgba(), for the one table layer that follows the suit. */
function tint(hex, a) {
  const n = Number.parseInt(String(hex).slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* The JS and the stylesheet must agree on what "compact" means, so both read
   the same query. Coarse pointers get tap-to-arm instead of hover previews;
   reduced motion skips every travelling ghost. */
const COMPACT = window.matchMedia('(max-width: 719px), (max-height: 700px)');
const COARSE = window.matchMedia('(hover: none)');
const RM = window.matchMedia('(prefers-reduced-motion: reduce)');

/* Topping marks are flat CSS shapes inside the card's cream circle — no SVG,
   no raster. Every dimension is a fraction of that circle (--m, set in CSS),
   so one piece of markup fits every card size. */
const MARK_HTML = {
  pepperoni: '<span class="mk-dot" style="--d:.30"></span><span class="mk-dot" style="--d:.23"></span><span class="mk-dot" style="--d:.26"></span>',
  basil: '<span class="mk-leaf"></span>',
  cheese: '<span class="mk-wedge"></span>',
  anchovy: '<span class="mk-fish"></span><span class="mk-tail"></span>',
  skip: '<span class="mk-skip"></span>',
  flip: '<span class="mk-flip"></span>',
  plus2: '<span class="mk-plus2">+2</span>',
  wild: '<span class="mk-star"></span>',
};

/** The corner index, the DM Mono code, and which mark goes in the cream
 *  circle. Action cards take a letter where a number would sit; the code
 *  underneath carries the full meaning. */
function face(c) {
  if (isWild(c)) return { corner: 'W', code: 'WILD', mark: 'wild' };
  if (c.value === 'SKIP') return { corner: 'S', code: 'SKIP', mark: 'skip' };
  if (c.value === 'REVERSE') return { corner: 'F', code: 'FLIP', mark: 'flip' };
  if (c.value === 'PLUS2') return { corner: '+2', code: 'DRAW', mark: 'plus2' };
  return { corner: c.value, code: SUITS[c.suit].abbr, mark: c.suit };
}

/** Card stock: the 160deg suit gradient and its 3D bottom lip, written as
 *  custom properties so the one shared CSS anatomy paints itself. */
function paintStock(node, c) {
  const s = isWild(c) ? WILD_STOCK : (SUITS[c.suit] || SUITS.cheese);
  node.style.setProperty('--suit-bg', `linear-gradient(160deg,${s.c},${s.deep})`);
  node.style.setProperty('--suit-edge', s.edge);
  /* The ground under the rank chip and the suit code. Cream on the bare
     gradient measured 1.45:1 on cheese; --suit-ink is what makes the two
     pieces of type on the card reach AA on every suit (see .card-index). */
  node.style.setProperty('--suit-ink', s.ink);
}

/** A stable per-card lean, so a fanned hand looks dealt rather than plotted. */
function jitterOf(id) {
  let h = 0;
  for (let i = 0; i < String(id).length; i++) h = (h * 31 + String(id).charCodeAt(i)) | 0;
  return ((((h % 7) + 7) % 7) - 3) * 0.6;   // -1.8deg … +1.8deg
}

function cardLabel(c) {
  if (isWild(c)) return 'WILD';
  if (c.value === 'SKIP') return 'SKIP ' + SUITS[c.suit].label;
  if (c.value === 'PLUS2') return '+2 ' + SUITS[c.suit].label;
  if (c.value === 'REVERSE') return 'REVERSE ' + SUITS[c.suit].label;
  return SUITS[c.suit].label + ' ' + c.value;
}

/** 'BASIL 7' → 'Basil 7', '+2 CHEESE' → '+2 Cheese'. */
const prettyCard = (c) => cardLabel(c).toLowerCase().replace(/\b[a-z]/g, (m) => m.toUpperCase());

/** Table copy reads as speech, not as labels. Names and TONDO keep their caps. */
function sentence(s, names) {
  if (!s) return '';
  let o = String(s).toLowerCase();
  o = o.charAt(0).toUpperCase() + o.slice(1);
  o = o.replace(/\btondo\b/gi, 'TONDO');
  (names || []).forEach((n) => {
    const low = String(n).toLowerCase();
    if (!low) return;
    const nice = low.charAt(0).toUpperCase() + low.slice(1);
    // Whole words only: a player named "an" must not recapitalise "anchovy".
    const safe = low.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    o = o.replace(new RegExp(`\\b${safe}\\b`, 'g'), nice);
  });
  return o;
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (ch) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

/* ------------------------------------------------------------------- DOM */

const el = (id) => document.getElementById(id);
const nodes = {};
['name-input', 'code-input', 'create-btn', 'join-btn', 'home-msg',
 'room-code', 'copy-btn', 'seat-list', 'host-controls', 'addbot-btn', 'start-btn',
 'lobby-wait', 'lobby-hint', 'lobby-msg', 'leave-btn',
 'queue', 'strip-code', 'stage', 'ring', 'plaque', 'match-label', 'dir-badge',
 'match-glyph', 'match-suit', 'match-or-wrap', 'match-value', 'deck-count',
 'ledger', 'wedge-glow', 'wedge-sector', 'wedge-tones',
 'top-card', 'top-index', 'top-glyph', 'top-suit', 'top-ghost',
 'under-1', 'under-2', 'dir-glyph', 'dir-label',
 'seats', 'event-ribbon', 'banner', 'live-polite', 'live-alert', 'live-now',
 'you-strip', 'you-portrait', 'you-name', 'you-pips', 'you-count', 'you-count-text',
 'you-status', 'hand-label', 'playable-label', 'tondo-bar', 'tondo-btn',
 'callout-bar', 'callout-head', 'callout-sub', 'callout-buttons',
 'drawn-bar', 'drawn-card', 'drawn-index', 'drawn-glyph', 'drawn-suit', 'drawn-ghost',
 'drawn-msg', 'drawn-play', 'drawn-keep',
 'wild-bar', 'wild-corner', 'wild-centre', 'wild-ghost', 'wild-grid',
 'hand-wrap', 'hand-row', 'fade-left', 'fade-right',
 'action-row', 'draw-btn', 'newround-btn', 'message', 'hint', 'game-leave', 'net-banner',
 'celebration',
].forEach((id) => { nodes[id] = el(id); });
nodes['top-card'].style.setProperty('--land-rise', LAND_RISE + 'px');
nodes['top-card'].style.setProperty('--land-scale', String(LAND_SCALE));
/* The three pieces of centre furniture the ledger has to keep its toppings off,
   plus the sauce disc they are positioned inside. Class-based, so they are
   resolved once here rather than re-queried on every repaint. */
nodes.sauce = document.querySelector('.sauce');
nodes.pile = document.querySelector('.center .pile');
nodes.dir = document.querySelector('.center .dir');

/* ----------------------------------------------------------------- state */

const app = {
  snap: null,
  roomCode: '',
  youId: '',
  name: '',
  message: '',
  messageTone: 'info',
  pendingWild: null,       // card id waiting for a suit
  armedCard: null,         // coarse pointers: first tap arms, second commits
  calloutDismissed: '',    // target key the player chose to let pass
  bannerTimer: 0,
  bannerExitTimer: 0,
  refuseTimer: 0,
  flashTimer: 0,
  lastTurn: undefined,
  wildWasOpen: false,      // so the picker steals focus once, not per snapshot
  drawnWasOpen: false,
  handMoved: false,      // the player has scrolled the hand at least once
  handOverflows: false,  // the hand row is wider than the tray
  pile: [],              // the last few discards, so the stack has visible depth
  lastSeatsHtml: '',     // unchanged HTML is not rewritten, so animations survive
  lastQueueHtml: '',
  ledger: [],            // the Slice Ledger: one topping per card played
  tally: new Map(),      // playerId → cards played this round (uncapped truth)
  ledgerSeq: 0,          // seeds the deterministic scatter
  ledgerKey: 0,          // bumped whenever the ledger's CONTENT changes
  ledgerLaidOut: '',     // geometry+content signature the pie is drawn for
  ledgerGeom: null,      // last measured sauce + centre-furniture geometry
  geomHeld: false,       // ledgerGeom is holding a stale measurement (below)
  centreWorst: null,     // widest the plaque and dir label can ever be here
  ledgerRaf: 0,          // re-spacing the pie while the table eases size
  glowRot: null,         // the lit wedge's rotation, UNWRAPPED so a Flip can
  glowDir: null,         //   sweep the long way round instead of the short one
  flight: null,          // the in-flight played-card ghost animation
  offline: true,         // stale snapshots stay visible, but never actionable
  celebratedWinner: '', // one confetti beat per completed round
  confettiTimer: 0,     // celebrate()'s own cleanup, so a second burst owns it
};

const conn = new Connection({ onMessage: handleMessage, onStatus: onNetStatus });

/* --------------------------------------------------------------- helpers */

function setScreen(name) { document.body.dataset.screen = name; }

/* A label swapping its words is something appearing on screen too, and a hard
 * swap reads exactly as jarring as a hard appearance. `setText` fades the old
 * words out (--t-text-out), swaps, and lets the CSS fade the new ones in.
 *
 * Interruptible by design: a change arriving mid-fade only retargets the
 * pending text and leaves the running fade alone, so a burst of snapshots
 * produces ONE crossfade ending on the newest words rather than a stutter.
 * The `is-swapping` class and --t-text-out are the contract with styles.css.
 *
 * `instant` is a rule about text -> TEXT only. It exists because hover fires
 * on every card the pointer crosses and crossfading the reason line at that
 * speed reads as flicker — but it was also flattening the two changes that
 * are genuinely an arrival and a departure: empty -> text and text -> empty.
 * Those keep their fade on every path:
 *   empty -> text : the words are written NOW (no out-phase to wait for) and
 *                   the `.txt-fade:empty` rule in styles.css fades them in.
 *   text  -> empty: the out-fade below runs first, so the words leave before
 *                   the node is cleared — clearing first would fade nothing.
 */
const textPending = new WeakMap();
const textTimers = new WeakMap();
function setText(node, text, instant) {
  const str = text == null ? '' : String(text);
  const current = textPending.has(node) ? textPending.get(node) : node.textContent;
  if (current === str) return;
  if (current === '') {                     // arriving: write now, CSS fades in
    clearTimeout(textTimers.get(node));
    textPending.delete(node);
    node.classList.remove('is-swapping');
    node.textContent = str;
    return;
  }
  if (instant && str !== '') {              // text -> text at hover speed
    clearTimeout(textTimers.get(node));
    textPending.delete(node);
    node.classList.remove('is-swapping');
    node.textContent = str;
    return;
  }
  const already = textPending.has(node);
  textPending.set(node, str);
  if (already) return;              // a fade is already running; it will land on `str`
  node.classList.add('is-swapping');
  textTimers.set(node, setTimeout(() => {
    node.textContent = textPending.get(node);
    textPending.delete(node);
    node.classList.remove('is-swapping');
  }, MS.textOut));
}

/** The words a node will be showing once any running crossfade lands. Reading
 *  `.textContent` mid-swap returns the OUTGOING words. */
function currentTextOf(node) {
  return textPending.has(node) ? textPending.get(node) : node.textContent;
}

function setMessage(text, tone, instant) {
  app.message = text || '';
  app.messageTone = tone || 'info';
  // `className =` would wipe the `is-swapping` class mid-crossfade.
  setText(nodes.message, app.message, instant);
  nodes.message.classList.toggle('bad', app.messageTone === 'bad');
  nodes.message.classList.toggle('good', app.messageTone === 'good');
}

function showBanner(text, tone, ms) {
  clearTimeout(app.bannerTimer);
  clearTimeout(app.bannerExitTimer);
  const wasShowing = !nodes.banner.hidden;
  nodes.banner.textContent = text;
  nodes.banner.className = 'banner' + (tone === 'win' ? ' win' : '');
  nodes.banner.hidden = false;
  /* Restarting the slam costs a forced synchronous layout (7.1ms of the first
     game render, instrumented at 1280x720) — and buys nothing unless the banner
     was ALREADY on screen. Coming out of `hidden` it goes display:none -> block,
     which starts the animation from 0 by itself; the none/reflow/restore dance
     was only ever for a second banner replacing a first one mid-flight. */
  if (wasShowing) {
    nodes.banner.style.animation = 'none';
    void nodes.banner.offsetWidth;
    nodes.banner.style.animation = '';
  }
  if (ms) app.bannerTimer = setTimeout(() => hideBanner(true), ms);
}

function celebrate() {
  if (!nodes.celebration || RM.matches) return;
  /* The 1.5s cleanup below belongs to THIS burst. Unstored, an earlier one was
     still armed when a second round ended inside its window and swept the new
     confetti off the screen mid-flight — the same reason every other timer in
     this file (bannerTimer, the flight guard) is held and cleared. */
  clearTimeout(app.confettiTimer);
  const colors = ['var(--gold)', 'var(--pep-solid)', 'var(--bas-solid)', 'var(--anc-solid)', 'var(--ink)'];
  const count = 24;
  nodes.celebration.replaceChildren();
  for (let i = 0; i < count; i++) {
    const piece = document.createElement('span');
    piece.className = 'confetti';
    piece.style.setProperty('--x', `${3 + ((i * 37) % 94)}%`);
    piece.style.setProperty('--drift', `${-54 + ((i * 29) % 108)}px`);
    piece.style.setProperty('--turn', `${180 + ((i * 83) % 420)}deg`);
    piece.style.setProperty('--delay', `${(i % 8) * 28}ms`);
    piece.style.setProperty('--c', colors[i % colors.length]);
    nodes.celebration.appendChild(piece);
  }
  nodes.celebration.classList.remove('is-live');
  void nodes.celebration.offsetWidth;
  nodes.celebration.classList.add('is-live');
  app.confettiTimer = setTimeout(() => {
    nodes.celebration.classList.remove('is-live');
    nodes.celebration.replaceChildren();
  }, 1500);
}
function hideBanner(soft) {
  clearTimeout(app.bannerTimer);
  clearTimeout(app.bannerExitTimer);
  if (soft && !nodes.banner.hidden && !RM.matches) {
    // Leave with a short fade instead of a snap; enter stays the loud one.
    nodes.banner.classList.add('is-leaving');
    app.bannerExitTimer = setTimeout(() => {
      nodes.banner.hidden = true;
      nodes.banner.classList.remove('is-leaving');
    }, MS.bannerOut);
    return;
  }
  nodes.banner.hidden = true;
  nodes.banner.classList.remove('is-leaving');
}

function onNetStatus(state) {
  const stuck = state === 'disconnected' || state === 'connecting' || state === 'joining';
  app.offline = stuck;
  nodes['net-banner'].hidden = !stuck;
  // "Reconnecting" is a lie on the very first load: nothing was connected yet.
  nodes['net-banner'].textContent =
    state === 'joining' ? 'Taking your seat back…'
      : (conn.credentials ? 'Reconnecting…' : 'Connecting…');
  // While out of sync the table is read-only; make it look it.
  document.body.classList.toggle('is-offline', stuck);
  // Reflect the transport gate in native control state immediately. A stale
  // table may remain useful to read, but keyboard and assistive-tech users must
  // not be offered actions the connection will drop.
  if (app.snap) {
    if (app.snap.phase === 'lobby') renderLobby(app.snap);
    else if (app.snap.game) renderGame(app.snap);
  }
}

function names(snap) {
  const list = (snap && snap.game ? snap.game.players : (snap ? snap.seats : [])) || [];
  return list.map((p) => p.name);
}

function playerName(id) {
  const s = app.snap;
  if (!s) return '';
  const all = (s.game ? s.game.players : s.seats) || [];
  const p = all.find((x) => x.id === id);
  return p ? p.name : '';
}

function nicely(name) {
  const s = String(name || '');
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/* --------------------------------------------------------------- network */

function handleMessage(msg, context) {
  if (context && context.rejoinRefused) {
    app.snap = null;
    setScreen('home');
    nodes['home-msg'].textContent = msg.message || 'That seat is gone.';
    return;
  }
  if (msg.type === 'joined') {
    app.roomCode = msg.roomCode;
    app.youId = msg.youId;
    conn.remember(app.name, msg.roomCode, msg.token);
    try { sessionStorage.setItem('tondo.room', msg.roomCode); } catch { /* ignore */ }
    return;
  }
  if (msg.type === 'state') { applySnapshot(msg); return; }
  if (msg.type === 'left') {
    app.snap = null;
    try { sessionStorage.removeItem('tondo.room'); } catch { /* ignore */ }
    setScreen('home');
    return;
  }
  if (msg.type === 'error') {
    const text = msg.message || 'That did not work.';
    nodes['home-msg'].textContent = text;
    nodes['lobby-msg'].textContent = text;
    setMessage(text, 'bad');
    nodes['live-now'].textContent = text; // refusals are announced, not just shown
  }
}

function send(payload) {
  const ok = conn.send(payload);
  if (!ok) setMessage('Not connected — try again in a moment.', 'bad');
  return ok;
}

/* -------------------------------------------------------------- snapshot */

function applySnapshot(snap) {
  const prev = app.snap;
  app.snap = snap;
  app.youId = snap.youId;
  app.roomCode = snap.roomCode;

  const g = snap.game;
  // A wild waiting for a suit is only meaningful while that card is in hand.
  if (app.pendingWild && !(g && g.hand.some((c) => c.id === app.pendingWild))) app.pendingWild = null;
  // An armed card survives only inside the same turn with the card in hand.
  if (app.armedCard && !(g && g.turnPlayerId === snap.youId
    && g.hand.some((c) => c.id === app.armedCard))) app.armedCard = null;
  if (g && !(g.calloutTargets || []).length) app.calloutDismissed = '';

  if (snap.phase === 'lobby') {
    hideBanner();
    document.title = 'TONDO';
    app.lastTurn = undefined;
    ledgerClear();
    app.glowRot = null;
    app.glowDir = null;
    app.celebratedWinner = '';
    setScreen('lobby');
    renderLobby(snap);
    return;
  }

  setScreen('game');
  if (snap.phase !== 'roundOver') app.celebratedWinner = '';
  if (!prev || prev.phase === 'lobby') { setMessage('', 'info'); app.handMoved = false; }

  const yourTurnNow = g && snap.phase === 'playing' && g.turnPlayerId === snap.youId;
  document.title = yourTurnNow ? '● Your turn — TONDO' : 'TONDO';

  if (snap.phase === 'roundOver' && g) {
    const winner = playerName(g.winnerId);
    showBanner(g.winnerId === snap.youId ? 'YOU WIN' : (nicely(winner) + ' WINS').toUpperCase(), 'win', 0);
    if (app.celebratedWinner !== g.winnerId) {
      app.celebratedWinner = g.winnerId;
      celebrate();
    }
    app.lastTurn = undefined;
  } else if (yourTurnNow && app.lastTurn !== g.turnPlayerId) {
    showBanner('YOUR TURN', 'you', 700);
    setMessage('', 'info');
    // The one event worth interrupting a screen reader for.
    nodes['live-now'].textContent =
      `Your turn. ${(g.playableCardIds || []).length} playable.`;
    app.lastTurn = g.turnPlayerId;
  } else if (g && g.turnPlayerId !== app.lastTurn) {
    hideBanner(true);
    // A rejection explains one tap; it must not outlive the turn it was in.
    if (app.messageTone === 'bad') setMessage('', 'info');
    app.lastTurn = g.turnPlayerId;
  }

  // ---- motion: measure the old world before the repaint ------------------
  const travel = planTravel(prev, snap);

  // ---- the ledger: whoever just played dresses their own wedge -----------
  // A new deal is a new pie. `roundOver` itself keeps the finished ledger on
  // screen — that is the round's scoreboard — and it is the NEXT round that
  // wipes it.
  const pgame = prev && prev.game;
  if (prev && prev.phase === 'roundOver' && snap.phase === 'playing') ledgerClear();
  // `pgame.turnPlayerId` is the player who just moved: this runs before the
  // repaint, so it is still the pre-play snapshot. A bot resolves here exactly
  // as your own play does. The suit is the ACTIVE one, so a Wild drops the
  // topping its owner chose rather than a colourless card.
  if (prev && prev.phase === 'playing' && g && pgame && g.topCard && pgame.topCard
      && pgame.topCard.id !== g.topCard.id && pgame.turnPlayerId) {
    ledgerAdd(g, pgame.turnPlayerId, activeSuitOf(g),
      (travel && travel.flight) ? MS.flight : 0);
  }

  renderGame(snap);
  runTravel(travel, snap);

  const pg = pgame;
  const turnChanged = !!(g && pg && prev.phase === 'playing' && snap.phase === 'playing'
    && g.turnPlayerId !== pg.turnPlayerId);
  if (turnChanged) {
    pulse(nodes.stage, 'is-turn-change', 220);
    // Whoever just took the turn: their tile pops once, so a bot's move has a
    // visible beginning as well as an end.
    popSeat(g.turnPlayerId);
  }
  // The plaque states what you must match. When that requirement actually
  // changes it acknowledges itself — state indication, not decoration.
  if (g && pg && activeSuitOf(g) !== activeSuitOf(pg)) {
    pulse(nodes.plaque, 'is-pop', MS.plaquePop);
    // A Wild is the one card whose topping is *chosen*: wash the new colour
    // outward across the sauce. Rare enough to earn the flourish.
    if (isWild(g.topCard) && !RM.matches) {
      const tintLayer = nodes.ring.querySelector('.sauce-tint');
      if (tintLayer) pulse(tintLayer, 'is-sweeping', MS.sweep);
    }
  }
  // With a flight in the air the card lands when the ghost arrives (see
  // flyToPile); without one — no known source, or reduced motion — it lands now.
  const topChanged = !!(g && pg && g.topCard
    && (!pg.topCard || pg.topCard.id !== g.topCard.id));
  if (topChanged && !(travel && travel.flight)) pulse(nodes['top-card'], 'is-landing', MS.land);
}

/** The seat plate is re-created by every seats repaint, so the pop is fired at
 *  the node that exists right now rather than held on a class in the markup. */
function popSeat(playerId) {
  if (!playerId || RM.matches) return;
  const plate = nodes.seats.querySelector(
    `.seat[data-player="${CSS.escape(playerId)}"] .plate`);
  if (!plate) return;
  plate.classList.add('is-pop');
  setTimeout(() => plate.classList.remove('is-pop'), MS.seatPop);
}

/** Re-triggerable one-shot animation class; a second pulse restarts cleanly. */
const pulseTimers = new WeakMap();
function pulse(el, className, ms) {
  clearTimeout(pulseTimers.get(el));
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
  pulseTimers.set(el, setTimeout(() => el.classList.remove(className), ms));
}

/* --------------------------------------------------- travelling ghosts
   The server is authoritative and snapshots repaint the truth immediately;
   ghosts only ever fly OVER an already-correct table, and a newer snapshot
   cancels the previous flight. */

function planTravel(prev, snap) {
  const g = snap.game;
  const pg = prev && prev.game;
  if (!pg || !g || RM.matches) return null;
  if (!(prev.phase === 'playing')) return null;

  const plan = { flight: null, deals: [] };

  // A new top card: somebody played. Remember where it came from. `pg` is the
  // pre-repaint snapshot, so `pg.turnPlayerId` is the player who just moved —
  // a bot's seat resolves here exactly as your own hand card does.
  if (g.topCard && (!pg.topCard || pg.topCard.id !== g.topCard.id)) {
    const playerId = pg.turnPlayerId;
    if (playerId === snap.youId) {
      const src = nodes['hand-row'].querySelector(`[data-card="${CSS.escape(g.topCard.id)}"]`);
      // The fan leans each card up to 10deg, and a rotated element's rect is its
      // BOUNDING BOX, not its box: 94x135 measures 115.54x148.76, so a ghost built
      // from it leaves the hand 23% too wide and the wrong shape. Use the layout
      // width, exactly as the seat path below already does.
      if (src) plan.flight = { from: cardRectAt(src, src.offsetWidth), card: g.topCard };
    } else if (playerId) {
      const src = nodes.seats.querySelector(`.seat[data-player="${CSS.escape(playerId)}"] .stack`);
      // A seat tile is square. The ghost leaves it already card-shaped, so the
      // flight never changes proportion and can hand off to the pile cleanly.
      // --seat-back is derived from the table now, and the table is derived
      // from the stage, so it is read AT THE SEAT rather than at :root — the
      // root has no --table-d to derive from, and the value also differs while
      // a context bar has the table compressed. It resolves to px because the
      // property is @property-registered as a <length> in styles.css.
      if (src) plan.flight = { from: cardRectAt(src, cssPx(src, '--seat-back', 34)), card: g.topCard };
    }
  }

  // Hands that grew: cards travel from the pile to their owner.
  for (const p of g.players) {
    const before = pg.players.find((x) => x.id === p.id);
    if (before && p.cardCount > before.cardCount) {
      plan.deals.push({ playerId: p.id, count: p.cardCount - before.cardCount });
    }
  }
  return (plan.flight || plan.deals.length) ? plan : null;
}

function runTravel(plan, snap) {
  if (!plan) return;
  if (plan.flight) flyToPile(plan.flight.from, plan.flight.card);
  let wave = 0;
  for (const deal of plan.deals) {
    const target = deal.playerId === snap.youId
      ? nodes['hand-row']
      : nodes.seats.querySelector(`.seat[data-player="${CSS.escape(deal.playerId)}"] .stack`);
    if (target) dealGhosts(target.getBoundingClientRect(), deal.count, wave++);
  }
}

/** The pile's on-screen source: the deck, or the top card where the deck hides.
 *  The deck steps out of the tray for as long as the hand is swapped for a
 *  decision bar — and a DRAWN card arrives in exactly that snapshot, so asking
 *  where the deck is at that moment answers "nowhere" and the card would fly
 *  out of the discard instead of out of the pile it actually came from. Its
 *  last on-screen box is the honest source; a layout where the deck is never
 *  shown at all (the phone band) still falls through to the discard. */
let lastDeckRect = null;
function pileRect() {
  const deck = document.getElementById('deck');
  if (deck && deck.offsetParent !== null) {
    const r = deck.getBoundingClientRect();
    if (r.width) { lastDeckRect = r; return r; }
  }
  return lastDeckRect || nodes['top-card'].getBoundingClientRect();
}

/** A card-proportioned rect (the 96×138 ratio) centred on `node`. */
function cardRectAt(node, cw) {
  const r = node.getBoundingClientRect();
  const w = Math.max(cw, 1);
  const h = w * 1.4375;
  return { left: r.left + r.width / 2 - w / 2, top: r.top + r.height / 2 - h / 2, width: w, height: h };
}

function ghostShell(rect) {
  const node = document.createElement('div');
  node.className = 'travel-ghost';
  node.style.left = rect.left + 'px';
  node.style.top = rect.top + 'px';
  node.style.width = rect.width + 'px';
  node.style.height = rect.height + 'px';
  return node;
}

/**
 * A played card flies from its owner — your hand, or an opponent's seat tile —
 * onto the pile. The snapshot has already repainted the pile with the new top
 * card, so `.is-inflight` hides it until the ghost arrives: what you see under
 * the flight is the card it is about to cover, which is what makes an
 * opponent's move legible instead of a swap.
 */
function flyToPile(from, card) {
  const topEl = nodes['top-card'];
  if (app.flight) {
    app.flight.cancelled = true;
    app.flight.anim.cancel();
    app.flight.ghost.remove();
    clearTimeout(app.flight.guard);
    app.flight = null;
  }
  const to = topEl.getBoundingClientRect();
  if (!to.width || !from.width) { topEl.classList.remove('is-inflight'); return; }
  const ghost = ghostShell(from);
  ghost.classList.add('travel-card');
  ghost.style.setProperty('--cw', Math.round(from.width) + 'px');   // a length: CSS scales it
  // The ghost wears the real face. A blank card turning into a printed one at
  // the hand-off is the "two objects swapping" artefact the pile settle is
  // meant to hide.
  ghost.innerHTML = '<div class="card-index"></div><div class="card-glyph"></div>' +
    '<div class="card-suit"></div><div class="card-ghost"></div>';
  paintCardFace(ghost, card);
  document.body.appendChild(ghost);
  const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
  const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
  // Both sides must be layout widths. `to` is the rotated bbox of a rotate(-3deg)
  // card (98px layout measures 104.81px), so dividing rects landed the ghost ~7%
  // wider than the card that replaces it — a visible pop at the one frame the
  // hand-off exists to hide.
  const s = topEl.offsetWidth / Math.round(from.width);
  const ms = COMPACT.matches ? 220 : MS.flight;
  const anim = ghost.animate([
    { transform: 'translate(0,0) scale(1) rotate(0deg)', opacity: 1 },
    { transform: `translate(${dx * .55}px,${dy * .55}px) scale(${(1 + s) / 2}) rotate(${dx > 0 ? 7 : -7}deg)`, opacity: 1, offset: .6 },
    // Lands oversized, 10px high and fully opaque — exactly the first frame of
    // `top-card-land`. The ghost is then swapped for the real pile card, so the
    // hand-off is one continuous card being slapped down, not a crossfade.
    { transform: `translate(${dx}px,${dy - LAND_RISE}px) scale(${s * LAND_SCALE}) rotate(-3deg)`, opacity: 1 },
  ], { duration: ms, easing: EASE_OUT, fill: 'forwards' });

  const flight = { ghost, anim, cancelled: false, guard: 0 };
  app.flight = flight;
  topEl.classList.add('is-inflight');

  const settle = () => {
    ghost.remove();
    clearTimeout(flight.guard);
    if (app.flight !== flight) return;   // a newer flight owns the pile now
    app.flight = null;
    topEl.classList.remove('is-inflight');
    if (!flight.cancelled) pulse(topEl, 'is-landing', MS.land);
  };
  // `finished` can reject (cancel) or, in rare detach cases, never settle —
  // the pile must never be left invisible either way.
  anim.finished.then(settle, settle);
  flight.guard = setTimeout(settle, ms + 400);
}

function dealGhosts(target, count, wave) {
  const src = pileRect();
  if (!src.width || !target.width) return;
  const shown = Math.min(count, 3); // a +2 reads at two; never flood the DOM
  const dx = (target.left + target.width / 2) - (src.left + src.width / 2);
  const dy = (target.top + target.height / 2) - (src.top + src.height / 2);
  for (let k = 0; k < shown; k++) {
    const ghost = ghostShell(src);
    ghost.classList.add('travel-back', 'back-face');
    ghost.style.setProperty('--cw', Math.round(src.width) + 'px');
    document.body.appendChild(ghost);
    const delay = wave * 120 + k * MS.dealStep;
    /* `finished` is the only thing holding these ghosts' leashes, and it does
       not always settle: on a hidden or unfocused page the animation never
       advances, so the promise never resolves and the ghost stays in <body>
       forever, one per dealt card. flyToPile has carried a guard timeout for
       exactly this since it was written; a deal throws up to three at a time
       and had none. `done` keeps the two paths from double-removing. */
    let done = false, guard = 0;
    const drop = () => { if (done) return; done = true; clearTimeout(guard); ghost.remove(); };
    ghost.animate([
      { transform: 'translate(0,0) scale(1) rotate(0deg)', opacity: 1 },
      { transform: `translate(${dx}px,${dy}px) scale(.55) rotate(${dx > 0 ? 9 : -9}deg)`, opacity: .85, offset: .8 },
      { transform: `translate(${dx}px,${dy}px) scale(.5) rotate(${dx > 0 ? 9 : -9}deg)`, opacity: 0 },
    ], { duration: MS.deal, delay, easing: EASE_OUT, fill: 'forwards' })
      .finished.then(drop, drop);
    guard = setTimeout(drop, MS.deal + delay + 400);
  }
}

/* ------------------------------------------------------------------ home */

function bootHome() {
  const params = new URLSearchParams(location.search);
  let stored = '';
  try { stored = localStorage.getItem('tondo.name') || ''; } catch { /* ignore */ }
  nodes['name-input'].value = stored;
  const code = params.get('code');
  if (code) nodes['code-input'].value = code.toUpperCase();
}

function readName() {
  const name = (nodes['name-input'].value || '').trim().slice(0, 14);
  if (!name) { nodes['home-msg'].textContent = 'Put a name on the ticket first.'; nodes['name-input'].focus(); return ''; }
  app.name = name;
  try { localStorage.setItem('tondo.name', name); } catch { /* ignore */ }
  return name;
}

nodes['create-btn'].addEventListener('click', () => {
  const name = readName();
  if (!name) return;
  nodes['home-msg'].textContent = '';
  send({ type: 'createRoom', name });
});

nodes['join-btn'].addEventListener('click', () => {
  const name = readName();
  if (!name) return;
  const code = (nodes['code-input'].value || '').trim().toUpperCase();
  if (!code) { nodes['home-msg'].textContent = 'A table code goes in the box.'; nodes['code-input'].focus(); return; }
  nodes['home-msg'].textContent = '';
  const seat = conn.seatFor(code);
  send({ type: 'joinRoom', code, name, token: seat ? seat.token : undefined });
});

nodes['code-input'].addEventListener('keydown', (e) => { if (e.key === 'Enter') nodes['join-btn'].click(); });
nodes['name-input'].addEventListener('keydown', (e) => { if (e.key === 'Enter') nodes['create-btn'].click(); });

/* ----------------------------------------------------------------- lobby */

function renderLobby(snap) {
  nodes['room-code'].textContent = snap.roomCode || '—';
  // lobby-msg is left alone: "Invite link copied." must not vanish the moment
  // someone else's join triggers a repaint.

  nodes['seat-list'].innerHTML = snap.seats.map((seat, i) => {
    // The same tile the player will wear at the table, so the seat they take
    // here is recognisably theirs once the game starts.
    const tone = TONES[SEAT_TONES[i % SEAT_TONES.length]];
    const name = seat.isBot ? nicely(seat.name) : seat.name;
    const initial = (String(name).trim().charAt(0) || '?').toUpperCase();
    const tags = [];
    if (seat.id === snap.youId) tags.push('<span class="tag tag-you">You</span>');
    if (seat.id === snap.hostId) tags.push('<span class="tag tag-host">Host</span>');
    if (seat.isBot) tags.push('<span class="tag tag-bot">Bot</span>');
    if (!seat.connected) tags.push('<span class="tag tag-away">Away</span>');
    const remove = (snap.isHost && seat.isBot)
      ? `<button type="button" class="btn btn-tiny" data-remove="${esc(seat.id)}" aria-label="Remove ${esc(name)}"${app.offline ? ' disabled' : ''}>Remove</button>` : '';
    return `<li class="seat-row">
      <span class="seat-chip" style="--tone-bg:${tone.bg};--tone-edge:${tone.edge}" aria-hidden="true"><span class="initial">${esc(initial)}</span></span>
      <span class="who">${esc(name)}</span>
      ${tags.join('')}${remove}
    </li>`;
  }).join('') +
    // The empty chairs are drawn too, so the table's capacity is visible and
    // the card does not jump in height as seats fill.
    Array.from({ length: Math.max(0, 4 - snap.seats.length) }, () =>
      '<li class="seat-row seat-ghost" aria-hidden="true"><span class="ghost-plus">+</span><span class="who">Open seat</span></li>'
    ).join('');

  nodes['seat-list'].querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => send({ type: 'removeSeat', seatId: btn.dataset.remove }));
  });

  nodes['host-controls'].hidden = !snap.isHost;
  nodes['lobby-wait'].hidden = snap.isHost;
  nodes['addbot-btn'].disabled = app.offline || snap.seats.length >= 4;
  nodes['start-btn'].disabled = app.offline || snap.seats.length < 2;
  nodes['lobby-hint'].textContent = !snap.isHost ? ''
    : (snap.seats.length < 2
      ? 'Two players minimum — add a bot, or send someone the invite link.'
      : 'The table is set — deal when everyone is ready.');
}

nodes['copy-btn'].addEventListener('click', async () => {
  const code = app.roomCode || '';
  // A link is the fastest invite there is; the code rides inside it.
  const url = `${location.origin}${location.pathname}?code=${encodeURIComponent(code)}`;
  try {
    await navigator.clipboard.writeText(url);
    nodes['lobby-msg'].textContent = 'Invite link copied.';
  } catch {
    nodes['lobby-msg'].textContent = 'Copy it by hand: ' + code;
  }
});
nodes['addbot-btn'].addEventListener('click', () => send({ type: 'addBot' }));
nodes['start-btn'].addEventListener('click', () => send({ type: 'startGame' }));
nodes['leave-btn'].addEventListener('click', leaveTable);
nodes['game-leave'].addEventListener('click', leaveTable);

function leaveTable() {
  // Mid-round the button sits right in the thumb arc: one stray tap must not
  // abandon the table for everyone.
  if (app.snap && app.snap.phase === 'playing'
    && !window.confirm('Leave the table? Your seat is given up.')) return;
  if (!send({ type: 'leaveRoom' })) {
    // The seat still exists server-side; going home now would strand it.
    setMessage('Not connected — try again in a moment.', 'bad');
    nodes['lobby-msg'].textContent = 'Not connected — try again in a moment.';
    return;
  }
  try { sessionStorage.removeItem('tondo.room'); } catch { /* ignore */ }
  app.snap = null;
  conn.forget();
  setScreen('home');
}

/* ------------------------------------------------------------ game: read */

function activeSuitOf(g) { return g.activeSuit || (g.topCard && g.topCard.suit) || 'cheese'; }
function matchValueText(g) {
  const v = g.topCard ? g.topCard.value : '';
  return ACTIONS[v] || (v === 'WILD' ? '' : v);
}
function reasonFor(g) {
  const s = nicely(SUITS[activeSuitOf(g)].label);
  const v = matchValueText(g).replace('⊘ ', '').replace('↻ ', '');
  return 'Doesn’t match — need ' + (v ? s + ', ' + nicely(v) : s) + ', or a Wild';
}
function consequence(g, c) {
  const nx = nicely(playerName(nextPlayerId(g)));
  if (isWild(c)) return 'Playable — wild, you pick the next topping.';
  if (c.value === 'SKIP') return `Playable — ${nx} loses their turn.`;
  if (c.value === 'PLUS2') return `Playable — ${nx} draws 2 and loses their turn.`;
  if (c.value === 'REVERSE') return 'Playable — the play order flips.';
  return 'Playable — ' + prettyCard(c) + '.';
}
function nextPlayerId(g) {
  const ps = g.players;
  const i = ps.findIndex((p) => p.id === g.turnPlayerId);
  if (i < 0) return '';
  const n = ps.length;
  return ps[(((i + (g.direction || 1)) % n) + n) % n].id;
}
function seatsAroundYou(g, youId) {
  const ps = g.players;
  const i = ps.findIndex((p) => p.id === youId);
  const others = [];
  for (let k = 1; k < ps.length; k++) others.push(ps[(i + k) % ps.length]);
  const slots = SLOTS[others.length] || [];
  return others.map((p, k) => ({ p, slot: slots[k], seatIndex: (i + k + 1) % ps.length, offset: k + 1 }));
}

/* ---------------------------------------------------------- game: render */

function renderGame(snap) {
  const g = snap.game;
  if (!g) return;
  const you = g.players.find((p) => p.id === snap.youId) || { cardCount: g.hand.length };
  const over = snap.phase === 'roundOver';
  const yourTurn = !over && g.turnPlayerId === snap.youId;
  const drawnId = g.drawnDecisionCardId || null;
  const wildOpen = !!app.pendingWild;
  const playable = new Set(g.playableCardIds || []);
  const nameList = names(snap);

  nodes['strip-code'].textContent = snap.roomCode || '';
  renderQueue(snap, g, over);
  renderCenter(snap, g, over);
  renderSeats(snap, g, over);

  const last = (g.log && g.log.length) ? g.log[g.log.length - 1] : '';
  const eventText = sentence(last, nameList);
  const redundantStatus = /^(your turn|.+ is playing(?:…|\.\.\.)?)$/i.test(eventText);
  setText(nodes['event-ribbon'], eventText);
  nodes['event-ribbon'].hidden = !eventText || redundantStatus;
  const politeEvent = redundantStatus ? '' : eventText;
  if (nodes['live-polite'].textContent !== politeEvent) {
    nodes['live-polite'].textContent = politeEvent;
  }

  /* --- you strip: the reference Seat, in the tray */
  const youName = nicely(you.name || app.name || 'You');
  const youTone = TONES[SEAT_TONES[0]];
  nodes['you-strip'].style.setProperty('--tone-bg', youTone.bg);
  nodes['you-strip'].style.setProperty('--tone-edge', youTone.edge);
  nodes['you-portrait'].textContent = (youName.charAt(0) || 'Y').toUpperCase();
  nodes['you-name'].textContent = youName;
  nodes['you-strip'].classList.toggle('is-acting', yourTurn);
  nodes['you-count'].textContent = String(g.hand.length);
  nodes['you-count-text'].textContent =
    g.hand.length + (g.hand.length === 1 ? ' card in your hand' : ' cards in your hand');
  let youStatus = '';
  let youAlarm = false;
  // The seat pill speaks: a serif italic verb beside the name, never a shout.
  if (over && g.winnerId === snap.youId) youStatus = 'winner!';
  else if (you.vulnerable) { youStatus = 'forgot TONDO!'; youAlarm = true; }
  else if (yourTurn) youStatus = 'your turn';
  else if (!over && nextPlayerId(g) === snap.youId) youStatus = 'you’re next';
  else if (g.hand.length === 1) youStatus = 'one card!';
  else youStatus = 'you';
  setText(nodes['you-status'], youStatus);
  nodes['you-status'].hidden = !youStatus;
  nodes['you-status'].classList.toggle('is-acting', yourTurn);
  nodes['you-status'].classList.toggle('is-alarm', youAlarm);

  /* --- contextual bars */
  nodes['tondo-bar'].hidden = !g.canDeclareTondo;
  nodes['tondo-btn'].disabled = app.offline;

  const targets = (g.calloutTargets || []).filter(Boolean);
  const targetKey = targets.join(',');
  const showCallout = targets.length > 0 && app.calloutDismissed !== targetKey;
  const drawnCard = drawnId ? g.hand.find((c) => c.id === drawnId) : null;
  nodes['callout-bar'].hidden = !showCallout;
  nodes.stage.classList.toggle(
    'is-compressed',
    g.canDeclareTondo || showCallout || !!drawnCard || wildOpen || over,
  );
  if (showCallout) {
    const who = targets.map((id) => nicely(playerName(id))).join(' and ');
    nodes['callout-head'].textContent = `${who} forgot TONDO — call them out`;
    nodes['callout-sub'].textContent = 'One card left and never said it. Catching them costs them +2.';
    nodes['callout-buttons'].innerHTML = targets.map((id) =>
      `<button type="button" class="btn btn-cta" data-callout="${esc(id)}"${app.offline ? ' disabled' : ''}>Call out ${esc(nicely(playerName(id)))}</button>`
    ).join('') + `<button type="button" class="btn btn-quiet" data-callout-skip="1"${app.offline ? ' disabled' : ''}>Let it pass</button>`;
    nodes['callout-buttons'].querySelectorAll('[data-callout]').forEach((btn) => {
      btn.addEventListener('click', () => send({ type: 'callout', targetId: btn.dataset.callout }));
    });
    const skip = nodes['callout-buttons'].querySelector('[data-callout-skip]');
    if (skip) skip.addEventListener('click', () => { app.calloutDismissed = targetKey; renderGame(app.snap); });
  }

  nodes['drawn-bar'].hidden = !drawnCard;
  if (drawnCard) {
    paintStock(nodes['drawn-card'], drawnCard);
    paintFace(drawnCard, {
      index: nodes['drawn-index'], glyph: nodes['drawn-glyph'],
      suit: nodes['drawn-suit'], ghost: nodes['drawn-ghost'],
    });
    nodes['drawn-msg'].textContent =
      `You drew ${prettyCard(drawnCard)} — play it, or keep it and pass.`;
    if (!app.drawnWasOpen) nodes['drawn-play'].focus({ preventScroll: true });
  }
  app.drawnWasOpen = !!drawnCard;
  nodes['drawn-play'].disabled = app.offline;
  nodes['drawn-keep'].disabled = app.offline;

  nodes['wild-bar'].hidden = !wildOpen;
  if (wildOpen) {
    const wildPreview = nodes['wild-bar'].querySelector('.wild-card');
    const wildCard = { value: 'WILD', suit: null };
    paintStock(wildPreview, wildCard);
    paintFace(wildCard, {
      index: nodes['wild-corner'], glyph: nodes['wild-centre'], ghost: nodes['wild-ghost'],
    });
    if (!nodes['wild-grid'].childElementCount) {
      nodes['wild-grid'].innerHTML = SUIT_KEYS.map((k) =>
        `<button type="button" class="btn" data-suit="${k}"
           aria-label="Make the next topping ${SUITS[k].label.toLowerCase()}">${sentence(SUITS[k].label)}</button>`
      ).join('') +
        '<button type="button" class="btn btn-quiet" data-wild-cancel="1">Never mind</button>';
      nodes['wild-grid'].querySelectorAll('[data-suit]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const cardId = app.pendingWild;
          if (!cardId) return;
          app.pendingWild = null;
          send({ type: 'play', cardId, suit: btn.dataset.suit });
          if (app.snap) renderGame(app.snap);
        });
      });
      nodes['wild-grid'].querySelector('[data-wild-cancel]')
        .addEventListener('click', cancelWild);
    }
    // Focus moves in once, when the picker opens — never re-stolen mid-tab.
    if (!app.wildWasOpen) {
      const first = nodes['wild-grid'].querySelector('button');
      if (first) first.focus({ preventScroll: true });
    }
    nodes['wild-grid'].querySelectorAll('button').forEach((btn) => {
      btn.disabled = app.offline;
    });
  }
  app.wildWasOpen = wildOpen;

  // Context bars already explain the event and the required action. Repeating
  // the same sentence on the table only competes with that decision.
  if (g.canDeclareTondo || showCallout || drawnCard || wildOpen) {
    nodes['event-ribbon'].hidden = true;
  }

  /* --- hand */
  const swapHand = !!drawnCard || wildOpen;
  nodes['hand-wrap'].hidden = swapHand;
  nodes['action-row'].hidden = swapHand;
  if (!swapHand) renderHand(g, yourTurn, playable, drawnId);

  setText(nodes['hand-label'], wildOpen ? 'Pick a topping'
    : (drawnCard ? 'Draw decision' : 'Your hand'));
  let playLabel;
  if (over) playLabel = 'Round over';
  else if (drawnCard) playLabel = 'Drawn card only';
  else if (wildOpen) playLabel = '';
  else if (yourTurn) playLabel = playable.size + (playable.size === 1 ? ' playable' : ' playable');
  else playLabel = 'Wait your turn';
  setText(nodes['playable-label'], playLabel);
  const liveLabel = yourTurn && !drawnCard && !wildOpen && !over;
  nodes['playable-label'].classList.toggle('is-live', liveLabel);
  nodes['playable-label'].classList.toggle('is-drawn', !liveLabel && !!drawnCard);

  /* --- action row */
  nodes['draw-btn'].disabled = app.offline || !yourTurn || !!drawnCard || wildOpen;
  nodes['draw-btn'].hidden = over;
  const deckButton = document.getElementById('deck');
  deckButton.disabled = nodes['draw-btn'].disabled || over;
  deckButton.setAttribute('aria-label', deckButton.disabled
    ? `Draw pile — ${g.drawPileCount} cards left`
    : `Draw a card — ${g.drawPileCount} left in the deck`);
  nodes['newround-btn'].hidden = !(over && snap.isHost);
  nodes['newround-btn'].disabled = app.offline;

  /* --- hint + assertive line */
  let hint;
  if (over) hint = snap.isHost ? 'Round over — deal again when you like.' : 'Round over — waiting for the host.';
  else if (wildOpen) hint = 'Pick a topping to continue.';
  else if (drawnCard) hint = 'Decide on the drawn card.';
  else if (yourTurn) hint = (app.handOverflows && !app.handMoved)
    ? 'Swipe to see the rest of your hand.' : 'Play a raised card, or draw from the deck.';
  else {
    const current = g.players.find((p) => p.id === g.turnPlayerId);
    hint = current && !current.connected
      ? `Waiting for ${nicely(current.name)} to reconnect…`
      : `${nicely(playerName(g.turnPlayerId))} is playing — hands off.`;
  }
  setText(nodes.hint, hint);

  let alert = '';
  if (g.canDeclareTondo) alert = 'You are down to two cards. Call TONDO before you play.';
  else if (showCallout) alert = `${targets.map((id) => nicely(playerName(id))).join(' and ')} forgot TONDO. Call them out now.`;
  else if (drawnCard) alert = `You drew ${prettyCard(drawnCard)}. Play it, or keep it and pass.`;
  else if (over) alert = g.winnerId === snap.youId ? 'You win the round.' : `${nicely(playerName(g.winnerId))} wins the round.`;
  if (nodes['live-alert'].textContent !== alert) nodes['live-alert'].textContent = alert;

  if (!over && !yourTurn && app.messageTone !== 'bad') setMessage('', 'info');

  moveToken(snap);
}

/** A small chip that travels the ring to whoever holds the turn — the turn
 *  passing is the Ring Table's one continuous, spatial fact. */
function moveToken(snap) {
  const tok = document.getElementById('turn-token');
  const g = snap.game;
  if (!g || snap.phase !== 'playing' || !g.turnPlayerId) { tok.hidden = true; return; }

  const stage = nodes.stage.getBoundingClientRect();
  if (!stage.width) { tok.hidden = true; return; }
  let x, y;
  if (g.turnPlayerId === snap.youId) {
    // The player strip already has its own pointer and status. A second dot
    // floating above it reads like an unexplained carousel indicator.
    tok.dataset.holder = g.turnPlayerId;
    tok.hidden = true;
    return;
  } else {
    const seatNode = nodes.seats.querySelector(`.seat[data-player="${CSS.escape(g.turnPlayerId)}"]`);
    if (!seatNode) { tok.hidden = true; return; }
    const r = seatNode.getBoundingClientRect();
    x = r.left + r.width / 2 - stage.left;
    y = r.bottom - stage.top + 10;
  }
  const moved = tok.dataset.holder !== g.turnPlayerId;
  tok.dataset.holder = g.turnPlayerId;
  tok.hidden = false;
  tok.style.background = TONES[seatToneOf(g, snap.youId, g.turnPlayerId)].solid;
  tok.style.transform = `translate3d(${(x - 7).toFixed(1)}px, ${(y - 7).toFixed(1)}px, 0)`;
  if (moved && !RM.matches) {
    tok.classList.remove('hop');
    void tok.offsetWidth;
    tok.classList.add('hop');
  }
}

/** Which of the four Stone Oven tones a player wears, relative to you. */
function seatToneOf(g, youId, id) {
  const i = g.players.findIndex((p) => p.id === id);
  const y = g.players.findIndex((p) => p.id === youId);
  if (i < 0) return SEAT_TONES[0];
  const n = g.players.length;
  return SEAT_TONES[(((i - y) % n) + n) % n];
}

function renderQueue(snap, g, over) {
  const active = g.players.find((p) => p.id === g.turnPlayerId);
  const nextId = nextPlayerId(g);
  const next = g.players.find((p) => p.id === nextId);
  const colorOf = (id) => TONES[seatToneOf(g, snap.youId, id)].solid;
  let verb;
  if (over) verb = (g.winnerId === snap.youId ? 'You win!' : nicely(playerName(g.winnerId)) + ' wins!');
  else if (g.turnPlayerId === snap.youId) verb = 'Your turn';
  else if (active && !active.connected) verb = 'Waiting for ' + nicely(active.name) + '…';
  else verb = nicely(active ? active.name : '') + ' is playing';
  const leadId = over ? g.winnerId : g.turnPlayerId;
  // The pill is the header's turn chip: a dot in the holder's tone, then the
  // verb. Whoever is next follows in the serif voice, not a second chip.
  let html = `<span class="chip">
      <span class="dot" style="background:${colorOf(leadId)}"></span>
      <span class="txt">${esc(verb)}</span></span>`;
  if (!over && next) {
    html += `<span class="chip chip-next">
      <span class="txt">then ${esc(next.id === snap.youId ? 'you' : nicely(next.name))}</span></span>`;
  }
  // Identical repaints are skipped so the chips are not torn down on every
  // unrelated snapshot; turn-change motion itself is the token's job.
  if (html !== app.lastQueueHtml) { nodes.queue.innerHTML = html; app.lastQueueHtml = html; }
}

/** Faces for the discard cards already buried under the top one. */
function paintUnder(node, c) {
  if (!c) { node.hidden = true; return; }
  node.hidden = false;
  paintStock(node, c);
  paintFace(c, {
    index: node.querySelector('.card-index'), glyph: node.querySelector('.card-glyph'),
    suit: node.querySelector('.card-suit'), ghost: node.querySelector('.card-ghost'),
  });
}

/* ---------------------------------------------------- the Slice Ledger ---
   The pie records OWNERSHIP. Every card played drops a topping into the wedge
   of the player who played it, the lit wedge is whose turn it is, and a Flip
   spins the glow the long way round. Ported from the designer's "Slice Ledger"
   concept: the placement algorithm, the shape table and the deterministic
   pseudo-random below are the concept's own. What is ours is the annulus —
   the concept lets toppings slide under its centre plaque and our discard card
   is far too big to hide anything behind, so ledgerGeom() measures the centre
   furniture and every piece is placed clear of it.

   This REPLACES the old count system, where the pieces on the pie spelled the
   number on the top card. Two systems on one surface would have cancelled each
   other out: a ledger only reads as a ledger if nothing else writes to it. */

/** The concept's hash noise. A topping keeps its spot across any number of
 *  re-layouts because its position is a pure function of its seed. */
function rnd(i, s) {
  const x = Math.sin(i * 127.1 + s * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/* The concept's shape table, in --tp-u units — the same numbers the stylesheet
   draws with. Needed here only to know how much clearance a piece wants. */
const TP_SIZE = { pepperoni: [26, 26], basil: [28, 28], cheese: [26, 22], anchovy: [31, 14] };

/* THE CAP. A long round is 50+ plays and the concept never caps, so the pie
   would silently turn to mush and the node count would climb all round.
   ~30 topping nodes is the whole budget, split evenly between the wedges.
   The number is the annulus a wedge actually has, measured rather than
   guessed: at an 825px table the band left between the discard and the crust
   is ~140px deep, and a four-player wedge subtends ~310px of arc at its
   mid-radius — ~44,000px² against a ~2,500px² topping, so 17 pieces at 100%
   packing and ~8 at the ~45% coverage where individual pieces still read.
   30/n gives 15 / 10 / 8 for 2 / 3 / 4 players and holds the node count flat
   for the whole round whatever the table size.
   The oldest few in each wedge sink and dim on their way out, so the cap reads
   as toppings settling into the cheese rather than as pieces blinking off. */
const LEDGER_BUDGET = 30;
const LEDGER_AGE = 3;   // how many of a wedge's oldest sink into the cheese

function ledgerCap(n) { return Math.max(5, Math.round(LEDGER_BUDGET / Math.max(n, 1))); }

/* Wedge centres, in screen degrees: 0 = right, positive = clockwise, so 90deg
   is the BOTTOM of the pie — yours, because your hand is in the tray below it.
   The others follow in PLAY order, which is the order renderSeats walks its
   left → top → right slots in, so the glow sweeping from wedge to wedge IS the
   turn going round the table.
     4 players land exactly on left / top / right (180 / 270 / 0).
     2 players put the one opponent opposite you (270).
     3 players cannot tile a circle on those slots — 90/180/0 at 120deg each
     both overlaps and leaves the top of the pie unowned — so the three wedges
     sit at 90 / 210 / 330: your slice faces you and the other two flank the
     top. That is the concept's own three-player layout. */
function wedgeAngle(offset, n) { return 90 + offset * (360 / n); }

/* The lit slice as ONE closed path: centre → 12 o'clock → arc → back. The
 *  stylesheet strokes it, so the two radii and the arc are the same weight and
 *  the corners are real joins rather than three layers ending near each other.
 *  viewBox units, 50 = the sauce radius. The path radius is pulled in by half
 *  the stroke (--wedge-stroke: .63) so the stroke's outer edge lands at 49.85
 *  — just inside the crust, never across it. */
const SECTOR_R = +(49.85 - 0.63 / 2).toFixed(3);
function sectorPath(spanDeg) {
  const a = spanDeg * Math.PI / 180;
  const x1 = (50 + SECTOR_R * Math.sin(a)).toFixed(3);
  const y1 = (50 - SECTOR_R * Math.cos(a)).toFixed(3);
  const large = spanDeg > 180 ? 1 : 0;
  return `M50 50L50 ${(50 - SECTOR_R).toFixed(3)}A${SECTOR_R} ${SECTOR_R} 0 ${large} 1 ${x1} ${y1}Z`;
}

/** playerId → seats from you, 0 being you, counting in play order. */
function seatOffsets(g, youId) {
  const ps = g.players;
  const i = Math.max(0, ps.findIndex((p) => p.id === youId));
  const map = new Map();
  ps.forEach((p, k) => map.set(p.id, (((k - i) % ps.length) + ps.length) % ps.length));
  return map;
}

/** How far a ray leaving the sauce centre stays inside one keep-out box, in px;
 *  0 if it never enters it. Slab test — the origin may be inside the box.
 *  `pad` grows the box on every side first. That padding is the whole trick:
 *  clearing the box along the RAY is not enough, because a topping's square
 *  can still poke back over the box's CORNER — measured, two of thirty-two did
 *  exactly that on a 375px phone. Padding by the piece's own half-diagonal
 *  (a Minkowski sum) makes "centre outside the padded box" mean "shape outside
 *  the real one", from any angle and at any rotation. */
function rayExit(dx, dy, b, pad) {
  const x0 = b.x0 - pad, x1 = b.x1 + pad, y0 = b.y0 - pad, y1 = b.y1 + pad;
  let lo = -Infinity, hi = Infinity;
  if (Math.abs(dx) < 1e-6) { if (x0 > 0 || x1 < 0) return 0; }
  else {
    let t0 = x0 / dx, t1 = x1 / dx;
    if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
    lo = Math.max(lo, t0); hi = Math.min(hi, t1);
  }
  if (Math.abs(dy) < 1e-6) { if (y0 > 0 || y1 < 0) return 0; }
  else {
    let t0 = y0 / dy, t1 = y1 / dy;
    if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
    lo = Math.max(lo, t0); hi = Math.min(hi, t1);
  }
  return hi <= Math.max(lo, 0) ? 0 : hi;
}

/* The two boxes in the centre column whose width is TEXT, measured at their
   WIDEST possible wording rather than at whatever they happen to say now.
   Without this the keep-out breathes: "Topping ● Cheese" and "Match ↻ ●
   Pepperoni or Flip" differ by ~25px, and "Counter-clockwise" is half as wide
   again as "Clockwise" — so toppings shuffled every time the words changed,
   and worse, a piece placed against the SHORT plaque ended up under the long
   one (measured: 11 clipped frames in a 47-play round).
   Measured on a hidden clone inside the stage, so it inherits every variable
   the real column does; once per viewport size, never during a paint the user
   can see. */
function centreWorst() {
  const key = `${window.innerWidth}x${window.innerHeight}`;
  if (app.centreWorst && app.centreWorst.key === key) return app.centreWorst;
  const centre = document.querySelector('.center');
  if (!centre || !nodes.stage) return null;
  const ghost = centre.cloneNode(true);
  ghost.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.cssText =
    'position:absolute;left:-10000px;top:0;transform:none;visibility:hidden;pointer-events:none';
  const suit = ghost.querySelector('.match-suit');
  const value = ghost.querySelector('.match-value');
  const orWrap = ghost.querySelector('.plaque-pair.fx-tight');
  const dirLabel = ghost.querySelector('.dir-label');
  // the longest suit name against the longest ACTIONS label — the same worst
  // case --min-orbit is derived from in styles.css
  if (suit) suit.textContent = sentence(SUITS.pepperoni.label);
  if (value) value.textContent = ACTIONS.REVERSE;
  if (orWrap) { orWrap.hidden = false; orWrap.style.transition = 'none'; }
  if (dirLabel) dirLabel.textContent = 'Counter-clockwise';
  nodes.stage.appendChild(ghost);
  const p = ghost.querySelector('.plaque');
  const d = ghost.querySelector('.dir');
  // Height as well as width: .plaque is rotated -2deg, so its BOUNDING box
  // grows taller as it grows wider (w x sin2deg is ~7px at the widest wording).
  // Taking only the width left a ~1px breath in the keep-out on every text
  // change — invisible, but it moved settled toppings, which is not nothing.
  const box = (n) => (n ? n.getBoundingClientRect() : { width: 0, height: 0 });
  const pr = box(p), dr = box(d);
  const worst = { key, plaque: pr.width, plaqueH: pr.height, dir: dr.width, dirH: dr.height };
  ghost.remove();
  app.centreWorst = worst;
  return worst;
}

/* The centre furniture, MEASURED rather than derived — no expression in
   --table-d can predict a text box, and the whole column shifts when a context
   bar compresses the table. Four live rects per repaint is cheap, and the
   signature they return lets layoutLedger skip the work when nothing moved. */
function ledgerGeom() {
  if (!nodes.sauce) return null;
  /* #top-card is listed as well as .pile: the card is rotated, so its own box
     is WIDER than the stack that contains it — measured .118 of the table
     against the pile's .109 — and clearing only the pile let two toppings in
     twenty-six clip the discard. */
  const parts = [['plaque', nodes.plaque], ['pile', nodes.pile],
                 ['card', nodes['top-card']], ['dir', nodes.dir]];
  /* Anything mid-animation reports a TRANSFORMED box — a landing discard is
     briefly 7% larger, a popping plaque 3%. Hold the last geometry instead. */
  for (const [, n] of parts) {
    if (n && n.getAnimations && n.getAnimations().length) { app.geomHeld = true; return app.ledgerGeom; }
  }
  app.geomHeld = false;
  const box = nodes.sauce.getBoundingClientRect();
  const R = box.width / 2;
  if (!R) return null;
  /* The crust's outer edge, and the ledger's hard ceiling. R alone was not a
     ceiling a wedge could always be placed inside: the centre column is TEXT
     and does not shrink with the table, so at desktop sizes the plaque's
     keep-out reached further up the pie than the sauce's own radius and the
     top wedge had NO band at all (measured -75.6px at 1800x900). A topping in
     that state was pushed outward past `overflow: hidden` and simply vanished.
     Between R and RO there is a whole crust of bake to land on, which is worse
     than the sauce and much better than gone. */
  const crustEl = nodes.sauce.parentElement;
  const RO = crustEl ? crustEl.getBoundingClientRect().width / 2 : R;
  const cx = box.left + R, cy = box.top + box.height / 2;
  const worst = centreWorst();

  const boxes = [];
  let sig = '';
  for (const [name, n] of parts) {
    if (!n) continue;
    const b = n.getBoundingClientRect();
    if (!b.width) continue;
    // Both text boxes are centred on the column, which is centred on the pie,
    // so their worst-case size can be hung on the live box's centre: the
    // centre is layout, which the wording does not move, while the SIZE is the
    // part that breathes.
    const halfW = ((worst && worst[name]) || b.width) / 2;
    const halfH = ((worst && worst[`${name}H`]) || b.height) / 2;
    const midY = b.top + b.height / 2 - cy;
    const grown = { x0: -halfW, x1: halfW, y0: midY - halfH, y1: midY + halfH };
    boxes.push(grown);
    sig += `${halfW.toFixed(1)},${grown.y0.toFixed(1)},${grown.y1.toFixed(1)};`;
  }
  const geom = { R, RO, boxes, u: cssPx(nodes.stage, '--tp-u', 1), key: `${R.toFixed(1)}|${RO.toFixed(1)}|${sig}` };
  app.ledgerGeom = geom;
  return geom;
}

/** Positions every topping. Cheap and idempotent, so it can run on each
 *  repaint and on resize; it only writes when the geometry or the ledger
 *  actually changed. */
function layoutLedger(g, force) {
  if (!nodes.ledger || !app.ledger.length) return;
  const geom = ledgerGeom();
  if (!geom) return;
  /* ledgerGeom HOLDS its last measurement while any centre part is
     mid-animation, and the signature check below would then decide nothing had
     moved and return. A window resize that lands during a landing discard
     therefore left every topping placed for the PREVIOUS pie until something
     else happened to repaint it — with bots that is up to 2.6s, and the pieces
     spend it sitting on the MATCH plaque. Ask again next frame until the
     geometry is real. This must sit BEFORE the early-out, or the retry dies
     with the first unchanged key. */
  if (app.geomHeld && !app.ledgerRaf) {
    app.ledgerRaf = requestAnimationFrame(() => {
      app.ledgerRaf = 0;
      const live = app.snap && app.snap.game;
      if (live) layoutLedger(live, true);
    });
  }
  const n = Math.max(g.players.length, 1);
  const spread = 360 / n;
  const offsets = seatOffsets(g, app.youId);
  const key = `${geom.key}|${app.ledgerKey}|${n}`;
  if (!force && key === app.ledgerLaidOut) return;
  app.ledgerLaidOut = key;

  const total = new Map();
  for (const t of app.ledger) total.set(t.owner, (total.get(t.owner) || 0) + 1);
  const cap = ledgerCap(n);
  const seen = new Map();

  for (const t of app.ledger) {
    // Ownership is re-read from the CURRENT table, so a player leaving re-tiles
    // the pie instead of stranding their toppings on a wedge nobody owns.
    if (offsets.has(t.owner)) t.offset = offsets.get(t.owner);
    // The concept's scatter: inside the wedge, never quite on its centre line.
    const ang = (wedgeAngle(t.offset, n) + t.jitter * spread * 0.775) * Math.PI / 180;
    const dx = Math.cos(ang), dy = Math.sin(ang);

    const size = TP_SIZE[t.suit] || TP_SIZE.pepperoni;
    // Circumscribed radius: the shape carries a random rotation, so it has to
    // clear the furniture from every angle, not just its resting one.
    const half0 = geom.u * Math.hypot(size[0], size[1]) / 2;
    const exitAt = (ux, uy, pad) => {
      let out = 0;
      for (const b of geom.boxes) out = Math.max(out, rayExit(ux, uy, b, pad));
      return out;
    };
    /* THE ANNULUS FLOOR. What one bearing has to offer, as a band [rMin, rMax]:
       rMin is outside the centre furniture, rMax is as far out as the piece may
       go. Sliding under the discard is the one outcome that is never allowed —
       you must be able to see what you match — so when the sauce band collapses
       the band grows OUTWARD over the crust instead, and only by as much as the
       starved wedge actually needs. `outer` is that hard ceiling; a piece
       placed at it is on the bake, still inside .crust's clip, still visible. */
    const outer = geom.RO - geom.u * 2;
    const place = (ux, uy) => {
      let half = half0;
      // Straight down on a 375px phone there is barely a piece's worth of band,
      // so the piece gives way rather than the clearance: it shrinks to fit,
      // down to 45% before it stops.
      const room = Math.max(0, outer - geom.u * 2 - exitAt(ux, uy, 0));
      let fit = 1;
      if (room < half * 2) { fit = Math.max(0.45, room / (half * 2)); half *= fit; }
      const rMin = exitAt(ux, uy, half) + geom.u * 2;
      const rSauce = geom.R - half - geom.u * 3;
      const rHard = outer - half;
      const rMax = Math.max(rSauce, Math.min(rHard, rMin + geom.u * 10));
      return { half, fit, rMin, rMax, rHard, slack: rHard - rMin };
    };

    let dirX = dx, dirY = dy, slot = place(dx, dy);
    if (slot.slack < half0) {
      /* Not even the crust has room on this bearing — the plaque's keep-out is
         deeper than the pie is wide here. Sweep the owner's own slice for the
         bearing with the most room and take that: a topping moves ASIDE within
         its wedge, which still reads as ownership, rather than under the
         discard, which reads as nothing. */
      for (let k = -6; k <= 6; k++) {
        const a2 = (wedgeAngle(t.offset, n) + (k / 6) * (spread * 0.44)) * Math.PI / 180;
        const ux = Math.cos(a2), uy = Math.sin(a2);
        const cand = place(ux, uy);
        if (cand.slack > slot.slack) { slot = cand; dirX = ux; dirY = uy; }
      }
    }
    const fit = slot.fit;
    // Last resort, and it should never fire once the geometry above holds: if
    // the whole slice is covered there is no honest place for the piece, so it
    // is not painted at all rather than painted where it lies.
    const homeless = slot.slack < 0;
    const rad = Math.min(slot.rHard, slot.rMax > slot.rMin
      ? slot.rMin + t.t * (slot.rMax - slot.rMin)
      : slot.rMin);
    t.node.style.left = `${(50 + (rad * dirX) / (2 * geom.R) * 100).toFixed(3)}%`;
    t.node.style.top = `${(50 + (rad * dirY) / (2 * geom.R) * 100).toFixed(3)}%`;

    // Ageing: a piece dims and sinks as it nears eviction, so the cap reads as
    // toppings settling into the cheese rather than as pieces blinking out.
    const idx = seen.get(t.owner) || 0;
    seen.set(t.owner, idx + 1);
    const life = idx + (cap - (total.get(t.owner) || 1));
    const f = Math.min(1, Math.max(0, life / LEDGER_AGE));
    t.node.style.setProperty('--age-s', ((0.74 + 0.26 * f) * fit).toFixed(3));
    t.node.style.setProperty('--age-o', (homeless ? 0 : 0.5 + 0.5 * f).toFixed(3));
  }

  /* --table-d EASES (a context bar takes a bite out of the stage), and while it
     does, the sauce is mid-flight while the MATCH plaque is a fixed-px box that
     does not move at all — so the fraction of the pie the plaque covers changes
     on every frame of the ease. Laying out once at the start of it places
     toppings for a pie that is about to stop existing, and they clip the plaque
     until the next snapshot repaints, up to 2.6s later with bots. Keep
     re-spacing until the table lands; ~12 frames of ≤32 nodes. */
  if (!app.ledgerRaf && nodes.stage.getAnimations
      && nodes.stage.getAnimations().some((a) => a.transitionProperty === '--table-d')) {
    app.ledgerRaf = requestAnimationFrame(() => {
      app.ledgerRaf = 0;
      const live = app.snap && app.snap.game;
      if (live) layoutLedger(live, true);
    });
  }
}

/** A new round is a new pie. */
function ledgerClear() {
  app.ledger = [];
  app.tally = new Map();
  app.ledgerKey = 0;
  app.ledgerLaidOut = '';
  if (nodes.ledger) nodes.ledger.replaceChildren();
}

/** One card played → one topping in that player's wedge. */
function ledgerAdd(g, ownerId, suit, delay) {
  if (!nodes.ledger || !ownerId || !TP_SIZE[suit]) return;
  const n = Math.max(g.players.length, 1);
  const offsets = seatOffsets(g, app.youId);
  const seed = ++app.ledgerSeq;

  const node = document.createElement('div');
  node.className = 'tp';
  const drop = document.createElement('div');
  drop.className = 'tp-drop';
  // The card gets to land first: with a flight in the air the topping waits
  // exactly as long as the ghost takes, so the pie answers the play instead of
  // pre-empting it. Reduced motion has no flight, so it waits for nothing.
  if (delay) drop.style.setProperty('--drop-delay', `${delay}ms`);
  if (!RM.matches) {
    const ripple = document.createElement('span');
    ripple.className = 'tp-ripple';
    if (delay) ripple.style.setProperty('--drop-delay', `${delay}ms`);
    drop.appendChild(ripple);
    // The grease ring is a one-shot; it must not stay in the tree all round.
    setTimeout(() => ripple.remove(), delay + 900);
  }
  const shape = document.createElement('span');
  shape.className = `tp-shape tp-shape--${suit}`;
  shape.style.setProperty('--tp-rot', `${Math.round(rnd(seed, 5) * 360)}deg`);
  drop.appendChild(shape);
  node.appendChild(drop);
  nodes.ledger.appendChild(node);

  app.ledger.push({
    owner: ownerId, suit, node,
    offset: offsets.has(ownerId) ? offsets.get(ownerId) : 0,
    jitter: rnd(seed, 3) - 0.5,
    t: rnd(seed, 9),
  });
  app.tally.set(ownerId, (app.tally.get(ownerId) || 0) + 1);

  // Trim this wedge back to its share of the budget, oldest first.
  const cap = ledgerCap(n);
  let count = 0;
  for (const t of app.ledger) if (t.owner === ownerId) count++;
  while (count > cap) {
    const i = app.ledger.findIndex((t) => t.owner === ownerId);
    app.ledger[i].node.remove();
    app.ledger.splice(i, 1);
    count--;
  }
  app.ledgerKey++;
}

/** The lit wedge follows the turn. A Flip sends it the long way round — the
 *  concept's stated way to read a direction change, and the only place on this
 *  board where the play order is a MOVEMENT rather than an arrow. */
function moveGlow(g, over) {
  const glow = nodes['wedge-glow'];
  if (!glow) return;
  const n = Math.max(g.players.length, 1);
  const spread = 360 / n;
  const lit = over ? '' : g.turnPlayerId;
  glow.dataset.lit = lit ? '1' : '0';
  if (!lit) return;
  const offset = seatOffsets(g, app.youId).get(lit);
  if (offset === undefined) return;

  // conic-gradient counts from 12 o'clock, screen angles from 3 o'clock.
  const base = wedgeAngle(offset, n) - spread / 2 + 90;
  let step = 0;
  if (app.glowRot === null) {
    app.glowRot = base;
  } else {
    const forward = (((base - app.glowRot) % 360) + 360) % 360;   // clockwise
    if (forward > 0.01) {
      const dir = g.direction || 1;
      step = dir === 1 ? forward : forward - 360;   // the short way, in play order
      // ...unless the order just flipped, in which case the glow carries on
      // the way it was already going and takes the long arc to the new wedge.
      if (app.glowDir !== null && app.glowDir !== dir) {
        step = step > 0 ? step - 360 : step + 360;
      }
      app.glowRot += step;
    }
  }
  app.glowDir = g.direction || 1;
  // A ~3x longer arc cannot run at the same duration and stay readable, but
  // matching its angular speed would take 1.6s. 800ms is the compromise.
  glow.style.setProperty('--glow-t', Math.abs(step) > 190 ? '800ms' : '420ms');
  glow.style.setProperty('--glow-rot', `${app.glowRot.toFixed(2)}deg`);
}

/* Whose wedge is whose, as a wash of the owner's SEAT tone across their slice.
   The concept labels each wedge with the player's name out on the crust, at
   46% of the pie's width. That cannot work here and the numbers say so: our
   side seats are ON the table, and their plates reach in to .558 of the ring's
   radius — straight over where a tag at .92 of it would sit. (The concept's
   seats sit above its pie, so it has that ring free.) A tone per slice carries
   the same fact, in the same colour as the seat tile it belongs to, and there
   is nothing for the seats to cover up. */
function renderWedgeTones(snap, g) {
  const layer = nodes['wedge-tones'];
  if (!layer) return;
  const n = Math.max(g.players.length, 1);
  const spread = 360 / n;
  const byOffset = [];
  const offsets = seatOffsets(g, snap.youId);
  for (const p of g.players) {
    const offset = offsets.get(p.id);
    if (offset !== undefined) byOffset[offset] = TONES[seatToneOf(g, snap.youId, p.id)].solid;
  }
  // conic 0deg is 12 o'clock and the first sector after `from` is YOUR wedge,
  // so the stops walk the seats in play order exactly as the glow does.
  const stops = [];
  for (let k = 0; k < n; k++) {
    /* .13 was a rumour, not a wash: adjacent wedges measured 1.004-1.118:1 and
       two of the four boundaries were mathematically indistinguishable. .30 is
       as far as this can go and still read as sauce rather than paint — and the
       ratio only reaches 1.03-1.26:1 even so, because these four hues are
       luminance-twins over this sauce. The BOUNDARY is what carries ownership
       now (see .sauce-slices); this is the second, hue-carried cue behind it. */
    const c = tint(byOffset[k] || '#000000', .38);
    stops.push(`${c} ${(k * spread).toFixed(3)}deg ${((k + 1) * spread).toFixed(3)}deg`);
  }
  const css = `conic-gradient(from ${(180 - spread / 2).toFixed(3)}deg, ${stops.join(', ')})`;
  if (layer.style.backgroundImage !== css && layer.dataset.k !== css) {
    layer.dataset.k = css;
    layer.style.backgroundImage = css;
  }
}

function renderCenter(snap, g, over) {
  const aSuit = activeSuitOf(g);
  const s = SUITS[aSuit];
  const top = g.topCard || { value: '0', suit: aSuit };
  const wildTop = isWild(top);

  // The one table layer that still answers to the active topping. The variable
  // is set ON that layer rather than on #ring: a custom property on a parent
  // recalculates styles for every descendant, and #ring owns the whole oven.
  const tintLayer = nodes.ring.querySelector('.sauce-tint');
  if (tintLayer) tintLayer.style.setProperty('--ring-fill', tint(s.c, .10));

  // How the pie is cut. Written once per player count onto .sauce — the wedge
  // hairlines, the turn glow and its leading edge all read the same two
  // values, so they can never disagree about where a slice starts.
  const span = `${(360 / Math.max(g.players.length, 1)).toFixed(4)}deg`;
  if (nodes.sauce && nodes.sauce.style.getPropertyValue('--wedge-span') !== span) {
    nodes.sauce.style.setProperty('--wedge-span', span);
    nodes.sauce.style.setProperty('--wedge-from', `${(180 - 360 / Math.max(g.players.length, 1) / 2).toFixed(4)}deg`);
    // The lit slice is a stroked path, not a gradient, so its geometry is
    // written here from the same number — one place, three sides, no drift.
    if (nodes['wedge-sector']) nodes['wedge-sector'].setAttribute('d', sectorPath(360 / Math.max(g.players.length, 1)));
  }
  renderWedgeTones(snap, g);
  moveGlow(g, over);

  // MATCH plaque: cream paper, the suit dot and its name in the suit's ink.
  nodes.plaque.style.setProperty('--suit-solid', s.c);
  nodes.plaque.style.setProperty('--suit-edge', s.edge);
  nodes['match-label'].textContent = wildTop ? 'Topping' : 'Match';
  nodes['match-glyph'].textContent = s.glyph;   // the CSS dot carries it visually
  nodes['match-suit'].textContent = sentence(s.label);
  nodes['match-or-wrap'].hidden = wildTop;
  nodes['match-value'].textContent = wildTop ? '' : sentence(matchValueText(g));
  nodes['dir-badge'].textContent = g.direction === 1 ? '↻' : '↺';
  nodes['dir-glyph'].textContent = g.direction === 1 ? '↻' : '↺';
  nodes['dir-label'].textContent = g.direction === 1 ? 'Clockwise' : 'Counter-clockwise';
  nodes['deck-count'].textContent = g.drawPileCount;

  // The pile remembers what it covered, so the discard has visible depth.
  if (g.topCard && (!app.pile.length || app.pile[0].id !== g.topCard.id)) {
    app.pile.unshift(g.topCard);
    app.pile.length = Math.min(app.pile.length, 3);
  }
  paintUnder(nodes['under-1'], app.pile[1]);
  paintUnder(nodes['under-2'], app.pile[2]);

  paintStock(nodes['top-card'], top);
  nodes['top-card'].setAttribute('aria-label', `Top card: ${prettyCard(top)}`);
  paintFace(top, {
    index: nodes['top-index'], glyph: nodes['top-glyph'],
    suit: nodes['top-suit'], ghost: nodes['top-ghost'],
  });

  // LAST, deliberately: the ledger clears the MATCH plaque and the discard, and
  // both were just repainted. Measuring before this point reads the previous
  // turn's plaque — which is how a topping ended up under the card.
  layoutLedger(g);
}

/* The fan beside a seat shows the shape of a hand, not its exact size — the
   badge on the tile carries the true count. */
const FAN_ROTS = [-10, -2, 6, 13];

function renderSeats(snap, g, over) {
  const around = seatsAroundYou(g, snap.youId);
  const nextId = over ? '' : nextPlayerId(g);
  const maxBacks = COMPACT.matches ? 3 : 4;

  const seatsHtml = around.map(({ p, slot, offset }) => {
    const tone = TONES[SEAT_TONES[offset % SEAT_TONES.length]];
    const acting = !over && p.id === g.turnPlayerId && p.connected;
    const isNext = p.id === nextId && !acting;
    const one = p.cardCount === 1;
    const name = nicely(p.name);

    let backs = '';
    const shown = Math.min(p.cardCount, maxBacks);
    for (let k = 0; k < shown; k++) {
      backs += `<span class="mini-back back-face" style="transform:rotate(${FAN_ROTS[k] || 0}deg)"></span>`;
    }

    let status = '', loud = false, alarm = false;
    if (over && g.winnerId === p.id) { status = 'wins!'; loud = true; }
    // Absence outranks the turn: a table stalled on a dropped player must
    // say so, not pretend they are thinking.
    else if (!p.connected) { status = 'away — reconnecting'; }
    else if (p.vulnerable) { status = 'forgot TONDO!'; alarm = true; }
    else if (acting) { status = 'playing…'; loud = true; }
    else if (isNext) { status = 'next'; }
    else if (one) { status = 'one card!'; }
    else if (p.declaredTondo) { status = 'TONDO!'; }
    else status = 'waiting';

    const toneVars = `--tone-bg:${tone.bg};--tone-edge:${tone.edge}`;
    const cardWord = p.cardCount === 1 ? 'card' : 'cards';
    const seatLabel = `${name}, ${p.cardCount} ${cardWord}, ${status}`;
    return `<div class="seat seat-${slot} ${acting ? '' : (isNext ? 'is-next' : 'is-idle')}" data-player="${esc(p.id)}" role="img" aria-label="${esc(seatLabel)}">
      <div class="plate ${acting ? 'is-acting' : ''} ${(loud || alarm) && !acting ? 'is-loud' : ''}">
        <div class="seat-body">
          <div class="stack" style="${toneVars}">
            ${acting ? '<span class="seat-ring"></span>' : ''}
            <span class="seat-tile"><span class="seat-initial">${esc((name.charAt(0) || '?').toUpperCase())}</span></span>
            <span class="count-badge">${p.cardCount}</span>
          </div>
          <div class="fan">${backs}</div>
        </div>
        <div class="seat-status ${alarm ? 'is-alarm' : (loud ? 'is-loud' : '')}">
          <span class="seat-name">${esc(name)}</span>
          <span class="seat-verb">${esc(status)}</span>
        </div>
      </div>
    </div>`;
  }).join('');
  // Skip identical repaints so the acting plate's bob is not restarted (and
  // the pop not replayed) by every unrelated snapshot.
  if (seatsHtml !== app.lastSeatsHtml) {
    nodes.seats.innerHTML = seatsHtml;
    app.lastSeatsHtml = seatsHtml;
  }
}

/**
 * The whole face: corner index, overflowing ghost number, the flat mark in
 * its cream circle, and the DM Mono code. Every size comes from CSS, scaled
 * from the card's own --cw, so this never needs repainting on a resize.
 */
function paintFace(card, target, opts) {   // eslint-disable-line no-unused-vars
  const f = face(card);
  if (target.index) target.index.textContent = f.corner;
  if (target.ghost) target.ghost.textContent = f.corner;
  if (target.glyph && target.glyph.dataset.mark !== f.mark) {
    target.glyph.innerHTML = MARK_HTML[f.mark] || '';
    target.glyph.dataset.mark = f.mark;
  }
  if (target.suit) target.suit.textContent = f.code;
  return f;
}

/** A registered <length> custom property, in px, as it computes ON `el`.
 *  Unregistered custom properties hand back their raw token stream (e.g.
 *  "clamp(20px, …)"), which parses to NaN — hence the fallback. */
function cssPx(el, property, fallback) {
  const value = Number.parseFloat(getComputedStyle(el).getPropertyValue(property));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function paintCardFace(btn, c) {
  paintStock(btn, c);
  paintFace(c, {
    index: btn.querySelector('.card-index'),
    glyph: btn.querySelector('.card-glyph'),
    suit: btn.querySelector('.card-suit'),
    ghost: btn.querySelector('.card-ghost'),
  });
}

function buildCard(c) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'card';
  btn.dataset.card = c.id;
  btn.style.setProperty('--jit', jitterOf(c.id).toFixed(2) + 'deg');
  btn.innerHTML = '<div class="card-index"></div><div class="card-glyph"></div>' +
    '<div class="card-suit"></div><div class="card-ghost"></div><div class="card-tick">✓</div>';
  paintCardFace(btn, c);
  btn.addEventListener('click', () => tapCardId(c.id));
  btn.addEventListener('mouseenter', () => previewCardId(c.id));
  btn.addEventListener('focus', () => previewCardId(c.id));
  return btn;
}

/**
 * Keyed reconciliation: a card keeps its node for as long as it is in the
 * hand. That is what lets CSS transitions (the playable lift, the fan) and
 * running animations survive a snapshot, keeps the scroll position, and keeps
 * keyboard focus alive across a repaint.
 */
function renderHand(g, yourTurn, playable, drawnId) {
  const row = nodes['hand-row'];
  const focusedId = document.activeElement && document.activeElement.dataset
    ? document.activeElement.dataset.card : null;
  const focusedIndex = focusedId
    ? [...row.children].findIndex((n) => n.dataset.card === focusedId) : -1;

  const live = new Map([...row.children].map((n) => [n.dataset.card, n]));
  const entering = [];
  g.hand.forEach((c, i) => {
    let btn = live.get(c.id);
    if (!btn) {
      btn = buildCard(c);
      row.appendChild(btn);
      entering.push(btn);
    } else {
      live.delete(c.id);   // the node is kept: its face and sizes still hold
    }
    if (row.children[i] !== btn) row.insertBefore(btn, row.children[i] || null);
    const ok = yourTurn && playable.has(c.id) && !drawnId;
    btn.classList.toggle('is-playable', ok);
    btn.classList.toggle('is-dimmed', !!drawnId);
    btn.classList.toggle('is-armed', app.armedCard === c.id);
    // Not `disabled`: the hand stays focusable off-turn so it can be read
    // and planned from; taps are rejected in tapCardId with an explanation.
    btn.disabled = app.offline;
    btn.setAttribute('aria-disabled', (ok && !app.offline) ? 'false' : 'true');
    const cardState = app.armedCard === c.id
      ? ' — selected; tap again to play'
      : (app.offline ? ' — reconnecting'
        : (yourTurn ? (playable.has(c.id) ? ' — playable' : ' — does not match') : ' — not your turn'));
    btn.setAttribute('aria-label', prettyCard(c) + cardState);
    const rawOffset = i - (g.hand.length - 1) / 2;
    // Preserve the playful fan without letting large hands rotate or drop
    // farther with every draw. Seven cards reach the full three-step arc;
    // larger hands distribute themselves across that same bounded arc.
    const fanScale = g.hand.length > 7 ? 6 / (g.hand.length - 1) : 1;
    const off = rawOffset * fanScale;
    btn.style.setProperty('--off', off.toFixed(2));
    btn.style.setProperty('--abs-off', Math.abs(off).toFixed(2));
  });
  live.forEach((n) => n.remove());

  /* Cards arriving together are staggered rather than appearing as one block —
     a seven-card round-start deal reads as a deal, a single drawn card (k = 0)
     gets no delay at all and stays instant. The transform effect composites
     ONTO the CSS fan transform, so a card never snaps into its lean when the
     entry finishes; opacity is a separate effect because additive opacity
     would cancel the fade. */
  if (entering.length && !RM.matches) {
    entering.forEach((node, k) => {
      const timing = {
        duration: MS.handIn,
        delay: Math.min(k, 6) * MS.dealStep,
        easing: EASE_OUT,
        fill: 'backwards',   // invisible during its delay, not popped in early
      };
      node.animate(
        [{ transform: 'translateY(22px) scale(.92)' }, { transform: 'translateY(0) scale(1)' }],
        { ...timing, composite: 'add' });
      node.animate([{ opacity: 0 }, { opacity: 1 }], timing);
    });
  }

  if (focusedId && document.activeElement === document.body && row.children.length) {
    // The focused card left the hand (it was played): land on its neighbour.
    const again = row.querySelector(`[data-card="${CSS.escape(focusedId)}"]`);
    const fallback = row.children[Math.min(Math.max(focusedIndex, 0), row.children.length - 1)];
    (again || fallback).focus({ preventScroll: true });
  }
  /* Measured, not deferred on principle: reading the row here — straight after
     rebuilding the hand, the seats and the centre — was the single forced
     synchronous layout in the first render of a game, 18.9ms of the 26.4ms that
     task spent inside layout reads (instrumented at 1280x720, `scrollWidth @
     updateFades`). One rAF later the browser has laid the page out on its own
     schedule and the same read is free. The fades and the swipe hint are a
     frame behind the cards they describe, which is what they were anyway: the
     hint is corrected inside updateFades precisely because the row cannot be
     measured while it is still being written. */
  scheduleFades();
}

function previewCardId(id) {
  const s = app.snap;
  if (!s || !s.game || s.game.turnPlayerId !== s.youId || s.phase !== 'playing') return;
  const g = s.game;
  const c = g.hand.find((x) => x.id === id);
  if (!c || g.drawnDecisionCardId) return;
  // Hover/focus preview fires on every card the pointer crosses — dozens of
  // times a round. Per the frequency rule, motion is removed here entirely:
  // a crossfade at hover speed reads as flicker, not polish.
  if ((g.playableCardIds || []).includes(id)) setMessage(consequence(g, c), 'good', true);
  else setMessage(reasonFor(g), 'bad', true);
}

function tapCardId(id) {
  const s = app.snap;
  if (!s || !s.game) return;
  if (app.offline) {
    setMessage('Reconnecting — the table is read-only for a moment.', 'info');
    return;
  }
  const g = s.game;
  const c = g.hand.find((x) => x.id === id);
  if (!c || s.phase !== 'playing' || g.drawnDecisionCardId) return;

  if (g.turnPlayerId !== s.youId) {
    setMessage(`${nicely(playerName(g.turnPlayerId))} is playing — you can look, but not play yet.`, 'info');
    return;
  }
  if (!(g.playableCardIds || []).includes(id)) {
    refuse(id);
    const reason = reasonFor(g);
    setMessage(reason, 'bad');
    nodes['live-now'].textContent = reason; // rejections must be hearable too
    return;
  }
  // Touch has no hover: the first tap arms the card and shows what it will
  // do; the second commits. A hovering pointer already saw the preview.
  if (COARSE.matches && app.armedCard !== id) {
    app.armedCard = id;
    const prompt = `${consequence(g, c)} Tap again to play.`;
    setMessage(prompt, 'good');
    nodes['live-now'].textContent = prompt;
    renderGame(s);
    return;
  }
  app.armedCard = null;
  if (isWild(c)) {
    app.pendingWild = id;
    setMessage('', 'info');
    renderGame(s);
    return;
  }
  send({ type: 'play', cardId: id });
}

function refuse(cardId) {
  clearTimeout(app.refuseTimer);
  clearTimeout(app.flashTimer);
  const btn = nodes['hand-row'].querySelector(`[data-card="${CSS.escape(cardId)}"]`);
  if (btn) {
    btn.classList.remove('refuse');
    void btn.offsetWidth;
    btn.classList.add('refuse');
    // Timer matches the animation exactly, so a second shake is never cut short.
    app.refuseTimer = setTimeout(() => btn.classList.remove('refuse'), MS.refuse);
  }
  nodes.plaque.classList.remove('flash');
  void nodes.plaque.offsetWidth;
  nodes.plaque.classList.add('flash');
  app.flashTimer = setTimeout(() => nodes.plaque.classList.remove('flash'), MS.flash);
}

function cancelWild() {
  const cardId = app.pendingWild;
  if (!cardId) return;
  app.pendingWild = null;
  if (!app.snap) return;
  renderGame(app.snap);
  const card = nodes['hand-row'].querySelector(`[data-card="${CSS.escape(cardId)}"]`);
  if (card) card.focus({ preventScroll: true });
}

/* Escape is the help dialog's OWN key: a native <dialog> closes on it, and
   this listener used to fire on the same keypress and silently discard the
   Wild the player had half-chosen behind it (no message, no undo, and the
   focus race with the dialog's own restore made the landing focus
   non-deterministic). One keypress, one meaning: while the dialog is open,
   Escape belongs to the dialog. `defaultPrevented` covers any other handler
   that has already claimed the key. */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (e.defaultPrevented) return;
  if (helpDialog && helpDialog.open) return;
  cancelWild();
});

function updateFades() {
  const row = nodes['hand-row'];
  // Every read first: `is-overflowing` changes justify-content, so measuring
  // scrollLeft after writing it is a forced synchronous layout in the middle of
  // a scroll.
  const scrollWidth = row.scrollWidth;
  const clientWidth = row.clientWidth;
  const scrollLeft = row.scrollLeft;
  const over = scrollWidth - clientWidth > 4;
  row.classList.toggle('is-overflowing', over);
  nodes['fade-left'].hidden = !(over && scrollLeft > 4);
  nodes['fade-right'].hidden = !(over && scrollLeft < scrollWidth - clientWidth - 4);
  // The hint is written before the row can be measured, so it is corrected here
  // rather than costing a second render pass.
  const wasOver = app.handOverflows;
  app.handOverflows = over;
  // renderGame has usually just queued the hint's crossfade, so the node still
  // shows the previous words — ask for the incoming ones, and correct those.
  if (over !== wasOver && currentTextOf(nodes.hint).startsWith('Play a raised card')) {
    if (over && !app.handMoved) setText(nodes.hint, 'Swipe to see the rest of your hand.');
  }
}

/* One fades pass per frame, at a moment when the layout is clean. Scroll fires
   faster than frames on a trackpad or a flung touch, and a render writes the
   whole hand immediately before asking how wide it is — both cases measure a
   row that something else has just dirtied. */
let fadesRaf = 0;
function scheduleFades() {
  if (fadesRaf) return;
  fadesRaf = requestAnimationFrame(() => { fadesRaf = 0; updateFades(); });
}
nodes['hand-row'].addEventListener('scroll', () => {
  app.handMoved = true;                 // gates the hint; must not wait a frame
  scheduleFades();
});
// Coalesced: an orientation change or a collapsing URL bar fires resize in
// bursts, and each pass forces a layout read.
let resizeRaf = 0;
window.addEventListener('resize', () => {
  if (resizeRaf) return;
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    updateFades();
    if (app.snap && app.snap.game) renderGame(app.snap);
  });
});

/* ------------------------------------------------------------- how to play */

const helpDialog = document.getElementById('help-dialog');
document.querySelectorAll('[data-help-open]').forEach((btn) => {
  btn.addEventListener('click', () => helpDialog.showModal());
});
document.getElementById('help-close').addEventListener('click', () => helpDialog.close());
helpDialog.addEventListener('click', (e) => {
  if (e.target === helpDialog) helpDialog.close(); // backdrop tap closes
});

nodes['draw-btn'].addEventListener('click', () => send({ type: 'draw' }));
// The deck itself is a draw control too; it obeys the same gate as the button.
document.getElementById('deck').addEventListener('click', () => {
  if (nodes['draw-btn'].disabled || nodes['draw-btn'].hidden) return;
  send({ type: 'draw' });
});
nodes['tondo-btn'].addEventListener('click', () => send({ type: 'tondo' }));
nodes['drawn-play'].addEventListener('click', () => {
  const g = app.snap && app.snap.game;
  if (!g || !g.drawnDecisionCardId) return;
  const c = g.hand.find((x) => x.id === g.drawnDecisionCardId);
  if (c && isWild(c)) { app.pendingWild = c.id; renderGame(app.snap); return; }
  send({ type: 'play', cardId: g.drawnDecisionCardId });
});
nodes['drawn-keep'].addEventListener('click', () => send({ type: 'pass' }));
nodes['newround-btn'].addEventListener('click', () => send({ type: 'newRound' }));

/* ------------------------------------------------------------------ boot */

bootHome();
setScreen('home');

/* A reload is a drop that lost its variables: arm the seat first, then dial. */
let room = '';
try { room = sessionStorage.getItem('tondo.room') || ''; } catch { /* ignore */ }
if (room) {
  const seat = conn.seatFor(room);
  if (seat) { app.name = seat.name; conn.restore(seat); }
}
conn.connect();
