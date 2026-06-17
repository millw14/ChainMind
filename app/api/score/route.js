import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { buildTursoScoreBundle } from "@/lib/score-bundle.js";
import { getTursoClient, tursoAddToScanQueue } from "@/lib/turso.js";
import { openDb } from "@/lib/db.js";
import { computeCoactivityScore } from "@/lib/score-core.js";

export const maxDuration = 60;
export const runtime = "nodejs";

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
    // On-demand ingestion: no events yet for this scope → enqueue it so the
    // pipeline worker pulls + ingests it. INSERT OR IGNORE makes this idempotent,
    // so repeated searches for the same address don't pile up. The client uses
    // `queued` to show a "pulling this address in" state instead of the raw message.
    if (body && body.empty) {
      try {
        await tursoAddToScanQueue(client, scope, "on-demand search");
        body.queued = true;
      } catch (e) {
        console.error("[score] scan-queue enqueue", e);
      }
    }
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String(e?.message ?? e) },
      { status: 500 },
    );
  }
}
