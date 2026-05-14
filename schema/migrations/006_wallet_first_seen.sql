-- Oldest known signature per wallet (chain-backed via RPC pagination).
-- Apply in Turso shell or run after npm run turso:schema picks up schema/turso.sql changes.

CREATE TABLE IF NOT EXISTS wallet_first_seen (
  address TEXT PRIMARY KEY,
  first_signature TEXT,
  first_slot INTEGER,
  first_block_time INTEGER,
  pages_walked INTEGER,
  capped INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wallet_first_seen_block_time
  ON wallet_first_seen (first_block_time DESC);
