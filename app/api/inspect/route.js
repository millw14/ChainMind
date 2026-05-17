import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { getSolanaConnection } from "@/lib/solana.js";
import { fetchSignaturesForDisplay } from "@/lib/inspect-service.js";
import { getTursoClient } from "@/lib/turso.js";

export const maxDuration = 30;
export const runtime = "nodejs";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const address = String(searchParams.get("address") ?? "").trim();
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") ?? 15) || 15));

  if (!address) {
    return NextResponse.json({ ok: false, error: "Missing ?address=<base58>" }, { status: 400 });
  }
  try {
    new PublicKey(address);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid base58 address" }, { status: 400 });
  }

  try {
    const connection = getSolanaConnection();
    const signatures = await fetchSignaturesForDisplay(connection, address, limit);

    // If RPC returned signatures use them
    if (signatures?.length > 0) {
      return NextResponse.json({ ok: true, address, limit, signatures, source: "rpc" });
    }

    // Fallback to Turso stored signatures
    const client = getTursoClient();
    if (client) {
      const result = await client.execute({
        sql: `SELECT signature, slot, block_time, err
              FROM signatures
              WHERE scope_address = ?
              ORDER BY slot DESC
              LIMIT ?`,
        args: [address, limit],
      });
      const stored = result.rows.map((r) => ({
        signature: String(r.signature ?? ""),
        slot: Number(r.slot) || null,
        blockTime: r.block_time ? Number(r.block_time) : null,
        blockTimeIso: r.block_time ? new Date(Number(r.block_time) * 1000).toISOString() : null,
        err: r.err || null,
      }));
      return NextResponse.json({ ok: true, address, limit, signatures: stored, source: "turso" });
    }

    return NextResponse.json({ ok: true, address, limit, signatures: [], source: "rpc_empty" });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String(e?.message ?? e) },
      { status: 500 },
    );
  }
}
