// Cloud-direct re-parse: read a scope's unparsed signatures straight from libSQL, fetch
// each tx from RPC, parse it, and write events + graph rows (signers/transfers/program_calls/
// edges) back to libSQL. Recovers a parse backlog without going through the local SQLite
// pipeline. Idempotent (delete-then-insert per tx), so it's safe to re-run / resume.
//
//   node scripts/reparse-libsql.mjs --scope=<base58> [--limit=200] [--throttle=250]
import { loadEnv } from "../lib/load-env.js";
loadEnv();

import { getTursoClient } from "../lib/turso.js";
import { getSolanaConnection } from "../lib/solana.js";
import { withRpcRetry } from "../lib/rpc-retry.js";
import { parsedToEventRow } from "../lib/parse-tx.js";
import { extractTxGraph } from "../lib/parse-tx-graph.js";

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, ...v] = a.slice(2).split("=");
    return [k, v.length ? v.join("=") : true];
  }),
);
const scope = String(flags.scope ?? "").trim();
const limit = Math.max(1, Number(flags.limit ?? 200) || 200);
const throttleMs = Math.max(0, Number(flags.throttle ?? 250) || 250);
if (!scope) { console.error("Missing --scope=<base58>"); process.exit(1); }

const client = getTursoClient();
if (!client) { console.error("No libSQL client — check .env.local"); process.exit(1); }
const conn = getSolanaConnection();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const coerce = (v) => (v === undefined ? null : typeof v === "bigint" ? v.toString() : v);

// client.batch isn't wrapped by turso.js withRetry — add our own backoff for the flaky link.
async function batchWithRetry(stmts) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { return await client.batch(stmts, "write"); }
    catch (e) {
      if (attempt === 4) throw e;
      await sleep(300 * (attempt + 1));
    }
  }
}

const pending = (await client.execute({
  sql: `SELECT s.signature, s.slot, s.block_time
        FROM signatures s
        LEFT JOIN events e ON e.signature = s.signature AND e.scope_address = s.scope_address
        WHERE s.scope_address = ? AND e.signature IS NULL AND s.err IS NULL
        ORDER BY s.slot DESC LIMIT ?`,
  args: [scope, limit],
})).rows;

console.log(`scope=${scope.slice(0, 10)} pending-to-parse this run: ${pending.length} (limit ${limit}, throttle ${throttleMs}ms)`);

let processed = 0, withEvents = 0, edgesWritten = 0, errors = 0;
for (let i = 0; i < pending.length; i++) {
  const row = pending[i];
  const sig = String(row.signature);
  const slot = row.slot != null ? Number(row.slot) : null;
  const bt = row.block_time != null ? Number(row.block_time) : null;
  if (throttleMs > 0 && i > 0) await sleep(throttleMs);

  let txn = null;
  try {
    txn = await withRpcRetry(
      () => conn.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }),
      { maxAttempts: 6, baseMs: 600, maxMs: 30_000 },
    );
  } catch {
    errors++; // leave it in the backlog to retry on a later run
    continue;
  }

  const ev = parsedToEventRow(txn);
  let parseNote = ev.parse_note;
  if (!txn && !parseNote) parseNote = "getParsedTransaction_null";
  const graph = txn ? extractTxGraph(txn, slot) : { signers: [], transfers: [], programCalls: [], edges: [] };
  const now = new Date().toISOString();

  const stmts = [
    { sql: `DELETE FROM edges WHERE tx_sig = ? AND scope_address = ?`, args: [sig, scope] },
    { sql: `DELETE FROM program_calls WHERE tx_sig = ? AND scope_address = ?`, args: [sig, scope] },
    { sql: `DELETE FROM transfers WHERE tx_sig = ? AND scope_address = ?`, args: [sig, scope] },
    { sql: `DELETE FROM signers WHERE tx_sig = ? AND scope_address = ?`, args: [sig, scope] },
    { sql: `INSERT OR REPLACE INTO events (signature,scope_address,slot,block_time,fee_payer,event_type,programs_json,counterparties_json,parse_note,ingested_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      args: [sig, scope, slot, bt, coerce(ev.fee_payer), ev.event_type, coerce(ev.programs_json), coerce(ev.counterparties_json), parseNote, now] },
  ];
  for (const s of graph.signers)
    stmts.push({ sql: `INSERT OR REPLACE INTO signers (tx_sig,scope_address,address,role,ingested_at) VALUES (?,?,?,?,?)`, args: [sig, scope, coerce(s.address), coerce(s.role), now] });
  for (const t of graph.transfers)
    stmts.push({ sql: `INSERT OR REPLACE INTO transfers (tx_sig,scope_address,idx,from_address,to_address,mint,amount,slot,ingested_at) VALUES (?,?,?,?,?,?,?,?,?)`, args: [sig, scope, coerce(t.idx), coerce(t.from_address), coerce(t.to_address), coerce(t.mint), coerce(t.amount), slot, now] });
  for (const c of graph.programCalls)
    stmts.push({ sql: `INSERT OR REPLACE INTO program_calls (tx_sig,scope_address,idx,program_id,instruction_name,slot,ingested_at) VALUES (?,?,?,?,?,?,?)`, args: [sig, scope, coerce(c.idx), coerce(c.program_id), coerce(c.instruction_name), slot, now] });
  for (const e of graph.edges)
    stmts.push({ sql: `INSERT OR IGNORE INTO edges (scope_address,from_address,to_address,tx_sig,slot,edge_type,mint,ingested_at) VALUES (?,?,?,?,?,?,?,?)`, args: [scope, coerce(e.from_address), coerce(e.to_address), sig, slot, coerce(e.edge_type), coerce(e.mint), now] });

  try {
    await batchWithRetry(stmts);
    processed++; if (txn) withEvents++; edgesWritten += graph.edges.length;
  } catch (e) {
    errors++;
    console.error(`  write failed ${sig.slice(0, 8)}: ${e?.message ?? e}`);
  }
  if ((i + 1) % 50 === 0 || i === pending.length - 1)
    console.log(`  ${i + 1}/${pending.length} — events ${withEvents}, edges +${edgesWritten}, errors ${errors}`);
}

console.log(`DONE scope=${scope.slice(0, 10)} processed=${processed} withEvents=${withEvents} edgesWritten=${edgesWritten} errors=${errors}`);
process.exit(0);
