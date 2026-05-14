/**
 * Community structure on a small induced subgraph (e.g. top fee payers + peer edges).
 * Deterministic label propagation — no extra npm deps, runs on K≤~20 nodes.
 */

/**
 * @param {string[]} nodes
 * @param {Array<{ from?: string, to?: string }>} peerEdges
 * @param {Set<string>} nodeSet
 * @returns {Set<string>} keys "a||b" with a < b lexicographically
 */
export function buildUndirectedEdgeKeys(nodes, peerEdges, nodeSet) {
  /** @type {Set<string>} */
  const undirected = new Set();
  for (const e of peerEdges) {
    const a = String(e.from ?? "").trim();
    const b = String(e.to ?? "").trim();
    if (!nodeSet.has(a) || !nodeSet.has(b) || a === b) continue;
    const key = a < b ? `${a}||${b}` : `${b}||${a}`;
    undirected.add(key);
  }
  return undirected;
}

/**
 * @param {Set<string>} undirected keys a||b
 * @returns {Map<string, Set<string>>}
 */
export function adjacencyFromUndirected(undirected) {
  /** @type {Map<string, Set<string>>} */
  const adj = new Map();
  for (const k of undirected) {
    const [x, y] = k.split("||");
    if (!adj.has(x)) adj.set(x, new Set());
    if (!adj.has(y)) adj.set(y, new Set());
    adj.get(x).add(y);
    adj.get(y).add(x);
  }
  return adj;
}

/**
 * @param {string} addr
 */
function compactId(addr) {
  const s = String(addr);
  if (s.length <= 12) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/**
 * Deterministic label propagation (sorted sweep order each round).
 *
 * @param {string[]} nodes
 * @param {Map<string, Set<string>>} adj
 * @param {number} maxIter
 * @returns {{ communityIdByNode: Map<string, string>, communities: string[][], iterations: number }}
 */
export function labelPropagationDeterministic(nodes, adj, maxIter = 50) {
  /** @type {Map<string, string>} */
  const label = new Map();
  for (const v of nodes) label.set(v, v);

  let iterations = 0;
  for (let it = 0; it < maxIter; it++) {
    iterations = it + 1;
    let changed = false;
    const order = [...nodes].sort();

    for (const v of order) {
      const nb = adj.get(v);
      if (!nb || nb.size === 0) continue;
      /** @type {Map<string, number>} */
      const counts = new Map();
      for (const u of nb) {
        const L = label.get(u);
        if (L == null) continue;
        counts.set(L, (counts.get(L) ?? 0) + 1);
      }
      let bestL = null;
      let bestC = -1;
      for (const [L, c] of counts) {
        if (bestL == null || c > bestC || (c === bestC && L < bestL)) {
          bestC = c;
          bestL = L;
        }
      }
      if (bestL != null && bestL !== label.get(v)) {
        label.set(v, bestL);
        changed = true;
      }
    }
    if (!changed) break;
  }

  /** @type {Map<string, string[]>} */
  const buckets = new Map();
  for (const v of nodes) {
    const L = label.get(v) ?? v;
    if (!buckets.has(L)) buckets.set(L, []);
    buckets.get(L).push(v);
  }

  const communitiesSorted = [...buckets.values()]
    .map((members) => [...members].sort())
    .sort((a, b) => b.length - a.length);

  /** @type {Map<string, string>} */
  const communityIdByNode = new Map();
  for (let idx = 0; idx < communitiesSorted.length; idx++) {
    const cid = `c${idx}`;
    for (const m of communitiesSorted[idx]) communityIdByNode.set(m, cid);
  }

  return { communityIdByNode, communities: communitiesSorted, iterations };
}

/**
 * Count undirected edges with both endpoints in set.
 * @param {Set<string>} vertexSet
 * @param {Set<string>} undirectedKeys
 */
function internalEdgeCount(vertexSet, undirectedKeys) {
  let c = 0;
  for (const k of undirectedKeys) {
    const [a, b] = k.split("||");
    if (vertexSet.has(a) && vertexSet.has(b)) c += 1;
  }
  return c;
}

/**
 * Largest weakly-connected component size (undirected).
 * @param {string[]} nodes
 * @param {Map<string, Set<string>>} adj
 */
export function largestComponentSize(nodes, adj) {
  const visited = new Set();
  let largest = 0;
  for (const start of nodes) {
    if (visited.has(start)) continue;
    let sz = 0;
    const st = [start];
    while (st.length) {
      const u = st.pop();
      if (visited.has(u)) continue;
      visited.add(u);
      sz++;
      const nb = adj.get(u);
      if (nb) for (const v of nb) if (!visited.has(v)) st.push(v);
    }
    largest = Math.max(largest, sz);
  }
  return largest;
}

/**
 * @param {string[]} topPayers
 * @param {Array<{ from?: string, to?: string }>} peerEdges
 * @param {{ maxNodes?: number, maxIter?: number }} [opts]
 */
export function analyzePeerCommunities(topPayers, peerEdges, opts = {}) {
  const maxNodes = Math.min(24, Math.max(1, opts.maxNodes ?? 14));
  const maxIter = Math.min(100, Math.max(5, opts.maxIter ?? 50));

  const nodes = [...new Set(topPayers.map(String).filter(Boolean))].slice(0, maxNodes);
  const nodeSet = new Set(nodes);

  if (nodes.length < 2) {
    return {
      nodeCount: nodes.length,
      undirectedPeerEdges: 0,
      globalDensity: 0,
      largestConnectedComponent: nodes.length,
      communities: [],
      labelPropagationIterations: 0,
      algorithm: "label_propagation_deterministic",
    };
  }

  const undirected = buildUndirectedEdgeKeys(nodes, peerEdges, nodeSet);
  const n = nodes.length;
  const possible = (n * (n - 1)) / 2;
  const globalDensity = possible > 0 ? undirected.size / possible : 0;

  const adj = adjacencyFromUndirected(undirected);
  const lc = largestComponentSize(nodes, adj);

  const { communities: groups, iterations } = labelPropagationDeterministic(nodes, adj, maxIter);

  /** @type {{ id: string, memberCount: number, membersCompact: string[], internalEdges: number, internalDensity: number }[]} */
  const communities = [];

  for (let idx = 0; idx < groups.length; idx++) {
    const members = groups[idx];
    const k = members.length;
    const vset = new Set(members);
    const intE = internalEdgeCount(vset, undirected);
    const pos = k >= 2 ? (k * (k - 1)) / 2 : 0;
    const intD = pos > 0 ? intE / pos : 0;
    communities.push({
      id: `c${idx}`,
      memberCount: k,
      membersCompact: members.slice(0, 10).map(compactId),
      internalEdges: intE,
      internalDensity: Math.round(intD * 1000) / 1000,
    });
  }

  communities.sort((a, b) => b.memberCount - a.memberCount);

  const largest = communities[0];
  const largestCommunityInternalDensity = largest?.internalDensity ?? 0;

  return {
    nodeCount: n,
    undirectedPeerEdges: undirected.size,
    globalDensity: Math.round(globalDensity * 1000) / 1000,
    maxPossibleUndirectedEdges: possible,
    largestConnectedComponent: lc,
    largestCommunitySize: largest?.memberCount ?? 0,
    largestCommunityInternalDensity,
    communities,
    labelPropagationIterations: iterations,
    algorithm: "label_propagation_deterministic",
  };
}
