import { NextResponse } from "next/server";
import { getTursoClient } from "@/lib/turso.js";

export const maxDuration = 10;
export const runtime = "nodejs";

/** Heartbeat older than this is stale — the worker rounds every ~90s plus sync time. */
const STALE_AFTER_MINUTES = 10;

/**
 * GET ingest-pipeline liveness (no auth, one cheap Turso read — point UptimeRobot /
 * healthchecks.io here). Reads the `worker_heartbeat` row the pipeline worker upserts
 * into ingest_state at the end of every round (carried up by the ingest_state sync).
 * 200 { ok: true, stale: false } while fresh; 503 { ok: false, stale: true } when the
 * last heartbeat is missing or older than STALE_AFTER_MINUTES.
 */
export async function GET() {
  const client = getTursoClient();
  if (!client) {
    return NextResponse.json({
      ok: true,
      database: "unconfigured",
      lastIngestAt: null,
      staleMinutes: null,
      stale: null,
      hint: "Connect Turso (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN) to monitor ingest freshness.",
    });
  }
  try {
    const result = await client.execute(
      "SELECT last_before_signature, updated_at FROM ingest_state WHERE scope_key = 'worker_heartbeat'",
    );
    const row = result.rows[0];
    let heartbeat = null;
    if (row) {
      try {
        heartbeat = JSON.parse(String(row.last_before_signature ?? "null"));
      } catch {
        heartbeat = null;
      }
    }
    const lastIngestAt = heartbeat?.at ?? (row ? String(row.updated_at ?? "") : null) ?? null;
    const ageMs = lastIngestAt ? Date.now() - Date.parse(lastIngestAt) : NaN;
    const staleMinutes = Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs / 60_000)) : null;
    const stale = staleMinutes == null || staleMinutes > STALE_AFTER_MINUTES;
    return NextResponse.json(
      {
        ok: !stale,
        database: "turso",
        lastIngestAt: lastIngestAt || null,
        staleMinutes,
        stale,
        ...(heartbeat ? { scopes: heartbeat.scopes ?? null, parsed: heartbeat.parsed ?? null } : {}),
        ...(row ? {} : { hint: "No worker heartbeat yet — start the pipeline worker (npm run pipeline -- --turso-sync)." }),
      },
      { status: stale ? 503 : 200 },
    );
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/no such table/i.test(msg)) {
      return NextResponse.json(
        {
          ok: false,
          database: "turso",
          lastIngestAt: null,
          staleMinutes: null,
          stale: true,
          hint: "ingest_state table missing — run npm run turso:schema on this Turso DB.",
        },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
