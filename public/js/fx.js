/**
 * One-shot effects for what just happened at the table.
 *
 * events.js decides WHAT happened; this module decides what the table SHOWS
 * for it. Every effect is fired imperatively at a node that exists right now —
 * never a class written into render output, which replays on every repaint.
 * Effects describing a played card start at the impact frame (`impactAt`),
 * the same moment the sound and the ledger topping land.
 *
 * Priority mirrors sound.js: what happened TO someone owns the frame.
 */

export const CONSEQUENCES = new Set(['skip', 'plus2', 'callout']);

let d = null;

/** Wires the app's helpers in, so this module never imports app.js. */
export function init(deps) { d = deps; }

const later = (seconds, fn) => setTimeout(fn, Math.max(0, seconds * 1000));

/*
 * The skip duck: a small lift, then the seat sinks and greys out for a beat
 * before it comes back. Percentages of the seat's own box, not pixels — 11.4%
 * is the measured 9px on a 78.7px plate, so it reads the same at every table
 * size. Each keyframe's `easing` runs from that keyframe to the next, exactly
 * like `animation-timing-function` inside a CSS keyframe.
 *
 * WAAPI with `composite: 'add'`, not a class. A class that sets `animation` on
 * the plate REPLACES what the plate is already running: a vulnerable seat's
 * plate carries `.is-loud` (its alarm pop), and when the duck's class came off
 * the plate fell back to that animation and replayed it. Added on top, the duck
 * composes with whatever the seat is doing and leaves its classes alone.
 */
const DUCK_FRAMES = [
  { offset: 0, transform: 'translateY(0) scale(1)', filter: 'saturate(1)' },
  { offset: .18, transform: 'translateY(-5.1%) scale(1.02)', easing: 'cubic-bezier(.33,0,.67,1)' },
  { offset: .55, transform: 'translateY(11.4%) scale(.90)', filter: 'saturate(.45)', easing: 'cubic-bezier(.34,1.56,.64,1)' },
  { offset: 1, transform: 'translateY(0) scale(1)', filter: 'saturate(1)' },
];
const DUCK_MS = 380;
const ducks = new WeakMap();

/** The box a seat's own motion rides: your tile in the tray, or a seat's plate. */
function seatBox(playerId) {
  return playerId === d.youId() ? document.querySelector('.you-seat') : d.seatPlate(playerId);
}

function duck(playerId) {
  const target = seatBox(playerId);
  if (!target) return;
  const running = ducks.get(target);
  if (running) running.cancel();   // a second skip restarts the duck cleanly
  ducks.set(target, target.animate(DUCK_FRAMES, {
    duration: DUCK_MS, easing: 'linear', composite: 'add', id: 'seat-skipped',
  }));
}

function sweep(direction) {
  const layer = document.querySelector('.dir-sweep');
  if (!layer) return;
  layer.classList.remove('is-cw', 'is-ccw');
  d.pulse(layer, direction === 1 ? 'is-cw' : 'is-ccw', 620);
}

/*
 * The Wild wash. A Wild is the one card whose topping is CHOSEN, and the old
 * flourish pulsed the resting tint layer — which sits at 10% alpha so the
 * table stays calm, and at 10% the motion audit found nobody sees it. The wash is
 * its own layer at its own alpha (the chosen suit's light colour at 34%, from
 * the `washColor` dep), so the moment can be seen without making the resting
 * tint louder. It fires on every Wild, including one played into the suit that
 * was already active: the choice happened either way.
 * Kept in step with `.sauce-wash.is-washing` (520ms) in styles.css.
 */
const WASH_MS = 520;

function wash(suit) {
  const layer = document.querySelector('.sauce-wash');
  const fill = d.washColor(suit);
  if (!layer || !fill) return;
  // Colour and pulse in the same moment, so a wash never starts in the
  // previous Wild's colour.
  layer.style.setProperty('--wash-fill', fill);
  d.pulse(layer, 'is-washing', WASH_MS);
}

/*
 * The TONDO stamp: a wind-up (squash and a counter-lean), then the seat slams
 * big and settles, and a gold ring shouts outward once. Classes, not WAAPI,
 * because a declaring seat is never running the alarm: TONDO is only legal on
 * exactly two cards (server/game.js declareTondo), and the alarm needs one. The
 * plate keeps `is-tondo` across repaints through PLATE_ONE_SHOTS in app.js.
 * Kept in step with `tondo-stamp` (440ms) in styles.css; the ring is 420ms.
 */
const STAMP_MS = 440;

function stamp(playerId) {
  const target = seatBox(playerId);
  if (target) d.pulse(target, 'is-tondo', STAMP_MS);
}

/*
 * The callout lunge: the caller's seat leans 14px toward the seat it caught —
 * out in 240ms, back in 320ms — and the two penalty cards are thrown from the
 * caller's seat (app.js runTravel). 14px is absolute, not a fraction of the
 * seat: it is a lean, and a lean the size of the seat reads as a jump.
 *
 * WAAPI with `composite: 'add'`, for the same reason as the duck: the caller's
 * plate can be running something of its own (its turn pop, a duck), and a
 * class would replace that animation instead of composing with it. The id is
 * what probes count it by — the duck is also a script animation on a plate.
 */
const LUNGE_PX = 14;
const LUNGE_OUT_MS = 240;
const LUNGE_MS = 560;
const lunges = new WeakMap();

function lunge(callerId, targetId) {
  const from = seatBox(callerId);
  const to = seatBox(targetId);
  if (!from || !to) return;
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const vx = (b.left + b.width / 2) - (a.left + a.width / 2);
  const vy = (b.top + b.height / 2) - (a.top + a.height / 2);
  const len = Math.hypot(vx, vy);
  if (!len) return;
  const dx = (vx / len) * LUNGE_PX;
  const dy = (vy / len) * LUNGE_PX;
  const running = lunges.get(from);
  if (running) running.cancel();
  lunges.set(from, from.animate([
    { offset: 0, transform: 'translate(0px, 0px)', easing: 'cubic-bezier(.33,0,.67,1)' },
    { offset: LUNGE_OUT_MS / LUNGE_MS, transform: `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)`, easing: 'cubic-bezier(.16,1,.3,1)' },
    { offset: 1, transform: 'translate(0px, 0px)' },
  ], { duration: LUNGE_MS, easing: 'linear', composite: 'add', id: 'callout-lunge' }));
}

/**
 * The live region keeps only its last line, and applySnapshot writes "Your
 * turn" into it just before fx runs. An announcement from the same snapshot
 * would overwrite that, so when this snapshot hands you the turn both facts go
 * in the one line.
 */
function withYourTurn(text, events) {
  const yours = events.find((t) => t.type === 'turn' && t.yours);
  return yours ? `${text} Your turn, ${yours.playable} playable.` : text;
}

/**
 * @param {Array<object>} events output of deriveEvents(prev, snap)
 * @param {{impactAt?: number}} [opts] seconds until the played card lands
 * @returns {string[]} the effects fired, in order
 */
export function playForEvents(events, { impactAt = 0 } = {}) {
  if (!d || !events || !events.length) return [];
  const fired = [];
  for (const e of events) {
    if (e.type === 'skip') {
      d.setSeatNote(e.victimId, 'skipped', 1200);
      if (e.youSkipped) d.announce('You were skipped.');
      if (!d.RM.matches) later(impactAt, () => duck(e.victimId));
      fired.push('skip');
    } else if (e.type === 'plus2') {
      d.setSeatNote(e.victimId, '+2', 1200);
      if (e.youHit) d.announce('You draw two.');
      fired.push('plus2'); // the lob and badge punch ride the deal ghosts in app.js
    } else if (e.type === 'reverse') {
      if (!d.RM.matches) later(impactAt, () => sweep(e.direction));
      // Announced NOW, in the snapshot's own task: the repaint has already run,
      // so the label says the new direction. Deferring it overwrote the
      // snapshot's "Your turn" line one tick later, and the live region only
      // keeps its last text — so when the reversal hands you the turn, both
      // facts go in one line.
      const label = ((d.nodes['dir-label'] && d.nodes['dir-label'].textContent) || '').toLowerCase()
        || (e.direction === 1 ? 'clockwise' : 'counter-clockwise');
      d.announce(withYourTurn(`Play order reversed — now ${label}.`, events));
      fired.push('reverse');
    } else if (e.type === 'wild') {
      // Movement only: the plaque already says the new topping in words, and it
      // pops for a changed suit in app.js. Reduced motion silences the wash in
      // styles.css.
      later(impactAt, () => wash(e.suit));
      fired.push('wild');
    } else if (e.type === 'tondo') {
      d.setSeatNote(e.playerId, 'TONDO!', 1200);
      if (!e.byYou) {
        d.announce(withYourTurn(`${d.playerName(e.playerId) || 'A player'} called TONDO.`, events));
      }
      // Reduced motion silences the stamp and its ring in styles.css; the note
      // and the announcement carry the moment.
      later(impactAt, () => stamp(e.playerId));
      fired.push('tondo');
    } else if (e.type === 'callout') {
      // The caller is read from the server's log line and can be unknown (null):
      // then there is nobody to lunge or to throw from, and the words say the
      // rest.
      if (e.callerId) d.setSeatNote(e.callerId, 'caught them!', 1200);
      d.setSeatNote(e.targetId, '+2', 1200);
      if (e.youCaught) d.announce(withYourTurn('Caught! You forgot TONDO — draw two.', events));
      if (e.callerId && !d.RM.matches) later(impactAt, () => lunge(e.callerId, e.targetId));
      fired.push('callout'); // the thrown cards and the badge punch ride the deal ghosts in app.js
    }
  }
  return fired;
}
