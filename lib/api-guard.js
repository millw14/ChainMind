/**
 * Abuse guards for public API routes: origin checks, caller identity and a
 * coarse rate limiter.
 *
 * The limiter is IN-MEMORY and PER-INSTANCE. On serverless (Vercel) every cold
 * start and every concurrent lambda gets its own Map, so the effective limit is
 * `limit x instances`. Treat it as a floor that stops trivial hammering — not as
 * a distributed guarantee. The daily quota does have a shared counter behind it
 * (lib/store.js); this one deliberately does not, because a per-minute burst
 * guard is not worth a store round trip on every request.
 *
 * THE IDENTITY EVERYTHING HERE IS KEYED ON IS THE OTHER HALF OF THE JOB. A limit
 * keyed on a value the caller writes is not a limit, so clientIdentity below
 * takes the forwarded hop OUR proxy appended rather than the leftmost one the
 * caller supplied. What that buys and what it does not is spelled out there.
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

/* ------------------------------ caller identity ----------------------------- */

/**
 * The bucket every caller we cannot identify shares.
 *
 * One shared bucket, deliberately. The alternative — inventing a fresh identity
 * per unidentifiable request — is what turns a daily limit into no limit at all,
 * because "I have no identity" is the one claim a caller can always make.
 */
export const UNKNOWN_CALLER = "unknown";

/**
 * How many proxies sit between this process and the public internet.
 *
 * ONE is the safe default and the common truth: Vercel, Railway, Fly, Render,
 * nginx and Cloudflare all put exactly one hop in front of the app. Set it higher
 * only when you actually run more (Cloudflare in front of your own nginx is two).
 * Zero means "there is no proxy I trust" — X-Forwarded-For is then ignored
 * entirely and everyone shares UNKNOWN_CALLER, which is the honest reading of a
 * header nobody vouched for.
 */
const DEFAULT_TRUSTED_PROXY_HOPS = 1;

/** @returns {number} trusted hops, floored at 0. */
export function trustedProxyHops() {
  const raw = process.env.TRUSTED_PROXY_HOPS;
  if (raw == null || String(raw).trim() === "") return DEFAULT_TRUSTED_PROXY_HOPS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TRUSTED_PROXY_HOPS;
  return Math.floor(n);
}

/**
 * A header the platform SETS (rather than appends to), and therefore one a
 * caller cannot forge — when there is one.
 *
 * Vercel writes x-vercel-forwarded-for at its edge and overwrites whatever
 * arrived, so on Vercel it is strictly better than counting hops. Cloudflare's
 * cf-connecting-ip and Fly's fly-client-ip behave the same way; name them with
 * TRUSTED_IP_HEADER. The value is only as good as the claim that the named header
 * really is set by your infrastructure — get that wrong and you have re-opened
 * the hole, which is why it is explicit configuration and not sniffing.
 *
 * @returns {string|null}
 */
export function trustedIpHeader() {
  const explicit = process.env.TRUSTED_IP_HEADER?.trim().toLowerCase();
  if (explicit) return explicit;
  // VERCEL is injected by the platform itself; it cannot be set by a request.
  if (String(process.env.VERCEL ?? "").trim()) return "x-vercel-forwarded-for";
  return null;
}

/** The last comma-separated entry of a header value — the one nearest to us. */
function lastEntry(value) {
  const parts = String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

/**
 * Who is calling, and whether that answer came from somewhere trustworthy.
 *
 * THE BUG THIS REPLACES. X-Forwarded-For is a LIST that each proxy APPENDS to,
 * so its leftmost entry is whatever the original caller wrote — a value we hand
 * out a fresh daily allowance to on request. `curl -H "X-Forwarded-For: $RANDOM"`
 * was an unlimited free tier. The entry that means anything is the one OUR proxy
 * appended, counted from the RIGHT: with one trusted hop that is the last entry,
 * which is the address our edge saw the connection come from. Everything the
 * caller wrote sits to the left of it and is ignored.
 *
 * WHAT THIS IS STILL NOT. Proof of identity. A VPN hop, a phone changing cells or
 * a residential proxy pool all produce a different, equally "trusted" address,
 * and a NAT puts a whole office behind one. It is a speed bump on the free tier,
 * not an anti-abuse control — see the header of lib/quota.js.
 *
 * @param {Request|{ headers: Headers }} request
 * @returns {{ ip: string, trusted: boolean, source: string }}
 */
export function clientIdentity(request) {
  const h = request?.headers;
  const read = (name) => (typeof h?.get === "function" ? String(h.get(name) ?? "").trim() : "");

  const platform = trustedIpHeader();
  if (platform) {
    const value = lastEntry(read(platform));
    if (value) return { ip: value, trusted: true, source: platform };
    // The configured header is missing. Falling back to X-Forwarded-For here
    // would hand the spoofer back exactly what this branch took away, so the
    // request joins the shared bucket instead.
    return { ip: UNKNOWN_CALLER, trusted: false, source: `${platform}:absent` };
  }

  const hops = trustedProxyHops();
  if (hops <= 0) return { ip: UNKNOWN_CALLER, trusted: false, source: "no-trusted-proxy" };

  const list = String(read("x-forwarded-for"))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const hop = list[list.length - hops];
  // Shorter than the configured hop count means the header did not come through
  // the proxy chain we were told about — a direct connection, or a header the
  // caller wrote from scratch. Neither is an identity.
  if (!hop) return { ip: UNKNOWN_CALLER, trusted: false, source: "x-forwarded-for:short" };
  return { ip: hop, trusted: true, source: "x-forwarded-for" };
}

/**
 * Caller identity as a bare string, for rate-limit and quota keys.
 *
 * @param {Request} request
 * @returns {string}
 */
export function clientIp(request) {
  return clientIdentity(request).ip;
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
