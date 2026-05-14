-- Layer 1: persisted per-scope bucket statistics for scoring baselines (calm | active | unknown).

CREATE TABLE IF NOT EXISTS scope_baselines (
  scope_address TEXT NOT NULL,
  bucket_width_minutes INTEGER NOT NULL,
  baseline_start_sec INTEGER NOT NULL,
  baseline_end_sec INTEGER NOT NULL,
  mean_event_count REAL NOT NULL,
  std_event_count REAL NOT NULL,
  mean_wallet_count REAL NOT NULL,
  std_wallet_count REAL NOT NULL,
  bucket_count INTEGER NOT NULL,
  regime TEXT NOT NULL DEFAULT 'calm', -- calm | active | unknown
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (scope_address, bucket_width_minutes)
);

CREATE INDEX IF NOT EXISTS idx_scope_baselines_computed
  ON scope_baselines (computed_at);
