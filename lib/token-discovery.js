import { PublicKey } from "@solana/web3.js";
import { isKnownEntity } from "./known-entities.js";

/**
 * Discover trending Solana token mints from DexScreener's FREE public API (no key).
 * Feeds the scan queue so detection isn't limited to a hand-curated watchlist — this is
 * the "what to watch" engine behind autonomous surfaces + cross-mint intel.
 *
 * Sources are trending/boosted/new-profile lists; we filter to Solana, validate the
 * mint, drop known entities (stablecoins/infra), dedup, and cap the count so the
 * ingest worker isn't flooded.
 */
const SOURCES = [
  "https://api.dexscreener.com/token-boosts/top/v1",
  "https://api.dexscreener.com/token-boosts/latest/v1",
  "https://api.dexscreener.com/token-profiles/latest/v1",
];

/** @param {string} a */
function validMint(a) {
  if (!a || a.length < 32 || a.length > 44) return false;
  try {
    // PublicKey throws on non-base58 / wrong length
    return Boolean(new PublicKey(a));
  } catch {
    return false;
  }
}

/**
 * @param {number} limit max mints to return
 * @returns {Promise<string[]>}
 */
export async function discoverTrendingSolanaMints(limit = 10) {
  const cap = Math.max(1, Math.min(50, Number(limit) || 10));
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const url of SOURCES) {
    if (out.length >= cap) break;
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) continue;
      const j = await r.json().catch(() => null);
      const arr = Array.isArray(j) ? j : Array.isArray(j?.tokens) ? j.tokens : [];
      for (const t of arr) {
        if (String(t?.chainId ?? "") !== "solana") continue;
        const mint = String(t?.tokenAddress ?? "").trim();
        if (!mint || seen.has(mint)) continue;
        seen.add(mint);
        if (!validMint(mint) || isKnownEntity(mint)) continue;
        out.push(mint);
        if (out.length >= cap) break;
      }
    } catch {
      // source unreachable — skip, try next
    }
  }
  return out;
}
