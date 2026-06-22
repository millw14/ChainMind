import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { getTursoClient } from "@/lib/turso.js";
import { buildScopeParticipants, buildWalletNeighborhood } from "@/lib/graph-neighborhood.js";

export const maxDuration = 30;
export const runtime = "nodejs";

/**
 * GET /api/graph/neighborhood?address=<base58>[&scope=<base58>][&limit=][&edgeCap=]
 *
 * Bounded 1-hop wallet neighborhood from the edges graph — counterparties with
 * per-edge-type counts and direction. Read-only; safe on hub wallets (hard caps).
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const address = String(searchParams.get("address") ?? "").trim();
  const scope = String(searchParams.get("scope") ?? "").trim() || null;

  if (!address) {
    return NextResponse.json({ ok: false, error: "Missing ?address=<base58>" }, { status: 400 });
  }
  try {
    new PublicKey(address);
    if (scope) new PublicKey(scope);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid base58 address" }, { status: 400 });
  }

  const client = getTursoClient();
  if (!client) {
    return NextResponse.json(
      { ok: true, center: address, neighbors: [], database: "unconfigured", message: "Connect Turso/libSQL + ingest graph edges." },
      { status: 200 },
    );
  }

  const neighborLimit = Number(searchParams.get("limit")) || undefined;
  const edgeCap = Number(searchParams.get("edgeCap")) || undefined;
  try {
    let result = await buildWalletNeighborhood(client, address, { scope, neighborLimit, edgeCap });
    // No edges as a wallet endpoint → it's likely a mint/scope. Show its participant
    // wallets instead of an empty neighborhood.
    if (result.neighborCount === 0 && !scope) {
      const asScope = await buildScopeParticipants(client, address, { neighborLimit, edgeCap });
      if (asScope.neighborCount > 0) result = asScope;
    }
    return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
  }
}
