/**
 * Pull compact inbound-funding rows for top co-active fee payers (Turso / libSQL).
 * Used to close the loop on “shared funder” hypotheses without shipping the full graph.
 *
 * @param {import("@libsql/client").Client} client
 * @param {string} scope
 * @param {number} cutoffUnix
 * @param {{ payer: string, events: number }[]} topPayerLinks
 * @param {number} maxPayers
 */
export async function fetchFundingSliceForTopPayers(client, scope, cutoffUnix, topPayerLinks, maxPayers = 6) {
  const payers = topPayerLinks
    .slice(0, maxPayers)
    .map((r) => String(r.payer ?? "").trim())
    .filter(Boolean);
  if (payers.length === 0) {
    return {
      status: "empty",
      note: "No fee payers in score window to attach funding rows.",
      payerInbound: {},
      sharedFunders: [],
      payerFirstSeen: {},
    };
  }

  /** @type {Record<string, { funder: string, tx_sig: string, edge_type: string, funded_at: number | null }[]>} */
  const payerInbound = {};
  /** @type {Record<string, number | null>} */
  const payerFirstSeen = {};

  const placeholders = payers.map(() => "?").join(",");
  const firstSeenRes = await client.execute({
    sql: `
      SELECT fee_payer, MIN(block_time) AS first_seen
      FROM events
      WHERE scope_address = ?
        AND block_time IS NOT NULL
        AND block_time >= ?
        AND fee_payer IN (${placeholders})
      GROUP BY fee_payer
    `,
    args: [scope, cutoffUnix, ...payers],
  });
  for (const row of firstSeenRes.rows) {
    const fp = String(row.fee_payer ?? "");
    const fs = row.first_seen != null ? Number(row.first_seen) : null;
    if (fp) payerFirstSeen[fp] = fs;
  }

  for (const payer of payers) {
    const result = await client.execute({
      sql: `
        SELECT e.from_address AS funder, e.tx_sig AS tx_sig, e.edge_type AS edge_type,
               sig.block_time AS funded_at
        FROM edges e
        LEFT JOIN signatures sig ON sig.signature = e.tx_sig AND sig.scope_address = e.scope_address
        WHERE e.scope_address = ?
          AND e.to_address = ?
          AND e.edge_type IN ('token_transfer', 'fee_payer_cosigner', 'mint_to', 'native_transfer')
          AND (sig.block_time IS NULL OR sig.block_time >= ?)
        ORDER BY sig.block_time DESC NULLS LAST
        LIMIT 12
      `,
      args: [scope, payer, cutoffUnix],
    });
    payerInbound[payer] = result.rows.map((row) => ({
      funder: String(row.funder ?? ""),
      tx_sig: String(row.tx_sig ?? ""),
      edge_type: String(row.edge_type ?? ""),
      funded_at: row.funded_at != null ? Number(row.funded_at) : null,
    }));
  }

  /** @type {Map<string, Set<string>>} */
  const funderToPayers = new Map();
  for (const [payer, edges] of Object.entries(payerInbound)) {
    const funders = new Set(edges.map((e) => e.funder).filter(Boolean));
    for (const f of funders) {
      if (!funderToPayers.has(f)) funderToPayers.set(f, new Set());
      funderToPayers.get(f).add(payer);
    }
  }

  const sharedFunders = [...funderToPayers.entries()]
    .filter(([, set]) => set.size >= 2)
    .map(([funder, set]) => ({
      funder,
      fundedPayers: [...set],
      payerCount: set.size,
    }))
    .sort((a, b) => b.payerCount - a.payerCount);

  const totalInbound = Object.values(payerInbound).reduce((n, arr) => n + arr.length, 0);

  return {
    status: totalInbound > 0 || Object.keys(payerFirstSeen).length > 0 ? "attached" : "empty",
    payerInbound,
    sharedFunders,
    payerFirstSeen,
  };
}
