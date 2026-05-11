import { loadEnv } from "../lib/load-env.js";
loadEnv();

import { PublicKey } from "@solana/web3.js";
import { getSolanaConnection } from "../lib/solana.js";
import { withRpcRetry } from "../lib/rpc-retry.js";

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

const limit = Math.min(
  100,
  Math.max(1, Number(flags.limit ?? process.env.INSPECT_LIMIT ?? "15") || 15),
);

if (!address) {
  console.error(`
Usage:
  npm run inspect -- <base58-address>

Or set TARGET_ADDRESS in .env.local

Example (USDC mint on mainnet):
  npm run inspect -- EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
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

const connection = getSolanaConnection();
const verbose = Boolean(flags.verbose);

console.log("Inspect address");
console.log("-------------");
console.log("Address:", pubkey.toBase58());
console.log("Limit  :", limit);
console.log("");

const sigs = await withRpcRetry(() =>
  connection.getSignaturesForAddress(pubkey, { limit }),
);

if (sigs.length === 0) {
  console.log("No recent signatures for this address (or RPC returned empty).");
  process.exit(0);
}

for (const s of sigs) {
  const errStr = s.err ? JSON.stringify(s.err) : "ok";
  console.log(
    [s.slot ?? "?", s.blockTime ?? "?", errStr, s.signature.slice(0, 16) + "…"].join(
      " | ",
    ),
  );
}

if (verbose && sigs[0]) {
  const full = await withRpcRetry(() =>
    connection.getParsedTransaction(sigs[0].signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    }),
  );
  console.log("");
  console.log("First tx (verbose):");
  console.log(JSON.stringify(full, (_, v) => (typeof v === "bigint" ? String(v) : v), 2));
}

console.log("");
console.log("(Columns: slot | blockTime | err | signature prefix)");
