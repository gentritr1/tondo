# TONDO — wire protocol (v1.3)

This file is the contract between `server/` and `public/js/`. Neither side may
deviate from it without updating this file first. All messages are JSON objects
with a `type` field, sent over a single WebSocket at the same origin (`ws://host/`).

**v1.3 (2026-10-06)** adds per-socket limits and an Origin check on the
WebSocket upgrade (see *Limits*), and widens the room-code space. The code
SHAPE is unchanged — still `WORD-NNNN`, still at most 10 characters — so no
client change is needed: only the word list and the random source moved.

**v1.2 (2026-09-09)** adds the round-boundary clock: `nextDueAt` and `held` on
`match`, a new `hold` client message, and a **permission change** — `newRound`
is now accepted from any seated human, not only the host. That last part is the
only non-additive change in this version: it *widens* what is accepted, so no
existing client breaks, but a client that hid its deal button behind `isHost`
will keep hiding it and should be updated.

**v1.1 (2026-09-09)** adds the `match` block to the `state` snapshot — the pie.
The change is purely ADDITIVE: every v1 field keeps its name, type and meaning,
no client→server message changed, and a client that ignores `match` plays
exactly as it did before. That is why the version moved by a minor step rather
than breaking the freeze.

## Game summary

Tondo is a 2–4 player UNO-style card game (pizza theme).

- **Suits** (4): `pepperoni` (#ff2e6b), `cheese` (#ffc93d), `basil` (#3ddc7f), `anchovy` (#4d9dff).
- **Deck** (68 cards): per suit one each of `0`–`9`, plus 2× `SKIP`, 2× `PLUS2`, 2× `REVERSE` (16/suit); plus 4× `WILD`.
- **Deal**: 7 cards each. Flip cards from the deck until a NUMBER card appears; that's the starting top card.
- **Turn**: play a legal card, or draw exactly one card.
  - Legal = card is WILD, or suit matches the active suit, or value matches the top card's value.
  - Active suit = suit chosen for the last wild if the top card is WILD, else top card's suit.
  - Drawn card playable → player must decide: play it or keep it (pass). Drawn card not playable → server keeps it and advances the turn automatically.
- **Actions**: `SKIP` next player loses turn. `PLUS2` next player draws 2 and loses turn. `REVERSE` flips direction (acts as SKIP with 2 players). `WILD` player picks the next suit. No stacking.
- **TONDO call**: a player holding exactly 2 cards may declare "TONDO" (any time before playing down to 1). If a player reaches 1 card without having declared, they are *vulnerable* until the start of their next turn; any other player may `callout` them → the vulnerable player draws 2 and is no longer vulnerable. Cards forced on a player (a `PLUS2`, a callout penalty) also end the vulnerability; a card they choose to draw on their own turn does not — at two players a SKIP or REVERSE can hand the turn straight back to a vulnerable player, and drawing used to erase the miss. Callout eligibility is the vulnerable flag alone, so at two players a target can briefly hold two cards. Declaring resets when the hand grows above 2. Round end clears every TONDO flag.
- **The pie**: a match is four rounds ("slices"). The round winner banks the value of everyone else's remaining cards; highest total after the fourth slice takes the pie. See *The pie* below.
- **Round over**: first player to 0 cards wins. Any seated human deals again; the opening seat moves to the seat after the previous opener each round, tracked by seat so a player joining or leaving between rounds does not skip or repeat anyone. `turnPlayerId` is `null` while the round is over, and the winner stays in `players` even if they leave.
- When the draw pile empties, reshuffle the discard pile (minus the top card) into it. If both are empty, draws are no-ops.

Bots: fill seats via host's `addBot`. Each named bot has a personality (`server/bot.js` `PERSONALITIES`): a chance to remember TONDO, a chance to call out a vulnerable player (rolled once per bot when the window opens, acted on after 1.4s so a human gets the first beat), and a think range. Think time scales with how many cards the bot could play, so a real choice visibly takes longer than a forced one. Bots forget TONDO at a rate tuned so a table of one human and three bots averages at least 0.30 callout windows on a bot per round (`node scripts/measure-scoring.js --callouts`).

## Client → server

| type | payload | notes |
|---|---|---|
| `createRoom` | `{name}` | creates room, seats sender as host |
| `joinRoom` | `{code, name, token?}` | `token` reclaims its seat — even over a half-open socket the server still believes in (the token outranks the stale socket, which is terminated). New players may join in `lobby` or `roundOver`, never mid-round |
| `addBot` | `{}` | host, lobby or roundOver, up to 4 seats |
| `removeSeat` | `{seatId}` | host, lobby or roundOver, bot seats only |
| `startGame` | `{}` | host, lobby only, ≥2 seats |
| `newRound` | `{}` | **any seated human**, roundOver only. Not host-gated: a table must never stall because one person put their phone down |
| `hold` | `{}` | any seated human, roundOver only. Stops the between-slices countdown until somebody deals — sticky, not a snooze |
| `leaveRoom` | `{}` | |
| `play` | `{cardId, suit?}` | `suit` required iff card is WILD |
| `draw` | `{}` | |
| `pass` | `{}` | only valid while deciding a playable drawn card |
| `tondo` | `{}` | declare TONDO |
| `callout` | `{targetId}` | punish a missed TONDO |
| `sync` | `{}` | request a fresh snapshot |

Unknown/invalid → `error` + fresh `state` snapshot (once seated; before a seat exists only the `error` is possible).

Host: `hostId` names the original host. While that seat is disconnected (or gone), every
seated human temporarily holds host powers and sees `isHost: true`, so a vanished host can
never freeze the table; the title snaps back when they reconnect.

## Server → client

| type | payload |
|---|---|
| `joined` | `{roomCode, youId, token, reconnected}` (sent only to that socket) |
| `state` | full per-player snapshot, see below (the ONLY gameplay message; re-broadcast whole on every change) |
| `left` | `{}` ack of `leaveRoom` |
| `error` | `{message}` human-readable string |

## `state` snapshot shape

```js
{
  type: 'state',
  phase: 'lobby' | 'playing' | 'roundOver',
  roomCode: 'BASIL-4821',
  youId: 'p1', hostId: 'p1', isHost: true,
  seats: [{ id, name, isBot, connected }],          // lobby order = seating order
  game: null | {                                    // null in lobby
    direction: 1 | -1,
    activeSuit: 'basil',                            // suit that must be matched
    topCard: { id, suit, value },                   // suit null for WILD
    drawPileCount: 23,
    turnPlayerId: 'p2',
    winnerId: null | 'p3',
    players: [{ id, name, isBot, connected, cardCount, declaredTondo, vulnerable }],
    hand: [{ id, suit, value }],                    // YOUR cards only
    playableCardIds: ['c12', 'c40'],                // computed server-side
    drawnDecisionCardId: null | 'c7',               // set → you must play{cardId} or pass
    canDeclareTondo: false,
    calloutTargets: [],                             // player ids you may callout right now
    log: ['CARMELA PLAYED BASIL 7', ...]            // last ≤20 events, newest last
  }
}
```

Card: `{ id: 'c17', suit: 'pepperoni'|'cheese'|'basil'|'anchovy'|null, value: '0'..'9'|'SKIP'|'PLUS2'|'REVERSE'|'WILD' }`. Ids are unique per round.

## The pie (`match`, v1.1)

A match is a **pie of four rounds** — four slices. The winner of a round banks
the value of every card still in every other hand: numbers score their face
value, `SKIP`/`PLUS2`/`REVERSE` score 20, `WILD` scores 50. After the fourth
slice the highest total takes the pie; ties are broken by rounds won, and a
genuine tie is shared rather than resolved by seat order.

A fixed length rather than a race to a target because a round is worth very
different amounts at different table sizes — measured over 2000 complete bot
rounds per size with `scripts/measure-scoring.js`, the winner banks a median of
51 points at two players, 85 at three and 137 at four. Any single "first to N"
target would therefore run roughly 4 rounds at one table size and 8 at another.

```js
match: {
  roundsPerPie: 4,
  round: 2,                 // slices FINISHED (so the one being played is round + 1)
  complete: false,          // true once the fourth slice is banked
  championIds: [],          // set when complete; more than one entry means a shared pie
  leaderIds: ['p3'],        // everyone currently tied at the top; empty while scoreless
  standings: [{ id, name, isBot, points, roundsWon }],   // richest first, seats still at the table
  lastRound: null | {       // what the round just finished was worth
    winnerId: 'p3',
    points: 107,
    forfeited: 0,           // points from a hand returned to the deck by a player leaving
    breakdown: [{ id, cards, points }]
  },
  nextDueAt: null | 1757430000000,  // epoch ms the next slice deals itself (v1.2)
  held: false                       // a human asked the table to wait (v1.2)
}
```

### The round-boundary clock (v1.2)

When a slice ends the server arms a 10-second countdown and then deals the next
slice itself. `nextDueAt` is an **absolute epoch millisecond**, not a remaining
duration, so a client renders the countdown from its own clock and the server
never has to tick at it.

It arms only when all of these hold: the phase is `roundOver`, the pie is **not**
complete, there are enough seats, and at least one human is connected. A finished
pie deliberately never arms one — that is the boundary that has earned a pause,
and it is where the group decides out loud whether to play another.

`hold` clears it and sets `held`. The hold is **sticky**: it survives re-arming
and is only spent when somebody actually deals. A hold that quietly expired
would be worse than no hold at all.

`match` is present on every snapshot, including in the lobby (where every total
is zero). A completed pie stays on the wire through `roundOver` so the final
scoreboard can be read; the next `startGame`/`newRound` resets it.

Other players' hands NEVER cross the wire — only `cardCount`.
The server is fully authoritative: clients send intent, never enforce rules,
and repaint entirely from each snapshot.

## Rooms & reconnect

- Room code: `WORD-NNNN` — 37 pizza words x 10,000 numbers = 370,000 codes,
  chosen with `crypto.randomInt`, four digits with a leading zero allowed
  (`SLICE-0421`). At most 10 characters. It was 10 words x 9000 = 90,000 until
  v1.3, which one socket swept end to end in 2.1 seconds — and a guessed code
  does not just reveal a table, it SEATS you at it. The shape could not grow:
  measured in the lobby's own code element, a six-digit code is 237-261px
  against a 229px box at 390x844 and would be truncated on the primary
  reference phone. The wrong-code throttle below is the actual defence; the
  space is depth. A client must not validate the shape beyond "non-empty,
  uppercased, trimmed" — the word list is the server's business.
- Each human seat gets a random hex `token` (returned in `joined`); a socket
  presenting the token for a disconnected seat reclaims it (`reconnected: true`).
- On disconnect mid-game the seat stays (connected:false) and its turns are
  auto-played (draw+pass) after 10s. In lobby, disconnected seats are removed.
- Empty rooms are garbage-collected after 60s — or 10s if the table never had
  a second human (see *Limits*).
- Ping/pong heartbeat every 30s; no pong → terminate.

## Limits (v1.3)

None of this is authentication — the game has none and needs none. It is the
floor that stops ONE socket denying the game to everybody, measured against what
real play does rather than guessed. Everything except the last item is **per
socket**, on purpose: this game is four friends in one room on their phones
behind ONE public IP, and a tight per-IP limit would break the primary use case
more thoroughly than the attack it prevents.

| limit | value | over it |
|---|---|---|
| messages | 20/s, burst 40 | `error` "Slow down — too many messages at once." and the frame is dropped. Answered for the first 10 refusals, then dropped silently (an error reply is bytes out too). 500 refusals closes the socket with code 1008 |
| `createRoom` | 3 per socket | `error` "You have opened enough tables. Join one instead." |
| failed `joinRoom` | 5 free, then 1 per 2s | `error` "Too many wrong table codes. Wait a moment and try again." — the code is not even looked up, and the message is the same whatever the code was. Only a FAILED join costs; a correct code costs nothing |
| concurrent sockets per IP | 32, `TONDO_MAX_SOCKETS_PER_IP` | the upgrade is refused with HTTP 401 |

**Origin.** The WebSocket upgrade is refused (HTTP 401) when an `Origin` header
is present and its host:port differs from `Host`. An ABSENT `Origin` is allowed
— native clients, the smoke scripts and the probes. LAN play is unaffected: a
phone opening `http://192.168.1.7:4600` sends `Origin: http://192.168.1.7:4600`
against `Host: 192.168.1.7:4600`, which matches. Without this, any page a player
visited could run every one of these attacks from inside their network,
including against a LAN-only instance (a WS upgrade is not covered by CORS).

**Abandoned tables.** A table whose humans are all disconnected is collected
after 60s, or after **10s** if it never had a second human — nobody is coming
back to a table one person opened and left, and 500 of those is how the room
slots were exhausted.

## HTTP

- Static files from `public/` (index at `/`).
- `GET /health` → `{ok: true, rooms: n}`.
- Port: `process.env.PORT || 4600`.
