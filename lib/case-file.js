import { deriveRiskProfile } from "./risk-profile.js";
import { NATIVE_SOL_TRANSFER } from "./programs.js";

/**
 * @param {Record<string, unknown>} bundle — buildTursoScoreBundle output (no _caseInternal)
 * @param {Awaited<ReturnType<import("./funding-tree-turso.js").expandFundingTreeInbound>>} fundingTree
 * @param {{
 *   caseId: string,
 *   createdAtIso: string,
 *   scope: string,
 *   windowMinutes: number,
 *   lastHours: number,
 *   groqAnalysis?: Record<string, unknown> | null,
 *   title?: string | null,
 * }} meta
 */
export function buildInvestigationCasePayload(bundle, fundingTree, meta) {
  const risk = deriveRiskProfile(bundle);

  /** @type {{ detector: string, triggered: boolean, severity: string, summary: string }[]} */
  const detectorFlags = [];
  const ad = bundle.aiDetection && typeof bundle.aiDetection === "object" ? bundle.aiDetection : null;
  const detectors = ad && typeof ad.detectors === "object" ? ad.detectors : null;
  if (detectors) {
    for (const [name, d] of Object.entries(detectors)) {
      if (!d || typeof d !== "object") continue;
      detectorFlags.push({
        detector: name,
        triggered: Boolean(d.triggered),
        severity: String(d.severity ?? "none"),
        summary: String(d.summary ?? ""),
      });
    }
  }

  const composite =
    ad && typeof ad.composite === "object" && ad.composite != null && "score0_100" in ad.composite
      ? Number(ad.composite.score0_100)
      : null;

  /** @type {{ address: string, compositeScore0_100: number | null, rank: number, feePayerEventsInLookback: number }[]} */
  const flaggedWallets = [];
  const top = Array.isArray(bundle.topPayerLinks) ? bundle.topPayerLinks : [];
  top.slice(0, 18).forEach((row, i) => {
    if (!row?.payer) return;
    flaggedWallets.push({
      address: String(row.payer),
      rank: i + 1,
      feePayerEventsInLookback: Number(row.events) || 0,
      compositeScore0_100: Number.isFinite(composite) ? composite : null,
    });
  });

  const internalRaw = Object.getOwnPropertyDescriptor(bundle, "_caseInternal")?.value;
  const transfers = Array.isArray(internalRaw?.transfers) ? internalRaw.transfers : [];
  const peerEdges = Array.isArray(internalRaw?.peerEdges) ? internalRaw.peerEdges : [];

  /** @type {Record<string, unknown>[]} */
  const evidenceRows = [];

  const treeEdges = Array.isArray(fundingTree.edges) ? fundingTree.edges : [];
  for (const e of treeEdges.slice(0, 220)) {
    evidenceRows.push({
      kind: "funding_edge",
      slot: e.slot ?? null,
      block_time: e.block_time ?? null,
      action: e.edge_type,
      from: e.from,
      to: e.to,
      mint: null,
      amount: null,
      tx_sig: e.tx_sig,
      hopDepth: e.hopDepth,
    });
  }

  for (const t of transfers.slice(0, 180)) {
    evidenceRows.push({
      kind: "token_transfer",
      slot: null,
      block_time: t.block_time ?? null,
      action: "transfer",
      from: t.from,
      to: t.to,
      mint: t.mint ?? null,
      amount: t.amount ?? null,
      amountNote:
        String(t.mint ?? "") === NATIVE_SOL_TRANSFER ? "lamports (native_sol sentinel)" : "raw integer string",
      tx_sig: null,
      hopDepth: null,
    });
  }

  /** @type {{ id: string, kind: string, label?: string }[]} */
  const graphNodes = [];
  graphNodes.push({ id: meta.scope, kind: "scope", label: "investigation_scope" });
  const treeNodes = Array.isArray(fundingTree.nodes) ? fundingTree.nodes : [];
  for (const n of treeNodes) {
    graphNodes.push({
      id: n.address,
      kind: "wallet",
      label: n.role,
      depth: n.depth,
    });
  }

  /** @type {{ source: string, target: string, type: string, tx_sig?: string, hopDepth?: number }[]} */
  const graphEdges = [];
  if (Array.isArray(bundle.walletGraph?.links)) {
    for (const l of bundle.walletGraph.links) {
      graphEdges.push({
        source: String(l.source ?? ""),
        target: String(l.target ?? ""),
        type: "scope_fee_payer",
        hopDepth: 0,
      });
    }
  }
  for (const e of peerEdges.slice(0, 150)) {
    graphEdges.push({
      source: e.from,
      target: e.to,
      type: `peer:${e.edge_type}`,
      mint: e.mint ?? null,
      block_time: e.block_time,
    });
  }
  for (const e of treeEdges.slice(0, 400)) {
    graphEdges.push({
      source: e.from,
      target: e.to,
      type: e.edge_type,
      tx_sig: e.tx_sig,
      hopDepth: e.hopDepth,
    });
  }

  return {
    schemaVersion: 1,
    caseId: meta.caseId,
    title: meta.title ?? `Investigation ${meta.scope.slice(0, 8)}…`,
    createdAt: meta.createdAtIso,
    scopeAddress: meta.scope,
    params: {
      windowMinutes: meta.windowMinutes,
      lastHours: meta.lastHours,
    },
    riskProfile: risk,
    scoreSnapshot: stripBundleForCase(bundle),
    fundingTree,
    flaggedWallets,
    detectorFlags,
    evidenceRows,
    graphSnapshot: {
      nodeCount: graphNodes.length,
      edgeCount: graphEdges.length,
      nodes: graphNodes.slice(0, 200),
      edges: graphEdges.slice(0, 500),
    },
    groqAnalysis: meta.groqAnalysis ?? null,
    chainMindNote:
      "Frozen snapshot: scores reflect Turso rows at case creation time. Re-run live /api/score for updates.",
  };
}

/**
 * Remove non-JSON-safe or huge fields from bundle before embedding.
 * @param {Record<string, unknown>} bundle
 */
function stripBundleForCase(bundle) {
  /** @type {Record<string, unknown>} */
  const o = { ...bundle };
  delete o._caseInternal;
  if (o.walletGraph && typeof o.walletGraph === "object") {
    const wg = /** @type {Record<string, unknown>} */ (o.walletGraph);
    const nodes = Array.isArray(wg.nodes) ? wg.nodes.slice(0, 48) : wg.nodes;
    o.walletGraph = { ...wg, nodes };
  }
  return o;
}
