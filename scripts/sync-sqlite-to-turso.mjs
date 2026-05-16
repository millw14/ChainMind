import { loadEnv } from "../lib/load-env.js";
loadEnv();

import { openDb } from "../lib/db.js";
import { getTursoClient } from "../lib/turso.js";

const turso = getTursoClient();
if (!turso) {
  console.error("Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.");
  process.exit(1);
}

const local = openDb();

const sigs = local.prepare(`SELECT * FROM signatures`).all();
const evs = local.prepare(`SELECT * FROM events`).all();
const state = local.prepare(`SELECT * FROM ingest_state`).all();
const signers = local.prepare(`SELECT * FROM signers`).all();
const transfers = local.prepare(`SELECT * FROM transfers`).all();
const programCalls = []; // skipped — not used by scoring or detection
const edges = local.prepare(`SELECT * FROM edges`).all();
local.close();

let n = 0;
for (const r of sigs) {
  await turso.execute({
    sql: `INSERT OR REPLACE INTO signatures
      (signature, scope_address, slot, block_time, err, summary_json, ingested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      r.signature,
      r.scope_address,
      r.slot,
      r.block_time,
      r.err,
      r.summary_json,
      r.ingested_at,
    ],
  });
  n++;
}
console.log("Uploaded signatures:", n);

n = 0;
for (const r of evs) {
  await turso.execute({
    sql: `INSERT OR REPLACE INTO events
      (signature, scope_address, slot, block_time, fee_payer, event_type,
       programs_json, counterparties_json, parse_note, ingested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      r.signature,
      r.scope_address,
      r.slot,
      r.block_time,
      r.fee_payer,
      r.event_type,
      r.programs_json,
      r.counterparties_json,
      r.parse_note,
      r.ingested_at,
    ],
  });
  n++;
}
console.log("Uploaded events:", n);

n = 0;
for (const r of signers) {
  await turso.execute({
    sql: `INSERT OR REPLACE INTO signers (tx_sig, scope_address, address, role, ingested_at)
      VALUES (?, ?, ?, ?, ?)`,
    args: [r.tx_sig, r.scope_address, r.address, r.role, r.ingested_at],
  });
  n++;
}
console.log("Uploaded signers:", n);

n = 0;
for (const r of transfers) {
  await turso.execute({
    sql: `INSERT OR REPLACE INTO transfers
      (tx_sig, scope_address, idx, from_address, to_address, mint, amount, slot, ingested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      r.tx_sig,
      r.scope_address,
      r.idx,
      r.from_address,
      r.to_address,
      r.mint,
      r.amount,
      r.slot,
      r.ingested_at,
    ],
  });
  n++;
}
console.log("Uploaded transfers:", n);

/*
n = 0;
for (const r of programCalls) {
  await turso.execute({
    sql: `INSERT OR REPLACE INTO program_calls
      (tx_sig, scope_address, idx, program_id, instruction_name, slot, ingested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      r.tx_sig,
      r.scope_address,
      r.idx,
      r.program_id,
      r.instruction_name,
      r.slot,
      r.ingested_at,
    ],
  });
  n++;
}
console.log("Uploaded program_calls:", n);
*/

n = 0;
for (const r of edges) {
  await turso.execute({
    sql: `INSERT OR REPLACE INTO edges
      (id, scope_address, from_address, to_address, tx_sig, slot, edge_type, mint, ingested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      r.id,
      r.scope_address,
      r.from_address,
      r.to_address,
      r.tx_sig,
      r.slot,
      r.edge_type,
      r.mint,
      r.ingested_at,
    ],
  });
  n++;
}
console.log("Uploaded edges:", n);

n = 0;
for (const r of state) {
  await turso.execute({
    sql: `INSERT OR REPLACE INTO ingest_state (scope_key, last_before_signature, updated_at)
      VALUES (?, ?, ?)`,
    args: [r.scope_key, r.last_before_signature, r.updated_at],
  });
  n++;
}
console.log("Uploaded ingest_state rows:", n);
console.log("Done. Refresh the Vercel dashboard DB + score panels.");
