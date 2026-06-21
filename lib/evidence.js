/**
 * lib/evidence.js
 *
 * Evidence layer — builds a case file from ingested on-chain data.
 *
 * Tables used (schema confirmed from persist-tx-graph.js / db.js):
 *   events    — signature, scope_address, block_time, fee_payer, event_type
 *   transfers — tx_sig, scope_address, from_address, to_address, mint, amount, slot
 *   edges     — scope_address, from_address, to_address, tx_sig, slot, edge_type, mint
 *   signers   — tx_sig, scope_address, address, role
 *
 * Note: transfers and edges carry slot, not block_time. We resolve timestamps
 * by joining back to events on signature = tx_sig where needed.
 *
 * Compatible with better-sqlite3 (local) and @libsql/client (Turso).
 * Pass whichever db client your route already has open — same pattern as
 * score-core.js and turso.js.
 */

// ---------------------------------------------------------------------------
// DB adapter
// ---------------------------------------------------------------------------

/**
 * @param {import("better-sqlite3").Database | import("@libsql/client").Client} db
 * @param {string} sql
 * @param {unknown[]} params
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function q(db, sql, params = []) {
  if (typeof db.prepare === "function") {
    return db.prepare(sql).all(...params);
  }
  if (typeof db.execute === "function") {
    const result = await db.execute({ sql, args: params });
    return result.rows ?? [];
  }
  throw new Error(
    "evidence.js: unsupported db — expected better-sqlite3 or @libsql/client"
  );
}

// Edge types from parse-tx-graph.js (excludes burn, fee_payer_cosigner for inbound-value semantics)
const FUNDING_EDGE_TYPES_SQL = `('native_transfer', 'token_transfer', 'mint_to')`;

// --- Bounds. A hot scope (e.g. Sakura: 24,734 edges) would otherwise ship every
// row into one /api/evidence JSON body and stall the dashboard indefinitely.
// These cap the work + payload so the build always returns in a bounded time.
const MAX_EDGES_RETURNED = 4000; // edge rows shipped in the payload (graph sample)
const MAX_TIMELINE_EVENTS = 25000; // spine of the case file; keeps most-recent N
const MAX_TIMELINE_TRANSFERS = 25000; // transfer legs joined onto the timeline
// SQLite/libSQL bind-parameter ceiling is ~999 (older) / 32766 (newer). Chunk the
// funding lookup so a busy scope's wallet set never trips "too many SQL variables"
// (which previously hit the catch() and silently dropped ALL funding links).
const FUNDING_LOOKUP_CHUNK = 400;

// ---------------------------------------------------------------------------
// Coordination window membership
// A minute bucket is "hot" when it has >= threshold distinct fee payers.
// Returns the set of signatures inside any hot bucket.
// ---------------------------------------------------------------------------

/**
 * @param {object} db
 * @param {string} scopeAddress
 * @param {number} cutoff      unix seconds
 * @param {number} threshold
 * @returns {Promise<Set<string>>}
 */
async function buildFlaggedSet(db, scopeAddress, cutoff, threshold = 3) {
  const rows = await q(
    db,
    `SELECT
       CAST(block_time / 60 AS INTEGER) AS bucket,
       COUNT(DISTINCT fee_payer)        AS payer_count,
       GROUP_CONCAT(signature, '|')     AS sigs
     FROM events
     WHERE scope_address = ?
       AND block_time >= ?
       AND block_time IS NOT NULL
       AND fee_payer IS NOT NULL
     GROUP BY bucket
     HAVING payer_count >= ?`,
    [scopeAddress, cutoff, threshold]
  );

  const flagged = new Set();
  for (const row of rows) {
    for (const sig of String(row.sigs ?? "").split("|")) {
      if (sig) flagged.add(sig);
    }
  }
  return flagged;
}

// ---------------------------------------------------------------------------
// buildTimeline
// ---------------------------------------------------------------------------

/**
 * @typedef {object} TimelineEntry
 * @property {string}      timestamp
 * @property {number}      block_time
 * @property {string}      signature
 * @property {string}      event_type
 * @property {string|null} from_wallet
 * @property {string|null} to_wallet
 * @property {string|null} mint
 * @property {number|null} amount
 * @property {string|null} fee_payer
 * @property {boolean}     coordinated
 * @property {string}      explorer
 */

/**
 * @param {object} db
 * @param {string} scopeAddress
 * @param {number} lookbackH
 * @returns {Promise<TimelineEntry[]>}
 */
export async function buildTimeline(db, scopeAddress, lookbackH = 24) {
  const cutoff = Math.floor(Date.now() / 1000) - lookbackH * 3600;
  const flagged = await buildFlaggedSet(db, scopeAddress, cutoff);

  // Cap the spine to the most-recent N (inner DESC + LIMIT), then re-sort ASC so the
  // timeline still reads oldest→newest. On normal scopes the cap is never reached.
  const events = await q(
    db,
    `SELECT signature, block_time, fee_payer, event_type
     FROM (
       SELECT signature, block_time, fee_payer, event_type
       FROM events
       WHERE scope_address = ?
         AND block_time >= ?
         AND block_time IS NOT NULL
       ORDER BY block_time DESC
       LIMIT ?
     )
     ORDER BY block_time ASC`,
    [scopeAddress, cutoff, MAX_TIMELINE_EVENTS]
  );

  // Pull transfers joined to their event's block_time (bounded — see MAX_TIMELINE_TRANSFERS)
  const transfers = await q(
    db,
    `SELECT t.tx_sig, t.from_address, t.to_address, t.mint, t.amount,
            e.block_time, e.fee_payer
     FROM transfers t
     LEFT JOIN events e
       ON e.signature = t.tx_sig
       AND e.scope_address = t.scope_address
     WHERE t.scope_address = ?
       AND e.block_time >= ?
     LIMIT ?`,
    [scopeAddress, cutoff, MAX_TIMELINE_TRANSFERS]
  ).catch(() => []);

  // Index by tx_sig
  /** @type {Map<string, object[]>} */
  const txMap = new Map();
  for (const t of transfers) {
    if (!txMap.has(t.tx_sig)) txMap.set(t.tx_sig, []);
    txMap.get(t.tx_sig).push(t);
  }

  const timeline = [];

  for (const ev of events) {
    const sig = ev.signature;
    const bt = Number(ev.block_time);
    const related = txMap.get(sig) ?? [];

    if (related.length === 0) {
      timeline.push({
        timestamp: new Date(bt * 1000).toISOString(),
        block_time: bt,
        signature: sig,
        event_type: ev.event_type ?? "fee_pay",
        from_wallet: ev.fee_payer ?? null,
        to_wallet: null,
        mint: null,
        amount: null,
        fee_payer: ev.fee_payer ?? null,
        coordinated: flagged.has(sig),
        explorer: `https://solscan.io/tx/${sig}`,
      });
    } else {
      for (const t of related) {
        timeline.push({
          timestamp: new Date(bt * 1000).toISOString(),
          block_time: bt,
          signature: sig,
          event_type: "transfer",
          from_wallet: t.from_address ?? null,
          to_wallet: t.to_address ?? null,
          mint: t.mint ?? null,
          amount: t.amount ?? null,
          fee_payer: ev.fee_payer ?? null,
          coordinated: flagged.has(sig),
          explorer: `https://solscan.io/tx/${sig}`,
        });
      }
    }
  }

  return timeline;
}

// ---------------------------------------------------------------------------
// buildWalletTable
// ---------------------------------------------------------------------------

/**
 * @typedef {object} WalletRow
 * @property {string}      address
 * @property {string}      first_seen
 * @property {string}      last_seen
 * @property {number}      tx_count
 * @property {string}      role
 * @property {number}      coordinated_txs
 * @property {string|null} funded_by
 * @property {string|null} funding_tx_sig
 * @property {string|null} funding_tx_url
 */

/**
 * @param {object} db
 * @param {string} scopeAddress
 * @param {TimelineEntry[]} timeline
 * @returns {Promise<WalletRow[]>}
 */
export async function buildWalletTable(db, scopeAddress, timeline) {
  /** @type {Map<string, { address:string, first_seen:string, last_seen:string, tx_count:number, roles:Set<string>, coordinated_txs:number, funded_by:string|null, funding_tx_sig:string|null, funding_tx_url:string|null }>} */
  const walletMap = new Map();

  const touch = (address, entry, role) => {
    if (!address) return;
    if (!walletMap.has(address)) {
      walletMap.set(address, {
        address,
        first_seen: entry.timestamp,
        last_seen: entry.timestamp,
        tx_count: 0,
        roles: new Set(),
        coordinated_txs: 0,
        funded_by: null,
        funding_tx_sig: null,
        funding_tx_url: null,
      });
    }
    const w = walletMap.get(address);
    if (entry.timestamp < w.first_seen) w.first_seen = entry.timestamp;
    if (entry.timestamp > w.last_seen) w.last_seen = entry.timestamp;
    w.tx_count += 1;
    w.roles.add(role);
    if (entry.coordinated) w.coordinated_txs += 1;
  };

  for (const entry of timeline) {
    touch(entry.fee_payer, entry, "fee_payer");
    touch(entry.from_wallet, entry, "sender");
    touch(entry.to_wallet, entry, "recipient");
  }

  // Resolve first inbound funder for each wallet via edges + events join.
  // Chunk the IN() list so a busy scope's wallet set can't trip the bind-parameter
  // ceiling (which previously failed the whole query and dropped all funding links).
  const addresses = [...walletMap.keys()];

  for (let i = 0; i < addresses.length; i += FUNDING_LOOKUP_CHUNK) {
    const chunk = addresses.slice(i, i + FUNDING_LOOKUP_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");

    const fundingEdges = await q(
      db,
      `SELECT ed.from_address, ed.to_address, ed.tx_sig, ev.block_time
       FROM edges ed
       LEFT JOIN events ev
         ON ev.signature = ed.tx_sig
         AND ev.scope_address = ed.scope_address
       WHERE ed.scope_address = ?
         AND ed.to_address IN (${placeholders})
         AND ed.edge_type IN ${FUNDING_EDGE_TYPES_SQL}
       ORDER BY ev.block_time ASC`,
      [scopeAddress, ...chunk]
    ).catch(() => []);

    for (const edge of fundingEdges) {
      const w = walletMap.get(edge.to_address);
      if (w && !w.funded_by) {
        w.funded_by = edge.from_address;
        w.funding_tx_sig = edge.tx_sig;
        w.funding_tx_url = `https://solscan.io/tx/${edge.tx_sig}`;
      }
    }
  }

  return [...walletMap.values()]
    .map((w) => ({
      address: w.address,
      first_seen: w.first_seen,
      last_seen: w.last_seen,
      tx_count: w.tx_count,
      role: w.roles.size > 1 ? "multi" : [...w.roles][0] ?? "unknown",
      coordinated_txs: w.coordinated_txs,
      funded_by: w.funded_by,
      funding_tx_sig: w.funding_tx_sig,
      funding_tx_url: w.funding_tx_url,
    }))
    .sort(
      (a, b) =>
        b.coordinated_txs - a.coordinated_txs || b.tx_count - a.tx_count
    );
}

// ---------------------------------------------------------------------------
// buildEdges
// ---------------------------------------------------------------------------

/**
 * @param {object} db
 * @param {string} scopeAddress
 * @param {number} lookbackH
 * @returns {Promise<object[]>}
 */
export async function buildEdges(db, scopeAddress, lookbackH = 24) {
  const cutoff = Math.floor(Date.now() / 1000) - lookbackH * 3600;

  // Bounded: ship at most MAX_EDGES_RETURNED of the most-recent edges. Without this,
  // a hot scope returns tens of thousands of rows in one JSON body and the panel hangs.
  const rows = await q(
    db,
    `SELECT ed.from_address, ed.to_address, ed.tx_sig, ed.edge_type, ed.mint,
            ev.block_time
     FROM edges ed
     LEFT JOIN events ev
       ON ev.signature = ed.tx_sig
       AND ev.scope_address = ed.scope_address
     WHERE ed.scope_address = ?
       AND (ev.block_time IS NULL OR ev.block_time >= ?)
     ORDER BY ev.block_time DESC
     LIMIT ?`,
    [scopeAddress, cutoff, MAX_EDGES_RETURNED]
  ).catch(() => []);

  return rows.map((r) => ({
    from: r.from_address,
    to: r.to_address,
    tx_sig: r.tx_sig,
    edge_type: r.edge_type ?? "unknown",
    mint: r.mint ?? null,
    timestamp: r.block_time
      ? new Date(Number(r.block_time) * 1000).toISOString()
      : null,
    explorer: `https://solscan.io/tx/${r.tx_sig}`,
  }));
}

// ---------------------------------------------------------------------------
// buildSharedFunders
// Groups flagged wallets by shared inbound funder.
// This is the strongest cluster signal — feeds Groq and the wallet table UI.
// ---------------------------------------------------------------------------

/**
 * @param {WalletRow[]} wallets
 * @returns {{ funder: string, funded: string[], funding_tx_sigs: string[] }[]}
 */
export function buildSharedFunders(wallets) {
  /** @type {Map<string, { funded: string[], sigs: string[] }>} */
  const map = new Map();

  for (const w of wallets) {
    if (!w.funded_by) continue;
    if (!map.has(w.funded_by)) map.set(w.funded_by, { funded: [], sigs: [] });
    const entry = map.get(w.funded_by);
    entry.funded.push(w.address);
    if (w.funding_tx_sig) entry.sigs.push(w.funding_tx_sig);
  }

  return [...map.entries()]
    .filter(([, v]) => v.funded.length > 1)
    .map(([funder, v]) => ({
      funder,
      funded: v.funded,
      funding_tx_sigs: v.sigs,
    }))
    .sort((a, b) => b.funded.length - a.funded.length);
}

// ---------------------------------------------------------------------------
// buildEvidencePayload — master export
// Full case file for /api/evidence and optional merge into groq-brief data.
// ---------------------------------------------------------------------------

/**
 * @param {object} db
 * @param {string} scopeAddress
 * @param {{ lookbackH?: number }} opts
 */
export async function buildEvidencePayload(db, scopeAddress, opts = {}) {
  const { lookbackH = 24 } = opts;

  const [timeline, edges] = await Promise.all([
    buildTimeline(db, scopeAddress, lookbackH),
    buildEdges(db, scopeAddress, lookbackH),
  ]);

  const wallets = await buildWalletTable(db, scopeAddress, timeline);
  const sharedFunders = buildSharedFunders(wallets);

  const edgesCapped = edges.length >= MAX_EDGES_RETURNED;
  const eventsCapped = timeline.length >= MAX_TIMELINE_EVENTS;

  return {
    scope: scopeAddress,
    generated_at: new Date().toISOString(),
    lookback_h: lookbackH,
    summary: {
      total_events: timeline.length,
      coordinated_events: timeline.filter((e) => e.coordinated).length,
      total_wallets: wallets.length,
      flagged_wallets: wallets.filter((w) => w.coordinated_txs > 0).length,
      shared_funder_clusters: sharedFunders.length,
      edges_found: edges.length,
      // When true, the arrays are a bounded most-recent sample — the scope has more
      // than the cap. Headline totals come from /api/db-stats, not this sample.
      edges_capped: edgesCapped,
      events_capped: eventsCapped,
    },
    timeline,
    wallets,
    edges,
    shared_funders: sharedFunders,
  };
}
