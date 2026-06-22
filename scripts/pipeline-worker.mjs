import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadEnv } from "../lib/load-env.js";
loadEnv();

import { openDb } from "../lib/db.js";
import { getSolanaConnection } from "../lib/solana.js";
import { loadWatchlist } from "../lib/watchlist.js";
import { countPendingForScope, ingestPendingEventsForScope, syncHeadSignaturesForScope } from "../lib/pipeline-sync.js";
import { tursoHttpAddToScanQueue, tursoHttpFetchPendingScanQueue, tursoHttpMarkScanQueuePicked } from "../lib/turso-http.js";
import { discoverTrendingSolanaMints } from "../lib/token-discovery.js";
import { isKnownEntity } from "../lib/known-entities.js";

function parseFlags(argv) {
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const raw = a.slice(2);
    const eq = raw.indexOf("=");
    if (eq === -1) flags[raw] = true;
    else flags[raw.slice(0, eq)] = raw.slice(eq + 1);
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(2));
const once = flags.once === true;
const tursoSync = flags["turso-sync"] === true;

const roundIntervalMs = Math.max(
  5000,
  Number(flags["round-interval-ms"] ?? process.env.PIPELINE_ROUND_MS ?? "90000") || 90_000,
);
const scopeDelayMs = Math.max(0, Number(flags["scope-delay-ms"] ?? "1500") || 1500);
// Head-poll discovery was outrunning parsing ~11:1 (400 discovered vs 35 parsed / scope /
// round), so the unparsed backlog grew without bound. Lower the discovery ceiling and
// raise the parse budget so parsing can keep pace; the parse-first guard below caps it.
const headMax = Math.min(5000, Math.max(5, Number(flags["head-max"] ?? "150") || 150));
const headPage = Math.min(150, Math.max(10, Number(flags["head-page"] ?? "80") || 80));
const ingestLimit = Math.min(
  500,
  Math.max(1, Number(flags["ingest-limit"] ?? process.env.INGEST_PARSE_LIMIT ?? "60") || 60),
);
const ingestThrottleMs = Math.max(0, Number(flags["ingest-throttle"] ?? process.env.INGEST_THROTTLE_MS ?? "900") || 900);
// When a scope's parse backlog exceeds this, pause head-polling for it and spend the
// round parsing instead — bounds the backlog instead of letting discovery grow it.
const backlogPauseAt = Math.max(0, Number(flags["backlog-pause-at"] ?? process.env.PIPELINE_BACKLOG_PAUSE ?? "500") || 500);

// Token discovery: auto-feed trending Solana mints into the scan queue so detection
// isn't limited to the static watchlist. Capped hard so the worker isn't overloaded —
// it processes EVERY active scope each round, so total scopes must stay bounded.
const discoveryEnabled = String(flags["discovery"] ?? process.env.DISCOVERY_ENABLED ?? "1").trim() !== "0";
const maxActiveScopes = Math.min(40, Math.max(2, Number(process.env.MAX_ACTIVE_SCOPES ?? 10) || 10));
const discoveryPerCycle = Math.min(10, Math.max(1, Number(process.env.DISCOVERY_PER_CYCLE ?? 3) || 3));
const discoveryEveryRounds = Math.max(1, Number(process.env.DISCOVERY_EVERY_ROUNDS ?? 4) || 4);

const BASELINE_INTERVAL_MS = 86_400_000;
const baselineStampPath = resolve(process.cwd(), "data/.pipeline-baseline-last");

function shouldRunDailyBaseline() {
  if (process.env.PIPELINE_BASELINE_DAILY !== "1") return false;
  try {
    const t = Number(readFileSync(baselineStampPath, "utf8").trim());
    if (Number.isFinite(t) && Date.now() - t < BASELINE_INTERVAL_MS) return false;
  } catch {
    /* first run */
  }
  return true;
}

function markDailyBaselineRun() {
  try {
    mkdirSync(dirname(baselineStampPath), { recursive: true });
    writeFileSync(baselineStampPath, String(Date.now()), "utf8");
  } catch (e) {
    console.error("[pipeline] baseline stamp", e);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const staticScopes = loadWatchlist();
  let scopes = [...staticScopes];
  if (scopes.length === 0) {
    console.error(`
No watchlist scopes found.

  • Copy config/watchlist.example.json → config/watchlist.json and add base58 addresses, or
  • Set CHAINMIND_WATCHLIST=/path/to.json, or
  • Set CHAINMIND_SCOPE / TARGET_ADDRESS for a single scope.

See docs/strategic-plan-data-pipeline.md (Phase 1).
`);
    process.exit(1);
  }

  const db = openDb();
  const connection = getSolanaConnection();

  console.log("ChainMind pipeline worker");
  console.log("---------------------------");
  console.log("Scopes        :", scopes.length);
  console.log("Mode          :", once ? "single round (--once)" : `repeat every ${roundIntervalMs}ms`);
  console.log("Head catch-up : max", headMax, "new sigs / scope / round, page", headPage);
  console.log("Parse         : up to", ingestLimit, "txs / scope / round, throttle", ingestThrottleMs, "ms");
  console.log("Backlog guard :", backlogPauseAt > 0 ? `pause head-poll at ${backlogPauseAt} unparsed (parse-first)` : "off");
  console.log("Turso sync    :", tursoSync ? "yes (end of each round)" : "no (pass --turso-sync)");
  console.log(
    "Daily baseline:",
    process.env.PIPELINE_BASELINE_DAILY === "1"
      ? "yes (baseline:update --force, at most once / 24h)"
      : "no (set PIPELINE_BASELINE_DAILY=1)",
  );
  console.log("");

  let round = 0;
  do {
    round++;
    console.log(`=== Round ${round} @ ${new Date().toISOString()} ===`);

    // Discover trending mints periodically and enqueue them — only while there's room
    // under the active-scope cap, so we never flood the worker.
    if (discoveryEnabled && scopes.length < maxActiveScopes && (round === 1 || round % discoveryEveryRounds === 0)) {
      try {
        const found = await discoverTrendingSolanaMints(discoveryPerCycle);
        let added = 0;
        for (const mint of found) {
          if (scopes.find((s) => s.address === mint)) continue;
          await tursoHttpAddToScanQueue(mint, "discovered:dexscreener");
          added++;
        }
        if (added) console.log(`~ discovery: enqueued ${added} trending mints`);
      } catch (e) {
        console.error("[discovery] failed:", e.message);
      }
    }

    // Merge new addresses from scan queue, capped at maxActiveScopes (the worker
    // processes every scope each round, so total must stay bounded).
    try {
      const queued = await tursoHttpFetchPendingScanQueue(20);
      for (const q of queued) {
        if (scopes.length >= maxActiveScopes) break;
        if (isKnownEntity(q.address)) {
          await tursoHttpMarkScanQueuePicked(q.address); // retire stablecoins/infra from the queue
          continue;
        }
        if (!scopes.find((s) => s.address === q.address)) {
          scopes.push({ address: q.address, note: q.note ?? "from scan queue" });
          await tursoHttpMarkScanQueuePicked(q.address);
          console.log(`+ queue: ${q.address}`);
        }
      }
    } catch (e) {
      console.error("[queue] fetch failed:", e.message);
    }

    for (const s of scopes) {
      const label = s.note ? `${s.address} — ${s.note}` : s.address;

      // Never spend RPC budget on allowlisted infra/stablecoins (SOL/USDC/…) — they're
      // excluded from detection anyway, and they're what bloated the backlog historically.
      if (isKnownEntity(s.address)) {
        console.log(`— ${label} (known entity — skipped)`);
        continue;
      }

      // Parse-first when behind: if the unparsed backlog is large, skip discovery this
      // round and put the whole RPC budget into draining it.
      const backlog = countPendingForScope(db, s.address);
      const behind = backlogPauseAt > 0 && backlog >= backlogPauseAt;
      console.log(`— ${label}  [backlog ${backlog}${behind ? " — parse-first, head-poll paused" : ""}]`);

      try {
        if (!behind) {
          const head = await syncHeadSignaturesForScope(connection, db, s.address, {
            maxNew: headMax,
            pageSize: headPage,
          });
          console.log(`    signatures +${head.inserted} (stop: ${head.stopReason}, pages: ${head.pages})`);
        }

        const ing = await ingestPendingEventsForScope(connection, db, s.address, {
          limit: ingestLimit,
          throttleMs: ingestThrottleMs,
        });
        console.log(`    events parsed ${ing.parsed} (backlog ${Math.max(0, backlog - ing.parsed)} left)`);
      } catch (e) {
        console.error(`    error: ${String(e?.message ?? e)}`);
      }

      if (scopeDelayMs > 0) await sleep(scopeDelayMs);
    }

    if (tursoSync) {
      try {
        execSync("node scripts/sync-sqlite-to-turso.mjs", { stdio: "inherit", cwd: process.cwd() });
      } catch {
        console.error("Turso sync failed (see log above). Continuing.");
      }
    }

    if (shouldRunDailyBaseline()) {
      try {
        console.log("— [daily] baseline:update --force (watchlist)");
        execSync("node scripts/baseline-update.mjs --force", { stdio: "inherit", cwd: process.cwd() });
        markDailyBaselineRun();
      } catch {
        console.error("baseline:update failed (see log above). Continuing.");
      }
    }

    if (once) break;

    console.log(`Sleep ${roundIntervalMs}ms until next round…\n`);
    await sleep(roundIntervalMs);
  } while (true);

  db.close();
  console.log("Pipeline worker stopped.");
}

await main();
