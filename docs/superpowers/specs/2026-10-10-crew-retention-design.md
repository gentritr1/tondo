# Crew-lite retention + Render hosting — design

**Status:** design approved section by section in chat on 2026-10-10. This spec
needs the owner's review before `superpowers:writing-plans` runs.
**Source:** `docs/HANDOFF-2026-10-10.md`, Workstreams 1 and 2, designed together
because a crew needs a durable store and the store is part of the hosting choice.

## 1. Intent

**What the owner said:**
- Tondo goes to a public, marketed launch.
- The retention hook is "reconvene the crew", scoped to Approach A (Crew-lite).
- Testing happens on **Render free** now, with a move to **Fly** if Tondo goes commercial.
- The host must stay switchable.

**Outcome.** A group that played one pie together can come back days later
through a link that still works. They see their standing tally and start a new
table in one tap. Every saved pie grows that tally.

**Success:**
- A crew link pasted in a group chat still opens the crew, with a correct tally,
  after the room is gone and after the server has restarted.
- The game itself never depends on the database.

**Non-goals for v1:**
- Live "online now" presence or a summon. That is Approach B, a fast-follow, and
  the data model below leaves room for it.
- Accounts, login or email.
- Notifications.
- Editing or merging members.
- Deleting a crew.
- More than 5 recent pies on the crew page.
- A push alert to the owner. That gap is accepted for the testing phase (§7.3)
  and must close before going commercial.

## 2. Identity and trust

- **Device secret:** `tondo.device` in `localStorage` holds 32 lowercase hex
  characters (128 bits) from `crypto.getRandomValues`, created on first need.
  - The server accepts only `/^[0-9a-f]{32}$/`.
  - The server stores only `sha256(device)` in hex and never logs the secret.
  - "Forget me" already clears every `tondo.` key, so it also drops this
    device's crews. That is intended.
  - The crew link still lets the player rejoin, as a new member.
- **Crew id:** 10 characters from the Crockford base32 alphabet,
  `0123456789abcdefghjkmnpqrstvwxyz`, generated server-side with
  `crypto.randomBytes`. That is 32¹⁰ ≈ 1.1 × 10¹⁵ ids, about 50 bits.
  - The id is a capability: holding the link lets you view the crew and play
    into it.
  - There is no listing and no search.
- **Results are server-sourced.** `saveToCrew` carries no scores.
  - The server records the pie from its own `Room.pie` and `standings()`.
    Any score-like field a client sends is ignored.
  - Each `freshPie()` gets a `pieKey` of 16 random hex characters, never sent to
    clients.
  - `UNIQUE (crew_id, pie_key)` makes a double save a no-op.
- **One crew per pie.** Once a pie is saved, later saves to the same crew are
  no-ops. A save to a *different* crew is refused with
  "This pie is already saved to <name>."
- **Membership at save:** every human seat present in `standings()` that
  carries a device hash becomes a member, matched on `(crew, device_hash)`.
  - An existing member's name is updated to the seat's current name.
  - Seats without a device secret (old clients) are recorded as `a guest`, with
    no name stored and no member row.
  - Bots appear in the pie's `bots` list by bot name and are never members.
  - A champion who left before the pie ended is not in `standings()`, so the
    pie is recorded with no member marked `won`. That is the same truth
    `share.js` already handles.
- **Display names:** members are ordered by `joined_at`. When names collide,
  later members get a numeric suffix at read time ("Gent", "Gent 2"). Nothing is
  stored for this.

## 3. Data model (migration `001_crews.sql`)

```sql
CREATE TABLE schema_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE crews (
  id          text PRIMARY KEY,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 24),
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_pie_at timestamptz
);

CREATE TABLE members (
  id          bigserial PRIMARY KEY,
  crew_id     text NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
  device_hash text,            -- NULL after the member leaves
  name        text,            -- NULL after the member leaves
  joined_at   timestamptz NOT NULL DEFAULT now(),
  left_at     timestamptz,
  UNIQUE (crew_id, device_hash)
);

CREATE TABLE pies (
  id        bigserial PRIMARY KEY,
  crew_id   text NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
  pie_key   text NOT NULL,
  played_at timestamptz NOT NULL DEFAULT now(),
  rounds    smallint NOT NULL,
  bots      jsonb NOT NULL DEFAULT '[]',   -- [{name, points, won}]; bot names only
  guests    jsonb NOT NULL DEFAULT '[]',   -- [{points, won}]; no names
  UNIQUE (crew_id, pie_key)
);

CREATE TABLE pie_players (
  pie_id    bigint NOT NULL REFERENCES pies(id) ON DELETE CASCADE,
  member_id bigint NOT NULL REFERENCES members(id),
  points    int NOT NULL,
  won       boolean NOT NULL,
  PRIMARY KEY (pie_id, member_id)
);
CREATE INDEX pies_crew_played ON pies (crew_id, played_at DESC);
```

- **Human names live only in `members`.** On leave, the member's `name` and
  `device_hash` are set to NULL, so every past pie renders that member as
  "a former member" and no copy of the name remains.
- **The tally is derived, never stored.** A member's pies are
  `count(pie_players)` and wins are `count(*) FILTER (WHERE won)`. A bug cannot
  make a counter drift.
- **Migration and wipe risk (CLAUDE.md §3), checked first:**
  - The server persists nothing today.
  - The client gains two keys, `tondo.device` and `tondo.crews`, and changes no
    existing key.
  - So there is nothing to migrate and nothing to wipe.
- **Future migrations** are numbered files, applied in order inside a
  transaction while holding `pg_advisory_lock(7310)`. Render starts the new
  instance before stopping the old one, so two instances can boot at once and
  the lock keeps them from migrating together.

## 4. Server

### 4.1 Files

- **`server/db.js`** owns the `pg` Pool, built from `DATABASE_URL`.
  - Pool settings: `max: 5`, `connectionTimeoutMillis: 5000` (above the 1.93 s
    Neon wake measured in the data-persistence playbook, DATA-002), and
    `idleTimeoutMillis: 10000`, so idle connections do not hold Neon awake.
    That last effect is unverified; see §8, item 12.
  - Each query runs in a transaction with `SET LOCAL statement_timeout = '3s'`.
    Startup options may be refused on the pooled URL.
  - It exports `query`, `tx`, and `state()`, which returns
    `{ status: 'off'|'starting'|'on'|'failing', reason, since }`.
- **`server/migrate.js`** runs migrations at boot over `DATABASE_URL_DIRECT`,
  falling back to `DATABASE_URL` when the direct URL is absent (local and test).
  - A boot-time failure never stops the HTTP/WS server.
  - Crews go to `failing` with a reason and retry with backoff: 30 s, doubling
    to a 10-min ceiling.
- **`server/crews.js`** is the only module that touches crew tables. It exports
  `createCrew(name)`, `savePie(crewId, pieRecord)`, `readCrew(id, deviceHash)`,
  `leave(id, deviceHash)` and `crewName(id)`.
- **No `DATABASE_URL`** means crews are `off`. The game runs exactly as today,
  and the client hides every crew control. This keeps local dev and the existing
  gates unchanged.

### 4.2 Protocol, v1.4 (additive)

- **`createRoom` and `joinRoom`** take an optional `device` (32 hex characters).
  An invalid one is ignored, not refused. It is kept as `seat.deviceHash`.
- **`createRoom`** takes an optional `crewId`. The room looks up the crew name
  asynchronously and sets `room.crew = { id, name }` when the crew is found. A
  crew that is not found, or a database that is down, leaves `room.crew = null`.
- **`saveToCrew { crewId }` or `saveToCrew { newCrewName }`** is accepted only
  when all of these hold:
  - it comes from a seated human;
  - `room.pie.complete` is true;
  - `room.pie.saving` is not set;
  - crews are `on`.

  The server sets `pie.saving` and runs the database work asynchronously. When
  it finishes, it sets `pie.savedTo = { id, name }` and the room broadcasts. A
  failure sends the requester an `error` with the plain message from §4.4. The
  pie object is captured by reference, so a `newRound` during the save cannot
  mis-tag the next pie. `NEXT_SLICE_MS` never auto-deals a finished pie, so the
  pie stays on screen while the save runs.
- **Snapshot additions:**
  - top-level `crew: {id, name} | null`, the crew this table was started from;
  - `match.savedTo: {id, name} | null`;
  - `match.saving: boolean`;
  - top-level `crews: 'on' | 'off' | 'failing'`, so the client knows whether to
    show crew controls.
- **HTTP:**
  - `GET /api/crew/:id` takes an optional `X-Tondo-Device` header (a header,
    never the URL) and returns
    `{ id, name, members: [{ name, pies, wins, you }], recent: [{ playedAt, rounds, players: [{ name, points, won, kind: 'member'|'former'|'guest'|'bot' }] }] }`.
    It sends `Cache-Control: no-store`. A bad id returns 404, and a database
    that is down returns 503 with the reason category.
  - `POST /api/crew/:id/leave` takes a JSON body `{ device }` and returns 204.
- **`GET /health`** keeps `{ ok, rooms }` and adds
  `crews: { status, reason, since }` from memory. It **does not query the
  database**, so the host's health checks cannot keep Neon awake. That is a
  deliberate exception to playbook DATA-003, made because of Neon free
  CU-hours. **`GET /health/crews`** does run `SELECT 1`. It is for drills and
  manual checks and is budgeted like crew reads.

### 4.3 Client address behind a proxy (launch blocker)

`clientIp()` reads `req.socket.remoteAddress`. Behind Render's (or Fly's) load
balancer, that address is the balancer's, so every player shares one address,
and the 32-socket cap would refuse everyone once 32 sockets were open across
the whole game.

- `TONDO_CLIENT_IP_HEADER=<name>` reads a single-value header the platform
  sets, such as Fly's `Fly-Client-IP`.
- Otherwise `TONDO_TRUST_PROXY=<hops>` (an integer ≥ 1) takes the entry
  `hops` from the right of `X-Forwarded-For`. Entries further left are
  client-forgeable and are never used.
- With neither set, the server keeps today's behaviour.
- The Render value is assumed to be `TONDO_TRUST_PROXY=1`. That is
  **UNVERIFIED**; it is confirmed at deploy (§8, item 6).

### 4.4 Failure reasons, in our words

| Detected from | Reason |
|---|---|
| no `DATABASE_URL` | `not configured` |
| pg code `28P01` / `28000` | `wrong password` |
| `ENOTFOUND` / `EAI_AGAIN` | `unknown host` |
| `ECONNREFUSED` / connect timeout / code `57014` | `timeout` |
| code `42P01` | `missing table` |
| message mentions the compute-time quota | `over quota` |
| anything else | `database error` |

- The players' message is always
  "Can't reach the crew book right now — your game is fine."
- Logs say `[crews] <op> failed: <reason>`, never the driver text, URLs or
  secrets.

### 4.5 Limits

There is one new `IpBudget` in `server/limits.js`: an LRU of 10,000 addresses.
Each entry holds token buckets that outlive any socket.

| Budget | Burst | Refill | Basis |
|---|---|---|---|
| WS connection attempts | 64 | 1/s | 2× the existing 32-concurrent cap, so a full household can reconnect completely twice in a burst |
| wrong table codes | 10 | 1 per 2 s | 4 players × 2 mistypes, plus 2 spare. Replaces the per-socket 5, which a reconnect reset (handoff residual) |
| crew reads (`GET /api/crew`, `/health/crews`) | 60 | 1/s | a household opening the link together and refreshing |
| crew creation | 10 | 10 per hour | a player makes one crew; 10 is generous |

- These numbers are **derived from existing caps and stated scenarios, not
  measured.** The plan adds `scripts/household-storm.js`, which drives 4
  players, 3 reconnects each, and 2 mistypes each through one address. It must
  show **zero false refusals**, and its output is pasted into the
  `limits.js` comment.
- `saveToCrew { newCrewName }` spends the crew-creation budget.
  `POST /api/crew/:id/leave` spends the crew-read budget.
- Over budget:
  - a connection attempt gets an HTTP 429 refusal on upgrade;
  - a wrong code gets the existing message;
  - HTTP routes get 429.

## 5. Client

- **Storage:**
  - `tondo.device` is the secret from §2.
  - `tondo.crews` is a JSON list of `[{ id, name, at }]`, newest first, at most
    10 entries. It is parsed defensively, the way `readLastTable()` is: a bad
    value reads as empty and is never deleted.
- **End of a pie:** shown only when `crews === 'on'`.
  - A **Save to crew** button sits beside Share.
  - If `snap.crew` is set, one tap saves to that crew.
  - Otherwise a picker lists the crews in `tondo.crews` plus **New crew**, with
    a name field prefilled "Our crew" (24 characters max; never the
    founder's name, because a crew's name outlives anyone leaving it).
  - After `match.savedTo` arrives, every client adds the crew to `tondo.crews`
    and shows "Saved to <name>". That line is announced through the existing
    live region; mind the same-tick clobber recorded in memory.
- **Share text:** `pieResultText(match, { origin, resolveName, crewUrl })`.
  - When `crewUrl` is given, the last line reads
    `<N> slices. See the crew: <crewUrl>`.
  - Without it, the output is byte-identical to today's. The existing
    `test/share.test.mjs` cases must pass unchanged.
- **Crew view at `?crew=<id>`:** a view inside the existing single page.
  - It shows the crew name, standings (wins desc, then pies desc, then name)
    with your row marked, and the last 5 pies.
  - The main button is **Start a table**, which sends `createRoom` with the
    `crewId`. If no name is stored, it asks for one first, the same rule as
    `?code=` links.
  - **Leave this crew** is small print with a two-tap confirm, like Forget.
  - Loading, empty ("No pies yet — play one and save it") and 503 states are
    each designed.
- **Home:** a **Your crews** row lists up to 3 crews, under the name field and
  alongside the last-table row. It is decided before first paint, so the card
  does not jump.
- **Save placement is a taste call.** Shoot-harness screenshots go to the
  owner for a yes or no before the work is called done.

## 6. Hosting

- **`render.yaml`:**
  - one web service: Node runtime, build `npm ci`, start `npm start`;
  - region `frankfurt`, plan `free`, `healthCheckPath: /health`;
  - env `NODE_ENV=production` and `TONDO_TRUST_PROXY=1`;
  - `DATABASE_URL` and `DATABASE_URL_DIRECT` marked `sync: false`, so the owner
    sets them.
- **One app serves both the page and the WebSocket.** The upgrade's Origin check
  (`server/index.js:139`) requires the same host, so the static client must not
  move to a separate CDN.
- **Neon:** a project in AWS `eu-central-1` (Frankfurt), to match Render.
  - The pooled URL goes to `DATABASE_URL` and the direct URL to
    `DATABASE_URL_DIRECT`.
  - The two must differ only by `-pooler` (DATA-004).
- **The owner does these steps;** Claude does not create accounts or enter
  credentials:
  1. create the Neon project;
  2. create the Render account and connect the GitHub repo;
  3. paste the two URLs into Render.

  `docs/DEPLOY.md` gives exact steps. Claude then verifies the live service.
- **Fly later:** `docs/DEPLOY.md` gets a Fly section with the exact commands,
  `TONDO_CLIENT_IP_HEADER=Fly-Client-IP`, and the same two database URLs. The
  server contains no host-specific code. Portability is a tested claim
  (§8, item 11).
- **Render free behaviour to expect:**
  - The service spins down after 15 min with no inbound HTTP or WebSocket
    message.
  - Waking takes about a minute.
  - A restart drops live tables. Crews survive, which is the point.

## 7. Monitoring (CLAUDE.md §12)

1. **Alive:** real traffic. Every save and every crew read logs
   `[crews] <op> ok crew=<id> ms=<n>`. No pinger.
2. **Why it failed:** the reasons in §4.4, held in `db.state()`. They appear in
   logs and in `/health`, which survive a database failure because both live in
   the server process.
3. **Where the owner sees it, and how fast:** Render's log view and `/health`.
   Nothing pushes an alert, so the **worst-case delay is unbounded**: the owner
   learns when they look or when a player says so. **Accepted for testing**; a
   push alert is a prerequisite for commercial launch.
4. **Cost: $0.**
   - Neon wakes only on real crew activity. One wake keeps it up about 5 min,
     at about 0.021 CU-h with 0.25 CU (DATA-005, inferred), so 100 CU-h covers
     about 4,800 wake windows a month.
   - Render free's 750 instance-hours cover one service for a month.
   - Queries per save: 1 transaction of about 5 statements. Per read: 1
     transaction of 3 statements.
5. **Drill:** with each of a wrong password, a wrong host, a missing
   `DATABASE_URL`, and a hanging query (`pg_sleep` beyond the 3 s statement
   timeout):
   - `/health` names the right reason;
   - Save shows the plain message;
   - a full 4-slice pie still plays to the end.

## 8. Acceptance criteria

Each item names how it is verified, per CLAUDE.md §1.

1. **Restart persistence.** Save a pie, kill the server process, restart it,
   then `GET /api/crew/:id`. Expect `pies = 1` and the champion with `wins = 1`.
   *Real Postgres (PGlite over the wire), then the Neon branch.*
2. **The link outlives the room.** After the room's TTL has expired (checked via
   `/health` `rooms`), the crew URL from the actual Share text opens the crew
   view with the tally. *Browser pane, `read_page`.*
3. **No forgery.**
   - `saveToCrew` is refused before `complete`, from an unseated socket, and
     from a bot seat.
   - Score fields in the message are ignored.
   - Two seats saving the same pie produce exactly one `pies` row.
   *Integration test against the real server and database.*
4. **Membership.**
   - 3 humans and 1 bot produce 3 members, with the bot only in `bots`.
   - Two devices named "Gent" read back as "Gent" and "Gent 2".
   - A seat without a device secret is recorded as `guest`.
5. **Database-down drill.** All four cases in §7, item 5, pass.
6. **Proxy address.**
   - Locally, a forged leftmost `X-Forwarded-For` is ignored under
     `TONDO_TRUST_PROXY=1`.
   - On Render, after deploy, a request carrying a forged header is logged with
     the real address.
7. **The wrong-code budget survives reconnect.** A defensive test against a
   local server Claude controls: 10 wrong codes, reconnect, and the 11th is
   refused. `scripts/household-storm.js` shows zero false refusals.
8. **Leave.**
   - After leaving, the member's `name` and `device_hash` are NULL.
   - Past pies render "a former member".
   - The crew disappears from that device's `tondo.crews`.
9. **Visuals.**
   - Shoot scenes: the finished pie with Save, the picker, the crew view
     (filled, empty, 503) and home with crews.
   - Sizes: 320×568, 390×844 and 1366×768.
   - The overlap and contrast gates pass, and **the owner says yes to the
     screenshots**.
10. **No regressions.**
    - `npm test` (116 tests at handoff, plus the new ones), `npm run smoke`,
      `npm run shoot` and `npm run contrast` all pass. A single red shoot run is
      re-run clean before concluding.
    - A client sending no `device` still plays a full pie.
11. **Portability.** With only `PORT`, `DATABASE_URL`, `DATABASE_URL_DIRECT` and
    `NODE_ENV` set, and no Render variables present, the server boots, migrates
    and saves a crew.
12. **Neon awake-time.** On the Neon branch, one save followed by 10 min idle
    leaves the compute suspended. Read from the Neon console or API, so the cost
    model in §7.4 is measured rather than inferred.

## 9. Testing infrastructure

- **New dependency:** `pg` 8.x, the only new runtime dependency.
- **Dev dependencies:** `@electric-sql/pglite` and `@electric-sql/pglite-socket`.
  Tests start PGlite behind a local socket, so the real `pg` driver and the real
  SQL run in `npm test` with no account.
- **If pglite-socket does not work on Node 20,** stop and ask the owner. The
  fallback is installing Postgres with Homebrew.
- **PGlite does not exercise Neon's wake or pooler,** which is why items 1, 5
  and 12 repeat on a disposable Neon branch the owner creates.
- Tests that touch the database get their own `npm run test:db` script, so
  `npm test` stays fast and dependency-free for the existing suite.

## 10. Build order

The plan details each step.

1. The proxy address (§4.3) and `IpBudget` (§4.5). Any public deploy needs these
   whether or not crews ship.
2. `db.js`, `migrate.js`, `crews.js` and their tests.
3. The protocol (v1.4): seat device, room crew, `saveToCrew`, snapshot fields,
   HTTP routes. PROTOCOL.md is updated first, per its own rule.
4. Client: storage, the Save button and picker, the crew view, the home row and
   the share text. Then the shoot scenes and the owner's eyeball.
5. `render.yaml` and `docs/DEPLOY.md`. **Deploy only with the owner's yes.**
   Then run the live checks: items 6 and 12, plus a real save read back after a
   manual restart.
