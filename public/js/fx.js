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

function duck(playerId) {
  const target = playerId === d.youId() ? document.querySelector('.you-seat') : d.seatPlate(playerId);
  if (target) d.pulse(target, 'is-skipped', 380);
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
      // Read after the repaint, so the words match what the badge now says.
      later(0, () => {
        const label = (d.nodes['dir-label'] && d.nodes['dir-label'].textContent || '').toLowerCase();
        d.announce(`Play order reversed — now ${label || (e.direction === 1 ? 'clockwise' : 'counter-clockwise')}.`);
      });
      fired.push('reverse');
    }
  }
  return fired;
}
