-- Frozen investigation snapshots (proof layer). Apply if DB predates this table.
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
