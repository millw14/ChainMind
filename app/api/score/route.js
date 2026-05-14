import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { runAiDetectors } from "@/lib/ai-detectors.js";
import { summarizeFundingGraphFromEdges } from "@/lib/funding-graph-summary.js";
import { computeCoactivityScoreFromRows } from "@/lib/score-math.js";
import { getSolanaConnection } from "@/lib/solana.js";
import {
  getTursoClient,
  tursoFetchInboundFundingEdges,
  tursoFetchPayerPeerEdges,
  tursoFetchScoreRows,
  tursoFetchTransfersWindow,
  tursoFetchWalletFirstSeenMany,
  tursoUpsertWalletFirstSeen,
} from "@/lib/turso.js";
import { fetchOldestSignatureForAddress } from "@/lib/wallet-age-rpc.js";
import { buildWalletLedgerAge } from "@/lib/wallet-ledger-age.js";

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

    /** @type {ReturnType<typeof buildWalletLedgerAge> | null} */
    let walletLedgerAge = null;
    try {
      if (result.ok && !result.empty && Array.isArray(result.topPayerLinks) && result.topPayerLinks.length > 0) {
        const payerAddrs = result.topPayerLinks.slice(0, 12).map((x) => x.payer).filter(Boolean);
        let dbRows = await tursoFetchWalletFirstSeenMany(client, payerAddrs);

        const lazy = process.env.CHAINMIND_FETCH_WALLET_AGE_ON_SCORE === "1";
        const maxLazy = Math.min(12, Math.max(0, Number(process.env.CHAINMIND_WALLET_AGE_MAX_FETCH ?? 3) || 3));
        const maxPages = Math.min(30, Math.max(1, Number(process.env.CHAINMIND_WALLET_AGE_MAX_PAGES ?? 5) || 5));

        if (lazy && maxLazy > 0 && process.env.SOLANA_RPC_URL?.trim()) {
          const have = new Set(dbRows.map((r) => r.address));
          const missing = payerAddrs.filter((a) => !have.has(a)).slice(0, maxLazy);
          if (missing.length) {
            let connection;
            try {
              connection = getSolanaConnection();
            } catch {
              connection = null;
            }
            if (connection) {
              for (const addr of missing) {
                try {
                  const meta = await fetchOldestSignatureForAddress(connection, addr, { maxPages });
                  if (!meta.signature) continue;
                  await tursoUpsertWalletFirstSeen(client, {
                    address: addr,
                    first_signature: meta.signature,
                    first_slot: meta.slot,
                    first_block_time: meta.blockTime,
                    pages_walked: meta.pagesWalked,
                    capped: meta.capped ? 1 : 0,
                  });
                  dbRows = dbRows.filter((r) => r.address !== addr);
                  dbRows.push({
                    address: addr,
                    first_signature: meta.signature,
                    first_slot: meta.slot,
                    first_block_time: meta.blockTime,
                    pages_walked: meta.pagesWalked,
                    capped: meta.capped ? 1 : 0,
                    updated_at: new Date().toISOString(),
                  });
                } catch {
                  /* RPC error */
                }
              }
            }
          }
        }

        walletLedgerAge = buildWalletLedgerAge(payerAddrs, dbRows);
      }
    } catch {
      walletLedgerAge = null;
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
        walletLedgerAge,
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

    return NextResponse.json({
      ...result,
      fundingGraph,
      database: "turso",
      ...(aiDetection ? { aiDetection } : {}),
      ...(walletLedgerAge ? { walletLedgerAge } : {}),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String(e?.message ?? e) },
      { status: 500 },
    );
  }
}
