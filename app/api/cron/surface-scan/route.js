import { NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/api-auth.js";
import { appBaseUrl } from "@/lib/app-base-url.js";
import { recomputeCrossMintIntel } from "@/lib/cross-mint-intel.js";
import { evaluateSurfaceTriggers, externalRulesDocumentation } from "@/lib/surface-triggers.js";
import { getTursoClient, tursoInsertSurfaceHits } from "@/lib/turso.js";
import { loadWatchlist } from "@/lib/watchlist.js";

export const maxDuration = 120;
export const runtime = "nodejs";

async function fetchJson(url) {
  const r = await fetch(url, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  return { r, j };
}

/**
 * GET — Vercel Cron. Scans every scope from `CHAINMIND_WATCHLIST_JSON` or `config/watchlist.json`,
 * evaluates surface triggers, optionally persists hits to Turso `surface_hits`.
 */
export async function GET(request) {
  const denied = requireCronAuth(request, "/api/cron/surface-scan");
  if (denied) return denied;

  let scopes;
  try {
    scopes = loadWatchlist();
  } catch (e) {
    return NextResponse.json(
      { error: String(e?.message ?? e) },
      { status: 500 },
    );
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

  const window = Math.min(60, Math.max(1, Number(process.env.SURFACE_SCORE_WINDOW ?? 5) || 5));
  const hours = Math.min(24 * 30, Math.max(1, Number(process.env.SURFACE_SCORE_HOURS ?? 168) || 168));
  const inspectLimit = Math.min(100, Math.max(1, Number(process.env.SURFACE_INSPECT_LIMIT ?? 12) || 12));

  const base = appBaseUrl();
  const pingUrl = `${base}/api/ping`;

  /** @type {{ scope: string, hits: import("@/lib/surface-triggers.js").SurfaceHit[], scoreMeta: any }[]} */
  const results = [];

  for (const { address: scope } of scopes) {
    const scoreUrl = `${base}/api/score?scope=${encodeURIComponent(scope)}&window=${window}&hours=${hours}`;
    const inspectUrl = `${base}/api/inspect?address=${encodeURIComponent(scope)}&limit=${inspectLimit}`;

    const [scorePack, inspectPack] = await Promise.all([fetchJson(scoreUrl), fetchJson(inspectUrl)]);

    if (!scorePack.r.ok) {
      results.push({
        scope,
        hits: [],
        scoreMeta: { ok: false, status: scorePack.r.status, body: scorePack.j },
      });
      continue;
    }

    const score = scorePack.j;
    const inspect = inspectPack.r.ok ? inspectPack.j : { ok: false, error: inspectPack.j?.error };

    const { hits } = evaluateSurfaceTriggers({ score, inspect }, process.env);

    results.push({
      scope,
      hits,
      scoreMeta: { ok: true, eventsCounted: score.eventsCounted ?? null, empty: score.empty ?? false },
    });
  }

  const { r: pingR, j: pingJ } = await fetchJson(pingUrl);
  const ping = pingR.ok ? pingJ : { error: pingJ?.error };

  /** @type {{ scope: string, ruleId: string, severity: string, detail: string, entities: string[] }[]} */
  const toRecord = [];
  for (const row of results) {
    for (const h of row.hits) {
      toRecord.push({
        scope: row.scope,
        ruleId: h.ruleId,
        severity: h.severity,
        detail: `[${row.scope.slice(0, 8)}…] ${h.title}: ${h.detail}`,
        entities: h.entities?.length ? h.entities : [row.scope],
      });
    }
  }

  let persisted = 0;
  const client = getTursoClient();
  if (client && toRecord.length > 0) {
    try {
      await tursoInsertSurfaceHits(client, toRecord);
      persisted = toRecord.length;
    } catch (e) {
      console.error("[surface-scan] turso insert", e);
    }
  }

  /** @type {Awaited<ReturnType<typeof recomputeCrossMintIntel>> | { ok: false; error: string } | null} */
  let crossMint = null;
  if (client && scopes.length >= 2) {
    try {
      const topN = Math.min(48, Math.max(5, Number(process.env.CROSS_MINT_TOP_PAYERS ?? 18) || 18));
      const minCluster = Math.min(24, Math.max(2, Number(process.env.CROSS_MINT_MIN_CLUSTER ?? 3) || 3));
      crossMint = await recomputeCrossMintIntel(client, scopes.map((s) => s.address), {
        lookbackHours: hours,
        topN,
        minClusterMembers: minCluster,
      });
    } catch (e) {
      console.error("[surface-scan] cross-mint intel", e);
      crossMint = { ok: false, error: String(e?.message ?? e) };
    }
  }

  return NextResponse.json({
    ok: true,
    scanned: scopes.length,
    hitsTotal: toRecord.length,
    hitsPersisted: persisted,
    ping: ping?.error ? { error: ping.error } : { ok: true },
    crossMint,
    rulesNotYetWired: externalRulesDocumentation(),
    results: results.map((r) => ({
      scope: r.scope,
      hitCount: r.hits.length,
      hits: r.hits,
      scoreMeta: r.scoreMeta,
    })),
  });
}
