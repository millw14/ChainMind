import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { fetchDexscreenerMintSnapshot } from "./dexscreener-token.js";
import { dasGetFungiblePriceUsd, getHeliusJsonRpcUrl } from "./helius-das.js";
import { readScanBaseline, writeScanBaseline } from "./helius-scan-baseline.js";
import { loadHeliusScanMints } from "./helius-scan-mints.js";
import { ingestPendingEventsForScope, syncHeadSignaturesForScope } from "./pipeline-sync.js";

/**
 * @param {import("@solana/web3.js").Connection} connection
 * @param {string} mint base58
 * @param {number} topN
 * @returns {Promise<string[]>} owner wallet pubkeys
 */
export async function extractTopTokenOwners(connection, mint, topN) {
  const mintPk = new PublicKey(mint);
  const res = await connection.getTokenLargestAccounts(mintPk);
  const slice = res.value.slice(0, Math.max(1, topN));
  /** @type {string[]} */
  const owners = [];
  for (const row of slice) {
    try {
      const pk = new PublicKey(row.address);
      const info = await connection.getParsedAccountInfo(pk);
      const data = info.value?.data;
      if (data && typeof data === "object" && "parsed" in data) {
        const owner = data.parsed?.info?.owner;
        if (typeof owner === "string") owners.push(owner);
      }
    } catch {
      /* skip */
    }
  }
  return [...new Set(owners)];
}

/**
 * @param {{
 *   prev: { h24Vol: number, priceUsd: number | null, updatedAt: string } | undefined,
 *   snap: { volumeM5: number, volumeH24: number, priceUsd: number | null, priceChangeM5: number | null },
 *   volMult: number,
 *   priceDeltaPct: number,
 *   dsM5AbsPct: number | null,
 *   minM5Usd: number,
 * }} p
 */
export function evaluateMomentum(p) {
  /** @type {string[]} */
  const reasons = [];
  if (p.minM5Usd > 0 && p.snap.volumeM5 >= p.minM5Usd) {
    reasons.push(`m5_usd>=${p.minM5Usd}`);
  }
  if (!p.prev) return { triggered: reasons.length > 0, reasons };

  const expectedM5 = p.snap.volumeH24 > 0 ? p.snap.volumeH24 / 288 : 0;
  if (expectedM5 > 0 && p.snap.volumeM5 >= expectedM5 * p.volMult) {
    reasons.push(`m5_vol>=${p.volMult}x flat_h24/288`);
  }
  const price = p.snap.priceUsd;
  if (p.prev.priceUsd != null && p.prev.priceUsd > 0 && price != null && price > 0) {
    if (Math.abs(price - p.prev.priceUsd) / p.prev.priceUsd >= p.priceDeltaPct) {
      reasons.push(`price_delta>=${(p.priceDeltaPct * 100).toFixed(1)}%_vs_baseline`);
    }
  }
  if (
    p.dsM5AbsPct != null &&
    p.snap.priceChangeM5 != null &&
    Math.abs(p.snap.priceChangeM5) >= p.dsM5AbsPct
  ) {
    reasons.push(`dex_abs_m5_pct>=${p.dsM5AbsPct}`);
  }
  return { triggered: reasons.length > 0, reasons };
}

/**
 * One poll across all configured mints: DexScreener momentum + Helius DAS price,
 * optional pipeline sync for mint + largest holders when thresholds hit.
 *
 * Run on a VPS or laptop (uses local SQLite — not compatible with Vercel serverless).
 *
 * @param {{
 *   connection: import("@solana/web3.js").Connection,
 *   db: import("better-sqlite3").Database,
 *   env?: NodeJS.ProcessEnv,
 * }} opts
 */
export async function runHeliusWatchlistScanRound(opts) {
  const env = opts.env ?? process.env;
  const mints = loadHeliusScanMints(env);
  if (mints.length === 0) {
    return {
      ok: false,
      error:
        "No mints — set CHAINMIND_HELIUS_SCAN_MINTS_JSON e.g. [\"mint1\",\"mint2\"] or {\"mints\":[\"...\"]}",
      results: [],
    };
  }

  const volMult = Math.max(1.1, Number(env.HELIUS_SCAN_VOLUME_SPIKE_MULT ?? 3) || 3);
  const priceDeltaPct = Math.min(1, Math.max(0.001, Number(env.HELIUS_SCAN_PRICE_DELTA_PCT ?? 0.08) || 0.08));
  const dsM5Raw = env.HELIUS_SCAN_DS_M5_ABS_PCT?.trim();
  const dsM5AbsPct = dsM5Raw === "" || dsM5Raw === undefined ? 8 : Number(dsM5Raw);
  const dsM5AbsPctUse = Number.isFinite(dsM5AbsPct) ? dsM5AbsPct : 8;
  const minM5Usd = Math.max(0, Number(env.HELIUS_SCAN_MIN_M5_USD ?? 0) || 0);

  const topHolders = Math.min(30, Math.max(1, Number(env.HELIUS_SCAN_TOP_HOLDERS ?? 8) || 8));
  const headMaxMint = Math.min(5000, Math.max(50, Number(env.HELIUS_SCAN_MINT_HEAD_MAX ?? 500) || 500));
  const headMaxWallet = Math.min(3000, Math.max(20, Number(env.HELIUS_SCAN_WALLET_HEAD_MAX ?? 120) || 120));
  const ingestLimit = Math.min(200, Math.max(5, Number(env.HELIUS_SCAN_INGEST_LIMIT ?? 25) || 25));
  const ingestThrottleMs = Math.max(0, Number(env.HELIUS_SCAN_INGEST_THROTTLE_MS ?? 700) || 700);
  const dexMs = Math.max(200, Number(env.HELIUS_SCAN_DEXSCREENER_GAP_MS ?? 1100) || 1100);

  const heliusUrl = getHeliusJsonRpcUrl(env);
  const baselines = readScanBaseline();

  /** @type {Array<Record<string, unknown>>} */
  const results = [];

  for (let i = 0; i < mints.length; i++) {
    const mint = mints[i];
    if (i > 0) await new Promise((r) => setTimeout(r, dexMs));

    const ds = await fetchDexscreenerMintSnapshot(mint);
    let priceUsd = ds?.priceUsd ?? null;
    let helSym;
    if (heliusUrl) {
      const h = await dasGetFungiblePriceUsd(heliusUrl, mint);
      if (h.priceUsd != null) priceUsd = h.priceUsd;
      helSym = h.symbol;
    }

    const snap = {
      volumeM5: ds?.volumeM5 ?? 0,
      volumeH24: ds?.volumeH24 ?? 0,
      priceUsd,
      priceChangeM5: ds?.priceChangeM5 ?? null,
    };

    const prev = baselines[mint];
    const { triggered, reasons } = evaluateMomentum({
      prev,
      snap,
      volMult,
      priceDeltaPct,
      dsM5AbsPct: dsM5AbsPctUse,
      minM5Usd,
    });

    baselines[mint] = {
      h24Vol: snap.volumeH24,
      priceUsd: snap.priceUsd,
      updatedAt: new Date().toISOString(),
    };

    /** @type {Record<string, unknown>} */
    const row = { mint, triggered, reasons, snap, symbol: helSym ?? null, pairUrl: ds?.pairUrl ?? null };
    results.push(row);

    if (!triggered) continue;

    const owners = await extractTopTokenOwners(opts.connection, mint, topHolders);
    row.topOwners = owners;

    const head = await syncHeadSignaturesForScope(opts.connection, opts.db, mint, { maxNew: headMaxMint, pageSize: 80 });
    const ing = await ingestPendingEventsForScope(opts.connection, opts.db, mint, {
      limit: ingestLimit,
      throttleMs: ingestThrottleMs,
    });
    row.mintPipeline = { inserted: head.inserted, parsed: ing.parsed };

    /** @type {Array<{ address: string, inserted: number, parsed: number }>} */
    const walletRuns = [];
    for (const w of owners) {
      const h2 = await syncHeadSignaturesForScope(opts.connection, opts.db, w, {
        maxNew: headMaxWallet,
        pageSize: 60,
      });
      const ing2 = await ingestPendingEventsForScope(opts.connection, opts.db, w, {
        limit: ingestLimit,
        throttleMs: ingestThrottleMs,
      });
      walletRuns.push({ address: w, inserted: h2.inserted, parsed: ing2.parsed });
    }
    row.walletPipelines = walletRuns;

    const qPath = resolve(process.cwd(), env.HELIUS_SCAN_QUEUE_PATH?.trim() || "data/helius-investigation-queue.jsonl");
    mkdirSync(dirname(qPath), { recursive: true });
    appendFileSync(
      qPath,
      `${JSON.stringify({
        at: new Date().toISOString(),
        mint,
        reasons,
        owners,
        pairUrl: ds?.pairUrl,
      })}\n`,
      "utf8",
    );
    row.queued = qPath;
  }

  writeScanBaseline(baselines);

  return { ok: true, mints: mints.length, results };
}
