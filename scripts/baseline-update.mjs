import { loadEnv } from "../lib/load-env.js";
loadEnv();

import { PublicKey } from "@solana/web3.js";
import {
  computeBaseline,
  fetchBaseline,
  fetchStaleBaselines,
  persistBaseline,
} from "../lib/baseline-manager.js";
import { buildTimelineBucketsFromRows } from "../lib/score-math.js";
// HTTP (pure-fetch) Turso client — importing lib/turso.js pulls in @libsql/client,
// whose native `libsql` dep fails to load on Railway and crashed baseline:update.
import { fetchEventsForScopeHttp, getTursoHttpClient } from "../lib/turso-http.js";
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
const windowMin = Math.min(60, Math.max(1, Number(flags.window ?? process.env.SCORE_WINDOW_MINUTES ?? "5") || 5));
const lookbackH = Math.min(24 * 30, Math.max(1, Number(flags.hours ?? "168") || 168));
const maxAgeDays = Math.max(0, Number(flags["max-age-days"] ?? "1") || 1);
const scopeDelayMs = Math.max(0, Number(flags["scope-delay-ms"] ?? "400") || 400);

// Single-scope override (mirrors ingest-events pattern)
const singleScope =
  positional[0]?.trim() ||
  process.env.CHAINMIND_SCOPE?.trim() ||
  process.env.TARGET_ADDRESS?.trim() ||
  null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function validateBase58(addr) {
  try {
    return new PublicKey(addr).toBase58();
  } catch {
    return null;
  }
}

function fmtBaseline(b) {
  if (!b) return "none stored";
  return `regime=${b.regime} buckets=${b.bucket_count} span=${b.span_hours ?? "?"}h shallow=${b.shallow_history}`;
}

async function processScope(turso, scopeAddress, windowMinutes, lookbackHours) {
  const cutoffSec = Math.floor(Date.now() / 1000) - lookbackHours * 3600;
  let rows;
  try {
    rows = await fetchEventsForScopeHttp(turso, scopeAddress, cutoffSec);
  } catch (e) {
    return { ok: false, reason: `turso fetch failed: ${String(e?.message ?? e)}` };
  }

  if (rows.length < 8) {
    return { ok: false, reason: `insufficient events (${rows.length} — need ≥ 8)` };
  }

  const timelineBuckets = buildTimelineBucketsFromRows(rows, windowMinutes);

  if (timelineBuckets.length < 8) {
    return { ok: false, reason: `insufficient buckets (${timelineBuckets.length} — need ≥ 8)` };
  }

  const baseline = computeBaseline(timelineBuckets, windowMinutes);
  if (!baseline) {
    return { ok: false, reason: "computeBaseline returned null" };
  }

  await persistBaseline(turso, scopeAddress, baseline);
  return { ok: true, baseline };
}

async function main() {
  console.log("ChainMind baseline:update");
  console.log("-------------------------");
  console.log("Window        :", windowMin, "min");
  console.log("Lookback      :", lookbackH, "h");
  console.log(
    "Force refresh :",
    force ? "yes (--force)" : `no — skip scopes whose baseline is newer than max-age-days=${maxAgeDays}`,
  );
  console.log("");

  const turso = getTursoHttpClient();
  if (!turso) {
    console.error("TURSO_* env vars not configured — baseline:update requires Turso.");
    process.exit(1);
  }

  let scopes;
  if (singleScope) {
    const addr = validateBase58(singleScope);
    if (!addr) {
      console.error("Invalid base58 address:", singleScope);
      process.exit(1);
    }
    scopes = [{ address: addr, note: "single scope (CLI arg / env)" }];
  } else {
    const watchlist = loadWatchlist();
    if (watchlist.length === 0) {
      console.error("No watchlist scopes found. Add scopes to config/watchlist.json or set CHAINMIND_SCOPE.");
      process.exit(1);
    }
    scopes = watchlist;
  }

  const staleSet = new Set();
  if (!force) {
    const staleRows = await fetchStaleBaselines(turso, maxAgeDays);
    for (const r of staleRows) staleSet.add(String(r.scope_address));
  }

  console.log(`Scopes to process: ${scopes.length}`);
  console.log("");

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const s of scopes) {
    const addr = validateBase58(s.address);
    if (!addr) {
      console.warn(`  SKIP invalid address: ${s.address}`);
      skipped++;
      continue;
    }

    const label = s.note ? `${addr} — ${s.note}` : addr;

    if (!force) {
      const existing = await fetchBaseline(turso, addr, windowMin);
      if (existing && !staleSet.has(addr)) {
        const ageH = Math.round((Date.now() / 1000 - Number(existing.computed_at)) / 3600);
        console.log(`  SKIP ${label}`);
        console.log(`       baseline fresh (${ageH}h old, max-age-days=${maxAgeDays})`);
        skipped++;
        if (scopeDelayMs > 0) await sleep(scopeDelayMs);
        continue;
      }
    }

    console.log(`  → ${label}`);
    const result = await processScope(turso, addr, windowMin, lookbackH);

    if (result.ok) {
      updated++;
      console.log(`    ✓ ${fmtBaseline(result.baseline)}`);
    } else {
      failed++;
      console.warn(`    ✗ ${result.reason}`);
    }

    if (scopeDelayMs > 0) await sleep(scopeDelayMs);
  }

  console.log("");
  console.log("Done.");
  console.log(`  Updated : ${updated}`);
  console.log(`  Skipped : ${skipped}`);
  console.log(`  Failed  : ${failed}`);

  if (failed > 0) process.exit(1);
}

await main();
