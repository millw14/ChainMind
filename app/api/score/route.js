import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { buildTursoScoreBundle } from "@/lib/score-bundle.js";
import {
  getTursoClient,
  tursoAddToScanQueue,
  tursoFetchScoreCache,
  tursoUpsertScoreCache,
  tursoRateLimit,
} from "@/lib/turso.js";
import { openDb } from "@/lib/db.js";
import { computeCoactivityScore } from "@/lib/score-core.js";
import { scoreFromRpc } from "@/lib/score-from-rpc.js";
import { getSolanaConnection } from "@/lib/solana.js";

export const maxDuration = 60;
export const runtime = "nodejs";

/** Cache TTL (s) for score results; 0 disables. */
function scoreCacheTtlSec() {
  const n = Number(process.env.CHAINMIND_SCORE_CACHE_TTL_SEC);
  return Number.isFinite(n) && n >= 0 ? n : 180;
}
/** Per-IP requests/min for the public score endpoint. */
function rateLimitPerMin() {
  const n = Number(process.env.CHAINMIND_RATE_LIMIT_PER_MIN);
  return Number.isFinite(n) && n > 0 ? n : 40;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const scope = String(searchParams.get("scope") ?? searchParams.get("address") ?? "").trim();
  const windowMinutes = Math.min(1440, Math.max(1, Number(searchParams.get("windowMinutes") ?? searchParams.get("window") ?? 5) || 5));
  const lastHours = Math.min(24 * 30, Math.max(1, Number(searchParams.get("lastHours") ?? searchParams.get("hours") ?? 24) || 24));

  if (!scope) {
    return NextResponse.json({ ok: false, error: "Missing ?scope=<base58>" }, { status: 400 });
  }
  try {
    new PublicKey(scope);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid base58 address" }, { status: 400 });
  }

  // Local SQLite fallback — set CHAINMIND_LOCAL_DB=1 in .env.local to use this
  const useLocal = process.env.CHAINMIND_LOCAL_DB === "1";
  if (useLocal) {
    try {
      const db = openDb();
      const result = computeCoactivityScore(db, scope, windowMinutes, lastHours);
      db.close();

      if (!result || result.eventsCounted === 0) {
        return NextResponse.json({
          ok: true,
          empty: true,
          database: "local_sqlite",
          scope,
          windowMinutes,
          lastHours,
          message: "No events in this lookback — run backfill + ingest-events first.",
          fundingGraph: { status: "skipped", reason: "empty_or_insufficient_events" },
          transferEdgesSample: [],
        });
      }

      // Build a minimal but real score bundle from local data
      return NextResponse.json({
        ok: true,
        empty: false,
        database: "local_sqlite",
        scope,
        address: scope,
        windowMinutes,
        lastHours,
        coActivityScore: result.score ?? 0,
        score: result.score ?? 0,
        distinctPayers: result.distinctPayers ?? null,
        distinctPayersWholeWindow: result.distinctPayersWholeWindow ?? null,
        peakBucketWalletCount: result.peakBucketWalletCount ?? null,
        peakBucketStartsIso: result.peakBucketStartsIso ?? null,
        eventsCounted: result.eventsCounted ?? null,
        topPayerLinks: result.topPayerLinks ?? [],
        drivers: result.drivers ?? [],
        typeBreakdown: result.typeBreakdown ?? {},
        topPrograms: result.topPrograms ?? [],
        signatures: result.signatures ?? [],
        fundingGraph: { status: "skipped", reason: "local_mode_no_funding_graph" },
        transferEdgesSample: [],
        walletEvidence: null,
        priorVerdicts: [],
        timeWindow: result.timeWindow ?? null,
      });
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: String(e?.message ?? e) },
        { status: 500 },
      );
    }
  }

  const client = getTursoClient();
  if (!client) {
    return NextResponse.json({
      ok: true,
      empty: true,
      database: "unconfigured",
      fundingGraph: {
        status: "not_attached",
        reason: "database_unconfigured",
        note: "Connect Turso and ingest graph edges to attach fee-payer funding trees.",
      },
      message:
        "Score needs events in Turso. Set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN, apply schema, ingest data.",
      scope,
      windowMinutes,
      lastHours,
    });
  }

  // Abuse/cost control: per-IP rate limit (public endpoint hits RPC/Groq/compute).
  const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  const rl = await tursoRateLimit(client, `score:${ip}`, rateLimitPerMin());
  if (!rl.allowed) {
    return NextResponse.json({ ok: false, error: "Too many requests — slow down a moment." }, { status: 429 });
  }
  // Serve repeat/popular searches + dashboard polls from cache (no RPC/compute).
  // `?fresh=1` (Re-Analyze in the dashboard) bypasses the read to force a recompute.
  const ttl = scoreCacheTtlSec();
  const bypassCache = ["1", "true", "yes"].includes(
    String(searchParams.get("fresh") ?? searchParams.get("noCache") ?? "").toLowerCase(),
  );
  if (ttl > 0 && !bypassCache) {
    const cached = await tursoFetchScoreCache(client, scope, windowMinutes, lastHours, ttl);
    if (cached) return NextResponse.json({ ...cached, cached: true });
  }

  try {
    const body = await buildTursoScoreBundle(client, { scope, windowMinutes, lastHours });
    console.log(
      "[score debug] eventsCounted:",
      body.eventsCounted,
      "topPayerLinks:",
      body.topPayerLinks?.length,
      "score:",
      body.score,
    );
    // Cold search: no rows in the DB yet. Instead of making the user wait for the
    // worker, score the address LIVE from RPC right now (real answer in seconds), and
    // enqueue it so the worker persists + keeps it fresh for next time.
    if (body && body.empty) {
      try {
        await tursoAddToScanQueue(client, scope, "on-demand search");
      } catch (e) {
        console.error("[score] scan-queue enqueue", e);
      }
      try {
        const connection = getSolanaConnection();
        const live = await scoreFromRpc(connection, scope, { windowMinutes, lastHours });
        const out = { ...live, queued: true };
        await tursoUpsertScoreCache(client, scope, windowMinutes, lastHours, out);
        return NextResponse.json(out);
      } catch (e) {
        console.error("[score] rpc-live", e);
        body.queued = true; // fall back to the DB empty + "pulling in" UX
      }
    } else {
      await tursoUpsertScoreCache(client, scope, windowMinutes, lastHours, body);
    }
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String(e?.message ?? e) },
      { status: 500 },
    );
  }
}
