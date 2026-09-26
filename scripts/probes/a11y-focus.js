(async () => {
  // The four accessibility defects, on the scripted mock table
  // (`--scene mock:yourTurn`):
  //   (a) a Wild's chosen topping is missing from #top-card's aria-label, and
  //       the MATCH plaque has no role or name at all;
  //   (b) "How to play" exists on the home screen and the game strip but not
  //       in the lobby, where a new player sits waiting;
  //   (c) focus drops to <body> after picking a Wild suit, and is left on a
  //       hidden button after "Deal the cards";
  //   (d) #callout-buttons and #seat-list are rebuilt with innerHTML on every
  //       snapshot, so the node a keyboard user is standing on is thrown away
  //       — a race they cannot win, because bot snapshots never stop.
  //
  // Sealed, per the house rules for probes:
  //  - `valid` asserts only that each case's PREMISE was really set up: the
  //    mock is here, each scene was reached, the control under test existed
  //    and really held focus, the enabling control was enabled, and the
  //    snapshot that is supposed to destroy focus really was rendered (read
  //    off #deck-count and the seat count, never off focus). It never reads a
  //    check, so the RED run is exactly as valid as the GREEN one.
  //  - `checks` carries the verdicts, one boolean per defect, and every
  //    observed value is printed beside them — labels, counts, and who holds
  //    focus — so a regression is a value, not a bare false.
  //  - A missing premise makes the run INVALID, never a pass: there is no
  //    "no focusable control here" branch that reads as success.
  //
  // (b) is checked by USE, not by existence: app.js binds the help listener
  // through one delegated click handler, and a button that exists but is not
  // wired is a dead button. The probe clicks it and asserts #help-dialog is
  // open. The auto-opened dialog is checked the same way, plus where focus
  // lands when it closes — a <dialog> opened with no opener has nothing to
  // restore focus to, which is defect (c) again in the flow (b) adds.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** Bounded wait: gives up rather than hanging, and says which it did. */
  const until = async (fn, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(50); }
    return false;
  };
  const m = window.__mock;
  const $ = (id) => document.getElementById(id);
  const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const help = $('help-dialog');
  // <body> has a box, so vis(document.body) was truthy and "it landed
  // somewhere visible" said nothing at all next to "it is not <body>".
  const vis = (n) => !!n && n !== document.body
    && !!(n.offsetParent || (n.getClientRects && n.getClientRects().length));
  /** A stable name for whoever holds focus, so RED and GREEN print the same shape. */
  const who = (a) => {
    if (!a) return 'none';
    if (a === document.body) return 'BODY';
    const d = a.dataset || {};
    if (d.callout) return 'callout:' + d.callout;
    if (d.calloutSkip) return 'callout-skip';
    if (d.remove) return 'remove:' + d.remove;
    if (d.card) return 'card:' + d.card;
    if (d.suit) return 'suit:' + d.suit;
    if (d.helpOpen !== undefined) return 'help-open';
    return a.id ? '#' + a.id : a.tagName;
  };
  const seatRows = () => document.querySelectorAll('#seat-list .seat-row:not(.seat-ghost)').length;
  /* Both live regions, watched together. A post-hoc textContent read cannot
     see a clobber: #live-now is role="alert" aria-live="assertive" and
     preempts the polite region, so what matters is WHICH regions mutated in
     the same tick, not what one of them says afterwards. Timestamps are
     relative to the trigger. */
  const watchRegions = () => {
    const hits = [];
    const t0 = performance.now();
    const obs = ['live-polite', 'live-now'].map((id) => {
      const node = $(id);
      node.textContent = '';
      const o = new MutationObserver(() => hits.push({
        region: id, at: Math.round(performance.now() - t0), text: node.textContent,
      }));
      o.observe(node, { childList: true, characterData: true, subtree: true });
      return o;
    });
    return {
      stop: () => { obs.forEach((o) => { o.takeRecords().forEach(() => {}); o.disconnect(); }); return hits; },
    };
  };
  const seenHelp = (on) => {
    try {
      if (on) localStorage.setItem('tondo.seenHelp', '1');
      else localStorage.removeItem('tondo.seenHelp');
      return (localStorage.getItem('tondo.seenHelp') || '') === (on ? '1' : '');
    } catch { return false; }
  };
  if (!m || !m.goto) return JSON.stringify({ valid: false, reason: 'no window.__mock — run with --scene mock:<name>' });
  // The probe drives this key both ways; whatever it found goes back at the end.
  let seenHelpWas = false;
  try { seenHelpWas = !!localStorage.getItem('tondo.seenHelp'); } catch { seenHelpWas = false; }

  const out = { viewport: `${innerWidth}x${innerHeight}`, reducedMotion: rm };

  /* ---- (d1) a callout button keeps focus across an unrelated snapshot ---- */
  m.goto('callout');
  await sleep(350);
  const calloutBtn = document.querySelector('#callout-buttons [data-callout]');
  const callout = { barShown: !$('callout-bar').hidden, button: !!calloutBtn };
  if (calloutBtn) {
    calloutBtn.focus();
    callout.focusedBefore = 'callout:' + calloutBtn.dataset.callout;
    callout.heldFocus = document.activeElement === calloutBtn;
    const g = m.table.game;
    callout.deckBefore = $('deck-count').textContent;
    g.drawPileCount = g.drawPileCount - 1;          // an unrelated change
    m.emit(m.snapshot());
    await sleep(250);
    callout.deckAfter = $('deck-count').textContent;
    // The repaint that is supposed to destroy focus demonstrably happened.
    callout.snapshotRendered = callout.deckAfter !== callout.deckBefore
      && callout.deckAfter === String(g.drawPileCount);
    callout.buttonsStill = document.querySelectorAll('#callout-buttons [data-callout]').length;
    callout.activeAfter = who(document.activeElement);

    // And when the bar closes UNDER the keyboard. "Let it pass" is the
    // synchronous half of that transition (the same `leavingCallout` branch
    // the answering snapshot takes after "Call out X"), so it is the one a
    // probe can watch without arming a scene timer.
    const pass = document.querySelector('#callout-buttons [data-callout-skip]');
    callout.skipButton = !!pass;
    if (pass) {
      pass.focus();
      callout.skipHeldFocus = document.activeElement === pass;
      pass.click();
      await sleep(350);
      const a = document.activeElement;
      callout.barHiddenAfterPass = $('callout-bar').hidden;
      callout.activeAfterPass = who(a);
      callout.passLandsOnHandOrDraw = !!(a && ((a.classList && a.classList.contains('card')) || a.id === 'draw-btn'));
      callout.passLandsVisible = vis(a);
    }
  }

  /* ---- (a) the top card names a Wild's topping; the plaque has a name ---- */
  await m.transition('wild', { seats: 4 });
  await sleep(300);
  const mg = m.table.game;
  const topCard = {
    // The premise comes from the MODEL, never from the label under test.
    modelValue: mg.topCard && mg.topCard.value,
    modelSuit: mg.activeSuit,
    label: $('top-card').getAttribute('aria-label'),
    role: $('top-card').getAttribute('role'),
  };
  const plaque = {
    role: $('plaque').getAttribute('role'),
    label: $('plaque').getAttribute('aria-label'),
    text: $('plaque').textContent.replace(/\s+/g, ' ').trim(),
  };

  /* ---- (b) "How to play" in the lobby, and it must WORK ---- */
  // The auto-open is tested on its own below; suppress it here so the modal
  // cannot sit inert over the seat-list test.
  const suppressed = seenHelp(true);
  const lobbyWatch = watchRegions();
  m.goto('lobby');
  await sleep(400);
  const lobbyShown = document.body.dataset.screen === 'lobby';
  const lobbyRegions = lobbyWatch.stop();
  const lobbyLine = $('live-polite').textContent;
  const helpBtn = document.querySelector('#screen-lobby [data-help-open]');
  const lobbyHelp = { present: !!helpBtn, text: helpBtn ? helpBtn.textContent.trim() : null, opened: false, afterClose: null };
  if (helpBtn) {
    helpBtn.focus();
    lobbyHelp.heldFocus = document.activeElement === helpBtn;
    helpBtn.click();
    await sleep(250);
    lobbyHelp.opened = !!help.open;
    if (help.open) { help.close(); await sleep(200); }
    lobbyHelp.afterClose = who(document.activeElement);
  }

  /* ---- (d2) the lobby seat list keeps focus when a bot is added ---- */
  // "Add bot" on a full table is disabled, and a click that does nothing
  // proves nothing: free a seat first so the snapshot under test is real.
  const lobby = { seatsAtEntry: seatRows(), addWasDisabled: $('addbot-btn').disabled };
  if ($('addbot-btn').disabled) {
    const last = [...document.querySelectorAll('#seat-list [data-remove]')].pop();
    if (last) { last.click(); await sleep(400); }
  }
  lobby.addEnabled = !$('addbot-btn').disabled;
  const seatBtn = document.querySelector('#seat-list [data-remove]');
  lobby.button = !!seatBtn;
  if (seatBtn) {
    seatBtn.focus();
    lobby.focusedBefore = 'remove:' + seatBtn.dataset.remove;
    lobby.heldFocus = document.activeElement === seatBtn;
    lobby.seatsBefore = seatRows();
    $('addbot-btn').click();
    await sleep(500);
    lobby.seatsAfter = seatRows();
    // The list really was rebuilt for a seat that is still there.
    lobby.listRebuilt = lobby.seatsAfter === lobby.seatsBefore + 1;
    lobby.survivorStillListed = !!document.querySelector(`#seat-list [data-remove="${seatBtn.dataset.remove}"]`);
    lobby.activeAfter = who(document.activeElement);
    const a = document.activeElement;
    lobby.stillInList = !!(a && a.closest && a.closest('#seat-list'));

    // The other half of the same rescue: the seat you are standing on is the
    // one that leaves. There is no surviving node to go back to, so it has to
    // walk to a neighbour.
    const last = [...document.querySelectorAll('#seat-list [data-remove]')].pop();
    lobby.departing = last ? 'remove:' + last.dataset.remove : null;
    if (last) {
      last.focus();
      lobby.departingHeldFocus = document.activeElement === last;
      lobby.seatsBeforeRemove = seatRows();
      last.click();
      await sleep(500);
      lobby.seatsAfterRemove = seatRows();
      lobby.seatDeparted = lobby.seatsAfterRemove === lobby.seatsBeforeRemove - 1
        && !document.querySelector(`#seat-list [data-remove="${last.dataset.remove}"]`);
      const b = document.activeElement;
      lobby.activeAfterRemove = who(b);
      lobby.removeLandsSomewhereReal = vis(b) && !!(b.dataset.remove || b.id === 'addbot-btn');
    }
  }

  /* ---- (c1) focus and the arrival announcement after "Deal the cards" ---- */
  // You open: the assertive turn alert fires in the same synchronous snapshot
  // as the screen swap, so only ONE of the two regions may speak.
  const start = $('start-btn');
  const deal = { enabled: !start.disabled };
  start.focus();
  deal.heldFocus = document.activeElement === start;
  const dealWatch = watchRegions();
  start.click();
  await sleep(600);
  deal.regions = dealWatch.stop();
  deal.screen = document.body.dataset.screen;
  deal.activeAfter = who(document.activeElement);
  deal.activeVisible = vis(document.activeElement);
  deal.isBody = document.activeElement === document.body;
  deal.liveLine = $('live-polite').textContent;
  deal.alertLine = $('live-now').textContent;
  deal.yourTurn = m.table.game.turnPlayerId === 'p1';

  /* ---- the other arrival: somebody else opens ---- */
  // Same screen swap, no turn alert — here the polite orientation line is the
  // only thing that can carry the arrival, so it must still fire. Built by
  // hand out of the scene's own game rather than with a scripted scene,
  // because those arm timers that would move the table under later steps.
  const opener = JSON.parse(JSON.stringify(m.table.game));
  opener.turnPlayerId = 'p2';
  opener.playableCardIds = [];
  m.goto('lobby');
  await sleep(450);
  const elsewhere = { fromLobby: document.body.dataset.screen === 'lobby' };
  const elseWatch = watchRegions();
  m.table.phase = 'playing';
  m.table.game = opener;
  m.emit(m.snapshot());
  await sleep(500);
  elsewhere.regions = elseWatch.stop();
  elsewhere.screen = document.body.dataset.screen;
  elsewhere.turnPlayerId = m.table.game.turnPlayerId;
  elsewhere.politeLine = $('live-polite').textContent;

  /* ---- (b2) the auto-opened dialog must not strand focus ---- */
  const cleared = seenHelp(false);
  m.goto('yourTurn');
  await sleep(250);
  const wasGame = document.body.dataset.screen === 'game';
  m.goto('lobby');
  await sleep(500);
  const auto = {
    cleared, wasGame, screen: document.body.dataset.screen,
    opened: !!help.open, whileOpen: who(document.activeElement),
  };
  if (help.open) { help.close(); await sleep(250); }
  auto.afterClose = who(document.activeElement);
  auto.afterCloseIsBody = document.activeElement === document.body;
  auto.afterCloseVisible = vis(document.activeElement);
  const ac = document.activeElement;
  auto.afterCloseInLobby = !!(ac && ac.closest && ac.closest('#screen-lobby'));

  // The same dialog with NOTHING focused behind it — the degenerate case the
  // auto-open would hit if the screen swap had not already parked focus on the
  // heading. This is the branch that must not leave the player on <body>.
  const orphan = {};
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  orphan.focusBefore = who(document.activeElement);
  help.showModal();
  await sleep(200);
  orphan.opened = !!help.open;
  help.close();
  await sleep(250);
  orphan.afterClose = who(document.activeElement);
  orphan.afterCloseIsBody = document.activeElement === document.body;

  // An auto-opened modal must not survive the screen under it: the host can
  // deal while a new player is still reading, and a `--scene game` capture
  // caught exactly that — the rules sitting over a dealt hand on their turn.
  const handover = { cleared: seenHelp(false) };
  m.goto('yourTurn');
  await sleep(250);
  m.goto('lobby');
  await sleep(500);
  handover.openedInLobby = !!help.open;
  m.goto('yourTurn');                       // the host deals while it is open
  await sleep(500);
  handover.screen = document.body.dataset.screen;
  handover.stillOpen = !!help.open;
  handover.activeAfter = who(document.activeElement);

  /* ---- (c2) focus after picking a Wild suit ---- */
  m.goto('wild');
  await sleep(400);
  const wild = {};
  // Coming out of the lobby the hand is DEALT: every card is `inert` until its
  // own rise begins (the last of six lands ~2s in), a tap on one is refused by
  // design, and an inert card cannot take focus either. A human cannot reach
  // the picker before the deal lands, so the probe does not pretend to —
  // clicking early once produced an empty picker and a vacuous "no suit
  // button" result. The wait is bounded and its outcome is a premise.
  wild.handSettled = await until(
    () => [...document.querySelectorAll('#hand-row .card')].every((n) => !n.inert), 4000);
  const wildCard = document.querySelector('#hand-row [data-card="w2"]');
  wild.card = !!wildCard;
  wild.cardReady = !!wildCard && !wildCard.inert;
  if (wildCard) {
    wildCard.click();                       // a coarse pointer needs two taps
    await sleep(300);
    if ($('wild-bar').hidden) { wildCard.click(); await sleep(300); }
  }
  wild.pickerOpen = !$('wild-bar').hidden;
  const suitBtn = document.querySelector('#wild-grid [data-suit]');
  wild.suitButton = !!suitBtn;
  if (suitBtn) {
    wild.suitName = suitBtn.getAttribute('aria-label');
    suitBtn.focus();
    wild.heldFocus = document.activeElement === suitBtn;
    suitBtn.click();
    // Straight after the click, before the played snapshot lands: did the
    // picker itself hand focus back, or was the player dropped on <body>?
    wild.atClick = who(document.activeElement);
    await sleep(800);
    const a = document.activeElement;
    wild.handShown = !$('hand-wrap').hidden;
    wild.cardsInHand = document.querySelectorAll('#hand-row .card').length;
    wild.activeAfter = who(a);
    wild.activeVisible = vis(a);
    wild.isCardOrDraw = !!(a && ((a.classList && a.classList.contains('card')) || a.id === 'draw-btn'));
  }

  // Put the player's own storage back the way this run found it.
  seenHelp(seenHelpWas);

  /* ---- the accessible names/roles this run read out of the DOM ---- */
  const nameOf = (n) => (!n ? null : (n.getAttribute('aria-label') || n.textContent.replace(/\s+/g, ' ').trim()));
  const names = {
    topCard: { role: topCard.role, name: topCard.label },
    plaque: { role: plaque.role, name: plaque.label },
    titles: ['home-title', 'lobby-title', 'game-title'].map((id) => ({
      id, tabindex: $(id) && $(id).getAttribute('tabindex'), name: nameOf($(id)),
    })),
    calloutButton: callout.focusedBefore ? nameOf(document.querySelector('#callout-buttons [data-callout]')) : null,
    suitButtons: [...document.querySelectorAll('#wild-grid [data-suit]')].map(nameOf),
    lobbyHelp: lobbyHelp.present ? nameOf(document.querySelector('#screen-lobby [data-help-open]')) : null,
    plaqueGlyphs: ['dir-badge', 'match-glyph', 'dir-glyph'].map((id) => ({
      id, glyph: $(id).textContent, hidden: $(id).getAttribute('aria-hidden') === 'true',
    })),
    plaqueReads: [...$('plaque').querySelectorAll('span')]
      .filter((n) => n.getAttribute('aria-hidden') !== 'true' && n.textContent.trim())
      .map((n) => n.textContent.trim()),
    helpFlipLine: (() => {
      const li = [...document.querySelectorAll('.help-list li')].find((n) => /skip/i.test(n.textContent));
      return li ? li.textContent.replace(/\s+/g, ' ').trim() : null;
    })(),
  };

  const checks = {
    // (a)
    topCardNamesTopping: topCard.label === 'Top card: Wild, topping is anchovy',
    plaqueNamed: plaque.role === 'group' && plaque.label === 'Match requirement',
    // (b)
    lobbyHelpWorks: lobbyHelp.present && lobbyHelp.opened === true,
    helpAutoOpens: auto.opened === true,
    helpAutoOpenKeepsFocus: auto.opened === true && auto.afterCloseIsBody === false
      && auto.afterCloseVisible === true && auto.afterCloseInLobby === true,
    helpNamesFlip: typeof names.helpFlipLine === 'string' && /⇄ Flip/.test(names.helpFlipLine)
      && /acts as a Skip/.test(names.helpFlipLine) && !/↻ Reverse/.test(names.helpFlipLine),
    // The card prints F / FLIP; the help must not call it something else.
    openerlessHelpKeepsFocus: orphan.opened === true && orphan.afterCloseIsBody === false
      && orphan.afterClose === 'help-open',
    autoHelpLeavesWithTheLobby: handover.openedInLobby === true && handover.stillOpen === false
      && handover.activeAfter === '#game-title',
    // (c)
    dealFocusLandsSomewhereReal: deal.isBody === false && deal.activeVisible === true,
    // One arrival, one announcement: the assertive alert speaks, the polite
    // orientation line stands down rather than being clobbered by it.
    arrivalAnnouncedOnce: deal.regions.length > 0
      && deal.regions.every((r) => r.region === 'live-now')
      && /^Your turn\. \d+ playable\.$/.test(deal.alertLine),
    // And when nobody alerts, the polite line is still the one that carries it.
    arrivalLineWhenNotYours: elsewhere.regions.length > 0
      && elsewhere.regions.every((r) => r.region === 'live-polite')
      && elsewhere.politeLine === 'Game started.',
    wildFocusLandsOnHand: wild.isCardOrDraw === true && wild.activeVisible === true,
    calloutBarLandsOnHand: callout.barHiddenAfterPass === true
      && callout.passLandsOnHandOrDraw === true && callout.passLandsVisible === true,
    // The lobby has no assertive line of its own, so the polite orientation
    // line is the arrival — and it must be the only thing that speaks.
    lobbyLineAnnounced: lobbyRegions.length > 0
      && lobbyRegions.every((r) => r.region === 'live-polite')
      && lobbyLine === 'Lobby for table BASIL-4821.',
    // (d)
    calloutKeepsFocus: callout.activeAfter === callout.focusedBefore,
    seatListKeepsFocus: lobby.activeAfter === lobby.focusedBefore && lobby.stillInList === true,
    departedSeatHandsFocusOn: lobby.removeLandsSomewhereReal === true,
    // The plaque names the group; the glyphs inside it are decoration that the
    // words beside them already carry.
    plaqueGlyphsHidden: names.plaqueGlyphs.every((g) => g.hidden === true),
    // titles have to be focusable for (c) to have anywhere to land
    titlesFocusable: names.titles.every((t) => t.tabindex === '-1'),
  };

  // Premises only. Nothing here reads a check, so RED is as valid as GREEN.
  const valid = callout.barShown && callout.button && callout.heldFocus === true
    && callout.snapshotRendered === true && callout.buttonsStill >= 1
    && topCard.modelValue === 'WILD' && topCard.modelSuit === 'anchovy'
    && suppressed && lobbyShown
    && lobby.button && lobby.heldFocus === true && lobby.addEnabled === true
    && lobby.listRebuilt === true && lobby.survivorStillListed === true
    && callout.skipButton === true && callout.skipHeldFocus === true
    && deal.enabled === true && deal.heldFocus === true && deal.screen === 'game'
    && deal.yourTurn === true
    && elsewhere.fromLobby === true && elsewhere.screen === 'game'
    && elsewhere.turnPlayerId === 'p2'
    && lobby.departing !== null && lobby.departingHeldFocus === true
    && lobby.seatDeparted === true
    && auto.cleared === true && auto.wasGame === true && auto.screen === 'lobby'
    && orphan.focusBefore === 'BODY'
    && handover.cleared === true && handover.screen === 'game'
    && wild.handSettled === true && wild.card === true && wild.cardReady === true
    && wild.pickerOpen === true && wild.suitButton === true
    && wild.heldFocus === true && wild.handShown === true && wild.cardsInHand > 0;

  return JSON.stringify(Object.assign(out, {
    callout, topCard, plaque, lobbyShown, lobbyLine, lobbyRegions, lobbyHelp, lobby, deal, elsewhere,
    auto, orphan, handover, wild, names,
    checks,
    pass: valid && Object.values(checks).every(Boolean),
    valid,
  }), null, 1);
})()
