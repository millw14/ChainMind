// Tests for THE CAPS — services/research/lib/budget.js.
//
// The failure this file exists to prevent is RUNAWAY. An agentic loop decides for itself
// what happens next, so nothing in the design bounds the work except these numbers, and a
// cap that is enforced but not REPORTED is nearly as bad as no cap: a run that stopped
// early would hand back a short report that reads exactly like a complete one.
//
// So what is proved here is both halves — that each resource actually stops the work, and
// that the snapshot says which one bit and never presents a bound as an exact measurement.
//
// Fully offline; the clock is injected.
// Run with: npm test (from the repository root)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBudget } from "../lib/budget.js";

const LIMITS = { steps: 3, toolCalls: 4, fetchedBytes: 1_000, wallMs: 10_000, modelTokens: 500 };

test("every resource stops the work when it runs out, and names itself", () => {
  for (const [resource, cap] of [["steps", 3], ["toolCalls", 4], ["modelTokens", 500]]) {
    const b = createBudget({ limits: LIMITS, now: () => 0 });
    const step = resource === "modelTokens" ? 100 : 1;
    for (let spent = 0; spent < cap; spent += step) {
      assert.equal(b.mayAfford(resource, step), true, `${resource} refused work it could afford`);
      b.spend(resource, step);
    }
    assert.equal(b.mayAfford(resource, step), false, `${resource} allowed work past its cap`);
    const hits = b.hits();
    assert.equal(hits.some((h) => h.resource === resource), true, `${resource} did not report itself`);
    assert.match(hits.find((h) => h.resource === resource).reading, /unexamined|UNREAD|stopped/i);
  }
});

test("bytes are checked BEFORE the socket opens, with the amount that might come back", () => {
  const b = createBudget({ limits: LIMITS, now: () => 0 });
  b.spend("fetchedBytes", 600);
  // 600 spent of 1,000: a 300-byte read fits and a 512KB one does not, and the difference
  // is only knowable if the amount is part of the question.
  assert.equal(b.mayAfford("fetchedBytes", 300), true);
  assert.equal(b.mayAfford("fetchedBytes", 512_000), false);
  assert.equal(b.hits()[0].resource, "fetchedBytes");
});

test("the wall clock runs out whether or not anything is spent", () => {
  let clock = 0;
  const b = createBudget({ limits: LIMITS, now: () => clock });
  assert.equal(b.mayAfford("steps"), true);
  assert.equal(b.remainingMs(), 10_000);
  clock = 10_001;
  assert.equal(b.remainingMs(), 0);
  // Asked about a resource with plenty left — and refused anyway, because time is gone.
  assert.equal(b.mayAfford("steps"), false);
  assert.equal(b.hits()[0].resource, "wallMs");
});

test("a cap is reported once, in the order it was reached", () => {
  const b = createBudget({ limits: LIMITS, now: () => 0 });
  b.spend("steps", 3);
  b.spend("toolCalls", 4);
  b.mayAfford("steps");
  b.mayAfford("steps");
  b.mayAfford("toolCalls");
  const hits = b.hits();
  assert.equal(hits.filter((h) => h.resource === "steps").length, 1, "a cap reported twice would read as two failures");
  assert.deepEqual(hits.map((h) => h.resource), ["steps", "toolCalls"]);
});

test("the snapshot marks a bound as a bound, and never as an exact figure", () => {
  const b = createBudget({ limits: LIMITS, now: () => 0 });
  b.spend("fetchedBytes", 1_000);
  const snap = b.snapshot();
  assert.equal(snap.fetchedBytes.used, 1_000);
  assert.equal(snap.fetchedBytes.cap, 1_000);
  assert.equal(snap.fetchedBytes.capped, true, "a run that landed on its cap must be flagged, not read as a coincidence");
  assert.equal(snap.steps.capped, false);
  assert.match(snap.reading, /STOPPED AT A CAP, NOT AT AN ANSWER/);
  assert.match(snap.reading, /UNEXAMINED/);
});

test("a run that finished under every cap says so, and does not claim completeness", () => {
  const b = createBudget({ limits: LIMITS, now: () => 0 });
  b.spend("steps", 1);
  b.spend("toolCalls", 2);
  const snap = b.snapshot();
  assert.deepEqual(snap.hit, []);
  assert.match(snap.reading, /No cap was reached/);
  assert.match(snap.reading, /not the same as having checked everything/);
});

test("junk limits fall back to defaults rather than to no limit at all", () => {
  const b = createBudget({ limits: { steps: 0, toolCalls: -5, wallMs: "soon", fetchedBytes: null, modelTokens: NaN } });
  for (const [resource, cap] of Object.entries(b.caps)) {
    assert.ok(Number.isFinite(cap) && cap > 0, `${resource} ended up unbounded`);
  }
});
