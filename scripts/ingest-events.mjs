import { loadEnv } from "../lib/load-env.js";
loadEnv();

import { PublicKey } from "@solana/web3.js";
import { getSolanaConnection } from "../lib/solana.js";
import { withRpcRetry } from "../lib/rpc-retry.js";
import { openDb } from "../lib/db.js";
import { parsedToEventRow } from "../lib/parse-tx.js";

function parseFlags(argv) {
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  const positional = [];
  for (const a of argv) {
    if (a.startsWith("--")) {
      const raw = a.slice(2);
      const eq = raw.indexOf("=");
      if (eq === -1) flags[raw] = true;
      else flags[raw.slice(0, eq)] = raw.slice(eq + 1);
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

const { flags, positional } = parseFlags(process.argv.slice(2));
const address =
  positional[0]?.trim() ||
  process.env.CHAINMIND_SCOPE?.trim() ||
  process.env.TARGET_ADDRESS?.trim() ||
  "";

const throttleMs = Math.max(
  0,
  Number(flags.throttle ?? process.env.INGEST_THROTTLE_MS ?? "900") || 900,
);

const batchLimit = Math.min(
  500,
  Math.max(1, Number(flags.limit ?? process.env.INGEST_PARSE_LIMIT ?? "40") || 40),
);

if (!address) {
  console.error(`
Usage:
  npm run ingest-events -- <base58-scope-address> [--limit=40]

Uses signatures already in DB for that scope (run backfill first).
Default scope env: CHAINMIND_SCOPE or TARGET_ADDRESS

Flags:
  --limit=N       signatures to parse (default 40)
  --throttle=MS   pause between RPC calls (default 900; raise if you see 429)
`);
  process.exit(1);
}

let pubkey;
try {
  pubkey = new PublicKey(address);
} catch {
  console.error("Invalid base58 address:", address);
  process.exit(1);
}

const scope = pubkey.toBase58();
const db = openDb();
const connection = getSolanaConnection();

const pending = db
  .prepare(
    `
    SELECT s.signature, s.slot, s.block_time
    FROM signatures s
    LEFT JOIN events e
      ON e.signature = s.signature AND e.scope_address = s.scope_address
    WHERE s.scope_address = ? AND e.signature IS NULL
    ORDER BY s.slot DESC
    LIMIT ?
  `,
  )
  .all(scope, batchLimit);

if (pending.length === 0) {
  console.log("No new signatures to parse for scope:", scope);
  db.close();
  process.exit(0);
}

const insert = db.prepare(`
  INSERT OR REPLACE INTO events
    (signature, scope_address, slot, block_time, fee_payer, event_type,
     programs_json, counterparties_json, parse_note, ingested_at)
  VALUES (@signature, @scope_address, @slot, @block_time, @fee_payer, @event_type,
          @programs_json, @counterparties_json, @parse_note, @ingested_at)
`);

console.log("Ingest events (parsed txs)");
console.log("-------------------------");
console.log("Scope :", scope);
console.log("Batch :", pending.length);
console.log("Throttle between RPC calls:", throttleMs, "ms");
console.log("");

let ok = 0;
for (let i = 0; i < pending.length; i++) {
  const row = pending[i];
  if (throttleMs > 0 && i > 0) {
    await new Promise((r) => setTimeout(r, throttleMs));
  }

  const parsed = await withRpcRetry(
    () =>
      connection.getParsedTransaction(row.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      }),
    { maxAttempts: 8, baseMs: 800, maxMs: 45_000 },
  );

  const ev = parsedToEventRow(parsed);
  const now = new Date().toISOString();
  let parseNote = ev.parse_note;
  if (!parsed && !parseNote) parseNote = "getParsedTransaction_null";

  insert.run({
    signature: row.signature,
    scope_address: scope,
    slot: row.slot ?? null,
    block_time: row.block_time ?? null,
    fee_payer: ev.fee_payer,
    event_type: ev.event_type,
    programs_json: ev.programs_json,
    counterparties_json: ev.counterparties_json,
    parse_note: parseNote,
    ingested_at: now,
  });
  ok++;
}

const totalEvents = db.prepare(`SELECT COUNT(*) AS c FROM events WHERE scope_address = ?`).get(scope)
  .c;

console.log("Parsed rows:", ok);
console.log("Total events in DB for scope:", totalEvents);
db.close();
