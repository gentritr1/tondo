(async () => {
  // A vulnerable seat that gets skipped keeps its alarm.
  //
  // Two seats; Carmela (p2) is on one card and forgot TONDO; you play SKIP from
  // your hand (so a real flight is in the air). The alarm outranks the "skipped"
  // note, so through the whole note window:
  //  - the seat verb stays "forgot TONDO!",
  //  - the plate never drops `is-loud`, so its alarm pop (tondo-pop) and ring
  //    (tondo-ring-pulse) never start again,
  //  - and the duck still starts on that plate (under reduced motion it must NOT
  //    start: fx.js keeps the words and drops the movement).
  // Built from hand-written snapshots pushed through the mock socket, so the real
  // render path runs. `valid` needs the SKIP to land AND frames to be sampled.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const m = window.__mock;
  await m.transition('number', { seats: 2 });   // a known two-seat table
  await sleep(1400);
  const seatOf = (id) => m.table.seats.find((s) => s.id === id);
  const player = (id, over) => Object.assign({
    id, name: seatOf(id).name, isBot: seatOf(id).isBot, connected: true,
    cardCount: 5, declaredTondo: false, vulnerable: false,
  }, over || {});
  const card = (id, suit, value) => ({ id, suit, value });
  const hand = [card('vs-skip', 'basil', 'SKIP'), card('vs-2', 'cheese', '2'), card('vs-3', 'anchovy', '9'),
    card('vs-4', 'basil', '6'), card('vs-5', 'pepperoni', '1')];
  const game = (over) => Object.assign({
    direction: 1, activeSuit: 'basil', topCard: card('vs-top', 'basil', '7'), drawPileCount: 30,
    turnPlayerId: 'p1', winnerId: null,
    players: [player('p1', { cardCount: 5 }), player('p2', { cardCount: 1, vulnerable: true })],
    hand: hand.slice(), playableCardIds: ['vs-skip'], drawnDecisionCardId: null,
    canDeclareTondo: false, calloutTargets: ['p2'], log: ['CARMELA HAS ONE CARD AND SAID NOTHING'],
  }, over || {});

  // BEFORE: settle long enough that the alarm's own first pop is long over.
  m.table.game = game();
  m.emit(m.snapshot());
  await sleep(1000);

  const plate = document.querySelector('.seat[data-player="p2"] .plate');
  const verb = document.querySelector('.seat[data-player="p2"] .seat-verb');
  const topCard = document.getElementById('top-card');
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const classes = [[0, plate.className]];
  const starts = [];
  const verbs = new Set([verb.textContent]);
  let duckAt = null, landedAt = null, frames = 0;
  const mo = new MutationObserver(() => {
    if (plate.className !== classes[classes.length - 1][1]) classes.push([ms(), plate.className]);
  });
  mo.observe(plate, { attributes: true, attributeFilter: ['class'] });
  const onStart = (e) => { if (plate.contains(e.target)) starts.push([ms(), e.animationName + (e.pseudoElement || '')]); };
  document.addEventListener('animationstart', onStart, true);

  // AFTER: your SKIP lands; at two seats the turn comes straight back to you,
  // and Carmela is still on one card and still vulnerable.
  m.table.game = game({
    topCard: card('vs-skip', 'basil', 'SKIP'),
    players: [player('p1', { cardCount: 4 }), player('p2', { cardCount: 1, vulnerable: true })],
    hand: hand.slice(1), playableCardIds: ['vs-4'],
    log: ['CARMELA HAS ONE CARD AND SAID NOTHING', 'YOU PLAYED SKIP BASIL'],
  });
  m.emit(m.snapshot());
  if (/Skip Basil$/.test(topCard.getAttribute('aria-label') || '')) landedAt = ms();

  const end = performance.now() + 1700;   // past the 1200ms note and its repaint
  await new Promise((resolve) => {
    const tick = () => {
      frames++;
      verbs.add(verb.textContent);
      if (landedAt === null && /Skip Basil$/.test(topCard.getAttribute('aria-label') || '')) landedAt = ms();
      if (duckAt === null && plate.getAnimations().some((a) => (a.animationName || a.id) === 'seat-skipped')) duckAt = ms();
      if (performance.now() < end) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
  mo.disconnect();
  document.removeEventListener('animationstart', onStart, true);

  const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const alarmRestarts = starts.filter((s) => /^tondo-(pop|ring-pulse)/.test(s[1]));
  const verdict = {
    verbStaysAlarm: verbs.size === 1 && verbs.has('forgot TONDO!'),
    plateStaysLoud: classes.every((c) => /\bis-loud\b/.test(c[1])),
    noAlarmRestart: alarmRestarts.length === 0,
    duckAsExpected: rm ? duckAt === null : duckAt !== null,
  };
  return JSON.stringify({
    reducedMotion: rm,
    valid: landedAt !== null && frames > 30,
    landedAtMs: landedAt, framesSampled: frames,
    pass: Object.values(verdict).every(Boolean),
    verdict,
    duckStartedAtMs: duckAt,
    plateClassSequence: classes.map((c) => `${c[0]}ms "${c[1]}"`),
    animationStartsOnPlate: starts.map((s) => `${s[0]}ms ${s[1]}`),
    verbsSeen: [...verbs],
  }, null, 1);
})()
