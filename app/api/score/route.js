import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { runAiDetectors } from "@/lib/ai-detectors.js";
import { summarizeFundingGraphFromEdges } from "@/lib/funding-graph-summary.js";
import { computeCoactivityScoreFromRows } from "@/lib/score-math.js";
import {
  getTursoClient,
  tursoFetchInboundFundingEdges,
  tursoFetchPayerPeerEdges,
  tursoFetchScoreRows,
  tursoFetchTransfersWindow,
} from "@/lib/turso.js";

export const maxDuration = 45;
export const runtime = "nodejs";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const scope = String(searchParams.get("scope") ?? searchParams.get("address") ?? "").trim();
  const windowMinutes = Math.min(60, Math.max(1, Number(searchParams.get("window") ?? 5) || 5));
  const lastHours = Math.min(24 * 30, Math.max(1, Number(searchParams.get("hours") ?? 24) || 24));

  if (!scope) {
    return NextResponse.json({ ok: false, error: "Missing ?scope=<base58>" }, { status: 400 });
  }
  try {
    new PublicKey(scope);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid base58 address" }, { status: 400 });
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
    const cutoff = Math.floor(Date.now() / 1000) - lastHours * 3600;
    const rows = await tursoFetchScoreRows(client, scope, cutoff);
    const result = computeCoactivityScoreFromRows(rows, scope, windowMinutes, lastHours);

    let fundingGraph = { status: "skipped", reason: "empty_or_insufficient_events" };
    /** @type {{ from: string, to: string, mint: string | null, amount: string, block_time: number }[]} */
    let transfers = [];
    /** @type {{ from: string, to: string, edge_type: string, mint: string | null, block_time: number }[]} */
    let peerEdges = [];

    if (result.ok && !result.empty && Array.isArray(result.topPayerLinks) && result.topPayerLinks.length > 0) {
      const payers = result.topPayerLinks.slice(0, 8).map((x) => x.payer).filter(Boolean);
      if (payers.length > 0) {
        const edgeRows = await tursoFetchInboundFundingEdges(client, scope, payers, cutoff);
        fundingGraph = summarizeFundingGraphFromEdges(payers, edgeRows);
      }
      const peers = result.topPayerLinks.slice(0, 12).map((x) => x.payer).filter(Boolean);
      try {
        const [trows, prow] = await Promise.all([
          tursoFetchTransfersWindow(client, scope, cutoff, 2500),
          tursoFetchPayerPeerEdges(client, scope, peers, cutoff, 800),
        ]);
        transfers = trows;
        peerEdges = prow;
      } catch {
        transfers = [];
        peerEdges = [];
      }
    }

    let aiDetection = null;
    if (result.ok && !result.empty) {
      aiDetection = runAiDetectors({
        scope,
        eventRows: rows,
        scoreResult: result,
        fundingGraph,
        transfers,
        peerEdges,
      });
      if (Array.isArray(result.drivers)) {
        const d = aiDetection.detectors;
        const fired = Object.values(d)
          .filter((x) => x?.triggered)
          .map((x) => x.name)
          .join(", ");
        result.drivers.push(
          `AI detection v2 composite ${aiDetection.composite.score0_100}/100` +
            (fired ? `; triggered: ${fired}` : "") +
            ` — see aiDetection JSON.`,
        );
      }
    }

    return NextResponse.json({ ...result, fundingGraph, database: "turso", ...(aiDetection ? { aiDetection } : {}) });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String(e?.message ?? e) },
      { status: 500 },
    );
  }
}
