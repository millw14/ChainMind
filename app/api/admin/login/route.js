import { NextResponse } from "next/server";
import { clientIp, isSameOriginRequest, rateLimit } from "@/lib/api-guard.js";
import {
  clearedAdminCookie,
  createAdminCookie,
  isAdminConfigured,
  verifyAdminPassword,
} from "@/lib/admin-auth.js";

export const runtime = "nodejs";

// A slow, quiet brute force is the only attack on a single password, so the login
// is rate limited hard per IP — five tries a minute, same window shape as /api/ask.
const TRIES = 5;
const WINDOW_MS = 60_000;

function setCookie(res, cookie) {
  res.cookies.set(cookie.name, cookie.value, cookie.options);
  return res;
}

/** POST { password } — exchange the operator password for a signed admin cookie. */
export async function POST(req) {
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ ok: false, error: "Cross-origin requests are not allowed." }, { status: 403 });
  }
  if (!isAdminConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Admin is not configured. Set ADMIN_PASSWORD (and SESSION_SECRET) in the environment." },
      { status: 503 },
    );
  }
  const { allowed } = rateLimit(`admin-login:${clientIp(req)}`, TRIES, WINDOW_MS);
  if (!allowed) {
    return NextResponse.json({ ok: false, error: "Too many attempts. Wait a minute and try again." }, { status: 429 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Body must be JSON." }, { status: 400 });
  }

  if (!verifyAdminPassword(body?.password)) {
    return NextResponse.json({ ok: false, error: "Wrong password." }, { status: 401 });
  }
  return setCookie(NextResponse.json({ ok: true }), createAdminCookie());
}

/** DELETE — log out of the admin surface. */
export async function DELETE(req) {
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ ok: false, error: "Cross-origin requests are not allowed." }, { status: 403 });
  }
  return setCookie(NextResponse.json({ ok: true }), clearedAdminCookie());
}
