import { loadEnv } from "../lib/load-env.js";
loadEnv();

import { PublicKey } from "@solana/web3.js";
import { getSolanaConnection } from "../lib/solana.js";
import { openDb } from "../lib/db.js";
import { ingestPendingEventsForScope } from "../lib/pipeline-sync.js";

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

console.log("Ingest events (parsed txs)");
console.log("-------------------------");
console.log("Scope :", scope);
console.log("Batch : up to", batchLimit);
console.log("Throttle between RPC calls:", throttleMs, "ms");
console.log("");

const { parsed: ok } = await ingestPendingEventsForScope(connection, db, scope, {
  limit: batchLimit,
  throttleMs,
});

if (ok === 0) {
  console.log("No new signatures to parse for scope:", scope);
  db.close();
  process.exit(0);
}

const totalEvents = db.prepare(`SELECT COUNT(*) AS c FROM events WHERE scope_address = ?`).get(scope).c;

console.log("Parsed rows:", ok);
console.log("Total events in DB for scope:", totalEvents);
db.close();
