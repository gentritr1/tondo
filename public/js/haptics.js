/**
 * A buzz for the player at THIS phone when something happens to THEM.
 *
 * Only you-events: a phone buzzing for another player's turn is how a game gets
 * muted. Pure progressive enhancement — `navigator.vibrate` does not exist in
 * Safari on iOS, so nothing may depend on it. Reduced motion mutes it.
 *
 * It is the one channel that can deliver a consequence to a single player's
 * body without anyone else at the table hearing it, which is exactly why it has
 * to be spent sparingly. Feedback earns its place or it devalues the feedback
 * that matters: a phone that buzzes constantly is a phone whose buzz means
 * nothing, and the two buzzes worth having here are a +2 and a callout landing
 * on you.
 */

const STORE_KEY = 'tondo.haptics';

/**
 * Durations in milliseconds. These are REASONED, NOT MEASURED — nobody has held
 * a phone that ran them, and a headless browser has no motor to feel.
 *
 * The one number with an argument behind it is the 20: many Android phones
 * drive an eccentric-rotating-mass motor that needs roughly 20-30ms just to
 * spin up to a perceptible amplitude, and several vendors clamp or drop very
 * short pulses outright, so a 10ms request is at real risk of being literally
 * imperceptible — a value that looks tuned in the source and does nothing in
 * the hand. 20 is a floor chosen for motor spin-up, not a measurement, and the
 * first person to try this on a real phone should feel free to move it.
 *
 * `caught` is the only pattern with a gap, because it is the only event where
 * somebody at the table did something to you on purpose.
 */
export const PATTERNS = { hit: 35, caught: [30, 60, 30], yourTurn: 20, tap: 20 };

/**
 * How long the screen must have gone untouched before a turn buzz is worth
 * spending. At a four-player table the turn comes round 15-30 times a round; a
 * buzz every time is noise. But the turn buzz does have one genuine use — in a
 * game played around a table you look UP at your friends, and the buzz is what
 * says "you're up" when your eyes are not on the screen. So it fires only in
 * that case. If you are visibly interacting, the screen already told you.
 */
export const IDLE_MS = 4000;

const supported = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
const RM = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
let enabled = true;
try { enabled = localStorage.getItem(STORE_KEY) !== 'off'; } catch { /* private mode */ }

/* -Infinity, not 0: "never touched" is the most idle a document can be, and
   anchoring to 0 would make the first four seconds after load read as a fresh
   interaction — the opposite of the truth. */
let lastPointerAt = -Infinity;
if (typeof document !== 'undefined') {
  /* Capture, so a handler that stops propagation cannot hide the fact that the
     player is touching the screen. Passive: this must never delay a tap. */
  document.addEventListener('pointerdown', () => { lastPointerAt = now(); }, { capture: true, passive: true });
}

function now() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

export function isSupported() { return supported; }
export function isEnabled() { return enabled; }

/** True when the player has not touched the screen inside the idle window. */
export function isIdle() { return now() - lastPointerAt >= IDLE_MS; }

export function setEnabled(value) {
  enabled = Boolean(value);
  try { localStorage.setItem(STORE_KEY, enabled ? 'on' : 'off'); } catch { /* private mode */ }
  return enabled;
}

/* The whole body is guarded, not just the call: `tap()` runs one line before
   `send({type:'play'})`, so anything that can throw in here is something that
   can stop a card being played. A channel that half the devices do not have
   may never be able to break one they all do. */
function buzz(pattern) {
  try {
    if (!supported || !enabled || RM.matches) return false;
    // A phone in a pocket must not buzz at a table it is not watching.
    if (typeof document !== 'undefined' && document.hidden) return false;
    return navigator.vibrate(pattern) !== false;
  } catch { return false; }
}

/**
 * One buzz per snapshot, for the event that happened to you, near the impact
 * frame.
 *
 * "Near", not on: this schedules against a JS timer while sound is scheduled
 * against the audio clock, and the two drift. Haptic perception tolerates far
 * more slop than audio does, so that is an accepted limitation rather than a
 * problem to chase with more machinery.
 *
 * @param {Array} events from events.js
 * @param {object} [o] @param {number} [o.impactAt] seconds until the card lands
 * @returns {string|null} the pattern name fired, or null
 */
export function forEvents(events, { impactAt = 0 } = {}) {
  if (!events || !events.length) return null;
  const find = (t) => events.find((e) => e.type === t);
  const callout = find('callout');
  const plus2 = find('plus2');
  const turn = find('turn');
  let name = null;
  // The same consequence ladder sound.js uses: what happened TO you outranks
  // whose turn it is.
  if (callout && callout.youCaught) name = 'caught';
  else if (plus2 && plus2.youHit) name = 'hit';
  // A consequence lands whether or not you were looking. Whose turn it is only
  // needs a buzz when you were NOT — see IDLE_MS. The gate is read here rather
  // than inside the timer so this function can keep its promise: the name it
  // returns is the pattern that will fire, never one that was quietly dropped
  // a quarter of a second later.
  else if (turn && turn.yours && isIdle()) name = 'yourTurn';
  if (!name) return null;
  setTimeout(() => buzz(PATTERNS[name]), Math.max(0, impactAt * 1000));
  return name;
}

/** Press feedback for an action the player just took. Never gated on idleness
 *  — they are self-evidently touching the screen; that is what a tap is. */
export function tap() { return buzz(PATTERNS.tap); }
