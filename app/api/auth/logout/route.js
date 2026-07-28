import { NextResponse } from "next/server";
import { isSameOriginRequest } from "@/lib/api-guard.js";
import { clearedCookie, PRE_SESSION_COOKIE, SESSION_COOKIE } from "@/lib/session.js";

export const runtime = "nodejs";
export const maxDuration = 10;

/**
 * POST — sign out.
 *
 * POST rather than GET so a prefetch, an <img> tag on another site or a link in
 * an email cannot log the user out. Same-origin checked for the same reason.
 *
 * Always 200, even with no session to clear: logout has no failure worth telling
 * the caller about, and "there was nothing to log out" is not information a
 * third-party page should be able to fish for.
 *
 * Nothing is deleted server-side. Sessions are stateless signed cookies, so
 * dropping the cookie IS the logout. A session already copied off the machine
 * stays valid until it expires — the reason the expiry is a day and not a month.
 */
export async function POST(request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Not allowed from this origin." }, { status: 403 });
  }
  const res = NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  for (const name of [SESSION_COOKIE, PRE_SESSION_COOKIE]) {
    const cleared = clearedCookie(name);
    res.cookies.set(cleared.name, cleared.value, cleared.options);
  }
  return res;
}
