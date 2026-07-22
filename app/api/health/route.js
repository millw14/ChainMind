import { NextResponse } from "next/server";
import { getChainConfig, getPublicClient } from "@/lib/chain.js";

export const maxDuration = 10;
export const runtime = "nodejs";

/**
 * GET liveness — confirms the app can reach Robinhood Chain over JSON-RPC.
 * Point UptimeRobot / healthchecks.io here. 200 while the RPC responds with
 * the expected chain id; 503 if the RPC is unreachable or mismatched.
 */
export async function GET() {
  const cfg = getChainConfig();
  try {
    const client = getPublicClient();
    const [chainId, blockNumber] = await Promise.all([
      client.getChainId(),
      client.getBlockNumber(),
    ]);
    const ok = chainId === cfg.id;
    return NextResponse.json(
      {
        ok,
        network: cfg.name,
        chainId,
        expectedChainId: cfg.id,
        blockNumber: blockNumber.toString(),
        ...(ok ? {} : { hint: "RPC chain id does not match the configured network." }),
      },
      { status: ok ? 200 : 503 },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, network: cfg.name, error: String(e?.message ?? e) },
      { status: 503 },
    );
  }
}
