import { NextResponse } from "next/server";
import { getGeoqApiKey, geoqFetch } from "@/lib/geoq.js";

export const maxDuration = 60;
export const runtime = "nodejs";

const SYSTEM = `You are an analyst copilot for on-chain activity review.
You receive a single JSON object of computed evidence (address, coActivityScore 0–1, timeWindow, distinctFeePayers, walletAges with fee-payer event counts — not chain inception ages unless stated, fundingOverlap string, signatures with failure flags, optional automatedAlerts, topPrograms, etc.).
Treat it as lab results: reference specific fields and values. If fundingOverlap says shared funding is not computed, do not invent shared-source claims.
Write a short, factual briefing: what the numbers suggest, what is uncertain, and 2–4 concrete next checks.
Do not claim legal proof, fraud, or manipulation—use wording like "suggests further review" or "consistent with coordination only if…".
Keep the answer under 300 words unless the user asks for more detail.`;

function truncate(s, max = 12000) {
  const t = String(s);
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n…[truncated]`;

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
    [focus ? `Analyst focus: ${focus}\n` : "", "Context (metrics / API output):\n", payloadText].join(""),
  );

  const model = process.env.GROQ_MODEL?.trim() || "llama-3.3-70b-versatile";

  let groqRes;
  try {
    groqRes = await geoqFetch("/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: userBlock },
        ],
        temperature: 0.2,
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

  return NextResponse.json({ text, model });
}
