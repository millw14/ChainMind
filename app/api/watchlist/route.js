import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { clientIp, hasOperatorAuth, isSameOriginBrowser } from "@/lib/api-auth.js";
import { loadWatchlist } from "@/lib/watchlist.js";
import { getTursoClient, tursoAddToScanQueue, tursoRateLimit } from "@/lib/turso.js";

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
  // Queueing an address commits the ingest worker's RPC budget to it — operator
  // auth (CHAINMIND_OPERATOR_SECRET), or the same-origin dashboard rate limited per IP.
  const operator = hasOperatorAuth(request);
  if (!operator && !isSameOriginBrowser(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
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
  if (!operator) {
    const rl = await tursoRateLimit(client, `watchlist:${clientIp(request)}`, 5);
    if (!rl.allowed) {
      return NextResponse.json({ ok: false, error: "Too many requests — slow down a moment." }, { status: 429 });
    }
  }
  const note = typeof body.note === "string" ? body.note.slice(0, 200) : null;
  await tursoAddToScanQueue(client, address, note);
  return NextResponse.json({ ok: true, queued: address });
}
