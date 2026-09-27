(async () => {
  // Does the top seat's lowest part clear the MATCH plaque?
  //
  // `.seat-top` is the only orbit seat with no `--min-orbit` floor, so a
  // context bar that compresses the stage can drop its status pill onto the
  // plaque — onto the element that tells the player what they may play, at the
  // moment the game is asking for a decision.
  //
  // Sealed: `valid` says only that the scene really was set up and measured —
  // the plaque and the seat exist, the seat has parts to measure, and every
  // rect is finite. It never reads `gapY`, so the verdict cannot validate
  // itself and a RED run is as valid as a GREEN one. `pass` carries the
  // verdict, and `gapY` is printed beside it so a regression is a number, not
  // a boolean. Measured after every animation is finished and two frames have
  // passed, because a seat mid-transition is not where the seat sits.
  document.getAnimations().forEach((a) => { try { a.finish(); } catch {} });
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const plaqueEl = document.getElementById('plaque');
  const top = document.querySelector('#seats .seat-top');
  const stage = document.getElementById('stage');
  if (!plaqueEl || !top) {
    return JSON.stringify({ valid: false, reason: !plaqueEl ? 'no #plaque in this scene' : 'no .seat-top in this scene' });
  }
  const plaque = plaqueEl.getBoundingClientRect();
  // An empty part list would make Math.max() return -Infinity and every gap
  // read as a pass, so the count is part of `valid`, not an afterthought.
  const parts = [...top.querySelectorAll('.seat-status, .seat-tile, .fan')].map((n) => n.getBoundingClientRect());
  // A hidden seat (`display: none`) still has DOM nodes for querySelectorAll to
  // find, and still returns a rect for each — a zero-size one at (0,0). That
  // used to read as "finite" and pass, the same shape of bug round-boundary.js
  // already guards against with `atRoundOver.seats === SEATS`: a hidden actor
  // means the scene was never set up, not that the geometry is fine. So the
  // premise here is a VISIBLE box, not just a numeric one — every part and the
  // plaque itself must have real area, or `valid` is false, not `pass`.
  const hasArea = (r) => r.width > 0 && r.height > 0;
  const finite = parts.length > 0
    && parts.every((r) => Number.isFinite(r.bottom) && hasArea(r))
    && Number.isFinite(plaque.top) && hasArea(plaque);
  const lowestBottom = finite ? Math.max(...parts.map((r) => r.bottom)) : null;
  const gapY = finite ? Math.round((plaque.top - lowestBottom) * 10) / 10 : null;
  return JSON.stringify({
    viewport: `${innerWidth}x${innerHeight}`,
    stageCompressed: !!stage && stage.classList.contains('is-compressed'),
    parts: parts.length,
    plaqueTop: Math.round(plaque.top * 10) / 10,
    lowestBottom: lowestBottom === null ? null : Math.round(lowestBottom * 10) / 10,
    gapY,
    pass: gapY !== null && gapY > 0,
    valid: finite,
  });
})()
