import { randomUUID } from "node:crypto";

import { clusterFingerprintFromMembers } from "./intel-cluster-fingerprint.js";

/**
 * @param {string} a
 * @param {string} b
 */
function clusterIdentityKey(a, b) {
  const canon = String(a ?? "").trim();
  if (canon) return canon;
  return String(b ?? "").trim();
}

/**
 * @param {Set<string>} a
 * @param {Set<string>} b
 */
export function jaccardSets(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) inter++;
  }
  const uni = a.size + b.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

/**
 * @param {string[]} scopeList
 * @param {string[]} rowScopes
 */
function scopesOverlap(scopeList, rowScopes) {
  const S = new Set(scopeList.map(String));
  return rowScopes.some((s) => S.has(String(s)));
}

/**
 * Persist a coordination cluster; merge with an existing row when Jaccard ≥ threshold and scopes overlap
 * (rotation-tolerant lineage via stable canonical_cluster_id).
 *
 * @param {import("@libsql/client").Client} client
 * @param {{
 *   wallets: string[],
 *   scopes: string[],
 *   mintCount: number,
 *   nowSec: number,
 *   avgPairScore: number,
 *   mergeJaccard?: number,
 *   candidateLimit?: number,
 * }} opts
 */
export async function persistClusterTrackRow(client, opts) {
  const wallets = [...new Set(opts.wallets.map(String).filter(Boolean))];
  const scopes = [...new Set(opts.scopes.map(String).filter(Boolean))];
  const mintCount = Math.max(1, Number(opts.mintCount) || 1);
  const nowSec = Number(opts.nowSec) || Math.floor(Date.now() / 1000);
  const avgPairScore = Number(opts.avgPairScore) || 0;
  const mergeJaccardRaw = Number(opts.mergeJaccard ?? 0.45);
  const mergeJaccard = Math.min(1, Math.max(0, Number.isFinite(mergeJaccardRaw) ? mergeJaccardRaw : 0.45));
  const candidateLimit = Math.min(800, Math.max(50, Number(opts.candidateLimit) || 400));

  if (wallets.length === 0 || scopes.length === 0) return { ok: false, reason: "empty" };

  const incoming = new Set(wallets);

  let rows;
  try {
    rows = await client.execute({
      sql: `
        SELECT cluster_fingerprint, members_json, scopes_json, canonical_cluster_id,
               first_seen, observation_count
        FROM intel_cluster_track
        ORDER BY last_seen DESC
        LIMIT ?
      `,
      args: [candidateLimit],
    });
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/no such column/i.test(msg)) {
      rows = await client.execute({
        sql: `
          SELECT cluster_fingerprint, members_json, scopes_json,
                 first_seen, observation_count
          FROM intel_cluster_track
          ORDER BY last_seen DESC
          LIMIT ?
        `,
        args: [candidateLimit],
      });
    } else {
      throw e;
    }
  }

  /** @type {{ key: string, members: Set<string>, scopes: string[], firstSeen: number, obs: number, fingerprint: string }[]} */
  const groups = [];

  for (const row of rows.rows) {
    const fp = String(row.cluster_fingerprint ?? "");
    const rawCanon = row.canonical_cluster_id != null ? String(row.canonical_cluster_id) : "";
    const key = clusterIdentityKey(rawCanon, fp);

    let members = [];
    let rowScopes = [];
    try {
      members = JSON.parse(String(row.members_json ?? "[]"));
      if (!Array.isArray(members)) members = [];
    } catch {
      members = [];
    }
    try {
      rowScopes = JSON.parse(String(row.scopes_json ?? "[]"));
      if (!Array.isArray(rowScopes)) rowScopes = [];
    } catch {
      rowScopes = [];
    }

    const memberSet = new Set(members.map(String).filter(Boolean));
    const fs = Number(row.first_seen) || nowSec;
    const obs = Number(row.observation_count) || 1;

    const existing = groups.find((g) => g.key === key);
    if (existing) {
      for (const m of memberSet) existing.members.add(m);
      for (const s of rowScopes) {
        if (!existing.scopes.includes(String(s))) existing.scopes.push(String(s));
      }
      existing.firstSeen = Math.min(existing.firstSeen, fs);
      existing.obs += obs;
    } else {
      groups.push({
        key,
        members: memberSet,
        scopes: [...new Set(rowScopes.map(String))],
        firstSeen: fs,
        obs,
        fingerprint: fp,
      });
    }
  }

  let best = /** @type {{ group: (typeof groups)[0]; jac: number } | null} */ (null);
  for (const group of groups) {
    if (!scopesOverlap(scopes, group.scopes)) continue;
    const jac = jaccardSets(incoming, group.members);
    if (jac >= mergeJaccard && (!best || jac > best.jac)) {
      best = { group, jac };
    }
  }

  const mergedMembers = new Set([...incoming]);
  let firstSeen = nowSec;
  let observationCount = 1;
  let canonicalId;

  if (best) {
    for (const m of best.group.members) mergedMembers.add(m);
    const mergedScopes = [...new Set([...scopes, ...best.group.scopes])];
    scopes.length = 0;
    scopes.push(...mergedScopes);
    firstSeen = Math.min(best.group.firstSeen, nowSec);
    observationCount = best.group.obs + 1;
    canonicalId = best.group.key;

    const fpsToDelete = new Set(
      rows.rows
        .filter((row) => {
          const fp = String(row.cluster_fingerprint ?? "");
          const rawCanon = row.canonical_cluster_id != null ? String(row.canonical_cluster_id) : "";
          return clusterIdentityKey(rawCanon, fp) === canonicalId;
        })
        .map((row) => String(row.cluster_fingerprint ?? "")),
    );

    for (const fp of fpsToDelete) {
      await client.execute({ sql: `DELETE FROM intel_cluster_track WHERE cluster_fingerprint = ?`, args: [fp] });
    }
  } else {
    canonicalId = randomUUID();
  }

  const mergedList = [...mergedMembers].sort();
  const fingerprint = clusterFingerprintFromMembers(mergedList);
  const members_json = JSON.stringify(mergedList);
  const scopes_json = JSON.stringify([...new Set(scopes)].sort());

  const memberCount = mergedList.length;

  try {
    await client.execute({
      sql: `
        INSERT INTO intel_cluster_track
          (cluster_fingerprint, members_json, scopes_json, mint_count, member_count,
           first_seen, last_seen, observation_count, last_pair_score_avg, canonical_cluster_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        fingerprint,
        members_json,
        scopes_json,
        mintCount,
        memberCount,
        firstSeen,
        nowSec,
        observationCount,
        avgPairScore,
        canonicalId,
      ],
    });
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/no such column/i.test(msg)) {
      await client.execute({
        sql: `
          INSERT INTO intel_cluster_track
            (cluster_fingerprint, members_json, scopes_json, mint_count, member_count,
             first_seen, last_seen, observation_count, last_pair_score_avg)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          fingerprint,
          members_json,
          scopes_json,
          mintCount,
          memberCount,
          firstSeen,
          nowSec,
          observationCount,
          avgPairScore,
        ],
      });
    } else {
      throw e;
    }
  }

  return {
    ok: true,
    merged: Boolean(best),
    jaccard: best?.jac ?? null,
    clusterFingerprint: fingerprint,
    canonicalClusterId: canonicalId,
    memberCount,
    observationCount,
  };
}