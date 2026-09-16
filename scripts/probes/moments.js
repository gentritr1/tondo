(async () => {
  // Watches what ONE scripted Wild, TONDO or callout does — and only that.
  //
  // Sealed the same way as action-legibility.js:
  //  1. every watch is PRIMED with an unobserved `number` transition at the same
  //     table size and victim, so each BEFORE replaces the same state;
  //  2. nothing counts until the watched AFTER snapshot has been DELIVERED, read
  //     from a marker only that AFTER carries (the BEFORE's Basil 7 must be seen
  //     first), and an animation counts only if it STARTED on or after that frame.
  // Delivery markers, all written by the app's pre-existing render path:
  //  - wild:    the top card's label becomes "Wild";
  //  - tondo:   the rendered log line (#live-polite) says "declared TONDO";
  //  - callout: the rendered log line says "called out".
  // `valid` needs every watch delivered, frames sampled, and a Wild's own landing
  // animated on #top-card. It never looks at the effects under test, so a RED run
  // on the old UI is as valid as a GREEN one; the effects are in `checks`.
  // The lunge is counted ONLY by its WAAPI id 'callout-lunge' — the skip duck
  // ('seat-skipped') is also a non-CSS animation on .plate / .you-seat.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const m = window.__mock;
  const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const top = document.getElementById('top-card');
  const polite = document.getElementById('live-polite');
  const liveNow = document.getElementById('live-now');
  const label = () => top.getAttribute('aria-label') || '';
  const nameOf = (a) => a.animationName || a.id || '';
  const seatBox = (id) => (id === 'p1' ? document.querySelector('.you-seat')
    : document.querySelector(`.seat[data-player="${id}"] .plate`));
  // Where a callout's cards should leave from: your tile, or the caller's stack.
  const sourceBox = (id) => (id === 'p1' ? document.querySelector('.you-seat')
    : document.querySelector(`.seat[data-player="${id}"] .stack`));
  const verbOf = (id) => {
    const n = id === 'p1' ? document.getElementById('you-status')
      : document.querySelector(`.seat[data-player="${id}"] .seat-verb`);
    return n ? n.textContent : '';
  };
  const centre = (r) => [r.left + r.width / 2, r.top + r.height / 2];
  const WASH_EXPECTED = 'rgba(110,158,224,0.34)';   // anchovy #6E9EE0 at .34

  // Mirrors mock.js transition(): at four seats p1 is you, p2 Carmela, p4 Pina.
  const PLAN = [
    { kind: 'wild', victim: 'bot', note: 'you play it, no flight', delivered: () => /Wild$/.test(label()) },
    { kind: 'wild', victim: 'you', note: 'Pina plays it, with a flight', delivered: () => /Wild$/.test(label()) },
    { kind: 'tondo', victim: 'bot', who: 'p2', delivered: () => /declared TONDO/i.test(polite.textContent) },
    { kind: 'tondo', victim: 'you', who: 'p1', delivered: () => /declared TONDO/i.test(polite.textContent) },
    { kind: 'callout', victim: 'bot', caller: 'p1', target: 'p2', delivered: () => /called out/i.test(polite.textContent) },
    { kind: 'callout', victim: 'you', caller: 'p2', target: 'p1', delivered: () => /called out/i.test(polite.textContent) },
  ];

  const watch = async (w) => {
    const opts = { seats: 4, victim: w.victim };
    await m.transition('number', opts);
    await sleep(1400);
    const t0 = performance.now();
    let sawBefore = false, deliveredAt = null, deliveredPerf = null, frames = 0;
    let aim = null;                               // unit vector caller → target at delivery
    const counted = new Map();                    // Animation → record
    const ignored = new Set();
    const notes = new Set();
    const announced = [];
    const ghosts = [];
    let lungeFrames = 0, lungeElsewhereFrames = 0, lungePeakPx = 0, lungeCos = null;
    let ringOpacityMax = null;                    // declarer ::after while .is-tondo is on
    let tondoClassFrames = 0;                     // frames the declarer carried .is-tondo
    const settle = () => {
      if (!sawBefore && /Basil 7$/.test(label())) sawBefore = true;
      if (sawBefore && deliveredAt === null && w.delivered()) {
        deliveredAt = document.timeline.currentTime;
        deliveredPerf = performance.now();
        if (w.kind === 'callout') {
          const a = centre(seatBox(w.caller).getBoundingClientRect());
          const b = centre(seatBox(w.target).getBoundingClientRect());
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          aim = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
        }
      }
    };
    const mo = new MutationObserver((records) => {
      settle();
      for (const r of records) {
        if (r.target === liveNow || liveNow.contains(r.target)) {
          if (deliveredAt !== null) announced.push(liveNow.textContent);
        } else if (r.target === document.body && deliveredAt !== null && w.kind === 'callout') {
          for (const n of r.addedNodes) {
            if (!n.classList || !n.classList.contains('travel-back')) continue;
            const g = centre({ left: parseFloat(n.style.left), top: parseFloat(n.style.top),
              width: parseFloat(n.style.width), height: parseFloat(n.style.height) });
            const s = centre(sourceBox(w.caller).getBoundingClientRect());
            const deck = document.getElementById('deck');
            const d = deck && deck.offsetParent !== null ? centre(deck.getBoundingClientRect()) : centre(top.getBoundingClientRect());
            ghosts.push({ fromCallerPx: Math.round(Math.hypot(g[0] - s[0], g[1] - s[1])),
              fromDeckPx: Math.round(Math.hypot(g[0] - d[0], g[1] - d[1])) });
          }
        }
      }
    });
    mo.observe(top, { attributes: true, attributeFilter: ['aria-label'] });
    mo.observe(polite, { childList: true, characterData: true, subtree: true });
    mo.observe(liveNow, { childList: true, characterData: true, subtree: true });
    mo.observe(document.body, { childList: true });

    const scan = () => {
      frames++;
      if (deliveredAt === null) return;
      for (const a of document.getAnimations()) {
        const n = nameOf(a);
        if (!n) continue;
        if (!(a.startTime === null || a.startTime >= deliveredAt)) {
          if (!counted.has(a)) ignored.add(n);
          continue;
        }
        const t = a.effect && a.effect.target;
        const rec = counted.get(a) || { name: n, target: t, pseudo: (a.effect && a.effect.pseudoElement) || '', startMs: null };
        if (rec.startMs === null && a.startTime !== null) rec.startMs = Math.round(a.startTime - deliveredAt);
        counted.set(a, rec);
        if (n === 'callout-lunge' && a.playState === 'running') {
          if (w.kind === 'callout' && t === seatBox(w.caller)) lungeFrames++;
          else lungeElsewhereFrames++;
        }
      }
      if (w.kind === 'callout') {
        const box = seatBox(w.caller);
        const tf = getComputedStyle(box).transform;
        if (tf && tf !== 'none') {
          const mx = new DOMMatrixReadOnly(tf);
          const px = Math.hypot(mx.e, mx.f);
          if (px > lungePeakPx) {
            lungePeakPx = px;
            lungeCos = aim && px ? (mx.e * aim[0] + mx.f * aim[1]) / px : null;
          }
        }
        for (const [id, want] of [[w.caller, 'caught them!'], [w.target, '+2']]) {
          if (verbOf(id) === want) notes.add(`${id}:${want}`);
        }
      }
      if (w.kind === 'tondo') {
        if (verbOf(w.who) === 'TONDO!') notes.add(`${w.who}:TONDO!`);
        const box = seatBox(w.who);
        if (box.classList.contains('is-tondo')) {
          tondoClassFrames++;
          const o = Number(getComputedStyle(box, '::after').opacity);
          ringOpacityMax = ringOpacityMax === null ? o : Math.max(ringOpacityMax, o);
        }
      }
    };

    await m.transition(w.kind, opts);
    settle();
    const end = performance.now() + 1100;
    await new Promise((resolve) => {
      const tick = () => { scan(); if (performance.now() < end) requestAnimationFrame(tick); else resolve(); };
      requestAnimationFrame(tick);
    });
    mo.disconnect();

    const recs = [...counted.values()];
    const on = (name, node, pseudo = '') => recs.filter((r) => r.name === name && r.target === node && r.pseudo === pseudo);
    const out = {
      kind: w.kind, victim: w.victim,
      deliveredMs: deliveredPerf === null ? null : Math.round(deliveredPerf - t0),
      framesSampled: frames,
      counted: recs.length,
      animations: [...new Set(recs.map((r) => r.name))].sort(),
      ignoredFromBefore: [...ignored].filter((n) => !recs.some((r) => r.name === n)).sort(),
      announced,
    };
    if (w.kind === 'wild') {
      const layer = document.querySelector('.sauce-wash');
      const washes = layer ? on('sauce-wash', layer) : [];
      out.washStarts = washes.length;
      out.washStartMs = washes.length ? washes[0].startMs : null;
      out.washFill = layer ? getComputedStyle(layer).getPropertyValue('--wash-fill').trim() : '(no .sauce-wash layer)';
      out.landingAnimations = recs.filter((r) => r.target === top && /^(top-card-land|rm-fade)$/.test(r.name)).length;
    }
    if (w.kind === 'tondo') {
      const box = seatBox(w.who);
      out.stampStarts = on('tondo-stamp', box).length;
      out.ringStarts = on('tondo-ring-shout', box, '::after').length;
      out.tondoClassFrames = tondoClassFrames;
      out.ringOpacityMaxWhileOn = ringOpacityMax;
      out.notes = [...notes];
    }
    if (w.kind === 'callout') {
      out.lungeStarts = on('callout-lunge', seatBox(w.caller)).length;
      out.lungeFrames = lungeFrames;
      out.lungeElsewhereFrames = lungeElsewhereFrames;
      out.lungePeakPx = Math.round(lungePeakPx * 10) / 10;
      out.lungeCosTowardTarget = lungeCos === null ? null : Math.round(lungeCos * 1000) / 1000;
      out.notes = [...notes];
      out.ghosts = ghosts;
    }
    out.valid = deliveredAt !== null && frames > 30 && (w.kind !== 'wild' || out.landingAnimations > 0);
    return out;
  };

  const results = [];
  for (const w of PLAN) results.push(await watch(w));

  // What each watch should show, under THIS motion preference.
  const checks = results.map((r, i) => {
    const w = PLAN[i];
    const c = { kind: r.kind, victim: r.victim };
    if (r.kind === 'wild') {
      c.wash = { want: !rm, got: r.washStarts > 0 };
      c.washFill = { want: WASH_EXPECTED, got: r.washFill.replace(/\s+/g, '') };
    }
    if (r.kind === 'tondo') {
      c.stamp = { want: !rm, got: r.stampStarts > 0 };
      c.ring = { want: !rm, got: r.ringStarts > 0 };
      // Under reduced motion the ring must not sit there static while the class is
      // on. That is only evidence if the class WAS seen on: a run where fx never
      // added `is-tondo` has nothing to measure, and must fail, not pass.
      if (rm) c.ringHiddenWhileStatic = { want: true, got: r.tondoClassFrames > 0 && r.ringOpacityMaxWhileOn === 0 };
      c.verb = { want: true, got: r.notes.includes(`${w.who}:TONDO!`) };
      c.announcedByName = { want: w.who !== 'p1', got: r.announced.some((t) => /^Carmela called TONDO\./.test(t)) };
    }
    if (r.kind === 'callout') {
      c.lunge = { want: !rm, got: r.lungeFrames > 0 };
      c.lungeOnlyOnCaller = { want: true, got: r.lungeElsewhereFrames === 0 };
      if (!rm) {
        c.lunge14px = { want: true, got: r.lungePeakPx >= 12.5 && r.lungePeakPx <= 14.5 };
        c.lungeTowardTarget = { want: true, got: r.lungeCosTowardTarget !== null && r.lungeCosTowardTarget > 0.98 };
        c.lobFromCaller = { want: true, got: r.ghosts.length > 0 && r.ghosts.every((g) => g.fromCallerPx <= 3) };
      } else {
        c.noGhosts = { want: true, got: r.ghosts.length === 0 };
      }
      c.callerNote = { want: true, got: r.notes.includes(`${w.caller}:caught them!`) };
      c.targetNote = { want: true, got: r.notes.includes(`${w.target}:+2`) };
      c.caughtAnnounced = { want: w.target === 'p1', got: r.announced.some((t) => /^Caught! You forgot TONDO — draw two\./.test(t)) };
    }
    c.pass = Object.values(c).every((v) => typeof v !== 'object' || String(v.want) === String(v.got));
    return c;
  });

  return JSON.stringify({
    reducedMotion: rm,
    watched: results.length,
    delivered: results.filter((r) => r.deliveredMs !== null).length,
    valid: results.every((r) => r.valid),
    pass: checks.every((c) => c.pass),
    checks,
    results,
  }, null, 1);
})()
