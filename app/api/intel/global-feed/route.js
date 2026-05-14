import { NextResponse } from "next/server";
import { buildGlobalIntelFeed } from "@/lib/intel-global-feed.js";
import { getTursoClient } from "@/lib/turso.js";

export const maxDuration = 30;
export const runtime = "nodejs";

/**
 * GET ranked global intel: cross-mint overlaps, persisted clusters, surface hits.
 * Query: limit (default 32), lookbackHours (optional filter on cross_mint_pair rows).
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") ?? 32) || 32));
  const lbRaw = searchParams.get("lookbackHours");
  const lookbackHours =
    lbRaw === null || lbRaw === "" ? null : Math.min(24 * 30, Math.max(1, Number(lbRaw) || 168));

  const client = getTursoClient();
  if (!client) {
    return NextResponse.json({
      ok: true,
      database: "unconfigured",
      feed: null,
      hint: "Set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN. Apply schema for intel_* tables.",
    });
  }

  try {
    const feed = await buildGlobalIntelFeed(client, { limit, lookbackHours });
    return NextResponse.json({ ok: true, database: "turso", ...feed });
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/no such table/i.test(msg)) {
      return NextResponse.json({
        ok: true,
        database: "turso",
        entries: [],
        hint: "Run npm run turso:schema (intel_* tables in schema/migrations/008_intel_cross_mint.sql).",
        errorDetail: msg.slice(0, 200),
      });
    }
    return NextResponse.json({ ok: false, error: msg.slice(0, 800) }, { status: 500 });
  }
}
