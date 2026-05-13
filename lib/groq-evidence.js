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

  /** Fee payers ranked by event volume in lookback (not chain “wallet age” — see note). */
  const walletAges = [];
  if (Array.isArray(score?.topPayerLinks)) {
    for (const row of score.topPayerLinks.slice(0, 12)) {
      if (!row?.payer) continue;
      walletAges.push({
        address: row.payer,
        feePayerEventsInLookback: row.events ?? 0,
        note: "Event count in lookback only — on-chain account age not fetched.",
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

  const signatures = pickSuspiciousSignatures(inspect);

  return {
    generatedAt: new Date().toISOString(),
    address: addr || null,
    coActivityScore,
    timeWindow,
    lookbackHours: score?.lastHours ?? null,
    distinctFeePayers,
    distinctFeePayersWholeWindow,
    walletAges,
    fundingOverlap,
    signatures,
    peakBucketStartsIso: score?.peakBucketStartsIso ?? null,
    eventsCounted: score?.eventsCounted ?? null,
    topPrograms: Array.isArray(score?.topPrograms) ? score.topPrograms.slice(0, 6) : [],
  };
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
