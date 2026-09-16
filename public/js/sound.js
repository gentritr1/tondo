/**
 * Tondo's voice.
 *
 * Every sound here is SYNTHESISED at runtime from oscillators and noise — there
 * are no audio files. That is a deliberate trade, and the reasoning is worth
 * recording because it is the kind of decision that looks arbitrary later:
 *
 *   - The project has no build step and no asset pipeline. A sampled set means
 *     either a sprite that has to be authored, encoded twice (Safari still
 *     wants a fallback), version-stamped and cache-busted by hand, or a dozen
 *     small files each costing a request. Synthesis costs 0 bytes and 0
 *     requests, and rides the same cache as the JS.
 *   - The palette Tondo needs is small and percussive: card thwacks, a chime, a
 *     whoosh, a couple of stings. That is precisely the range where synthesis
 *     holds up. It would not hold up for music or for a voice, and there is
 *     neither here.
 *
 * The character to aim for is a wooden table in a warm room: short, soft-edged,
 * a little damped. Nothing metallic, nothing arcade. The brand note is
 * "neighbourhood game night", so the loudest thing in the game is a win, and
 * even that is two seconds.
 *
 * Autoplay policy: a browser will not let audio start before a gesture. The
 * context is therefore created lazily on the first real interaction and
 * `resume()`d on every subsequent one, which is what iOS in particular needs
 * after it suspends a context in the background.
 */

const STORE_KEY = 'tondo.sound';

/* Master level. Everything below is written relative to this, so the whole
   game gets quieter or louder in one place. Deliberately low: this is a game
   people open in a room with other people in it. */
const MASTER = 0.34;

let ctx = null;
let master = null;
let muted = false;
let unlocked = false;
/* Sounds are triggered off snapshot deltas, and one snapshot can legitimately
   carry several events (a +2 lands, the turn moves, a hand grows). Firing all
   of them at full level at the same millisecond is what makes a game sound
   cheap, so a short window ducks anything after the first. */
let burstAt = 0;
let burstCount = 0;

try { muted = localStorage.getItem(STORE_KEY) === 'off'; } catch { /* private mode */ }

function ensureContext() {
  if (ctx) return ctx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  master = ctx.createGain();
  master.gain.value = MASTER;
  /* A limiter, not for loudness but for safety: several stings overlapping
     must never clip, and a soft knee keeps the ducking from being audible as
     a pump. */
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.knee.value = 24;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.18;
  master.connect(limiter).connect(ctx.destination);
  return ctx;
}

/** One short burst of white noise, reused by every percussive sound. */
let noiseBuffer = null;
function noise() {
  const c = ensureContext();
  if (!noiseBuffer) {
    const len = Math.floor(c.sampleRate * 0.4);
    noiseBuffer = c.createBuffer(1, len, c.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }
  const src = c.createBufferSource();
  src.buffer = noiseBuffer;
  return src;
}

/**
 * A pitched voice with a percussive envelope.
 * @param {object} o
 * @param {number} o.freq starting frequency in Hz
 * @param {number} [o.to] frequency to glide to (a fall reads as weight)
 * @param {string} [o.type] oscillator type
 * @param {number} [o.gain] peak level, relative to master
 * @param {number} [o.attack] seconds to peak
 * @param {number} [o.decay] seconds to silence
 * @param {number} [o.at] start offset in seconds
 */
function tone({ freq, to, type = 'sine', gain = 0.3, attack = 0.006, decay = 0.18, at = 0 }) {
  const c = ensureContext();
  if (!c) return;
  const t = c.currentTime + at;
  const osc = c.createOscillator();
  const amp = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to && to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(to, 1), t + decay);
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(Math.max(gain, 0.0001), t + attack);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  osc.connect(amp).connect(master);
  osc.start(t);
  osc.stop(t + attack + decay + 0.02);
}

/**
 * Filtered noise — the body of every card sound. A card on felt is broadband
 * and short; the bandpass is what stops it sounding like static.
 */
function thwack({ freq = 1500, q = 1.1, gain = 0.3, decay = 0.09, at = 0, sweepTo = null, type = 'bandpass' }) {
  const c = ensureContext();
  if (!c) return;
  const t = c.currentTime + at;
  const src = noise();
  const filter = c.createBiquadFilter();
  const amp = c.createGain();
  filter.type = type;
  filter.frequency.setValueAtTime(freq, t);
  if (sweepTo) filter.frequency.exponentialRampToValueAtTime(Math.max(sweepTo, 20), t + decay);
  filter.Q.value = q;
  amp.gain.setValueAtTime(Math.max(gain, 0.0001), t);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  src.connect(filter).connect(amp).connect(master);
  src.start(t);
  src.stop(t + decay + 0.02);
}

/* ------------------------------------------------------------- the palette */

/*
 * Every voice takes `t` — when it should START, in seconds from now — and adds
 * it to each of its own internal offsets. This is not decoration: the card a
 * sound describes is still in the air when the snapshot arrives, so a voice
 * fired immediately lands ~260ms BEFORE the thing it is meant to be the sound
 * of. Sound arriving early is more noticeable than sound arriving late, so
 * these are scheduled against the impact frame — the same delay the ledger's
 * topping drop already uses (app.js:518).
 *
 * `me` is loudness: how much this event is about the player at this screen.
 * events.js already works out whether a +2 landed on YOU or on someone across
 * the table, and playing both identically throws that away.
 */
const VOICES = {
  /* A card meeting the pile: broadband body, a low thump under it for weight. */
  play(t, me) {
    thwack({ freq: 1750, q: 0.9, gain: me ? 0.36 : 0.3, decay: 0.075, at: t, sweepTo: 700 });
    tone({ freq: 190, to: 96, type: 'triangle', gain: 0.16, decay: 0.1, at: t });
  },
  /* Lighter and duller than a play: a card leaving the deck, not landing. */
  draw(t) {
    thwack({ freq: 1150, q: 0.8, gain: 0.2, decay: 0.06, at: t, sweepTo: 520 });
  },
  /* Seven cards, staggered — the sound of a round starting. */
  deal(t) {
    for (let i = 0; i < 7; i++) {
      thwack({ freq: 1250 + i * 55, q: 0.8, gain: 0.17, decay: 0.055, at: t + i * 0.055, sweepTo: 560 });
    }
  },
  /* Two falling notes: something was taken away from someone. Lower and louder
     when the someone is you. */
  skip(t, me) {
    const k = me ? 0.82 : 1;
    tone({ freq: 620 * k, to: 500 * k, type: 'triangle', gain: me ? 0.26 : 0.2, decay: 0.12, at: t });
    tone({ freq: 415 * k, to: 330 * k, type: 'triangle', gain: me ? 0.24 : 0.18, decay: 0.2, at: t + 0.1 });
  },
  /* The heaviest thing in the game that is not a win: a thud, then two cards.
     Taking one yourself drops the fundamental about a fifth and leans on it. */
  plus2(t, me) {
    tone({ freq: me ? 100 : 150, to: me ? 46 : 62, type: 'square', gain: me ? 0.3 : 0.18, decay: me ? 0.32 : 0.24, at: t });
    thwack({ freq: 900, q: 0.7, gain: me ? 0.3 : 0.22, decay: 0.09, at: t + 0.06, sweepTo: 380 });
    thwack({ freq: 900, q: 0.7, gain: me ? 0.3 : 0.22, decay: 0.09, at: t + 0.19, sweepTo: 380 });
  },
  /* A filter sweep reads as motion, which is exactly what REVERSE is. */
  reverse(t) {
    thwack({ freq: 480, q: 1.4, gain: 0.3, decay: 0.34, at: t, sweepTo: 2600, type: 'bandpass' });
  },
  /* Four notes for four toppings, rising: the one card that opens a choice. */
  wild(t) {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      tone({ freq: f, type: 'sine', gain: 0.19, decay: 0.2, at: t + i * 0.062 });
    });
  },
  /* A call across a room — bright, two notes, unmistakably an announcement. */
  tondo(t) {
    tone({ freq: 784, type: 'sine', gain: 0.26, decay: 0.16, at: t });
    tone({ freq: 1046.5, type: 'sine', gain: 0.24, decay: 0.3, at: t + 0.11 });
  },
  /* Caught. Comic rather than cruel: a wobble, not a buzzer. */
  callout(t, me) {
    tone({ freq: 380, to: 300, type: 'sawtooth', gain: me ? 0.2 : 0.14, decay: 0.13, at: t });
    tone({ freq: 300, to: 236, type: 'sawtooth', gain: me ? 0.19 : 0.13, decay: 0.22, at: t + 0.1 });
    thwack({ freq: 700, q: 0.6, gain: 0.16, decay: 0.11, at: t + 0.05 });
  },
  /* Your turn. The single most repeated sound in the game, so it is the
     quietest and softest thing here — a nudge, not an alert. */
  turn(t) {
    tone({ freq: 880, type: 'sine', gain: 0.14, decay: 0.17, at: t });
  },
  /* The pile being shuffled back: a long, soft riffle. */
  reshuffle(t) {
    for (let i = 0; i < 9; i++) {
      thwack({ freq: 900 + Math.random() * 700, q: 1.5, gain: 0.09, decay: 0.05, at: t + i * 0.035 });
    }
  },
  /* Two seconds, and the loudest thing in the game. */
  win(t) {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      tone({ freq: f, type: 'triangle', gain: 0.26, decay: 0.42, at: t + i * 0.085 });
    });
    tone({ freq: 130.81, type: 'sine', gain: 0.16, decay: 0.9, at: t + 0.02 });
  },
  /* Somebody else won. Warm, not a failure buzz — this is a friendly game. */
  lose(t) {
    tone({ freq: 392, to: 330, type: 'triangle', gain: 0.17, decay: 0.3, at: t });
    tone({ freq: 261.63, type: 'sine', gain: 0.13, decay: 0.5, at: t + 0.14 });
  },
};

/* ------------------------------------------------------------------ public */

/**
 * Creates or resumes the audio context. Must be called from a real user
 * gesture; calling it more often than necessary is harmless and is in fact the
 * point — iOS suspends the context when the tab goes away, and the next tap is
 * the only thing allowed to bring it back.
 */
export function unlock() {
  const c = ensureContext();
  if (!c) return;
  unlocked = true;
  if (c.state === 'suspended') c.resume().catch(() => { /* still no gesture */ });
}

/**
 * Plays a named voice.
 * @param {string} name a key of VOICES; unknown names are ignored, not thrown
 * @param {number} [at] seconds from now to start it — use the moment the thing
 *   being described actually happens on screen, not the moment the snapshot
 *   arrived
 * @param {boolean} [me] true when this event happened to (or was done by) the
 *   player at this screen
 */
export function play(name, at = 0, me = false) {
  if (muted || !unlocked || !VOICES[name]) return;
  // A tab the player cannot see must not make noise at them.
  if (typeof document !== 'undefined' && document.hidden) return;
  const c = ensureContext();
  if (!c || c.state !== 'running') return;

  const now = c.currentTime;
  if (now - burstAt > 0.12) { burstAt = now; burstCount = 0; }
  burstCount++;
  // The third and later sound in one burst is dropped entirely rather than
  // played quietly: a smear of half-heard sounds reads worse than silence.
  if (burstCount > 2) return;
  const duck = burstCount === 1 ? 1 : 0.55;

  const before = master.gain.value;
  master.gain.setValueAtTime(MASTER * duck, now);
  try { VOICES[name](Math.max(at, 0), Boolean(me)); }
  catch { /* a dead context must never break a repaint */ }
  master.gain.setValueAtTime(before, now + 0.001);
}

export function isMuted() { return muted; }

/** @param {boolean} value @returns {boolean} the new muted state */
export function setMuted(value) {
  muted = Boolean(value);
  try { localStorage.setItem(STORE_KEY, muted ? 'off' : 'on'); } catch { /* private mode */ }
  if (!muted) unlock();
  return muted;
}

export function toggleMuted() { return setMuted(!muted); }

/**
 * Maps the events derived in events.js onto voices.
 *
 * Two rules shape this and are easy to get wrong later:
 *  1. Only ONE voice per snapshot, chosen by priority. A snapshot carrying a
 *     +2 also carries a play, a draw and a turn change; playing all four is
 *     the noise that makes people mute a game.
 *  2. `turn` only speaks when the turn becomes YOURS. Announcing every seat
 *     change means a sound every two seconds, forever.
 */
export function playForEvents(events, { impactAt = 0 } = {}) {
  if (!events || !events.length || muted) return null;
  const has = (t) => events.find((e) => e.type === t);

  // A win or a deal has no card in flight to wait for.
  const win = has('win');
  if (win) { play(win.youWon ? 'win' : 'lose', 0, true); return win.youWon ? 'win' : 'lose'; }
  if (has('deal')) { play('deal'); return 'deal'; }

  // Loudest consequence first: what happened TO someone outranks what was
  // played, and what was played outranks whose turn it now is.
  const consequences = [
    ['callout', (e) => e.youCaught],
    ['plus2', (e) => e.youHit],
    ['skip', (e) => e.youSkipped],
    ['reverse', () => false],
    ['wild', (e) => e.byYou],
    ['tondo', (e) => e.byYou],
  ];
  for (const [name, isMine] of consequences) {
    const e = has(name);
    if (e) { play(name, impactAt, isMine(e)); return name; }
  }
  const played = has('play');
  if (played) { play('play', impactAt, played.byYou); return 'play'; }
  if (has('draw')) { play('draw'); return 'draw'; }
  if (has('reshuffle')) { play('reshuffle'); return 'reshuffle'; }
  const turn = has('turn');
  if (turn && turn.yours) { play('turn', impactAt); return 'turn'; }
  return null;
}

export const __test = { VOICES, MASTER };
