import { NextResponse } from "next/server";
import { getChainConfig, getPublicClient } from "@/lib/chain.js";

export const maxDuration = 10;
export const runtime = "nodejs";

// A health check that outlives its own maxDuration is useless: the 503 it
// exists to emit never reaches the monitor. One RPC attempt, no retries, and a
// hard deadline well inside the 10s budget.
const RPC_TIMEOUT_MS = 3_000;
const DEADLINE_MS = 8_000;

function deadline(ms) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`RPC health check exceeded ${ms}ms.`)), ms);
  });
}

/**
 * GET liveness — confirms the app can reach Robinhood Chain over JSON-RPC.
 * Point UptimeRobot / healthchecks.io here. 200 while the RPC responds with
 * the expected chain id; 503 if the RPC is unreachable, slow or mismatched.
 */
export async function GET() {
  const cfg = getChainConfig();
  try {
    const client = getPublicClient({ timeout: RPC_TIMEOUT_MS, retryCount: 0 });
    const [chainId, blockNumber] = await Promise.race([
      Promise.all([client.getChainId(), client.getBlockNumber()]),
      deadline(DEADLINE_MS),
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
