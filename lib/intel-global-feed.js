import { tursoFetchSurfaceHits } from "./turso.js";

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/**
 * The most-recently-computed batch of cross-mint pairs — whatever window the cron last
 * ran at. The feed always shows the latest intel; it does NOT filter by the dashboard's
 * requested window (the old exact-match-on-lookback_hours hid real pairs whenever the
 * dashboard lookback didn't match the cron's compute window).
 * @param {import("@libsql/client").Client} client
 */
async function fetchCrossMintPairs(client, limit) {
  const res = await client.execute({
    sql: `SELECT scope_a, scope_b, COUNT(*) AS shared_wallets, AVG(pair_score) AS avg_pair_score,
                 MAX(computed_at) AS computed_at, MAX(lookback_hours) AS lookback_hours
          FROM intel_cross_mint_pair
          WHERE computed_at = (SELECT MAX(computed_at) FROM intel_cross_mint_pair)
          GROUP BY scope_a, scope_b
          ORDER BY shared_wallets DESC, avg_pair_score DESC
          LIMIT ?`,
    args: [limit],
  });
  return res.rows;
}

/**
 * Unified ranked feed: cross-mint pairs, persisted clusters, recent surface hits.
 *
 * @param {import("@libsql/client").Client} client
 * @param {{ limit?: number, lookbackHours?: number | null }} [opts]
 */
export async function buildGlobalIntelFeed(client, opts = {}) {
  const limit = Math.min(80, Math.max(5, Number(opts.limit) || 32));
  const lookbackHours =
    opts.lookbackHours == null ? null : Math.min(24 * 30, Math.max(1, Number(opts.lookbackHours) || 168));

  const now = Math.floor(Date.now() / 1000);

  /** @type {{ kind: string, score: number, item: Record<string, unknown> }[]} */
  const items = [];

  // Always show the latest computed pairs (see fetchCrossMintPairs) — no window filtering,
  // so the feed can't be blank just because the dashboard lookback ≠ the cron's window.
  let pairWindowHours = null;
  try {
    const pairRows = await fetchCrossMintPairs(client, limit);
    for (const row of pairRows) {
      if (pairWindowHours == null && row.lookback_hours != null) pairWindowHours = Number(row.lookback_hours);
      const shared = Number(row.shared_wallets) || 0;
      const avg = Number(row.avg_pair_score) || 0;
      const comp = Number(row.computed_at) || 0;
      const score = shared * 25 + avg * 40 + Math.min(20, (now - comp) / 3600);
      items.push({
        kind: "cross_mint_pair",
        score,
        item: {
          scope_a: String(row.scope_a ?? ""),
          scope_b: String(row.scope_b ?? ""),
          sharedWalletCount: shared,
          avgPairScore: Math.round(avg * 10000) / 10000,
          computedAt: comp,
        },
      });
    }
  } catch {
    /* table missing on old DBs */
  }

  try {
    let cl;
    try {
      cl = await client.execute({
        sql: `
        SELECT cluster_fingerprint, canonical_cluster_id, members_json, scopes_json, mint_count, member_count,
               first_seen, last_seen, observation_count, last_pair_score_avg
        FROM intel_cluster_track
        ORDER BY (member_count * observation_count) DESC, last_seen DESC
        LIMIT ?
      `,
        args: [limit],
      });
    } catch (e) {
      if (!/no such column/i.test(String(e?.message ?? e))) throw e;
      cl = await client.execute({
        sql: `
        SELECT cluster_fingerprint, members_json, scopes_json, mint_count, member_count,
               first_seen, last_seen, observation_count, last_pair_score_avg
        FROM intel_cluster_track
        ORDER BY (member_count * observation_count) DESC, last_seen DESC
        LIMIT ?
      `,
        args: [limit],
      });
    }
    for (const row of cl.rows) {
      const mc = Number(row.member_count) || 0;
      const oc = Number(row.observation_count) || 1;
      const mintCount = Number(row.mint_count) || 0;
      const ls = Number(row.last_seen) || 0;
      const score = mc * 15 + oc * 8 + mintCount * 12 + Math.min(15, (now - ls) / 7200);
      let members = [];
      let scopes = [];
      try {
        members = JSON.parse(String(row.members_json ?? "[]"));
        if (!Array.isArray(members)) members = [];
      } catch {
        members = [];
      }
      try {
        scopes = JSON.parse(String(row.scopes_json ?? "[]"));
        if (!Array.isArray(scopes)) scopes = [];
      } catch {
        scopes = [];
      }
      const canon =
        row.canonical_cluster_id != null && String(row.canonical_cluster_id).trim()
          ? String(row.canonical_cluster_id).trim()
          : null;
      items.push({
        kind: "persistent_cluster",
        score,
        item: {
          clusterFingerprint: String(row.cluster_fingerprint ?? ""),
          canonicalClusterId: canon,
          memberCount: mc,
          mintCount,
          observationCount: oc,
          membersSample: members.slice(0, 12),
          scopes,
          firstSeen: Number(row.first_seen) || 0,
          lastSeen: ls,
          lastPairScoreAvg: row.last_pair_score_avg != null ? Number(row.last_pair_score_avg) : null,
        },
      });
    }
  } catch {
    /* missing table */
  }

  try {
    const hits = await tursoFetchSurfaceHits(client, limit);
    for (const h of hits) {
      const sev = SEVERITY_RANK[String(h.severity ?? "").toLowerCase()] ?? 1;
      const score = sev * 12 + 5;
      items.push({
        kind: "surface_hit",
        score,
        item: {
          id: h.id,
          created_at: h.created_at,
          scope_address: h.scope_address,
          rule_id: h.rule_id,
          severity: h.severity,
          detail: h.detail,
          entities: h.entities,
        },
      });
    }
  } catch {
    /* no surface */
  }

  items.sort((a, b) => b.score - a.score);

  return {
    generatedAt: new Date().toISOString(),
    lookbackHoursUsed: lookbackHours,
    // Window the cross-mint pairs actually came from (may differ from the request after the
    // fallback above) — lets the UI show the true pair window instead of the requested one.
    pairWindowHours,
    limit,
    entries: items.slice(0, limit),
  };
}
