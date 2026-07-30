import { rateLimit } from "./api-guard.js";
import { resolveAccess } from "./ask-access.js";
import { isEntitled } from "./entitlement.js";
import { msUntilUtcReset, utcDayKey, utcResetAt } from "./quota.js";

/**
 * WHO MAY START A DEEP INVESTIGATION, AND HOW MANY.
 *
 * WHY THIS IS A SECOND ALLOWANCE AND NOT A SECOND POLICY. lib/ask-access.js already
 * answers "who is asking and may they" — session cookie, entitlement, counter, in that
 * order and cheapest first — and this module CALLS it rather than re-deriving any of it.
 * What it adds is one number: a research job is not a question, and counting it as one
 * would price a seven-minute crawl of somebody else's website the same as a ticker
 * lookup. So the identity work is reused wholesale and only the ledger is new.
 *
 * WHY IT COSTS MORE THAN A QUESTION, stated in the units that actually get spent:
 *   - MINUTES of wall clock, against a question's seconds;
 *   - up to 320,000 model tokens, against a question's few thousand;
 *   - up to 12 MB fetched from THIRD PARTIES WHO DID NOT AGREE TO ANY OF THIS, against a
 *     question's zero. That last one is the reason the ceiling exists at all: the cost of
 *     a runaway here lands on somebody else's server.
 *
 * WHY IT REQUIRES SIGNING IN, when a question does not. Three reasons, and the first is
 * not about cost. (1) The output is a REPORT ABOUT IDENTIFIABLE PEOPLE AND BUSINESSES,
 * and a job with an owner is one somebody can be told is theirs and be shown only to
 * them — an anonymous job id is a capability anybody who guesses it holds. (2) An IP is
 * the weakest identifier available (see lib/quota.js) and it is the only one an anonymous
 * caller has; metering minutes of third-party bandwidth against it is metering nothing.
 * (3) A signature costs the visitor nothing and moves no funds, so the bar is low and it
 * is honest about what it is: a name on the request.
 *
 * WHY A VERIFIED HOLDER IS CAPPED TOO, when they ask questions without limit. A daily
 * question limit protects OUR spend and a holder has paid for that in the only currency
 * the gate reads. This limit protects OTHER PEOPLE'S servers, and no token balance is
 * consent from a third party to be crawled. The holder's number is bigger; it is not
 * absent.
 *
 * Server-side only: no React.
 */

/** Which standing a caller is in. The refusal says which, because "no" alone is useless. */
export const RESEARCH_ACCESS = Object.freeze({
  ALLOWED: "allowed",
  /** No session at all: nothing to attribute a job to. */
  ANONYMOUS: "anonymous",
  /** Signed in, allowance spent for today. */
  SPENT: "spent",
  /** Signed in, and this tier's allowance is configured to zero. */
  DISABLED: "disabled",
});

/** Which tier a caller is in, which is only ever about the daily number. */
export const RESEARCH_TIER = Object.freeze({
  HOLDER: "holder",
  SIGNED_IN: "signed-in",
});

/** Deep investigations per UTC day for a signed-in caller who is not a verified holder. */
const DEFAULT_SIGNED_IN_DAILY = 1;
/** Deep investigations per UTC day for a verified holder. Bigger, and still a number. */
const DEFAULT_HOLDER_DAILY = 5;

/**
 * The daily allowance for one tier.
 *
 * Zero is meaningful and is preserved: `RESEARCH_DAILY_JOBS=0` turns the feature off for
 * non-holders without turning it off for holders, which is the shape an operator paying
 * for a Groq key actually wants. Only NaN and negatives fall back.
 */
export function researchAllowance(tier, env = process.env) {
  const raw = tier === RESEARCH_TIER.HOLDER ? env.RESEARCH_HOLDER_DAILY_JOBS : env.RESEARCH_DAILY_JOBS;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  return tier === RESEARCH_TIER.HOLDER ? DEFAULT_HOLDER_DAILY : DEFAULT_SIGNED_IN_DAILY;
}

/** The counter key for one caller's research jobs. Address only — see below. */
export function researchQuotaKey(address, now = Date.now()) {
  const addr = String(address ?? "").trim().toLowerCase();
  // There is no IP branch, and that is the gate rather than an omission: a caller with no
  // address cannot get here at all, so there is no key for one.
  return `research:${utcDayKey(now)}:addr:${addr}`;
}

/**
 * WHAT THIS CALLER MAY DO RIGHT NOW — read only, spends nothing.
 *
 * PEEK NOW, CHARGE AFTER THE JOB ACTUALLY STARTS. `store.increment` cannot be un-spent,
 * and the alternative ordering — charge, then discover the service is down — takes a
 * day's allowance from somebody for an investigation that never ran. The cost of this
 * ordering is a race: two submissions in flight at once can both see the last slot free
 * and both start. That is the same speed-bump posture lib/quota.js documents in detail
 * for questions, and one extra job is a far smaller wrong than one stolen allowance.
 *
 * @param {{ sessionCookie?: string|null, ip?: string, store?: object|null, now?: number, env?: object }} args
 * @returns {Promise<object>} never throws
 */
export async function resolveResearchAccess({
  sessionCookie = null,
  ip = "unknown",
  store = null,
  now = Date.now(),
  env = process.env,
} = {}) {
  // consume:false — asking whether a deep investigation is allowed must not spend one of
  // the caller's daily QUESTIONS. The two ledgers are separate and stay separate.
  const access = await resolveAccess({ sessionCookie, ip, store, now, consume: false });
  const address = access.address;
  const entitlement = access.entitlement;

  if (!address) {
    return report({
      state: RESEARCH_ACCESS.ANONYMOUS,
      allowed: false,
      tier: null,
      limit: null,
      address: null,
      entitlement: null,
      resetsAt: null,
      message:
        "A deep investigation runs for minutes and reads other people's servers, so it is attached to a wallet rather than to nobody. Connect one and sign — signing is a plain message, not a transaction: it cannot move funds, grant an allowance or spend gas.",
    });
  }

  const tier = isEntitled(entitlement) ? RESEARCH_TIER.HOLDER : RESEARCH_TIER.SIGNED_IN;
  const limit = researchAllowance(tier, env);
  const resetsAt = utcResetAt(now);

  if (limit <= 0) {
    return report({
      state: RESEARCH_ACCESS.DISABLED,
      allowed: false,
      tier,
      limit: 0,
      used: 0,
      remaining: 0,
      address,
      entitlement,
      resetsAt,
      message:
        tier === RESEARCH_TIER.HOLDER
          ? "Deep investigations are switched off on this server."
          : "Deep investigations are switched off for this tier on this server. Holding the gating token is what opens them, where the operator has enabled that.",
    });
  }

  const key = researchQuotaKey(address, now);
  let used = null;
  if (typeof store?.counter === "function") {
    try {
      const row = await store.counter(key);
      used = row ? Number(row.value) || 0 : 0;
    } catch (e) {
      // Unreadable is NOT zero and is not "spent" either. It is unknown, and `degraded`
      // is what says so; the charge below still tries, and the per-process floor stands
      // in if it cannot.
      console.error(`[research] counter read failed — ${String(e?.message ?? e)}`);
      used = null;
    }
  }

  const spent = used != null && used >= limit;
  return report({
    state: spent ? RESEARCH_ACCESS.SPENT : RESEARCH_ACCESS.ALLOWED,
    allowed: !spent,
    tier,
    limit,
    used: used ?? 0,
    remaining: used == null ? null : Math.max(0, limit - used),
    address,
    entitlement,
    resetsAt,
    degraded: used == null,
    message: spent
      ? `That is all ${limit} deep investigation${limit === 1 ? "" : "s"} for today. They come back at 00:00 UTC (in ${untilReset(resetsAt, now)}).${tier === RESEARCH_TIER.SIGNED_IN ? " Holding the gating token raises the daily number." : ""}`
      : "",
  });
}

/**
 * SPEND ONE, once a job really started.
 *
 * FAILING OPEN WITH A FLOOR, exactly as lib/quota.js does: a counter outage must not take
 * the feature down, but it must not silently make it unlimited either, so the per-process
 * fixed-window limiter stands in with the same allowance and the same reset and the
 * report says `degraded`. On serverless that floor is per warm instance — which is a
 * weaker limit and is reported rather than dressed up.
 *
 * @returns {Promise<{ used: number|null, remaining: number|null, degraded: boolean }>}
 */
export async function chargeResearchJob({ store, address, limit, now = Date.now() } = {}) {
  const key = researchQuotaKey(address, now);
  const ttlMs = msUntilUtcReset(now);
  const cap = Number.isFinite(limit) && limit > 0 ? limit : 1;
  try {
    if (typeof store?.increment !== "function") throw new Error("no store is configured");
    const { value } = await store.increment(key, { ttlMs });
    const used = Number(value) || 0;
    return { used, remaining: Math.max(0, cap - used), degraded: false };
  } catch (e) {
    console.error(`[research] durable counter unavailable — ${String(e?.message ?? e)}`);
    const fallback = rateLimit(`research-fallback:${key}`, cap, ttlMs);
    return { used: cap - fallback.remaining, remaining: fallback.remaining, degraded: true };
  }
}

/**
 * The standing, trimmed to what a client may render.
 *
 * The wallet address is NOT in here. The client already knows its own address from the
 * session panel, and a field is a field somebody eventually logs.
 */
export function publicResearchAccess(access) {
  if (!access) return null;
  return {
    state: access.state,
    allowed: access.allowed,
    tier: access.tier,
    limit: access.limit,
    used: access.used,
    remaining: access.remaining,
    resetsAt: access.resetsAt,
    degraded: access.degraded,
    message: access.message,
  };
}

/* --------------------------------- internals -------------------------------- */

/** The report shape, so no branch can quietly omit a field. */
function report(fields) {
  return {
    state: RESEARCH_ACCESS.ANONYMOUS,
    allowed: false,
    tier: null,
    limit: null,
    used: 0,
    remaining: null,
    resetsAt: null,
    degraded: false,
    address: null,
    entitlement: null,
    message: "",
    ...fields,
  };
}

/** "3h 12m" / "14m" — how long until the allowance comes back. */
function untilReset(resetsAt, now) {
  const ms = new Date(resetsAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return "shortly";
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
