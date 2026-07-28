/**
 * The one place the app is allowed to remember something between requests.
 *
 * WHY A SEAM AT ALL. Everything the wallet gate needs — a sign-in nonce that must
 * be single-use, a quota counter, a user's saved history — is state that outlives
 * one request, and hosting is undecided between Vercel (many short-lived lambdas,
 * ephemeral filesystem) and Railway (one long-lived process). Those two have
 * opposite storage truths, so the call sites must not know which one they are on.
 *
 * THE FAILURE THIS FILE EXISTS TO PREVENT. An in-memory Map on serverless is not
 * "a bit lossy" — it is per-lambda. A 5/day quota backed by memory across ten warm
 * instances is a 50/day quota that also resets on every deploy, and a nonce issued
 * by one instance is unknown to the next, so sign-in fails at random. Both bugs are
 * SILENT: nothing throws, the numbers are just wrong. So the memory adapter is
 * never chosen implicitly in production, and when it IS chosen it says so loudly.
 *
 * HOW THE DRIVER IS PICKED (resolveStoreDriver, and it is deliberately boring):
 *   1. STORE_DRIVER=memory|redis|postgres wins outright. Explicit beats clever.
 *   2. Otherwise a REST URL + token (UPSTASH_REDIS_REST_*, or Vercel's
 *      KV_REST_API_*) => redis. First because it is the one that needs nothing
 *      installed.
 *   3. Otherwise a connection string (STORE_DATABASE_URL or DATABASE_URL) => postgres.
 *   4. Otherwise, outside production => memory. `npm run dev` needs no setup.
 *   5. Otherwise (production, nothing configured) => "unconfigured": a store whose
 *      every method REJECTS. Not memory. A production quota that silently became
 *      decorative is the exact outcome this module refuses to produce.
 *
 * THE SHIPPING DRIVER IS REDIS-OVER-HTTP, AND IT ADDS NO DEPENDENCY. Upstash's
 * REST API (and Vercel KV, which is the same protocol) speaks Redis commands over
 * plain HTTP POST, so `fetch` is the entire client — no TCP driver, no connection
 * pool to leak across lambdas, and the same code path on Vercel's many short-lived
 * instances and Railway's one long process. That is why it is preferred over
 * postgres: the five-dependency budget stays intact and there is nothing an
 * operator can forget to `npm install`.
 *
 * THE POSTGRES DRIVER IS OPTIONAL AND STILL NOT BUNDLED. Node has no built-in
 * postgres client (`node:postgres` does not exist; `node:sqlite` does, but a
 * file-backed database on a serverless filesystem is memory with extra steps), so
 * the adapter loads `pg` through a dynamic import: install it and postgres works,
 * skip it and STORE_DRIVER=postgres FAILS CLOSED with an error naming the fix. It
 * is kept for deployments that already have a database and want one less service.
 * What it never does is fall back to memory, because a fallback is how a
 * durability guarantee quietly stops being one.
 *
 * EVERY ROUND TRIP HAS A DEADLINE. getStore() hands back an adapter whose methods
 * are wrapped by withStoreDeadline, because the quota check runs BEFORE /api/ask
 * opens its 24s budget: an unbounded store call there does not merely slow a
 * request down, it spends the answer's time and hands the reader the 504 the
 * budget exists to prevent. On timeout the call rejects, and lib/quota.js degrades
 * to the per-process limiter with `degraded: true` rather than failing the
 * question.
 *
 * VALUES are JSON-shaped (whatever survives a structuredClone / JSONB round trip).
 * KEYS are opaque strings; callers own their own prefixes.
 */

/** Hard cap on live keys in the memory adapter. See evictOldest for the trade. */
export const MEMORY_MAX_ENTRIES = 10_000;

/** Hard cap on items in one memory list, so history cannot grow without bound. */
export const MEMORY_MAX_LIST_ITEMS = 500;

/**
 * Where this module reads the time. A seam, not a nicety: TTL tests otherwise
 * race real sleeps against real expiries, which is a flake waiting for a loaded
 * CI box. Production never touches this — the default IS Date.now.
 */
let clock = () => Date.now();

/**
 * Swap the clock for a test, and get a restore function back.
 * @param {() => number} fn
 * @returns {() => void} restores the real clock
 */
export function setStoreClock(fn) {
  const previous = clock;
  clock = typeof fn === "function" ? fn : previous;
  return () => {
    clock = previous;
  };
}

/**
 * Thrown when the app is asked to remember something and has nowhere to put it.
 *
 * Carries a `code` so a route can turn it into a 503 "not configured" instead of
 * a 500 "something broke" — the operator needs to know it is a missing env var,
 * not a bug.
 */
export class StoreUnconfiguredError extends Error {
  constructor(message) {
    super(message);
    this.name = "StoreUnconfiguredError";
    this.code = "STORE_UNCONFIGURED";
  }
}

/**
 * Thrown when a store round trip outlives its deadline.
 *
 * A distinct type from the one above because the two want opposite responses: an
 * unconfigured store is a deploy to fix, a timed-out one is a request to degrade.
 * The call itself is ABANDONED, not cancelled — the underlying fetch or query may
 * still complete and be thrown away. That is the trade: a caller that is already
 * out of time cannot be made to wait for a cancellation handshake.
 */
export class StoreTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "StoreTimeoutError";
    this.code = "STORE_TIMEOUT";
  }
}

/** Trimmed env read; empty string counts as unset. */
function env(name) {
  const raw = process.env[name];
  const s = raw == null ? "" : String(raw).trim();
  return s || null;
}

/** True in a production deployment, where a silent memory store is a real bug. */
function isProduction() {
  return process.env.NODE_ENV === "production";
}

/** The postgres connection string, from either accepted name. */
export function storeConnectionString() {
  return env("STORE_DATABASE_URL") || env("DATABASE_URL");
}

/**
 * Credentials for the HTTP key-value backend, or null.
 *
 * Both Upstash's own variable names and Vercel KV's are accepted because they are
 * the same service under two labels and a deployer should not have to copy one
 * into the other. BOTH halves are required: a URL with no token is a store that
 * would 401 on every call, and reporting that as "configured" is exactly the
 * silent-failure shape this module exists to refuse.
 *
 * @returns {{ url: string, token: string }|null}
 */
export function storeRestConfig() {
  const url = env("UPSTASH_REDIS_REST_URL") || env("KV_REST_API_URL");
  const token = env("UPSTASH_REDIS_REST_TOKEN") || env("KV_REST_API_TOKEN");
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

/**
 * Which adapter this environment asks for, without building it.
 *
 * Pure and synchronous so the decision can be asserted in tests and reported by
 * a health endpoint without opening a connection.
 *
 * @returns {{ driver: "memory"|"redis"|"postgres"|"unconfigured", reason: string }}
 */
export function resolveStoreDriver() {
  const explicit = env("STORE_DRIVER")?.toLowerCase();
  if (explicit === "memory") return { driver: "memory", reason: "STORE_DRIVER=memory" };
  if (explicit === "redis" || explicit === "upstash" || explicit === "kv") {
    return storeRestConfig()
      ? { driver: "redis", reason: `STORE_DRIVER=${explicit}` }
      : {
          driver: "unconfigured",
          reason: `STORE_DRIVER=${explicit} but UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL/KV_REST_API_TOKEN) are not both set`,
        };
  }
  if (explicit === "postgres" || explicit === "postgresql") {
    return { driver: "postgres", reason: "STORE_DRIVER=postgres" };
  }
  if (explicit) {
    return {
      driver: "unconfigured",
      reason: `STORE_DRIVER="${explicit}" is not a known driver (use memory, redis or postgres).`,
    };
  }
  // Ahead of postgres on purpose: this is the driver that ships working, with no
  // `npm install` step an operator can skip and no pool to manage per lambda.
  if (storeRestConfig()) return { driver: "redis", reason: "a REST key-value URL and token are set" };
  if (storeConnectionString()) {
    return { driver: "postgres", reason: "a connection string is set" };
  }
  if (!isProduction()) return { driver: "memory", reason: "no store configured, not production" };
  return {
    driver: "unconfigured",
    reason: "production with no STORE_DRIVER, no REST key-value credentials and no connection string",
  };
}

/**
 * How long one store round trip may take before the caller gives up on it.
 *
 * SMALL RELATIVE TO WHAT IT PRECEDES, and that is the whole design constraint.
 * The gate runs before /api/ask opens its 24s budget (lib/request-budget.js), so
 * everything it spends comes out of PLATFORM_MARGIN_MS — 6s — alongside cold
 * start and response serialization. The gate's worst case is one balance read
 * (GATE_RPC_TIMEOUT_MS, 2.5s) plus one counter increment: 1.5s here keeps the
 * pair at 4s and leaves 2s of margin, and lib/ask-access.js asserts that sum
 * against the margin so the two cannot drift apart unnoticed.
 */
const DEFAULT_STORE_TIMEOUT_MS = 1_500;

/** @returns {number} the per-call deadline in ms; 0 or negative disables it. */
export function storeTimeoutMs() {
  const raw = process.env.STORE_TIMEOUT_MS;
  if (raw == null || String(raw).trim() === "") return DEFAULT_STORE_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_STORE_TIMEOUT_MS;
}

/* --------------------------------- memory --------------------------------- */

/**
 * Process-local adapter: correct on one long-lived process, actively misleading
 * on many. Everything about it is bounded, because the process it lives in is
 * expected to run for weeks and the key space (one entry per caller, per nonce)
 * has no natural ceiling.
 *
 * Says nothing on construction: the announcement belongs to getStore(), which is
 * the only place that knows this adapter was chosen by config rather than asked
 * for on purpose by a test.
 */
export function createMemoryStore() {
  /** key -> { value, expiresAt } for scalars, { items, expiresAt } for lists.
   *  Insertion order doubles as the eviction queue. */
  const entries = new Map();

  function evictOldest() {
    // Dropping the oldest key can drop a live nonce, which costs that user one
    // retry — a far better failure than an unbounded Map taking the process out.
    const oldest = entries.keys().next();
    if (!oldest.done) entries.delete(oldest.value);
  }

  function live(key) {
    const e = entries.get(key);
    if (!e) return null;
    if (e.expiresAt != null && e.expiresAt <= clock()) {
      entries.delete(key);
      return null;
    }
    return e;
  }

  function put(key, entry) {
    // Re-insert so the key moves to the back of the eviction queue.
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > MEMORY_MAX_ENTRIES) evictOldest();
  }

  function expiryFrom(ttlMs) {
    const n = Number(ttlMs);
    return Number.isFinite(n) && n > 0 ? clock() + n : null;
  }

  return {
    driver: "memory",
    durable: false,
    shared: false,
    /** No shared counter, no enforced quota. Nothing downstream may read a memory
     *  store as a limit that actually holds across instances. */
    enforced: false,
    warnings: [...memoryWarnings(), ...unenforcedWarnings()],

    async get(key) {
      const e = live(key);
      if (!e || !("value" in e)) return null;
      // Clone on the way out as well as in: a caller that mutates what it read
      // would otherwise silently rewrite the stored copy, a bug that cannot
      // happen against postgres and so would only ever show up in production.
      return structuredClone(e.value);
    },

    async set(key, value, opts = {}) {
      put(key, { value: structuredClone(value), expiresAt: expiryFrom(opts.ttlMs) });
    },

    async take(key) {
      const e = live(key);
      if (!e || !("value" in e)) return null;
      entries.delete(key);
      return structuredClone(e.value);
    },

    async delete(key) {
      return entries.delete(key);
    },

    async counter(key) {
      // A READ of a counter, which increment cannot give without also spending
      // one. The UI needs "2 of 5 used" on page load, and asking for that must
      // not cost the visitor a question.
      const e = live(key);
      if (!e || typeof e.value !== "number") return null;
      return { value: e.value, expiresAt: e.expiresAt };
    },

    async increment(key, opts = {}) {
      const amount = Number.isFinite(Number(opts.amount)) ? Number(opts.amount) : 1;
      const e = live(key);
      if (!e || typeof e.value !== "number") {
        const expiresAt = expiryFrom(opts.ttlMs);
        put(key, { value: amount, expiresAt });
        return { value: amount, expiresAt };
      }
      // The window does NOT slide: the expiry stays where the first increment put
      // it, so a caller cannot hold a bucket open forever by hammering it.
      const value = e.value + amount;
      put(key, { value, expiresAt: e.expiresAt });
      return { value, expiresAt: e.expiresAt };
    },

    async append(key, item, opts = {}) {
      const max = Math.min(Number(opts.max) || MEMORY_MAX_LIST_ITEMS, MEMORY_MAX_LIST_ITEMS);
      const e = live(key);
      const items = e && Array.isArray(e.items) ? e.items : [];
      items.unshift({ at: clock(), value: structuredClone(item) });
      if (items.length > max) items.length = max;
      put(key, { items, expiresAt: expiryFrom(opts.ttlMs) ?? e?.expiresAt ?? null });
      return items.length;
    },

    async list(key, opts = {}) {
      const e = live(key);
      if (!e || !Array.isArray(e.items)) return [];
      const limit = Number(opts.limit) > 0 ? Number(opts.limit) : e.items.length;
      return e.items.slice(0, limit).map((row) => structuredClone(row.value));
    },

    async removeFromList(key, itemId) {
      // Deleting ONE item, matched on an id inside the stored value rather than
      // on a position: a caller that names an id which is not under this key
      // removes nothing, which is what makes per-user scoping hold when the id
      // comes from a request. Positions would not survive a concurrent append.
      const id = String(itemId ?? "");
      const e = live(key);
      if (!id || !e || !Array.isArray(e.items)) return 0;
      const before = e.items.length;
      const items = e.items.filter((row) => String(row?.value?.id ?? "") !== id);
      if (items.length === before) return 0;
      put(key, { items, expiresAt: e.expiresAt ?? null });
      return before - items.length;
    },

    async close() {},

    /** Test/diagnostic hook. Not part of the adapter contract. */
    _size() {
      return entries.size;
    },
  };
}

/** The sentences a memory store has to be able to say about itself. */
function memoryWarnings() {
  return [
    "The store is IN-MEMORY: not durable (a restart or deploy erases it) and not shared (every process or lambda has its own).",
    "On serverless this makes quotas per-instance and sign-in nonces unreliable — issue on one lambda, verify on another, and the nonce is simply not there.",
  ];
}

/* ---------------------------------- redis --------------------------------- */

/**
 * Durable, shared adapter over an Upstash-compatible Redis REST API.
 *
 * NO DRIVER, NO POOL, NO DEPENDENCY. Commands go out as a JSON array in an HTTP
 * POST — `["SET","k","v","PX","1000"]` — and come back as `{ "result": … }`.
 * That is the entire protocol, which is why this one can ship: `fetch` is in the
 * runtime already, and a stateless HTTP call behaves identically whether it is
 * made by the tenth cold lambda of a Vercel deploy or by a Railway process that
 * has been up for a month. A TCP pool has to be reasoned about differently in
 * those two places; this does not.
 *
 * ATOMICITY, WHICH IS THE PART THAT MATTERS. Single-use nonces use GETDEL, so two
 * concurrent verifies cannot both come back with the challenge. Counters use
 * INCRBY, so two lambdas incrementing the same day's key produce 2 and not 1. The
 * TTL is planted by a `SET … NX` in the same pipeline as the increment, which is
 * what keeps the daily window from SLIDING: only the request that creates the key
 * sets its expiry, so hammering the counter cannot hold the day open.
 *
 * @param {{ url: string, token: string }|null} config
 */
export function createRedisStore(config) {
  // Destructured inside rather than in the signature: a null config is a
  // misconfiguration to report, not a TypeError to debug.
  const { url, token } = config ?? {};
  if (!url || !token) {
    throw new StoreUnconfiguredError(
      "The REST key-value store is selected but its URL and token are not both set. " +
        "Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (Vercel KV's " +
        "KV_REST_API_URL / KV_REST_API_TOKEN are accepted too).",
    );
  }

  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  /** The per-call abort, so a stalled socket is dropped rather than merely
   *  abandoned by the deadline wrapper above it. Slightly longer than that
   *  deadline: the wrapper should be what reports the timeout, in one voice. */
  function signal() {
    const ms = storeTimeoutMs();
    if (!(ms > 0) || typeof AbortSignal?.timeout !== "function") return undefined;
    return AbortSignal.timeout(ms + 250);
  }

  async function post(path, body) {
    const res = await fetch(`${url}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // Never let a platform fetch cache a state read. There is no such thing as
      // a stale-but-fine counter.
      cache: "no-store",
      signal: signal(),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`redis REST ${res.status}${detail ? ` ${detail.slice(0, 200)}` : ""}`);
    }
    return res.json();
  }

  /** One command. Returns the raw redis reply. */
  async function cmd(args) {
    const body = await post("", args.map(String));
    if (body?.error) throw new Error(`redis ${args[0]}: ${body.error}`);
    return body?.result ?? null;
  }

  /** Several commands in one round trip, in order. Returns their raw replies. */
  async function pipeline(commands) {
    const list = commands.filter(Boolean).map((c) => c.map(String));
    if (!list.length) return [];
    const body = await post("/pipeline", list);
    if (!Array.isArray(body)) throw new Error("redis pipeline: unexpected reply shape");
    return body.map((row, i) => {
      if (row?.error) throw new Error(`redis ${list[i][0]}: ${row.error}`);
      return row?.result ?? null;
    });
  }

  /** Stored values are JSON. A value that is not is treated as absent rather than
   *  thrown over: a key some other tool wrote must not break a quota check. */
  function decode(raw) {
    if (raw == null) return null;
    try {
      return JSON.parse(String(raw));
    } catch {
      return null;
    }
  }

  /** PTTL: -1 means "no expiry", -2 "no key". Neither is a timestamp. */
  function expiryFromPttl(pttl) {
    const n = Number(pttl);
    return Number.isFinite(n) && n > 0 ? clock() + n : null;
  }

  function positiveTtl(ttlMs) {
    const n = Number(ttlMs);
    return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
  }

  return {
    driver: "redis",
    durable: true,
    shared: true,
    enforced: true,
    warnings: [],

    async get(key) {
      return decode(await cmd(["GET", key]));
    },

    async set(key, value, opts = {}) {
      const ttl = positiveTtl(opts.ttlMs);
      const json = JSON.stringify(value);
      await cmd(ttl ? ["SET", key, json, "PX", ttl] : ["SET", key, json]);
    },

    async take(key) {
      // GETDEL is the single-use guarantee: read and delete in one server-side
      // step, so two concurrent redeems of one nonce cannot both find it.
      return decode(await cmd(["GETDEL", key]));
    },

    async delete(key) {
      return Number(await cmd(["DEL", key])) > 0;
    },

    async counter(key) {
      const [value, pttl] = await pipeline([
        ["GET", key],
        ["PTTL", key],
      ]);
      if (value == null) return null;
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      return { value: n, expiresAt: expiryFromPttl(pttl) };
    },

    async increment(key, opts = {}) {
      const amount = Number.isFinite(Number(opts.amount)) ? Number(opts.amount) : 1;
      // Mirrors the postgres adapter: a counter with no stated window still gets
      // one, because a counter that never expires is a counter that never resets.
      const ttl = positiveTtl(opts.ttlMs) ?? 60_000;
      const [, value, pttl] = await pipeline([
        // NX: only the first writer plants the expiry, so the window is fixed to
        // the first increment and does not slide under a hammering caller.
        ["SET", key, "0", "PX", ttl, "NX"],
        ["INCRBY", key, amount],
        ["PTTL", key],
      ]);
      return { value: Number(value) || 0, expiresAt: expiryFromPttl(pttl) };
    },

    async append(key, item, opts = {}) {
      const max = Math.min(Number(opts.max) || MEMORY_MAX_LIST_ITEMS, MEMORY_MAX_LIST_ITEMS);
      const ttl = positiveTtl(opts.ttlMs);
      // LPUSH then LTRIM: the cap is a ring, so a save is never refused because a
      // user has asked a lot of questions — the oldest entry drops instead.
      const replies = await pipeline([
        ["LPUSH", key, JSON.stringify(item)],
        ["LTRIM", key, 0, max - 1],
        ttl ? ["PEXPIRE", key, ttl] : null,
        ["LLEN", key],
      ]);
      return Number(replies[replies.length - 1]) || 0;
    },

    async list(key, opts = {}) {
      const limit = Number(opts.limit) > 0 ? Number(opts.limit) : MEMORY_MAX_LIST_ITEMS;
      const rows = await cmd(["LRANGE", key, 0, limit - 1]);
      return (Array.isArray(rows) ? rows : []).map(decode).filter((v) => v != null);
    },

    async removeFromList(key, itemId) {
      const id = String(itemId ?? "");
      if (!id) return 0;
      // Redis removes list elements by VALUE, so the exact stored string has to be
      // found first. Two round trips for a delete is fine — it happens when a user
      // clicks a bin icon, not on the answer path. The read is bounded by the same
      // cap append enforces, and the key is derived from the session address, so an
      // id belonging to another wallet matches nothing here.
      const rows = await cmd(["LRANGE", key, 0, MEMORY_MAX_LIST_ITEMS - 1]);
      const raw = (Array.isArray(rows) ? rows : []).find(
        (row) => String(decode(row)?.id ?? "") === id,
      );
      if (raw == null) return 0;
      return Number(await cmd(["LREM", key, 1, String(raw)])) || 0;
    },

    async close() {},
  };
}

/* -------------------------------- postgres -------------------------------- */

/**
 * Table definitions, kept beside the queries that use them so the two cannot
 * drift. Applied with IF NOT EXISTS once per process; safe to run concurrently
 * from many instances, which is what a cold start on serverless will do.
 */
const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS cm_kv (
  k          text PRIMARY KEY,
  v          jsonb NOT NULL,
  expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS cm_kv_expires_idx ON cm_kv (expires_at);

CREATE TABLE IF NOT EXISTS cm_counter (
  k          text PRIMARY KEY,
  n          bigint NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS cm_counter_expires_idx ON cm_counter (expires_at);

CREATE TABLE IF NOT EXISTS cm_list (
  id         bigserial PRIMARY KEY,
  k          text NOT NULL,
  v          jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS cm_list_key_idx ON cm_list (k, id DESC);
CREATE INDEX IF NOT EXISTS cm_list_expires_idx ON cm_list (expires_at);
`;

/** The message an operator needs when postgres is asked for and unavailable. */
function pgUnavailable(detail) {
  return new StoreUnconfiguredError(
    "The postgres store is selected but no driver is installed. " +
      "ChainMind does not bundle one — run `npm install pg` in the deployment, or use " +
      "the REST key-value store instead (UPSTASH_REDIS_REST_URL + " +
      "UPSTASH_REDIS_REST_TOKEN), which needs nothing installed. " +
      `(import("pg") failed: ${detail})`,
  );
}

/**
 * Durable adapter over a plain postgres connection string.
 *
 * The driver is imported at runtime rather than declared as a dependency (see the
 * module header). Any failure to obtain it throws StoreUnconfiguredError — there
 * is no path from here back to the memory store.
 */
export async function createPostgresStore(connectionString) {
  if (!connectionString) {
    throw new StoreUnconfiguredError(
      "The postgres store is selected but no connection string is set. " +
        "Set STORE_DATABASE_URL (or DATABASE_URL) to a postgres:// URL.",
    );
  }

  let pg;
  try {
    pg = await import("pg");
  } catch (e) {
    throw pgUnavailable(String(e?.message ?? e));
  }
  // `pg` is CommonJS, so the named exports arrive under .default in ESM.
  const Pool = pg?.default?.Pool ?? pg?.Pool;
  if (typeof Pool !== "function") throw pgUnavailable("the module exports no Pool");

  // TLS settings ride in the connection string (?sslmode=require) so no hosting
  // provider's certificate policy is hard-coded here.
  const pool = new Pool({ connectionString, max: Number(env("STORE_PG_POOL_MAX")) || 4 });

  let ready = null;
  function migrated() {
    // One DDL round trip per process, memoised on the promise so concurrent
    // first calls share it rather than racing each other into the same CREATE.
    if (!ready) ready = pool.query(PG_SCHEMA).catch((e) => ((ready = null), Promise.reject(e)));
    return ready;
  }

  async function q(text, params) {
    await migrated();
    return pool.query(text, params);
  }

  /** Expiries are computed here, not in SQL, so the clock seam applies to both adapters. */
  function expiryFrom(ttlMs) {
    const n = Number(ttlMs);
    return Number.isFinite(n) && n > 0 ? new Date(clock() + n) : null;
  }
  function nowDate() {
    return new Date(clock());
  }

  // Expired rows are swept opportunistically rather than by a cron: 1-in-N writes
  // pays the delete, which keeps the tables bounded without needing a scheduler
  // that neither Vercel nor Railway is guaranteed to run.
  async function maybeSweep() {
    if (Math.random() > 0.02) return;
    const now = nowDate();
    try {
      await q("DELETE FROM cm_kv WHERE expires_at IS NOT NULL AND expires_at <= $1", [now]);
      await q("DELETE FROM cm_counter WHERE expires_at <= $1", [now]);
      await q("DELETE FROM cm_list WHERE expires_at IS NOT NULL AND expires_at <= $1", [now]);
    } catch {
      // A failed sweep is housekeeping debt, never a failed request.
    }
  }

  return {
    driver: "postgres",
    durable: true,
    shared: true,
    enforced: true,
    warnings: [],

    async get(key) {
      const r = await q(
        "SELECT v FROM cm_kv WHERE k = $1 AND (expires_at IS NULL OR expires_at > $2)",
        [key, nowDate()],
      );
      return r.rows.length ? r.rows[0].v : null;
    },

    async set(key, value, opts = {}) {
      await q(
        `INSERT INTO cm_kv (k, v, expires_at) VALUES ($1, $2, $3)
         ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, expires_at = EXCLUDED.expires_at`,
        [key, JSON.stringify(value), expiryFrom(opts.ttlMs)],
      );
      await maybeSweep();
    },

    async take(key) {
      // DELETE ... RETURNING is the whole reason single-use nonces are safe here:
      // two concurrent verifies of the same nonce, on different instances, cannot
      // both come back with a row.
      const r = await q("DELETE FROM cm_kv WHERE k = $1 RETURNING v, expires_at", [key]);
      if (!r.rows.length) return null;
      const row = r.rows[0];
      if (row.expires_at && new Date(row.expires_at).getTime() <= clock()) return null;
      return row.v;
    },

    async delete(key) {
      const r = await q("DELETE FROM cm_kv WHERE k = $1", [key]);
      const c = await q("DELETE FROM cm_counter WHERE k = $1", [key]);
      const l = await q("DELETE FROM cm_list WHERE k = $1", [key]);
      return (r.rowCount ?? 0) + (c.rowCount ?? 0) + (l.rowCount ?? 0) > 0;
    },

    async counter(key) {
      const r = await q("SELECT n, expires_at FROM cm_counter WHERE k = $1 AND expires_at > $2", [
        key,
        nowDate(),
      ]);
      if (!r.rows.length) return null;
      return { value: Number(r.rows[0].n), expiresAt: new Date(r.rows[0].expires_at).getTime() };
    },

    async increment(key, opts = {}) {
      const amount = Number.isFinite(Number(opts.amount)) ? Number(opts.amount) : 1;
      const expiresAt = expiryFrom(opts.ttlMs) ?? new Date(clock() + 60_000);
      // One statement, so the read-modify-write cannot interleave with another
      // instance's. An expired row is reset in place rather than deleted first.
      const r = await q(
        `INSERT INTO cm_counter (k, n, expires_at) VALUES ($1, $2, $3)
         ON CONFLICT (k) DO UPDATE SET
           n = CASE WHEN cm_counter.expires_at <= $4 THEN EXCLUDED.n ELSE cm_counter.n + EXCLUDED.n END,
           expires_at = CASE WHEN cm_counter.expires_at <= $4 THEN EXCLUDED.expires_at ELSE cm_counter.expires_at END
         RETURNING n, expires_at`,
        [key, amount, expiresAt, nowDate()],
      );
      const row = r.rows[0];
      await maybeSweep();
      return { value: Number(row.n), expiresAt: new Date(row.expires_at).getTime() };
    },

    async append(key, item, opts = {}) {
      const max = Math.min(Number(opts.max) || MEMORY_MAX_LIST_ITEMS, MEMORY_MAX_LIST_ITEMS);
      await q("INSERT INTO cm_list (k, v, expires_at) VALUES ($1, $2, $3)", [
        key,
        JSON.stringify(item),
        expiryFrom(opts.ttlMs),
      ]);
      // Trim to the cap immediately; an unbounded history table is a storage bill
      // and, because it is user content, a privacy liability.
      await q(
        `DELETE FROM cm_list WHERE k = $1 AND id NOT IN (
           SELECT id FROM cm_list WHERE k = $1 ORDER BY id DESC LIMIT $2
         )`,
        [key, max],
      );
      const r = await q("SELECT count(*)::int AS c FROM cm_list WHERE k = $1", [key]);
      await maybeSweep();
      return r.rows[0].c;
    },

    async list(key, opts = {}) {
      const limit = Number(opts.limit) > 0 ? Number(opts.limit) : MEMORY_MAX_LIST_ITEMS;
      const r = await q(
        `SELECT v FROM cm_list
         WHERE k = $1 AND (expires_at IS NULL OR expires_at > $2)
         ORDER BY id DESC LIMIT $3`,
        [key, nowDate(), limit],
      );
      return r.rows.map((row) => row.v);
    },

    async removeFromList(key, itemId) {
      const id = String(itemId ?? "");
      if (!id) return 0;
      // BOTH the key and the id are in the WHERE clause. The key is derived from
      // the session server-side and the id comes from the request, so an id that
      // belongs to another key matches no row — the scoping is the query, not a
      // check somewhere above it that a refactor could drop.
      const r = await q("DELETE FROM cm_list WHERE k = $1 AND v->>'id' = $2", [key, id]);
      return r.rowCount ?? 0;
    },

    async close() {
      await pool.end();
    },
  };
}

/* ------------------------------- unconfigured ------------------------------ */

/**
 * The store you get in production when nobody configured one: it implements the
 * whole interface and rejects every call.
 *
 * This is the deliberate choice. Returning memory here would let a deploy look
 * healthy while the quota counted to five per lambda and sign-in worked one
 * request in three. A store that refuses is a bug report; a store that forgets is
 * a mystery.
 */
export function createUnconfiguredStore(reason) {
  const fail = async () => {
    throw new StoreUnconfiguredError(
      `No store is configured (${reason}). Set UPSTASH_REDIS_REST_URL and ` +
        "UPSTASH_REDIS_REST_TOKEN (no dependency to install), or STORE_DATABASE_URL to a " +
        "postgres:// URL with `pg` installed, or STORE_DRIVER=memory to accept a " +
        "per-process, non-durable store and an unenforced quota.",
    );
  };
  return {
    driver: "unconfigured",
    durable: false,
    shared: false,
    enforced: false,
    warnings: [
      `No store is configured (${reason}). Anything that needs to be remembered will fail.`,
      ...unenforcedWarnings(),
    ],
    get: fail,
    set: fail,
    take: fail,
    delete: fail,
    counter: fail,
    increment: fail,
    append: fail,
    list: fail,
    removeFromList: fail,
    async close() {},
  };
}

/* --------------------------------- deadline -------------------------------- */

/** Every method of the adapter contract that goes over a wire. */
const STORE_METHODS = Object.freeze([
  "get",
  "set",
  "take",
  "delete",
  "counter",
  "increment",
  "append",
  "list",
  "removeFromList",
]);

/**
 * The same adapter, with a deadline on every call.
 *
 * WHY IT IS HERE AND NOT AT THE CALL SITES. The gate awaits a store round trip
 * before /api/ask opens its budget, so a hung store does not slow one call down —
 * it eats the answer's time and produces the platform 504 this codebase spent a
 * round removing. A deadline that lives at one call site is a deadline the next
 * call site will not have; wrapping the adapter means a store call without one is
 * not reachable from getStore().
 *
 * The in-flight work is ABANDONED rather than cancelled (see StoreTimeoutError),
 * and non-contract properties — `driver`, `warnings`, a test's `_size` — are
 * carried through untouched.
 *
 * @param {object} store
 * @param {number|(() => number)} [ms] deadline in ms; 0 or negative disables it
 * @returns {object}
 */
export function withStoreDeadline(store, ms = storeTimeoutMs) {
  if (!store) return store;
  const budget = () => Number(typeof ms === "function" ? ms() : ms);
  const wrapped = { ...store };
  for (const name of STORE_METHODS) {
    const fn = store[name];
    if (typeof fn !== "function") continue;
    wrapped[name] = (...args) => {
      const limit = budget();
      const call = () => Promise.resolve(fn.apply(store, args));
      if (!Number.isFinite(limit) || limit <= 0) return call();
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          settled = true;
          reject(new StoreTimeoutError(`store.${name} did not answer within ${limit}ms.`));
        }, limit);
        // Deliberately NOT unref'd. An unref'd timer lets the event loop drain
        // while a store call is still outstanding, which turns "this call is
        // late" into "this process exited without settling the promise" — the
        // caller never learns anything. The timer is cleared the moment the call
        // answers, so the longest it can hold anything open is `limit`.
        call().then(
          (value) => {
            if (settled) return;
            clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            if (settled) return;
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    };
  }
  return wrapped;
}

/* --------------------------------- factory -------------------------------- */

/** Memoised store promise. One pool per process, not one per request. */
let storePromise = null;
let announced = false;

/**
 * What getStore() would build, for health output — no connection is opened.
 *
 * `enforced` is the field an operator actually needs: it answers "is the daily
 * quota a real limit right now, or is it counting to five inside each of ten
 * lambdas". Only a shared, durable store can say yes.
 */
export function storeStatus() {
  const { driver, reason } = resolveStoreDriver();
  const shared = driver === "postgres" || driver === "redis";
  return {
    driver,
    reason,
    durable: shared,
    shared,
    enforced: shared,
    timeoutMs: storeTimeoutMs(),
    warnings: shared
      ? []
      : driver === "memory"
        ? [...memoryWarnings(), ...unenforcedWarnings()]
        : [reason, ...unenforcedWarnings()],
  };
}

/** What has to be said out loud whenever nothing durable is behind the counters. */
function unenforcedWarnings() {
  return [
    "The daily question quota is NOT ENFORCED: there is no shared counter, so every instance counts on its own.",
    "Configure UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (or STORE_DATABASE_URL with `pg` installed) to make it real.",
  ];
}

/**
 * Say out loud what we are about to run on.
 *
 * Once per process, and at console.warn rather than console.info in production,
 * because the whole point is that the memory adapter's damage is invisible in
 * normal operation. If this line is in a production log, someone has to see it.
 */
function announce(status) {
  if (announced) return;
  announced = true;
  if (status.driver === "memory") {
    const lines = [`[store] driver=memory (${status.reason})`, ...status.warnings];
    if (isProduction()) {
      console.warn(
        ["", "!".repeat(72), ...lines.map((l) => `! ${l}`), "!".repeat(72), ""].join("\n"),
      );
    } else {
      console.info(lines.join(" "));
    }
    return;
  }
  if (status.driver === "unconfigured") {
    // A banner, not a line. The failure being announced is one that leaves every
    // endpoint answering 200 while the quota counts per instance, so it has to be
    // impossible to skim past in a deploy log.
    console.error(
      [
        "",
        "!".repeat(72),
        `! [store] driver=unconfigured — ${status.reason}`,
        // The reason is already the line above; repeating it only pads a banner
        // whose whole job is to be read.
        ...status.warnings.filter((w) => w !== status.reason).map((w) => `! ${w}`),
        "! Stateful features (sign-in nonces, quota, saved history) will FAIL until one is set.",
        "!".repeat(72),
        "",
      ].join("\n"),
    );
    return;
  }
  console.info(`[store] driver=${status.driver} (${status.reason}) quota-enforced=${status.enforced}`);
}

/**
 * Say it at startup, before any request has been served.
 *
 * instrumentation.js calls this so the banner lands in the deploy log rather than
 * waiting for whichever request happens to touch the store first — which, on a
 * deploy nobody has hit yet, is never. Safe to call repeatedly: `announced` makes
 * it a no-op after the first.
 */
export function announceStore() {
  announce(storeStatus());
}

/**
 * The store for this process. Built once; every caller shares it.
 *
 * Rejections are not memoised: a postgres pool that failed to build on a cold
 * start should be retried on the next request, not turned into a permanently
 * broken process.
 *
 * @returns {Promise<object>} an adapter implementing the interface above
 */
export function getStore() {
  if (storePromise) return storePromise;
  const status = storeStatus();
  announce(status);
  storePromise = (async () => {
    // Wrapped on the way out, every driver, no exceptions: a store call that can
    // outlive its caller's budget is the failure this deadline exists to stop,
    // and an adapter that skipped the wrapper would be exactly that call.
    if (status.driver === "redis") return withStoreDeadline(createRedisStore(storeRestConfig()));
    if (status.driver === "postgres") {
      return withStoreDeadline(await createPostgresStore(storeConnectionString()));
    }
    if (status.driver === "memory") return withStoreDeadline(createMemoryStore());
    return createUnconfiguredStore(status.reason);
  })().catch((e) => {
    storePromise = null;
    throw e;
  });
  return storePromise;
}

/** Drop the memoised store (tests, and env changes that should take effect). */
export async function resetStore() {
  const p = storePromise;
  storePromise = null;
  announced = false;
  if (!p) return;
  try {
    const s = await p;
    await s.close?.();
  } catch {
    // Nothing to close if it never built.
  }
}
