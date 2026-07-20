import { NextResponse } from "next/server";
import { getTursoClient, tursoFetchSurfaceHits } from "@/lib/turso.js";

export const maxDuration = 15;
export const runtime = "nodejs";

/**
 * GET recent autonomous surface hits (Turso `surface_hits`), newest first.
 * Populated by Vercel Cron → `/api/cron/surface-scan`.
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") ?? 24) || 24));
  const offset = Math.min(10_000, Math.max(0, Number(searchParams.get("offset") ?? 0) || 0));

  const client = getTursoClient();
  if (!client) {
    return NextResponse.json({
      ok: true,
      database: "unconfigured",
      hits: [],
      hint: "Connect Turso and run surface-scan cron to populate surface_hits.",
    });
  }

  try {
    // Fetch one extra row past the page so hasMore is exact without a COUNT.
    const rows = await tursoFetchSurfaceHits(client, limit + 1, offset);
    return NextResponse.json({
      ok: true,
      database: "turso",
      hits: rows.slice(0, limit),
      hasMore: rows.length > limit,
      limit,
      offset,
    });
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/no such table/i.test(msg)) {
      return NextResponse.json({
        ok: true,
        database: "turso",
        hits: [],
        hint: "Apply schema/migrations/005_surface_hits.sql (or turso.sql) to create surface_hits.",
      });
    }
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
