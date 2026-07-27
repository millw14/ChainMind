import { NextResponse } from "next/server";
import { getGeoqApiKey, geoqFetch } from "@/lib/geoq.js";
import { clientIp, isSameOriginRequest, rateLimit } from "@/lib/api-guard.js";
import { GUIDANCE, runAsk, runAskStream } from "@/lib/ask-runner.js";

export const maxDuration = 30;
export const runtime = "nodejs";

// This route is the GUARD and the ADAPTER, nothing else.
//
// Everything about how a question gets answered — fast path, model routing, the
// keyword fallback, small talk, which status a missed lookup deserves — lives in
// lib/ask-runner.js, because this file imports "next/server" and the "@/" alias
// and so cannot be loaded by `node --test`. What is left here is exactly the
// part that needs a Request: the checks that decide whether any upstream work
// happens at all, and the conversion of the runner's output into a response —
// { status, body } into a NextResponse for a normal request, or a stream of
// events into SSE frames for one that asked for `stream: true`.
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
async function completeChat(payload, signal) {
  const res = await postCompletion(payload, signal);
  const body = await res.json().catch(() => null);
  if (!body) {
    const err = new Error("Groq returned a body that was not JSON.");
    err.status = 502;
    throw err;
  }
  return body;
}

/**
 * ONE streamed /chat/completions round trip — the client lib/ask-runner.js is
 * given for the final answer turn.
 *
 * Same failure contract as completeChat (throws with `status`, transport is 0),
 * because a stream that never starts is an ordinary request failure and the
 * runner's fallbacks depend on being able to tell one from the other. On success
 * it resolves to an async iterable of DECODED SSE text: the runner does the
 * framing, this only turns bytes into strings.
 */
async function streamChat(payload, signal) {
  const res = await postCompletion(payload, signal);
  if (!res.body) {
    const err = new Error("Groq returned no response body to stream.");
    err.status = 502;
    throw err;
  }
  return decodedChunks(res.body);
}

/**
 * Upstream deadline for a streamed turn. The same 20s lib/geoq.js gives every
 * other completion — an `init.signal` REPLACES geoqFetch's own timeout, so
 * forwarding the client's abort signal on its own would quietly remove the only
 * thing that stops a stalled upstream from holding the route open until the
 * platform kills it. 700 output tokens arrive in a few seconds; 20s is a stall.
 */
const STREAM_TIMEOUT_MS = 20_000;

/** The caller's abort signal, still carrying geoqFetch's timeout. */
function withDeadline(signal) {
  const deadline = AbortSignal.timeout(STREAM_TIMEOUT_MS);
  if (!signal) return deadline;
  // AbortSignal.any landed in Node 20.3. On anything older the client's own
  // signal is the better half to keep — a hung-up client is the common case.
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, deadline]) : signal;
}

/** The POST both clients share, with the HTTP failure contract they both need. */
async function postCompletion(payload, signal) {
  let res;
  try {
    res = await geoqFetch("/chat/completions", {
      method: "POST",
      body: JSON.stringify(payload),
      ...(signal ? { signal: withDeadline(signal) } : {}),
    });
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
  return res;
}

/**
 * A byte stream as decoded text, in whatever slices arrive.
 *
 * The reader is released in `finally`, which runs on a normal end AND when the
 * consumer abandons the generator — breaking out of a `for await` calls
 * `.return()` on it. That is the only thing standing between a client hanging up
 * mid-answer and a socket left holding a locked reader nobody will ever read.
 *
 * `decoder.decode(value, { stream: true })` matters: a multi-byte character can
 * be split across two network chunks, and decoding each chunk independently would
 * turn any non-ASCII answer — every Spanish or French one — into mojibake.
 */
async function* decodedChunks(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text) yield text;
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed: nothing to release */
    }
  }
}

/** SSE headers. Every one of them is load-bearing; see the comments. */
const SSE_HEADERS = Object.freeze({
  "Content-Type": "text/event-stream; charset=utf-8",
  // no-transform as well as no-store: a transforming proxy is free to buffer a
  // body it thinks it may rewrite, which is exactly what breaks a stream.
  "Cache-Control": "no-store, no-transform",
  Connection: "keep-alive",
  // nginx (and every proxy that copied it) buffers proxied responses by default,
  // which would hold the whole answer back and deliver it in one piece — the very
  // behaviour streaming exists to remove.
  "X-Accel-Buffering": "no",
});

/**
 * The streaming reply: the runner's events as SSE frames.
 *
 * Three things it must not do, each of which has one line here:
 *  - leave the response open after the answer ends (the frame loop always reaches
 *    `controller.close()` through `finally`);
 *  - keep working for a client that has gone (the request's abort signal is
 *    forwarded to the upstream fetch AND breaks the frame loop, which returns the
 *    generator and so cancels the reader beneath it);
 *  - throw. A rejection inside `start` would tear the response down with no
 *    explanation, so the last resort is an `error` frame.
 */
function streamingResponse(req, { question, target }) {
  // One controller for the whole request: the client hanging up must cancel the
  // routing completion and the streamed one, not just whichever is in flight.
  const upstream = new AbortController();
  const abort = () => upstream.abort();
  if (req.signal) {
    if (req.signal.aborted) upstream.abort();
    else req.signal.addEventListener("abort", abort, { once: true });
  }

  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      let open = true;
      const send = (frame) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        } catch {
          // The consumer is gone. Stop writing rather than throwing per frame.
          open = false;
        }
      };

      const events = runAskStream({
        question,
        target,
        chat: (payload) => completeChat(payload, upstream.signal),
        streamChat: (payload) => streamChat(payload, upstream.signal),
        // Say what is being read while it is being read. A ticker question is
        // ~5.6s of measured indexer time, almost all of it before the first word
        // of the answer exists, and `progress` frames are what the transcript
        // shows instead of three dots for those five seconds. Frames the client
        // does not understand are ignored by it, so this is safe to send to an
        // older bundle sitting in someone's cache.
        progress: true,
      });

      try {
        for await (const event of events) {
          if (upstream.signal.aborted) break;
          send(event);
          if (!open) break;
        }
        if (open && !upstream.signal.aborted) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
      } catch (e) {
        console.error(`[ask] streaming response failed: ${String(e?.stack ?? e)}`);
        send({ type: "error", error: "Something went wrong answering that. Try again.", status: 500 });
      } finally {
        // Breaking or throwing out of the loop above already returns the
        // generator; this is belt and braces for the paths that did neither.
        try {
          await events.return();
        } catch {
          /* already finished */
        }
        req.signal?.removeEventListener?.("abort", abort);
        open = false;
        try {
          controller.close();
        } catch {
          /* already closed by a cancelling consumer */
        }
      }
    },
    cancel() {
      // The client closed the connection: stop paying Groq for an answer nobody
      // is reading.
      upstream.abort();
    },
  });

  return new Response(body, { status: 200, headers: SSE_HEADERS });
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

  // Streaming is opt-in and changes nothing above it: every guard has already
  // run, in the same order, with the same limits. A request that does not ask for
  // a stream gets exactly the JSON reply it always got.
  if (body?.stream === true) {
    return streamingResponse(req, { question, target });
  }

  // runAsk returns its failures rather than throwing them, so there is nothing
  // left to catch: every outcome is already a { status, body } this can send.
  const { status, body: payload } = await runAsk({ question, target, chat: completeChat });
  return NextResponse.json(payload, { status });
}
