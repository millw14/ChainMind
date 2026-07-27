// Tests for the indexer TTL cache and single-flight gate (lib/indexer-cache.js),
// plus its wiring into lib/blockscout.js. Entirely offline: the upstream is a
// counting stub, and the blockscout tests swap globalThis.fetch. Run: npm test
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ENTRIES,
  cacheTtlMs,
  indexerCacheStats,
  resetIndexerCache,
  setIndexerClock,
  withIndexerCache,
} from "../lib/indexer-cache.js";
import { getToken, getTokenHolders } from "../lib/blockscout.js";

/** Set INDEXER_CACHE_TTL_MS for one test; undefined restores the default. */
function withTtl(ms) {
  if (ms === undefined) delete process.env.INDEXER_CACHE_TTL_MS;
  else process.env.INDEXER_CACHE_TTL_MS = String(ms);
}

/** An upstream that counts its calls and answers with a fresh object. */
function counter(body = () => ({ ok: true })) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    fetcher() {
      calls += 1;
      return Promise.resolve(body(calls));
    },
  };
}

/** A promise plus its resolve/reject, so a test can hold a call open. */
function gate() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetIndexerCache();
  withTtl(undefined);
});

afterEach(() => {
  resetIndexerCache();
  withTtl(undefined);
});

/* ------------------------------- TTL cache ------------------------------- */

test("cacheTtlMs defaults to 60s and honours the override", () => {
  assert.equal(cacheTtlMs(), 60_000);
  withTtl(5_000);
  assert.equal(cacheTtlMs(), 5_000);
  withTtl(0);
  assert.equal(cacheTtlMs(), 0, "0 is a real setting, not falsy-to-default");
});

test("cacheTtlMs falls back to the default on junk or negative config", () => {
  // A typo must not silently remove the protection this whole module exists for.
  for (const bad of ["", "   ", "soon", "-1", "NaN"]) {
    withTtl(bad);
    assert.equal(cacheTtlMs(), 60_000, `"${bad}" should fall back`);
  }
});

test("a second read inside the TTL is served from cache", async () => {
  const up = counter();
  const a = await withIndexerCache("https://x/tokens/1", up.fetcher);
  const b = await withIndexerCache("https://x/tokens/1", up.fetcher);
  assert.equal(up.calls, 1, "the repeat must not reach the indexer");
  assert.deepEqual(b, a);
  assert.equal(indexerCacheStats().hits, 1);
});

test("different urls are cached independently", async () => {
  const up = counter((n) => ({ n }));
  const a = await withIndexerCache("https://x/tokens/1", up.fetcher);
  const b = await withIndexerCache("https://x/tokens/2", up.fetcher);
  assert.equal(up.calls, 2);
  assert.notDeepEqual(a, b);
  assert.equal(indexerCacheStats().size, 2);
});

/**
 * Drive the cache's clock by hand.
 *
 * These two tests used real setTimeout sleeps against a real TTL and asserted an
 * exact upstream call count. That is a flake waiting for a loaded machine: three
 * 15ms sleeps against a 40ms TTL become four expiries the moment the process is
 * descheduled, and the assertion fails for a reason that has nothing to do with
 * the cache. Reproduced by running the suite four times concurrently.
 *
 * With the clock injected the timings are exact and the tests are instant.
 * Returns a tick(ms) to advance it, and registers the restore.
 */
function fakeClock(t) {
  let nowMs = 1_000_000;
  const restore = setIndexerClock(() => nowMs);
  t.after(restore);
  return (ms) => {
    nowMs += ms;
  };
}

test("the entry expires once the TTL is past", async (t) => {
  withTtl(20);
  const tick = fakeClock(t);
  const up = counter((n) => ({ n }));
  const first = await withIndexerCache("https://x/tokens/1", up.fetcher);
  tick(40);
  const second = await withIndexerCache("https://x/tokens/1", up.fetcher);
  assert.equal(up.calls, 2, "an expired entry must be re-fetched");
  assert.deepEqual(first, { n: 1 });
  assert.deepEqual(second, { n: 2 });
});

test("a hit refreshes recency but never the expiry", async (t) => {
  withTtl(40);
  const tick = fakeClock(t);
  const up = counter((n) => ({ n }));
  await withIndexerCache("https://x/tokens/1", up.fetcher);
  // Read it repeatedly across its whole life; it must still expire on schedule
  // rather than being kept alive forever by being popular. 3x15ms crosses 40ms
  // exactly once, so a correct cache fetches twice and a sliding window once.
  for (let i = 0; i < 3; i += 1) {
    tick(15);
    await withIndexerCache("https://x/tokens/1", up.fetcher);
  }
  assert.equal(up.calls, 2, "the sliding-window bug would leave this at 1");
});

test("callers cannot poison the cache by mutating what they got", async () => {
  const up = counter(() => ({ items: [{ rank: 1 }] }));
  const first = await withIndexerCache("https://x/holders", up.fetcher);
  first.items.push({ rank: 2 });
  first.items[0].rank = 99;
  const second = await withIndexerCache("https://x/holders", up.fetcher);
  assert.equal(up.calls, 1, "still a hit");
  assert.deepEqual(second, { items: [{ rank: 1 }] });
});

/* --------------------------- failures never stick --------------------------- */

test("a rejection is not cached", async () => {
  let calls = 0;
  const fetcher = () => {
    calls += 1;
    return Promise.reject(new Error("Blockscout 503"));
  };
  await assert.rejects(() => withIndexerCache("https://x/down", fetcher), /503/);
  await assert.rejects(() => withIndexerCache("https://x/down", fetcher), /503/);
  assert.equal(calls, 2, "a cached outage would turn a blip into a minute of lying");
  assert.equal(indexerCacheStats().stores, 0);
});

test("a failure leaves no in-flight entry behind", async () => {
  const fetcher = () => Promise.reject(new Error("boom"));
  await assert.rejects(() => withIndexerCache("https://x/down", fetcher));
  assert.equal(indexerCacheStats().inFlight, 0, "a stuck entry pins every later caller to a dead call");
});

test("a success after a failure is cached normally", async () => {
  let calls = 0;
  const fetcher = () => {
    calls += 1;
    return calls === 1 ? Promise.reject(new Error("503")) : Promise.resolve({ ok: true });
  };
  await assert.rejects(() => withIndexerCache("https://x/flaky", fetcher));
  assert.deepEqual(await withIndexerCache("https://x/flaky", fetcher), { ok: true });
  assert.deepEqual(await withIndexerCache("https://x/flaky", fetcher), { ok: true });
  assert.equal(calls, 2);
});

test("a non-object body is not storable", async () => {
  // A proxy error page or a truncated read can parse as JSON without being the
  // body we asked for; keeping it for a minute makes it indistinguishable.
  const up = counter(() => null);
  await withIndexerCache("https://x/partial", up.fetcher);
  await withIndexerCache("https://x/partial", up.fetcher);
  assert.equal(up.calls, 2);
  assert.equal(indexerCacheStats().size, 0);

  const str = counter(() => "Bad Gateway");
  await withIndexerCache("https://x/html", str.fetcher);
  await withIndexerCache("https://x/html", str.fetcher);
  assert.equal(str.calls, 2);
  assert.equal(indexerCacheStats().size, 0);
});

/* ------------------------------ single-flight ------------------------------ */

test("concurrent identical calls collapse into one upstream call", async () => {
  const g = gate();
  let calls = 0;
  const fetcher = () => {
    calls += 1;
    return g.promise;
  };

  const all = Promise.all(
    Array.from({ length: 5 }, () => withIndexerCache("https://x/tokens/NVDA", fetcher)),
  );
  assert.equal(calls, 1, "five callers, one request");
  assert.equal(indexerCacheStats().joins, 4);

  g.resolve({ symbol: "NVDA" });
  const results = await all;
  for (const r of results) assert.deepEqual(r, { symbol: "NVDA" });
  assert.equal(calls, 1);
});

test("each joiner gets its own copy", async () => {
  const g = gate();
  const fetcher = () => g.promise;
  const both = Promise.all([
    withIndexerCache("https://x/tokens/NVDA", fetcher),
    withIndexerCache("https://x/tokens/NVDA", fetcher),
  ]);
  g.resolve({ items: [1, 2] });
  const [a, b] = await both;
  assert.notEqual(a, b, "sharing one object lets one caller rewrite the other's evidence");
  a.items.push(3);
  assert.deepEqual(b.items, [1, 2]);
});

test("concurrent calls to different urls do not share", async () => {
  const up = counter((n) => ({ n }));
  const [a, b] = await Promise.all([
    withIndexerCache("https://x/a", up.fetcher),
    withIndexerCache("https://x/b", up.fetcher),
  ]);
  assert.equal(up.calls, 2);
  assert.notDeepEqual(a, b);
});

test("every joiner sees the rejection, and nothing is cached", async () => {
  const g = gate();
  let calls = 0;
  const fetcher = () => {
    calls += 1;
    return g.promise;
  };
  // Assertions are attached before the rejection lands: three joined promises
  // left bare across an await would be unhandled rejections, which by default
  // take the process down.
  const waiters = [1, 2, 3].map(() => {
    const p = withIndexerCache("https://x/down", fetcher);
    return assert.rejects(() => p, /timeout/);
  });
  g.reject(new Error("timeout"));
  await Promise.all(waiters);
  assert.equal(calls, 1);
  assert.equal(indexerCacheStats().size, 0);
  // The gate is clear, so the next caller gets a real attempt rather than the
  // corpse of this one.
  const up = counter();
  assert.deepEqual(await withIndexerCache("https://x/down", up.fetcher), { ok: true });
  assert.equal(up.calls, 1);
});

test("single-flight still applies with the cache disabled", async () => {
  withTtl(0);
  const g = gate();
  let calls = 0;
  const fetcher = () => {
    calls += 1;
    return g.promise;
  };
  const both = Promise.all([
    withIndexerCache("https://x/tokens/1", fetcher),
    withIndexerCache("https://x/tokens/1", fetcher),
  ]);
  assert.equal(calls, 1);
  g.resolve({ ok: true });
  await both;
});

/* ------------------------------ bounds & config ------------------------------ */

test("TTL 0 disables storage entirely", async () => {
  withTtl(0);
  const up = counter();
  await withIndexerCache("https://x/tokens/1", up.fetcher);
  await withIndexerCache("https://x/tokens/1", up.fetcher);
  await withIndexerCache("https://x/tokens/1", up.fetcher);
  assert.equal(up.calls, 3, "every read must go upstream");
  assert.equal(indexerCacheStats().size, 0);
  assert.equal(indexerCacheStats().hits, 0);
});

test("the entry count is bounded and the oldest go first", async () => {
  const up = counter((n) => ({ n }));
  for (let i = 0; i < MAX_ENTRIES + 5; i += 1) {
    await withIndexerCache(`https://x/tokens/${i}`, up.fetcher);
  }
  const stats = indexerCacheStats();
  assert.ok(stats.size <= MAX_ENTRIES, `size ${stats.size} exceeded the ${MAX_ENTRIES} bound`);
  assert.ok(stats.evictions > 0, "something must have been evicted");

  // The first url inserted is the least recently used, so it is gone; the last
  // is still there.
  const before = up.calls;
  await withIndexerCache("https://x/tokens/0", up.fetcher);
  assert.equal(up.calls, before + 1, "the oldest entry should have been evicted");
  await withIndexerCache(`https://x/tokens/${MAX_ENTRIES + 4}`, up.fetcher);
  assert.equal(up.calls, before + 1, "the newest entry should have survived");
});

test("a recently read entry outlives an older untouched one", async () => {
  const up = counter((n) => ({ n }));
  await withIndexerCache("https://x/hot", up.fetcher);
  for (let i = 0; i < MAX_ENTRIES + 5; i += 1) {
    // Keep touching the first url so recency, not insertion, decides.
    await withIndexerCache("https://x/hot", up.fetcher);
    await withIndexerCache(`https://x/cold/${i}`, up.fetcher);
  }
  const before = up.calls;
  await withIndexerCache("https://x/hot", up.fetcher);
  assert.equal(up.calls, before, "the hot url must still be cached");
});

test("resetIndexerCache clears entries and counters", async () => {
  const up = counter();
  await withIndexerCache("https://x/tokens/1", up.fetcher);
  await withIndexerCache("https://x/tokens/1", up.fetcher);
  assert.ok(indexerCacheStats().hits > 0);
  resetIndexerCache();
  const stats = indexerCacheStats();
  assert.equal(stats.size, 0);
  assert.equal(stats.hits, 0);
  assert.equal(stats.upstream, 0);
  await withIndexerCache("https://x/tokens/1", up.fetcher);
  assert.equal(up.calls, 2, "the cleared entry is really gone");
});

/* ------------------------- wiring into blockscout ------------------------- */

/** Swap globalThis.fetch for a counting stub; returns a restore function. */
function stubFetch(handler) {
  const real = globalThis.fetch;
  let calls = 0;
  const urls = [];
  globalThis.fetch = async (url, init) => {
    calls += 1;
    urls.push(String(url));
    return handler(String(url), init, calls);
  };
  return {
    get calls() {
      return calls;
    },
    urls,
    restore() {
      globalThis.fetch = real;
    },
  };
}

/** A Response-ish object — blockscout only reads ok/status/statusText/json. */
function jsonResponse(body, { status = 200, statusText = "OK" } = {}) {
  return { ok: status >= 200 && status < 300, status, statusText, json: async () => body };
}

test("blockscout getters share the cache with no call-site change", async () => {
  const f = stubFetch(() => jsonResponse({ symbol: "NVDA", exchange_rate: "1.23" }));
  try {
    const a = await getToken("0x1111111111111111111111111111111111111111");
    const b = await getToken("0x1111111111111111111111111111111111111111");
    assert.equal(f.calls, 1, "the repeat lookup must not hit the network");
    assert.deepEqual(b, a);

    // A different endpoint for the same address is a different URL, so it does
    // its own call — the key is the request, not the address.
    await getTokenHolders("0x1111111111111111111111111111111111111111");
    assert.equal(f.calls, 2);
  } finally {
    f.restore();
  }
});

test("a burst of identical blockscout reads costs one request", async () => {
  const g = gate();
  const f = stubFetch(() => g.promise);
  try {
    const all = Promise.all(
      Array.from({ length: 5 }, () => getToken("0x2222222222222222222222222222222222222222")),
    );
    assert.equal(f.calls, 1);
    g.resolve(jsonResponse({ symbol: "TSLA" }));
    const results = await all;
    for (const r of results) assert.deepEqual(r, { symbol: "TSLA" });
  } finally {
    f.restore();
  }
});

test("a blockscout error is neither cached nor stripped of its status", async () => {
  const f = stubFetch(() => jsonResponse(null, { status: 503, statusText: "Service Unavailable" }));
  try {
    const addr = "0x3333333333333333333333333333333333333333";
    await assert.rejects(() => getToken(addr), (e) => e.status === 503);
    await assert.rejects(() => getToken(addr), (e) => e.status === 503);
    assert.equal(f.calls, 2, "an outage must stay retryable");
  } finally {
    f.restore();
  }
});

test("a 404 is not cached either, so a later mint is visible", async () => {
  // 404 is the one status callers read as "does not exist". Caching it would
  // keep asserting that for a full TTL after the contract shows up.
  let n = 0;
  const f = stubFetch(() => {
    n += 1;
    return n === 1 ? jsonResponse(null, { status: 404, statusText: "Not Found" }) : jsonResponse({ symbol: "NEW" });
  });
  try {
    const addr = "0x4444444444444444444444444444444444444444";
    await assert.rejects(() => getToken(addr), (e) => e.status === 404);
    assert.deepEqual(await getToken(addr), { symbol: "NEW" });
  } finally {
    f.restore();
  }
});
