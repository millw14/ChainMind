/**
 * Shared helpers + types for graph-backed detectors.
 *
 * @typedef {{
 *   wallet?: string,
 *   action: string,
 *   slot: number | null,
 *   tx_sig?: string | null,
 *   mint?: string | null,
 * }} DetectorEvidence
 *
 * @typedef {{
 *   flag: string,
 *   confidence: number,
 *   evidence: DetectorEvidence[],
 *   summary: string,
 * }} DetectorResult
 */

const FUNDING_EDGE_TYPES = ["token_transfer", "mint_to", "fee_payer_cosigner", "native_transfer"];

/** @param {number} x */
export function clamp01(x) {
  if (Number.isNaN(x) || x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * @param {import("../graph.js").AdjacencyGraph} graph
 * @param {string} address
 * @param {string[]} [kinds]
 */
export function fundersFromGraph(graph, address, kinds = FUNDING_EDGE_TYPES) {
  /** @type {Set<string>} */
  const set = new Set();
  for (const e of graph.inbound.get(address) ?? []) {
    if (kinds.includes(e.edge_type)) set.add(e.from_address);
  }
  return [...set];
}

/**
 * Wallets that received a funding-like edge from `funder`.
 * @param {import("../graph.js").AdjacencyGraph} graph
 * @param {string} funder
 * @param {string[]} [kinds]
 */
export function fundedRecipientsFromGraph(graph, funder, kinds = FUNDING_EDGE_TYPES) {
  /** @type {Set<string>} */
  const set = new Set();
  for (const e of graph.outbound.get(funder) ?? []) {
    if (kinds.includes(e.edge_type)) set.add(e.to_address);
  }
  return [...set];
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} scopeAddress
 * @param {number|null} minSlot
 * @param {number|null} maxSlot
 */
export function scopeMaxSlot(db, scopeAddress, minSlot = null, maxSlot = null) {
  let sql = `SELECT MAX(slot) AS m FROM signatures WHERE scope_address = ?`;
  /** @type {(string|number|null)[]} */
  const p = [scopeAddress];
  if (minSlot != null) {
    sql += ` AND slot >= ?`;
    p.push(minSlot);
  }
  if (maxSlot != null) {
    sql += ` AND slot <= ?`;
    p.push(maxSlot);
  }
  const row = db.prepare(sql).get(...p);
  return row?.m != null ? Number(row.m) : null;
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} scopeAddress
 * @param {number} lookbackSlots
 */
export function defaultSlotWindow(db, scopeAddress, lookbackSlots) {
  const hi = scopeMaxSlot(db, scopeAddress);
  if (hi == null) return { minSlot: null, maxSlot: null };
  return { minSlot: hi - lookbackSlots, maxSlot: hi };
}

/** @param {string | null | undefined} raw */
export function parseAmountBigInt(raw) {
  if (raw == null || raw === "") return 0n;
  try {
    return BigInt(String(raw).split(".")[0]);
  } catch {
    return 0n;
  }
}

/** @param {bigint} n */
export function shortenAmountLabel(n) {
  if (n === 0n) return "0";
  const s = n.toString();
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)} (${s.length} digits)`;
}

export { FUNDING_EDGE_TYPES };
