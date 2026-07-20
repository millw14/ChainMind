import { PublicKey } from "@solana/web3.js";
import { withRpcRetry } from "./rpc-retry.js";
import { persistIngestedTx } from "./persist-tx-graph.js";

/**
 * Pull newest signatures for a scope until RPC returns nothing or we overlap an existing row
 * (same signature + scope), or budgets are hit.
 *
 * When a walk stops on max_new the signatures below its last insert are unchecked, and the
 * next head walk would stop at this round's newest row — sealing the gap forever. So the
 * budget-interrupted position is persisted as a resume cursor in ingest_state and drained
 * first on later rounds until true overlap / end of history; only then is it cleared.
 *
 * @param {import("@solana/web3.js").Connection} connection
 * @param {import("better-sqlite3").Database} db
 * @param {string} scope base58
 * @param {{ pageSize?: number, maxNew?: number }} [opts]
 * @returns {Promise<{ inserted: number, pages: number, stopReason: string }>}
 */
export async function syncHeadSignaturesForScope(connection, db, scope, opts = {}) {
  const pageSize = Math.min(150, Math.max(5, Number(opts.pageSize ?? 80) || 80));
  const maxNew = Math.min(5000, Math.max(1, Number(opts.maxNew ?? 500) || 500));

  const pubkey = new PublicKey(scope);
  const existsStmt = db.prepare(
    `SELECT 1 AS o FROM signatures WHERE signature = ? AND scope_address = ? LIMIT 1`,
  );
  const insert = db.prepare(`
    INSERT OR REPLACE INTO signatures
      (signature, scope_address, slot, block_time, err, summary_json, ingested_at)
    VALUES (@signature, @scope_address, @slot, @block_time, @err, @summary_json, @ingested_at)
  `);
  const resumeKey = `head_resume_before:${scope}`;
  const readCursor = db.prepare(`SELECT last_before_signature FROM ingest_state WHERE scope_key = ?`);
  const writeCursor = db.prepare(`
    INSERT INTO ingest_state (scope_key, last_before_signature, updated_at)
    VALUES (@scope_key, @last_before_signature, @updated_at)
    ON CONFLICT(scope_key) DO UPDATE SET
      last_before_signature = excluded.last_before_signature,
      updated_at = excluded.updated_at
  `);
  const clearCursor = db.prepare(`DELETE FROM ingest_state WHERE scope_key = ?`);

  let inserted = 0;
  let pages = 0;

  /**
   * Page downward from `startBefore` (the head when undefined) until overlap, empty/partial
   * page, or the shared insert budget runs out. `inserted`/`pages` accumulate across walks.
   * @param {string | undefined} startBefore
   * @returns {Promise<{ stopReason: string, lastInserted: string | null }>}
   */
  async function walk(startBefore) {
    let before = startBefore;
    let lastInserted = null;
    let stopReason = "exhausted";

    while (inserted < maxNew) {
      const need = Math.min(pageSize, maxNew - inserted);
      const batch = await withRpcRetry(
        () => connection.getSignaturesForAddress(pubkey, { limit: need, before }),
        { maxAttempts: 6, baseMs: 600, maxMs: 30_000 },
      );
      pages++;

      if (batch.length === 0) {
        stopReason = "empty_page";
        break;
      }

      const now = new Date().toISOString();
      let hitOverlap = false;
      for (const s of batch) {
        if (existsStmt.get(s.signature, scope)?.o === 1) {
          hitOverlap = true;
          break;
        }
        const errStr = s.err ? JSON.stringify(s.err) : null;
        const summary = s.memo ? JSON.stringify({ memo: s.memo }) : null;
        insert.run({
          signature: s.signature,
          scope_address: scope,
          slot: s.slot ?? null,
          block_time: s.blockTime ?? null,
          err: errStr,
          summary_json: summary,
          ingested_at: now,
        });
        lastInserted = s.signature;
        inserted++;
        if (inserted >= maxNew) {
          stopReason = "max_new";
          break;
        }
      }

      if (hitOverlap) {
        stopReason = "head_overlap";
        break;
      }

      before = batch[batch.length - 1].signature;
      if (batch.length < need) {
        stopReason = "partial_page";
        break;
      }
    }

    return { stopReason, lastInserted };
  }

  // Drain any pending gap first — it only exists because a previous round ran out of
  // budget, and because the budget is shared a head walk that stops on max_new can only
  // happen after the cursor was cleared, so a single cursor per scope suffices.
  const cursor = readCursor.get(resumeKey)?.last_before_signature;
  if (cursor) {
    const gap = await walk(String(cursor));
    if (gap.stopReason === "max_new") {
      writeCursor.run({
        scope_key: resumeKey,
        last_before_signature: gap.lastInserted ?? String(cursor),
        updated_at: new Date().toISOString(),
      });
      return { inserted, pages, stopReason: "max_new" };
    }
    clearCursor.run(resumeKey);
  }

  const head = await walk(undefined);
  if (head.stopReason === "max_new" && head.lastInserted) {
    writeCursor.run({
      scope_key: resumeKey,
      last_before_signature: head.lastInserted,
      updated_at: new Date().toISOString(),
    });
  }
  return { inserted, pages, stopReason: head.stopReason };
}

/**
 * Parse up to `limit` signatures that have no event row for this scope.
 *
 * @param {import("@solana/web3.js").Connection} connection
 * @param {import("better-sqlite3").Database} db
 * @param {string} scope base58
 * @param {{ limit?: number, throttleMs?: number }} [opts]
 * @returns {Promise<{ parsed: number }>}
 */
export async function ingestPendingEventsForScope(connection, db, scope, opts = {}) {
  const batchLimit = Math.min(
    500,
    Math.max(1, Number(opts.limit ?? process.env.INGEST_PARSE_LIMIT ?? 40) || 40),
  );
  const throttleMs = Math.max(0, Number(opts.throttleMs ?? process.env.INGEST_THROTTLE_MS ?? 900) || 900);

  const pending = db
    .prepare(
      `
    SELECT s.signature, s.slot, s.block_time
    FROM signatures s
    LEFT JOIN events e
      ON e.signature = s.signature AND e.scope_address = s.scope_address
    WHERE s.scope_address = ? AND e.signature IS NULL
    ORDER BY s.slot DESC
    LIMIT ?
  `,
    )
    .all(scope, batchLimit);

  if (pending.length === 0) return { parsed: 0 };

  let parsed = 0;
  for (let i = 0; i < pending.length; i++) {
    const row = pending[i];
    if (throttleMs > 0 && i > 0) {
      await new Promise((r) => setTimeout(r, throttleMs));
    }

    const txn = await withRpcRetry(
      () =>
        connection.getParsedTransaction(row.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        }),
      { maxAttempts: 8, baseMs: 800, maxMs: 45_000 },
    );

    const now = new Date().toISOString();
    persistIngestedTx(db, {
      txSig: row.signature,
      scopeAddress: scope,
      slot: row.slot ?? null,
      blockTime: row.block_time ?? null,
      parsedTx: txn,
      ingestedAt: now,
    });
    parsed++;
  }

  return { parsed };
}

/**
 * Count parseable signatures with no event row for this scope (the parse backlog).
 * Excludes on-chain-errored txs, which legitimately produce no events.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} scope base58
 * @returns {number}
 */
export function countPendingForScope(db, scope) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM signatures s
       LEFT JOIN events e
         ON e.signature = s.signature AND e.scope_address = s.scope_address
       WHERE s.scope_address = ? AND e.signature IS NULL AND s.err IS NULL`,
    )
    .get(scope);
  return Number(row?.n ?? 0);
}
