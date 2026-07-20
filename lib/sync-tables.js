/**
 * Per-table incremental sync core for the SQLite → Turso mirror. Extracted from
 * scripts/sync-sqlite-to-turso.mjs so the high-water-mark logic is unit-testable:
 * `client` is any object with a pipeline(stmts: {sql, args?}[]) method returning
 * Turso /v2/pipeline-shaped results ({ response: { result: { rows } } } per
 * statement) — the script backs it with HTTPS, tests with in-memory SQLite.
 */

/** Tables mirrored to Turso, in sync order. */
export const SYNC_TABLES = [
  { table: "signatures", columns: ["signature", "scope_address", "slot", "block_time", "err", "summary_json", "ingested_at"] },
  { table: "events", columns: ["signature", "scope_address", "slot", "block_time", "fee_payer", "event_type", "programs_json", "counterparties_json", "parse_note", "ingested_at"] },
  { table: "signers", columns: ["tx_sig", "scope_address", "address", "role", "ingested_at"] },
  { table: "transfers", columns: ["tx_sig", "scope_address", "idx", "from_address", "to_address", "mint", "amount", "slot", "ingested_at"] },
  { table: "program_calls", columns: ["tx_sig", "scope_address", "idx", "program_id", "instruction_name", "slot", "ingested_at"] },
  // edges: omit autoincrement id (local ids reset on ephemeral hosts and would clobber
  // unrelated Turso rows); dedupe on the natural unique index via INSERT OR IGNORE.
  { table: "edges", columns: ["scope_address", "from_address", "to_address", "tx_sig", "slot", "edge_type", "mint", "ingested_at"], orMode: "IGNORE" },
];

/** Local-only bookkeeping (never pushed to Turso): per-table sync watermark. */
export function ensureSyncState(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (
      table_name TEXT PRIMARY KEY,
      last_marker TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

/** High-water mark already in Turso for a table (first-run fallback only — see syncTable). */
export async function remoteMaxMarker(client, table, col) {
  const results = await client.pipeline([{ sql: `SELECT MAX(${col}) AS m FROM ${table}`, args: [] }]);
  const v = results[0]?.response?.result?.rows?.[0]?.[0]?.value;
  return v == null ? "" : String(v);
}

/**
 * Last marker THIS local db has synced for a table. Turso's global MAX spans every
 * writer (reparse-libsql, other ingest hosts) whose clocks can run ahead of ours,
 * which would permanently skip our older unsynced rows — so the watermark is kept
 * per local database, falling back to Turso's MAX only when no local marker exists.
 */
export function localMarker(db, table) {
  return db.prepare("SELECT last_marker FROM sync_state WHERE table_name = ?").get(table)?.last_marker ?? "";
}

export function saveLocalMarker(db, table, marker) {
  db.prepare("INSERT OR REPLACE INTO sync_state (table_name, last_marker, updated_at) VALUES (?, ?, ?)")
    .run(table, marker, new Date().toISOString());
}

/**
 * Stream local rows newer than the high-water mark and upsert them in batches.
 * Streaming (.iterate) avoids loading whole tables into memory — the OOM/abort that
 * killed the old SELECT *.all() approach once data grew.
 */
export async function syncTable(db, client, table, columns, { markerCol = "ingested_at", orMode = "REPLACE", batchSize = 100, log = console.log } = {}) {
  const hw = localMarker(db, table) || (await remoteMaxMarker(client, table, markerCol));
  const colList = columns.join(", ");
  const insertSql = `INSERT OR ${orMode} INTO ${table} (${colList}) VALUES (${columns.map(() => "?").join(", ")})`;
  const selectSql = hw
    ? `SELECT ${colList} FROM ${table} WHERE ${markerCol} >= ? ORDER BY ${markerCol}`
    : `SELECT ${colList} FROM ${table}`;
  const iterator = hw ? db.prepare(selectSql).iterate(hw) : db.prepare(selectSql).iterate();

  let batch = [];
  let n = 0;
  let maxSeen = "";
  for (const row of iterator) {
    const m = row[markerCol];
    if (m != null && String(m) > maxSeen) maxSeen = String(m);
    batch.push({ sql: insertSql, args: columns.map((c) => row[c]) });
    if (batch.length >= batchSize) {
      await client.pipeline(batch);
      n += batch.length;
      batch = [];
    }
  }
  if (batch.length) {
    await client.pipeline(batch);
    n += batch.length;
  }
  if (maxSeen || hw) saveLocalMarker(db, table, maxSeen || hw);
  log(`Synced ${table}: +${n} rows (since ${markerCol} >= ${hw || "BEGINNING"})`);
  return n;
}
