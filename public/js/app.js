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
import { deriveEvents } from './events.js';
import * as sound from './sound.js';
import * as haptics from './haptics.js';
import * as fx from './fx.js';
import { pieResultText } from './share.js';

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
/* Blend a suit colour toward the cream ink before it is used as a wash.
   A pure suit colour laid over the sauce carries a HUE change but barely a
   LIGHTNESS one when the suit is itself red, and the sauce is red: measured
   against the lightest sauce stop (#A03A22) at the shipped .34 alpha, the wash
   moves luminance by 28.1/255 for cheese and only 7.7 for pepperoni — a 3.65x
   spread for one effect, and nothing at all for a player who cannot separate
   those hues. Mixing 55% cream in first gives every topping a lightness
   component: pepperoni 22.7, cheese 34.1, basil 26.6, anchovy 24.8 — spread
   1.50x, floor three times higher, and the alpha is unchanged so the wash is
   not heavier overall. */
function creamed(hex, cream) {
  const n = Number.parseInt(String(hex).slice(1), 16);
  const C = [0xFF, 0xF7, 0xE8];
  const mix = (v, i) => Math.round(v * (1 - cream) + C[i] * cream);
  return [mix((n >> 16) & 255, 0), mix((n >> 8) & 255, 1), mix(n & 255, 2)];
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
 'quickpie-btn', 'last-table', 'last-table-sub', 'rejoin-btn', 'forget-btn',
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
 'slice-chip', 'scoreboard', 'score-title', 'score-sub', 'score-rows', 'slice-pips', 'share-btn', 'score-share-msg',
 'action-row', 'draw-btn', 'newround-btn', 'hold-btn', 'message', 'hint', 'game-leave', 'net-banner',
 'celebration',
].forEach((id) => { nodes[id] = el(id); });
nodes['top-card'].style.setProperty('--land-rise', LAND_RISE + 'px');
nodes['top-card'].style.setProperty('--land-scale', String(LAND_SCALE));
/* The home card itself: an invite link hides it while it seats you, and every
   revert of the forget control watches clicks anywhere inside it. */
nodes['home-card'] = document.querySelector('.home-card');
/* The three pieces of centre furniture the ledger has to keep its toppings off,
   plus the sauce disc they are positioned inside. Class-based, so they are
   resolved once here rather than re-queried on every repaint. */
nodes.sauce = document.querySelector('.sauce');
nodes.pile = document.querySelector('.center .pile');
nodes.dir = document.querySelector('.center .dir');
/* The one-shot effects for what just happened (fx.js). Handed the helpers
   rather than importing this file, so the dependency only points one way. */
fx.init({
  nodes, pulse, popSeat, MS, RM, seatPlate,
  seatNode: (id) => nodes.seats.querySelector(`.seat[data-player="${CSS.escape(id)}"]`),
  youId: () => app.youId,
  setSeatNote, announce,
  // A seat's display name, as the table shows it ("Carmela", not "CARMELA").
  playerName: (id) => nicelyName(playerName(id)),
  // The Wild wash's colour: the chosen topping creamed 55% toward the ink, at
  // 34%. Its own layer and alpha, so the resting .sauce-tint (10%) stays
  // subtle. See creamed() for why the mix is there — without it the same wash
  // is 3.65x stronger for cheese than for pepperoni.
  washColor: (suit) => {
    if (!SUITS[suit]) return '';
    const [r, g, b] = creamed(SUITS[suit].c, .55);
    return `rgba(${r},${g},${b},.34)`;
  },
});

/* ----------------------------------------------------------------- state */

const app = {
  snap: null,
  roomCode: '',
  youId: '',
  name: '',
  message: '',
  messageTone: 'info',
  pendingWild: null,       // card id waiting for a suit
  autoJoin: '',            // a ?code= on THIS load, waiting for an open socket
  autoJoinWait: false,     // a joinRoom is out and the seating line is showing
  autoJoinTimer: 0,        // the deadline that hands the front door back
  rejoinAttempt: false,    // this join came from a link or a remembered table
  quickPie: null,          // null | 'creating' | 'seating' | 'dealing'
  rosterPending: false,    // the next snapshot names tondo.lastTable's roster
  armedCard: null,         // coarse pointers: first tap arms, second commits
  calloutDismissed: '',    // target key the player chose to let pass
  bannerTimer: 0,
  bannerExitTimer: 0,
  refuseTimer: 0,
  flashTimer: 0,
  lastTurn: undefined,
  screenLine: '',          // setScreen's orientation line, owed one repaint
  wildWasOpen: false,      // so the picker steals focus once, not per snapshot
  drawnWasOpen: false,
  handMoved: false,      // the player has scrolled the hand at least once
  handOverflows: false,  // the hand row is wider than the tray
  pile: [],              // the last few discards, so the stack has visible depth
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
  roundDeal: null,       // {players, seatIndex, startDelay} during a new deal's repaint
  offline: true,         // stale snapshots stay visible, but never actionable
  nextDueAt: 0,         // epoch ms the next slice deals itself, 0 when idle
  nextTicker: 0,        // the 1s interval that rewrites the countdown line
  celebratedWinner: '', // one confetti beat per completed round
  confettiTimer: 0,     // celebrate()'s own cleanup, so a second burst owns it
  seatNotes: {},       // id -> {text, until}: a transient seat verb
  seatNoteTimer: 0,
};

const conn = new Connection({ onMessage: handleMessage, onStatus: onNetStatus });

/* --------------------------------------------------------------- helpers */

/* The heading of each screen, made focusable (`tabindex="-1"` in the markup)
   so there is somewhere real to put focus when a screen is swapped. */
const SCREEN_TITLE = { home: 'home-title', lobby: 'lobby-title', game: 'game-title' };

/**
 * Swap the visible screen — and take the keyboard with it.
 *
 * Every snapshot calls this, so it moves focus ONLY when the screen actually
 * changed: otherwise a bot's snapshot would yank focus off whatever the
 * player was standing on, twice a second. On a real change the outgoing
 * screen is display:none'd, which drops focus to <body> (that is where
 * "Deal the cards" left it), so focus goes to the new screen's <h1> and one
 * orientation line goes to #live-polite.
 *
 * Returns true when the screen changed, so a caller can hang first-entry
 * behaviour off it.
 */
function setScreen(name, opts) {
  if (document.body.dataset.screen === name) return false;
  document.body.dataset.screen = name;
  const title = document.getElementById(SCREEN_TITLE[name]);
  if (title) title.focus({ preventScroll: true });
  /* The lobby's auto-opened rules are not a decision the player made, and the
     table does not wait for them: the host can deal while they are still
     reading. A modal nobody asked for must not end up covering a dealt hand
     on somebody's turn — measured on a `--scene game` capture, which is
     exactly what it did. Focus goes to the heading this swap just gave it,
     not back to a "How to play" button on the screen they have left. */
  closeAutoHelp(title);
  const code = String(app.roomCode || '').toUpperCase();
  const line = name === 'home' ? 'Home.'
    : name === 'lobby' ? (code ? `Lobby for table ${code}.` : 'Lobby.')
      : 'Game started.';
  /* One arrival, one announcement. Arriving at the table and "Your turn" land
     in the SAME synchronous snapshot, and #live-now is role="alert"
     aria-live="assertive": it preempts the polite region, so the orientation
     line loses a race it started (both regions were observed mutating on the
     same tick, 103ms after "Deal the cards"). When the assertive turn alert is
     going to carry the arrival, this line stands down rather than competing. */
  /* renderGame writes this same region from the game log, and it runs later in
     the very same repaint — without this the orientation line was overwritten
     (usually with '') before a screen reader ever saw it. The line owns one
     repaint; the next snapshot's event takes the region back. A silent swap
     owes nothing, and says so, or a line left pending from an earlier screen
     would eat the next game event's turn at the region. */
  app.screenLine = (opts && opts.silent) ? '' : line;
  if (app.screenLine) nodes['live-polite'].textContent = line;
  return true;
}

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
  // An invite link's join is the first thing the open socket does. `send()`
  // queues nothing, so this is the only moment it can be sent from.
  if (state === 'synchronized' && app.autoJoin) sendAutoJoin();
}

/* An open socket with no credentials is `synchronized`, which takes the net
   banner DOWN — so without this the whole joinRoom round trip is a bare
   gradient with nothing on it, and a reply that never comes is a bare
   gradient forever. The wait says what it is doing and gives up out loud. */
const AUTOJOIN_MS = 8000;

/** The Join button's message, sent for the player, from a ?code= on this load. */
function sendAutoJoin() {
  const code = app.autoJoin;
  app.autoJoin = '';
  const seat = conn.seatFor(code);
  app.rejoinAttempt = true;
  const ok = conn.send({ type: 'joinRoom', code, name: app.name, token: seat ? seat.token : undefined });
  if (!ok) {
    // The socket went away between the status hook and here. Hand the player
    // the ordinary front door with the code already in the box.
    app.rejoinAttempt = false;
    revealHome();
    nodes['home-msg'].textContent = 'Not connected — try again in a moment.';
    return;
  }
  app.autoJoinWait = true;
  nodes['net-banner'].hidden = false;
  nodes['net-banner'].textContent = 'Taking your seat…';
  clearTimeout(app.autoJoinTimer);
  app.autoJoinTimer = setTimeout(() => {
    app.autoJoinTimer = 0;
    app.rejoinAttempt = false;
    revealHome();
    nodes['home-msg'].textContent = 'That table did not answer — try again, or start a new one.';
  }, AUTOJOIN_MS);
}

/** Takes the seating line down and disarms its deadline. */
function endAutoJoinWait() {
  if (!app.autoJoinWait) return;
  app.autoJoinWait = false;
  clearTimeout(app.autoJoinTimer);
  app.autoJoinTimer = 0;
  nodes['net-banner'].hidden = true;
}

/** Puts the home card back on screen after an auto-join that went nowhere. */
function revealHome() {
  endAutoJoinWait();
  nodes['home-card'].hidden = false;
  setScreen('home');
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
  // Per WORD, not per string: title-casing the whole string turned
  // "PEPPERONI" into "Pepperoni" correctly, but also turned "Chef Bot" into
  // "Chef bot". Splitting on spaces before capitalising each word fixes
  // both — for a string whose casing carries no meaning of its own, such as
  // a hardcoded ALL-CAPS suit or card-value label (SUITS[...].label,
  // ACTIONS[...]), which is what this function is for. For a NAME, whose
  // casing a person or the game chose on purpose, use nicelyName() below —
  // this function would flatten "AJ" to "Aj".
  return s.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

/**
 * Same per-word title-casing as nicely(), for every PLAYER/SEAT name in the
 * UI — with one more guard a suit label does not need: a word that already
 * carries a capital past its first letter (McDonald, eBay, DeAndre, AJ) is
 * left exactly as typed, never lowercased into it. A name is something a
 * person chose the casing of on purpose, or the game did for "Chef Bot"
 * (server/bot.js's own BOT_NAMES); a suit label never was. This still
 * normalizes a plain-lowercase or ALL-CAPS-typed name a word at a time
 * ("gent" -> "Gent"), since neither carries an interior capital to protect.
 * It does NOT recover a capital buried inside an otherwise-uppercase word
 * ("MCDONALD" -> "Mcdonald", not "McDonald") — that needs a name dictionary
 * and is not attempted here.
 * Duplicated in share.js (identical body), not imported: share.js has no
 * DOM and app.js already imports pieResultText FROM it, so importing this
 * back would be circular.
 */
function nicelyName(name) {
  const s = String(name || '');
  return s.split(' ').map((w) => (/[A-Z]/.test(w.slice(1))
    ? w
    : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(' ');
}

/* --------------------------------------------------------------- network */

function handleMessage(msg, context) {
  if (context && context.rejoinRefused) {
    app.snap = null;
    app.quickPie = null;
    app.rejoinAttempt = false;
    revealHome();
    nodes['home-msg'].textContent = msg.message || 'That seat is gone.';
    return;
  }
  if (msg.type === 'joined') {
    app.roomCode = msg.roomCode;
    app.youId = msg.youId;
    app.rejoinAttempt = false;
    conn.remember(app.name, msg.roomCode, msg.token);
    try { sessionStorage.setItem('tondo.room', msg.roomCode); } catch { /* ignore */ }
    // The code is known now; the roster is not — the seats arrive with the
    // first snapshot, which fills it in. Rejoining the same table keeps the
    // names already written rather than blanking them for one beat.
    const code = String(msg.roomCode || '').toUpperCase();
    const prev = readLastTable();
    writeLastTable(code, (prev && prev.code === code) ? prev.roster : []);
    app.rosterPending = true;
    return;
  }
  if (msg.type === 'state') { applySnapshot(msg); return; }
  if (msg.type === 'left') {
    app.snap = null;
    app.quickPie = null;
    app.rejoinAttempt = false;
    try { sessionStorage.removeItem('tondo.room'); } catch { /* ignore */ }
    renderLastTable();
    revealHome();
    return;
  }
  if (msg.type === 'error') {
    const text = msg.message || 'That did not work.';
    // A shortcut into a table nobody is sitting at any more is not an error
    // the player did anything about; it is a dead end with a way out.
    const fromMemory = app.rejoinAttempt;
    app.rejoinAttempt = false;
    app.quickPie = null;
    if (fromMemory) revealHome();
    nodes['home-msg'].textContent = (fromMemory && text === 'No table has that code.')
      ? 'That table has closed — start a new one.'
      : text;
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
  // The table answered: the seating line has nothing left to say.
  endAutoJoinWait();
  const prev = app.snap;
  app.snap = snap;
  app.youId = snap.youId;
  app.roomCode = snap.roomCode;

  // The table you were last at, as the table itself reports it. Written when
  // the roster is first known and refreshed at every round boundary, so the
  // names on the home screen are the ones you actually played with.
  if (app.rosterPending || (prev && prev.phase !== 'roundOver' && snap.phase === 'roundOver')) {
    app.rosterPending = false;
    writeLastTable(String(snap.roomCode || '').toUpperCase(), rosterOf(snap));
  }

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
    const enteredLobby = setScreen('lobby');
    renderLobby(snap);
    // First time at a table: the rules, once, before anyone is waiting on you.
    if (enteredLobby) maybeAutoHelp();
    // One tap asked for a dealt table, so the lobby fills itself: one bot per
    // snapshot (each addBot answers with one), then deal. Driven off the
    // snapshot rather than a timer, so a dropped message stalls instead of
    // seating a fifth chair.
    if (app.quickPie === 'creating' || app.quickPie === 'seating') {
      // Nothing is queued, so a dropped message ends the shortcut. The player
      // is the host of a real lobby with every control in front of them —
      // they are not stranded, but they are owed an explanation.
      const stalled = () => {
        app.quickPie = null;
        nodes['lobby-msg'].textContent = 'Not connected — fill the table and deal when it comes back.';
      };
      if (snap.seats.length < 4) {
        app.quickPie = 'seating';
        if (!conn.send({ type: 'addBot' })) stalled();
      } else {
        app.quickPie = 'dealing';
        if (!conn.send({ type: 'startGame' })) stalled();
      }
    }
    return;
  }

  // Computed before the screen swap, because it decides whether the swap
  // announces itself at all (see setScreen): the turn alert below is
  // assertive and would preempt the polite line in the same tick.
  const yourTurnNow = g && snap.phase === 'playing' && g.turnPlayerId === snap.youId;
  const alertsTurn = !!(snap.phase !== 'roundOver' && yourTurnNow && app.lastTurn !== g.turnPlayerId);
  setScreen('game', { silent: alertsTurn });
  if (snap.phase === 'playing') app.quickPie = null;
  if (snap.phase !== 'roundOver') app.celebratedWinner = '';
  if (!prev || prev.phase === 'lobby') { setMessage('', 'info'); app.handMoved = false; }

  document.title = yourTurnNow ? '● Your turn — TONDO' : 'TONDO';

  if (snap.phase === 'roundOver' && g) {
    /* On the last slice two things are true at once — somebody won the round
       and somebody took the pie — and they are often different people. The
       banner announces the bigger of the two, so it cannot contradict the
       scoreboard directly underneath it. */
    const m = snap.match;
    const champions = (m && m.complete) ? (m.championIds || []) : [];
    let text;
    if (champions.length > 1) {
      text = 'PIE SHARED';
    } else if (champions.length === 1) {
      text = champions[0] === snap.youId
        ? 'YOU TAKE THE PIE'
        : `${nicelyName(playerName(champions[0]))} TAKES THE PIE`.toUpperCase();
    } else {
      text = g.winnerId === snap.youId
        ? 'YOU WIN'
        : `${nicelyName(playerName(g.winnerId))} WINS`.toUpperCase();
    }
    showBanner(text, 'win', 0);
    /* Confetti is for the PIE, not for a slice. It used to fire on every round
       win — four times a pie, including for a bot's — which left the one moment
       worth escalating to with nothing bigger to reach for. The round already
       has a banner, a queue chip, a score title and a scoreboard; the pie now
       has the only burst. */
    if (champions.length) {
      const celebrationKey = `pie:${champions.join(',')}`;
      if (app.celebratedWinner !== celebrationKey) {
        app.celebratedWinner = celebrationKey;
        celebrate();
      }
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
  // clears it: the finished pie is swept off the board first, and the new
  // deal waits for the board to be clear before its first card leaves.
  const pgame = prev && prev.game;
  if (prev && prev.phase === 'roundOver' && snap.phase === 'playing') {
    const clearIn = ledgerClear({ sweep: true });
    if (travel && travel.roundDeal) travel.startDelay = clearIn;
  }
  // `pgame.turnPlayerId` is the player who just moved: this runs before the
  // repaint, so it is still the pre-play snapshot. A bot resolves here exactly
  // as your own play does. The suit is the ACTIVE one, so a Wild drops the
  // topping its owner chose rather than a colourless card.
  if (prev && prev.phase === 'playing' && g && pgame && g.topCard && pgame.topCard
      && pgame.topCard.id !== g.topCard.id && pgame.turnPlayerId) {
    ledgerAdd(g, pgame.turnPlayerId, activeSuitOf(g),
      (travel && travel.flight) ? MS.flight : 0);
  }

  // ---- what actually happened -------------------------------------------
  // The repaint below cannot tell a real move from an identical snapshot
  // arriving twice; this can. Derived once here and shared, so a sound and a
  // one-shot animation can never disagree about what the table just did.
  // Deliberately outside the reduced-motion guard that gates `travel`: less
  // movement is not less information.
  const events = deriveEvents(prev, snap);

  // Scheduled against the frame the card actually lands on, not the frame the
  // snapshot arrived — the same delay ledgerAdd above already uses. A sound
  // that beats its own card to the pile is heard as being out of sync. The +2
  // throw below holds from this same frame.
  const impactAt = (travel && travel.flight) ? MS.flight / 1000 : 0;
  // renderHand reads this while it builds the new hand, so your cards rise as
  // their own ghosts arrive rather than on the ordinary draw stagger. It lives
  // for exactly this snapshot's repaint — a later repaint is not a deal — and
  // is cleared even if the repaint throws, or the next mid-turn repaint would
  // rebuild the hand as if it were being dealt.
  app.roundDeal = (travel && travel.roundDeal) ? {
    players: travel.deals.length,
    seatIndex: travel.deals.findIndex((d) => d.playerId === snap.youId),
    startDelay: travel.startDelay || 0,
  } : null;
  try {
    renderGame(snap);
  } finally {
    app.roundDeal = null;
  }
  runTravel(travel, snap, events, impactAt);
  if (events.length) {
    // A new round's deal is heard when its first card leaves the deck, after
    // the finished pie has been swept — not while the sweep is still running.
    const heardAt = (travel && travel.roundDeal) ? (travel.startDelay || 0) / 1000 : impactAt;
    sound.playForEvents(events, { impactAt: heardAt });
    // The same moment in the third channel, for the one player it happened to.
    // Silent on iOS and on any phone without a motor, so it only ever ADDS to
    // the sound and the animation — nothing above is conditional on it, and
    // the catch is what keeps that true in the other direction: fx.js's half
    // of this moment runs a few lines below, and must not be reachable only
    // through a channel half the devices here do not have.
    try { haptics.forEvents(events, { impactAt: heardAt }); } catch { /* never breaks a repaint */ }
  }
  // The table's half of the same moment: a skipped seat ducks, a reversal
  // sweeps the sauce, a Wild washes it, a TONDO stamps the declaring seat, a
  // callout lunges the caller at the caught seat — and the seats say what
  // happened in words that survive reduced motion. Fired after the repaint, at
  // nodes that exist now.
  fx.playForEvents(events, { impactAt });

  const pg = pgame;
  const turnChanged = !!(g && pg && prev.phase === 'playing' && snap.phase === 'playing'
    && g.turnPlayerId !== pg.turnPlayerId);
  // The consequence ladder: when a card did something TO somebody, that owns
  // the frame. A generic turn pop on top of a skip's duck or a +2's throw reads
  // as two things happening, and at two players the "turn" often never moved.
  if (turnChanged && !events.some((e) => fx.CONSEQUENCES.has(e.type))) {
    /* The whole-pie warm flash that used to fire here is gone. It was a 476px
       overlay on the single most-repainted surface, 15-30 times a round, saying
       what the queue chip, the token hop, the seat pop and the seat pill all
       already say. An effect a player sees tens of times per round is one they
       stop seeing; spending the pie's own surface on it devalued the
       consequence effects that genuinely need the eye. The seat pop below is
       the right amount for "somebody's turn moved". */
    // Whoever just took the turn: their tile pops once, so a bot's move has a
    // visible beginning as well as an end.
    popSeat(g.turnPlayerId);
  }
  // The plaque states what you must match. When that requirement actually
  // changes it acknowledges itself — state indication, not decoration.
  // (A Wild's wash across the sauce is fx.js's, on its own layer: it fires for
  // every Wild, including one that keeps the suit this check would miss.)
  if (g && pg && activeSuitOf(g) !== activeSuitOf(pg)) {
    pulse(nodes.plaque, 'is-pop', MS.plaquePop);
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

/** The seat plate for a player, as it exists right now (seats are keyed). */
function seatPlate(playerId) {
  const seat = nodes.seats.querySelector(`.seat[data-player="${CSS.escape(playerId)}"]`);
  return seat ? seat.querySelector('.plate') : null;
}

/** A seat says something for a moment — "skipped", "+2" — then goes back. */
function setSeatNote(playerId, text, ms) {
  if (!playerId) return;
  app.seatNotes[playerId] = { text, until: Date.now() + ms };
  scheduleSeatNoteExpiry();
  if (app.snap) renderGame(app.snap);
}

/** One repaint at the EARLIEST live note's expiry, then again for the next.
 *  A single timer re-armed for the newest note cancelled the older note's
 *  repaint, so "skipped" stayed up until the second note expired (1839ms for a
 *  1200ms note, measured). */
function scheduleSeatNoteExpiry() {
  clearTimeout(app.seatNoteTimer);
  const now = Date.now();
  let next = Infinity;
  for (const [id, note] of Object.entries(app.seatNotes)) {
    if (note.until <= now) delete app.seatNotes[id];
    else next = Math.min(next, note.until);
  }
  if (next === Infinity) return;
  app.seatNoteTimer = setTimeout(() => {
    if (app.snap) renderGame(app.snap);
    scheduleSeatNoteExpiry();
  }, next - now + 20);
}

function liveSeatNote(playerId) {
  const note = app.seatNotes[playerId];
  if (!note) return null;
  if (note.until <= Date.now()) { delete app.seatNotes[playerId]; return null; }
  return note.text;
}

function announce(text) { nodes['live-now'].textContent = text; }

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
  if (!g || RM.matches) return null;
  // A new deal — the next slice, or the first one out of the lobby, which has
  // no previous game at all. This is the one moment cards are literally being
  // dealt, so it gets the whole table's worth rather than a diff.
  if (prev && (prev.phase === 'roundOver' || prev.phase === 'lobby') && snap.phase === 'playing') {
    return planRoundDeal(g);
  }
  if (!pg) return null;
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

/**
 * One deal per player at their full hand, in seat order (`g.players`), starting
 * AT the opener: the player who acts first is dealt first, so their hand is up
 * within the deal's first lap instead of arriving last. `startDelay` is filled
 * in by applySnapshot once it knows how long the finished pie takes to leave.
 */
function planRoundDeal(g) {
  const ps = g.players || [];
  if (!ps.length) return null;
  const opener = Math.max(0, ps.findIndex((p) => p.id === g.turnPlayerId));
  const deals = [];
  for (let i = 0; i < ps.length; i++) {
    const p = ps[(opener + i) % ps.length];
    deals.push({ playerId: p.id, count: p.cardCount });
  }
  return { flight: null, deals, roundDeal: true, startDelay: 0 };
}

/** Where a player's cards go: your hand row, or an opponent's seat stack. */
function travelTarget(playerId, snap) {
  return playerId === snap.youId
    ? nodes['hand-row']
    : nodes.seats.querySelector(`.seat[data-player="${CSS.escape(playerId)}"] .stack`);
}

function runTravel(plan, snap, events, impactAt) {
  if (!plan) return;
  if (plan.roundDeal) { runRoundDeal(plan, snap); return; }
  if (plan.flight) flyToPile(plan.flight.from, plan.flight.card);
  let wave = 0;
  for (const deal of plan.deals) {
    const target = travelTarget(deal.playerId, snap);
    // Cards a +2 forced on somebody are thrown off the card that did it, not
    // dealt off the deck like an ordinary draw. A callout's two are thrown by
    // whoever made the call, from their seat — when the log names them; an
    // unknown caller falls back to an ordinary deal.
    const impactMs = (impactAt || 0) * 1000;
    const hit = (events || []).find((e) => e.type === 'plus2' && e.victimId === deal.playerId);
    const caught = hit ? null
      : (events || []).find((e) => e.type === 'callout' && e.targetId === deal.playerId && e.callerId);
    const fromRect = caught ? seatCardRect(caught.callerId) : null;
    let opts = null;
    if (hit) opts = { lob: true, playerId: deal.playerId, impactMs };
    else if (fromRect) opts = { lob: true, playerId: deal.playerId, impactMs, fromRect };
    if (target) dealGhosts(target.getBoundingClientRect(), deal.count, wave++, opts);
  }
}

/* A round deal shows this many card backs per seat; your hand's first this-many
   cards rise on their ghosts' arrival (renderHand). */
const ROUND_DEAL_CARDS = 4;

/**
 * The deal goes around the table: card k of the player at seat position p
 * leaves at startDelay + k·(players·90) + p·90 ms, so a four-seat table is 16
 * ghosts over ~1.35s, one card to each seat per lap.
 *
 * Every ghost is created NOW, in the snapshot's own task, because your hand's
 * entry animations (renderHand) are created in this task too: WAAPI delays that
 * start on the same ready frame stay locked together, where a timer would drift
 * from them by however long the task runs (see the lob's badge punch).
 *
 * But the table is not where it will be. The snapshot that deals is the one
 * that swaps the scoreboard back out for the hand, so for the next --t-swap the
 * tray is changing height, the stage with it, and --table-d is easing the seat
 * orbit back out. Aimed at the snapshot frame, the worst ghost landed 116px
 * from its target at 1440x900 and 146px at 390x844 (the deck and your hand move
 * furthest). The first deal out of the lobby is worse in a different way: it has
 * no sweep to wait for, so its first cards are ALREADY in the air while the game
 * screen grows into place (118px at 390x844, measured in review). So every
 * ghost follows its target until it lands (followDeal): before it leaves, from
 * wherever the deck now is; once it has left, from the point it left, with only
 * the destination moving.
 */
function runRoundDeal(plan, snap) {
  const players = plan.deals.length;
  const startDelay = plan.startDelay || 0;
  const legs = [];
  plan.deals.forEach((deal, seatIndex) => {
    const el = travelTarget(deal.playerId, snap);
    if (!el) return;
    const ghosts = dealGhosts(el.getBoundingClientRect(), deal.count, 0,
      { roundDeal: { players, seatIndex, startDelay } });
    if (ghosts.length) legs.push({ el, ghosts });
  });
  if (legs.length) followDeal(legs);
}

/** Aims a round deal's ghosts at the table as it is on this frame, every frame
 *  until the last one lands. A waiting ghost is re-seated on the deck too; a
 *  flying one keeps the point it left from and the tilt it left with (a tilt
 *  flipping sign mid-flight would snap), and only its destination follows. */
function followDeal(legs) {
  const aim = () => {
    const src = pileRect();
    let live = 0;
    for (const leg of legs) {
      const to = leg.el.isConnected ? leg.el.getBoundingClientRect() : null;
      for (const g of leg.ghosts) {
        if (!g.ghost.isConnected) continue;
        const state = g.anim.playState;
        if (state === 'finished' || state === 'idle') continue;
        live++;
        const t = g.anim.currentTime;
        const flying = t !== null && t >= g.delay;
        if (flying && !g.from) {
          const st = g.ghost.style;
          g.from = { left: parseFloat(st.left), top: parseFloat(st.top), width: parseFloat(st.width), height: parseFloat(st.height) };
        }
        const from = flying ? g.from : src;
        if (to && to.width && from.width) aimDealGhost(g, from, to);
      }
    }
    if (live) requestAnimationFrame(aim);
  };
  requestAnimationFrame(aim);
}

/** The ordinary deck → hand path: straight there, shrinking, fading at the end. */
function dealFrames(dx, dy, tilt = dx > 0 ? 9 : -9) {
  return [
    { transform: 'translate(0,0) scale(1) rotate(0deg)', opacity: 1 },
    { transform: `translate(${dx}px,${dy}px) scale(.55) rotate(${tilt}deg)`, opacity: .85, offset: .8 },
    { transform: `translate(${dx}px,${dy}px) scale(.5) rotate(${tilt}deg)`, opacity: 0 },
  ];
}

function aimDealGhost(g, src, to) {
  const key = [src.left, src.top, src.width, src.height, to.left, to.top, to.width, to.height]
    .map((v) => Math.round(v * 2)).join(',');
  if (g.key === key) return;
  g.key = key;
  const node = g.ghost;
  if (!g.from) {
    node.style.left = src.left + 'px';
    node.style.top = src.top + 'px';
    node.style.width = src.width + 'px';
    node.style.height = src.height + 'px';
    node.style.setProperty('--cw', Math.round(src.width) + 'px');
  }
  const dx = (to.left + to.width / 2) - (src.left + src.width / 2);
  const dy = (to.top + to.height / 2) - (src.top + src.height / 2);
  if (!g.from) g.tilt = dx > 0 ? 9 : -9;   // a flying ghost keeps the tilt it left with
  g.anim.effect.setKeyframes(dealFrames(dx, dy, g.tilt));
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

/**
 * A card back sized for a seat, centred on it: where a seat's thrown cards
 * leave from. An opponent's is the table's own --seat-back on their stack —
 * the same box their played cards fly out of in planTravel. Yours is centred on
 * your tile at .74 of its width, the ratio the seats use (--seat-back .08 over
 * --seat-tile .108 of the table): the tray has no --seat-back of its own.
 */
function seatCardRect(playerId) {
  if (playerId === app.youId) {
    const tile = document.querySelector('.you-seat');
    return tile && tile.offsetWidth ? cardRectAt(tile, tile.offsetWidth * .74) : null;
  }
  const stack = nodes.seats.querySelector(`.seat[data-player="${CSS.escape(playerId)}"] .stack`);
  return stack ? cardRectAt(stack, cssPx(stack, '--seat-back', 34)) : null;
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

/**
 * Card backs travelling to a hand. `opts.lob` is a +2: the cards leave the top
 * card that forced them, after a 90ms hold past the impact frame (the stillness
 * is the weight), arc up by 0.4 of a card on the way, and the victim's count
 * badge takes the punch when the last one arrives. `opts.impactMs` is that
 * impact frame: MS.flight while a played card is in the air, 0 without one.
 * `opts.fromRect` overrides where a lob leaves from — a callout's cards leave
 * the caller's seat (seatCardRect), not the top card.
 * `opts.roundDeal = { players, seatIndex, startDelay }` is a new round's deal
 * (runRoundDeal): four cards instead of three, on the round-robin stagger, and
 * unseen while they wait their turn on the deck. Returns the ghosts it threw,
 * as `{ ghost, anim, delay }`, so a round deal can re-aim the ones still waiting.
 */
function dealGhosts(target, count, wave, opts) {
  const lob = !!(opts && opts.lob);
  const round = (opts && opts.roundDeal) || null;
  const src = lob ? (opts.fromRect || nodes['top-card'].getBoundingClientRect()) : pileRect();
  if (!src.width || !target.width) return [];
  // A +2 reads at two; a deal reads at four; never flood the DOM.
  const shown = Math.min(count, round ? ROUND_DEAL_CARDS : 3);
  const dx = (target.left + target.width / 2) - (src.left + src.width / 2);
  const dy = (target.top + target.height / 2) - (src.top + src.height / 2);
  const lift = 0.4 * src.height;
  const LOB_MS = 300;
  const hold = lob ? (opts.impactMs || 0) + 90 : 0;
  let lastAnim = null;
  const thrown = [];
  for (let k = 0; k < shown; k++) {
    const ghost = ghostShell(src);
    ghost.classList.add('travel-back', 'back-face');
    ghost.style.setProperty('--cw', Math.round(src.width) + 'px');
    // Up to ~1.9s of waiting for a round deal: a stack of backs sitting on the
    // deck that long — or on the discard, where the phone band has no deck —
    // would cover the card the new round starts on. The first keyframe brings
    // each one in at opacity 1 the moment it leaves.
    if (round) ghost.style.opacity = '0';
    document.body.appendChild(ghost);
    const delay = lob ? hold + k * 90
      : round ? round.startDelay + k * (round.players * 90) + round.seatIndex * 90
        : wave * 120 + k * MS.dealStep;
    /* `finished` is the only thing holding these ghosts' leashes, and it does
       not always settle: on a hidden or unfocused page the animation never
       advances, so the promise never resolves and the ghost stays in <body>
       forever, one per dealt card. flyToPile has carried a guard timeout for
       exactly this since it was written; a deal throws up to three at a time
       and had none. `done` keeps the two paths from double-removing. */
    let done = false, guard = 0;
    const drop = () => { if (done) return; done = true; clearTimeout(guard); ghost.remove(); };
    const frames = lob
      ? [
        { transform: 'translate(0,0) scale(1)', opacity: 1 },
        { transform: `translate(${dx * .5}px, ${dy * .5 - lift}px) scale(.8)`, opacity: 1, offset: .5 },
        { transform: `translate(${dx}px, ${dy}px) scale(.5)`, opacity: 0 },
      ]
      : dealFrames(dx, dy);
    const duration = lob ? LOB_MS : MS.deal;
    lastAnim = ghost.animate(frames, { duration, delay, easing: EASE_OUT, fill: 'forwards' });
    lastAnim.finished.then(drop, drop);
    guard = setTimeout(drop, duration + delay + 400);
    thrown.push({ ghost, anim: lastAnim, delay, tilt: dx > 0 ? 9 : -9 });
  }
  if (lob && lastAnim) {
    // The punch rides the LAST card's own `finished`, not a timer started here.
    // A WAAPI delay counts from the frame the animation becomes ready, which is
    // after this whole snapshot task (two renders, with the seat note); a timer
    // counts from now. With a 200ms stall injected at the end of the task, a
    // timer punched the badge exactly 200ms before the card got there. The
    // guard is the same leash the ghosts wear, for a surface that never ticks.
    let punched = false, punchGuard = 0;
    const punch = () => {
      if (punched) return;
      punched = true;
      clearTimeout(punchGuard);
      const badge = opts.playerId === app.youId
        ? nodes['you-count']
        : nodes.seats.querySelector(`.seat[data-player="${CSS.escape(opts.playerId)}"] .count-badge`);
      if (badge) pulse(badge, 'is-punched', 260);
    };
    lastAnim.finished.then(punch, punch);
    punchGuard = setTimeout(punch, hold + (shown - 1) * 90 + LOB_MS + 400);
  }
  return thrown;
}

/* ------------------------------------------------------------------ home */

/* Storage is a privilege, not a given: Safari's private mode throws on the
   first touch of either store, and an uncaught throw at boot is a blank
   screen. Every read and every write is guarded on its own, and a value that
   will not parse is read as "nothing remembered" — never deleted, never
   allowed to take the home screen down with it. */

const LAST_TABLE_KEY = 'tondo.lastTable';
const LAST_TABLE_MS = 12 * 60 * 60 * 1000;

/** The seats around you, as the table names them. */
function rosterOf(snap) {
  return ((snap && snap.seats) || [])
    .filter((s) => s.id !== snap.youId)
    .map((s) => (s.isBot ? nicelyName(s.name) : s.name))
    .filter(Boolean);
}

/** `{ code, roster, at }`, or null for anything that is not exactly that. */
function readLastTable() {
  let raw = '';
  try { raw = localStorage.getItem(LAST_TABLE_KEY) || ''; } catch { return null; }
  if (!raw) return null;
  let v = null;
  // A truncated or hand-edited value is not an error to report, it is simply
  // no last table. The bad value stays where it is: the next join rewrites it.
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const code = typeof v.code === 'string' ? v.code.trim().toUpperCase() : '';
  const at = Number(v.at);
  if (!code || !Number.isFinite(at)) return null;
  const roster = Array.isArray(v.roster)
    ? v.roster.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim()).slice(0, 3)
    : [];
  return { code, roster, at };
}

function writeLastTable(code, roster) {
  if (!code) return;
  try {
    localStorage.setItem(LAST_TABLE_KEY, JSON.stringify({ code, roster: roster || [], at: Date.now() }));
  } catch { /* nowhere to keep it */ }
}

/** Decided before first paint, so the row never shoves the card downwards. */
function renderLastTable() {
  const last = readLastTable();
  // Older than half a day and the names stop being a promise worth making.
  const fresh = !!last && (Date.now() - last.at) < LAST_TABLE_MS;
  nodes['last-table'].hidden = !fresh;
  // The copy never claims the table is still there — only that it was yours.
  nodes['last-table-sub'].textContent = fresh && last.roster.length
    ? 'with ' + last.roster.join(', ') : '';
}

function bootHome() {
  const params = new URLSearchParams(location.search);
  let stored = '';
  try { stored = localStorage.getItem('tondo.name') || ''; } catch { /* ignore */ }
  nodes['name-input'].value = stored;
  const code = (params.get('code') || '').trim().toUpperCase();
  if (code) nodes['code-input'].value = code;
  renderLastTable();
  // A friend tapping an invite link has already told us the two things the
  // front door asks for. Only a ?code= on THIS load may do this — a
  // remembered table never seats you without a tap.
  if (code && stored) {
    app.name = stored;
    app.autoJoin = code;
    nodes['home-card'].hidden = true;
  }
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

/* One tap instead of create, add three bots, deal. No stats, no record, no
   progression: playing alone must not grow a ledger to keep up with. */
nodes['quickpie-btn'].addEventListener('click', () => {
  const name = readName();
  if (!name) return;
  nodes['home-msg'].textContent = '';
  app.quickPie = 'creating';
  if (!send({ type: 'createRoom', name })) app.quickPie = null;
});

nodes['join-btn'].addEventListener('click', () => {
  // Whether this join came from a remembered table is decided BEFORE
  // readName() can bail out, and only survives as far as a message actually
  // sent — otherwise the next server error would wear the wrong copy.
  const fromMemory = app.rejoinAttempt;
  app.rejoinAttempt = false;
  const name = readName();
  if (!name) return;
  const code = (nodes['code-input'].value || '').trim().toUpperCase();
  if (!code) { nodes['home-msg'].textContent = 'A table code goes in the box.'; nodes['code-input'].focus(); return; }
  nodes['home-msg'].textContent = '';
  const seat = conn.seatFor(code);
  app.rejoinAttempt = fromMemory;
  if (!send({ type: 'joinRoom', code, name, token: seat ? seat.token : undefined })) app.rejoinAttempt = false;
});

/* Always an explicit tap: the row offers the table, it never takes it. */
nodes['rejoin-btn'].addEventListener('click', () => {
  const last = readLastTable();
  if (!last) { renderLastTable(); return; }
  nodes['code-input'].value = last.code;
  app.rejoinAttempt = true;
  nodes['join-btn'].click();
});

/* ---- forget this device -------------------------------------------------
   Two taps on one button, not a modal: the wipe takes the seat token with it,
   so a mis-tap on a control that sits where a thumb rests would be
   unrecoverable, and a modal is focus-trap surface a privacy affordance does
   not deserve. The armed state is announced by #home-msg, which is already a
   polite live region — no second one is added. */
const FORGET_IDLE = 'Forget this device';
const FORGET_ARMED = 'Tap again to forget';
const FORGET_WARN = 'This clears your name and your last table. It cannot be undone.';
const FORGET_DONE = 'Forgotten. Nothing about you is stored here now.';
const FORGET_MS = 4000;
let forgetTimer = 0;

function disarmForget() {
  if (!forgetTimer) return;
  clearTimeout(forgetTimer);
  forgetTimer = 0;
  nodes['forget-btn'].textContent = FORGET_IDLE;
  // Only the warning is ours to take back. Another control may have written
  // its own line in the same breath, and that one stands.
  if (nodes['home-msg'].textContent === FORGET_WARN) nodes['home-msg'].textContent = '';
}

/** Removes every `tondo.` key from one store, and nothing else. */
function wipeStore(get) {
  try {
    const store = get();
    for (const key of Object.keys(store)) {
      if (key.startsWith('tondo.')) { try { store.removeItem(key); } catch { /* ignore */ } }
    }
  } catch { /* no storage to clear */ }
}

nodes['forget-btn'].addEventListener('click', () => {
  if (!forgetTimer) {
    forgetTimer = setTimeout(disarmForget, FORGET_MS);
    nodes['forget-btn'].textContent = FORGET_ARMED;
    nodes['home-msg'].textContent = FORGET_WARN;
    return;
  }
  clearTimeout(forgetTimer);
  forgetTimer = 0;
  nodes['forget-btn'].textContent = FORGET_IDLE;
  wipeStore(() => localStorage);
  wipeStore(() => sessionStorage);
  // The stores are only half of it: Connection still holds { name, code,
  // token } in memory, and the next socket drop would re-send joinRoom and
  // write every one of those keys back. "Nothing about you is stored here
  // now" has to be true a minute later too.
  conn.forget();
  nodes['name-input'].value = '';
  app.name = '';
  renderLastTable();
  nodes['home-msg'].textContent = FORGET_DONE;
});

// Leaving the button, or reaching for anything else on the card, puts the
// safety back on.
nodes['forget-btn'].addEventListener('blur', disarmForget);
nodes['home-card'].addEventListener('click', (e) => {
  if (!nodes['forget-btn'].contains(e.target)) disarmForget();
});

nodes['code-input'].addEventListener('keydown', (e) => { if (e.key === 'Enter') nodes['join-btn'].click(); });
nodes['name-input'].addEventListener('keydown', (e) => { if (e.key === 'Enter') nodes['create-btn'].click(); });

/* ----------------------------------------------------------------- lobby */

/* One tag per kind, so a row's tags can be compared as a list rather than as
   a blob of markup. */
const TAG_TEXT = { you: 'You', host: 'Host', bot: 'Bot', away: 'Away' };

/** The empty shell of one seat row; everything inside is updated in place. */
function buildSeatRow(key, ghost) {
  const li = document.createElement('li');
  li.className = ghost ? 'seat-row seat-ghost' : 'seat-row';
  li.dataset.seat = key;
  if (ghost) {
    li.setAttribute('aria-hidden', 'true');
    li.innerHTML = '<span class="ghost-plus">+</span><span class="who">Open seat</span>';
  } else {
    li.innerHTML = '<span class="seat-chip" aria-hidden="true"><span class="initial"></span></span>'
      + '<span class="who"></span>';
  }
  return li;
}

/** Puts `kinds` on the row, in order, before `anchor`. Tags are not focusable,
 *  so the cheap path is to compare the whole list and rebuild only on a change. */
function syncTags(row, kinds, anchor) {
  const live = [...row.querySelectorAll('.tag')];
  if (live.map((n) => n.dataset.tag).join(',') === kinds.join(',')) return;
  live.forEach((n) => n.remove());
  kinds.forEach((k) => {
    const el = document.createElement('span');
    el.className = 'tag tag-' + k;
    el.dataset.tag = k;
    el.textContent = TAG_TEXT[k];
    row.insertBefore(el, anchor);
  });
}

/**
 * Keyed reconciliation, for the same reason renderSeats and renderHand are:
 * this list is repainted by every snapshot, and someone else joining, a bot
 * being added or a name changing used to throw away the "Remove" button the
 * keyboard was standing on. A seat keeps its node for as long as it is at the
 * table; the empty chairs are keyed by position.
 *
 * Classes are toggled rather than assigned wholesale, so a transient class a
 * helper puts on a row survives the next snapshot.
 */
function renderSeatList(snap) {
  const host = nodes['seat-list'];
  const focused = document.activeElement;
  const focusedKey = (focused && host.contains(focused) && focused.dataset.remove) || '';
  const focusedIndex = focusedKey
    ? [...host.children].findIndex((n) => n.contains(focused)) : -1;
  const live = new Map([...host.children].map((n) => [n.dataset.seat, n]));

  snap.seats.forEach((seat, i) => {
    // The same tile the player will wear at the table, so the seat they take
    // here is recognisably theirs once the game starts.
    const tone = TONES[SEAT_TONES[i % SEAT_TONES.length]];
    const name = seat.isBot ? nicelyName(seat.name) : seat.name;
    const initial = (String(name).trim().charAt(0) || '?').toUpperCase();
    let row = live.get(seat.id);
    if (!row || row.classList.contains('seat-ghost')) row = buildSeatRow(seat.id, false);
    else live.delete(seat.id);
    if (host.children[i] !== row) host.insertBefore(row, host.children[i] || null);

    const chip = row.querySelector('.seat-chip');
    if (chip.style.getPropertyValue('--tone-bg') !== tone.bg) {
      chip.style.setProperty('--tone-bg', tone.bg);
      chip.style.setProperty('--tone-edge', tone.edge);
    }
    setTextIfChanged(chip.querySelector('.initial'), initial);
    setTextIfChanged(row.querySelector('.who'), name);

    // The one focusable control in the row: kept, not rebuilt, and its
    // listener reads the seat id off the node so it outlives every repaint.
    let remove = row.querySelector('[data-remove]');
    const wantRemove = !!(snap.isHost && seat.isBot);
    if (wantRemove && !remove) {
      remove = document.createElement('button');
      remove.type = 'button';
      remove.classList.add('btn', 'btn-tiny');
      remove.dataset.remove = seat.id;
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => send({ type: 'removeSeat', seatId: remove.dataset.remove }));
      row.appendChild(remove);
    } else if (!wantRemove && remove) { remove.remove(); remove = null; }
    if (remove) {
      remove.dataset.remove = seat.id;
      const label = `Remove ${name}`;
      if (remove.getAttribute('aria-label') !== label) remove.setAttribute('aria-label', label);
      remove.disabled = app.offline;
    }

    const tags = [];
    if (seat.id === snap.youId) tags.push('you');
    if (seat.id === snap.hostId) tags.push('host');
    if (seat.isBot) tags.push('bot');
    if (!seat.connected) tags.push('away');
    syncTags(row, tags, remove);
  });

  // The empty chairs are drawn too, so the table's capacity is visible and the
  // card does not jump in height as seats fill.
  const ghosts = Math.max(0, 4 - snap.seats.length);
  for (let k = 0; k < ghosts; k++) {
    const key = 'ghost:' + k;
    const at = snap.seats.length + k;
    let row = live.get(key);
    if (!row) row = buildSeatRow(key, true);
    else live.delete(key);
    if (host.children[at] !== row) host.insertBefore(row, host.children[at] || null);
  }
  live.forEach((n) => n.remove());

  // Belt and braces: the node is normally the same one, but if a seat's row
  // was rebuilt the keyboard still goes back to it — and if the seat you were
  // standing on is the one that LEFT (you removed that bot), it walks outwards
  // to the nearest row that still has a control, then to the button that
  // fills the table. Removing a bot used to drop the keyboard on <body>.
  if (focusedKey && focusLost()) {
    const usable = (n) => !!n && !n.disabled && (n.offsetParent || n.getClientRects().length);
    const again = host.querySelector(`[data-remove="${CSS.escape(focusedKey)}"]`);
    let target = usable(again) ? again : null;
    const kids = [...host.children];
    const start = Math.min(Math.max(focusedIndex, 0), Math.max(kids.length - 1, 0));
    for (let d = 0; d < kids.length && !target; d++) {
      for (const row of [kids[start - d], kids[start + d]]) {
        const btn = row && row.querySelector('[data-remove]');
        if (usable(btn)) { target = btn; break; }
      }
    }
    if (!target && usable(nodes['addbot-btn'])) target = nodes['addbot-btn'];
    if (target) target.focus({ preventScroll: true });
  }
}

function renderLobby(snap) {
  nodes['room-code'].textContent = snap.roomCode || '—';
  // lobby-msg is left alone: "Invite link copied." must not vanish the moment
  // someone else's join triggers a repaint.

  renderSeatList(snap);

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

/* The readonly textarea shown after the share button when the clipboard
   write did not land. Tracked so a later render (a new round, a new pie)
   can clear a stale one instead of leaving it behind under the wrong text. */
let shareFallbackEl = null;
function hideShareBtn() {
  nodes['share-btn'].hidden = true;
  if (shareFallbackEl) { shareFallbackEl.remove(); shareFallbackEl = null; }
  setText(nodes['score-share-msg'], '');
}

/**
 * `navigator.clipboard` is undefined outside a secure context — and Tondo is
 * a LAN game people open at `http://192.168.x.x` from another phone, which is
 * not one. Reading `.writeText` off `undefined` there throws a TypeError
 * SYNCHRONOUSLY, before any promise exists; a `.then().catch()` chained onto
 * that call never runs, because there is no promise to chain onto. The
 * try/catch below is what actually catches it — the same catch also covers
 * `writeText` rejecting (permission denied). A resolved `writeText` is
 * trusted as "copied"; whether the clipboard is later readABLE is never
 * checked here.
 */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

nodes['share-btn'].addEventListener('click', async () => {
  const m = app.snap && app.snap.match;
  if (!m) return;
  const origin = location.origin + location.pathname.replace(/index\.html$/, '');
  const text = pieResultText(m, { origin, resolveName: playerName });
  if (!text) return;
  const copied = await copyToClipboard(text);
  if (shareFallbackEl) { shareFallbackEl.remove(); shareFallbackEl = null; }
  if (copied) {
    // Its own node (#score-share-msg), not #score-sub: renderMatch rewrites
    // #score-sub on every snapshot, which would erase this the moment
    // anything else changes at the table — a bot added, someone leaving,
    // even a resize. Announced too, since neither outcome otherwise reaches
    // a screen reader (WCAG 4.1.3), and the announcement survives that same
    // clobber independently of this node.
    setText(nodes['score-share-msg'], 'Result copied — paste it anywhere.');
    announce('Result copied — paste it anywhere.');
    return;
  }
  setText(nodes['score-share-msg'], 'Copy failed — select the text below.');
  announce('Copy failed — select the text below.');
  const ta = document.createElement('textarea');
  ta.className = 'score-share-fallback input';
  ta.readOnly = true;
  ta.rows = 3;
  ta.value = text;
  ta.setAttribute('aria-label', 'Pie result — select and copy');
  nodes['share-btn'].insertAdjacentElement('afterend', ta);
  ta.focus();
  // setSelectionRange, not select(): the durable idiom on the one platform
  // this fallback exists for (a non-secure-context LAN game opened on a
  // phone) — a plain select() has a history of being unreliable there.
  ta.setSelectionRange(0, ta.value.length);
  shareFallbackEl = ta;
});
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
  app.quickPie = null;
  conn.forget();
  renderLastTable();
  revealHome();
}

/* ------------------------------------------------------------ game: read */

/* The key the "Let it pass" button is stored under, so one map holds both it
   and the targets without an id ever colliding with it. */
const CALLOUT_SKIP = '\u0000skip';

/**
 * Keyed reconciliation, like renderSeats and renderHand.
 *
 * This bar is open at the one moment the table is busiest: a bot's snapshot
 * lands every second or two, and rebuilding these buttons threw away the node
 * the keyboard was standing on — "Call out Dominic" could not be reached
 * before it was replaced, a race a keyboard player cannot win. The button for
 * a target keeps its node for as long as that target is callable, and its
 * listener reads the id off the node so it survives every repaint.
 *
 * Classes are toggled, never assigned wholesale, so a transient class a helper
 * owns is not stripped by the next snapshot.
 */
function renderCalloutButtons(targets, targetKey) {
  const host = nodes['callout-buttons'];
  const keyOf = (n) => (n.dataset.calloutSkip ? CALLOUT_SKIP : (n.dataset.callout || ''));
  const focused = document.activeElement;
  const focusedKey = (focused && host.contains(focused)) ? keyOf(focused) : '';
  const live = new Map([...host.children].map((n) => [keyOf(n), n]));

  targets.forEach((id, i) => {
    let btn = live.get(id);
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.classList.add('btn', 'btn-cta');
      btn.dataset.callout = id;
      btn.addEventListener('click', () => send({ type: 'callout', targetId: btn.dataset.callout }));
    } else live.delete(id);
    if (host.children[i] !== btn) host.insertBefore(btn, host.children[i] || null);
    setTextIfChanged(btn, `Call out ${nicelyName(playerName(id))}`);
    btn.disabled = app.offline;
  });

  let skip = live.get(CALLOUT_SKIP);
  if (!skip) {
    skip = document.createElement('button');
    skip.type = 'button';
    skip.classList.add('btn', 'btn-quiet');
    skip.dataset.calloutSkip = '1';
    skip.textContent = 'Let it pass';
    // The key is read off the node at click time: the button outlives the
    // render that made it, and the targets it is dismissing can change.
    skip.addEventListener('click', () => {
      app.calloutDismissed = skip.dataset.key || '';
      renderGame(app.snap);
    });
  } else live.delete(CALLOUT_SKIP);
  skip.dataset.key = targetKey;
  // Only move it when it is not already last: relocating a node blurs it.
  if (host.lastElementChild !== skip) host.appendChild(skip);
  skip.disabled = app.offline;

  live.forEach((n) => n.remove());

  if (focusedKey && focusLost()) {
    const again = focusedKey === CALLOUT_SKIP
      ? skip : host.querySelector(`[data-callout="${CSS.escape(focusedKey)}"]`);
    if (again && !again.disabled) again.focus({ preventScroll: true });
  }
}

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
  const nx = nicelyName(playerName(nextPlayerId(g)));
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
  // setScreen has just written "Game started." into this region for the screen
  // the player has only now arrived on; it keeps this one repaint.
  if (app.screenLine) app.screenLine = '';
  else if (nodes['live-polite'].textContent !== politeEvent) {
    nodes['live-polite'].textContent = politeEvent;
  }

  /* --- you strip: the reference Seat, in the tray */
  const youName = nicelyName(you.name || app.name || 'You');
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
  // Same ladder as the seats: a win and the forgot-TONDO alarm outrank a note.
  const youNote = (youStatus === 'winner!' || youAlarm) ? null : liveSeatNote(snap.youId);
  if (youNote) youStatus = youNote;
  setText(nodes['you-status'], youStatus);
  nodes['you-status'].hidden = !youStatus;
  nodes['you-status'].classList.toggle('is-acting', yourTurn);
  nodes['you-status'].classList.toggle('is-alarm', youAlarm);

  /* --- contextual bars */
  nodes['tondo-bar'].hidden = !g.canDeclareTondo;
  nodes['tondo-btn'].disabled = app.offline;

  const targets = (g.calloutTargets || []).filter(Boolean);
  const targetKey = targets.join(',');
  const showCallout = !over && targets.length > 0 && app.calloutDismissed !== targetKey;
  const drawnCard = drawnId ? g.hand.find((c) => c.id === drawnId) : null;
  /* The bar is about to close under whoever pressed a button in it: "Let it
     pass" hides it in this very repaint, "Call out X" on the snapshot that
     answers. Either way the focused node goes with it and the keyboard lands
     on <body> — the same shape the suit picker had, so it takes the same
     landing, applied after the hand below has been rebuilt. */
  const leavingCallout = !nodes['callout-bar'].hidden && !showCallout
    && !!document.activeElement && nodes['callout-bar'].contains(document.activeElement);
  nodes['callout-bar'].hidden = !showCallout;
  nodes.stage.classList.toggle(
    'is-compressed',
    g.canDeclareTondo || showCallout || !!drawnCard || wildOpen || over,
  );
  /* Round over is its own kind of compressed. A decision bar swaps the hand out
     and costs the stage ~84px; the scoreboard costs it 247px (tray 434 -> 547 at
     1440x900), which `--bar-h` does not model, so the pie is sized for a stage
     that no longer exists and the plaque rides up into a seat ring pinned at its
     floor. Measured overlap at pie complete: -34.4px at 1024x768, -46.1px at
     1280x800, -29.9px at 1440x900. The stage cannot hold both — at 1280x800 it
     is 220px, and no pie size or centre offset fixes it (shrinking the table
     from 194px to 150px moves the gap 0.8px, because the plaque tracks the
     stage's middle rather than the pie). So the seats stand down and let the
     scoreboard be the thing: it already lists every player with their score,
     and the banner names the winner. See styles.css `.stage.is-over #seats`. */
  nodes.stage.classList.toggle('is-over', over);
  if (showCallout) {
    const who = targets.map((id) => nicelyName(playerName(id))).join(' and ');
    nodes['callout-head'].textContent = `${who} forgot TONDO — call them out`;
    nodes['callout-sub'].textContent = 'One card left and never said it. Catching them costs them +2.';
    renderCalloutButtons(targets, targetKey);
  }

  /* Playing a DRAWN wild opens the suit picker while the server still holds a
     drawn decision, so both bars used to show at once — and the drawn bar's
     "Play it" simply re-opened the picker the player was already looking at.
     One decision is on the table at a time: once the picker is up, it is the
     only thing being asked. */
  nodes['drawn-bar'].hidden = !drawnCard || wildOpen;
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
          /* The button that was just pressed is inside a bar this render has
             hidden, so the browser drops focus to <body> and a keyboard player
             is left nowhere. Same landing as cancelWild's Escape path. */
          focusHandOrDraw(cardId);
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

  /* --- the pie */
  renderMatch(snap, over);

  /* --- hand */
  // A finished round swaps the hand for the scoreboard: the cards can no
  // longer be played, and the standings are what the table wants to look at.
  const swapHand = !!drawnCard || wildOpen || over;
  nodes['hand-wrap'].hidden = swapHand;
  nodes['action-row'].hidden = !!drawnCard || wildOpen;
  if (!swapHand) renderHand(g, yourTurn, playable, drawnId);

  // The label names whatever the tray is actually showing — at round over the
  // hand has been swapped out for the scoreboard, so "Your hand" would be
  // pointing at something that is not there.
  setText(nodes['hand-label'], over ? 'The pie'
    : (wildOpen ? 'Pick a topping' : (drawnCard ? 'Draw decision' : 'Your hand')));
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

  // The callout bar has closed under the keyboard (see `leavingCallout`): the
  // hand is rendered now, so there is somewhere real to land.
  if (leavingCallout) focusHandOrDraw();

  /* --- action row */
  nodes['draw-btn'].disabled = app.offline || !yourTurn || !!drawnCard || wildOpen;
  nodes['draw-btn'].hidden = over;
  const deckButton = document.getElementById('deck');
  deckButton.disabled = nodes['draw-btn'].disabled || over;
  deckButton.setAttribute('aria-label', deckButton.disabled
    ? `Draw pile — ${g.drawPileCount} cards left`
    : `Draw a card — ${g.drawPileCount} left in the deck`);
  /* Dealing is no longer the host's alone. A table used to stall because one
     specific person had put their phone down, and everyone else was shown
     "waiting for the host" with no control at all. */
  const m = snap.match;
  nodes['newround-btn'].hidden = !over;
  if (over) setText(nodes['newround-btn'], m && m.complete ? 'New pie' : 'Next slice');
  // Hold is only meaningful while a clock is actually running toward a deal.
  const clockRunning = !!(over && m && m.nextDueAt);
  nodes['hold-btn'].hidden = !clockRunning;
  nodes['hold-btn'].disabled = app.offline;
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
      ? `Waiting for ${nicelyName(current.name)} to reconnect…`
      : `${nicelyName(playerName(g.turnPlayerId))} is playing — hands off.`;
  }
  /* The between-slices clock lives in the hint slot, in the tray's own quiet
     type. Deliberately NOT a large counting digit and never a tick sound: the
     beat exists so the table can read the standings and groan about them, and
     a slot-machine reel would turn a pause into pressure. `app.nextDueAt`
     drives a 1s ticker (below) that rewrites this line in place. */
  app.nextDueAt = clockRunning ? m.nextDueAt : 0;
  if (over) {
    if (clockRunning) hint = nextSliceHint(m);
    else if (m && m.held) hint = 'Held — deal when the table is ready.';
    else if (m && m.complete) hint = 'Pie finished. Deal again for a fresh one.';
    else hint = 'Round over — deal again when you like.';
  }
  // A countdown must not crossfade every second; it is rewritten in place.
  if (clockRunning) nodes.hint.textContent = hint;
  else setText(nodes.hint, hint);
  scheduleNextSliceTicker();

  let alert = '';
  if (g.canDeclareTondo) alert = 'You are down to two cards. Call TONDO before you play.';
  else if (showCallout) alert = `${targets.map((id) => nicelyName(playerName(id))).join(' and ')} forgot TONDO. Call them out now.`;
  else if (drawnCard) alert = `You drew ${prettyCard(drawnCard)}. Play it, or keep it and pass.`;
  else if (over) alert = g.winnerId === snap.youId ? 'You win the round.' : `${nicelyName(playerName(g.winnerId))} wins the round.`;
  if (nodes['live-alert'].textContent !== alert) nodes['live-alert'].textContent = alert;

  if (!over && !yourTurn && app.messageTone !== 'bad') setMessage('', 'info');

  moveToken(snap);
}

/** A small chip that travels the ring to whoever holds the turn — the turn
 *  passing is the Ring Table's one continuous, spatial fact. */
/**
 * The pie: four rounds, a running score, and the scoreboard that closes each
 * one.
 *
 * A round used to end and leave nothing behind — a banner, a dead hand and a
 * button. Nothing accumulated, so there was never a reason to play the next
 * one beyond wanting to. This is where a round becomes part of something.
 *
 * During play it is deliberately almost invisible: one chip saying which slice
 * this is. The product principle is that idle surfaces stay quiet, and a
 * running scoreboard on screen while somebody is deciding a card is noise.
 */
function renderMatch(snap, over) {
  const m = snap.match;
  const chip = nodes['slice-chip'];
  const board = nodes.scoreboard;
  if (!m) { chip.hidden = true; board.hidden = true; hideShareBtn(); return; }

  // Slice N of 4 — `round` counts slices FINISHED, so the one being played is
  // the next one up, capped so a finished pie does not read "slice 5 of 4".
  const playing = Math.min(m.round + 1, m.roundsPerPie);
  chip.hidden = over;
  if (!over) setText(chip, `Slice ${playing}/${m.roundsPerPie}`);

  board.hidden = !over;
  if (!over) { hideShareBtn(); return; }

  // The share button only ever describes a FINISHED pie — a mid-pie round
  // boundary has nothing worth pasting into a group chat yet.
  if (!m.complete) hideShareBtn();
  else nodes['share-btn'].hidden = false;

  const last = m.lastRound;
  const champions = m.championIds || [];
  const youWon = champions.includes(snap.youId);
  const championNames = champions.map((id) => nicelyName(playerName(id))).join(' & ');

  if (m.complete) {
    setText(nodes['score-title'], champions.length > 1
      ? 'The pie is shared'
      : (youWon ? 'You take the pie!' : `${championNames} takes the pie`));
    setText(nodes['score-sub'], champions.length > 1
      ? `${championNames} finish level after four slices.`
      : `Four slices played. Deal again for a fresh pie.`);
  } else {
    const winner = last && last.winnerId ? nicelyName(playerName(last.winnerId)) : null;
    setText(nodes['score-title'], !winner ? 'Round over'
      : (last.winnerId === snap.youId ? `You win slice ${m.round}` : `${winner} wins slice ${m.round}`));
    /* The scoreboard used to show a bare "+107" with nothing anywhere saying
       where it came from, and the help dialog never uses the word "point" at
       all. The server has always shipped the answer — roundResult.breakdown,
       one { id, cards, points } per seat that did not win (server/game.js) and
       documented in PROTOCOL.md — and no client code read it. This line spends
       it: the sum IS the rule, so showing the addition teaches "the winner
       banks the value of every other hand" without a sentence of instruction.
       The slices-left count it replaces was duplicated by the pips directly
       below it, which now carry that fact to assistive tech as well as to the
       eye. */
    setText(nodes['score-sub'], roundArithmetic(last, snap.youId)
      || `${m.roundsPerPie - m.round} ${m.roundsPerPie - m.round === 1 ? 'slice' : 'slices'} left in the pie.`);
  }

  // Rows are keyed by player id for the same reason the seats are: a score
  // that counts up should animate, and a rebuilt node cannot.
  const rows = nodes['score-rows'];
  const live = new Map([...rows.children].map((n) => [n.dataset.player, n]));
  (m.standings || []).forEach((row, i) => {
    let li = live.get(row.id);
    if (!li) {
      li = document.createElement('li');
      li.className = 'score-row';
      li.dataset.player = row.id;
      li.innerHTML = '<span class="score-rank"></span><span class="score-name"></span>'
        + '<span class="score-delta"></span><span class="score-total"></span>';
    } else live.delete(row.id);
    if (rows.children[i] !== li) rows.insertBefore(li, rows.children[i] || null);

    const gained = last && last.winnerId === row.id ? last.points : 0;
    const isChampion = m.complete && champions.includes(row.id);
    const cls = `score-row${row.id === snap.youId ? ' is-you' : ''}${isChampion ? ' is-champion' : ''}`;
    if (li.className !== cls) li.className = cls;
    li.querySelector('.score-rank').textContent = String(i + 1);
    li.querySelector('.score-name').textContent = nicelyName(row.name);
    // The points just banked are the story of the round; a zero is left blank
    // rather than shown as "+0", which reads as a failure the player caused.
    li.querySelector('.score-delta').textContent = gained ? `+${gained}` : '';
    li.querySelector('.score-total').textContent = String(row.points);
    li.setAttribute('aria-label',
      `${nicelyName(row.name)}, ${row.points} points${gained ? `, ${gained} this round` : ''}`);
  });
  live.forEach((n) => n.remove());

  // One pip per slice, filled as the pie is eaten.
  const pips = nodes['slice-pips'];
  while (pips.children.length > m.roundsPerPie) pips.lastElementChild.remove();
  while (pips.children.length < m.roundsPerPie) {
    const pip = document.createElement('span');
    pip.className = 'slice-pip';
    pips.appendChild(pip);
  }
  [...pips.children].forEach((pip, i) => pip.classList.toggle('is-done', i < m.round));
  /* The pips were aria-hidden decoration duplicating the sub-line's
     slices-left sentence. The sub-line now carries the round's arithmetic
     instead, so the pips take over the fact they were already showing. */
  const label = `${m.round} of ${m.roundsPerPie} slices played`;
  if (pips.getAttribute('aria-label') !== label) pips.setAttribute('aria-label', label);
}

/* "Cards left in hand: Dominic 45 + Pina 32 + you 30 = 107."
   Built from the round result's own breakdown, in the order the server sent it,
   so the figures cannot disagree with the +107 on the winner's row. Returns ''
   when there is nothing to explain — no winner, or a breakdown the server did
   not send — and the caller falls back to the old sentence rather than printing
   a half-formed one. `forfeited` is called out separately because it comes from
   a hand returned to the deck by someone who left, not from a seat still at the
   table, and silently folding it into the sum would make the addition wrong. */
function roundArithmetic(last, youId) {
  if (!last || !last.winnerId || !Array.isArray(last.breakdown) || !last.breakdown.length) return '';
  const parts = last.breakdown.map((b) => {
    const who = b.id === youId ? 'you' : nicelyName(playerName(b.id));
    return `${who} ${b.points}`;
  });
  const forfeited = last.forfeited
    ? ` (+${last.forfeited} from a seat that left)` : '';
  return `Cards left in hand: ${parts.join(' + ')} = ${last.points}${forfeited}.`;
}

/** "Next slice in 7 — or deal now." Seconds, floored, never below zero. */
function nextSliceHint(m) {
  const left = Math.max(0, Math.ceil((m.nextDueAt - Date.now()) / 1000));
  return left > 0
    ? `Next slice in ${left} — deal now, or hold.`
    : 'Dealing the next slice…';
}

/* One 1s interval, alive only while a clock is actually running. It rewrites a
   single text node and touches nothing else — a full repaint every second at
   the round boundary would restart the scoreboard's own entry. */
function scheduleNextSliceTicker() {
  clearInterval(app.nextTicker);
  app.nextTicker = 0;
  if (!app.nextDueAt) return;
  app.nextTicker = setInterval(() => {
    const m = app.snap && app.snap.match;
    if (!m || !m.nextDueAt || app.snap.phase !== 'roundOver') {
      clearInterval(app.nextTicker);
      app.nextTicker = 0;
      return;
    }
    nodes.hint.textContent = nextSliceHint(m);
  }, 1000);
}

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
  // On the last slice the chip follows the banner and the scoreboard: the pie
  // outranks the round, and the three must not name three different people.
  const m = snap.match;
  const champions = (over && m && m.complete) ? (m.championIds || []) : [];
  let verb;
  if (champions.length > 1) verb = 'Pie shared';
  else if (champions.length === 1) {
    verb = champions[0] === snap.youId ? 'You take the pie!' : `${nicelyName(playerName(champions[0]))} takes the pie!`;
  } else if (over) verb = (g.winnerId === snap.youId ? 'You win!' : nicelyName(playerName(g.winnerId)) + ' wins!');
  else if (g.turnPlayerId === snap.youId) verb = 'Your turn';
  else if (active && !active.connected) verb = 'Waiting for ' + nicelyName(active.name) + '…';
  else verb = nicelyName(active ? active.name : '') + ' is playing';
  const leadId = champions.length === 1 ? champions[0] : (over ? g.winnerId : g.turnPlayerId);
  // The pill is the header's turn chip: a dot in the holder's tone, then the
  // verb. Whoever is next follows in the serif voice, not a second chip.
  let html = `<span class="chip">
      <span class="dot" style="background:${colorOf(leadId)}"></span>
      <span class="txt">${esc(verb)}</span></span>`;
  if (!over && next) {
    html += `<span class="chip chip-next">
      <span class="txt">then ${esc(next.id === snap.youId ? 'you' : nicelyName(next.name))}</span></span>`;
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

/* The finished pie leaving the board: each topping slides outward along its own
   bearing, past the crust, fading as it goes. Ease-in, because it is leaving —
   it gathers speed on the way out rather than arriving anywhere. */
const LEDGER_SWEEP_MS = 520;
const LEDGER_SWEEP_EASE = 'cubic-bezier(.55,.06,.68,.19)';

/**
 * A new round is a new pie. The ledger's STATE resets at once — the next
 * round's toppings start from nothing even while the last round's are still
 * leaving — but with `{ sweep: true }` the finished pie is swept off the board
 * instead of vanishing in one frame. Returns the milliseconds until the board is
 * clear: LEDGER_SWEEP_MS while sweeping, 0 when it cleared immediately (reduced
 * motion, an empty pie, or any caller that did not ask for the sweep).
 */
function ledgerClear({ sweep = false } = {}) {
  app.ledger = [];
  app.tally = new Map();
  app.ledgerKey = 0;
  app.ledgerLaidOut = '';
  if (!nodes.ledger) return 0;
  const leaving = [...nodes.ledger.querySelectorAll('.tp')];
  const box = nodes.sauce ? nodes.sauce.getBoundingClientRect() : null;
  const R = box ? box.width / 2 : 0;
  if (!sweep || RM.matches || !leaving.length || !R) {
    nodes.ledger.replaceChildren();
    return 0;
  }
  const cx = box.left + R, cy = box.top + box.height / 2;
  for (const node of leaving) {
    // The point is the topping's position (the .tp box is 0x0), so its bearing
    // is read off the rect; a piece dead on the centre leaves straight up.
    const p = node.getBoundingClientRect();
    const x = p.left - cx, y = p.top - cy;
    const len = Math.hypot(x, y);
    const ux = len > 0.5 ? x / len : 0, uy = len > 0.5 ? y / len : -1;
    /* composite: 'add' appends this translate AFTER the topping's own
       `scale(--age-s)`, which scales it: divide that back out so every piece
       travels the full 135% of the radius, aged or not. */
    const s = Number.parseFloat(node.style.getPropertyValue('--age-s')) || 1;
    const d = (1.35 * R) / s;
    const timing = { id: 'ledger-sweep', duration: LEDGER_SWEEP_MS, easing: LEDGER_SWEEP_EASE, fill: 'forwards' };
    const move = node.animate([
      { transform: 'translate(0px, 0px)' },
      { transform: `translate(${(ux * d).toFixed(2)}px, ${(uy * d).toFixed(2)}px)` },
    ], { ...timing, composite: 'add' });
    // Opacity is its own, replacing effect: an additive one would add to the
    // topping's age dimming rather than fade it out.
    node.animate([{ opacity: 0 }], timing);
    let gone = false, guard = 0;
    const drop = () => { if (gone) return; gone = true; clearTimeout(guard); node.remove(); };
    move.finished.then(drop, drop);
    guard = setTimeout(drop, LEDGER_SWEEP_MS + 400);
  }
  return LEDGER_SWEEP_MS;
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
  /* A Wild's chosen topping is the single most consequential fact on the
     board, and #top-card is the only labelled element that exists to state
     it: "Top card: Wild" alone leaves a screen-reader player unable to know
     what they may play. The plaque shows the same thing to everyone else. */
  nodes['top-card'].setAttribute('aria-label', isWild(top)
    ? `Top card: Wild, topping is ${SUITS[activeSuitOf(g)].label.toLowerCase()}`
    : `Top card: ${prettyCard(top)}`);
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

/** The empty shell of one seat. Everything inside it is then updated in place. */
function buildSeat(playerId) {
  const seat = document.createElement('div');
  seat.className = 'seat';
  seat.dataset.player = playerId;
  seat.setAttribute('role', 'img');
  seat.innerHTML = `<div class="plate">
      <div class="seat-body">
        <div class="stack">
          <span class="seat-tile"><span class="seat-initial"></span></span>
          <span class="count-badge"></span>
        </div>
        <div class="fan"></div>
      </div>
      <div class="seat-status">
        <span class="seat-name"></span>
        <span class="seat-verb"></span>
      </div>
    </div>`;
  return seat;
}

/** One-shot classes fired at a seat plate from outside the render (see renderSeats):
 *  the turn pop, and fx.js's TONDO stamp.
 *  (The skip duck and the callout lunge are WAAPI animations in fx.js, so they
 *  need no entry here.) */
const PLATE_ONE_SHOTS = ['is-pop', 'is-tondo'];

/** Adds or removes fanned card backs so the stack matches the hand size. */
function syncFan(fan, shown) {
  while (fan.children.length > shown) fan.lastElementChild.remove();
  while (fan.children.length < shown) {
    const back = document.createElement('span');
    back.className = 'mini-back back-face';
    back.style.transform = `rotate(${FAN_ROTS[fan.children.length] || 0}deg)`;
    fan.appendChild(back);
  }
}

const setTextIfChanged = (node, text) => { if (node.textContent !== text) node.textContent = text; };

/**
 * Seats are updated in place, keyed by player id — the same treatment the hand
 * gets, and for the same reasons.
 *
 * This used to render one HTML string for the whole ring and assign it to
 * `innerHTML` whenever it differed from last time. Because ANY difference
 * rewrote EVERY seat, three things followed. A card count changing anywhere
 * destroyed and rebuilt all four seats, so a player who had forgotten TONDO had
 * their alarm restarted by other people's moves. The seats' own CSS opacity
 * transitions could never run at all, because the node that would have
 * transitioned was replaced rather than changed. And the rebuild cost the most
 * DOM churn in the app on the single most frequent event in the game.
 *
 * Keeping the nodes fixes all three: an animation restarts only when the thing
 * it describes actually changes.
 */
function renderSeats(snap, g, over) {
  const around = seatsAroundYou(g, snap.youId);
  const nextId = over ? '' : nextPlayerId(g);
  const maxBacks = COMPACT.matches ? 3 : 4;
  const host = nodes.seats;
  const live = new Map([...host.children].map((n) => [n.dataset.player, n]));

  around.forEach(({ p, slot, offset }, i) => {
    const tone = TONES[SEAT_TONES[offset % SEAT_TONES.length]];
    const acting = !over && p.id === g.turnPlayerId && p.connected;
    const isNext = p.id === nextId && !acting;
    const name = nicelyName(p.name);

    let status = '', loud = false, alarm = false;
    if (over && g.winnerId === p.id) { status = 'wins!'; loud = true; }
    // Absence outranks the turn: a table stalled on a dropped player must
    // say so, not pretend they are thinking.
    else if (!p.connected) { status = 'away — reconnecting'; }
    else if (p.vulnerable) { status = 'forgot TONDO!'; alarm = true; }
    else if (acting) { status = 'playing…'; loud = true; }
    else if (isNext) { status = 'next'; }
    else if (p.cardCount === 1) { status = 'one card!'; }
    else if (p.declaredTondo) { status = 'TONDO!'; }
    else status = 'waiting';
    // A transient verb ("skipped", "+2") outranks the ordinary statuses: it is
    // the words half of a consequence, and it has to be there under reduced
    // motion, where the duck and the throw are not. A win, an absence and the
    // forgot-TONDO alarm outrank it — the alarm is still true and still
    // catchable, and swapping it out for 1.2s toggled the plate's `is-loud` off
    // and on, which replayed the alarm pop when the note expired.
    const note = (status === 'wins!' || status === 'away — reconnecting' || alarm) ? null : liveSeatNote(p.id);
    if (note) { status = note; loud = true; }

    let seat = live.get(p.id);
    if (!seat) seat = buildSeat(p.id);
    else live.delete(p.id);
    if (host.children[i] !== seat) host.insertBefore(seat, host.children[i] || null);

    // `className` is assigned wholesale only when it actually differs, so the
    // seat's transitions see a class change only on a real state change.
    const seatClass = `seat seat-${slot}${acting ? '' : (isNext ? ' is-next' : ' is-idle')}`;
    if (seat.className !== seatClass) seat.className = seatClass;

    const cardWord = p.cardCount === 1 ? 'card' : 'cards';
    const label = `${name}, ${p.cardCount} ${cardWord}, ${status}`;
    if (seat.getAttribute('aria-label') !== label) seat.setAttribute('aria-label', label);

    const plate = seat.firstElementChild;
    // A seat note makes the PILL loud, never the plate. `.plate.is-loud` is a pop,
    // and the note arrives with the snapshot: on the plate it fired before the
    // card's impact frame, and it replayed straight after the duck (a 0.4-opacity
    // flash, measured at 406ms). The consequence effect (duck, throw, punch) is
    // the only motion the victim's plate gets.
    const plateClass = `plate${acting ? ' is-acting' : ''}${(loud || alarm) && !acting && !note ? ' is-loud' : ''}`;
    // Transient one-shot classes (PLATE_ONE_SHOTS) are owned by their callers;
    // preserve them across updates, or a repaint landing mid-animation would
    // strip the class and cut the motion short.
    const transient = PLATE_ONE_SHOTS.filter((c) => plate.classList.contains(c));
    const bare = transient.reduce((cls, c) => cls.replace(' ' + c, ''), plate.className);
    if (bare !== plateClass) {
      plate.className = plateClass + transient.map((c) => ' ' + c).join('');
    }

    const stack = plate.querySelector('.stack');
    if (stack.style.getPropertyValue('--tone-bg') !== tone.bg) {
      stack.style.setProperty('--tone-bg', tone.bg);
      stack.style.setProperty('--tone-edge', tone.edge);
    }
    // The acting ring is a node rather than a class so its pulse starts when
    // the turn arrives and cannot be restarted by an unrelated repaint.
    const ring = stack.querySelector('.seat-ring');
    if (acting && !ring) {
      const r = document.createElement('span');
      r.className = 'seat-ring';
      stack.insertBefore(r, stack.firstChild);
    } else if (!acting && ring) ring.remove();

    setTextIfChanged(stack.querySelector('.seat-initial'), (name.charAt(0) || '?').toUpperCase());
    setTextIfChanged(stack.querySelector('.count-badge'), String(p.cardCount));
    syncFan(plate.querySelector('.fan'), Math.min(p.cardCount, maxBacks));

    const statusEl = plate.querySelector('.seat-status');
    const statusClass = `seat-status${alarm ? ' is-alarm' : (loud ? ' is-loud' : '')}`;
    if (statusEl.className !== statusClass) statusEl.className = statusClass;
    setTextIfChanged(statusEl.querySelector('.seat-name'), name);
    setTextIfChanged(statusEl.querySelector('.seat-verb'), status);
  });

  live.forEach((n) => n.remove());
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

  // A new deal is a whole new hand, even where a card id repeats. Ids name a
  // card in the deck (c0…c67), not a hand, so a keyed node from last round's
  // leftovers would be KEPT for the same card in the new deal — shown at once,
  // before any ghost has left the deck. (A three-card leftover shares an id
  // with a fresh seven-card hand 1 − C(65,7)/C(68,7) ≈ 28% of the time.)
  if (app.roundDeal) row.replaceChildren();
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
    // During a new round's deal each card that has a ghost (the first
    // ROUND_DEAL_CARDS) rises as that ghost arrives: the same round-robin slot
    // dealGhosts gives it, plus the flight. The rest follow straight after the
    // last of those on the ordinary draw stagger — continuing the round-robin
    // for cards nobody sees dealt left a 7-card hand still rising at 3.1s.
    const deal = app.roundDeal && app.roundDeal.seatIndex >= 0 ? app.roundDeal : null;
    const ghosted = Math.min(entering.length, ROUND_DEAL_CARDS);
    const arrival = (k) => deal.startDelay + k * (deal.players * 90) + deal.seatIndex * 90 + MS.deal;
    const rising = [];
    entering.forEach((node, k) => {
      const delay = !deal ? Math.min(k, 6) * MS.dealStep
        : (k < ghosted ? arrival(k) : arrival(ghosted - 1) + (k - ghosted + 1) * MS.dealStep);
      const timing = {
        duration: MS.handIn,
        delay,
        easing: EASE_OUT,
        fill: 'backwards',   // invisible during its delay, not popped in early
      };
      const rise = node.animate(
        [{ transform: 'translateY(22px) scale(.92)' }, { transform: 'translateY(0) scale(1)' }],
        { ...timing, composite: 'add' });
      node.animate([{ opacity: 0 }, { opacity: 1 }], timing);
      // A card still waiting to rise is at opacity 0 but otherwise a real
      // button: it could be tabbed to, armed or played unseen. Inert until its
      // rise begins (releaseWhenRising), and tapCardId refuses it besides.
      if (delay > 0) { node.inert = true; rising.push({ node, rise, delay }); }
    });
    if (rising.length) releaseWhenRising(rising);
  }

  if (focusedId && focusLost() && row.children.length) {
    // The focused card left the hand (it was played): land on its neighbour.
    // A card that has not started rising yet is `inert` and cannot take focus
    // — focusing it is a silent no-op that leaves the player on <body> — so
    // the search walks outwards from where the played card was to the nearest
    // card that can actually hold focus.
    const again = row.querySelector(`[data-card="${CSS.escape(focusedId)}"]`);
    const takesFocus = (n) => !!n && !n.inert && !n.disabled;
    const kids = [...row.children];
    const start = Math.min(Math.max(focusedIndex, 0), kids.length - 1);
    let near = null;
    for (let d = 0; d < kids.length && !near; d++) {
      if (takesFocus(kids[start - d])) near = kids[start - d];
      else if (takesFocus(kids[start + d])) near = kids[start + d];
    }
    const target = takesFocus(again) ? again : near;
    if (target) target.focus({ preventScroll: true });
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

/** Hands each waiting card back to the player on the frame its rise begins —
 *  read off its own entry animation, so it cannot come back before it is seen. */
function releaseWhenRising(cards) {
  const tick = () => {
    let waiting = 0;
    for (const c of cards) {
      if (!c.node.inert) continue;
      const t = c.rise.currentTime;
      const state = c.rise.playState;
      if (!c.node.isConnected || state === 'finished' || state === 'idle' || (t !== null && t >= c.delay)) {
        c.node.inert = false;
      } else {
        waiting++;
      }
    }
    if (waiting) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
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
  // A card that has not started rising yet is not on screen (see renderHand).
  const node = nodes['hand-row'].querySelector(`[data-card="${CSS.escape(id)}"]`);
  if (node && node.inert) return;

  if (g.turnPlayerId !== s.youId) {
    setMessage(`${nicelyName(playerName(g.turnPlayerId))} is playing — you can look, but not play yet.`, 'info');
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
  // Press feedback for the commit, not for the arming tap above: the buzz
  // says "that went", which is only true of this branch.
  haptics.tap();
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

/**
 * Has the keyboard been dropped? A removed node leaves <body> focused, but a
 * node that is merely hidden can keep `document.activeElement` pointing at it
 * for a while (measured on the help dialog: still #help-close one microtask,
 * one rAF and one timeout after close), so "is it still connected and in the
 * document" is the question, not "is it <body>".
 */
function focusLost() {
  const a = document.activeElement;
  return !a || a === document.body || !a.isConnected || !document.body.contains(a);
}

/**
 * Where the keyboard goes when a tray bar closes under it — the suit picker,
 * either way it can close, and the callout bar. The card the bar was about if
 * it is still in the hand (Escape put a Wild back), else the nearest card that
 * survived, else the Draw button. Never <body>.
 */
function focusHandOrDraw(cardId) {
  const row = nodes['hand-row'];
  const handUp = !nodes['hand-wrap'].hidden;
  const usable = (n) => n && !n.inert && !n.disabled && (n.offsetParent || n.getClientRects().length);
  const card = (handUp && cardId) ? row.querySelector(`[data-card="${CSS.escape(cardId)}"]`) : null;
  const target = (usable(card) && card)
    || (handUp ? [...row.children].find(usable) : null)
    || (usable(nodes['draw-btn']) ? nodes['draw-btn'] : null);
  if (target) target.focus({ preventScroll: true });
}

function cancelWild() {
  const cardId = app.pendingWild;
  if (!cardId) return;
  app.pendingWild = null;
  if (!app.snap) return;
  renderGame(app.snap);
  focusHandOrDraw(cardId);
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

/* ------------------------------------------------------------------ sound */

/* A browser will not create a running AudioContext outside a user gesture, and
   iOS suspends the one we have whenever the tab goes away. So this listens to
   every gesture rather than just the first: `unlock()` is a no-op once the
   context is running, and the repeat is what brings it back after a suspend. */
for (const evt of ['pointerdown', 'keydown', 'touchstart']) {
  document.addEventListener(evt, () => sound.unlock(), { passive: true });
}

const soundBtn = document.getElementById('sound-btn');
function paintSoundButton() {
  const on = !sound.isMuted();
  soundBtn.setAttribute('aria-pressed', String(on));
  soundBtn.setAttribute('aria-label', on ? 'Sound on — turn off' : 'Sound off — turn on');
  soundBtn.classList.toggle('is-off', !on);
}
soundBtn.addEventListener('click', () => {
  const nowMuted = sound.toggleMuted();
  paintSoundButton();
  // Unmuting plays the sound it just re-enabled, so the button proves itself.
  if (!nowMuted) sound.play('turn');
});
paintSoundButton();

/* ---------------------------------------------------------------- haptics */

/* The toggle only exists where the capability does. `navigator.vibrate` has
   never shipped in Safari on iOS, so on roughly half the phones this game is
   played on the button stays `hidden` rather than sitting there doing nothing
   — and every other channel carries the same information regardless. */
const hapticsBtn = document.getElementById('haptics-btn');
function paintHapticsButton() {
  const on = haptics.isEnabled();
  hapticsBtn.hidden = !haptics.isSupported();
  hapticsBtn.setAttribute('aria-pressed', String(on));
  hapticsBtn.setAttribute('aria-label', on ? 'Vibration on — turn off' : 'Vibration off — turn on');
  hapticsBtn.classList.toggle('is-off', !on);
}
hapticsBtn.addEventListener('click', () => {
  const on = haptics.setEnabled(!haptics.isEnabled());
  paintHapticsButton();
  // Turning it on proves itself in the only way this channel can be proven.
  if (on) haptics.tap();
});
paintHapticsButton();

/* ------------------------------------------------------------- how to play */

const helpDialog = document.getElementById('help-dialog');
/* Delegated, not a one-shot querySelectorAll at boot: a `[data-help-open]`
   button that is added to the page after that line has run is a dead control
   that still looks like a live one. */
document.addEventListener('click', (e) => {
  const opener = e.target instanceof Element ? e.target.closest('[data-help-open]') : null;
  if (opener) openHelp(opener);
});

/** The control focus should return to when the dialog closes, when the
 *  browser has none of its own (an auto-open has no opener). */
let helpReturn = null;
/** This dialog was opened by the app, not by the player. */
let helpAuto = false;

function openHelp(opener) {
  // Seeing the rules once is the whole gate on the lobby's auto-open.
  try { localStorage.setItem('tondo.seenHelp', '1'); } catch { /* private mode */ }
  helpReturn = opener || null;
  helpAuto = !opener;
  if (!helpDialog.open) helpDialog.showModal();
}

/** Takes an auto-opened dialog down when the screen under it changes. A
 *  dialog the player opened themselves is theirs and stays. */
function closeAutoHelp(landOn) {
  if (!helpDialog.open || !helpAuto) return;
  helpReturn = landOn || null;
  helpDialog.close();
}

/** A real control on the screen the player is actually looking at. */
function helpFallbackControl() {
  const screen = document.getElementById('screen-' + (document.body.dataset.screen || 'home'));
  if (!screen) return null;
  const shown = (n) => !!(n.offsetParent || n.getClientRects().length);
  const help = [...screen.querySelectorAll('[data-help-open]')].find(shown);
  if (help) return help;
  return [...screen.querySelectorAll('button:not([disabled])')].find(shown) || null;
}

/* A native <dialog> restores focus to whatever opened it — but the lobby's
   first-visit auto-open has no opener, so the browser has nothing to restore
   to and focus falls to <body>: defect (c) again, inside the flow (b) adds.
   So the landing is placed here rather than waited for. Measured in headless
   Chrome 1280x800: at `close` time, and still one microtask, one rAF and one
   timeout later, document.activeElement is #help-close — a node inside a
   dialog that is already display:none — and only afterwards does the browser
   quietly reset it to <body>. Reading focus to decide whether to intervene
   therefore always reads the wrong answer; setting it does not. Where the
   browser would have a restore target of its own (a button the player
   pressed) this lands on that same button. */
helpDialog.addEventListener('close', () => {
  const back = helpReturn;
  helpReturn = null;
  helpAuto = false;
  const shown = (n) => !!(n && n.isConnected && (n.offsetParent || n.getClientRects().length));
  const target = shown(back) ? back : helpFallbackControl();
  if (target) target.focus({ preventScroll: true });
});

/** The lobby, on a first visit: the rules, once, unasked. */
function maybeAutoHelp() {
  if (helpDialog.open) return;
  // "One quick pie" passes through the lobby in two snapshots on its way to a
  // dealt table; a modal opened there would land on top of the game.
  if (app.quickPie) return;
  let seen = '';
  try { seen = localStorage.getItem('tondo.seenHelp') || ''; } catch { seen = ''; }
  if (seen) return;
  openHelp(null);
}

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
nodes['hold-btn'].addEventListener('click', () => {
  // Sticky on the server: the table waits until somebody actually deals.
  send({ type: 'hold' });
  nodes['live-now'].textContent = 'Table held. Deal when you are ready.';
});

/* ------------------------------------------------------------------ boot */

bootHome();
setScreen('home');

/* A reload is a drop that lost its variables: arm the seat first, then dial. */
let room = '';
try { room = sessionStorage.getItem('tondo.room') || ''; } catch { /* ignore */ }
if (room && !app.autoJoin) {
  const seat = conn.seatFor(room);
  if (seat) { app.name = seat.name; conn.restore(seat); }
}
conn.connect();
