(async () => {
  // The round boundary, on the scripted mock table (`--scene mock:roundOver`):
  // a full table's round-over banner; the next deal going around the table; the
  // finished pie swept off the board; your new hand rising as its cards arrive,
  // and not playable before it does; the deal's sound; the YOUR TURN banner; and
  // the first deal out of the lobby, which has no sweep to wait behind.
  //
  // Sealed, per the house rules for probes:
  //  - PRIMED: three scripted plays put toppings on the pie before anything is
  //    watched, and every animation is finished at round over, so nothing that
  //    started earlier can be counted.
  //  - Counted only from the watched step: ghosts are the `.travel-back` nodes
  //    ADDED after that step's observer starts; the sweep is counted by its own
  //    WAAPI id ('ledger-sweep') on the toppings that were on the pie before the
  //    deal; the deal's voice is the audio sources scheduled inside the deal
  //    snapshot's own task.
  //  - A ghost's miss is measured where it LANDS: its aim and its target's centre
  //    on the last frame it is in flight, not the settled table afterwards.
  //  - `valid` reads only the watched steps' own signals (the win banner and Next
  //    slice button, three seats measured under each banner, toppings on the pie,
  //    each deal snapshot delivered, the lobby shown, the audio pipeline live,
  //    frames sampled, YOUR TURN read on a settled table inside its 700ms). It
  //    never looks at the effects under test, so a RED run on the old UI is as
  //    valid as a GREEN one; the verdicts are in `checks`, each beside its count.
  //
  // `atRoundOver` keeps the { bannerVisible, overlaps } shape Task 11 reads, plus
  // `seats`: an empty `overlaps` means nothing unless seats were there to overlap.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const m = window.__mock;
  const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (id) => document.getElementById(id);
  const shown = (el) => !!el && !el.hidden && getComputedStyle(el).display !== 'none';
  const intersects = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
  const centre = (r) => [r.left + r.width / 2, r.top + r.height / 2];
  const scripted = (a) => !a.transitionProperty && !a.animationName;   // WAAPI only
  const finish = (el) => el.getAnimations().forEach((a) => { try { a.finish(); } catch {} });
  const SEATS = 3;                        // a four-seat table: three opponents on #seats
  const ORDER = ['p1', 'p2', 'p3', 'p4']; // mock yourTurn: opener p1 (you), dealt first
  const PER_SEAT = 4, DEAL_MS = 240, STEP_MS = 55, HAND = 'c1,c2,c3,c4,c5,c6';
  // `display` belongs here: with allow-discrete it is what keeps a leaving
  // panel in the layout, and under reduced motion (where height/--table-d do
  // not transition at all) it is the ONLY sign the tray is still swapping —
  // read at 5ms instead of 190ms, the stage is 29px short and the banner reads
  // as covering the top card it clears once the swap lands.
  const LAYOUT = new Set(['--table-d', 'height', 'width', 'margin-top', 'margin-bottom', 'margin-left', 'padding-top', 'padding-bottom', 'display']);
  const layoutMoving = () => document.getAnimations().filter((a) => LAYOUT.has(a.transitionProperty) && a.playState === 'running').length;

  // `want` names the banner this step is supposed to show, so a leftover banner
  // of the other kind cannot stand in for it.
  /* `seats` counts NODES and `seatsVisible` counts seats with real area, and the
     difference is load-bearing now that the ring stands down at round over.
     querySelectorAll still matches a `display: none` seat, and a zero-size rect
     intersects nothing — so counting nodes alone would have reported
     `seats: 3, overlaps: []` at round over and called it a pass, which is the
     vacuous shape this probe exists to refuse. Overlaps are computed only
     against seats that are actually on screen. */
  const bannerOverlaps = (want) => {
    const banner = $('banner');
    const all = [...document.querySelectorAll('#seats .seat')];
    const onScreen = all.filter((s) => { const r = s.getBoundingClientRect(); return r.width > 1 && r.height > 1; });
    if (!shown(banner) || !want(banner)) {
      return { bannerVisible: false, seats: all.length, seatsVisible: onScreen.length, overlaps: [] };
    }
    const br = banner.getBoundingClientRect();
    const overlaps = onScreen.filter((s) => intersects(br, s.getBoundingClientRect())).map((s) => s.dataset.player);
    return { bannerVisible: true, seats: all.length, seatsVisible: onScreen.length, overlaps };
  };
  // YOUR TURN also answers "is the top card clear?", and "would the low placement
  // (bottom: 8px, the win banner's) have covered it?" — forced inline for one
  // read and restored in the same task.
  const readYourTurn = () => {
    const banner = $('banner');
    finish(banner);
    const o = bannerOverlaps((b) => b.textContent === 'YOUR TURN');
    if (!o.bannerVisible) return Object.assign(o, { topCardOverlap: null, lowWouldCoverTopCard: null, placement: null });
    const card = $('top-card').getBoundingClientRect();
    const br = banner.getBoundingClientRect();
    const st = $('stage').getBoundingClientRect();
    banner.style.top = 'auto'; banner.style.bottom = '8px';
    const low = banner.getBoundingClientRect();
    banner.style.top = ''; banner.style.bottom = '';
    return Object.assign(o, {
      topCardOverlap: intersects(br, card),
      lowWouldCoverTopCard: intersects(low, card),
      placement: br.top - st.top < st.height / 2 ? 'high' : 'low',
    });
  };

  // What the app sends (a tap that plays sends `play`) and what it schedules on
  // the audio clock (every voice starts sources through this one method).
  // While a tap test runs, what it sends is recorded and NOT delivered: on a UI
  // that lets an unseen card be played, the play would move the turn on and
  // take the YOUR TURN banner (and the rest of the watch) with it.
  const sent = [];
  let swallow = false;
  const sendWas = window.WebSocket.prototype.send;
  window.WebSocket.prototype.send = function (data) {
    try { sent.push(JSON.parse(data).type); } catch { /* not ours */ }
    if (swallow) return undefined;
    return sendWas.call(this, data);
  };
  // AudioBufferSourceNode declares its own start(), so wrapping the shared
  // AudioScheduledSourceNode one alone misses every noise-based card sound.
  const voices = [];
  const wrapped = [AudioScheduledSourceNode.prototype, AudioBufferSourceNode.prototype]
    .filter((proto) => Object.prototype.hasOwnProperty.call(proto, 'start'))
    .map((proto) => {
      const was = proto.start;
      proto.start = function (when = 0, ...rest) {
        voices.push({ kind: this.constructor.name, at: when - this.context.currentTime });
        return was.call(this, when, ...rest);
      };
      return [proto, was];
    });
  document.dispatchEvent(new PointerEvent('pointerdown'));   // the app's own unlock listener
  await sleep(150);

  // 0. Prime: toppings on the pie, so the exit sweep has something to move.
  for (let k = 0; k < 3; k++) {
    await m.transition('number', { seats: 4 });
    await sleep(700);
  }

  // 1. Round over with a full table: does the win banner cover a seat?
  voices.length = 0;
  m.goto('roundOver');
  const audioLive = voices.length > 0;       // the win/lose voice was scheduled
  await sleep(700);
  document.getAnimations().forEach((a) => { try { a.finish(); } catch {} });
  const roundOverShown = shown($('banner')) && $('banner').classList.contains('win') && shown($('newround-btn'));
  const atRoundOver = bannerOverlaps((b) => b.classList.contains('win'));

  /** Delivers one deal (`trigger`) and watches it for `windowMs`. */
  const watchDeal = async ({ trigger, windowMs, withSweep, tapTest }) => {
    const ghosts = [];
    const mo = new MutationObserver((muts) => {
      for (const mu of muts) for (const n of mu.addedNodes) {
        if (!n.classList || !n.classList.contains('travel-back')) continue;
        const anim = n.getAnimations().find(scripted) || null;
        ghosts.push({ node: n, anim, delay: anim ? anim.effect.getTiming().delay : null, last: null });
      }
    });
    mo.observe(document.body, { childList: true });
    const sauce = document.querySelector('.sauce');
    const sauceNow = () => { const b = sauce.getBoundingClientRect(); return { cx: b.left + b.width / 2, cy: b.top + b.height / 2, R: b.width / 2 }; };
    const before = withSweep ? [...document.querySelectorAll('#ledger .tp')] : [];
    const s0 = sauceNow();
    const startRatio = new Map(before.map((n) => {
      const p = n.getBoundingClientRect();
      return [n, Math.hypot(p.left - s0.cx, p.top - s0.cy) / s0.R];
    }));

    voices.length = 0;
    trigger();
    const dealVoice = voices.map((v) => Object.assign({}, v));   // scheduled in the deal's own task
    const cards = [...$('hand-row').querySelectorAll('.card')];
    const handIds = cards.map((c) => c.dataset.card).join(',');
    const delivered = !shown($('scoreboard')) && document.body.dataset.screen === 'game' && handIds === HAND;
    const hand = cards.map((c) => {
      const anims = c.getAnimations().filter(scripted);
      return { node: c, anims, delays: anims.map((a) => a.effect.getTiming().delay), inertAtDelivery: c.inert, releasedAt: null, riseAt: null };
    });
    const leftoverAtDelivery = before.filter((n) => n.isConnected).length;

    // A tap on a card that has not started rising must do nothing.
    let tap = null;
    if (tapTest) {
      const h = hand.find((x) => x.node.dataset.card === 'c1');   // Basil 4: playable
      const sentBefore = sent.length;
      h.node.focus();
      const r = h.node.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      swallow = true;
      h.node.click();
      swallow = false;
      tap = {
        card: 'c1', delay: Math.max(...h.delays), inert: h.node.inert,
        focusable: document.activeElement === h.node,
        hitTestReachesCard: !!hit && (hit === h.node || h.node.contains(hit)),
        sent: sent.slice(sentBefore), armed: h.node.classList.contains('is-armed'),
      };
    }

    let yourTurn = { bannerVisible: false, seats: 0, overlaps: [] };
    let yourTurnMeasuredAt = null, layoutMovingFrames = 0, frames = 0, tpSweepFrames = 0;
    const swept = new Set();
    let sweepEnd = 0;
    const lastRatio = new Map(), lastOpacity = new Map();
    const targetEl = (id) => (id === 'p1' ? $('hand-row') : document.querySelector(`.seat[data-player="${id}"] .stack`));
    const t0 = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        frames++;
        if (yourTurnMeasuredAt === null) {
          if (layoutMoving()) layoutMovingFrames++;
          else { yourTurnMeasuredAt = Math.round(performance.now() - t0); yourTurn = readYourTurn(); }
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
        // In flight: where is each ghost aimed, and where is every target, now?
        const centres = ORDER.map((id) => ({ id, c: centre(targetEl(id).getBoundingClientRect()) }));
        for (const g of ghosts) {
          if (!g.anim || !g.node.isConnected) continue;
          const ct = g.anim.currentTime;
          if (ct === null) continue;
          if (ct < g.delay) {
            // One frame of margin at the boundary: on the frame a ghost leaves,
            // its first keyframe can already be applied while currentTime still
            // reads just under the delay, which counted a launching ghost as a
            // visible waiting one (2 frames of 157 on a RED run).
            if (ct < g.delay - 17 && Number(getComputedStyle(g.node).opacity) > 0.01) g.visibleWhileWaiting = true;
            continue;
          }
          if (ct >= g.delay + DEAL_MS || g.anim.playState === 'finished') continue;
          const kf = g.anim.effect.getKeyframes();
          const mt = /translate\((-?[\d.e-]+)px,\s*(-?[\d.e-]+)px\)/.exec(kf[kf.length - 1].transform || '');
          const st = g.node.style;
          const aim = mt ? [Number.parseFloat(st.left) + Number.parseFloat(st.width) / 2 + Number(mt[1]),
                            Number.parseFloat(st.top) + Number.parseFloat(st.height) / 2 + Number(mt[2])] : [NaN, NaN];
          let best = null;
          for (const t of centres) {
            const d = Math.hypot(aim[0] - t.c[0], aim[1] - t.c[1]);
            if (!best || d < best.d) best = { id: t.id, d };
          }
          g.last = best;
          if (g.launchedAt === undefined) g.launchedAt = document.timeline.currentTime;
        }
        for (const h of hand) {
          if (h.riseAt === null && h.anims[0] && h.anims[0].startTime !== null) h.riseAt = h.anims[0].startTime + Math.max(...h.delays);
          if (h.inertAtDelivery && h.releasedAt === null && !h.node.inert) h.releasedAt = document.timeline.currentTime;
        }
        if (performance.now() - t0 < windowMs) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });
    mo.disconnect();

    const n = ORDER.length;
    const startDelay = ghosts.length ? Math.min(...ghosts.map((g) => g.delay)) : null;
    const lastGhostDelay = ghosts.length ? Math.max(...ghosts.map((g) => g.delay)) : null;
    const perTarget = {};
    const slots = new Set();
    let slotsOk = ghosts.length > 0, maxMiss = 0, landed = 0;
    const slotOf = (g) => {
      const rel = g.delay - startDelay;
      const k = Math.floor(rel / (n * 90));
      return { k, p: (rel - k * n * 90) / 90 };
    };
    for (const g of ghosts) {
      const { k, p } = slotOf(g);
      if (!Number.isInteger(p) || p >= n || k >= PER_SEAT || slots.has(`${k}:${p}`)) slotsOk = false;
      slots.add(`${k}:${p}`);
      if (!g.last) continue;
      landed++;
      maxMiss = Math.max(maxMiss, g.last.d);
      perTarget[g.last.id] = perTarget[g.last.id] || { ghosts: 0, seatPositions: [] };
      perTarget[g.last.id].ghosts++;
      if (!perTarget[g.last.id].seatPositions.includes(p)) perTarget[g.last.id].seatPositions.push(p);
    }
    const dealOrder = Object.entries(perTarget).filter(([, v]) => v.seatPositions.length === 1)
      .sort((a, b) => a[1].seatPositions[0] - b[1].seatPositions[0]).map(([id]) => id);
    const firstLaunch = ghosts.length ? Math.min(...ghosts.map((g) => (g.anim && g.anim.startTime !== null ? g.anim.startTime + g.delay : Infinity))) : null;
    const yourGhostDelays = ghosts.filter((g) => slotOf(g).p === ORDER.indexOf('p1')).map((g) => g.delay).sort((a, b) => a - b);
    const handDelays = hand.map((h) => (h.delays.length ? Math.max(...h.delays) : null));
    const riseErrors = yourGhostDelays.map((d, k) => (hand[k] && hand[k].delays.length === 2
      ? Math.max(...hand[k].delays.map((x) => Math.abs(x - (d + DEAL_MS)))) : Infinity));
    const releaseLag = hand.filter((h) => h.inertAtDelivery).map((h) => (h.releasedAt === null || h.riseAt === null ? null : +(h.releasedAt - h.riseAt).toFixed(1)));
    const outward = [...swept].map((t) => (lastRatio.get(t) || 0) - (startRatio.get(t) || 0));
    return {
      delivered, handIds, frames, layoutMovingFrames, yourTurnMeasuredAt, yourTurn, tap,
      deal: {
        ghosts: ghosts.length, landed, startDelay, lastGhostDelay, perTarget, dealOrder, slotsOk,
        maxMissAtLandingPx: +maxMiss.toFixed(1),
        ghostsVisibleWhileWaiting: ghosts.filter((g) => g.visibleWhileWaiting).length,
      },
      hand: {
        delays: handDelays, yourGhostDelays, riseErrors,
        inertAtDelivery: hand.filter((h) => h.inertAtDelivery).length,
        releasedAfterRiseMs: releaseLag,
      },
      sweep: {
        toppingsBefore: before.length, tpSweepFrames, sweptNodes: swept.size,
        minOutwardRadii: outward.length ? +Math.min(...outward).toFixed(2) : null,
        lastOpacityMax: swept.size ? +Math.max(...[...swept].map((t) => lastOpacity.get(t) ?? 1)).toFixed(2) : null,
        endsBeforeFirstCardMs: sweepEnd && firstLaunch !== null ? +(firstLaunch - sweepEnd).toFixed(1) : null,
        leftoverAtDelivery, leftoverAfter: before.filter((nd) => nd.isConnected).length,
      },
      voice: {
        sources: dealVoice.length, kinds: [...new Set(dealVoice.map((v) => v.kind))],
        firstAtS: dealVoice.length ? +Math.min(...dealVoice.map((v) => v.at)).toFixed(3) : null,
        lastAtS: dealVoice.length ? +Math.max(...dealVoice.map((v) => v.at)).toFixed(3) : null,
      },
    };
  };

  // 2. The next slice's deal, after the sweep.
  const next = await watchDeal({ trigger: () => m.goto('yourTurn'), windowMs: 2600, withSweep: true, tapTest: !rm });
  const atYourTurn = next.yourTurn;

  // 3. The same YOUR TURN with each bar a turn can open with — TONDO, callout
  //    (the tallest), a drawn card — which compress the stage by different
  //    amounts, so a placement chosen by viewport is judged against all of them.
  const atYourTurnWithBar = {};
  for (const scene of ['tondo', 'callout', 'drawn']) {
    m.goto('roundOver');
    await sleep(300);
    m.goto(scene);
    let at = null;
    const tc = performance.now();
    while (performance.now() - tc < 650) {
      await new Promise((r) => requestAnimationFrame(r));
      if (!layoutMoving()) { at = Math.round(performance.now() - tc); break; }
    }
    atYourTurnWithBar[scene] = Object.assign(readYourTurn(), {
      measuredAt: at, compressed: $('stage').classList.contains('is-compressed'),
    });
  }
  const barReads = Object.values(atYourTurnWithBar);

  // 4. The first deal out of the lobby: no sweep, startDelay 0, and the game
  //    screen still growing into place while the first cards fly.
  m.goto('lobby');
  await sleep(400);
  const lobbyShown = document.body.dataset.screen === 'lobby';
  const lobby = await watchDeal({ trigger: () => m.goto('yourTurn'), windowMs: 2000, withSweep: false, tapTest: false });

  // 5. The positive control for the tap test: once risen, the same tap works.
  let tapAfterRise = null;
  if (!rm) {
    const c1 = $('hand-row').querySelector('[data-card="c1"]');
    const sentBefore = sent.length;
    c1.focus();
    const focusable = document.activeElement === c1;
    swallow = true;
    c1.click();
    swallow = false;
    await sleep(80);
    tapAfterRise = { inert: c1.inert, focusable, sent: sent.slice(sentBefore), armed: c1.classList.contains('is-armed') };
  }
  window.WebSocket.prototype.send = sendWas;
  for (const [proto, was] of wrapped) proto.start = was;

  const aroundTable = (w, startAt) => w.deal.ghosts === ORDER.length * PER_SEAT && w.deal.landed === w.deal.ghosts
    && w.deal.slotsOk && ORDER.every((id) => w.deal.perTarget[id] && w.deal.perTarget[id].ghosts === PER_SEAT)
    && w.deal.dealOrder.join() === ORDER.join() && w.deal.startDelay === startAt
    // 6px: between the 0.0px measured with the ghosts following their seats and
    // the 116-146px measured without; well inside the smallest seat tile (36px).
    && w.deal.maxMissAtLandingPx <= 6;
  // Your cards: the four with ghosts rise as each lands; the first inside the
  // deal's first lap; the rest on the draw stagger, all begun by the time the
  // last ghost lands plus that stagger.
  const handOnArrival = (w) => w.hand.yourGhostDelays.length === PER_SEAT && w.hand.riseErrors.every((e) => e <= 1)
    && w.hand.delays[0] - w.deal.startDelay <= ORDER.length * 90 + DEAL_MS
    && Math.max(...w.hand.delays) <= w.deal.lastGhostDelay + DEAL_MS + (w.hand.delays.length - PER_SEAT) * STEP_MS
    && w.hand.delays.slice(PER_SEAT).every((d, i) => Math.abs(d - (w.hand.delays[PER_SEAT - 1] + (i + 1) * STEP_MS)) <= 1);
  // Inert until the rise begins, released on (at most two frames after) it.
  const inertUntilRise = (w) => w.hand.inertAtDelivery === w.hand.delays.length
    && w.hand.releasedAfterRiseMs.every((d) => d !== null && d >= -1 && d <= 34);
  // 10ms of tolerance, because that is the instrument: each source's start time
  // is read against context.currentTime a moment after the voice computed it,
  // and that clock advances in 128-sample quanta (~2.7ms at 48kHz) — a run came
  // back at -0.006s for a voice scheduled at 0. Still 50x smaller than the
  // 520ms this check is about.
  const voiceOnFirstCard = (w, atS) => w.voice.sources === 7 && w.voice.kinds.join() === 'AudioBufferSourceNode'
    && Math.abs(w.voice.firstAtS - atS) <= 0.01;
  // The ruled trade: YOUR TURN never covers the top card; it clears every seat
  // unless it is up high BECAUSE the low placement would cover the top card in
  // one of this viewport's turns (plain, or with a bar open).
  const lowCoversCardHere = [atYourTurn, ...barReads].some((y) => y.lowWouldCoverTopCard);
  const clearOrRuledTrade = (y) => y.bannerVisible && (y.overlaps.length === 0 || (y.placement === 'high' && lowCoversCardHere));

  const checks = rm ? {
    // Reduced motion: no travel, no sweep, the old pie gone at once, the hand
    // visible and playable at once, the deal heard at once.
    noGhosts: next.deal.ghosts === 0 && lobby.deal.ghosts === 0,
    noSweep: next.sweep.tpSweepFrames === 0 && next.sweep.sweptNodes === 0,
    clearedAtOnce: next.sweep.leftoverAtDelivery === 0,
    handNotInert: next.hand.inertAtDelivery === 0 && lobby.hand.inertAtDelivery === 0,
    dealVoiceAtOnce: voiceOnFirstCard(next, 0) && voiceOnFirstCard(lobby, 0),
  } : {
    dealAroundTable: aroundTable(next, 520),
    lobbyDealAroundTable: aroundTable(lobby, 0),
    ghostsUnseenWhileWaiting: next.deal.ghosts === 16 && next.deal.ghostsVisibleWhileWaiting === 0
      && lobby.deal.ghosts === 16 && lobby.deal.ghostsVisibleWhileWaiting === 0,
    handRisesOnArrival: handOnArrival(next) && handOnArrival(lobby),
    handInertUntilRising: inertUntilRise(next) && inertUntilRise(lobby)
      && next.tap.inert && !next.tap.focusable && !next.tap.hitTestReachesCard
      && next.tap.sent.length === 0 && !next.tap.armed
      && !tapAfterRise.inert && tapAfterRise.focusable && (tapAfterRise.sent.includes('play') || tapAfterRise.armed),
    // Every topping that was on the pie is swept (by id), outward by at least
    // half a radius, fading, gone afterwards — and gone before the first card
    // leaves. Outward and opacity are read on the LAST frame sampled before a
    // piece is removed, which on an ease-in lands short of the 1.35 radii / 0 it
    // reaches: measured 1.01-1.11 radii and 0.02 at 60Hz. Half a radius and 0.25
    // leave room for a sampler at half that rate; a piece fading in place reads 0.
    sweep: next.sweep.toppingsBefore > 0 && next.sweep.sweptNodes === next.sweep.toppingsBefore && next.sweep.tpSweepFrames > 0
      && next.sweep.minOutwardRadii >= 0.5 && next.sweep.lastOpacityMax <= 0.25
      && next.sweep.leftoverAtDelivery === next.sweep.toppingsBefore && next.sweep.leftoverAfter === 0
      && next.sweep.endsBeforeFirstCardMs !== null && next.sweep.endsBeforeFirstCardMs >= -1,
    dealVoiceOnFirstCard: voiceOnFirstCard(next, (next.deal.startDelay || 0) / 1000) && voiceOnFirstCard(lobby, 0),
  };
  /* At round over the seat ring is hidden by design (styles.css
     `.stage.is-over #seats`), because the scoreboard leaves the stage 220px at
     1280x800 and the plaque was landing 46px into the top seat. So "the banner
     clears the seats" is no longer a question that can be asked here, and
     asserting it would pass against nothing. What IS worth pinning is that the
     ring really did stand down — if it ever comes back, this check fails and
     the overlap question returns with it. The live banner-vs-seat test is
     `bannerClearAtYourTurn`, where the seats are on screen. */
  checks.seatsStandDownAtRoundOver = atRoundOver.bannerVisible && atRoundOver.seatsVisible === 0;
  checks.bannerClearAtYourTurn = [atYourTurn, ...barReads].every(clearOrRuledTrade);
  checks.yourTurnClearOfTopCard = [atYourTurn, ...barReads].every((y) => y.topCardOverlap === false);

  /* Named one by one rather than chained with `&&`. A bare `valid=false` says
     only that ONE of a dozen premises did not hold, and the gate prints the
     verdict, not the conjunction — so a failure here cost a full diagnostic
     round-trip just to learn WHICH premise it was, while the same run in
     isolation passed. The names are the diagnosis. */
  const premises = {
    audioLive,
    roundOverShown,
    roundOverBannerVisible: atRoundOver.bannerVisible,
    roundOverSeatNodes: atRoundOver.seats === SEATS,
    toppingsBeforeSweep: next.sweep.toppingsBefore > 0,
    nextDelivered: next.delivered,
    lobbyShown,
    lobbyDelivered: lobby.delivered,
    // The overlap tests below mean nothing unless the seats are ON SCREEN for
    // them, so the premise counts area, not nodes.
    yourTurnBannerVisible: atYourTurn.bannerVisible,
    yourTurnSeatsOnScreen: atYourTurn.seatsVisible === SEATS,
    barsUsable: barReads.every((y) => y.bannerVisible && y.seatsVisible === SEATS && y.compressed && y.measuredAt !== null),
    // YOUR TURN counts only if it waited for the table to settle (the swap was
    // seen moving; reduced motion snaps it) and still landed inside its 700ms.
    layoutSeenMoving: rm || next.layoutMovingFrames > 0,
    yourTurnMeasured: next.yourTurnMeasuredAt !== null && next.yourTurnMeasuredAt < 700,
    // Sample-count floors. These are the premises that go soft under load:
    // the rAF sampler is counting real frames, so a browser 40 navigations
    // into a gate run can undershoot a floor that an isolated run clears
    // three times over. Reported with their counts for exactly that reason.
    nextFrameFloor: next.frames >= 60,
    lobbyFrameFloor: lobby.frames >= 45,
  };
  const failedPremises = Object.keys(premises).filter((k) => !premises[k]);
  const valid = failedPremises.length === 0;
  return JSON.stringify({
    viewport: `${innerWidth}x${innerHeight}`, reducedMotion: rm,
    atRoundOver, atYourTurn, atYourTurnWithBar,
    next: Object.assign({}, next, { yourTurn: undefined }),
    lobby: Object.assign({}, lobby, { yourTurn: undefined }),
    tapAfterRise,
    signals: { audioLive, roundOverShown, lobbyShown, nextDelivered: next.delivered, lobbyDelivered: lobby.delivered,
      frames: [next.frames, lobby.frames], yourTurnMeasuredAt: next.yourTurnMeasuredAt, layoutMovingFrames: next.layoutMovingFrames,
      barsMeasuredAt: barReads.map((y) => y.measuredAt) },
    checks,
    pass: valid && Object.values(checks).every(Boolean),
    valid, failedPremises,
  }, null, 1);
})()
