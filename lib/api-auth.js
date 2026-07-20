import crypto from "node:crypto";
// .js suffix so plain `node --test` can resolve the module too (next has no
// exports map, and bare "next/server" only resolves through the bundler).
import { NextResponse } from "next/server.js";

/**
 * Constant-time compare of an Authorization header against `Bearer <secret>`.
 * timingSafeEqual requires equal-length buffers, so length mismatch is an early
 * (non-secret-dependent) reject.
 * @param {string | null | undefined} authHeader
 * @param {string} secret
 */
function bearerMatches(authHeader, secret) {
  const expected = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(String(authHeader ?? ""));
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

/**
 * Vercel Cron guard (shared by all /api/cron/* routes): 503 when CRON_SECRET is
 * unset, 401 on a bad Bearer token, null when authorized.
 * @param {Request} request
 * @param {string} routeLabel e.g. "/api/cron/analyst-sweep" — used in the 503 hint
 * @returns {NextResponse | null}
 */
export function requireCronAuth(request, routeLabel) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return NextResponse.json(
      { error: `CRON_SECRET is not set — add it in Vercel env to enable ${routeLabel}` },
      { status: 503 },
    );
  }
  const auth = request.headers.get("authorization") ?? "";
  if (!bearerMatches(auth, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

/**
 * Operator-level Bearer check for write/expensive endpoints. Accepts
 * CHAINMIND_OPERATOR_SECRET plus any route-specific legacy secrets (env var
 * names) so existing GROQ_BRIEF_SECRET / CASE_CREATE_SECRET setups keep working.
 * @param {Request} request
 * @param {string[]} [legacyEnvKeys]
 */
export function hasOperatorAuth(request, legacyEnvKeys = []) {
  const auth = request.headers.get("authorization");
  if (!auth) return false;
  for (const key of ["CHAINMIND_OPERATOR_SECRET", ...legacyEnvKeys]) {
    const secret = process.env[key]?.trim();
    if (secret && bearerMatches(auth, secret)) return true;
  }
  return false;
}

/**
 * Best-effort "this came from our own dashboard in a browser" check — NOT a hard
 * auth boundary (headers are client-settable), but it keeps interactive flows
 * working with no secret configured while shutting out naive scripted abuse.
 * True when the browser marked the fetch same-origin, or the Origin header
 * matches NEXT_PUBLIC_APP_URL.
 * @param {Request} request
 */
export function isSameOriginBrowser(request) {
  if (request.headers.get("sec-fetch-site") === "same-origin") return true;
  const origin = request.headers.get("origin");
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (origin && appUrl) {
    try {
      return new URL(origin).origin === new URL(appUrl).origin;
    } catch {
      return false;
    }
  }
  return false;
}

/** First hop of x-forwarded-for — per-IP rate-limit key for public endpoints. */
export function clientIp(request) {
  return (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}
