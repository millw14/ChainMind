import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";

/**
 * @typedef {{ address: string, note?: string }} WatchScope
 */

/**
 * Load watchlist: CHAINMIND_WATCHLIST path to JSON, default config/watchlist.json,
 * else fall back to CHAINMIND_SCOPE / TARGET_ADDRESS (single scope).
 * @param {string} [cwd]
 * @returns {WatchScope[]}
 */
export function loadWatchlist(cwd = process.cwd()) {
  const jsonEnv = process.env.CHAINMIND_WATCHLIST_JSON?.trim();
  if (jsonEnv) {
    try {
      const j = JSON.parse(jsonEnv);
      const list = j.scopes ?? j.addresses ?? j;
      if (!Array.isArray(list)) {
        throw new Error('expected "scopes" array (or top-level array) in CHAINMIND_WATCHLIST_JSON');
      }
      return list.map(normalizeScope).filter(Boolean);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`CHAINMIND_WATCHLIST_JSON: ${msg}`);
    }
  }

  const fromEnvPath = process.env.CHAINMIND_WATCHLIST?.trim();
  const defaultPath = resolve(cwd, "config/watchlist.json");
  const path = fromEnvPath ? resolve(cwd, fromEnvPath) : defaultPath;

  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8");
    const j = JSON.parse(raw);
    const list = j.scopes ?? j.addresses ?? j;
    if (!Array.isArray(list)) {
      throw new Error("Watchlist JSON must have a \"scopes\" array (or be an array of addresses).");
    }
    return list.map(normalizeScope).filter(Boolean);
  }

  const single =
    process.env.CHAINMIND_SCOPE?.trim() ||
    process.env.TARGET_ADDRESS?.trim() ||
    "";
  if (single) {
    return [{ address: normalizeAddress(single), note: "from env" }];
  }

  return [];
}

/**
 * @param {unknown} item
 * @returns {WatchScope | null}
 */
function normalizeScope(item) {
  if (typeof item === "string") {
    const address = normalizeAddress(item);
    return address ? { address } : null;
  }
  if (item && typeof item === "object" && typeof item.address === "string") {
    const address = normalizeAddress(item.address);
    if (!address) return null;
    const note = typeof item.note === "string" ? item.note : undefined;
    return { address, note };
  }
  return null;
}

/**
 * @param {string} s
 */
function normalizeAddress(s) {
  const t = s.trim();
  if (!t) return null;
  try {
    return new PublicKey(t).toBase58();
  } catch {
    return null;
  }
}
