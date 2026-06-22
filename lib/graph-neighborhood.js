/**
 * lib/graph-neighborhood.js
 *
 * Phase 3 read-side: bounded wallet-neighborhood queries over the `edges` graph.
 * Given a wallet, return its immediate counterparties with per-edge-type counts and
 * direction — the building block for "who is this wallet connected to" without a
 * full-table scan. Everything is hard-bounded (scan cap + neighbor cap) so a hub wallet
 * can't blow up the query or the payload.
 */

/** Defaults — absolute ceilings, not relative, so any wallet stays bounded. */
export const NEIGHBORHOOD_DEFAULTS = {
  edgeCap: 2000, // max edge rows scanned (most-recent by slot)
  neighborLimit: 100, // max distinct counterparties returned
};

/**
 * Reduce edge rows into per-neighbor objects, then keep the top `neighborLimit`. Pure —
 * unit-testable without a DB. Accepts raw edges (one row per edge, `slot`) or pre-grouped
 * rows (`n`, `first_slot`/`last_slot`).
 *
 * @param {string} center base58 address the neighborhood is centered on
 * @param {{ neighbor: string, edge_type?: string|null, outbound?: number, n?: number, slot?: number|null, first_slot?: number|null, last_slot?: number|null }[]} rows
 * @param {{ edgeCap: number, neighborLimit?: number }} bounds
 */
export function shapeNeighborhood(center, rows, bounds) {
  const map = new Map();
  let edgesConsidered = 0;
  for (const r of rows ?? []) {
    const id = String(r.neighbor ?? "");
    if (!id) continue;
    if (!map.has(id)) {
      map.set(id, { address: id, edges: 0, inbound: 0, outbound: 0, edgeTypes: {}, firstSlot: null, lastSlot: null });
    }
    const e = map.get(id);
    const n = r.n != null ? Number(r.n) || 0 : 1; // raw edge rows count as one each
    const et = String(r.edge_type ?? "unknown");
    e.edgeTypes[et] = (e.edgeTypes[et] ?? 0) + n;
    e.edges += n;
    if (Number(r.outbound) === 1) e.outbound += n;
    else e.inbound += n;
    const fs = r.first_slot != null ? Number(r.first_slot) : r.slot != null ? Number(r.slot) : null;
    const ls = r.last_slot != null ? Number(r.last_slot) : r.slot != null ? Number(r.slot) : null;
    if (fs != null) e.firstSlot = e.firstSlot == null ? fs : Math.min(e.firstSlot, fs);
    if (ls != null) e.lastSlot = e.lastSlot == null ? ls : Math.max(e.lastSlot, ls);
    edgesConsidered += n;
  }
  const ranked = [...map.values()].sort((a, b) => b.edges - a.edges);
  const limit = bounds.neighborLimit ?? ranked.length;
  const neighbors = ranked.slice(0, limit);
  return {
    center,
    neighborCount: neighbors.length,
    totalNeighbors: ranked.length,
    neighborsTruncated: ranked.length > neighbors.length,
    edgesConsidered,
    // True when the scan hit its cap — the wallet has more edges than we looked at.
    capped: edgesConsidered >= bounds.edgeCap,
    neighbors,
  };
}

/**
 * Fetch a wallet's bounded 1-hop neighborhood from libSQL.
 *
 * @param {import("@libsql/client").Client} client
 * @param {string} address base58 wallet
 * @param {{ scope?: string|null, edgeCap?: number, neighborLimit?: number }} [opts]
 */
export async function buildWalletNeighborhood(client, address, opts = {}) {
  const scope = opts.scope?.trim() ? opts.scope.trim() : null;
  const edgeCap = Math.min(8000, Math.max(50, Number(opts.edgeCap) || NEIGHBORHOOD_DEFAULTS.edgeCap));
  const neighborLimit = Math.min(500, Math.max(1, Number(opts.neighborLimit) || NEIGHBORHOOD_DEFAULTS.neighborLimit));

  // Scan the most-recent `edgeCap` edges touching `address` (indexed on from/to) and
  // aggregate in JS — keeps neighbor/`capped` semantics exact (a SQL GROUP BY + LIMIT
  // would cap edge-type/direction combos, not distinct neighbors). Plain `?` placeholders,
  // bound in order of appearance.
  const scopeClause = scope ? "AND scope_address = ?" : "";
  const sql = `
    SELECT
      CASE WHEN from_address = ? THEN to_address ELSE from_address END AS neighbor,
      edge_type,
      CASE WHEN from_address = ? THEN 1 ELSE 0 END AS outbound,
      slot
    FROM edges
    WHERE (from_address = ? OR to_address = ?) ${scopeClause}
    ORDER BY slot DESC
    LIMIT ?`;

  const args = scope
    ? [address, address, address, address, scope, edgeCap]
    : [address, address, address, address, edgeCap];

  const res = await client.execute({ sql, args });
  const out = shapeNeighborhood(address, res.rows, { edgeCap, neighborLimit });
  return { ...out, scope: scope ?? null, edgeCap, neighborLimit };
}
