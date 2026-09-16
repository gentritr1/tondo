# Tondo Tier 2 + Tier 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish everything `docs/NEXT-LEVEL.md` leaves open: rules fixes, bots you can catch, readable action cards at every table size, motion for the remaining silent events, a round boundary that looks like one, one-tap joining, the four accessibility defects, phone haptics, sharing a finished pie, and screenshot checks that fail on regression.

**Architecture:** The server stays authoritative (`server/game.js` rules, `server/rooms.js` clocks and bots). The client repaints from snapshots; one-shot effects are derived from snapshot deltas by `public/js/events.js` and fired imperatively by a new `public/js/fx.js`, never as classes written into render output. Every visual claim is verified with `scripts/shoot.js` (headless Chrome over CDP) against a pre-fix reproduction.

**Tech Stack:** Node ≥18 (v20.19 in use), the `ws` package, browser-native ES modules, plain CSS, WebAudio. No build step, no bundler, no framework.

**Spec:** `docs/NEXT-LEVEL.md` (§3 Tier 2 and Tier 3, §6 Still open). Background research with the measurements quoted below lives in the git-ignored `.superpowers/research/` (read it only for background; every value you need is in your task).

## Global Constraints

- No build step, no bundler, no new runtime dependency. The only runtime dependency is `ws`.
- No accounts, no server database. Browser persistence only, every key prefixed `tondo.`, every `localStorage`/`sessionStorage` read and write wrapped in its own `try { } catch { }`. Reads go field by field against defaults; never wipe or reset a stored value because it failed to parse.
- The server is authoritative. Any change to rules or wire behaviour updates `PROTOCOL.md` in the same commit.
- WCAG 2.2 AA. Touch targets ≥ 44×44px. `node scripts/check-contrast.js` must exit 0.
- Reduced motion keeps meaning: anything that moves under normal motion must still be communicated under `prefers-reduced-motion: reduce`, through words, a live region, or a fade.
- One-screen play loop: no vertical page scroll during play on a 360×640 phone.
- Brand: "a lively neighbourhood game night". No screen shake, no casino spectacle, no dense HUD, no information carried by colour alone.
- Motion rules, all learned the hard way in this repo:
  - Fire one-shots imperatively at the node that exists now (the `pulse(el, className, ms)` / `popSeat(id)` pattern in `public/js/app.js`). Never write an animation class into render output — that is how a vulnerable seat's alarm replayed on every repaint.
  - A card's transform is composed from four custom properties; new card motion rides a registered `@property` or WAAPI with `composite: 'add'`, never a raw `transform` keyframe on `.card`.
  - `.banner` keyframes replace its own transform: every frame keeps the `translate(-50%,0) … rotate(-2deg)` anchor, or the banner teleports off-centre. Move the banner with `top`/`bottom`, never by editing those transforms.
  - New layers in the table centre go inside `.sauce`; never animate `.plaque`, `.pile`, `#top-card` or `.dir` boxes (the ledger holds geometry while those animate).
  - One-shots describing a played card are scheduled at the impact frame: `MS.flight` (260ms) after the snapshot when a flight is in the air, 0 otherwise — the same delay `ledgerAdd` and `sound.playForEvents` already use.
  - Flight and deal ghosts are appended to `document.body`, not the stage.
- Sound: exactly one voice per snapshot (`sound.playForEvents`). Visual consequences follow the same priority: what happened TO someone (callout, +2, skip) outranks what was played, which outranks whose turn it is.
- Verification rules:
  - Visual and motion claims come only from `scripts/shoot.js` (headless Chrome, asserts `document.hidden === false`). Never from the Browser pane.
  - Every probe prints the count of the thing that was supposed to happen next to its verdict; a probe that observed nothing is INVALID, not a pass.
  - Reproduce the failure BEFORE fixing (RED), then show it fixed (GREEN), with the same probe.
- Running a server: use your task's own port, never 4600 (the user's preview) and never `pkill -f "server/index.js"` (it kills other people's servers). Start: `PORT=47NN node server/index.js > /tmp/tondo-47NN.log 2>&1 & echo $! > /tmp/tondo-47NN.pid`. Stop: `kill "$(cat /tmp/tondo-47NN.pid)"`. Point the harness at it with `TONDO_URL=http://localhost:47NN`. NN is your task number, zero-padded (Task 3 → 4703).
- Tests: `npm test` must be green before every commit. `PORT=47NN npm run smoke` must be green for any task touching `server/`.
- Commits: branch `next-level` (already checked out). Every commit message ends with the line `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Do not edit `docs/NEXT-LEVEL.md` or `.superpowers/research/` — the controller owns them.

## Out of scope for this plan

Deliberate, so nobody mistakes them for forgotten:
- **The local chef profile** (spec Tier 3). The judged research this spec is built on rejected a local progression layer twice, and recommended explicitly that the solo warm-up table carry no stats or record. Not built; flagged to the user.
- **Wedge-tone recolour and a table-cloth plane** (art audit). Taste decisions that close on the user's eye, not on a diff.
- **A full keyboard-play trace** (spec §6). Task 8 fixes the four verified focus and labelling defects; an end-to-end keyboard trace remains open afterwards.
- The warm-ground palette named as undecided in spec §6 already shipped in the baseline commit (`c7922d9`); that spec line is stale and the controller updates it.

## Harness quick reference

```bash
# a live bot game, stop at a scene, run a probe expression, print its JSON result
TONDO_URL=http://localhost:47NN node scripts/shoot.js --scene game --w 1440 --h 900 --probe "$(cat scripts/probes/<file>.js)"
# the scripted mock client (no server logic), pinned to a scene
TONDO_URL=http://localhost:47NN node scripts/shoot.js --scene mock:callout --w 360 --h 640 --probe "..."
# write a screenshot
TONDO_URL=http://localhost:47NN node scripts/shoot.js --out /tmp/shots --scene mock:roundOver --w 390 --h 844 --tag x
# reduced motion
... --reduced
```

Scenes: `home`, `lobby`, `game`, `roundOver`, `pieComplete` (live bot games) and `mock:<name>` where `<name>` is a key of `SCENES` in `public/js/mock.js`. In mock mode, `window.__mock` exposes `goto(name)`, `emit(snapshot)`, `snapshot()` and `table`.

A probe is a JavaScript expression evaluated in the page; it may be an async IIFE and must return a JSON string.

---

### Task 1: Rules — round end, the two-player escape, the start card, and who opens

**Files:**
- Modify: `server/game.js` (`dealTo`, `drawCard`, `endRound`, `callOut`, `viewFor`, `createGame`)
- Modify: `server/rooms.js` (`reconcileCallouts`, `startRound`)
- Modify: `public/js/app.js` (`renderGame`: the `showCallout` expression)
- Modify: `PROTOCOL.md` (Game summary: TONDO call bullet, Round over bullet)
- Test: `test/rules.test.js`, `test/rooms.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `game.pickStartCard(drawPile)` → returns the first number card, cycling non-numbers to the bottom; throws `Error('The deck has no number card to start on.')` if the pile holds no number card.
  - Callout eligibility is now `p.vulnerable` alone (no hand-size condition) in `callOut`, `viewFor().calloutTargets` and `Room.reconcileCallouts`. Task 2 relies on this.
  - `Room.lastStarterId` / `Room.lastStarterIndex` replace the modulo rotation.

Four defects, all verified by the structure audit:

1. **The callout bar survives round over.** `endRound()` never clears `vulnerable`, so `calloutTargets` stays populated at `roundOver`; the client shows the bar beside the scoreboard and every tap is refused with "The round is over."
2. **A missed TONDO can be erased at two players.** A SKIP or REVERSE played as the second-to-last card returns the turn to the same player while they are vulnerable. They draw one card, `dealTo` clears `vulnerable` because the hand grew past one, and the callout window closes before the opponent (a bot waits 1400ms) can act. Ruling already made: this escape is unintended. A voluntary draw by the vulnerable player on their own turn no longer ends vulnerability; only the start of their next turn, an involuntary deal (+2 or callout penalty) or round end does.
3. **The start-card loop is unbounded** — it spins forever on a deck with no number card. Unreachable with today's deck, unsafe the moment `buildDeck` or `HAND_SIZE` changes.
4. **Who opens drifts.** `startIndex: this.roundCount++ % this.seats.length` assumes a fixed seat count, but seats may join or leave between rounds. Rotate by seat identity instead.

Not in scope (documented, not changed): a player who declared at two cards, played to one and drew back to two stays declared — accepted as fair; the stalemate path is unreachable with the 68-card deck.

- [ ] **Step 1: Write the failing tests** — append to `test/rules.test.js`, before the runner's final `if (failures.length)` block:

```js
// ---------------------------------------------------------------------------
// Round end, the two-player escape, the start card
// ---------------------------------------------------------------------------

test('round end clears every TONDO flag, so no callout survives into roundOver', () => {
  const state = game.createGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], { seed: 21 });
  const b = game.findPlayer(state, 'b');
  b.hand = b.hand.slice(0, 1);
  b.vulnerable = true;
  b.declaredTondo = false;
  const mover = game.currentPlayer(state);
  const win = { id: 'w-end', suit: game.topCard(state).suit, value: '3' };
  mover.hand = [win];
  assert(game.playCard(state, mover.id, win.id).ok, 'winning play');
  assert(state.status === 'roundOver', 'round over');
  for (const p of state.players) {
    assert(p.vulnerable === false, `${p.id} vulnerable cleared`);
    assert(p.declaredTondo === false, `${p.id} declaration cleared`);
  }
  const viewA = game.viewFor(state, 'a');
  assert(viewA.calloutTargets.length === 0, `no callout targets at round over, got ${JSON.stringify(viewA.calloutTargets)}`);
});

test('TWO PLAYERS: drawing does not erase a missed TONDO', () => {
  const state = game.createGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { seed: 22 });
  const a = game.findPlayer(state, 'a');
  state.turnIndex = state.players.findIndex((p) => p.id === 'a');
  const top = game.topCard(state);
  const skip = { id: 'skip-a', suit: top.suit, value: 'SKIP' };
  const last = { id: 'last-a', suit: top.suit === 'basil' ? 'cheese' : 'basil', value: top.value === '9' ? '8' : '9' };
  a.hand = [skip, last];
  a.declaredTondo = false;
  assert(game.playCard(state, 'a', skip.id).ok, 'SKIP as the second-to-last card');
  assert(game.currentPlayer(state).id === 'a', 'the turn came straight back to A');
  assert(a.vulnerable === true, 'A missed TONDO');
  // Force a draw A cannot play (not the SKIP's suit, not a SKIP), so the turn
  // moves on instead of lingering on a drawn-card decision.
  const otherSuit = game.SUITS.find((suit) => suit !== top.suit);
  state.drawPile.push({ id: 'unplayable', suit: otherSuit, value: '0' });
  const drew = game.drawCard(state, 'a');
  assert(drew.ok, `draw accepted: ${drew.error}`);
  assert(a.hand.length === 2, `A holds two cards, holds ${a.hand.length}`);
  assert(a.vulnerable === true, 'a voluntary draw must NOT end the vulnerability');
  assert(game.viewFor(state, 'b').calloutTargets.includes('a'), 'B can still see A as a target');
  const caught = game.callOut(state, 'b', 'a');
  assert(caught.ok, `B's callout accepted: ${caught.error}`);
  assert(a.hand.length === 4, `A drew the two-card penalty, holds ${a.hand.length}`);
  assert(a.vulnerable === false, 'and the penalty closes the window');
});

test('an involuntary +2 still ends vulnerability, as before', () => {
  const state = game.createGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], { seed: 23 });
  const b = game.findPlayer(state, 'b');
  b.hand = b.hand.slice(0, 1);
  b.vulnerable = true;
  state.turnIndex = state.players.findIndex((p) => p.id === 'a');
  const a = game.findPlayer(state, 'a');
  const plus2 = { id: 'p2-a', suit: game.topCard(state).suit, value: 'PLUS2' };
  a.hand.push(plus2);
  assert(game.playCard(state, 'a', plus2.id).ok, '+2 on B');
  assert(b.vulnerable === false, 'the +2 ended it');
});

test('pickStartCard returns a number and cycles actions to the bottom', () => {
  const pile = [
    { id: 'n1', suit: 'basil', value: '5' },
    { id: 's1', suit: 'basil', value: 'SKIP' },
    { id: 'w1', suit: null, value: 'WILD' },
  ];
  const first = game.pickStartCard(pile);
  assert(first.id === 'n1', `picked ${first.id}`);
  assert(pile.length === 2 && pile[0].id === 'w1' && pile[1].id === 's1', `non-numbers went to the bottom: ${pile.map((c) => c.id)}`);
});

test('pickStartCard throws instead of spinning on a deck with no number', () => {
  const pile = [{ id: 's1', suit: 'basil', value: 'SKIP' }, { id: 'w1', suit: null, value: 'WILD' }];
  let threw = null;
  try { game.pickStartCard(pile); } catch (err) { threw = err; }
  assert(threw && /no number card/.test(threw.message), `threw: ${threw && threw.message}`);
});
```

Append to `test/rooms.test.js`, before its runner's final block (it already has `fakeSocket` and `RoomManager` in scope):

```js
test('the opening seat rotates by identity, surviving a seat leaving between rounds', () => {
  const manager = new RoomManager();
  const { room } = manager.createRoom('Host', fakeSocket());
  room.addSeat({ name: 'B1', isBot: true });
  room.addSeat({ name: 'B2', isBot: true });
  const [s0, s1, s2] = room.seats.map((s) => s.id);
  const opener = () => room.game.players[room.game.turnIndex].id;

  assert(room.startRound().ok, 'round 1');
  eq(opener(), s0, 'round 1 opens with seat 0');
  room.phase = 'roundOver';
  assert(room.startRound().ok, 'round 2');
  eq(opener(), s1, 'round 2 opens with seat 1');
  room.phase = 'roundOver';
  room.removeSeat(s1); // the last opener leaves
  assert(room.startRound().ok, 'round 3');
  eq(opener(), s2, 'round 3 opens with the seat that followed the one who left');
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node test/rules.test.js; node test/rooms.test.js`
Expected: FAIL — "no callout targets at round over", "a voluntary draw must NOT end the vulnerability", "game.pickStartCard is not a function", and the rotation test failing on round 3 (or a different opener). Record the exact failure lines for your report.

- [ ] **Step 3: Implement the engine changes in `server/game.js`**

`dealTo` gains an option so a voluntary draw leaves vulnerability alone:

```js
/** Gives `count` cards to a player. Returns the cards actually dealt.
 *  `voluntary` marks a draw the player chose on their own turn: it does not end
 *  a missed-TONDO window (at two players the turn can come straight back to a
 *  vulnerable player, and drawing used to be a free escape). Cards forced on a
 *  player — a +2, a callout penalty — still end it. */
function dealTo(state, player, count, { voluntary = false } = {}) {
  const dealt = [];
  for (let i = 0; i < count; i++) {
    if (state.drawPile.length === 0 && !refillDrawPile(state)) break;
    dealt.push(state.drawPile.pop());
  }
  player.hand.push(...dealt);
  // A bigger hand is no longer one card away, and past two the declaration is
  // spent: both flags follow the hand, never the other way round.
  if (player.hand.length > 1 && !voluntary) player.vulnerable = false;
  if (player.hand.length > 2) player.declaredTondo = false;
  return dealt;
}
```

In `drawCard`, change `const dealt = dealTo(state, player, 1);` to `const dealt = dealTo(state, player, 1, { voluntary: true });`.

In `endRound`, directly after `state.drawnCard = null;` add:

```js
  // Nothing about TONDO outlives the round: a flag left standing here kept the
  // callout bar on screen beside the scoreboard, and every tap on it was refused.
  for (const p of state.players) {
    p.vulnerable = false;
    p.declaredTondo = false;
  }
```

`endRound` computes `roundResult` from hands, not flags, so this may sit before or after that computation; put it before.

In `callOut`, replace `if (!target.vulnerable || target.hand.length !== 1) {` with `if (!target.vulnerable) {`.

In `viewFor`, replace the `calloutTargets` filter `(p) => p.id !== playerId && p.vulnerable && p.hand.length === 1` with `(p) => p.id !== playerId && p.vulnerable`.

Add `pickStartCard` above `createGame`, and use it inside `createGame` in place of the `let first = …; while (!isNumber(first)) {…}` block:

```js
/**
 * The starting card must be a number: an action card with nobody to act on is
 * a rule nobody wants to write down. Non-numbers go back to the bottom. Bounded
 * by the pile's length, so a deck with no number card throws instead of
 * spinning forever.
 */
function pickStartCard(drawPile) {
  for (let tries = 0; tries <= drawPile.length; tries++) {
    const card = drawPile.pop();
    if (isNumber(card)) return card;
    drawPile.unshift(card);
  }
  throw new Error('The deck has no number card to start on.');
}
```

Inside `createGame`: `const first = pickStartCard(state.drawPile);` then the existing `state.discardPile.push(first); state.activeSuit = first.suit;`.

Export `pickStartCard` from the module's `module.exports` list.

- [ ] **Step 4: Implement the room changes in `server/rooms.js`**

In `reconcileCallouts`, replace the filter `(p) => !p.left && p.vulnerable && p.hand.length === 1` with `(p) => !p.left && p.vulnerable`.

In the `Room` constructor add, beside `this.roundCount = 0;`:

```js
    // Who opened the last round, by seat id. Rotating by index broke whenever
    // a seat joined or left between rounds, because the modulus base moved.
    this.lastStarterId = null;
    this.lastStarterIndex = 0;
```

In `startRound`, replace `{ startIndex: this.roundCount++ % this.seats.length }` with a computed `startIndex`, declared just before `this.game = game.createGame(`:

```js
    const ids = this.seats.map((s) => s.id);
    const previous = ids.indexOf(this.lastStarterId);
    let startIndex = 0;
    if (previous >= 0) startIndex = (previous + 1) % ids.length;
    // The last opener left: whoever now sits in their place is next.
    else if (this.lastStarterId) startIndex = this.lastStarterIndex % ids.length;
    this.lastStarterId = ids[startIndex];
    this.lastStarterIndex = startIndex;
    this.roundCount++;
```

and pass `{ startIndex }`.

- [ ] **Step 5: Client belt-and-braces in `public/js/app.js`**

In `renderGame`, the line `const showCallout = targets.length > 0 && app.calloutDismissed !== targetKey;` becomes `const showCallout = !over && targets.length > 0 && app.calloutDismissed !== targetKey;` (`over` is already declared at the top of `renderGame`).

- [ ] **Step 6: Update `PROTOCOL.md`**

Replace the Game summary's **TONDO call** bullet text after "(any time before playing down to 1)." with:

> If a player reaches 1 card without having declared, they are *vulnerable* until the start of their next turn; any other player may `callout` them → the vulnerable player draws 2 and is no longer vulnerable. Cards forced on a player (a `PLUS2`, a callout penalty) also end the vulnerability; a card they choose to draw on their own turn does not — at two players a SKIP or REVERSE can hand the turn straight back to a vulnerable player, and drawing used to erase the miss. Callout eligibility is the vulnerable flag alone, so at two players a target can briefly hold two cards. Declaring resets when the hand grows above 2. Round end clears every TONDO flag.

Replace "The host deals again; the opening seat rotates by one each round." in the **Round over** bullet with "The opening seat moves to the seat after the previous opener each round, tracked by seat so a player joining or leaving between rounds does not skip or repeat anyone."

- [ ] **Step 7: Run everything**

Run: `npm test`
Expected: all suites pass, including the five new rules tests and the rotation test.

Run the smoke test against your own server:
```bash
PORT=4701 node server/index.js > /tmp/tondo-4701.log 2>&1 & echo $! > /tmp/tondo-4701.pid
sleep 1; PORT=4701 npm run smoke; kill "$(cat /tmp/tondo-4701.pid)"
```
Expected: `TABLE SMOKE PASS` and the host smoke prints a winner.

- [ ] **Step 8: Commit**

```bash
git add server/game.js server/rooms.js public/js/app.js PROTOCOL.md test/rules.test.js test/rooms.test.js
git commit -m "Rules: clear TONDO flags at round end, close the two-player draw escape, bound the start card, rotate openers by seat

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Bots that can be caught

**Files:**
- Modify: `server/bot.js`
- Modify: `server/rooms.js` (`scheduleTimers`, `reconcileCallouts` call sites)
- Modify: `scripts/measure-scoring.js` (add `--callouts` mode)
- Modify: `PROTOCOL.md` (the Bots line)
- Test: `test/rules.test.js`

**Interfaces:**
- Consumes (Task 1): callout eligibility is `p.vulnerable` alone.
- Produces:
  - `bot.PERSONALITIES` — `{ [name]: { tondoChance, calloutChance, think: [minMs, maxMs] } }`
  - `bot.personalityOf(name)` → a personality record (names starting "Chef Bot" use the `'Chef Bot'` record)
  - `bot.decide(view, name, rng = Math.random)`
  - `bot.wantsCallout(name, rng = Math.random)` → boolean
  - `bot.thinkMs(name, view, rng = Math.random)` → integer ms
  - `bot.bestSuit(hand, rng = Math.random)`

Why: `bot.js` declares TONDO unconditionally (`if (view.canDeclareTondo) return { action: 'tondo' };`), so a bot is never vulnerable and the game's own home-screen promise — "catch your friends forgetting TONDO" — is unreachable in every solo game. Two research judges measured zero catchable moments over 2000 and 4000 rounds.

Acceptance is an OUTCOME, measured: **≥ 0.30 callout windows on a bot per round** at a table of one human and three bots (Carmela, Dominic, Pina), over 2000 rounds. Derivation: a pie is 4 rounds (`PIE_ROUNDS` in `server/rooms.js`), so 0.30 per round is ≥ 1.2 windows per pie — the average pie holds at least one chance to catch someone. The personality numbers below are STARTING values: if the measurement misses 0.30, tune `tondoChance` values until the outcome is met and report the final table with its measured rate. Do not ship unmeasured inputs.

Two independent defects in the same file, fixed here:
- `playable.sort((a, b) => rank(a) - rank(b) || (Math.random() < 0.5 ? -1 : 1))` is an invalid comparator, not a coin toss (measured 43.7 / 18.9 / 37.4% first-choice over 200k sorts, against 33.3% each). Shuffle, then stable-sort by rank.
- `bestSuit` reduces from `game.SUITS[0]`, so a balanced hand always calls pepperoni. Break ties randomly.

Do NOT make bots stronger: a threat-aware heuristic measured 1973–2027 against the current bot over 4000 rounds — a coin flip.

- [ ] **Step 1: Add the `--callouts` measurement to `scripts/measure-scoring.js`**

Add this function above `main()`:

```js
/**
 * Counts callout windows a human gets on a bot: a snapshot in which the human's
 * `calloutTargets` gains a bot id it did not hold one step earlier. The human
 * plays legally and always declares TONDO, so the only windows are bot misses.
 * Bot-on-bot callouts are timed (1400ms) in the real room and are ignored here:
 * the human always gets the first beat.
 */
function measureCallouts(rounds) {
  const seats = [
    { id: 'p1', name: 'Human' },
    { id: 'p2', name: 'Carmela', isBot: true },
    { id: 'p3', name: 'Dominic', isBot: true },
    { id: 'p4', name: 'Pina', isBot: true },
  ];
  const nameOf = Object.fromEntries(seats.map((s) => [s.id, s.name]));
  let windows = 0;
  let finished = 0;
  for (let r = 0; r < rounds; r++) {
    const state = game.createGame(seats, { seed: r * 104729 + 17, startIndex: r % 4 });
    let open = new Set();
    let steps = 0;
    while (state.status === 'playing' && steps < 3000) {
      const me = game.currentPlayer(state);
      const view = game.viewFor(state, me.id);
      if (me.id === 'p1') {
        if (view.canDeclareTondo) game.declareTondo(state, 'p1');
        else if (view.drawnDecisionCardId) {
          const card = view.hand.find((c) => c.id === view.drawnDecisionCardId);
          if (view.playableCardIds.includes(view.drawnDecisionCardId)) {
            game.playCard(state, 'p1', card.id, card.value === 'WILD' ? 'basil' : undefined);
          } else game.passTurn(state, 'p1');
        } else if (view.playableCardIds.length) {
          const card = view.hand.find((c) => c.id === view.playableCardIds[0]);
          game.playCard(state, 'p1', card.id, card.value === 'WILD' ? 'basil' : undefined);
        } else game.drawCard(state, 'p1');
      } else {
        const move = bot.decide(view, nameOf[me.id]);
        if (!move) break;
        if (move.action === 'play') game.playCard(state, me.id, move.cardId, move.suit);
        else if (move.action === 'draw') game.drawCard(state, me.id);
        else if (move.action === 'pass') game.passTurn(state, me.id);
        else if (move.action === 'tondo') game.declareTondo(state, me.id);
      }
      const now = new Set(game.viewFor(state, 'p1').calloutTargets.filter((id) => id !== 'p1'));
      for (const id of now) if (!open.has(id)) windows++;
      open = now;
      steps++;
    }
    if (state.status === 'roundOver') finished++;
  }
  return { rounds, finished, windows, perRound: windows / rounds };
}
```

At the top of `main()`, before the existing scoring output:

```js
  if (argv.includes('--callouts')) {
    const n = i >= 0 ? Number(argv[i + 1]) : 2000;
    const m = measureCallouts(n);
    console.log(`\nCallout windows on bots — 1 legal human + Carmela, Dominic, Pina — ${m.rounds} rounds (${m.finished} finished)`);
    console.log(`  windows: ${m.windows}   per round: ${m.perRound.toFixed(2)}   per pie (x4): ${(m.perRound * 4).toFixed(2)}`);
    console.log(`  required: >= 0.30 per round  ->  ${m.perRound >= 0.30 ? 'PASS' : 'FAIL'}\n`);
    process.exitCode = m.perRound >= 0.30 ? 0 : 1;
    return;
  }
```

(`argv` and `i` are the variables `main()` already declares for `--rounds`; move those two lines above this block if they are below it.)

- [ ] **Step 2: Run it on the current bots — this is the reproduction**

Run: `node scripts/measure-scoring.js --callouts --rounds 2000`
Expected: `per round: 0.00` and `FAIL`, exit code 1. Paste the output into your report as RED evidence.

- [ ] **Step 3: Write the failing distribution tests** — append to `test/rules.test.js` before the runner's final block (`game` and `bot` are already required there):

```js
// ---------------------------------------------------------------------------
// Bots: personalities, fair tie-breaks
// ---------------------------------------------------------------------------

test('each named bot has a personality, and unknown Chef Bots share one', () => {
  for (const name of ['Carmela', 'Dominic', 'Pina', 'Chef Bot']) {
    const p = bot.personalityOf(name);
    assert(p && typeof p.tondoChance === 'number' && typeof p.calloutChance === 'number', `${name} has chances`);
    assert(Array.isArray(p.think) && p.think[0] < p.think[1], `${name} has a think range`);
  }
  assert(bot.personalityOf('Chef Bot 3') === bot.personalityOf('Chef Bot'), 'numbered Chef Bots share the record');
});

test('a bot that rolls a miss does not declare TONDO', () => {
  const view = {
    winnerId: null, canDeclareTondo: true, drawnDecisionCardId: null,
    hand: [{ id: 'x', suit: 'basil', value: '4' }, { id: 'y', suit: 'cheese', value: '2' }],
    playableCardIds: ['x'],
  };
  const always = bot.decide(view, 'Carmela', () => 0.0);
  const never = bot.decide(view, 'Carmela', () => 0.9999);
  assert(always.action === 'tondo', `low roll declares, got ${always.action}`);
  assert(never.action === 'play', `high roll forgets and plays, got ${never.action}`);
});

test('think time scales with how many cards the bot could play', () => {
  const [lo, hi] = bot.personalityOf('Dominic').think;
  const forced = bot.thinkMs('Dominic', { playableCardIds: ['a'] }, () => 0.5);
  const open = bot.thinkMs('Dominic', { playableCardIds: ['a', 'b', 'c', 'd', 'e'] }, () => 0.5);
  assert(forced >= lo && forced <= hi, `forced ${forced} in range`);
  assert(open >= lo && open <= hi, `open ${open} in range`);
  assert(open - forced >= (hi - lo) * 0.8, `a real choice visibly takes longer: ${forced} vs ${open}`);
});

test('tie-break between equal-rank cards is fair, not deal-order biased', () => {
  const rng = game.makeRng(4242);
  const counts = { a: 0, b: 0, c: 0 };
  const hand = [{ id: 'a', suit: 'basil', value: '1' }, { id: 'b', suit: 'basil', value: '2' }, { id: 'c', suit: 'basil', value: '3' }];
  const view = { winnerId: null, canDeclareTondo: false, drawnDecisionCardId: null, hand, playableCardIds: ['a', 'b', 'c'] };
  const N = 200000;
  for (let i = 0; i < N; i++) counts[bot.decide(view, 'Chef Bot', rng).cardId]++;
  for (const id of ['a', 'b', 'c']) {
    const pct = (counts[id] / N) * 100;
    assert(Math.abs(pct - 33.333) <= 1.5, `${id} chosen ${pct.toFixed(2)}% (want 33.3 ± 1.5)`);
  }
});

test('bestSuit breaks a balanced hand evenly across suits', () => {
  const rng = game.makeRng(777);
  const hand = [
    { id: '1', suit: 'pepperoni', value: '1' }, { id: '2', suit: 'cheese', value: '1' },
    { id: '3', suit: 'basil', value: '1' }, { id: '4', suit: 'anchovy', value: '1' },
  ];
  const counts = { pepperoni: 0, cheese: 0, basil: 0, anchovy: 0 };
  const N = 10000;
  for (let i = 0; i < N; i++) counts[bot.bestSuit(hand, rng)]++;
  for (const s of Object.keys(counts)) {
    const pct = (counts[s] / N) * 100;
    assert(Math.abs(pct - 25) <= 2, `${s} ${pct.toFixed(2)}% (want 25 ± 2)`);
  }
});
```

Run: `node test/rules.test.js`
Expected: FAIL — `bot.personalityOf is not a function`, and the tie-break test failing its ±1.5pp bound.

- [ ] **Step 4: Implement `server/bot.js`**

Replace `BOT_NAMES`, `CALLOUT_CHANCE`, `THINK_MIN_MS`/`THINK_MAX_MS`, `thinkMs`, `wantsCallout`, `bestSuit` and `decide` with:

```js
/**
 * Bots are people at the table, not a difficulty setting. Each has a declare
 * rate (how often they remember TONDO), a callout rate (how often they catch
 * someone who forgot) and a think range. STARTING values — tuned against
 * `node scripts/measure-scoring.js --callouts`, which must report >= 0.30
 * windows per round. Do not change one without re-running it.
 */
const PERSONALITIES = {
  Carmela: { tondoChance: 0.95, calloutChance: 0.60, think: [900, 1600] },  // quick, sharp-eyed
  Dominic: { tondoChance: 0.70, calloutChance: 0.35, think: [1100, 3000] }, // deliberate, forgetful
  Pina: { tondoChance: 0.60, calloutChance: 0.10, think: [2200, 3400] },    // slow, generous
  'Chef Bot': { tondoChance: 0.85, calloutChance: 0.35, think: [1400, 2600] },
};
const BOT_NAMES = ['Carmela', 'Dominic', 'Pina', 'Chef Bot'];

function personalityOf(name) {
  const key = String(name || '');
  if (PERSONALITIES[key]) return PERSONALITIES[key];
  return PERSONALITIES['Chef Bot'];
}

/** One roll of the missed-TONDO lottery, at this bot's own rate. */
function wantsCallout(name, rng = Math.random) {
  return rng() < personalityOf(name).calloutChance;
}

/**
 * How long this bot pauses. Timing carries information: a forced play (one
 * legal card) is quick, a real choice visibly takes longer. A little jitter
 * keeps two identical choices from ticking in lockstep.
 */
function thinkMs(name, view, rng = Math.random) {
  const [lo, hi] = personalityOf(name).think;
  const choices = view && Array.isArray(view.playableCardIds) ? view.playableCardIds.length : 1;
  const weight = Math.min(1, Math.max(0, (choices - 1) / 4));
  const jitter = (rng() - 0.5) * 0.1 * (hi - lo);
  return Math.round(Math.min(hi, Math.max(lo, lo + (hi - lo) * weight + jitter)));
}

/** The suit the bot holds most of, for a wild. Ties are broken at random. */
function bestSuit(hand, rng = Math.random) {
  const counts = Object.fromEntries(game.SUITS.map((s) => [s, 0]));
  for (const card of hand) if (card.suit) counts[card.suit]++;
  const top = Math.max(...Object.values(counts));
  const tied = game.SUITS.filter((s) => counts[s] === top);
  return tied[Math.floor(rng() * tied.length)];
}
```

Keep `rank(card)` as it is. `playMove(view, card)` gains `rng`:

```js
function playMove(view, card, rng) {
  const move = { action: 'play', cardId: card.id };
  if (card.value === game.WILD) {
    move.suit = bestSuit(view.hand.filter((c) => c.id !== card.id), rng);
  }
  return move;
}

/**
 * @param {object} view a `game.viewFor()` result for this bot
 * @param {string} name the bot's seat name, which selects its personality
 * @param {() => number} [rng]
 */
function decide(view, name, rng = Math.random) {
  if (!view || view.winnerId) return null;

  // A bot remembers TONDO at its own rate. The misses are the game's hook:
  // "catch your friends forgetting TONDO" needs someone who forgets.
  if (view.canDeclareTondo && rng() < personalityOf(name).tondoChance) return { action: 'tondo' };

  const playable = view.hand.filter((c) => view.playableCardIds.includes(c.id));

  if (view.drawnDecisionCardId) {
    const drawn = playable.find((c) => c.id === view.drawnDecisionCardId);
    return drawn ? playMove(view, drawn, rng) : { action: 'pass' };
  }
  if (playable.length > 0) {
    // Shuffle, then a STABLE sort by rank: the shuffle order survives inside
    // each rank, which makes the tie-break a real coin toss. The old random
    // comparator was not one — it favoured deal order.
    game.shuffle(playable, rng);
    playable.sort((a, b) => rank(a) - rank(b));
    return playMove(view, playable[0], rng);
  }
  return { action: 'draw' };
}
```

Update `module.exports` to: `decide, wantsCallout, pickBotName, thinkMs, bestSuit, personalityOf, PERSONALITIES, BOT_NAMES`. `pickBotName` is unchanged. Remove the old exported constants `CALLOUT_CHANCE`, `THINK_MIN_MS`, `THINK_MAX_MS`; grep `test/` and `server/` for them and update any reader.

A declare roll must happen once per opportunity: `decide` is called again after a TONDO shout (the room winds the bot back up), and by then `canDeclareTondo` is false, so a miss is never re-rolled into a declaration. Confirm this by reading `tickRoom` in `server/rooms.js`; if you find a path that calls `decide` twice for the same two-card opportunity, report it.

- [ ] **Step 5: Update the call sites in `server/rooms.js`**

In `scheduleTimers`: replace `now + bot.thinkMs()` with `now + bot.thinkMs(seat.name, game.viewFor(this.game, seat.id))`.

In `reconcileCallouts`: replace `bot.wantsCallout()` with `bot.wantsCallout(seat.name)`.

In `tickRoom`, the bot move: `bot.decide(game.viewFor(room.game, current.id))` becomes `bot.decide(game.viewFor(room.game, current.id), current.name)`.

Grep `server/` for any other `bot.decide(`, `bot.thinkMs(` or `bot.wantsCallout(` call and pass the name there too.

- [ ] **Step 6: Tests and the outcome measurement**

Run: `npm test`
Expected: all green, including the five bot tests.

Run: `node scripts/measure-scoring.js --callouts --rounds 2000`
Expected: `per round` ≥ 0.30 and `PASS`. If it prints less, raise the misses by lowering `tondoChance` for Dominic and Pina (Carmela stays sharp), re-run, and repeat until it passes. Record every tuning run (values → measured rate) in your report.

Run: `node scripts/measure-scoring.js --rounds 500` and confirm the ordinary scoring report still prints (the pie target in `server/rooms.js` was derived from it).

- [ ] **Step 7: Update `PROTOCOL.md`**

Replace the line beginning "Bots: fill seats via host's `addBot`." with:

> Bots: fill seats via host's `addBot`. Each named bot has a personality (`server/bot.js` `PERSONALITIES`): a chance to remember TONDO, a chance to call out a vulnerable player (rolled once per bot when the window opens, acted on after 1.4s so a human gets the first beat), and a think range. Think time scales with how many cards the bot could play, so a real choice visibly takes longer than a forced one. Bots forget TONDO at a rate tuned so a table of one human and three bots averages at least 0.30 callout windows on a bot per round (`node scripts/measure-scoring.js --callouts`).

- [ ] **Step 8: Smoke and commit**

```bash
PORT=4702 node server/index.js > /tmp/tondo-4702.log 2>&1 & echo $! > /tmp/tondo-4702.pid
sleep 1; PORT=4702 npm run smoke; kill "$(cat /tmp/tondo-4702.pid)"
git add server/bot.js server/rooms.js scripts/measure-scoring.js PROTOCOL.md test/rules.test.js
git commit -m "Bots that can be caught: per-bot personalities, choice-scaled think time, fair tie-breaks

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Action cards read at every table size

**Files:**
- Create: `public/js/fx.js`
- Create: `scripts/probes/action-legibility.js`
- Modify: `public/js/mock.js` (add `transition`)
- Modify: `public/js/app.js` (import and init fx; `applySnapshot` consequence ladder; `runTravel`/`dealGhosts` +2 lob; seat notes in `renderSeats`)
- Modify: `public/index.html` (`.dir-sweep` layer)
- Modify: `public/styles.css` (keyframes, layer, reduced-motion silence list)
- Modify: `scripts/shoot.js` (`--no-settle`, `--wait <ms>` flags)

**Interfaces:**
- Consumes: `deriveEvents(prev, snap)` from `public/js/events.js`. Event shapes it already emits — do not change them:
  - `{type:'play', playerId, card, byYou, isAction}`
  - `{type:'skip', victimId, byId, youSkipped, viaReverse?}` — at two players a REVERSE is reported ONLY as this skip with `viaReverse: true`; no `reverse` event is emitted, because the server never changes direction there.
  - `{type:'plus2', victimId, byId, youHit, cardsSeen}`
  - `{type:'reverse', direction, byId}` — only when `direction` actually changed (3–4 players).
  - `{type:'wild', suit, byId, byYou}`, `{type:'tondo', playerId, byYou}`, `{type:'callout', targetId, youCaught}`, `{type:'turn', playerId, yours, playable}`, `{type:'draw', …}`, `{type:'deal', …}`, `{type:'win', …}`
- Produces (later tasks rely on these exact names):
  - `fx.init(deps)` where `deps = { nodes, pulse, popSeat, MS, RM, seatPlate(id), seatNode(id), youId(), setSeatNote(id, text, ms), announce(text) }`.
  - `fx.playForEvents(events, { impactAt })` → array of the effect names it fired, e.g. `['skip']`.
  - `fx.CONSEQUENCES` — `Set(['skip', 'plus2', 'callout'])`.
  - `window.__mock.transition(kind, { seats = 4, victim = 'bot' })` → `Promise` resolving after the AFTER snapshot is emitted. `kind` ∈ `'number' | 'skip' | 'plus2' | 'reverse' | 'wild' | 'tondo' | 'callout'`. `victim: 'you'` makes the skip/+2/callout land on `p1`.
  - `app.seatNotes` map and `setSeatNote(id, text, ms)` — a transient seat verb that `renderSeats` shows until it expires.

The defect: at two players, `server/game.js` makes SKIP, +2 and REVERSE all `advanceTurn(state, 2)`, so `turnPlayerId` never changes and nothing but the ribbon text distinguishes them from a number card. Measured by the motion audit: a two-player SKIP fires exactly the animations a number card fires (`tondoDrop`, `top-card-land`, `tondoRipple`, the ribbon fade). One human and one bot is the likeliest first session.

Effects, with exact values:
- **SKIP** — the skipped seat's plate ducks, starting at the impact frame:
  ```css
  @keyframes seat-skipped {
    0%   { transform: translateY(0) scale(1); filter: saturate(1); }
    18%  { transform: translateY(-5.1%) scale(1.02); animation-timing-function: cubic-bezier(.33,0,.67,1); }
    55%  { transform: translateY(11.4%) scale(.90); filter: saturate(.45); animation-timing-function: cubic-bezier(.34,1.56,.64,1); }
    100% { transform: translateY(0) scale(1); filter: saturate(1); }
  }
  .plate.is-skipped { animation: seat-skipped 380ms linear 1; }
  ```
  Percentages, not pixels: 11.4% is the measured 9px on a 78.7px plate, so it survives every table size. When the skipped seat is YOU (`youSkipped`), duck `#you-portrait`'s seat container (`.you-seat`) instead.
- **+2** — the two cards are thrown, not dealt. For a `deals` entry whose player is a `plus2` victim, `dealGhosts` sources the ghosts from `#top-card`'s rect instead of `pileRect()`, waits a 90ms hold after the impact frame (the stillness is the weight), and lobs each card along three keyframes: `translate(0,0) scale(1)` → at offset `.5` `translate(${dx*.5}px, ${dy*.5 - lift}px) scale(.8)` where `lift = 0.4 × #top-card height` → `translate(${dx}px, ${dy}px) scale(.5)` with opacity 0. Duration 300ms, stagger 90ms between the two cards, easing `cubic-bezier(.23, 1, .32, 1)`. When the last card arrives, punch the victim's count badge:
  ```css
  @keyframes badge-punch { 0% { scale: 1; } 40% { scale: 1.34; } 100% { scale: 1; } }
  .count-badge.is-punched, .you-count.is-punched { animation: badge-punch 260ms cubic-bezier(.34,1.56,.64,1) 1; }
  ```
  (the `scale` property composes with any existing `transform`).
- **REVERSE** (3–4 players only; never at two, where no `reverse` event exists): a one-shot sweep inside `.sauce`. Add `<div class="dir-sweep" aria-hidden="true"></div>` to `public/index.html` immediately after `<div class="sauce-tint"></div>`.
  ```css
  .dir-sweep {
    position: absolute; inset: 0; border-radius: 50%; pointer-events: none; opacity: 0;
    background: conic-gradient(from -20deg, transparent 0deg, rgb(245 203 92) 20deg, transparent 40deg, transparent 360deg);
  }
  .dir-sweep.is-cw  { animation: dir-sweep-cw 620ms cubic-bezier(.16,1,.3,1) 1; }
  .dir-sweep.is-ccw { animation: dir-sweep-ccw 620ms cubic-bezier(.16,1,.3,1) 1; }
  @keyframes dir-sweep-cw  { 0% { transform: rotate(0deg); opacity: 0; } 12% { opacity: .22; } 100% { transform: rotate(360deg); opacity: 0; } }
  @keyframes dir-sweep-ccw { 0% { transform: rotate(0deg); opacity: 0; } 12% { opacity: .22; } 100% { transform: rotate(-360deg); opacity: 0; } }
  ```
  Rotate in the NEW play order's direction. Read which direction value the UI calls clockwise from how `renderCenter` sets `#dir-label` ("Clockwise") and match it; state what you found in your report.
- **Consequence ladder** — in `applySnapshot`, when any event's type is in `fx.CONSEQUENCES`, do not fire the generic turn-change effects (`pulse(nodes.stage, 'is-turn-change', 220)` and `popSeat(g.turnPlayerId)`), so the consequence owns the frame.
- **Words, under every motion preference** — the effects carry the moment; words make it survive reduced motion and a glance away:
  - skip → `setSeatNote(victimId, 'skipped', 1200)`; if `youSkipped`, `announce('You were skipped.')`.
  - plus2 → `setSeatNote(victimId, '+2', 1200)`; if `youHit`, `announce('You draw two.')`.
  - reverse → `announce(`Play order reversed — now ${label}.`)` where `label` is the text `#dir-label` shows after the repaint.
  - `announce(text)` writes `nodes['live-now'].textContent` (the event-time live region that repaints never rewrite). `setSeatNote` stores `{ text, until: Date.now() + ms }` in `app.seatNotes[id]`, then schedules one `renderGame(app.snap)` at expiry. In `renderSeats`, a live note replaces the computed `status` for that seat, below `wins!` and `away — reconnecting` in priority. For YOU, write the note into `#you-status` the same way.
- **Reduced motion** — add `.plate.is-skipped, .you-seat.is-skipped, .count-badge.is-punched, .you-count.is-punched, .dir-sweep` to the reduced-motion block with `animation: none !important;` (beside the existing `.sauce-tint.is-sweeping { animation: none !important; }`). `planTravel` already returns null under reduced motion, so no lob ghosts are created there.

- [ ] **Step 1: Add `transition` to `public/js/mock.js`**

Add above the `/* --------------------------------------------------------------- routing */` banner:

```js
/**
 * Emits one scripted BEFORE/AFTER pair so a check can watch exactly one event
 * land. `seats` picks the table size (2-4). `victim: 'you'` makes a skip, +2 or
 * callout land on you (p1); otherwise it lands on a bot.
 * Resolves just after the AFTER snapshot is delivered.
 */
function transition(kind, { seats = 4, victim = 'bot' } = {}) {
  table.seats = seatsWithYou().slice(0, 1).concat(BOTS.slice(0, seats - 1).map((b) => Object.assign({}, b)));
  table.phase = 'playing';
  const ids = table.seats.map((s) => s.id);
  const hitsYou = victim === 'you';
  const actor = hitsYou ? ids[ids.length - 1] : 'p1';
  const target = hitsYou ? 'p1' : ids[1];
  const hand = [c('h1', 'basil', '4'), c('h2', 'cheese', '2'), c('h3', 'anchovy', '9'), c('h4', 'basil', '6'), c('h5', 'pepperoni', '1')];
  const counts = ids.map((id) => (id === 'p1' ? hand.length : 5));
  const base = (over) => Object.assign({
    direction: 1,
    activeSuit: 'basil',
    topCard: c('t-before', 'basil', '7'),
    drawPileCount: 30,
    turnPlayerId: actor,
    winnerId: null,
    players: playersFrom(counts),
    hand: hand.slice(),
    playableCardIds: actor === 'p1' ? ['h1', 'h4'] : [],
    drawnDecisionCardId: null,
    canDeclareTondo: false,
    calloutTargets: [],
    log: ['SCRIPTED BEFORE'],
  }, over || {});
  const after = (card, extra) => {
    const players = playersFrom(counts.map((n, i) => (ids[i] === actor ? n - 1 : n)), extra && extra.players);
    const handAfter = actor === 'p1' ? hand.slice(1) : hand.slice();
    return base(Object.assign({ topCard: card, players, hand: handAfter, log: ['SCRIPTED AFTER'] }, extra && extra.game));
  };
  const next = (steps) => ids[((ids.indexOf(actor) + steps) % ids.length + ids.length) % ids.length];

  let before = base();
  let afterGame;
  switch (kind) {
    case 'number':
      afterGame = after(c('t-num', 'basil', '3'), { game: { turnPlayerId: next(1) } });
      break;
    case 'skip':
      afterGame = after(c('t-skip', 'basil', 'SKIP'), { game: { turnPlayerId: next(2) } });
      break;
    case 'plus2': {
      const bumped = {};
      bumped[target] = { cardCount: counts[ids.indexOf(target)] + 2 };
      afterGame = after(c('t-plus2', 'basil', 'PLUS2'), { players: bumped, game: { turnPlayerId: next(2) } });
      if (target === 'p1') afterGame.hand = afterGame.hand.concat([c('d1', 'cheese', '5'), c('d2', 'anchovy', '8')]);
      break;
    }
    case 'reverse':
      // At two seats the server treats REVERSE as a skip and leaves direction alone.
      afterGame = seats === 2
        ? after(c('t-rev', 'basil', 'REVERSE'), { game: { turnPlayerId: actor } })
        : after(c('t-rev', 'basil', 'REVERSE'), { game: { direction: -1, turnPlayerId: ids[(ids.indexOf(actor) - 1 + ids.length) % ids.length] } });
      break;
    case 'wild':
      afterGame = after(c('t-wild', null, 'WILD'), { game: { activeSuit: 'anchovy', turnPlayerId: next(1) } });
      break;
    case 'tondo': {
      const declarer = hitsYou ? 'p1' : ids[1];
      before = base({ players: playersFrom(counts.map((n, i) => (ids[i] === declarer ? 2 : n))) });
      afterGame = base({ players: playersFrom(counts.map((n, i) => (ids[i] === declarer ? 2 : n)), { [declarer]: { declaredTondo: true } }), log: ['SCRIPTED AFTER'] });
      break;
    }
    case 'callout': {
      const caller = hitsYou ? ids[1] : 'p1';
      const vuln = {};
      vuln[target] = { cardCount: 1, vulnerable: true };
      before = base({ players: playersFrom(counts, vuln), calloutTargets: target === 'p1' ? [] : [target] });
      const caught = {};
      caught[target] = { cardCount: 3, vulnerable: false };
      // Upper-cased exactly as server/game.js writes it (`up(name)`), so the
      // caller can be read back from this line. nameOf('p1') is "You".
      const up = (id) => String(nameOf(id)).toUpperCase();
      afterGame = base({ players: playersFrom(counts, caught), log: ['SCRIPTED BEFORE', `${up(caller)} CALLED OUT ${up(target)} - DRAW 2`] });
      break;
    }
    default:
      return Promise.reject(new Error('unknown transition: ' + kind));
  }
  table.game = before;
  emit(snapshot());
  return new Promise((resolve) => setTimeout(() => {
    table.game = afterGame;
    emit(snapshot());
    setTimeout(resolve, 20);
  }, 120));
}
```

Add `transition` to the `window.__mock` object at the bottom of the file.

- [ ] **Step 2: Add `--no-settle` and `--wait` to `scripts/shoot.js`**

In `parseArgs`, add defaults `settle: true, wait: 0` and parse `--no-settle` (sets `settle = false`) and `--wait <ms>`. In `main()`, after the probe runs and before the capture: `if (a.wait) await sleep(a.wait);`, and pass `{ settle: a.settle }` to `shoot(cdp, file, …)`. This lets a capture freeze a frame mid-animation.

- [ ] **Step 3: Write the probe** — create `scripts/probes/action-legibility.js`:

```js
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
```

- [ ] **Step 4: Run the probe on the unchanged UI — the reproduction**

Start your server (port 4703), then:
Run: `TONDO_URL=http://localhost:4703 node scripts/shoot.js --scene mock:yourTurn --w 390 --h 844 --probe "$(cat scripts/probes/action-legibility.js)"`
Expected RED: `valid: true`; for the two-player skip, plus2 and reverse, `differsFromNumber` is false or differs only by ghost count, and `hasDuck`, `hasSweep`, `hasBadge` are all false. Paste the JSON into your report.

- [ ] **Step 5: Create `public/js/fx.js`**

```js
/**
 * One-shot effects for what just happened at the table.
 *
 * events.js decides WHAT happened; this module decides what the table SHOWS
 * for it. Every effect is fired imperatively at a node that exists right now —
 * never a class written into render output, which replays on every repaint.
 * Effects describing a played card start at the impact frame (`impactAt`),
 * the same moment the sound and the ledger topping land.
 *
 * Priority mirrors sound.js: what happened TO someone owns the frame.
 */

export const CONSEQUENCES = new Set(['skip', 'plus2', 'callout']);

let d = null;

/** Wires the app's helpers in, so this module never imports app.js. */
export function init(deps) { d = deps; }

const later = (seconds, fn) => setTimeout(fn, Math.max(0, seconds * 1000));

function duck(playerId) {
  const target = playerId === d.youId() ? document.querySelector('.you-seat') : d.seatPlate(playerId);
  if (target) d.pulse(target, 'is-skipped', 380);
}

function sweep(direction) {
  const layer = document.querySelector('.dir-sweep');
  if (!layer) return;
  layer.classList.remove('is-cw', 'is-ccw');
  d.pulse(layer, direction === 1 ? 'is-cw' : 'is-ccw', 620);
}

/**
 * @param {Array<object>} events output of deriveEvents(prev, snap)
 * @param {{impactAt?: number}} [opts] seconds until the played card lands
 * @returns {string[]} the effects fired, in order
 */
export function playForEvents(events, { impactAt = 0 } = {}) {
  if (!d || !events || !events.length) return [];
  const fired = [];
  for (const e of events) {
    if (e.type === 'skip') {
      d.setSeatNote(e.victimId, 'skipped', 1200);
      if (e.youSkipped) d.announce('You were skipped.');
      if (!d.RM.matches) later(impactAt, () => duck(e.victimId));
      fired.push('skip');
    } else if (e.type === 'plus2') {
      d.setSeatNote(e.victimId, '+2', 1200);
      if (e.youHit) d.announce('You draw two.');
      fired.push('plus2'); // the lob and badge punch ride the deal ghosts in app.js
    } else if (e.type === 'reverse') {
      if (!d.RM.matches) later(impactAt, () => sweep(e.direction));
      // Read after the repaint, so the words match what the badge now says.
      later(0, () => {
        const label = (d.nodes['dir-label'] && d.nodes['dir-label'].textContent || '').toLowerCase();
        d.announce(`Play order reversed — now ${label || (e.direction === 1 ? 'clockwise' : 'counter-clockwise')}.`);
      });
      fired.push('reverse');
    }
  }
  return fired;
}
```

`fx.js` and the lob read `nodes['dir-label']`, `nodes['live-now']` and `nodes['you-count']`; register any of them missing from `app.js`'s node-id list.

- [ ] **Step 6: Wire it into `public/js/app.js`**

1. Import beside the sound import: `import * as fx from './fx.js';`
2. Add to the `app` state object: `seatNotes: {},       // id -> {text, until}: a transient seat verb` and `seatNoteTimer: 0,`.
3. Add these helpers near `popSeat`:

```js
/** The seat plate for a player, as it exists right now (seats are keyed). */
function seatPlate(playerId) {
  const seat = nodes.seats.querySelector(`.seat[data-player="${CSS.escape(playerId)}"]`);
  return seat ? seat.querySelector('.plate') : null;
}

/** A seat says something for a moment — "skipped", "+2" — then goes back. */
function setSeatNote(playerId, text, ms) {
  if (!playerId) return;
  app.seatNotes[playerId] = { text, until: Date.now() + ms };
  clearTimeout(app.seatNoteTimer);
  app.seatNoteTimer = setTimeout(() => { if (app.snap) renderGame(app.snap); }, ms + 20);
  if (app.snap) renderGame(app.snap);
}

function liveSeatNote(playerId) {
  const note = app.seatNotes[playerId];
  if (!note) return null;
  if (note.until <= Date.now()) { delete app.seatNotes[playerId]; return null; }
  return note.text;
}

function announce(text) { nodes['live-now'].textContent = text; }
```

4. After the node list registration (where `nodes['top-card'].style.setProperty('--land-rise', …)` runs), call:

```js
fx.init({
  nodes, pulse, popSeat, MS, RM, seatPlate,
  seatNode: (id) => nodes.seats.querySelector(`.seat[data-player="${CSS.escape(id)}"]`),
  youId: () => app.youId,
  setSeatNote, announce,
});
```

5. In `applySnapshot`, after the `sound.playForEvents(...)` block, add `const fired = fx.playForEvents(events, { impactAt: (travel && travel.flight) ? MS.flight / 1000 : 0 });` (compute `impactAt` once and reuse it for both). Then change `if (turnChanged) {` to `if (turnChanged && !events.some((e) => fx.CONSEQUENCES.has(e.type))) {`.
6. In `renderSeats`, after the status `if/else` chain computes `status`, add: `const note = (status === 'wins!' || status === 'away — reconnecting') ? null : liveSeatNote(p.id); if (note) { status = note; loud = true; alarm = false; }`. Apply the same override for your own status wherever `#you-status` text is computed in `renderGame` (`youStatus`), using `liveSeatNote(snap.youId)`.
7. The +2 lob: give `runTravel(plan, snap)` a third parameter `events` and pass `events` from `applySnapshot` (move the `runTravel` call below the `const events = deriveEvents(prev, snap);` line if needed — it already is). In `runTravel`, for each deal, find `const hit = (events || []).find((e) => e.type === 'plus2' && e.victimId === deal.playerId);` and call `dealGhosts(target.getBoundingClientRect(), deal.count, wave++, hit ? { lob: true, playerId: deal.playerId } : null)`.
8. Extend `dealGhosts(target, count, wave, opts)`: when `opts && opts.lob`, use `nodes['top-card'].getBoundingClientRect()` as the source, `lift = 0.4 * sourceRect.height`, delay `MS.flight + 90 + k * 90`, duration 300, and the three-keyframe lob path from the Effects list; after the last ghost's delay + 300ms, `pulse` the victim's badge: for another player `nodes.seats.querySelector(`.seat[data-player="${CSS.escape(opts.playerId)}"] .count-badge`)`, for you `nodes['you-count']`, with class `is-punched` for 260ms. Keep the existing guard-timeout pattern for every ghost. Without `opts.lob`, behaviour is unchanged.

- [ ] **Step 7: Add the CSS and the layer**

Add the keyframes and rules from the Effects list to `public/styles.css`, near the other `@keyframes` block, and the reduced-motion silence rules inside the existing `@media (prefers-reduced-motion: reduce)` block. Add the `.dir-sweep` element to `public/index.html`.

- [ ] **Step 8: Run the probe again — GREEN**

Run the same command as Step 4.
Expected: two-player `skip` → `hasDuck: true`, `differsFromNumber: true`, `wordsChanged: true`; two-player `plus2` → `hasBadge: true`, `differsFromNumber: true`; two-player `reverse` → `hasDuck: true`, `hasSweep: false`; four-player `reverse` → `hasSweep: true`, `hasDuck: false`.

Run with `--reduced` appended.
Expected: `reducedMotion: true`; for skip, plus2 and reverse `wordsChanged: true`; `hasDuck`, `hasSweep` and `hasBadge` all false.

- [ ] **Step 9: Capture frames for a human to judge**

For each of the 2-player skip, plus2, reverse and the 4-player reverse, capture the frame 480ms after the event with a one-line probe that triggers it: `--probe "window.__mock.transition('skip',{seats:2}).then(()=>'ok')" --no-settle --wait 480 --out .superpowers/sdd/frames --tag skip2` (and similarly). List the image paths in your report. These are for the controller to show the user; do not commit them.

- [ ] **Step 10: Full checks and commit**

Run: `npm test` (green) and `node scripts/check-contrast.js` (exit 0). Run `node scripts/shoot.js --scene game --w 1440 --h 900` against your server and confirm `no page errors`.

```bash
git add public/js/fx.js public/js/app.js public/js/mock.js public/index.html public/styles.css scripts/shoot.js scripts/probes/action-legibility.js
git commit -m "Action cards read at every table size: skip duck, thrown +2, reverse sweep, seat notes

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Wild, TONDO and callout get their moment

**Files:**
- Modify: `public/js/events.js` (callout gains `callerId`)
- Modify: `test/events.test.mjs`
- Modify: `public/js/fx.js`
- Modify: `public/js/app.js` (remove the old wild sweep; callout lob source)
- Modify: `public/index.html` (`.sauce-wash` layer)
- Modify: `public/styles.css`
- Create: `scripts/probes/moments.js`

**Interfaces:**
- Consumes (Task 3): `fx.init` deps, `fx.playForEvents`, `setSeatNote`, `announce`, `window.__mock.transition` kinds `wild`, `tondo`, `callout`; `dealGhosts(target, count, wave, opts)` with `opts.lob`.
- Produces:
  - callout event: `{type:'callout', targetId, youCaught, callerId}` where `callerId` is a player id or `null`.
  - `dealGhosts` accepts `opts.fromRect` (a DOMRect) to override the lob's source.

The motion audit, measured live: a Wild — the one card whose topping is chosen — washes the sauce at 10% alpha, which nobody sees; an opponent declaring TONDO fires zero animations and zero transitions; a callout has nothing on the caller.

Effects, with exact values:
- **WILD** — its own layer at its own alpha, so the resting tint stays subtle. Add `<div class="sauce-wash" aria-hidden="true"></div>` to `public/index.html` immediately after `.sauce-tint` (before `.dir-sweep`).
  ```css
  .sauce-wash {
    position: absolute; inset: 0; border-radius: 50%; pointer-events: none; opacity: 0;
    background: radial-gradient(circle closest-side, var(--wash-fill, transparent) 0%, var(--wash-fill, transparent) 55%, transparent 100%);
  }
  .sauce-wash.is-washing { animation: sauce-wash 520ms cubic-bezier(.16,1,.3,1) 1; }
  @keyframes sauce-wash { 0% { opacity: 0; transform: scale(.42); } 30% { opacity: 1; } 100% { opacity: 0; transform: scale(1.08); } }
  ```
  fx sets `--wash-fill` on the layer to the chosen suit's light colour at 34% alpha (add `washColor: (suit) => tint(SUITS[suit].c, .34)` to the `fx.init` deps; `tint` and `SUITS` already exist in `app.js`), then pulses `is-washing` at `impactAt`. It fires on every `wild` event, including a Wild played into the same suit. Delete the old block in `applySnapshot` that pulses `.sauce-tint` with `is-sweeping` (keep the plaque pop).
- **TONDO** — a stamp with a wind-up on the declaring seat's plate (or `.you-seat` for you):
  ```css
  @keyframes tondo-stamp {
    0%   { transform: scale(1) rotate(0deg); }
    22%  { transform: scale(.92) rotate(-3deg); animation-timing-function: cubic-bezier(.33,0,.67,1); }
    52%  { transform: scale(1.14) rotate(2deg); animation-timing-function: cubic-bezier(.34,1.56,.64,1); }
    100% { transform: scale(1) rotate(0deg); }
  }
  .plate.is-tondo, .you-seat.is-tondo { animation: tondo-stamp 440ms linear 1; }
  ```
  Plus a ring: `.plate.is-tondo::after` (and `.you-seat.is-tondo::after`) — `content:""; position:absolute; inset:-6px; border-radius:22px; border:2px solid var(--gold); pointer-events:none; animation: tondo-ring-shout 420ms cubic-bezier(.16,1,.3,1) 1 forwards;` with `@keyframes tondo-ring-shout { 0% { opacity: .9; transform: scale(1); } 100% { opacity: 0; transform: scale(1.34); } }`. This is a NEW keyframe; do not edit the shared `tondo-ring-pulse`. If `.plate` or `.you-seat` lacks `position: relative`, add it (check it does not move anything with a screenshot). Words: `setSeatNote(playerId, 'TONDO!', 1200)`; if not `byYou`, `announce(`${name} called TONDO.`)` with `name` from `snap.game.players`.
- **CALLOUT** — the caller's plate lunges toward the target: `transform: translate(dx, dy)` where `(dx, dy)` is 14px along the unit vector from the caller's plate centre to the target's plate centre (use `.you-seat` for you), 240ms out on `cubic-bezier(.33,0,.67,1)` then 320ms back on `cubic-bezier(.16,1,.3,1)` — a WAAPI animation with two keyframes out and back via `offset: 240/560`, `composite: 'add'`. The two penalty cards lob from the caller's seat rect instead of `#top-card` (pass `fromRect` into `dealGhosts`). Words: `setSeatNote(callerId, 'caught them!', 1200)` when known; `setSeatNote(targetId, '+2', 1200)`; if `youCaught`, `announce('Caught! You forgot TONDO — draw two.')`.
- **Reduced motion** — add `.sauce-wash, .plate.is-tondo, .you-seat.is-tondo, .plate.is-tondo::after, .you-seat.is-tondo::after` to the silence list; fx skips the lunge under `RM`. The seat notes and announcements carry the meaning.

The caller is not in snapshot state, so `events.js` reads it from the newest server log line. The format is written by `server/game.js` `callOut`: `` `${up(caller.name)} CALLED OUT ${up(target.name)} - DRAW ${dealt.length}` ``. A test drives the real engine, so a wording change in `game.js` fails the test instead of silently dropping the lunge.

- [ ] **Step 1: Failing test for `callerId`** — append to `test/events.test.mjs` before the runner's final block:

```js
test('a callout names its caller, read from the real engine\'s log line', () => {
  const state = newState();
  const victim = game.findPlayer(state, 'p2');
  victim.hand = victim.hand.slice(0, 1);
  victim.declaredTondo = false;
  victim.vulnerable = true;
  const before = snapOf(state);
  assert(game.callOut(state, 'p3', 'p2').ok, 'Dominic calls out Carmela');
  const evs = deriveEvents(before, snapOf(state));
  const c = pick(evs, 'callout');
  assert(c, 'a callout event');
  eq(c.targetId, 'p2', 'target');
  eq(c.callerId, 'p3', 'caller parsed from the log');
});

test('a callout whose log line cannot be matched reports a null caller, not a wrong one', () => {
  const state = newState();
  const victim = game.findPlayer(state, 'p2');
  victim.hand = victim.hand.slice(0, 1);
  victim.vulnerable = true;
  const before = snapOf(state);
  game.callOut(state, 'p3', 'p2');
  const after = snapOf(state);
  after.game.log = after.game.log.slice(0, -1).concat(['SOMETHING ELSE ENTIRELY']);
  const c = pick(deriveEvents(before, after), 'callout');
  eq(c.callerId, null, 'no guess');
});
```

Run: `node test/events.test.mjs`
Expected: FAIL — `caller parsed from the log: expected "p3", got undefined`.

- [ ] **Step 2: Implement `callerId` in `public/js/events.js`**

Add above `deriveEvents`:

```js
/**
 * Who made a callout. State does not carry it; the server's log line does, in
 * a fixed format written by server/game.js callOut():
 *   "<CALLER> CALLED OUT <TARGET> - DRAW <n>"   (names upper-cased)
 * test/events.test.mjs drives the real engine, so a wording change there fails
 * a test instead of silently dropping the effect. Unmatched -> null.
 */
function calloutCaller(g, targetId) {
  const target = byId(g.players, targetId);
  const line = [...(g.log || [])].reverse().find((l) => / CALLED OUT /.test(l));
  if (!target || !line) return null;
  const m = line.match(/^(.+) CALLED OUT (.+) - DRAW \d+$/);
  if (!m || m[2] !== String(target.name).toUpperCase()) return null;
  const caller = (g.players || []).find((p) => String(p.name).toUpperCase() === m[1] && p.id !== targetId);
  return caller ? caller.id : null;
}
```

In the callout push, add `callerId: calloutCaller(g, p.id)`.

Run: `node test/events.test.mjs` → PASS.

- [ ] **Step 3: Write the probe** — create `scripts/probes/moments.js`:

```js
(async () => {
  const watch = async (kind, opts) => {
    const names = new Set();
    let lunges = 0;
    const onStart = (e) => names.add(e.animationName);
    document.addEventListener('animationstart', onStart, true);
    const liveBefore = document.getElementById('live-now').textContent;
    await window.__mock.transition(kind, opts);
    const t0 = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        for (const a of document.getAnimations()) {
          if (a.animationName) names.add(a.animationName);
          else if (a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest('.plate, .you-seat')) lunges++;
        }
        if (performance.now() - t0 < 1100) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });
    document.removeEventListener('animationstart', onStart, true);
    const washFill = getComputedStyle(document.querySelector('.sauce-wash') || document.body).getPropertyValue('--wash-fill').trim();
    return {
      kind, animations: [...names].sort(), lungeFrames: lunges, washFill,
      liveNowChanged: document.getElementById('live-now').textContent !== liveBefore,
      seatVerbs: [...document.querySelectorAll('.seat-verb')].map((n) => n.textContent),
    };
  };
  const out = [];
  for (const [kind, opts] of [['wild', { seats: 4 }], ['tondo', { seats: 4 }], ['callout', { seats: 4 }]]) {
    out.push(await watch(kind, opts));
    await new Promise((r) => setTimeout(r, 1400));
  }
  const observed = out.reduce((n, r) => n + r.animations.length + r.lungeFrames, 0);
  return JSON.stringify({ reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, observed, valid: out.length === 3, out }, null, 1);
})()
```

- [ ] **Step 4: RED** — start your server (port 4704) and run:
`TONDO_URL=http://localhost:4704 node scripts/shoot.js --scene mock:yourTurn --w 1280 --h 800 --probe "$(cat scripts/probes/moments.js)"`
Expected: `wild` has no `sauce-wash`; `tondo` has no `tondo-stamp` and no `TONDO!` seat verb; `callout` has `lungeFrames: 0`. Paste into your report.

- [ ] **Step 5: Implement** the three effects in `public/js/fx.js` (extend the `for` loop in `playForEvents` with `wild`, `tondo` and `callout` branches, pushing `'wild'`, `'tondo'`, `'callout'` into `fired`), the CSS and layer, the `washColor` dep, the removal of the old `is-sweeping` block, and the callout lob source: in `runTravel`, for a deal whose player is a callout target with a known `callerId`, pass `{ lob: true, playerId, fromRect: <caller's plate or .you-seat rect> }`.

- [ ] **Step 6: GREEN** — the same probe.
Expected: `wild.animations` includes `sauce-wash` and `washFill` is a non-empty colour; `tondo.animations` includes `tondo-stamp` and `tondo-ring-shout`, and `seatVerbs` includes `TONDO!`; `callout.lungeFrames > 0`, and `seatVerbs` includes `caught them!` and `+2`.
With `--reduced`: no `sauce-wash`, `tondo-stamp` or lunge; `liveNowChanged: true` for tondo and callout; the seat verbs still change.

- [ ] **Step 7: Frames, checks, commit** — capture frames at 300ms for each moment as in Task 3 Step 9 and list them in your report. Run `npm test`, `node scripts/check-contrast.js`, and a `--scene game` capture with `no page errors`.

```bash
git add public/js/events.js test/events.test.mjs public/js/fx.js public/js/app.js public/index.html public/styles.css scripts/probes/moments.js
git commit -m "Wild wash, TONDO stamp and callout lunge — the silent moments get motion and words

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The round boundary looks like a round boundary

**Files:**
- Modify: `public/js/app.js` (`planTravel`, `runTravel`, `dealGhosts`, `renderHand` entry delay, `ledgerClear`, `applySnapshot` sequencing)
- Modify: `public/styles.css` (`.banner` placement while a banner would cover a seat)
- Create: `scripts/probes/round-boundary.js`

**Interfaces:**
- Consumes (Task 3): `dealGhosts(target, count, wave, opts)`, `runTravel(plan, snap, events)`.
- Produces: `dealGhosts` accepts `opts.roundDeal = { players, seatIndex, startDelay }`; `ledgerClear({ sweep })` returns the milliseconds until the board is clear (0 when not sweeping).

Three verified gaps at the emotional peak of the game:
1. `planTravel` returns null unless `prev.phase === 'playing'`, so a new deal — `roundOver → playing` or `lobby → playing` — produces zero travel ghosts at the one moment a deal is literally happening.
2. `ledgerClear()` is a bare `replaceChildren()`: up to 30 toppings, the round's visual record, vanish in one frame.
3. The win banner covers the top opponent's seat on a full table (visible in `docs/qa-2026-09/roundOver-boundary-1440x900.png` and `pieComplete-final-1440x900.png`), and the "YOUR TURN" banner does the same for 700ms at every turn start.

Behaviour, with exact values:
- **The deal goes around the table.** When `prev.phase` is `'roundOver'` or `'lobby'` and `snap.phase === 'playing'` (and not reduced motion), `planTravel` returns `{ flight: null, deals: [...], roundDeal: true }` with one deal per player at their full `cardCount`, in seat order starting from the player after the dealer-less opener (use `g.players` order). `dealGhosts` shows 4 cards per player for a round deal (3 otherwise), with a round-robin stagger: card `k` of the player at seat position `p` leaves at `startDelay + k * (players * 90) + p * 90` ms — four players × four cards = 16 ghosts over about 1.35s, once per round. Your own new hand cards rise when their ghost arrives: in `renderHand`, when a round deal is in progress, the entry animation delay for your card `k` is `startDelay + k * (players * 90) + yourSeatIndex * 90 + MS.deal` instead of `Math.min(k, 6) * MS.dealStep`.
- **The finished pie leaves.** `ledgerClear({ sweep: true })` moves each `.tp` topping outward along its own bearing from the sauce centre by 135% of the sauce radius over 520ms on `cubic-bezier(.55,.06,.68,.19)`, fading to opacity 0 over the same span (WAAPI, `composite: 'add'`, so the topping's own transform is preserved), then clears. It returns 520. Under reduced motion, or with no toppings, it clears immediately and returns 0. The `roundOver → playing` transition calls `ledgerClear({ sweep: true })` and passes the returned value as the round deal's `startDelay`, so the sweep completes before the first card leaves. Every other caller keeps the immediate clear.
- **No banner covers a seat.** Measure first (Step 2). Then move the banner by `top`/`bottom` only — never by editing the `tondo-slam` / `tondo-leave` keyframe transforms, which carry the `translate(-50%,0) … rotate(-2deg)` anchor. The target: at `roundOver` and during "YOUR TURN", the banner's rect intersects no `.seat` rect, at 390×844, 1280×800 and 1440×900 with four seats. The recommended placement is the lower part of the stage, clear of the board's lower rim; choose the exact offset from the measurement and state the numbers in your report.

- [ ] **Step 1: Write the probe** — create `scripts/probes/round-boundary.js`:

```js
(async () => {
  const intersects = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
  const bannerOverlaps = () => {
    const banner = document.getElementById('banner');
    if (!banner || banner.hidden) return { bannerVisible: false, overlaps: [] };
    const br = banner.getBoundingClientRect();
    const overlaps = [...document.querySelectorAll('#seats .seat')]
      .filter((s) => intersects(br, s.getBoundingClientRect()))
      .map((s) => s.dataset.player);
    return { bannerVisible: true, overlaps };
  };

  // 0. Put toppings on the pie first, so the exit sweep has something to move.
  for (let k = 0; k < 3; k++) {
    await window.__mock.transition('number', { seats: 4 });
    await new Promise((r) => setTimeout(r, 700));
  }

  // 1. Round over with a full table: does the win banner cover a seat?
  window.__mock.goto('roundOver');
  await new Promise((r) => setTimeout(r, 700));
  document.getAnimations().forEach((a) => { try { a.finish(); } catch {} });
  const atRoundOver = bannerOverlaps();

  // 2. The next deal: ghosts and the ledger's exit.
  let ghosts = 0;
  let tpSweeps = 0;
  const mo = new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) if (n.classList && n.classList.contains('travel-back')) ghosts++;
  });
  mo.observe(document.body, { childList: true });
  const toppingsBefore = document.querySelectorAll('#ledger .tp').length;
  window.__mock.goto('yourTurn');
  // 3. YOUR TURN: measure while its 700ms banner is up, at its settled position.
  await new Promise((r) => setTimeout(r, 60));
  const bannerEl = document.getElementById('banner');
  if (bannerEl) bannerEl.getAnimations().forEach((a) => { try { a.finish(); } catch {} });
  const atYourTurn = bannerOverlaps();
  const t0 = performance.now();
  await new Promise((resolve) => {
    const tick = () => {
      for (const a of document.getAnimations()) {
        const t = a.effect && a.effect.target;
        if (t && t.classList && t.classList.contains('tp') && !a.animationName) tpSweeps++;
      }
      if (performance.now() - t0 < 2400) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
  mo.disconnect();

  return JSON.stringify({
    viewport: `${innerWidth}x${innerHeight}`,
    atRoundOver, atYourTurn,
    deal: { ghosts, toppingsBefore, tpSweepFrames: tpSweeps },
    valid: atRoundOver.bannerVisible && toppingsBefore >= 0,
  }, null, 1);
})()
```

If `atYourTurn.bannerVisible` is false (the banner shows only when the turn becomes yours after not being yours), verify the YOUR TURN placement with a live bot game instead: `--scene game` stops on your turn with the banner up.

- [ ] **Step 2: RED** — start your server (port 4705), then run at 1440×900, 1280×800 and 390×844:
`TONDO_URL=http://localhost:4705 node scripts/shoot.js --scene mock:roundOver --w 1440 --h 900 --probe "$(cat scripts/probes/round-boundary.js)"`
Expected: `deal.ghosts: 0` and `tpSweepFrames: 0`; `atRoundOver.overlaps` non-empty on at least the 1440×900 run. Also measure the live YOUR TURN banner: `--scene game --w 1440 --h 900 --probe "<the bannerOverlaps function body returning JSON>"` and record the overlap. Paste all results into your report.

- [ ] **Step 3: Implement** the deal, the sweep and the banner placement as specified.

- [ ] **Step 4: GREEN** — re-run all three viewports and the live YOUR TURN check.
Expected: `deal.ghosts` between 8 and 16 at four seats; `tpSweepFrames > 0` whenever `toppingsBefore > 0`; `atRoundOver.overlaps` and the YOUR TURN overlaps empty at 390×844, 1280×800 and 1440×900.
Under `--reduced`: `deal.ghosts: 0` (correct — no travel under reduced motion) and the banner overlap checks still empty.

- [ ] **Step 5: Screenshots for a human** — capture `--scene mock:roundOver` at 390×844 and 1280×800 into `.superpowers/sdd/frames/` with `--tag boundary`, and a mid-deal frame: `--scene mock:roundOver --probe "(window.__mock.goto('yourTurn'), 'ok')" --no-settle --wait 700 --tag mid-deal`. List paths in your report; do not commit them.

- [ ] **Step 6: Checks and commit** — `npm test`, `node scripts/check-contrast.js`, and one live `--scene pieComplete` run (it plays four real rounds; allow up to 15 minutes) confirming `no page errors`.

```bash
git add public/js/app.js public/styles.css scripts/probes/round-boundary.js
git commit -m "Round boundary: deal around the table, sweep the finished pie away, keep banners off the seats

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The top seat never lands on the MATCH plaque

**Files:**
- Modify: `public/styles.css` (`.seat-top`)
- Create: `scripts/probes/seat-plaque-gap.js`

**Interfaces:**
- Consumes: mock scenes `tondo`, `callout`, `drawn`, `wild` (each opens a context bar, which compresses the stage).
- Produces: the probe file, reused by Task 11's check mode.

The art audit measured it: `.seat-top` is the only orbit seat with no `--min-orbit` floor (`.seat-left` and `.seat-right` clamp to it), so when a context bar compresses the stage on desktop the top seat's status pill lands on the MATCH plaque — gapY of −6 to −9px at 1280×800 in the callout scene. It lands on the element that tells the player what they may play, at the moment the game demands a decision.

- [ ] **Step 1: Write the probe** — create `scripts/probes/seat-plaque-gap.js`:

```js
(async () => {
  document.getAnimations().forEach((a) => { try { a.finish(); } catch {} });
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const plaque = document.getElementById('plaque').getBoundingClientRect();
  const top = document.querySelector('#seats .seat-top');
  if (!top) return JSON.stringify({ valid: false, reason: 'no .seat-top in this scene' });
  const parts = [...top.querySelectorAll('.seat-status, .seat-tile, .fan')].map((n) => n.getBoundingClientRect());
  const lowestBottom = Math.max(...parts.map((r) => r.bottom));
  const gapY = Math.round((plaque.top - lowestBottom) * 10) / 10;
  const stageCompressed = document.getElementById('stage').classList.contains('is-compressed');
  return JSON.stringify({ viewport: `${innerWidth}x${innerHeight}`, stageCompressed, gapY, pass: gapY > 0, valid: true });
})()
```

- [ ] **Step 2: RED** — start your server (port 4706). For each viewport in `1024x768 1280x800 1440x900` and each scene in `tondo callout drawn wild`, run:
`TONDO_URL=http://localhost:4706 node scripts/shoot.js --scene mock:<scene> --w <W> --h <H> --probe "$(cat scripts/probes/seat-plaque-gap.js)"`
Record the 12 results as a table in your report. Expected: at least one `pass: false` (the audit measured the callout scene at 1280×800). If every row passes on the unchanged code, report that the defect no longer reproduces (the warm-palette or tray fix may have moved the stage), stop, and return status DONE_WITH_CONCERNS with the table — do not change CSS for a defect you cannot reproduce.

- [ ] **Step 3: Implement** — in `public/styles.css`, change the `.seat-top` rule from
`.seat-top   { left: 50%; top: max(calc(50% - var(--table-d) / 2), calc(var(--seat-tile) * 1)); }`
to the clamp shape the side seats already use:
`.seat-top   { left: 50%; top: max(min(calc(50% - var(--table-d) / 2), calc(50% - var(--min-orbit, 0px))), calc(var(--seat-tile) * 1)); }`
`--min-orbit` was calibrated for horizontal clearance. If the table shows this vertical use pushes the seat too far up (its tile clipped by the strip) or still fails a row, introduce `--min-orbit-top` measured from the live plaque rect — the distance from the stage centre to the plaque's top edge plus the top seat's own height below its anchor plus 8px — define it beside `--min-orbit` for each band where `--min-orbit` is defined, and use it here. Report which you shipped and why.

- [ ] **Step 4: GREEN** — re-run all 12 combinations. Expected: every row `pass: true`, and additionally `mock:yourTurn` at 390×844 and 1440×900 still shows the top seat fully on screen (`gapY > 0`). Capture `mock:callout` at 1280×800 into `.superpowers/sdd/frames/` and list it.

- [ ] **Step 5: Commit**

```bash
git add public/styles.css scripts/probes/seat-plaque-gap.js
git commit -m "Top seat clamps to the orbit floor, so its pill never lands on the MATCH plaque

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: One tap to a table

**Files:**
- Modify: `public/js/app.js` (`bootHome`, the `joined` handler, lobby branch of `applySnapshot`, round-end refresh, new handlers)
- Modify: `public/index.html` (home card: quick pie, last table, forget)
- Modify: `public/styles.css`
- Modify: `scripts/shoot.js` (`--path`, `--storage`, `--scene none`)
- Create: `scripts/probes/one-tap.js`

**Interfaces:**
- Consumes: `send()` returns false while the socket is not open (`public/js/net.js`: nothing is queued) — act only after the connection reports open (the `onNetStatus` hook in `app.js`).
- Produces: localStorage key `tondo.lastTable` = JSON `{ code: string, roster: string[], at: number }`.

Today `bootHome` only PREFILLS `#code-input` from `?code=`; a friend who taps an invite link still has to type a name and press Join. And a player alone has three taps and a lobby between them and a game.

Behaviour, with exact copy:
- **Auto-join from a link.** When THIS page load carries `?code=` AND `localStorage['tondo.name']` is non-empty, set `app.name` from it and send `joinRoom` (with the stored seat token for that code, exactly as the Join button does) as soon as the connection is open; the home screen is never shown. Auto-join fires only from a URL parameter present on this load, never from stored state alone. With no stored name, behaviour is exactly as today: home screen, code prefilled. If the server replies with the error `No table has that code.`, show the home screen with the message `That table has closed — start a new one.` in `#home-msg`.
- **One quick pie.** A secondary button in `#screen-home`, below "Create table": label `One quick pie`, with a one-line hint under it in the tagline style: `Warm up against three bots while your friends arrive.` It uses the name in the field (same `readName()` validation). It sends `createRoom`; on the first lobby snapshot for that room it sends `addBot` until `snap.seats.length === 4`, then `startGame`. Track this with `app.quickPie` (`null | 'creating' | 'seating' | 'dealing'`), cleared on the first `playing` snapshot or any error. No stats, no record, no progression — the research was explicit that solo play must not grow a ledger.
- **Last table.** Write `tondo.lastTable` in the `joined` handler (code from the message, roster from the first snapshot's seat names excluding yours) and refresh the roster from `snap.seats` whenever a round ends. On the home screen, when it exists and is under 12 hours old, show a row above the code field: a button `Rejoin last table` with the sub-line `with Carmela, Dominic, Pina` (names from the roster, joined with ", "). Tapping it fills `#code-input` and presses Join — always an explicit tap. The copy never promises the table still exists; a failed join shows the `That table has closed — start a new one.` message.
- **Forget this device.** A quiet text button at the bottom of the home card: `Forget this device`. It removes every `localStorage` and `sessionStorage` key starting with `tondo.`, clears the name field, hides the last-table row, and sets `#home-msg` to `Forgotten. Nothing about you is stored here now.`.
- Storage discipline from Global Constraints applies to every read and write. Keep writing `tondo.name` exactly as today.

- [ ] **Step 1: Harness options** — in `scripts/shoot.js`:
  - `--path <p>`: navigate to `ORIGIN + p` instead of `ORIGIN` (for non-mock scenes).
  - `--storage-json '<json object>'`: before navigating, call `Page.addScriptToEvaluateOnNewDocument` with a script that sets each key of the object as a `localStorage` string value (wrapped in try/catch), so the values exist when the app boots. Example: `--storage-json '{"tondo.name":"Gent"}'`.
  - `--scene none`: skip `driveTo` entirely after load.

- [ ] **Step 2: Write the probe** — create `scripts/probes/one-tap.js`, returning the current screen and storage state:

```js
(async () => {
  const t0 = performance.now();
  // Wait up to 4s for the app to settle on a screen other than the initial home render.
  while (performance.now() - t0 < 4000 && document.body.dataset.screen === 'home' && new URLSearchParams(location.search).has('code') && localStorage.getItem('tondo.name')) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const tondoKeys = (s) => Object.keys(s).filter((k) => k.startsWith('tondo.'));
  return JSON.stringify({
    screen: document.body.dataset.screen,
    codeInput: (document.getElementById('code-input') || {}).value,
    homeMsg: (document.getElementById('home-msg') || {}).textContent,
    localKeys: tondoKeys(localStorage), sessionKeys: tondoKeys(sessionStorage),
    ms: Math.round(performance.now() - t0),
  });
})()
```

- [ ] **Step 3: RED** — start your server (port 4707). Hold a live room open with a host socket that stays connected for two minutes, writing its code to a file:

```bash
node -e "
const W = require('ws'); const ws = new W('ws://localhost:4707');
ws.on('open', () => ws.send(JSON.stringify({ type: 'createRoom', name: 'Host' })));
ws.on('message', (m) => { const x = JSON.parse(m); if (x.type === 'joined') require('fs').writeFileSync('/tmp/tondo-4707.code', x.roomCode); });
setTimeout(() => process.exit(0), 120000);
" & echo $! > /tmp/tondo-4707-host.pid
sleep 2
TONDO_URL=http://localhost:4707 node scripts/shoot.js --scene none --path "/?code=$(cat /tmp/tondo-4707.code)" --storage-json '{"tondo.name":"Gent"}' --probe "$(cat scripts/probes/one-tap.js)"
```

Expected RED: `screen: "home"`. Record it. Re-run the host script whenever a check needs a fresh live code; `kill "$(cat /tmp/tondo-4707-host.pid)"` when done.

- [ ] **Step 4: Implement** everything in the Behaviour list.

- [ ] **Step 5: GREEN — four checks**, each recorded in your report:
  1. Same command as Step 3 → `screen` is `"lobby"` (or `"game"`) with zero clicks.
  2. The same path with no `--storage-json` → `screen: "home"` and `codeInput` equals the code.
  3. Quick pie: `--scene none` then a probe that fills `#name-input` with `Gent`, clicks the `One quick pie` button, records `performance.now()`, and polls until `document.body.dataset.screen === 'game'` and `document.querySelectorAll('#seats .seat').length === 3`; report the elapsed ms. Required: under 2000ms.
  4. Forget: a probe that sets `tondo.name`, `tondo.lastTable` and `sessionStorage['tondo.room']`, clicks `Forget this device`, and returns `localKeys` and `sessionKeys`. Required: both empty.
  Capture the home screen at 390×844 with a stored last table — `--scene home --storage-json '{"tondo.name":"Gent","tondo.lastTable":"{\"code\":\"BASIL-4821\",\"roster\":[\"Carmela\",\"Dominic\",\"Pina\"],\"at\":9999999999999}"}'` — into `.superpowers/sdd/frames/` and list it.

- [ ] **Step 6: Checks and commit** — `npm test`, `node scripts/check-contrast.js`, `PORT=4707 npm run smoke`.

```bash
git add public/js/app.js public/index.html public/styles.css scripts/shoot.js scripts/probes/one-tap.js
git commit -m "One tap to a table: invite links seat you, One quick pie, rejoin last table, forget this device

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: The four accessibility defects

**Files:**
- Modify: `public/js/app.js` (top card label; wild pick focus; `setScreen` focus; keyed `#callout-buttons`; keyed `#seat-list`)
- Modify: `public/index.html` (plaque role; lobby help button; `tabindex="-1"` on the three screen `<h1>`s; help copy)
- Create: `scripts/probes/a11y-focus.js`

**Interfaces:**
- Consumes: mock scenes `callout`, `lobby`, `wild`; `window.__mock.emit`, `snapshot`, `table`.
- Produces: nothing later tasks consume.

Verified in the current tree:
- **(a)** After a Wild, `#top-card`'s `aria-label` is `Top card: Wild` — the chosen topping, the single most consequential fact on the board, is missing from the only labelled element that exists to state it.
- **(b)** `data-help-open` appears on the home screen and the game strip, and nowhere in the lobby — exactly where a new player sits idle and waiting. The help dialog also says "Reverse" while the card itself prints `F` and `FLIP`.
- **(c)** Focus drops to `<body>` after picking a Wild suit, and is left on a hidden button after "Deal the cards".
- **(d)** `#callout-buttons` and `#seat-list` are rebuilt with `innerHTML` on every snapshot, so a keyboard user loses focus on "Call out Dominic" before they can press Enter — a race they cannot win, since bot snapshots arrive constantly while the window is open.

Changes:
- **(a)** The top-card label: `isWild(top) ? `Top card: Wild, topping is ${SUITS[activeSuitOf(g)].label.toLowerCase()}` : `Top card: ${prettyCard(top)}``. Give `#plaque` `role="group"` and `aria-label="Match requirement"`.
- **(b)** A `How to play` button with `data-help-open` in the lobby card, directly above "Leave table", using the same classes as the home screen's. Auto-open the help dialog once, on first lobby entry, gated on `localStorage['tondo.seenHelp']` (set it when the dialog opens). In the help dialog, the action-card line becomes: `<b>⊘ Skip</b> makes the next player lose their turn. <b>+2</b> makes them draw two and lose their turn. <b>⇄ Flip</b> reverses the play order (with two players it acts as a Skip).`
- **(c)** In the wild-suit click handler, after `send`, move focus the way `cancelWild` already does on its Escape path (nearest surviving hand card, else `#draw-btn`). `setScreen(name)` focuses the newly visible screen's `<h1>` (give `#home-title`, `#lobby-title` and `#game-title` `tabindex="-1"`) with `{ preventScroll: true }` only when the screen actually changed, and writes one orientation line to `#live-polite`: `Home.` / `Lobby for table <CODE>.` / `Game started.`.
- **(d)** Key both lists the way `renderSeats` and `renderHand` already are: `#callout-buttons` keyed on target id (`data-callout`), `#seat-list` keyed on seat id; reuse nodes, update text and attributes in place, remove departed ones, and if the previously focused id survives, restore focus to it. Preserve any transient class a helper owns across updates. Ship (d) as its own commit after (a)–(c).

- [ ] **Step 1: Write the probe** — create `scripts/probes/a11y-focus.js`:

```js
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};

  // (d1) callout button keeps focus across an unrelated snapshot
  window.__mock.goto('callout');
  await wait(300);
  const btn = document.querySelector('#callout-buttons [data-callout]');
  if (btn) {
    btn.focus();
    const g = window.__mock.table.game;
    g.drawPileCount = g.drawPileCount - 1; // unrelated change
    window.__mock.emit(window.__mock.snapshot());
    await wait(200);
    const a = document.activeElement;
    out.calloutFocus = { focusedBefore: btn.dataset.callout, activeAfter: a && (a.dataset.callout || a.id || a.tagName) };
  } else out.calloutFocus = { error: 'no callout button rendered' };

  // (d2) lobby seat list keeps focus after a bot is added
  window.__mock.goto('lobby');
  await wait(300);
  const seatBtn = document.querySelector('#seat-list button');
  if (seatBtn) {
    seatBtn.focus();
    const before = seatBtn.outerHTML.slice(0, 60);
    document.getElementById('addbot-btn').click();
    await wait(400);
    const a = document.activeElement;
    out.lobbyFocus = { before, activeAfterTag: a && a.tagName, stillInList: !!(a && a.closest && a.closest('#seat-list')) };
  } else out.lobbyFocus = { note: 'no focusable control in the lobby seat list' };

  // (c) focus after picking a wild suit
  window.__mock.goto('wild');
  await wait(400);
  const suitBtn = document.querySelector('#wild-grid [data-suit]');
  if (suitBtn) {
    suitBtn.focus();
    suitBtn.click();
    await wait(700);
    const a = document.activeElement;
    out.wildFocus = { activeTag: a && a.tagName, activeId: a && a.id, isCardOrDraw: !!(a && (a.classList.contains('card') || a.id === 'draw-btn')) };
  } else out.wildFocus = { error: 'no suit button' };

  // (a) top card label after a wild
  await window.__mock.transition('wild', { seats: 4 });
  await wait(200);
  out.topCardLabel = document.getElementById('top-card').getAttribute('aria-label');
  out.plaque = { role: document.getElementById('plaque').getAttribute('role'), label: document.getElementById('plaque').getAttribute('aria-label') };

  // (b) help in the lobby
  window.__mock.goto('lobby');
  await wait(300);
  out.lobbyHelp = !!document.querySelector('#screen-lobby [data-help-open]');
  return JSON.stringify(out, null, 1);
})()
```

- [ ] **Step 2: RED** — start your server (port 4708) and run:
`TONDO_URL=http://localhost:4708 node scripts/shoot.js --scene mock:yourTurn --w 1280 --h 800 --probe "$(cat scripts/probes/a11y-focus.js)"`
Expected: `calloutFocus.activeAfter` is `BODY`; `wildFocus.isCardOrDraw` false; `topCardLabel` is `Top card: Wild`; `plaque.role` null; `lobbyHelp` false. Record it.

- [ ] **Step 3: Implement (a), (b), (c); run the probe; commit**

Expected after: `topCardLabel` is `Top card: Wild, topping is anchovy`; `plaque.role` is `group`; `lobbyHelp` true; `wildFocus.isCardOrDraw` true.

```bash
git add public/js/app.js public/index.html
git commit -m "A11y: the top card names a wild's topping, help in the lobby, focus lands somewhere real

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Implement (d); run the probe; commit**

Expected after: `calloutFocus.activeAfter` equals `calloutFocus.focusedBefore`; `lobbyFocus.stillInList` true (or the note, if the lobby list has no focusable control for this seat).

```bash
git add public/js/app.js
git commit -m "A11y: key the callout buttons and lobby seat list so focus survives snapshots

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Checks** — `npm test`, `node scripts/check-contrast.js`, a `--scene game` capture with `no page errors`, and a `--reduced` run of the probe with the same expectations. Screen-reader output (VoiceOver/NVDA) cannot be run here: say so in your report as UNVERIFIED, and report the accessible names you verified from the DOM instead.

---

### Task 9: Haptics on phones that support them

**Files:**
- Create: `public/js/haptics.js`
- Modify: `public/js/app.js` (call on events; tap buzz; toggle wiring)
- Modify: `public/index.html` (toggle beside the sound button)
- Modify: `public/styles.css`
- Create: `scripts/probes/haptics.js`

**Interfaces:**
- Consumes: event flags `plus2.youHit`, `callout.youCaught`, `turn.yours`; `window.__mock.transition(kind, { seats, victim: 'you' })`.
- Produces: `haptics.isSupported()`, `haptics.isEnabled()`, `haptics.setEnabled(bool)`, `haptics.forEvents(events, { impactAt })` → the pattern name fired or `null`, `haptics.tap()`.

Zero haptics today, and the phone band is a first-class target. It is the one channel that can deliver a consequence to a single player's body without anyone else at the table hearing it. `navigator.vibrate` has never shipped in Safari on iOS, so this is silently absent on roughly half the target devices: pure progressive enhancement, never the sole carrier of any event.

- [ ] **Step 1: Harness options and the probe** — add two options to `scripts/shoot.js`: `--prelude <file>` registers the file's contents with `Page.addScriptToEvaluateOnNewDocument` before navigation, and `--query <q>` appends `&<q>` to a mock scene URL. The probe installs a recording stub for `navigator.vibrate` BEFORE the app loads through that prelude. Prelude file `scripts/probes/haptics-stub.js`:

```js
window.__vibrations = [];
if (!location.search.includes('novibrate')) {
  Object.defineProperty(navigator, 'vibrate', { configurable: true, value: (p) => { window.__vibrations.push(p); return true; } });
} else {
  try { delete Navigator.prototype.vibrate; } catch {}
  Object.defineProperty(navigator, 'vibrate', { configurable: true, value: undefined });
}
```

Probe `scripts/probes/haptics.js`:

```js
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = async (kind, victim) => {
    window.__vibrations.length = 0;
    await window.__mock.transition(kind, { seats: 4, victim });
    await wait(900);
    return window.__vibrations.slice();
  };
  const toggle = document.getElementById('haptics-btn');
  return JSON.stringify({
    supported: typeof navigator.vibrate === 'function',
    toggleVisible: !!(toggle && !toggle.hidden),
    plus2OnYou: await run('plus2', 'you'),
    plus2OnBot: await run('plus2', 'bot'),
    calloutOnYou: await run('callout', 'you'),
    calloutOnBot: await run('callout', 'bot'),
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  }, null, 1);
})()
```

- [ ] **Step 2: RED** — start your server (port 4709) and run:
`TONDO_URL=http://localhost:4709 node scripts/shoot.js --scene mock:yourTurn --w 390 --h 844 --prelude scripts/probes/haptics-stub.js --probe "$(cat scripts/probes/haptics.js)"`
Expected: `supported: true`, `toggleVisible: false`, every recorded array empty.

- [ ] **Step 3: Implement `public/js/haptics.js`**

```js
/**
 * A buzz for the player at THIS phone when something happens to THEM.
 *
 * Only you-events: a phone buzzing for another player's turn is how a game gets
 * muted. Pure progressive enhancement — `navigator.vibrate` does not exist in
 * Safari on iOS, so nothing may depend on it. Reduced motion mutes it.
 */

const STORE_KEY = 'tondo.haptics';
export const PATTERNS = { hit: 35, caught: [30, 60, 30], yourTurn: 10, tap: 10 };

const supported = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
const RM = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
let enabled = true;
try { enabled = localStorage.getItem(STORE_KEY) !== 'off'; } catch { /* private mode */ }

export function isSupported() { return supported; }
export function isEnabled() { return enabled; }

export function setEnabled(value) {
  enabled = Boolean(value);
  try { localStorage.setItem(STORE_KEY, enabled ? 'on' : 'off'); } catch { /* private mode */ }
  return enabled;
}

function buzz(pattern) {
  if (!supported || !enabled || RM.matches) return false;
  if (typeof document !== 'undefined' && document.hidden) return false;
  try { return navigator.vibrate(pattern) !== false; } catch { return false; }
}

/** One buzz per snapshot, for the event that happened to you, at the impact frame. */
export function forEvents(events, { impactAt = 0 } = {}) {
  if (!events || !events.length) return null;
  const find = (t) => events.find((e) => e.type === t);
  const callout = find('callout');
  const plus2 = find('plus2');
  const turn = find('turn');
  let name = null;
  if (callout && callout.youCaught) name = 'caught';
  else if (plus2 && plus2.youHit) name = 'hit';
  else if (turn && turn.yours) name = 'yourTurn';
  if (!name) return null;
  setTimeout(() => buzz(PATTERNS[name]), Math.max(0, impactAt * 1000));
  return name;
}

export function tap() { return buzz(PATTERNS.tap); }
```

- [ ] **Step 4: Wire it** — in `app.js`: `import * as haptics from './haptics.js';`; call `haptics.forEvents(events, { impactAt })` beside `sound.playForEvents`; call `haptics.tap()` in `tapCardId` just before `send({ type: 'play', cardId: id })`. Add a toggle button `#haptics-btn` beside `#sound-btn` in `public/index.html`, same classes and 30px circle with the 44×44 `::before` hit area as `.strip-sound`, `aria-pressed`, label `Vibration on — turn off` / `Vibration off — turn on`, with a drawn glyph (a small phone outline with two short side ticks, done in CSS like `.sound-glyph`; muted state adds a slash exactly as the sound button does, so state is carried by shape). The button is `hidden` when `!haptics.isSupported()` — a toggle that does nothing on an iPhone is worse than none. Clicking it flips `setEnabled`, repaints its state, and buzzes `tap` when turning on.

- [ ] **Step 5: GREEN — three runs**, all recorded:
  1. Step 2's command → `toggleVisible: true`; `plus2OnYou` equals `[35]`; `calloutOnYou` equals `[[30,60,30]]`; `plus2OnBot` and `calloutOnBot` equal `[]`.
  2. Step 2's command with `--query novibrate` added → `supported: false`, `toggleVisible: false`, all arrays `[]`, and the run reports `no page errors`.
  3. Step 2's command with `--reduced` → all arrays `[]`.
  In your report state plainly: physical Android verification is UNVERIFIED (no device available here); iOS absence verified only by simulation of a missing API.

- [ ] **Step 6: Checks and commit** — `npm test`, `node scripts/check-contrast.js`.

```bash
git add public/js/haptics.js public/js/app.js public/index.html public/styles.css scripts/shoot.js scripts/probes/haptics.js scripts/probes/haptics-stub.js
git commit -m "Haptics: a buzz when a +2 or callout lands on you, on phones that support it

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Share the finished pie

**Files:**
- Create: `public/js/share.js`
- Create: `test/share.test.mjs`
- Modify: `package.json` (`test` script)
- Modify: `public/js/app.js` (`renderMatch`; button handler)
- Modify: `public/index.html` (`#share-btn` in `#scoreboard`)
- Modify: `public/styles.css`
- Modify: `public/js/mock.js` (a `pieComplete` scene)

**Interfaces:**
- Consumes: `snap.match` — `{ complete, championIds, standings: [{id, name, isBot, points, roundsWon}] }` (PROTOCOL.md v1.2).
- Produces: `pieResultText(match, { origin })` → string.

At pie end, one tap copies plain text naming everyone at the table with their score. Plain text, never an image. Nothing is gated behind sharing and the text asks nothing of the reader — the moment a share button buys a reward it reads as an ad. The room code dies 60 seconds after a table empties, so the text says start a new table and never implies the link is durable.

Exact format:

```
🍕 TONDO — Pina took the pie
Pina 273 · Carmela 85 · Gent 81 · Dominic 0
Four slices. Start a new table: http://localhost:4600
```

A shared pie's first line is `🍕 TONDO — Pina and Carmela shared the pie` (three or more: `Pina, Carmela and Gent shared the pie`). Standings keep the order they arrive in. Every seat appears with its points. The text stays under 400 characters with four 16-character names.

- [ ] **Step 1: Failing tests** — create `test/share.test.mjs`:

```js
import { pieResultText } from '../public/js/share.js';

let passed = 0;
const failures = [];
const test = (name, fn) => { try { fn(); passed++; } catch (err) { failures.push({ name, err }); } };
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };

const standings = [
  { id: 'p4', name: 'Pina', isBot: true, points: 273, roundsWon: 2 },
  { id: 'p2', name: 'Carmela', isBot: true, points: 85, roundsWon: 1 },
  { id: 'p1', name: 'Gent', isBot: false, points: 81, roundsWon: 1 },
  { id: 'p3', name: 'Dominic', isBot: true, points: 0, roundsWon: 0 },
];

test('names the champion, every seat with its score, and says start a new table', () => {
  const text = pieResultText({ complete: true, championIds: ['p4'], standings }, { origin: 'https://tondo.example' });
  const lines = text.split('\n');
  assert(lines[0] === '🍕 TONDO — Pina took the pie', `line 1: ${lines[0]}`);
  assert(lines[1] === 'Pina 273 · Carmela 85 · Gent 81 · Dominic 0', `line 2: ${lines[1]}`);
  assert(lines[2] === 'Four slices. Start a new table: https://tondo.example', `line 3: ${lines[2]}`);
});

test('a shared pie names everyone who shared it', () => {
  const two = pieResultText({ complete: true, championIds: ['p4', 'p2'], standings }, { origin: 'x' });
  assert(two.startsWith('🍕 TONDO — Pina and Carmela shared the pie'), two);
  const three = pieResultText({ complete: true, championIds: ['p4', 'p2', 'p1'], standings }, { origin: 'x' });
  assert(three.startsWith('🍕 TONDO — Pina, Carmela and Gent shared the pie'), three);
});

test('stays under 400 characters with four 16-character names', () => {
  const long = ['A', 'B', 'C', 'D'].map((ch, i) => ({ id: 'p' + i, name: ch.repeat(16), isBot: false, points: 999, roundsWon: 1 }));
  const text = pieResultText({ complete: true, championIds: ['p0'], standings: long }, { origin: 'https://a-reasonably-long-hostname.example' });
  assert(text.length < 400, `length ${text.length}`);
});

test('makes no reward claim and no durable-link promise', () => {
  const text = pieResultText({ complete: true, championIds: ['p4'], standings }, { origin: 'https://tondo.example' }).toLowerCase();
  for (const word of ['reward', 'unlock', 'bonus', 'win a', 'join my table', 'code']) {
    assert(!text.includes(word), `contains "${word}"`);
  }
});

test('returns an empty string for a pie that is not complete', () => {
  assert(pieResultText({ complete: false, championIds: [], standings }, { origin: 'x' }) === '', 'empty');
});

if (failures.length) {
  for (const f of failures) console.error(`\n  FAIL  ${f.name}\n        ${f.err && f.err.message}`);
  console.error(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(1);
}
console.log(`\n${passed} passed, 0 failed\n`);
```

Add `&& node test/share.test.mjs` to the end of the `test` script in `package.json`.
Run: `node test/share.test.mjs` → FAIL (module not found).

- [ ] **Step 2: Implement `public/js/share.js`**

```js
/**
 * The finished pie as plain text, for pasting into a group chat.
 *
 * Plain text because it pastes everywhere. It names everyone and spoils
 * nothing, and it asks the reader for nothing: no reward, no "join my table" —
 * a room code is dead 60 seconds after the table empties, so the link offers
 * a NEW table instead of promising the old one.
 */

const listNames = (names) => (names.length <= 2
  ? names.join(' and ')
  : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

export function pieResultText(match, { origin = '' } = {}) {
  if (!match || !match.complete) return '';
  const standings = match.standings || [];
  const nameOf = (id) => {
    const row = standings.find((r) => r.id === id);
    return row ? row.name : '';
  };
  const champions = (match.championIds || []).map(nameOf).filter(Boolean);
  const headline = champions.length > 1
    ? `${listNames(champions)} shared the pie`
    : `${champions[0] || 'Nobody'} took the pie`;
  const scores = standings.map((r) => `${r.name} ${r.points}`).join(' · ');
  return `🍕 TONDO — ${headline}\n${scores}\nFour slices. Start a new table: ${origin}`;
}
```

Run: `node test/share.test.mjs` → PASS.

- [ ] **Step 3: The button** — in `public/index.html`, inside `#scoreboard` after `#slice-pips`: `<button id="share-btn" type="button" class="btn btn-quiet score-share" hidden>Copy result</button>`. In `app.js`: register `share-btn` in the node list; in `renderMatch`, `nodes['share-btn'].hidden = !(over && m.complete)`; the click handler builds `pieResultText(app.snap.match, { origin: location.origin + location.pathname.replace(/index\.html$/, '') })`, writes it with `navigator.clipboard.writeText`, and sets `#score-sub` to `Result copied — paste it anywhere.`. On failure, show the text in a readonly `<textarea>` inserted after the button (selected, so a long-press copies it) and set `#score-sub` to `Copy failed — select the text below.`. Style `.score-share` to sit centred under the pips with the scoreboard's type; ≥44px tall.

In `public/js/mock.js`, add a `pieComplete` scene: the `roundOver` scene's table with `matchBlock()` returning `round: 4, complete: true, championIds: ['p2']` when `table.scene === 'pieComplete'`.

- [ ] **Step 4: Verify in the browser** — start your server (port 4710). Add to `scripts/shoot.js` a `--clipboard` flag that calls `Browser.grantPermissions` with `['clipboardReadWrite', 'clipboardSanitizedWrite']` for the origin before navigating. Run:
`TONDO_URL=http://localhost:4710 node scripts/shoot.js --scene mock:pieComplete --w 390 --h 844 --clipboard --probe "(async()=>{const b=document.getElementById('share-btn');if(!b||b.hidden)return JSON.stringify({visible:false});b.click();await new Promise(r=>setTimeout(r,300));const t=await navigator.clipboard.readText();return JSON.stringify({visible:true,sub:document.getElementById('score-sub').textContent,copied:t,length:t.length});})()"`
Expected: `visible: true`, `copied` in the exact format with every seat, `length < 400`. Also confirm the button is hidden in `mock:roundOver` (pie not complete). Capture `mock:pieComplete` at 390×844 into `.superpowers/sdd/frames/`. State in your report that iOS Safari's gesture-gated clipboard is UNVERIFIED here.

- [ ] **Step 5: Checks and commit** — `npm test` (now including share), `node scripts/check-contrast.js`.

```bash
git add public/js/share.js test/share.test.mjs package.json public/js/app.js public/index.html public/styles.css public/js/mock.js scripts/shoot.js
git commit -m "Share the finished pie: one tap copies plain-text standings

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: Screenshot checks that fail on regression

**Files:**
- Modify: `scripts/shoot.js` (`--check` mode)
- Modify: `package.json` (`shoot` script)
- Modify: `docs/qa/` (replace the stale set)
- Delete: `docs/qa-2026-09/` (folded into `docs/qa/`)

**Interfaces:**
- Consumes: `scripts/probes/seat-plaque-gap.js` (Task 6), `scripts/probes/round-boundary.js` (Task 5), mock scenes.
- Produces: `npm run shoot` — exits non-zero when any assertion fails.

All 24 PNGs in `docs/qa/` were committed at `c30d845` (2026-08-14) and show a design deleted since — a bare green ring with photo-portrait seats. A stale screenshot is worse than none because it is silently believable, and nobody had looked at a 360×640 phone with a decision bar open, which is how the unreachable Leave button survived. A capture tool that can never fail is decoration.

- [ ] **Step 1: `--check` mode** in `scripts/shoot.js`. When `--check` is passed:
  1. Pick a free port (`require('node:net').createServer().listen(0)`, read the port, close), spawn `node server/index.js` with `PORT` set to it, and wait for `GET /health` to answer. Kill that child on exit, success or failure.
  2. Run these assertions, each in a fresh Chrome page, collecting failures instead of stopping at the first:
     - **tray-selector**: at 360×640, `mock:callout` — `document.getElementById('stage').classList.contains('is-compressed')` is true AND `document.querySelectorAll('.stage.is-compressed ~ .tray').length === 1`.
     - **leave-reachable**: at 360×640 and 320×568, for `mock:tondo`, `mock:callout`, `mock:drawn`, `mock:wild` — scroll `.tray` and the page to the bottom; `#game-leave`'s rect bottom ≤ `innerHeight + 1`.
     - **seat-plaque-gap**: at 1024×768, 1280×800, 1440×900 × `mock:tondo`, `mock:callout`, `mock:drawn`, `mock:wild` — `scripts/probes/seat-plaque-gap.js` returns `pass: true`.
     - **banner-clear**: at 390×844, 1280×800, 1440×900 — the `atRoundOver.overlaps` from `scripts/probes/round-boundary.js` is empty.
     - **no-page-errors**: every page loaded during the check reports zero page errors.
     - **contrast**: `node scripts/check-contrast.js` exits 0 (run it as a child process).
  3. Capture every mock scene (`yourTurn opponents tondo callout drawn wild roundOver pieComplete`) at `320x568 360x640 390x844 852x393 1280x800` into `.superpowers/qa-latest/` (git-ignored).
  4. With `--update-docs` as well, also write the curated set into `docs/qa/`: `yourTurn`, `callout` and `roundOver` at `390x844` and `1280x800`, `callout` at `360x640`, and `pieComplete` at `1280x800` — 8 files named `<scene>-<W>x<H>.png`.
  5. Print one line per assertion (`PASS`/`FAIL` with the measured values) and a summary; `process.exitCode = 1` if any failed.

- [ ] **Step 2: npm script** — `package.json` `"shoot": "node scripts/shoot.js --check"`.

- [ ] **Step 3: Prove it can fail** — temporarily revert the tray selector in your working tree (`public/styles.css`: `.stage.is-compressed ~ .tray` → `.stage.is-compressed + .tray`), run `npm run shoot`, and record the output and exit code. Expected: non-zero, with `tray-selector` FAIL and `leave-reachable` FAIL at 360×640. Restore the file (`git checkout public/styles.css`) and confirm `git diff --stat public/styles.css` is empty. Never commit the reverted state.

- [ ] **Step 4: Pass on the real code** — `npm run shoot` → exit 0, every assertion PASS. Record the output. If an assertion fails on the real code (320×568 has never been measured on this build), that is a real defect, not a test to relax: do not weaken or remove the assertion — stop and report DONE_WITH_CONCERNS with the measured values.

- [ ] **Step 5: Replace the stale screenshots** — `git rm docs/qa/*.png`, `git rm -r docs/qa-2026-09`, then `node scripts/shoot.js --check --update-docs` and `git add docs/qa/`. Confirm `ls docs/qa` shows exactly the 8 curated files.

- [ ] **Step 6: Commit**

```bash
git add scripts/shoot.js package.json docs/qa
git commit -m "npm run shoot fails on regression: tray, reachability, seat/plaque, banner, errors, contrast; fresh docs/qa

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```
