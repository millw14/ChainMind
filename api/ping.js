import { loadEnv } from "../lib/load-env.js";
loadEnv();

import { getSolanaCluster, getSolanaConnection, getSolanaRpcUrl } from "../lib/solana.js";
import { withRpcRetry } from "../lib/rpc-retry.js";

function redactRpcUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    if (u.searchParams.has("api-key")) u.searchParams.set("api-key", "***");
    return u.toString();
  } catch {
    return url.slice(0, 48) + (url.length > 48 ? "…" : "");
  }
}

export default async function handler(req, res) {
  try {
    const connection = getSolanaConnection();
    const version = await withRpcRetry(() => connection.getVersion());
    const slot = await withRpcRetry(() => connection.getSlot("confirmed"));
    res.status(200).json({
      ok: true,
      cluster: getSolanaCluster(),
      rpcUrl: redactRpcUrl(getSolanaRpcUrl()),
      version: version?.["solana-core"] ?? version,
      slot,
      deployment: "vercel",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
}
