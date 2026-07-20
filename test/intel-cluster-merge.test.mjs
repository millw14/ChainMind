// Tests for cluster-track merging (lib/intel-cluster-merge.js): the documented
// mergeJaccard default (0.45) must apply when the option is omitted or junk —
// `Number(x) ?? d` used to yield NaN and silently disable merging. Uses a stub
// libsql client (no network). Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { persistClusterTrackRow, jaccardSets } from "../lib/intel-cluster-merge.js";

/** Stub client: SELECT returns the seeded rows, everything else records the call. */
function stubClient(existingRows) {
  const calls = [];
  return {
    calls,
    async execute(q) {
      calls.push(q);
      const sql = typeof q === "string" ? q : q.sql;
      if (/^\s*SELECT/i.test(sql)) return { rows: existingRows };
      return { rows: [] };
    },
  };
}

const existing = [
  {
    cluster_fingerprint: "fp1",
    members_json: JSON.stringify(["A", "B", "C"]),
    scopes_json: JSON.stringify(["Scope1"]),
    canonical_cluster_id: "canon1",
    first_seen: 100,
    observation_count: 2,
  },
];

const baseOpts = {
  wallets: ["A", "B", "C", "D"], // Jaccard vs existing = 3/4 = 0.75
  scopes: ["Scope1"],
  mintCount: 2,
  nowSec: 200,
  avgPairScore: 0.5,
};

test("omitted mergeJaccard falls back to 0.45 and still merges", async () => {
  const client = stubClient(existing);
  const res = await persistClusterTrackRow(client, { ...baseOpts });
  assert.equal(res.ok, true);
  assert.equal(res.merged, true);
  assert.equal(res.jaccard, 0.75);
  assert.equal(res.canonicalClusterId, "canon1");
  assert.equal(res.observationCount, 3);
});

test("non-numeric mergeJaccard falls back to 0.45", async () => {
  const client = stubClient(existing);
  const res = await persistClusterTrackRow(client, { ...baseOpts, mergeJaccard: "junk" });
  assert.equal(res.merged, true);
  assert.equal(res.canonicalClusterId, "canon1");
});

test("explicit threshold above the overlap prevents the merge", async () => {
  const client = stubClient(existing);
  const res = await persistClusterTrackRow(client, { ...baseOpts, mergeJaccard: 0.9 });
  assert.equal(res.merged, false);
  assert.notEqual(res.canonicalClusterId, "canon1");
  assert.equal(res.observationCount, 1);
});

test("jaccardSets sanity", () => {
  assert.equal(jaccardSets(new Set(["A", "B", "C", "D"]), new Set(["A", "B", "C"])), 0.75);
  assert.equal(jaccardSets(new Set(), new Set()), 1);
});
