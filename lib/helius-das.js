/**
 * Minimal Helius DAS JSON-RPC (getAsset for USD read).
 */

export function getHeliusJsonRpcUrl(env = process.env) {
  const key = env.HELIUS_API_KEY?.trim();
  if (key) return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
  const rpc = env.SOLANA_RPC_URL?.trim();
  if (rpc && /helius-rpc\.com/i.test(rpc)) return rpc;
  return null;
}

/**
 * @param {string} url
 * @param {string} method
 * @param {Record<string, unknown>} params
 */
export async function heliusDasRpc(url, method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "chainmind-helius", method, params }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Helius DAS HTTP ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
  if (j.error) throw new Error(j.error?.message || String(j.error));
  return j.result;
}

/**
 * @param {string} rpcUrl
 * @param {string} mint base58
 * @returns {Promise<{ priceUsd: number | null, symbol?: string }>}
 */
export async function dasGetFungiblePriceUsd(rpcUrl, mint) {
  try {
    const result = await heliusDasRpc(rpcUrl, "getAsset", {
      id: mint,
      options: { showFungible: true },
    });
    const p = result?.token_info?.price_info?.price_per_token;
    const n = typeof p === "number" ? p : Number(p);
    const sym = result?.token_info?.symbol ?? result?.content?.metadata?.symbol;
    return { priceUsd: Number.isFinite(n) && n > 0 ? n : null, symbol: typeof sym === "string" ? sym : undefined };
  } catch {
    return { priceUsd: null };
  }
}
