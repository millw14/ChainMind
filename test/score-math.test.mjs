// Tests for the timeline bucket grid (lib/score-math.js): empty intervals must be
// gap-filled with zero counts so z-scores/baselines are computed over time, not
// over active buckets only. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTimelineBucketsFromRows } from "../lib/score-math.js";

const row = (payer, blockTime, eventType = "swap") => ({
  fee_payer: payer,
  block_time: blockTime,
  event_type: eventType,
});

test("empty intervals between events are gap-filled with zero counts", () => {
  // 5-minute buckets: events in bucket 0 and bucket 10 → 11 dense buckets.
  const out = buildTimelineBucketsFromRows([row("A", 10), row("B", 3010)], 5);
  assert.equal(out.length, 11);
  assert.equal(out[0].eventCount, 1);
  assert.equal(out[0].walletCount, 1);
  for (let i = 1; i < 10; i++) {
    assert.equal(out[i].eventCount, 0, `bucket ${i} eventCount`);
    assert.equal(out[i].walletCount, 0, `bucket ${i} walletCount`);
  }
  assert.equal(out[10].eventCount, 1);
  assert.equal(out[10].walletCount, 1);
});

test("bucket grid is contiguous and sorted", () => {
  const out = buildTimelineBucketsFromRows([row("A", 10), row("B", 3010)], 5);
  for (let i = 0; i < out.length; i++) {
    assert.equal(out[i].startSec, i * 300);
    assert.equal(out[i].endSec, (i + 1) * 300);
  }
});

test("320-bucket cap keeps the newest end of the grid", () => {
  // Events in bucket 0 and bucket 1000 → grid trimmed to buckets 681..1000.
  const out = buildTimelineBucketsFromRows([row("A", 10), row("B", 1000 * 300 + 10)], 5);
  assert.equal(out.length, 320);
  assert.equal(out[0].startSec, 681 * 300);
  assert.equal(out[319].startSec, 1000 * 300);
  assert.equal(out[319].eventCount, 1);
  // The bucket-0 event fell off the old end of the capped grid.
  assert.equal(out.reduce((s, b) => s + b.eventCount, 0), 1);
});

test("no rows → empty timeline", () => {
  assert.deepEqual(buildTimelineBucketsFromRows([], 5), []);
});

test("event_type filter still applies before gap fill", () => {
  const out = buildTimelineBucketsFromRows(
    [row("A", 10, "swap"), row("B", 3010, "other")],
    5,
    new Set(["swap"]),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].eventCount, 1);
});
