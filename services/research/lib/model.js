import { GEOQ_OPENAI_BASE } from "../../../lib/geoq.js";

/**
 * ONE /chat/completions ROUND TRIP, WITH THE UPSTREAM'S OWN CONTRACT.
 *
 * The same seam lib/ask-runner.js uses and for the same reason: the loop takes a
 * `complete(payload)` function rather than reaching for `fetch` itself, so every branch of
 * lib/loop.js — a tool call, a refusal, a cap, an injection attempt — is testable offline
 * against a scripted fake with no API key and no network. A loop that could only be
 * exercised against the real model would have no tests worth the name.
 *
 * WHY IT IS NOT lib/geoq.js's geoqFetch UNCHANGED. That helper is built for a request
 * inside lib/request-budget.js's 24-second web budget and clamps its own timeout against
 * it. This service has no such budget — a research job runs for minutes on purpose — and it
 * needs the response's `usage` block back to charge the token cap, which a raw Response
 * does not give without a second read. So the base URL is shared (one constant, not two)
 * and the transport around it is this service's own.
 *
 * THROWS on transport and HTTP failure, with `status` attached — the contract the loop's
 * error handling is written against. 0 means the request never got an answer.
 *
 * Server-side only: no React.
 */

/** The header a Groq key goes in, and the only header carrying a secret in this service. */
function authHeaders(apiKey) {
  return { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
}

/**
 * @param {{ apiKey: string, timeoutMs?: number, fetcher?: Function }} options
 * @returns {(payload: object) => Promise<object>} resolves to the parsed response body
 */
export function createModelClient({ apiKey, timeoutMs = 60_000, fetcher } = {}) {
  const key = String(apiKey ?? "").trim();
  const call = typeof fetcher === "function" ? fetcher : fetch;

  return async function complete(payload) {
    if (!key) {
      const e = new Error("No GROQ_API_KEY is configured, so no completion can be requested.");
      e.status = 0;
      throw e;
    }
    let res = null;
    try {
      res = await call(`${GEOQ_OPENAI_BASE}/chat/completions`, {
        method: "POST",
        headers: authHeaders(key),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch (cause) {
      const e = new Error(`The model endpoint could not be reached: ${String(cause?.message ?? cause).slice(0, 200)}`);
      e.status = 0;
      throw e;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const e = new Error(`The model endpoint answered HTTP ${res.status}`);
      e.status = res.status;
      e.detail = detail.slice(0, 600);
      throw e;
    }
    return res.json();
  };
}
