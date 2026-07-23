/**
 * Groq Cloud API (OpenAI-compatible). Keys use the `gsk_` prefix.
 * Accepts `GROQ_API_KEY` (recommended) or `GEOQ_API_KEY` as an alias.
 */

export const GEOQ_OPENAI_BASE = "https://api.groq.com/openai/v1";

export function getGeoqApiKey() {
  const key = process.env.GROQ_API_KEY || process.env.GEOQ_API_KEY;
  if (!key || !String(key).trim()) {
    throw new Error(
      "Set GROQ_API_KEY (or GEOQ_API_KEY) in the environment — do not commit secrets.",
    );
  }
  return String(key).trim();
}

export function geoqAuthHeaders() {
  return {
    Authorization: `Bearer ${getGeoqApiKey()}`,
    "Content-Type": "application/json",
  };
}

/**
 * Completion budget. Generous — a 700-token answer takes a few seconds — but
 * never unbounded: a stalled upstream must not hold the route open until the
 * platform kills it. A caller-supplied `init.signal` wins.
 */
const TIMEOUT_MS = 20_000;

/**
 * @param {string} path - e.g. "/chat/completions"
 * @param {RequestInit} [init]
 */
export async function geoqFetch(path, init = {}) {
  const url = `${GEOQ_OPENAI_BASE}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = {
    ...geoqAuthHeaders(),
    ...(init.headers && typeof init.headers === "object" ? init.headers : {}),
  };
  return fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), ...init, headers });
}
