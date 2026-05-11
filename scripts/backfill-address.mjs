import { loadEnv } from "../lib/load-env.js";
loadEnv();

import { PublicKey } from "@solana/web3.js";
import { getSolanaConnection } from "../lib/solana.js";
import { withRpcRetry } from "../lib/rpc-retry.js";
import { openDb } from "../lib/db.js";

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
  process.env.TARGET_ADDRESS?.trim() ||
  "";

const maxTotal = Math.min(
  5000,
  Math.max(1, Number(flags.max ?? process.env.BACKFILL_MAX ?? "200") || 200),
);

if (!address) {
  console.error(`
Usage:
  npm run backfill -- <base58-address> [--max=200]

Or set TARGET_ADDRESS and BACKFILL_MAX in .env.local
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
const insert = db.prepare(`
  INSERT OR REPLACE INTO signatures
    (signature, scope_address, slot, block_time, err, summary_json, ingested_at)
  VALUES (@signature, @scope_address, @slot, @block_time, @err, @summary_json, @ingested_at)
`);
const upsertCursor = db.prepare(`
  INSERT INTO ingest_state (scope_key, last_before_signature, updated_at)
  VALUES (@scope_key, @last_before_signature, @updated_at)
  ON CONFLICT(scope_key) DO UPDATE SET
    last_before_signature = excluded.last_before_signature,
    updated_at = excluded.updated_at
`);

const connection = getSolanaConnection();
let fetched = 0;
let before = undefined;
const batchSize = 100;

console.log("Backfill signatures");
console.log("-------------------");
console.log("Scope    :", scope);
console.log("Max rows :", maxTotal);
console.log("");

while (fetched < maxTotal) {
  const need = Math.min(batchSize, maxTotal - fetched);
  const batch = await withRpcRetry(() =>
    connection.getSignaturesForAddress(pubkey, { limit: need, before }),
  );

  if (batch.length === 0) break;

  const now = new Date().toISOString();
  const run = db.transaction((rows) => {
    for (const s of rows) {
      const errStr = s.err ? JSON.stringify(s.err) : null;
      const summary = s.memo ? JSON.stringify({ memo: s.memo }) : null;
      insert.run({
        signature: s.signature,
        scope_address: scope,
        slot: s.slot ?? null,
        block_time: s.blockTime ?? null,
        err: errStr,
        summary_json: summary,
        ingested_at: now,
      });
    }
  });

  run(batch);
  fetched += batch.length;
  before = batch[batch.length - 1].signature;
  upsertCursor.run({
    scope_key: scope,
    last_before_signature: before,
    updated_at: now,
  });

  console.log(`Fetched ${fetched} / ${maxTotal} (last before cursor → next page)`);
  if (batch.length < need) break;
}

const total = db
  .prepare(`SELECT COUNT(*) AS c FROM signatures WHERE scope_address = ?`)
  .get(scope).c;

console.log("");
console.log("Done. This run added/up to:", fetched, "| total rows for scope in DB:", total);
db.close();
