---
target: Tondo game interface
total_score: 28
p0_count: 0
p1_count: 2
timestamp: 2026-08-14T22-14-17Z
slug: public-index-html
---
# Tondo Game Interface Critique

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of system status | 3/4 | Turn, reconnect, event, and decision states are well surfaced, but the same turn state is repeated across too many elements. |
| 2 | Match between system and real world | 4/4 | The shared table, hand, draw pile, top card, match rule, and familiar actions map naturally to an UNO-style game. |
| 3 | User control and freedom | 2/4 | Leave and callout escape paths exist, but tapping a Wild hides the hand and offers no way back. |
| 4 | Consistency and standards | 3/4 | Components are cohesive, though display typography and several competing status treatments weaken the product vocabulary. |
| 5 | Error prevention | 3/4 | Illegal cards teach instead of failing silently, start is guarded, and network errors recover; accidental Wild selection is not reversible. |
| 6 | Recognition rather than recall | 4/4 | Playable lifts, checks, match labels, card text, glyphs, and contextual rule bars make decisions recognizable. |
| 7 | Flexibility and efficiency | 2/4 | Native keyboard focus and Enter submission work, but the desktop draw action is separated from the visible deck and there are no lightweight accelerators. |
| 8 | Aesthetic and minimalist design | 2/4 | The custom pizza deck is distinctive, but repeated turn messaging, widely scattered desktop seats, and multiple pills compete for attention. |
| 9 | Error recognition and recovery | 3/4 | Errors use plain language and preserve state; copy and reconnect have useful recovery, with a few contextual gaps. |
| 10 | Help and documentation | 2/4 | Contextual teaching is strong, but there is no concise, discoverable rules reference for a first-time player. |
| **Total** |  | **28/40** | **Good foundation; concentration and accessibility need a focused pass.** |

## Anti-Patterns Verdict

**LLM assessment:** This does not read as a stock AI game. The custom topping marks, illustrated player portraits, ring-table composition, and server-driven contextual states give it real authorship. The weaker edge is a familiar dark-neon game-dashboard treatment: too many pill-shaped statuses, low-contrast blue-gray text, display type in ordinary controls, a bordered card with a very wide shadow on entry screens, and motion that is either continuously bobbing or absent when a card actually lands.

**Deterministic scan:** The detector returned one warning, `single-font`, at `public/index.html:1`, claiming that only Archivo Black is used. This is a false positive: the page imports Archivo Black, Archivo, Instrument Serif, and Space Mono, and the CSS uses all four. The scan found no other automated anti-patterns.

**Visual overlays:** No reliable overlay was available. The in-app browser exposes read-only page evaluation and no supported mutable injection surface, so the workflow correctly skipped script injection. Fallback evidence came from live desktop and 390×844 mobile walkthroughs of home, lobby, active-turn, and Wild states, plus the existing QA scene screenshots.

## Overall Impression

Tondo already knows how to teach the game. Its biggest opportunity is to behave more like a physical card table: gather people closer, let the hand and current match dominate, remove repeated status noise, and spend animation on cards and decisions rather than perpetual idle movement.

## What's Working

- Legal cards combine lift, full saturation, a check, text, shape, and accessible names; illegal taps shake and explain the mismatch instead of merely disabling learning.
- TONDO, callout, drawn-card, Wild, reconnect, and round-over states appear only when relevant and are announced through polite/assertive live regions.
- Mobile keeps the hand in the thumb zone, preserves one-screen play, supports horizontal overflow, and maintains 44px targets and reduced motion.

## Priority Issues

### [P1] The turn hierarchy is repeated and spatially scattered

**Why it matters:** On an active turn, the header chip, full-screen banner, table ribbon, player strip, status pill, hand label, and playable count all compete to say roughly the same thing. On wide screens, opponents sit near viewport edges instead of around the ring, so the user's eyes travel across empty space.

**Fix:** Constrain opponent seats around a capped table radius; reduce the player strip to identity, count, and one status; hide redundant event-ribbon turn messages; keep one persistent status plus one short celebratory turn cue.

**Suggested command:** `$impeccable distill` and `$impeccable layout`

### [P1] Muted states fall below a comfortable accessibility floor

**Why it matters:** Placeholder, room code, hint, and inactive status colors are faint on deep navy, while non-playable cards drop to 42% opacity and 30% saturation. Players with low vision or a dim phone screen lose useful rule and card information.

**Fix:** Raise muted text contrast to WCAG AA, keep unavailable cards readable while still clearly secondary, and standardize focus/disabled/error/success tokens.

**Suggested command:** `$impeccable audit` and `$impeccable colorize`

### [P2] Wild selection has no escape

**Why it matters:** An exploratory or accidental tap hides the hand and forces a topping choice. That violates the otherwise forgiving interaction model.

**Fix:** Add a clear “Back to hand” action, return focus to the selected Wild card, and keep the four topping choices as the only primary decision group.

**Suggested command:** `$impeccable harden`

### [P2] Motion and typography emphasize the wrong things

**Why it matters:** Opponents bob indefinitely and several transitions overshoot, while actual top-card changes have little tactile landing feedback. Archivo Black on routine buttons/status labels makes every control shout.

**Fix:** Use Archivo Black only for the wordmark and card faces; use Archivo 700 for UI controls; replace elastic/continuous movement with fast ease-out state transitions, a top-card landing, contextual bar reveal, and a restrained win/turn moment. Preserve reduced-motion alternatives.

**Suggested command:** `$impeccable animate` and `$impeccable typeset`

### [P2] Drawing is less intuitive than the physical metaphor suggests

**Why it matters:** Desktop players see a deck at the center but must find a separate button below the hand. First-time help is entirely reactive, so the visible pile implies an action it cannot perform.

**Fix:** Make the desktop deck a real draw button with a clear accessible label, retain the bottom draw button for compact layouts, and add a quiet rules disclosure on the entry screen.

**Suggested command:** `$impeccable clarify` and `$impeccable delight`

## Persona Red Flags

**Jordan (first-timer):** The match plaque and contextual explanations help immediately, but there is no quick rules reference before joining. The visible deck is not clickable, and six repeated turn cues make it harder—not easier—to know which one is authoritative.

**Sam (accessibility-dependent):** Native controls, focus outlines, live regions, non-color card cues, and reduced-motion handling are strong. Low-contrast placeholder/hint/status text is the main barrier; Wild selection also lacks a keyboard-friendly cancel route.

**Casey (distracted mobile user):** The hand and draw action sit in the thumb zone and state survives reconnects. Horizontal hands are taught with a swipe hint, but faint helper text and a large contextual panel can make recovery after interruption slower than necessary.

## Minor Observations

- The home and lobby panels use a 22px radius, 1px border, and 50px-blur shadow, which creates a generic floating-card treatment.
- The disabled Start button retains a muddy version of the primary yellow and does not explain that a second seat is required.
- The compact layout hides the room code; that is acceptable during play if the lobby remains the primary invite moment.
- The center turn banner briefly covers the match and top card; it should be shorter and visually lighter.

## Questions to Consider

- What if the table—not the dashboard chrome—carried almost all persistent game state?
- Can a new player understand “match topping or value” and “call TONDO at two cards” before the first deal without reading a rulebook?
- Which two moments deserve the most delight: a card landing, calling TONDO, or winning the round?

## Resolution Addendum

All five priority findings above were resolved. The table and turn hierarchy are concentrated, muted states meet the intended accessibility register, Wild has a keyboard-safe cancel path with focus restoration, motion now follows card/turn events and respects reduced motion, and the visible desktop deck is a real draw control with concise help available from every screen.

A separate final review then found four edge cases; those were resolved too: 568–719px landscape phones now use the side-by-side game layout with an internally scrollable decision tray, the landscape help target remains 44×44px, repeated live-region announcements are suppressed, and every stale game action becomes natively disabled while reconnecting. The post-fix heuristic score is **37/40**.

Verification: 390×844 portrait, 568×320/667×375/844×390 landscape, 1440×1000 desktop, all mock game states, keyboard/help/Wild recovery, reduced-motion behavior, reconnect gating, 44 automated rule/room tests, and a real four-player WebSocket round smoke test.
