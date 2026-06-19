import { PublicKey } from "@solana/web3.js";
import { parsedToEventRow } from "./parse-tx.js";
import { extractTxGraph } from "./parse-tx-graph.js";
import { computeCoactivityScoreFromRows } from "./score-math.js";
import { summarizeFundingGraphFromEdges } from "./funding-graph-summary.js";
import { runAiDetectors } from "./ai-detectors.js";
import { computeZScores } from "./zscore-engine.js";

const FUNDING_EDGE_TYPES = new Set(["token_transfer", "mint_to", "native_transfer"]);

/**
 * Score a scope LIVE from RPC, in-memory — for a cold search (no DB rows yet), so a
 * public "paste an address" returns a real answer in seconds instead of "wait a minute".
 * Output mirrors buildTursoScoreBundle so the dashboard/route render it identically.
 *
 * @param {import("@solana/web3.js").Connection} connection
 * @param {string} scope
 * @param {{ windowMinutes?: number, lastHours?: number, maxSigs?: number }} [opts]
 */
export async function scoreFromRpc(connection, scope, opts = {}) {
  const windowMinutes = Math.min(1440, Math.max(1, Number(opts.windowMinutes) || 60));
  const lastHours = Math.min(24 * 30, Math.max(1, Number(opts.lastHours) || 24));
  const maxSigs = Math.min(1000, Math.max(50, Number(opts.maxSigs) || 300));
  const cutoff = Math.floor(Date.now() / 1000) - lastHours * 3600;

  const empty = (msg) => ({
    ok: true, empty: true, scope, address: scope, windowMinutes, lastHours,
    database: "rpc_live", live: true, message: msg,
    fundingGraph: { status: "skipped", reason: "rpc_live_no_events" }, transferEdgesSample: [],
  });

  let pk;
  try { pk = new PublicKey(scope); } catch { return empty("Invalid address."); }

  const sigInfos = await connection.getSignaturesForAddress(pk, { limit: maxSigs });
  const sigs = sigInfos.filter((s) => s.blockTime == null || s.blockTime >= cutoff).map((s) => s.signature);
  if (sigs.length === 0) return empty("No recent transactions for this address in the lookback window.");

  /** @type {any[]} */ const eventRows = [];
  /** @type {any[]} */ const transfers = [];
  /** @type {any[]} */ const edges = [];
  for (let i = 0; i < sigs.length; i += 50) {
    const parsedList = await connection
      .getParsedTransactions(sigs.slice(i, i + 50), { maxSupportedTransactionVersion: 0 })
      .catch(() => []);
    for (const p of parsedList) {
      const bt = p?.blockTime;
      if (!p || bt == null || bt < cutoff) continue;
      const ev = parsedToEventRow(p);
      eventRows.push({ ...ev, block_time: bt, slot: p.slot ?? null });
      const g = extractTxGraph(p, p.slot ?? null);
      for (const t of g.transfers) transfers.push({ from: t.from_address, to: t.to_address, mint: t.mint, amount: t.amount, block_time: bt });
      for (const e of g.edges) edges.push({ from: e.from_address, to: e.to_address, edge_type: e.edge_type, mint: e.mint, block_time: bt });
    }
  }

  const result = computeCoactivityScoreFromRows(eventRows, scope, windowMinutes, lastHours);
  if (!result.ok || result.empty) return { ...result, database: "rpc_live", live: true };

  const payers = (result.walletGraph?.nodes ?? [])
    .filter((n) => n.kind === "wallet").slice(0, 12).map((n) => n.id).filter(Boolean);
  const fundingRows = edges
    .filter((e) => FUNDING_EDGE_TYPES.has(e.edge_type))
    .map((e) => ({ recipient: e.to, funder: e.from, edge_type: e.edge_type }));
  const fundingGraph = payers.length
    ? summarizeFundingGraphFromEdges(payers, fundingRows)
    : { status: "skipped", reason: "no_payers" };

  const zScores = computeZScores(Array.isArray(result.timelineBuckets) ? result.timelineBuckets : [], null);

  let aiDetection = null;
  try {
    aiDetection = runAiDetectors({
      scope, eventRows, scoreResult: result, fundingGraph, transfers, peerEdges: [],
      walletLedgerAge: null, storedBaseline: null,
    });
  } catch { aiDetection = null; }

  const transferEdgesSample = transfers.slice(0, 24).map((t) => ({
    kind: "transfer", from: t.from, to: t.to, mint: t.mint ?? null, amount: t.amount, block_time: t.block_time,
  }));

  return {
    ...result,
    zScores,
    fundingGraph,
    database: "rpc_live",
    live: true,
    transferEdgesSample,
    ...(aiDetection ? { aiDetection } : {}),
    scope,
    address: scope,
  };
}
