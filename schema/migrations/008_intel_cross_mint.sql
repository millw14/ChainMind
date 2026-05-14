-- Cross-mint / multi-scope intel (Gap 3). Apply with npm run turso:schema or Turso shell.

CREATE TABLE IF NOT EXISTS intel_scope_top_payers (
  scope_address TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  rank_pos INTEGER NOT NULL,
  lookback_hours INTEGER NOT NULL,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (scope_address, wallet_address, lookback_hours)
);

CREATE INDEX IF NOT EXISTS idx_intel_top_wallet ON intel_scope_top_payers (wallet_address);
CREATE INDEX IF NOT EXISTS idx_intel_top_scope ON intel_scope_top_payers (scope_address);

CREATE TABLE IF NOT EXISTS intel_cross_mint_pair (
  wallet_address TEXT NOT NULL,
  scope_a TEXT NOT NULL,
  scope_b TEXT NOT NULL,
  events_a INTEGER NOT NULL,
  events_b INTEGER NOT NULL,
  rank_a INTEGER NOT NULL,
  rank_b INTEGER NOT NULL,
  pair_score REAL NOT NULL,
  lookback_hours INTEGER NOT NULL,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (wallet_address, scope_a, scope_b, lookback_hours),
  CHECK (scope_a < scope_b)
);

CREATE INDEX IF NOT EXISTS idx_cross_mint_scope_pair ON intel_cross_mint_pair (scope_a, scope_b);
CREATE INDEX IF NOT EXISTS idx_cross_mint_wallet ON intel_cross_mint_pair (wallet_address);

CREATE TABLE IF NOT EXISTS intel_cluster_track (
  cluster_fingerprint TEXT PRIMARY KEY,
  members_json TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  mint_count INTEGER NOT NULL,
  member_count INTEGER NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  observation_count INTEGER NOT NULL DEFAULT 1,
  last_pair_score_avg REAL
);

CREATE INDEX IF NOT EXISTS idx_cluster_track_last_seen ON intel_cluster_track (last_seen DESC);
