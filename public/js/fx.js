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

function duck(playerId) {
  const target = playerId === d.youId() ? document.querySelector('.you-seat') : d.seatPlate(playerId);
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
      const yours = events.find((t) => t.type === 'turn' && t.yours);
      d.announce(`Play order reversed — now ${label}.${yours ? ` Your turn, ${yours.playable} playable.` : ''}`);
      fired.push('reverse');
    }
  }
  return fired;
}
