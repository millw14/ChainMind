import { NextResponse } from "next/server";
import { getGeoqApiKey, geoqFetch } from "@/lib/geoq.js";
import { clientIp, isSameOriginRequest, rateLimit } from "@/lib/api-guard.js";
import { GUIDANCE, runAsk } from "@/lib/ask-runner.js";

export const maxDuration = 30;
export const runtime = "nodejs";

// This route is the GUARD and the ADAPTER, nothing else.
//
// Everything about how a question gets answered — fast path, model routing, the
// keyword fallback, which status a missed lookup deserves — lives in
// lib/ask-runner.js, because this file imports "next/server" and the "@/" alias
// and so cannot be loaded by `node --test`. What is left here is exactly the
// part that needs a Request: the checks that decide whether any upstream work
// happens at all, and the conversion of { status, body } into a NextResponse.
//
// The gate matters MORE than it used to. The model-routed path costs one
// completion when the model needs no lookup, two in the normal case — the
// routing turn plus the prose turn — and three at its hard ceiling, against the
// single completion the old keyword path always spent. The limit is unchanged
// because it is a per-question limit and questions are what users send; but a
// permitted question is now worth up to three times as much upstream, which is
// exactly why nothing below runs before the limiter has.
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

// Input spend is bounded here by question length; the evidence budget and the
// answer's max_tokens are bounded in lib/ask-runner.js and lib/ask-loop.js.
const MAX_QUESTION_CHARS = 500;

/**
 * One /chat/completions round trip — the client lib/ask-runner.js is given.
 *
 * Throws on failure with `status` and `detail` attached, because the tool loop
 * has to tell "this endpoint will not accept a tools request" (degrade to
 * keyword routing, which still works) from "the upstream is down" (a second
 * completion would only fail again more slowly). A transport error carries
 * status 0.
 */
async function completeChat(payload) {
  let res;
  try {
    res = await geoqFetch("/chat/completions", { method: "POST", body: JSON.stringify(payload) });
  } catch (e) {
    const err = new Error(String(e?.message ?? e));
    err.status = 0;
    throw err;
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const err = new Error(`Groq ${res.status}`);
    err.status = res.status;
    err.detail = detail.slice(0, 500);
    throw err;
  }
  const body = await res.json().catch(() => null);
  if (!body) {
    const err = new Error("Groq returned a body that was not JSON.");
    err.status = 502;
    throw err;
  }
  return body;
}

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

  // `target` is optional. Most real questions — "what are the top stocks by
  // market cap", "what's trending" — name nothing to look up, and rejecting them
  // for it was the product answering five questions in eight. Only a request
  // carrying neither a question nor a target has nothing to work with.
  const target = String(body?.target ?? "").trim();
  if (!question && !target) {
    return NextResponse.json(
      { ok: false, error: `Ask a question, or provide an address — ${GUIDANCE}.` },
      { status: 400 },
    );
  }

  try {
    getGeoqApiKey(); // fail fast with a clear message if unconfigured
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
  }

  // runAsk returns its failures rather than throwing them, so there is nothing
  // left to catch: every outcome is already a { status, body } this can send.
  const { status, body: payload } = await runAsk({ question, target, chat: completeChat });
  return NextResponse.json(payload, { status });
}
