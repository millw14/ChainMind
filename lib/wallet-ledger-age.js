/**
 * Summarize chain-backed wallet ages for top payers (from Turso wallet_first_seen).
 *
 * @param {string[]} topPayers — ordered fee payers of interest
 * @param {Array<{ address: string, first_signature?: string | null, first_slot?: number | null, first_block_time?: number | null, capped?: number | null }>} dbRows
 * @param {number} [nowSec]
 */
export function buildWalletLedgerAge(topPayers, dbRows, nowSec = Math.floor(Date.now() / 1000)) {
  const map = new Map();
  for (const r of dbRows) {
    const a = String(r.address ?? "").trim();
    if (a) map.set(a, r);
  }

  /** @type {Record<string, unknown>[]} */
  const rows = [];
  let withData = 0;
  let young7d = 0;
  let cappedCount = 0;

  for (const addr of topPayers) {
    const r = map.get(addr);
    const bt = r?.first_block_time != null ? Number(r.first_block_time) : null;
    if (r == null || !Number.isFinite(bt)) {
      rows.push({
        address: addr,
        firstSignature: r?.first_signature ?? null,
        firstSlot: r?.first_slot != null ? Number(r.first_slot) : null,
        firstBlockTime: null,
        ageDays: null,
        historyCapped: r?.capped != null ? Boolean(Number(r.capped)) : null,
      });
      continue;
    }

    withData += 1;
    const ageSec = nowSec - bt;
    const ageDays = ageSec / 86400;
    // Capped rows only prove the oldest tx IN THE WALKED WINDOW — a busy old
    // wallet looks hours old — so they never count toward the youth signal.
    const capped = Boolean(Number(r.capped));
    if (capped) cappedCount += 1;
    if (ageDays <= 7 && !capped) young7d += 1;

    rows.push({
      address: addr,
      firstSignature: r.first_signature ?? null,
      firstSlot: r.first_slot != null ? Number(r.first_slot) : null,
      firstBlockTime: bt,
      ageDays: Math.round(ageDays * 10) / 10,
      historyCapped: capped,
    });
  }

  const n = topPayers.length;
  const status = n === 0 ? "not_fetched" : withData === 0 ? "not_fetched" : withData >= Math.ceil(n * 0.5) ? "attached" : "partial";

  return {
    status,
    source: "turso_wallet_first_seen",
    payersExamined: n,
    payersWithData: withData,
    youngWalletsUnder7d: young7d,
    cappedCount,
    note:
      status === "not_fetched"
        ? "No chain-backed first-tx rows for these payers — run npm run wallet-age:backfill or enable CHAINMIND_FETCH_WALLET_AGE_ON_SCORE=1."
        : `${withData}/${n} top payers have first signature time from RPC; ${young7d} younger than 7d in this cohort (${cappedCount} history-capped rows excluded — see historyCapped per row).`,
    rows: rows.slice(0, 16),
  };
}
