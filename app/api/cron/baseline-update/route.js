import { NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/api-auth.js";
import { updateBaselinesForWatchlist } from "@/lib/baseline-update-run.js";
import { getTursoClient } from "@/lib/turso.js";
import { loadWatchlist } from "@/lib/watchlist.js";

export const maxDuration = 300;
export const runtime = "nodejs";

/**
 * GET — Vercel Cron (daily). Refreshes `scope_baselines` for every watchlist scope (Turso events).
 */
export async function GET(request) {
  const denied = requireCronAuth(request, "/api/cron/baseline-update");
  if (denied) return denied;

  const client = getTursoClient();
  if (!client) {
    return NextResponse.json(
      { error: "Turso is not configured (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN)" },
      { status: 503 },
    );
  }

  let scopes;
  try {
    scopes = loadWatchlist();
  } catch (e) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }

  if (!scopes.length) {
    return NextResponse.json(
      {
        error:
          "No watchlist scopes — set CHAINMIND_WATCHLIST_JSON (Vercel) or config/watchlist.json / CHAINMIND_SCOPE",
      },
      { status: 400 },
    );
  }

  const windowMinutes = Math.min(
    120,
    Math.max(1, Number(process.env.BASELINE_WINDOW_MINUTES ?? process.env.SCORE_WINDOW_MINUTES ?? "5") || 5),
  );
  const lastHours = Math.min(
    24 * 90,
    Math.max(1, Number(process.env.BASELINE_LOOKBACK_HOURS ?? "168") || 168),
  );

  const results = await updateBaselinesForWatchlist(client, scopes, windowMinutes, { lastHours });

  const okCount = results.filter((r) => r.status === "ok").length;
  const skipCount = results.filter((r) => r.status === "skip").length;

  return NextResponse.json({
    ok: true,
    windowMinutes,
    lastHours,
    scopes: scopes.length,
    updated: okCount,
    skipped: skipCount,
    results,
  });
}
