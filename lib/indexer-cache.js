/**
 * TTL cache + single-flight gate in front of every indexer read.
 *
 * WHY. The Robinhood Chain Blockscout instance is rate limited, not slow-but-
 * infinite: measured against it, five calls spaced 3s apart all land in 1.5-3.7s,
 * one question's five-endpoint fan-out lands 5/5, and a tight loop of ~30 requests
 * loses roughly half to timeouts. Bursts ACROSS questions are what break it, and
 * the same token asked twice pays the full round trip twice for a byte-identical
 * answer. Both of those are removed here — repeats by the cache, concurrent
 * duplicates by the single-flight map — without any call site changing.
 *
 * SCOPE. In-memory and PER-INSTANCE. On serverless every lambda gets its own Map,
 * so this is a warm-instance win for repeat questions and a burst absorber inside
 * one process — never a distributed cache, never a source of truth across
 * instances, regions or deploys. Two lambdas asking for NVDA still cost two calls.
 *
 * WHAT IS NEVER STORED. Failures, timeouts, aborts and non-JSON-object bodies.
 * A cached outage is the worst possible outcome here: it turns a two-second blip
 * into a full minute of confidently serving the wrong story, and this codebase's
 * whole contract is that an outage reads as "could not look", not as an answer.
 * Only a call that resolved with a complete body is storable.
 */

/** Default TTL. Short enough that a holder count is never minutes stale. */
const DEFAULT_TTL_MS = 60_000;

/**
 * Default TTL for a read that carries a PRICE.
 *
 * Not everything ages at the same rate. A holder list, a verification flag, a
 * creator address and a transfer history are all fine for a minute — they change
 * on the timescale of blocks and nobody is comparing them against another screen.
 * An exchange rate is not: a minute-old quote read beside a live one looks simply
 * wrong, and the reader has no way to tell which of the two is stale.
 *
 * Ten seconds, not zero. The cache is the reason the self-inflicted rate limiting
 * stopped — measured, a tight burst of ~30 requests lost roughly half of them, and
 * that was breaking the holder table — so the price reads get a SHORTER window,
 * never no window. It also does not make the figure fresher than the indexer's own
 * refresh, which is the real floor and is not ours to control; it only stops us
 * adding a minute of our own on top.
 */
const DEFAULT_PRICE_TTL_MS = 10_000;

/**
 * Hard entry bound. The process is long-lived (a Node server, a warm lambda) and
 * the key space is unbounded — every address anyone ever pastes is a new URL — so
 * without a cap this Map is a slow leak.
 */
export const MAX_ENTRIES = 500;

/**
 * Where this module reads the time. A seam, not a nicety.
 *
 * Expiry tests otherwise have to race real setTimeout sleeps against a real
 * TTL, and asserting an exact upstream call count against wall-clock timing is
 * a flake waiting for a loaded CI box: one test slept 3x15ms against a 40ms TTL
 * and expected exactly two fetches, which becomes three the moment the process
 * is descheduled. Widening the tolerance only makes it rarer. Controlling the
 * clock makes the assertion exact and the test instant.
 *
 * Production never touches this — the default IS Date.now.
 */
let clock = () => Date.now();

/**
 * Swap the clock for a test, and get a restore function back.
 * @param {() => number} fn
 * @returns {() => void} restores the real clock
 */
export function setIndexerClock(fn) {
  const previous = clock;
  clock = typeof fn === "function" ? fn : previous;
  return () => {
    clock = previous;
  };
}

/** url -> { value, expiresAt }. Insertion order doubles as the LRU queue. */
const entries = new Map();

/** url -> in-flight promise. Lives only between request and settle. */
const inFlight = new Map();

/** Counters for the measurement harness; not load-bearing for behaviour. */
let counts = { hits: 0, misses: 0, stores: 0, joins: 0, upstream: 0, evictions: 0 };

/**
 * TTL in milliseconds, read per call so a deploy-time env change takes effect
 * without a rebuild and so tests can flip it.
 *
 * INDEXER_CACHE_TTL_MS overrides the 60s default. **0 disables storage entirely**
 * — every read goes upstream — which is what you want when debugging whether a
 * stale body is behind a wrong answer. Single-flight stays on at 0: collapsing
 * two identical concurrent calls into one is never a staleness risk, because
 * neither caller could have observed a newer answer than the one they share.
 * A negative or unparseable value falls back to the default rather than
 * disabling — a typo in config must not silently remove the protection.
 *
 * @returns {number}
 */
export function cacheTtlMs() {
  const raw = process.env.INDEXER_CACHE_TTL_MS;
  if (raw == null || String(raw).trim() === "") return DEFAULT_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_MS;
}

/**
 * TTL for a price-bearing read, read per call for the same reasons as above.
 *
 * INDEXER_PRICE_CACHE_TTL_MS overrides the 10s default; 0 sends every price read
 * upstream. Junk or negative falls back to the default rather than to the long
 * TTL — a typo in config must not quietly make quotes a minute old.
 *
 * @returns {number}
 */
export function priceCacheTtlMs() {
  const raw = process.env.INDEXER_PRICE_CACHE_TTL_MS;
  if (raw == null || String(raw).trim() === "") return DEFAULT_PRICE_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PRICE_TTL_MS;
}

/**
 * The TTL this call actually gets: the shorter of the global setting and any
 * per-call override.
 *
 * The MINIMUM, deliberately, and it is what makes the override safe to sprinkle
 * on call sites. An operator who sets INDEXER_CACHE_TTL_MS=0 to debug a stale body
 * has disabled the cache, and a per-call 10s that quietly re-enabled it for the
 * one endpoint they were debugging would be the worst possible surprise. Likewise
 * an operator who tightens the global to 5s means five seconds everywhere, not
 * "except prices". An absent, non-numeric or negative override means no opinion,
 * so the global stands and every existing caller is unchanged.
 *
 * A real NUMBER is required, not something Number() will coerce. `Number(null)`
 * and `Number("")` are both 0, and 0 here means "never cache this URL" — so a call
 * site that passed a missing config value would silently disable the cache for its
 * endpoint and reintroduce the bursts this module exists to absorb. Anything that
 * is not a finite non-negative number falls back to the global.
 *
 * @param {{ ttlMs?: unknown } | undefined} options
 * @returns {number}
 */
function effectiveTtl(options) {
  const base = cacheTtlMs();
  if (!options || typeof options !== "object") return base;
  const n = options.ttlMs;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return base;
  return Math.min(base, n);
}

/**
 * Is this response complete enough to keep?
 *
 * Blockscout answers every getter with a JSON object or array. A null, a bare
 * string or a number means we got something other than the body we asked for —
 * a proxy error page parsed as JSON, a truncated read — and a partial body cached
 * for a minute is indistinguishable to callers from a real one.
 */
function storable(value) {
  return value != null && typeof value === "object";
}

/**
 * Hand every caller its own copy.
 *
 * A cached body is shared by definition: without this, one caller's `items.sort()`
 * silently rewrites what the next question reads. Today's readers only ever read,
 * so this buys nothing observable — it buys that the next reader can't quietly
 * poison the cache. Cost is microseconds against a 1-4s round trip. A body that
 * can't be cloned (shouldn't happen for parsed JSON) is passed through rather
 * than turned into a failure.
 */
function copy(value) {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

/** Drop expired entries, then the oldest, until one more will fit. */
function evictFor(now) {
  if (entries.size < MAX_ENTRIES) return;
  for (const [k, e] of entries) if (e.expiresAt <= now) entries.delete(k);
  // Insertion order is recency order (a hit re-inserts), so the front is the
  // least recently used.
  for (const k of entries.keys()) {
    if (entries.size < MAX_ENTRIES) break;
    entries.delete(k);
    counts.evictions += 1;
  }
}

function store(key, value, ttl, now) {
  evictFor(now);
  // `storedAt` is the real age of the body, kept alongside the deadline so a
  // caller on a SHORTER TTL than whoever stored it can reject an entry that is
  // still inside the storer's window but already too old for its own.
  entries.set(key, { value, storedAt: now, expiresAt: now + ttl });
  counts.stores += 1;
}

/**
 * The fresh entry for `key`, or null. A hit re-inserts to refresh RECENCY but
 * never `expiresAt`: extending the deadline on every read would let a hot URL
 * serve the same minute-old body forever.
 *
 * `ttl` is this caller's own ceiling. Entries are keyed by URL alone, so if one
 * call site ever asks for a URL on the 60s default and another on the 10s price
 * budget, the second must not be handed a 40-second-old quote just because the
 * first put a minute on it. Age is measured, not assumed.
 */
function read(key, now, ttl) {
  const hit = entries.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= now || now - hit.storedAt >= ttl) {
    entries.delete(key);
    return null;
  }
  entries.delete(key);
  entries.set(key, hit);
  return hit;
}

/**
 * Run `fetcher` for `url` through the cache and the single-flight gate.
 *
 * Three outcomes: a fresh cached body (no upstream call), a join onto an
 * identical call already running (no upstream call), or the one call that
 * actually goes out. Rejections propagate untouched to every caller — nothing is
 * swallowed here, because the layers above decide what a failure means.
 *
 * DEADLINE CAVEAT, since it is invisible from the call site: a joiner inherits
 * the LEADER's abort signal, so a caller on the 8s essential budget that joins a
 * call started on the 6s enrichment budget gets cut off at 6s. It fails as
 * "could not look", which is honest, and the alternative — a second identical
 * request for the sake of 2s more patience — is exactly the burst this exists to
 * prevent.
 *
 * @param {string} url - the full request URL; the cache key
 * @param {() => Promise<any>} fetcher - performs the upstream read
 * @param {{ ttlMs?: number }} [options] - per-call TTL CEILING for reads that age
 *   faster than the default, e.g. anything carrying an exchange rate. Omitted, it
 *   is exactly the old behaviour. See effectiveTtl for why it can only shorten.
 * @returns {Promise<any>}
 */
export function withIndexerCache(url, fetcher, options) {
  const key = String(url);
  const ttl = effectiveTtl(options);
  const now = clock();

  const hit = ttl > 0 ? read(key, now, ttl) : null;
  if (hit) {
    counts.hits += 1;
    return Promise.resolve(copy(hit.value));
  }
  counts.misses += 1;

  const running = inFlight.get(key);
  if (running) {
    counts.joins += 1;
    return running.then(copy);
  }

  const call = (async () => {
    counts.upstream += 1;
    const value = await fetcher();
    // Re-read the clock and the TTL: the call took seconds, and an entry must
    // live for its TTL from when it was ANSWERED, not from when it was asked.
    const settledTtl = effectiveTtl(options);
    if (settledTtl > 0 && storable(value)) store(key, value, settledTtl, clock());
    return value;
  })();

  inFlight.set(key, call);
  // Clear on BOTH outcomes. Leaving a rejected promise in the map would pin every
  // later caller to one dead call — a cached failure by another name. The handler
  // also marks `call` as handled, so a rejection nobody joined can't surface as an
  // unhandled rejection and take the process down.
  const done = () => {
    if (inFlight.get(key) === call) inFlight.delete(key);
  };
  call.then(done, done);

  return call.then(copy);
}

/**
 * Cache counters and sizes, for the measurement harness and tests.
 * `upstream` is the number of calls that actually reached the indexer.
 */
export function indexerCacheStats() {
  return {
    ...counts,
    size: entries.size,
    inFlight: inFlight.size,
    ttlMs: cacheTtlMs(),
    priceTtlMs: priceCacheTtlMs(),
  };
}

/**
 * Drop every entry and every counter. In-flight calls are NOT cancelled — they
 * finish and (harmlessly) store into the cleared map. For tests and for a manual
 * "read it fresh" escape hatch.
 */
export function resetIndexerCache() {
  entries.clear();
  inFlight.clear();
  counts = { hits: 0, misses: 0, stores: 0, joins: 0, upstream: 0, evictions: 0 };
}
