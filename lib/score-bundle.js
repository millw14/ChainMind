import { baselineRowForZScores, fetchBaseline } from "./baseline-manager.js";
import { detectPrePositioning } from "./pre-position-detector.js";
import { runAiDetectors } from "./ai-detectors.js";
import { deriveRiskProfile } from "./risk-profile.js";
import { summarizeFundingGraphFromEdges } from "./funding-graph-summary.js";
import { computeCoactivityScoreFromRows } from "./score-math.js";
import { computeZScores } from "./zscore-engine.js";
import { getSolanaConnection } from "./solana.js";
import {
  tursoFetchInboundFundingEdges,
  tursoFetchPayerPeerEdges,
  tursoFetchScoreRows,
  tursoFetchTransfersWindow,
  tursoFetchWalletFirstSeenMany,
  tursoUpsertWalletFirstSeen,
} from "./turso.js";
import { fetchOldestSignatureForAddress } from "./wallet-age-rpc.js";
import { buildWalletLedgerAge } from "./wallet-ledger-age.js";

/**
 * Full Turso-backed score payload (same shape as GET /api/score success body).
 *
 * @param {import("@libsql/client").Client} client
 * @param {{ scope: string, windowMinutes: number, lastHours: number }} p
 * @param {{ includeCaseInternal?: boolean }} [opts]
 */
export async function buildTursoScoreBundle(client, p, opts = {}) {
  const { scope, windowMinutes, lastHours } = p;
  const cutoff = Math.floor(Date.now() / 1000) - lastHours * 3600;
  const rows = await tursoFetchScoreRows(client, scope, cutoff);
  const result = computeCoactivityScoreFromRows(rows, scope, windowMinutes, lastHours);

  let fundingGraph = { status: "skipped", reason: "empty_or_insufficient_events" };
  /** @type {{ from: string, to: string, mint: string | null, amount: string, block_time: number }[]} */
  let transfers = [];
  /** @type {{ from: string, to: string, edge_type: string, mint: string | null, block_time: number }[]} */
  let peerEdges = [];

  if (result.ok && !result.empty && Array.isArray(result.topPayerLinks) && result.topPayerLinks.length > 0) {
    const payers = result.topPayerLinks.slice(0, 8).map((x) => x.payer).filter(Boolean);
    if (payers.length > 0) {
      const edgeRows = await tursoFetchInboundFundingEdges(client, scope, payers, cutoff);
      fundingGraph = summarizeFundingGraphFromEdges(payers, edgeRows);
    }
    const peers = result.topPayerLinks.slice(0, 12).map((x) => x.payer).filter(Boolean);
    try {
      const [trows, prow] = await Promise.all([
        tursoFetchTransfersWindow(client, scope, cutoff, 2500),
        tursoFetchPayerPeerEdges(client, scope, peers, cutoff, 800),
      ]);
      transfers = trows;
      peerEdges = prow;
    } catch {
      transfers = [];
      peerEdges = [];
    }
  }

  /** @type {ReturnType<typeof buildWalletLedgerAge> | null} */
  let walletLedgerAge = null;
  try {
    if (result.ok && !result.empty && Array.isArray(result.topPayerLinks) && result.topPayerLinks.length > 0) {
      const payerAddrs = result.topPayerLinks.slice(0, 12).map((x) => x.payer).filter(Boolean);
      let dbRows = await tursoFetchWalletFirstSeenMany(client, payerAddrs);

      const lazy = process.env.CHAINMIND_FETCH_WALLET_AGE_ON_SCORE === "1";
      const maxLazy = Math.min(12, Math.max(0, Number(process.env.CHAINMIND_WALLET_AGE_MAX_FETCH ?? 3) || 3));
      const maxPages = Math.min(30, Math.max(1, Number(process.env.CHAINMIND_WALLET_AGE_MAX_PAGES ?? 5) || 5));

      if (lazy && maxLazy > 0 && process.env.SOLANA_RPC_URL?.trim()) {
        const have = new Set(dbRows.map((r) => r.address));
        const missing = payerAddrs.filter((a) => !have.has(a)).slice(0, maxLazy);
        if (missing.length) {
          let connection;
          try {
            connection = getSolanaConnection();
          } catch {
            connection = null;
          }
          if (connection) {
            for (const addr of missing) {
              try {
                const meta = await fetchOldestSignatureForAddress(connection, addr, { maxPages });
                if (!meta.signature) continue;
                await tursoUpsertWalletFirstSeen(client, {
                  address: addr,
                  first_signature: meta.signature,
                  first_slot: meta.slot,
                  first_block_time: meta.blockTime,
                  pages_walked: meta.pagesWalked,
                  capped: meta.capped ? 1 : 0,
                });
                dbRows = dbRows.filter((r) => r.address !== addr);
                dbRows.push({
                  address: addr,
                  first_signature: meta.signature,
                  first_slot: meta.slot,
                  first_block_time: meta.blockTime,
                  pages_walked: meta.pagesWalked,
                  capped: meta.capped ? 1 : 0,
                  updated_at: new Date().toISOString(),
                });
              } catch {
                /* RPC error */
              }
            }
          }
        }
      }

      walletLedgerAge = buildWalletLedgerAge(payerAddrs, dbRows);
    }
  } catch {
    walletLedgerAge = null;
  }

  let storedBaselineRow = null;
  try {
    storedBaselineRow = await fetchBaseline(client, scope, windowMinutes);
  } catch {
    storedBaselineRow = null;
  }

  const timelineBucketsForZ = Array.isArray(result.timelineBuckets) ? result.timelineBuckets : [];
  const zScores = computeZScores(timelineBucketsForZ, baselineRowForZScores(storedBaselineRow));

  let aiDetection = null;
  if (result.ok && !result.empty) {
    aiDetection = runAiDetectors({
      scope,
      eventRows: rows,
      scoreResult: result,
      fundingGraph,
      transfers,
      peerEdges,
      walletLedgerAge,
      storedBaseline: storedBaselineRow,
    });
    if (Array.isArray(result.drivers)) {
      const d = aiDetection.detectors;
      const fired = Object.values(d)
        .filter((x) => x?.triggered)
        .map((x) => x.name)
        .join(", ");
      result.drivers.push(
        `AI detection v2 composite ${aiDetection.composite.score0_100}/100` +
          (fired ? `; triggered: ${fired}` : "") +
          ` — see aiDetection JSON.`,
      );
    }
  }

  const risk = deriveRiskProfile({ ...result, ...(aiDetection ? { aiDetection } : {}) });
  const coActivityNorm =
    risk.score0_100 != null && Number.isFinite(Number(risk.score0_100))
      ? Math.min(1, Math.max(0, Number(risk.score0_100) / 100))
      : null;
  const prePosition = detectPrePositioning(zScores, timelineBucketsForZ, coActivityNorm);

  /** Capped for Groq evidence narrative + dashboard export (full rows stay internal to case builds). */
  const transferEdgesSample = [
    ...transfers.slice(0, 16).map((t) => ({
      kind: "transfer",
      from: t.from,
      to: t.to,
      mint: t.mint ?? null,
      amount: t.amount,
      block_time: t.block_time,
    })),
    ...peerEdges.slice(0, 16).map((e) => ({
      kind: "peer_edge",
      edge_type: e.edge_type,
      from: e.from,
      to: e.to,
      mint: e.mint ?? null,
      block_time: e.block_time,
    })),
  ].slice(0, 32);

  const bundle = {
    ...result,
    zScores,
    prePosition,
    fundingGraph,
    database: "turso",
    transferEdgesSample,
    ...(aiDetection ? { aiDetection } : {}),
    ...(walletLedgerAge ? { walletLedgerAge } : {}),
  };

  if (opts.includeCaseInternal) {
    Object.defineProperty(bundle, "_caseInternal", {
      enumerable: false,
      value: { cutoffUnix: cutoff, eventRows: rows, transfers, peerEdges },
    });
  }

  return bundle;
}
