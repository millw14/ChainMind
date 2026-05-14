import { NextResponse } from "next/server";
import { recomputeCrossMintIntel } from "@/lib/cross-mint-intel.js";
import { getTursoClient } from "@/lib/turso.js";
import { loadWatchlist } from "@/lib/watchlist.js";

export const maxDuration = 120;
export const runtime = "nodejs";

function authorizeCron(request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not set — required for /api/cron/cross-mint-recompute" },
      { status: 503 },
    );
  }
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

/**
 * GET — recompute cross-mint intel only (watchlist scopes from Turso events).
 */
export async function GET(request) {
  const denied = authorizeCron(request);
  if (denied) return denied;

  let scopes;
  try {
    scopes = loadWatchlist();
  } catch (e) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }

  if (!scopes.length) {
    return NextResponse.json(
      { error: "No watchlist scopes — set CHAINMIND_WATCHLIST_JSON or config/watchlist.json" },
      { status: 400 },
    );
  }

  const client = getTursoClient();
  if (!client) {
    return NextResponse.json({ error: "Turso not configured" }, { status: 503 });
  }

  const hours = Math.min(24 * 30, Math.max(1, Number(process.env.SURFACE_SCORE_HOURS ?? 168) || 168));
  const topN = Math.min(48, Math.max(5, Number(process.env.CROSS_MINT_TOP_PAYERS ?? 18) || 18));
  const minCluster = Math.min(24, Math.max(2, Number(process.env.CROSS_MINT_MIN_CLUSTER ?? 3) || 3));

  try {
    const result = await recomputeCrossMintIntel(client, scopes.map((s) => s.address), {
      lookbackHours: hours,
      topN,
      minClusterMembers: minCluster,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message ?? e).slice(0, 800) }, { status: 500 });
  }
}
