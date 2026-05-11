import { loadEnv } from "../lib/load-env.js";
loadEnv();

import { PublicKey } from "@solana/web3.js";
import { openDb } from "../lib/db.js";
import { computeCoactivityScore } from "../lib/score-core.js";

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

const windowMinutes = Math.min(
  60,
  Math.max(1, Number(flags.window ?? process.env.SCORE_WINDOW_MINUTES ?? "5") || 5),
);

const lastHours = Math.min(
  24 * 30,
  Math.max(1, Number(flags.hours ?? process.env.SCORE_LAST_HOURS ?? "24") || 24),
);

if (!address) {
  console.error(`
Usage:
  npm run score-window -- <base58-scope> [--window=5] [--hours=24]

v1 score = max distinct fee payers in any fixed time bucket (co-activity proxy only).
`);
  process.exit(1);
}

try {
  new PublicKey(address);
} catch {
  console.error("Invalid base58 address:", address);
  process.exit(1);
}

const scope = address.trim();
const db = openDb();
const result = computeCoactivityScore(db, scope, windowMinutes, lastHours);
db.close();

if (result.empty) {
  console.log(result.message ?? "No data.");
  process.exit(0);
}

const r = result;
console.log("");
console.log("ChainMind score — v1 (co-activity proxy, NOT collusion proof)");
console.log("=============================================================");
console.log("Scope          :", r.scope);
console.log("Bucket width   :", r.windowMinutes, "minutes");
console.log("Lookback       :", r.lastHours, "hours");
console.log("Events counted :", r.eventsCounted);
console.log("Distinct payers:", r.distinctPayersWholeWindow, "(whole window)");
console.log("");
console.log("Score          :", r.score);
console.log("  (= max distinct fee payers in any single bucket)");
if (r.peakBucketStartsIso) {
  console.log(
    "  Peak bucket  : starts",
    r.peakBucketStartsIso,
    `(${r.peakBucketWalletCount} wallets)`,
  );
}
console.log("");
console.log("Event types:");
for (const [t, n] of Object.entries(r.typeBreakdown)) {
  console.log(`  ${t}: ${n}`);
}
console.log("");
console.log("Top programs (instruction targets, heuristic):");
for (const { program: p, count: n } of r.topPrograms) {
  console.log(`  ${n}×  ${p}`);
}
console.log("");
console.log("Drivers (plain English):");
for (const line of r.drivers) {
  console.log("-", line);
}
console.log("");
console.log(r.limitation);
