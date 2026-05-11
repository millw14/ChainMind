import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * @param {string} [relativePath]
 */
export function openDb(relativePath) {
  const file =
    relativePath?.trim() ||
    process.env.DATABASE_PATH?.trim() ||
    "data/chainmind.db";
  const abs = resolve(process.cwd(), file);
  mkdirSync(dirname(abs), { recursive: true });
  const db = new Database(abs);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS ingest_state (
      scope_key TEXT PRIMARY KEY,
      last_before_signature TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS signatures (
      signature TEXT PRIMARY KEY,
      scope_address TEXT NOT NULL,
      slot INTEGER,
      block_time INTEGER,
      err TEXT,
      summary_json TEXT,
      ingested_at TEXT NOT NULL
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
  `);
  return db;
}