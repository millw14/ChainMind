import { timingSafeEqual } from "node:crypto";

/**
 * THE ONLY THING BETWEEN THIS SERVICE AND THE INTERNET.
 *
 * A render service with no auth is an open proxy that runs the caller's JavaScript on
 * this host, from this host's IP, and hands back a screenshot. Every one of those is
 * something a stranger would like: SSRF-by-proxy, IP laundering, and a free browser.
 * So the check is unconditional, it happens before anything reads the body, and there
 * is no unauthenticated path except the health check.
 *
 * WHY A SHARED SECRET AND NOT SOMETHING GRANDER. The only client is ChainMind's own
 * server, one hop away, over TLS. A bearer secret both sides hold is exactly strong
 * enough for that, and it has the property that matters most for this deployment: it
 * is the ONLY credential in the process, so a full compromise of the browser yields a
 * token that grants the ability to render a page and nothing else. An OAuth client or
 * a signing key would be a more valuable thing to steal, for no more safety.
 *
 * WHY THE COMPARISON IS TIMING-SAFE. `a === b` on strings returns as soon as two bytes
 * differ, so the time it takes leaks how many leading bytes were right, and a remote
 * caller with enough samples recovers the secret one byte at a time. timingSafeEqual
 * reads both buffers whole. The length is compared separately and unavoidably leaks —
 * which is why lib/config.js enforces a minimum length rather than trusting secrecy of
 * the length.
 *
 * PURE apart from the crypto import, so every branch is testable with no server.
 * Server-side only: no React.
 */

/** The header this service reads, and the only one. */
export const AUTH_HEADER = "authorization";

/**
 * Whether a request carries the shared secret.
 *
 * `reason` is for the SERVICE'S OWN LOG, never for the response body: telling an
 * unauthenticated caller whether the header was missing, malformed or merely wrong is
 * telling them how close they got. server.js answers every failure with the same bare
 * 401.
 *
 * @param {unknown} headerValue - the raw Authorization header
 * @param {unknown} secret - the configured shared secret
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function checkAuth(headerValue, secret) {
  const expected = typeof secret === "string" ? secret : "";
  if (!expected) {
    // Belt and braces behind lib/config.js, which refuses to start without a secret.
    // If this is ever reached, the safe answer is to authenticate nobody rather than
    // to authenticate everybody.
    return { ok: false, reason: "no shared secret is configured, so no caller can be authenticated" };
  }

  const raw = typeof headerValue === "string" ? headerValue.trim() : "";
  if (!raw) return { ok: false, reason: "no Authorization header" };

  const m = /^Bearer\s+(.+)$/i.exec(raw);
  if (!m) return { ok: false, reason: "the Authorization header is not a Bearer token" };

  const presented = m[1].trim();
  if (!presented) return { ok: false, reason: "the Bearer token is empty" };

  // Compared as bytes, not characters: a secret is an opaque byte string and a
  // multi-byte character must not make two different secrets compare equal.
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return { ok: false, reason: "the presented token is the wrong length" };
  if (!timingSafeEqual(a, b)) return { ok: false, reason: "the presented token does not match" };
  return { ok: true, reason: null };
}
