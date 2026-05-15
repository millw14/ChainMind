CREATE TABLE IF NOT EXISTS scan_queue (
  address TEXT NOT NULL PRIMARY KEY,
  added_at INTEGER NOT NULL DEFAULT (unixepoch()),
  status TEXT NOT NULL DEFAULT 'pending',
  last_picked_at INTEGER,
  note TEXT
);
