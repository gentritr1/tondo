# TONDO

A simple UNO-style pizza card game for 2–4 players around a ring table.
*Tondo* is Italian for "round" — like the table, and the pie.

Based on the "ZA Ring Table" design (see `docs/design/`), with the multiplayer
spine borrowed from the Za! codebase: one dependency (`ws`), no build step,
a fully server-authoritative game, and a complete per-player snapshot broadcast
on every state change.

## Run

```bash
npm install
npm start          # serves http://localhost:4600
```

Open the URL, enter a name, create a table, add bots (or share the
`WORD-NNNN` code — `/?code=WORD-NNNN` links prefill it), and start.

## Rules in one breath

Match the top card by topping or number; SKIP, +2, REVERSE, and WILD do what
you'd expect; when you're down to two cards, **call TONDO** before playing —
if you reach one card without calling it, anyone can call you out and you
draw 2. First to zero cards wins the round.

## Development

- `PROTOCOL.md` — the frozen wire contract between `server/` and `public/js/`.
- `npm test` — pure-rules test suite (`test/rules.test.js`).
- `node scripts/host-smoke.js` — end-to-end smoke: creates a room, seats 3
  bots, plays a full game over a real WebSocket (server must be running).
- `http://localhost:4601/?mock=1` style mock mode: serve `public/` statically
  and the client runs against scripted snapshots (`public/js/mock.js`).
- QA screenshots from the build live in `docs/qa/`.
