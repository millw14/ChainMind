/**
 * Derive coordination “threat index” labels from GET /api/score JSON.
 * @param {any} score
 */
export function deriveRiskProfile(score) {
  if (!score || score.error) {
    return { tier: "unknown", score0_100: null, blurb: "Run coordination analysis when data is available." };
  }
  if (score.database === "unconfigured") {
    return {
      tier: "unknown",
      score0_100: null,
      blurb: "Ingest synced events to produce a coordination risk estimate for this token or wallet.",
    };
  }
  if (score.empty) {
    return {
      tier: "low",
      score0_100: 8,
      blurb: score.message || "No parsed events in this lookback — risk from coordination is not measurable yet.",
    };
  }
  const peak = Number(score.score ?? 0);
  const score0_100 = Math.min(100, Math.round(100 * (1 - Math.exp(-peak / 10))));
  let tier = "low";
  if (score0_100 >= 78) tier = "critical";
  else if (score0_100 >= 58) tier = "high";
  else if (score0_100 >= 38) tier = "elevated";
  return {
    tier,
    score0_100,
    peakPayers: peak,
    blurb: `Peak ${peak} distinct fee payers in one ${score.windowMinutes}-minute slice (coordination pressure index ${score0_100}/100).`,
  };
}