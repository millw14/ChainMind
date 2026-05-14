-- Optional: apply on Turso DBs created before autonomous surface scan (safe to re-run).
-- Turso / libSQL web console: run ONE statement at a time (select all in one block often fails).

CREATE TABLE IF NOT EXISTS surface_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  scope_address TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  detail TEXT NOT NULL,
  entities_json TEXT NOT NULL
);

-- Run separately after the table exists:
CREATE INDEX IF NOT EXISTS idx_surface_hits_scope ON surface_hits (scope_address);

-- Run separately:
CREATE INDEX IF NOT EXISTS idx_surface_hits_created ON surface_hits (created_at);