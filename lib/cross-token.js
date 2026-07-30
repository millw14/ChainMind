import { formatUnits } from "viem";
import {
  ENRICHMENT_TIMEOUT_MS,
  TIMEOUT_MS,
  deadline,
  getAddressTokenBalances,
  getToken,
  getTokenHolders,
} from "./blockscout.js";
import { fmtTokenAmount, pctOfSupply } from "./ask-evidence.js";
import { displayNumber, finiteOrNull } from "./format-number.js";
import {
  HOLDER_ROLES,
  MAX_HOLDERS_PROBED,
  PROBE_CONCURRENCY,
  classifyRole,
  holderFirstAcquisition,
  tokenPoolAddresses,
} from "./holder-history.js";
import { PAGE_ATTEMPTS, readPageWithRetry } from "./page-retry.js";
import { noteBudgetSkip, outOfTimeFor } from "./request-budget.js";

/**
 * QUESTIONS THAT SPAN TWO THINGS — which wallets hold BOTH of these tokens, what
 * ELSE this token's holders are in, and does this one wallet hold X and Y.
 *
 * WHY THIS MODULE EXISTS, AND IT IS NOT A FEATURE REQUEST. Measured on
 * chainmind.fun, a user asked:
 *
 *   "what wallet in this coin 0x31ba…c6cc also bought this: 0xa15c…7b32"
 *
 * There was no tool for a relation across two tokens, so the model ran
 * lookup_token on the FIRST address, printed its holders, and never mentioned the
 * second token at all. It answered an easier, adjacent question and said nothing
 * about the substitution — which is worse than "I cannot do that", and is the exact
 * failure the `unavailable` convention, the lower-bound labelling and
 * ask_clarification exist to prevent everywhere else in this codebase. The user
 * caught it in one line, by naming a wallet that holds both.
 *
 * THE ANSWER THAT SHOULD HAVE COME BACK, measured live on chain 4663: PIPECAT
 * (150 holders) and Merrymen by Virtuals (473 holders) share 14 wallets. 150 + 473
 * holders is 3 + 10 pages, 13 indexer calls: the question was cheap all along.
 *
 * AND A CORRECTION THIS FILE ONCE HAD WRONG, kept because the mistake is instructive.
 * The largest thing in that intersection — 0x8366a39c…, on 50.5% of PIPECAT's supply
 * and 0.7% of MERRYMEN's — was described here as "PIPECAT's #1 holder, the single most
 * interesting fact about the pair". It is the UNISWAP V4 POOLMANAGER: one contract that
 * holds every v4 pool on the chain and custodies every token in them, so it is a large
 * holder of many unrelated tokens and a holder of nothing in the sense a reader means.
 * It went unlabelled because pool identity here came from a v3 factory sweep and the
 * singleton has no token0() for a sweep to find. See lib/holder-history.js classifyRole
 * and lib/dex-price.js resolveV4PoolManager: the largest row in an overlap is exactly
 * where a mislabelled pool does the most damage.
 *
 * THE SCALING PROBLEM, AND THE TWO STRATEGIES. A full intersection is only cheap
 * when the lists are small, and they are not always small — one VLAD contract on
 * this chain has 52,214 holders, which is ~1,045 pages and cannot be read inside a
 * request. So:
 *
 *   a. FULL INTERSECTION when every list fits. Read them all, intersect. This is an
 *      EXACT answer and says so.
 *   b. SMALLEST-SET PROBE when one list does not fit. Every wallet holding all the
 *      tokens must appear in the SMALLEST token's list, so read that list fully and
 *      ask each candidate for its own portfolio —
 *      /addresses/{a}/token-balances returns EVERY token a wallet holds in one
 *      body (14 rows for the measured wallet), so one call settles a candidate
 *      against all the other tokens at once. Cost scales with the smaller set, not
 *      the larger.
 *
 * When neither can be finished — a page cap, a clock, a 500 — what came back is a
 * LOWER BOUND: "at least N wallets". Never the complete set, and never zero. The
 * truncation lives in the DATA (`listComplete`, `pagesRead`, `candidates.complete`,
 * `exact`), not only in the prose, so a caller cannot drop the qualifier by
 * quoting a field.
 *
 * THE HONESTY THAT IS MOST OF THE WORK HERE:
 *
 *  1. HOLDING IS NOT BUYING. The user said "also bought". A balance is a fact about
 *     now; it says nothing about how the tokens arrived. Airdrops, migrations,
 *     transfers from another of the same person's wallets and OTC deals all produce
 *     a balance with no purchase behind it. Every result is stamped
 *     `measured: "current_co_holding"` and no string in this file says "bought".
 *     The opt-in acquisition leg reports the oldest INBOUND transfer that could be
 *     read — an acquisition, still not a purchase — and is labelled as such.
 *  2. CO-HOLDING IS A CORRELATION. Two wallets holding two popular tokens means
 *     almost nothing; one wallet holding a majority of two obscure ones is worth a
 *     look. The figures and the shares go out, the reader judges, and nothing here
 *     emits scam, rug, fraud, insider or coordination language.
 *  3. THE DENOMINATOR TRAVELS WITH THE COUNT. "4 of 10 probed holders" where the
 *     token has 52,214 is not a pattern across the token, and coHoldings will not
 *     let that figure out of the door without both denominators attached.
 *  4. A POOL IS NOT AN INTERESTED WALLET. The role rules are lib/holder-history.js's
 *     — v3 pool, v4 PoolManager, burn sink, token contract — reused rather than
 *     re-derived, so a Uniswap pool holding both tokens is labelled and set aside
 *     instead of being printed as the most interesting wallet on the list. This is
 *     not a hypothetical: the v4 singleton WAS printed as that wallet, which is why
 *     the fourth rule exists.
 *
 * COST. Bounded at MAX_LIST_PAGES per list and MAX_TOTAL_PAGES overall for a full
 * intersection, MAX_CANDIDATES_PROBED for a probe run, everything through a worker
 * pool at lib/holder-history.js PROBE_CONCURRENCY, every read on the enrichment
 * deadline and every item behind a lib/request-budget.js check. Every call goes
 * through lib/blockscout.js and therefore lib/indexer-cache.js, so the follow-up
 * question about the same pair is free and two questions about the same wallet cost
 * one portfolio read.
 *
 * Server-side only: no React, no next/*. Every indexer call and the pool resolver
 * are injectable, so test/cross-token.test.mjs exercises all of it offline.
 */

/* --------------------------------- limits -------------------------------- */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Rows per holder page on this indexer, measured live on chain 4663.
 *
 * It is a COST MODEL, not a request parameter: a token's holder count divided by
 * this is how many calls reading its list will take, which is the whole input to
 * choosing a strategy. PIPECAT's 150 holders are 3 pages; MERRYMEN's 473 are 10.
 */
export const HOLDER_PAGE_SIZE = 50;

/**
 * How many tokens one overlap may span.
 *
 * FOUR. Two is the question people ask; three happens ("which wallets are in all
 * of these"); beyond four the intersection is almost always empty and the reader is
 * better served by a smaller question. It is also a cost bound: the full strategy
 * pages every list, so the tail tokens are paid for even when the first pair
 * already share nothing.
 */
export const MAX_TOKENS = 4;

/**
 * Pages one holder list may be walked, and pages the whole full-intersection may
 * spend.
 *
 * TWELVE per list is 600 holders — MERRYMEN's 473 fit with room, and anything past
 * it is a list this strategy should not be reading at all. THIRTY overall keeps a
 * four-token question from costing 48 calls because each list individually
 * qualified: measured, this indexer answers a holder page in a few hundred
 * milliseconds, so 30 pages spread across concurrent walks is seconds against
 * lib/request-budget.js ASK_BUDGET_MS of 24s, of which the wallet gate has already
 * spent up to 4s.
 *
 * THE OVERALL CAP IS ENFORCED BY DIVIDING IT, not by checking it afterwards: a full
 * intersection gives each list `MAX_TOTAL_PAGES / tokens` pages, and the plan calls
 * a list readable only against THAT figure. Checking the total after the fact would
 * let a walk run past the budget and then report the overrun, and a plan that says
 * "this is the complete set" must not be able to disagree with the walk it planned.
 */
export const MAX_LIST_PAGES = 12;
export const MAX_TOTAL_PAGES = 30;

/**
 * How many candidates from the smallest list get a portfolio probe.
 *
 * SIXTY, derived from the clock rather than picked. One probe is one indexer call;
 * measured, this indexer answers /token-balances in a few hundred milliseconds and
 * drops requests issued in a tight burst, so 60 probes through a pool of
 * PROBE_CONCURRENCY is ~15 waves, a handful of seconds. Past that the request runs
 * out of budget, and a bound that is hit is reported (`candidates.complete: false`)
 * rather than quietly shortening the answer.
 *
 * Candidates are probed LARGEST BALANCE FIRST, so a cap that bites drops the
 * smallest positions rather than a random slice — the 52.4% holder is never the one
 * that goes missing.
 */
export const MAX_CANDIDATES_PROBED = 60;

/**
 * How many of a token's top holders coHoldings probes, and the ceiling on that.
 *
 * TEN by default, the same number lib/holder-history.js MAX_HOLDERS_PROBED settled
 * on for the same reason: one call per holder, and ten is what the ask route can
 * afford. Twenty-five is the ceiling a caller may ask for.
 */
export const DEFAULT_COHOLDING_HOLDERS = 10;
export const MAX_COHOLDING_HOLDERS = 25;

/** Rows returned by default, and the most a caller may ask for. */
export const DEFAULT_WALLET_ROWS = 50;
export const MAX_WALLET_ROWS = 200;

/**
 * Time worth STARTING one page read or one probe with. The question is "is it worth
 * starting", not "has the clock run out": a call handed 200ms fails, and a failure
 * reports an indexer outage — a claim about an upstream that was never really
 * asked. See lib/request-budget.js outOfTimeFor.
 */
const PAGE_MIN_MS = 1_200;
const PROBE_MIN_MS = 1_200;

/**
 * WHAT A HOLDER PAGE COSTS IN TIME, AND WHY THE PLAN DELIBERATELY IGNORES IT.
 *
 * Measured live on chain 4663, cold, one page at a time: 1.8s, 1.9s, 2.0s, 2.1s,
 * 2.9s, 3.1s, 3.2s, 3.2s, 3.8s, 5.1s and 5.7s — about 2.5s each. Two walks run
 * CONCURRENTLY did not divide that: both slowed, one page 500'd and another hit the
 * 6s enrichment deadline, so the indexer is the bottleneck and a plan's cost is its
 * TOTAL page count. Thirteen pages is therefore ~33s against the ask route's 17s of
 * lookup time, and PIPECAT + MERRYMEN — thirteen pages, comfortably inside every page
 * cap — cannot be walked in full on a cold cache.
 *
 * A CLOCK CHECK IN planOverlap WAS TRIED AND MEASURED WORSE. Demoting that pair to the
 * smallest-set probe on a cold cache produced "at least 0 wallets": the probe reads the
 * base list's holders LARGEST FIRST and caps at MAX_CANDIDATES_PROBED, and for this
 * pair the shared wallets are the SMALL PIPECAT positions — measured, of PIPECAT's top
 * five readable holders none holds MERRYMEN, while the full intersection finds fourteen
 * wallets whose PIPECAT balances run down to 1e-18. So the probe is not a cheaper route
 * to the same answer; it is a different, weaker instrument that happens to be
 * affordable, and it is right only when a list genuinely cannot be paged at all — which
 * is exactly what the page-count model above already detects. On a warm cache (a
 * follow-up question inside lib/indexer-cache.js's 60s TTL) the full walk answers the
 * same pair EXACTLY in ~7s, and the clock check was throwing that away.
 *
 * So the plan costs pages, the walk checks the clock per page, and a walk the clock
 * cuts short reports a labelled lower bound. Cold, that bound is sometimes "at least
 * 0 wallets" — useless, and honest, and better than either a false zero or a weaker
 * answer presented as the same question.
 */
const MEASURED_PAGE_COST_MS = 2_500;

/** Which of the two strategies produced a result, reported in every answer. */
export const OVERLAP_STRATEGIES = Object.freeze({
  /** Every list read and intersected. Exact when every list came back complete. */
  FULL: "full_intersection",
  /** The smallest list read, each candidate checked by its own portfolio. */
  SMALLEST: "smallest_set_probe",
});

/**
 * The indexer calls, overridable per call — the same test seam
 * lib/holder-history.js and lib/token-evidence.js use. Nothing in this module may
 * reach Blockscout during a unit test.
 */
const DEFAULT_CALLS = Object.freeze({
  getAddressTokenBalances,
  getToken,
  getTokenHolders,
});

/* -------------------------------- plumbing -------------------------------- */

/** Lowercased 0x address, or null when the field is not an address at all. */
function lowerAddress(v) {
  if (v && typeof v === "object") {
    return lowerAddress(v.hash ?? v.address ?? v.address_hash ?? null);
  }
  const s = String(v ?? "").trim().toLowerCase();
  return ADDRESS_RE.test(s) ? s : null;
}

/** 0x1234567890abcdef… -> "0x1234…cdef", the form every surface here uses. */
function shortHex(value) {
  const v = String(value ?? "");
  return v.length > 12 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * "473 holders", "3 addresses", "1 page" — with the separator a reader expects at
 * five digits and the plural a reader expects at the end of a sibilant. "3 addresss"
 * shipped once from the naive version of this, in the sentence that lists the
 * addresses excluded from an overlap.
 */
function countWords(n, noun) {
  const s = displayNumber(n, "count");
  const plural = /(?:s|x|z|ch|sh)$/.test(noun) ? `${noun}es` : `${noun}s`;
  return `${s} ${Math.round(n) === 1 ? noun : plural}`;
}

/**
 * A wallet count as the sentence it must be quoted as.
 *
 * The "at least" is baked in at the only place that knows the answer was bounded,
 * for the reason lib/holder-history.js holdWords bakes in its own: a lower bound
 * rendered as a plain figure IS a false claim, and remembering the qualifier must
 * not be the caller's job.
 */
function countDisplay(n, isLowerBound) {
  const words = countWords(n, "wallet");
  return isLowerBound ? `at least ${words}` : words;
}

/** Run a read without letting it fail the gather. Same shape as elsewhere. */
async function attempt(thunk) {
  try {
    return { ok: true, value: await thunk(), status: null };
  } catch (error) {
    return { ok: false, value: null, status: error?.status ?? null };
  }
}

/**
 * Map over `items` with at most `limit` in flight, preserving order.
 *
 * Promise.all over sixty addresses is one burst of sixty, which is the shape this
 * indexer drops requests on. Measured on chain 4663: probing holders at
 * concurrency 4 completed 9 of 10 in 12.6s, concurrency 2 took 24.0s for the same
 * 9, and concurrency 1 managed 6 in 38.0s — higher concurrency here is both more
 * complete AND faster, so the pool is wide rather than polite. The order is kept so
 * `out[i]` is `items[i]`'s answer and a slow probe cannot reorder a balance-ranked
 * table.
 */
async function mapPooled(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= items.length) return;
        out[i] = await worker(items[i], i);
      }
    }),
  );
  return out;
}

/**
 * Cursor params for the next page. Blockscout echoes its own cursor back as
 * `next_page_params`; nulls in it would stringify to the literal "null" and poison
 * the query. Local rather than shared with lib/wallet-evidence.js's copy, for the
 * reason that one gives: one page-walker reaching into another's internals is how
 * two walks end up having to change together.
 */
function cursorParams(next) {
  if (!next || typeof next !== "object") return null;
  const out = {};
  for (const [key, value] of Object.entries(next)) {
    if (value == null) continue;
    out[key] = String(value);
  }
  return Object.keys(out).length ? out : null;
}

/** True when two param bags are the same request — a cursor that repeats loops. */
function sameParams(a, b) {
  const ak = Object.keys(a ?? {});
  const bk = Object.keys(b ?? {});
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a[k] === b[k]);
}

/** The items array off a Blockscout body that is sometimes bare, sometimes paged. */
function itemsOf(body) {
  if (Array.isArray(body)) return body;
  return Array.isArray(body?.items) ? body.items : [];
}

/** A count clamped into range; junk falls back rather than failing the lookup. */
function clampCount(raw, fallback, max) {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, n));
}

/**
 * A base-unit amount as a Number, or null. Separate from fmtTokenAmount because
 * these amounts have to be COMPARED — the candidate ordering below is a sort on
 * them — and a compacted "32.1M" cannot be compared with anything.
 *
 * Through formatUnits rather than `Number(raw) / 10 ** d`: the raw balances here run
 * to 27 digits, past what a double holds exactly, and dividing the rounded double
 * gives 32,099,881.000000004 where the exact decimal string gives 32,099,881.
 */
function amountNumber(raw, decimals) {
  if (raw == null) return null;
  try {
    const d = finiteOrNull(decimals) ?? 18;
    const n = Number(formatUnits(BigInt(raw), d));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** The failure sentence for a call that never answered. Never "not found". */
function unavailableError(what, status) {
  return {
    ok: false,
    error: `The Robinhood Chain indexer did not answer${status ? ` (HTTP ${status})` : ""}, so ${what} could not be read — unknown, not absent. Try again shortly.`,
  };
}

function nowIso() {
  return new Date().toISOString();
}

/* ------------------------------ token metadata ---------------------------- */

/**
 * The four things every token in a cross-token question needs: its symbol, its
 * decimals, its supply (for the shares) and its HOLDER COUNT — which is the input
 * to choosing a strategy, and the only reason this call happens before any list is
 * read.
 *
 * `holderCount: null` is not zero holders. It is a token endpoint that did not
 * answer, and the plan below treats it as an UNKNOWN cost rather than a cheap one:
 * a list whose length is unknown gets walked with the page cap in force and its
 * completeness MEASURED from whether a cursor came back, instead of assumed from a
 * count nobody read.
 */
async function tokenMeta(address, calls, timeoutMs) {
  const res = await attempt(() => calls.getToken(address, deadline(timeoutMs)));
  const t = res.value ?? null;
  const decimals = finiteOrNull(t?.decimals);
  const holderCount = finiteOrNull(t?.holders ?? t?.holders_count);
  return {
    address,
    read: Boolean(t),
    status: res.status,
    symbol: typeof t?.symbol === "string" ? t.symbol.slice(0, 16) : null,
    name: typeof t?.name === "string" ? t.name.slice(0, 72) : null,
    decimals: decimals ?? 18,
    decimalsAssumed: decimals === null,
    rawSupply: t?.total_supply ?? null,
    supplyRead: t?.total_supply != null,
    holderCount,
    holderCountDisplay: holderCount === null ? null : displayNumber(holderCount, "count"),
  };
}

/** How a token is named in prose: its symbol when it has one, else short hex. */
function tokenLabel(meta) {
  return meta?.symbol || shortHex(meta?.address);
}

/* ------------------------------ role labelling ---------------------------- */

/**
 * WHAT ONE ADDRESS IS, relative to EVERY token in the question.
 *
 * The rules are lib/holder-history.js classifyRole's, called once per token and
 * short-circuited on the first non-holder answer. Reused rather than re-derived
 * because there must be exactly one definition of "this is a pool, not a position"
 * in this codebase: a second copy would drift, and the drift would show up as a
 * Uniswap pool printed as the most interesting wallet in an overlap.
 *
 * `roleToken` says WHICH token made it a contract or a pool, which the single-token
 * caller never needed and a cross-token reader does — "0x31ba…c6cc is PIPECAT's own
 * contract" is a different sentence from "it is a pool".
 */
function classifyAcross(address, tokens, pools, v4PoolManager) {
  for (const meta of tokens) {
    const c = classifyRole(address, { token: meta.address, pools, v4PoolManager });
    if (c.role !== HOLDER_ROLES.HOLDER) {
      return {
        role: c.role,
        roleReason: c.reason,
        // The v4 singleton is not a fact about any ONE of the tokens asked about — it
        // holds all of them and thousands of others — so it carries no roleToken. A
        // sentence naming "PIPECAT's v4 PoolManager" would be wrong about ownership.
        roleToken: c.poolVersion === "v4" ? null : meta.address,
        roleTokenSymbol: c.poolVersion === "v4" ? null : meta.symbol,
        poolVersion: c.poolVersion ?? null,
      };
    }
  }
  return { role: HOLDER_ROLES.HOLDER, roleReason: null, roleToken: null, roleTokenSymbol: null, poolVersion: null };
}

/**
 * Every pool address across every token in the question, plus whether that
 * question was answered for all of them.
 *
 * "mixed" is its own status and not a rounding of the other two: one token's pools
 * resolved and another's unread means SOME unlabelled row could still be a pool,
 * which is exactly the caveat a reader needs and exactly what "resolved" would hide.
 */
async function poolsAcross(tokens, options) {
  const results = await Promise.all(
    tokens.map((meta) =>
      tokenPoolAddresses(meta.address, {
        client: options.client,
        calls: options.calls,
        resolvePool: options.resolvePool,
        resolveV4PoolManager: options.resolveV4PoolManager,
      }),
    ),
  );
  const pools = new Set();
  for (const r of results) for (const p of r.pools) pools.add(p);
  // The v4 singleton is one address for the whole chain, so every token's lookup asks
  // the same question and answers it identically. The first SETTLED verdict is taken —
  // not the first verdict — so one token's brownout cannot erase a confirmation another
  // token's lookup already got, and the address then applies to every row.
  const v4 = results.find((r) => r.v4?.status === "confirmed")?.v4
    ?? results.find((r) => r.v4?.status === "rejected")?.v4
    ?? results[0]?.v4
    ?? { address: null, status: "unread", reason: "the Uniswap v4 PoolManager check did not run" };
  const unread = results.filter((r) => r.status === "unread");
  const status = unread.length === 0 ? (pools.size ? "resolved" : "none") : unread.length === results.length ? "unread" : "mixed";
  const caveat =
    unread.length === 0
      ? null
      : `${unread.length === results.length ? "No token's" : `${unread.length} of these tokens'`} pool was identified (${unread[0].reason ?? "the lookup did not settle"}), so an address listed below as a wallet may in fact be a liquidity pool. Treat the labels as provisional.`;
  // A SECOND caveat for a second gap: the v3 sweep can settle while the v4 check does
  // not, and the v4 manager is a top holder of every token whose market is on v4 — the
  // exact shape that put a pool at the head of this table in the first place.
  const v4Caveat =
    v4.status === "unread"
      ? `Whether the Uniswap v4 PoolManager is among these holders was not established (${v4.reason ?? "the check did not settle"}). v4 keeps every pool in one contract, so a token trading there has its liquidity at a single address that would appear below as a large holder of BOTH tokens. Treat an unusually large unlabelled row with that in mind.`
      : null;
  return { pools, status, caveat, unreadCount: unread.length, v4, v4Caveat };
}

/* ------------------------------ holder lists ------------------------------ */

/**
 * ONE TOKEN'S HOLDER LIST, walked to the page cap, with an honest verdict on
 * whether that was the whole list.
 *
 * THE FOUR WAYS A WALK ENDS, and they are four different facts:
 *   - no cursor came back: the list is COMPLETE, and a wallet absent from it truly
 *     does not hold this token;
 *   - the page cap or the clock stopped us: INCOMPLETE, and every absence from it
 *     is unknown rather than measured;
 *   - a page threw on every attempt it was given: INCOMPLETE with a status, which is
 *     an outage and must never be read as the end of the list;
 *   - a page threw and the request could not afford to ask again: INCOMPLETE, and a
 *     SHORTAGE OF TIME rather than an outage — reported as its own sentence, because
 *     "the indexer did not answer" is a claim about an upstream and this one is not.
 *
 * A FAILED PAGE IS RE-ASKED BEFORE ANY OF THAT, which is what closes the gap between
 * this walk's honesty and its usefulness. Measured, the failures are ~10% per page and
 * random, so a ten-page list lost at least one page roughly two runs in three and the
 * answer for PIPECAT + MERRYMEN came back as "at least 1 wallet" and "at least 4
 * wallets" for a pair that shares 14. The retry policy and the evidence for it live in
 * lib/page-retry.js; the honesty layer below is unchanged, because a walk that STILL
 * cannot finish must still report itself incomplete with its reason.
 *
 * The distinction is the whole reason this returns a `complete` flag instead of
 * just a Map: the intersection below can only be exact if every list it intersected
 * was complete, and an absence from a truncated list can only make the answer
 * SMALLER — hence a lower bound, never an overstatement.
 *
 * @returns {Promise<{ token: string, balances: Map<string, unknown>, pagesRead: number,
 *   complete: boolean, reason: string|null, failedStatus: number|null,
 *   pageAttempts: number, retriedPages: number }>}
 */
async function readHolderList(token, { calls, timeoutMs, maxPages, retry }) {
  const balances = new Map();
  let params = {};
  let pagesRead = 0;
  // What the retries cost and how often they were needed, so the price of the
  // completeness above is visible rather than inferred from a page count.
  let pageAttempts = 0;
  let retriedPages = 0;

  /** Every ending shares these; only the verdict and the sentence differ. */
  const stop = (reason, failedStatus = null) => ({
    token,
    balances,
    pagesRead,
    complete: false,
    reason,
    failedStatus,
    pageAttempts,
    retriedPages,
  });

  for (;;) {
    if (pagesRead >= maxPages) {
      // "12 pages … was read" shipped from the first draft of this: countWords
      // pluralises the noun and the verb has to follow it.
      return stop(
        `only the first ${countWords(pagesRead, "page")} of this token's holder list ${pagesRead === 1 ? "was" : "were"} read (${countWords(balances.size, "holder")}), so the rest of its holders are unknown rather than absent`,
      );
    }
    if (outOfTimeFor(PAGE_MIN_MS)) {
      noteBudgetSkip("holderOverlap");
      return stop(
        `this token's holder list was cut short after ${countWords(pagesRead, "page")} because the request ran short of time — the holders not read are unknown, not absent`,
      );
    }

    const res = await readPageWithRetry(
      () => calls.getTokenHolders(token, params, deadline(timeoutMs)),
      { ...retry, minMs: PAGE_MIN_MS, label: "holderOverlap" },
    );
    pageAttempts += res.attempts;
    if (res.retried) retriedPages += 1;
    if (!res.ok) {
      // Stopping here with `complete: true` would turn a 500 into the sentence
      // "these are all the holders", which is the single worst thing this module
      // could say. Which of the two shortages it was matters as much: a page that
      // failed every attempt is an OUTAGE, and one that failed with no budget left
      // to ask again is a request that ran out of TIME. Reporting the second as the
      // first would blame an upstream that was asked once and never re-asked.
      return stop(
        res.stoppedForTime
          ? `page ${pagesRead + 1} of this token's holder list did not answer${res.status ? ` (HTTP ${res.status})` : ""} and the request had no time left to ask again, so the list is part-read — the holders beyond it are unknown, not absent`
          : `the indexer did not answer for page ${pagesRead + 1} of this token's holder list${res.status ? ` (HTTP ${res.status})` : ""} on ${countWords(res.attempts, "attempt")}, so the list is part-read — the holders beyond it are unknown, not absent`,
        res.status,
      );
    }
    pagesRead += 1;

    for (const item of itemsOf(res.value)) {
      const address = lowerAddress(item?.address);
      if (!address) continue;
      // First write wins: a cursor that overlaps a page would otherwise let a later
      // page's row replace an earlier one, and the balances are the same row anyway.
      if (!balances.has(address)) balances.set(address, item?.value ?? null);
    }

    const next = cursorParams(res.value?.next_page_params);
    if (!next) {
      return {
        token,
        balances,
        pagesRead,
        complete: true,
        reason: null,
        failedStatus: null,
        pageAttempts,
        retriedPages,
      };
    }
    if (sameParams(next, params)) {
      // A cursor that repeats is a walk that would never end. Bailing out is right;
      // calling the result complete would not be.
      return stop(
        "the indexer returned the same page cursor twice, so the walk was stopped — the remaining holders are unknown",
      );
    }
    params = next;
  }
}

/* ------------------------------- positions -------------------------------- */

/**
 * One wallet's position in one token, in the shape everything printable needs.
 *
 * `percent` is null and never 0 when the token's supply could not be read — a
 * wallet shown as holding 0% of a token it demonstrably holds is the sharpest false
 * claim available here, and `percentUnknownReason` says which of the two it is.
 */
function positionOf(meta, rawBalance, source) {
  const percent = meta.supplyRead ? pctOfSupply(rawBalance, meta.rawSupply) : null;
  return {
    token: meta.address,
    symbol: meta.symbol,
    name: meta.name,
    balance: rawBalance == null ? null : String(rawBalance),
    amount: amountNumber(rawBalance, meta.decimals),
    amountDisplay: fmtTokenAmount(rawBalance, meta.decimals),
    percent,
    percentDisplay: percent === null ? null : `${round2(percent)}%`,
    percentUnknownReason:
      percent === null
        ? meta.supplyRead
          ? "this balance could not be measured against the token's supply, so the share is unknown rather than zero"
          : "this token's total supply could not be read, so the share of supply is unknown rather than zero"
        : null,
    decimalsAssumed: meta.decimalsAssumed,
    // Which read this came from: the token's own holder list, or the wallet's
    // portfolio. They agree, and when they ever do not the reader should know which
    // one is on the page.
    source,
  };
}

/** The biggest share of any one token's supply this wallet holds. Nulls ignored. */
function largestShare(positions) {
  let best = null;
  for (const p of positions) {
    if (typeof p.percent !== "number" || !Number.isFinite(p.percent)) continue;
    if (!best || p.percent > best.percent) best = p;
  }
  if (!best) return null;
  return { token: best.token, symbol: best.symbol, percent: round2(best.percent), display: `${round2(best.percent)}% of ${best.symbol || shortHex(best.token)}` };
}

/**
 * Rank wallets by the largest supply share they hold, biggest first, with the
 * unknown-share rows LAST rather than treated as small.
 *
 * A comparator that read null as 0 would sort every wallet whose token supply went
 * unread to the bottom as "the smallest position", which is the coerce-to-zero
 * mistake in ranking form. Ties break on the address so two runs over one sample
 * produce the same table.
 */
function byLargestShare(a, b) {
  const pa = a.largestShare?.percent ?? null;
  const pb = b.largestShare?.percent ?? null;
  if (pa === null && pb === null) return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
  if (pa === null) return 1;
  if (pb === null) return -1;
  if (pb !== pa) return pb - pa;
  return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
}

/* ---------------------------- 1. holder overlap --------------------------- */

/**
 * WHICH WALLETS HOLD ALL OF THESE TOKENS — the question the measured session asked
 * and the app could not answer.
 *
 * WHAT IT MEASURES, exactly: CURRENT CO-HOLDING. Every wallet in the result holds a
 * non-zero balance of every token named, as of the reads below. That is not
 * "bought both", and the disclaimer in the result says so in those words, because
 * the phrasing that reaches this function will often be "also bought" and the honest
 * answer has to name the substitution rather than perform it.
 *
 * THE STRATEGY IS PART OF THE ANSWER. `strategy` says which of the two ran and
 * `strategyReason` says why, so a reader can tell "I read both lists in full" from
 * "I read the small list and checked 60 of its 150 holders against the big one".
 * `exact` is the single field that carries whether the set is the complete one, and
 * it is true only when nothing was truncated, nothing failed and nothing was
 * skipped for time.
 *
 * WHY AN INCOMPLETE READ IS ALWAYS A LOWER BOUND AND NEVER AN OVERSTATEMENT: a
 * wallet enters the result only by being FOUND in every list or portfolio read, so
 * a page we did not read can only add wallets, never remove one. The count is
 * therefore ≤ the truth, which is what makes "at least N" the honest form.
 *
 * @param {Array<string|{address: string}>} tokens - 2 to MAX_TOKENS contracts
 * @param {{ calls?: object, client?: object, resolvePool?: Function,
 *   resolveV4PoolManager?: Function, limit?: number, maxPages?: number,
 *   maxCandidates?: number, timeoutMs?: number, concurrency?: number,
 *   acquisitions?: boolean, now?: number, retry?: object }} [options] - `retry`
 *   overrides lib/page-retry.js's policy for the page walks; only tests pass it.
 * @returns {Promise<object>}
 */
export async function holderOverlap(tokens, options = {}) {
  const calls = { ...DEFAULT_CALLS, ...(options.calls && typeof options.calls === "object" ? options.calls : {}) };
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : ENRICHMENT_TIMEOUT_MS;
  const concurrency = Number.isInteger(options.concurrency) && options.concurrency > 0 ? options.concurrency : PROBE_CONCURRENCY;
  const maxPages = clampCount(options.maxPages, MAX_LIST_PAGES, MAX_LIST_PAGES);
  const maxCandidates = clampCount(options.maxCandidates, MAX_CANDIDATES_PROBED, MAX_CANDIDATES_PROBED);
  const rowLimit = clampCount(options.limit, DEFAULT_WALLET_ROWS, MAX_WALLET_ROWS);

  // Deduped, because "which wallets hold X and X" is a typo and answering it as an
  // intersection of one list would report every holder of X as an overlap.
  const wanted = [];
  const seen = new Set();
  let duplicates = 0;
  for (const t of Array.isArray(tokens) ? tokens : []) {
    const address = lowerAddress(typeof t === "string" ? t : t?.address ?? t);
    if (!address) continue;
    if (seen.has(address)) {
      duplicates += 1;
      continue;
    }
    seen.add(address);
    wanted.push(address);
  }
  if (wanted.length < 2) {
    return {
      ok: false,
      // The two shortfalls are different mistakes and get different sentences: one
      // address is an incomplete question, the same address twice is a typo whose
      // "overlap" would be every holder of that token.
      error: duplicates
        ? "An overlap needs two DIFFERENT tokens: the same contract was given twice, and every holder of a token overlaps with itself."
        : "Name at least two token contract addresses to compare — an overlap is a relation between tokens, so one address is not enough.",
    };
  }
  if (wanted.length > MAX_TOKENS) {
    return {
      ok: false,
      error: `That is ${wanted.length} tokens; this compares at most ${MAX_TOKENS} at once, because every extra list has to be read in full before the intersection means anything. Ask about ${MAX_TOKENS} or fewer.`,
    };
  }

  const unavailable = [];
  // Metadata for every token first, and CONCURRENTLY: the holder counts are what
  // decide the strategy, so nothing can be read until they are in, and reading them
  // one after another would put N round trips in front of the first page.
  const metas = await Promise.all(wanted.map((address) => tokenMeta(address, calls, TIMEOUT_MS)));
  for (const meta of metas) {
    if (!meta.read) unavailable.push(`token:${meta.address}`);
  }

  // The pool sweep runs alongside the lists, not before them: it is an RPC-side
  // question and they are indexer-side ones, and serialising would put a factory
  // sweep in front of every overlap for nothing.
  const poolPromise = poolsAcross(metas, options);

  // Every list in a full intersection gets an equal slice of the overall page
  // budget, so the bound the plan reasons about is the bound the walk obeys. The
  // smallest-set probe reads ONE list and may spend the whole per-list cap on it.
  const pagesEach = Math.max(1, Math.min(maxPages, Math.floor(MAX_TOTAL_PAGES / wanted.length)));
  const plan = planOverlap(metas, { pagesEach, maxPages, maxCandidates });
  // The retry policy is lib/page-retry.js's; only its SEAM is threaded through here,
  // so a test can hand it a sleep that costs nothing and nothing else changes.
  const retry = options.retry && typeof options.retry === "object" ? options.retry : undefined;
  const run =
    plan.strategy === OVERLAP_STRATEGIES.FULL
      ? await runFullIntersection(metas, { calls, timeoutMs, maxPages: pagesEach, retry })
      : await runSmallestSetProbe(metas, plan, { calls, timeoutMs, maxPages, maxCandidates, concurrency, retry });

  const pools = await poolPromise;
  if (pools.v4.status === "unread") unavailable.push("v4_pool_identification");
  for (const list of run.lists) {
    if (list.failedStatus !== null || (!list.complete && list.pagesRead === 0)) {
      unavailable.push(`holders:${list.token}`);
    }
  }

  // Roles decide who is a WALLET. A pool, a burn sink or one of the token contracts
  // can hold every token in the question and is still not somebody with a position;
  // it is labelled, listed separately, and never counted in the headline.
  const wallets = [];
  const excluded = [];
  for (const found of run.found) {
    const role = classifyAcross(found.address, metas, pools.pools, pools.v4.address);
    const row = {
      address: found.address,
      ...role,
      positions: found.positions,
      largestShare: largestShare(found.positions),
    };
    if (role.role === HOLDER_ROLES.HOLDER) wallets.push(row);
    else excluded.push(row);
  }
  wallets.sort(byLargestShare);
  excluded.sort(byLargestShare);

  const exact = run.exact && !metas.some((m) => !m.read);
  const isLowerBound = !exact;
  const rows = wallets.slice(0, rowLimit);

  const acquisitions =
    options.acquisitions === true
      ? await overlapAcquisitions(rows, metas, { ...options, calls, timeoutMs })
      : null;

  return {
    ok: true,
    // What was measured, in one field, so no caller has to infer it from prose.
    measured: "current_co_holding",
    tokens: metas.map((meta) => {
      const list = run.lists.find((l) => l.token === meta.address) ?? null;
      return {
        address: meta.address,
        symbol: meta.symbol,
        name: meta.name,
        holderCount: meta.holderCount,
        holderCountDisplay: meta.holderCountDisplay,
        supplyRead: meta.supplyRead,
        decimalsAssumed: meta.decimalsAssumed,
        // The truncation, IN THE DATA. A caller that never reads `reading` still
        // cannot mistake a part-read list for a complete one.
        listRead: Boolean(list),
        listComplete: list ? list.complete : false,
        pagesRead: list ? list.pagesRead : 0,
        holdersRead: list ? list.balances.size : 0,
        // WHAT COMPLETENESS COST. `pageAttempts` above `pagesRead` means pages had to
        // be re-asked (see lib/page-retry.js), and `retriedPages` is how many. Both
        // are data rather than prose: a recovered page is not a bound on the answer,
        // so it belongs where an operator can see it and not in the reader's sentence.
        pageAttempts: list ? list.pageAttempts : 0,
        retriedPages: list ? list.retriedPages : 0,
        listReason: list ? list.reason : "this token's holder list was not read — it was checked one candidate at a time instead",
      };
    }),
    strategy: plan.strategy,
    strategyReason: plan.reason,
    base: plan.base ? { address: plan.base.address, symbol: plan.base.symbol, holderCount: plan.base.holderCount } : null,
    // THE ONE FIELD THAT SAYS WHETHER THIS IS THE COMPLETE SET.
    exact,
    isLowerBound,
    count: wallets.length,
    countDisplay: countDisplay(wallets.length, isLowerBound),
    wallets: rows,
    walletsTruncated: rows.length < wallets.length,
    totalWallets: wallets.length,
    excluded,
    excludedCount: excluded.length,
    excludedNote: excluded.length
      ? "These addresses hold every token asked about but are not wallets with a position: a liquidity pool's balance is the market's, a burn sink's is destroyed, and a token contract's is its own. They are listed so the rows reconcile against the explorer, and they are not counted in the figure above."
      : null,
    candidates: run.candidates,
    poolStatus: pools.status,
    poolCaveat: pools.caveat,
    // The v4 singleton's own verdict, separate from the v3 sweep's, because they are
    // separate questions and a run where one settled must not report the other as
    // settled too. `v4PoolManager` is non-null only when the chain confirmed it.
    v4PoolManager: pools.v4.address,
    v4Status: pools.v4.status,
    v4Caveat: pools.v4Caveat,
    acquisitions,
    unavailable,
    // The bounds this answer was produced under, so a reader can see what a
    // different figure would have cost rather than guessing why this one stopped.
    limits: { pagesPerList: pagesEach, maxTotalPages: MAX_TOTAL_PAGES, maxCandidates, walletRows: rowLimit },
    reading: overlapReading({ metas, plan, run, wallets, excluded, exact, pools, rows }),
    disclaimer:
      "This is CURRENT CO-HOLDING, not shared buying. A balance says a wallet holds the token now; it does not say the wallet bought it — airdrops, migrations, transfers between one person's own wallets and OTC deals all leave a balance with no purchase behind it. Holding two tokens is also a correlation and nothing more: overlap between two widely held tokens is unremarkable, while one wallet sitting on a large share of two thinly held ones is worth a look. Nothing here is evidence of coordination or wrongdoing.",
    asOf: nowIso(),
  };
}

/**
 * WHICH STRATEGY, decided from the holder counts before a single list is read.
 *
 * The comparison is a cost model, not a heuristic: `ceil(holders / 50)` is exactly
 * how many calls reading a list takes, so a plan can be made honestly and the
 * reason quoted back. Anything with a 56,676-holder VLAD in it cannot be walked at
 * all, and the smaller list becomes the base.
 *
 * COST IS COUNTED IN PAGES AND NOT IN SECONDS, WHICH IS A DECISION AND NOT AN
 * OVERSIGHT — see MEASURED_PAGE_COST_MS. Thirteen pages is ~33s cold against 17s of
 * lookup time, so a cold walk of PIPECAT + MERRYMEN gets truncated; demoting it to the
 * probe for that reason was tried and measured WORSE, because the probe reads largest
 * balances first and this pair's shared wallets are the small positions. The clock
 * belongs in the walk, which checks it per page and reports what it actually read.
 *
 * A NULL COUNT IS AN UNKNOWN COST AND NOT A CHEAP ONE. When no count is readable
 * the full walk still runs — with the page cap in force and completeness MEASURED
 * from the cursor — because the alternative is refusing a question that is probably
 * cheap. When some counts are readable and others are not, the smallest KNOWN list
 * becomes the base and the unknowns are settled one candidate at a time, which is
 * the strategy that does not need to know their size at all.
 */
function planOverlap(metas, { pagesEach, maxPages, maxCandidates }) {
  const pagesFor = (n) => (n === null ? null : Math.max(1, Math.ceil(n / HOLDER_PAGE_SIZE)));
  const costs = metas.map((meta) => ({ meta, pages: pagesFor(meta.holderCount) }));
  const known = costs.filter((c) => c.pages !== null);
  const unknown = costs.filter((c) => c.pages === null);

  if (!known.length) {
    return {
      strategy: OVERLAP_STRATEGIES.FULL,
      base: null,
      reason: `No holder count could be read for these tokens, so each list was walked up to ${countWords(pagesEach, "page")} and whether that covered the whole list was measured from the indexer's own paging rather than assumed.`,
    };
  }

  const totalPages = known.reduce((acc, c) => acc + c.pages, 0);
  const allFit = !unknown.length && known.every((c) => c.pages <= pagesEach);
  if (allFit) {
    // The estimate is stated rather than acted on: it is what a truncated walk will
    // be explained by, and MEASURED_PAGE_COST_MS says why the clock is not a demotion.
    const estimate = Math.round((totalPages * MEASURED_PAGE_COST_MS) / 1000);
    return {
      strategy: OVERLAP_STRATEGIES.FULL,
      base: null,
      reason: `Every holder list is small enough to read in full: ${known.map((c) => `${tokenLabel(c.meta)} ${countWords(c.meta.holderCount, "holder")} (${countWords(c.pages, "page")})`).join(", ")}, ${countWords(totalPages, "page")} in total — roughly ${estimate}s of reading at the ${Math.round(MEASURED_PAGE_COST_MS / 100) / 10}s a holder page measures on this indexer, so a cold cache may not finish it and whether it did is reported per list rather than assumed.`,
    };
  }

  // The base is the smallest list: every wallet holding all of these tokens must
  // appear in it, so it is the only list that has to be read at all.
  const base = known.reduce((a, b) => (b.meta.holderCount < a.meta.holderCount ? b : a));
  const tooBig = costs.filter((c) => c !== base && (c.pages === null || c.pages > maxPages));
  // TWO REASONS TO READ ONE LIST INSTEAD OF ALL OF THEM, and they are different facts
  // about the question: a list nobody could page through at all is not the same as a
  // set of lists that add up past what one request may spend.
  const why = tooBig.length
    ? `${tooBig.map((c) => `${tokenLabel(c.meta)} ${c.meta.holderCount === null ? "has an unreadable holder count" : `has ${countWords(c.meta.holderCount, "holder")} (${countWords(c.pages, "page")})`}`).join(" and ")}, which cannot be read inside one request`
    : `the lists together come to ${countWords(totalPages, "page")}, past the ${countWords(MAX_TOTAL_PAGES, "page")} one request may spend`;
  return {
    strategy: OVERLAP_STRATEGIES.SMALLEST,
    base: base.meta,
    // Sentence-cased, because overlapReading quotes this after a full stop of its own
    // ("Method: … through its own portfolio. the lists come to 13 pages") and a clause
    // written to sit mid-sentence reads as a typo once something puts a stop in front
    // of it. A leading token symbol is already upper case and is unaffected.
    reason: `${why.charAt(0).toUpperCase()}${why.slice(1)}. So the SMALLEST list was read instead — ${tokenLabel(base.meta)}, ${countWords(base.meta.holderCount, "holder")} — and each of its holders was checked against the other token${metas.length > 2 ? "s" : ""} through its own portfolio, up to ${countWords(maxCandidates, "candidate")}. Every wallet holding all of these tokens must hold the smallest one, so nothing is missed by not reading the larger list${metas.length > 2 ? "s" : ""}.`,
  };
}

/**
 * STRATEGY A — read every list, intersect them.
 *
 * The lists are walked CONCURRENTLY (each walk is internally sequential, because a
 * cursor cannot be guessed), which is at most MAX_TOKENS walks in flight — well
 * inside what this indexer answers, and the difference between 13 calls in series
 * and 13 in three waves.
 *
 * Exactness is the AND of every list's completeness. One truncated list is enough
 * to make the whole answer a lower bound, because a wallet missing from that list
 * is missing from the intersection.
 */
async function runFullIntersection(metas, { calls, timeoutMs, maxPages, retry }) {
  const lists = await Promise.all(
    metas.map((meta) => readHolderList(meta.address, { calls, timeoutMs, maxPages, retry })),
  );
  const byToken = new Map(lists.map((l) => [l.token, l]));

  // Intersect starting from the SHORTEST list read: the result is the same either
  // way and the loop is bounded by the smaller set.
  const smallest = lists.reduce((a, b) => (b.balances.size < a.balances.size ? b : a));
  const found = [];
  for (const [address, rawBalance] of smallest.balances) {
    const positions = [];
    let inAll = true;
    for (const meta of metas) {
      const list = byToken.get(meta.address);
      const raw = list === smallest ? rawBalance : list.balances.get(address);
      if (!list.balances.has(address)) {
        inAll = false;
        break;
      }
      positions.push(positionOf(meta, raw, "holder_list"));
    }
    if (inAll) found.push({ address, positions });
  }

  return {
    lists,
    found,
    exact: lists.every((l) => l.complete),
    candidates: null,
  };
}

/**
 * STRATEGY B — read the smallest list, ask each candidate for its own portfolio.
 *
 * ONE CALL SETTLES A CANDIDATE AGAINST EVERY OTHER TOKEN, because
 * /addresses/{a}/token-balances returns the wallet's whole token list in one body
 * (14 rows for the measured wallet). That is what makes this scale with the small
 * set: 150 candidates against a 52,214-holder token is 150 calls, not 1,045.
 *
 * A FAILED PROBE IS UNKNOWN, NOT A MISS. An address whose portfolio did not come
 * back is neither in nor out of the overlap — it goes in `candidates.unknown` with
 * its reason and it makes the whole answer a lower bound, because treating it as
 * "does not hold" is exactly the silent shrink this codebase exists to refuse.
 *
 * EVERY CANDIDATE IS PROBED, INCLUDING THE ONES THAT WILL TURN OUT NOT TO BE
 * WALLETS. Skipping the pool would save a call, but knowing which address is the
 * pool takes the RPC sweep that is deliberately running CONCURRENTLY with this
 * (see holderOverlap), and blocking sixty probes behind a factory sweep to save two
 * of them is the wrong trade. Probing everything also keeps `excluded` meaning the
 * same thing under both strategies: an address that holds every token asked about
 * and is still not a position.
 */
async function runSmallestSetProbe(metas, plan, { calls, timeoutMs, maxPages, maxCandidates, concurrency, retry }) {
  const base = plan.base ?? metas[0];
  const baseMeta = metas.find((m) => m.address === base.address) ?? metas[0];
  const others = metas.filter((m) => m.address !== baseMeta.address);
  const list = await readHolderList(baseMeta.address, { calls, timeoutMs, maxPages, retry });

  // Largest balance first, so a cap that bites drops the smallest positions rather
  // than an arbitrary slice — the majority holder is never the one lost to a bound.
  const ordered = [...list.balances.entries()]
    .map(([address, raw]) => ({ address, raw, amount: amountNumber(raw, baseMeta.decimals) }))
    .sort((a, b) => {
      const aa = a.amount === null ? -Infinity : a.amount;
      const bb = b.amount === null ? -Infinity : b.amount;
      if (bb !== aa) return bb - aa;
      return a.address < b.address ? -1 : 1;
    });

  const probe = ordered.slice(0, maxCandidates);
  const results = await mapPooled(probe, concurrency, async (candidate) => {
    if (outOfTimeFor(PROBE_MIN_MS)) {
      noteBudgetSkip("holderOverlap");
      return { ...candidate, ok: false, reason: "this candidate was not checked because the request ran short of time — whether it holds the other tokens is unknown, not no" };
    }
    const res = await attempt(() => calls.getAddressTokenBalances(candidate.address, deadline(timeoutMs)));
    if (!res.ok) {
      return {
        ...candidate,
        ok: false,
        reason: `the indexer did not answer for this candidate's holdings${res.status ? ` (HTTP ${res.status})` : ""}, so whether it holds the other tokens is unknown, not no`,
      };
    }
    const held = new Map();
    for (const entry of itemsOf(res.value)) {
      const address = lowerAddress(entry?.token ?? entry?.token_address);
      if (!address) continue;
      held.set(address, entry);
    }
    return { ...candidate, ok: true, held, reason: null };
  });

  const found = [];
  const unknown = [];
  let probed = 0;
  for (const r of results) {
    if (!r) continue;
    if (!r.ok) {
      unknown.push({ address: r.address, reason: r.reason });
      continue;
    }
    probed += 1;
    if (!others.every((meta) => r.held.has(meta.address))) continue;
    const positions = [positionOf(baseMeta, r.raw, "holder_list")];
    for (const meta of others) {
      const entry = r.held.get(meta.address);
      // The portfolio carries the token's own decimals; the token body is the more
      // authoritative source and is used when it answered, so a wallet's share is
      // never computed against a supply and a precision from different places.
      positions.push(positionOf(meta, entry?.value ?? null, "portfolio"));
    }
    found.push({ address: r.address, positions });
  }

  const complete = list.complete && probe.length === ordered.length && unknown.length === 0;
  return {
    lists: [list],
    found,
    exact: complete,
    candidates: {
      base: baseMeta.address,
      baseSymbol: baseMeta.symbol,
      probed,
      attempted: probe.length,
      of: ordered.length,
      // Two separate bounds, because they are two separate reasons the answer is
      // not the whole story: the base list may be part-read, and the candidates from
      // it may be part-checked.
      listComplete: list.complete,
      complete,
      unknown,
      unknownCount: unknown.length,
      reason: complete
        ? null
        : [
            list.complete ? null : list.reason,
            probe.length < ordered.length
              ? `${countWords(probe.length, "candidate")} of the ${countWords(ordered.length, "holder")} read from ${tokenLabel(baseMeta)} were checked against the other token${others.length > 1 ? "s" : ""}; the rest are unknown rather than excluded`
              : null,
            unknown.length ? `${countWords(unknown.length, "candidate")} could not be read at all and ${unknown.length === 1 ? "is" : "are"} unknown — not counted as holding, and not counted as not holding` : null,
          ]
            .filter(Boolean)
            .join(". "),
    },
  };
}

/**
 * EVERY REASON THIS ANSWER IS SHORT OF THE WHOLE TRUTH, in one clause, or null.
 *
 * BOTH SOURCES, and that is the bug this exists to close. The empty-overlap sentence
 * used to quote the incomplete LISTS only, so a run whose base list was read in full
 * and whose CANDIDATES were half-probed produced "the read was NOT complete ()" —
 * empty parentheses where the explanation belongs. Measured live: PIPECAT's 140
 * holders all read, 27 of 60 candidates answered, 33 refused by the indexer, and the
 * one sentence that had to say why said nothing at all.
 *
 * Null rather than an empty string, so the caller omits the parenthetical instead of
 * printing an empty one — an unexplained bound still reads as a bound, but an empty
 * bracket reads as a bug and invites the reader to trust the figure in front of it.
 *
 * DEDUPED, because the two sources overlap on purpose: the probe run's own reason
 * already opens with the base list's reason when that list was part-read, so quoting
 * both printed the same sentence twice in one bracket. A caveat repeated verbatim
 * reads as two separate problems and gets skimmed as boilerplate.
 */
function truncationReasons(run) {
  const seen = new Set();
  for (const reason of [...run.lists.filter((l) => !l.complete).map((l) => l.reason), run.candidates?.reason]) {
    if (!reason) continue;
    // Split so a compound probe reason still dedupes against the list reason inside it.
    for (const clause of String(reason).split(". ")) {
      const trimmed = clause.trim().replace(/\.$/, "");
      if (trimmed) seen.add(trimmed);
    }
  }
  return seen.size ? [...seen].join("; ") : null;
}

/**
 * The sentence a reader gets, with the bound and the denominators inside it.
 *
 * FOUR DIFFERENT ANSWERS, and the empty ones are the pair that matter: a measured
 * zero ("both lists were read in full and share nobody") is a finding, and an
 * unread zero ("nothing turned up in the part we read") is not. Collapsing them
 * into "no overlap found" would state the second as the first, which is the same
 * class of error as reading an outage as an absence.
 */
function overlapReading({ metas, plan, run, wallets, excluded, exact, pools, rows }) {
  const names = metas.map((m) => tokenLabel(m));
  const pair = names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const parts = [];
  const shortfall = truncationReasons(run);

  if (!wallets.length) {
    parts.push(
      exact
        ? `No wallet holds ${pair}. Every holder list was read in full, so this is a MEASURED zero — the tokens genuinely share no holder — rather than a lookup that came up short.`
        : `No overlapping wallet was found in the part of the data that could be read, and the read was NOT complete${shortfall ? ` (${shortfall})` : ""}. That is not a finding that nothing overlaps: the wallets not read are unknown, and one of them may well hold ${pair}.`,
    );
  } else {
    const top = wallets[0];
    parts.push(
      exact
        ? `Exactly ${countWords(wallets.length, "wallet")} hold ${pair}. Every holder list was read in full, so this is the complete set.`
        : `AT LEAST ${countWords(wallets.length, "wallet")} hold ${pair} — a LOWER BOUND, not the complete set, because the reads behind it were cut short${shortfall ? ` (${shortfall})` : ""}. There may be more; there are not fewer.`,
    );
    if (top.largestShare) {
      parts.push(
        `The largest position among them is ${shortHex(top.address)}, holding ${top.largestShare.display}${top.positions.length > 1 ? ` alongside ${top.positions.filter((p) => p.token !== top.largestShare.token).map((p) => `${p.amountDisplay ?? "an unread amount"} ${p.symbol || shortHex(p.token)}`).join(" and ")}` : ""}.`,
      );
    }
  }

  parts.push(
    plan.strategy === OVERLAP_STRATEGIES.FULL
      ? `Method: every token's holder list was read and intersected. ${plan.reason}`
      : `Method: the smallest holder list was read and each of its holders checked against the other token${metas.length > 2 ? "s" : ""} through its own portfolio. ${plan.reason}`,
  );

  if (Array.isArray(rows) && rows.length < wallets.length) {
    parts.push(
      `${countWords(rows.length, "row")} of the ${countWords(wallets.length, "wallet")} found ${rows.length === 1 ? "is" : "are"} listed below, largest position first — the rest are counted in the figure above and not printed.`,
    );
  }
  if (excluded.length) {
    parts.push(
      `${countWords(excluded.length, "address")} in the intersection ${excluded.length === 1 ? "is" : "are"} not a wallet with a position and ${excluded.length === 1 ? "is" : "are"} not counted above: ${excluded.map((e) => `${shortHex(e.address)} (${e.roleReason ?? e.role})`).join(", ")}.`,
    );
  }
  if (pools.caveat) parts.push(pools.caveat);
  if (pools.v4Caveat) parts.push(pools.v4Caveat);
  const unread = metas.filter((m) => !m.read);
  if (unread.length) {
    parts.push(
      `${countWords(unread.length, "token")} could not be read at all (${unread.map((m) => shortHex(m.address)).join(", ")}), so ${unread.length === 1 ? "its symbol, supply and holder count are" : "their symbols, supplies and holder counts are"} unknown and the shares of supply below are missing rather than zero.`,
    );
  }
  parts.push(
    "What this measures is CURRENT CO-HOLDING — these wallets hold every token named, as of now. It is not a finding that they bought them, and not a finding that they act together.",
  );
  return parts.join(" ");
}

/**
 * WHEN each overlapping wallet FIRST RECEIVED each token — opt-in, bounded, and
 * carefully not called a purchase.
 *
 * WHY IT IS OPT-IN. It is one indexer call per wallet PER TOKEN on top of
 * everything above, so a two-token overlap of ten wallets is twenty extra calls.
 * The overlap itself answers the question that was asked; this answers the follow-up
 * ("did they get in at the same time"), and only when a caller asks for it.
 *
 * WHY IT REUSES holderFirstAcquisition. That function already does the bounded,
 * concurrent, cached, budget-checked per-holder probe, and — more importantly — it
 * already knows that a full transfer page means the true first acquisition is
 * EARLIER (a lower bound, "at least N days") and that an empty read is UNKNOWN
 * rather than a fresh buy. Re-deriving either of those here would be re-deriving
 * the two claims most likely to come out false.
 *
 * WHAT IT IS NOT, and this is the sentence the whole leg exists to keep honest: the
 * oldest inbound transfer of a token is an ACQUISITION. A purchase, an airdrop, a
 * migration and a transfer from the same person's other wallet are indistinguishable
 * from it. Nothing here reports a buy.
 */
async function overlapAcquisitions(rows, metas, options) {
  const addresses = rows.slice(0, MAX_HOLDERS_PROBED);
  if (!addresses.length) {
    return {
      ran: false,
      reason: "there were no overlapping wallets to look up",
      note: null,
      wallets: [],
    };
  }
  if (outOfTimeFor(PROBE_MIN_MS)) {
    noteBudgetSkip("holderOverlapAcquisitions");
    return {
      ran: false,
      reason: "the request ran short of time, so first acquisitions were not read — that is not a finding that these wallets acquired at the same time, or at different times",
      note: null,
      wallets: [],
    };
  }

  const passes = await Promise.all(
    metas.map((meta) =>
      holderFirstAcquisition(meta.address, {
        holders: addresses.map((r) => ({
          address: r.address,
          percent: r.positions.find((p) => p.token === meta.address)?.percent ?? null,
        })),
        calls: options.calls,
        client: options.client,
        resolvePool: options.resolvePool,
        now: options.now,
        timeoutMs: options.timeoutMs,
      }),
    ),
  );

  const wallets = addresses.map((row) => ({
    address: row.address,
    tokens: metas.map((meta, i) => {
      const pass = passes[i];
      const probe = pass.ok ? pass.holders.find((h) => h.address === row.address) : null;
      return {
        token: meta.address,
        symbol: meta.symbol,
        status: probe?.status ?? "unknown",
        firstBlock: probe?.firstBlock ?? null,
        firstTimestamp: probe?.firstTimestamp ?? null,
        // The qualifier is inside the string, from lib/holder-history.js holdWords.
        heldForDisplay: probe?.holdDisplay ?? null,
        isLowerBound: Boolean(probe?.isLowerBound),
        reason: probe?.reason ?? pass.error ?? "this wallet's history with this token was not read",
      };
    }),
  }));

  return {
    ran: true,
    reason: null,
    probedWallets: addresses.length,
    ofWallets: rows.length,
    wallets,
    note: "These are the oldest INBOUND transfers of each token that could be read for each wallet — an ACQUISITION, not a purchase. A buy, an airdrop, a contract migration and a transfer from the same person's other wallet all look identical from here, and a figure marked as a lower bound means the wallet's history ran past the one page read, so it acquired the token EARLIER than the block shown.",
  };
}

/* ----------------------------- 2. co-holdings ----------------------------- */

/**
 * WHAT ELSE THIS TOKEN'S TOP HOLDERS HOLD — the natural follow-up to an overlap,
 * and the question "what are these wallets also in".
 *
 * ONE CALL PER HOLDER, because /addresses/{a}/token-balances returns the wallet's
 * whole portfolio in one body. Ten holders is ten calls, all cached, so asking this
 * after an overlap of the same wallets costs nothing.
 *
 * THE DENOMINATORS ARE THE ANSWER'S BACKBONE. A token appearing in 4 of 10 probed
 * holders is a fact about four wallets. If the subject has 52,214 holders, it is
 * NOT a fact about the token's holder base, and the temptation to write "40% of
 * holders also hold X" is exactly the claim this function refuses to support:
 * `coverage` carries how many were probed, out of how many were read, out of how
 * many exist, and the reading says which of those the figure speaks for.
 *
 * A FAILED PROBE SHRINKS NOTHING. A wallet whose portfolio did not come back is
 * counted in `probeFailed`, not silently dropped from a denominator — otherwise
 * "3 of 3" would quietly replace "3 of 10" and read as unanimity.
 *
 * @param {string} token - the subject token contract
 * @param {{ calls?: object, client?: object, resolvePool?: Function, limit?: number,
 *   timeoutMs?: number, concurrency?: number }} [options]
 * @returns {Promise<object>}
 */
export async function coHoldings(token, options = {}) {
  const calls = { ...DEFAULT_CALLS, ...(options.calls && typeof options.calls === "object" ? options.calls : {}) };
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : ENRICHMENT_TIMEOUT_MS;
  const concurrency = Number.isInteger(options.concurrency) && options.concurrency > 0 ? options.concurrency : PROBE_CONCURRENCY;
  const limit = clampCount(options.limit, DEFAULT_COHOLDING_HOLDERS, MAX_COHOLDING_HOLDERS);

  const subject = lowerAddress(token);
  if (!subject) {
    return {
      ok: false,
      error: `"${String(token ?? "").slice(0, 64)}" is not a token contract address, so there is nothing to read holders for. An address is 0x followed by exactly 40 hex characters.`,
    };
  }

  const unavailable = [];
  const metaPromise = tokenMeta(subject, calls, TIMEOUT_MS);
  const holdersPromise = attempt(() => calls.getTokenHolders(subject, { items_count: limit }, deadline(timeoutMs)));
  const poolPromise = tokenPoolAddresses(subject, {
    client: options.client,
    calls: options.calls,
    resolvePool: options.resolvePool,
    resolveV4PoolManager: options.resolveV4PoolManager,
  });

  const meta = await metaPromise;
  if (!meta.read) unavailable.push("token");
  const holdersRes = await holdersPromise;
  if (!holdersRes.ok) {
    return unavailableError(`the holders of ${tokenLabel(meta)}`, holdersRes.status);
  }

  const items = itemsOf(holdersRes.value);
  const pools = await poolPromise;
  if (pools.status === "unread") unavailable.push("pool_identification");
  if (pools.v4.status === "unread") unavailable.push("v4_pool_identification");

  // Labelled and kept, the lib/holder-history.js convention: a pool, a burn sink or
  // the contract stays visible so the rows reconcile against the explorer's list,
  // and is kept out of the aggregate — "what these wallets are also in" must not be
  // answered with a pool's other liquidity.
  const ranked = [];
  const excluded = [];
  for (const item of items.slice(0, limit)) {
    const address = lowerAddress(item?.address);
    if (!address) continue;
    const { role, reason, poolVersion } = classifyRole(address, {
      token: subject,
      pools: pools.pools,
      v4PoolManager: pools.v4.address,
    });
    const row = {
      address,
      role,
      roleReason: reason,
      poolVersion,
      position: positionOf(meta, item?.value ?? null, "holder_list"),
    };
    if (role === HOLDER_ROLES.HOLDER) ranked.push(row);
    else excluded.push(row);
  }

  const probes = await mapPooled(ranked, concurrency, async (row) => {
    if (outOfTimeFor(PROBE_MIN_MS)) {
      noteBudgetSkip("coHoldings");
      return { address: row.address, ok: false, reason: "this holder's other holdings were not read because the request ran short of time — unknown, not none" };
    }
    const res = await attempt(() => calls.getAddressTokenBalances(row.address, deadline(timeoutMs)));
    if (!res.ok) {
      return {
        address: row.address,
        ok: false,
        reason: `the indexer did not answer for this holder's holdings${res.status ? ` (HTTP ${res.status})` : ""} — unknown, not none`,
      };
    }
    return { address: row.address, ok: true, entries: itemsOf(res.value), reason: null };
  });

  const probed = probes.filter((p) => p?.ok);
  const failed = probes.filter((p) => p && !p.ok).map((p) => ({ address: p.address, reason: p.reason }));
  if (failed.length) unavailable.push("holderPortfolios");

  // The aggregate. Keyed by contract, because two tokens can share a symbol on this
  // chain and a tally keyed by symbol would merge an impostor into the real one.
  const byToken = new Map();
  for (const p of probed) {
    for (const entry of p.entries) {
      const t = entry?.token && typeof entry.token === "object" ? entry.token : {};
      const address = lowerAddress(entry?.token ?? entry?.token_address);
      // The subject itself is not something "else" these wallets hold.
      if (!address || address === subject) continue;
      const decimals = finiteOrNull(t.decimals);
      const row =
        byToken.get(address) ??
        {
          address,
          symbol: typeof t.symbol === "string" ? t.symbol.slice(0, 16) : null,
          name: typeof t.name === "string" ? t.name.slice(0, 72) : null,
          type: t.type ?? null,
          decimals: decimals ?? 18,
          decimalsAssumed: decimals === null,
          holders: 0,
          wallets: [],
        };
      const amount = amountNumber(entry?.value, row.decimals);
      row.holders += 1;
      row.wallets.push({
        address: p.address,
        balance: entry?.value == null ? null : String(entry.value),
        amount,
        amountDisplay: fmtTokenAmount(entry?.value, row.decimals),
      });
      byToken.set(address, row);
    }
  }

  const shared = [...byToken.values()]
    .map((row) => {
      const known = row.wallets.map((w) => w.amount).filter((n) => typeof n === "number" && Number.isFinite(n));
      return {
        ...row,
        // The denominator, on every row: "held by 4 of the 8 holders probed".
        ofProbed: probed.length,
        sharedDisplay: `${row.holders} of the ${probed.length} probed holder${probed.length === 1 ? "" : "s"}`,
        // A total over the amounts that could be read, with how many that was —
        // never a sum that treats an unreadable balance as zero.
        totalAmount: known.length ? known.reduce((acc, n) => acc + n, 0) : null,
        totalAmountCounted: known.length,
        totalAmountOf: row.wallets.length,
      };
    })
    .sort((a, b) => (b.holders !== a.holders ? b.holders - a.holders : a.address < b.address ? -1 : 1));

  const coverage = {
    probed: probed.length,
    attempted: ranked.length,
    holdersRead: items.length,
    holderCount: meta.holderCount,
    holderCountDisplay: meta.holderCountDisplay,
    probeFailed: failed.length,
    failures: failed,
    excludedCount: excluded.length,
    // Only true when the token's whole holder base was probed, which for anything
    // past MAX_COHOLDING_HOLDERS holders it never is.
    complete: meta.holderCount !== null && probed.length >= meta.holderCount,
  };

  return {
    ok: true,
    measured: "current_co_holding",
    token: subject,
    symbol: meta.symbol,
    name: meta.name,
    holderCount: meta.holderCount,
    holderCountDisplay: meta.holderCountDisplay,
    probedHolders: ranked.map((r) => ({ address: r.address, position: r.position })),
    excluded,
    excludedCount: excluded.length,
    excludedNote: excluded.length
      ? "A liquidity pool, a burn sink and the token's own contract sit in a balance-ranked holder list and are not wallets with a position. They are listed here and their other balances are NOT in the tally below — a pool's holdings are the market's, not a trader's."
      : null,
    tokens: shared,
    tokenCount: shared.length,
    coverage,
    unavailable,
    reading: coHoldingsReading({ meta, shared, coverage, excluded, pools }),
    disclaimer:
      "This is what a bounded sample of the top holders by balance ALSO HOLD right now. It is not a finding about the token's holder base, not evidence that these wallets are connected, and not a claim that anybody bought anything — a balance can arrive by airdrop, migration or transfer. Two tokens sharing holders is unremarkable when both are widely held; it is worth a second look when the wallets involved hold a large share of both.",
    asOf: nowIso(),
  };
}

function coHoldingsReading({ meta, shared, coverage, excluded, pools }) {
  const label = tokenLabel(meta);
  const denominator =
    coverage.holderCount === null
      ? `${countWords(coverage.probed, "holder")} of ${label}'s holders (its total holder count could not be read, so what share of the token this covers is unknown)`
      : `${countWords(coverage.probed, "holder")} of ${label}'s ${countWords(coverage.holderCount, "holder")}`;
  const parts = [];

  if (!coverage.probed) {
    parts.push(
      `None of ${label}'s holders could be read for their other holdings, so there is nothing to report here — that is unread, not a finding that they hold nothing else.`,
    );
  } else if (!shared.length) {
    parts.push(
      `The ${denominator} that were probed — the top ones by balance — hold no other token between them, measured from their full portfolios. That is a measured empty result for those ${countWords(coverage.probed, "wallet")}, and says nothing about the holders that were not probed.`,
    );
  } else {
    const top = shared[0];
    parts.push(
      `Across ${denominator} — the top ones by balance — ${countWords(shared.length, "other token")} appear. The most widely shared is ${top.symbol || shortHex(top.address)}, held by ${top.sharedDisplay}.`,
    );
    parts.push(
      `Every count below is out of the ${countWords(coverage.probed, "wallet")} actually probed${coverage.holderCount === null ? "" : `, not out of the ${countWords(coverage.holderCount, "holder")} the token has`}. A token shared by a handful of the biggest wallets is a fact about those wallets${coverage.complete ? "" : " and not a pattern across the token"}.`,
    );
  }

  if (coverage.probeFailed) {
    parts.push(
      `${countWords(coverage.probeFailed, "holder")} could not be read at all and ${coverage.probeFailed === 1 ? "is" : "are"} missing from every count above — unknown holdings, not empty ones, so each figure here is a floor rather than a total.`,
    );
  }
  if (excluded.length) {
    parts.push(
      `${countWords(excluded.length, "address")} in the top list ${excluded.length === 1 ? "is" : "are"} not a holding position and ${excluded.length === 1 ? "was" : "were"} not probed: ${excluded.map((e) => `${shortHex(e.address)} (${e.roleReason ?? e.role})`).join(", ")}.`,
    );
  }
  if (pools.status === "unread") {
    parts.push(
      `This token's pool was not identified (${pools.reason ?? "the lookup did not settle"}), so one of the addresses probed above may in fact be a liquidity pool, whose holdings are the market's rather than a trader's.`,
    );
  }
  if (pools.v4?.status === "unread" && pools.status !== "unread") {
    // Its own sentence, because it is its own gap — and a sharper one here than
    // anywhere else: the v4 singleton's "other holdings" are every token trading on
    // v4, so tallying it as a holder would manufacture a shared portfolio out of a
    // market's inventory.
    parts.push(
      `Whether the Uniswap v4 PoolManager is among the holders probed was not established (${pools.v4?.reason ?? "the check did not settle"}). v4 holds every pool in one contract, so if that address is in the list above its balances are the market's inventory rather than a trader's portfolio.`,
    );
  }
  return parts.join(" ");
}

/* ------------------------- 3. one wallet's positions ---------------------- */

/**
 * ONE WALLET'S HOLDINGS ACROSS TOKENS — so "does this wallet hold X and Y" costs a
 * single call and needs no intersection at all.
 *
 * THE MEASURED FACT THAT MAKES THIS CHEAP: /addresses/{a}/token-balances returns
 * EVERY token the address holds in one body (14 rows for the wallet the user named).
 * So a named wallet's membership in any number of tokens is one read, which is why
 * the answer to "does 0x80fd… hold both" should never have cost a holder-list walk.
 *
 * ABSENCE IS MEASURED HERE, AND ONLY HERE. Because the body is the whole portfolio,
 * a token missing from it means this wallet does NOT hold that token — a real
 * negative, which is rare in this codebase and worth having. It holds only while
 * two things are true, and both are checked rather than assumed: the read
 * SUCCEEDED, and the body was not paged. A failed read returns an error rather than
 * an empty portfolio, and an unexpected cursor drops every `held` verdict to null
 * with a reason, because a partial portfolio can prove holding and cannot prove its
 * absence.
 *
 * @param {string} address - the wallet
 * @param {{ calls?: object, tokens?: Array<string>, timeoutMs?: number }} [options] -
 *   `tokens` asks the direct question: for each one, does this wallet hold it?
 * @returns {Promise<object>}
 */
export async function walletTokenPositions(address, options = {}) {
  const calls = { ...DEFAULT_CALLS, ...(options.calls && typeof options.calls === "object" ? options.calls : {}) };
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : TIMEOUT_MS;

  const self = lowerAddress(address);
  if (!self) {
    return {
      ok: false,
      error: `"${String(address ?? "").slice(0, 64)}" is not a wallet address, so its holdings cannot be looked up. An address is 0x followed by exactly 40 hex characters.`,
    };
  }

  const res = await attempt(() => calls.getAddressTokenBalances(self, deadline(timeoutMs)));
  if (!res.ok) {
    // NOT an empty portfolio. This is the one function whose negatives are load
    // bearing, so a read that did not happen must not produce any.
    return unavailableError(`the holdings of ${shortHex(self)}`, res.status);
  }

  // A cursor on this endpoint has never been observed, and if one ever appears the
  // body is a PAGE rather than a portfolio — enough to prove a holding, never
  // enough to prove its absence.
  const complete = !cursorParams(res.value?.next_page_params);
  const entries = itemsOf(res.value);
  const positions = [];
  const byToken = new Map();
  for (const entry of entries) {
    const t = entry?.token && typeof entry.token === "object" ? entry.token : {};
    const token = lowerAddress(entry?.token ?? entry?.token_address);
    if (!token) continue;
    const decimals = finiteOrNull(t.decimals);
    const priceUsd = finiteOrNull(t.exchange_rate);
    const amount = amountNumber(entry?.value, decimals ?? 18);
    // Both halves have to be real: an amount with no price and a price with no
    // readable amount are equally unvaluable, and neither is worth $0.
    const valueUsd = priceUsd !== null && amount !== null ? round2(amount * priceUsd) : null;
    const row = {
      token,
      symbol: typeof t.symbol === "string" ? t.symbol.slice(0, 16) : null,
      name: typeof t.name === "string" ? t.name.slice(0, 72) : null,
      type: t.type ?? null,
      balance: entry?.value == null ? null : String(entry.value),
      amount,
      amountDisplay: fmtTokenAmount(entry?.value, decimals ?? 18),
      priceUsd,
      priceDisplay: displayNumber(priceUsd, "price"),
      valueUsd,
      valueDisplay: displayNumber(valueUsd, "usd"),
      priced: valueUsd !== null,
      decimalsAssumed: decimals === null,
    };
    positions.push(row);
    byToken.set(token, row);
  }

  // The direct question, when one was asked.
  const asked = [];
  for (const t of Array.isArray(options.tokens) ? options.tokens : []) {
    const token = lowerAddress(typeof t === "string" ? t : t?.address ?? t);
    if (!token || asked.some((a) => a.token === token)) continue;
    const position = byToken.get(token) ?? null;
    asked.push({
      token,
      symbol: position?.symbol ?? null,
      // TRUE, FALSE or NULL — and null only when the portfolio came back paged, so
      // "no" is a measurement and never a failure wearing its clothes.
      held: position ? true : complete ? false : null,
      position,
      reason: position
        ? null
        : complete
          ? "this token is absent from the wallet's full token-balance list, so the wallet does not hold it — a measured absence"
          : "the wallet's token list came back paged rather than whole, so this token's absence from the part read proves nothing",
    });
  }

  const held = asked.filter((a) => a.held === true);
  const notHeld = asked.filter((a) => a.held === false);
  const unknown = asked.filter((a) => a.held === null);

  return {
    ok: true,
    measured: "current_holdings",
    address: self,
    positions: positions.sort((a, b) => {
      // Value order with the unpriced LAST rather than smallest: this indexer
      // quotes the issuer-verified equities and little else, so unpriced means
      // unquoted, not worthless.
      const av = a.valueUsd;
      const bv = b.valueUsd;
      if (av === null && bv === null) return (b.amount ?? -Infinity) - (a.amount ?? -Infinity);
      if (av === null) return 1;
      if (bv === null) return -1;
      return bv - av;
    }),
    count: positions.length,
    complete,
    asked,
    heldCount: held.length,
    notHeldCount: notHeld.length,
    unknownCount: unknown.length,
    unavailable: [],
    reading: [
      `${shortHex(self)} holds ${countWords(positions.length, "token")}${complete ? ", read from its full token-balance list in one call" : " in the page of its token list that came back — there may be more"}.`,
      asked.length
        ? `${
            unknown.length
              ? `Whether it holds ${unknown.map((a) => shortHex(a.token)).join(", ")} could not be established: ${unknown[0].reason}.`
              : ""
          }${held.length ? `It DOES hold ${held.map((a) => `${a.symbol || shortHex(a.token)} (${a.position.amountDisplay ?? "an unreadable amount"})`).join(" and ")}. ` : ""}${
            notHeld.length
              ? `It does NOT hold ${notHeld.map((a) => shortHex(a.token)).join(" or ")} — a measured absence, because this endpoint returns the wallet's whole token list rather than a page of it.`
              : ""
          }`.trim()
        : null,
      "These are current balances. They say what the wallet holds now, not what it bought, and not what it has already sold.",
    ]
      .filter(Boolean)
      .join(" "),
    asOf: nowIso(),
  };
}
