/**
 * Abuse guards for public API routes: origin checks, caller identity and a
 * coarse rate limiter.
 *
 * The limiter is IN-MEMORY and PER-INSTANCE. On serverless (Vercel) every cold
 * start and every concurrent lambda gets its own Map, so the effective limit is
 * `limit x instances`. Treat it as a floor that stops trivial hammering — not as
 * a distributed guarantee. Move to Redis/Upstash if a hard global cap matters.
 */

/** Lowercased host of a URL-ish string, or null when it isn't parseable. */
function hostOf(urlish) {
  const s = String(urlish ?? "").trim();
  if (!s) return null;
  try {
    return new URL(s).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when the request plausibly came from our own pages rather than a
 * third-party site spending our upstream budget with its visitors' browsers.
 *
 * @param {Request} request
 * @returns {boolean}
 */
export function isSameOriginRequest(request) {
  const h = request?.headers;
  if (!h || typeof h.get !== "function") return false;

  // Browsers attach Sec-Fetch-Site to every fetch: "same-origin" from our own
  // UI, "none" for a user-typed URL. A cross-site page can never forge it.
  const site = h.get("sec-fetch-site");
  if (site === "same-origin" || site === "none") return true;

  // Fallback for clients that omit Sec-Fetch-Site: compare the Origin host with
  // the host we were reached on (proxy header first) or the configured app URL.
  const originHost = hostOf(h.get("origin"));
  if (!originHost) return false;
  const requestHost = String(h.get("x-forwarded-host") || h.get("host") || "").toLowerCase();
  if (requestHost && originHost === requestHost) return true;
  const appHost = hostOf(process.env.NEXT_PUBLIC_APP_URL);
  return Boolean(appHost) && originHost === appHost;
}

/**
 * Best-effort caller identity for rate limiting: the first X-Forwarded-For hop
 * (the client as seen by the edge proxy). Spoofable without a trusted proxy,
 * which is why it only ever gates a soft limit.
 *
 * @param {Request} request
 * @returns {string}
 */
export function clientIp(request) {
  const raw = request?.headers?.get?.("x-forwarded-for") ?? "";
  const first = String(raw).split(",")[0]?.trim();
  return first || "unknown";
}

/** key -> { count, resetAt }. Never persisted; see the module comment. */
const buckets = new Map();
const PRUNE_AT = 512;

/**
 * Fixed-window limiter. The window starts on the first request for a key and
 * resets wholesale, so a caller can burst up to `limit` twice across a window
 * boundary — acceptable for a spend guard.
 *
 * @param {string} key - caller identity (e.g. client IP)
 * @param {number} limit - allowed requests per window
 * @param {number} windowMs - window length in milliseconds
 * @returns {{ allowed: boolean, remaining: number }}
 */
export function rateLimit(key, limit, windowMs) {
  const now = Date.now();

  // Opportunistic sweep: without it the map grows once per unique IP forever.
  if (buckets.size > PRUNE_AT) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: Math.max(0, limit - 1) };
  }

  bucket.count += 1;
  return { allowed: bucket.count <= limit, remaining: Math.max(0, limit - bucket.count) };
}
