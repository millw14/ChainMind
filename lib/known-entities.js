import { INFRA_ACCOUNTS } from "./programs.js";

/**
 * Wallet-level known entities whose activity is NOT token-specific coordination —
 * CEX hot wallets, market makers, launchpad fee wallets, bridges. When such an
 * address appears as a funder / co-activity payer / wash counterparty it should be
 * excluded from coordination signals (an exchange funding thousands of withdrawals
 * is not a sybil hub).
 *
 * Distinct from INFRA_ACCOUNTS (programs/routers in programs.js) — this is for
 * regular account addresses. Seed is intentionally empty: hardcoding a wrong address
 * would HIDE real coordination, so entries are added deliberately. Populate without a
 * redeploy via env (verify each address first):
 *
 *   CHAINMIND_KNOWN_ENTITIES_JSON='[{"address":"<base58>","label":"Binance hot","type":"exchange"}]'
 *
 * type is free-form (exchange | market_maker | launchpad | bridge | other).
 */

/** @type {Map<string, { label: string, type: string }>} */
const SEED = new Map([
  // Add only addresses you've verified. Example (commented):
  // ["<base58>", { label: "pump.fun fee", type: "launchpad" }],
]);

/** @type {Map<string, { label: string, type: string }> | null} */
let cache = null;

function load() {
  if (cache) return cache;
  const m = new Map(SEED);
  const raw = process.env.CHAINMIND_KNOWN_ENTITIES_JSON?.trim();
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const e of arr) {
          const a = String(e?.address ?? "").trim();
          if (a) m.set(a, { label: String(e?.label ?? "known entity"), type: String(e?.type ?? "other") });
        }
      }
    } catch {
      // malformed env JSON — ignore, fall back to seed only
    }
  }
  cache = m;
  return m;
}

/**
 * True if the address is a known non-coordination entity (allowlist) OR core
 * infra/program. Single check for the coordination surfaces (funding, co-activity, wash).
 * @param {string} address
 */
export function isKnownEntity(address) {
  const a = String(address ?? "").trim();
  if (!a) return false;
  return load().has(a) || INFRA_ACCOUNTS.has(a);
}

/**
 * Human label for a known entity, or null. (Infra accounts return null here — they're
 * labeled elsewhere.)
 * @param {string} address
 */
export function knownEntityLabel(address) {
  const e = load().get(String(address ?? "").trim());
  return e ? `${e.label} (${e.type})` : null;
}

/** Test-only: drop the memoized map so a changed env is re-read. */
export function _resetKnownEntitiesCache() {
  cache = null;
}
