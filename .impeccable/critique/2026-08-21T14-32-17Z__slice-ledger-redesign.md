---
target: Tondo — Slice Ledger redesign
total_score: 27
p0_count: 5
p1_count: 6
timestamp: 2026-08-21T14-32-17Z
slug: slice-ledger-redesign
---
# Tondo — Slice Ledger Redesign Critique

Supersedes `2026-08-14T22-14-17Z__public-index-html.md` (28/40, pre-redesign). That
critique's own resolution addendum claimed 37/40. **This score is not directly
comparable** to either: the fonts, palette, table, layout and motion system have all
been replaced since. What is comparable is the finding list, tracked below.

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of system status | 3/4 | Everything is surfaced, and reconnect/away handling is excellent — but five treatments say "whose turn" at once, and the turn banner covers 100% of the match plaque. |
| 2 | Match between system and real world | 3/4 | The pizza-as-ledger metaphor is genuinely good; the execution does not render it — adjacent wedges differ by 1.004:1. |
| 3 | User control and freedom | 3/4 | Wild now has "Never mind" + focus restore (prior P2 fixed). Escape silently discards a pending Wild when the help dialog is open. |
| 4 | Consistency and standards | 3/4 | Native buttons everywhere, one focus ring, a real motion-token system, a hardened `[hidden]` guard. Undercut by ~124 colour literals bypassing the tokens and a truncated stylesheet. |
| 5 | Error prevention | 3/4 | Illegal cards teach instead of failing; away turns auto-resolve; start is guarded and explained. The disabled Start label is unreadable at 2.07:1. |
| 6 | Recognition rather than recall | 2/4 | Structurally excellent (stateful `aria-label`s, lift, tick), but the rank digit reads 1.45:1 on cheese and the colour-blind suit fallback is 8.09px. |
| 7 | Flexibility and efficiency | 2/4 | Keyboard path is clean and complete; no accelerators, and the desktop draw pile is a 44×63 target parked ~750px from the table. |
| 8 | Aesthetic and minimalist design | 2/4 | Charming art direction and a genuinely lovely phone layout, wrapped around a desktop view that leaves 83% of its width empty. |
| 9 | Error recognition and recovery | 3/4 | Reconnect, away-turn auto-resolve and room TTL are well engineered; the silent Wild cancel offers no undo. |
| 10 | Help and documentation | 3/4 | A real native `<dialog>`, reachable from every screen, all text ≥8.6:1. It is a dense wall of prose with no card imagery, behind a 30×30 trigger. |
| **Total** | | **27/40** | **Strong engineering bones; the redesign's own centrepiece does not reach the eye.** |

## Anti-Patterns Verdict

**LLM assessment:** This does not read as generated UI. The card faces, the plaque, the
oven ring and the seat plates are authored, and the code carries real reasoning —
comments that name measured worst-case strings, a Minkowski inflation for keep-out
geometry, an explicit `[hidden] { display: none !important }` guard with its two prior
bugs written up beside it. The weakness is not taste, it is **calibration**: nearly every
decorative value is tuned one or two steps too faint (wedge tint .13, glow .26, muted ink
.28–.45, oven watermark .09), so a design that is correct in structure lands as a dark,
low-contrast field.

**Deterministic scan:** `public/styles.css` fails a comment-balance check — final comment
depth 1, last `/*` opened at line 1788, EOF at 1799 with no `*/`. Verified by parser and
by `tail`.

**Surfaces used (stated per the brief):** all colour, geometry and CSSOM numbers come
from **real Chrome** (tab reported `document.hidden === true`, which is irrelevant to
layout/computed style but froze animation *progress* — so no claim here rests on observed
animation motion). Focus-ring behaviour was captured in the **in-app browser pane** with
**real `Tab` keypresses** while that surface reported `document.hidden === false`;
programmatic `.focus()` in the occluded Chrome tab did *not* apply `:focus` and its
readings were discarded. Responsive numbers come from **same-origin iframes at fixed
sizes** (`offsetWidth`, not rects), which avoids unreliable window resizing.

## What's Working

- **Keyboard and ARIA hygiene is genuinely excellent.** Zero non-native interactive
  elements, zero `tabindex` anywhere, every control has an accessible name. In-game tab
  order is help → deck → cards → leave, 9 focusables, and each card's name carries its
  state: `"Cheese 2 — does not match"`, `"Basil 4 — playable"`.
- **Focus is visible and passes.** One global rule (`styles.css:443`) gives buttons, cards
  and the deck a 3px gold ring at **11.57:1** against the panel. Inputs swap it for a
  border treatment that still measures **6.48:1** against the well interior and **4.15:1**
  against its own unfocused state — above the 3:1 floor. Not a bug.
- **The help modal is a native `<dialog>`** opened with `showModal()` (`:modal` confirmed
  true at runtime), so focus trap, Escape and inertness are the platform's. All body text
  measures 8.64–16.81:1.
- **Disconnect handling is better than most shipped games.** Closing a player's tab
  produced `"away — reconnecting"` and a truthful hint, and `AWAY_TURN_MS = 10000`
  (`server/rooms.js:22`) auto-resolves the turn, so a dropped player cannot stall a table.
- **The reduced-motion block is unusually thorough** — 14 rules, and every one of the six
  WAAPI/JS animation sites is independently gated in JS, which a CSS media block cannot
  reach. Zero `ease-in`, zero infinite keyframes, and every hover *transform* gated behind
  `@media (hover: hover) and (pointer: fine)`.
- **The phone layout is the best version of this game.** At 375×812 the board is 72.8% of
  the viewport width with a 56px topping ring, and the draw button is a full-size labelled
  control in the thumb zone.
- **Prior critique's P2 "Wild has no escape" is fixed** — a "Never mind" button (114×45),
  focus moved to the first suit, and `aria-label="Make the next topping pepperoni"`.

## Priority Issues

### [P0] `public/styles.css` is truncated mid-comment — the wide-desktop block it announces was never written

**Evidence (executed).** Comment-balance parse: final depth 1, last `/*` at **line 1788**,
file ends at 1799. `git show HEAD:public/styles.css` is 398 lines; the working tree is
1798 and stops mid-sentence: *"…min-height 701px keeps this strictly out of the phone band
below 700px,"*. CSSOM confirms 343 rules parsed, last rule
`@media (max-height:540px) and (min-width:560px) and (max-width:599px)`.

The truncated comment states the exact problem measured below: *"A 1800x876 desktop window
is the opposite: the column is ~750x835, and running the cramped tuning there is what
leaves the large empty void under the hand."* The fix was mid-authoring and is absent.

**Why it matters:** no visible breakage *today* (nothing follows the opener), but the file
is silently swallowing everything appended after 1788 — the next rule anyone writes will
do nothing, with no error.

**Fix:** close the comment, then write the block it describes (see next finding).

### [P0] The board is height-bound: 16.9% of viewport width, and the topping ring goes *negative* at common window heights

**Evidence (executed, iframe sweep at fixed sizes).** `--table-d` read live; `annulus` =
ledger radius − centre-column half-width, i.e. the ring left for toppings:

| viewport | `--table-d` | ledger | centre col | **annulus** | board % of width |
|---|---|---|---|---|---|
| 1800×900 | 445.68px | 304 | 205 | **+50** | **16.9%** |
| 1280×900 | 445.68px | 323 | 205 | +59 | 25.2% |
| 1024×768 | 346.88px | 251 | 205 | +23 | 24.5% |
| 1800×800 | 370.83px | 242 | 205 | +19 | 13.4% |
| 1800×775 | 352.12px | 227 | 205 | +11 | — |
| 1800×760 | 340.89px | 217 | 205 | +6 | 12.1% |
| 1800×745 | 329.67px | 208 | 205 | +2 | — |
| 1800×730 | 318.44px | 199 | 205 | **−3** | — |
| 1800×722 | 312.45px | 194 | 205 | **−5** | — |
| **1800×720** | **583.94px** | **454** | 205 | **+125** | — |
| 375×812 | 345.00px | 273 | 162 | +56 | 72.8% |
| 360×640 | 246.51px | 191 | 162 | +15 | 53.1% |

Three separate facts here:

1. **`--table-d` is identical (445.676px) at 1800×900 and 1280×900.** The board is purely
   height-bound; 520 extra pixels of width buy nothing.
2. **A 2px change in window height makes the board 87% bigger.** 1800×722 → ledger 194px,
   annulus −5. 1800×720 → ledger 454px, annulus +125. The two-column layout one pixel away
   does it right, which is the proof the single-column desktop path is under-tuned rather
   than the layout choice being wrong.
3. **For window heights ~721–744px at 1800 wide the annulus is ≤0** — the discard card and
   plaque are *wider than the ledger's radius*, so the topping ring is entirely covered. In
   the live game at 1800×747 I measured annulus **−13px** with **5 of 19 topping nodes
   (26%) geometrically inside the centre column's rect**.

**Fix:** this is the single-column desktop tuning that line 1788's comment was about — not
a two-column reintroduction. Give the stage a larger share of the vertical budget above
`min-height: 701px` (the `--chrome-h` term `259px + 91.104px * 1.4375` ≈ 390px of the
876px viewport is the binding constraint), and floor the annulus: `--table-d` must never
resolve below `centre-column-width + 2 × minimum-ring`. A ring under ~40px cannot hold a
26px topping.

### [P0] Wedge ownership — the entire premise of the Slice Ledger — is imperceptible

**Evidence (executed).** Live `.wedge-tones` computed background:
`conic-gradient(from 135deg, rgba(78,203,120,0.13) 0deg … rgba(217,80,58,0.13) … rgba(110,158,224,0.13) … rgba(232,180,94,0.13) 360deg)`.
Composited each tint over all three `.sauce` gradient stops (`#A03A22`, `#7E2617`,
`#56160D`) and measured adjacent-wedge contrast:

| sauce stop | basil\|pep | pep\|anchovy | anchovy\|crust | crust\|basil | max |
|---|---|---|---|---|---|
| `#A03A22` | 1.011 | **1.005** | 1.113 | 1.096 | 1.113 |
| `#7E2617` | **1.004** | 1.011 | 1.118 | 1.103 | 1.118 |
| `#56160D` | 1.010 | **1.006** | 1.111 | 1.094 | 1.111 |

**Two of the four wedge boundaries sit at ~1.005:1 — mathematically indistinguishable.**
The best boundary anywhere on the pie is 1.118:1. A player cannot see whose slice is
whose, so a topping landing in "your" wedge communicates nothing. The mechanic the whole
redesign is named after does not reach the eye.

The turn glow is the stronger half: `rgba(245,203,92,0.26)` over a 90° arc measures
**1.46–1.78:1** against unlit sauce depending on radius — still roughly half the 3:1 that
WCAG 1.4.11 asks of a meaningful graphical distinction, though turn state is redundantly
carried by four other elements so this is a failure of the *Ledger*, not of turn
communication.

**Fix:** the wedge tint needs to be a structural edge, not a wash — raise alpha well past
.13 and/or add a real divider stroke between wedges (a 2px `--hair-2` radial line reads at
any size and costs nothing). Target ≥3:1 between adjacent wedges. Then raise the glow to
≥3:1 against its unlit neighbour.

### [P0] Card rank digits are unreadable on three of five suits

**Evidence (executed).** `.card-index` computed live: **17.8035px, font-weight 800,
`rgb(255,247,232)`, `text-shadow: none`, `-webkit-text-stroke: 0px`** — nothing rescues
it. Contrast of that cream against each suit gradient's two stops, and against the
same after the non-playable `filter: grayscale(.5) brightness(.7)`:

| suit | ink / top stop | ink / bottom stop | dimmed top | dimmed bottom |
|---|---|---|---|---|
| **cheese** | **1.45** | **2.04** | 1.44 | 1.96 |
| **basil** | **1.95** | 3.06 | 1.95 | 2.88 |
| **anchovy** | **2.58** | 4.26 | 2.37 | 3.58 |
| pepperoni | 3.82 | 5.75 | 3.70 | 5.10 |
| wild | 12.72 | 14.72 | 7.33 | 7.94 |

17.8px at weight 800 is **below** the 18.66px bold threshold, so the bar is 4.5:1. Cheese
fails by 3×. Even judged generously as large text (3:1), cheese and basil still fail.

Compounding it: `.card-suit` — the **only non-colour cue for a colour-blind player** —
computes to **8.09px** at `rgba(255,247,232,.9)`, i.e. roughly 2:1 on basil. The
accessibility fallback is both the smallest and among the least legible text in the app.

**Fix:** darken the rank ink per suit rather than using one cream everywhere (a dark
`--*-edge` ink on cheese/basil reaches 7:1+ immediately), or add a solid contrasting
plate behind the digit. Raise `.card-suit` to ≥11px and full opacity.

### [P0] The turn banner covers 100% of the match plaque at every desktop size

**Evidence (executed, banner forced visible, animations finished, overlap computed as a
rect intersection):**

| viewport | banner | plaque | overlap | **% of plaque covered** |
|---|---|---|---|---|
| 1800×900 | 222×72 @y161 | 206×41 @y192 | 206×41 | **100%** |
| 1280×900 | 229×74 @y168 | 206×41 @y192 | 206×41 | **100%** |
| 1024×768 | 229×74 @y137 | 206×41 @y158 | 206×41 | **100%** |
| 375×812 | 156×53 @y150 | 163×33 @y172 | 156×30 | **88.8%** |
| 360×640 | 156×53 @y104 | 163×33 @y157 | 156×0 | 0.8% |

`z-index` 12 over 2. Duration is `showBanner('YOUR TURN', 'you', 700)` (`app.js:415`) plus
a 140ms exit — so for **~840ms at the start of every one of your turns**, the answer to
"what am I allowed to play?" is hidden behind the words "YOUR TURN".

**Fix:** the banner is the fifth redundant turn indicator (see P1 below). Deleting it
solves the occlusion and the redundancy together. If it is kept for the party-game beat,
translate it clear of the plaque — the plaque is only 41px tall and there is empty stage
above it.

### [P1] Five treatments compete to say "whose turn"

**Evidence (executed, live game at 1800×876).** Simultaneously on screen: header chip
`"● Your turn"` + `"then Nina"`; the centre banner `"YOUR TURN"`; the ribbon
`"Chef is up first"`; the tray pill `"Chef your turn"`; the right-hand label
`"2 PLAYABLE"`; and the hint `"Play a raised card, or draw from the deck."` On the
round-over screen the same pattern repeats five times for the winner.

This is the prior critique's P1 unresolved. It was reported fixed; the redesign
reintroduced it.

**Fix:** keep the header chip as the persistent authority and the tray pill as the local
one; drop the banner and the ribbon's turn-duplicating messages; keep "N PLAYABLE" since
it is the only element carrying *new* information.

### [P1] Muted text fails WCAG AA across every screen — the prior P1, regressed

**Evidence (executed).** Measured against real composited backgrounds:

| element | file | size | colour | ratio | need |
|---|---|---|---|---|---|
| `.input::placeholder` | styles.css:475 | 16px | `rgba(255,247,232,.28)` | **2.37** | 4.5 |
| `.who` "Open seat" | styles.css:594 | 15px | `rgba(255,247,232,.32)` | **2.78** | 4.5 |
| `.strip-code` room code | styles.css:633 | 11px | `rgba(255,247,232,.32)` | **2.72** | 4.5 |
| `.rule` "or join one" | styles.css:542 | 11px | `rgba(255,247,232,.32)` | **2.78** | 4.5 |
| `.field-label` | styles.css:482 | 11px | `rgba(255,247,232,.4)` | **3.64** | 4.5 |
| `.dir-label` "Clockwise" | styles.css:1026 | 10px | `rgba(255,247,232,.34)` | **3.62** | 4.5 |
| `.ghost-plus` "+" | styles.css:596 | 20px | `rgba(255,247,232,.3)` | **2.60** | 3 |
| `.txt` "then Nina" | — | 16px | `rgba(255,247,232,.45)` | **4.30** | 4.5 |
| `#start-btn` disabled | styles.css:451+438 | 14px | eff. α ≈ .406 | **2.07** | — |

The root cause is structural: the token set has **no alpha ladder**, so every muted step is
hand-written. `rgba(255,247,232, α)` appears on **50 separate lines** with 22 distinct
alpha values (.06 … .9). ~124 colour literals in total bypass `:root`.

Disabled controls are formally exempt from 1.4.3, so `#start-btn` at 2.07:1 is listed as a
usability problem (you cannot read the button that is blocking you), not a violation.

**Fix:** add `--ink-90/-70/-55/-40` tokens with measured ratios and replace the 50 ad-hoc
alphas. The floor for body text on `--shell` is α ≈ .62; for 10–11px labels, higher.

### [P1] Escape silently discards a pending Wild

**Evidence (reproduced at runtime, not read).** `app.js:1805` is unguarded:

```js
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') cancelWild();
});
```

Repro: open the Wild picker (`wildBarOpen: true`), open Help from the `?` button
(`dialogOpen: true`, focus on "Got it"), press Escape → dialog closes **and**
`wildBarOpen` becomes `false`. A player who opens the rules mid-decision loses their
selection with no message and no undo. `cancelWild()` also force-focuses a hand card
(`app.js:1801`) at the same moment the dialog restores focus, so the landing focus is
non-deterministic.

**Fix:** `if (helpDialog.open || e.defaultPrevented) return;` before `cancelWild()`.

### [P1] The desktop draw pile is a 44×63 target ~750px from the table

**Evidence (executed).** `#deck` at 1800×900: `offsetLeft: 26`, **54×78**; at 1024×768 and
at 1800×760 it floors to **44×63**. The table centre sits at x≈900, so the deck is pinned
to the far-left viewport edge, ~750px from where the player is looking, with no visual
connection to the pizza. Below 720px height the two-column band moves it to `left: 12px`
at 71×102 — bigger and better placed on the *smaller* window. On phones it is
`display: none` and replaced by a proper full-width "Draw a card" button, which is the
best version of the three.

**Fix:** anchor the deck to the table (just outside the crust) rather than the viewport,
and let it scale with `--table-d` instead of flooring at the 44px clamp minimum.

### [P1] `.strip-help` is a 30×30 target at every viewport

**Evidence (executed).** Confirmed at runtime in the iframe sweep — `btn 30x30` was the
sole sub-44px target returned at **all seven** sizes tested (1800×900, 1280×900, 1024×768,
1800×800/760/720, 375×812, 360×640). Declared at `styles.css:635`
(`width/height/min-height: 30px`), which overrides `.btn`'s `min-height: 44px` at equal
specificity by source order. On phones it sits 12px from the screen corner.

Also under 44px: `.code-row .btn-ghost` "Copy" at **63×38** (styles.css:561) and
`.seat-row .btn-tiny` "Remove" at **34** tall (styles.css:589).

**Fix:** keep the 30px *visual* circle, restore a 44px hit area via padding or a
`::after` overlay.

### [P1] `.wedge-tones` gets no reduced-motion hand-back

**Evidence (verified via CSSOM, correcting the static sweep).** Enumerated all 14 selectors
inside `@media (prefers-reduced-motion: reduce)`: `.wedge-tones` is **absent**, so its
420ms ownership cross-dissolve (`styles.css:839`) falls to the 1ms blanket damper and hard
cuts. The block's own comment says comprehension-carrying opacity changes must keep their
fade.

Two claims from the static sweep I checked and **disproved**: `.plate.is-loud` *is*
covered (rule 3 of the block), and `.wedge-glow`, `.tp-drop`, `.tp-ripple` and `.stage`
are all covered.

One real internal contradiction confirmed: `.turn-token` is declared twice —
rule 3 gives it `transition-property: opacity, display` with `allow-discrete`, and
rule 13 (`.turn-token { transition: none !important; }`) is later at equal specificity and
**wins**, making rule 3's inclusion dead code.

### [P2] Motion: the 550/800ms glow exception holds — with one edge case

The brief asked me to judge this rather than reflexively flag it. **It holds.** Evidence:

- The sweep carries information (direction of play, and a Flip reversing it), which is the
  standards' "explanation / spatial consistency" purpose, not decoration. The <300ms rule
  targets UI chrome — dropdowns, tooltips, modals — not travel across a board.
- **It cannot be outrun by the pacing it was designed for.** `THINK_MIN_MS = 1400`
  (`server/bot.js:21`), so the minimum gap between turn changes is 1400ms against a 550ms
  sweep — 2.5× headroom; the 800ms Flip still has 1.75×.
- It is implemented as a **CSS transition, not keyframes**, so a mid-flight retarget
  interpolates from the current angle instead of restarting — the correct choice per the
  interruptibility rule.
- Overshoot is small: I solved `cubic-bezier(.34, 1.4, .5, 1)` numerically — peak **1.0529**
  (5.29% over) at 56.5% progress, i.e. **4.8°** on a 90° hop and 14.3° on a 270° Flip arc.
  Against a 90°-wide wedge the glow never meaningfully lights the wrong player.

**The edge case:** the 1400ms floor is a *bot* constant. Four fast humans can change turns
in well under 550ms, and then the glow permanently lags the truth. Worth a cheap guard —
snap (or shorten to ~200ms) when a turn change arrives while the previous sweep is still
running.

Separately, `--table-d` is a registered `<length>` transitioned over 200ms
(`styles.css:766`) that drives `.ring` width/height, seat `left`/`top`, `.oven-mark`
`font-size` and `.center` `gap` — a full layout pass per frame on the largest element on
screen. It is correctly killed under reduced motion, and it is short, but it is the one
place the otherwise-disciplined motion system animates layout.

### [P2] The rules modal is a wall of prose

Reachable from every screen and fully legible (8.64–16.81:1), but it is six paragraphs of
text explaining a *visual* game with no card imagery — no picture of a match, no picture
of a Flip. For a game whose pitch is "cartoonish party game", the one place that teaches
it is the least playful surface in the app.

## Persona Red Flags

**Jordan (first-timer):** Reaches the table fast and the plaque tells them what to play —
except for the first ~840ms of every turn, when the banner covers it entirely. They will
never work out that the toppings mean ownership, because at 1.004:1 there is nothing to
work out. On a 1800×735 window they will not see a topping ring at all.

**Sam (accessibility-dependent):** Genuinely well served on the axes that usually fail —
every control native and named, tab order logical, focus ring 11.57:1, reduced motion
handled down to the WAAPI call sites. Then blocked by the axis that usually passes:
placeholder 2.37:1, the rank digit 1.45:1 on cheese, and an 8.09px suit code as the only
colour-blind fallback.

**Casey (distracted mobile user):** Best served of the three. 72.8% board, a real draw
button in the thumb zone, a swipe hint, 44px targets — except the `?` at 30×30 in the
corner. Reconnect is handled truthfully and the table cannot stall.

## Minor Observations

- The `TABLE CODE` placeholder is `BASIL-4821`, a plausible real code; at 2.37:1 it is
  ambiguous whether the field is pre-filled.
- `app.js:34–37` defines a `TONES` palette with five colours (`#C88B2E`, `#96631C`,
  `#AE3320`, `#2E9A57`, `#4571B8`) that exist nowhere in CSS, at a 155deg gradient angle
  against the stylesheet's 160deg.
- `#F0A092` is the app's only error/alarm colour and is duplicated across 6 selectors with
  no `--alarm` token. `--pep-bg` and `--bas-bg` are re-inlined verbatim at styles.css:1384–1385.
- Round-over shows no cumulative score across rounds — only the current hand counts.
- The lobby's three "Remove" buttons share one accessible name (`app.js:716`).
- `#home-msg`, `#lobby-msg` and `#net-banner` lack `aria-atomic`, so partial diffs may be
  announced.
- The `.oven-mark` "TONDO" watermark measures 1.21:1 — decorative and intentional, listed
  only so it is not re-flagged later.
- No horizontal overflow at any of the seven sizes tested.

## Questions to Consider

- If the wedge tint were strong enough to see, would the pie still look appetising — or is
  the .13 alpha protecting the art at the cost of the mechanic? This is the real trade and
  it needs your eye, not a threshold.
- The banner, the ribbon and the chip all announce the turn. Which one would you keep if
  you could only keep one?
- Mobile is the best version of this layout. What would desktop look like if it were
  designed *up* from 375px instead of down from 1800px?

## Verification Gaps (open)

- **Motion feel is UNVERIFIED.** Both available surfaces reported `document.hidden === true`
  for the second half of this session, which freezes CSS transitions and WAAPI and
  throttles rAF. Every motion statement above is derived from declared timings, CSSOM,
  numerically-solved bezier curves and server pacing constants — **not** from observed
  movement. The landing/flight/deal hand-off and whether the glow *reads* as travel need a
  recording or your eye.
- Hover states were verified structurally via source and CSSOM only; the in-app pane
  cannot produce `:hover`.
- `prefers-reduced-motion` was audited by enumerating the media block's rules, not by
  emulating the setting.
- All contrast figures for elements over the pizza's gradients composite against the named
  gradient **stops**; the exact painted pixel varies continuously with radius. Ranges are
  given where that matters, and the wedge conclusion was checked against all three stops.
