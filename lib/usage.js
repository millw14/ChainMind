/**
 * Usage tracking for the operator admin page: what people searched, how many
 * questions were asked, and how many distinct people showed up.
 *
 * IT LIVES ON THE SAME STORE AS THE QUOTA. No new dependency, no second service:
 * counters via increment(), the recent-search feed via append()/list(), and
 * unique-visitor de-duplication via a per-id marker key. When the store is not
 * durable (memory in dev, or unconfigured in prod) these numbers are best-effort
 * and readUsage() says so — an admin page that silently shows per-lambda counts
 * is worse than one that admits it has nowhere to count.
 *
 * IT MUST NEVER BREAK A REQUEST. Every writer swallows its own errors: tracking
 * is a nice-to-have bolted onto the side of /api/ask, and a store hiccup there is
 * a missing data point, never a failed answer. Writers are meant to be called
 * from Next's `after()` so they cost the response nothing.
 *
 * PRIVACY. A raw IP is never stored. Visitors are keyed by wallet address when
 * signed in, otherwise by a salted hash of the IP, and the feed shows only a
 * short label (`0x1234…abcd` or `ip#a1b2c3d4`), never the address in full or the
 * IP at all.
 */
import { createHash } from "node:crypto";
import { getStore } from "./store.js";

/** Key namespace, kept short — see the quota module on why cookie/key bytes matter. */
const K = {
  qTotal: "u:q:total",
  qDay: (d) => `u:q:d:${d}`,
  vTotal: "u:v:total",
  vDay: (d) => `u:v:d:${d}`,
  seenAll: (id) => `u:seen:all:${id}`,
  seenDay: (d, id) => `u:seen:d:${d}:${id}`,
  feed: "u:searches",
};

/** Daily counters outlive any window the admin page draws, but not forever. */
const COUNTER_TTL_MS = 190 * 24 * 60 * 60 * 1000;
/** A per-day "already counted this visitor" marker only has to survive the day. */
const SEEN_DAY_TTL_MS = 2 * 24 * 60 * 60 * 1000;
/** How many recent searches to keep and, at most, hand back. */
const FEED_MAX = 200;

/** `2026-07-30` in UTC — the same day boundary the quota uses. */
export function utcDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function salt() {
  const s = process.env.SESSION_SECRET;
  return s ? String(s) : "chainmind-usage";
}

function ipHash(ip) {
  return createHash("sha256").update(`${salt()}:${String(ip ?? "")}`).digest("hex");
}

/** Stable, non-reversible id used as a map key for one visitor. */
function idFor({ address, ip }) {
  const a = String(address ?? "").toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(a)) return `w:${a}`;
  return `i:${ipHash(ip)}`;
}

/** The short, safe-to-display label for that same visitor. */
function labelFor({ address, ip }) {
  const a = String(address ?? "").toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(a)) return `${a.slice(0, 6)}…${a.slice(-4)}`;
  return `ip#${ipHash(ip).slice(0, 8)}`;
}

function clip(s, max) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Count a visitor exactly once for all-time and once for the UTC day.
 *
 * A read-then-write, so two requests from a brand-new visitor in the same instant
 * can both count them — an acceptable, rare over-count for analytics, and never an
 * over-count of anything that gates access.
 */
async function markVisit(store, id, day) {
  const allKey = K.seenAll(id);
  if (!(await store.get(allKey))) {
    await store.set(allKey, 1);
    await store.increment(K.vTotal);
  }
  const dayKey = K.seenDay(day, id);
  if (!(await store.get(dayKey))) {
    await store.set(dayKey, 1, { ttlMs: SEEN_DAY_TTL_MS });
    await store.increment(K.vDay(day), { ttlMs: COUNTER_TTL_MS });
  }
}

/**
 * Record one accepted question: a counter, the recent-search feed, and a visit.
 * Call from `after()` — it awaits nothing the response is waiting on.
 */
export async function recordSearch({ question, target, ip, address } = {}) {
  try {
    const store = await getStore();
    const day = utcDay();
    await Promise.allSettled([
      store.increment(K.qTotal),
      store.increment(K.qDay(day), { ttlMs: COUNTER_TTL_MS }),
      store.append(
        K.feed,
        { q: clip(question, 200), target: clip(target, 80), who: labelFor({ address, ip }), at: Date.now() },
        { max: FEED_MAX },
      ),
      markVisit(store, idFor({ address, ip }), day),
    ]);
  } catch {
    // Tracking is bolted on the side; a store hiccup here is a lost data point,
    // never a failed answer.
  }
}

/** Record a bare page visit (no question). Used by the visit beacon. */
export async function recordVisit({ ip, address } = {}) {
  try {
    const store = await getStore();
    await markVisit(store, idFor({ address, ip }), utcDay());
  } catch {
    // See recordSearch.
  }
}

/**
 * Everything the admin page shows, in one read.
 *
 * @param {{ days?: number, feed?: number }} [opts]
 * @returns usage snapshot; `configured:false` when the store cannot persist it.
 */
export async function readUsage({ days = 14, feed = 100 } = {}) {
  let store;
  try {
    store = await getStore();
  } catch (e) {
    return { configured: false, error: String(e?.message ?? e), warnings: [] };
  }

  const durable = store.durable === true && store.shared === true;
  const now = Date.now();
  const dayKeys = Array.from({ length: days }, (_, i) => utcDay(now - i * 86_400_000));

  const num = (r) => (r && typeof r.value === "number" ? r.value : 0);
  const safe = async (p) => {
    try {
      return await p;
    } catch {
      return null;
    }
  };

  const [qTotal, vTotal, feedRows, ...series] = await Promise.all([
    safe(store.counter(K.qTotal)),
    safe(store.counter(K.vTotal)),
    safe(store.list(K.feed, { limit: feed })),
    ...dayKeys.flatMap((d) => [safe(store.counter(K.qDay(d))), safe(store.counter(K.vDay(d)))]),
  ]);

  const byDay = dayKeys.map((day, i) => ({
    day,
    questions: num(series[i * 2]),
    visitors: num(series[i * 2 + 1]),
  }));

  return {
    configured: durable,
    driver: store.driver,
    warnings: durable ? [] : store.warnings ?? [],
    questions: { total: num(qTotal), today: byDay[0]?.questions ?? 0 },
    visitors: { total: num(vTotal), today: byDay[0]?.visitors ?? 0 },
    days: byDay,
    recent: Array.isArray(feedRows) ? feedRows : [],
  };
}
