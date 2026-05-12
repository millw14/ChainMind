-- One-time Turso / libSQL migration if signatures still use PRIMARY KEY (signature) only.
-- Verify with: SELECT sql FROM sqlite_master WHERE name = 'signature';

BEGIN TRANSACTION;

CREATE TABLE signatures__pk2 (
  signature TEXT NOT NULL,
  scope_address TEXT NOT NULL,
  slot INTEGER,
  block_time INTEGER,
  err TEXT,
  summary_json TEXT,
  ingested_at TEXT NOT NULL,
  PRIMARY KEY (signature, scope_address)
);

INSERT OR REPLACE INTO signatures__pk2
  (signature, scope_address, slot, block_time, err, summary_json, ingested_at)
  SELECT signature, scope_address, slot, block_time, err, summary_json, ingested_at
  FROM signatures;

DROP TABLE signatures;

ALTER TABLE signatures__pk2 RENAME TO signatures;

CREATE INDEX IF NOT EXISTS idx_signatures_scope_slot
  ON signatures (scope_address, slot DESC);

COMMIT;
