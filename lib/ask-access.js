/**
 * Who is asking, and may they — the whole gate decision in one call.
 *
 * It lives in lib/ rather than in the route because the route imports
 * "next/server" and the "@/" alias and so cannot be loaded by `node --test`, and
 * this is precisely the code that has to be tested: a gate nobody can exercise is
 * a gate nobody knows the shape of. The route keeps the two things that genuinely
 * need a Request — pulling the cookie and the forwarded IP off it, and turning the
 * verdict into a response.
 *
 * THE ORDER IS CHEAPEST FIRST, because this runs before every question on a path
 * that is already close to its time budget:
 *   1. the session cookie — an HMAC verify, no I/O at all;
 *   2. the entitlement — skipped entirely for anonymous callers, and served from a
 *      few-minute cache for everyone else, so the eth_call is paid once per wallet
 *      per cache window rather than once per question;
 *   3. the counter — one store round trip, and NOT EVEN THAT for a verified
 *      holder, who is unlimited and therefore has nothing to count.
 * A rejected request costs a cookie verify plus at most one cached lookup and one
 * increment. That is the point: the expensive work is what the gate protects.
 *
 * AND EVERY PART OF IT IS BOUNDED. This runs BEFORE app/api/ask opens its 24s
 * budget, so seconds spent here are not borrowed from the answer — they are spent
 * outside the clock entirely, out of the 6s PLATFORM_MARGIN_MS that also has to
 * cover cold start and writing the response. An unbounded store call here was
 * therefore not "a slow gate": it was the platform 504 the budget was built to
 * remove, arriving from the one place the budget could not see. See
 * gateWorstCaseMs below, and the test that holds it under the margin.
 */
import { checkEntitlement, entitlementRpcTimeoutMs } from "./entitlement.js";
import { consumeQuestion, peekQuota, quotaMessage } from "./quota.js";
import { readSessionCookie } from "./session.js";
import { getStore, storeTimeoutMs } from "./store.js";

/**
 * The longest the gate can take before the ask budget opens.
 *
 * One balance read plus one counter increment, both bounded, and nothing else
 * blocking: the session verify is CPU-only and the entitlement is skipped
 * entirely for anonymous callers. A caller who is WITHIN quota pays exactly the
 * same round trips as one who is not — the increment is one call either way — so
 * the gate cannot make a permitted question slower than it makes a refused one.
 *
 * @returns {number}
 */
export function gateWorstCaseMs() {
  return entitlementRpcTimeoutMs() + storeTimeoutMs();
}

/**
 * Resolve one caller's access.
 *
 * @param {{ sessionCookie?: string|null, ip?: string, store?: object|null,
 *           now?: number, consume?: boolean }} args
 *   `store` is a seam for tests; production passes nothing and gets the app's own.
 *   `consume` false peeks without spending a question (the /api/quota route).
 * @returns {Promise<{ address: string|null, entitlement: object|null, quota: object,
 *                     message: string }>} never throws
 */
export async function resolveAccess({
  sessionCookie = null,
  ip = "unknown",
  store = null,
  now = Date.now(),
  consume = true,
} = {}) {
  // The address comes from a cookie this server signed. Nothing else in the
  // request can name a wallet, which is why there is no address parameter here.
  const session = readSessionCookie(sessionCookie);
  const address = session.ok ? session.address : null;

  // No session, no balance to read. An anonymous question must not cost an
  // eth_call — that would make the free tier the expensive one.
  const entitlement = address ? await checkEntitlement({ address }) : null;

  let resolved = store;
  if (!resolved) {
    try {
      resolved = await getStore();
    } catch (e) {
      // Not fatal here: consumeQuestion falls back to the per-process limiter and
      // marks the report degraded rather than refusing the question outright.
      console.error(`[gate] no usable store — ${String(e?.message ?? e)}`);
      resolved = null;
    }
  }

  const args = { store: resolved, address, entitlement, ip, now };
  const quota = consume ? await consumeQuestion(args) : await peekQuota(args);

  return {
    address,
    entitlement,
    quota,
    message: quota.allowed ? "" : quotaMessage(quota, entitlement, now),
  };
}

/**
 * The entitlement, as the holder themselves may see it.
 *
 * Everything here is either public on chain (the token, the threshold) or the
 * caller's own balance, returned to the session that proved it owns that address.
 * The RPC failure reason is included on purpose: "we could not read the chain" is
 * the sentence that stops an outage reading as "you hold nothing".
 */
export function publicEntitlement(entitlement) {
  if (!entitlement) return null;
  return {
    state: entitlement.state,
    reason: entitlement.reason,
    token: entitlement.token,
    symbol: entitlement.symbol,
    balance: entitlement.balanceTokens,
    threshold: entitlement.thresholdTokens,
  };
}

/** The quota report, trimmed to what a client needs to render. */
export function publicQuota(quota) {
  if (!quota) return null;
  return {
    state: quota.state,
    // Why we could not verify, when that is the state. The panel needs it to tell
    // "the chain did not answer" from "this server has no gate configured".
    reason: quota.reason,
    unlimited: quota.unlimited,
    limit: quota.limit,
    used: quota.used,
    remaining: quota.remaining,
    resetsAt: quota.resetsAt,
    degraded: quota.degraded,
  };
}

/**
 * Response headers carrying the caller's standing.
 *
 * Headers rather than a body field because the ask route answers in two shapes —
 * JSON and an SSE stream — and headers are the one place a number can be attached
 * to both without inventing a frame type the older client bundles do not know.
 *
 * @param {object} quota
 * @returns {Record<string,string>}
 */
export function quotaHeaders(quota) {
  if (!quota) return {};
  const headers = { "x-quota-state": String(quota.state) };
  if (quota.unlimited) {
    headers["x-quota-limit"] = "unlimited";
    return headers;
  }
  headers["x-quota-limit"] = String(quota.limit);
  // Only when we actually know it. A header saying 0 because a counter could not
  // be read would be the client's version of an outage reading as absence.
  if (quota.remaining != null) headers["x-quota-remaining"] = String(quota.remaining);
  if (quota.resetsAt) headers["x-quota-reset"] = String(quota.resetsAt);
  if (quota.degraded) headers["x-quota-degraded"] = "1";
  return headers;
}

/**
 * The 429 body.
 *
 * `error` is the sentence the transcript shows, and it names the state the caller
 * is in and the one thing that would change it — see lib/quota.js quotaMessage.
 * The structured fields beside it are what the header widget re-renders from.
 */
export function quotaDenial({ quota, entitlement, message }) {
  return {
    ok: false,
    error: message,
    quota: publicQuota(quota),
    gate: publicEntitlement(entitlement),
  };
}
