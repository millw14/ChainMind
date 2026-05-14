/**
 * Structured verdict card: merge Groq JSON with deterministic signals from user evidence.
 */

/**
 * @param {string} s
 * @param {number} [head]
 * @param {number} [tail]
 */
export function shortenIdCompact(s, head = 4, tail = 4) {
  const t = String(s ?? "").trim();
  if (!t) return "—";
  if (t.length <= head + tail + 1) return t;
  return `${t.slice(0, head)}…${t.slice(-tail)}`;
}

/**
 * @param {unknown} v
 * @returns {string[]}
 */
function toStringArray(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

/** @param {unknown} s */
function normalizeSeverityLabel(s) {
  const u = String(s ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
  if (["HIGH", "MEDIUM", "LOW", "SKIPPED", "NOT_FETCHED", "NOT FETCHED", "UNKNOWN"].includes(u)) return u;
  if (u === "MED") return "MEDIUM";
  if (u === "NONE" || u === "—" || u === "-") return "LOW";
  return "MEDIUM";
}

/**
 * @param {unknown} raw
 * @returns {{ name: string, value: string, severity: string }[] | null}
 */
export function normalizeSignalsArray(raw) {
  if (!Array.isArray(raw)) return null;
  /** @type {{ name: string, value: string, severity: string }[]} */
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const name = String(item.name ?? "").trim() || "Signal";
    const value = String(item.value ?? "—").trim() || "—";
    const severity = normalizeSeverityLabel(item.severity);
    out.push({ name, value, severity });
  }
  return out.length ? out : null;
}

/**
 * @param {ReturnType<import("./groq-user-evidence.js").buildGroqUserEvidence>} ev
 * @returns {{ name: string, value: string, severity: string }[]}
 */
export function deriveSignalsFromUserEvidence(ev) {
  /** @type {{ name: string, value: string, severity: string }[]} */
  const signals = [];

  const n = typeof ev.sampledTxCount === "number" ? ev.sampledTxCount : 0;
  const failed = Array.isArray(ev.signatures) ? ev.signatures.filter((s) => s?.failed).length : 0;

  if (n > 0 && ev.failureRate != null && Number.isFinite(Number(ev.failureRate))) {
    const fr = Number(ev.failureRate);
    const sev = fr >= 0.5 ? "HIGH" : fr >= 0.25 ? "MEDIUM" : "LOW";
    signals.push({ name: "Failure rate", value: String(fr), severity: sev });
    signals.push({
      name: "Failed tx count",
      value: String(failed),
      severity: failed >= 12 ? "HIGH" : failed >= 4 ? "MEDIUM" : "LOW",
    });
  } else {
    signals.push({ name: "Failure rate", value: n > 0 ? "—" : "no sample", severity: "NOT_FETCHED" });
    signals.push({ name: "Failed tx count", value: n > 0 ? String(failed) : "—", severity: "NOT_FETCHED" });
  }

  if (ev.coActivityScore != null && Number.isFinite(Number(ev.coActivityScore))) {
    const c = Number(ev.coActivityScore);
    const sev = c >= 0.72 ? "HIGH" : c >= 0.45 ? "MEDIUM" : "LOW";
    signals.push({ name: "Co-activity score", value: String(c), severity: sev });
  } else {
    signals.push({ name: "Co-activity score", value: "—", severity: "NOT_FETCHED" });
  }

  const fg = ev.fundingGraph;
  const fgStatus = fg && typeof fg === "object" ? String(fg.status ?? "") : "";
  if (fgStatus === "attached") {
    signals.push({ name: "Funding graph", value: "ATTACHED", severity: "LOW" });
  } else {
    signals.push({ name: "Funding graph", value: "SKIPPED", severity: "SKIPPED" });
  }

  const ag = ev.accountAge;
  const agStatus = ag && typeof ag === "object" ? String(ag.status ?? "") : "";
  if (agStatus && agStatus !== "not_fetched") {
    const pd = ag.payersWithData;
    const pe = ag.payersExamined;
    const y = ag.youngWalletsUnder7d;
    const val =
      pd != null && pe != null
        ? `${pd}/${pe} payers w/ first-tx; ${y ?? 0} younger than 7d`
        : String(ag.note ?? agStatus).slice(0, 48);
    const sev =
      y != null && pe != null && y >= Math.ceil(Number(pe) * 0.4)
        ? "HIGH"
        : agStatus === "partial"
          ? "MEDIUM"
          : "LOW";
    signals.push({
      name: "Account age",
      value: val,
      severity: sev,
    });
  } else {
    signals.push({ name: "Account age", value: "NOT FETCHED", severity: "NOT_FETCHED" });
  }

  return signals;
}

/**
 * @param {ReturnType<import("./groq-user-evidence.js").buildGroqUserEvidence>} ev
 * @returns {string[]}
 */
export function deriveLimitingFactorsFromEvidence(ev) {
  /** @type {string[]} */
  const out = [];
  const fg = ev.fundingGraph;
  const fgStatus = fg && typeof fg === "object" ? String(fg.status ?? "") : "";
  if (fgStatus !== "attached") {
    out.push("Funding graph skipped — shared-funder conclusions capped until graph backfill lands.");
  }
  const ag = ev.accountAge;
  const agStatus = ag && typeof ag === "object" ? String(ag.status ?? "") : "";
  if (agStatus === "not_fetched") {
    out.push("Account age not in export — wallet-age hypothesis limited.");
  } else if (agStatus === "partial") {
    out.push("Partial wallet first-tx coverage — backfill more payers or increase CHAINMIND_WALLET_AGE_MAX_FETCH.");
  }
  return out;
}

/**
 * Model wins on name collision (case-insensitive).
 * @param {{ name: string, value: string, severity: string }[]} model
 * @param {{ name: string, value: string, severity: string }[]} derived
 */
export function mergeSignalsByName(model, derived) {
  const m = new Map();
  for (const s of derived) m.set(s.name.toLowerCase(), { ...s });
  for (const s of model) m.set(s.name.toLowerCase(), { ...s });
  return [...m.values()];
}

/**
 * @param {Record<string, unknown>} analysis normalized from Groq
 * @param {ReturnType<import("./groq-user-evidence.js").buildGroqUserEvidence>} userEvidence
 * @returns {Record<string, unknown>}
 */
export function enrichAnalysisWithVerdictStructure(analysis, userEvidence) {
  const derived = deriveSignalsFromUserEvidence(userEvidence);
  const modelSignals = normalizeSignalsArray(analysis.signals);
  /** @type {{ name: string, value: string, severity: string }[]} */
  let signals;
  if (modelSignals?.length) {
    signals = mergeSignalsByName(modelSignals, derived);
  } else {
    signals = derived;
  }

  const lfModel = toStringArray(analysis.limiting_factors);
  const lfDerived = deriveLimitingFactorsFromEvidence(userEvidence);
  const limitingSet = new Set([...lfDerived, ...lfModel].map((s) => s.trim()).filter(Boolean));
  const limiting_factors = [...limitingSet];

  /** @type {Record<string, unknown>} */
  const out = { ...analysis, signals, limiting_factors };
  if (typeof analysis.confidence === "number" && Number.isFinite(analysis.confidence)) {
    const c = Math.min(1, Math.max(0, analysis.confidence));
    out.confidence_pct = Math.round(c * 100);
  } else if (typeof analysis.confidence_pct === "number" && Number.isFinite(analysis.confidence_pct)) {
    out.confidence_pct = Math.round(analysis.confidence_pct);
  }

  return out;
}
