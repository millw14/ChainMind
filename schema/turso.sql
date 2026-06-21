-- ChainMind tables for Turso / libSQL (Vercel production DB).
-- Apply in Turso shell or: npm run turso:schema

CREATE TABLE IF NOT EXISTS ingest_state (
  scope_key TEXT PRIMARY KEY,
  last_before_signature TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signatures (
  signature TEXT NOT NULL,
  scope_address TEXT NOT NULL,
  slot INTEGER,
  block_time INTEGER,
  err TEXT,
  summary_json TEXT,
  ingested_at TEXT NOT NULL,
  PRIMARY KEY (signature, scope_address)
);

CREATE INDEX IF NOT EXISTS idx_signatures_scope_slot
  ON signatures (scope_address, slot DESC);

CREATE TABLE IF NOT EXISTS events (
  signature TEXT NOT NULL,
  scope_address TEXT NOT NULL,
  slot INTEGER,
  block_time INTEGER,
  fee_payer TEXT,
  event_type TEXT NOT NULL,
  programs_json TEXT NOT NULL,
  counterparties_json TEXT,
  parse_note TEXT,
  ingested_at TEXT NOT NULL,
  PRIMARY KEY (signature, scope_address)
);

CREATE INDEX IF NOT EXISTS idx_events_scope_time
  ON events (scope_address, block_time DESC);

CREATE INDEX IF NOT EXISTS idx_events_scope_fee_payer
  ON events (scope_address, fee_payer);

-- Per-scope time-bucket baselines for z-scores / regime-aware layers (see migrations/003_scope_baselines.sql).
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

CREATE TABLE IF NOT EXISTS signers (
  tx_sig TEXT NOT NULL,
  scope_address TEXT NOT NULL,
  address TEXT NOT NULL,
  role TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  PRIMARY KEY (tx_sig, scope_address, address, role)
);

CREATE INDEX IF NOT EXISTS idx_signers_scope ON signers (scope_address);
CREATE INDEX IF NOT EXISTS idx_signers_address ON signers (address);

CREATE TABLE IF NOT EXISTS transfers (
  tx_sig TEXT NOT NULL,
  scope_address TEXT NOT NULL,
  idx INTEGER NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  mint TEXT,
  amount TEXT NOT NULL,
  slot INTEGER,
  ingested_at TEXT NOT NULL,
  PRIMARY KEY (tx_sig, scope_address, idx)
);

CREATE INDEX IF NOT EXISTS idx_transfers_scope ON transfers (scope_address);
CREATE INDEX IF NOT EXISTS idx_transfers_scope_mint ON transfers (scope_address, mint);
CREATE INDEX IF NOT EXISTS idx_transfers_from ON transfers (from_address);
CREATE INDEX IF NOT EXISTS idx_transfers_to ON transfers (to_address);

CREATE TABLE IF NOT EXISTS program_calls (
  tx_sig TEXT NOT NULL,
  scope_address TEXT NOT NULL,
  idx INTEGER NOT NULL,
  program_id TEXT NOT NULL,
  instruction_name TEXT NOT NULL,
  slot INTEGER,
  ingested_at TEXT NOT NULL,
  PRIMARY KEY (tx_sig, scope_address, idx)
);

CREATE INDEX IF NOT EXISTS idx_program_calls_scope ON program_calls (scope_address);
CREATE INDEX IF NOT EXISTS idx_program_calls_program ON program_calls (program_id);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_address TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  tx_sig TEXT NOT NULL,
  slot INTEGER,
  edge_type TEXT NOT NULL,
  mint TEXT,
  ingested_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_natural_u
  ON edges (scope_address, tx_sig, from_address, to_address, edge_type, IFNULL(mint, ''));
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges (from_address);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges (to_address);
CREATE INDEX IF NOT EXISTS idx_edges_scope ON edges (scope_address);
CREATE INDEX IF NOT EXISTS idx_edges_scope_from ON edges (scope_address, from_address);
CREATE INDEX IF NOT EXISTS idx_edges_scope_to ON edges (scope_address, to_address);
CREATE INDEX IF NOT EXISTS idx_signers_scope_tx ON signers (scope_address, tx_sig);
CREATE INDEX IF NOT EXISTS idx_program_calls_sig ON program_calls (scope_address, tx_sig);

CREATE TABLE IF NOT EXISTS surface_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  scope_address TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  detail TEXT NOT NULL,
  entities_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_surface_hits_scope ON surface_hits (scope_address);
CREATE INDEX IF NOT EXISTS idx_surface_hits_created ON surface_hits (created_at);

-- RPC-backfilled oldest signature per address (for real wallet age vs export-only first seen).
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

-- Shareable frozen case files (JSON payload); created via POST /api/cases
CREATE TABLE IF NOT EXISTS investigation_cases (
  id TEXT PRIMARY KEY,
  scope_address TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  window_minutes INTEGER NOT NULL,
  last_hours INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_investigation_cases_scope
  ON investigation_cases (scope_address);

CREATE INDEX IF NOT EXISTS idx_investigation_cases_created
  ON investigation_cases (created_at DESC);

-- Score result cache: serve repeat/popular searches + dashboard polls from cache
-- instead of re-hitting RPC/compute (cost + abuse control). TTL enforced in code.
CREATE TABLE IF NOT EXISTS score_cache (
  scope_address TEXT NOT NULL,
  window_minutes INTEGER NOT NULL,
  last_hours INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (scope_address, window_minutes, last_hours)
);

-- Fixed-window per-client request counter for rate limiting public endpoints.
CREATE TABLE IF NOT EXISTS rate_limit (
  bucket TEXT PRIMARY KEY,   -- "<key>:<unix_minute>"
  n INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Per-mint decimals cache (constant per mint) so raw on-chain amounts can be shown in
-- human units. Populated lazily from RPC; native SOL / lamports use 9.
CREATE TABLE IF NOT EXISTS mint_decimals (
  mint TEXT PRIMARY KEY,
  decimals INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

-- Groq verdict cache: lets /api/groq-brief skip a redundant model call when a recent
-- analysis for the same scope + unchanged evidence already exists (see lib/evidence-hash.js).
CREATE TABLE IF NOT EXISTS groq_analysis_log (
  scope_address TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  evidence_hash TEXT NOT NULL,
  source TEXT,
  model TEXT,
  verdict TEXT,
  confidence REAL,
  analysis_json TEXT NOT NULL,
  PRIMARY KEY (scope_address, created_at)
);

CREATE INDEX IF NOT EXISTS idx_groq_analysis_log_scope_created
  ON groq_analysis_log (scope_address, created_at DESC);

-- Cross-mint intel: top payers per scope, pairwise overlaps, persistent cluster fingerprints
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
  last_pair_score_avg REAL,
  canonical_cluster_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_cluster_track_last_seen ON intel_cluster_track (last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_cluster_track_canonical ON intel_cluster_track (canonical_cluster_id);

CREATE TABLE IF NOT EXISTS scan_queue (
  address TEXT NOT NULL PRIMARY KEY,
  added_at INTEGER NOT NULL DEFAULT (unixepoch()),
  status TEXT NOT NULL DEFAULT 'pending',
  last_picked_at INTEGER,
  note TEXT
);

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
  regime TEXT NOT NULL DEFAULT 'calm',
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (scope_address, bucket_width_minutes)
);
CREATE INDEX IF NOT EXISTS idx_scope_baselines_computed
  ON scope_baselines (computed_at);
