(async () => {
  // The front door (`--scene none`): what the page does on its own between the
  // first byte and the first tap. Four modes, chosen by the URL fragment so
  // the same file serves every check and the app never sees the switch:
  //
  //   (no hash)  an invite link WITH a seeded name: it must seat you
  //   #no-name   the same link with NO seeded name: it must NOT seat you
  //   #quick     One quick pie: one tap on a cold home screen to a dealt table
  //   #forget    Forget this device: the two-stage confirm, stage by stage
  //   #autojoin-timeout  a server that accepts the socket and never answers
  //
  // House rules, per mode:
  //  - PRIMED before anything is counted: the socket has to be open (the net
  //    banner hidden) or a click sends nothing and the probe measures the
  //    harness rather than the app.
  //  - `valid` reads only the prime's own signals — the controls existing, the
  //    socket open, the seeded keys actually present. It never reads the effect
  //    under test, so a RED run is as valid as a GREEN one; every verdict sits
  //    next to the count that produced it.
  //  - `#forget` seeds THREE keys and asserts the seeded count before the first
  //    click: "both storages are empty" over a collection that was empty all
  //    along is the vacuous pass this check exists to avoid.
  //
  // Returned as an object, not a JSON string: shoot.js pretty-prints whatever
  // the probe resolves to, and the numbers are the evidence.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tondoKeys = (get) => {
    try { return Object.keys(get()).filter((k) => k.startsWith('tondo.')).sort(); }
    catch { return null; } // storage refused us — not the same thing as empty
  };
  const localKeys = () => tondoKeys(() => localStorage);
  const sessionKeys = () => tondoKeys(() => sessionStorage);
  const txt = (id) => { const n = document.getElementById(id); return n ? n.textContent.trim() : null; };
  const mode = (location.hash || '').replace('#', '');

  // ---------------------------------------------------------------- prime
  // The socket is open once the reconnect banner is down. Everything that
  // sends a message waits for it.
  const socketOpen = async (ms) => {
    const t = performance.now();
    while (performance.now() - t < ms) {
      const b = document.getElementById('net-banner');
      if (b && b.hidden) return true;
      await sleep(50);
    }
    return false;
  };

  // --------------------------------------------------- mode: quick pie
  if (mode === 'quick') {
    const btn = document.getElementById('quickpie-btn');
    const name = document.getElementById('name-input');
    const open = await socketOpen(8000);
    const valid = !!btn && !!name && open && document.body.dataset.screen === 'home';
    if (!valid) {
      return {
        mode, valid: false,
        why: { buttonPresent: !!btn, namePresent: !!name, socketOpen: open, screen: document.body.dataset.screen },
      };
    }
    name.value = 'Gent';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    const t0 = performance.now();
    btn.click();
    let seats = 0;
    let screen = document.body.dataset.screen;
    let polls = 0;
    while (performance.now() - t0 < 10000) {
      polls++;
      screen = document.body.dataset.screen;
      seats = document.querySelectorAll('#seats .seat').length;
      if (screen === 'game' && seats === 3) break;
      await sleep(16);
    }
    const ms = Math.round(performance.now() - t0);
    return {
      mode, valid: true,
      ms, budgetMs: 2000, underBudget: ms < 2000,
      screen, opponentSeats: seats, polls,
      handCards: document.querySelectorAll('#hand-row .card').length,
      dealtInOneTap: screen === 'game' && seats === 3,
      homeMsg: txt('home-msg'),
      localKeys: localKeys(), sessionKeys: sessionKeys(),
    };
  }

  // ------------------------------------------------------- mode: forget
  if (mode === 'forget') {
    const btn = document.getElementById('forget-btn');
    // Seeded here rather than by --storage-json: the count seeded and the
    // count read back have to be the same measurement.
    const seeded = [];
    try { localStorage.setItem('tondo.name', 'Gent'); seeded.push('tondo.name'); } catch { /* no storage */ }
    try {
      localStorage.setItem('tondo.lastTable',
        JSON.stringify({ code: 'BASIL-4821', roster: ['Carmela', 'Dominic', 'Pina'], at: Date.now() }));
      seeded.push('tondo.lastTable');
    } catch { /* no storage */ }
    try { sessionStorage.setItem('tondo.room', 'BASIL-4821'); seeded.push('tondo.room'); } catch { /* no storage */ }
    const before = { localKeys: localKeys(), sessionKeys: sessionKeys() };
    // Three keys had to be THERE, or "empty afterwards" proves nothing.
    const valid = !!btn
      && seeded.length === 3
      && (before.localKeys || []).length === 2
      && (before.sessionKeys || []).length === 1;
    if (!valid) {
      return { mode, valid: false, why: { buttonPresent: !!btn, seeded, before } };
    }
    const label0 = btn.textContent.trim();
    btn.click();
    await sleep(60);
    const afterFirst = {
      localKeys: localKeys(), sessionKeys: sessionKeys(),
      label: btn.textContent.trim(), homeMsg: txt('home-msg'),
    };
    btn.click();
    await sleep(60);
    const afterSecond = {
      localKeys: localKeys(), sessionKeys: sessionKeys(),
      label: btn.textContent.trim(), homeMsg: txt('home-msg'),
    };
    const sameKeys = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    return {
      mode, valid: true,
      label0,
      before,
      beforeCounts: { local: before.localKeys.length, session: before.sessionKeys.length },
      afterFirst,
      afterFirstCounts: { local: (afterFirst.localKeys || []).length, session: (afterFirst.sessionKeys || []).length },
      afterSecond,
      afterSecondCounts: { local: (afterSecond.localKeys || []).length, session: (afterSecond.sessionKeys || []).length },
      firstTapTouchedNothing: sameKeys(before.localKeys, afterFirst.localKeys)
        && sameKeys(before.sessionKeys, afterFirst.sessionKeys),
      firstTapChangedLabel: afterFirst.label !== label0,
      secondTapWiped: (afterFirst.localKeys || []).length === 2
        && (afterSecond.localKeys || []).length === 0
        && (afterSecond.sessionKeys || []).length === 0,
      nameFieldCleared: (document.getElementById('name-input') || {}).value === '',
      lastTableHidden: (document.getElementById('last-table') || {}).hidden,
    };
  }

  // ------------------------------------------- mode: auto-join deadline
  // Paired with a server that accepts the socket and never answers joinRoom.
  // The prime is that the app really did go into the seating wait; the verdict
  // is whether it ever comes out of it.
  if (mode === 'autojoin-timeout') {
    const banner = document.getElementById('net-banner');
    const card = document.querySelector('.home-card');
    // Sample the wait itself before anything can end it.
    let sawSeatingLine = '';
    let sawCardHidden = null;
    const t0 = performance.now();
    while (performance.now() - t0 < 3000) {
      if (banner && !banner.hidden && banner.textContent.trim()) {
        sawSeatingLine = banner.textContent.trim();
        sawCardHidden = card.hidden;
        break;
      }
      await sleep(25);
    }
    // PRIME: the card was hidden and a line was showing — i.e. the app was
    // actually in the interstitial this check is about. Neither reads the
    // effect under test, which is whether it ever ENDS.
    const valid = sawCardHidden === true && !!sawSeatingLine
      && new URLSearchParams(location.search).has('code');
    if (!valid) {
      return { mode, valid: false, why: { sawSeatingLine, sawCardHidden, screen: document.body.dataset.screen } };
    }
    const t1 = performance.now();
    while (performance.now() - t1 < 14000 && card.hidden) await sleep(50);
    return {
      mode, valid: true,
      seatingLine: sawSeatingLine,
      cardHiddenDuringWait: sawCardHidden,
      recoveredMs: Math.round(performance.now() - t1),
      deadlineMs: 8000,
      homeCardVisible: card.hidden === false,
      bannerHidden: banner.hidden,
      homeMsg: txt('home-msg'),
      screen: document.body.dataset.screen,
      codeInput: (document.getElementById('code-input') || {}).value,
      controlsUsable: ['create-btn', 'quickpie-btn', 'join-btn', 'forget-btn']
        .filter((id) => { const n = document.getElementById(id); return n && n.offsetParent !== null && !n.disabled; }).length,
    };
  }

  // ------------------------- modes: an invite link, seated and not seated
  // The URL fragment DECLARES which of the two this run is, so the prime can
  // fail when the harness seeded nothing — a run with no `tondo.name` is
  // otherwise indistinguishable from the app ignoring the link entirely.
  const expectSeated = mode !== 'no-name';
  const params = new URLSearchParams(location.search);
  const hasCodeParam = params.has('code');
  let seededName = '';
  try { seededName = localStorage.getItem('tondo.name') || ''; } catch { /* no storage */ }
  const t0 = performance.now();
  // Up to 4s for the app to settle. It settles either by leaving the home
  // screen or by writing a line and handing the card back — waiting out the
  // whole budget after the second one measures nothing but the budget.
  while (performance.now() - t0 < 4000
    && document.body.dataset.screen === 'home'
    && !txt('home-msg')
    && hasCodeParam && seededName) {
    await sleep(100);
  }
  return {
    mode: expectSeated ? 'screen' : 'no-name',
    // The URL had to carry a code, and the storage had to be in the state this
    // run is about. Neither reads the screen the app settled on.
    valid: hasCodeParam && (expectSeated ? !!seededName : !seededName),
    expectSeated,
    hasCodeParam,
    codeParam: params.get('code'),
    seededNamePresent: !!seededName,
    screen: document.body.dataset.screen,
    homeCardHidden: (document.querySelector('.home-card') || {}).hidden,
    codeInput: (document.getElementById('code-input') || {}).value,
    homeMsg: txt('home-msg'),
    lobbySeats: document.querySelectorAll('#seat-list .seat-row:not(.seat-ghost)').length,
    localKeys: localKeys(), sessionKeys: sessionKeys(),
    ms: Math.round(performance.now() - t0),
  };
})()
