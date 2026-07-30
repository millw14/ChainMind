/**
 * The lock on /admin: a single operator password, proven once, then carried in a
 * signed cookie.
 *
 * WHY A PASSWORD AND NOT THE WALLET GATE. The admin surface exists to be reached
 * from any browser the owner happens to be on, including one with no wallet
 * extension. A shared secret in the deploy env is the smallest thing that does
 * that, and it reuses the session HMAC so there is no second signing key to keep.
 *
 * THE COOKIE PROVES A LOGIN, NOT AN IDENTITY. It says "someone presented the
 * admin password before it expired" — nothing more, so there is nothing in it
 * worth stealing beyond the access it grants, and it is signed (not encrypted)
 * for the same reason sessions are. Fails closed: no ADMIN_PASSWORD, or no
 * SESSION_SECRET to sign with, and every check below denies.
 */
import { timingSafeEqual } from "node:crypto";
import { isSessionConfigured, signPayload, verifyPayload } from "./session.js";

export const ADMIN_COOKIE = "cm_admin";
const PURPOSE = "admin";
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

/** The configured password, trimmed; empty counts as unset. */
function adminPassword() {
  const raw = process.env.ADMIN_PASSWORD;
  const s = raw == null ? "" : String(raw).trim();
  return s || null;
}

/** True only when the page can both check a password AND sign a cookie. */
export function isAdminConfigured() {
  return Boolean(adminPassword()) && isSessionConfigured();
}

function ttlMs() {
  const n = Number(process.env.ADMIN_SESSION_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

/**
 * Constant-time compare of a submitted password against the configured one.
 * Length is compared first because timingSafeEqual throws on a length mismatch,
 * and a wrong-length guess must read as a plain rejection.
 */
export function verifyAdminPassword(submitted) {
  const expected = adminPassword();
  if (!expected) return false;
  const a = Buffer.from(String(submitted ?? ""), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function cookieOptions(maxAgeSeconds) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/** The cookie to set after a correct password. Throws only if signing is unconfigured. */
export function createAdminCookie() {
  const now = Date.now();
  const exp = now + ttlMs();
  const value = signPayload(PURPOSE, { v: 1, iat: now, exp });
  return { name: ADMIN_COOKIE, value, options: cookieOptions(Math.floor(ttlMs() / 1000)), expiresAt: exp };
}

/** The cookie that removes the admin cookie. */
export function clearedAdminCookie() {
  return { name: ADMIN_COOKIE, value: "", options: { ...cookieOptions(0), expires: new Date(0) } };
}

/** Whether a cookie value is a live, validly-signed admin session. */
export function isAdminRequest(cookieValue) {
  const res = verifyPayload(PURPOSE, cookieValue);
  return res.ok === true;
}
