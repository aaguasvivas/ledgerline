-- Ledgerline read model (CQRS query side).
--
-- Durable Objects remain the authoritative source of truth for ordering and
-- integrity. These tables are an eventually-consistent projection the Worker
-- writes to *after* a StreamDO confirms an append, powering fast paginated
-- reads and stats queries.

-- API keys are stored hashed (SHA-256 hex). The raw key is shown to the caller
-- exactly once, at mint time, and is never persisted.
CREATE TABLE IF NOT EXISTS api_keys (
  key_hash     TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  rate_per_min INTEGER NOT NULL DEFAULT 60,
  created_at   INTEGER NOT NULL
);

-- Streams are owned by the key that created them. Ownership is checked on every
-- request; a caller asking about a stream it does not own gets a 404 (we do not
-- leak existence).
CREATE TABLE IF NOT EXISTS streams (
  id             TEXT PRIMARY KEY,
  owner_key_hash TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);

-- Reserved for a future "list my streams" query; the current code only looks
-- streams up by primary key.
CREATE INDEX IF NOT EXISTS idx_streams_owner ON streams (owner_key_hash);

-- Mirrored events. (stream_id, seq) is unique, so re-mirroring an idempotent
-- replay is a no-op via INSERT OR IGNORE.
CREATE TABLE IF NOT EXISTS events (
  stream_id  TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  hash       TEXT NOT NULL,
  prev_hash  TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- The composite PK also serves the one read pattern
  -- (WHERE stream_id = ? AND seq > ? ORDER BY seq): no secondary index needed.
  PRIMARY KEY (stream_id, seq)
);
