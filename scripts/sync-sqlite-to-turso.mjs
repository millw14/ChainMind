import { loadEnv } from "../lib/load-env.js";
loadEnv();
import { openDb } from "../lib/db.js";
import { SYNC_TABLES, ensureSyncState, syncTable } from "../lib/sync-tables.js";

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

// The per-table sync core (marker resolution, row selection, statement building)
// lives in lib/sync-tables.js so it can be unit-tested; this script only wires it
// to the real Turso pipeline endpoint.
const client = { pipeline: tursoPipeline };

const db = openDb();
ensureSyncState(db);
try {
  for (const { table, columns, orMode } of SYNC_TABLES) {
    await syncTable(db, client, table, columns, { orMode, batchSize: BATCH });
  }

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
