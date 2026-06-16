import { NextResponse } from "next/server";
import { getGeoqApiKey, geoqFetch } from "@/lib/geoq.js";
import { sendVerdictWebhook } from "@/lib/groq-webhook.js";
import {
  enrichAnalysisWithVerdictStructure,
  inferRiskLevelFromTriVerdict,
  normalizePatternStr,
  normalizeTopEvidenceArray,
  normalizeTriVerdict,
  normalizeVerdictWindow,
} from "@/lib/groq-verdict-card.js";
import { buildGroqEvidenceBlockText } from "@/lib/groq-evidence-block.js";
import { buildGroqUserEvidence } from "@/lib/groq-user-evidence.js";
import { buildGroqBriefUserContent, GROQ_BRIEF_SYSTEM_PROMPT } from "@/lib/groq-brief-prompts.js";
import {
  getTursoClient,
  tursoFetchRecentCaseVerdictsForScope,
  tursoFetchLastGroqAnalysis,
  tursoInsertGroqAnalysisLog,
} from "@/lib/turso.js";
import { stableEvidenceHash } from "@/lib/evidence-hash.js";

export const maxDuration = 60;
export const runtime = "nodejs";

function truncate(s, max = 12000) {
  const t = String(s);
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n…[truncated]`;
}

/**
 * @param {string} content
 */
function extractJsonObject(content) {
  const t = String(content).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) return t.slice(start, end + 1).trim();
  return t;
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

/**
 * @param {unknown} raw
 */
function normalizeAnalysis(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Analysis is not an object");
  }
  /** @type {any} */
  const o = raw;

  const verdict = normalizeTriVerdict(o.verdict);
  let confidence = Number(o.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.min(1, Math.max(0, confidence));

  const pattern = normalizePatternStr(o.pattern, o.manipulation_type);

  let scope = typeof o.scope === "string" ? o.scope.trim() : "";
  if (!scope && typeof o.scope_address === "string") scope = o.scope_address.trim();

  const windowObj = normalizeVerdictWindow(o, null);

  let confidence_reasoning =
    typeof o.confidence_reasoning === "string"
      ? o.confidence_reasoning.trim()
      : typeof o.confidenceReasoning === "string"
        ? o.confidenceReasoning.trim()
        : "";

  let named_entities = toStringArray(o.named_entities);
  if (named_entities.length === 0) named_entities = toStringArray(o.namedEntities);

  let manipulation_vs_benign = "";
  if (typeof o.manipulation_vs_benign === "object" && o.manipulation_vs_benign !== null) {
    // New schema: { for: "...", against: "..." }
    const f = o.manipulation_vs_benign.for ?? o.manipulation_vs_benign.FOR ?? "";
    const a = o.manipulation_vs_benign.against ?? o.manipulation_vs_benign.AGAINST ?? "";
    if (f || a) {
      manipulation_vs_benign = `FOR: ${f} | AGAINST: ${a}`;
    } else {
      try {
        manipulation_vs_benign = JSON.stringify(o.manipulation_vs_benign);
      } catch {
        manipulation_vs_benign = "";
      }
    }
  } else if (typeof o.manipulation_vs_benign === "string") {
    manipulation_vs_benign = o.manipulation_vs_benign.trim();
  } else if (typeof o.manipulationVsBenign === "string") {
    manipulation_vs_benign = o.manipulationVsBenign.trim();
  }

  let reasoning = toStringArray(o.reasoning);
  let next_steps = toStringArray(o.next_steps);
  if (next_steps.length === 0) next_steps = toStringArray(o.nextSteps);

  let next_action = typeof o.next_action === "string" ? o.next_action.trim() : "";
  if (!next_action && typeof o.nextAction === "string") next_action = o.nextAction.trim();

  const key_evidence_legacy = toStringArray(o.key_evidence);
  if (next_steps.length === 0 && key_evidence_legacy.length) {
    next_steps = [...key_evidence_legacy];
  }
  if (!next_action && next_steps.length) next_action = next_steps[0];

  if (!confidence_reasoning && reasoning.length) {
    confidence_reasoning = reasoning.join(" ");
  }
  if (!confidence_reasoning) {
    confidence_reasoning = "Model did not return confidence_reasoning — treat calibration as unknown.";
  }

  if (reasoning.length === 0) {
    reasoning = [confidence_reasoning];
  } else if (confidence_reasoning && !reasoning.some((r) => r.includes(confidence_reasoning.slice(0, 40)))) {
    reasoning = [confidence_reasoning, ...reasoning];
  }

  if (named_entities.length === 0) {
    named_entities.push("(none returned — re-prompt or widen inspect sample)");
  }

  if (!manipulation_vs_benign) {
    manipulation_vs_benign = "No manipulation_vs_benign field returned.";
  }

  if (next_steps.length === 0) {
    next_steps.push("Pull signatures listed in evidence and trace the first fee payer on Solscan.");
  }

  const manipulation_type =
    typeof o.manipulation_type === "string" && o.manipulation_type.trim()
      ? o.manipulation_type.trim()
      : typeof o.manipulationType === "string" && o.manipulationType.trim()
        ? o.manipulationType.trim()
        : "none";

  const risk_level = inferRiskLevelFromTriVerdict(verdict, confidence);

  const rawSignals = Array.isArray(o.signals) ? o.signals : [];
  let top_evidence = normalizeTopEvidenceArray(o.top_evidence ?? o.topEvidence);
  let flags = toStringArray(o.flags);

  let limiting_factors = toStringArray(o.limiting_factors);
  if (limiting_factors.length === 0) limiting_factors = toStringArray(o.limitingFactors);

  /** @type {Record<string, unknown>} */
  const base = {
    verdict,
    confidence,
    pattern,
    scope: scope || null,
    window: windowObj,
    signals: rawSignals,
    top_evidence,
    next_action: next_action || "",
    flags,
    confidence_reasoning,
    named_entities,
    manipulation_vs_benign,
    reasoning,
    next_steps,
    manipulation_type,
    risk_level,
    limiting_factors,
    key_evidence: key_evidence_legacy.length
      ? key_evidence_legacy
      : [...named_entities.filter((x) => x.startsWith("(") === false), ...next_steps].slice(0, 8),
  };
  return base;
}
function webhookConfidenceThreshold() {
  const raw = process.env.CHAINMIND_WEBHOOK_MIN_CONFIDENCE?.trim();
  if (raw === undefined || raw === "") return 0.7;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.7;
}

/**
 * Hours within which an unchanged scope reuses its cached verdict instead of
 * calling Groq again. 0 (or unset → default) disables the cache.
 * @returns {number}
 */
function groqReanalyzeMinHours() {
  const raw = process.env.CHAINMIND_GROQ_REANALYZE_MIN_HOURS?.trim();
  if (raw === undefined || raw === "") return 6;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 6;
}

/** Sources eligible for the verdict cache — non-interactive paths only. */
const CACHEABLE_SOURCES = new Set(["auto", "auto_investigation_case", "case"]);

/**
 * @param {unknown} data
 */
function pickEvidenceAddress(data) {
  if (data && typeof data === "object" && "address" in data) {
    const a = /** @type {{ address?: string }} */ (data).address;
    if (typeof a === "string" && a.trim()) return a.trim();
  }
  return null;
}

export async function POST(request) {
  const briefSecret = process.env.GROQ_BRIEF_SECRET?.trim();
  if (briefSecret) {
    const auth = request.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${briefSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { data, focus, source } = body ?? {};
  if (data === undefined || data === null) {
    return NextResponse.json(
      { error: "Expected JSON body with a `data` field (object or string)" },
      { status: 400 },
    );
  }

  try {
    getGeoqApiKey();
  } catch {
    return NextResponse.json({ error: "GROQ_API_KEY is not configured" }, { status: 503 });
  }

  const userEvidence =
    typeof data === "object" && data !== null
      ? buildGroqUserEvidence(data)
      : { error: "Expected object snapshot", raw: typeof data === "string" ? data.slice(0, 500) : null };

  let priorVerdicts = [];
  const evidenceAddr = pickEvidenceAddress(data);
  if (evidenceAddr && userEvidence && typeof userEvidence === "object" && !("error" in userEvidence)) {
    const turso = getTursoClient();
    if (turso) {
      try {
        priorVerdicts = await tursoFetchRecentCaseVerdictsForScope(turso, evidenceAddr, 3);
      } catch (e) {
        console.error("[groq-brief] prior verdicts", e);
      }
    }
  }

  const evidenceForPrompt =
    userEvidence && typeof userEvidence === "object" && !("error" in userEvidence)
      ? { ...userEvidence, priorVerdicts }
      : userEvidence;

  // Verdict cache: reuse a recent analysis for the same scope + unchanged evidence
  // instead of calling Groq again. Covers dashboard auto-invoke, cron sweep, and case
  // auto-Groq — the non-interactive paths that drive most consumption.
  const minHours = groqReanalyzeMinHours();
  const evidenceHash = stableEvidenceHash(data);
  const cacheEligible =
    minHours > 0 && evidenceAddr && CACHEABLE_SOURCES.has(String(source ?? ""));
  if (cacheEligible) {
    const turso = getTursoClient();
    if (turso) {
      try {
        const last = await tursoFetchLastGroqAnalysis(turso, evidenceAddr);
        const ageHours = last ? (Date.now() / 1000 - last.created_at) / 3600 : Infinity;
        if (last && last.evidence_hash === evidenceHash && ageHours < minHours) {
          return NextResponse.json({
            analysis: last.analysis,
            model: last.model ?? null,
            cached: true,
            cache: { ageHours: Math.round(ageHours * 100) / 100, reason: "recent_unchanged_evidence" },
            webhook: { attempted: false, skipped: true },
          });
        }
      } catch (e) {
        console.error("[groq-brief] verdict cache read", e);
      }
    }
  }

  const evidenceNarrative = buildGroqEvidenceBlockText(
    evidenceForPrompt && typeof evidenceForPrompt === "object" ? evidenceForPrompt : {},
  );
  const userBlock = truncate(
    buildGroqBriefUserContent(evidenceNarrative, JSON.stringify(evidenceForPrompt, null, 2), focus),
  );

  const model = process.env.GROQ_MODEL?.trim() || "llama-3.3-70b-versatile";

  let groqRes;
  try {
    groqRes = await geoqFetch("/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: GROQ_BRIEF_SYSTEM_PROMPT },
          { role: "user", content: userBlock },
        ],
        temperature: 0.15,
        max_tokens: 2048,
      }),
    });
  } catch (e) {
    console.error("[groq-brief] fetch", e);
    return NextResponse.json({ error: "Groq request failed" }, { status: 502 });
  }

  const raw = await groqRes.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("[groq-brief] non-JSON Groq response", raw.slice(0, 500));
    return NextResponse.json({ error: "Invalid response from Groq" }, { status: 502 });
  }

  if (!groqRes.ok) {
    const errMsg = parsed?.error?.message ?? parsed?.message ?? groqRes.statusText;
    console.error("[groq-brief] Groq error", groqRes.status, errMsg);
    const status = groqRes.status === 429 ? 429 : 502;
    const cap = status === 429 ? 8000 : 500;
    return NextResponse.json({ error: String(errMsg).slice(0, cap) }, { status });
  }

  const text = parsed?.choices?.[0]?.message?.content?.trim();
  if (!text) {
    return NextResponse.json({ error: "Empty completion from Groq" }, { status: 502 });
  }

  let analysis;
  try {
    const parsedAnalysis = JSON.parse(extractJsonObject(text));
    // Post-process: remove shared-funder signal if no actual shared funders in evidence
    const evidenceFg = typeof data === "object" && data !== null ? data?.fundingGraph : null;
    const hasRealSharedFunders =
      Array.isArray(evidenceFg?.sharedInboundFunders) && evidenceFg.sharedInboundFunders.length > 0;
    if (!hasRealSharedFunders && Array.isArray(parsedAnalysis.signals)) {
      parsedAnalysis.signals = parsedAnalysis.signals.filter(
        (s) => !(typeof s === "object" && String(s?.type ?? "").includes("shared-funder")),
      );
      // If verdict was escalate but shared-funder was the key signal, downgrade
      const remainingWeight = parsedAnalysis.signals.reduce(
        (sum, s) => sum + (Number(s?.weight) || 0),
        0,
      );
      if (remainingWeight < 0.6 && parsedAnalysis.verdict === "escalate") {
        parsedAnalysis.verdict = "monitor";
        parsedAnalysis.confidence = Math.min(0.55, Number(parsedAnalysis.confidence) || 0.5);
      }
    }
    analysis = normalizeAnalysis(parsedAnalysis);
    analysis = enrichAnalysisWithVerdictStructure(analysis, evidenceForPrompt);
    analysis.model = model;
    if (!analysis.analyzed_at || typeof analysis.analyzed_at !== "string") {
      analysis.analyzed_at = new Date().toISOString();
    }
  } catch (e) {
    console.error("[groq-brief] parse analysis", e, text.slice(0, 800));
    return NextResponse.json(
      { error: "Model did not return valid JSON analysis" },
      { status: 502 },
    );
  }

  const evidenceAddress = pickEvidenceAddress(data);

  /** @type {{ attempted: boolean, delivered?: boolean, skipped?: boolean, error?: string }} */
  const webhook = { attempted: false };

  if ((source === "auto" || source === "auto_investigation_case") && analysis.confidence > webhookConfidenceThreshold()) {
    webhook.attempted = true;
    const payload = {
      event: "chainmind.high_confidence_verdict",
      timestamp: new Date().toISOString(),
      source: "auto",
      address: evidenceAddress,
      coActivityScore:
        data && typeof data === "object" && "coActivityScore" in data
          ? /** @type {{ coActivityScore?: number }} */ (data).coActivityScore
          : null,
      analysis,
      model,
    };
    const wh = await sendVerdictWebhook(payload);
    if (wh.skipped) {
      webhook.skipped = true;
    } else if (wh.ok) {
      webhook.delivered = true;
    } else {
      webhook.error = wh.error ?? `HTTP ${wh.status ?? "?"}`;
      console.error("[groq-brief] webhook", webhook.error);
    }
  }

  // Record this verdict so future calls for the same scope + unchanged evidence
  // can be served from cache (mirrors the read gate above).
  if (cacheEligible) {
    const turso = getTursoClient();
    if (turso) {
      try {
        await tursoInsertGroqAnalysisLog(turso, {
          scope_address: evidenceAddress ?? evidenceAddr,
          evidence_hash: evidenceHash,
          source: typeof source === "string" ? source : null,
          model,
          verdict: typeof analysis.verdict === "string" ? analysis.verdict : null,
          confidence: typeof analysis.confidence === "number" ? analysis.confidence : null,
          analysis,
        });
      } catch (e) {
        console.error("[groq-brief] verdict cache write", e);
      }
    }
  }

  return NextResponse.json({ analysis, model, webhook });
}
