/**
 * Compute and persist scope_baselines from Turso events (same row fetch as score-core / tursoFetchScoreRows).
 *
 * First run (single scope):
 *   npm run baseline:update -- <base58> --force
 *
 * Expect regime=, buckets=, span=, shallow= in the log. shallow=true means <2h baseline span — ingest
 * more history (e.g. npm run backfill), then re-run with --force.
 */
import { loadEnv } from "../lib/load-env.js";
loadEnv();

import { PublicKey } from "@solana/web3.js";
import {
  updateBaselineForScope,
  updateBaselinesForStaleRows,
} from "../lib/baseline-update-run.js";
import { getTursoClient } from "../lib/turso.js";
import { loadWatchlist } from "../lib/watchlist.js";

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
const force = flags.force === true;
const staleOnly = flags["stale-only"] === true;
const windowMinutes = Math.min(
  120,
  Math.max(1, Number(flags.window ?? process.env.SCORE_WINDOW_MINUTES ?? "5") || 5),
);
const lastHours = Math.min(
  24 * 90,
  Math.max(1, Number(flags.hours ?? flags.lookback ?? "168") || 168),
);
const staleDays = Math.min(365, Math.max(1, Number(flags["stale-days"] ?? "1") || 1));

const opts = { lastHours, force };

/**
 * @param {Awaited<ReturnType<typeof updateBaselineForScope>>} r
 * @param {string} scopeAddress
 */
function logScopeResult(r, scopeAddress) {
  if (r.status === "skip") {
    console.log(`  skip ${scopeAddress}: ${r.detail ?? "?"}`);
    return;
  }
  const b = r.baseline;
  if (!b) return;
  console.log(
    `  ok ${scopeAddress} regime=${b.regime} buckets=${b.bucket_count} span=${b.span_hours}h shallow=${b.shallow_history}`,
  );
}

const client = getTursoClient();
if (!client) {
  console.error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set.");
  process.exit(1);
}

const single =
  positional[0]?.trim() ||
  process.env.CHAINMIND_SCOPE?.trim() ||
  process.env.TARGET_ADDRESS?.trim() ||
  "";

if (single) {
  let scope;
  try {
    scope = new PublicKey(single).toBase58();
  } catch {
    console.error("Invalid base58 address:", single);
    process.exit(1);
  }

  console.log("baseline:update (single scope)");
  console.log("--------------------------");
  console.log("Scope           :", scope);
  console.log("Window minutes  :", windowMinutes);
  console.log("Lookback hours  :", lastHours);
  console.log("Force shallow   :", force);
  console.log("");
  const r = await updateBaselineForScope(client, scope, windowMinutes, opts);
  logScopeResult(r, scope);
  process.exit(0);
}

if (staleOnly) {
  console.log("baseline:update (--stale-only)");
  console.log("-----------------------------");
  console.log("Lookback hours  :", lastHours);
  console.log("Force shallow   :", force);
  console.log("");
  const { staleRowCount, results } = await updateBaselinesForStaleRows(client, staleDays, opts);
  console.log("Stale rows      :", staleRowCount, `(computed_at older than ${staleDays}d)`);
  for (const row of results) {
    const label = `${row.scope} (window=${row.bucketWidthMinutes}m)`;
    if (row.status === "skip") {
      console.log(`  skip ${label}: ${row.detail ?? "?"}`);
    } else {
      console.log(
        `  ok ${label} regime=${row.regime} buckets=${row.bucket_count} span=${row.span_hours}h shallow=${row.shallow}`,
      );
    }
  }
  process.exit(0);
}

const scopes = loadWatchlist();
if (scopes.length === 0) {
  console.error(`
Usage:
  npm run baseline:update -- <base58> [--force] [--window=5] [--hours=168]
  npm run baseline:update [--force] [--window=5] [--hours=168]   # all scopes in watchlist
  npm run baseline:update --stale-only [--stale-days=1] [--force]

Single-scope env: CHAINMIND_SCOPE / TARGET_ADDRESS
Watchlist: config/watchlist.json or CHAINMIND_WATCHLIST / CHAINMIND_WATCHLIST_JSON

${force ? "" : "Use --force to persist when shallow=true (short baseline span).\n"}`);
  process.exit(1);
}

console.log("baseline:update (watchlist)");
console.log("---------------------------");
console.log("Scopes          :", scopes.length);
console.log("Window minutes  :", windowMinutes);
console.log("Lookback hours  :", lastHours);
console.log("Force shallow   :", force);
console.log("");

for (const s of scopes) {
  const label = s.note ? `${s.address} — ${s.note}` : s.address;
  console.log("—", label);
  const r = await updateBaselineForScope(client, s.address, windowMinutes, opts);
  logScopeResult(r, s.address);
}
