import { displayNumber, finiteOrNull } from "./format-number.js";
import { getPublicClient } from "./chain.js";
import { THIN_LIQUIDITY_USD, tokenMarketData } from "./dex-price.js";
import { priceCacheTtlMs, withIndexerCache } from "./indexer-cache.js";
import { clampTimeout, noteBudgetSkip, remainingWorkMs } from "./request-budget.js";

/**
 * WHICH CONTRACT WEARING A TICKER ACTUALLY HAS A MARKET — decided on realisable
 * depth, and on nothing else.
 *
 * TWO LEGS, NOT ONE. Depth is measured from the chain and corroboration from the
 * indexer's own trading record, they are reported separately, and a winner is only
 * named when both point at the same contract. Depth alone is a snapshot of capital
 * that can be withdrawn — see quoteDepth for the two attacks that made that
 * concrete — where a settled trade cannot be un-settled and a wash round trip pays
 * the pool fee every time. The two fail in different ways, which is the whole
 * reason for having both.
 *
 * THE MEASUREMENT THIS MODULE EXISTS FOR. Chain 4663 carries 229 DISTINCT
 * contracts whose symbol is exactly "VLAD". Industrial ticker squatting is the
 * normal case here, not an edge case. Surveying the eighteen with the most
 * holders and reading the quote side of each one's Uniswap v3 pool (the figures
 * below are the quote BALANCES the first survey took; the ranking figure is now
 * BAND DEPTH — see quoteDepth — which puts The Green Bull at $1,324.23 and leaves
 * the rest of the field under a dollar):
 *
 *   $69,583.29 | 1,334 holders  | The Green Bull 0x31be…bf81 | cap   $238,397
 *   $3.92      | 7,634 holders  | Vladhoods      0xbbdd…247c | cap   $405,629
 *   $2.52      | 2,500 holders  | The Robinhoods             | cap    $23,208
 *   $1.50      | 9,518 holders  | The Robinhood Guy          | cap   $828,456
 *   $1.03      | 52,214 holders | The Robinhood  0xfd58…d409 | cap $3,855,217
 *   $0.34      | 13,203 holders | Vladhood                   | cap   $288,996
 *   $0.00 ×5 more, and 7 more with no pool at all.
 *
 * EXACTLY ONE of the eighteen has more than $100 of realisable depth. Ten of the
 * eleven with pools have under $10.
 *
 * AN EARLIER DIAGNOSIS IN THIS PROJECT IS RETRACTED BY THAT TABLE. It held that
 * the indexer "happens to price whichever copycat" and that holder count should
 * therefore decide. The causation runs the other way: Blockscout prices The Green
 * Bull BECAUSE it is the one with a real market — its own figures (exchange_rate
 * 0.00024519, circulating cap $245,195.83) agree with our independent pool math
 * (price 0.00023840, cap $238,397) to within 3%, which is two separate
 * instruments measuring the same thing. Holder count is the actively HARMFUL
 * figure here: ranking on it hands VLAD to a contract with $1.03 of WETH behind a
 * $3.86M notional cap, over the one with $69.6K of capital genuinely at risk.
 * Airdrops make 52,214 holders cheap; pooled WETH is somebody's money.
 *
 * So the indexer pricing a token is CORROBORATION and never a verdict — it is
 * used to decide who gets measured first, and the measurement decides who wins.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not rank issuer-verified equities. Those
 * are settled by their deployer in lib/stock-tokens.js, which is a stronger fact
 * than any market figure, and no memecoin with a deep pool may outrank a real
 * equity sharing its ticker. Depth only ever separates candidates the tiers and
 * the issuer check have already tied.
 *
 * Server-side only: no React. The RPC client and the probe are both injectable,
 * so every path here is exercised offline in test/depth-rank.test.mjs.
 */

/* --------------------------------- limits -------------------------------- */

/**
 * How many contracts in a collision get their pool read. THE BOUND, and it is
 * the reason this is affordable at all.
 *
 * A depth probe is not one request, and it has got MORE expensive twice, on purpose
 * both times. It is a factory lookup for every fee tier of every verified quote
 * asset — twelve slots, swept in full rather than stopped at the first hit — then,
 * for each pool that exists, token0/token1/fee, slot0, liquidity(), tickSpacing and
 * the quote balance, then THE TICK LADDER (a bitmap word per 256 spacings across the
 * band, then one read per initialised tick inside it), then the target balance and a
 * decimals read per side for the winner.
 *
 * MEASURED LIVE ON CHAIN 4663, cold, through the batching client: FOUR concurrent
 * probes are 8.0s, 16 HTTP requests and 211 JSON-RPC calls, no 429s, all four
 * measured — inside the 12s cutoff, with less room than before. A repeat inside the
 * price TTL is zero.
 *
 * IT GOT DEARER WHEN THE LADDER STOPPED REFUSING, and the figure is restated rather
 * than left at the old 4.9s / 11 requests / 170 calls. A crowded pool used to cost
 * its bitmap words and no tick reads at all, because the budget cancelled the read;
 * capping instead means those reads are actually issued, and the stablecoin peg pools
 * are exactly the crowded ones. Three things paid most of it back: MAX_TICKS_READ is
 * sized to the ranking band (24, not 64), the peg check asks for the ranking band
 * ALONE and so reads a fifth of the tick range, and the batch is capped at 32 calls
 * per request because this endpoint answers 64 with a flat 429.
 *
 * THE LADDER COST ALMOST BLEW THE BUDGET, and the fix was DEPTH not width: the
 * stablecoin verification used to run BEFORE the WETH sweep, putting six serial
 * round trips in front of every lookup, and four concurrent probes then took over
 * 12s and every one of them reported unmeasured. lib/dex-price.js resolvePool now
 * runs the verification and the WETH sweep at the same time, and holds a verified
 * quote for minutes rather than seconds.
 *
 * WHY THE SWEEP IS WORTH PAYING FOR. Stopping at the first existing tier let anyone
 * capture our probe with one gas-only transaction and no capital — an empty pool at
 * an earlier tier, on a token they have nothing to do with (see lib/dex-price.js
 * FEE_TIERS). Ranking on the measurement is what makes the decoy worthless, and the
 * only way to rank is to look at all of them.
 *
 * WHAT PAYS FOR IT. Six probes at this read count would not fit: four of them
 * unbatched issued 131 separate HTTP requests before the ladder existed at all. The
 * bound is FOUR and poolReadClient batches, packing every call issued in the same
 * tick into one JSON-RPC array.
 *
 * FOUR IS ENOUGH BECAUSE OF WHAT IS AT THE FRONT. The cheap ordering (see
 * depthShortlist) puts any contract the indexer independently prices first, which
 * on the measured census is exactly the contract that wins — The Green Bull is
 * position 1 of 229 — and a live run confirms it: 4 measured of the 33 rows the
 * explorer returned, verdict dominant, $1,324.23 of band depth against $0.31, with
 * the indexer's $2,990.70 of 24h volume on the same contract.
 *
 * WHAT IT DROPS is reported, never hidden: `attempted`, `measured`, `failed` and
 * `dropped` all travel with the verdict, as four separate quantities, so an answer
 * can say "4 measured of 229 returned" rather than implying the field was swept.
 * A dropped candidate is unmeasured, which is not the same as shallow.
 */
export const MAX_DEPTH_PROBES = 4;

/**
 * The floor a contract's realisable depth must clear before it counts as a market
 * anyone could be choosing between.
 *
 * Same number as lib/dex-price.js THIN_LIQUIDITY_USD, and imported rather than
 * repeated: "too thin for the price to mean much" and "too thin to be a contender"
 * are the same judgement, and two constants that drifted apart would let a token
 * be a contender here and thin there in the same answer.
 *
 * THE MARGIN AGAINST IT SHRANK WHEN THE MEASURE GOT HONEST, and that is stated
 * rather than papered over. Under the old balance figure The Green Bull cleared this
 * floor 26× over; measured as band depth it clears it 1.3×, because $69,679 of HELD
 * WETH is only a few hundred dollars of realisable depth near the market.
 *
 * THE FLOOR MOVED ONCE, WITH THE MEASURE AND NOT AHEAD OF IT. The ranking figure is
 * now the -2% band rather than the -10% one, which is a strictly smaller quantity on
 * the same pool, so the number was re-expressed in the new units — $1,000 to $200, by
 * the band geometry, derived and justified at lib/dex-price.js THIN_LIQUIDITY_USD.
 * The test of whether that was a concession is the MARGIN, and the margin did not
 * move: 1.32× before ($1,324.23 against $1,000), 1.30× after ($259.33 against $200).
 * The Green Bull is still the only contract wearing VLAD that clears it, and it still
 * clears it barely.
 *
 * If the pool thins past it the verdict becomes "shallow", and the corroboration leg
 * is what stops that from being reported as an absence: the indexer's volume for that
 * contract sets `tradingContradiction`, and the answer then states both figures and
 * says they disagree instead of claiming nothing wearing VLAD has a market.
 */
export const MEANINGFUL_DEPTH_USD = THIN_LIQUIDITY_USD;

/**
 * How far ahead the deepest pool has to be before the question is CLOSED.
 *
 * Justified by the measured distribution, which stayed extremely lopsided through
 * two changes of measure: on the -10% band, $1,324.23 against a next-deepest $0.31,
 * a gap of 4,316×; on the -2% band that now ranks, $259.33 against $3.88, a gap of
 * 67×. So any threshold in the low tens answers VLAD directly. Ten is chosen
 * rather than a hundred because it is the point where a reader would genuinely want
 * a say: $50K against $30K of realisable depth is two live markets and picking one
 * silently answers a question nobody asked, where $50K against $2K is not.
 *
 * A MENU FOR A CASE AS CLEAR-CUT AS VLAD WOULD BE ITS OWN FAILURE. The threshold
 * exists to make asking rare, not to make it safe.
 */
export const DOMINANCE_RATIO = 10;

/**
 * When a market cap is this many times its own realisable depth, the cap may not
 * be quoted on its own.
 *
 * Measured on the OLD balance figure: The Robinhood posted a $3,855,217 cap on
 * $1.03 of WETH — 3.7 million times — and The Green Bull $238,397 on $69,583.29,
 * 3.4 times. A hundred sat in the empty space between them.
 *
 * ON BAND DEPTH THE RULE NOW FIRES FOR THE GREEN BULL TOO — $234,330 against the
 * -2% figure of $259.33 is 903×, and it fired at 177× against the -10% figure it
 * used to be read on — AND THE THRESHOLD IS DELIBERATELY NOT MOVED TO SILENCE IT.
 * The sentence it produces is true of that contract: you cannot realise $234K out
 * of a pool that gives up $259 before the price has fallen 2%. Retuning the
 * constant so the one legitimate token reads clean would be choosing the flattering
 * number over the measured one, which is the failure this whole module exists to
 * undo. The notice says explicitly that thin depth is a fact about a pool and not
 * evidence of a scam; that is what keeps it fair, not suppressing it.
 */
export const CAP_TO_DEPTH_RATIO = 100;

/** Per-probe cutoff. Sized like lib/ask-evidence.js POOL_TIMEOUT_MS, per token. */
export const DEPTH_PROBE_TIMEOUT_MS = 12_000;

/**
 * The least remaining request time that makes ONE probe worth starting.
 *
 * Measured cold on chain 4663: four concurrent probes are 8.0s and a single one is
 * a little over five, because most of the cost is the serial half — the quote-asset
 * verification and the factory sweep — which every probe pays and none of them
 * shares. Below this there is no probe that can finish, and starting one anyway
 * buys a timeout that reports as an outage: "the pool could not be read" about a
 * pool nobody really asked. Not starting it and SAYING SO is the honest version of
 * the same shortage. See lib/request-budget.js.
 */
export const DEPTH_PROBE_FLOOR_MS = 6_000;

/**
 * What each ADDITIONAL concurrent probe adds to that.
 *
 * Probes run together, so the cost is not linear — 8.0s for four against ~5.5s for
 * one is roughly 800ms each on top of a fixed base. 1.5s is that with margin, and
 * the margin is deliberately on the pessimistic side: over-estimating the cost
 * measures three contracts instead of four, where under-estimating it measures none
 * of them because the request was killed. A smaller measured sample is a verdict
 * that says so; a killed request is a 504.
 */
export const DEPTH_PROBE_MARGINAL_MS = 1_500;

/**
 * How many probes the REMAINING request time can pay for, out of the `bound` the
 * caller asked for.
 *
 * Fewer candidates probed when time is short, rather than probes started that
 * cannot finish. The distinction matters to what the answer may claim: a probe
 * never started leaves its contract UNMEASURED and the count of measurements is
 * honestly smaller, where a probe started and killed arrives as `failed`, which
 * reads as "the chain did not answer" about an endpoint that was answering fine.
 *
 * With no budget open this returns `bound` unchanged, so every test and script
 * probes exactly what it always did.
 *
 * @param {number} bound
 * @returns {number} 0 when there is no time to measure anything
 */
export function affordableDepthProbes(bound) {
  const want = Number.isInteger(bound) && bound > 0 ? bound : MAX_DEPTH_PROBES;
  const left = remainingWorkMs();
  if (!Number.isFinite(left)) return want;
  if (left < DEPTH_PROBE_FLOOR_MS) return 0;
  const extra = Math.floor((left - DEPTH_PROBE_FLOOR_MS) / DEPTH_PROBE_MARGINAL_MS);
  return Math.max(0, Math.min(want, 1 + extra));
}

/* ------------------------------ small helpers ---------------------------- */

/**
 * A candidate's BAND DEPTH in dollars, or null. Never coerced to zero.
 *
 * The field is lib/dex-price.js's `quoteLiquidityUsd`, and what it measures has
 * changed twice. It was the pool's quote BALANCE, which counted positions parked
 * out of range — depth that could be rented rather than bought. It then became
 * min(balance, the reserve implied by liquidity()), which was not a bound on
 * anything: the two halves are computed over disjoint sets of positions, so a
 * hair-width position plus a parked one defeated the minimum for about $3 a day.
 *
 * It is now the integral of the TICK LADDER across a price band — the quote a
 * seller could actually realise before the price has moved RANK_BAND_BPS (-2%)
 * against them — the tight band, because capital sitting at the edge of the wide one
 * counts toward it in full and is never traded through.
 * See lib/tick-depth.js, which also states plainly what that does not prove.
 */
export function quoteDepth(candidate) {
  return finiteOrNull(candidate?.quoteLiquidityUsd);
}

/**
 * IS THAT FIGURE EXACT, OR ONLY "AT LEAST THIS MUCH"?
 *
 * lib/tick-depth.js caps the tick walk at a read budget rather than refusing, so a
 * pool with more initialised ticks in the band than the budget pays for comes back
 * as a genuine integral over a shorter interval — a LOWER BOUND. That is the right
 * answer (an attacker minting dust into someone else's pool can shorten the range
 * and nothing more) and it changes what the ranking may CONCLUDE:
 *
 *   - a lower bound that already beats every rival WINS OUTRIGHT: the true figure is
 *     at least this, so beating the field by this much is beating it by more.
 *   - a lower bound on a RIVAL settles nothing: the rival could be deeper than the
 *     leader, so the ordering is not established and no dominance may be claimed.
 *   - a lower bound may never establish an ABSENCE: "nothing cleared the floor" is
 *     not something a figure that understates can demonstrate.
 *
 * Absent flag means exact — every path that produces one sets it explicitly.
 */
export function depthIsLowerBound(candidate) {
  return candidate?.depthIsLowerBound === true;
}

/**
 * The indexer's 24H VOLUME for a contract — the second leg, and the one depth
 * cannot supply.
 *
 * WHY A SECOND LEG AT ALL. Band depth is a SNAPSHOT of capital that is present
 * right now, and capital can be moved in for a block and out again; realised
 * trading is a record of things that already happened and cannot be un-happened.
 * Faking it is not free either — a wash round trip pays the pool's fee every time,
 * 1% each way on the tier that matters here — so the two legs fail in different
 * ways and neither substitutes for the other. Measured on chain 4663, Blockscout
 * reports volume_24h $2,808.23 and exchange_rate 0.00024519 for The Green Bull and
 * nothing at all for the other 228 contracts wearing VLAD.
 *
 * NULL IS NOT ZERO. The indexer carries a feed for essentially nothing outside the
 * 94 verified equities, so an absent volume means "this instrument is silent about
 * this contract", never "nothing traded".
 */
export function indexerVolume24h(candidate) {
  const v = finiteOrNull(candidate?.volume24h);
  return v !== null && v > 0 ? v : null;
}

/** Descending compare that keeps unknowns last rather than poisoning the sort. */
function numDesc(a, b) {
  const x = Number.isFinite(a) ? a : -Infinity;
  const y = Number.isFinite(b) ? b : -Infinity;
  if (x === y) return 0;
  return y > x ? 1 : -1;
}

/** "17,750×", "3.4×" — a multiple, rendered so it cannot be read as money. */
export function ratioLabel(x) {
  const n = finiteOrNull(x);
  if (n === null || n < 0) return null;
  if (!Number.isFinite(n)) return null;
  if (n >= 100) return `${Math.round(n).toLocaleString("en-US")}×`;
  return `${Number(n.toFixed(1))}×`;
}

/** 0x1234…cdef, the form every surface in this repo uses for an address. */
function shortHex(value) {
  const s = String(value ?? "");
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

/** "0x31be…bf81 (\"The Green Bull\")" — enough for a reader to tell two apart. */
export function candidateLabel(row) {
  const address = shortHex(row?.address);
  const name = typeof row?.name === "string" ? row.name.trim() : "";
  return name && name.toUpperCase() !== String(row?.symbol ?? "").toUpperCase()
    ? `${address} ("${name}")`
    : address;
}

/* ------------------------------ the shortlist ---------------------------- */

/**
 * WHO GETS MEASURED, when measuring everybody is not an option.
 *
 * A cheap ordering over figures already in hand, so the expensive reads go where
 * they are most likely to matter. In order:
 *
 *  1. A contract the INDEXER independently prices. Blockscout carries a feed for
 *     essentially nothing outside the 94 verified equities, so when it does quote
 *     an ordinary ERC-20 that is a second instrument having found a market there.
 *     Corroborating evidence, never a verdict — it decides who is measured first
 *     and the measurement decides who wins. On the census this puts The Green Bull
 *     at position 1 of 229; ranked on holders alone it is 6th and a bound of six
 *     would have very nearly dropped the only contract with a market.
 *  2. Holder count, descending. A weak signal on its own — airdrops are cheap —
 *     but free, and better than arrival order.
 *  3. Market cap, descending, as the last tie-break among rows with neither.
 *
 * STABLE: equal rows keep their input order, so the same collision shortlists the
 * same contracts on every call and a price does not appear to move between
 * contracts for a reason the reader cannot see.
 *
 * @param {Array<object>} candidates - already narrowed to the top relevance tier
 * @param {number} [bound]
 * @returns {Array<object>} the head of the ordering, at most `bound` long
 */
export function depthShortlist(candidates, bound = MAX_DEPTH_PROBES) {
  const rows = Array.isArray(candidates) ? candidates.filter((c) => c && c.address) : [];
  const limit = Number.isInteger(bound) && bound > 0 ? bound : MAX_DEPTH_PROBES;
  return rows
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => {
      const ap = indexerPriced(a.candidate) ? 1 : 0;
      const bp = indexerPriced(b.candidate) ? 1 : 0;
      if (ap !== bp) return bp - ap;
      const byHolders = numDesc(finiteOrNull(a.candidate.holders), finiteOrNull(b.candidate.holders));
      if (byHolders !== 0) return byHolders;
      const byCap = numDesc(finiteOrNull(a.candidate.marketCap), finiteOrNull(b.candidate.marketCap));
      if (byCap !== 0) return byCap;
      return a.index - b.index;
    })
    .slice(0, limit)
    .map((x) => x.candidate);
}

/**
 * Did the indexer QUOTE this contract — exchange_rate, not a derived cap.
 *
 * The rate is the discriminating field. A market cap can arrive from several
 * places and does not on its own say a feed found a market; an exchange_rate is
 * the indexer stating a price, which on this chain it does for essentially nothing
 * outside the 94 verified equities. Measured: Blockscout carries exchange_rate
 * 0.00024519 for The Green Bull and none for the other VLADs.
 */
function indexerPriced(candidate) {
  return finiteOrNull(candidate?.price) !== null;
}

/* -------------------------------- probing -------------------------------- */

/**
 * The RPC client the depth probes read through, built once per process and
 * shared with lib/ask-evidence.js's pool fallback.
 *
 * A shorter per-request timeout and one retry rather than viem's 10s and three:
 * a probe spends dozens of reads under a single budget, so one stuck read has to
 * fail fast enough that the rest still fit. Built LAZILY, so a caller that injects
 * its own probe — which every test does — never constructs one and never opens a
 * connection. Returns null rather than throwing if the client cannot be built at
 * all: a probe that could not run is unmeasured, and unmeasured must never take
 * an answer down.
 *
 * BATCHED, AND THAT IS WHAT PAYS FOR THE FEE-TIER SWEEP. Measuring every tier of
 * every quote asset rather than stopping at the first hit roughly doubled the
 * reads per candidate, and measured live a four-probe VLAD collision issued 131
 * separate HTTP requests and took 10.8s cold — inside the 12s cutoff with almost
 * no margin, on an endpoint that rate limits. Packing the calls issued in the same
 * tick into one JSON-RPC array turns that fan-out into a handful of requests. The
 * 8ms window is a tick, not a delay anyone waits on: it only ever collects calls
 * that were already in flight together.
 *
 * AND THE BATCH IS CAPPED AT 32, WHICH IS A MEASURED LIMIT AND NOT A GUESS. The
 * public endpoint for chain 4663 answers a 48-call array with a 200 and a 64-call
 * array with a bare `429 Too Many Requests` — no per-call errors, just a rejected
 * request. That never bit while the tick ladder REFUSED to read a crowded pool,
 * because the refusal happened before the tick reads were issued; once the ladder
 * started capping instead, one lookup's fan-out (63 tick reads plus 18 bitmap words
 * plus the pool state) landed in a single array past that limit, every retry hit it
 * too, and the pool came back unreadable. Splitting into arrays of 32 keeps the same
 * call count in one or two more HTTP round trips.
 */
let sharedClient = null;

export function poolReadClient() {
  if (sharedClient) return sharedClient;
  try {
    sharedClient = getPublicClient({ timeout: 5_000, retryCount: 1, batch: { wait: 8, batchSize: 32 } });
  } catch {
    sharedClient = null;
  }
  return sharedClient;
}

/** Drop the shared client and let the next caller rebuild it. For tests. */
export function resetPoolReadClient() {
  sharedClient = null;
}

/**
 * A promise with a hard cutoff. The underlying work is NOT cancelled — it keeps
 * running and warms lib/dex-price.js's caches for the next lookup — but the probe
 * stops waiting on it and its result stays NULL, which is unmeasured and can
 * never win.
 */
function withDeadline(promise, ms, label) {
  let timer = null;
  const cutoff = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, cutoff]).finally(() => clearTimeout(timer));
}

/**
 * The lib/dex-price.js reason codes that mean THE CHAIN ANSWERED AND THERE IS
 * NOTHING TO MEASURE, as opposed to the ones that mean we could not look.
 *
 * Only these may be remembered. "This token has no Uniswap v3 pool" and "this pool
 * has never been initialised" are findings; "the RPC did not answer", "the pool
 * could not be read" and "no ETH/USD rate" are outages wearing the same null.
 */
const MEASURED_ABSENCE_REASONS = new Set(["no_pool", "pool_not_initialised"]);

/**
 * One contract's realisable depth, live. Null on ANY failure — a probe that did
 * not answer leaves the contract unmeasured, and a candidate that could not be
 * measured must never outrank one that could.
 *
 * A FAILED PROBE IS NEVER CACHED, which is what this shape is for. The cache
 * stores whatever the fetcher RESOLVES with and stores nothing at all when it
 * rejects, so returning `{ quoteLiquidityUsd: null }` on a failure — as this used
 * to — wrote the failure into the cache for the full price TTL and contradicted
 * the invariant lib/indexer-cache.js is built around. Ten seconds of "this
 * contract has no depth" is exactly the window in which one RPC blip decides which
 * contract owns a ticker. So a read that did not produce a figure THROWS, and only
 * a measurement — a number, or a chain-confirmed absence — is storable.
 *
 * @param {string} address
 * @param {{ client?: object|null, marketData?: Function }} [options] - test seams;
 *   production passes neither and gets the shared client and lib/dex-price.js.
 * @returns {Promise<{ depthUsd: number, lowerBound: boolean }|null>} the figure and
 *   whether it is exact, or null for unread. NEVER a bare number: a lower bound that
 *   travelled as one would be read as a measurement by everything downstream.
 */
export async function probeQuoteDepth(address, options = {}) {
  const client = options.client !== undefined ? options.client : poolReadClient();
  // The market read is injectable so the CACHING CONTRACT above can be exercised
  // offline — it is the half of this function that cannot be tested any other way,
  // and it is the half that was wrong.
  const marketData = typeof options.marketData === "function" ? options.marketData : tokenMarketData;
  if (!client) return null;
  try {
    const res = await withDeadline(
      withIndexerCache(
        `depth:${String(address).toLowerCase()}`,
        async () => {
          const market = await marketData(address, { client });
          const depth = quoteDepth(market);
          if (depth !== null) {
            return { quoteLiquidityUsd: depth, depthIsLowerBound: depthIsLowerBound(market) };
          }
          // THE ONE ZERO IN THIS FILE THAT IS A MEASUREMENT. A chain-confirmed
          // "this token has no Uniswap v3 pool" is a finding, and the realisable
          // depth of a token with no pool is genuinely nothing — so it counts as a
          // contract that WAS measured and simply has no market, which is what
          // makes a field of dust reportable as shallow at all. Everything else
          // that produced no figure is unread.
          if (MEASURED_ABSENCE_REASONS.has(market?.reason)) {
            return { quoteLiquidityUsd: 0, depthIsLowerBound: false };
          }
          // Rejecting rather than resolving is the whole point: the cache stores
          // nothing on a rejection, so the next lookup asks the chain again.
          throw new Error(`depth unread: ${market?.reason ?? "no figure"}`);
        },
        { ttlMs: priceCacheTtlMs() },
      ),
      // Capped by what the request has left as well as by its own budget: twelve
      // seconds is the right patience for this read in isolation and a guaranteed
      // overrun with eight seconds of the request remaining.
      clampTimeout(DEPTH_PROBE_TIMEOUT_MS),
      "depth probe",
    );
    const depthUsd = finiteOrNull(res?.quoteLiquidityUsd);
    return depthUsd === null ? null : { depthUsd, lowerBound: res?.depthIsLowerBound === true };
  } catch {
    return null;
  }
}

/**
 * Measure the realisable depth of a bounded shortlist, concurrently.
 *
 * BIASED THE SAFE WAY, the same way lib/stock-tokens.js withHolderCounts is: a
 * probe that fails leaves its contract at null, and null loses every comparison
 * against a number. The ranking prefers the contract it could measure over the one
 * it could not, which never promotes an unknown over a known.
 *
 * THREE QUANTITIES, NOT ONE, AND THE DIFFERENCE IS THE WHOLE POINT:
 *
 *   attempted — probes STARTED. A count of intentions.
 *   measured  — probes that came back with a figure. A count of FACTS, and the
 *               only one a verdict may be stated on.
 *   failed    — attempted minus measured: probes that ran and did not answer.
 *   dropped   — candidates the bound never shortlisted, which were never asked.
 *
 * These used to be two. `probed` was the shortlist LENGTH and every sentence
 * downstream read it as measurements obtained, so eight candidates, six probes,
 * five of them throwing and one $1.03 squatter answering produced "Measured 6 of
 * the 8 contracts wearing VLAD… no contract wearing VLAD has a market of any size,
 * so say that plainly". Five of those six were never measured, and the sentence
 * instructed the model to assert their absence as fact. Splitting the counts is
 * what makes that sentence impossible to write.
 *
 * @param {Array<object>} tier - the top relevance tier, already narrowed
 * @param {{ probe?: Function, bound?: number }} [options]
 *   The probe answers with a figure when it measured one (zero included — a
 *   chain-confirmed absence of any pool is a measurement of no market) and NULL
 *   when it could not read. It may answer with a bare number or with
 *   `{ depthUsd, lowerBound }`; a bare number is taken as EXACT, which is the safe
 *   reading because a caller that knows about lower bounds says so.
 * @returns {Promise<{ depths: Map<string, number>, lowerBounds: Set<string>,
 *   attempted: number, measured: number, failed: number, dropped: number,
 *   bound: number, candidateCount: number }>}
 */
export async function measureDepths(tier, options = {}) {
  const rows = Array.isArray(tier) ? tier.filter((c) => c && c.address) : [];
  const asked = Number.isInteger(options.bound) && options.bound > 0 ? options.bound : MAX_DEPTH_PROBES;
  const probe = typeof options.probe === "function" ? options.probe : probeQuoteDepth;

  // THE BOUND IS NOW THE SMALLER OF TWO BOUNDS: the per-lookup cap this module has
  // always had, and what the request's remaining time can actually pay for. Probing
  // fewer candidates is a smaller sample and the counts below say so; probing four
  // when there is time for one is four unmeasured contracts AND a dead request.
  const bound = Math.min(asked, affordableDepthProbes(asked));
  const boundLoweredForTime = bound < asked;
  // Nothing measured means the comparator falls back to the cheap signals already in
  // hand — the indexer's 24h volume and its quoted rate, which ride along in bodies
  // already fetched and cost nothing (see lib/stock-tokens.js beatsOnFigures). That
  // is a weaker ranking and it is REPORTED as one: the verdict becomes "unmeasured",
  // which says which contract has a market is unknown rather than that none does.
  if (boundLoweredForTime) noteBudgetSkip(bound === 0 ? "poolDepth" : "poolDepth (partial)");

  const shortlist = bound > 0 ? depthShortlist(rows, bound) : [];
  const depths = new Map();
  // WHICH OF THOSE FIGURES ARE ONLY "AT LEAST". Carried separately from the numbers
  // so no consumer can read one without having had the chance to see the other.
  const lowerBounds = new Set();
  if (!shortlist.length) {
    return {
      depths,
      lowerBounds,
      attempted: 0,
      measured: 0,
      failed: 0,
      dropped: rows.length,
      bound,
      boundLoweredForTime,
      candidateCount: rows.length,
    };
  }

  const results = await Promise.all(
    shortlist.map(async (c) => {
      try {
        const res = await probe(c.address);
        if (res === null || res === undefined) return null;
        if (typeof res === "object") {
          const depthUsd = finiteOrNull(res.depthUsd);
          return depthUsd === null ? null : { depthUsd, lowerBound: res.lowerBound === true };
        }
        const depthUsd = finiteOrNull(res);
        return depthUsd === null ? null : { depthUsd, lowerBound: false };
      } catch {
        return null;
      }
    }),
  );
  shortlist.forEach((c, i) => {
    if (results[i] === null) return;
    depths.set(c.address, results[i].depthUsd);
    if (results[i].lowerBound) lowerBounds.add(c.address);
  });

  return {
    depths,
    lowerBounds,
    attempted: shortlist.length,
    measured: depths.size,
    // Probes that RAN AND DID NOT ANSWER — the quantity that had no name before,
    // and the one that decides whether a verdict may be stated as a fact.
    failed: shortlist.length - depths.size,
    dropped: rows.length - shortlist.length,
    bound,
    // Whether that bound is the per-lookup cap or a TIGHTER one the clock imposed.
    // The two produce the same `dropped` count and call for different sentences:
    // one is a stated limit of the measurement, the other is a limit of this
    // particular request, and a reader deserves to know which they are looking at.
    boundLoweredForTime,
    candidateCount: rows.length,
  };
}

/**
 * The same list with `quoteLiquidityUsd` filled in where it was read — and
 * `depthIsLowerBound` beside it, ALWAYS, so a row carrying a figure can never be
 * read without the qualifier travelling with it.
 *
 * A NEW OBJECT per enriched row: the caller's list, and anything else holding a
 * reference to these candidates, must not mutate under it.
 *
 * @param {Array<object>} candidates
 * @param {Map<string, number>} depths
 * @param {Set<string>} [lowerBounds] - addresses whose figure is "at least this much"
 */
export function applyDepths(candidates, depths, lowerBounds = null) {
  if (!Array.isArray(candidates) || !(depths instanceof Map) || !depths.size) return candidates;
  const bounded = lowerBounds instanceof Set ? lowerBounds : new Set();
  return candidates.map((c) =>
    c && depths.has(c.address)
      ? { ...c, quoteLiquidityUsd: depths.get(c.address), depthIsLowerBound: bounded.has(c.address) }
      : c,
  );
}

/* ------------------------------ the verdict ------------------------------ */

/**
 * DOES ANY ONE CONTRACT DOMINATE, in a form a caller can act on without
 * re-deriving the policy.
 *
 * TWO LEGS, NEVER BLENDED INTO A SCORE. The depth leg is the measured band depth
 * (lib/tick-depth.js); the corroboration leg is the indexer's own record — 24h
 * volume first, and failing that whether it quotes the contract at all. They are
 * reported separately in `legs` and a reader can always see which one said what.
 * Averaging them would hide exactly the disagreement that matters.
 *
 * WHY DEPTH ALONE MAY NOT NAME A WINNER. Depth is a snapshot of capital present
 * now, and capital is rentable. Realised trading is not: it already happened, and
 * faking it costs the pool fee on every round trip. So one rentable number does not
 * get to decide a ticker on its own.
 *
 * Seven outcomes, kept apart because they call for seven different answers:
 *
 *   "dominant"      — one measured contract clears MEANINGFUL_DEPTH_USD with no
 *                     rival inside DOMINANCE_RATIO, EVERY probe answered, there was
 *                     a measured rival to beat, AND the corroboration leg names the
 *                     same contract. Both legs agree: answer about it directly, no
 *                     menu. This is VLAD — measured live, band depth $1,324.13
 *                     against $3.88, and the indexer's $2,808.23 of 24h volume on
 *                     the same contract.
 *   "conflicted"    — the depth leg names one contract and the corroboration leg
 *                     names a DIFFERENT one. Deep pool with no trading beside
 *                     trading with no depth is precisely the "which do you mean"
 *                     ask_clarification exists for, so this asks, and the question
 *                     says what disagreed.
 *   "uncorroborated"— the depth leg names a contract and the indexer is silent
 *                     about every contract measured. That is not disagreement, it
 *                     is a second instrument with nothing to say, so there is
 *                     nothing to ask the reader — but it is not dominance either.
 *                     Name the deepest contract, say the depth is uncorroborated.
 *   "ambiguous"     — two or more clear the floor AND sit inside the ratio of each
 *                     other. Genuinely comparable markets, so ASK rather than pick.
 *   "shallow"       — every probe answered and nothing cleared the floor. Answer
 *                     about the best-ranked contract, and say that none of the
 *                     contracts MEASURED holds meaningful realisable depth. A menu
 *                     of contracts with a dollar each helps nobody.
 *   "partial"       — something was measured and something was NOT. There is a
 *                     deepest-read contract and it is not established as anything.
 *   "unmeasured"    — nothing was measured at all. Which contract has a market is
 *                     UNKNOWN, which is not the same as none having one.
 *
 * A SHALLOW VERDICT THE INDEXER CONTRADICTS DOES NOT BECOME A QUESTION. If nothing
 * cleared the depth floor but the indexer reports real volume for the deepest
 * contract, both legs still point at the SAME contract — they disagree about
 * whether it is a market, not about which one it is, and asking "which do you mean"
 * would answer a question nobody has. It stays "shallow" and carries
 * `tradingContradiction`, which forbids the absence sentence.
 *
 * WHY "partial" EXISTS. Both of the other verdicts were being stated on samples
 * that could not support them. Six probes, five throwing, one $1.03 squatter
 * answering produced "shallow" and the sentence "no contract wearing VLAD has a
 * market of any size, so say that plainly" — an outage rendered as a measured
 * absence, and handed to the model as an instruction. The same shape inverts: five
 * failures and one $69.58K read produced "That is not a close call", declaring
 * dominance over rivals nobody measured. A verdict may never be more confident than
 * its successful sample, so both of those now downgrade and say what is missing.
 *
 * A FAILED PROBE IS NOT A DROPPED CANDIDATE. `dropped` (never shortlisted, never
 * asked) is disclosed separately and does NOT downgrade the verdict — the bound is
 * a known, stated limit of the measurement, where a failure is the measurement not
 * happening. Conflating them would make every collision on a 229-contract ticker
 * permanently "partial" and the distinction between a bound and an outage would be
 * lost.
 *
 * @param {Array<object>} rows - candidates carrying quoteLiquidityUsd where read
 * @param {object} [survey] - the measureDepths bookkeeping, echoed through
 * @returns {object}
 */
export function dominanceVerdict(rows, survey = {}) {
  const all = Array.isArray(rows) ? rows.filter((c) => c && c.address) : [];
  const measured = all
    .filter((c) => quoteDepth(c) !== null)
    .sort((a, b) => quoteDepth(b) - quoteDepth(a) || String(a.address).localeCompare(String(b.address)));

  const top = measured[0] ?? null;
  const runnerUp = measured[1] ?? null;
  const topDepth = top ? quoteDepth(top) : null;
  const runnerUpDepth = runnerUp ? quoteDepth(runnerUp) : null;

  // Contenders: deep enough to be a market at all, and close enough to the top to
  // be a real choice. Anything failing either test is not something to ask about.
  const contenders =
    topDepth === null
      ? []
      : measured.filter((c) => quoteDepth(c) >= MEANINGFUL_DEPTH_USD && quoteDepth(c) * DOMINANCE_RATIO >= topDepth);

  const ratio =
    topDepth === null || runnerUpDepth === null || runnerUpDepth <= 0
      ? null
      : topDepth / runnerUpDepth;

  // WHICH FIGURES ARE ONLY "AT LEAST THIS MUCH" — see depthIsLowerBound. The leader
  // being a lower bound is harmless to a dominance claim (the true figure is at least
  // that, so a win by this margin is a win by more); a RIVAL being one is fatal to it,
  // because the rival could be the deeper of the two and nothing here can rule it out.
  const boundedRows = measured.filter((c) => depthIsLowerBound(c));
  const topIsLowerBound = top !== null && depthIsLowerBound(top);
  const rivalsBounded = boundedRows.some((c) => c !== top);

  // The survey is the authority on what the PROBE did; the rows only say what
  // arrived carrying a figure. Fall back to the rows when no survey was passed.
  const measuredCount = measured.length;
  const attempted = Number.isFinite(survey.attempted) ? survey.attempted : measuredCount;
  const failedCount = Number.isFinite(survey.failed)
    ? survey.failed
    : Math.max(0, attempted - measuredCount);
  const dropped = Number.isFinite(survey.dropped) ? survey.dropped : 0;

  // ---- the depth leg, on its own.
  let verdict;
  if (!measuredCount) verdict = "unmeasured";
  else if (contenders.length >= 2) verdict = "ambiguous";
  else if (failedCount > 0) verdict = "partial";
  else if (contenders.length === 1) verdict = measuredCount >= 2 ? "dominant" : "partial";
  else verdict = "shallow";

  // ---- and now what the LOWER BOUNDS allow that verdict to say.
  //
  // Two of the seven outcomes are claims a bound cannot support. "dominant" asserts
  // an ORDERING, which a lower bound on a rival does not establish. "shallow" asserts
  // an ABSENCE — nothing here clears the floor — which no figure that understates can
  // demonstrate, whichever row it sits on. Both downgrade to "partial", whose whole
  // job is to name the deepest contract READ and settle nothing.
  //
  // A lower bound on the LEADER ALONE is deliberately left to stand as dominance: the
  // true figure is at least that, every rival is exact, so the separation holds a
  // fortiori. That is the property that makes truncation safe against the griefing
  // attack rather than merely less bad than refusing.
  const boundInconclusive =
    (verdict === "dominant" && rivalsBounded) || (verdict === "shallow" && boundedRows.length > 0);
  if (boundInconclusive) verdict = "partial";

  // ---- the corroboration leg, on its own. Volume is preferred because it is a
  // record of trades that happened; the indexer merely QUOTING a contract is the
  // weaker fallback, used only when nothing measured has a volume figure at all.
  const trading = corroborationLeg(measured);
  const leader = trading.leader;
  const legsAgree = leader !== null && top !== null && sameAddressLoose(leader.address, top.address);
  const legsConflict = leader !== null && top !== null && !sameAddressLoose(leader.address, top.address);

  // ---- and only now, what the two of them together support.
  let tradingContradiction = false;
  if (verdict === "dominant") {
    if (legsConflict) verdict = "conflicted";
    else if (!legsAgree) verdict = "uncorroborated";
  } else if (verdict === "shallow" && legsAgree) {
    tradingContradiction = true;
  }

  // Under a conflict the reader is choosing between the two contracts the two legs
  // named, which is not the same set as the depth contenders — a squatter with all
  // the volume and no pool would otherwise never appear in its own clarification.
  const askRows =
    verdict === "conflicted" ? dedupeByAddress([top, leader].filter(Boolean)) : contenders;

  return {
    verdict,
    dominant: verdict === "dominant",
    // "conflicted" asks through the SAME path "ambiguous" does — see
    // lib/ask-tools.js askIfUnsettled — because the reader is being asked the same
    // question, for a different reason, and a second mechanism would be a second
    // thing to keep in step.
    ambiguous: verdict === "ambiguous" || verdict === "conflicted",
    // THE TWO LEGS, REPORTED SEPARATELY AND NEVER AVERAGED. A reader has to be able
    // to see which instrument said what, especially when they disagree.
    legs: {
      depth: {
        leader: top?.address ?? null,
        topDepthUsd: topDepth,
        runnerUpDepthUsd: runnerUpDepth,
        floorUsd: MEANINGFUL_DEPTH_USD,
        // "At least this much", per row and in aggregate. A reader has to be able to
        // see that a figure understates before deciding what it proves.
        topIsLowerBound,
        lowerBoundCount: boundedRows.length,
        rivalsLowerBound: rivalsBounded,
        // Set when a bound is the REASON this verdict settles nothing, as opposed to a
        // failed probe. Two different gaps, and they call for two different sentences.
        boundInconclusive,
      },
      trading: {
        source: "indexer",
        signal: trading.signal,
        leader: leader?.address ?? null,
        volume24hUsd: trading.volume24hUsd,
        pricedCount: trading.pricedCount,
        volumeCount: trading.volumeCount,
      },
      agree: legsAgree,
      conflict: legsConflict,
    },
    // Set only under "shallow": the depth leg found no market and the indexer says
    // one traded anyway. The absence sentence may not be used when this is true.
    tradingContradiction,
    // Every verdict that measured anything names its deepest READ contract. Under
    // "partial" that is the deepest of those that answered and nothing more.
    winner: top ?? null,
    topDepthUsd: topDepth,
    runnerUpDepthUsd: runnerUpDepth,
    depthRatio: ratio,
    // WHO THE READER IS BEING ASKED TO CHOOSE BETWEEN. Under "ambiguous" that is
    // the contracts with comparable depth; under "conflicted" it is the two the two
    // legs disagreed about, which is a different set.
    contenders: askRows.map((c) => contenderRow(c, trading)),
    // The question askIfUnsettled puts to the reader, written HERE because only
    // this function knows why it is asking. Null when nothing is being asked.
    clarifyQuestion: clarifyQuestion(verdict, askRows, trading, top),
    // EVERY row a depth was actually read for, deepest first — bounded by the
    // probe cap, so at most MAX_DEPTH_PROBES of them. `contenders` is the subset
    // worth ASKING about; this is the subset that was MEASURED, and a caller that
    // needs the depth behind one specific contract (to qualify a market cap the
    // indexer quoted, say) has to be able to find it whether or not it cleared the
    // contender floor.
    measuredRows: measured.map((c) => ({
      address: c.address,
      quoteLiquidityUsd: quoteDepth(c),
      depthIsLowerBound: depthIsLowerBound(c),
    })),
    // THE BOOKKEEPING, as four separate quantities. `probed` is deliberately gone
    // rather than redefined: every sentence that used it read it as measurements
    // obtained, and a field that quietly changed meaning would have been read the
    // same wrong way for another release.
    candidateCount: Number.isFinite(survey.candidateCount) ? survey.candidateCount : all.length,
    attempted,
    measuredCount,
    failedCount,
    dropped,
    unmeasuredCount: all.length - measuredCount,
    bound: Number.isFinite(survey.bound) ? survey.bound : MAX_DEPTH_PROBES,
    // Was that bound the per-lookup cap, or a tighter one this request's clock
    // imposed? Echoed rather than re-derived — only measureDepths knows.
    boundLoweredForTime: survey.boundLoweredForTime === true,
  };
}

/** Case-insensitive address compare. The chain mixes case; our keys do not. */
function sameAddressLoose(a, b) {
  return String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase() && Boolean(a);
}

/** First occurrence of each address, order preserved. */
function dedupeByAddress(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = String(r?.address ?? "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * WHICH CONTRACT THE SECOND INSTRUMENT POINTS AT, and on what.
 *
 * Volume outranks a quoted price because they are different strengths of evidence:
 * volume_24h is a record of trades that settled, where an exchange_rate is the
 * indexer saying it found a market without saying how much went through it. So the
 * price is only consulted when NOTHING measured carries a volume figure.
 *
 * A TIE ON THE WEAKER SIGNAL NAMES NOBODY. If two contracts are both quoted and
 * neither has volume, the indexer has not distinguished them, and inventing a
 * leader by falling back to depth would smuggle the first leg into the second.
 *
 * `signal` says which one spoke — "volume_24h", "exchange_rate", or null for
 * silence — so no sentence downstream has to guess how strong the corroboration is.
 */
function corroborationLeg(measured) {
  const rows = Array.isArray(measured) ? measured : [];
  const withVolume = rows
    .filter((c) => indexerVolume24h(c) !== null)
    .sort((a, b) => indexerVolume24h(b) - indexerVolume24h(a));
  const priced = rows.filter((c) => indexerPriced(c));

  if (withVolume.length) {
    return {
      signal: "volume_24h",
      leader: withVolume[0],
      volume24hUsd: indexerVolume24h(withVolume[0]),
      volumeCount: withVolume.length,
      pricedCount: priced.length,
    };
  }
  if (priced.length === 1) {
    return {
      signal: "exchange_rate",
      leader: priced[0],
      volume24hUsd: null,
      volumeCount: 0,
      pricedCount: 1,
    };
  }
  return {
    signal: null,
    leader: null,
    volume24hUsd: null,
    volumeCount: 0,
    pricedCount: priced.length,
  };
}

/**
 * The terminal question, written where the reason for asking is known.
 *
 * Two shapes, because the two verdicts that ask are asking different things: under
 * "ambiguous" several markets are comparable and the reader picks one; under
 * "conflicted" the two instruments named different contracts and the reader is
 * being told exactly that before picking.
 */
function clarifyQuestion(verdict, rows, trading, top) {
  const symbol = rows[0]?.symbol ? String(rows[0].symbol) : "that ticker";
  if (verdict === "ambiguous") {
    return `${rows.length} contracts trade under ${symbol} with comparable realisable depth and none dominates — which one do you mean?`;
  }
  if (verdict === "conflicted") {
    const depthLabel = top ? candidateLabel(top) : "one contract";
    const tradeLabel = trading.leader ? candidateLabel(trading.leader) : "another";
    const what =
      trading.signal === "volume_24h"
        ? `${displayNumber(trading.volume24hUsd, "usd")} of 24h volume`
        : "the only price the indexer quotes";
    return `Two measurements of ${symbol} disagree: the deepest pool is ${depthLabel}, but ${tradeLabel} is where the indexer reports ${what}. Which contract do you mean?`;
  }
  return null;
}

/** The narrow shape a contender travels in — enough to choose between, not to trade. */
function contenderRow(c, trading = null) {
  const depth = quoteDepth(c);
  const volume = indexerVolume24h(c);
  return {
    address: c.address,
    symbol: c.symbol ?? null,
    name: c.name ?? null,
    quoteLiquidityUsd: depth,
    // The second leg travels WITH each option rather than only in the question, so
    // a reader choosing between contracts can see both figures for each of them.
    volume24hUsd: volume,
    indexerPriced: indexerPriced(c),
    isTradingLeader: Boolean(trading?.leader && sameAddressLoose(trading.leader.address, c.address)),
    label: candidateLabel(c),
    display: {
      quoteLiquidity: displayNumber(depth, "usd"),
      volume24h: displayNumber(volume, "usd"),
      marketCap: displayNumber(finiteOrNull(c.marketCap), "usd"),
    },
  };
}

/**
 * The verdict as a finished sentence, because the reader needs the contracts and
 * the figures named and the model must not have to assemble that from six fields.
 *
 * The same convention as impostorWarning and identityNotice in
 * lib/ask-evidence.js: sentences travel, flags do not.
 *
 * @param {object} v - a dominanceVerdict result
 * @param {string|null} symbol
 * @returns {string|null}
 */
export function collisionNotice(v, symbol) {
  if (!v || typeof v !== "object") return null;
  const ticker = symbol ? String(symbol) : "this ticker";
  // MEASUREMENTS OBTAINED, never probes attempted. The count in this clause is the
  // one a reader will take as the size of the evidence, and it used to be the
  // shortlist length — so five probes that threw and one that answered read as
  // "measured 6", with the failures invisible.
  //
  // "…the explorer returned" rather than a bare count: the candidate set is one
  // page of search results, not a census of the chain. Measured, 33 rows come back
  // for VLAD and 229 contracts actually carry the symbol, so "4 of 33" without
  // that clause would quietly assert a total nobody counted.
  const scope = `${v.measuredCount} of the ${v.candidateCount} contract${v.candidateCount === 1 ? "" : "s"} wearing ${ticker} that the explorer returned`;
  // TWO SEPARATE ADMISSIONS, because they are two different facts. A probe that
  // failed is an outage; a candidate the bound never reached was never asked.
  const failed =
    v.failedCount > 0
      ? ` ${v.failedCount} further contract${v.failedCount === 1 ? " was" : "s were"} probed and could not be read at all, so ${v.failedCount === 1 ? "its depth is" : "their depths are"} unknown rather than small.`
      : "";
  // A BOUND THE READER CANNOT SEE IS A LIE BY OMISSION, and when the clock set that
  // bound rather than the per-lookup cap, saying "capped at N pools per lookup"
  // would name the wrong limit — it reads as a permanent property of the product
  // where it is a property of one slow request. So the sentence says which.
  const cappedBy = v.boundLoweredForTime
    ? `this lookup had time to probe ${v.bound === 1 ? "only 1 pool" : `only ${v.bound} pools`} before the answer had to be written`
    : `the probe is capped at ${v.bound} pools per lookup`;
  const dropped =
    v.dropped > 0
      ? ` ${v.dropped} more went unmeasured — ${cappedBy}, so they are unknown rather than shallow.`
      : "";
  // A THIRD ADMISSION, and it is neither of the other two. A lower bound is a
  // measurement that happened and understates: the read budget capped the tick walk,
  // so the figure covers less of the band than it names. Reported in its own clause
  // because "at least $X" and "$X" are different claims and only one of them is true.
  const boundedCount = finiteOrNull(v.legs?.depth?.lowerBoundCount) ?? 0;
  const bounded =
    boundedCount > 0
      ? ` ${boundedCount} of the figures below ${boundedCount === 1 ? "is a LOWER BOUND" : "are LOWER BOUNDS"} — the pool held more initialised ticks inside the band than one lookup reads, so ${boundedCount === 1 ? "that contract's depth is at least" : "those contracts' depths are at least"} the amount shown and may be more. Say "at least", never the bare figure.`
      : "";
  const caveats = `${failed}${dropped}${bounded}`;

  if (v.verdict === "unmeasured") {
    // NOT ONE PROBE WAS EVEN STARTED, because the request had no time left to spend
    // on one. That is a different sentence from "we probed and they did not answer":
    // the chain was never asked, so there is no outage to report and no measurement
    // to have failed. Saying it the other way round would send a reader looking for
    // a broken endpoint. What ranks the contracts instead is named, so the weaker
    // basis for the ordering is visible rather than implied.
    if (v.attempted === 0 && v.boundLoweredForTime) {
      return `No pool was read for any of the ${v.candidateCount} contract${v.candidateCount === 1 ? "" : "s"} wearing ${ticker} that the explorer returned — this lookup ran out of its time budget before the depth probes could start, so nothing was measured and nothing failed. Which of them has a real market is UNKNOWN, not none. The rank and the figures below rest on the indexer's own 24h volume and quoted rate and on holder counts, none of which measures what a trade could actually realise.`;
    }
    // Nothing was measured, so the count here is ATTEMPTS — the one place that is
    // the honest number, because there are no measurements to report. Falls back to
    // the candidate count when the caller passed no survey to say how many ran.
    const tried = v.attempted > 0 ? v.attempted : v.candidateCount;
    return `Depth could not be read for any of the ${tried} contract${tried === 1 ? "" : "s"} probed out of ${v.candidateCount} wearing ${ticker}, so which of them has a real market is unknown — not that none does. Rank and figures below rest on holder counts and whatever the indexer quoted, neither of which measures what a trade could realise.${dropped}`;
  }

  const topLabel = v.winner ? candidateLabel(v.winner) : "the deepest contract";
  const topFigure = displayNumber(v.topDepthUsd, "usd");
  // WHAT THE SECOND INSTRUMENT SAID, in its own clause. Never folded into the depth
  // figure and never averaged with it.
  const tradingFigure =
    v.legs?.trading?.volume24hUsd != null ? displayNumber(v.legs.trading.volume24hUsd, "usd") : null;

  if (v.verdict === "shallow") {
    const base = `Measured ${scope}, every probe answering: none holds as much as ${displayNumber(MEANINGFUL_DEPTH_USD, "usd")} of realisable quote-side depth, the deepest being ${topLabel} at ${topFigure}.`;
    // THE ABSENCE SENTENCE IS WITHDRAWN when the indexer contradicts it. Depth is a
    // snapshot and trading is a record; a contract with $2,800 of settled volume and
    // a thin pool is not a contract with no market, it is two instruments
    // disagreeing, and the answer has to say so rather than pick the flattering one.
    if (v.tradingContradiction) {
      return `${base} The indexer disagrees: it reports ${tradingFigure ?? "a price"} for ${topLabel}${tradingFigure ? " of 24h volume" : ""}, so the pool measurement and the trading record point opposite ways about whether there is a market. Report BOTH figures and say they disagree; do NOT say that nothing wearing ${ticker} has a market.${caveats}${dropped}`;
    }
    return `${base} Say that none of the contracts measured has a market of any size — scoped to what was measured — rather than presenting one of them as the token.${dropped}`;
  }

  if (v.verdict === "uncorroborated") {
    return `Measured ${scope}, every probe answering: ${topLabel} holds ${topFigure} of realisable quote-side depth and nothing measured comes close. The second instrument is SILENT — the indexer quotes no price and reports no 24h volume for any of the contracts measured — so the depth stands on its own and depth is a snapshot of capital that can be moved. Report on that contract as the deepest one measured, and do NOT call it dominant or say it is "the" ${ticker} on this evidence alone.${caveats}${dropped}`;
  }

  if (v.verdict === "conflicted") {
    const list = v.contenders.map((c) => `${c.label} — ${c.display.quoteLiquidity} of depth, ${c.display.volume24h ?? "no"} 24h volume`).join("; ");
    return `Measured ${scope}, and the two measurements DISAGREE. The deepest pool is ${topLabel} at ${topFigure}, but the indexer's trading record points at a different contract: ${list}. Depth is a snapshot of capital that could be withdrawn; volume is trades that already settled and paid the fee — neither overrides the other, so name both and ask which contract they mean rather than choosing.${caveats}${dropped}`;
  }

  if (v.verdict === "partial") {
    // The other route into "partial": nothing FAILED, but only one contract was
    // measured at all, so there is no measured rival for it to have beaten.
    const lone =
      v.failedCount === 0 && v.measuredCount === 1
        ? " No rival was measured beside it, so nothing here says it dominates — it is simply the one contract a depth could be read for."
        : "";
    // The third route into "partial": every probe answered, but a figure that
    // UNDERSTATES cannot establish an ordering or an absence. Named separately from
    // an outage, because a reader who is told "could not be read" would look for one.
    const inconclusive = v.legs?.depth?.boundInconclusive
      ? " Every probe answered; what is missing is exactness, not data. At least one figure is a lower bound, so which contract is deepest — and whether any of them clears the floor — is not established by these readings."
      : "";
    return `Measured ${scope}: the deepest that answered is ${topLabel} at ${v.legs?.depth?.topIsLowerBound ? `at least ${topFigure}` : topFigure}.${caveats}${lone}${inconclusive} This is a partial reading, so it settles nothing: name that contract as the deepest of the ones that could be read, say how many could not, and claim NEITHER that it dominates NOR that nothing wearing ${ticker} has a market.`;
  }

  if (v.verdict === "ambiguous") {
    const list = v.contenders.map((c) => `${c.label} at ${c.display.quoteLiquidity}`).join(", ");
    return `Measured ${scope}: ${v.contenders.length} hold comparable realisable depth — ${list}. None is ${DOMINANCE_RATIO}× the next, so no one of them is "the" ${ticker}: ask which contract they mean instead of picking one silently.${caveats}`;
  }

  const gap =
    v.runnerUpDepthUsd === null
      ? "nothing else measured holds any"
      : `the next deepest holds ${displayNumber(v.runnerUpDepthUsd, "usd")}${v.depthRatio ? ` — ${ratioLabel(v.depthRatio)} less` : ""}`;
  // BOTH LEGS, NAMED. The dominance claim rests on two instruments agreeing, and
  // the sentence has to say which two so a reader can weigh it — this is the one
  // verdict that tells the model not to hedge, and it may not do that on one number.
  // "the only one" is only said when it IS the only one. The count is carried on
  // the leg for exactly this reason: a sentence that claims the others reported
  // nothing, when two of them reported something, is a false statement about the
  // evidence even though the verdict it supports is right.
  const sole = v.legs?.trading?.volumeCount === 1;
  const second =
    v.legs?.trading?.signal === "volume_24h"
      ? ` The indexer independently agrees: it reports ${tradingFigure} of 24h volume on that same contract${sole ? " and none on the others measured" : ", the most of any measured"} — a record of trades that settled, which a snapshot of pooled capital cannot supply.`
      : ` The indexer independently agrees: it is the only contract measured that it quotes a price for at all.`;
  // A LOWER BOUND ON THE LEADER ALONE STILL SUPPORTS DOMINANCE — the true figure is
  // at least this and every rival's is exact — but the SENTENCE must not round it up
  // to a measurement. "At least $X" is what was established; "$X" is not.
  const topPhrase = v.legs?.depth?.topIsLowerBound ? `at least ${topFigure}` : topFigure;
  return `Measured ${scope}, every probe answering: ${topLabel} holds ${topPhrase} of realisable quote-side depth and ${gap}.${second} Both measurements point at the same contract, so that is not a close call — report on it directly and do not offer the reader a menu.${bounded}${dropped}`;
}

/* --------------------------- the naked-cap rule --------------------------- */

/**
 * A MARKET CAP MAY NOT BE QUOTED NAKED, and this is the clause that goes beside it.
 *
 * "$3.86M market cap" behind $1.03 of WETH is not a $3.86M token, and a reader who
 * is not told will be misled — not by a wrong figure but by a correct one with its
 * context removed. Supply times pool price is arithmetic about supply; the quote
 * side of the pool is the only part somebody else put in.
 *
 * TOTAL LIQUIDITY IS NOT DEPTH AND IS NAMED SEPARATELY. Measured on Vladhoods:
 * liquidityUsd $363,783 against a quote side of $3.91. That "liquidity" is ~900M of
 * the token valuing ITSELF at its own quoted price — circular, and it is the figure
 * a reader is most likely to mistake for money. So when the two disagree, both are
 * stated and the circularity is named.
 *
 * NOT AN ACCUSATION. Thin depth is a fact about a pool. Plenty of honest new tokens
 * are thin, and this sentence must never harden into a claim of fraud, a rug or
 * intent — it says what the figure is, not what anyone did.
 *
 * @param {unknown} marketCapUsd
 * @param {unknown} quoteLiquidityUsd - the REALISABLE side
 * @param {unknown} [liquidityUsd] - both sides, which can be circular
 * @param {{ crossSource?: boolean }} [options] - set when the cap and the depth
 *   came from DIFFERENT instruments (the indexer's cap qualified by our pool
 *   read). The two are never blended into one figure, so the sentence says which
 *   is which rather than letting a reader assume one measurement.
 * @returns {string|null} null when the cap needs no qualifier
 */
export function capNotice(marketCapUsd, quoteLiquidityUsd, liquidityUsd = null, options = {}) {
  const cap = finiteOrNull(marketCapUsd);
  if (cap === null || cap <= 0) return null;
  const quote = finiteOrNull(quoteLiquidityUsd);
  const total = finiteOrNull(liquidityUsd);
  const capText = displayNumber(cap, "usd");
  const sources = options?.crossSource
    ? " The cap is the indexer's own figure and the depth is read from the token's Uniswap v3 pool — two different instruments, quoted separately and never blended into one number."
    : "";

  if (quote === null) {
    return `${capText} is supply times price. How much of it is realisable was not measured — the pool's balances could not be read — so quote the cap as a notional figure and say the depth behind it is unknown, never that it is deep and never that it is thin.`;
  }

  const circular =
    total !== null && quote > 0 && total >= quote * CAP_TO_DEPTH_RATIO
      ? ` The pool's two sides total ${displayNumber(total, "usd")}, but almost all of that is the token valuing ITSELF at the price under discussion; only the ${displayNumber(quote, "usd")} quote side is capital somebody else put in.`
      : "";

  if (quote <= 0 || cap / quote >= CAP_TO_DEPTH_RATIO) {
    const multiple = quote > 0 ? ratioLabel(cap / quote) : null;
    return `${capText} is a market cap against ${displayNumber(quote, "usd")} of realisable quote-side liquidity in the token's pool${multiple ? ` — the cap is ${multiple} the money actually in the pool` : ""}. State the two together: a cap this far above its depth is notional, not value anyone could take out.${circular}${sources} Thin depth is a fact about a pool, not evidence of a scam — plenty of honest new tokens are thin.`;
  }

  // Proportionate. The depth is still worth stating and lib/ask-evidence.js's
  // liquidityNotice states it; adding a second sentence here would only dilute the
  // one that fires when it matters.
  return null;
}
