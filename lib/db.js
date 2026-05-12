import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * @param {import("better-sqlite3").Database} db
 */
function migrateSignaturesToCompositePk(db) {
  const tx = db.transaction(() => {
    db.exec(`
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
    `);
    db.exec(`
      INSERT INTO signatures__pk2
        (signature, scope_address, slot, block_time, err, summary_json, ingested_at)
      SELECT signature, scope_address, slot, block_time, err, summary_json, ingested_at
        FROM signatures;
    `);
    db.exec(`DROP TABLE signatures;`);
    db.exec(`ALTER TABLE signatures__pk2 RENAME TO signatures;`);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_signatures_scope_slot
        ON signatures (scope_address, slot DESC);
    `);
  });
  tx();
}

/**
 * @param {import("better-sqlite3").Database} db
 * @returns {boolean}
 */
function signaturesNeedsCompositePkMigration(db) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'signatures'`).get();
  if (!row?.sql) return false;
  return !/\bPRIMARY\s+KEY\s*\(\s*signature\s*,\s*scope_address\s*\)/i.test(row.sql);
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function initChainmindSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ingest_state (
      scope_key TEXT PRIMARY KEY,
      last_before_signature TEXT,
      updated_at TEXT NOT NULL
    );
  `);

  const sigDef = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'signatures'`).get();
  if (!sigDef?.sql) {
    db.exec(`
      CREATE TABLE signatures (
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
    `);
  } else if (signaturesNeedsCompositePkMigration(db)) {
    migrateSignaturesToCompositePk(db);
  } else {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_signatures_scope_slot
        ON signatures (scope_address, slot DESC);
    `);
  }

  db.exec(`
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
}

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
  initChainmindSchema(db);
  return db;
}
