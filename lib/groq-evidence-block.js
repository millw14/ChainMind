/**
 * Human-readable "Evidence Block" for Groq user messages (layer 2), derived from the same snapshot as {@link buildGroqUserEvidence}.
 *
 * @param {Record<string, unknown>} userEvidence — output of buildGroqUserEvidence, optionally with priorVerdicts attached
 * @param {{ priorVerdicts?: unknown[] }} [opts]
 * @returns {string}
 */
export function buildGroqEvidenceBlockText(userEvidence, opts = {}) {
  const e = userEvidence && typeof userEvidence === "object" ? userEvidence : {};
  const priorRaw = opts.priorVerdicts ?? e.priorVerdicts;
  const priorVerdicts = Array.isArray(priorRaw) ? priorRaw : [];

  const address = typeof e.scopeAddress === "string" && e.scopeAddress.trim() ? e.scopeAddress.trim() : "(unknown)";
  const lookbackHours =
    typeof e.lookbackHours === "number" && Number.isFinite(e.lookbackHours) ? String(Math.round(e.lookbackHours)) : "?";

  const durationMin = parseDurationMinutes(e.timeWindow) ?? null;
  const peakStartIso =
    typeof e.peakBucketStartsIso === "string" && e.peakBucketStartsIso.trim() ? e.peakBucketStartsIso.trim() : null;

  let windowStart = peakStartIso;
  let windowEnd = null;
  if (peakStartIso && durationMin != null && durationMin > 0) {
    const ms = Date.parse(peakStartIso);
    if (Number.isFinite(ms)) {
      windowEnd = new Date(ms + durationMin * 60 * 1000).toISOString();
    }
  }

  if (!windowStart) {
    windowStart = inferNewestSignatureIso(e.signatures);
  }
  if (!windowEnd && windowStart && durationMin != null && durationMin > 0) {
    const ms = Date.parse(windowStart);
    if (Number.isFinite(ms)) windowEnd = new Date(ms + durationMin * 60 * 1000).toISOString();
  }

  const durationLabel = durationMin != null && durationMin > 0 ? String(durationMin) : "?";

  /** @type {unknown[]} */
  const sigSample = Array.isArray(e.signatures)
    ? [...e.signatures]
        .filter((x) => x && typeof x === "object")
        .sort((a, b) => {
          const ta = isoSec((/** @type {any} */ (a)).blockTimeIso);
          const tb = isoSec((/** @type {any} */ (b)).blockTimeIso);
          return tb - ta;
        })
        .slice(0, 24)
    : [];
  const n = sigSample.length;

  const uniquePayers =
    e.distinctFeePayersWholeWindow != null && Number.isFinite(Number(e.distinctFeePayersWholeWindow))
      ? String(Math.round(Number(e.distinctFeePayersWholeWindow)))
      : e.distinctFeePayersPeak != null && Number.isFinite(Number(e.distinctFeePayersPeak))
        ? String(Math.round(Number(e.distinctFeePayersPeak)))
        : "?";

  const peakCount =
    e.peakBucketWalletCount != null && Number.isFinite(Number(e.peakBucketWalletCount))
      ? String(Math.round(Number(e.peakBucketWalletCount)))
      : e.distinctFeePayersPeak != null && Number.isFinite(Number(e.distinctFeePayersPeak))
        ? String(Math.round(Number(e.distinctFeePayersPeak)))
        : "?";

  const peakTime = peakStartIso ?? "n/a";

  let overlapLine = "n/a (not computed)";
  if (typeof e.payerOverlapPriorWindowsPct === "number" && Number.isFinite(e.payerOverlapPriorWindowsPct)) {
    overlapLine = `${formatPct(e.payerOverlapPriorWindowsPct)}%`;
  }

  /** @type {unknown[]} */
  const edges = Array.isArray(e.transferEdgesSample)
    ? e.transferEdgesSample.filter((x) => x && typeof x === "object")
    : [];

  const windowStartDisp = windowStart ?? "unknown";
  const windowEndDisp = windowEnd ?? "unknown";

  const lines = [
    "You are analyzing the following on-chain window:",
    "",
    `SCOPE: ${address}`,
    `WINDOW: ${windowStartDisp} → ${windowEndDisp} (${durationLabel}m)`,
    `LOOKBACK: ${lookbackHours}h`,
    "",
    `SIGNATURE SAMPLE (most recent ${n}):`,
    safeJsonPretty(sigSample),
    "",
    "PAYER ACTIVITY:",
    `- Unique fee payers: ${uniquePayers}`,
    `- Peak payers in ${durationLabel}m bucket: ${peakCount} at ${peakTime}`,
    `- Payer overlap with prior windows: ${overlapLine}`,
    "",
    "TRANSFER EDGES (parsed):",
    safeJsonPretty(edges),
    "",
    "PRIOR VERDICTS ON THIS SCOPE (last 3):",
    safeJsonPretty(priorVerdicts.length ? priorVerdicts : []),
  ];

  return lines.join("\n");
}

/**
 * @param {unknown} timeWindow e.g. "5min"
 * @returns {number | null}
 */
function parseDurationMinutes(timeWindow) {
  if (timeWindow == null) return null;
  const s = String(timeWindow).trim();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*min/i);
  if (m) return Math.round(Number(m[1]));
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** @param {unknown} v */
function isoSec(v) {
  if (typeof v !== "string" || !v.trim()) return 0;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/** @param {unknown} signatures */
function inferNewestSignatureIso(signatures) {
  if (!Array.isArray(signatures)) return null;
  let best = 0;
  let bestIso = null;
  for (const s of signatures) {
    if (!s || typeof s !== "object") continue;
    const iso = /** @type {any} */ (s).blockTimeIso;
    if (typeof iso !== "string" || !iso.trim()) continue;
    const sec = isoSec(iso);
    if (sec >= best) {
      best = sec;
      bestIso = iso.trim();
    }
  }
  return bestIso;
}

/** @param {unknown} data */
function safeJsonPretty(data) {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return "[]";
  }
}

/** @param {number} x */
function formatPct(x) {
  return String(Math.round(x * 10) / 10);
}
