import { NextResponse } from "next/server";
import { appBaseUrl } from "@/lib/app-base-url.js";
import { runAnalystSweepForScope } from "@/lib/analyst-sweep-run.js";
import { loadWatchlist } from "@/lib/watchlist.js";

export const maxDuration = 300;
export const runtime = "nodejs";

/**
 * Secured scheduled sweep: Vercel Cron sends Authorization: Bearer CRON_SECRET when env is set.
 * @param {Request} request
 */
function authorizeCron(request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not set — add it in Vercel env to enable /api/cron/analyst-sweep" },
      { status: 503 },
    );
  }
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

function truthyEnv(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

/**
 * Runs on Vercel Cron (GET).
 * - Default: single scope from CHAINMIND_CRON_SCOPE or CHAINMIND_SCOPE.
 * - Watchlist mode: set CHAINMIND_ANALYST_SWEEP_WATCHLIST=1 — runs every watchlist address (capped by ANALYST_SWEEP_MAX_SCOPES).
 * If co-activity > GROQ_AUTO_CO_ACTIVITY, POSTs to /api/groq-brief (source=auto) per scope.
 */
export async function GET(request) {
  const denied = authorizeCron(request);
  if (denied) return denied;

  const useWatchlist = truthyEnv(process.env.CHAINMIND_ANALYST_SWEEP_WATCHLIST);
  const maxScopes = Math.min(24, Math.max(1, Number(process.env.ANALYST_SWEEP_MAX_SCOPES ?? 8) || 8));
  const groqDelayMs = Math.min(5000, Math.max(0, Number(process.env.ANALYST_SWEEP_GROQ_DELAY_MS ?? 350) || 0));

  const window = Math.min(60, Math.max(1, Number(process.env.CHAINMIND_CRON_SCORE_WINDOW ?? 5) || 5));
  const hours = Math.min(24 * 30, Math.max(1, Number(process.env.CHAINMIND_CRON_SCORE_HOURS ?? 168) || 168));
  const inspectLimit = Math.min(100, Math.max(1, Number(process.env.CHAINMIND_CRON_INSPECT_LIMIT ?? 12) || 12));

  const base = appBaseUrl();

  if (useWatchlist) {
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
            "Watchlist mode enabled but no scopes — set CHAINMIND_WATCHLIST_JSON (Vercel) or config/watchlist.json / CHAINMIND_SCOPE",
        },
        { status: 400 },
      );
    }
    const slice = scopes.slice(0, maxScopes);
    /** @type {unknown[]} */
    const results = [];
    let groqCalls = 0;
    let skipped = 0;
    for (const { address } of slice) {
      const scope = String(address ?? "").trim();
      if (!scope) continue;
      const one = await runAnalystSweepForScope({ baseUrl: base, scope, window, hours, inspectLimit });
      results.push(one);
      if (one.ok && !one.skipped) groqCalls++;
      if (one.skipped) skipped++;
      if (groqDelayMs > 0 && one.ok && !one.skipped) {
        await new Promise((r) => setTimeout(r, groqDelayMs));
      }
    }
    return NextResponse.json({
      ok: true,
      mode: "watchlist",
      scanned: slice.length,
      groqInvocations: groqCalls,
      skippedBelowThreshold: skipped,
      maxScopes,
      results,
    });
  }

  const scope = (process.env.CHAINMIND_CRON_SCOPE || process.env.CHAINMIND_SCOPE || "").trim();
  if (!scope) {
    return NextResponse.json(
      {
        error:
          "Set CHAINMIND_CRON_SCOPE or CHAINMIND_SCOPE, or enable CHAINMIND_ANALYST_SWEEP_WATCHLIST=1 with a configured watchlist",
      },
      { status: 400 },
    );
  }

  const one = await runAnalystSweepForScope({ baseUrl: base, scope, window, hours, inspectLimit });
  if (!one.ok && one.skipped === undefined) {
    const status = one.error === "score_failed" ? 502 : one.error === "groq_brief_failed" ? 502 : 500;
    return NextResponse.json(one, { status });
  }
  if (one.skipped) {
    return NextResponse.json({ ok: true, mode: "single", ...one });
  }
  return NextResponse.json({ ok: true, mode: "single", ...one });
}
