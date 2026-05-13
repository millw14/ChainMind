import { NextResponse } from "next/server";
import { getGeoqApiKey, geoqFetch } from "@/lib/geoq.js";
import { sendVerdictWebhook } from "@/lib/groq-webhook.js";

export const maxDuration = 60;
export const runtime = "nodejs";

const SYSTEM_PROMPT = `You are a crypto manipulation analyst.
Given on-chain signals, identify coordination patterns, assess confidence, and recommend next investigation steps.

You know these manipulation patterns:
- Coordinated accumulation: multiple wallets buying the same token within tight time windows, often funded from the same source
- Wash trading: the same capital rotating through linked wallets to inflate volume
- Sybil pump: many fresh wallets buying simultaneously with a shared fee payer
- Fake liquidity: LP added and removed in a coordinated way

Rules:
- Use only what appears in the evidence JSON. If shared funding or true wallet age is not in the payload, do not invent it.
- Prefer verdict "suspicious" over "manipulation_detected" unless the numbers clearly support coordination pressure.
- Use verdict "clean" only when evidence is weak or consistent with benign traffic.

Respond with ONLY valid JSON (no markdown fences, no commentary before or after the object):
{
  "verdict": "manipulation_detected | suspicious | clean",
  "confidence": 0.0,
  "reasoning": ["bullet explaining what the signals suggest"],
  "next_steps": ["concrete investigative or data-collection step"]
}

confidence is a number from 0 through 1. reasoning and next_steps must be arrays of short strings (at least one entry each).`;
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

  let reasoning = toStringArray(o.reasoning);
  let next_steps = toStringArray(o.next_steps);
  if (next_steps.length === 0) next_steps = toStringArray(o.nextSteps);

  const key_evidence_legacy = toStringArray(o.key_evidence);
  if (next_steps.length === 0 && key_evidence_legacy.length) {
    next_steps = [...key_evidence_legacy];
  }

  const manipulation_type = MANIP_TYPES.has(o.manipulation_type) ? o.manipulation_type : "none";
  const risk_level = RISK_LEVELS.has(o.risk_level)
    ? o.risk_level
    : inferRiskLevel(verdict, confidence);

  if (reasoning.length === 0) {
    reasoning.push("Model returned no reasoning lines—treat as indeterminate.");
  }
  if (next_steps.length === 0) {
    next_steps.push("Refine score window and pull a wider signature sample; validate against funding tooling when available.");
  }

  return {
    verdict,
    confidence,
    reasoning,
    next_steps,
    manipulation_type,
    risk_level,
    key_evidence: key_evidence_legacy.length ? key_evidence_legacy : next_steps.slice(0, Math.min(5, next_steps.length)),
  };
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

  const payloadText = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const userBlock = truncate(["Analyze:", payloadText, focus ? `\n\nNote:\n${focus}` : ""].join("\n"));

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
        max_tokens: 1024,
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
    return NextResponse.json({ error: String(errMsg).slice(0, 500) }, { status: 502 });
  }

  const text = parsed?.choices?.[0]?.message?.content?.trim();
  if (!text) {
    return NextResponse.json({ error: "Empty completion from Groq" }, { status: 502 });
  }

  let analysis;
  try {
    analysis = normalizeAnalysis(JSON.parse(extractJsonObject(text)));
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
