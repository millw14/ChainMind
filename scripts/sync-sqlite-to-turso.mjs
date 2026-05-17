import { loadEnv } from "../lib/load-env.js";
loadEnv();
import { openDb } from "../lib/db.js";

const TURSO_URL = process.env.TURSO_DATABASE_URL?.trim()?.replace("libsql://", "https://");
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN?.trim();

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error("Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.");
  process.exit(1);
}

async function tursoHttp(sql, args = []) {
  const res = await fetch(`${TURSO_URL}/v2/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TURSO_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: [{
        type: "execute",
        stmt: {
          sql,
          args: args.map((a) =>
            a == null ? { type: "null" }
            : typeof a === "number" ? { type: "integer", value: String(a) }
            : { type: "text", value: String(a) }
          ),
        },
      }],
    }),
  });
  const data = await res.json();
  if (data.results?.[0]?.type === "error") throw new Error(data.results[0].error?.message ?? "Turso error");
  return data.results?.[0]?.response?.result;
}

async function batchUpsert(rows, sql, argsMapper, label) {
  let n = 0;
  for (const r of rows) {
    await tursoHttp(sql, argsMapper(r));
    n++;
  }
  console.log(`Uploaded ${label}:`, n);
}

const local = openDb();
const sigs = local.prepare("SELECT * FROM signatures").all();
const evs = local.prepare("SELECT * FROM events").all();
const state = local.prepare("SELECT * FROM ingest_state").all();
const signers = local.prepare("SELECT * FROM signers").all();
const transfers = local.prepare("SELECT * FROM transfers").all();
const edges = local.prepare("SELECT * FROM edges").all();
local.close();

await batchUpsert(sigs,
  `INSERT OR REPLACE INTO signatures (signature, scope_address, slot, block_time, err, summary_json, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  (r) => [r.signature, r.scope_address, r.slot, r.block_time, r.err, r.summary_json, r.ingested_at],
  "signatures");

await batchUpsert(evs,
  `INSERT OR REPLACE INTO events (signature, scope_address, slot, block_time, fee_payer, event_type, programs_json, counterparties_json, parse_note, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  (r) => [r.signature, r.scope_address, r.slot, r.block_time, r.fee_payer, r.event_type, r.programs_json, r.counterparties_json, r.parse_note, r.ingested_at],
  "events");

await batchUpsert(signers,
  `INSERT OR REPLACE INTO signers (tx_sig, scope_address, address, role, ingested_at) VALUES (?, ?, ?, ?, ?)`,
  (r) => [r.tx_sig, r.scope_address, r.address, r.role, r.ingested_at],
  "signers");

await batchUpsert(transfers,
  `INSERT OR REPLACE INTO transfers (tx_sig, scope_address, idx, from_address, to_address, mint, amount, slot, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  (r) => [r.tx_sig, r.scope_address, r.idx, r.from_address, r.to_address, r.mint, r.amount, r.slot, r.ingested_at],
  "transfers");

await batchUpsert(edges,
  `INSERT OR REPLACE INTO edges (id, scope_address, from_address, to_address, tx_sig, slot, edge_type, mint, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  (r) => [r.id, r.scope_address, r.from_address, r.to_address, r.tx_sig, r.slot, r.edge_type, r.mint, r.ingested_at],
  "edges");

await batchUpsert(state,
  `INSERT OR REPLACE INTO ingest_state (scope_key, last_before_signature, updated_at) VALUES (?, ?, ?)`,
  (r) => [r.scope_key, r.last_before_signature, r.updated_at],
  "ingest_state rows");

console.log("Done. Refresh the Vercel dashboard DB + score panels.");
