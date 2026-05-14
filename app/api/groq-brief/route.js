import { NextResponse } from "next/server";
import { getGeoqApiKey, geoqFetch } from "@/lib/geoq.js";
import { sendVerdictWebhook } from "@/lib/groq-webhook.js";
import { enrichAnalysisWithVerdictStructure, normalizeSignalsArray } from "@/lib/groq-verdict-card.js";
import { buildGroqUserEvidence } from "@/lib/groq-user-evidence.js";

export const maxDuration = 60;
export const runtime = "nodejs";

const SYSTEM_PROMPT = `You are ChainMind, a crypto manipulation analyst for Solana.
You receive structured evidence (metrics, funding graph, optional aiDetection block).
Your job is to:
1. Name specific wallets/signatures in your reasoning — never speak in abstracts.
2. Explain WHY your confidence is the number it is, and what would raise or lower it.
3. Distinguish between manipulation signals vs. benign explanations (congestion, market-maker bots, hot-wallet churn, etc.).
4. Give next steps that name specific entities to investigate (use addresses or transaction signatures from the evidence), not generic actions.

When Evidence.aiDetection is present, it is **pre-computed ChainMind logic** (multiSignal + named detectors detect_wash_rotation, detect_sybil_pump, detect_coordination_cluster). Treat these as labeled features, not ground truth — weigh them against benign alternatives and cite which sub-signals fired.
Patterns to weigh only when the numbers support them: coordinated accumulation, wash rotation, sybil-style payer bursts, coordinated LP moves.
If shared funding or true account age is not in the evidence object, say so explicitly — do not invent it.
When fundingGraph.status is "attached" and sharedInboundFunders is non-empty, treat that as primary evidence of shared provisioning — you may raise confidence materially versus co-activity alone.
When fundingGraph.status is "no_edges" or "not_attached", state that shared-funder conclusions are capped until graph backfill lands.
The Evidence JSON includes entityLedger (id → role labels), fundingGraph, fundingNarrative, accountAge — cite specific ids from entityLedger or signatures/feePayers.

Respond with ONLY valid JSON (no markdown fences, no commentary before or after the object):
{
  "verdict": "manipulation_detected | suspicious | clean",
  "confidence": 0.0,
  "risk_level": "critical | high | medium | low",
  "confidence_reasoning": "short string: why confidence is capped; no long prose — limiting factors go in limiting_factors",
  "signals": [
    { "name": "Failure rate", "value": "0.58", "severity": "HIGH | MEDIUM | LOW | SKIPPED | NOT_FETCHED" }
  ],
  "limiting_factors": ["funding graph skipped", "account age not fetched"],
  "named_entities": ["identifiers only — no sentences; use base58 or signature strings"],
  "manipulation_vs_benign": "one tight contrast line OR two short sentences max",
  "next_steps": ["specific step naming an entity from named_entities or evidence signatures"]
}

confidence is 0..1. risk_level should match verdict + confidence.
signals: align with Evidence.failureRate, sampled txs, coActivityScore, fundingGraph.status, accountAge when possible.
Do NOT paste long paragraph reasoning into confidence_reasoning — keep calibration concise; Evidence JSON has the numbers.
named_entities must be identifiers only (no narrative paragraphs). If evidence is empty, use one honest placeholder entry.`;
const VERDICTS = new Set(["manipulation_detected", "suspicious", "clean"]);
const MANIP_TYPES = new Set(["coordinated_accumulation", "wash_trade", "sybil_pump", "none"]);
const RISK_LEVELS = new Set(["critical", "high", "medium", "low"]);

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
 * @param {string} verdict
 * @param {number} confidence
 */
function inferRiskLevel(verdict, confidence) {
  if (verdict === "manipulation_detected") return confidence > 0.75 ? "critical" : "high";
  if (verdict === "suspicious") return "medium";
  return "low";
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
  const verdict = VERDICTS.has(o.verdict) ? o.verdict : "suspicious";
  let confidence = Number(o.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.min(1, Math.max(0, confidence));

  let confidence_reasoning =
    typeof o.confidence_reasoning === "string"
      ? o.confidence_reasoning.trim()
      : typeof o.confidenceReasoning === "string"
        ? o.confidenceReasoning.trim()
        : "";

  let named_entities = toStringArray(o.named_entities);
  if (named_entities.length === 0) named_entities = toStringArray(o.namedEntities);

  let manipulation_vs_benign = "";
  if (typeof o.manipulation_vs_benign === "string") manipulation_vs_benign = o.manipulation_vs_benign.trim();
  else if (typeof o.manipulationVsBenign === "string") manipulation_vs_benign = o.manipulationVsBenign.trim();
  else if (o.manipulation_vs_benign && typeof o.manipulation_vs_benign === "object") {
    try {
      manipulation_vs_benign = JSON.stringify(o.manipulation_vs_benign);
    } catch {
      manipulation_vs_benign = "";
    }
  }

  let reasoning = toStringArray(o.reasoning);
  let next_steps = toStringArray(o.next_steps);
  if (next_steps.length === 0) next_steps = toStringArray(o.nextSteps);

  const key_evidence_legacy = toStringArray(o.key_evidence);
  if (next_steps.length === 0 && key_evidence_legacy.length) {
    next_steps = [...key_evidence_legacy];
  }

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

  const manipulation_type = MANIP_TYPES.has(o.manipulation_type) ? o.manipulation_type : "none";
  const risk_level = RISK_LEVELS.has(o.risk_level)
    ? o.risk_level
    : inferRiskLevel(verdict, confidence);

  const signals = normalizeSignalsArray(o.signals);
  let limiting_factors = toStringArray(o.limiting_factors);
  if (limiting_factors.length === 0) limiting_factors = toStringArray(o.limitingFactors);

  /** @type {Record<string, unknown>} */
  const base = {
    verdict,
    confidence,
    confidence_reasoning,
    named_entities,
    manipulation_vs_benign,
    reasoning,
    next_steps,
    manipulation_type,
    risk_level,
    signals: signals ?? [],
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

  const userBlock = truncate(
    ["Evidence:", JSON.stringify(userEvidence, null, 2), focus ? `\n\nNote:\n${focus}` : ""].join("\n"),
  );

  const model = process.env.GROQ_MODEL?.trim() || "llama-3.3-70b-versatile";

  let groqRes;
  try {
    groqRes = await geoqFetch("/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userBlock },
        ],
        temperature: 0.15,
        max_tokens: 1536,
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
    analysis = normalizeAnalysis(JSON.parse(extractJsonObject(text)));
    analysis = enrichAnalysisWithVerdictStructure(analysis, userEvidence);
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

  if (source === "auto" && analysis.confidence > webhookConfidenceThreshold()) {
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

  return NextResponse.json({ analysis, model, webhook });
}
