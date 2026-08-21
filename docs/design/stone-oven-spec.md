# Stone Oven — design port spec (from "Tondo Stone Oven - standalone.html")

Ground truth: open `http://localhost:4600/_ref.html` (the bundled reference; takes ~2s to
unpack, desktop 1000px design). Extracted sources (exact numbers, read these):

- `/private/tmp/claude-501/-Users-gentlegen-Desktop-tondo/479acb05-7521-41bf-ac52-1be2f66124e9/scratchpad/stone-oven/template.html` — full page layout
- `.../stone-oven/f83a3cdf.html` — Card component (props: suit pep|bas|chz|anc|back, n, size sm|md|big, rot, lift, dim)
- `.../stone-oven/8c2497f8.html` — Seat component (props: label, initial, count, status, tone crust|sauce|basil|anchovy, active, size md|big)

## Fonts (Google Fonts, add <link> to index.html; real fallback stacks required)
- Display / numbers / names: **Bricolage Grotesque** 600/700/800
- Body / buttons: **DM Sans** 400/500/700
- Micro labels (MATCH, YOUR HAND, card code): **DM Mono** 500, letter-spacing .18–.2em, uppercase
- Status verbs / hints ("playing…", "then you", "Test is up first"): **Instrument Serif** italic 400

## Palette
- Page bg `#070C16`, radial glow `#121B2E` at top; shell panel `#0E1729`; hand tray `#0A1120`
- Hairlines `rgba(255,247,232,.08–.16)`; cream ink `#FFF7E8`; gold accent `#F5CB5C`; crust orange `#E0A44A` / `#E8B45E`
- Suits (gradient 160deg, edge = 3D bottom lip `0 5px 0 <edge>`):
  - pep `#D9503A→#B33421` edge `#7C2416`
  - bas `#4ECB78→#2FA25B` edge `#1C6B3C`
  - chz `#F5CB5C→#E0A63C` edge `#9A6C1C`
  - anc `#6E9EE0→#4A76BE` edge `#2F4E82`
- Card back: `#E0A44A` + polka dots `radial-gradient(#C4432B 26%, transparent 27%)` 16px grid, center navy tile `#16233C` w/ gold "T", rotated -8deg
- Seat tones: crust `#E8B45E→#C88B2E`/`#96631C`, sauce `#D9503A→#AE3320`/`#7C2416`, basil `#4ECB78→#2E9A57`/`#1C6B3C`, anchovy `#6E9EE0→#4571B8`/`#2F4E82`

## Card anatomy (md = 96×138, sm = 52×76, big = 126×182)
Border-radius 16 (md), border 4px solid `#FFF7E8`, shadow `0 5px 0 <edge>, 0 14px 22px rgba(0,0,0,.45)`,
per-card jitter `rotate(rot) translateY(lift)`. Contents top→bottom:
- corner number top-left: Bricolage 800, 22px (md), cream
- ghost number bottom-right, overflowing: 100px (md), `rgba(255,247,232,.16)`, line-height .8
- center mark: cream circle Ø52 (md), `inset 0 -3px 0 rgba(0,0,0,.12)`, containing flat CSS shapes:
  - pep: 3 circles `#B33421` (Ø ≈ .30/.23/.26 of mark)
  - bas: leaf `#2FA25B`, `border-radius:66% 6% 66% 6%`, rotate 14deg, ≈.7 of mark
  - chz: triangle `#E0A63C` via clip-path, ≈.74×.64 of mark
  - anc: fish body `#4A76BE` `border-radius:52% 42% 52% 42%` + tail triangle
- code bottom-center: DM Mono 500 10px (md), tracking .18em, `rgba(255,247,232,.9)` — PEP/BAS/CHZ/ANC
- dim (unplayable): `filter: grayscale(.5) brightness(.7)`
Specials (SKIP/FLIP/+2/WILD — not in the reference; same anatomy, bounded latitude):
suit-colored like any card, their icon replaces the shapes inside the cream circle, code = SKIP/FLIP/DRAW;
WILD = navy `#16233C` bg, gold `#F5CB5C` star in cream circle, code WILD.

## Seat anatomy
- Tile: rounded square (56px md / 68px big, radius 19), tone gradient, 3px cream border,
  `0 5px 0 <edge>` + drop shadow, **rotate(-5deg)**, initial letter centered (Bricolage 800, 23/28px, cream, counter-rotated 5deg)
- Count badge: cream pill bottom-right corner (min-width 24, h 24, radius 12, 2px border in tone edge, navy text, Bricolage 800 12px)
- Active: dashed gold ring `2px dashed rgba(245,203,92,.75)` inset -7px, radius 24, rotate 6deg
- Name pill under tile: radius 999, name DM Sans 700 13px + status Instrument Serif italic 14px;
  active → bg `rgba(245,203,92,.16)`, border `rgba(245,203,92,.45)`, gold text; idle → transparent bg, border `rgba(255,247,232,.14)`, cream 72%/45%
- Opponent hand: fan of `sm` card **backs** next to the tile, overlapping `margin-left:-34px`, rots ≈ -10/-2/+6

## Table (the stone oven)
- Outer stone ring: circle (576px ref), padding 16, `linear-gradient(160deg,#2A3247,#151C2C 60%,#0F1420)`,
  deep shadow + inset light lip; thin gold circle line inset 9px `rgba(245,203,92,.22)`
- Crust ring: radial `#F6D290→#E5AE5C 26%→#D89A45 48%→#B87A2A 76%→#8E5A1C`, inset shadows,
  char speckles (dark radial dots) + light flour dots
- Sauce center: inset 44px circle, radial `#A03A22→#7E2617 52%→#56160D`, slice lines
  (repeating-conic hairlines), warm glow ellipses, basil flecks, vignette
- Ghost "TONDO" behind center: Bricolage 800 46px, tracking .36em, `rgba(255,240,205,.09)`
- MATCH plaque: cream paper chip `linear-gradient(#FFFCF2,#F3E4C6)`, radius 11, rotate -2deg,
  `0 3px 0 rgba(96,58,14,.5)`; contents: `MATCH` DM Mono 10px `#9A7434` tracking .2em •
  16px suit dot • suit name Bricolage 800 17px in suit-edge color • `or` DM Sans 13px `#9A7434` • value Bricolage 800 17px `#16233C`
- Discard: top card `big` + up to 2 previous beneath at opacity .72/.45, rots ≈ -3/+9/-14,
  `filter: drop-shadow(0 18px 22px rgba(20,4,2,.55))`
- Below table: hint line Instrument Serif italic 19px `rgba(255,247,232,.5)`

## Header / hand tray
- Header: TONDO wordmark Bricolage 800 19px tracking .14em gold; turn chip = pill w/ 8px dot,
  bg `rgba(224,164,74,.16)`, border `rgba(224,164,74,.45)`, text `#E8B45E` DM Sans 700 13px;
  "then you" Instrument Serif italic 16px cream 45%; "?" 30px outline circle
- Tray (`#0A1120`, top hairline): your Seat (tone basil, status "you") + `YOUR HAND` DM Mono label;
  right side status label DM Mono gold 70% (e.g. WAIT YOUR TURN)
- Hand: cards fanned with per-card rot (≈ -11…+9) and lift, unplayable cards `dim`
- Draw chip: rounded rect `rgba(255,247,232,.06)` + hairline border, mini card-back (24×34, dots at 9px) + "Draw a card" DM Sans 700 14px cream 70%
- Hint under: Instrument Serif italic 15px cream 40%
