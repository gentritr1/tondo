(async () => {
  /*
   * Haptics: does the app ASK for a vibration, and — the part that matters —
   * does it stay quiet the rest of the time?
   *
   * What this probe can prove, and what it cannot:
   *   PROVES   which pattern was handed to `navigator.vibrate`, and on which
   *            occasions nothing was handed to it at all.
   *   CANNOT   prove a motor spun, that anything was felt, or that 20ms is
   *            long enough to be perceptible. Headless Chrome has no motor.
   *            Those close on a phone in a hand, or not at all.
   *
   * The negative cases are the point. An implementation that buzzes for
   * EVERYTHING passes a positive-only probe, and a phone that buzzes for
   * everything is a phone whose buzz means nothing. So the six recorded runs
   * are three pairs, each pair differing in exactly one thing:
   *
   *   plus2OnYou / plus2OnBot         victim = you vs a bot
   *   calloutOnYou / calloutOnBot     victim = you vs a bot
   *   turnWhenIdle / turnAfterTouch   no pointer input vs a pointerdown
   *                                   immediately before the same snapshot
   *
   * Sealed, per the house rules:
   *  - `valid` asserts only PREMISES — the stub is installed, the mock is
   *    here, each watched snapshot really rendered (read off #live-now and the
   *    mock's own model, never off a vibration), the pointer input the gate
   *    turns on really was or was not delivered. It reads no check, so a RED
   *    run is exactly as valid as a GREEN one. It does not require
   *    `haptics.js` to exist: in RED it does not.
   *  - Every recorded array is printed, not just its verdict.
   *  - Priming: the four consequence runs each dispatch a pointerdown first,
   *    which deliberately CLOSES the turn channel for the duration of the run.
   *    That is what makes `plus2OnBot: []` mean "no consequence buzz for a
   *    bot's +2" rather than "no buzz, or maybe one turn buzz, who knows" —
   *    the mock's own `before` snapshot hands you the turn on the bot runs, so
   *    without priming those arrays would carry a turn buzz that has nothing
   *    to do with the thing being watched. Count only the watched signal.
   */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const m = window.__mock;
  if (!m || !m.transition) {
    return JSON.stringify({ valid: false, reason: 'no window.__mock — run with --scene mock:<name>' }, null, 1);
  }
  if (!Array.isArray(window.__vibrations)) {
    return JSON.stringify({ valid: false, reason: 'no window.__vibrations — run with --prelude scripts/probes/haptics-stub.js' }, null, 1);
  }

  const supported = typeof navigator.vibrate === 'function';
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  /* Two environments in which EVERY array must be empty, for two different
     reasons: no API to call (the iOS branch, simulated) and a player who has
     asked the machine to stop moving. Both are inputs to this run, not
     verdicts about it. */
  const silent = !supported || reducedMotion;

  /* The module, best-effort: read to report the live threshold and patterns
     next to the literals this probe asserts. Never required — RED has no
     module, and a probe that is INVALID without the fix cannot show RED. */
  let mod = null;
  try { mod = await import('./js/haptics.js'); } catch { mod = null; }
  const live = {
    moduleLoaded: !!mod,
    IDLE_MS: mod && typeof mod.IDLE_MS === 'number' ? mod.IDLE_MS : null,
    PATTERNS: mod && mod.PATTERNS ? mod.PATTERNS : null,
    isSupported: mod && mod.isSupported ? mod.isSupported() : null,
    isEnabled: mod && mod.isEnabled ? mod.isEnabled() : null,
  };

  /* This probe's own pointer bookkeeping. The gate is "no pointerdown in the
     last IDLE_MS", so the premise each branch needs is a COUNT of pointer
     input the probe delivered, not a reading of the gate itself. */
  let pointerdowns = 0;
  let lastTouchAt = null;
  document.addEventListener('pointerdown', () => { pointerdowns++; }, true);
  const touch = () => {
    lastTouchAt = performance.now();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    return lastTouchAt;
  };

  const take = () => window.__vibrations.slice();
  const clear = () => { window.__vibrations.length = 0; };

  /* #live-now carries "Your turn. N playable." the moment a turn becomes
     yours (app.js:698). Watching it is how a turn run proves the snapshot it
     is measuring was actually PROCESSED — a post-hoc read cannot tell a
     repaint that happened from one that never arrived. */
  const watchAlert = () => {
    const node = $('live-now');
    node.textContent = '';
    const hits = [];
    const o = new MutationObserver(() => hits.push(node.textContent));
    o.observe(node, { childList: true, characterData: true, subtree: true });
    return () => { o.disconnect(); return hits; };
  };

  const out = { viewport: `${innerWidth}x${innerHeight}`, reducedMotion, supported, silent, live };

  /* ---------------------------------------------------------------- turn --
   * The gate: a turn buzz is for the player who is looking at their friends,
   * not at the screen. Both branches drive the SAME snapshot — the turn
   * moving from a bot back to you — and differ only in whether a pointerdown
   * landed first.
   */
  const setTurn = async (who, ms) => {
    const g = m.table.game;
    g.turnPlayerId = who;
    g.playableCardIds = who === 'p1' ? ['c1'] : [];
    m.emit(m.snapshot());
    await sleep(ms);
  };

  const turnRun = async (touchFirst) => {
    await setTurn('p2', 420);          // park the turn on a bot, quietly
    clear();
    const stop = watchAlert();
    const pdBefore = pointerdowns;
    const at = touchFirst ? touch() : null;
    const g = m.table.game;
    g.turnPlayerId = 'p1';
    g.playableCardIds = ['c1'];
    m.emit(m.snapshot());
    const emittedAt = performance.now();
    await sleep(900);
    return {
      recorded: take(),
      alerts: stop(),
      title: document.title,
      turnPlayerId: m.table.game.turnPlayerId,
      pointerdownsDelivered: pointerdowns - pdBefore,
      touchToEmitMs: at === null ? null : Math.round(emittedAt - at),
    };
  };
  const arrived = (r) => r.alerts.some((t) => /^Your turn\. \d+ playable\.$/.test(t))
    && r.turnPlayerId === 'p1';

  /* Idle branch FIRST, before this probe has dispatched any pointer input at
     all. The wait is absolute rather than relative to some reading of the
     module: once `performance.now()` (ms since navigation) exceeds the
     threshold and no pointerdown has occurred since load, no pointerdown can
     have occurred within the window, whatever clock the gate is anchored to.
     A `mock:` scene is never driven by clicks — scripts/shoot.js only waits
     for the game screen — so "since load" is the whole document's life. */
  const idleNeeded = (live.IDLE_MS == null ? 4000 : live.IDLE_MS) + 250;
  while (performance.now() < idleNeeded) await sleep(100);
  const idleAtStart = { elapsedMs: Math.round(performance.now()), needMs: idleNeeded, pointerdownsSoFar: pointerdowns };
  const turnWhenIdle = await turnRun(false);
  const turnAfterTouch = await turnRun(true);

  /* --------------------------------------------------------- consequences --
   * Primed (see the header): the pointerdown closes the turn channel, so each
   * array below holds the consequence channel and nothing else.
   */
  const run = async (kind, victim) => {
    const pdBefore = pointerdowns;
    touch();
    clear();
    await m.transition(kind, { seats: 4, victim });
    await sleep(900);
    const g = m.table.game;
    const counts = {};
    for (const p of g.players || []) counts[p.id] = p.cardCount;
    /* The premise: the scripted consequence really landed where it was aimed.
       `transition()` rebuilds the whole table from a fixed baseline of 5 cards
       a seat, so a before/after delta says nothing — the absolute count of the
       seat that was aimed at is what carries it. A +2 leaves its victim on 7,
       a callout leaves its victim on 3 (public/js/mock.js:341-375). Read off
       the mock's model and the rendered log, never off a vibration. */
    return {
      recorded: take(),
      log: (g.log || []).slice(-1)[0] || null,
      victim: victim === 'you' ? 'p1' : 'p2',
      victimCards: counts[victim === 'you' ? 'p1' : 'p2'],
      counts,
      topCard: g.topCard ? g.topCard.id : null,
      handCards: document.querySelectorAll('#hand-row .card').length,
      pointerdownsDelivered: pointerdowns - pdBefore,
    };
  };

  const plus2OnYou = await run('plus2', 'you');
  const plus2OnBot = await run('plus2', 'bot');
  const calloutOnYou = await run('callout', 'you');
  const calloutOnBot = await run('callout', 'bot');

  /* -------------------------------------------------------------- toggle --
   * `hidden` when the API is absent: a control that does nothing on an iPhone
   * is worse than no control. So the toggle's presence is itself one of the
   * checks, and the two runs below only exist when it is there to click.
   */
  const btn = $('haptics-btn');
  const toggle = {
    present: !!btn,
    visible: !!(btn && !btn.hidden && btn.offsetParent !== null),
    ariaPressed: btn ? btn.getAttribute('aria-pressed') : null,
    ariaLabel: btn ? btn.getAttribute('aria-label') : null,
    isOff: !!(btn && btn.classList.contains('is-off')),
    // The 30px circle is the visual; the 44x44 target is a ::before, exactly
    // as .strip-sound does it. Measured, because a copied rule can be dropped.
    hit: btn ? (() => {
      const s = getComputedStyle(btn, '::before');
      return { w: s.width, h: s.height };
    })() : null,
    box: btn ? (() => { const r = btn.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })() : null,
  };

  /* Turning it OFF must silence the loudest pattern in the set; turning it
     back ON must prove itself with the tap buzz. Null when there is nothing
     to click — and in that case `toggleHiddenWhenUnsupported` below is what
     has to hold instead, so the absence is never a free pass. */
  let toggleOffSilencesHit = null;
  let toggleOnBuzz = null;
  if (toggle.visible) {
    btn.click();                                  // → off
    await sleep(120);
    toggle.ariaPressedAfterOff = btn.getAttribute('aria-pressed');
    toggle.isOffAfterOff = btn.classList.contains('is-off');
    toggleOffSilencesHit = (await run('plus2', 'you')).recorded;
    clear();
    btn.click();                                  // → on, and it says so
    await sleep(400);
    toggleOnBuzz = take();
    toggle.ariaPressedAfterOn = btn.getAttribute('aria-pressed');
  }

  /* ----------------------------------------------------------------- tap --
   * The press feedback, through the real path: tapCardId → send('play'). A
   * coarse pointer arms on the first tap and commits on the second, and
   * arming must not buzz, so the loop is the same two-tap dance the a11y
   * probe does.
   */
  m.goto('yourTurn');
  await sleep(450);
  const card = document.querySelector('#hand-row [data-card="c1"]');
  const tapRun = { card: !!card, playable: !!(card && card.classList.contains('is-playable')) };
  if (card) {
    // A card that has not finished rising is `inert`, and tapCardId refuses
    // it: clicking early would measure a refusal, not a play.
    const t0 = Date.now();
    while (card.inert && Date.now() - t0 < 3000) await sleep(50);
    tapRun.ready = !card.inert;
    touch();
    clear();
    const topBefore = m.table.game.topCard.id;
    card.click();
    await sleep(250);
    tapRun.afterFirst = take();
    // Coarse pointers arm on the first tap and commit on the second. Which
    // branch this run took is recorded, because the two have different
    // correct answers for `afterFirst`.
    tapRun.playedOnFirst = m.table.game.topCard.id !== topBefore;
    if (!tapRun.playedOnFirst) { card.click(); await sleep(250); }
    await sleep(500);
    tapRun.recorded = take();
    tapRun.topBefore = topBefore;
    tapRun.topAfter = m.table.game.topCard.id;
    tapRun.played = tapRun.topAfter !== topBefore;
  }

  /* ---------------------------------------------------------------------- */
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  /* Literal expectations, never read back out of the module: a probe that
     compares the app against the app's own constants asserts nothing. */
  const want = silent
    ? { hit: [], caught: [], turnIdle: [], tap: [] }
    : { hit: [35], caught: [[30, 60, 30]], turnIdle: [20], tap: [20] };

  const checks = {
    // the two buzzes that are the point of this task
    plus2OnYouBuzzes: eq(plus2OnYou.recorded, want.hit),
    calloutOnYouBuzzes: eq(calloutOnYou.recorded, want.caught),
    // …and the same events aimed at somebody else, which must be silent
    plus2OnBotSilent: eq(plus2OnBot.recorded, []),
    calloutOnBotSilent: eq(calloutOnBot.recorded, []),
    // the gate: one snapshot, two branches
    turnBuzzesWhenIdle: eq(turnWhenIdle.recorded, want.turnIdle),
    turnSilentAfterTouch: eq(turnAfterTouch.recorded, []),
    // progressive enhancement: no API, no control
    toggleMatchesSupport: toggle.visible === supported,
    toggleHiddenWhenUnsupported: supported || (toggle.visible === false && toggleOffSilencesHit === null),
    toggleOffSilences: supported ? eq(toggleOffSilencesHit, []) : toggleOffSilencesHit === null,
    toggleOnProvesItself: supported ? eq(toggleOnBuzz, want.tap) : toggleOnBuzz === null,
    tapBuzzesOnPlay: eq(tapRun.recorded, want.tap),
    // Arming a card is not playing one, so it must not buzz. On a fine
    // pointer the first tap IS the play, and then it must.
    armingDoesNotBuzz: eq(tapRun.afterFirst, tapRun.playedOnFirst ? want.tap : []),
  };

  /* Premises only — nothing below reads a check. */
  const valid = document.body.dataset.screen === 'game'
    && idleAtStart.pointerdownsSoFar === 0
    && idleAtStart.elapsedMs >= idleAtStart.needMs
    && arrived(turnWhenIdle) && turnWhenIdle.pointerdownsDelivered === 0
    && arrived(turnAfterTouch) && turnAfterTouch.pointerdownsDelivered === 1
    /* "Immediately before" against a 4000ms window. The bound is 1000ms and
       not 250ms because the FIRST pointerdown in a document also constructs
       the AudioContext (app.js unlocks sound on every gesture), which cost
       380ms in the run that set this number. */
    && turnAfterTouch.touchToEmitMs !== null && turnAfterTouch.touchToEmitMs < 1000
    // each consequence really landed where it was aimed, and nowhere else
    && plus2OnYou.victimCards === 7 && plus2OnYou.counts.p2 === 5 && plus2OnYou.topCard === 't-plus2'
    && plus2OnBot.victimCards === 7 && plus2OnBot.counts.p1 !== 7 && plus2OnBot.topCard === 't-plus2'
    && calloutOnYou.victimCards === 3 && /CALLED OUT YOU - DRAW 2$/.test(calloutOnYou.log || '')
    && calloutOnBot.victimCards === 3 && /^YOU CALLED OUT /.test(calloutOnBot.log || '')
    && [plus2OnYou, plus2OnBot, calloutOnYou, calloutOnBot].every((r) => r.pointerdownsDelivered === 1)
    // the tap path really played a card
    && tapRun.card === true && tapRun.ready === true && tapRun.played === true;

  return JSON.stringify(Object.assign(out, {
    idleAtStart,
    turnWhenIdle, turnAfterTouch,
    plus2OnYou, plus2OnBot, calloutOnYou, calloutOnBot,
    toggle, toggleOffSilencesHit, toggleOnBuzz, tapRun,
    recorded: {
      plus2OnYou: plus2OnYou.recorded, plus2OnBot: plus2OnBot.recorded,
      calloutOnYou: calloutOnYou.recorded, calloutOnBot: calloutOnBot.recorded,
      turnWhenIdle: turnWhenIdle.recorded, turnAfterTouch: turnAfterTouch.recorded,
      toggleOffSilencesHit, toggleOnBuzz, tap: tapRun.recorded,
    },
    checks,
    pass: valid && Object.values(checks).every(Boolean),
    valid,
  }), null, 1);
})()
