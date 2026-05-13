import { NextResponse } from "next/server";
import { getGeoqApiKey, geoqFetch } from "@/lib/geoq.js";

export const maxDuration = 60;
export const runtime = "nodejs";

const SYSTEM_PROMPT = `You are ChainMind, an on-chain manipulation detection analyst for Solana.

You know these manipulation patterns:
- Coordinated accumulation: multiple wallets buying same token within tight time windows, funded from same source
- Wash trading: same capital rotating through linked wallets to inflate volume
- Sybil pump: many fresh wallets (<72h old) buying simultaneously with shared fee payer
- Fake liquidity: LP positions opened and removed in coordinated fashion

You receive one JSON object of computed evidence (fee-payer concentration, co-activity score, transaction samples, alerts, etc.). Some fields may be missing or explicitly state that shared funding / true wallet age was not computed—do not infer those signals. Prefer lower confidence or verdict "suspicious" over "manipulation_detected" when the payload does not support a pattern. Use manipulation_type "none" and verdict "clean" only when evidence is weak or consistent with benign traffic.

You must respond with ONLY valid JSON (no markdown fences, no commentary before or after the object):
{
  "verdict": "manipulation_detected | suspicious | clean",
  "confidence": 0.0,
  "manipulation_type": "coordinated_accumulation | wash_trade | sybil_pump | none",
  "risk_level": "critical | high | medium | low",
  "reasoning": ["point 1", "point 2", "point 3"],
  "key_evidence": ["specific data point that triggered this"]
}

Rules: confidence is a number from 0 through 1. reasoning and key_evidence must be arrays of strings (at least one entry each when you have any signal; use cautious language in strings).`;

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
  const manipulation_type = MANIP_TYPES.has(o.manipulation_type) ? o.manipulation_type : "none";
  const risk_level = RISK_LEVELS.has(o.risk_level) ? o.risk_level : "medium";
  const reasoning = Array.isArray(o.reasoning)
    ? o.reasoning.map((x) => String(x).trim()).filter(Boolean)
    : [];
  const key_evidence = Array.isArray(o.key_evidence)
    ? o.key_evidence.map((x) => String(x).trim()).filter(Boolean)
    : [];

  if (reasoning.length === 0) {
    reasoning.push("Model returned no reasoning lines—treat as indeterminate.");
  }
  if (key_evidence.length === 0) {
    key_evidence.push("No explicit evidence strings returned.");
  }

  return { verdict, confidence, manipulation_type, risk_level, reasoning, key_evidence };
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

  const { data, focus } = body ?? {};
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
  const userBlock = truncate(
    [focus ? `Analyst focus: ${focus}\n\n` : "", "Structured evidence (JSON):\n", payloadText].join(""),
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

  return NextResponse.json({ analysis, model });
}
