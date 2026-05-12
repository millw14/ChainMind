import { fundingTree } from "../graph.js";
import {
  clamp01,
  defaultSlotWindow,
  fundersFromGraph,
  parseAmountBigInt,
  shortenAmountLabel,
} from "./shared.js";

const DEFAULT_LOOKBACK_SLOTS = 200_000;

/**
 * Funding hub roots many fresh wallets that each barely touch one mint — synthetic distribution footprint.
 *
 * @param {import("../graph.js").AdjacencyGraph} graph
 * @param {string} address focal wallet (often the coordinator or one burner)
 * @param {{
 *   db: import("better-sqlite3").Database,
 *   scopeAddress: string,
 *   mint?: string | null,
 *   funderAddress?: string | null,
 *   minSlot?: number | null,
 *   maxSlot?: number | null,
 *   lookbackSlots?: number,
 *   minRecipients?: number,
 *   maxTouchesPerWallet?: number,
 *   maxHoldSlots?: number,
 *   requireFundingBeforeActivity?: boolean,
 *   onlyTimingPass?: boolean,
 * }} params
 * @returns {import("./shared.js").DetectorResult}
 */
export function detectSybilPump(graph, address, params) {
  const db = params.db;
  const scope = params.scopeAddress;
  const mintFocus = params.mint?.trim() ?? null;
  const minRecipients = Math.max(4, params.minRecipients ?? 12);
  const maxTouches = Math.max(1, params.maxTouchesPerWallet ?? 2);
  const maxHoldSlots = params.maxHoldSlots ?? 720;
  const lookbackSlots = params.lookbackSlots ?? DEFAULT_LOOKBACK_SLOTS;

  let minSlot = params.minSlot ?? null;
  let maxSlot = params.maxSlot ?? null;
  if (minSlot == null && maxSlot == null) {
    const w = defaultSlotWindow(db, scope, lookbackSlots);
    minSlot = w.minSlot;
    maxSlot = w.maxSlot;
  }

  let root = params.funderAddress?.trim() ?? null;
  if (!root) {
    const gs = fundersFromGraph(graph, address);
    if (gs.length === 1) root = gs[0];
    else {
      const row = db
        .prepare(
          `
        SELECT from_address AS f, COUNT(*) AS c
        FROM edges
        WHERE scope_address = ?
          AND to_address = ?
          AND edge_type IN ('token_transfer', 'mint_to', 'fee_payer_cosigner')
        GROUP BY from_address
        ORDER BY c DESC
        LIMIT 1
      `,
        )
        .get(scope, address);
      root = row?.f ? String(row.f) : address;
    }
  }

  if (!root || minSlot == null || maxSlot == null) {
    return {
      flag: "sybil-pump",
      confidence: 0,
      evidence: [],
      summary: "Cannot evaluate sybil pump without a coordinator wallet and slot bounds.",
    };
  }

  let recipients = fundingTree(db, root, {
    scopeAddress: scope,
    requireFundingBeforeRecipientActivity: params.requireFundingBeforeActivity !== false,
  });
  if (params.onlyTimingPass !== false) {
    recipients = recipients.filter((r) => r.passes_timing_heuristic);
  }

  /** @type {{ to_address: string, funded_slot: number|null, tx_sig: string }[]} */
  const uniq = [];
  const seenAddr = new Set();
  for (const r of recipients) {
    if (seenAddr.has(r.to_address)) continue;
    seenAddr.add(r.to_address);
    uniq.push({
      to_address: r.to_address,
      funded_slot: r.slot,
      tx_sig: r.tx_sig,
    });
    if (uniq.length >= 240) break;
  }

  let mint = mintFocus;
  if (!mint && uniq.length) {
    /** @type {Map<string, number>} */
    const mc = new Map();
    const q = db.prepare(`
      SELECT mint FROM transfers
      WHERE scope_address = ?
        AND mint IS NOT NULL
        AND (from_address = ? OR to_address = ?)
    `);
    for (const r of uniq.slice(0, 90)) {
      const hits = q.all(scope, r.to_address, r.to_address);
      for (const h of hits) {
        const m = String(h.mint);
        mc.set(m, (mc.get(m) ?? 0) + 1);
      }
    }
    mint = [...mc.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }

  if (!mint) {
    return {
      flag: "sybil-pump",
      confidence: 0,
      evidence: [],
      summary: "Supply params.mint (or ingest transfers) so recipients' dominant mint can be inferred.",
    };
  }

  const xferStmt = db.prepare(`
    SELECT tx_sig AS tx_sig,
           slot AS slot,
           amount AS amount,
           from_address AS from_address,
           to_address AS to_address
    FROM transfers
    WHERE scope_address = ?
      AND mint = ?
      AND slot >= ? AND slot <= ?
      AND (from_address = ? OR to_address = ?)
  `);

  /** @type {{ wallet: string, txs: number, span: number, volume: bigint, funded_slot: number|null }[]} */
  const stats = [];

  for (const rec of uniq) {
    const w = rec.to_address;
    const rows = xferStmt.all(scope, mint, minSlot, maxSlot, w, w);
    /** @type {Set<string>} */
    const txs = new Set();
    /** @type {number[]} */
    const slots = [];
    let volume = 0n;
    for (const row of rows) {
      txs.add(String(row.tx_sig));
      if (row.slot != null) slots.push(Number(row.slot));
      volume += parseAmountBigInt(row.amount);
    }
    const span = slots.length ? Math.max(...slots) - Math.min(...slots) : 0;
    stats.push({
      wallet: w,
      txs: txs.size,
      span,
      volume,
      funded_slot: rec.funded_slot,
    });
  }

  const shallow = stats.filter((s) => s.txs > 0 && s.txs <= maxTouches && s.span <= maxHoldSlots);
  const denom = stats.filter((s) => s.txs > 0).length || 1;
  const breadth = uniq.length;

  if (breadth < minRecipients || shallow.length < Math.min(minRecipients, breadth * 0.55)) {
    return {
      flag: "sybil-pump",
      confidence: 0,
      evidence: [],
      summary: `Coordinator ${root.slice(0, 8)}… funded ${breadth} wallets but only ${shallow.length} show ≤${maxTouches} touches within ${maxHoldSlots} slots on ${mint.slice(0, 8)}….`,
    };
  }

  const ratio = shallow.length / denom;
  const burst = clamp01(breadth / (minRecipients + 18));
  const touchScore = clamp01((ratio - 0.45) / 0.45);
  const confidence = clamp01(burst * 0.48 + touchScore * 0.42 + clamp01(shallow.length / 80) * 0.1);

  /** @type {import("./shared.js").DetectorEvidence[]} */
  const evidence = [];

  evidence.push({
    wallet: root,
    action: `funding hub with ${breadth} deduped downstream wallets (${shallow.length} shallow traders on mint ${mint.slice(0, 8)}…)`,
    slot: uniq[0]?.funded_slot ?? null,
    mint,
  });

  for (const s of shallow.slice(0, 22)) {
    evidence.push({
      wallet: s.wallet,
      action: `${s.txs} distinct txs, span ${s.span} slots, moved ${shortenAmountLabel(s.volume)} · funded≈slot ${s.funded_slot ?? "?"}`,
      slot: s.funded_slot,
      mint,
    });
  }

  return {
    flag: "sybil-pump",
    confidence,
    evidence,
    summary: `${root.slice(0, 8)}… seeded ${breadth} wallets; ${shallow.length}/${denom} barely interact (≤${maxTouches} txs, ≤${maxHoldSlots} slots) with ${mint.slice(0, 8)}….`,
  };
}
