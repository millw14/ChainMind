import { analyzePeerCommunities } from "./graph-communities.js";
import { NATIVE_SOL_TRANSFER } from "./programs.js";
import { buildTimelineBucketsFromRows } from "./score-math.js";

/** Event types treated as swap / SPL trade-like for burst Z-score (parser labels). */
const TRADE_LIKE_EVENT_TYPES = new Set(["swap_eligible", "spl"]);

/**
 * Named manipulation detectors + multi-signal scoring (pure — no I/O).
 * Outputs are structured for Groq / dashboards (not raw chain dumps).
 */

/**
 * @typedef {{ fee_payer: string, block_time: number }} EventRow
 * @typedef {{ from: string, to: string, mint: string | null, amount: string, block_time: number }} TransferRow
 * @typedef {{ from: string, to: string, edge_type: string, mint: string | null, block_time: number }} PeerEdgeRow
 * @typedef {{ status: string, sharedInboundFunders?: { funder: string, recipientCount: number, recipientPayers: string[] }[] }} FundingGraphLike
 */

/**
 * Chain-backed cohort youth: many fresh wallets among top payers → coordination risk signal.
 *
 * @param {ReturnType<import("./wallet-ledger-age.js").buildWalletLedgerAge> | null | undefined} w
 */
export function ledgerCohortYouthNorm01(w) {
  if (!w || typeof w !== "object") {
    return { norm01: 0, coverage01: 0, youngFrac: 0, medianAgeDays: null, note: "no_ledger" };
  }
  const examined = Number(w.payersExamined) || 0;
  const withData = Number(w.payersWithData) || 0;
  if (examined < 1 || withData < 2) {
    return {
      norm01: 0,
      coverage01: examined ? withData / examined : 0,
      youngFrac: 0,
      medianAgeDays: null,
      note: "insufficient_ledger_rows",
    };
  }
  const young = Number(w.youngWalletsUnder7d) || 0;
  const youngFrac = young / withData;

  /** @type {number[]} */
  const ages = [];
  for (const r of w.rows ?? []) {
    if (typeof r.ageDays === "number" && Number.isFinite(r.ageDays)) ages.push(r.ageDays);
  }
  ages.sort((a, b) => a - b);
  const med = ages.length ? ages[Math.floor((ages.length - 1) / 2)] : null;

  let norm = Math.min(1, youngFrac / 0.38);
  if (med != null && med <= 14) {
    norm = Math.max(norm, Math.min(1, 1 - med / 22));
  }
  norm = Math.min(1, norm);
  const coverage01 = withData / examined;
  norm *= 0.55 + 0.45 * coverage01;

  return {
    norm01: Math.min(1, norm),
    coverage01: Math.round(coverage01 * 1000) / 1000,
    youngFrac: Math.round(youngFrac * 1000) / 1000,
    medianAgeDays: med != null ? Math.round(med * 10) / 10 : null,
    note: w.status === "partial" ? "partial_ledger_coverage" : null,
  };
}

/**
 * Z-score of the largest bucket count vs all bucket event counts.
 * @param {{ eventCount: number }[]} timelineBuckets
 */
export function buyBurstZScore(timelineBuckets) {
  if (!Array.isArray(timelineBuckets) || timelineBuckets.length < 4) {
    return { z: null, mean: null, std: null, maxCount: null, note: "Need >=4 time buckets for a baseline." };
  }
  const counts = timelineBuckets.map((b) => Number(b.eventCount) || 0);
  const n = counts.length;
  const mean = counts.reduce((a, b) => a + b, 0) / n;
  if (mean <= 0) return { z: null, mean: 0, std: 0, maxCount: Math.max(...counts), note: "Zero-mean buckets." };
  const varc = counts.reduce((s, c) => s + (c - mean) ** 2, 0) / n;
  const std = Math.sqrt(varc) || 1e-9;
  const maxCount = Math.max(...counts);
  const z = (maxCount - mean) / std;
  return { z, mean, std, maxCount, note: null };
}

/**
 * @param {EventRow[]} rows
 * @param {number | null} peakBucketStartSec
 * @param {number} bucketSec
 * @param {string[]} topPayers
 */
export function walletFirstActivityProfile(rows, peakBucketStartSec, bucketSec, topPayers) {
  const want = new Set(topPayers.map(String).filter(Boolean).slice(0, 18));
  /** @type {Map<string, number>} */
  const first = new Map();
  for (const r of rows) {
    const p = String(r.fee_payer ?? "");
    if (!want.has(p)) continue;
    const t = Number(r.block_time);
    if (!Number.isFinite(t)) continue;
    if (!first.has(p) || t < first.get(p)) first.set(p, t);
  }
  let inPeak = 0;
  let have = 0;
  if (peakBucketStartSec != null && bucketSec > 0) {
    const peakEnd = peakBucketStartSec + bucketSec;
    for (const p of want) {
      const t = first.get(p);
      if (t == null) continue;
      have++;
      if (t >= peakBucketStartSec && t < peakEnd) inPeak++;
    }
  }
  const recencyFrac = want.size > 0 ? inPeak / want.size : 0;
  return { tracked: want.size, withEvents: have, firstActivityInPeakBucket: inPeak, recencyFraction: recencyFrac };
}

/**
 * @param {TransferRow[]} transfers
 * @param {string} scopeMint
 * @param {Set<string>} participantSet
 */
export function detectWashRotation(transfers, scopeMint, participantSet) {
  const mint = String(scopeMint ?? "").trim();
  /** @type {Map<string, number>} */
  const dirCount = new Map();
  const dkey = (a, b, asset) => `${a}\0${b}\0${asset}`;

  for (const t of transfers) {
    const from = String(t.from ?? "").trim();
    const to = String(t.to ?? "").trim();
    const m = t.mint != null ? String(t.mint).trim() : "";
    if (!from || !to || from === to) continue;

    /** @type {string | null} */
    let asset = null;
    if (!mint) {
      if (participantSet.size > 0 && (!participantSet.has(from) || !participantSet.has(to))) continue;
      asset = m || "unknown";
    } else if (m === mint) {
      asset = mint;
    } else if (
      m === NATIVE_SOL_TRANSFER &&
      participantSet.size > 0 &&
      participantSet.has(from) &&
      participantSet.has(to)
    ) {
      asset = NATIVE_SOL_TRANSFER;
    } else {
      continue;
    }

    const kk = dkey(from, to, asset);
    dirCount.set(kk, (dirCount.get(kk) ?? 0) + 1);
  }

  /** @type {{ pair: [string, string], forward: number, back: number, mint: string }[]} */
  const suspicious = [];
  const seenUnordered = new Set();
  for (const [k] of dirCount) {
    const parts = k.split("\0");
    if (parts.length < 3) continue;
    const x0 = parts[0];
    const y0 = parts[1];
    const asset = parts.slice(2).join("\0");
    const x = x0 < y0 ? x0 : y0;
    const y = x0 < y0 ? y0 : x0;
    const u = `${x}||${y}||${asset}`;
    if (seenUnordered.has(u)) continue;
    seenUnordered.add(u);
    const fLeg = dirCount.get(dkey(x, y, asset)) ?? 0;
    const bLeg = dirCount.get(dkey(y, x, asset)) ?? 0;
    if (fLeg >= 1 && bLeg >= 1 && fLeg + bLeg >= 3) {
      suspicious.push({ pair: [x, y], forward: fLeg, back: bLeg, mint: asset });
    }
  }
  suspicious.sort((a, b) => b.forward + b.back - (a.forward + a.back));

  const triggered = suspicious.length > 0;
  return {
    name: "detect_wash_rotation",
    triggered,
    severity: triggered ? (suspicious.length >= 2 || suspicious[0].forward + suspicious[0].back >= 6 ? "high" : "medium") : "none",
    summary: triggered
      ? (() => {
          const s0 = suspicious[0];
          const m = s0.mint;
          const mLabel =
            m === NATIVE_SOL_TRANSFER ? "native SOL (lamports)" : `${m.slice(0, 6)}…`;
          return `Reciprocal transfers (${s0.forward}+${s0.back} legs) between linked wallets on ${mLabel} — possible wash rotation.`;
        })()
      : "No strong two-way transfer legs among watched wallets for this mint in window.",
    evidence: suspicious.slice(0, 4).map((s) => ({
      walletA: s.pair[0].slice(0, 8) + "…",
      walletB: s.pair[1].slice(0, 8) + "…",
      legsOneWayApprox: Math.max(s.forward, s.back),
      legsReverseApprox: Math.min(s.forward, s.back),
      mintShort:
        s.mint === NATIVE_SOL_TRANSFER
          ? "native SOL"
          : s.mint.length > 10
            ? `${s.mint.slice(0, 6)}…${s.mint.slice(-4)}`
            : s.mint,
    })),
    limitation: mint
      ? "Mint scope includes SPL legs for that mint plus native SOL legs only when both endpoints are top fee payers."
      : "Scope may not be a mint — wash scan used any mint where both endpoints are in the payer cohort.",
  };
}

/**
 * @param {FundingGraphLike} fundingGraph
 * @param {ReturnType<typeof walletFirstActivityProfile>} activity
 */
export function detectSybilPump(fundingGraph, activity) {
  const sharedRaw = Array.isArray(fundingGraph?.sharedInboundFunders) ? fundingGraph.sharedInboundFunders : [];
  const shared = [...sharedRaw];
  const best = shared.reduce((m, s) => Math.max(m, Number(s.recipientCount) || 0), 0);
  const top =
    shared.length > 0
      ? [...shared].sort((a, b) => (Number(b.recipientCount) || 0) - (Number(a.recipientCount) || 0))[0]
      : null;

  const hubStrong = best >= 3;
  const burstCrowd = activity.recencyFraction >= 0.35 && activity.tracked >= 4;
  const triggered = hubStrong && burstCrowd;

  let severity = "none";
  if (triggered) severity = best >= 5 && activity.recencyFraction >= 0.5 ? "high" : "medium";

  return {
    name: "detect_sybil_pump",
    triggered,
    severity,
    summary: triggered
      ? `Shared inbound funder fans out to ${best} fee payers; ~${Math.round(activity.recencyFraction * 100)}% of top payers' first seen activity falls in the peak bucket — sybil/coordination pattern.`
      : hubStrong
        ? "Shared funder hub seen but payer first-activity is not concentrated in the peak slice — weak sybil signal."
        : "No shared inbound funder touching 3+ top payers in this graph slice.",
    evidence: top
      ? {
          funderShort: String(top.funder).slice(0, 8) + "…",
          recipientsLinked: Number(top.recipientCount) || 0,
          payerFirstActivityInPeakPct: Math.round(activity.recencyFraction * 100),
        }
      : {},
    limitation: "Wallet birth time not on-chain here — 'first activity' is first fee_payer event in this export window.",
  };
}

/**
 * @param {string[]} topPayers
 * @param {PeerEdgeRow[]} peerEdges
 */
export function detectCoordinationCluster(topPayers, peerEdges) {
  const nodes = [...new Set(topPayers.map(String).filter(Boolean))].slice(0, 14);
  if (nodes.length < 3) {
    return {
      name: "detect_coordination_cluster",
      triggered: false,
      severity: "none",
      summary: "Not enough top payers to evaluate peer-to-peer communities.",
      evidence: {
        nodeCount: nodes.length,
        undirectedPeerEdges: 0,
        globalDensityRounded: 0,
        communities: [],
      },
    };
  }

  const analysis = analyzePeerCommunities(topPayers, peerEdges, { maxNodes: 14, maxIter: 50 });
  const edgeCount = analysis.undirectedPeerEdges;
  const density = analysis.globalDensity;
  const lc = analysis.largestConnectedComponent;
  const communities = analysis.communities;
  const largest = communities[0];

  const strongCommunity =
    largest &&
    largest.memberCount >= 4 &&
    largest.internalDensity >= 0.2 &&
    largest.internalEdges >= 2;

  const triggered =
    (density >= 0.12 && edgeCount >= 4) ||
    Boolean(strongCommunity) ||
    Boolean(largest && largest.memberCount >= 5 && lc >= 5 && edgeCount >= 3);

  let severity = "none";
  if (triggered) {
    if (
      density >= 0.22 ||
      (largest && largest.memberCount >= 6 && largest.internalDensity >= 0.35) ||
      (largest && largest.memberCount >= 7 && largest.internalEdges >= 5)
    ) {
      severity = "high";
    } else {
      severity = "medium";
    }
  }

  return {
    name: "detect_coordination_cluster",
    triggered,
    severity,
    summary: triggered
      ? `Label-prop communities on peer subgraph: ${edgeCount} undirected edges, global density ${density}; largest module ${largest?.memberCount ?? 0} wallets (internal density ${largest?.internalDensity ?? 0}) — coordination cluster signal.`
      : "Weak peer-to-peer linking among top payers in this edge sample — no strong community module.",
    evidence: {
      nodeCount: analysis.nodeCount,
      undirectedPeerEdges: edgeCount,
      maxPossibleUndirectedEdges: analysis.maxPossibleUndirectedEdges,
      globalDensityRounded: density,
      largestConnectedComponent: lc,
      largestCommunitySize: analysis.largestCommunitySize,
      largestCommunityInternalDensity: analysis.largestCommunityInternalDensity,
      labelPropagationIterations: analysis.labelPropagationIterations,
      algorithm: analysis.algorithm,
      communities: communities.slice(0, 5),
    },
    limitation:
      "Deterministic label propagation on Turso peer edges only — not Louvain/Leiden; sparse graphs yield singleton-heavy partitions.",
  };
}

/**
 * Coefficient of variation of transfer raw amounts (same mint as scope when set).
 * @param {TransferRow[]} transfers
 * @param {string} scopeMint
 */
export function transferAmountUniformity(transfers, scopeMint) {
  const mint = String(scopeMint ?? "").trim();
  const amounts = [];
  for (const t of transfers) {
    if (mint && String(t.mint ?? "").trim() !== mint) continue;
    const raw = String(t.amount ?? "").trim();
    const v = Number(raw);
    if (Number.isFinite(v) && v > 0) amounts.push(v);
  }
  if (amounts.length < 6) {
    return { cv: null, mean: null, n: amounts.length, note: "Not enough same-mint positive amounts in window." };
  }
  const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  if (mean <= 0) return { cv: null, mean: 0, n: amounts.length, note: "Zero mean amount." };
  const varc = amounts.reduce((s, x) => s + (x - mean) ** 2, 0) / amounts.length;
  const std = Math.sqrt(varc);
  const cv = std / mean;
  return { cv, mean, n: amounts.length, note: null };
}

/**
 * @param {FundingGraphLike} fundingGraph
 */
export function fundingHubStrength01(fundingGraph) {
  const shared = Array.isArray(fundingGraph?.sharedInboundFunders) ? fundingGraph.sharedInboundFunders : [];
  const best = shared.reduce((m, s) => Math.max(m, Number(s.recipientCount) || 0), 0);
  return Math.min(1, best / 12);
}

/**
 * Normalize peak distinct payers to 0..1 (saturating).
 * @param {number} peakPayers
 */
export function feePayerConcentration01(peakPayers) {
  const p = Number(peakPayers);
  if (!Number.isFinite(p) || p < 0) return 0;
  return Math.min(1, 1 - Math.exp(-p / 12));
}

/**
 * @param {{
 *   scope: string,
 *   eventRows: EventRow[],
 *   scoreResult: Record<string, unknown>,
 *   fundingGraph: FundingGraphLike,
 *   transfers: TransferRow[],
 *   peerEdges: PeerEdgeRow[],
 *   walletLedgerAge?: ReturnType<import("./wallet-ledger-age.js").buildWalletLedgerAge> | null,
 * }} opts
 */
export function runAiDetectors(opts) {
  const { scope, eventRows, scoreResult, fundingGraph, transfers, peerEdges, walletLedgerAge } = opts;
  const scopeStr = String(scope ?? "").trim();
  const windowMinutes = Number(scoreResult.windowMinutes) || 5;
  const bucketSec = windowMinutes * 60;
  const timelineBuckets = Array.isArray(scoreResult.timelineBuckets) ? scoreResult.timelineBuckets : [];
  const peakStartIso = scoreResult.peakBucketStartsIso;
  let peakBucketStartSec = null;
  if (typeof peakStartIso === "string" && peakStartIso) {
    const ms = Date.parse(peakStartIso);
    if (Number.isFinite(ms)) peakBucketStartSec = Math.floor(ms / 1000);
  }

  const topPayers = Array.isArray(scoreResult.topPayerLinks)
    ? scoreResult.topPayerLinks.map((x) => String(x.payer ?? "")).filter(Boolean)
    : [];
  const participantSet = new Set(topPayers);

  const zInfo = buyBurstZScore(timelineBuckets);
  const z = zInfo.z != null && Number.isFinite(zInfo.z) ? zInfo.z : 0;
  let buyBurstNorm = Math.min(1, Math.max(0, z / 4));

  const tradeBuckets = buildTimelineBucketsFromRows(eventRows, windowMinutes, TRADE_LIKE_EVENT_TYPES);
  const zTradeInfo = buyBurstZScore(tradeBuckets);
  const zTrade =
    zTradeInfo.z != null && Number.isFinite(zTradeInfo.z) ? zTradeInfo.z : null;
  const buyBurstTradeNorm =
    zTrade != null && tradeBuckets.length >= 4 ? Math.min(1, Math.max(0, zTrade / 4)) : null;
  if (buyBurstTradeNorm != null) {
    buyBurstNorm = Math.max(buyBurstNorm, buyBurstTradeNorm);
  }

  const activity = walletFirstActivityProfile(eventRows, peakBucketStartSec, bucketSec, topPayers);
  const walletRecencyNorm = Math.min(1, activity.recencyFraction * 1.4);

  const peakPayers = Number(scoreResult.peakBucketWalletCount ?? scoreResult.score ?? 0);
  const feeConcNorm = feePayerConcentration01(peakPayers);

  const fundHub = fundingHubStrength01(fundingGraph);

  const uni = transferAmountUniformity(transfers, scopeStr);
  let uniformityNorm = 0;
  if (uni.cv != null && uni.cv < 0.35 && uni.n >= 6) {
    uniformityNorm = Math.min(1, (0.35 - uni.cv) / 0.35 + (uni.n >= 12 ? 0.15 : 0));
  }

  const wash = detectWashRotation(transfers, scopeStr, participantSet);
  const sybil = detectSybilPump(fundingGraph, activity);
  const cluster = detectCoordinationCluster(topPayers, peerEdges);

  const ledgerYouth = ledgerCohortYouthNorm01(walletLedgerAge ?? null);

  const detectorBoost =
    (wash.triggered ? (wash.severity === "high" ? 0.22 : 0.12) : 0) +
    (sybil.triggered ? (sybil.severity === "high" ? 0.2 : 0.1) : 0) +
    (cluster.triggered ? (cluster.severity === "high" ? 0.18 : 0.09) : 0);

  const blend =
    0.26 * feeConcNorm +
    0.22 * buyBurstNorm +
    0.2 * fundHub +
    0.12 * walletRecencyNorm +
    0.1 * uniformityNorm +
    0.1 * ledgerYouth.norm01;

  const composite01 = Math.min(1, blend + detectorBoost);
  const compositeScore0_100 = Math.round(composite01 * 100);

  return {
    version: 2,
    multiSignal: {
      feePayerConcentration01: Math.round(feeConcNorm * 1000) / 1000,
      buyBurstZScore: zInfo.z != null ? Math.round(zInfo.z * 100) / 100 : null,
      buyBurstNorm01: Math.round(buyBurstNorm * 1000) / 1000,
      buyBurstTradeZScore: zTrade != null ? Math.round(zTrade * 100) / 100 : null,
      buyBurstTradeNorm01:
        buyBurstTradeNorm != null ? Math.round(buyBurstTradeNorm * 1000) / 1000 : null,
      tradeLikeBucketsUsed: tradeBuckets.length,
      walletFirstActivityInPeakFraction: Math.round(activity.recencyFraction * 1000) / 1000,
      walletRecencyNorm01: Math.round(walletRecencyNorm * 1000) / 1000,
      ledgerCohortYouthNorm01: Math.round(ledgerYouth.norm01 * 1000) / 1000,
      ledgerAgeCoverage01: ledgerYouth.coverage01,
      ledgerYoungWalletFracAmongKnown: ledgerYouth.youngFrac,
      ledgerMedianAgeDaysAmongKnown: ledgerYouth.medianAgeDays,
      ledgerYouthNote: ledgerYouth.note,
      solFundingHubStrength01: Math.round(fundHub * 1000) / 1000,
      transferAmountCv: uni.cv != null ? Math.round(uni.cv * 10000) / 10000 : null,
      transferUniformityNorm01: Math.round(uniformityNorm * 1000) / 1000,
    },
    detectors: {
      detect_wash_rotation: wash,
      detect_sybil_pump: sybil,
      detect_coordination_cluster: cluster,
    },
    dataAvailability: {
      transferRowsInWindow: transfers.length,
      splTransferRows: transfers.filter((t) => {
        const m = String(t.mint ?? "").trim();
        return Boolean(m) && m !== NATIVE_SOL_TRANSFER;
      }).length,
      nativeSolTransferRows: transfers.filter((t) => String(t.mint ?? "").trim() === NATIVE_SOL_TRANSFER).length,
      peerEdgeRowsInWindow: peerEdges.length,
      washAssetSemantics:
        "Mint scope: SPL on scope mint + native SOL between top payers; no mint scope: cohort endpoints only.",
    },
    composite: {
      score0_100: compositeScore0_100,
      formulaNote:
        "Weighted blend: fee concentration, activity burst z-score (all events; trade-like swap/SPL z when ≥4 buckets), funding hub, window first-activity-in-peak, amount uniformity, chain-backed cohort youth (wallet_first_seen), plus detector boosts — heuristic, not court-grade.",
    },
  };
}
