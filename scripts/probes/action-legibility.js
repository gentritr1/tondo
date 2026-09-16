(async () => {
  // Watches what ONE scripted event animates, over the full impact window.
  // Counts both CSS animations (by name) and WAAPI ghosts appended to <body>.
  const watch = async (kind, opts) => {
    const names = new Set();
    let ghosts = 0;
    const onStart = (e) => names.add(e.animationName);
    document.addEventListener('animationstart', onStart, true);
    const mo = new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) if (n.classList && n.classList.contains('travel-back')) ghosts++;
    });
    mo.observe(document.body, { childList: true });
    const liveBefore = document.getElementById('live-now').textContent;
    await window.__mock.transition(kind, opts);
    const t0 = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        for (const a of document.getAnimations()) if (a.animationName) names.add(a.animationName);
        if (performance.now() - t0 < 1100) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });
    document.removeEventListener('animationstart', onStart, true);
    mo.disconnect();
    const verbs = [...document.querySelectorAll('.seat-verb')].map((n) => n.textContent);
    return {
      kind, seats: opts.seats, animations: [...names].sort(), ghosts,
      liveNowChanged: document.getElementById('live-now').textContent !== liveBefore,
      seatVerbs: verbs,
    };
  };
  const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const results = [];
  for (const kind of ['number', 'skip', 'plus2', 'reverse']) {
    results.push(await watch(kind, { seats: 2, victim: 'bot' }));
    await new Promise((r) => setTimeout(r, 1400));
  }
  results.push(await watch('reverse', { seats: 4, victim: 'bot' }));
  const key = (r) => r.animations.join(',') + '|g' + r.ghosts;
  const number = results[0];
  const verdicts = results.slice(1).map((r) => ({
    kind: r.kind, seats: r.seats,
    differsFromNumber: key(r) !== key(number),
    hasDuck: r.animations.includes('seat-skipped'),
    hasSweep: r.animations.some((n) => n.startsWith('dir-sweep')),
    hasBadge: r.animations.includes('badge-punch'),
    wordsChanged: r.liveNowChanged || r.seatVerbs.some((v) => v === 'skipped' || v === '+2'),
  }));
  const observed = results.reduce((n, r) => n + r.animations.length, 0);
  return JSON.stringify({ reducedMotion: rm, observedAnimationNames: observed, valid: observed > 0, results, verdicts }, null, 1);
})()
