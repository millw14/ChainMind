import { NextResponse } from "next/server";
import { after } from "next/server";
import { clientIp, isSameOriginRequest, rateLimit } from "@/lib/api-guard.js";
import { SESSION_COOKIE, readSessionCookie } from "@/lib/session.js";
import { recordVisit } from "@/lib/usage.js";

export const runtime = "nodejs";

// One visitor firing this on every page hit would inflate nothing (visits
// de-duplicate per day) but would still cost store round trips, so it is capped
// per IP. The beacon also self-limits to once per browser session.
const HITS = 30;
const WINDOW_MS = 60_000;

/** POST — a bare page-visit beacon. No body, no answer beyond ok. */
export async function POST(req) {
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ ok: false }, { status: 403 });
  }
  const ip = clientIp(req);
  const { allowed } = rateLimit(`visit:${ip}`, HITS, WINDOW_MS);
  if (!allowed) return NextResponse.json({ ok: true, skipped: true });

  const session = readSessionCookie(req.cookies.get(SESSION_COOKIE)?.value ?? null);
  const address = session.ok ? session.address : null;

  // After the response: the beacon must never delay the page it fired from.
  after(() => recordVisit({ ip, address }));
  return NextResponse.json({ ok: true });
}
