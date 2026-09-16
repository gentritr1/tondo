(async () => {
  // The round boundary, on the scripted mock table (`--scene mock:roundOver`):
  // a full table's round-over banner, the next deal going around the table, the
  // finished pie being swept off the board, and the YOUR TURN banner.
  //
  // Sealed, per the house rules for probes:
  //  - PRIMED: three scripted plays put toppings on the pie before anything is
  //    watched, and every animation is finished at round over, so nothing that
  //    started earlier can be counted.
  //  - Counted only from the watched step: ghosts are the `.travel-back` nodes
  //    ADDED after the observer starts, and the sweep is counted by its own WAAPI
  //    id ('ledger-sweep') on the toppings that were on the pie before the deal —
  //    never "any non-CSS animation on a .tp", which any future topping effect
  //    would satisfy.
  //  - `valid` reads only the watched steps' own signals: the WIN banner and the
  //    Next slice button were on screen at round over, toppings were on the pie,
  //    the deal snapshot was delivered (the scoreboard left, the yourTurn hand is
  //    rendered, the banner says YOUR TURN) and frames were sampled. It never
  //    looks at the effects under test, so a RED run on the old UI is as valid
  //    as a GREEN one; the verdicts are in `checks`, each beside its count.
  //
  // `atRoundOver` keeps the { bannerVisible, overlaps } shape Task 11 reads.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const m = window.__mock;
  const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (id) => document.getElementById(id);
  const shown = (el) => !!el && !el.hidden && getComputedStyle(el).display !== 'none';
  const intersects = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
  // `want` names the banner this step is supposed to show, so a leftover banner
  // of the other kind cannot stand in for it.
  const bannerOverlaps = (want) => {
    const banner = $('banner');
    if (!shown(banner) || !want(banner)) return { bannerVisible: false, overlaps: [] };
    const br = banner.getBoundingClientRect();
    const overlaps = [...document.querySelectorAll('#seats .seat')]
      .filter((s) => intersects(br, s.getBoundingClientRect()))
      .map((s) => s.dataset.player);
    return { bannerVisible: true, overlaps };
  };
  const centre = (r) => [r.left + r.width / 2, r.top + r.height / 2];
  // WAAPI only: a card's own CSS transitions (the playable lift) carry no delay.
  const scripted = (a) => !a.transitionProperty && !a.animationName;

  // 0. Prime: toppings on the pie, so the exit sweep has something to move.
  for (let k = 0; k < 3; k++) {
    await m.transition('number', { seats: 4 });
    await sleep(700);
  }

  // 1. Round over with a full table: does the win banner cover a seat?
  m.goto('roundOver');
  await sleep(700);
  document.getAnimations().forEach((a) => { try { a.finish(); } catch {} });
  const roundOverShown = shown($('banner')) && $('banner').classList.contains('win') && shown($('newround-btn'));
  const atRoundOver = bannerOverlaps((b) => b.classList.contains('win'));

  // 2. The next deal. Mirrors mock.js yourTurn: players p1 (you), p2, p3, p4,
  //    opener p1 — so the deal starts at p2 and ends on you.
  const EXPECTED_ORDER = ['p2', 'p3', 'p4', 'p1'];
  const PER_SEAT = 4;
  const ghosts = [];
  const mo = new MutationObserver((muts) => {
    for (const mu of muts) for (const n of mu.addedNodes) {
      if (!n.classList || !n.classList.contains('travel-back')) continue;
      const anim = n.getAnimations().find(scripted) || null;
      ghosts.push({ node: n, anim, delay: anim ? anim.effect.getTiming().delay : null, aim: null });
    }
  });
  mo.observe(document.body, { childList: true });
  const sauce = document.querySelector('.sauce');
  const sauceNow = () => { const b = sauce.getBoundingClientRect(); return { cx: b.left + b.width / 2, cy: b.top + b.height / 2, R: b.width / 2 }; };
  const before = [...document.querySelectorAll('#ledger .tp')];
  const toppingsBefore = before.length;
  const s0 = sauceNow();
  const startRatio = new Map(before.map((n) => {
    const p = n.getBoundingClientRect();
    return [n, Math.hypot(p.left - s0.cx, p.top - s0.cy) / s0.R];
  }));

  m.goto('yourTurn');
  const deliveredAt = document.timeline.currentTime;
  const handIds = [...$('hand-row').querySelectorAll('.card')].map((c) => c.dataset.card).join(',');
  const dealDelivered = !shown($('scoreboard')) && handIds === 'c1,c2,c3,c4,c5,c6';
  // Your cards' entry delays, read at delivery: [transform, opacity] per card.
  const handDelays = [...$('hand-row').querySelectorAll('.card')].map((c) =>
    c.getAnimations().filter(scripted).map((a) => a.effect.getTiming().delay));
  const leftoverAtDelivery = before.filter((n) => n.isConnected).length;

  // 3 and 4, sampled together from the deal's first frame.
  // YOUR TURN is measured while its 700ms banner is up, at its settled
  // position — and on the SETTLED table: the deal snapshot swaps the scoreboard
  // out for the hand, so for --t-swap the tray changes height and the stage and
  // its seats move with it. Measured mid-swap, the seats are not where the
  // banner will be sharing the stage with them (a first version of the live
  // check read "no overlap" at 390x844 that way, 0ms into a 200ms swap).
  const LAYOUT = new Set(['--table-d', 'height', 'margin-top', 'margin-bottom', 'padding-top', 'padding-bottom']);
  const layoutMoving = () => document.getAnimations().filter((a) => LAYOUT.has(a.transitionProperty) && a.playState === 'running').length;
  let atYourTurn = { bannerVisible: false, overlaps: [] };
  let yourTurnMeasuredAt = null, layoutMovingFrames = 0;
  let frames = 0, tpSweepFrames = 0;
  const swept = new Set();
  let sweepEnd = 0;                         // timeline ms the last sweep animation ends
  const lastRatio = new Map(), lastOpacity = new Map();
  const t0 = performance.now();
  await new Promise((resolve) => {
    const tick = () => {
      frames++;
      if (yourTurnMeasuredAt === null) {
        if (layoutMoving()) layoutMovingFrames++;
        else {
          yourTurnMeasuredAt = Math.round(performance.now() - t0);
          $('banner').getAnimations().forEach((a) => { try { a.finish(); } catch {} });
          atYourTurn = bannerOverlaps((b) => b.textContent === 'YOUR TURN');
        }
      }
      const s = sauceNow();
      for (const a of document.getAnimations()) {
        const t = a.effect && a.effect.target;
        if (a.id !== 'ledger-sweep' || !t || !startRatio.has(t)) continue;
        tpSweepFrames++;
        swept.add(t);
        if (a.startTime !== null) sweepEnd = Math.max(sweepEnd, a.startTime + a.effect.getComputedTiming().endTime);
        if (t.isConnected) {
          const p = t.getBoundingClientRect();
          lastRatio.set(t, Math.hypot(p.left - s.cx, p.top - s.cy) / s.R);
          lastOpacity.set(t, Number(getComputedStyle(t).opacity));
        }
      }
      // A ghost's course is fixed the frame it leaves: record where it is aimed.
      for (const g of ghosts) {
        if (g.aim || !g.anim || g.anim.currentTime === null || g.anim.currentTime < g.delay) continue;
        const kf = g.anim.effect.getKeyframes();
        const mt = /translate\((-?[\d.e-]+)px,\s*(-?[\d.e-]+)px\)/.exec(kf[kf.length - 1].transform || '');
        const st = g.node.style;
        g.aim = mt ? [Number.parseFloat(st.left) + Number.parseFloat(st.width) / 2 + Number(mt[1]),
                      Number.parseFloat(st.top) + Number.parseFloat(st.height) / 2 + Number(mt[2])] : [NaN, NaN];
      }
      for (const g of ghosts) {
        if (!g.aim && g.node.isConnected && Number(getComputedStyle(g.node).opacity) > 0.01) g.visibleWhileWaiting = true;
      }
      if (performance.now() - t0 < 2600) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
  mo.disconnect();

  // Where every target is once the table has settled, and which ghost went where.
  const targetEl = (id) => (id === 'p1' ? $('hand-row') : document.querySelector(`.seat[data-player="${id}"] .stack`));
  const targets = EXPECTED_ORDER.map((id) => ({ id, c: centre(targetEl(id).getBoundingClientRect()) }));
  const startDelay = ghosts.length ? Math.min(...ghosts.map((g) => g.delay)) : null;
  const n = EXPECTED_ORDER.length;
  const perTarget = {};
  let maxMiss = 0, launched = 0;
  const slots = new Set();
  let slotsOk = ghosts.length > 0;
  for (const g of ghosts) {
    const rel = g.delay - startDelay;
    const k = Math.floor(rel / (n * 90));
    const p = (rel - k * n * 90) / 90;
    if (!Number.isInteger(p) || p >= n || k >= PER_SEAT || slots.has(`${k}:${p}`)) slotsOk = false;
    slots.add(`${k}:${p}`);
    if (!g.aim) continue;
    launched++;
    let best = null;
    for (const t of targets) {
      const d = Math.hypot(g.aim[0] - t.c[0], g.aim[1] - t.c[1]);
      if (!best || d < best.d) best = { id: t.id, d };
    }
    maxMiss = Math.max(maxMiss, best.d);
    perTarget[best.id] = perTarget[best.id] || { ghosts: 0, seatPositions: [] };
    perTarget[best.id].ghosts++;
    if (!perTarget[best.id].seatPositions.includes(p)) perTarget[best.id].seatPositions.push(p);
  }
  const dealOrder = Object.entries(perTarget)
    .filter(([, v]) => v.seatPositions.length === 1)
    .sort((a, b) => a[1].seatPositions[0] - b[1].seatPositions[0]).map(([id]) => id);
  const firstLaunch = ghosts.length ? Math.min(...ghosts.map((g) => (g.anim && g.anim.startTime !== null ? g.anim.startTime + g.delay : Infinity))) : null;
  const yourGhostDelays = ghosts.filter((g) => {
    const rel = g.delay - startDelay;
    return (rel - Math.floor(rel / (n * 90)) * n * 90) / 90 === EXPECTED_ORDER.indexOf('p1');
  }).map((g) => g.delay).sort((a, b) => a - b);
  // Each of your ghosted cards must start rising exactly when its ghost's 240ms
  // flight ends — both of its entry effects (transform and opacity), or none counts.
  const handRiseErrors = yourGhostDelays.map((d, k) => (handDelays[k] && handDelays[k].length === 2
    ? Math.max(...handDelays[k].map((h) => Math.abs(h - (d + 240)))) : Infinity));
  const outward = [...swept].map((t) => (lastRatio.get(t) || 0) - (startRatio.get(t) || 0));
  const leftoverAfter = before.filter((nd) => nd.isConnected).length;

  const deal = {
    ghosts: ghosts.length, launched, toppingsBefore, tpSweepFrames,
    startDelay, perTarget, dealOrder, maxMissPx: +maxMiss.toFixed(1),
    ghostsVisibleWhileWaiting: ghosts.filter((g) => g.visibleWhileWaiting).length,
    handDelays: handDelays.map((d) => d[0]), yourGhostDelays,
    sweptNodes: swept.size, sweepMinOutward: outward.length ? +Math.min(...outward).toFixed(2) : null,
    sweepLastOpacityMax: swept.size ? +Math.max(...[...swept].map((t) => lastOpacity.get(t) ?? 1)).toFixed(2) : null,
    sweepEndsBeforeFirstCard: sweepEnd && firstLaunch !== null ? +(firstLaunch - sweepEnd).toFixed(1) : null,
    leftoverAtDelivery, leftoverAfter,
  };
  const checks = rm ? {
    // Reduced motion: no travel and no sweep; the old pie is gone at once.
    noGhosts: ghosts.length === 0,
    noSweep: tpSweepFrames === 0 && swept.size === 0,
    clearedAtOnce: leftoverAtDelivery === 0,
  } : {
    // 4 seats x 4 cards, one slot each on the round-robin grid, 4 to every seat
    // in seat order from the player after the opener, each aimed at its seat.
    // The 6px miss allowance sits between what was measured (0.0px at 390x844,
    // 1280x800 and 1440x900 with re-aiming; 116px / 146px at 1440x900 / 390x844
    // with the re-aim disabled) and well inside the smallest seat tile (36px).
    dealAroundTable: ghosts.length === n * PER_SEAT && launched === ghosts.length && slotsOk
      && EXPECTED_ORDER.every((id) => perTarget[id] && perTarget[id].ghosts === PER_SEAT)
      && dealOrder.join() === EXPECTED_ORDER.join() && maxMiss <= 6,
    ghostsUnseenWhileWaiting: ghosts.length === n * PER_SEAT && deal.ghostsVisibleWhileWaiting === 0,
    handRisesOnArrival: yourGhostDelays.length === PER_SEAT && handRiseErrors.every((e) => e <= 1),
    // Every topping that was on the pie is swept (by id), outward by at least
    // half a radius, fading, gone afterwards — and gone before the first card leaves.
    // Outward and opacity are read on the LAST frame sampled before a piece is
    // removed, which on an ease-in lands short of the 1.35 radii / 0 it reaches:
    // measured 1.01-1.11 radii and 0.02 at 60Hz. Half a radius and 0.25 leave room
    // for a sampler running at half that rate; a piece that fades in place reads 0.
    sweep: toppingsBefore > 0 && swept.size === toppingsBefore && tpSweepFrames > 0
      && outward.every((d) => d >= 0.5) && deal.sweepLastOpacityMax <= 0.25
      && leftoverAtDelivery === toppingsBefore && leftoverAfter === 0
      && deal.sweepEndsBeforeFirstCard !== null && deal.sweepEndsBeforeFirstCard >= -1,
  };
  checks.bannerClearAtRoundOver = atRoundOver.bannerVisible && atRoundOver.overlaps.length === 0;
  checks.bannerClearAtYourTurn = atYourTurn.bannerVisible && atYourTurn.overlaps.length === 0;

  // The YOUR TURN measurement only counts if it waited for the table to settle
  // (the swap was seen moving; reduced motion snaps it) and still landed inside
  // the banner's 700ms.
  const valid = roundOverShown && atRoundOver.bannerVisible && toppingsBefore > 0
    && dealDelivered && atYourTurn.bannerVisible && (rm || layoutMovingFrames > 0)
    && yourTurnMeasuredAt !== null && yourTurnMeasuredAt < 700 && frames >= 60;
  return JSON.stringify({
    viewport: `${innerWidth}x${innerHeight}`, reducedMotion: rm,
    atRoundOver, atYourTurn, deal,
    signals: { roundOverShown, dealDelivered, handIds, frames, deliveredAt: Math.round(deliveredAt), yourTurnMeasuredAt, layoutMovingFrames },
    checks,
    pass: valid && Object.values(checks).every(Boolean),
    valid,
  }, null, 1);
})()
