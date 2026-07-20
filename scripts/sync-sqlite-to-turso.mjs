import { loadEnv } from "../lib/load-env.js";
loadEnv();
import { openDb } from "../lib/db.js";

const TURSO_URL = process.env.TURSO_DATABASE_URL?.trim()?.replace("libsql://", "https://");
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN?.trim();

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error("Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.");
  process.exit(1);
}

const BATCH = Math.max(1, Number(process.env.TURSO_SYNC_BATCH) || 100);

/** @param {unknown} a */
function encodeArg(a) {
  if (a == null) return { type: "null" };
  if (typeof a === "number" || typeof a === "bigint") return { type: "integer", value: String(a) };
  return { type: "text", value: String(a) };
}

/** Run N statements in one Turso pipeline request; throw on any per-statement error. */
async function tursoPipeline(stmts) {
  const res = await fetch(`${TURSO_URL}/v2/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TURSO_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: stmts.map((s) => ({ type: "execute", stmt: { sql: s.sql, args: (s.args ?? []).map(encodeArg) } })),
    }),
  });
  if (!res.ok) throw new Error(`Turso HTTP ${res.status}`);
  const data = await res.json();
  for (const r of data.results ?? []) {
    if (r?.type === "error") throw new Error(r.error?.message ?? "Turso error");
  }
  return data.results ?? [];
}

/** High-water mark already in Turso for a table (first-run fallback only — see syncTable). */
async function tursoMaxMarker(table, col) {
  const results = await tursoPipeline([{ sql: `SELECT MAX(${col}) AS m FROM ${table}`, args: [] }]);
  const v = results[0]?.response?.result?.rows?.[0]?.[0]?.value;
  return v == null ? "" : String(v);
}

/**
 * Last marker THIS local db has synced for a table. Turso's global MAX spans every
 * writer (reparse-libsql, other ingest hosts) whose clocks can run ahead of ours,
 * which would permanently skip our older unsynced rows — so the watermark is kept
 * per local database, falling back to Turso's MAX only when no local marker exists.
 */
function localMarker(db, table) {
  return db.prepare("SELECT last_marker FROM sync_state WHERE table_name = ?").get(table)?.last_marker ?? "";
}

function saveLocalMarker(db, table, marker) {
  db.prepare("INSERT OR REPLACE INTO sync_state (table_name, last_marker, updated_at) VALUES (?, ?, ?)")
    .run(table, marker, new Date().toISOString());
}

/**
 * Stream local rows newer than the high-water mark and upsert them in batches.
 * Streaming (.iterate) avoids loading whole tables into memory — the OOM/abort that
 * killed the old SELECT *.all() approach once data grew.
 */
async function syncTable(db, table, columns, { markerCol = "ingested_at", orMode = "REPLACE" } = {}) {
  const hw = localMarker(db, table) || (await tursoMaxMarker(table, markerCol));
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
    if (batch.length >= BATCH) {
      await tursoPipeline(batch);
      n += batch.length;
      batch = [];
    }
  }
  if (batch.length) {
    await tursoPipeline(batch);
    n += batch.length;
  }
  if (maxSeen || hw) saveLocalMarker(db, table, maxSeen || hw);
  console.log(`Synced ${table}: +${n} rows (since ${markerCol} >= ${hw || "BEGINNING"})`);
  return n;
}

const db = openDb();
// Local-only bookkeeping (never pushed to Turso): per-table sync watermark.
db.exec(`
  CREATE TABLE IF NOT EXISTS sync_state (
    table_name TEXT PRIMARY KEY,
    last_marker TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);
try {
  await syncTable(db, "signatures", ["signature", "scope_address", "slot", "block_time", "err", "summary_json", "ingested_at"]);
  await syncTable(db, "events", ["signature", "scope_address", "slot", "block_time", "fee_payer", "event_type", "programs_json", "counterparties_json", "parse_note", "ingested_at"]);
  await syncTable(db, "signers", ["tx_sig", "scope_address", "address", "role", "ingested_at"]);
  await syncTable(db, "transfers", ["tx_sig", "scope_address", "idx", "from_address", "to_address", "mint", "amount", "slot", "ingested_at"]);
  await syncTable(db, "program_calls", ["tx_sig", "scope_address", "idx", "program_id", "instruction_name", "slot", "ingested_at"]);
  // edges: omit autoincrement id (local ids reset on ephemeral hosts and would clobber
  // unrelated Turso rows); dedupe on the natural unique index via INSERT OR IGNORE.
  await syncTable(db, "edges", ["scope_address", "from_address", "to_address", "tx_sig", "slot", "edge_type", "mint", "ingested_at"], { orMode: "IGNORE" });

  // ingest_state is tiny (one row per scope) — full upsert, no marker needed.
  const stateRows = db.prepare("SELECT scope_key, last_before_signature, updated_at FROM ingest_state").all();
  for (let i = 0; i < stateRows.length; i += BATCH) {
    await tursoPipeline(
      stateRows.slice(i, i + BATCH).map((r) => ({
        sql: "INSERT OR REPLACE INTO ingest_state (scope_key, last_before_signature, updated_at) VALUES (?, ?, ?)",
        args: [r.scope_key, r.last_before_signature, r.updated_at],
      })),
    );
  }
  console.log(`Synced ingest_state: ${stateRows.length} rows`);
} finally {
  db.close();
}
console.log("Done (incremental). Dashboard reads Turso.");
