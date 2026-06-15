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
 * Tri-state verdict (analyst workflow).
 * @param {unknown} v
 */
export function normalizeTriVerdict(v) {
  const t = String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s|]+/g, "");
  if (t === "escalate" || t === "monitor" || t === "dismiss") return t;
  const u = String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (u === "manipulation_detected") return "escalate";
  if (u === "suspicious") return "monitor";
  if (u === "clean") return "dismiss";
  return "monitor";
}

const PATTERN_SET = new Set([
  "coordinated-accumulation",
  "wash-rotation",
  "sybil-pump",
  "time-synchronized-burst",
  "organic",
  "unknown",
]);

/**
 * @param {unknown} p
 * @param {unknown} legacyManipType
 */
export function normalizePatternStr(p, legacyManipType) {
  const s = String(p ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (PATTERN_SET.has(s)) return s;
  const m = String(legacyManipType ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (m === "coordinated_accumulation") return "coordinated-accumulation";
  if (m === "wash_trade" || m === "wash_rotation") return "wash-rotation";
  if (m === "sybil_pump") return "sybil-pump";
  if (m === "none" || !m) return "unknown";
  return "unknown";
}

/**
 * Same shape as POST /api/groq-brief normalizeAnalysis: object
 * { for, against } (or FOR/AGAINST) → one line for dashboard / cards.
 *
 * @param {unknown} v
 * @returns {string}
 */
export function normalizeManipulationVsBenignField(v) {
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    const o = /** @type {Record<string, unknown>} */ (v);
    const fRaw = o.for ?? o.FOR ?? "";
    const aRaw = o.against ?? o.AGAINST ?? "";
    const f = String(fRaw ?? "").trim();
    const a = String(aRaw ?? "").trim();
    if (f || a) return `FOR: ${f} | AGAINST: ${a}`;
    try {
      return JSON.stringify(v);
    } catch {
      return "";
    }
  }
  if (typeof v === "string") return v.trim();
  return "";
}

/**
 * @param {Record<string, unknown>} o raw model object
 * @param {number | null} fallbackDurationMinutes
 */
export function normalizeVerdictWindow(o, fallbackDurationMinutes) {
  const w = o.window;
  if (w && typeof w === "object") {
    /** @type {any} */
    const win = w;
    let start = String(win.start ?? "").trim();
    let end = String(win.end ?? "").trim();
    let dm = Number(win.duration_minutes);
    if ((!Number.isFinite(dm) || dm <= 0) && start && end) {
      const a = Date.parse(start);
      const b = Date.parse(end);
      if (Number.isFinite(a) && Number.isFinite(b)) dm = Math.max(0, Math.round((b - a) / 60000));
    }
    if (!Number.isFinite(dm)) dm = 0;
    if (!end) end = new Date().toISOString();
    if (!start && fallbackDurationMinutes != null && Number.isFinite(fallbackDurationMinutes) && fallbackDurationMinutes > 0) {
      start = new Date(Date.now() - fallbackDurationMinutes * 60000).toISOString();
    }
    if (!start) start = new Date(Date.now() - Math.max(dm, 1) * 60000).toISOString();
    if (!Number.isFinite(dm) || dm <= 0) {
      const a = Date.parse(start);
      const b = Date.parse(end);
      if (Number.isFinite(a) && Number.isFinite(b)) dm = Math.max(0, Math.round((b - a) / 60000));
    }
    return { start, end, duration_minutes: dm };
  }
  const dm =
    fallbackDurationMinutes != null && Number.isFinite(fallbackDurationMinutes)
      ? Math.round(fallbackDurationMinutes)
      : 0;
  const end = new Date().toISOString();
  const start = new Date(Date.now() - Math.max(dm, 1) * 60000).toISOString();
  return { start, end, duration_minutes: dm };
}

/**
 * @param {unknown} raw
 */
export function normalizeTopEvidenceArray(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {{ signature: string, slot: number, actor: string, action: string }[]} */
  const out = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const sig = String(/** @type {any} */ (row).signature ?? "").trim();
    if (!sig) continue;
    const slot = Number(/** @type {any} */ (row).slot);
    out.push({
      signature: sig,
      slot: Number.isFinite(slot) ? slot : 0,
      actor: String(/** @type {any} */ (row).actor ?? "").trim() || "—",
      action: String(/** @type {any} */ (row).action ?? "").trim() || "—",
    });
  }
  return out.slice(0, 12);
}

/**
 * @param {unknown} raw
 * @returns {{ type: string, weight: number, detail: string }[]}
 */
export function normalizeWeightedSignalsArray(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {{ type: string, weight: number, detail: string }[]} */
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    /** @type {any} */
    const it = item;
    if (it.type != null && (it.detail != null || it.weight != null)) {
      let w = Number(it.weight);
      if (!Number.isFinite(w)) w = 0.5;
      w = Math.min(1, Math.max(0, w));
      let ty = String(it.type ?? "unknown").trim().toLowerCase().replace(/\s+/g, "-");
      if (!ty) ty = "unknown";
      out.push({
        type: ty,
        weight: w,
        detail: String(it.detail ?? "").trim() || "—",
      });
      continue;
    }
    const name = String(it.name ?? "").trim() || "signal";
    const value = String(it.value ?? "—").trim();
    const sev = String(it.severity ?? "MEDIUM").toUpperCase();
    const weight = sev === "HIGH" ? 0.85 : sev === "MEDIUM" ? 0.55 : sev === "LOW" ? 0.35 : 0.45;
    const slug = name
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .slice(0, 64);
    out.push({ type: slug || "signal", weight, detail: `${name}: ${value}` });
  }
  return out;
}

/**
 * @param {ReturnType<import("./groq-user-evidence.js").buildGroqUserEvidence>} ev
 * @returns {{ type: string, weight: number, detail: string }[]}
 */
export function deriveWeightedSignalsFromUserEvidence(ev) {
  const derived = deriveSignalsFromUserEvidence(ev);
  // Only call a funding line a "shared-funder" signal when the graph is attached
  // AND carries actual shared funders. A skipped/empty graph is a limiting factor,
  // not evidence of a cluster — labeling it shared-funder re-introduces the
  // false-positive the route's post-process filter is meant to strip.
  const fg = ev.fundingGraph;
  const hasRealSharedFunders =
    fg &&
    typeof fg === "object" &&
    String(fg.status ?? "") === "attached" &&
    Array.isArray(fg.sharedInboundFunders) &&
    fg.sharedInboundFunders.length > 0;
  /** @type {{ type: string, weight: number, detail: string }[]} */
  const out = [];
  for (const s of derived) {
    const ln = s.name.toLowerCase();
    let type = "timing-cluster";
    if (ln.includes("failure") || ln.includes("failed tx")) type = "time-synchronized-burst";
    if (ln.includes("co-activity")) type = "fee-payer-concentration";
    if (ln.includes("funding")) type = hasRealSharedFunders ? "shared-funder" : "funding-graph-skipped";
    if (ln.includes("account")) type = "timing-cluster";
    let w = 0.45;
    if (s.severity === "HIGH") w = 0.72;
    else if (s.severity === "MEDIUM") w = 0.5;
    else if (s.severity === "LOW") w = 0.32;
    else if (s.severity === "SKIPPED" || s.severity === "NOT_FETCHED") w = 0.25;
    out.push({ type, weight: w, detail: `${s.name}: ${s.value}` });
  }
  return out;
}

/**
 * Model entries win on same normalized type key.
 * @param {{ type: string, weight: number, detail: string }[]} model
 * @param {{ type: string, weight: number, detail: string }[]} derived
 */
export function mergeWeightedSignalsByType(model, derived) {
  const m = new Map();
  for (const s of derived) {
    const k = s.type.toLowerCase();
    m.set(k, { ...s });
  }
  for (const s of model) {
    const k = s.type.toLowerCase();
    m.set(k, { ...s });
  }
  return [...m.values()];
}

/**
 * @param {ReturnType<import("./groq-user-evidence.js").buildGroqUserEvidence>} ev
 * @param {number} limit
 */
export function defaultTopEvidenceFromUserEvidence(ev, limit = 5) {
  const sigs = Array.isArray(ev.signatures) ? ev.signatures : [];
  /** @type {{ signature: string, slot: number, actor: string, action: string }[]} */
  const out = [];
  const actor0 = ev.feePayers?.[0] ? String(ev.feePayers[0]) : "—";
  for (const s of sigs.slice(0, limit)) {
    if (!s?.signature) continue;
    out.push({
      signature: String(s.signature),
      slot: s.slot != null && Number.isFinite(Number(s.slot)) ? Number(s.slot) : 0,
      actor: actor0,
      action: s.failed ? "failed tx in inspect sample" : "inspect sample tx",
    });
  }
  return out;
}

/**
 * @param {string} verdict
 * @param {number} confidence
 */
export function inferRiskLevelFromTriVerdict(verdict, confidence) {
  if (verdict === "escalate") return confidence > 0.75 ? "critical" : "high";
  if (verdict === "monitor") return "medium";
  return "low";
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
  const wModel = normalizeWeightedSignalsArray(Array.isArray(analysis.signals) ? analysis.signals : []);
  const wDerived = deriveWeightedSignalsFromUserEvidence(userEvidence);
  const weightedSignals = mergeWeightedSignalsByType(wModel, wDerived);

  const lfModel = toStringArray(analysis.limiting_factors);
  const lfDerived = deriveLimitingFactorsFromEvidence(userEvidence);
  const limitingSet = new Set([...lfDerived, ...lfModel].map((s) => s.trim()).filter(Boolean));
  const limiting_factors = [...limitingSet];

  const hours = userEvidence.lookbackHours != null ? Number(userEvidence.lookbackHours) : null;
  const fallbackMinutes = Number.isFinite(hours) && hours > 0 ? hours * 60 : null;

  /** @type {Record<string, unknown>} */
  const out = { ...analysis, signals: weightedSignals, limiting_factors };

  const scopeFromEv = userEvidence.scopeAddress && String(userEvidence.scopeAddress).trim();
  const scopeStr = typeof out.scope === "string" ? out.scope.trim() : "";
  if (!scopeStr && scopeFromEv) {
    out.scope = scopeFromEv;
  }

  out.window = normalizeVerdictWindow(/** @type {any} */ ({ window: out.window }), fallbackMinutes);

  let top = normalizeTopEvidenceArray(out.top_evidence ?? (/** @type {any} */ (out).topEvidence));
  if (top.length === 0) top = defaultTopEvidenceFromUserEvidence(userEvidence, 5);
  out.top_evidence = top;

  let flags = toStringArray(out.flags);
  if (flags.length === 0) flags = toStringArray((/** @type {any} */ (out).risk_flags));
  out.flags = flags;

  const verdictStr = normalizeTriVerdict(out.verdict);
  out.verdict = verdictStr;
  out.pattern = normalizePatternStr(out.pattern, out.manipulation_type);

  let conf = Number(out.confidence);
  if (!Number.isFinite(conf)) conf = 0.5;
  conf = Math.min(1, Math.max(0, conf));
  out.confidence = conf;
  out.confidence_pct = Math.round(conf * 100);
  out.risk_level = inferRiskLevelFromTriVerdict(verdictStr, conf);

  const nextAction =
    typeof out.next_action === "string"
      ? out.next_action.trim()
      : typeof (/** @type {any} */ (out).nextAction) === "string"
        ? String((/** @type {any} */ (out).nextAction)).trim()
        : "";
  const stepsLegacy = toStringArray(out.next_steps);
  if (nextAction) {
    out.next_action = nextAction;
    out.next_steps = [nextAction, ...stepsLegacy.filter((s) => s && s !== nextAction)].slice(0, 8);
  } else if (stepsLegacy.length) {
    out.next_action = stepsLegacy[0];
    out.next_steps = stepsLegacy;
  } else {
    out.next_action = "Pull top_evidence signatures and trace fee pay on Solscan.";
    out.next_steps = [out.next_action];
  }

  let manipulationVsBenign = normalizeManipulationVsBenignField(
    out.manipulation_vs_benign ?? (/** @type {any} */ (out).manipulationVsBenign),
  );
  if (!manipulationVsBenign) manipulationVsBenign = "No manipulation_vs_benign field returned.";
  out.manipulation_vs_benign = manipulationVsBenign;

  return out;
}
