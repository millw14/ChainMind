import { clusterFingerprintFromMembers } from "./intel-cluster-fingerprint.js";
import { persistClusterTrackRow } from "./intel-cluster-merge.js";

export { clusterFingerprintFromMembers };

// One (wallet, tx signature) arm per signal; UNION dedupes identical pairs so the
// outer COUNT(DISTINCT sig) is a true per-tx count — a tx where a wallet is fee payer,
// signer, and transfer endpoint counts once, not 3-4x as with summed per-signal counts.
const ARM_FEE_PAYER = `
        SELECT e.fee_payer AS w, e.signature AS sig
        FROM events e
        WHERE e.scope_address = ?
          AND e.block_time IS NOT NULL
          AND e.block_time >= ?
          AND e.fee_payer IS NOT NULL
          AND TRIM(e.fee_payer) != ''`;

const ARM_SIGNERS = `
        SELECT s.address AS w, s.tx_sig AS sig
        FROM signers s
        INNER JOIN events e ON e.signature = s.tx_sig AND e.scope_address = s.scope_address
        WHERE s.scope_address = ?
          AND e.block_time IS NOT NULL
          AND e.block_time >= ?`;

const ARM_XFER_FROM = `
        SELECT t.from_address AS w, t.tx_sig AS sig
        FROM transfers t
        INNER JOIN events e ON e.signature = t.tx_sig AND e.scope_address = t.scope_address
        WHERE t.scope_address = ? AND e.block_time IS NOT NULL AND e.block_time >= ?`;

const ARM_XFER_TO = `
        SELECT t.to_address AS w, t.tx_sig AS sig
        FROM transfers t
        INNER JOIN events e ON e.signature = t.tx_sig AND e.scope_address = t.scope_address
        WHERE t.scope_address = ? AND e.block_time IS NOT NULL AND e.block_time >= ?`;

/**
 * @param {import("@libsql/client").Client} client
 * @param {string[]} arms
 * @param {string} scope
 * @param {number} cutoff unix sec
 * @param {number} limit
 */
async function fetchDistinctTxCounts(client, arms, scope, cutoff, limit) {
  const r = await client.execute({
    sql: `
      SELECT w, COUNT(DISTINCT sig) AS c
      FROM (${arms.join("\n        UNION")}
      ) u
      WHERE w IS NOT NULL AND TRIM(w) != ''
      GROUP BY w
      ORDER BY c DESC
      LIMIT ?
    `,
    args: [...arms.flatMap(() => [scope, cutoff]), limit],
  });
  /** @type {{ w: string, c: number }[]} */
  const out = [];
  for (const row of r.rows) {
    const w = String(row.w ?? "").trim();
    const c = Number(row.c) || 0;
    if (w) out.push({ w, c });
  }
  return out;
}

/**
 * Fee payers + frequent signers + transfer endpoints (from/to), fused into one ranked
 * list per scope by distinct tx signature count. When the signer/transfer joins fail
 * (tables missing), falls back to fee-payer-only and flags the scope as degraded so
 * callers don't silently compare mixed signal sets across scopes.
 * @param {import("@libsql/client").Client} client
 */
async function rankedWalletsForScope(client, scope, cutoff, topN, fetchLimit) {
  const feeOnly = String(process.env.CROSS_MINT_RANK_SIGNALS ?? "").toLowerCase() === "fee_only";

  let raw;
  let degraded = false;
  if (feeOnly) {
    raw = await fetchDistinctTxCounts(client, [ARM_FEE_PAYER], scope, cutoff, fetchLimit);
  } else {
    try {
      raw = await fetchDistinctTxCounts(
        client,
        [ARM_FEE_PAYER, ARM_SIGNERS, ARM_XFER_FROM, ARM_XFER_TO],
        scope,
        cutoff,
        fetchLimit,
      );
    } catch {
      /* signers / transfers table or join missing */
      raw = await fetchDistinctTxCounts(client, [ARM_FEE_PAYER], scope, cutoff, fetchLimit);
      degraded = true;
    }
  }

  /** @type {{ wallet: string; count: number; rank: number }[]} */
  const rows = raw
    .slice(0, topN)
    .map(({ w, c }, i) => ({ wallet: w, count: c, rank: i + 1 }));

  return { rows, degraded };
}

/**
 * Rebuild cross-mint tables for one lookback window: ranked wallets per scope, pairwise overlaps,
 * cluster rows when intersection size ≥ minClusterMembers.
 *
 * @param {import("@libsql/client").Client} client
 * @param {string[]} scopeAddresses
 * @param {{
 *   lookbackHours?: number,
 *   topN?: number,
 *   minClusterMembers?: number,
 *   mergeJaccard?: number,
 * }} [opts]
 */
export async function recomputeCrossMintIntel(client, scopeAddresses, opts = {}) {
  const lookbackHours = Math.min(24 * 30, Math.max(1, Number(opts.lookbackHours) || 168));
  const topN = Math.min(48, Math.max(5, Number(opts.topN) || 18));
  const minCluster = Math.min(24, Math.max(2, Number(opts.minClusterMembers) || 3));
  const mergeJaccard = Math.min(
    1,
    Math.max(0, Number(opts.mergeJaccard ?? process.env.CROSS_MINT_CLUSTER_MERGE_JACCARD ?? 0.45) || 0.45),
  );

  const scopes = [...new Set(scopeAddresses.map(String).filter(Boolean))];
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - lookbackHours * 3600;
  const fetchLimit = Math.min(96, topN * 3);

  if (scopes.length === 0) {
    return { ok: false, reason: "no_scopes", scopes: 0 };
  }

  await client.execute({
    sql: `DELETE FROM intel_scope_top_payers WHERE lookback_hours = ?`,
    args: [lookbackHours],
  });

  await client.execute({
    sql: `DELETE FROM intel_cross_mint_pair WHERE lookback_hours = ?`,
    args: [lookbackHours],
  });

  /** @type {Map<string, { wallet: string; count: number; rank: number }[]>} */
  const byScope = new Map();
  /** @type {string[]} scopes ranked on fee-payer-only counts (signer/transfer join failed) */
  const degradedScopes = [];

  for (const scope of scopes) {
    const { rows, degraded } = await rankedWalletsForScope(client, scope, cutoff, topN, fetchLimit);
    byScope.set(scope, rows);
    if (degraded) degradedScopes.push(scope);

    for (const row of rows) {
      await client.execute({
        sql: `
          INSERT INTO intel_scope_top_payers
            (scope_address, wallet_address, event_count, rank_pos, lookback_hours, computed_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        args: [scope, row.wallet, row.count, row.rank, lookbackHours, now],
      });
    }
  }

  let crossMintPairRows = 0;

  for (let i = 0; i < scopes.length; i++) {
    for (let j = i + 1; j < scopes.length; j++) {
      const sa = scopes[i];
      const sb = scopes[j];
      const scopeA = sa < sb ? sa : sb;
      const scopeB = sa < sb ? sb : sa;
      const listA = byScope.get(scopeA) ?? [];
      const listB = byScope.get(scopeB) ?? [];
      const mapB = new Map(listB.map((x) => [x.wallet, x]));

      /** @type {{ wallet: string; pair_score: number; events_a: number; events_b: number; rank_a: number; rank_b: number }[]} */
      const inter = [];

      for (const ra of listA) {
        const rb = mapB.get(ra.wallet);
        if (!rb) continue;
        const pair_score =
          (Math.min(ra.count, rb.count) / Math.max(1, Math.max(ra.count, rb.count))) *
          (1 / Math.max(1, Math.min(ra.rank, rb.rank)));
        inter.push({
          wallet: ra.wallet,
          pair_score,
          events_a: ra.count,
          events_b: rb.count,
          rank_a: ra.rank,
          rank_b: rb.rank,
        });
      }

      for (const row of inter) {
        await client.execute({
          sql: `
            INSERT INTO intel_cross_mint_pair
              (wallet_address, scope_a, scope_b, events_a, events_b, rank_a, rank_b, pair_score, lookback_hours, computed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          args: [
            row.wallet,
            scopeA,
            scopeB,
            row.events_a,
            row.events_b,
            row.rank_a,
            row.rank_b,
            row.pair_score,
            lookbackHours,
            now,
          ],
        });
        crossMintPairRows++;
      }

      if (inter.length >= minCluster) {
        const wallets = inter.map((x) => x.wallet);
        const avgPair =
          inter.length > 0 ? inter.reduce((s, x) => s + x.pair_score, 0) / inter.length : 0;
        await persistClusterTrackRow(client, {
          wallets,
          scopes: [scopeA, scopeB],
          mintCount: 2,
          nowSec: now,
          avgPairScore: avgPair,
          mergeJaccard,
        });
      }
    }
  }

  /** @type {number} */
  let tripleClusters = 0;
  for (let i = 0; i < scopes.length; i++) {
    for (let j = i + 1; j < scopes.length; j++) {
      for (let k = j + 1; k < scopes.length; k++) {
        const s1 = scopes[i];
        const s2 = scopes[j];
        const s3 = scopes[k];
        const [b1, b2, b3] = [s1, s2, s3].sort();
        const list1 = byScope.get(b1) ?? [];
        const map2 = new Map((byScope.get(b2) ?? []).map((x) => [x.wallet, x]));
        const map3 = new Map((byScope.get(b3) ?? []).map((x) => [x.wallet, x]));

        /** @type {{ wallet: string; pair_score: number }[]} */
        const triple = [];
        for (const r1 of list1) {
          const r2 = map2.get(r1.wallet);
          const r3 = map3.get(r1.wallet);
          if (!r2 || !r3) continue;
          const ps =
            (Math.min(r1.count, r2.count) / Math.max(1, Math.max(r1.count, r2.count)) +
              Math.min(r1.count, r3.count) / Math.max(1, Math.max(r1.count, r3.count)) +
              Math.min(r2.count, r3.count) / Math.max(1, Math.max(r2.count, r3.count))) /
            3;
          triple.push({ wallet: r1.wallet, pair_score: ps });
        }

        if (triple.length >= minCluster) {
          const wallets = triple.map((x) => x.wallet);
          const avg = triple.reduce((s, x) => s + x.pair_score, 0) / triple.length;
          await persistClusterTrackRow(client, {
            wallets,
            scopes: [b1, b2, b3],
            mintCount: 3,
            nowSec: now,
            avgPairScore: avg,
            mergeJaccard,
          });
          tripleClusters++;
        }
      }
    }
  }

  return {
    ok: true,
    scopes: scopes.length,
    lookbackHours,
    topN,
    minClusterMembers: minCluster,
    mergeJaccard,
    topPayerRowTotal: [...byScope.values()].reduce((n, a) => n + a.length, 0),
    degradedScopes,
    crossMintPairRows,
    tripleClusterCandidates: tripleClusters,
    computedAt: now,
  };
}
