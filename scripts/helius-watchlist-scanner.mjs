/**
 * Rolling token watchlist scanner (~60s loop by default).
 *
 * - Poll DexScreener for per-mint m5 / h24 volume + short price change (Helius DAS has no top-mover list).
 * - Poll Helius DAS getAsset for USD price when HELIUS_API_KEY or Helius SOLANA_RPC_URL is set.
 * - When thresholds trip: run syncHeadSignaturesForScope + ingest for the mint, then for largest token-holder wallets.
 *
 * Requires local SQLite (same as pipeline-worker) — run on a laptop/VPS, not Vercel serverless.
 *
 * Usage:
 *   npm run helius-scan
 *   npm run helius-scan -- --once
 *
 * Env: see .env.example (CHAINMIND_HELIUS_SCAN_MINTS_JSON, HELIUS_*, HELIUS_SCAN_*).
 */

import { loadEnv } from "../lib/load-env.js";

loadEnv();

import { openDb } from "../lib/db.js";
import { getSolanaConnection } from "../lib/solana.js";
import { runHeliusWatchlistScanRound } from "../lib/helius-watchlist-scan-round.js";

const intervalMs = Math.max(5000, Number(process.env.HELIUS_SCAN_INTERVAL_MS ?? 60_000) || 60_000);
const once = process.argv.includes("--once");

async function main() {
  const db = openDb();
  const connection = getSolanaConnection();
  try {
    do {
      const t0 = Date.now();
      try {
        const report = await runHeliusWatchlistScanRound({ connection, db });
        console.log(JSON.stringify({ ...report, durationMs: Date.now() - t0 }, null, 2));
      } catch (e) {
        console.error("[helius-scan] round error:", e?.message ?? e);
      }
      if (once) break;
      await new Promise((r) => setTimeout(r, intervalMs));
    } while (true);
  } finally {
    db.close();
  }
}

await main();
