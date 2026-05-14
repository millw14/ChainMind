import { createClient } from "@libsql/client";

/** @returns {import("@libsql/client").Client | null} */
export function getTursoClient() {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) return null;
  return createClient({ url, authToken });
}

/**
 * @param {import("@libsql/client").Client} client
 * @param {string} scope
 * @param {number} cutoff unix seconds
 */
export async function tursoFetchScoreRows(client, scope, cutoff) {
  const result = await client.execute({
    sql: `
      SELECT fee_payer, block_time, programs_json, event_type
      FROM events
      WHERE scope_address = ?
        AND block_time IS NOT NULL
        AND block_time >= ?
        AND fee_payer IS NOT NULL
    `,
    args: [scope, cutoff],
  });

  return result.rows.map((row) => ({
    fee_payer: String(row.fee_payer ?? ""),
    block_time: Number(row.block_time),
    programs_json: String(row.programs_json ?? "[]"),
    event_type: String(row.event_type ?? "other"),
  }));
}

/**
 * @param {import("@libsql/client").Client} client
 */
export async function tursoFetchDbStats(client) {
  const sig = await client.execute("SELECT COUNT(*) AS c FROM signatures");
  const evt = await client.execute("SELECT COUNT(*) AS c FROM events");
  const sigTotal = Number(sig.rows[0]?.c ?? 0);
  const evtTotal = Number(evt.rows[0]?.c ?? 0);

  const scopes = await client.execute(`
    WITH scopes AS (
      SELECT DISTINCT scope_address AS scope FROM signatures
      UNION
      SELECT DISTINCT scope_address AS scope FROM events
    )
    SELECT
      scopes.scope,
      (SELECT COUNT(*) FROM signatures s WHERE s.scope_address = scopes.scope) AS signatures,
      (SELECT COUNT(*) FROM events e WHERE e.scope_address = scopes.scope) AS events
    FROM scopes
    ORDER BY events DESC, signatures DESC
  `);

  const byScope = scopes.rows.map((r) => ({
    scope: String(r.scope),
    signatures: Number(r.signatures ?? 0),
    events: Number(r.events ?? 0),
  }));

  return { signaturesTotal: sigTotal, eventsTotal: evtTotal, byScope };
}

const FUNDING_EDGE_TYPES = ["token_transfer", "fee_payer_cosigner", "mint_to"];

/**
 * Inbound funding-like edges (some wallet funded / touched these recipients).
 *
 * @param {import("@libsql/client").Client} client
 * @param {string} scope
 * @param {string[]} recipients
 * @param {number} sinceUnix
 * @param {number} [limit]
 */
export async function tursoFetchInboundFundingEdges(client, scope, recipients, sinceUnix, limit = 450) {
  const uniq = [...new Set(recipients.map(String).filter(Boolean))].slice(0, 12);
  if (uniq.length === 0) return [];

  const ph = uniq.map(() => "?").join(", ");
  const typePh = FUNDING_EDGE_TYPES.map(() => "?").join(", ");
  const sql = `
    SELECT e.to_address AS recipient,
           e.from_address AS funder,
           e.tx_sig AS tx_sig,
           e.edge_type AS edge_type,
           e.slot AS slot,
           sig.block_time AS block_time
    FROM edges e
    LEFT JOIN signatures sig
      ON sig.signature = e.tx_sig AND sig.scope_address = e.scope_address
    WHERE e.scope_address = ?
      AND e.to_address IN (${ph})
      AND e.edge_type IN (${typePh})
      AND (sig.block_time IS NULL OR sig.block_time >= ?)
    LIMIT ?
  `;

  const args = [scope, ...uniq, ...FUNDING_EDGE_TYPES, sinceUnix, limit];
  const result = await client.execute({ sql, args });

  return result.rows.map((row) => ({
    recipient: String(row.recipient ?? ""),
    funder: String(row.funder ?? ""),
    tx_sig: String(row.tx_sig ?? ""),
    edge_type: String(row.edge_type ?? ""),
    slot: row.slot != null ? Number(row.slot) : null,
    block_time: row.block_time != null ? Number(row.block_time) : null,
  }));
}
