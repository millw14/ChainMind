import { tursoFetchInboundFundingEdges } from "./turso.js";

/**
 * Multi-hop inbound funding expansion: who funded the frontier, then who funded them, …
 * Uses same funding-like edge types as /api/score funding graph.
 *
 * @param {import("@libsql/client").Client} client
 * @param {string} scope
 * @param {number} sinceUnix
 * @param {string[]} seedAddresses — usually top fee payers (depth 0)
 * @param {{
 *   maxDepth?: number,
 *   maxNodes?: number,
 *   frontierWidth?: number,
 *   perQueryLimit?: number,
 * }} [opts]
 */
export async function expandFundingTreeInbound(
  client,
  scope,
  sinceUnix,
  seedAddresses,
  opts = {},
) {
  const maxDepth = Math.min(8, Math.max(1, Number(opts.maxDepth) || 4));
  const maxNodes = Math.min(250, Math.max(16, Number(opts.maxNodes) || 96));
  const frontierWidth = Math.min(32, Math.max(4, Number(opts.frontierWidth) || 16));
  const perQueryLimit = Math.min(600, Math.max(80, Number(opts.perQueryLimit) || 320));

  const seeds = [...new Set(seedAddresses.map(String).filter(Boolean))].slice(0, frontierWidth);

  /** @type {Map<string, { address: string, depth: number, role: string }>} */
  const nodeMap = new Map();
  for (const a of seeds) {
    nodeMap.set(a, { address: a, depth: 0, role: "top_fee_payer" });
  }

  /** @type {Map<string, true>} */
  const edgeDedupe = new Map();
  /** @type {{ from: string, to: string, edge_type: string, tx_sig: string, slot: number | null, block_time: number | null, hopDepth: number }[]} */
  const edges = [];

  let frontier = [...seeds];

  for (let depth = 1; depth <= maxDepth && nodeMap.size < maxNodes && frontier.length > 0; depth++) {
    const slice = frontier.slice(0, frontierWidth);
    const rows = await tursoFetchInboundFundingEdges(client, scope, slice, sinceUnix, perQueryLimit);

    /** @type {Set<string>} */
    const next = new Set();

    for (const r of rows) {
      const fund = String(r.funder ?? "").trim();
      const rec = String(r.recipient ?? "").trim();
      if (!fund || !rec) continue;

      const ek = `${r.tx_sig}|${fund}|${rec}|${r.edge_type}`;
      if (edgeDedupe.has(ek)) continue;
      edgeDedupe.set(ek, true);

      edges.push({
        from: fund,
        to: rec,
        edge_type: String(r.edge_type ?? ""),
        tx_sig: String(r.tx_sig ?? ""),
        slot: r.slot != null ? Number(r.slot) : null,
        block_time: r.block_time != null ? Number(r.block_time) : null,
        hopDepth: depth,
      });

      if (!nodeMap.has(fund) && nodeMap.size < maxNodes) {
        nodeMap.set(fund, {
          address: fund,
          depth,
          role: depth === 1 ? "direct_inbound_funder" : `funder_hop_${depth}`,
        });
        next.add(fund);
      }
    }

    frontier = [...next];
  }

  const nodes = [...nodeMap.values()].sort((a, b) => a.depth - b.depth || a.address.localeCompare(b.address));

  return {
    seedCount: seeds.length,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    maxDepthConfigured: maxDepth,
    nodes,
    edges,
    note:
      "Inbound edges: funder → recipient (recipient was in the previous frontier). Native + SPL funding-like types only; capped by Turso row limits per hop.",
  };
}
