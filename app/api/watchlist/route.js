import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { loadWatchlist } from "@/lib/watchlist.js";
import { getTursoClient, tursoAddToScanQueue } from "@/lib/turso.js";

export const runtime = "nodejs";

/**
 * GET — watchlist addresses for dashboard multi-focus (no secrets; scopes are public pubkeys).
 */
export async function GET() {
  try {
    const scopes = loadWatchlist();
    return NextResponse.json({
      ok: true,
      scopes: scopes.map((s) => ({ address: s.address, note: s.note ?? null })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const address = String(body.address ?? "").trim();
  if (!address) return NextResponse.json({ ok: false, error: "Missing address" }, { status: 400 });
  try {
    new PublicKey(address);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid base58 address" }, { status: 400 });
  }
  const client = getTursoClient();
  if (!client) return NextResponse.json({ ok: false, error: "Turso not configured" }, { status: 503 });
  await tursoAddToScanQueue(client, address, body.note ?? null);
  return NextResponse.json({ ok: true, queued: address });
}
