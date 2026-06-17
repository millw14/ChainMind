import { isKnownEntity } from "./known-entities.js";

/**
 * Summarize inbound funding-like edges from Turso `edges` for top fee payers.
 * Pure — no DB imports (safe for bundling).
 *
 * @param {string[]} topPayers — fee payer pubkeys (subset examined)
 * @param {Array<{ recipient?: string, funder?: string, tx_sig?: string, edge_type?: string, slot?: number | null, block_time?: number | null }>} rows
 */
export function summarizeFundingGraphFromEdges(topPayers, rows) {
  const list = topPayers.map(String).filter(Boolean).slice(0, 12);
  if (list.length === 0) {
    return { status: "skipped", reason: "no_payers" };
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      status: "no_edges",
      topPayersExamined: list.length,
      note:
        "No inbound token_transfer / native_transfer / fee_payer_cosigner / mint_to edges into these payers in this lookback — graph backfill may be incomplete.",
    };
  }

  const payersSet = new Set(list);
  /** @type {Map<string, Set<string>>} */
  const recipientToFunders = new Map();
  /** @type {Map<string, Set<string>>} */
  const funderToRecipients = new Map();

  for (const p of list) {
    recipientToFunders.set(p, new Set());
  }

  for (const r of rows) {
    const rec = String(r.recipient ?? "").trim();
    const fund = String(r.funder ?? "").trim();
    // Infra (routers/vaults/programs) and known entities (CEX/market-maker/launchpad
    // hot wallets) move tokens to many wallets as normal operation — they are not
    // "shared funders." Excluding them stops a single hub from looking like a sybil.
    if (!payersSet.has(rec) || !fund || isKnownEntity(fund)) continue;
    recipientToFunders.get(rec)?.add(fund);
    if (!funderToRecipients.has(fund)) funderToRecipients.set(fund, new Set());
    funderToRecipients.get(fund).add(rec);
  }

  /** @type {{ funder: string, recipientPayers: string[], recipientCount: number }[]} */
  const sharedInboundFunders = [];
  for (const [funder, recipients] of funderToRecipients) {
    if (recipients.size >= 2) {
      sharedInboundFunders.push({
        funder,
        recipientPayers: [...recipients],
        recipientCount: recipients.size,
      });
    }
  }
  sharedInboundFunders.sort((a, b) => b.recipientCount - a.recipientCount);

  const payerFunding = list.map((payer) => {
    const funders = recipientToFunders.get(payer) ?? new Set();
    const sample = [...funders].slice(0, 6);
    return {
      payer,
      inboundFunderCount: funders.size,
      fundersSample: sample,
    };
  });

  return {
    status: "attached",
    edgeRowsSampled: rows.length,
    topPayersExamined: list.length,
    payerFunding,
    sharedInboundFunders: sharedInboundFunders.slice(0, 8),
  };
}
