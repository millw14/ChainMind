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
  console.log(
    "[tursoFetchScoreRows] scope:",
    scope,
    "cutoff:",
    cutoff,
    new Date(cutoff * 1000).toISOString(),
  );
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
 * Events in lookback for a scope — same filters as {@link tursoFetchScoreRows}, ordered by time (baseline CLI).
 *
 * @param {import("@libsql/client").Client} client
 * @param {string} scope
 * @param {number} cutoffSec unix seconds
 */
export async function fetchEventsForScope(client, scope, cutoffSec) {
  const result = await client.execute({
    sql: `
      SELECT fee_payer, block_time, programs_json, event_type
      FROM events
      WHERE scope_address = ?
        AND block_time IS NOT NULL
        AND block_time >= ?
        AND fee_payer IS NOT NULL
      ORDER BY block_time ASC
    `,
    args: [scope, cutoffSec],
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

  let edgesTotal = null;
  /** @type {Map<string, { edges: number, fundingLikeEdges: number }> | null} */
  let edgeByScope = null;
  try {
    const ec = await client.execute("SELECT COUNT(*) AS c FROM edges");
    edgesTotal = Number(ec.rows[0]?.c ?? 0);
    const erows = await client.execute(`
      SELECT scope_address AS scope,
             COUNT(*) AS edges,
             SUM(
               CASE WHEN edge_type IN ('token_transfer', 'fee_payer_cosigner', 'mint_to', 'native_transfer')
                 THEN 1 ELSE 0 END
             ) AS funding_like
      FROM edges
      GROUP BY scope_address
    `);
    edgeByScope = new Map();
    for (const r of erows.rows) {
      const sc = String(r.scope ?? "");
      edgeByScope.set(sc, {
        edges: Number(r.edges ?? 0),
        fundingLikeEdges: Number(r.funding_like ?? 0),
      });
    }
  } catch {
    edgesTotal = null;
    edgeByScope = null;
  }

  if (!edgeByScope) {
    return {
      signaturesTotal: sigTotal,
      eventsTotal: evtTotal,
      edgesTotal: null,
      byScope,
      graphFundingEdgeTypes: ["token_transfer", "fee_payer_cosigner", "mint_to", "native_transfer"],
    };
  }

  let merged = byScope.map((s) => {
    const e = edgeByScope.get(s.scope);
    return {
      ...s,
      edges: e?.edges ?? 0,
      fundingLikeEdges: e?.fundingLikeEdges ?? 0,
    };
  });

  for (const [scope, counts] of edgeByScope) {
    if (!merged.some((m) => m.scope === scope)) {
      merged.push({
        scope,
        signatures: 0,
        events: 0,
        edges: counts.edges,
        fundingLikeEdges: counts.fundingLikeEdges,
      });
    }
  }

  merged.sort((a, b) => {
    if (b.events !== a.events) return b.events - a.events;
    if (b.signatures !== a.signatures) return b.signatures - a.signatures;
    return b.edges - a.edges;
  });

  return {
    signaturesTotal: sigTotal,
    eventsTotal: evtTotal,
    edgesTotal,
    byScope: merged,
    graphFundingEdgeTypes: ["token_transfer", "fee_payer_cosigner", "mint_to", "native_transfer"],
  };
}

const FUNDING_EDGE_TYPES = ["token_transfer", "fee_payer_cosigner", "mint_to", "native_transfer"];

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

/**
 * Token transfers in lookback (for amount uniformity + wash heuristics).
 *
 * @param {import("@libsql/client").Client} client
 * @param {string} scope
 * @param {number} sinceUnix
 * @param {number} [limit]
 */
export async function tursoFetchTransfersWindow(client, scope, sinceUnix, limit = 2500) {
  const lim = Math.min(8000, Math.max(1, limit));
  const result = await client.execute({
    sql: `
      SELECT t.from_address AS from_address,
             t.to_address AS to_address,
             t.mint AS mint,
             t.amount AS amount,
             s.block_time AS block_time
      FROM transfers t
      INNER JOIN signatures s
        ON s.signature = t.tx_sig AND s.scope_address = t.scope_address
      WHERE t.scope_address = ?
        AND s.block_time IS NOT NULL
        AND s.block_time >= ?
      ORDER BY s.block_time DESC
      LIMIT ?
    `,
    args: [scope, sinceUnix, lim],
  });

  return result.rows.map((row) => ({
    from: String(row.from_address ?? ""),
    to: String(row.to_address ?? ""),
    mint: row.mint != null ? String(row.mint) : null,
    amount: String(row.amount ?? "0"),
    block_time: Number(row.block_time),
  }));
}

/**
 * Edges whose endpoints are both in `payers` (peer subgraph among active wallets).
 *
 * @param {import("@libsql/client").Client} client
 * @param {string} scope
 * @param {string[]} payers
 * @param {number} sinceUnix
 * @param {number} [limit]
 */
export async function tursoFetchPayerPeerEdges(client, scope, payers, sinceUnix, limit = 800) {
  const uniq = [...new Set(payers.map(String).filter(Boolean))].slice(0, 14);
  if (uniq.length < 2) return [];
  const ph = uniq.map(() => "?").join(", ");
  const lim = Math.min(4000, Math.max(1, limit));
  const sql = `
    SELECT e.from_address AS fa,
           e.to_address AS ta,
           e.edge_type AS et,
           e.mint AS mint,
           s.block_time AS bt
    FROM edges e
    INNER JOIN signatures s
      ON s.signature = e.tx_sig AND s.scope_address = e.scope_address
    WHERE e.scope_address = ?
      AND e.from_address IN (${ph})
      AND e.to_address IN (${ph})
      AND s.block_time IS NOT NULL
      AND s.block_time >= ?
    LIMIT ?
  `;
  const args = [scope, ...uniq, ...uniq, sinceUnix, lim];
  const result = await client.execute({ sql, args });

  return result.rows.map((row) => ({
    from: String(row.fa ?? ""),
    to: String(row.ta ?? ""),
    edge_type: String(row.et ?? ""),
    mint: row.mint != null ? String(row.mint) : null,
    block_time: Number(row.bt),
  }));
}

/**
 * @param {import("@libsql/client").Client} client
 * @param {string[]} addresses
 */
export async function tursoFetchWalletFirstSeenMany(client, addresses) {
  const uniq = [...new Set(addresses.map(String).filter(Boolean))].slice(0, 24);
  if (uniq.length === 0) return [];

  const ph = uniq.map(() => "?").join(", ");
  const result = await client.execute({
    sql: `
      SELECT address, first_signature, first_slot, first_block_time, pages_walked, capped, updated_at
      FROM wallet_first_seen
      WHERE address IN (${ph})
    `,
    args: uniq,
  });

  return result.rows.map((row) => ({
    address: String(row.address ?? ""),
    first_signature: row.first_signature != null ? String(row.first_signature) : null,
    first_slot: row.first_slot != null ? Number(row.first_slot) : null,
    first_block_time: row.first_block_time != null ? Number(row.first_block_time) : null,
    pages_walked: row.pages_walked != null ? Number(row.pages_walked) : null,
    capped: row.capped != null ? Number(row.capped) : 0,
    updated_at: String(row.updated_at ?? ""),
  }));
}

/**
 * @param {import("@libsql/client").Client} client
 * @param {{
 *   address: string,
 *   first_signature: string | null,
 *   first_slot: number | null,
 *   first_block_time: number | null,
 *   pages_walked?: number,
 *   capped?: number | boolean,
 * }} row
 */
export async function tursoUpsertWalletFirstSeen(client, row) {
  const now = new Date().toISOString();
  const cap = row.capped === true || row.capped === 1 ? 1 : 0;
  await client.execute({
    sql: `
      INSERT INTO wallet_first_seen
        (address, first_signature, first_slot, first_block_time, pages_walked, capped, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(address) DO UPDATE SET
        first_signature = excluded.first_signature,
        first_slot = excluded.first_slot,
        first_block_time = excluded.first_block_time,
        pages_walked = excluded.pages_walked,
        capped = excluded.capped,
        updated_at = excluded.updated_at
    `,
    args: [
      String(row.address).trim(),
      row.first_signature,
      row.first_slot,
      row.first_block_time,
      Number(row.pages_walked) || 0,
      cap,
      now,
    ],
  });
}

/**
 * @param {import("@libsql/client").Client} client
 * @param {Array<{ scope: string, ruleId: string, severity: string, detail: string, entities?: string[] }>} hits
 */
export async function tursoInsertSurfaceHits(client, hits) {
  const created = new Date().toISOString();
  for (const h of hits) {
    await client.execute({
      sql: `INSERT INTO surface_hits (created_at, scope_address, rule_id, severity, detail, entities_json)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        created,
        h.scope,
        h.ruleId,
        h.severity,
        h.detail.slice(0, 4000),
        JSON.stringify(h.entities ?? []),
      ],
    });
  }
}

/**
 * @param {import("@libsql/client").Client} client
 * @param {number} [limit]
 */
export async function tursoFetchSurfaceHits(client, limit = 48) {
  const result = await client.execute({
    sql: `
      SELECT id, created_at, scope_address, rule_id, severity, detail, entities_json
      FROM surface_hits
      ORDER BY id DESC
      LIMIT ?
    `,
    args: [Math.min(200, Math.max(1, limit))],
  });
  return result.rows.map((row) => {
    let entities = [];
    try {
      entities = JSON.parse(String(row.entities_json ?? "[]"));
      if (!Array.isArray(entities)) entities = [];
    } catch {
      entities = [];
    }
    return {
      id: Number(row.id),
      created_at: String(row.created_at ?? ""),
      scope_address: String(row.scope_address ?? ""),
      rule_id: String(row.rule_id ?? ""),
      severity: String(row.severity ?? "low"),
      detail: String(row.detail ?? ""),
      entities,
    };
  });
}

/**
 * @param {import("@libsql/client").Client} client
 * @param {{
 *   id: string,
 *   scope_address: string,
 *   window_minutes: number,
 *   last_hours: number,
 *   payload: Record<string, unknown>,
 * }} row
 */
export async function tursoInsertInvestigationCase(client, row) {
  const created = Math.floor(Date.now() / 1000);
  await client.execute({
    sql: `
      INSERT INTO investigation_cases (id, scope_address, created_at, window_minutes, last_hours, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    args: [
      row.id,
      row.scope_address,
      created,
      row.window_minutes,
      row.last_hours,
      JSON.stringify(row.payload),
    ],
  });
  return { createdAt: created };
}

/**
 * @param {import("@libsql/client").Client} client
 * @param {string} id
 * @returns {Promise<{
 *   id: string,
 *   scope_address: string,
 *   created_at: number,
 *   window_minutes: number,
 *   last_hours: number,
 *   payload: Record<string, unknown>,
 * } | null>}
 */
export async function tursoFetchInvestigationCase(client, id) {
  const result = await client.execute({
    sql: `
      SELECT id, scope_address, created_at, window_minutes, last_hours, payload_json
      FROM investigation_cases
      WHERE id = ?
    `,
    args: [String(id).trim()],
  });
  const row = result.rows[0];
  if (!row) return null;
  let payload = {};
  try {
    payload = JSON.parse(String(row.payload_json ?? "{}"));
    if (!payload || typeof payload !== "object") payload = {};
  } catch {
    payload = {};
  }
  return {
    id: String(row.id ?? ""),
    scope_address: String(row.scope_address ?? ""),
    created_at: Number(row.created_at) || 0,
    window_minutes: Number(row.window_minutes) || 0,
    last_hours: Number(row.last_hours) || 0,
    payload: /** @type {Record<string, unknown>} */ (payload),
  };
}

/**
 * Latest saved investigation cases for a scope (used in Groq Evidence Block prior-verdicts).
 *
 * @param {import("@libsql/client").Client} client
 * @param {string} scopeAddress
 * @param {number} [limit]
 * @returns {Promise<{ source: string, case_created_at: string | null, verdict: unknown, confidence: unknown, pattern: unknown, scope: unknown, analyzed_at: unknown }[]>}
 */
export async function tursoFetchRecentCaseVerdictsForScope(client, scopeAddress, limit = 3) {
  const lim = Math.min(10, Math.max(1, Number(limit) || 3));
  const result = await client.execute({
    sql: `
      SELECT created_at, payload_json
      FROM investigation_cases
      WHERE scope_address = ?
      ORDER BY created_at DESC
      LIMIT ?
    `,
    args: [String(scopeAddress ?? "").trim(), lim],
  });
  /** @type {{ source: string, case_created_at: string | null, verdict: unknown, confidence: unknown, pattern: unknown, scope: unknown, analyzed_at: unknown }[]} */
  const out = [];
  for (const row of result.rows) {
    const created = Number(row.created_at) || 0;
    let payload = {};
    try {
      payload = JSON.parse(String(row.payload_json ?? "{}"));
      if (!payload || typeof payload !== "object") payload = {};
    } catch {
      payload = {};
    }
    const groq = payload.groqAnalysis && typeof payload.groqAnalysis === "object" ? payload.groqAnalysis : null;
    const analysis = groq?.analysis && typeof groq.analysis === "object" ? groq.analysis : null;
    if (!analysis) continue;
    out.push({
      source: "investigation_case",
      case_created_at: created ? new Date(created * 1000).toISOString() : null,
      verdict: analysis.verdict ?? null,
      confidence: analysis.confidence ?? null,
      pattern: analysis.pattern ?? null,
      scope: analysis.scope ?? null,
      analyzed_at: analysis.analyzed_at ?? null,
    });
  }
  return out;
}

export async function tursoFetchRecentCases(client, limit = 20) {
  const lim = Math.min(50, Math.max(1, Number(limit) || 20));
  const result = await client.execute({
    sql: `SELECT id, scope_address, created_at, payload_json
          FROM investigation_cases
          ORDER BY created_at DESC
          LIMIT ?`,
    args: [lim],
  });
  return result.rows.map((row) => {
    let payload = {};
    try {
      payload = JSON.parse(String(row.payload_json ?? "{}"));
    } catch {}
    const analysis = payload?.groqAnalysis?.analysis ?? null;
    return {
      id: String(row.id ?? ""),
      scope_address: String(row.scope_address ?? ""),
      created_at: Number(row.created_at) || 0,
      verdict: analysis?.verdict ?? "dismiss",
      confidence: analysis?.confidence ?? 0,
      pattern: analysis?.pattern ?? "unknown",
      risk_level: analysis?.risk_level ?? "low",
    };
  });
}
