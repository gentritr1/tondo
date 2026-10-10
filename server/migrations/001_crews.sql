-- Crews: a durable group that outlives a room. See
-- docs/superpowers/specs/2026-10-10-crew-retention-design.md §3.
-- Human names live ONLY in members, so leaving (name := NULL) removes every
-- copy. The tally is derived from pie_players, never stored as a counter.

CREATE TABLE crews (
  id          text PRIMARY KEY,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 24),
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_pie_at timestamptz
);

CREATE TABLE members (
  id          bigserial PRIMARY KEY,
  crew_id     text NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
  device_hash text,
  name        text,
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
  bots      jsonb NOT NULL DEFAULT '[]',
  guests    jsonb NOT NULL DEFAULT '[]',
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
