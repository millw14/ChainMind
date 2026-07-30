// Tests for lib/page-retry.js — the one retry policy every paginated walk shares.
//
// WHAT THIS FILE PINS DOWN. The measured failure on chain 4663 is a page that drops
// roughly one time in ten and answers when asked again, which turned a ten-page walk
// into "usually truncated" and made holder_overlap report "at least 1 wallet" for a
// pair that shares 14. So: a recovered page must look exactly like a page that never
// failed, an exhausted page must still fail (with its status intact, because the honesty
// layer above quotes it), and a retry must never be started with time the request does
// not have — a read handed 200ms fails and then reports an indexer outage, which is a
// claim about an upstream that was never really asked.
//
// Entirely offline and instant: the sleep is injected, and the clock comes from
// lib/request-budget.js's own runWithBudget. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { PAGE_ATTEMPTS, PAGE_BACKOFF_MS, readPageWithRetry } from "../lib/page-retry.js";
import { budgetSkips, runWithBudget } from "../lib/request-budget.js";

/** A reader that fails its first `failures` calls and then answers. Records waits. */
function flaky({ failures, status = 503, value = { items: [] } } = {}) {
  const state = { tries: 0, waits: [] };
  return {
    state,
    sleep: async (ms) => {
      state.waits.push(ms);
    },
    read: async () => {
      state.tries += 1;
      if (state.tries <= failures) throw Object.assign(new Error("indexer down"), { status });
      return value;
    },
  };
}

test("a page that fails once and then answers is indistinguishable from one that never failed", async () => {
  const f = flaky({ failures: 1 });
  const res = await readPageWithRetry(f.read, { sleep: f.sleep });

  assert.equal(res.ok, true);
  assert.deepEqual(res.value, { items: [] });
  assert.equal(res.status, null);
  assert.equal(res.attempts, 2);
  // `retried` is the flag that lets a caller report what completeness cost, and
  // `stoppedForTime` is false because nothing was withheld.
  assert.equal(res.retried, true);
  assert.equal(res.stoppedForTime, false);
  assert.deepEqual(f.state.waits, [PAGE_BACKOFF_MS[0]]);
});

test("two failures are still recovered — the measured ~10% per page needs the second retry", async () => {
  const f = flaky({ failures: 2 });
  const res = await readPageWithRetry(f.read, { sleep: f.sleep });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, PAGE_ATTEMPTS);
  assert.deepEqual(f.state.waits, [...PAGE_BACKOFF_MS]);
});

test("an indexer that is genuinely down costs the bound and no more, and keeps its status", async () => {
  const f = flaky({ failures: 99 });
  const res = await readPageWithRetry(f.read, { sleep: f.sleep });

  assert.equal(res.ok, false);
  assert.equal(res.value, null);
  // The status has to survive every attempt: the sentence a reader gets says "HTTP 503",
  // and a walk that lost it would have to describe the outage without naming it.
  assert.equal(res.status, 503);
  assert.equal(res.attempts, PAGE_ATTEMPTS);
  assert.equal(res.stoppedForTime, false);
  assert.equal(f.state.tries, PAGE_ATTEMPTS, "the attempts are bounded");
});

test("a transport failure with no status is unknown rather than an HTTP code", async () => {
  const res = await readPageWithRetry(
    async () => {
      throw new Error("socket hang up");
    },
    { sleep: async () => {} },
  );
  assert.equal(res.ok, false);
  assert.equal(res.status, null);
});

test("the first attempt is never gated on the clock — that is the caller's own check", async () => {
  // A walk already decided this page was worth starting. Refusing it here would turn
  // one shared policy into two places that both have to agree about the budget.
  const f = flaky({ failures: 0 });
  const res = await runWithBudget(() => readPageWithRetry(f.read, { sleep: f.sleep, minMs: 1_200 }), {
    totalMs: 10,
    reserveMs: 0,
  });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 1);
});

test("a retry is NOT started when the request cannot afford it, and says so", async () => {
  const f = flaky({ failures: 1 });
  const res = await runWithBudget(
    async () => {
      const out = await readPageWithRetry(f.read, { sleep: f.sleep, minMs: 1_200, label: "holderOverlap" });
      // Read inside the budget: the skips live on the request's own store.
      return { out, skips: budgetSkips() };
    },
    { totalMs: 50, reserveMs: 0 },
  );

  assert.equal(res.out.ok, false);
  assert.equal(res.out.attempts, 1, "the failing read happened; the retry did not");
  assert.equal(res.out.retried, false);
  // THE DISTINCTION THE HONESTY LAYER NEEDS: this is a request that ran out of time,
  // not an indexer that refused three times. The status is still carried.
  assert.equal(res.out.stoppedForTime, true);
  assert.equal(res.out.status, 503);
  assert.deepEqual(res.skips, ["holderOverlap"]);
  assert.deepEqual(f.state.waits, [], "no backoff is spent on a retry that was not made");
});

test("with no budget open the policy is unchanged — every script and test retries fully", async () => {
  const f = flaky({ failures: 2 });
  const res = await readPageWithRetry(f.read, { sleep: f.sleep, minMs: 1_200 });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 3);
});

test("the attempt count is caller-overridable and clamped, so nothing can retry forever", async () => {
  const once = flaky({ failures: 99 });
  const res = await readPageWithRetry(once.read, { attempts: 1, sleep: once.sleep });
  assert.equal(res.attempts, 1);
  assert.equal(once.state.waits.length, 0);

  const greedy = flaky({ failures: 99 });
  const capped = await readPageWithRetry(greedy.read, { attempts: 500, sleep: greedy.sleep });
  assert.ok(capped.attempts <= 10, "an unbounded retry would spend the whole request");
});
