import { PublicKey } from "@solana/web3.js";
import { NATIVE_SOL_TRANSFER } from "./programs.js";

/** Lamports / native-SOL sentinel are 9 decimals. */
const NATIVE_DECIMALS = 9;

/** @param {string | null | undefined} mint */
function isNativeMint(mint) {
  const m = String(mint ?? "").trim();
  return m === "" || m === NATIVE_SOL_TRANSFER || m === "native_sol" || m === "So11111111111111111111111111111111111111112";
}

/**
 * Resolve decimals for a set of mints, cache-first with RPC fallback (results cached).
 * Decimals are constant per mint, so this is a cheap one-time-per-mint lookup.
 *
 * @param {import("@solana/web3.js").Connection | null} connection
 * @param {import("@libsql/client").Client | null} client
 * @param {(string | null | undefined)[]} mints
 * @returns {Promise<Map<string, number>>} mint → decimals (native sentinel keyed as "native_sol")
 */
export async function getMintDecimalsMany(connection, client, mints) {
  /** @type {Map<string, number>} */
  const out = new Map();
  const want = new Set();
  for (const m of mints) {
    if (isNativeMint(m)) {
      out.set("native_sol", NATIVE_DECIMALS);
      continue;
    }
    want.add(String(m).trim());
  }
  if (want.size === 0) return out;

  const list = [...want];
  // 1) cache read
  if (client) {
    try {
      const ph = list.map(() => "?").join(",");
      const res = await client.execute({
        sql: `SELECT mint, decimals FROM mint_decimals WHERE mint IN (${ph})`,
        args: list,
      });
      for (const r of res.rows) out.set(String(r.mint), Number(r.decimals));
    } catch {
      /* table may not exist yet — fall through to RPC */
    }
  }

  // 2) RPC fill for misses, then cache
  const missing = list.filter((m) => !out.has(m));
  if (missing.length && connection) {
    for (const mint of missing) {
      try {
        const info = await connection.getParsedAccountInfo(new PublicKey(mint));
        const dec = /** @type {any} */ (info.value?.data)?.parsed?.info?.decimals;
        if (typeof dec === "number") {
          out.set(mint, dec);
          if (client) {
            client
              .execute({
                sql: "INSERT OR REPLACE INTO mint_decimals (mint, decimals, updated_at) VALUES (?, ?, ?)",
                args: [mint, dec, new Date().toISOString()],
              })
              .catch(() => {});
          }
        }
      } catch {
        /* skip unresolvable mint */
      }
    }
  }
  return out;
}

/**
 * Format a raw integer amount string into human units given decimals.
 * @param {string | number | null | undefined} raw
 * @param {number | undefined} decimals
 * @returns {string} formatted ui amount, or "—" when unknown
 */
export function formatUiAmount(raw, decimals) {
  if (raw == null || raw === "") return "—";
  if (typeof decimals !== "number") {
    // decimals unknown — show the raw integer grouped, marked raw
    try {
      return `${BigInt(raw).toLocaleString()} (raw)`;
    } catch {
      return String(raw);
    }
  }
  let big;
  try {
    big = BigInt(raw);
  } catch {
    const n = Number(raw);
    return Number.isFinite(n) ? n.toLocaleString() : "—";
  }
  if (decimals === 0) return big.toLocaleString();
  const base = 10n ** BigInt(decimals);
  const whole = big / base;
  const frac = big % base;
  if (frac === 0n) return whole.toLocaleString();
  // up to 4 significant fractional digits
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, 4).replace(/0+$/, "");
  return `${whole.toLocaleString()}${fracStr ? "." + fracStr : ""}`;
}
