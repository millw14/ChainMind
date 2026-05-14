/**
 * Build analyst evidence for Groq — computed dashboard metrics only (no pre-written narrative).
 *
 * @param {object} p
 * @param {string} p.address
 * @param {any} p.score — JSON from GET /api/score
 * @param {any} p.inspect — JSON from GET /api/inspect
 * @param {{ score0_100: number | null, peakPayers?: number } | null} p.risk — from deriveRiskProfile(score)
 */
export function buildGroqEvidence({ address, score, inspect, risk }) {
  const addr = String(address ?? "").trim();

  const windowMinutes = score?.windowMinutes ?? null;
  const timeWindow = windowMinutes != null ? `${windowMinutes}min` : null;

  let coActivityScore = null;
  if (risk?.score0_100 != null && Number.isFinite(Number(risk.score0_100))) {
    coActivityScore = Math.round((Number(risk.score0_100) / 100) * 1000) / 1000;
  }

  const distinctFeePayers =
    score?.peakBucketWalletCount ?? score?.score ?? null;

  const distinctFeePayersWholeWindow = score?.distinctPayersWholeWindow ?? null;

  const wl = score?.walletLedgerAge;
  /** @type {Map<string, Record<string, unknown>>} */
  const ledgerByAddr = new Map();
  if (wl && typeof wl === "object" && Array.isArray(wl.rows)) {
    for (const r of wl.rows) {
      if (r && typeof r === "object" && r.address) ledgerByAddr.set(String(r.address), r);
    }
  }

  /** Fee payers ranked by event volume in lookback + optional chain-backed first-tx from Turso. */
  const walletAges = [];
  if (Array.isArray(score?.topPayerLinks)) {
    for (const row of score.topPayerLinks.slice(0, 12)) {
      if (!row?.payer) continue;
      const ledger = ledgerByAddr.get(String(row.payer));
      const hasLedger = ledger && ledger.firstBlockTime != null;
      walletAges.push({
        address: row.payer,
        feePayerEventsInLookback: row.events ?? 0,
        note: hasLedger
          ? `Chain-backed oldest signature in RPC walk (~${ledger.ageDays}d since first blockTime in metadata; history capped=${ledger.historyCapped}).`
          : "Event count in lookback only — no wallet_first_seen row (run wallet-age backfill or lazy score fetch).",
        firstBlockTime: hasLedger ? ledger.firstBlockTime : null,
        ageDays: hasLedger ? ledger.ageDays : null,
        historyCapped: hasLedger ? ledger.historyCapped : null,
      });
    }
  }

  let fundingOverlap = null;
  if (score?.database === "unconfigured") {
    fundingOverlap = "Coordination DB offline — no fee-payer / funding graph for this export.";
  } else if (score?.ok === false) {
    fundingOverlap = `Score unavailable: ${score.error ?? "error"}.`;
  } else if (score?.empty) {
    fundingOverlap = "No qualifying events in lookback — overlap metrics not applicable.";
  } else if (score?.ok) {
    const peak = distinctFeePayers ?? "?";
    const whole = distinctFeePayersWholeWindow ?? "?";
    const hrs = score.lastHours ?? "?";
    fundingOverlap = `Shared funding ancestry not computed in this pipeline. Peak ${peak} distinct fee payers in one ${timeWindow ?? "bucket"}; ${whole} unique fee payers across last ${hrs}h (fee-payer graph is scope-linked only).`;
  }

  const fg = score?.fundingGraph;
  if (fg?.status === "attached") {
    const shared = Array.isArray(fg.sharedInboundFunders) ? fg.sharedInboundFunders : [];
    const peak = distinctFeePayers ?? "?";
    const whole = distinctFeePayersWholeWindow ?? "?";
    const hrs = score?.lastHours ?? "?";
    if (shared.length > 0) {
      const bits = shared.slice(0, 4).map((s) => `${s.funder?.slice(0, 8)}… funds ${s.recipientCount} payers`);
      fundingOverlap = `Funding graph (Turso): shared inbound funders across top payers — ${bits.join("; ")}. Co-activity: peak ${peak} payers in one ${timeWindow ?? "bucket"}; ${whole} across ${hrs}h.`;
    } else {
      fundingOverlap = `Funding graph sampled (${fg.edgeRowsSampled ?? 0} edges) — no single funder links 2+ top payers in this window. Co-activity: peak ${peak} in one ${timeWindow ?? "bucket"}; ${whole} across ${hrs}h.`;
    }
  } else if (fg?.status === "no_edges") {
    fundingOverlap = `${fg.note ?? "No inbound funding edges for top payers in lookback."} ${fundingOverlap ?? ""}`.trim();
  } else if (fg?.status === "not_attached" && typeof fg.note === "string") {
    fundingOverlap = `${fg.note} ${fundingOverlap ?? ""}`.trim();
  }

  const signatures = pickSuspiciousSignatures(inspect);

  /** @type {Record<string, unknown>} */
  const accountAge =
    wl && typeof wl === "object" && wl.status && wl.status !== "not_fetched"
      ? {
          status: wl.status,
          source: wl.source,
          payersExamined: wl.payersExamined,
          payersWithData: wl.payersWithData,
          youngWalletsUnder7d: wl.youngWalletsUnder7d,
          note: wl.note,
          sample: Array.isArray(wl.rows) ? wl.rows.slice(0, 8) : [],
        }
      : {
          status: "not_fetched",
          note: "No wallet_first_seen coverage for top payers yet — run npm run wallet-age:backfill or CHAINMIND_FETCH_WALLET_AGE_ON_SCORE=1.",
        };

  const transferEdgesSample = Array.isArray(score?.transferEdgesSample)
    ? score.transferEdgesSample.slice(0, 40)
    : [];

  const lastHoursVal = score?.lastHours != null && Number.isFinite(Number(score.lastHours)) ? Number(score.lastHours) : null;

  /** @type {Record<string, unknown>} */
  const evidence = {
    generatedAt: new Date().toISOString(),
    ...(score && typeof score === "object" ? { ...score } : {}),
    address: addr || null,
    coActivityScore,
    timeWindow,
    lookbackHours: lastHoursVal,
    lastHours: lastHoursVal,
    distinctFeePayers,
    distinctFeePayersWholeWindow,
    transferEdgesSample,
    payerOverlapPriorWindowsPct:
      typeof score?.payerOverlapPriorWindowsPct === "number" && Number.isFinite(score.payerOverlapPriorWindowsPct)
        ? Math.round(score.payerOverlapPriorWindowsPct * 10) / 10
        : null,
    walletAges,
    fundingOverlap,
    fundingGraph: score?.fundingGraph ?? { status: "not_attached", reason: "score_payload_missing" },
    accountAge,
    signatures,
    topPrograms: Array.isArray(score?.topPrograms) ? score.topPrograms.slice(0, 8) : [],
    typeBreakdown:
      score?.typeBreakdown && typeof score.typeBreakdown === "object" && !Array.isArray(score.typeBreakdown)
        ? score.typeBreakdown
        : {},
    drivers: Array.isArray(score?.drivers) ? score.drivers : [],
  };

  if (score?.walletLedgerAge && typeof score.walletLedgerAge === "object") {
    evidence.walletLedgerAge = score.walletLedgerAge;
  }

  if (score?.aiDetection && typeof score.aiDetection === "object") {
    evidence.aiDetection = score.aiDetection;
  }

  // Trim large arrays before POST — keeps Groq payload under ~40KB
  const ARRAY_CAPS = {
    timelineBuckets: 60,
    buckets: 60,
    transferEdgesSample: 40,
    topPrograms: 8,
    drivers: 12,
    signatures: 24,
    walletAges: 20,
    feePayers: 16,
    entityLedger: 56,
  };

  for (const [key, cap] of Object.entries(ARRAY_CAPS)) {
    if (Array.isArray(evidence[key]) && evidence[key].length > cap) {
      evidence[key] = evidence[key].slice(0, cap);
    }
  }

  return evidence;
}

function summarizeErr(err) {
  if (err == null) return null;
  if (typeof err === "string") return err.slice(0, 240);
  try {
    return JSON.stringify(err).slice(0, 240);
  } catch {
    return "error";
  }
}

/**
 * Prefer failed txs, then most recent, cap size.
 * @param {any} inspect
 * @returns {object[]}
 */
function pickSuspiciousSignatures(inspect) {
  if (!inspect?.ok || !Array.isArray(inspect.signatures)) return [];

  const ranked = [...inspect.signatures].sort((a, b) => {
    const aFail = a?.err ? 1 : 0;
    const bFail = b?.err ? 1 : 0;
    if (bFail !== aFail) return bFail - aFail;
    return (Number(b?.blockTime) || 0) - (Number(a?.blockTime) || 0);
  });

  return ranked.slice(0, 18).map((s) => ({
    signature: s.signature,
    slot: s.slot ?? null,
    blockTimeIso:
      s.blockTime != null && Number.isFinite(Number(s.blockTime))
        ? new Date(Number(s.blockTime) * 1000).toISOString()
        : null,
    failed: Boolean(s?.err),
    errSummary: s?.err ? summarizeErr(s.err) : null,
  }));
}
