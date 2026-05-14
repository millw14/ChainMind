/**
 * Pre-positioning detector — fires when stealth accumulation signals
 * converge before public volume or narrative inflects.
 *
 * Requires: zScoreResult + recent timelineBuckets + coactivity score
 *
 * @param {import("./zscore-engine.js").ZScoreResult | { available?: boolean }} zScores
 * @param {Array<{ startSec: number, endSec: number, walletCount: number, eventCount: number }>} _timelineBuckets reserved for future use (density / trend)
 * @param {number | null | undefined} coActivityScore normalized 0–1
 */
export function detectPrePositioning(zScores, _timelineBuckets, coActivityScore) {
  const signals = [];
  let confidence = 0;

  if (!zScores?.available) {
    return {
      detected: false,
      reason: "z-scores unavailable",
      signals: [],
      confidence: 0,
      verdict: "dismiss",
    };
  }

  if (zScores.eventSpikeDetected) {
    signals.push({
      type: "event-acceleration",
      weight: 0.35,
      detail: `Peak event z-score ${zScores.peakEventZ} vs ${zScores.baselineSource}`,
    });
    confidence += 0.35;
  }

  if (zScores.walletSpikeDetected) {
    signals.push({
      type: "wallet-compression",
      weight: 0.35,
      detail: `Peak wallet z-score ${zScores.peakWalletZ} — unusual payer concentration`,
    });
    confidence += 0.35;
  }

  if (zScores.accelerating) {
    signals.push({
      type: "sustained-acceleration",
      weight: 0.2,
      detail: `Mean signal window event z-score ${zScores.meanSignalEventZ} — not a single spike`,
    });
    confidence += 0.2;
  }

  if (typeof coActivityScore === "number" && coActivityScore > 0.6) {
    signals.push({
      type: "coactivity-elevated",
      weight: 0.25,
      detail: `Co-activity score ${coActivityScore} above 0.6 threshold`,
    });
    confidence += 0.25;
  }

  const detected = signals.length >= 2;
  confidence = Math.min(1, Math.round(confidence * 100) / 100);

  const baselineWarning = zScores.baselineSource?.includes("fallback")
    ? "stored baseline not available — z-scores computed in-window, confidence reduced"
    : null;

  if (baselineWarning && detected) confidence = Math.min(confidence, 0.6);

  return {
    detected,
    confidence,
    signals,
    verdict: detected ? (confidence >= 0.7 ? "escalate" : "monitor") : "dismiss",
    baselineSource: zScores.baselineSource,
    baselineWarning,
    peakEventZ: zScores.peakEventZ,
    peakWalletZ: zScores.peakWalletZ,
  };
}
