/** @typedef {{ id: string, severity: 'critical' | 'high' | 'medium' | 'low' | 'info', title: string, detail?: string }} IntelAlert */

/**
 * @param {{ inspect: any, score: any, ping: any }} param0
 * @returns {IntelAlert[]}
 */
export function buildAlerts({ inspect, score, ping }) {
  /** @type {IntelAlert[]} */
  const out = [];
  let k = 0;
  const id = () => `a-${k++}`;

  if (ping?.error) {
    out.push({
      id: id(),
      severity: "high",
      title: "RPC reachability",
      detail: String(ping.error),
    });
  }

  if (score?.database === "unconfigured") {
    out.push({
      id: id(),
      severity: "info",
      title: "Coordination channel offline",
      detail: "Sync events to Turso to unlock graph, timeline, and coordination risk for this scope.",
    });
  } else if (score?.ok && !score.empty && score.score != null) {
    const s = score.score;
    const w = score.windowMinutes ?? 5;
    if (s >= 18) {
      out.push({
        id: id(),
        severity: "critical",
        title: "Dense payer burst",
        detail: `${s} distinct fee payers in a single ${w}-minute bucket — worth manual review.`,
      });
    } else if (s >= 11) {
      out.push({
        id: id(),
        severity: "high",
        title: "Elevated co-activity",
        detail: `${s} distinct payers peaked in one ${w}-minute slice.`,
      });
    } else if (s >= 6) {
      out.push({
        id: id(),
        severity: "medium",
        title: "Coordination pressure",
        detail: `${s} payers in the busiest ${w}-minute window over the lookback.`,
      });
    }
  }

  if (inspect && inspect.ok === false && inspect.error) {
    out.push({
      id: id(),
      severity: "high",
      title: "Activity feed error",
      detail: String(inspect.error),
    });
  }

  if (inspect?.ok && Array.isArray(inspect.signatures) && inspect.signatures.length >= 4) {
    const sigs = inspect.signatures;
    const failed = sigs.filter((row) => row.err).length;
    const ratio = failed / sigs.length;
    if (ratio >= 0.35) {
      out.push({
        id: id(),
        severity: "medium",
        title: "On-chain failures spiking",
        detail: `${Math.round(ratio * 100)}% of sampled txs failed — could be congestion, routing, or program risk.`,
      });
    }
  }

  const hasActionable = out.some((a) => ["critical", "high", "medium"].includes(a.severity));
  const hasContext = out.some((a) => a.severity === "info");
  if (!hasActionable && !hasContext) {
    out.push({
      id: id(),
      severity: "low",
      title: "No automated anomalies",
      detail: "Alerts re-check on the live polling interval — tune windows if you need stricter signals.",
    });
  }

  return out;
}
