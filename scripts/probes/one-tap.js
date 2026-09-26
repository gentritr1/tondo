(async () => {
  // The front door (`--scene none`): what the page does on its own between the
  // first byte and the first tap. Three modes, chosen by the URL fragment so
  // the same file serves every check and the app never sees the switch:
  //
  //   (no hash)  screen + storage after load — the invite-link auto-join
  //   #quick     One quick pie: one tap on a cold home screen to a dealt table
  //   #forget    Forget this device: the two-stage confirm, stage by stage
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

  // -------------------------------------- mode: screen + storage (default)
  const t0 = performance.now();
  // Wait up to 4s for the app to settle on a screen other than the initial home render.
  while (performance.now() - t0 < 4000 && document.body.dataset.screen === 'home'
    && new URLSearchParams(location.search).has('code') && localStorage.getItem('tondo.name')) {
    await sleep(100);
  }
  return {
    mode: 'screen',
    // The prime for this one is the page itself: the app booted and named a
    // screen, and the URL carried what the check is about.
    valid: !!document.body.dataset.screen,
    hasCodeParam: new URLSearchParams(location.search).has('code'),
    codeParam: new URLSearchParams(location.search).get('code'),
    screen: document.body.dataset.screen,
    homeCardHidden: (document.querySelector('.home-card') || {}).hidden,
    codeInput: (document.getElementById('code-input') || {}).value,
    homeMsg: txt('home-msg'),
    lobbySeats: document.querySelectorAll('#seat-list .seat-row:not(.seat-ghost)').length,
    localKeys: localKeys(), sessionKeys: sessionKeys(),
    ms: Math.round(performance.now() - t0),
  };
})()
