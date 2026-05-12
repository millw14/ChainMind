#!/usr/bin/env node
/**
 * Incremental watcher: poll signatures → ingest → detectors → webhook when confidence clears threshold.
 *
 * Usage:
 *   npm run watch -- <token_or_wallet> [options]
 *
 * Env:
 *   CHAINMIND_ALERT_WEBHOOK_URL    Discord / Slack / generic HTTPS endpoint
 *   CHAINMIND_ALERT_WEBHOOK_KIND   auto | generic | discord | slack
 *   CHAINMIND_ALERT_CONFIDENCE_MIN default 0.72
 *   CHAINMIND_WATCH_INTERVAL_MS    default 30000 (floor with slot polls)
 *   CHAINMIND_ALERT_COOLDOWN_MS    default 900000 (per flag dedupe baseline)
 */

import { loadEnv } from "../lib/load-env.js";

loadEnv();

import { openDb } from "../lib/db.js";
import { getSolanaConnection } from "../lib/solana.js";
import { syncHeadSignaturesForScope, ingestPendingEventsForScope } from "../lib/pipeline-sync.js";
import {
  buildAdjacencyFromEdges,
  inferWatchContext,
  runAllDetectors,
  toAlertPayload,
  sendAlert,
  shouldEmit,
  recordEmitted,
} from "../lib/alerts.js";

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {string[]} */
  const positional = [];
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  for (const a of argv) {
    if (a.startsWith("--")) {
      const raw = a.slice(2);
      const eq = raw.indexOf("=");
      if (eq === -1) flags[raw] = true;
      else flags[raw.slice(0, eq)] = raw.slice(eq + 1);
    } else positional.push(a);
  }
  return { positional, flags };
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Wake early when the chain advances before intervalMs elapses.
 * @param {import("@solana/web3.js").Connection} connection
 * @param {number} lastSlot
 * @param {number} intervalMs
 * @param {number} slotPollMs
 */
async function waitNextCycle(connection, lastSlot, intervalMs, slotPollMs) {
  const deadline = Date.now() + intervalMs;
  while (Date.now() < deadline) {
    const s = await connection.getSlot("confirmed");
    if (s > lastSlot) return { slot: s, reason: "slot" };
    await sleep(Math.min(slotPollMs, Math.max(50, deadline - Date.now())));
  }
  const s = await connection.getSlot("confirmed");
  return { slot: s, reason: "interval" };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const scope = positional[0]?.trim();
  if (!scope) {
    console.error(`
Usage:
  npm run watch -- <token_or_wallet> [options]

Options:
  --webhook-url=<url>           Overrides CHAINMIND_ALERT_WEBHOOK_URL
  --webhook-kind=auto|discord|slack|generic
  --threshold=<0..1>          Min detector confidence to notify (default env or 0.72)
  --interval-ms=<n>           Max wall time between polls (default 30000)
  --slot-poll-ms=<n>          How often to poll getSlot inside interval (default 4000)
  --cooldown-ms=<n>           Min spacing per flag unless confidence/evidence jumps (default 900000)
  --confidence-delta=<n>      Retrigger early if confidence jumps by this delta (default 0.09)
  --detect-always             Run detectors even when nothing parsed this cycle
  --once                      Single poll cycle then exit
  --head-max=<n>              Passed to signature sync (default 400)
  --head-page=<n>
  --ingest-limit=<n>
  --ingest-throttle-ms=<n>

Without a webhook URL, alerts print JSON to stdout (still respects threshold + throttle).
`);
    process.exit(1);
  }

  const webhookUrl = String(flags["webhook-url"] ?? flags.webhook ?? process.env.CHAINMIND_ALERT_WEBHOOK_URL ?? "").trim();
  const webhookKind = String(flags["webhook-kind"] ?? process.env.CHAINMIND_ALERT_WEBHOOK_KIND ?? "auto");

  const threshold = Math.min(
    1,
    Math.max(0, Number(flags.threshold ?? process.env.CHAINMIND_ALERT_CONFIDENCE_MIN ?? "0.72") || 0.72),
  );
  const intervalMs = Math.max(5000, Number(flags["interval-ms"] ?? process.env.CHAINMIND_WATCH_INTERVAL_MS ?? "30000") || 30_000);
  const slotPollMs = Math.max(400, Number(flags["slot-poll-ms"] ?? "4000") || 4000);
  const cooldownMs = Math.max(
    30_000,
    Number(flags["cooldown-ms"] ?? process.env.CHAINMIND_ALERT_COOLDOWN_MS ?? "900000") || 900_000,
  );
  const confidenceDelta = Number(flags["confidence-delta"] ?? "0.09") || 0.09;

  const once = flags.once === true;
  const detectAlways = flags["detect-always"] === true;

  const headMax = Math.min(5000, Math.max(5, Number(flags["head-max"] ?? "400") || 400));
  const headPage = Math.min(150, Math.max(10, Number(flags["head-page"] ?? "80") || 80));
  const ingestLimit = Math.min(500, Math.max(1, Number(flags["ingest-limit"] ?? process.env.INGEST_PARSE_LIMIT ?? "35") || 35));
  const ingestThrottleMs = Math.max(0, Number(flags["ingest-throttle-ms"] ?? process.env.INGEST_THROTTLE_MS ?? "900") || 900);

  const db = openDb();
  const connection = getSolanaConnection();

  /** @type {Map<string, { lastSentAt: number, lastConfidence: number, lastHash: string }>} */
  const throttle = new Map();

  let lastSlot = await connection.getSlot("confirmed");
  let cycle = 0;

  console.log("ChainMind watch");
  console.log("---------------");
  console.log("Scope           :", scope);
  console.log("Webhook         :", webhookUrl ? webhookUrl.slice(0, 64) + (webhookUrl.length > 64 ? "…" : "") : "(stdout only)");
  console.log("Threshold       :", threshold);
  console.log("Interval / poll :", intervalMs + "ms / " + slotPollMs + "ms");
  console.log("Detectors       :", detectAlways ? "every cycle" : "after new parsed txs");
  console.log("Mode            :", once ? "single cycle" : "continuous (Ctrl+C to stop)");
  console.log("");

  const stopping = async () => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", stopping);
  process.on("SIGTERM", stopping);

  try {
    do {
      cycle++;
      const cycleStart = Date.now();
      console.log(`=== Cycle ${cycle} @ ${new Date().toISOString()} (slot ${lastSlot}) ===`);

      const head = await syncHeadSignaturesForScope(connection, db, scope, {
        maxNew: headMax,
        pageSize: headPage,
      });
      const ing = await ingestPendingEventsForScope(connection, db, scope, {
        limit: ingestLimit,
        throttleMs: ingestThrottleMs,
      });
      console.log(`    signatures +${head.inserted} (${head.stopReason}) · parsed ${ing.parsed}`);

      if (detectAlways || ing.parsed > 0) {
        const graph = buildAdjacencyFromEdges(db, { scopeAddress: scope });
        const ctx = inferWatchContext(db, scope);
        console.log(
          `    infer: mode=${ctx.mode} mintHint=${ctx.mintHint ? ctx.mintHint.slice(0, 12) + "…" : "—"} focal=${ctx.focalWallet.slice(0, 12)}…`,
        );

        const results = runAllDetectors(db, graph, scope, ctx);

        /** @type {import("../lib/detectors/shared.js").DetectorResult[]} */
        const fired = [];
        for (const r of results) {
          if (r.confidence < threshold) continue;
          if (!shouldEmit(throttle, scope, r, cooldownMs, confidenceDelta)) continue;

          const payload = toAlertPayload(r, scope);
          fired.push(r);

          if (!webhookUrl) {
            console.log("ALERT:", JSON.stringify(payload));
          } else {
            const kindArg =
              webhookKind === "generic" || webhookKind === "discord" || webhookKind === "slack"
                ? webhookKind
                : "auto";
            await sendAlert(webhookUrl, payload, kindArg);
            console.log(`    webhook OK · ${r.flag} (${r.confidence.toFixed(3)})`);
          }
          recordEmitted(throttle, scope, r);
        }

        if (fired.length === 0) {
          const near = results.filter((x) => x.confidence >= threshold * 0.85).sort((a, b) => b.confidence - a.confidence);
          if (near[0]) {
            console.log(`    top below threshold: ${near[0].flag} ${near[0].confidence.toFixed(3)}`);
          }
        }
      } else if (head.inserted > 0) {
        console.log("    queued signatures pending parse — detectors deferred until ingest catches up");
      }

      console.log(`    cycle wall ${Date.now() - cycleStart}ms`);

      if (once) break;

      const tick = await waitNextCycle(connection, lastSlot, intervalMs, slotPollMs);
      lastSlot = tick.slot;
      console.log(`    wait (${tick.reason}) next anchor slot=${tick.slot}\n`);
    } while (true);
  } finally {
    db.close();
  }

  console.log("Watch stopped.");
}

await main();
