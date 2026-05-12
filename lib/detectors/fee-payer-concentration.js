import { clamp01, defaultSlotWindow } from "./shared.js";

const DEFAULT_LOOKBACK_SLOTS = 180_000;

/**
 * Fee-payer dominance among TOKEN transfers touching a mint — complementary to v1 “distinct payers per bucket”.
 *
 * @param {import("../graph.js").AdjacencyGraph} graph reserved for future expansions (same detector signature family)
 * @param {string} address focal participant — boosts confidence when they ride under the dominant payer
 * @param {{
 *   db: import("better-sqlite3").Database,
 *   scopeAddress: string,
 *   mint: string,
 *   minSlot?: number | null,
 *   maxSlot?: number | null,
 *   lookbackSlots?: number,
 *   minTransfers?: number,
 *   minDominanceShare?: number,
 * }} params
 * @returns {import("./shared.js").DetectorResult}
 */
export function detectFeePayerConcentration(graph, address, params) {
  void graph;

  const db = params.db;
  const scope = params.scopeAddress;
  const mint = params.mint?.trim();
  const minTransfers = Math.max(12, params.minTransfers ?? 24);
  const minDominanceShare = params.minDominanceShare ?? 0.38;
  const lookbackSlots = params.lookbackSlots ?? DEFAULT_LOOKBACK_SLOTS;

  if (!mint) {
    return {
      flag: "fee-payer-concentration",
      confidence: 0,
      evidence: [],
      summary: "params.mint is required for fee payer concentration.",
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
      flag: "fee-payer-concentration",
      confidence: 0,
      evidence: [],
      summary: "Missing slot bounds — ingest signatures/transfers first.",
    };
  }

  /** @type {{ payer: string, c: number }[]} */
  const rows = db
    .prepare(
      `
    SELECT e.fee_payer AS payer, COUNT(*) AS c
    FROM transfers t
    INNER JOIN events e
      ON e.signature = t.tx_sig AND e.scope_address = t.scope_address
    WHERE t.scope_address = ?
      AND t.mint = ?
      AND t.slot >= ? AND t.slot <= ?
      AND e.fee_payer IS NOT NULL
    GROUP BY e.fee_payer
    ORDER BY c DESC
    LIMIT 48
  `,
    )
    .all(scope, mint, minSlot, maxSlot);

  const total = rows.reduce((acc, r) => acc + Number(r.c), 0);
  if (total < minTransfers || rows.length === 0) {
    return {
      flag: "fee-payer-concentration",
      confidence: 0,
      evidence: [],
      summary: `Only ${total} TOKEN transfers join events in-window — need ≥ ${minTransfers}.`,
    };
  }

  const top = rows[0];
  const topShare = Number(top.c) / total;
  const distinct = rows.filter((r) => Number(r.c) > 0).length;
  const baseline = distinct > 0 ? 1 / distinct : 0;

  /** focal participant rides dominant payer */
  let focalShareTop = 0;
  if (address?.trim()) {
    const focalRows = db
      .prepare(
        `
      SELECT e.fee_payer AS payer, COUNT(*) AS c
      FROM transfers t
      INNER JOIN events e
        ON e.signature = t.tx_sig AND e.scope_address = t.scope_address
      WHERE t.scope_address = ?
        AND t.mint = ?
        AND t.slot >= ? AND t.slot <= ?
        AND e.fee_payer IS NOT NULL
        AND (t.from_address = ? OR t.to_address = ?)
      GROUP BY e.fee_payer
      ORDER BY c DESC
      LIMIT 12
    `,
      )
      .all(scope, mint, minSlot, maxSlot, address.trim(), address.trim());
    const focalTotal = focalRows.reduce((acc, r) => acc + Number(r.c), 0);
    if (focalTotal > 0 && top?.payer) {
      const hit = focalRows.find((r) => String(r.payer) === String(top.payer));
      focalShareTop = hit ? Number(hit.c) / focalTotal : 0;
    }
  }

  const lift = baseline > 0 ? topShare / baseline : topShare * distinct;
  const dominanceGap = clamp01((topShare - minDominanceShare) / Math.max(1e-6, 1 - minDominanceShare));
  const entropyPenalty = clamp01((distinct - 3) / 18);
  let confidence = clamp01(dominanceGap * 0.62 + clamp01(Math.log1p(lift)) * 0.22 + (1 - entropyPenalty) * 0.16);

  if (focalShareTop >= 0.45 && address?.trim()) {
    confidence = clamp01(confidence + 0.08);
  }

  /** @type {import("./shared.js").DetectorEvidence[]} */
  const evidence = [];

  const topN = rows.slice(0, 8);
  for (const r of topN) {
    const c = Number(r.c);
    evidence.push({
      wallet: String(r.payer),
      action: `paid fees for ${c}/${total} mint-tagged transfers (${(c / total).toFixed(2)} share, ${distinct} distinct payers)`,
      slot: maxSlot,
      mint,
    });
  }

  if (address?.trim() && focalShareTop > 0) {
    evidence.push({
      wallet: address.trim(),
      action: `${(focalShareTop * 100).toFixed(0)}% of focal wallet's mint transfers used fee payer ${String(top.payer).slice(0, 8)}…`,
      slot: maxSlot,
      mint,
    });
  }

  return {
    flag: "fee-payer-concentration",
    confidence,
    evidence,
    summary: `Fee payer ${String(top.payer).slice(0, 8)}… sponsored ${(topShare * 100).toFixed(
      1,
    )}% of ${mint.slice(0, 8)}… transfers (${Number(top.c)}/${total}; ${distinct} payers).`,
  };
}
