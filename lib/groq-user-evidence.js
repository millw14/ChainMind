/**
 * Narrow evidence object for the Groq *user* message — concrete addresses, sigs, timing, rates.
 * Built from the full dashboard/cron snapshot (POST `data`).
 *
 * @param {unknown} fullSnapshot
 */
export function buildGroqUserEvidence(fullSnapshot) {
  if (!fullSnapshot || typeof fullSnapshot !== "object") {
    return {
      scopeAddress: null,
      feePayers: [],
      signatures: [],
      timeDeltas: null,
      coActivityScore: null,
      failureRate: null,
    };
  }

  const d = /** @type {Record<string, any>} */ (fullSnapshot);

  /** @type {string[]} */
  const feePayers = [];
  if (Array.isArray(d.walletAges)) {
    for (const w of d.walletAges) {
      if (w?.address) feePayers.push(String(w.address));
    }
  }

  const rawSigs = Array.isArray(d.signatures) ? d.signatures : [];
  const n = rawSigs.length;
  const failed = rawSigs.filter((s) => s?.failed || s?.err).length;
  const failureRate = n > 0 ? Math.round((failed / n) * 1000) / 1000 : null;

  const signatures = rawSigs.slice(0, 24).map((s) => ({
    signature: s.signature,
    slot: s.slot ?? null,
    failed: Boolean(s.failed),
    ...(s.blockTimeIso ? { blockTimeIso: s.blockTimeIso } : {}),
  }));

  const timeDeltas = computeTimeDeltas(rawSigs);

  const coActivityScore =
    typeof d.coActivityScore === "number" && Number.isFinite(d.coActivityScore) ? d.coActivityScore : null;

  return {
    scopeAddress: typeof d.address === "string" && d.address.trim() ? d.address.trim() : null,
    feePayers: feePayers.slice(0, 16),
    signatures,
    timeDeltas,
    coActivityScore,
    failureRate,
    sampledTxCount: n,
    distinctFeePayersPeak: d.distinctFeePayers ?? null,
    timeWindow: d.timeWindow ?? null,
    lookbackHours: d.lookbackHours ?? null,
  };
}

/**
 * @param {any[]} sigRows — items with blockTimeIso or blockTime
 */
function computeTimeDeltas(sigRows) {
  /** @type {number[]} */
  const times = [];
  for (const s of sigRows) {
    let t = null;
    if (s?.blockTimeIso) {
      const ms = Date.parse(s.blockTimeIso);
      if (Number.isFinite(ms)) t = Math.floor(ms / 1000);
    } else if (s?.blockTime != null && Number.isFinite(Number(s.blockTime))) {
      t = Number(s.blockTime);
    }
    if (t != null) times.push(t);
  }
  times.sort((a, b) => b - a);
  if (times.length === 0) {
    return { hasTimestamps: false, note: "No block times in sample — deltas unavailable." };
  }
  const now = Math.floor(Date.now() / 1000);
  const newestToNowSec = now - times[0];
  const oldest = times[times.length - 1];
  const sampleSpanSec = times[0] - oldest;
  /** @type {number[]} */
  const intervalsSec = [];
  for (let i = 0; i < Math.min(times.length - 1, 20); i++) {
    intervalsSec.push(times[i] - times[i + 1]);
  }
  return {
    hasTimestamps: true,
    sampleSpanSeconds: sampleSpanSec,
    secondsFromNewestTxToNow: newestToNowSec,
    intervalsBetweenConsecutiveSamplesSec: intervalsSec,
  };
}
