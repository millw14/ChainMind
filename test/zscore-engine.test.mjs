// Tests for lib/zscore-engine.js: stored-baseline z-scores, the in-window
// fallback, the strict > 2.0 spike thresholds, and the insufficient-data
// guards. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeZScores } from "../lib/zscore-engine.js";

const bucket = (eventCount, walletCount, i = 0) => ({
  startSec: i * 300,
  endSec: (i + 1) * 300,
  eventCount,
  walletCount,
});

/** 7 quiet buckets + 3 signal buckets → signal window = last 3 (floor(10 * 0.3)). */
const withSignal = (signalEvents, signalWallets) => [
  ...Array.from({ length: 7 }, (_, i) => bucket(10, 5, i)),
  ...signalEvents.map((e, i) => bucket(e, signalWallets[i], 7 + i)),
];

const STORED = {
  mean_event_count: 10,
  std_event_count: 2,
  mean_wallet_count: 5,
  std_wallet_count: 1,
  bucket_count: 40,
  regime: "calm",
};

test("fewer than 2 buckets → insufficient_buckets", () => {
  assert.deepEqual(computeZScores([], null), { available: false, reason: "insufficient_buckets" });
  assert.deepEqual(computeZScores([bucket(1, 1)], null), { available: false, reason: "insufficient_buckets" });
  assert.deepEqual(computeZScores(null, null), { available: false, reason: "insufficient_buckets" });
});

test("no stored baseline and under 4 baseline buckets → insufficient_baseline_buckets", () => {
  // 5 buckets → cutoff floor(5 * 0.7) = 3 < 4.
  const out = computeZScores(Array.from({ length: 5 }, (_, i) => bucket(1, 1, i)), null);
  assert.deepEqual(out, { available: false, reason: "insufficient_baseline_buckets" });
});

test("stored baseline: exact z-scores and spike detection just above 2.0", () => {
  // Signal events peak 16 → z = (16 - 10) / 2 = 3; wallets peak 6 → z = 1.
  const out = computeZScores(withSignal([10, 10, 16], [5, 5, 6]), STORED);
  assert.equal(out.available, true);
  assert.equal(out.baselineSource, "stored (calm regime, 40 buckets)");
  assert.equal(out.baselineRegime, "calm");
  assert.equal(out.signalWindowBuckets, 3);
  assert.equal(out.peakEventZ, 3);
  assert.equal(out.peakWalletZ, 1);
  assert.equal(out.meanSignalEventZ, 1); // mean [10,10,16] = 12 → (12 - 10) / 2
  assert.equal(out.eventSpikeDetected, true);
  assert.equal(out.walletSpikeDetected, false);
  assert.equal(out.accelerating, false); // 1 is not > 1.5
  assert.equal(out.baselineMeanEvent, 10);
  assert.equal(out.baselineStdEvent, 2);
});

test("z exactly 2.0 does NOT count as a spike (strict >)", () => {
  // Events peak 14 → z = 2 exactly; wallets peak 8 → z = 3.
  const out = computeZScores(withSignal([10, 10, 14], [5, 5, 8]), STORED);
  assert.equal(out.peakEventZ, 2);
  assert.equal(out.eventSpikeDetected, false);
  assert.equal(out.peakWalletZ, 3);
  assert.equal(out.walletSpikeDetected, true);
});

test("accelerating requires mean signal z > 1.5 without needing a peak spike", () => {
  // Every signal bucket at 14 → meanSignalEventZ = 2 (> 1.5), peakEventZ = 2 (not > 2).
  const out = computeZScores(withSignal([14, 14, 14], [5, 5, 5]), STORED);
  assert.equal(out.meanSignalEventZ, 2);
  assert.equal(out.accelerating, true);
  assert.equal(out.eventSpikeDetected, false);
});

test("stored baseline with zero std falls back to the in-window baseline", () => {
  const out = computeZScores(withSignal([10, 10, 30], [5, 5, 5]), { ...STORED, std_event_count: 0 });
  assert.equal(out.available, true);
  assert.equal(out.baselineSource, "in-window fallback (stored baseline not available)");
  // baselineRegime still echoes the stored row's regime label even in fallback.
  assert.equal(out.baselineRegime, "calm");
});

test("in-window fallback detects a spike against the oldest 70% of buckets", () => {
  // Baseline = first 7 buckets [1,3,1,3,1,3,1] (mean ~1.86, std ~0.99); signal peak 20.
  const buckets = [
    ...[1, 3, 1, 3, 1, 3, 1].map((e, i) => bucket(e, 1, i)),
    bucket(1, 1, 7),
    bucket(1, 1, 8),
    bucket(20, 1, 9),
  ];
  const out = computeZScores(buckets, null);
  assert.equal(out.available, true);
  assert.equal(out.baselineSource, "in-window fallback (stored baseline not available)");
  assert.equal(out.eventSpikeDetected, true);
  assert.ok(out.peakEventZ > 2, `peakEventZ ${out.peakEventZ}`);
});

test("zero-variance in-window baseline yields null z-scores and no detections", () => {
  const out = computeZScores(Array.from({ length: 10 }, (_, i) => bucket(2, 2, i)), null);
  assert.equal(out.available, true);
  assert.equal(out.peakEventZ, null);
  assert.equal(out.peakWalletZ, null);
  assert.equal(out.meanSignalEventZ, null);
  assert.equal(out.eventSpikeDetected, false);
  assert.equal(out.walletSpikeDetected, false);
  assert.equal(out.accelerating, false);
});
