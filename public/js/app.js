/**
 * TONDO client.
 *
 * The server is authoritative: this file sends intent and repaints the whole
 * screen from each `state` snapshot. Nothing here decides whether a card is
 * legal — `playableCardIds`, `canDeclareTondo`, `calloutTargets` and
 * `drawnDecisionCardId` come off the wire and every affordance follows them.
 *
 * Visual language ported from docs/design/ring-table.dc.html: the card faces,
 * topping marks, ring geometry, seat plates and animations are the design's.
 */

import { Connection } from './net.js';

/* ------------------------------------------------------------- constants */

const SUITS = {
  pepperoni: { label: 'PEPPERONI', c: '#ff2e6b', glyph: '●', abbr: 'PEP' },
  cheese:    { label: 'CHEESE',    c: '#ffc93d', glyph: '◆', abbr: 'CHZ' },
  basil:     { label: 'BASIL',     c: '#3ddc7f', glyph: '❧', abbr: 'BAS' },
  anchovy:   { label: 'ANCHOVY',   c: '#4d9dff', glyph: '≈', abbr: 'ANC' },
};
const SUIT_KEYS = ['pepperoni', 'cheese', 'basil', 'anchovy'];
const BONE = '#f4f7ff';
const ACTIONS = { SKIP: '⊘ SKIP', PLUS2: '+2 CARDS', REVERSE: '↻ REVERSE' };
/* seat colours in the design's order: you, then the three other seats */
const SEAT_COLORS = ['#f4f7ff', '#ff8f2e', '#b06bff', '#2fe0d0'];
const HUMAN_ART = './assets/avatar-chef-bot.png';
const BOT_ART = ['./assets/carmela.png', './assets/dominic.png', './assets/pina.png'];
const SLOTS = { 1: ['top'], 2: ['left', 'top'], 3: ['left', 'top', 'right'] };

const mix = (c, p, o) => `color-mix(in oklab, ${c} ${p}%, ${o})`;
const isWild = (c) => !!c && c.value === 'WILD';

/* Topping marks in the deck's illustrated language: solid figure, heavy ink
   outline, one shaded detail. @F fill, @S ink. */
const SVG_BODY = {
  pepperoni: '<circle cx="12" cy="12" r="9" fill="@F" stroke="@S" stroke-width="1.4"/><circle cx="8.9" cy="9.3" r="1.5" fill="@S" fill-opacity=".5"/><circle cx="15.2" cy="11" r="1.8" fill="@S" fill-opacity=".5"/><circle cx="10.8" cy="15.5" r="1.35" fill="@S" fill-opacity=".5"/>',
  cheese: '<path d="M4 18 L12 5.4 L20 18 Z" fill="@F" stroke="@S" stroke-width="1.3" stroke-linejoin="round"/><circle cx="11.3" cy="14.2" r="1.25" fill="@S" fill-opacity=".42"/><circle cx="15.2" cy="16.4" r="0.9" fill="@S" fill-opacity=".42"/>',
  basil: '<path d="M12 2.9C4.4 8.1 4.8 15.7 12 21.1c7.2-5.4 7.6-13 0-18.2z" fill="@F" stroke="@S" stroke-width="1.15" stroke-linejoin="round"/><path d="M12.6 18.2c-2.2-3.4-2.4-7.6-0.6-10.4" fill="none" stroke="@S" stroke-opacity=".4" stroke-width="1" stroke-linecap="round"/>',
  anchovy: '<path d="M3.9 12c2.9-3.5 6.7-5 10.2-5 2.8 0 5 1 6.2 2.3-1 1-1.5 1.8-1.5 2.7s.5 1.7 1.5 2.7c-1.2 1.3-3.4 2.3-6.2 2.3-3.5 0-7.3-1.5-10.2-5z" fill="@F" stroke="@S" stroke-width="1.4" stroke-linejoin="round"/><circle cx="16.4" cy="10.6" r="1.1" fill="@S" fill-opacity=".62"/>',
  wild: '<path d="M12 2.8l2.8 6 6.4.7-4.8 4.4 1.3 6.4L12 17.1 6.3 20.3l1.3-6.4L2.8 9.5l6.4-.7z" fill="@F" stroke="@S" stroke-width="1.4" stroke-linejoin="round"/>',
  skip: '<circle cx="12" cy="12" r="8.2" fill="none" stroke="@S" stroke-width="4.6"/><circle cx="12" cy="12" r="8.2" fill="none" stroke="@F" stroke-width="2.6"/><path d="M6.6 17.4 17.4 6.6" stroke="@S" stroke-width="4.6" stroke-linecap="round"/><path d="M6.6 17.4 17.4 6.6" stroke="@F" stroke-width="2.6" stroke-linecap="round"/>',
  reverse: '<g fill="none" stroke="@S" stroke-width="4.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9.9a7.3 7.3 0 0 1 12.7-2.1"/><path d="M19 14.1a7.3 7.3 0 0 1-12.7 2.1"/><path d="M14.5 4.4 18.2 7.5 14.7 10"/><path d="M9.5 19.6 5.8 16.5 9.3 14"/></g><g fill="none" stroke="@F" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9.9a7.3 7.3 0 0 1 12.7-2.1"/><path d="M19 14.1a7.3 7.3 0 0 1-12.7 2.1"/><path d="M14.5 4.4 18.2 7.5 14.7 10"/><path d="M9.5 19.6 5.8 16.5 9.3 14"/></g>',
};

/** Wild sits on a near-white card, so it inverts: ink figure, pale outline.
 *  Below ~16px an outline is 40% of the figure, so small marks go silhouette. */
function markUrl(kind, size) {
  const dark = kind === 'wild';
  const fill = dark ? '#2b3350' : '#ffffff';
  const ink = size < 16 ? fill : (dark ? '#0d1020' : '#2a1a1e');
  const body = SVG_BODY[kind].split('@F').join(fill).split('@S').join(ink);
  return 'url("data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' + body + '</svg>') + '")';
}

function applyMark(node, kind, size, shadow) {
  node.textContent = '';
  node.style.width = size + 'px';
  node.style.height = size + 'px';
  node.style.background = markUrl(kind, size) + ' center/contain no-repeat';
  node.style.textShadow = '';
  node.style.filter = (shadow && kind !== 'wild') ? `drop-shadow(0 ${size > 22 ? 2 : 1}px 0 ${shadow})` : '';
}
function clearMark(node) {
  node.style.width = ''; node.style.height = ''; node.style.background = ''; node.style.filter = '';
}

/** An action card leads with its effect; the topping survives in the border
 *  and the corner glyph. */
function face(c, narrow) {
  if (isWild(c)) return { corner: '', centre: '', label: 'WILD', icon: 'wild', cornerIcon: 'wild' };
  if (c.value === 'REVERSE') return { corner: '', centre: '', label: narrow ? 'FLIP' : 'REVERSE', icon: 'reverse', cornerIcon: c.suit };
  if (c.value === 'SKIP') return { corner: '', centre: '', label: 'SKIP', icon: 'skip', cornerIcon: c.suit };
  if (c.value === 'PLUS2') return { corner: '', centre: '+2', label: narrow ? 'DRAW' : 'DRAW TWO', icon: null, cornerIcon: c.suit };
  return { corner: c.value, centre: '', label: narrow ? SUITS[c.suit].abbr : SUITS[c.suit].label, icon: c.suit, cornerIcon: null };
}

/** Archivo 700 caps run ~0.78em per character, so the size follows the box. */
function fitFont(text, boxW, base) {
  const n = Math.max(1, String(text || '').length);
  return Math.max(9, Math.min(base, Math.floor(boxW / (n * 0.78))));
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

function cardBackground(col) {
  return `linear-gradient(180deg, rgba(255,255,255,.3), rgba(255,255,255,0) 44%),` +
         `linear-gradient(180deg,${mix(col, 90, 'white')},${mix(col, 80, 'black')})`;
}

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
    o = o.split(low).join(nice);
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
 'lobby-wait', 'lobby-msg', 'leave-btn',
 'queue', 'strip-code', 'stage', 'ring', 'plaque', 'match-label', 'dir-badge',
 'match-glyph', 'match-suit', 'match-or-wrap', 'match-value', 'deck-count',
 'top-card', 'top-index', 'top-glyph', 'top-suit', 'dir-glyph', 'dir-label',
 'seats', 'event-ribbon', 'banner', 'live-polite', 'live-alert',
 'you-strip', 'you-portrait', 'you-pips', 'you-count', 'you-status',
 'hand-label', 'playable-label', 'tondo-bar', 'tondo-btn',
 'callout-bar', 'callout-head', 'callout-sub', 'callout-buttons',
 'drawn-bar', 'drawn-card', 'drawn-index', 'drawn-glyph', 'drawn-suit', 'drawn-msg',
 'drawn-play', 'drawn-keep', 'wild-bar', 'wild-corner', 'wild-centre', 'wild-grid',
 'hand-wrap', 'hand-row', 'fade-left', 'fade-right',
 'action-row', 'draw-btn', 'newround-btn', 'message', 'hint', 'game-leave', 'net-banner',
].forEach((id) => { nodes[id] = el(id); });

/* ----------------------------------------------------------------- state */

const app = {
  snap: null,
  roomCode: '',
  youId: '',
  name: '',
  message: '',
  messageTone: 'info',
  pendingWild: null,       // card id waiting for a suit
  calloutDismissed: '',    // target key the player chose to let pass
  bannerTimer: 0,
  lastTurn: undefined,
  handMoved: false,      // the player has scrolled the hand at least once
  handOverflows: false,  // the hand row is wider than the tray
};

const conn = new Connection({ onMessage: handleMessage, onStatus: onNetStatus });

/* --------------------------------------------------------------- helpers */

function setScreen(name) { document.body.dataset.screen = name; }

function setMessage(text, tone) {
  app.message = text || '';
  app.messageTone = tone || 'info';
  nodes.message.textContent = app.message;
  nodes.message.className = 'message' + (app.messageTone === 'info' ? '' : ' ' + app.messageTone);
}

function showBanner(text, tone, ms) {
  clearTimeout(app.bannerTimer);
  nodes.banner.textContent = text;
  nodes.banner.className = 'banner' + (tone === 'win' ? ' win' : '');
  nodes.banner.hidden = false;
  // restart the slam
  nodes.banner.style.animation = 'none';
  void nodes.banner.offsetWidth;
  nodes.banner.style.animation = '';
  if (ms) app.bannerTimer = setTimeout(() => { nodes.banner.hidden = true; }, ms);
}
function hideBanner() { clearTimeout(app.bannerTimer); nodes.banner.hidden = true; }

function onNetStatus(state) {
  const stuck = state === 'disconnected' || state === 'connecting' || state === 'joining';
  nodes['net-banner'].hidden = !stuck;
  nodes['net-banner'].textContent = state === 'joining' ? 'Taking your seat back…' : 'Reconnecting…';
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
  if (g && !(g.calloutTargets || []).length) app.calloutDismissed = '';

  if (snap.phase === 'lobby') {
    hideBanner();
    app.lastTurn = undefined;
    setScreen('lobby');
    renderLobby(snap);
    return;
  }

  setScreen('game');
  if (!prev || prev.phase === 'lobby') { setMessage('', 'info'); app.handMoved = false; }

  if (snap.phase === 'roundOver' && g) {
    const winner = playerName(g.winnerId);
    showBanner(g.winnerId === snap.youId ? 'YOU WIN' : (nicely(winner) + ' WINS').toUpperCase(), 'win', 0);
    app.lastTurn = undefined;
  } else if (g && g.turnPlayerId === snap.youId && app.lastTurn !== g.turnPlayerId) {
    showBanner('YOUR TURN', 'you', 1000);
    setMessage('', 'info');
    app.lastTurn = g.turnPlayerId;
  } else if (g && g.turnPlayerId !== app.lastTurn) {
    hideBanner();
    app.lastTurn = g.turnPlayerId;
  }

  renderGame(snap);
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

function avatarFor(seat, botIndex) {
  return seat.isBot ? BOT_ART[botIndex % BOT_ART.length] : HUMAN_ART;
}

function renderLobby(snap) {
  nodes['room-code'].textContent = snap.roomCode || '—';
  nodes['lobby-msg'].textContent = '';

  let bots = 0;
  nodes['seat-list'].innerHTML = snap.seats.map((seat, i) => {
    const art = avatarFor(seat, seat.isBot ? bots++ : 0);
    const color = SEAT_COLORS[i % SEAT_COLORS.length];
    const tags = [];
    if (seat.id === snap.hostId) tags.push('<span class="tag tag-host">Host</span>');
    if (seat.isBot) tags.push('<span class="tag tag-bot">Bot</span>');
    if (!seat.connected) tags.push('<span class="tag tag-away">Away</span>');
    const remove = (snap.isHost && seat.isBot)
      ? `<button type="button" class="btn btn-tiny" data-remove="${esc(seat.id)}">Remove</button>` : '';
    return `<li class="seat-row">
      <span class="portrait" style="background-image:url('${art}');border-color:${color}"></span>
      <span class="who">${esc(seat.isBot ? nicely(seat.name) : seat.name)}${seat.id === snap.youId ? ' <span class="tag tag-bot">You</span>' : ''}</span>
      ${tags.join('')}${remove}
    </li>`;
  }).join('');

  nodes['seat-list'].querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => send({ type: 'removeSeat', seatId: btn.dataset.remove }));
  });

  nodes['host-controls'].hidden = !snap.isHost;
  nodes['lobby-wait'].hidden = snap.isHost;
  nodes['addbot-btn'].disabled = snap.seats.length >= 4;
  nodes['start-btn'].disabled = snap.seats.length < 2;
}

nodes['copy-btn'].addEventListener('click', async () => {
  const code = app.roomCode || '';
  try {
    await navigator.clipboard.writeText(code);
    nodes['lobby-msg'].textContent = 'Code copied.';
  } catch {
    nodes['lobby-msg'].textContent = 'Copy it by hand: ' + code;
  }
});
nodes['addbot-btn'].addEventListener('click', () => send({ type: 'addBot' }));
nodes['start-btn'].addEventListener('click', () => send({ type: 'startGame' }));
nodes['leave-btn'].addEventListener('click', leaveTable);
nodes['game-leave'].addEventListener('click', leaveTable);

function leaveTable() {
  send({ type: 'leaveRoom' });
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
  renderCenter(g);
  renderSeats(snap, g, over);

  const last = (g.log && g.log.length) ? g.log[g.log.length - 1] : '';
  nodes['event-ribbon'].textContent = sentence(last, nameList);
  nodes['live-polite'].textContent = sentence(last, nameList);

  /* --- you strip */
  nodes['you-portrait'].style.backgroundImage = `url('${HUMAN_ART}')`;
  nodes['you-strip'].classList.toggle('is-acting', yourTurn);
  nodes['you-pips'].innerHTML = g.hand.slice(0, 7).map(() => {
    const col = yourTurn ? BONE : '#67729a';
    return `<span class="pip" style="background:linear-gradient(155deg,${mix(col, 74, 'white')},${mix(col, 88, 'black')})"></span>`;
  }).join('');
  nodes['you-count'].textContent = g.hand.length + (g.hand.length === 1 ? ' card' : ' cards');
  let youStatus = '';
  let youAlarm = false;
  if (over && g.winnerId === snap.youId) youStatus = 'Winner!';
  else if (you.vulnerable) { youStatus = 'Forgot TONDO!'; youAlarm = true; }
  else if (yourTurn) youStatus = 'Your turn!';
  else if (!over && nextPlayerId(g) === snap.youId) youStatus = '▸ You’re next';
  else if (g.hand.length === 1) youStatus = 'One card!';
  nodes['you-status'].textContent = youStatus;
  nodes['you-status'].hidden = !youStatus;
  nodes['you-status'].className = 'you-status' + (yourTurn ? ' is-acting' : '') + (youAlarm ? ' is-alarm' : '');

  /* --- contextual bars */
  nodes['tondo-bar'].hidden = !g.canDeclareTondo;

  const targets = (g.calloutTargets || []).filter(Boolean);
  const targetKey = targets.join(',');
  const showCallout = targets.length > 0 && app.calloutDismissed !== targetKey;
  nodes['callout-bar'].hidden = !showCallout;
  if (showCallout) {
    const who = targets.map((id) => nicely(playerName(id))).join(' and ');
    nodes['callout-head'].textContent = `${who} forgot TONDO — call them out`;
    nodes['callout-sub'].textContent = 'One card left and never said it. Catching them costs them +2.';
    nodes['callout-buttons'].innerHTML = targets.map((id) =>
      `<button type="button" class="btn btn-cta" data-callout="${esc(id)}">Call out ${esc(nicely(playerName(id)))}</button>`
    ).join('') + '<button type="button" class="btn btn-quiet" data-callout-skip="1">Let it pass</button>';
    nodes['callout-buttons'].querySelectorAll('[data-callout]').forEach((btn) => {
      btn.addEventListener('click', () => send({ type: 'callout', targetId: btn.dataset.callout }));
    });
    const skip = nodes['callout-buttons'].querySelector('[data-callout-skip]');
    if (skip) skip.addEventListener('click', () => { app.calloutDismissed = targetKey; renderGame(app.snap); });
  }

  const drawnCard = drawnId ? g.hand.find((c) => c.id === drawnId) : null;
  nodes['drawn-bar'].hidden = !drawnCard;
  if (drawnCard) {
    const col = isWild(drawnCard) ? BONE : SUITS[drawnCard.suit].c;
    nodes['drawn-card'].style.background = cardBackground(col);
    paintFace(drawnCard, {
      index: nodes['drawn-index'], glyph: nodes['drawn-glyph'], suit: nodes['drawn-suit'],
    }, { narrow: true, glyphSize: 28, boxW: 62 });
    nodes['drawn-msg'].textContent =
      `You drew ${prettyCard(drawnCard)} — play it, or keep it and pass.`;
  }

  nodes['wild-bar'].hidden = !wildOpen;
  if (wildOpen) {
    applyMark(nodes['wild-corner'], 'wild', 13, null);
    applyMark(nodes['wild-centre'], 'wild', 24, null);
    if (!nodes['wild-grid'].childElementCount) {
      nodes['wild-grid'].innerHTML = SUIT_KEYS.map((k) =>
        `<button type="button" class="btn" data-suit="${k}" style="background:${SUITS[k].c}"
           aria-label="Make the next topping ${SUITS[k].label.toLowerCase()}">${sentence(SUITS[k].label)}</button>`
      ).join('');
      nodes['wild-grid'].querySelectorAll('[data-suit]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const cardId = app.pendingWild;
          if (!cardId) return;
          app.pendingWild = null;
          send({ type: 'play', cardId, suit: btn.dataset.suit });
          if (app.snap) renderGame(app.snap);
        });
      });
    }
    const first = nodes['wild-grid'].querySelector('button');
    if (first && document.activeElement !== first) first.focus({ preventScroll: true });
  }

  /* --- hand */
  const swapHand = !!drawnCard || wildOpen;
  nodes['hand-wrap'].hidden = swapHand;
  nodes['action-row'].hidden = swapHand;
  if (!swapHand) renderHand(g, yourTurn, playable, drawnId);

  nodes['hand-label'].textContent = wildOpen ? 'Pick a topping'
    : (drawnCard ? 'Draw decision' : 'Your hand');
  let playLabel;
  if (over) playLabel = 'Round over';
  else if (drawnCard) playLabel = 'Drawn card only';
  else if (wildOpen) playLabel = '';
  else if (yourTurn) playLabel = playable.size + (playable.size === 1 ? ' playable' : ' playable');
  else playLabel = 'Wait your turn';
  nodes['playable-label'].textContent = playLabel;
  nodes['playable-label'].className = 'playable-label' +
    (yourTurn && !drawnCard && !wildOpen && !over ? ' is-live' : (drawnCard ? ' is-drawn' : ''));

  /* --- action row */
  nodes['draw-btn'].disabled = !yourTurn || !!drawnCard || wildOpen;
  nodes['draw-btn'].hidden = over;
  nodes['newround-btn'].hidden = !(over && snap.isHost);

  /* --- hint + assertive line */
  let hint;
  if (over) hint = snap.isHost ? 'Round over — deal again when you like.' : 'Round over — waiting for the host.';
  else if (wildOpen) hint = 'Pick a topping to continue.';
  else if (drawnCard) hint = 'Decide on the drawn card.';
  else if (yourTurn) hint = (app.handOverflows && !app.handMoved)
    ? 'Swipe to see the rest of your hand.' : 'Tap a raised card, or draw.';
  else hint = `${nicely(playerName(g.turnPlayerId))} is playing — hands off.`;
  nodes.hint.textContent = hint;

  let alert = '';
  if (g.canDeclareTondo) alert = 'You are down to two cards. Call TONDO before you play.';
  else if (showCallout) alert = `${targets.map((id) => nicely(playerName(id))).join(' and ')} forgot TONDO. Call them out now.`;
  else if (drawnCard) alert = `You drew ${prettyCard(drawnCard)}. Play it, or keep it and pass.`;
  else if (over) alert = g.winnerId === snap.youId ? 'You win the round.' : `${nicely(playerName(g.winnerId))} wins the round.`;
  if (nodes['live-alert'].textContent !== alert) nodes['live-alert'].textContent = alert;

  if (!over && !yourTurn && app.messageTone !== 'bad') setMessage('', 'info');
}

function renderQueue(snap, g, over) {
  const active = g.players.find((p) => p.id === g.turnPlayerId);
  const nextId = nextPlayerId(g);
  const next = g.players.find((p) => p.id === nextId);
  const colorOf = (id) => {
    const i = g.players.findIndex((p) => p.id === id);
    const y = g.players.findIndex((p) => p.id === snap.youId);
    if (i < 0) return SEAT_COLORS[0];
    return SEAT_COLORS[(((i - y) % g.players.length) + g.players.length) % g.players.length];
  };
  let verb;
  if (over) verb = (g.winnerId === snap.youId ? 'You win!' : nicely(playerName(g.winnerId)) + ' wins!');
  else if (g.turnPlayerId === snap.youId) verb = 'Your turn!';
  else verb = nicely(active ? active.name : '') + ' is playing…';
  const leadId = over ? g.winnerId : g.turnPlayerId;
  const lead = colorOf(leadId);
  let html = `<span class="chip" style="background:${lead}">
      <span class="dot" style="background:rgba(13,15,26,.72)"></span>
      <span class="txt" style="color:#0d0f1a">${esc(verb)}</span></span>`;
  if (!over && next) {
    html += `<span class="chip chip-next">
      <span class="dot" style="background:${colorOf(next.id)}"></span>
      <span class="txt">then ${esc(next.id === snap.youId ? 'you' : nicely(next.name))}</span></span>`;
  }
  nodes.queue.innerHTML = html;
}

function renderCenter(g) {
  const aSuit = activeSuitOf(g);
  const tc = SUITS[aSuit].c;
  const top = g.topCard || { value: '0', suit: aSuit };
  const wildTop = isWild(top);

  nodes.ring.style.setProperty('--ring-line', mix(tc, 26, 'transparent'));
  nodes.ring.style.setProperty('--ring-fill', mix(tc, 12, 'transparent'));
  nodes.plaque.style.setProperty('--suit-color', tc);
  nodes['match-label'].textContent = wildTop ? 'Current topping' : 'Match';
  nodes['match-glyph'].textContent = SUITS[aSuit].glyph;
  nodes['match-suit'].textContent = sentence(SUITS[aSuit].label);
  nodes['match-or-wrap'].hidden = wildTop;
  nodes['match-value'].textContent = wildTop ? '' : sentence(matchValueText(g));
  nodes['dir-badge'].textContent = g.direction === 1 ? '↻' : '↺';
  nodes['dir-glyph'].textContent = g.direction === 1 ? '↻' : '↺';
  nodes['dir-label'].textContent = g.direction === 1 ? 'Clockwise' : 'Counter-clockwise';
  nodes['deck-count'].textContent = g.drawPileCount;

  nodes['top-card'].style.background = cardBackground(tc);
  paintFace(top, { index: nodes['top-index'], glyph: nodes['top-glyph'], suit: nodes['top-suit'] },
    { narrow: true, glyphSize: 30, boxW: 60 });
  // The design wrote 'WILD → BASIL' here; at this card's width that string is
  // clipped, and the chosen topping is already carried by the plaque above and
  // by the card's own colour, so the face keeps the short word.
  if (wildTop) nodes['top-suit'].textContent = 'WILD';
}

function renderSeats(snap, g, over) {
  const around = seatsAroundYou(g, snap.youId);
  const nextId = over ? '' : nextPlayerId(g);
  let botIndex = 0;
  const botArt = new Map();
  g.players.forEach((p) => { if (p.isBot) botArt.set(p.id, BOT_ART[botIndex++ % BOT_ART.length]); });

  nodes.seats.innerHTML = around.map(({ p, slot, offset }) => {
    const color = SEAT_COLORS[offset % SEAT_COLORS.length];
    const acting = !over && p.id === g.turnPlayerId;
    const isNext = p.id === nextId && !acting;
    const one = p.cardCount === 1;
    const art = p.isBot ? botArt.get(p.id) : HUMAN_ART;
    const pipColor = (acting || one) ? color : mix(color, 44, '#48526f');
    const shown = Math.min(p.cardCount, 7);
    let pips = '';
    for (let k = 0; k < shown; k++) {
      const off = k - (shown - 1) / 2;
      pips += `<span class="pip" style="background:linear-gradient(155deg,${mix(pipColor, 74, 'white')},${mix(pipColor, 88, 'black')});` +
        `transform:rotate(${(off * 5).toFixed(1)}deg) translateY(${Math.abs(off * 1.4).toFixed(1)}px)"></span>`;
    }

    let status = '', stColor = mix(color, 82, 'white'), stBg = 'transparent', loud = false;
    if (over && g.winnerId === p.id) { status = 'wins!'; stColor = '#0d0f1a'; stBg = color; loud = true; }
    else if (p.vulnerable) { status = 'forgot TONDO!'; stColor = '#0d0f1a'; stBg = '#ff2e6b'; loud = true; }
    else if (acting) { status = 'playing…'; stColor = '#0d0f1a'; stBg = color; loud = true; }
    else if (!p.connected) { status = 'away'; }
    else if (isNext) { status = '▸ next'; }
    else if (one) { status = 'one card!'; }
    else if (p.declaredTondo) { status = 'TONDO!'; }
    else status = 'waiting';

    return `<div class="seat seat-${slot} ${acting ? '' : (isNext ? 'is-next' : 'is-idle')}">
      <div class="plate ${acting ? 'is-acting' : ''} ${loud && !acting ? 'is-loud' : ''}">
        <div class="stack ${(acting || one) ? 'is-lit' : ''}">
          <div class="fan">${pips}</div>
          <span class="portrait-sm" style="background-image:url('${art}');border-color:${loud ? color : mix(color, 52, '#2b3454')}"></span>
          <span class="count-badge" style="color:${(acting || one) ? mix(color, 80, 'white') : '#8f9bc4'};border-color:${(acting || one) ? color : '#2b3454'}">${p.cardCount}</span>
        </div>
        <div class="seat-status ${loud ? 'is-loud' : 'is-soft'}" style="background:${loud ? stBg : 'rgba(255,255,255,.07)'}">
          <span class="seat-name" style="color:${loud ? stColor : mix(color, 86, 'white')}">${esc(nicely(p.name))}</span>
          <span class="seat-verb" style="color:${loud ? 'rgba(13,15,26,.72)' : mix(color, 66, 'white')}">${esc(status)}</span>
        </div>
      </div>
    </div>`;
  }).join('');
}

function paintFace(card, target, opts) {
  const o = opts || {};
  const wild = isWild(card);
  const col = wild ? BONE : SUITS[card.suit].c;
  const ink = mix(col, 45, 'black');
  const f = face(card, !!o.narrow);
  const cornerSize = o.cornerSize || 13;

  if (f.cornerIcon) {
    applyMark(target.index, f.cornerIcon, cornerSize, ink);
    target.index.style.opacity = '.95';
  } else {
    clearMark(target.index);
    target.index.style.opacity = '1';
    target.index.textContent = f.corner;
    target.index.style.textShadow = `0 1px 0 ${ink}`;
  }

  if (f.icon) {
    applyMark(target.glyph, f.icon, o.glyphSize || 30, ink);
  } else {
    clearMark(target.glyph);
    target.glyph.textContent = f.centre;
    target.glyph.style.textShadow = `0 3px 0 ${ink}`;
  }

  target.suit.textContent = f.label;
  target.suit.style.fontSize = fitFont(f.label, (o.boxW || 70), o.suitBase || 15) + 'px';
  if (target.ghost) target.ghost.textContent = f.corner;
  return f;
}

function renderHand(g, yourTurn, playable, drawnId) {
  const row = nodes['hand-row'];
  const focusedId = document.activeElement && document.activeElement.dataset
    ? document.activeElement.dataset.card : null;

  row.innerHTML = '';
  const narrow = window.innerWidth < 720;
  g.hand.forEach((c) => {
    const ok = yourTurn && playable.has(c.id) && !drawnId;
    const col = isWild(c) ? BONE : SUITS[c.suit].c;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'card' + (ok ? ' is-playable' : '') + (drawnId ? ' is-dimmed' : '');
    btn.dataset.card = c.id;
    btn.style.background = cardBackground(col);
    btn.disabled = !yourTurn || !!drawnId;
    btn.setAttribute('aria-label', prettyCard(c) +
      (yourTurn ? (playable.has(c.id) ? ' — playable' : ' — does not match') : ' — not your turn'));
    btn.innerHTML = '<div class="card-index"></div><div class="card-glyph"></div>' +
      '<div class="card-suit"></div><div class="card-ghost"></div>' + (ok ? '<div class="card-tick">✓</div>' : '');
    paintFace(c, {
      index: btn.querySelector('.card-index'),
      glyph: btn.querySelector('.card-glyph'),
      suit: btn.querySelector('.card-suit'),
      ghost: btn.querySelector('.card-ghost'),
    }, {
      narrow, glyphSize: narrow ? 26 : 34, cornerSize: narrow ? 11 : 13,
      boxW: (narrow ? 70 : 92) - 20, suitBase: narrow ? 12 : 15,
    });
    if (ok) btn.style.transform = 'translateY(-13px)';
    btn.addEventListener('click', () => tapCard(c));
    btn.addEventListener('mouseenter', () => previewCard(c));
    btn.addEventListener('focus', () => previewCard(c));
    row.appendChild(btn);
  });

  row.classList.toggle('is-locked', !yourTurn);
  if (focusedId) {
    const again = row.querySelector(`[data-card="${CSS.escape(focusedId)}"]`);
    if (again && !again.disabled) again.focus({ preventScroll: true });
  }
  updateFades();
}

function previewCard(c) {
  const s = app.snap;
  if (!s || !s.game || s.game.turnPlayerId !== s.youId || s.phase !== 'playing') return;
  const g = s.game;
  if (g.drawnDecisionCardId) return;
  if ((g.playableCardIds || []).includes(c.id)) setMessage(consequence(g, c), 'good');
  else setMessage(reasonFor(g), 'bad');
}

function tapCard(c) {
  const s = app.snap;
  if (!s || !s.game) return;
  const g = s.game;
  if (s.phase !== 'playing' || g.turnPlayerId !== s.youId || g.drawnDecisionCardId) return;

  if (!(g.playableCardIds || []).includes(c.id)) {
    refuse(c.id);
    setMessage(reasonFor(g), 'bad');
    return;
  }
  if (isWild(c)) {
    app.pendingWild = c.id;
    setMessage('', 'info');
    renderGame(s);
    return;
  }
  send({ type: 'play', cardId: c.id });
}

function refuse(cardId) {
  const btn = nodes['hand-row'].querySelector(`[data-card="${CSS.escape(cardId)}"]`);
  if (btn) {
    btn.classList.remove('refuse');
    void btn.offsetWidth;
    btn.classList.add('refuse');
    setTimeout(() => btn.classList.remove('refuse'), 400);
  }
  nodes.plaque.classList.remove('flash');
  void nodes.plaque.offsetWidth;
  nodes.plaque.classList.add('flash');
  setTimeout(() => nodes.plaque.classList.remove('flash'), 800);
}

function updateFades() {
  const row = nodes['hand-row'];
  const over = row.scrollWidth - row.clientWidth > 4;
  row.classList.toggle('is-overflowing', over);
  nodes['fade-left'].hidden = !(over && row.scrollLeft > 4);
  nodes['fade-right'].hidden = !(over && row.scrollLeft < row.scrollWidth - row.clientWidth - 4);
  // The hint is written before the row can be measured, so it is corrected here
  // rather than costing a second render pass.
  const wasOver = app.handOverflows;
  app.handOverflows = over;
  if (over !== wasOver && nodes.hint.textContent.startsWith('Tap a raised card')) {
    if (over && !app.handMoved) nodes.hint.textContent = 'Swipe to see the rest of your hand.';
  }
}

nodes['hand-row'].addEventListener('scroll', () => { app.handMoved = true; updateFades(); });
window.addEventListener('resize', () => { updateFades(); if (app.snap && app.snap.game) renderGame(app.snap); });

nodes['draw-btn'].addEventListener('click', () => send({ type: 'draw' }));
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
