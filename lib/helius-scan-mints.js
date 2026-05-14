import { PublicKey } from "@solana/web3.js";

/**
 * Token mints to poll for Helius + DexScreener momentum scan.
 * Env: CHAINMIND_HELIUS_SCAN_MINTS_JSON — e.g. ["mint1","mint2"] or {"mints":["..."]}
 * @returns {string[]} base58 mints
 */
export function loadHeliusScanMints(env = process.env) {
  const raw = env.CHAINMIND_HELIUS_SCAN_MINTS_JSON?.trim();
  if (!raw) return [];
  const j = JSON.parse(raw);
  const list = Array.isArray(j) ? j : j.mints ?? [];
  const out = [];
  for (const item of list) {
    const addr = typeof item === "string" ? item : item?.address;
    if (typeof addr !== "string") continue;
    try {
      out.push(new PublicKey(addr.trim()).toBase58());
    } catch {
      /* skip */
    }
  }
  return [...new Set(out)];
}
