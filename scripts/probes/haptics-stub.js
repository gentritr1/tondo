/**
 * Recording stub for `navigator.vibrate`, installed on the NEW document by
 * `scripts/shoot.js --prelude` — before the first line of app.js runs.
 *
 * What this can and cannot prove, stated here so nobody reads more out of the
 * arrays than is in them:
 *
 *   IT PROVES  the app ASKED for a vibration, with which pattern, and when —
 *              and, just as importantly, that it did NOT ask on the occasions
 *              where a buzz would be wrong.
 *   IT CANNOT  prove that a motor spun, that a human felt anything, or that a
 *              duration is long enough to be perceptible. Headless Chrome has
 *              no motor. Only a phone in a hand can close those.
 *
 * `haptics.js` reads `typeof navigator.vibrate === 'function'` once at module
 * load, so a stub written after navigation would be testing a different
 * program. Hence the prelude.
 *
 * With `novibrate` in the query string the stub does the opposite: it removes
 * the API entirely, which is the only way to reach the iOS branch from a
 * desktop Chrome. That is a SIMULATION of Safari's absence, not a test on
 * Safari.
 */
window.__vibrations = [];
if (!location.search.includes('novibrate')) {
  Object.defineProperty(navigator, 'vibrate', {
    configurable: true,
    value: (p) => { window.__vibrations.push(p); return true; },
  });
} else {
  // Deleting the prototype accessor is not enough on its own if an own
  // property has already been installed, and defining `undefined` is not
  // enough on its own if the prototype still carries it. Both, in that order.
  try { delete Navigator.prototype.vibrate; } catch { /* non-configurable */ }
  Object.defineProperty(navigator, 'vibrate', { configurable: true, value: undefined });
}
