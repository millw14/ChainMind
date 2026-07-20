// Tests for the autonomous surface rules (lib/surface-triggers.js): each rule must
// fire just above its threshold and stay silent just below it, defaults pinned by
// passing an explicit empty env. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateSurfaceTriggers } from "../lib/surface-triggers.js";

const ENV = {}; // pin DEFAULTS regardless of ambient SURFACE_* vars

const hitIds = (res) => res.hits.map((h) => h.ruleId);

/** score payload with N-event buckets — enough shape for every rule. */
const scoreWithBuckets = (counts, extra = {}) => ({
  ok: true,
  scope: "ScopeAddr111111111111111111111111111111111",
  windowMinutes: 60,
  timelineBuckets: counts.map((c, i) => ({ startSec: i * 300, endSec: (i + 1) * 300, eventCount: c, walletCount: 1 })),
  ...extra,
});

test("dense_fee_payer_burst fires at exactly densePayerMin (40) and is silent at 39", () => {
  const at = evaluateSurfaceTriggers({ score: scoreWithBuckets([], { peakBucketWalletCount: 40 }) }, ENV);
  assert.deepEqual(hitIds(at), ["dense_fee_payer_burst"]);
  assert.equal(at.hits[0].severity, "high");

  const below = evaluateSurfaceTriggers({ score: scoreWithBuckets([], { peakBucketWalletCount: 39 }) }, ENV);
  assert.deepEqual(hitIds(below), []);
});

test("dense_fee_payer_burst escalates to critical at densePayerMin + 4", () => {
  const res = evaluateSurfaceTriggers({ score: scoreWithBuckets([], { peakBucketWalletCount: 44 }) }, ENV);
  assert.equal(res.hits[0].severity, "critical");
  assert.deepEqual(res.hits[0].entities, ["ScopeAddr111111111111111111111111111111111"]);
});

test("funding_hub_shared fires at minFundedPayers (4) recipients and is silent at 3", () => {
  const fg = (n) => ({
    fundingGraph: {
      status: "attached",
      sharedInboundFunders: [{ funder: "FunderAddr", recipientCount: n, recipientPayers: ["P1", "P2"] }],
    },
  });
  const at = evaluateSurfaceTriggers({ score: scoreWithBuckets([], fg(4)) }, ENV);
  assert.deepEqual(hitIds(at), ["funding_hub_shared"]);
  assert.equal(at.hits[0].severity, "high");
  assert.deepEqual(at.hits[0].entities, ["FunderAddr", "P1", "P2"]);

  const below = evaluateSurfaceTriggers({ score: scoreWithBuckets([], fg(3)) }, ENV);
  assert.deepEqual(hitIds(below), []);
});

test("funding_hub_shared escalates to critical at minFundedPayers + 2", () => {
  const score = scoreWithBuckets([], {
    fundingGraph: { status: "attached", sharedInboundFunders: [{ funder: "F", recipientCount: 6, recipientPayers: [] }] },
  });
  assert.equal(evaluateSurfaceTriggers({ score }, ENV).hits[0].severity, "critical");
});

test("ingest_event_spike fires when max >= eventSpikeMult (4) x mean, silent just below", () => {
  // counts [1,1,1,1,1,10]: mean 2.5, threshold 10 → fires (medium, < 1.5x margin).
  const at = evaluateSurfaceTriggers({ score: scoreWithBuckets([1, 1, 1, 1, 1, 10]) }, ENV);
  assert.deepEqual(hitIds(at), ["ingest_event_spike"]);
  assert.equal(at.hits[0].severity, "medium");

  // counts [1,1,1,1,1,9]: threshold ~9.33 → silent.
  const below = evaluateSurfaceTriggers({ score: scoreWithBuckets([1, 1, 1, 1, 1, 9]) }, ENV);
  assert.deepEqual(hitIds(below), []);
});

test("ingest_event_spike needs at least 6 buckets and escalates to high at 1.5x margin", () => {
  const short = evaluateSurfaceTriggers({ score: scoreWithBuckets([1, 1, 1, 1, 40]) }, ENV);
  assert.deepEqual(hitIds(short), []);

  // sum 18 over 12 buckets → mean 1.5, fire at 6, high at 4 x 1.5 x mean = 9 → 14 is high.
  const high = evaluateSurfaceTriggers({ score: scoreWithBuckets([1, 1, 1, 1, 0, 14, 0, 0, 0, 0, 0, 0]) }, ENV);
  assert.deepEqual(hitIds(high), ["ingest_event_spike"]);
  assert.equal(high.hits[0].severity, "high");
});

test("known-entity scopes (USDC) never produce surface hits", () => {
  const score = scoreWithBuckets([1, 1, 1, 1, 1, 50], {
    scope: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    peakBucketWalletCount: 500,
    fundingGraph: { status: "attached", sharedInboundFunders: [{ funder: "F", recipientCount: 9, recipientPayers: [] }] },
  });
  const res = evaluateSurfaceTriggers({ score }, ENV);
  assert.deepEqual(res.hits, []);
  assert.ok(Array.isArray(res.externalRulesPending) && res.externalRulesPending.length > 0);
});

test("thresholds are env-tunable via SURFACE_* overrides", () => {
  const score = scoreWithBuckets([], { peakBucketWalletCount: 2 });
  assert.deepEqual(hitIds(evaluateSurfaceTriggers({ score }, { SURFACE_DENSE_PAYER_MIN: "2" })), ["dense_fee_payer_burst"]);
  assert.deepEqual(hitIds(evaluateSurfaceTriggers({ score }, { SURFACE_DENSE_PAYER_MIN: "3" })), []);
});

test("not-ok or empty score payloads produce no burst/spike hits", () => {
  assert.deepEqual(hitIds(evaluateSurfaceTriggers({ score: { ok: false, peakBucketWalletCount: 99 } }, ENV)), []);
  assert.deepEqual(hitIds(evaluateSurfaceTriggers({ score: scoreWithBuckets([], { empty: true, peakBucketWalletCount: 99 }) }, ENV)), []);
});
