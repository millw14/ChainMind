/**
 * Computes z-scores for the signal window (recent buckets) against
 * a stored baseline. Falls back to in-window baseline if none stored.
 *
 * Returns a ZScoreResult the Groq evidence block and detectors can consume.
 *
 * @param {Array<{startSec: number, endSec: number, walletCount: number, eventCount: number}>} timelineBuckets
 * @param {null | undefined | StoredBaselineInput} storedBaseline
 * @returns {ZScoreResult}
 */
export function computeZScores(timelineBuckets, storedBaseline) {
  if (!Array.isArray(timelineBuckets) || timelineBuckets.length < 2) {
    return { available: false, reason: "insufficient_buckets" };
  }

  // Signal window = most recent 30% of buckets (or last 12, whichever smaller)
  const signalCount = Math.min(12, Math.max(2, Math.floor(timelineBuckets.length * 0.3)));
  const signalBuckets = timelineBuckets.slice(-signalCount);

  let baselineMeanEvent;
  let baselineStdEvent;
  let baselineMeanWallet;
  let baselineStdWallet;
  /** @type {string} */
  let baselineSource;

  if (storedBaseline && Number(storedBaseline.std_event_count) > 0) {
    baselineMeanEvent = Number(storedBaseline.mean_event_count);
    baselineStdEvent = Number(storedBaseline.std_event_count);
    baselineMeanWallet = Number(storedBaseline.mean_wallet_count);
    baselineStdWallet = Number(storedBaseline.std_wallet_count);
    baselineSource = `stored (${String(storedBaseline.regime ?? "unknown")} regime, ${storedBaseline.bucket_count ?? "?"} buckets)`;
  } else {
    // In-window fallback — use oldest 70%
    const cutoff = Math.floor(timelineBuckets.length * 0.7);
    const base = timelineBuckets.slice(0, cutoff);
    if (base.length < 4) return { available: false, reason: "insufficient_baseline_buckets" };
    const ec = base.map((b) => b.eventCount);
    const wc = base.map((b) => b.walletCount);
    baselineMeanEvent = mean(ec);
    baselineStdEvent = std(ec);
    baselineMeanWallet = mean(wc);
    baselineStdWallet = std(wc);
    baselineSource = "in-window fallback (stored baseline not available)";
  }

  const signalEventCounts = signalBuckets.map((b) => b.eventCount);
  const signalWalletCounts = signalBuckets.map((b) => b.walletCount);

  const peakEventZ =
    baselineStdEvent > 0 ? (Math.max(...signalEventCounts) - baselineMeanEvent) / baselineStdEvent : null;

  const peakWalletZ =
    baselineStdWallet > 0 ? (Math.max(...signalWalletCounts) - baselineMeanWallet) / baselineStdWallet : null;

  const meanSignalEventZ =
    baselineStdEvent > 0 ? (mean(signalEventCounts) - baselineMeanEvent) / baselineStdEvent : null;

  return {
    available: true,
    baselineSource,
    baselineRegime: storedBaseline?.regime != null ? String(storedBaseline.regime) : "in-window",
    signalWindowBuckets: signalCount,
    peakEventZ: round2(peakEventZ),
    peakWalletZ: round2(peakWalletZ),
    meanSignalEventZ: round2(meanSignalEventZ),
    // Thresholds for detector use
    eventSpikeDetected: peakEventZ !== null && Number.isFinite(peakEventZ) && peakEventZ > 2.0,
    walletSpikeDetected: peakWalletZ !== null && Number.isFinite(peakWalletZ) && peakWalletZ > 2.0,
    accelerating: meanSignalEventZ !== null && Number.isFinite(meanSignalEventZ) && meanSignalEventZ > 1.5,
    // Raw for Groq evidence
    baselineMeanEvent: round2(baselineMeanEvent),
    baselineStdEvent: round2(baselineStdEvent),
  };
}

function mean(arr) {
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function std(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

function round2(n) {
  return n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;
}

/**
 * @typedef {{
 *   mean_event_count: number,
 *   std_event_count: number,
 *   mean_wallet_count: number,
 *   std_wallet_count: number,
 *   bucket_count?: number,
 *   regime?: string,
 * }} StoredBaselineInput
 */

/**
 * @typedef {{
 *   available: false,
 *   reason: string,
 * } | {
 *   available: true,
 *   baselineSource: string,
 *   baselineRegime: string,
 *   signalWindowBuckets: number,
 *   peakEventZ: number | null,
 *   peakWalletZ: number | null,
 *   meanSignalEventZ: number | null,
 *   eventSpikeDetected: boolean,
 *   walletSpikeDetected: boolean,
 *   accelerating: boolean,
 *   baselineMeanEvent: number | null,
 *   baselineStdEvent: number | null,
 * }} ZScoreResult
 */
