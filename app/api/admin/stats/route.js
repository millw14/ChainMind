import { NextResponse } from "next/server";
import { ADMIN_COOKIE, isAdminRequest } from "@/lib/admin-auth.js";
import { readUsage } from "@/lib/usage.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET — the usage snapshot behind the admin cookie. 401 to anyone without it. */
export async function GET(req) {
  if (!isAdminRequest(req.cookies.get(ADMIN_COOKIE)?.value ?? null)) {
    return NextResponse.json({ ok: false, error: "Not authorized." }, { status: 401 });
  }
  const usage = await readUsage();
  return NextResponse.json({ ok: true, usage }, { headers: { "cache-control": "no-store" } });
}
