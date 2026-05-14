/**
 * Detection-oriented evidence block for Groq user messages (layer 2).
 * Frames each section around what the model must decide, not prose narrative.
 *
 * @param {Record<string, unknown>} userEvidence — output of buildGroqUserEvidence, optionally with priorVerdicts
 * @param {{ priorVerdicts?: unknown[] }} [opts]
 * @returns {string}
 */
export function buildGroqEvidenceBlockText(userEvidence, opts = {}) {
  const base = userEvidence && typeof userEvidence === "object" ? userEvidence : {};
  const priorMerged = Array.isArray(opts.priorVerdicts)
    ? opts.priorVerdicts
    : Array.isArray(base.priorVerdicts)
      ? base.priorVerdicts
      : [];

  /** @type {Record<string, any>} */
  const ev = { ...base, priorVerdicts: priorMerged };

  const lines = [];

  const scope =
    (typeof ev.address === "string" && ev.address.trim()) ||
    (typeof ev.scopeAddress === "string" && ev.scopeAddress.trim()) ||
    (typeof ev.scope === "string" && ev.scope.trim()) ||
    "unknown";

  lines.push(`SCOPE: ${scope}`);
  lines.push(`CHAIN: Solana`);
  lines.push(`ANALYSIS TIMESTAMP: ${new Date().toISOString()}`);
  lines.push(``);

  const windowMinutes =
    ev.windowMinutes != null && Number.isFinite(Number(ev.windowMinutes))
      ? Math.round(Number(ev.windowMinutes))
      : parseDurationMinutes(ev.timeWindow);
  const bucketLabel =
    windowMinutes != null && windowMinutes > 0 ? String(windowMinutes) : "?";

  const wholePayers = pickUnknown(
    ev.distinctFeePayersWholeWindow,
    ev.distinctPayersWholeWindow,
    ev.distinctPayers,
  );
  const peakCount = pickUnknown(ev.peakBucketWalletCount, ev.distinctFeePayersPeak);
  const peakAt = pickUnknown(ev.peakBucketStartsIso);
  const coNorm = pickUnknown(ev.coActivityScore);
  const v1BucketScore = pickUnknown(ev.distinctFeePayers, ev.score, ev.distinctFeePayersPeak);

  lines.push(`## FEE PAYER CONCENTRATION`);
  lines.push(
    `Detector focus: Does fee-payer concentration, peak bucket density, or funding overlap support coordinated-accumulation or sybil-pump?`,
  );
  lines.push(`Unique fee payers (whole window): ${wholePayers}`);
  lines.push(`Peak payers in single ${bucketLabel}m bucket: ${peakCount} at ${peakAt}`);
  lines.push(`Co-activity score (v1 normalized 0–1): ${coNorm}`);
  lines.push(`V1 max distinct fee payers (single bucket): ${v1BucketScore}`);
  if (typeof ev.payerOverlapPriorWindowsPct === "number" && Number.isFinite(ev.payerOverlapPriorWindowsPct)) {
    lines.push(
      `Payer overlap vs prior windows: ${String(Math.round(ev.payerOverlapPriorWindowsPct * 10) / 10)}%`,
    );
  }
  if (ev.fundingGraph && typeof ev.fundingGraph === "object" && ev.fundingGraph.status === "attached") {
    const shared = Array.isArray(ev.fundingGraph.sharedInboundFunders)
      ? ev.fundingGraph.sharedInboundFunders.length
      : 0;
    lines.push(`Funding graph: attached (sharedInboundFunders sample count ≈ ${shared})`);
  }
  lines.push(``);

  const lookback = fmtHours(ev.lookbackHours, ev.lastHours);
  const eventsCounted = fmtCount(ev.eventsCounted);
  lines.push(`## TIMING`);
  lines.push(
    `Detector focus: Do timestamps / bucket density / drivers support time-synchronized-burst or organic spacing?`,
  );
  lines.push(`Lookback window: ${lookback}h, bucket width: ${bucketLabel}m`);
  lines.push(`Total events counted (ingest scope): ${eventsCounted}`);
  const drivers = Array.isArray(ev.drivers) ? ev.drivers : [];
  if (drivers.length) {
    lines.push(`Scoring drivers (v1):`);
    for (const d of drivers) lines.push(`  - ${String(d)}`);
  } else {
    lines.push(`Scoring drivers: (none in snapshot)`);
  }
  lines.push(``);

  lines.push(`## TOP PROGRAMS CALLED`);
  lines.push(`Detector focus: Does program concentration hint at wash-rotation or scripted routing?`);
  const topPrograms = Array.isArray(ev.topPrograms) ? ev.topPrograms : [];
  if (topPrograms.length) {
    for (const p of topPrograms) {
      const row = p && typeof p === "object" ? p : {};
      const cnt = row.count ?? row.n ?? "?";
      const prog = row.program ?? row.p ?? "?";
      lines.push(`  ${cnt}×  ${prog}`);
    }
  } else {
    lines.push(`  (none)`);
  }
  lines.push(``);

  lines.push(`## EVENT TYPE BREAKDOWN`);
  lines.push(`Detector focus: Which event classes dominate — noise vs coordinated classes?`);
  const tb = ev.typeBreakdown && typeof ev.typeBreakdown === "object" && !Array.isArray(ev.typeBreakdown);
  if (tb) {
    for (const [etype, count] of Object.entries(ev.typeBreakdown)) {
      lines.push(`  ${etype}: ${count}`);
    }
  } else {
    lines.push(`  (none)`);
  }
  lines.push(``);

  lines.push(`## TRANSFER EDGES (parsed sample)`);
  lines.push(
    `Detector focus: Do token / peer edges show value cycling (wash-rotation) or one-off flows?`,
  );
  const edges = Array.isArray(ev.transferEdgesSample)
    ? ev.transferEdgesSample.filter((x) => x && typeof x === "object")
    : [];
  if (edges.length) {
    lines.push(safeJsonPretty(edges.slice(0, 32)));
  } else {
    lines.push(`  (none in snapshot)`);
  }
  lines.push(``);

  lines.push(`## SIGNATURE SAMPLE (most recent)`);
  lines.push(`Detector focus: Which txs anchor top_evidence — failures, bursts, same payers?`);
  const sigs = Array.isArray(ev.signatures) ? ev.signatures : Array.isArray(ev.recentSignatures) ? ev.recentSignatures : [];
  const sorted = [...sigs]
    .filter((s) => s && (typeof s === "string" || typeof s === "object"))
    .sort((a, b) => {
      const sa = typeof a === "string" ? null : /** @type {any} */ (a);
      const sb = typeof b === "string" ? null : /** @type {any} */ (b);
      return isoSec(sb?.blockTimeIso) - isoSec(sa?.blockTimeIso);
    });
  if (sorted.length) {
    for (const s of sorted.slice(0, 20)) {
      lines.push(`  ${typeof s === "string" ? s : JSON.stringify(s)}`);
    }
  } else {
    lines.push(`  (none in snapshot)`);
  }
  lines.push(``);

  lines.push(`## PRIOR VERDICTS ON THIS SCOPE`);
  lines.push(
    `Detector focus: Is recurrence a corroborating signal (see system rule on priorVerdicts)?`,
  );
  const priors = Array.isArray(ev.priorVerdicts) ? ev.priorVerdicts : [];
  if (priors.length) {
    for (const v of priors) {
      const row = v && typeof v === "object" ? /** @type {Record<string, unknown>} */ (v) : {};
      const ts =
        row.analyzed_at != null
          ? String(row.analyzed_at)
          : row.case_created_at != null
            ? String(row.case_created_at)
            : "?";
      lines.push(
        `  [${ts}] verdict=${row.verdict ?? "?"} confidence=${row.confidence ?? "?"} pattern=${row.pattern ?? "?"}`,
      );
    }
  } else {
    lines.push(`  None — first analysis of this scope in saved cases (or no Turso history).`);
  }
  lines.push(``);

  lines.push(`---`);
  lines.push(`Classify the above. Return only the JSON verdict object.`);

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

/** @param {...unknown} xs */
function fmtHours(...xs) {
  for (const x of xs) {
    if (x != null && Number.isFinite(Number(x))) return String(Math.round(Number(x)));
  }
  return "?";
}

/** @param {unknown} x */
function fmtCount(x) {
  if (x != null && Number.isFinite(Number(x))) return String(Math.round(Number(x)));
  return "unknown";
}

/** @param {...unknown} candidates */
function pickUnknown(...candidates) {
  for (const c of candidates) {
    if (c === null || c === undefined) continue;
    if (typeof c === "number" && Number.isFinite(c)) return String(c);
    if (typeof c === "string" && c.trim()) return c.trim();
    if (typeof c === "boolean") return String(c);
  }
  return "unknown";
}

/** @param {unknown} data */
function safeJsonPretty(data) {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return "[]";
  }
}
