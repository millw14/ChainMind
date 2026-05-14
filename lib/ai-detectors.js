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
  const dkey = (a, b) => `${a}\0${b}`;

  for (const t of transfers) {
    const from = String(t.from ?? "").trim();
    const to = String(t.to ?? "").trim();
    const m = t.mint != null ? String(t.mint).trim() : "";
    if (!from || !to || from === to) continue;
    if (mint && m !== mint) continue;
    if (participantSet.size > 0 && (!participantSet.has(from) || !participantSet.has(to))) continue;

    const k = dkey(from, to);
    dirCount.set(k, (dirCount.get(k) ?? 0) + 1);
  }

  /** @type {{ pair: [string, string], forward: number, back: number, mint: string }[]} */
  const suspicious = [];
  const seenUnordered = new Set();
  for (const [k] of dirCount) {
    const [x0, y0] = k.split("\0");
    if (!x0 || !y0) continue;
    const x = x0 < y0 ? x0 : y0;
    const y = x0 < y0 ? y0 : x0;
    const u = `${x}||${y}`;
    if (seenUnordered.has(u)) continue;
    seenUnordered.add(u);
    const fLeg = dirCount.get(dkey(x, y)) ?? 0;
    const bLeg = dirCount.get(dkey(y, x)) ?? 0;
    if (fLeg >= 1 && bLeg >= 1 && fLeg + bLeg >= 3) {
      let pairMint = mint || "multi";
      if (!mint) {
        for (const t of transfers) {
          const tf = String(t.from ?? "").trim();
          const tt = String(t.to ?? "").trim();
          if (
            participantSet.size === 0 ||
            (participantSet.has(tf) && participantSet.has(tt))
          ) {
            if (tf === x && tt === y && t.mint) {
              pairMint = String(t.mint);
              break;
            }
            if (tf === y && tt === x && t.mint) {
              pairMint = String(t.mint);
              break;
            }
          }
        }
      }
      suspicious.push({ pair: [x, y], forward: fLeg, back: bLeg, mint: pairMint });
    }
  }
  suspicious.sort((x, y) => y.forward + y.back - (x.forward + x.back));

  const triggered = suspicious.length > 0;
  return {
    name: "detect_wash_rotation",
    triggered,
    severity: triggered ? (suspicious.length >= 2 || suspicious[0].forward + suspicious[0].back >= 6 ? "high" : "medium") : "none",
    summary: triggered
      ? `Reciprocal transfers (${suspicious[0].forward}+${suspicious[0].back} legs) between linked wallets on mint ${suspicious[0].mint.slice(0, 6)}… — possible wash rotation.`
      : "No strong two-way transfer legs among watched wallets for this mint in window.",
    evidence: suspicious.slice(0, 4).map((s) => ({
      walletA: s.pair[0].slice(0, 8) + "…",
      walletB: s.pair[1].slice(0, 8) + "…",
      legsOneWayApprox: Math.max(s.forward, s.back),
      legsReverseApprox: Math.min(s.forward, s.back),
      mintShort: s.mint.length > 10 ? `${s.mint.slice(0, 6)}…${s.mint.slice(-4)}` : s.mint,
    })),
    limitation: mint
      ? null
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
      summary: "Not enough top payers to evaluate peer-to-peer edge density.",
      evidence: { nodeCount: nodes.length, internalEdges: 0, density: 0 },
    };
  }
  const set = new Set(nodes);
  /** @type {Set<string>} */
  const undirected = new Set();
  for (const e of peerEdges) {
    const a = String(e.from ?? "").trim();
    const b = String(e.to ?? "").trim();
    if (!set.has(a) || !set.has(b) || a === b) continue;
    const edgeKey = a < b ? `${a}||${b}` : `${b}||${a}`;
    undirected.add(edgeKey);
  }
  const n = nodes.length;
  const possible = (n * (n - 1)) / 2;
  const density = possible > 0 ? undirected.size / possible : 0;

  /** crude component count on internal edges */
  /** @type {Map<string, Set<string>>} */
  const adj = new Map();
  for (const k of undirected) {
    const [x, y] = k.split("||");
    if (!adj.has(x)) adj.set(x, new Set());
    if (!adj.has(y)) adj.set(y, new Set());
    adj.get(x).add(y);
    adj.get(y).add(x);
  }
  const visited = new Set();
  let largest = 0;
  for (const start of nodes) {
    if (visited.has(start)) continue;
    let sz = 0;
    const st = [start];
    while (st.length) {
      const u = st.pop();
      if (visited.has(u)) continue;
      visited.add(u);
      sz++;
      const nb = adj.get(u);
      if (nb) for (const v of nb) if (!visited.has(v)) st.push(v);
    }
    largest = Math.max(largest, sz);
  }

  const triggered = density >= 0.12 && undirected.size >= 4;
  const severity = triggered ? (density >= 0.22 || largest >= 6 ? "high" : "medium") : "none";

  return {
    name: "detect_coordination_cluster",
    triggered,
    severity,
    summary: triggered
      ? `Dense wallet-wiring among top payers (density ${density.toFixed(2)}, ${undirected.size} unique undirected peer edges) — plausible coordination cluster.`
      : "Fee payers mostly connect through scope only — low direct peer edge density in this sample.",
    evidence: {
      topPayersInGraph: n,
      undirectedPeerEdges: undirected.size,
      maxPossibleEdges: possible,
      densityRounded: Math.round(density * 1000) / 1000,
      largestConnectedComponent: largest,
    },
    limitation: "Community detection is edge-density heuristic only (not full Louvain/label propagation).",
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
 * }} opts
 */
export function runAiDetectors(opts) {
  const { scope, eventRows, scoreResult, fundingGraph, transfers, peerEdges } = opts;
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
  const buyBurstNorm = Math.min(1, Math.max(0, z / 4));

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

  const detectorBoost =
    (wash.triggered ? (wash.severity === "high" ? 0.22 : 0.12) : 0) +
    (sybil.triggered ? (sybil.severity === "high" ? 0.2 : 0.1) : 0) +
    (cluster.triggered ? (cluster.severity === "high" ? 0.18 : 0.09) : 0);

  const blend =
    0.28 * feeConcNorm +
    0.24 * buyBurstNorm +
    0.22 * fundHub +
    0.14 * walletRecencyNorm +
    0.12 * uniformityNorm;

  const composite01 = Math.min(1, blend + detectorBoost);
  const compositeScore0_100 = Math.round(composite01 * 100);

  return {
    version: 2,
    multiSignal: {
      feePayerConcentration01: Math.round(feeConcNorm * 1000) / 1000,
      buyBurstZScore: zInfo.z != null ? Math.round(zInfo.z * 100) / 100 : null,
      buyBurstNorm01: Math.round(buyBurstNorm * 1000) / 1000,
      walletFirstActivityInPeakFraction: Math.round(activity.recencyFraction * 1000) / 1000,
      walletRecencyNorm01: Math.round(walletRecencyNorm * 1000) / 1000,
      solFundingHubStrength01: Math.round(fundHub * 1000) / 1000,
      transferAmountCv: uni.cv != null ? Math.round(uni.cv * 10000) / 10000 : null,
      transferUniformityNorm01: Math.round(uniformityNorm * 1000) / 1000,
    },
    detectors: {
      detect_wash_rotation: wash,
      detect_sybil_pump: sybil,
      detect_coordination_cluster: cluster,
    },
    composite: {
      score0_100: compositeScore0_100,
      formulaNote:
        "Weighted blend of concentration, burst z-score, funding hub, payer first-activity-in-peak, amount uniformity, plus triggered detector boosts — heuristic, not court-grade.",
    },
  };
}
