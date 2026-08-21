# TONDO — wire protocol (v1, FROZEN)

This file is the contract between `server/` and `public/js/`. Neither side may
deviate from it without updating this file first. All messages are JSON objects
with a `type` field, sent over a single WebSocket at the same origin (`ws://host/`).

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
- **TONDO call**: a player holding exactly 2 cards may declare "TONDO" (any time before playing down to 1). If a player reaches 1 card without having declared, they are *vulnerable* until the start of their next turn; any other player may `callout` them → the vulnerable player draws 2 and is no longer vulnerable. Declaring resets when the hand grows above 2. Any growth of the hand (including a `PLUS2` landing on them) ends the vulnerability: both flags follow the hand, so a punished-by-cards player cannot also be called out.
- **Round over**: first player to 0 cards wins. The host deals again; the opening seat rotates by one each round. `turnPlayerId` is `null` while the round is over, and the winner stays in `players` even if they leave.
- When the draw pile empties, reshuffle the discard pile (minus the top card) into it. If both are empty, draws are no-ops.

Bots: fill seats via host's `addBot`. Bots always declare TONDO; each bot callouts a vulnerable player with 35% probability (rolled once when the window opens, after a 1s delay).

## Client → server

| type | payload | notes |
|---|---|---|
| `createRoom` | `{name}` | creates room, seats sender as host |
| `joinRoom` | `{code, name, token?}` | `token` reclaims its seat — even over a half-open socket the server still believes in (the token outranks the stale socket, which is terminated). New players may join in `lobby` or `roundOver`, never mid-round |
| `addBot` | `{}` | host, lobby or roundOver, up to 4 seats |
| `removeSeat` | `{seatId}` | host, lobby or roundOver, bot seats only |
| `startGame` | `{}` | host, lobby only, ≥2 seats |
| `newRound` | `{}` | host, roundOver only |
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

Other players' hands NEVER cross the wire — only `cardCount`.
The server is fully authoritative: clients send intent, never enforce rules,
and repaint entirely from each snapshot.

## Rooms & reconnect

- Room code: `WORD-NNNN` from a small pizza word list.
- Each human seat gets a random hex `token` (returned in `joined`); a socket
  presenting the token for a disconnected seat reclaims it (`reconnected: true`).
- On disconnect mid-game the seat stays (connected:false) and its turns are
  auto-played (draw+pass) after 10s. In lobby, disconnected seats are removed.
- Empty rooms are garbage-collected after 60s.
- Ping/pong heartbeat every 30s; no pong → terminate.

## HTTP

- Static files from `public/` (index at `/`).
- `GET /health` → `{ok: true, rooms: n}`.
- Port: `process.env.PORT || 4600`.
