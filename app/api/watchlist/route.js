import { NextResponse } from "next/server";

import { loadWatchlist } from "@/lib/watchlist.js";

export const runtime = "nodejs";

/**
 * GET — watchlist addresses for dashboard multi-focus (no secrets; scopes are public pubkeys).
 */
export async function GET() {
  try {
    const scopes = loadWatchlist();
    return NextResponse.json({
      ok: true,
      scopes: scopes.map((s) => ({ address: s.address, note: s.note ?? null })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
  }
}
