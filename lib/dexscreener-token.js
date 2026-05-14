/**
 * DexScreener public HTTP API (volume / m5 momentum). Not Helius — used because Helius DAS
 * does not expose aggregate DEX volume time series per mint.
 */

const DS_BASE = "https://api.dexscreener.com/latest/dex/tokens";

/**
 * @param {string} mint base58
 * @returns {Promise<{
 *   priceUsd: number | null,
 *   volumeM5: number,
 *   volumeH24: number,
 *   priceChangeM5: number | null,
 *   pairUrl: string | null,
 * } | null>}
 */
export async function fetchDexscreenerMintSnapshot(mint) {
  const r = await fetch(`${DS_BASE}/${encodeURIComponent(mint)}`, { cache: "no-store" });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const pairs = j?.pairs;
  if (!Array.isArray(pairs) || pairs.length === 0) return null;

  let best = pairs[0];
  let bestVol = Number(best?.volume?.h24) || 0;
  for (const p of pairs) {
    const v = Number(p?.volume?.h24) || 0;
    if (v > bestVol) {
      bestVol = v;
      best = p;
    }
  }

  const priceUsd = Number(best?.priceUsd);
  const volumeM5 = Number(best?.volume?.m5) || 0;
  const volumeH24 = Number(best?.volume?.h24) || 0;
  const pc = best?.priceChange;
  const priceChangeM5 = pc && typeof pc.m5 === "number" ? pc.m5 : null;

  return {
    priceUsd: Number.isFinite(priceUsd) ? priceUsd : null,
    volumeM5,
    volumeH24,
    priceChangeM5,
    pairUrl: typeof best?.url === "string" ? best.url : null,
  };
}
