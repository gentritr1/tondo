(async () => {
  // Watches what ONE scripted event does — and only that event.
  //
  // `__mock.transition()` emits a BEFORE snapshot, then the AFTER 120ms later,
  // and the BEFORE replaces whatever the previous watch left behind. Two things
  // keep it out of the numbers:
  //  1. every watch is PRIMED with an unobserved `number` transition at the same
  //     table size, so each BEFORE replaces the same state;
  //  2. nothing is counted until the watched card has LANDED (the top card's
  //     label becomes that card, after the BEFORE's card was seen), and an
  //     animation only counts if it STARTED on or after that frame.
  // `valid` is evidence about the watched events themselves: every watched card
  // must land and its own landing must animate (top-card-land, or rm-fade under
  // reduced motion). Animations the BEFORE started are reported, never counted.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const CARD = { number: 'Basil 3', skip: 'Skip Basil', plus2: '+2 Basil', reverse: 'Reverse Basil' };
  const top = document.getElementById('top-card');
  const liveNow = document.getElementById('live-now');
  const label = () => top.getAttribute('aria-label') || '';
  const nameOf = (a) => a.animationName || a.id || '';

  const watch = async (kind, opts) => {
    await window.__mock.transition('number', opts);
    await sleep(1400);
    const t0 = performance.now();
    let sawBefore = false, landedAt = null;
    const after = new Set(), ignored = new Set();
    const landing = new Set();
    let ghosts = 0;
    const liveTexts = [];
    const notes = new Set();
    const mo = new MutationObserver((records) => {
      // Records arrive in order, so the label change marks the landing before
      // the same task's ghosts and announcements are read.
      for (const m of records) {
        if (m.target === top) {
          if (label().endsWith('Basil 7')) sawBefore = true;
          else if (sawBefore && landedAt === null && label().endsWith(CARD[kind])) landedAt = document.timeline.currentTime;
        } else if (m.target === liveNow || liveNow.contains(m.target)) {
          liveTexts.push([Math.round(performance.now() - t0), liveNow.textContent, landedAt !== null]);
        } else if (landedAt !== null) {
          for (const n of m.addedNodes) if (n.classList && n.classList.contains('travel-back')) ghosts++;
        }
      }
    });
    mo.observe(top, { attributes: true, attributeFilter: ['aria-label'] });
    mo.observe(liveNow, { childList: true, characterData: true, subtree: true });
    mo.observe(document.body, { childList: true });
    const scan = () => {
      for (const a of document.getAnimations()) {
        const n = nameOf(a);
        if (!n) continue;
        if (landedAt !== null && (a.startTime === null || a.startTime >= landedAt)) {
          after.add(n);
          if (a.effect && a.effect.target === top) landing.add(a);
        } else ignored.add(n);
      }
      if (landedAt !== null) {
        for (const v of document.querySelectorAll('.seat-verb, #you-status')) {
          if (v.textContent === 'skipped' || v.textContent === '+2') notes.add((v.id === 'you-status' ? 'you:' : '') + v.textContent);
        }
      }
    };
    await window.__mock.transition(kind, opts);
    const end = performance.now() + 1100;
    await new Promise((resolve) => {
      const tick = () => { scan(); if (performance.now() < end) requestAnimationFrame(tick); else resolve(); };
      requestAnimationFrame(tick);
    });
    mo.disconnect();
    const announced = liveTexts.filter((l) => l[2]).map((l) => l[1]);
    return {
      kind, seats: opts.seats, victim: opts.victim,
      landedMs: landedAt === null ? null : Math.round(landedAt - t0),
      landingAnimations: landing.size,
      animations: [...after].sort(),
      ignoredFromBefore: [...ignored].filter((n) => !after.has(n)).sort(),
      lobGhosts: ghosts,
      notes: [...notes],
      liveNowSequence: liveTexts.map((l) => `${l[0]}ms ${l[1]}`),
      liveNowFinal: liveNow.textContent,
      announcedAfterLanding: announced,
    };
  };

  const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const plan = [
    ['number', 2, 'bot'], ['skip', 2, 'bot'], ['plus2', 2, 'bot'], ['reverse', 2, 'bot'],
    ['reverse', 4, 'bot'], ['reverse', 4, 'you'],
  ];
  const results = [];
  for (const [kind, seats, victim] of plan) results.push(await watch(kind, { seats, victim }));
  const verdicts = results.filter((r) => r.kind !== 'number').map((r) => {
    const v = {
      kind: r.kind, seats: r.seats, victim: r.victim,
      hasDuck: r.animations.includes('seat-skipped'),
      hasSweep: r.animations.some((n) => n.startsWith('dir-sweep')),
      hasBadge: r.animations.includes('badge-punch'),
      wordsChanged: r.notes.length > 0 || r.announcedAfterLanding.some((t) => /skipped|draw two|reversed/i.test(t)),
    };
    // A reversal that hands YOU the turn must keep both facts in the one line
    // the live region ends on.
    if (r.kind === 'reverse' && r.victim === 'you') {
      v.liveNowKeepsReversal = /reversed/i.test(r.liveNowFinal);
      v.liveNowKeepsYourTurn = /your turn/i.test(r.liveNowFinal);
    }
    return v;
  });
  const landed = results.filter((r) => r.landedMs !== null && r.landingAnimations > 0).length;
  return JSON.stringify({
    reducedMotion: rm,
    watched: results.length,
    watchedLandedAndAnimated: landed,
    valid: landed === results.length,
    verdicts,
    results,
  }, null, 1);
})()
