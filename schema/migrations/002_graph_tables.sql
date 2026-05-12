-- Optional: apply on existing Turso DBs that already ran turso.sql before graph tables existed.
-- Safe to run multiple times (IF NOT EXISTS).

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
