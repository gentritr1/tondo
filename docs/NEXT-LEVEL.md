# Tondo — the next level

**Date:** 2026-09-09 · **Against:** `fee48df` (v0.2.1)

What this is: an audit of where Tondo actually is, an honest read of its
retention problem, and a tiered plan for animation, art and the loop. Part of
Tier 1 is already built — §5 lists exactly what, with the evidence.

Every claim below is tagged by how it was established:

- **MEASURED** — a command was run and the output read. The command is named.
- **READ** — established by reading the code. File and line are named.
- **JUDGEMENT** — a design call. Argued, not measured.

---

## 1. Where Tondo actually is

### The good, and it is genuinely good

The engine is the strongest part of the project and none of this plan touches
it. The server is fully authoritative, the rules live in a pure seedable module
(`server/game.js`), rooms handle reconnect, host migration and away-turn
resolution, and there are real tests. The Slice Ledger board — a CSS pizza that
records who played what in per-player wedges — is a genuinely original idea,
executed with measured contrast, fluid scaling and a careful reduced-motion
path.

One piece of the motion is exemplary and is the standard the rest should be
held to: the played card. A WAAPI ghost flies from hand-or-seat to the pile, the
pile hides behind `.is-inflight`, and the ghost's last frame is byte-identical
to the settle's first because `LAND_RISE`/`LAND_SCALE` are declared once in JS
and read back by CSS (`app.js:44-52`, `styles.css:398-405`). The topping then
falls into the owner's wedge with a real accelerate-squash-settle curve and a
ripple fired at the exact impact frame. **READ.**

### The gaps

**Nothing accumulates.** A round ended, a banner appeared, a dead hand sat on
screen and one person could press a button. No score, no series, no standings —
`roundCount` existed only to rotate who deals. There was no reason for the next
round to exist beyond wanting it. **READ** (`rooms.js`, `game.js:257`).

**Six rules events had no motion at all.** SKIP, +2, REVERSE, WILD, TONDO and a
callout all resolved into a line of italic text. Worse, at a two-player table —
the likeliest casual setup — `advanceTurn(state, 2)` means SKIP, +2 and REVERSE
leave `turnPlayerId` unchanged, so no oven flash, no seat pop, no token hop
fire: three of the four action cards are visually identical to a number card.
**READ** + confirmed live with `animationstart`/`transitionrun` listeners: an
opponent declaring TONDO fired zero animations and zero transitions.

**No sound whatsoever.** No `Audio`, no `AudioContext`, nothing. For a party
card game that is most of the feel budget, unspent.

**No identity, so nothing could be built on it.** The only durable state was
`localStorage['tondo.name']` — a 14-character string that was not even loaded
into app state, just back into the input box. A returning player was
indistinguishable from a stranger who typed the same name. **READ**
(`app.js:762-775`).

**Delivery was untuned.** `server/index.js` wrote exactly two response headers,
`Content-Type` and `Content-Length`. No `Cache-Control`, no `ETag`, no
compression — every byte re-downloaded on every visit, with no way even to 304.
**MEASURED:** 241,685 bytes, every visit, forever.

**Art generated and never wired in.** `public/assets/` held 4.2MB that nothing
referenced — 94% of the tracked public tree — including four photoreal pizza
WebPs and four bot portraits. `/favicon.ico` 404'd on every single visit.
**MEASURED** (`curl`, `performance.getEntriesByType('resource')`).

**The docs lied about the game.** All 24 screenshots in `docs/qa/` were
committed at `c30d845` and never regenerated across two visual releases. They
show a bare green circle with photo-portrait seats; the shipped build is a CSS
stone-oven pie with letter tiles. Anyone auditing from `docs/qa/` was auditing a
game that no longer exists. **MEASURED** (`git log -- docs/qa`).

---

## 2. The retention problem, honestly

Tondo has no accounts, no server database, no push notifications and no store
presence. That rules out most of what "retention" normally means, and it is
worth being blunt about which game Tondo can win.

**It cannot win the solo daily-habit game.** A player alone on a Tuesday has bot
opponents and no stakes. Any attempt to manufacture a reason — daily login
rewards, streak guilt, an energy meter — would be the casino spectacle the
product brief explicitly forbids, and would be transparent besides.

**It can win "again, right now" and "call the same four people on Friday".**
That is a real, defensible loop, and it has three requirements Tondo did not
meet:

1. **Rounds must accumulate into something**, so "one more" is a move in a
   larger game rather than a repeat of the same one.
2. **The ten seconds after a round must be worth watching.** It is the only
   moment the whole table is looking at the same thing, and it was empty.
3. **The game must be good enough to talk about.** Nobody re-invites people to a
   competent prototype. Sound, character and the physicality of the cards are
   not decoration here — they are the invite mechanic.

**The loop, stated plainly:**

> A round ends → the scoreboard says what it was worth and how much pie is left
> → the table is one slice from a result, so the next round starts itself → the
> pie ends with a champion and a shareable outcome → someone says "again".

**JUDGEMENT.** This is a design position, not a measurement. Its weakness is
honest and worth stating: it produces almost nothing for a player who has nobody
to play with. Tier 3 addresses that with a local chef identity, but it is a
consolation prize, not the main loop, and it should not be oversold.

---

## 3. The plan

### Tier 1 — make a round matter *(built; see §5)*

| Workstream | Why | Status |
|---|---|---|
| **The pie** — four-round match, scoring, standings | Nothing accumulated | **Built** |
| **The round-over scoreboard** | The one shared moment was empty | **Built** |
| **Sound** — full synthesised palette | Zero audio existed | **Built** |
| **`events.js`** — derive what happened from snapshot deltas | Foundation for sound *and* motion | **Built** |
| **Keyed seats** | Fixed 3 audited defects at once | **Built** |
| **Delivery** — compression, ETag, content hashing | 242KB re-downloaded every visit | **Built** |
| **Favicon** | A 404 on every visit | **Built** |
| **The unreachable Leave button** | A CSS rule matching *zero* elements | **Built** |
| **Sound on the impact frame** | Audio led the card by 260ms | **Built** |
| **Two-player REVERSE** | Announced a reversal that never happened | **Built** |
| **The warm ground** | A *blue* glow sitting behind a warm pizza | **Built** |
| **Nobody waits for the host** | A table stalled on one person's phone | **Built** |

### Tier 2 — make it worth talking about

Ordered by the judged roadmap. Each names the audit finding it answers.

**2.1 Bots that can be caught.** `bot.js:73` is
`if (view.canDeclareTondo) return { action: 'tondo' }` — unconditional. Bots
*never* forget, so the home screen's own promise ("catch your friends forgetting
TONDO") is unreachable in a solo game. Give each bot a miss rate and distinct
think-time personality. **Acceptance:** extend `scripts/measure-scoring.js` with
a `--callouts` mode and show ≥1 callout window per pie on average over 2000
rounds — measured, not assumed.

**2.2 Three of four action cards look like a 7 at two players.**
`server/game.js:365-389`: at two seats SKIP, PLUS2 and REVERSE all
`advanceTurn(state, 2)`, so `turnPlayerId` never changes and no oven flash, seat
pop or token hop fires. `events.js` now distinguishes these correctly (see §5),
but nothing renders the distinction yet. At two seats the goal is *effect*
legibility — "something happened, you lost your turn" — not direction.

**2.3 Motion for the remaining silent events.** SKIP duck, +2 travelling from
attacker to victim, the WILD sweep raised from its invisible 10% alpha, a TONDO
ring pulse, acknowledgement for the caller. Exact values are in the motion audit.
**Not** screen shake: Tondo has no camera layer, so "shake" means translating the
stage, which fights the one-screen constraint and is the effect most associated
with the casino register the brand forbids.

**2.4 The round boundary looks like a round boundary.** `planTravel` returns null
unless `prev.phase === 'playing'`, so a new deal produces **zero** travel ghosts
at the one moment a deal is literally what is happening. Also: the win banner
covers the top seat (visible in every round-over capture in `docs/qa-2026-09/`).

**2.5 One tap to a table.** `bootHome` only *prefills* the code from `?code=`; it
does not join. With a known name, an invite link should seat you with no
intermediate screen. Add "One quick pie" — one tap from cold to a dealt table
with three bots.

**2.6 The four a11y correctness defects.** Chief among them: `app.js` labels the
top card `'Top card: ' + prettyCard(top)`, and `prettyCard` of a WILD returns
just "Wild" — the chosen suit lives in `g.activeSuit`, so after a Wild the single
most important element on the board tells a screen-reader user nothing.

### Tier 3 — later

- **Haptics** as pure enhancement (`navigator.vibrate`; iOS Safari does not
  support it — that is fine, it degrades to nothing).
- **Share the finished pie**: one tap copies plain text naming everyone and their
  score. The clipboard path already exists; `match.standings` is already sorted.
- **A local chef profile** — versioned from the first write, additive-safe. This
  is the consolation prize for a solo player, not the main loop, and should not
  be oversold.
- **Regenerate QA on every change** and make `npm run shoot` *fail* rather than
  merely capture.

### Deliberately not doing

The judged review killed more than it kept. The most important rejections:

| Idea | Why not |
|---|---|
| Durable named tables (`/?table=friday-crew`) | Killed by all three of its own judges. `EMPTY_ROOM_TTL_MS = 60000` means create-or-join by slug turns a clean 404 into a **silent empty room** — the returning player is seated alone in a lobby needing two, with no way to summon anyone. An empty named table says "your friends chose not to come"; a dead link just says the night is over. It also leaks a slug key per table forever. |
| Streaks, dailies, XP, unlock currency, loot boxes, season passes | All three proposals rejected these independently. Decisive mechanical argument: with no push, the game can never tell you a streak is at risk, and a localStorage streak evaporates on a cleared cache or a second device. Casino-shaped *and* non-functional. |
| An awards/badges engine | Absence-conditions ("never forgot TONDO") read a client-derived event stream that returns `[]` whenever `prev` is null — a reconnect silently grants the award. |
| Chasing bot *strength* | Measured: a threat-aware heuristic written to beat the current bot went **1973–2027 over 4000 rounds**. A coin flip. The headroom is thin; personality is worth more than strength. |
| Idle card "breathing" sway | Decoration carrying no information, on the surface with the most nodes, in a file whose comments record effects being removed *specifically* because they repainted. |
| Filling the ~6s inter-turn gap with a minigame/ticker/timer | The gap is three legible ~2s beats (bot think is 1400–2600ms), not dead air. |
| Wiring in the four bot portraits, or photoreal pizza anywhere | Four mutually incompatible art languages. And a bitmap pie cannot be cut into 2/3/4 wedges, tinted per owner, or carry the lit-slice outline — the board is the scoreboard, not decoration. |
| House-rule toggles (stacking +2, jump-in…) | Genuinely the cheapest "make next week different" engine available, and genuinely out of scope: every toggle is a server rules change plus a lobby surface plus a protocol change. Worth revisiting. |

## 4. How this gets verified

Claims about motion cannot be made from the Browser pane. A hidden or unfocused
surface throttles `requestAnimationFrame` to zero, freezes transitions mid-flight
and has been observed compositing the wrong colour — a screenshot taken there is
not evidence.

`scripts/shoot.js` exists for this. It drives a real headless Chrome over CDP,
plays a real bot game over a real WebSocket (not `?mock=1` snapshots, which
cannot prove anything about the live socket path), asserts `document.hidden ===
false` before it captures, finishes outstanding animations before measuring, and
reports page errors rather than silently writing a broken screenshot.

```bash
node scripts/shoot.js --out docs/qa-2026-09 --scene game --w 1440 --h 900
node scripts/shoot.js --out docs/qa-2026-09 --scene pieComplete --w 390 --h 844
node scripts/shoot.js --scene game --reduced --probe "document.getAnimations().length"
```

Two traps it now guards, both of which produced a wrong answer first:

- **Round-over detection.** The first version watched the banner — but the same
  element also says "YOUR TURN", so it captured a mid-round screen and labelled
  it `roundOver`. It now requires the win tone *and* the host's deal button.
- **A fixed debug port.** A previous run's Chrome outlives its launcher, so the
  next run attached to a zombie still on `about:blank` — which looked exactly
  like a broken driver for 628 no-op ticks. Every run now takes its own port and
  kills only its own browser, matched on a per-run profile directory.

Numbers in this document that pin a threshold name the script that produced
them. `scripts/measure-scoring.js` is why the pie is four rounds.

---

## 5. What was applied in this pass

### The pie — a round now matters

A match is four rounds ("slices"). The winner banks the value of every card left
in every other hand — numbers at face value, actions 20, WILD 50, the UNO scale
players already know. Highest total after the fourth slice takes the pie; ties
break on rounds won and a genuine tie is shared.

**Why four rounds and not "first to N".** **MEASURED**, 2000 complete bot rounds
per table size via `scripts/measure-scoring.js`:

| Players | median | mean | p25 | p75 | p95 |
|---|---|---|---|---|---|
| 2 | 51 | 58.8 | 31 | 79 | 130 |
| 3 | 85 | 89.0 | 62 | 112 | 157 |
| 4 | 137 | 139.7 | 105 | 170 | 228 |

A round is worth 2.7× as much at four players as at two, so any single "first to
N" target runs about 4 rounds at one table size and 8 at another — and at four
players the first round win usually decides it. A fixed four slices is the same
promise at every table, and the measured spread (p25 105 → p75 170 at four
players) is wide enough that the last slice can still turn the result over.

**The forfeit trap, caught before it shipped.** `removePlayer` returns a leaving
player's hand to the deck *before* it can end the round (`game.js:451` ran ahead
of `:458`). The obvious scoring implementation reads the hands at `endRound` and
would have scored those cards as zero, quietly shorting the winner. `endRound`
now takes the forfeited points as an argument, banked before the splice.
`test/match.test.js` pins it.

**Verified:** 13 new tests in `test/match.test.js` covering card values, the
round result, the forfeit path, pie completion, tie-sharing, mid-pie joins and
departures. `npm test` → 74 passing.

### The round-over moment

The scoreboard now replaces the dead hand: who won the slice and for how much,
the running standings with your row marked, slice pips, and a button that says
"Next slice" or "New pie". Before / after captures are in `docs/qa-2026-09/`.

### Sound, from nothing

`public/js/sound.js` — twelve voices, entirely synthesised from oscillators and
filtered noise. **Zero bytes, zero requests, no asset pipeline**, which is the
only approach that fits a project with no build step. The character aimed for is
a wooden table in a warm room: short, soft-edged, damped.

It solves the problem that makes naive sound wiring unbearable here: the client
repaints everything from every snapshot, so hooking sound to render would fire
on repaints. `playForEvents` takes derived events and plays **exactly one** voice
per snapshot, chosen by priority — what happened *to* someone outranks what was
played, which outranks whose turn it is. A burst limiter drops the third and
later sound in a 120ms window entirely rather than smearing them.

Also: lazy `AudioContext` created on a real gesture and resumed on every
subsequent one (which is what iOS needs after it suspends), silence when the tab
is hidden, and a mute toggle that persists and is marked by *shape* — a slash,
not just a dimmer colour.

**Verified:** instrumented `AudioContext.prototype.createOscillator` and
`createBufferSource` during a real bot game — 22 audio nodes across 10 distinct
bursts, burst sizes 2–3, never exceeding the limiter's cap.

### `events.js` — the keystone

A pure module that derives thirteen event types from two consecutive snapshots:
play, skip, plus2, reverse, wild, tondo, callout, draw, deal, win, reshuffle,
turn, connect/disconnect. No DOM, no side effects.

The subtleties it gets right are the ones that would otherwise be silent bugs: a
SKIP's victim is read from the *previous* turn order, because by the time the
snapshot arrives the turn has already moved past them; a REVERSE is read the
same way because `direction` has already flipped; and a callout is told apart
from a +2 by being the only way a hand grows by two with no card on the pile.

Deliberately **not** reduced-motion aware — a player who asked for less movement
still wants the sound and the announcement. Filtering belongs at the consumer.

**Verified:** 17 tests in `test/events.test.mjs`, driven through the *real*
`server/game.js` and diffing real `viewFor()` output rather than hand-written
fixtures — a fixture would only prove the deriver agrees with my idea of the
wire shape. Includes a full seeded round played to completion.

**This unblocks Tier 2.1**: every silent event now has a hook to hang an
animation on.

### Keyed seats — one fix, three defects

`renderSeats` built one HTML string for the whole ring and assigned it to
`innerHTML` whenever it differed. Because *any* difference rewrote *every* seat,
three things followed: a card count changing anywhere destroyed all four seats,
restarting the alarm on a player who had forgotten TONDO because of somebody
else's move; the seats' own CSS opacity transitions could never run, because the
node that would transition was replaced rather than changed; and it was the most
DOM churn in the app on the most frequent event in the game.

**Verified, with a pre-fix control** — the same probe against `HEAD` and against
the fix, stamping each seat node with an identity the DOM cannot forge:

| | seat nodes surviving | real repaints observed |
|---|---|---|
| Before (`innerHTML`) | **0 of 3** | 9 |
| After (keyed) | **3 of 3** | 11 |

The first run of this probe was a *vacuous pass* — 3/3 survived, but zero
repaints had occurred, so it never exercised the failing path. The probe now
drives moves itself and reports `valid: false` if nothing changed.

### Delivery

`server/assets.js`: brotli/gzip negotiated and cached in memory, strong `ETag`
on everything, and content hashing that works without a build step — the server
stamps `?v=<hash>` into the documents that reference each file, so hashed URLs
get `max-age=31536000, immutable` and everything else revalidates.

The hash is **transitive**. `app.js` imports `net.js`, so hashing `app.js` by its
own bytes alone would leave a year-cached `app.js` pointing at a year-cached
`net.js` — a change to `net.js` would never reach anyone. A file's hash mixes in
the hashes of everything it references.

**Verified:**

| | before | after |
|---|---|---|
| First visit | 241,685 B | **65,300 B** (−73%) |
| Repeat visit | 241,685 B | **0 B of body** (4 × 304) |
| `Cache-Control` | *(none)* | `immutable` on hashed, `must-revalidate` on entry |

- Editing `net.js` changed `app.js`'s stamped URL (`52d3676…` → `27766ab…`) and
  restoring it changed it back — the hash is content-derived, not time-derived.
- A full round played end to end through the stamped module graph.
- `_ref.html` (1.7MB) and `_concept/` are now 404 in production.

### The unreachable Leave button

`styles.css` had a carefully measured block — capping and scrolling the tray on
short phones so contextual bars cannot push the primary controls out of the
viewport. Its selector was `.stage.is-compressed + .tray`, and `#celebration`
sits between `#stage` and `.tray` in the markup, so the **adjacent**-sibling
combinator matched **zero elements**. The rule had never applied to anything,
and the symptom it was written to prevent was live the whole time.

**Verified, with a pre-fix control** — same probe, 360×640, callout bar open,
after scrolling every scrollable container to the bottom:

| | tray scrollable | Leave button | reachable |
|---|---|---|---|
| Before (`+`) | no | 744px (viewport is 640) | **no** |
| After (`~`) | yes | 632px | **yes** |

Checked in all four bar states (tondo, callout, drawn, wild). The stylesheet's
other two adjacent-sibling selectors were audited at runtime and both match
correctly (9 and 1 elements), so this was the only instance.

*A selector that silently matches nothing is indistinguishable from a rule
nobody wrote. Assert the match count; do not assume it.*

### Sound on the frame the card lands

The first version of `sound.js` fired at snapshot time. The played card is still
in flight for `MS.flight` = 260ms at that moment, so every impact sound arrived
**260ms before the card it described** — and audio leading video is more
noticeable than audio trailing it. `playForEvents` now takes `{impactAt}` and
every voice takes a start offset, scheduled natively against `ctx.currentTime`.
It is the same delay `ledgerAdd` had been using at `app.js:518` all along.

The same pass spent the actor/victim data `events.js` was already computing and
throwing away: a +2 that lands on **you** drops its fundamental from 150Hz to
100Hz and gains half again in level; the same +2 across the table does not.

### Two-player REVERSE announced something that never happened

`server/game.js:374-380`: at two seats a REVERSE **acts as a SKIP and never
touches `direction`**. `events.js` was emitting a `reverse` event for any REVERSE
card, so at the most common casual table size it announced a rule the server had
not applied — and would have spun a direction sweep for it. It now emits `reverse`
only when `direction` actually changed, and otherwise reports the skip that
really happened, flagged `viaReverse`. Two tests pin both halves.

### One decision on the table at a time

Playing a **drawn** WILD left the drawn-card bar and the suit picker on screen
simultaneously, and the drawn bar's "Play it" simply re-opened the picker the
player was already looking at. Found because the capture harness clicked it 1855
times in one run without the round advancing.

### The banner no longer contradicts the scoreboard

On the last slice two things are true at once — somebody won the round, somebody
took the pie — and they are usually different people. The banner said "CARMELA
WINS" directly above a scoreboard saying "Pina takes the pie". It now announces
the pie when the pie is complete.

### Nobody waits for the host

Five of nine judges named this independently as the highest value per line in
the whole review, and it was true: a round ended, and one specific person had to
press a button. Everyone else read *"Round over — waiting for the host"* with no
control at all, so a table stalled whenever that person put their phone down.

Now: when a slice ends the server arms a **10-second countdown** and then deals
the next slice itself. Any seated human may deal now, or **Hold** — which is
sticky, and only spent when somebody actually deals, because a hold that quietly
expired would be worse than no hold at all.

Two deliberate restraints. The countdown **never arms on a finished pie** — that
is the one boundary that has earned a pause, and it is where the group decides
out loud whether to play another. And it is rendered as a **quiet line in the
tray's own type**, never a large counting digit and never a tick sound: the beat
exists so the table can read the standings and groan about them, and a
slot-machine reel would turn a pause into pressure.

`nextDueAt` goes on the wire as an absolute epoch millisecond rather than a
remaining duration, so a client renders the countdown from its own clock and the
server never has to tick at it.

**Verified**, in a real browser and over a real socket:

- Round over → the hint counted `10 → 1` and **the table dealt itself at
  exactly 10s with nothing clicked**.
- Hold → *"Held — deal when the table is ready."*, and it had **not** dealt 14
  seconds later, well past the original window.
- `npm run smoke` seats **two humans and a bot** on one table and asserts the
  part a single client cannot: the guest is not the host, both seats see the
  clock, the guest's hold reaches the host, and **the non-host's deal is
  accepted**.
- 7 new unit tests, including that a finished pie never arms and that the clock
  will not arm into a room with no connected human.

*Protocol v1.2.* `nextDueAt` and `held` are additive; the `newRound` permission
change only widens what is accepted, so no existing client breaks.

### The warm ground

The one place the design spent extra light, it spent it **cold**: `--page-glow`
was `#121B2E`, a blue radial sitting directly behind a warm pizza, pooled at the
top of the page where it lit nothing. Four surface tokens now run warm and the
glow is repositioned into a lamp pool under the board.

Doing half of this is worse than doing none — the first attempt changed three
tokens and left the tray navy, which just moved the problem into a visible seam
across the middle of the screen. It is four tokens plus the two hand-fade stops
that hard-coded the old navy as their transparent end.

**Verified with `npm run contrast`**, a new checker that composites the whole
translucent ink ladder against every live surface read out of the stylesheet.
Worst case moved from 6.18:1 to **5.58:1** (`--ink-3` on the glow) against a
4.5:1 floor — every word-carrying rung still clears AA, and the check is now
repeatable rather than a one-off claim.

### Housekeeping

- **Favicon** — an SVG pie. Also *stops* the browser requesting `/favicon.ico`,
  which had been 404ing on every visit. Page errors during a full game: **0**.
- **`public/assets/` 4.2MB → 1.5MB.** `pizza-table-v2.png` moved to `art/`.
  Worth a correction: it was reported as a duplicate of the 238KB WebP, and it
  is not — it is 1254×1254 against the WebP's 1024×1024, a higher-resolution
  master. Deleting it would have lost detail, not just weight, so it was moved
  out of the served tree instead.
- **`PROTOCOL.md` → v1.1.** The `match` block is purely additive; a client that
  ignores it plays exactly as before.
- **`docs/qa-2026-09/`** — fresh captures, since the old ones show a game that
  no longer exists.

---

## 6. Still open

- **Tier 2 motion is specified but not built.** `events.js` is the hard part and
  it is done; the animations are not.
- **iOS audio is UNVERIFIED.** Unlock and resume are written to the documented
  pattern and verified in headless Chrome. Neither Safari nor a real iPhone has
  run this. It needs a device before anyone claims sound works on iOS.
- **Sound character is UNVERIFIED by ear.** Synthesis parameters were reasoned,
  and node scheduling was measured — but nobody has *listened* to it. It needs
  someone to press the speaker button and say whether it sounds warm or cheap.
  Tuning is a matter of editing numbers in one table in `sound.js`.
- **Keyboard play has gaps.** Not yet traced end to end.
- **Two latent rules issues**, both **READ**, neither fixed: a missed TONDO can
  be erased by drawing at a two-player table, and the bot's rank tie-break is a
  biased comparator rather than the coin toss its comment claims.
- **The warm-ground palette is captured but not shipped.** Side-by-side renders
  exist; the change is four `:root` tokens plus two hard-coded fade stops, and
  the contrast maths was checked as neutral. It is a taste call and is waiting on
  a decision. The narrower version — fixing only `--page-glow`, a *blue* glow
  sitting behind a warm pizza — is the recommended first step either way.
- **The win banner still covers the top seat.** Visible in every round-over
  capture. Tier 2.5.
