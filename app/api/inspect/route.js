import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { getSolanaConnection } from "@/lib/solana.js";
import { fetchSignaturesForDisplay } from "@/lib/inspect-service.js";

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
    return NextResponse.json({ ok: true, address, limit, signatures });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String(e?.message ?? e) },
      { status: 500 },
    );
  }
}
