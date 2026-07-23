import { NextResponse } from "next/server";
import { getGeoqApiKey, geoqFetch } from "@/lib/geoq.js";
import { gatherEvidence } from "@/lib/ask-evidence.js";
import { getChainConfig } from "@/lib/chain.js";
import { clientIp, isSameOriginRequest, rateLimit } from "@/lib/api-guard.js";

export const maxDuration = 30;
export const runtime = "nodejs";

// Every accepted request spends Groq tokens and fires several Blockscout calls,
// so the route is gated before any upstream work happens.
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

// Input and output token spend are both bounded: the question by length, the
// serialized evidence by a backstop truncation, the answer by max_tokens.
const MAX_QUESTION_CHARS = 500;
const MAX_EVIDENCE_CHARS = 24_000;
const MAX_ANSWER_TOKENS = 700;

const SYSTEM_PROMPT = `You are an on-chain analyst for Robinhood Chain, an Ethereum Layer-2 for tokenized stocks and real-world assets.
You are given a user question and a JSON "evidence" block gathered from the chain's Blockscout indexer.
Answer in plain, conversational English that a Robinhood trader (not an engineer) can understand.

Rules:
- Ground every claim in the evidence. Never invent balances, tokens, counterparties, transactions, prices, or holders.
- If the evidence does not contain what's needed, say so plainly instead of guessing.
- Be thorough and specific — surface the notable facts that are present: for a token, cover name/symbol/type, total supply, holder count, price/market cap/24h volume if present, top holders and how concentrated ownership is, contract verification, and recent transfer activity; for a wallet, cover its ETH balance, notable token holdings and their USD value, how active it is, and who it interacts with; for a transaction, what it did, success/failure, method, tokens moved, and fee.
- Lead with a direct one-line answer, then give the supporting detail. When there are several facts, use short bullet points so it's scannable. Don't pad, but don't omit useful specifics that are in the evidence.
- Refer to ETH/USD amounts and token symbols exactly as given. Shorten 0x addresses to first 6 + last 4 chars.
- Do not give financial advice or price predictions.`;

export async function POST(req) {
  // Requiring a JSON content-type takes the route out of CORS "simple request"
  // territory: a cross-origin page now needs a preflight we never answer.
  if (!String(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return NextResponse.json(
      { ok: false, error: "Content-Type must be application/json." },
      { status: 415 },
    );
  }

  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ ok: false, error: "Cross-origin requests are not allowed." }, { status: 403 });
  }

  const { allowed } = rateLimit(clientIp(req), RATE_LIMIT, RATE_WINDOW_MS);
  if (!allowed) {
    return NextResponse.json(
      { ok: false, error: `Too many questions — limit is ${RATE_LIMIT} per minute. Try again shortly.` },
      { status: 429 },
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Body must be JSON." }, { status: 400 });
  }

  const question = String(body?.question ?? "").trim();
  if (question.length > MAX_QUESTION_CHARS) {
    return NextResponse.json(
      { ok: false, error: `Question is too long — keep it under ${MAX_QUESTION_CHARS} characters.` },
      { status: 400 },
    );
  }

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
  // Backstop only — the evidence shape is already capped per list, but a token
  // with a pathological field shouldn't be able to inflate the prompt.
  const evidenceJson = JSON.stringify(gathered.evidence, null, 2).slice(0, MAX_EVIDENCE_CHARS);
  const userContent = `Question: ${userQuestion}

Target: ${gathered.target} (${gathered.kind})
Network: ${getChainConfig().name}

Evidence (JSON):
${evidenceJson}`;

  const model = process.env.GROQ_MODEL?.trim() || "llama-3.3-70b-versatile";

  let groqRes;
  try {
    groqRes = await geoqFetch("/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: MAX_ANSWER_TOKENS,
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
