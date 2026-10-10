# Deploying Tondo

Tondo is one Node process that serves the page AND the game's WebSocket from
the same address (the WebSocket refuses other origins — server/index.js
`originAllowed`). Crews live in Postgres (Neon), outside the host, so moving
hosts never moves data.

## Settings the server reads (all of them)
| Variable | Value |
|---|---|
| `PORT` | set by the host |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Neon **pooled** connection string (has `-pooler` in the host) |
| `DATABASE_URL_DIRECT` | Neon **direct** connection string (same, without `-pooler`) |
| `TONDO_TRUST_PROXY` | `1` on Render |
| `TONDO_CLIENT_IP_HEADER` | `Fly-Client-IP` on Fly (instead of TONDO_TRUST_PROXY) |

## 1. Neon (you do this; ~5 minutes)
1. Sign up at neon.tech. Create a project named `tondo`, Postgres 16+, region
   **AWS Europe Central 1 (Frankfurt)**.
2. Dashboard → Connect → copy the connection string with **Connection pooling
   ON** (→ DATABASE_URL) and again with it **OFF** (→ DATABASE_URL_DIRECT).
   The two must differ only by `-pooler` in the host name.
3. Keep them private. Paste them only into Render's settings (step 2.4) —
   never into chat, a file in this repo, or a URL.

## 2. Render (you do this; ~10 minutes)
1. Sign up at render.com with GitHub. Authorize access to `gentritr1/tondo`.
2. New → Blueprint → pick the repo → it reads `render.yaml` → Apply.
3. When it asks for `DATABASE_URL` and `DATABASE_URL_DIRECT`, paste the two
   strings from step 1.2.
4. Wait for the first deploy to say Live. Tell Claude the service URL.

## 3. Live checks (Claude does these once you share the URL)
1. `curl -s https://<service>/health` → `crews.status` is `on`.
2. Open the URL on a phone, play a quick pie, Save to crew, open the crew link
   from a different browser → the tally shows.
3. Proxy address: `curl -s -H 'X-Forwarded-For: 6.6.6.6' https://<service>/health`
   while watching Render → Logs; a request that hits a budget logs the REAL
   address, never 6.6.6.6. (Claude triggers one deliberate 429 on
   `/api/crew/zzzzzzzzzz` with 61 quick requests to make the address appear.)
4. Restart persistence: Render → Manual Deploy → Restart; reload the crew link
   → same tally.

## Render free: what to expect
- Sleeps after 15 min with no HTTP request or WebSocket message; the next
  visitor waits about a minute.
- A restart or sleep drops live tables (they are in memory). Crews survive.
- No alert reaches you when the crew book fails: check `/health` or Logs.
  Before going commercial, add a push alert (spec §7.3).

## Moving to Fly later
(Untested until we move; the portability check proves the server needs nothing else.)

1. Install flyctl; `fly auth signup` (needs a card after the trial).
2. In the repo: `fly launch --no-deploy --name tondo --region fra` (accept the
   Node detection; it writes a fly.toml and a Dockerfile).
3. `fly secrets set DATABASE_URL='<pooled>' DATABASE_URL_DIRECT='<direct>' NODE_ENV=production TONDO_CLIENT_IP_HEADER=Fly-Client-IP`
4. In fly.toml set `internal_port = 8080` and add `[env] PORT = "8080"` (the
   server reads PORT).
5. `fly deploy`, then run the live checks in section 3 against the Fly URL.
6. Point players at the new URL; shut the Render service down.

## Proving the move is safe (already done, repeatable)
`npm run check:portable` boots the server with ONLY the variables in the table
above (plus PATH), against a throwaway Postgres, plays one real four-slice pie
against bots and saves it to a new crew. It takes a few minutes. It passes only
if the server needs nothing host-specific.
