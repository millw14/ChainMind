import {
  clamp01,
  defaultSlotWindow,
  fundedRecipientsFromGraph,
  fundersFromGraph,
  parseAmountBigInt,
  shortenAmountLabel,
} from "./shared.js";

const DEFAULT_LOOKBACK_SLOTS = 150_000;
const DEFAULT_LOOKAHEAD_SLOTS = 12_000;
const MAX_CLUSTER_WALLETS = 96;

/**
 * Linked wallets (shared fee payer / shared funding hub) receiving the same mint from outsiders in a tight slot band,
 * optionally followed by elevated mint-side activity (volume-surrogate).
 *
 * @param {import("../graph.js").AdjacencyGraph} graph
 * @param {string} address
 * @param {{
 *   db: import("better-sqlite3").Database,
 *   scopeAddress: string,
 *   mint: string,
 *   minSlot?: number | null,
 *   maxSlot?: number | null,
 *   lookbackSlots?: number,
 *   lookaheadSlots?: number,
 *   minCluster?: number,
 *   maxSlotSpread?: number,
 *   linkViaFeePayer?: boolean,
 *   volumeSurgeRatio?: number,
 * }} params
 * @returns {import("./shared.js").DetectorResult}
 */
export function detectCoordinatedAccumulation(graph, address, params) {
  const db = params.db;
  const scope = params.scopeAddress;
  const mint = params.mint?.trim();
  const minCluster = Math.max(2, params.minCluster ?? 3);
  const maxSlotSpread = params.maxSlotSpread ?? 48;
  const lookbackSlots = params.lookbackSlots ?? DEFAULT_LOOKBACK_SLOTS;
  const lookaheadSlots = params.lookaheadSlots ?? DEFAULT_LOOKAHEAD_SLOTS;
  const surgeRatioNeed = params.volumeSurgeRatio ?? 1.55;

  if (!mint) {
    return {
      flag: "coordinated-accumulation",
      confidence: 0,
      evidence: [],
      summary: "Provide params.mint to evaluate coordinated accumulation.",
    };
  }

  let minSlot = params.minSlot ?? null;
  let maxSlot = params.maxSlot ?? null;
  if (minSlot == null && maxSlot == null) {
    const w = defaultSlotWindow(db, scope, lookbackSlots);
    minSlot = w.minSlot;
    maxSlot = w.maxSlot;
  }

  if (minSlot == null || maxSlot == null) {
    return {
      flag: "coordinated-accumulation",
      confidence: 0,
      evidence: [],
      summary: "Could not derive slot bounds — ingest signatures/transfers first.",
    };
  }

  /** @type {Set<string>} */
  const cluster = new Set([address]);

  const funders = fundersFromGraph(graph, address);
  for (const f of funders) {
    cluster.add(f);
    for (const r of fundedRecipientsFromGraph(graph, f)) cluster.add(r);
  }

  if (params.linkViaFeePayer !== false) {
    const fpStmt = db.prepare(`
      SELECT e.fee_payer AS fp, COUNT(*) AS c
      FROM events e
      INNER JOIN signers s ON s.tx_sig = e.signature AND s.scope_address = e.scope_address
      WHERE e.scope_address = ?
        AND s.address = ?
        AND e.slot >= ? AND e.slot <= ?
        AND e.fee_payer IS NOT NULL
      GROUP BY e.fee_payer
      ORDER BY c DESC
      LIMIT 8
    `);
    /** @type {{ fp: string }[]} */
    const fpRows = fpStmt.all(scope, address, minSlot, maxSlot);
    const fpList = fpRows.map((r) => String(r.fp)).filter(Boolean);
    if (fpList.length) {
      const ph = fpList.map(() => "?").join(",");
      const peers = db
        .prepare(
          `
        SELECT DISTINCT s2.address AS addr
        FROM events e2
        INNER JOIN signers s2 ON s2.tx_sig = e2.signature AND s2.scope_address = e2.scope_address
        WHERE e2.scope_address = ?
          AND e2.fee_payer IN (${ph})
          AND e2.slot >= ? AND e2.slot <= ?
          AND s2.role IN ('signer', 'fee_payer')
      `,
        )
        .all(scope, ...fpList, minSlot, maxSlot);
      for (const p of peers) cluster.add(String(p.addr));
    }
  }

  let clusterArr = [...cluster];
  let truncated = false;
  if (clusterArr.length > MAX_CLUSTER_WALLETS) {
    const seed = address;
    const pri = [];
    const seen = new Set();
    const push = (/** @type {string} */ x) => {
      if (!x || seen.has(x)) return;
      seen.add(x);
      pri.push(x);
    };
    push(seed);
    for (const f of funders) push(f);
    for (const f of funders) {
      for (const r of fundedRecipientsFromGraph(graph, f)) push(r);
    }
    for (const x of clusterArr) push(x);
    clusterArr = pri.slice(0, MAX_CLUSTER_WALLETS);
    truncated = pri.length > MAX_CLUSTER_WALLETS;
  }

  const placeholders = clusterArr.map(() => "?").join(",");
  /** @type {{ to_address: string, from_address: string, amount: string, slot: number|null, tx_sig: string }[]} */
  const rows = db
    .prepare(
      `
    SELECT to_address AS to_address,
           from_address AS from_address,
           amount AS amount,
           slot AS slot,
           tx_sig AS tx_sig
    FROM transfers
    WHERE scope_address = ?
      AND mint = ?
      AND slot >= ? AND slot <= ?
      AND to_address IN (${placeholders})
  `,
    )
    .all(scope, mint, minSlot, maxSlot, ...clusterArr);

  /** @type {Map<string, { amt: bigint, slots: number[], txs: Set<string>, outsiders: Set<string> }>} */
  const recv = new Map();
  const clusterSet = new Set(clusterArr);

  for (const r of rows) {
    const from = String(r.from_address);
    const to = String(r.to_address);
    if (clusterSet.has(from)) continue;
    const slot = r.slot != null ? Number(r.slot) : NaN;
    if (!Number.isFinite(slot)) continue;
    const amt = parseAmountBigInt(r.amount);
    const tx = String(r.tx_sig);
    if (!recv.has(to))
      recv.set(to, { amt: 0n, slots: [], txs: new Set(), outsiders: new Set() });
    const agg = recv.get(to);
    agg.amt += amt;
    agg.slots.push(slot);
    agg.txs.add(tx);
    agg.outsiders.add(from);
  }

  /** @type {{ wallet: string, amt: bigint, lo: number, hi: number, txs: number, outsiders: Set<string> }[]} */
  const buyers = [];
  for (const [wallet, agg] of recv) {
    if (!clusterSet.has(wallet)) continue;
    if (agg.slots.length === 0) continue;
    buyers.push({
      wallet,
      amt: agg.amt,
      lo: Math.min(...agg.slots),
      hi: Math.max(...agg.slots),
      txs: agg.txs.size,
      outsiders: agg.outsiders,
    });
  }

  let bandLo = Infinity;
  let bandHi = -Infinity;
  for (const b of buyers) {
    bandLo = Math.min(bandLo, b.lo);
    bandHi = Math.max(bandHi, b.hi);
  }
  const spread = Number.isFinite(bandLo) ? bandHi - bandLo : Infinity;

  if (buyers.length < minCluster || spread > maxSlotSpread) {
    return {
      flag: "coordinated-accumulation",
      confidence: 0,
      evidence: [],
      summary:
        buyers.length < minCluster
          ? `Only ${buyers.length} linked wallets received outside mint in-flow in-band — need ≥ ${minCluster}.`
          : `Receiver slots span ${spread} (> ${maxSlotSpread}) — accumulation looks diffuse.`,
    };
  }

  let surgeBoost = 0;
  let surgeObserved = 1;
  if (lookaheadSlots > 0 && Number.isFinite(bandHi)) {
    const aheadHi = bandHi + lookaheadSlots;
    const aheadCount =
      db
        .prepare(
          `
      SELECT COUNT(*) AS c FROM transfers
      WHERE scope_address = ? AND mint = ?
        AND slot > ? AND slot <= ?
    `,
        )
        .get(scope, mint, bandHi, aheadHi)?.c ?? 0;
    const baselineSpan = bandHi - bandLo || 1;
    const behindLo = Math.max(minSlot, bandLo - baselineSpan);
    const baselineLen = Math.max(1, bandLo - behindLo);
    const baselineCount =
      db
        .prepare(
          `
      SELECT COUNT(*) AS c FROM transfers
      WHERE scope_address = ? AND mint = ?
        AND slot >= ? AND slot < ?
    `,
        )
        .get(scope, mint, behindLo, bandLo)?.c ?? 0;
    const baselineRate = baselineCount / baselineLen;
    const aheadRate = aheadCount / lookaheadSlots;
    surgeObserved = baselineRate > 0 ? aheadRate / baselineRate : aheadRate > 0 ? surgeRatioNeed + 1 : 1;
    surgeBoost = clamp01((surgeObserved - 1) / Math.max(0.01, surgeRatioNeed - 1)) * 0.35;
  }

  const cohesion = clamp01(buyers.length / (minCluster + 5));
  const tightness = clamp01(1 - spread / Math.max(maxSlotSpread * 4, spread));
  const diversity =
    buyers.reduce((acc, b) => acc + Math.min(4, b.outsiders.size), 0) / Math.max(1, buyers.length * 4);

  let confidence = clamp01(cohesion * 0.42 + tightness * 0.38 + diversity * 0.15 + surgeBoost);

  /** @type {import("./shared.js").DetectorEvidence[]} */
  const evidence = [];

  if (truncated) {
    evidence.push({
      wallet: scope,
      action: `Cluster linkage capped at ${MAX_CLUSTER_WALLETS} wallets for SQL bounds.`,
      slot: bandLo !== Infinity ? bandLo : null,
    });
  }

  const sortedBuyers = [...buyers].sort((a, b) => a.lo - b.lo).slice(0, 24);
  for (const b of sortedBuyers) {
    const hub = fundersFromGraph(graph, b.wallet)[0];
    const fundStr = hub ? `${hub.slice(0, 8)}…` : "unknown";
    evidence.push({
      wallet: b.wallet,
      action: `received ${shortenAmountLabel(b.amt)} ${mint.slice(0, 8)}… from outsiders (${b.outsiders.size} routes, ${b.txs} txs); linked funding hub ~ ${fundStr}`,
      slot: b.lo,
      mint,
    });
  }

  const surgeNote =
    lookaheadSlots > 0 && surgeBoost > 0
      ? ` Post-band activity ~${surgeObserved.toFixed(2)}× baseline (threshold ${surgeRatioNeed}).`
      : "";

  return {
    flag: "coordinated-accumulation",
    confidence,
    evidence,
    summary: `${buyers.length} linked wallets accumulated outside-sourced ${mint.slice(
      0,
      8,
    )}… within ${spread} slots (${bandLo}→${bandHi}).${surgeNote}`,
  };
}
