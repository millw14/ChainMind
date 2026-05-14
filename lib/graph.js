/**
 * Graph builder over persisted `edges`, `signers`, `program_calls`, `events`, `signatures`.
 *
 * Native System Program lamport transfers are recorded as `native_transfer` edges / `native_sol` mint in `transfers`; SPL flows use
 * `token_transfer`, `mint_to`, and `fee_payer_cosigner`.
 *
 * @module graph
 */

/** @typedef {{ tx_sig: string, scope_address: string, from_address: string, to_address: string, slot: number|null, edge_type: string, mint: string|null }} EdgeRow */

/** @typedef {{ outbound: Map<string, EdgeRow[]>, inbound: Map<string, EdgeRow[]> }} AdjacencyGraph */

/** @typedef {{
 *   to_address: string,
 *   tx_sig: string,
 *   edge_type: string,
 *   mint: string|null,
 *   slot: number|null,
 *   funded_at: number|null,
 *   recipient_first_fee_tx_at: number|null,
 *   passes_timing_heuristic: boolean
 * }} FundingRecipient */

/** @typedef {{
 *   wallet_a: string,
 *   wallet_b: string,
 *   cluster_score: number,
 *   overlap_fee_payer: number,
 *   overlap_funders: number,
 *   overlap_program_sequences: number,
 *   shared_fee_payers: number,
 *   shared_funders: number,
 *   shared_sequences: number
 * }} SybilPairScore */

/** @typedef {{
 *   tx_sig: string,
 *   scope_address: string,
 *   slot: number|null,
 *   block_time: number|null,
 *   flagged_addresses: string[],
 *   flagged_count: number
 * }} SharedSignerHit */

/**
 * Load edges into inbound + outbound adjacency lists (deduped parallel edges collapsed).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{
 *   scopeAddress?: string|null,
 *   minSlot?: number|null,
 *   maxSlot?: number|null,
 *   edgeTypes?: string[]|null,
 * }} [opts]
 * @returns {AdjacencyGraph}
 */
export function buildAdjacencyFromEdges(db, opts = {}) {
  const scopeAddress = opts.scopeAddress ?? null;
  const minSlot = opts.minSlot ?? null;
  const maxSlot = opts.maxSlot ?? null;
  const edgeTypes = opts.edgeTypes ?? null;

  let sql = `
    SELECT tx_sig, scope_address, from_address, to_address, slot, edge_type, mint
    FROM edges
    WHERE 1 = 1
  `;
  /** @type {(string|number|null)[]} */
  const params = [];

  if (scopeAddress) {
    sql += ` AND scope_address = ?`;
    params.push(scopeAddress);
  }
  if (minSlot != null) {
    sql += ` AND slot >= ?`;
    params.push(minSlot);
  }
  if (maxSlot != null) {
    sql += ` AND slot <= ?`;
    params.push(maxSlot);
  }
  if (edgeTypes?.length) {
    sql += ` AND edge_type IN (${edgeTypes.map(() => "?").join(",")})`;
    params.push(...edgeTypes);
  }

  /** @type {EdgeRow[]} */
  const rows = db.prepare(sql).all(...params);

  /** @type {Map<string, EdgeRow[]>} */
  const outbound = new Map();
  /** @type {Map<string, EdgeRow[]>} */
  const inbound = new Map();

  /** @type {Set<string>} */
  const seen = new Set();

  for (const r of rows) {
    const key = `${r.tx_sig}|${r.scope_address}|${r.from_address}|${r.to_address}|${r.edge_type}|${r.mint ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const edge = /** @type {EdgeRow} */ (r);
    if (!outbound.has(edge.from_address)) outbound.set(edge.from_address, []);
    outbound.get(edge.from_address).push(edge);

    if (!inbound.has(edge.to_address)) inbound.set(edge.to_address, []);
    inbound.get(edge.to_address).push(edge);
  }

  return { outbound, inbound };
}

/**
 * @param {Set<string>} a
 * @param {Set<string>} b
 */
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) inter++;
  }
  const uni = a.size + b.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

/**
 * Funding-like outbound edges from `rootAddress`.
 * Timing heuristic: keep rows where funding signature predates recipient's first `events.fee_payer = recipient` row (same scope), when available.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} rootAddress base58
 * @param {{
 *   scopeAddress: string,
 *   requireFundingBeforeRecipientActivity?: boolean,
 *   sinceUnix?: number|null,
 *   untilUnix?: number|null,
 * }} opts
 * @returns {FundingRecipient[]}
 */
export function fundingTree(db, rootAddress, opts) {
  const scope = opts.scopeAddress;
  const requireTiming = opts.requireFundingBeforeRecipientActivity !== false;
  const sinceUnix = opts.sinceUnix ?? null;
  const untilUnix = opts.untilUnix ?? null;

  let sql = `
    SELECT e.to_address AS to_address,
           e.tx_sig AS tx_sig,
           e.edge_type AS edge_type,
           e.mint AS mint,
           e.slot AS slot,
           sig.block_time AS funded_at
    FROM edges e
    LEFT JOIN signatures sig
      ON sig.signature = e.tx_sig AND sig.scope_address = e.scope_address
    WHERE e.scope_address = ?
      AND e.from_address = ?
      AND e.edge_type IN ('token_transfer', 'fee_payer_cosigner', 'mint_to', 'native_transfer')
  `;
  /** @type {(string|number|null)[]} */
  const params = [scope, rootAddress];

  if (sinceUnix != null) {
    sql += ` AND (sig.block_time IS NULL OR sig.block_time >= ?)`;
    params.push(sinceUnix);
  }
  if (untilUnix != null) {
    sql += ` AND (sig.block_time IS NULL OR sig.block_time <= ?)`;
    params.push(untilUnix);
  }

  /** @type {FundingRecipient[]} */
  const raw = db.prepare(sql).all(...params).map((row) => ({
    to_address: String(row.to_address),
    tx_sig: String(row.tx_sig),
    edge_type: String(row.edge_type),
    mint: row.mint != null ? String(row.mint) : null,
    slot: row.slot != null ? Number(row.slot) : null,
    funded_at: row.funded_at != null ? Number(row.funded_at) : null,
    recipient_first_fee_tx_at: /** @type {number|null} */ (null),
    passes_timing_heuristic: true,
  }));

  const firstFeeStmt = db.prepare(`
    SELECT MIN(block_time) AS t
    FROM events
    WHERE scope_address = ?
      AND fee_payer = ?
      AND block_time IS NOT NULL
  `);

  const out = [];
  const dedupe = new Set();

  for (const row of raw) {
    const key = `${row.to_address}|${row.tx_sig}|${row.edge_type}|${row.mint ?? ""}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);

    const fr = /** @type {FundingRecipient} */ ({ ...row });
    const first = firstFeeStmt.get(scope, row.to_address);
    fr.recipient_first_fee_tx_at = first?.t != null ? Number(first.t) : null;

    if (requireTiming && fr.funded_at != null && fr.recipient_first_fee_tx_at != null) {
      fr.passes_timing_heuristic = fr.funded_at < fr.recipient_first_fee_tx_at;
    } else if (requireTiming && fr.recipient_first_fee_tx_at == null) {
      fr.passes_timing_heuristic = true;
    }

    out.push(fr);
  }

  return out;
}

/**
 * Build tx_sig → ordered program trace string for txs inside [sinceUnix, untilUnix].
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} scopeAddress
 * @param {number|null} sinceUnix
 * @param {number|null} untilUnix
 */
function preloadProgramSequences(db, scopeAddress, sinceUnix, untilUnix) {
  let sql = `
    SELECT pc.tx_sig AS tx_sig,
           pc.program_id AS program_id,
           pc.instruction_name AS instruction_name,
           pc.idx AS idx
    FROM program_calls pc
    INNER JOIN signatures sig
      ON sig.signature = pc.tx_sig AND sig.scope_address = pc.scope_address
    WHERE pc.scope_address = ?
  `;
  /** @type {(string|number|null)[]} */
  const params = [scopeAddress];

  if (sinceUnix != null) {
    sql += ` AND sig.block_time >= ?`;
    params.push(sinceUnix);
  }
  if (untilUnix != null) {
    sql += ` AND sig.block_time <= ?`;
    params.push(untilUnix);
  }

  sql += ` ORDER BY pc.tx_sig ASC, pc.idx ASC`;

  const rows = db.prepare(sql).all(...params);

  /** @type {Map<string, string>} */
  const map = new Map();
  /** @type {Map<string, string[]>} */
  const buckets = new Map();

  for (const r of rows) {
    const sig = String(r.tx_sig);
    const part = `${String(r.program_id)}:${String(r.instruction_name)}`;
    if (!buckets.has(sig)) buckets.set(sig, []);
    buckets.get(sig).push(part);
  }

  for (const [sig, parts] of buckets) {
    map.set(sig, parts.join(">"));
  }

  return map;
}

/**
 * Distinct wallets touching signers table in window (cap list size).
 *
 * @param {import("better-sqlite3").Database} db
 */
function walletsActiveInWindow(db, scopeAddress, sinceUnix, untilUnix, limit = 200) {
  let sql = `
    SELECT DISTINCT si.address AS address
    FROM signers si
    INNER JOIN signatures sig
      ON sig.signature = si.tx_sig AND sig.scope_address = si.scope_address
    WHERE si.scope_address = ?
  `;
  /** @type {(string|number|null)[]} */
  const params = [scopeAddress];

  if (sinceUnix != null) {
    sql += ` AND sig.block_time >= ?`;
    params.push(sinceUnix);
  }
  if (untilUnix != null) {
    sql += ` AND sig.block_time <= ?`;
    params.push(untilUnix);
  }

  sql += ` LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params).map((r) => String(r.address));
}

/**
 * Fee payers observed on txs wallet participates in (any signer row).
 *
 * @param {import("better-sqlite3").Database} db
 */
function feePayersForWallet(db, scopeAddress, wallet, sinceUnix, untilUnix) {
  let sql = `
    SELECT DISTINCT fp.address AS fee_payer
    FROM signers si_w
    INNER JOIN signers fp
      ON fp.tx_sig = si_w.tx_sig
     AND fp.scope_address = si_w.scope_address
     AND fp.role = 'fee_payer'
    INNER JOIN signatures sig
      ON sig.signature = si_w.tx_sig AND sig.scope_address = si_w.scope_address
    WHERE si_w.scope_address = ?
      AND si_w.address = ?
      AND si_w.role IN ('signer', 'fee_payer')
  `;
  /** @type {(string|number|null)[]} */
  const params = [scopeAddress, wallet];

  if (sinceUnix != null) {
    sql += ` AND sig.block_time >= ?`;
    params.push(sinceUnix);
  }
  if (untilUnix != null) {
    sql += ` AND sig.block_time <= ?`;
    params.push(untilUnix);
  }

  const rows = db.prepare(sql).all(...params);
  return new Set(rows.map((r) => String(r.fee_payer)));
}

/**
 * Incoming funders via token or native SOL transfer edges (to_wallet is recipient).
 *
 * @param {import("better-sqlite3").Database} db
 */
function incomingFundersForWallet(db, scopeAddress, wallet, sinceUnix, untilUnix) {
  let sql = `
    SELECT DISTINCT e.from_address AS funder
    FROM edges e
    INNER JOIN signatures sig
      ON sig.signature = e.tx_sig AND sig.scope_address = e.scope_address
    WHERE e.scope_address = ?
      AND e.to_address = ?
      AND e.edge_type IN ('token_transfer', 'native_transfer')
  `;
  /** @type {(string|number|null)[]} */
  const params = [scopeAddress, wallet];

  if (sinceUnix != null) {
    sql += ` AND sig.block_time >= ?`;
    params.push(sinceUnix);
  }
  if (untilUnix != null) {
    sql += ` AND sig.block_time <= ?`;
    params.push(untilUnix);
  }

  const rows = db.prepare(sql).all(...params);
  return new Set(rows.map((r) => String(r.funder)));
}

/**
 * Ordered program-call fingerprints for txs wallet touches.
 *
 * @param {import("better-sqlite3").Database} db
 */
function sequenceKeysForWallet(db, scopeAddress, wallet, sinceUnix, untilUnix, seqByTx) {
  let sql = `
    SELECT DISTINCT si.tx_sig AS tx_sig
    FROM signers si
    INNER JOIN signatures sig
      ON sig.signature = si.tx_sig AND sig.scope_address = si.scope_address
    WHERE si.scope_address = ?
      AND si.address = ?
      AND si.role IN ('signer', 'fee_payer')
  `;
  /** @type {(string|number|null)[]} */
  const params = [scopeAddress, wallet];

  if (sinceUnix != null) {
    sql += ` AND sig.block_time >= ?`;
    params.push(sinceUnix);
  }
  if (untilUnix != null) {
    sql += ` AND sig.block_time <= ?`;
    params.push(untilUnix);
  }

  const rows = db.prepare(sql).all(...params);
  /** @type {Set<string>} */
  const keys = new Set();
  for (const r of rows) {
    const seq = seqByTx.get(String(r.tx_sig));
    if (seq) keys.add(seq);
  }
  return keys;
}

/**
 * Pairwise Sybil-style overlap score across fee-payer overlap, shared funders, shared program traces.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{
 *   scopeAddress: string,
 *   sinceUnix?: number|null,
 *   untilUnix?: number|null,
 *   maxWallets?: number,
 *   minClusterScore?: number,
 *   limitPairs?: number,
 * }} opts
 * @returns {SybilPairScore[]}
 */
export function sybilClusterPairs(db, opts) {
  const scope = opts.scopeAddress;
  const sinceUnix = opts.sinceUnix ?? null;
  const untilUnix = opts.untilUnix ?? null;
  const maxWallets = Math.min(400, Math.max(10, opts.maxWallets ?? 120));
  const minScore = opts.minClusterScore ?? 0.15;
  const limitPairs = Math.min(5000, opts.limitPairs ?? 500);

  const seqByTx = preloadProgramSequences(db, scope, sinceUnix, untilUnix);
  const wallets = walletsActiveInWindow(db, scope, sinceUnix, untilUnix, maxWallets);

  /** @type {Map<string, { fee: Set<string>, fund: Set<string>, seq: Set<string> }>} */
  const metrics = new Map();

  for (const w of wallets) {
    metrics.set(w, {
      fee: feePayersForWallet(db, scope, w, sinceUnix, untilUnix),
      fund: incomingFundersForWallet(db, scope, w, sinceUnix, untilUnix),
      seq: sequenceKeysForWallet(db, scope, w, sinceUnix, untilUnix, seqByTx),
    });
  }

  /** @type {SybilPairScore[]} */
  const scores = [];

  for (let i = 0; i < wallets.length; i++) {
    for (let j = i + 1; j < wallets.length; j++) {
      const wa = wallets[i];
      const wb = wallets[j];
      const ma = metrics.get(wa);
      const mb = metrics.get(wb);
      if (!ma || !mb) continue;

      const jFee = jaccard(ma.fee, mb.fee);
      const jFund = jaccard(ma.fund, mb.fund);
      const jSeq = jaccard(ma.seq, mb.seq);

      let sharedFee = 0;
      for (const x of ma.fee) if (mb.fee.has(x)) sharedFee++;

      let sharedFund = 0;
      for (const x of ma.fund) if (mb.fund.has(x)) sharedFund++;

      let sharedSeq = 0;
      for (const x of ma.seq) if (mb.seq.has(x)) sharedSeq++;

      const cluster_score = (jFee + jFund + jSeq) / 3;

      if (cluster_score >= minScore) {
        scores.push({
          wallet_a: wa,
          wallet_b: wb,
          cluster_score,
          overlap_fee_payer: jFee,
          overlap_funders: jFund,
          overlap_program_sequences: jSeq,
          shared_fee_payers: sharedFee,
          shared_funders: sharedFund,
          shared_sequences: sharedSeq,
        });
      }
    }
  }

  scores.sort((a, b) => b.cluster_score - a.cluster_score);
  return scores.slice(0, limitPairs);
}

/**
 * Transactions where at least `minFlagged` of `flaggedAddresses` appear as signers or fee payer.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string[]} flaggedAddresses base58
 * @param {{
 *   scopeAddress: string,
 *   sinceUnix?: number|null,
 *   untilUnix?: number|null,
 *   minFlagged?: number,
 *   limit?: number,
 * }} opts
 * @returns {SharedSignerHit[]}
 */
export function sharedSignerSets(db, flaggedAddresses, opts) {
  const scope = opts.scopeAddress;
  const sinceUnix = opts.sinceUnix ?? null;
  const untilUnix = opts.untilUnix ?? null;
  const minFlagged = Math.max(2, opts.minFlagged ?? 2);
  const limit = Math.min(500, opts.limit ?? 100);

  const flagged = [...new Set(flaggedAddresses.filter(Boolean))];
  if (flagged.length < minFlagged) return [];

  const placeholders = flagged.map(() => "?").join(",");

  let sql = `
    SELECT si.tx_sig AS tx_sig,
           si.scope_address AS scope_address,
           MIN(sig.slot) AS slot,
           MIN(sig.block_time) AS block_time,
           COUNT(DISTINCT CASE WHEN si.address IN (${placeholders}) THEN si.address END) AS flagged_here
    FROM signers si
    INNER JOIN signatures sig
      ON sig.signature = si.tx_sig AND sig.scope_address = si.scope_address
    WHERE si.scope_address = ?
      AND si.role IN ('signer', 'fee_payer')
  `;

  /** @type {(string|number|null)[]} */
  const params = [...flagged, scope];

  if (sinceUnix != null) {
    sql += ` AND sig.block_time >= ?`;
    params.push(sinceUnix);
  }
  if (untilUnix != null) {
    sql += ` AND sig.block_time <= ?`;
    params.push(untilUnix);
  }

  sql += `
    GROUP BY si.tx_sig, si.scope_address
    HAVING COUNT(DISTINCT CASE WHEN si.address IN (${placeholders}) THEN si.address END) >= ?
    ORDER BY block_time DESC
    LIMIT ?
  `;
  params.push(...flagged, minFlagged, limit);

  const grouped = db.prepare(sql).all(...params);

  /** @type {import("better-sqlite3").Statement} */
  const addrsStmt = db.prepare(`
    SELECT DISTINCT address AS address
    FROM signers
    WHERE tx_sig = ?
      AND scope_address = ?
      AND role IN ('signer', 'fee_payer')
      AND address IN (${placeholders})
  `);

  /** @type {SharedSignerHit[]} */
  const hits = [];

  for (const row of grouped) {
    const txSig = String(row.tx_sig);
    const flagged_here = Number(row.flagged_here);
    const flaggedAddrs = addrsStmt.all(txSig, scope, ...flagged).map((r) => String(r.address));

    hits.push({
      tx_sig: txSig,
      scope_address: String(row.scope_address),
      slot: row.slot != null ? Number(row.slot) : null,
      block_time: row.block_time != null ? Number(row.block_time) : null,
      flagged_addresses: flaggedAddrs,
      flagged_count: flagged_here,
    });
  }

  return hits;
}

export default {
  buildAdjacencyFromEdges,
  fundingTree,
  sybilClusterPairs,
  sharedSignerSets,
};
