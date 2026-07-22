import { NextResponse } from "next/server";
import { getGeoqApiKey, geoqFetch } from "@/lib/geoq.js";
import { gatherEvidence } from "@/lib/ask-evidence.js";
import { getChainConfig } from "@/lib/chain.js";

export const maxDuration = 30;
export const runtime = "nodejs";

const SYSTEM_PROMPT = `You are an on-chain analyst for Robinhood Chain, an Ethereum Layer-2 for tokenized stocks and real-world assets.
You are given a user question and a JSON "evidence" block gathered from the chain's Blockscout indexer.
Answer in plain, conversational English that a Robinhood trader (not an engineer) can understand.

Rules:
- Ground every claim in the evidence. Never invent balances, tokens, counterparties, or transactions.
- If the evidence does not contain what's needed, say so plainly instead of guessing.
- Prefer 2-5 short sentences. Lead with the direct answer, then the supporting detail.
- Refer to ETH amounts and token symbols exactly as given. Shorten 0x addresses to first 6 + last 4 chars.
- Do not give financial advice or price predictions.`;

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Body must be JSON." }, { status: 400 });
  }

  const question = String(body?.question ?? "").trim();
  const target = String(body?.target ?? "").trim();
  if (!target) {
    return NextResponse.json(
      { ok: false, error: "Provide a `target` (0x address or transaction hash)." },
      { status: 400 },
    );
  }

  try {
    getGeoqApiKey(); // fail fast with a clear message if unconfigured
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
  }

  const gathered = await gatherEvidence(target);
  if (!gathered.ok) {
    return NextResponse.json({ ok: false, error: gathered.error, kind: gathered.kind }, { status: 404 });
  }

  const userQuestion = question || `Explain this ${gathered.kind} in plain English.`;
  const userContent = `Question: ${userQuestion}

Target: ${gathered.target} (${gathered.kind})
Network: ${getChainConfig().name}

Evidence (JSON):
${JSON.stringify(gathered.evidence, null, 2)}`;

  const model = process.env.GROQ_MODEL?.trim() || "llama-3.3-70b-versatile";

  let groqRes;
  try {
    groqRes = await geoqFetch("/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `Groq request failed: ${String(e?.message ?? e)}` }, { status: 502 });
  }

  if (!groqRes.ok) {
    const detail = await groqRes.text().catch(() => "");
    return NextResponse.json(
      { ok: false, error: `Groq ${groqRes.status}`, detail: detail.slice(0, 500) },
      { status: 502 },
    );
  }

  const groqJson = await groqRes.json().catch(() => null);
  const answer = groqJson?.choices?.[0]?.message?.content?.trim() ?? null;
  if (!answer) {
    return NextResponse.json({ ok: false, error: "Empty answer from model." }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    kind: gathered.kind,
    target: gathered.target,
    answer,
    evidence: gathered.evidence,
    model,
  });
}
