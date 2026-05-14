import { createHash } from "node:crypto";

/**
 * Stable id for a wallet set (same set → same fingerprint across runs).
 * @param {string[]} members
 */
export function clusterFingerprintFromMembers(members) {
  const s = [...new Set(members.map(String).filter(Boolean))].sort().join("|");
  return createHash("sha256").update(s).digest("hex").slice(0, 48);
}

/**
 * Upsert cluster observation (same fingerprint → increment observation_count).
 * @param {import("@libsql/client").Client} client
 */
async function upsertClusterObservation(
  client,
  fingerprint,
  wallets,
  scopeList,
  nowSec,
  avgScore,
  mintCount,
) {
  const members_json = JSON.stringify([...wallets].sort());
  const scopes_json = JSON.stringify([...new Set(scopeList)].sort());
  await client.execute({
    sql: `
      INSERT INTO intel_cluster_track
        (cluster_fingerprint, members_json, scopes_json, mint_count, member_count, first_seen, last_seen, observation_count, last_pair_score_avg)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(cluster_fingerprint) DO UPDATE SET
        last_seen = excluded.last_seen,
        observation_count = intel_cluster_track.observation_count + 1,
        last_pair_score_avg = excluded.last_pair_score_avg,
        members_json = excluded.members_json,
        scopes_json = excluded.scopes_json,
        mint_count = excluded.mint_count,
        member_count = excluded.member_count
    `,
    args: [
      fingerprint,
      members_json,
      scopes_json,
      mintCount,
      wallets.length,
      nowSec,
      nowSec,
      avgScore,
    ],
  });
}

/**
 * Rebuild cross-mint tables for one lookback window: top payers per scope, pairwise overlaps,
 * cluster rows when intersection size ≥ minClusterMembers.
 *
 * @param {import("@libsql/client").Client} client
 * @param {string[]} scopeAddresses
 * @param {{
 *   lookbackHours?: number,
 *   topN?: number,
 *   minClusterMembers?: number,
 * }} [opts]
 */
export async function recomputeCrossMintIntel(client, scopeAddresses, opts = {}) {
  const lookbackHours = Math.min(24 * 30, Math.max(1, Number(opts.lookbackHours) || 168));
  const topN = Math.min(48, Math.max(5, Number(opts.topN) || 18));
  const minCluster = Math.min(24, Math.max(2, Number(opts.minClusterMembers) || 3));

  const scopes = [...new Set(scopeAddresses.map(String).filter(Boolean))];
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - lookbackHours * 3600;

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

  /** @type {Map<string, { wallet: string, count: number, rank: number }[]>} */
  const byScope = new Map();

  for (const scope of scopes) {
    const r = await client.execute({
      sql: `
        SELECT fee_payer AS w, COUNT(*) AS c
        FROM events
        WHERE scope_address = ?
          AND block_time IS NOT NULL
          AND block_time >= ?
          AND fee_payer IS NOT NULL
          AND TRIM(fee_payer) != ''
        GROUP BY fee_payer
        ORDER BY c DESC
        LIMIT ?
      `,
      args: [scope, cutoff, topN],
    });

    /** @type {{ wallet: string, count: number, rank: number }[]} */
    const rows = [];
    let rank = 0;
    for (const row of r.rows) {
      rank++;
      const w = String(row.w ?? "").trim();
      const c = Number(row.c) || 0;
      if (!w) continue;
      rows.push({ wallet: w, count: c, rank });
    }
    byScope.set(scope, rows);

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
        const fp = clusterFingerprintFromMembers(wallets);
        const avgPair =
          inter.length > 0 ? inter.reduce((s, x) => s + x.pair_score, 0) / inter.length : 0;
        await upsertClusterObservation(client, fp, wallets, [scopeA, scopeB], now, avgPair, 2);
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
          const fp = clusterFingerprintFromMembers(wallets);
          const avg = triple.reduce((s, x) => s + x.pair_score, 0) / triple.length;
          await upsertClusterObservation(client, fp, wallets, [b1, b2, b3], now, avg, 3);
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
    topPayerRowTotal: [...byScope.values()].reduce((n, a) => n + a.length, 0),
    crossMintPairRows,
    tripleClusterCandidates: tripleClusters,
    computedAt: now,
  };
}
