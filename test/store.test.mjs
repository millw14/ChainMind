// Tests for the storage seam (lib/store.js): the memory adapter's semantics, the
// bound that keeps it from eating a long-lived process, and — the part that
// actually matters — that production with nothing configured does NOT quietly
// hand back a memory store. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryStore,
  createPostgresStore,
  createRedisStore,
  createUnconfiguredStore,
  MEMORY_MAX_ENTRIES,
  resolveStoreDriver,
  setStoreClock,
  storeConnectionString,
  storeStatus,
  storeTimeoutMs,
  StoreTimeoutError,
  StoreUnconfiguredError,
  withStoreDeadline,
} from "../lib/store.js";

/** Run a body with a controlled set of env vars, restoring whatever was there. */
async function withEnv(vars, body) {
  const previous = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await body();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/* ------------------------------ driver choice ----------------------------- */

test("resolveStoreDriver: production with nothing configured refuses to guess", async () => {
  await withEnv(
    { NODE_ENV: "production", STORE_DRIVER: null, STORE_DATABASE_URL: null, DATABASE_URL: null },
    () => {
      // The whole point: NOT "memory". A per-lambda quota that silently counts to
      // five in each of ten instances is the failure this branch exists to stop.
      assert.equal(resolveStoreDriver().driver, "unconfigured");
    },
  );
});

test("resolveStoreDriver: development with nothing configured uses memory", async () => {
  await withEnv(
    { NODE_ENV: "development", STORE_DRIVER: null, STORE_DATABASE_URL: null, DATABASE_URL: null },
    () => {
      assert.equal(resolveStoreDriver().driver, "memory");
    },
  );
});

test("resolveStoreDriver: a connection string selects postgres, in production too", async () => {
  await withEnv(
    { NODE_ENV: "production", STORE_DRIVER: null, STORE_DATABASE_URL: "postgres://u@h/db" },
    () => {
      assert.equal(resolveStoreDriver().driver, "postgres");
      assert.equal(storeConnectionString(), "postgres://u@h/db");
    },
  );
});

test("resolveStoreDriver: STORE_DRIVER wins over a connection string", async () => {
  await withEnv(
    { NODE_ENV: "production", STORE_DRIVER: "memory", DATABASE_URL: "postgres://u@h/db" },
    () => {
      // Explicit opt-in is the ONLY way memory happens in production.
      assert.equal(resolveStoreDriver().driver, "memory");
    },
  );
});

test("resolveStoreDriver: an unknown driver name is unconfigured, not a fallback", async () => {
  await withEnv({ STORE_DRIVER: "dynamo", DATABASE_URL: null, STORE_DATABASE_URL: null }, () => {
    const r = resolveStoreDriver();
    assert.equal(r.driver, "unconfigured");
    assert.match(r.reason, /not a known driver/);
  });
});

test("resolveStoreDriver: STORE_DRIVER=redis without credentials is unconfigured", async () => {
  // Naming a driver is not configuring it. Half-configured must land in the same
  // place as unconfigured, never in a store that quietly 401s on every call.
  await withEnv(
    {
      STORE_DRIVER: "redis",
      UPSTASH_REDIS_REST_URL: "https://kv.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: null,
      KV_REST_API_URL: null,
      KV_REST_API_TOKEN: null,
    },
    () => {
      assert.equal(resolveStoreDriver().driver, "unconfigured");
    },
  );
});

/* ------------------------------- fail closed ------------------------------ */

test("the unconfigured store rejects every operation", async () => {
  const store = createUnconfiguredStore("test");
  for (const call of [
    () => store.get("k"),
    () => store.set("k", 1),
    () => store.take("k"),
    () => store.delete("k"),
    () => store.increment("k"),
    () => store.append("k", 1),
    () => store.list("k"),
  ]) {
    await assert.rejects(call, StoreUnconfiguredError);
  }
  assert.equal(store.durable, false);
  assert.ok(store.warnings.length > 0, "an unconfigured store has to say so");
});

test("createPostgresStore without a connection string fails closed", async () => {
  await assert.rejects(() => createPostgresStore(""), StoreUnconfiguredError);
});

test("createPostgresStore without the optional driver fails closed, never to memory", async () => {
  // `pg` is intentionally not a dependency of this app. If someone later adds it,
  // this assertion becomes about the connection failing instead — which is why it
  // only insists the call does not RESOLVE to a working store.
  await assert.rejects(
    () => createPostgresStore("postgres://user@127.0.0.1:1/db"),
    (e) => {
      assert.ok(e instanceof Error);
      if (e instanceof StoreUnconfiguredError) assert.match(e.message, /npm install pg/);
      return true;
    },
  );
});

/* ---------------------------- memory semantics ---------------------------- */

test("memory store round-trips values and reports what it is", async () => {
  const store = createMemoryStore();
  assert.equal(store.driver, "memory");
  assert.equal(store.durable, false);
  assert.equal(store.shared, false);
  assert.ok(
    store.warnings.some((w) => /not durable/i.test(w)),
    "the memory adapter must be able to say it is not durable",
  );

  assert.equal(await store.get("missing"), null);
  await store.set("k", { a: 1 });
  assert.deepEqual(await store.get("k"), { a: 1 });
  assert.equal(await store.delete("k"), true);
  assert.equal(await store.get("k"), null);
});

test("memory store clones on the way in and out", async () => {
  const store = createMemoryStore();
  const original = { list: [1] };
  await store.set("k", original);
  original.list.push(2);
  assert.deepEqual(await store.get("k"), { list: [1] }, "a later mutation must not reach the store");

  const read = await store.get("k");
  read.list.push(3);
  assert.deepEqual(await store.get("k"), { list: [1] }, "a caller's mutation must not reach it either");
});

test("memory store expires values on the clock, not on a sleep", async () => {
  let now = 1_000;
  const restore = setStoreClock(() => now);
  try {
    const store = createMemoryStore();
    await store.set("k", "v", { ttlMs: 100 });
    now = 1_099;
    assert.equal(await store.get("k"), "v");
    now = 1_100;
    assert.equal(await store.get("k"), null, "expiry is inclusive of the boundary");
  } finally {
    restore();
  }
});

test("take returns a value once and only once", async () => {
  const store = createMemoryStore();
  await store.set("nonce", { n: 1 });
  assert.deepEqual(await store.take("nonce"), { n: 1 });
  assert.equal(await store.take("nonce"), null, "a single-use value must not survive being taken");
});

test("take does not return an expired value", async () => {
  let now = 0;
  const restore = setStoreClock(() => now);
  try {
    const store = createMemoryStore();
    await store.set("k", "v", { ttlMs: 10 });
    now = 10;
    assert.equal(await store.take("k"), null);
  } finally {
    restore();
  }
});

test("increment counts in a FIXED window that hammering cannot extend", async () => {
  let now = 0;
  const restore = setStoreClock(() => now);
  try {
    const store = createMemoryStore();
    const first = await store.increment("quota", { ttlMs: 100 });
    assert.deepEqual(first, { value: 1, expiresAt: 100 });

    now = 90;
    const second = await store.increment("quota", { ttlMs: 100 });
    assert.equal(second.value, 2);
    assert.equal(second.expiresAt, 100, "the window must not slide forward on each hit");

    now = 100;
    const third = await store.increment("quota", { ttlMs: 100 });
    assert.equal(third.value, 1, "a new window starts from zero");
  } finally {
    restore();
  }
});

test("increment accepts a custom amount", async () => {
  const store = createMemoryStore();
  await store.increment("k", { ttlMs: 1000, amount: 5 });
  const r = await store.increment("k", { ttlMs: 1000, amount: 3 });
  assert.equal(r.value, 8);
});

test("append/list keep history newest-first and bounded", async () => {
  const store = createMemoryStore();
  for (const q of ["one", "two", "three"]) await store.append("hist:0xabc", q, { max: 2 });
  assert.deepEqual(await store.list("hist:0xabc"), ["three", "two"]);
  assert.deepEqual(await store.list("hist:0xabc", { limit: 1 }), ["three"]);
});

test("deleting a history key removes it — the user can take their data back", async () => {
  const store = createMemoryStore();
  await store.append("hist:0xabc", "a question");
  assert.equal(await store.delete("hist:0xabc"), true);
  assert.deepEqual(await store.list("hist:0xabc"), []);
});

test("one address's history is not reachable under another key", async () => {
  const store = createMemoryStore();
  await store.append("hist:0xaaa", "mine");
  assert.deepEqual(await store.list("hist:0xbbb"), []);
});

test("memory store stays bounded under an unbounded key space", async () => {
  const store = createMemoryStore();
  for (let i = 0; i < MEMORY_MAX_ENTRIES + 50; i++) await store.set(`k${i}`, i);
  assert.ok(store._size() <= MEMORY_MAX_ENTRIES, `size ${store._size()} exceeded the cap`);
  // Eviction is oldest-first, so the newest writes are the ones that survive.
  assert.equal(await store.get(`k${MEMORY_MAX_ENTRIES + 49}`), MEMORY_MAX_ENTRIES + 49);
  assert.equal(await store.get("k0"), null);
});

/* ------------------------- the store that ships ---------------------------- */

/**
 * A fake Upstash REST endpoint: it speaks the wire protocol (a JSON command
 * array in, `{ result }` out) against a Map, so the adapter's own encoding,
 * pipelining and reply handling are what is under test rather than a mock of
 * them.
 */
function fakeRedis() {
  const keys = new Map();
  const seen = [];

  function run([op, key, ...rest]) {
    const name = String(op).toUpperCase();
    if (name === "SET") {
      // NX is the whole reason the daily window does not slide; honour it here
      // or the test below would pass against an adapter that dropped it.
      if (rest.includes("NX") && keys.has(key)) return null;
      keys.set(key, { value: rest[0] });
      return "OK";
    }
    if (name === "GET") return keys.get(key)?.value ?? null;
    if (name === "GETDEL") {
      const v = keys.get(key)?.value ?? null;
      keys.delete(key);
      return v;
    }
    if (name === "DEL") return keys.delete(key) ? 1 : 0;
    if (name === "INCRBY") {
      const next = Number(keys.get(key)?.value ?? 0) + Number(rest[0]);
      keys.set(key, { value: String(next) });
      return next;
    }
    if (name === "PTTL") return keys.has(key) ? 60_000 : -2;
    if (name === "PEXPIRE") return 1;
    if (name === "LPUSH") {
      const items = keys.get(key)?.items ?? [];
      items.unshift(rest[0]);
      keys.set(key, { items });
      return items.length;
    }
    if (name === "LTRIM") {
      const items = keys.get(key)?.items ?? [];
      keys.set(key, { items: items.slice(Number(rest[0]), Number(rest[1]) + 1) });
      return "OK";
    }
    if (name === "LLEN") return (keys.get(key)?.items ?? []).length;
    if (name === "LRANGE") {
      const items = keys.get(key)?.items ?? [];
      const stop = Number(rest[1]);
      return stop < 0 ? items.slice(Number(rest[0])) : items.slice(Number(rest[0]), stop + 1);
    }
    if (name === "LREM") {
      const items = keys.get(key)?.items ?? [];
      const at = items.indexOf(rest[1]);
      if (at < 0) return 0;
      items.splice(at, 1);
      keys.set(key, { items });
      return 1;
    }
    throw new Error(`fakeRedis does not implement ${name}`);
  }

  async function fetchImpl(url, init) {
    const body = JSON.parse(init.body);
    seen.push({ url: String(url), body });
    const payload = String(url).endsWith("/pipeline")
      ? body.map((c) => ({ result: run(c) }))
      : { result: run(body) };
    return {
      ok: true,
      status: 200,
      async json() {
        return payload;
      },
    };
  }

  return { fetchImpl, seen, keys };
}

/** Swap global fetch for the duration of a body. */
async function withFetch(impl, body) {
  const previous = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await body();
  } finally {
    globalThis.fetch = previous;
  }
}

test("the REST key-value driver is selected by credentials alone, with nothing installed", async () => {
  await withEnv(
    {
      NODE_ENV: "production",
      STORE_DRIVER: null,
      STORE_DATABASE_URL: null,
      DATABASE_URL: null,
      UPSTASH_REDIS_REST_URL: "https://kv.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "t",
    },
    () => {
      assert.equal(resolveStoreDriver().driver, "redis");
      // And it is reported as a real, shared, enforced store.
      const status = storeStatus();
      assert.equal(status.enforced, true);
      assert.deepEqual(status.warnings, []);
    },
  );
});

test("redis: nonces are single-use through GETDEL and counters accumulate", async () => {
  const fake = fakeRedis();
  await withFetch(fake.fetchImpl, async () => {
    const store = createRedisStore({ url: "https://kv.upstash.io", token: "t" });

    await store.set("auth:nonce:pre", { nonce: "n1" }, { ttlMs: 60_000 });
    assert.deepEqual(await store.take("auth:nonce:pre"), { nonce: "n1" });
    // The second redeem finds nothing — the whole point of a single-use nonce.
    assert.equal(await store.take("auth:nonce:pre"), null);

    assert.equal((await store.increment("quota:d:ip:1.2.3.4", { ttlMs: 1000 })).value, 1);
    assert.equal((await store.increment("quota:d:ip:1.2.3.4", { ttlMs: 1000 })).value, 2);
    assert.equal((await store.counter("quota:d:ip:1.2.3.4")).value, 2);
    // A key nobody has touched is absent, and absent is null — never zero.
    assert.equal(await store.counter("quota:d:ip:never"), null);
  });
});

test("redis: the daily window is planted once and does not slide", async () => {
  const fake = fakeRedis();
  await withFetch(fake.fetchImpl, async () => {
    const store = createRedisStore({ url: "https://kv.upstash.io", token: "t" });
    await store.increment("quota:d:ip:9", { ttlMs: 1000 });
    await store.increment("quota:d:ip:9", { ttlMs: 1000 });
    const sets = fake.seen.flatMap((r) => r.body).filter((c) => Array.isArray(c) && c[0] === "SET");
    assert.equal(sets.length, 2);
    // NX on every one of them: only the request that creates the key sets its
    // expiry, so hammering the counter cannot hold the day open.
    for (const s of sets) assert.ok(s.includes("NX"), "the TTL is only planted on create");
  });
});

test("redis: history is a bounded ring and one entry can be removed by id", async () => {
  const fake = fakeRedis();
  await withFetch(fake.fetchImpl, async () => {
    const store = createRedisStore({ url: "https://kv.upstash.io", token: "t" });
    for (const id of ["a", "b", "c"]) await store.append("hist:0xabc", { id }, { max: 2 });
    assert.deepEqual(await store.list("hist:0xabc"), [{ id: "c" }, { id: "b" }]);
    assert.equal(await store.removeFromList("hist:0xabc", "b"), 1);
    assert.deepEqual(await store.list("hist:0xabc"), [{ id: "c" }]);
    // An id under somebody else's key matches nothing.
    assert.equal(await store.removeFromList("hist:0xdef", "c"), 0);
  });
});

test("redis: an HTTP failure is an error, never an empty answer", async () => {
  const failing = async () => ({
    ok: false,
    status: 500,
    async text() {
      return "boom";
    },
  });
  await withFetch(failing, async () => {
    const store = createRedisStore({ url: "https://kv.upstash.io", token: "t" });
    // Never null. An outage reading as absence is the bug the store exists to avoid.
    await assert.rejects(() => store.counter("quota:d:ip:1"), /redis REST 500/);
  });
});

test("createRedisStore refuses half-configured credentials", () => {
  assert.throws(() => createRedisStore({ url: "https://kv.upstash.io", token: "" }), StoreUnconfiguredError);
  assert.throws(() => createRedisStore({ url: "", token: "t" }), StoreUnconfiguredError);
});

/* ---------------------- unenforced, loudly rather than not ----------------- */

test("a production deploy with no store is reported as an UNENFORCED quota", async () => {
  await withEnv(
    {
      NODE_ENV: "production",
      STORE_DRIVER: null,
      STORE_DATABASE_URL: null,
      DATABASE_URL: null,
      UPSTASH_REDIS_REST_URL: null,
      UPSTASH_REDIS_REST_TOKEN: null,
      KV_REST_API_URL: null,
      KV_REST_API_TOKEN: null,
    },
    () => {
      const status = storeStatus();
      assert.equal(status.driver, "unconfigured");
      assert.equal(status.enforced, false, "and it must SAY so, not merely be it");
      assert.ok(
        status.warnings.some((w) => /NOT ENFORCED/.test(w)),
        "the words an operator can search for have to be in the output",
      );
    },
  );
});

test("memory is never reported as an enforced quota", async () => {
  await withEnv({ STORE_DRIVER: "memory" }, () => {
    const status = storeStatus();
    assert.equal(status.driver, "memory");
    assert.equal(status.enforced, false);
    assert.ok(status.warnings.some((w) => /NOT ENFORCED/.test(w)));
  });
  // The adapters carry the same claim, so nothing downstream has to re-derive it
  // from a driver name it would have to keep a list of.
  assert.equal(createMemoryStore().enforced, false);
  assert.equal(createUnconfiguredStore("test").enforced, false);
});

/* ------------------------------- the deadline ------------------------------ */

test("a hanging store call times out instead of eating its caller's budget", async () => {
  const hanging = {
    async increment() {
      return new Promise(() => {});
    },
  };
  const store = withStoreDeadline(hanging, 25);
  const started = Date.now();
  await assert.rejects(
    () => store.increment("k", { ttlMs: 1000 }),
    (e) => e instanceof StoreTimeoutError && e.code === "STORE_TIMEOUT",
  );
  // Bounded, and bounded by OUR number rather than by whatever the store decides.
  assert.ok(Date.now() - started < 1_000, "the caller was released promptly");
});

test("the deadline does not get in the way of a store that answers", async () => {
  const store = withStoreDeadline(createMemoryStore(), 5_000);
  await store.set("k", 1);
  assert.equal(await store.get("k"), 1);
  assert.equal((await store.increment("c", { ttlMs: 1000 })).value, 1);
  // Non-contract properties survive the wrapping.
  assert.equal(store.driver, "memory");
  assert.equal(typeof store._size, "function");
});

test("the deadline can be switched off, and defaults to something small", async () => {
  const slow = {
    async get() {
      await new Promise((r) => setTimeout(r, 20));
      return "late";
    },
  };
  assert.equal(await withStoreDeadline(slow, 0).get("k"), "late", "0 means no deadline");
  await withEnv({ STORE_TIMEOUT_MS: null }, () => {
    // Small relative to the 24s ask budget it runs before — see lib/ask-access.js.
    assert.ok(storeTimeoutMs() > 0 && storeTimeoutMs() <= 3_000, `got ${storeTimeoutMs()}ms`);
  });
  await withEnv({ STORE_TIMEOUT_MS: "250" }, () => assert.equal(storeTimeoutMs(), 250));
  await withEnv({ STORE_TIMEOUT_MS: "banana" }, () => assert.equal(storeTimeoutMs(), 1_500));
});
