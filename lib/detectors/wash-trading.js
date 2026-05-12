import {
  clamp01,
  defaultSlotWindow,
  fundersFromGraph,
  parseAmountBigInt,
  shortenAmountLabel,
} from "./shared.js";

const DEFAULT_MIN_PAIR_TRANSFERS = 8;
const DEFAULT_IMBALANCE_RATIO = 0.14;
const DEFAULT_LOOKBACK_SLOTS = 120_000;

/**
 * Two wallets pass the same token back and forth with near-flat net flow.
 *
 * @param {import("../graph.js").AdjacencyGraph} graph
 * @param {string} address
 * @param {{
 *   db: import("better-sqlite3").Database,
 *   scopeAddress: string,
 *   mint?: string | null,
 *   minSlot?: number | null,
 *   maxSlot?: number | null,
 *   lookbackSlots?: number,
 *   minPairTransfers?: number,
 *   maxNetImbalanceRatio?: number,
 * }} params
 * @returns {import("./shared.js").DetectorResult}
 */
export function detectWashTrading(graph, address, params) {
  const db = params.db;
  const scope = params.scopeAddress;
  const lookback = params.lookbackSlots ?? DEFAULT_LOOKBACK_SLOTS;

  let minSlot = params.minSlot ?? null;
  let maxSlot = params.maxSlot ?? null;
  if (minSlot == null && maxSlot == null) {
    const w = defaultSlotWindow(db, scope, lookback);
    minSlot = w.minSlot;
    maxSlot = w.maxSlot;
  }

  /** @type {string[]} */
  let mints = [];
  if (params.mint?.trim()) {
    mints = [params.mint.trim()];
  } else {
    const s = new Set();
    for (const e of graph.outbound.get(address) ?? []) {
      if (e.edge_type === "token_transfer" && e.mint) s.add(e.mint);
    }
    for (const e of graph.inbound.get(address) ?? []) {
      if (e.edge_type === "token_transfer" && e.mint) s.add(e.mint);
    }
    mints = [...s];
  }

  if (mints.length === 0 || minSlot == null || maxSlot == null) {
    return {
      flag: "wash-trading",
      confidence: 0,
      evidence: [],
      summary: "Not enough scoped transfer/mint data to evaluate wash trading.",
    };
  }

  const minPairTransfers = params.minPairTransfers ?? DEFAULT_MIN_PAIR_TRANSFERS;
  const maxNetImbalanceRatio = params.maxNetImbalanceRatio ?? DEFAULT_IMBALANCE_RATIO;

  const stmt = db.prepare(`
    SELECT from_address AS from_address,
           to_address AS to_address,
           amount AS amount,
           slot AS slot,
           tx_sig AS tx_sig
    FROM transfers
    WHERE scope_address = ?
      AND mint = ?
      AND slot IS NOT NULL
      AND slot >= ? AND slot <= ?
      AND (from_address = ? OR to_address = ?)
    ORDER BY slot ASC
  `);

  let best = /** @type {null | {
    mint: string,
    counterparty: string,
    freq: number,
    imbalanceRatio: number,
    confidenceRaw: number,
    sharedFunder: boolean,
    out: bigint,
    inn: bigint,
    evidence: import("./shared.js").DetectorEvidence[],
  }} */ (null);

  for (const mint of mints) {
    const rows = stmt.all(scope, mint, minSlot, maxSlot, address, address);

    /** @type {Map<string, Record<string, unknown>[]>} */
    const byCp = new Map();

    for (const r of rows) {
      const from = String(r.from_address);
      const to = String(r.to_address);
      const cp = from === address ? to : from;
      if (!byCp.has(cp)) byCp.set(cp, []);
      byCp.get(cp).push(r);
    }

    for (const [counterparty, rr] of byCp) {
      const funders = new Set(fundersFromGraph(graph, address));
      const cpFunders = new Set(fundersFromGraph(graph, counterparty));
      const sharedFunder = [...funders].some((f) => cpFunders.has(f));

      let out = 0n;
      let inn = 0n;
      /** @type {import("./shared.js").DetectorEvidence[]} */
      const ev = [];
      for (const r of rr) {
        const amt = parseAmountBigInt(r.amount);
        const slot = r.slot != null ? Number(r.slot) : null;
        if (String(r.from_address) === address && String(r.to_address) === counterparty) out += amt;
        else if (String(r.from_address) === counterparty && String(r.to_address) === address) inn += amt;
        const dir = String(r.from_address) === address ? "out" : "in";
        ev.push({
          wallet: address,
          action: `${dir === "out" ? "sent to" : "received from"} ${counterparty.slice(0, 8)}… · ${shortenAmountLabel(
            amt,
          )} (${mint.slice(0, 8)}…)`,
          slot,
          tx_sig: r.tx_sig != null ? String(r.tx_sig) : null,
          mint,
        });
      }

      const freq = rr.length;
      const leg = out > inn ? out : inn;
      const imbalanceRatio =
        leg === 0n ? 1 : Number((out > inn ? out - inn : inn - out)) / Number(leg === 0n ? 1n : leg);

      if (freq < minPairTransfers) continue;
      if (imbalanceRatio > maxNetImbalanceRatio * 1.35) continue;

      const slots = rr.map((x) => Number(x.slot)).filter(Number.isFinite);
      const slotSpan = slots.length ? Math.max(...slots) - Math.min(...slots) : 0;
      const density = slotSpan > 0 ? freq / slotSpan : freq / Math.max(1, maxSlot - minSlot);

      const balanceScore = clamp01(1 - imbalanceRatio / maxNetImbalanceRatio);
      const freqScore = clamp01((freq - minPairTransfers) / (minPairTransfers * 2));
      const speedScore = clamp01(density * 800);
      const linkScore = sharedFunder ? 0.12 : 0;
      const confidence = clamp01(balanceScore * 0.45 + freqScore * 0.32 + speedScore * 0.23 + linkScore);

      if (!best || confidence > best.mint.length) {
        /* placeholder to satisfy linter — real compare below */
      }
      if (
        !best ||
        confidence > best.confidenceRaw ||
        (confidence === best.confidenceRaw && freq > best.freq)
      ) {
        best = {
          mint,
          counterparty,
          freq,
          imbalanceRatio,
          slotSpan,
          out,
          inn,
          evidence: ev.slice(0, 24),
          sharedFunder: sharedFunder,
          confidenceRaw: confidence,
        };
      }
    }
  }

  if (!best) {
    return {
      flag: "wash-trading",
      confidence: 0,
      evidence: [],
      summary: "No counterparty showed high-frequency balanced two-way flow on a single mint.",
    };
  }

  const sumLine = `${shortenAmountLabel(best.out)} out / ${shortenAmountLabel(best.inn)} in vs ${best.counterparty.slice(
    0,
    6,
  )}…`;

  return {
    flag: "wash-trading",
    confidence: clamp01(best.confidenceRaw),
    evidence: best.evidence,
    summary: `${best.freq} transfers on mint ${best.mint.slice(0, 8)}… with ~balanced legs (${sumLine}, imbalance ${(
      best.imbalanceRatio * 100
    ).toFixed(1)}%)${best.sharedFunder ? "; wallets share a graph funder" : ""}.`,
  };
}
