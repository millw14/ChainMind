import { NextResponse } from "next/server";
import { getSolanaCluster, getSolanaConnection, getSolanaRpcUrl } from "@/lib/solana.js";
import { withRpcRetry } from "@/lib/rpc-retry.js";
import { redactRpcUrl } from "@/lib/redacted-rpc.js";

export const maxDuration = 30;
export const runtime = "nodejs";

export async function GET() {
  try {
    const connection = getSolanaConnection();
    const version = await withRpcRetry(() => connection.getVersion());
    const slot = await withRpcRetry(() => connection.getSlot("confirmed"));
    return NextResponse.json({
      ok: true,
      cluster: getSolanaCluster(),
      rpcUrl: redactRpcUrl(getSolanaRpcUrl()),
      version: version?.["solana-core"] ?? version,
      slot,
      deployment: "next",
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String(e?.message ?? e) },
      { status: 500 },
    );
  }
}
