import { formatUnits } from "viem";
import { fmtTokenAmount, sanitizeLabel } from "./ask-evidence.js";
import { getToken } from "./blockscout.js";
import { bigRatioToNumber, ethUsd, priceFromSqrtX96, resolvePool, resolveV4PoolManager } from "./dex-price.js";
import { NATIVE_CURRENCY, V4_DISCOVERY_BUDGET_MS, V4_INITIALIZE_EVENT, readV4Pools } from "./dex-v4.js";
import { displayNumber, finiteOrNull } from "./format-number.js";
import { withIndexerCache } from "./indexer-cache.js";
import { noteBudgetSkip, outOfTimeFor, remainingWorkMs } from "./request-budget.js";
import { poolReadClient } from "./depth-rank.js";
import { listStockTokens, resolveSymbol, snapshotMatch } from "./stock-tokens.js";
import { buildTable, col } from "./table-shape.js";
import { resolveTokenTarget } from "./token-evidence.js";
import {
  AMOUNT_SIGN_CONVENTION,
  BLOCKS_PER_SECOND,
  MAX_LOG_SPAN,
  MAX_TRADER_JOINS,
  MAX_WINDOW_CHUNKS,
  SWAP_TOPICS,
  VENUES,
  attachTraders,
  decodeV3SwapLog,
  decodeV4SwapLog,
  readV3Swaps,
  summariseSwaps,
  swapNotice,
  tokenSwapFlow,
  traderLegs,
} from "./swap-log.js";

/**
 * THE SWAP LAYER TURNED INTO ANSWERS — three questions a holder actually asks, off
 * the record lib/swap-log.js decodes.
 *
 * lib/swap-log.js reads and normalises Swap events and deliberately stops there: it
 * discovers no pools, prices nothing in dollars and forms no opinion. This module is the
 * layer above it, and it is where the three questions live:
 *
 *   recentTrades  — who has been buying and selling this token lately, and how much.
 *   realVolume    — how much of that volume is two-sided trading and how concentrated it is.
 *   swapDetail    — what actually happened in ONE swap: venue, pool, fee, price move, legs.
 *
 * THE SIGN CONVENTION IS NOT RE-DERIVED HERE. lib/swap-log.js AMOUNT_SIGN_CONVENTION
 * measured it two independent ways and found the two venues OPPOSITE — v4 amounts are the
 * swapper's delta, v3 amounts are the pool's — and swapDirection() is the single
 * derivation. Nothing below looks at the sign of an amount; every direction comes from
 * `row.subject.direction`, so there is exactly one place this can be wrong.
 *
 * WHAT SHAPES THE COST, MEASURED LIVE ON CHAIN 4663 TODAY:
 *
 *  - A 5,600-block PoolManager window is 4,021 Swap logs and 2.3 seconds — ONE getLogs
 *    call. That is the cheap, complete unit of work and it is the default.
 *  - The v3 pool sweep (lib/dex-price.js resolvePool) is the expensive leg: 6.2s for a
 *    token that turns out to have NO v3 pool, 3.3s for one that does. It runs LAST and
 *    behind a budget gate, because v4 is where this chain trades and a sweep that eats the
 *    request to report "no pool" is the worst trade available here.
 *  - Naming a trader costs one eth_getTransaction, ~400ms, and cannot be batched. Eight is
 *    3.2 seconds, so the eight are CHOSEN rather than taken in order — see curatedForJoin.
 *  - The indexer is the wrong source for a transaction: measured, its transaction endpoint
 *    is 4,648ms and its logs endpoint 2,785ms where eth_getTransactionByHash is 707ms and
 *    eth_getTransactionReceipt 383ms for the same 17 logs. swapDetail therefore reads the
 *    chain directly.
 *  - A balance is likewise cheaper from the chain: the indexer's token-balances endpoint
 *    took 2,876ms and returned 2,689 rows for ONE address, where eight batched balanceOf
 *    calls took 387ms in total.
 *
 * THE ORDERING IS LOAD-BEARING AND IS NOT A STYLE CHOICE. This repo carries a measured
 * warning that log queries and a large eth_call sweep against this node must not overlap
 * or the log queries lose, and lib/swap-log.js reproduced it with a new pair of readers.
 * So every stage below is awaited before the next begins: the v4 manager check, then the
 * v4 discovery and window read, then the transaction joins, then the v3 sweep, then the v3
 * window read, then the balance sweep. Nothing here runs two RPC stages concurrently.
 *
 * WHAT THIS MODULE REFUSES TO DO. It never says nobody is selling — only that no sell was
 * OBSERVED in the blocks actually read, which is the distinction `canSayNone` exists for.
 * It never calls volume wash trading: concentration is a measurement and wash trading is a
 * claim about intent, and the two are kept apart in the shape of the evidence rather than
 * in a caveat at the end. It never reports the `sender` topic as the trader — that is a
 * router in almost every case. And it never blends the venues: each carries its own
 * window, its own completeness and its own counts.
 *
 * Everything is best-effort and nothing throws: each function returns `{ ok, kind,
 * evidence }` or `{ ok: false, error }`, which is the contract lib/ask-tools.js dispatches
 * on. Server-side only: no React.
 */

/* --------------------------------- bounds --------------------------------- */

/**
 * THE DEFAULT WINDOW, IN MINUTES: ten, which is lib/swap-log.js DEFAULT_WINDOW_BLOCKS
 * expressed the way a person asks for it.
 *
 * Ten minutes is 5,600 blocks at the measured 9.4 blocks/second, which fits in ONE
 * eth_getLogs call — the property worth having, because a single-call window either
 * succeeds and is COMPLETE or fails and is honestly unread. Measured today: 4,021 Swap
 * logs in 2,279ms for that window, across 273 distinct pools.
 */
export const DEFAULT_TRADE_MINUTES = 10;

/**
 * THE WIDEST WINDOW THIS MODULE WILL ASK FOR, and the ceiling is the v4 singleton's log
 * DENSITY rather than anybody's preference.
 *
 * 30 minutes is ~16,900 blocks, which is two chunks and about 12,000 Swap logs at the
 * measured rate — under lib/swap-log.js MAX_WINDOW_LOGS of 20,000, but not by much. Past
 * it the row caps start trimming and every count downstream becomes a lower bound, which
 * is honest but is a worse answer than the one a narrower window gives exactly. A question
 * about deeper history is a different lookup: whale_moves and token_transfers read the
 * indexer's transfer index, which covers far longer spans for far less.
 */
export const MAX_TRADE_MINUTES = 30;

/**
 * THE TWO VENUES GET DIFFERENT WINDOWS, AND THE REASON IS A MEASURED DENSITY GAP OF TWO
 * ORDERS OF MAGNITUDE.
 *
 * A v4 pool lives inside ONE singleton that holds every pool on the chain, so 5,600 blocks
 * of it is 4,483 Swap logs. A v3 pool is its own contract: measured, the whole Green Bull
 * pool over 2,000,000 blocks is 123 logs of all types. Reading both over the same ten
 * minutes gives a complete, useful v4 answer and — measured live today — a v3 answer of
 * "nothing observed", every time, for a pool that trades roughly once every 16,000 blocks.
 *
 * A SHARED WINDOW THEREFORE ANSWERS ONE VENUE'S QUESTION AND WASTES THE OTHER'S. So the v3
 * side is read over the widest span lib/swap-log.js will cover in one call —
 * MAX_WINDOW_CHUNKS × MAX_LOG_SPAN, about three and a half hours of chain — and each venue
 * reports the window it was actually read over. That is why nothing here ever adds the two
 * venues' counts together: they are not counts of the same period, let alone of the same
 * market.
 */
export const V3_WINDOW_BLOCKS = MAX_WINDOW_CHUNKS * MAX_LOG_SPAN;

/**
 * WHAT ONE v3 CHUNK COSTS, and why the v3 window is sized by the clock rather than fixed.
 *
 * MEASURED end to end: the full eight-chunk read of The Green Bull's pool took about eleven
 * seconds of a twenty-one second run, which is ~1.4s per chunk including lib/swap-log.js's
 * pacing gap. Eight of those is more than a whole request has, so a fixed wide window would
 * be a constant that quietly overruns the budget every time.
 *
 * So v3ChunksFor turns whatever is left into how many chunks can land, exactly as joinCapFor
 * does for the originator joins. With no budget open the answer is the full eight — about
 * three and a half hours of chain, which on the measured Green Bull pool contained three
 * swaps where ten minutes contained none. The window that was actually read travels with the
 * result either way, so a narrow one understates nothing: it says what it covered.
 */
export const V3_CHUNK_COST_MS = 1_500;

/** How wide the v3 read may be, given what the request has left. Always at least one chunk. */
export function v3ChunksFor(remainingMs, reserveMs = JOIN_MIN_MS) {
  if (!Number.isFinite(remainingMs)) return MAX_WINDOW_CHUNKS;
  const usable = remainingMs - reserveMs;
  if (usable <= 0) return 1;
  return Math.max(1, Math.min(MAX_WINDOW_CHUNKS, Math.floor(usable / V3_CHUNK_COST_MS)));
}

/** Rows in the prose half of the evidence, per side. The table carries the rest. */
export const PROSE_TRADE_ROWS = 8;

/**
 * Rows in the drawn table.
 *
 * A trade row is about 150 characters, so 60 rows is ~9KB against lib/ask-loop.js
 * MAX_EVIDENCE_CHARS of 24,000 — room for the bounds, the notices and a second tool result
 * in the same turn. What gets cut when an evidence blob is truncated mid-JSON is the tail,
 * which is exactly where the honesty fields live, so the rows are what gives way.
 */
export const MAX_TRADE_TABLE_ROWS = 60;

/**
 * How many balances the trader tally may read, and why it is worth doing at all.
 *
 * "Who is dumping this" is half answered by naming the seller and half by saying whether
 * they still hold any. Measured, eight batched balanceOf calls cost 387ms in total — a
 * tenth of what naming those eight wallets cost — so the balance is nearly free once the
 * wallet is known. It is bounded anyway because the batch is only cheap while it is small.
 */
export const MAX_BALANCE_READS = 8;

/**
 * The least remaining work time that makes the v3 pool sweep worth STARTING.
 *
 * MEASURED, and the two numbers are far apart: 6,160ms for a token with no v3 pool (every
 * fee tier of every quote asset swept for nothing) and 3,254ms for one with a pool. Seven
 * seconds is above the worse case with a little room, and a sweep started with four
 * seconds left does not merely fail — it fails and then reports an RPC outage, which is a
 * claim about an upstream that was never really asked. Skipped, it says it was skipped.
 */
export const V3_SWEEP_MIN_MS = 7_000;

/**
 * WHAT ONE TRADER'S NAME COSTS, and the two constants that fall out of it.
 *
 * MEASURED: one eth_getTransaction on this node is ~400ms, six in a row were 401, 399, 402,
 * 399, 402 and 416, and there is no batch form of it here. So the join count is not a
 * preference, it is a division: JOIN_MIN_MS is the least time worth starting one at all, and
 * joinCapFor turns whatever the request has left into how many can actually land.
 *
 * A CAP THAT SHRINKS WITH THE BUDGET RATHER THAN A FIXED ONE THAT OVERRUNS IT. With no
 * budget open — a script, a test — the cap is the full MAX_TRADER_JOINS. Inside a request
 * that has four seconds left it is four names and the rest are honestly unnamed, which is a
 * better answer than eight names and no time to write them up.
 */
export const JOIN_MIN_MS = 1_200;
export const JOIN_COST_MS = 500;

/** Turn remaining work time into how many originator joins can plausibly land. */
export function joinCapFor(remainingMs, limit = MAX_TRADER_JOINS) {
  if (!Number.isFinite(remainingMs)) return limit;
  if (remainingMs < JOIN_MIN_MS) return 0;
  return Math.max(0, Math.min(limit, Math.floor(remainingMs / JOIN_COST_MS)));
}

/** The least remaining work time the balance sweep needs. One batched wave, measured 387ms. */
export const BALANCE_MIN_MS = 1_000;

/**
 * A ROUND TRIP, AS A SHAPE IN THE DATA RATHER THAN A CLAIM ABOUT A PERSON.
 *
 * Two swaps in the SAME pool, in opposite directions, of near-equal subject-token size,
 * inside a short block distance. That is observable from the logs alone with no identity at
 * all, which is the point: naming the originator of every swap costs 400ms each and is not
 * affordable, so the identity-free shape is what can actually be measured over a whole
 * window. It is EVIDENCE OF A SHAPE and nothing else — two different traders can produce it
 * by accident, and an ordinary market maker produces it all day on purpose.
 *
 * 600 blocks is about a minute at the measured chain speed; 2% is tight enough that two
 * unrelated fills rarely match and loose enough to survive a fee.
 */
export const ROUND_TRIP_BLOCKS = 600;
export const ROUND_TRIP_TOLERANCE = 0.02;

/** How many round-trip shapes travel in the evidence. Enough to quote, not a feed. */
export const MAX_ROUND_TRIP_ROWS = 10;

/** The concentration ranks reported for swap size. Same idea as a holder band. */
const VOLUME_RANKS = Object.freeze([1, 3, 5]);

/**
 * How far back swapDetail looks for the PREVIOUS swap in the same pool, which is what makes
 * a price move exact rather than assumed.
 *
 * sqrtPriceX96 in a Swap log is the price AFTER that swap, and nothing except a swap moves
 * it — a liquidity change does not — so the price BEFORE a swap is the sqrtPriceX96 of the
 * most recent prior Swap in that pool. That is an exact figure, not an estimate. Reading it
 * is cheap because the query can be filtered by BOTH topics: measured, topics:[Swap, poolId]
 * over 3,000 blocks answered in 648ms with 4 logs. 12,000 blocks is about twenty minutes of
 * chain; past that the pool was quiet and the move is reported as UNKNOWN rather than zero.
 */
export const PRIOR_SWAP_LOOKBACK_BLOCKS = 12_000;

/** How many swaps in one transaction are described. A routed trade is a handful of hops. */
export const MAX_DETAIL_SWAPS = 8;

/* -------------------------------- sentences ------------------------------- */

/**
 * The sentences that must travel with these answers, spelled once.
 *
 * Finished sentences rather than flags, the same convention as lib/dex-price.js
 * liquidityNotice and lib/request-budget.js budgetNotice: the model must not have to derive
 * "this is a bound" or "this is not a verdict" from a boolean, and a bound the reader cannot
 * see is a lie by omission.
 */
export const SWAP_NOTES = Object.freeze({
  router:
    "The address in each swap's `router` field is the contract that CALLED the pool — a router or aggregator in almost every case, not the wallet that traded. Never report it as the trader.",
  traderBound:
    "A wallet is recovered by joining a swap log to its transaction, which costs one round trip each, so only a bounded number of swaps in a window carry one. A row with no wallet is UNNAMED, not anonymous and not the router.",
  approximateTime:
    "Times are derived from block distance at this chain's measured average of 9.4 blocks per second. They are approximate by construction — a block is not a clock.",
  balance:
    "A balance is what the wallet holds NOW, read from the token contract. It is not a position history: it includes everything that wallet ever received from anywhere, and a wallet that sold in this window may still hold plenty for reasons outside it.",
  venues:
    "The two venues are reported separately and must not be added together. They were read over DIFFERENT windows on purpose — a v4 pool lives inside one singleton whose logs are dense, and a v3 pool is its own quiet contract — so each venue's block range and completeness travel with its own figures, and they are not counts of the same period or the same market.",
  concentration:
    "Volume sitting in few addresses, few transactions or one direction is a MEASUREMENT. Wash trading is a claim about INTENT and is not measurable here: nothing in this data separates a market maker, a bot rebalancing, one desk filling a large order in slices, and somebody trading with themselves. Never assert wash trading, and never attach a likelihood to it.",
  washAbsence:
    "The absence of this pattern proves nothing either. A sole liquidity provider round-tripping its own pool pays the fee to itself, so the pattern is cheap to produce and equally cheap to avoid — a clean-looking window is not evidence that trading is genuine.",
  ordering:
    "A swap that appears earlier in a block was ORDERED BEFORE another one. That is all it establishes: this is a sequencer-ordered L2 with no mempool visibility from here, so being earlier is not evidence that anyone saw the other transaction, and it must never be described as front-running.",
  priceMove:
    "A price move is measured between the pool's state after the PREVIOUS swap and its state after this one. Nothing but a swap moves that price, so the figure is exact when a prior swap was found in the blocks read — and UNKNOWN, never zero, when the pool was quiet through the whole lookback.",
  feeSource:
    "A Uniswap v4 fee is charged per swap and is in the Swap event, so the figure is the fee this trade actually paid. A hook may set it, and there is no tier set on this chain: fees of 0, 100, 252, 10,990, 50,950 and 106,468 hundred-thousandths were all observed in one 5,600-block window.",
});

/** Every way these lookups can decline, each with the sentence a reader should get. */
export const SWAP_EVIDENCE_REASONS = Object.freeze({
  no_client:
    "No RPC client could be built, so the chain was never asked for a swap log. That is a fault on our side — not an outage, and not an absence of trading.",
  manager_unread:
    "Whether the candidate address is the Uniswap v4 PoolManager did not settle, so the singleton that holds every v4 pool on this chain was never read. Whatever traded on v4 in this window is UNKNOWN, not nothing.",
  v3_skipped:
    "The Uniswap v3 pool sweep was not started, because this answer's time limit could not pay for it — measured, that sweep is 3.3 to 6.2 seconds. Whether this token has a v3 pool, and what traded in it, is UNKNOWN rather than absent.",
  v3_no_pool:
    "No Uniswap v3 pool was found for this token, so there were no v3 swap logs to read. On this chain that is ordinary: v4 is where trading happens, and a token can have a real v4 market and no v3 pool at all.",
  no_swap_logs:
    "This transaction's logs were read and contain no Uniswap v3 or Uniswap v4 Swap event, so it did not swap on either of the two venues this reader knows. A swap on some other venue would not be visible here.",
  tx_unread:
    "The transaction could not be read from the chain, so what it did is UNKNOWN. That is an outage, not a transaction that did nothing.",
  tx_not_found:
    "No transaction with that hash exists on this chain, or it has not been mined yet.",
});

/* ------------------------------ small helpers ----------------------------- */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_RE = /^0x[0-9a-fA-F]{64}$/;

/** The minimal ERC-20 surface this module reads. Three immutable-or-cheap getters. */
const ERC20_ABI = Object.freeze([
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
]);

/** token0/token1/fee on a Uniswap v3 pool. Immutable, so one read is forever. */
const V3_POOL_ABI = Object.freeze([
  { name: "token0", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "token1", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "fee", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
]);

function lower(value) {
  const s = String(value ?? "").trim().toLowerCase();
  return ADDRESS_RE.test(s) ? s : null;
}

function sameAddress(a, b) {
  const x = lower(a);
  const y = lower(b);
  return x !== null && y !== null && x === y;
}

/** 0x1234567890abcdef… -> "0x1234…cdef". The form every surface in this app uses. */
function shortHex(value) {
  const v = String(value ?? "");
  return v.length > 12 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v;
}

function nowIso() {
  return new Date().toISOString();
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Run one read without letting it fail the whole answer. A thunk, so a sync throw is caught. */
async function attempt(thunk) {
  try {
    return { ok: true, value: await thunk() };
  } catch (e) {
    return { ok: false, value: null, error: e };
  }
}

/**
 * A base-unit amount as a Number, or null when the decimals are not known.
 *
 * NULL RATHER THAN A DIVISION BY 18. On this chain a pair can span 18 decimals against 6 —
 * USDG has 6, measured — so an amount converted at an assumed precision is wrong by a
 * factor of 10^12 and looks exactly like a number. An unknown-precision amount travels as
 * raw base units, labelled, and nothing here prints it as a size.
 */
function unitsToNumber(raw, decimals) {
  if (raw === null || raw === undefined) return null;
  if (!knownDecimals(decimals)) return null;
  try {
    const n = Number(formatUnits(BigInt(raw), Number(decimals)));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** A token amount as a compact human string, or null when the precision is unknown. */
function amountDisplay(raw, decimals) {
  if (!knownDecimals(decimals)) return null;
  return fmtTokenAmount(raw, Number(decimals));
}

/**
 * Is this an actual precision, or the ABSENCE of one?
 *
 * `Number(null)` is 0 and `Number.isInteger(0)` is true, so the obvious guard lets an unknown
 * precision through as ZERO DECIMALS — which does not fail, it prints. Caught by its own test:
 * a real 2.26M-token swap rendered as "2259363335703.56T", a figure eighteen orders of
 * magnitude out that looks exactly like a number. Unknown must stay unknown.
 */
function knownDecimals(decimals) {
  if (decimals === null || decimals === undefined || decimals === "" || typeof decimals === "boolean") return false;
  const n = Number(decimals);
  return Number.isInteger(n) && n >= 0 && n <= 77;
}

/**
 * A v4/v3 fee as the percentage it actually is.
 *
 * Both venues express the fee in hundredths of a basis point — 10,000 is 1%. THE OBSERVED
 * VALUES ARE NOT A TIER SET: 0, 100, 252, 625, 3,499, 10,990, 16,000, 50,950 and 106,468
 * all appeared in one measured 5,600-block window, and 106,468 is a 10.65% fee on one
 * trade. So nothing here rounds a fee to a familiar tier or assumes one when the log did
 * not carry it.
 *
 * THE ONE VALUE THAT IS NOT A RATE is 8,388,608 (0x800000), the v4 dynamic-fee FLAG: a pool
 * declaring it at Initialize is saying its hook sets the fee per swap, not that it charges
 * 838%. Verified live — pool 0x818914e6… declares 8388608 and its hook charged 16,000 on
 * every swap in a window. It is reported as a flag and never as a percentage.
 */
export const V4_DYNAMIC_FEE_FLAG = 0x800000;

export function feePercent(fee) {
  // null, undefined and "" must not become 0: a v3 Swap event carries NO fee at all, so a
  // row whose fee nobody supplied would otherwise print "0%" — a free trade nobody had.
  if (fee === null || fee === undefined || fee === "" || typeof fee === "boolean") return null;
  const n = Number(fee);
  if (!Number.isInteger(n) || n < 0) return null;
  if (n === V4_DYNAMIC_FEE_FLAG) return null;
  return n / 10_000;
}

/** "1%", "10.65%", "0.01%" — a fee said the way a trader reads it, or null. */
export function feeDisplayOf(fee) {
  const pct = feePercent(fee);
  if (pct === null) {
    return Number(fee) === V4_DYNAMIC_FEE_FLAG
      ? "dynamic (set by the pool's hook per swap, not a rate)"
      : null;
  }
  if (pct === 0) return "0%";
  // FOUR DECIMALS IS EXACT AND NOTHING LESS IS. The fee is an integer number of
  // hundred-thousandths, so a percentage of it has at most four decimal places — rounding to
  // two is lossy in a way that showed up live: a pool declaring 990,000 and charging 990,001
  // both rendered "99%", so the result said the two figures DIFFER while printing them
  // identically. Trailing zeros go, because "1%" is how a 10,000 fee is read.
  return `${Number(pct.toFixed(4))}%`;
}

/**
 * How far the pool's price moved between two sqrtPriceX96 readings, in basis points, for
 * whichever token the caller names as the numerator side.
 *
 * sqrtPriceX96 is sqrt(token1/token0) in ATOMIC units, so the ratio of two readings squared
 * is the move in token0's price expressed in token1 — and the decimals cancel out entirely,
 * because both readings are of the same pair. That is why this figure is exact where a
 * priced one would need decimals nobody may assume.
 *
 * @param {bigint} before
 * @param {bigint} after
 * @param {boolean} forToken0 - true for token0's price, false for token1's
 * @returns {number|null} basis points, signed; null when either reading is unusable
 */
export function priceMoveBps(before, after, forToken0 = true) {
  if (typeof before !== "bigint" || typeof after !== "bigint" || before <= 0n || after <= 0n) return null;
  const ratio = bigRatioToNumber(after, before);
  if (ratio === null || !(ratio > 0)) return null;
  const token0Move = ratio * ratio - 1;
  const move = forToken0 ? token0Move : 1 / (1 + token0Move) - 1;
  // Four decimals, not two: a large trade against a deep pool moves the price by a fraction
  // of a basis point, and rounding that to 2dp turns a MEASURED move into an exact zero —
  // which reads as "this trade moved nothing" rather than "it moved very little".
  return Number.isFinite(move) ? Math.round(move * 10_000 * 10_000) / 10_000 : null;
}

/**
 * "+18.4 bps", "-1,204 bps", or null. Signed, because the direction is the point.
 *
 * A non-zero move too small to show at two decimals prints as "<0.01 bps" rather than as
 * "+0 bps": the figure was measured, and a rendered zero is the one thing it is not.
 */
function bpsDisplay(bps) {
  if (bps === null || !Number.isFinite(bps)) return null;
  const abs = Math.abs(bps);
  const sign = bps < 0 ? "-" : "+";
  if (bps === 0) return "0 bps";
  if (abs < 0.01) return `${sign}<0.01 bps`;
  const shown = abs >= 100 ? Math.round(abs).toLocaleString("en-US") : String(round2(abs));
  return `${sign}${shown} bps`;
}

/**
 * Roughly how long ago a block was, from its distance behind the head.
 *
 * APPROXIMATE AND SAID TO BE. The conversion is the measured chain average of 9.4
 * blocks/second, which is an average and not a clock — the alternative is one
 * eth_getBlockByNumber per distinct block, which for a 222-swap window is 222 round trips
 * to date rows the reader is going to read as "a few minutes ago" anyway.
 */
function agoDisplay(block, head) {
  if (typeof block !== "bigint" || typeof head !== "bigint" || head < block) return null;
  const seconds = Number(head - block) / BLOCKS_PER_SECOND;
  if (!Number.isFinite(seconds)) return null;
  if (seconds < 90) return `~${Math.round(seconds)}s ago`;
  const minutes = seconds / 60;
  if (minutes < 90) return `~${Math.round(minutes)}m ago`;
  return `~${round2(minutes / 60)}h ago`;
}

/* ---------------------------- reading token units -------------------------- */

/**
 * decimals() and symbol() for one currency, or nulls.
 *
 * NATIVE ETH IS NOT A CONTRACT. Uniswap v4 pools quote against the zero address for native
 * ETH — measured, the busiest pools on this chain do — and calling decimals() on the zero
 * address answers nothing. It is answered from knowledge here, which is the one place in
 * this module that is allowed to: the native currency of an Ethereum L2 has 18 decimals by
 * the protocol's own definition, not by a lookup.
 *
 * Cached because both are immutable, and namespaced so the key cannot collide with another
 * module's. A failed read is never cached — see lib/indexer-cache.js.
 */
async function tokenUnits(client, address) {
  const addr = lower(address);
  if (!addr) return { address: null, decimals: null, symbol: null, source: "bad_address" };
  if (addr === NATIVE_CURRENCY) {
    return { address: addr, decimals: 18, symbol: "ETH", source: "native" };
  }
  if (!client || typeof client.readContract !== "function") {
    return { address: addr, decimals: null, symbol: null, source: "no_client" };
  }
  const res = await attempt(() =>
    withIndexerCache(`swapunits:${addr}`, async () => {
      const [decimals, symbol] = await Promise.all([
        attempt(() => client.readContract({ address: addr, abi: ERC20_ABI, functionName: "decimals" })),
        attempt(() => client.readContract({ address: addr, abi: ERC20_ABI, functionName: "symbol" })),
      ]);
      // A contract that will not say its decimals is a contract whose amounts cannot be
      // printed. Thrown rather than stored, so an RPC blip does not harden into "this token
      // has no precision" for the life of the cache entry.
      if (!decimals.ok) throw new Error("decimals() did not answer");
      const d = Number(decimals.value);
      if (!Number.isInteger(d) || d < 0 || d > 77) throw new Error("decimals() out of range");
      return { decimals: d, symbol: symbol.ok ? sanitizeLabel(symbol.value, 16) : null };
    }),
  );
  if (!res.ok) return { address: addr, decimals: null, symbol: null, source: "unread" };
  return { address: addr, decimals: res.value.decimals, symbol: res.value.symbol, source: "contract" };
}

/**
 * The units and the dollar rate for every currency a set of rows touches, bounded.
 *
 * TWO DIFFERENT THINGS, AND ONLY ONE OF THEM IS ALWAYS AVAILABLE. `decimals` makes an
 * amount printable and comes from the contract. `usdPerUnit` makes it a dollar figure and
 * exists only for a currency this chain has a verified rate for — native ETH and WETH
 * through the indexer's ETH/USD, and a stablecoin only if lib/dex-price.js verified it as
 * one by its behaviour. Everything else has a size and no dollar value, which is what it
 * should have: inventing a rate is how a token gets a market cap nobody could realise.
 */
async function currencyMap(client, addresses, { ethPrice, quotes }) {
  const map = new Map();
  const wanted = [];
  for (const raw of addresses) {
    const addr = lower(raw);
    if (!addr || map.has(addr) || wanted.includes(addr)) continue;
    wanted.push(addr);
  }
  // Sequentially issued but concurrently in flight: the shared client batches every call
  // made in the same tick into one JSON-RPC array, which is why eight of these measured
  // 387ms in total rather than 3.2 seconds.
  const read = await Promise.all(wanted.map((addr) => tokenUnits(client, addr)));
  for (const entry of read) {
    if (!entry.address) continue;
    const quote = quotes.get(entry.address) ?? null;
    map.set(entry.address, {
      address: entry.address,
      decimals: entry.decimals ?? quote?.decimals ?? null,
      symbol: entry.symbol,
      decimalsSource: entry.source,
      usdPerUnit: quote?.usdPerUnit ?? (isEthLike(entry.address) ? ethPrice : null),
      usdSource: quote ? quote.source : isEthLike(entry.address) && ethPrice !== null ? "indexer_eth_usd" : null,
    });
  }
  return map;
}

/** Native ETH and canonical WETH price the same, because one wraps the other 1:1. */
function isEthLike(address) {
  return lower(address) === NATIVE_CURRENCY || sameAddress(address, WETH_ADDRESS);
}

/**
 * Canonical WETH on this chain.
 *
 * There is more than one contract here calling itself "Wrapped Ether" and neither the name
 * nor the symbol distinguishes them — lib/dex-price.js DEFAULT_WETH documents the pair and
 * picks the one that is token0 of real pools with real liquidity. It is not exported, so it
 * is repeated here with that note rather than silently re-guessed; the value is the one
 * confirmed live as token0 of the known-good v3 pool 0x8f450B8E….
 */
const WETH_ADDRESS = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";

/* ------------------------------ the shared read --------------------------- */

/**
 * ONE WINDOW OF SWAPS, BOTH VENUES, READY TO ANSWER FROM — the leg recentTrades and
 * realVolume share, because they are two questions about the same read and paying for it
 * twice in one turn would be indefensible.
 *
 * THE STAGE ORDER IS THE CONTENTION FIX, and it is also a priority ordering. The cheap,
 * high-yield work happens first and the expensive, low-yield work happens last, so what
 * gets dropped when the clock runs short is the leg the reader can most afford to lose:
 *
 *   1. resolve the token, and read its metadata off the indexer (a different host).
 *   2. confirm the v4 PoolManager — four eth_calls, cached as a permanent fact.
 *   3. v4 discovery + the v4 window read (lib/swap-log.js tokenSwapFlow, joins off).
 *   4. the v3 pool sweep, behind a budget gate — measured 3.3-6.2s.
 *   5. the v3 window read, which is cheap once the pools are known.
 *   6. the currencies' decimals and symbols, one batched wave of eth_calls.
 *   7. name a CURATED handful of traders, ~400ms each.
 *   8. balances for whoever got named, one batched wave.
 *
 * THE v3 SWEEP'S GATE RESERVES THE JOINS IT WOULD DISPLACE. It is the most expensive leg and
 * it comes before the joins, so a gate that only asked "can the sweep finish" would let it
 * spend the budget and leave the traders unnamed — and "who is dumping this" is a question
 * about wallets. So it may only start when the sweep AND at least a couple of joins still
 * fit, and when it cannot it says it was skipped.
 *
 * @param {string} query - ticker, company name or 0x contract address
 * @param {object} options - `client` (RPC seam), `calls` (indexer seam), `minutes`,
 *   `now`, `sleep`, `joinTraders`, `readBalances`, `v3Pools`, `manager`
 */
async function tradeContext(query, options = {}) {
  const calls = indexerCalls(options);
  const target = await resolveTokenTarget(query, calls);
  if (!target.ok) return target;

  const client = options.client !== undefined ? options.client : poolReadClient();
  if (!client || typeof client.request !== "function") {
    return { ok: false, error: SWAP_EVIDENCE_REASONS.no_client };
  }

  const token = target.address;
  const minutes = clampMinutes(options.minutes);
  const windowBlocks = Math.min(Math.ceil(minutes * 60 * BLOCKS_PER_SECOND), Math.ceil(MAX_TRADE_MINUTES * 60 * BLOCKS_PER_SECOND));

  const skipped = [];
  const note = (label) => {
    skipped.push(label);
    noteBudgetSkip(label);
  };

  /* ---- 1. the subject's own units. The indexer is a different host from the RPC. ---- */
  const meta = await attempt(() => calls.getToken(token));
  const tokenBody = meta.ok ? meta.value : null;
  const indexerDecimals = finiteOrNull(tokenBody?.decimals);
  const symbol = sanitizeLabel(tokenBody?.symbol, 16) ?? target.symbol ?? null;
  const ethPrice = options.ethUsd !== undefined ? options.ethUsd : await attemptValue(() => ethUsd({ calls: options.calls }));

  /* ---- 2. the v4 singleton. Four eth_calls, and a settled verdict is cached forever. ---- */
  const manager =
    options.manager !== undefined
      ? { status: lower(options.manager) ? "confirmed" : "unread", address: lower(options.manager), reason: null }
      : await resolveV4PoolManager({ client });

  /* ---- 3. v4 discovery, then the v4 window. Joins are OFF: see curatedForJoin. ---- */
  const head = toBlock(options.toBlock) ?? (await attemptValue(() => client.getBlockNumber()));
  if (head === null) {
    return { ok: false, error: "The chain would not say what the head block is, so no window could be read. That is an outage, not a quiet market." };
  }
  const v4From = head - BigInt(windowBlocks) + 1n > 0n ? head - BigInt(windowBlocks) + 1n : 0n;

  /**
   * DISCOVERY FIRST, AND ITS ANSWER DECIDES WHETHER THE WINDOW IS READ AT ALL.
   *
   * readV4Pools answers from the chain's own log index over the WHOLE history, so "none" is
   * a measured fact: this token has no Uniswap v4 pool, has never had one, and therefore no
   * swap inside the singleton can possibly be its. Reading 5,640 blocks of the busiest
   * address on the chain to confirm that is 4,000 logs and seconds of budget spent proving
   * something already known — and measured live, that waste is what pushed The Green Bull's
   * v3 sweep out of a real request's budget entirely, so the token's actual market went
   * unread while the venue it does not trade on was swept in full.
   *
   * The discovery is bounded the same way lib/swap-log.js bounds its own, and its result is
   * handed to tokenSwapFlow rather than re-derived there, so the poolMapComplete judgement
   * stays in the one module that owns it.
   */
  const discovery = manager.address
    ? await boundedV4Discovery(client, manager.address, token, options)
    : { status: "unread", pools: [], reason: "manager_unknown" };

  let flow = null;
  let v4 = null;
  if (discovery.status === "none") {
    v4 = {
      ok: true,
      venue: VENUES.V4,
      reason: "no_v4_pool",
      detail:
        "This token has no Uniswap v4 pool — the whole history of the singleton's Initialize log was searched for one, on both sides of the pair, and there is none. So it cannot have traded on v4, and the swap window was not read.",
      rows: [],
      // A real absence, derived from a read that covered everything: no pool, no swap.
      complete: true,
      unattributed: 0,
      decodeFailures: 0,
      rowsCapped: false,
      discovery: { status: "none", poolCount: 0 },
      window: { fromBlock: v4From, toBlock: head, blocks: head - v4From + 1n, blocksUnread: 0n, complete: true },
    };
  } else {
    flow = await tokenSwapFlow(token, {
      client,
      manager: manager.address,
      toBlock: head,
      windowBlocks,
      discovery,
      // The subject's precision, where the indexer supplied it. The counterparties' come from
      // the chain after the read, once we know which currencies actually appear; until then a
      // row's price is null and says why.
      decimals: indexerDecimals === null ? undefined : { [token]: indexerDecimals },
      // v3 is read separately below, and only once its pools are known.
      v3Pools: [],
      joinTraders: false,
      sleep: options.sleep,
      now: options.now,
    });
    if (!flow.window || !flow.venues) {
      return {
        ok: false,
        error: `The swap window could not be read (${flow.reason ?? "unknown"}). ${flow.detail ?? SWAP_EVIDENCE_REASONS.no_client}`,
      };
    }
    v4 = flow.venues[VENUES.V4] ?? null;
  }
  const v4Rows = (v4?.rows ?? []).filter((row) => row.subject);

  /* ---- 4. the v3 sweep: the most expensive leg, and the first thing dropped. ---- */
  let v3Discovery = { status: "skipped", reason: "v3_skipped", poolCount: 0, pools: [] };
  if (Array.isArray(options.v3Pools)) {
    v3Discovery = { status: "supplied", reason: null, poolCount: options.v3Pools.length, pools: options.v3Pools };
  } else if (outOfTimeFor(V3_SWEEP_MIN_MS + JOIN_MIN_MS)) {
    note("uniswap v3 pool sweep");
  } else {
    const swept = await attempt(() => resolvePool(token, { client, calls: options.calls, ethUsd: ethPrice ?? null }));
    if (!swept.ok) {
      v3Discovery = { status: "unread", reason: "discovery_failed", poolCount: 0, pools: [] };
    } else {
      const pools = Array.isArray(swept.value?.pools) ? swept.value.pools : [];
      /**
       * ONLY "no_pool" IS AN ABSENCE. Every other reason lib/dex-price.js can give back —
       * a read that failed, a depth comparison that did not settle, a quote asset it could
       * not re-verify and therefore never swept the tiers of — leaves this token's v3
       * market UNLOOKED-AT rather than absent, and the two must not collapse into one
       * word. The sweep's own reason is carried through so the answer can say WHICH.
       */
      v3Discovery = {
        status: pools.length ? "found" : swept.value?.reason === "no_pool" ? "none" : "unread",
        reason: pools.length ? null : (swept.value?.reason ?? "no_pool"),
        sweepReason: swept.value?.reason ?? null,
        poolCount: pools.length,
        pools,
      };
    }
  }

  /* ---- 5. the v3 window. One read per pool, and a quiet pool is cheap. ---- */
  const v3Pools = (v3Discovery.pools ?? [])
    .map((p) => ({ pool: lower(p.pool), token0: lower(p.token0), token1: lower(p.token1), fee: finiteOrNull(p.fee) }))
    .filter((p) => p.pool);
  // Wider than the v4 window, and as wide as the clock allows — see V3_WINDOW_BLOCKS for why
  // the sparse venue needs its own span, and v3ChunksFor for why that span is not a constant.
  const v3Width = BigInt(Math.max(windowBlocks, v3ChunksFor(remainingWorkMs()) * MAX_LOG_SPAN));
  const v3From = head - v3Width + 1n > 0n ? head - v3Width + 1n : 0n;
  const v3 = v3Pools.length
    ? await readV3Swaps(client, {
        pools: v3Pools,
        fromBlock: v3From,
        toBlock: head,
        subject: token,
        decimals: indexerDecimals === null ? undefined : { [token]: indexerDecimals },
        sleep: options.sleep,
        now: options.now,
        label: "uniswap v3 swap logs",
      })
    : {
        ok: false,
        venue: VENUES.V3,
        reason: v3Discovery.status === "skipped" ? "no_time" : v3Discovery.status === "unread" ? "discovery_failed" : "no_pools",
        detail:
          v3Discovery.status === "skipped"
            ? SWAP_EVIDENCE_REASONS.v3_skipped
            : v3Discovery.status === "unread"
              ? "This token's Uniswap v3 pools could not be listed, so whether it traded there is UNKNOWN — an outage, not a quiet market."
              : SWAP_EVIDENCE_REASONS.v3_no_pool,
        rows: [],
        complete: false,
        unattributed: 0,
        decodeFailures: 0,
        windows: [],
      };
  const v3Rows = (v3.rows ?? []).filter((row) => row.subject);

  /* ---- 6. precisions and dollar rates. One batched wave of eth_calls, measured 387ms. ---- */
  const rows = [...v4Rows, ...v3Rows].sort(chainOrder);
  const currencies = await currencyMap(client, currenciesIn(rows, token), {
    ethPrice,
    quotes: quoteRates(v3Discovery.pools, ethPrice),
  });
  // The subject's own precision comes from the indexer where it answered and from the
  // contract otherwise. Both are the same immutable number, and having two sources for it is
  // why a token whose indexer body failed still prints real amounts rather than raw words.
  if (indexerDecimals !== null) {
    const existing = currencies.get(token) ?? { address: token, symbol, usdPerUnit: null, usdSource: null };
    currencies.set(token, { ...existing, decimals: indexerDecimals, decimalsSource: "indexer" });
  }
  const decimals = currencies.get(token)?.decimals ?? indexerDecimals;

  /* ---- 7. the traders, curated. After every log read, never beside one. ---- */
  const joinCap = joinCapFor(remainingWorkMs());
  const curated = curatedForJoin(rows, token, decimals, joinCap);
  let join = { joined: 0, distinctTransactions: 0, resolved: 0, cappedAt: joinCap, skippedForTime: false };
  if (options.joinTraders === false) {
    // Nothing joined and nothing claimed: every row keeps the `not_joined` source
    // lib/swap-log.js already put on it.
    join.cappedAt = 0;
  } else if (!joinCap || outOfTimeFor(JOIN_MIN_MS)) {
    note("swap originator lookup (tx.from)");
  } else {
    join = await attachTraders(client, curated, { now: options.now, maxJoins: joinCap });
  }

  /* ---- 8. the balances of whoever got named. One batched wave, measured 387ms for eight. ---- */
  const traders = tallyTraders(rows, token, decimals);
  const balances = new Map();
  if (options.readBalances === false || !traders.length) {
    // Asked not to, or nobody to ask about.
  } else if (outOfTimeFor(BALANCE_MIN_MS)) {
    note("current balances of the named traders");
  } else {
    const wanted = traders.slice(0, MAX_BALANCE_READS).map((t) => t.address);
    const read = await Promise.all(
      wanted.map((address) =>
        attempt(() => client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [address] })),
      ),
    );
    wanted.forEach((address, i) => {
      // A balanceOf that ANSWERED zero is a measured zero — that wallet is out. One that did
      // not answer is unread, and the two must never print the same.
      balances.set(address, read[i].ok ? { raw: read[i].value, source: "balanceOf" } : { raw: null, source: "unread" });
    });
  }

  return {
    ok: true,
    target,
    token,
    symbol,
    name: sanitizeLabel(tokenBody?.name, 72),
    decimals,
    decimalsSource: currencies.get(token)?.decimalsSource ?? (indexerDecimals === null ? "unread" : "indexer"),
    totalSupplyRaw: tokenBody?.total_supply ?? null,
    head,
    // The v4 window IS the window the caller asked for; the v3 one is wider by design and is
    // reported beside it rather than instead of it.
    window: { ...describeWindow(v4From, head), minutesRequested: minutes },
    v4Window: describeWindow(v4From, head),
    v3Window: v3Pools.length ? describeWindow(v3From, head) : null,
    windowsDiffer: v3Pools.length > 0 && v3Width !== head - v4From + 1n,
    manager,
    v4,
    v3,
    v3Discovery: {
      status: v3Discovery.status,
      reason: v3Discovery.reason,
      sweepReason: v3Discovery.sweepReason ?? null,
      poolCount: v3Discovery.poolCount,
      note:
        v3Discovery.status === "unread"
          ? `The Uniswap v3 pool sweep did not settle (${v3Discovery.sweepReason ?? "reason not stated"}), so whether this token has a v3 pool — and what traded in it — is UNKNOWN rather than absent.`
          : null,
    },
    rows,
    v4Rows,
    v3Rows,
    join,
    curatedCount: curated.length,
    balances,
    currencies,
    ethPrice,
    skipped,
    client,
  };
}

/**
 * readV4Pools UNDER A CEILING, exactly as lib/swap-log.js tokenSwapFlow puts it under one, and
 * for the measured reason recorded there: discovery is healthy alone (1.0-2.4s for three
 * tokens) and loses when it runs behind a window read, and losing costs four attempts and
 * 4.7 seconds of backoff — 15.9 seconds for one doomed lookup against a 24-second request.
 *
 * The ceiling is imported rather than re-chosen so the callers of readV4Pools cannot drift
 * apart. The losing read is NOT cancelled: it keeps running and warms the shared cache for
 * the next lookup, which is the same bargain lib/dex-price.js v4Discover strikes.
 */
async function boundedV4Discovery(client, manager, token, options) {
  const ceiling =
    Number.isFinite(options.discoveryBudgetMs) && options.discoveryBudgetMs > 0
      ? options.discoveryBudgetMs
      : V4_DISCOVERY_BUDGET_MS;
  return Promise.race([
    readV4Pools(client, manager, token, { sleep: options.sleep }),
    new Promise((resolve) => {
      // Unref'd so a bounded read that lost the race cannot hold a process open on its own.
      setTimeout(() => resolve({ status: "unread", pools: [], poolsDropped: 0, reason: "discovery_failed" }), ceiling).unref?.();
    }),
  ]);
}

/** A block number as a BigInt, or null. Accepts hex, decimal strings, numbers and BigInts. */
function toBlock(raw) {
  if (raw === null || raw === undefined) return null;
  try {
    const n = BigInt(raw);
    return n >= 0n ? n : null;
  } catch {
    return null;
  }
}

/** Await a thunk for its value, or null. For reads whose failure is not itself an answer. */
async function attemptValue(thunk) {
  const res = await attempt(thunk);
  return res.ok ? res.value : null;
}

/**
 * The indexer calls, overridable per call — the same test seam lib/token-evidence.js and
 * lib/ask-tools.js use. Nothing in this module may reach Blockscout during a unit test.
 *
 * The four here are what resolveTokenTarget needs plus the token body: the ticker resolver,
 * the synchronous snapshot hit, the equity registry that tells an outage apart from an
 * unknown ticker, and getToken for the subject's own decimals and symbol.
 */
const DEFAULT_CALLS = Object.freeze({ getToken, listStockTokens, resolveSymbol, snapshotMatch });

function indexerCalls(options) {
  const o = options && typeof options === "object" ? options : {};
  return o.calls && typeof o.calls === "object" ? { ...DEFAULT_CALLS, ...o.calls } : DEFAULT_CALLS;
}

/** Chain order: block, then position inside the block. Deterministic, so callers agree. */
function chainOrder(a, b) {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  return a.logIndex - b.logIndex;
}

/**
 * A block range said the way an answer has to say it — with the range itself, because "the
 * last ten minutes" is a derivation from an average block time and the block numbers are not.
 */
function describeWindow(fromBlock, toBlock) {
  const blocks = Number(toBlock - fromBlock + 1n);
  const mins = round2(blocks / BLOCKS_PER_SECOND / 60);
  const span = mins >= 90 ? `${round2(mins / 60)} hours` : `${mins} minutes`;
  return {
    fromBlock: String(fromBlock),
    toBlock: String(toBlock),
    blocks,
    approxMinutes: mins,
    display: `blocks ${fromBlock}-${toBlock} (${blocks.toLocaleString("en-US")} blocks, about ${span} at this chain's measured 9.4 blocks/second)`,
  };
}

/** The requested window in minutes, clamped. Junk falls back rather than failing. */
function clampMinutes(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TRADE_MINUTES;
  return Math.min(MAX_TRADE_MINUTES, Math.max(1, Math.round(n)));
}

/**
 * WHICH SWAPS GET A WALLET, when only a handful can have one.
 *
 * lib/swap-log.js attachTraders joins the most RECENT transactions, which is the right
 * default for "who is selling right now" and the wrong one for "who is dumping this": the
 * rows worth naming are the BIG ones, and the biggest sell in a window is routinely not
 * among the last eight swaps in it. At ~400ms per join and a cap of eight there is no
 * version of this where every row gets a wallet, so the eight are chosen: the largest
 * sells, the largest buys, and the newest swaps, deduplicated by transaction.
 *
 * ROWS OUTSIDE THIS SET ARE LEFT EXACTLY AS THEY WERE — `trader.address` null with source
 * "not_joined". They are never handed the router's address instead, which is the whole
 * point of the field.
 *
 * THE LIST HANDED BACK HOLDS AT MOST `limit` DISTINCT TRANSACTIONS, and that bound is what
 * makes the curation stick: attachTraders takes the hashes out of whatever list it is given
 * in NEWEST-FIRST order, so a list carrying twenty hashes would spend the eight joins on the
 * eight newest and quietly discard the ranking above. Capping the hash set means every hash
 * in the list gets attempted, whichever order they are attempted in — and every row sharing
 * one of those transactions gets the wallet, which is why the rows are collected by hash at
 * the end rather than as they are picked.
 */
export function curatedForJoin(rows, token, decimals, limit = MAX_TRADER_JOINS) {
  const list = Array.isArray(rows) ? rows.filter((row) => row?.subject?.direction) : [];
  if (limit <= 0) return [];
  const size = (row) => {
    const n = unitsToNumber(subjectLeg(row, token).subjectRaw, decimals);
    return n === null ? 0 : n;
  };
  const bySize = (direction) =>
    list.filter((row) => row.subject.direction === direction).sort((a, b) => size(b) - size(a));
  const newest = [...list].sort((a, b) => chainOrder(b, a));
  // A third each to the biggest sells, the biggest buys and the newest swaps, with whatever
  // the first two do not use falling through to the third.
  const share = Math.max(1, Math.floor(limit / 3));

  const hashes = new Set();
  // Sells first: "who is dumping this" is the question this ordering exists for.
  for (const group of [bySize("sold").slice(0, share), bySize("bought").slice(0, share), newest]) {
    for (const row of group) {
      if (hashes.size >= limit) break;
      hashes.add(row.txHash);
    }
  }
  return list.filter((row) => hashes.has(row.txHash));
}

/**
 * The subject's leg of a swap and the counterparty's, as raw magnitudes.
 *
 * Derived by comparing ADDRESSES rather than by reading the direction, so the two facts
 * stay independent: if the direction were ever wrong, this would not silently agree with
 * it. lib/swap-log.js traderLegs already states both legs from the TRADER's side on both
 * venues, which is what makes a v3 row and a v4 row comparable at all.
 */
function subjectLeg(row, token) {
  const s = row?.subject ?? null;
  if (!s) return { subjectRaw: null, counterRaw: null, counter: null };
  if (sameAddress(s.inCurrency, token)) {
    return { subjectRaw: s.amountIn, counterRaw: s.amountOut, counter: lower(s.outCurrency) };
  }
  if (sameAddress(s.outCurrency, token)) {
    return { subjectRaw: s.amountOut, counterRaw: s.amountIn, counter: lower(s.inCurrency) };
  }
  return { subjectRaw: s.subjectAmount === undefined ? null : absBig(s.subjectAmount), counterRaw: null, counter: null };
}

function absBig(n) {
  return typeof n === "bigint" ? (n < 0n ? -n : n) : null;
}

/** Every currency that appears opposite the subject in a set of rows, plus the subject. */
function currenciesIn(rows, token) {
  const out = [token];
  for (const row of rows) {
    const { counter } = subjectLeg(row, token);
    if (counter) out.push(counter);
  }
  return out;
}

/**
 * The dollar rate for each verified quote asset, out of the v3 sweep's own findings.
 *
 * lib/dex-price.js resolvePool returns a `quote` on every pool it measured, and that quote
 * has EARNED its dollar rate: WETH is the reference, and a stablecoin only appears after
 * being verified by behaviour — a real pool against WETH, live depth in it, and an implied
 * ETH price near the live one. So these rates are taken and none is invented. A currency
 * absent from this map has a size and no dollar value.
 */
function quoteRates(pools, ethPrice) {
  const map = new Map();
  for (const pool of Array.isArray(pools) ? pools : []) {
    const q = pool?.quote;
    const addr = lower(q?.address);
    const decimals = finiteOrNull(q?.decimals);
    const usd = finiteOrNull(q?.usdPerUnit);
    if (!addr || decimals === null) continue;
    map.set(addr, { decimals, usdPerUnit: usd, source: "uniswap v3 verified quote asset" });
  }
  if (ethPrice !== null && !map.has(NATIVE_CURRENCY)) {
    map.set(NATIVE_CURRENCY, { decimals: 18, usdPerUnit: ethPrice, source: "indexer_eth_usd" });
  }
  if (ethPrice !== null && !map.has(WETH_ADDRESS)) {
    map.set(WETH_ADDRESS, { decimals: 18, usdPerUnit: ethPrice, source: "indexer_eth_usd" });
  }
  return map;
}

/* ------------------------------- row shaping ------------------------------ */

/**
 * ONE DECODED SWAP AS A PRINTABLE ROW. Flat, because these go into a table where a nested
 * object renders as "[object Object]".
 *
 * Every figure that needs a precision we do not have comes back null with the raw base
 * units beside it. That is the difference between "0.0000001 of the token" and "we cannot
 * say how much" — and the second is the honest answer for a contract whose decimals() did
 * not answer.
 */
export function tradeRow(row, { token, currencies, head, rank }) {
  const subject = currencies.get(lower(token)) ?? null;
  const { subjectRaw, counterRaw, counter } = subjectLeg(row, token);
  const counterUnits = counter ? (currencies.get(counter) ?? null) : null;
  const amount = unitsToNumber(subjectRaw, subject?.decimals);
  const counterAmount = unitsToNumber(counterRaw, counterUnits?.decimals);
  const usdPerUnit = counterUnits?.usdPerUnit ?? null;
  const valueUsd = counterAmount !== null && usdPerUnit !== null ? counterAmount * usdPerUnit : null;

  return {
    rank: rank ?? null,
    venue: row.venue,
    side: row.subject.direction ?? "no direction",
    block: row.block,
    ago: agoDisplay(row.blockNumber, head),
    amount,
    amountDisplay: amountDisplay(subjectRaw, subject?.decimals),
    amountRaw: subjectRaw === null ? null : String(subjectRaw),
    counterSymbol: counterUnits?.symbol ?? (counter ? shortHex(counter) : null),
    counterAmountDisplay: amountDisplay(counterRaw, counterUnits?.decimals),
    valueUsd,
    valueUsdDisplay: displayNumber(valueUsd, "usd"),
    fee: row.fee,
    feeDisplay: feeDisplayOf(row.fee),
    feeSource: row.feeSource,
    pool: row.pool?.kind === "pool_id" ? shortHex(row.pool.poolId) : shortHex(row.pool?.address),
    poolFull: row.pool?.kind === "pool_id" ? row.pool.poolId : (row.pool?.address ?? null),
    hooked: row.pool?.hooked ?? null,
    // Null with a reason, never the router. See SWAP_NOTES.router.
    trader: row.trader?.address ?? null,
    traderDisplay: row.trader?.address ? shortHex(row.trader.address) : null,
    traderSource: row.trader?.source ?? "not_joined",
    router: row.sender?.address ?? null,
    routerDisplay: row.sender?.address ? shortHex(row.sender.address) : null,
    txHash: row.txHash,
    txShort: shortHex(row.txHash),
  };
}

/**
 * WHO TRADED, TALLIED — one entry per NAMED wallet, with what they bought and sold in this
 * window.
 *
 * Only rows whose originator was actually recovered can appear, so this list is a FLOOR in
 * two directions at once: there are wallets behind the unjoined rows, and each named
 * wallet's totals cover only its rows that were joined. Both bounds are reported rather
 * than left for a reader to infer from a small number sitting beside a large one.
 */
export function tallyTraders(rows, token, decimals) {
  const byAddress = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const address = row?.trader?.address ?? null;
    const direction = row?.subject?.direction ?? null;
    if (!address || !direction) continue;
    const entry = byAddress.get(address) ?? {
      address,
      buys: 0,
      sells: 0,
      boughtRaw: 0n,
      soldRaw: 0n,
      firstBlock: row.block,
      lastBlock: row.block,
    };
    const { subjectRaw } = subjectLeg(row, token);
    entry[direction === "bought" ? "buys" : "sells"] += 1;
    if (typeof subjectRaw === "bigint") {
      entry[direction === "bought" ? "boughtRaw" : "soldRaw"] += subjectRaw;
    }
    entry.firstBlock = Math.min(entry.firstBlock, row.block);
    entry.lastBlock = Math.max(entry.lastBlock, row.block);
    byAddress.set(address, entry);
  }
  return [...byAddress.values()]
    .map((entry) => ({
      ...entry,
      bought: unitsToNumber(entry.boughtRaw, decimals),
      sold: unitsToNumber(entry.soldRaw, decimals),
    }))
    .sort((a, b) => (b.sold ?? 0) + (b.bought ?? 0) - ((a.sold ?? 0) + (a.bought ?? 0)));
}

/* ---------------------------- volume measurements ------------------------- */

/**
 * HOW CONCENTRATED THIS WINDOW'S VOLUME IS — measured four ways, none of them a verdict.
 *
 * The four are deliberately different quantities, because each is a different bound on what
 * anyone may conclude:
 *
 *  - BY SWAP SIZE. What share of the window's subject-token volume sits in the biggest one,
 *    three and five swaps. Exact, identity-free, and the cheapest real signal here.
 *  - BY TRANSACTION. Swaps and transactions are not the same count: a routed trade emits
 *    several Swap events, and reading each as a separate trade doubles somebody's activity.
 *  - BY POOL CALLER. The distinct `sender` topics. Measured on this chain, 248 swaps in the
 *    busiest pool entered through TWO contracts — which says the flow is routed, and says
 *    NOTHING about how many people traded, because a router is not a trader.
 *  - BY NAMED WALLET. Real identity, over the bounded set of rows that got joined. The
 *    denominator travels with it, always, because "3 sellers" out of 8 named rows and out
 *    of 222 swaps are different claims.
 */
export function volumeShape(rows, { token, decimals }) {
  const list = Array.isArray(rows) ? rows.filter((row) => row?.subject?.direction) : [];
  const sizes = [];
  let boughtRaw = 0n;
  let soldRaw = 0n;
  const txs = new Set();
  const callers = new Map();
  let unsized = 0;

  for (const row of list) {
    const { subjectRaw } = subjectLeg(row, token);
    if (typeof subjectRaw === "bigint") {
      sizes.push(subjectRaw);
      if (row.subject.direction === "bought") boughtRaw += subjectRaw;
      else soldRaw += subjectRaw;
    } else {
      unsized += 1;
    }
    txs.add(row.txHash);
    const caller = row.sender?.address ?? null;
    if (caller) callers.set(caller, (callers.get(caller) ?? 0) + 1);
  }

  const total = sizes.reduce((a, b) => a + b, 0n);
  const ranked = [...sizes].sort((a, b) => (a === b ? 0 : a > b ? -1 : 1));
  const topShares = VOLUME_RANKS.filter((n) => n <= ranked.length).map((n) => {
    const sum = ranked.slice(0, n).reduce((a, b) => a + b, 0n);
    const share = total > 0n ? bigRatioToNumber(sum * 10_000n, total) : null;
    const percent = share === null ? null : round2(share / 100);
    return {
      rank: n,
      percent,
      display: percent === null ? null : `${percent}% of the window's volume in the largest ${n === 1 ? "swap" : `${n} swaps`}`,
    };
  });

  const bought = unitsToNumber(boughtRaw, decimals);
  const sold = unitsToNumber(soldRaw, decimals);
  const volume = unitsToNumber(total, decimals);
  const buyShare = volume !== null && volume > 0 && bought !== null ? round2((bought / volume) * 100) : null;

  return {
    swaps: list.length,
    buys: list.filter((row) => row.subject.direction === "bought").length,
    sells: list.filter((row) => row.subject.direction === "sold").length,
    transactions: txs.size,
    swapsPerTransaction: txs.size ? round2(list.length / txs.size) : null,
    // Raw strings beside the human figures: a size we could not convert is not a size of
    // zero, and the raw total is the only exact form when the decimals are unknown.
    volume,
    volumeDisplay: amountDisplay(total, decimals),
    volumeRaw: String(total),
    bought,
    boughtDisplay: amountDisplay(boughtRaw, decimals),
    sold,
    soldDisplay: amountDisplay(soldRaw, decimals),
    netDisplay: amountDisplay(boughtRaw > soldRaw ? boughtRaw - soldRaw : soldRaw - boughtRaw, decimals),
    netDirection: boughtRaw === soldRaw ? "flat" : boughtRaw > soldRaw ? "bought" : "sold",
    buySharePercent: buyShare,
    buyShareDisplay: buyShare === null ? null : `${buyShare}% of the volume was buying, ${round2(100 - buyShare)}% selling`,
    // Swaps whose size could not be converted. Counted so the shares above have a stated
    // denominator rather than a silently smaller one.
    unsizedSwaps: unsized,
    topShares,
    poolCallers: {
      distinct: callers.size,
      rows: [...callers.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([address, swaps]) => ({ address, display: shortHex(address), swaps })),
      note: SWAP_NOTES.router,
    },
  };
}

/**
 * ROUND-TRIP SHAPES: a buy and a sell of near-equal size, in the same pool, close together.
 *
 * IDENTITY-FREE ON PURPOSE. Naming the wallet behind every swap in a window is 400ms a row
 * and is not affordable, so the alternative to this measurement is not a better one — it is
 * none at all. What this finds is a SHAPE: something bought and something very like it sold
 * back within about a minute, in the same pool.
 *
 * WHAT IT CANNOT ESTABLISH, and the two halves matter equally. It does not establish that
 * ONE address did both sides — that needs the join, and `sameWallet` says whether it landed
 * and what it found. And its ABSENCE establishes nothing at all: a sole liquidity provider
 * round-tripping its own pool pays the fee to itself, which makes the pattern cheap to
 * produce and equally cheap to avoid.
 */
export function roundTripShapes(rows, { token, decimals, blocks = ROUND_TRIP_BLOCKS, tolerance = ROUND_TRIP_TOLERANCE } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row?.subject?.direction).slice().sort(chainOrder);
  const used = new Set();
  const found = [];

  for (let i = 0; i < list.length; i += 1) {
    if (used.has(i)) continue;
    const a = list[i];
    const sizeA = unitsToNumber(subjectLeg(a, token).subjectRaw, decimals);
    if (sizeA === null || sizeA <= 0) continue;
    for (let j = i + 1; j < list.length; j += 1) {
      if (used.has(j)) continue;
      const b = list[j];
      if (b.block - a.block > blocks) break;
      if (b.subject.direction === a.subject.direction) continue;
      if (poolKey(a) !== poolKey(b)) continue;
      const sizeB = unitsToNumber(subjectLeg(b, token).subjectRaw, decimals);
      if (sizeB === null || sizeB <= 0) continue;
      if (Math.abs(sizeB - sizeA) / Math.max(sizeA, sizeB) > tolerance) continue;
      used.add(i);
      used.add(j);
      const walletA = a.trader?.address ?? null;
      const walletB = b.trader?.address ?? null;
      found.push({
        pool: poolKey(a),
        poolDisplay: shortHex(poolKey(a)),
        venue: a.venue,
        firstSide: a.subject.direction,
        firstBlock: a.block,
        secondBlock: b.block,
        blocksApart: b.block - a.block,
        sizeDisplay: amountDisplay(subjectLeg(a, token).subjectRaw, decimals),
        // Three states, and they are not interchangeable: the same wallet did both sides,
        // two different wallets did, or nobody looked. The third is the common one.
        sameWallet: walletA && walletB ? walletA === walletB : null,
        wallets: [walletA, walletB],
        firstTx: a.txHash,
        secondTx: b.txHash,
      });
      break;
    }
    if (found.length >= MAX_ROUND_TRIP_ROWS) break;
  }
  return found;
}

function poolKey(row) {
  return row?.pool?.kind === "pool_id" ? row.pool.poolId : (row?.pool?.address ?? null);
}

/* --------------------------------- venue view ----------------------------- */

/**
 * ONE VENUE'S READ, AS THE ANSWER MUST DESCRIBE IT.
 *
 * `canSayNone` is the only field that licenses the sentence "nothing traded", and it is
 * lib/swap-log.js's judgement rather than this module's — it is true only when every block
 * in the window was read AND no swap sat in a pool whose pair could not be named. Anything
 * else gets a notice that says LOWER BOUND, and `observedNone` exists so the model has a
 * phrase for the honest version: no sell was OBSERVED in the blocks that were read.
 */
function venueView(side, summary, { label, window }) {
  const read = Boolean(side?.ok);
  const complete = side?.complete === true;
  const notice = swapNotice(summary, side?.window ?? side?.windows?.[0] ?? null);
  const windowInfo = window ? window.display : "the blocks that were read";
  return {
    venue: label,
    read,
    complete,
    /** The blocks THIS venue was read over. The two venues do not share a window. */
    window,
    reason: side?.reason ?? null,
    detail: side?.detail ?? null,
    swaps: summary.swaps,
    buys: summary.bought,
    sells: summary.sold,
    undirected: summary.undirected,
    distinctBuyersNamed: summary.distinctBuyers,
    distinctSellersNamed: summary.distinctSellers,
    tradersUnnamed: summary.tradersUnknown,
    walletsAreLowerBound: summary.walletsAreLowerBound,
    countsAreLowerBound: summary.atLeast,
    /** The one field that licenses an absence claim. See summariseSwaps. */
    canSayNone: summary.canSayNone,
    observedNone:
      summary.swaps === 0 && read
        ? complete
          ? `No swap of this token was observed on ${label} in ${windowInfo}, and every block in that window was read.`
          : `No swap of this token was observed on ${label} in the part of ${windowInfo} that could be read — and part of it could not, so this is not a finding that none happened.`
        : null,
    blocksUnread: side?.window?.blocksUnread !== undefined ? String(side.window.blocksUnread) : null,
    notice,
  };
}

/* ------------------------------- recent trades ---------------------------- */

/**
 * WHO HAS BEEN BUYING AND SELLING THIS TOKEN LATELY, AND HOW MUCH.
 *
 * The answer to "who is dumping", "any buys", "is anyone actually trading this" — and the
 * first lookup in this codebase that can answer any of them, because a transfer list cannot:
 * a transfer says something moved, and a swap says somebody bought or sold. Buys and sells
 * are reported SEPARATELY with their sizes, each venue carries its own window and its own
 * completeness, and every wallet named comes from tx.from rather than from the router in the
 * log.
 *
 * WHAT IT CANNOT ESTABLISH. It cannot say nobody is selling: a window is blocks that were
 * read, and the honest negative is "no sell was observed in the N blocks read". It cannot
 * name most traders — one join per transaction at ~400ms means a bounded few get a wallet
 * and the rest are UNNAMED. It cannot see trading anywhere but Uniswap v3 and v4 pools it
 * could identify. And a wallet's balance is what it holds now, not a position history.
 *
 * @param {string} query - ticker, company name or 0x contract address
 * @param {{ minutes?: number, client?: object, calls?: object }} [options]
 */
export async function recentTrades(query, options = {}) {
  try {
    const ctx = await tradeContext(query, options);
    if (!ctx.ok) return ctx;

    const windowInfo = ctx.windowsDiffer
      ? `${ctx.v4Window.display} on Uniswap v4 and ${ctx.v3Window.display} on Uniswap v3`
      : ctx.v4Window.display;
    const v4Summary = summariseSwaps(countable(ctx.v4?.rows), { complete: ctx.v4?.complete === true });
    const v3Summary = summariseSwaps(countable(ctx.v3?.rows), { complete: ctx.v3?.complete === true });

    const shaped = ctx.rows
      .slice()
      .sort((a, b) => chainOrder(b, a))
      .map((row, i) => tradeRow(row, { token: ctx.token, currencies: ctx.currencies, head: ctx.head, rank: i + 1 }));
    const buys = shaped.filter((row) => row.side === "bought");
    const sells = shaped.filter((row) => row.side === "sold");

    const traders = tallyTraders(ctx.rows, ctx.token, ctx.decimals).map((entry) => {
      const balance = ctx.balances.get(entry.address) ?? { raw: null, source: "not_read" };
      const held = unitsToNumber(balance.raw, ctx.decimals);
      return {
        address: entry.address,
        display: shortHex(entry.address),
        buys: entry.buys,
        sells: entry.sells,
        boughtDisplay: amountDisplay(entry.boughtRaw, ctx.decimals),
        soldDisplay: amountDisplay(entry.soldRaw, ctx.decimals),
        netDirection: entry.boughtRaw === entry.soldRaw ? "flat" : entry.boughtRaw > entry.soldRaw ? "bought" : "sold",
        firstBlock: entry.firstBlock,
        lastBlock: entry.lastBlock,
        // A zero balanceOf ANSWERED is a wallet that is out; a balance that was not read is
        // unknown. They must never print the same, so the source travels with the figure.
        balance: held,
        balanceDisplay: balance.source === "balanceOf" ? amountDisplay(balance.raw, ctx.decimals) : null,
        balanceSource: balance.source,
        balanceNote: balance.source === "balanceOf" ? null : "This wallet's current balance was not read, so what it still holds is unknown — not zero.",
      };
    });

    const table = buildTable({
      id: "recent-trades",
      title: `${shaped.length} swap${shaped.length === 1 ? "" : "s"} of ${ctx.symbol ?? shortHex(ctx.token)} in ${windowInfo}`,
      columns: [
        col("rank", "#", "right"),
        col("side", "Side"),
        col("venue", "Venue"),
        col("block", "Block", "right"),
        col("ago", "Approx. age"),
        col("amountDisplay", "Amount", "right"),
        col("counterAmountDisplay", "Paid/received", "right"),
        col("counterSymbol", "In"),
        col("valueUsdDisplay", "Value", "right"),
        col("feeDisplay", "Fee", "right"),
        col("traderDisplay", "Trader"),
        col("routerDisplay", "Called pool via"),
        col("txShort", "Tx"),
      ],
      rows: shaped.slice(0, MAX_TRADE_TABLE_ROWS),
      totalRows: shaped.length,
      truncated: shaped.length > MAX_TRADE_TABLE_ROWS,
      note: [
        `Newest first, over ${windowInfo}.`,
        "\"Side\" is from the TRADER's side: bought means the wallet received this token.",
        SWAP_NOTES.router,
        SWAP_NOTES.traderBound,
        SWAP_NOTES.approximateTime,
      ].join(" "),
    });

    return {
      ok: true,
      kind: "trades",
      evidence: {
        address: ctx.token,
        symbol: ctx.symbol,
        name: ctx.name,
        company: ctx.target.company ?? null,
        window: ctx.window,
        signConvention: {
          ...AMOUNT_SIGN_CONVENTION,
          note: "Uniswap v3 and Uniswap v4 report swap amounts from OPPOSITE sides — v4's are the swapper's delta, v3's are the pool's — and both were measured on this chain. Direction was derived once from that, not from a convention.",
        },
        venues: {
          [VENUES.V4]: venueView(ctx.v4, v4Summary, { label: "Uniswap v4", window: ctx.v4Window }),
          [VENUES.V3]: venueView(ctx.v3, v3Summary, { label: "Uniswap v3", window: ctx.v3Window }),
        },
        v4PoolManager: {
          status: ctx.manager.status,
          address: ctx.manager.address,
          reason: ctx.manager.reason,
          note: ctx.manager.status === "confirmed" ? null : SWAP_EVIDENCE_REASONS.manager_unread,
        },
        v3Pools: ctx.v3Discovery,
        /**
         * THE COMBINED ROWS, AND THE ONE THING THAT MAY NOT BE DONE WITH THEM.
         *
         * These counts are over both venues' attributed rows, which is the right list to
         * READ — the biggest sell of this token is the biggest sell whichever venue it
         * happened on. It is the wrong list to describe as a period: when
         * `countsSpanTwoWindows` is true the two halves were read over different block
         * ranges, so "N swaps in the last ten minutes" is false of the combined figure even
         * though each venue's own figure is exactly that. Quote the per-venue counts with
         * their windows; use these for the rows, not for the arithmetic.
         */
        swaps: shaped.length,
        buyCount: buys.length,
        sellCount: sells.length,
        countsSpanTwoWindows: Boolean(ctx.windowsDiffer && (ctx.v3?.rows?.length ?? 0) > 0),
        countsSpanNote: ctx.windowsDiffer
          ? `These combined counts cover ${windowInfo} — two different block ranges. Each venue's own count and window are above; do not describe the combined figure as one period.`
          : null,
        buys: buys.slice(0, PROSE_TRADE_ROWS),
        sells: sells.slice(0, PROSE_TRADE_ROWS),
        traders,
        tradersNamed: traders.length,
        tradersUnnamed: v4Summary.tradersUnknown + v3Summary.tradersUnknown,
        originators: {
          ...ctx.join,
          rowsOffered: ctx.curatedCount,
          note: "Wallets come from tx.from on a bounded, CHOSEN set of swaps — the largest sells, the largest buys and the newest — because each one costs a round trip. Every other row reports no wallet, which is unnamed and never the router.",
        },
        notes: [
          SWAP_NOTES.venues,
          SWAP_NOTES.router,
          SWAP_NOTES.traderBound,
          SWAP_NOTES.balance,
          SWAP_NOTES.approximateTime,
          SWAP_NOTES.ordering,
        ],
        ...(ctx.skipped.length ? { skippedForTime: ctx.skipped } : {}),
        ...(ctx.decimals === null
          ? {
              decimalsUnknown: true,
              decimalsNote:
                "This token's precision could not be read from either the indexer or the contract, so no amount below is converted into token units — the raw base-unit figures are all that can honestly be shown.",
            }
          : {}),
        table,
        asOf: nowIso(),
      },
    };
  } catch (e) {
    return { ok: false, error: `The recent swaps could not be read: ${String(e?.message ?? e).slice(0, 200)}.` };
  }
}

/** Rows a per-token count may include. See tokenSwapFlow's note: unnameable rows stay in. */
function countable(rows) {
  return (Array.isArray(rows) ? rows : []).filter(
    (row) => row.subject || row.pool?.pairUnknownReason !== "not_this_token_pool",
  );
}

/* -------------------------------- real volume ----------------------------- */

/**
 * HOW MUCH OF THIS VOLUME IS TWO-SIDED TRADING, AND HOW CONCENTRATED IT IS.
 *
 * The lookup for "is the volume real", "is this wash traded", "is one guy trading with
 * himself". It reports MEASUREMENTS: how many swaps and how many transactions, how much of
 * the volume sits in the largest few swaps, how one-sided the flow is, how many distinct
 * contracts called the pool, how many wallets were actually named out of how many, and how
 * many round-trip SHAPES appear.
 *
 * WASH TRADING IS NOT ONE OF THOSE MEASUREMENTS, AND THIS IS THE WHOLE DISCIPLINE OF THE
 * TOOL. It is a claim about INTENT, and nothing in a swap log separates a market maker, a
 * bot rebalancing, one desk filling a large order in slices, and somebody trading with
 * themselves. So the shape is reported, the inference is refused, and both halves are in
 * the evidence rather than in a caveat at the end.
 *
 * ITS ABSENCE PROVES NOTHING EITHER. A sole liquidity provider round-tripping its own pool
 * pays the fee to itself — the pattern is cheap to produce, so a window that looks clean is
 * not evidence that the trading in it is genuine. That sentence ships with every result,
 * including the quiet ones.
 *
 * @param {string} query - ticker, company name or 0x contract address
 * @param {{ minutes?: number, client?: object, calls?: object }} [options]
 */
export async function realVolume(query, options = {}) {
  try {
    const ctx = await tradeContext(query, options);
    if (!ctx.ok) return ctx;

    const v4Summary = summariseSwaps(countable(ctx.v4?.rows), { complete: ctx.v4?.complete === true });
    const v3Summary = summariseSwaps(countable(ctx.v3?.rows), { complete: ctx.v3?.complete === true });

    /**
     * EVERY MEASUREMENT IS PER VENUE, and that is not tidiness — it is the same rule that
     * keeps the two windows apart. The venues were read over different block ranges, so a
     * combined "58% of the volume was buying" would be a share of two periods added
     * together, which is not a share of anything. Each venue's shape is computed over its
     * own rows and its own window, and nothing sums them.
     */
    const perVenue = {};
    for (const [key, side, window] of [
      [VENUES.V4, ctx.v4, ctx.v4Window],
      [VENUES.V3, ctx.v3, ctx.v3Window],
    ]) {
      const rows = (side?.rows ?? []).filter((row) => row.subject);
      const shape = volumeShape(rows, { token: ctx.token, decimals: ctx.decimals });
      perVenue[key] = {
        window,
        measured: {
          swaps: shape.swaps,
          transactions: shape.transactions,
          swapsPerTransaction: shape.swapsPerTransaction,
          swapsPerTransactionNote:
            "Swaps and transactions are different counts. One routed trade emits several Swap events, so reading each event as a separate trade overstates how many times anybody traded.",
          buys: shape.buys,
          sells: shape.sells,
          volumeDisplay: shape.volumeDisplay,
          volumeRaw: shape.volumeRaw,
          boughtDisplay: shape.boughtDisplay,
          soldDisplay: shape.soldDisplay,
          netDirection: shape.netDirection,
          netDisplay: shape.netDisplay,
          buySharePercent: shape.buySharePercent,
          buyShareDisplay: shape.buyShareDisplay,
          unsizedSwaps: shape.unsizedSwaps,
        },
        concentration: { topShares: shape.topShares, poolCallers: shape.poolCallers },
        roundTrips: roundTripShapes(rows, { token: ctx.token, decimals: ctx.decimals }),
      };
    }

    const trips = [...perVenue[VENUES.V4].roundTrips, ...perVenue[VENUES.V3].roundTrips];
    const traders = tallyTraders(ctx.rows, ctx.token, ctx.decimals);
    const swapTotal = perVenue[VENUES.V4].measured.swaps + perVenue[VENUES.V3].measured.swaps;
    const txTotal = perVenue[VENUES.V4].measured.transactions + perVenue[VENUES.V3].measured.transactions;

    // The named wallets are a SAMPLE and the denominator is stated every time it is used.
    // "2 of the 2 named wallets did both sides" is a fact about two wallets, not about a
    // token, and the difference is the whole distance between a measurement and a smear.
    const bothSides = traders.filter((t) => t.buys > 0 && t.sells > 0);
    const namedCoverage = {
      wallets: traders.length,
      ofSwaps: swapTotal,
      ofTransactions: txTotal,
      joinsAttempted: ctx.join.joined,
      display: `${traders.length} wallet${traders.length === 1 ? "" : "s"} named out of ${txTotal} transaction${txTotal === 1 ? "" : "s"} carrying ${swapTotal} swap${swapTotal === 1 ? "" : "s"}`,
    };
    const windowInfo = ctx.windowsDiffer
      ? `${ctx.v4Window.display} on Uniswap v4 and ${ctx.v3Window.display} on Uniswap v3`
      : ctx.v4Window.display;

    const table = buildTable({
      id: "round-trip-shapes",
      title: `${trips.length} round-trip shape${trips.length === 1 ? "" : "s"} in ${windowInfo}`,
      columns: [
        col("poolDisplay", "Pool"),
        col("venue", "Venue"),
        col("firstSide", "First side"),
        col("firstBlock", "First block", "right"),
        col("secondBlock", "Second block", "right"),
        col("blocksApart", "Blocks apart", "right"),
        col("sizeDisplay", "Size", "right"),
        col("sameWallet", "Same wallet?"),
      ],
      rows: trips,
      totalRows: trips.length,
      truncated: trips.length >= MAX_ROUND_TRIP_ROWS,
      note: [
        `A buy and a sell of the same token, in the same pool, within ${ROUND_TRIP_BLOCKS} blocks and ${round2(ROUND_TRIP_TOLERANCE * 100)}% of each other in size.`,
        "\"Same wallet?\" is null when neither side's originator was named, which is the usual case — it means nobody looked, not that they differ.",
        SWAP_NOTES.concentration,
        SWAP_NOTES.washAbsence,
      ].join(" "),
    });

    return {
      ok: true,
      kind: "volumeQuality",
      evidence: {
        address: ctx.token,
        symbol: ctx.symbol,
        name: ctx.name,
        window: ctx.window,
        windowsDiffer: ctx.windowsDiffer,
        venues: {
          [VENUES.V4]: venueView(ctx.v4, v4Summary, { label: "Uniswap v4", window: ctx.v4Window }),
          [VENUES.V3]: venueView(ctx.v3, v3Summary, { label: "Uniswap v3", window: ctx.v3Window }),
        },
        v3Pools: ctx.v3Discovery,
        /** Every count and every share, kept under the venue and the window it was read over. */
        perVenue,
        namedWallets: {
          ...namedCoverage,
          rows: traders.slice(0, PROSE_TRADE_ROWS).map((t) => ({
            address: t.address,
            display: shortHex(t.address),
            buys: t.buys,
            sells: t.sells,
            boughtDisplay: amountDisplay(t.boughtRaw, ctx.decimals),
            soldDisplay: amountDisplay(t.soldRaw, ctx.decimals),
            bothSides: t.buys > 0 && t.sells > 0,
          })),
          bothSidesCount: bothSides.length,
          note: "These wallets are the ones a bounded set of joins happened to name — chosen as the largest and newest swaps, not sampled at random. A figure over them is a fact about THEM and must never be presented as a share of the token's trading.",
        },
        roundTrips: {
          count: trips.length,
          windowBlocks: ROUND_TRIP_BLOCKS,
          tolerancePercent: round2(ROUND_TRIP_TOLERANCE * 100),
          shapes: trips,
          sameWalletConfirmed: trips.filter((t) => t.sameWallet === true).length,
          sameWalletUnknown: trips.filter((t) => t.sameWallet === null).length,
          note: "A round trip here is a SHAPE in the logs — something bought and something very like it sold back shortly after, in the same pool. Whether one address did both sides is only known where both joins landed, and it usually is not.",
        },
        /**
         * THE INFERENCE, REFUSED IN THE EVIDENCE ITSELF rather than left to the prompt.
         * Every field above is a count of something that happened; this is the line between
         * those counts and the accusation a reader will reach for.
         */
        inference: {
          claim: "wash trading",
          measurable: false,
          statement: SWAP_NOTES.concentration,
          absence: SWAP_NOTES.washAbsence,
          ordering: SWAP_NOTES.ordering,
        },
        notes: [SWAP_NOTES.venues, SWAP_NOTES.router, SWAP_NOTES.traderBound],
        ...(ctx.skipped.length ? { skippedForTime: ctx.skipped } : {}),
        table,
        asOf: nowIso(),
      },
    };
  } catch (e) {
    return { ok: false, error: `The volume could not be examined: ${String(e?.message ?? e).slice(0, 200)}.` };
  }
}

/* -------------------------------- swap detail ----------------------------- */

/**
 * WHAT ACTUALLY HAPPENED IN ONE SWAP — venue, pool, the fee that was really charged, the
 * tokens in and out, and how far the price moved.
 *
 * The lookup for "why did my swap eat 97% of my bag", "what fee did I pay", "what did this
 * tx actually do". The fee is the answer to more of those than anything else: a v4 fee is
 * charged per swap and sits in the Swap event, and on this chain it is not a tier. Measured
 * in one 5,600-block window: 0, 100, 252, 625, 3,499, 10,990, 16,000, 50,950 and 106,468.
 * The last of those is a 10.65% fee on a single trade, and it is in the log rather than
 * anywhere a caller could have guessed it.
 *
 * IT READS THE CHAIN, NOT THE INDEXER, and that is a measurement: eth_getTransactionByHash
 * is 707ms and eth_getTransactionReceipt 383ms against the indexer's 4,648ms and 2,785ms
 * for the same transaction and the same 17 logs.
 *
 * WHAT IT CANNOT ESTABLISH. It sees only Uniswap v3 and v4 Swap events: a swap on another
 * venue leaves no log this reader knows, so "no swap here" means none on those two. The
 * price move is exact only when a PRIOR swap in the same pool was found in the blocks read
 * — otherwise it is UNKNOWN, never zero. It cannot say what a trade was worth in dollars
 * unless one side is a currency this chain has a verified rate for. And it says nothing
 * about intent: a swap that lost most of its value did so through a fee and a price move,
 * both of which are stated, and neither of which establishes that anybody arranged it.
 *
 * @param {string} hash - a 0x transaction hash
 * @param {{ client?: object }} [options]
 */
export async function swapDetail(hash, options = {}) {
  const tx = String(hash ?? "").trim().toLowerCase();
  if (!TX_RE.test(tx)) {
    return { ok: false, error: `"${String(hash ?? "").slice(0, 80)}" is not a transaction hash. A hash is 0x followed by exactly 64 hex characters.` };
  }

  try {
    const client = options.client !== undefined ? options.client : poolReadClient();
    if (!client || typeof client.request !== "function") {
      return { ok: false, error: SWAP_EVIDENCE_REASONS.no_client };
    }

    // The two chain reads, in sequence: the transaction for who signed it and what it
    // called, the receipt for its logs and what it cost. Not concurrent, for the reason
    // every stage in this module is sequential.
    const txRes = await attempt(() => client.getTransaction({ hash: tx }));
    if (!txRes.ok) {
      const missing = /not (be )?found/i.test(String(txRes.error?.message ?? ""));
      return { ok: false, error: missing ? SWAP_EVIDENCE_REASONS.tx_not_found : SWAP_EVIDENCE_REASONS.tx_unread };
    }
    const receipt = await attemptValue(() => client.getTransactionReceipt({ hash: tx }));
    if (!receipt) return { ok: false, error: SWAP_EVIDENCE_REASONS.tx_unread };

    const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
    const manager = options.manager !== undefined
      ? { status: lower(options.manager) ? "confirmed" : "unread", address: lower(options.manager), reason: null }
      : await resolveV4PoolManager({ client });

    // Decoded client-side, and the topic is re-checked on every row: whether the node
    // applied a filter is not something correctness may depend on here either.
    const decoded = [];
    for (const log of logs) {
      const topic0 = String(log?.topics?.[0] ?? "").toLowerCase();
      if (topic0 === SWAP_TOPICS[VENUES.V4]) {
        const row = decodeV4SwapLog(log);
        if (row) decoded.push({ ...row, emitter: lower(log.address) });
      } else if (topic0 === SWAP_TOPICS[VENUES.V3]) {
        const row = decodeV3SwapLog(log, {});
        if (row) decoded.push({ ...row, emitter: lower(log.address) });
      }
      if (decoded.length >= MAX_DETAIL_SWAPS) break;
    }

    const ethPrice = options.ethUsd !== undefined ? options.ethUsd : await attemptValue(() => ethUsd({ calls: options.calls }));
    const swaps = [];
    for (const row of decoded) {
      swaps.push(await describeSwap(client, row, { manager, ethPrice, options }));
    }

    const gasUsed = receipt.gasUsed ?? null;
    const gasPrice = receipt.effectiveGasPrice ?? txRes.value?.gasPrice ?? null;
    const feeWei = typeof gasUsed === "bigint" && typeof gasPrice === "bigint" ? gasUsed * gasPrice : null;
    const feeEth = unitsToNumber(feeWei, 18);

    const table = buildTable({
      id: "swap-detail",
      title: `${swaps.length} swap${swaps.length === 1 ? "" : "s"} in ${shortHex(tx)}`,
      columns: [
        col("hop", "#", "right"),
        col("venue", "Venue"),
        col("poolDisplay", "Pool"),
        col("paidDisplay", "Paid", "right"),
        col("paidSymbol", "Paid in"),
        col("receivedDisplay", "Received", "right"),
        col("receivedSymbol", "Received in"),
        col("feeDisplay", "Fee charged", "right"),
        col("priceMoveDisplay", "Pool price move"),
      ],
      rows: swaps.map((s, i) => ({
        hop: i + 1,
        venue: s.venue,
        poolDisplay: s.pool.display,
        paidDisplay: s.paid.amountDisplay,
        paidSymbol: s.paid.symbol,
        receivedDisplay: s.received.amountDisplay,
        receivedSymbol: s.received.symbol,
        feeDisplay: s.fee.display,
        priceMoveDisplay: s.priceMove.display,
      })),
      note: [
        "One row per Swap event in this transaction, in log order — a routed trade is several hops of one trade, not several trades.",
        SWAP_NOTES.feeSource,
        SWAP_NOTES.priceMove,
      ].join(" "),
    });

    return {
      ok: true,
      kind: "swap",
      evidence: {
        txHash: tx,
        status: receipt.status ?? null,
        // tx.from is the wallet that SIGNED this, which is the trader. tx.to is whatever
        // contract they called — a router in almost every routed swap.
        trader: lower(txRes.value?.from),
        traderDisplay: lower(txRes.value?.from) ? shortHex(lower(txRes.value.from)) : null,
        calledContract: lower(txRes.value?.to),
        calledContractDisplay: txRes.value?.to ? shortHex(lower(txRes.value.to)) : null,
        method: txRes.value?.input ? String(txRes.value.input).slice(0, 10) : null,
        block: receipt.blockNumber === undefined ? null : Number(receipt.blockNumber),
        gasFeeEth: feeEth,
        gasFeeEthDisplay: feeEth === null ? null : `${Number(feeEth.toPrecision(4))} ETH`,
        gasFeeUsdDisplay: feeEth !== null && ethPrice !== null ? displayNumber(feeEth * ethPrice, "usd") : null,
        swapCount: swaps.length,
        swaps,
        v4PoolManager: { status: manager.status, address: manager.address, reason: manager.reason },
        ...(swaps.length
          ? {}
          : {
              noSwap: true,
              noSwapReason: SWAP_EVIDENCE_REASONS.no_swap_logs,
              logCount: logs.length,
            }),
        notes: [SWAP_NOTES.feeSource, SWAP_NOTES.priceMove, SWAP_NOTES.router, SWAP_NOTES.ordering],
        table,
        asOf: nowIso(),
      },
    };
  } catch (e) {
    return { ok: false, error: `The transaction could not be examined: ${String(e?.message ?? e).slice(0, 200)}.` };
  }
}

/**
 * ONE DECODED SWAP, FULLY DESCRIBED — the pair, the legs, the fee, the move.
 *
 * The pair is what everything else needs, and where it comes from differs by venue because
 * the venues are shaped differently. A v3 pool is its own contract, so token0/token1/fee are
 * three immutable getters on it. A v4 pool is a key inside one singleton, so its pair lives
 * in the Initialize log — read by BOTH topics, which is the cheap query on this node:
 * measured, a fully-filtered Initialize lookup over the whole 23,300,000-block history
 * answered in 291ms.
 */
async function describeSwap(client, row, { manager, ethPrice, options }) {
  const isV4 = row.venue === VENUES.V4;
  const pair = isV4 ? await v4PoolKey(client, manager.address, row.poolId, options) : await v3PoolPair(client, row.pool);
  const c0 = lower(pair?.currency0);
  const c1 = lower(pair?.currency1);

  const units = await currencyMap(client, [c0, c1].filter(Boolean), {
    ethPrice,
    quotes: quoteRates([], ethPrice),
  });
  const u0 = c0 ? units.get(c0) : null;
  const u1 = c1 ? units.get(c1) : null;

  const legs = traderLegs(row.venue, row.amount0, row.amount1);
  const paidIsToken0 = legs ? legs.inCurrency === 0 : null;
  const paidUnits = paidIsToken0 === null ? null : paidIsToken0 ? u0 : u1;
  const gotUnits = paidIsToken0 === null ? null : paidIsToken0 ? u1 : u0;
  const paidAmount = unitsToNumber(legs?.amountIn, paidUnits?.decimals);
  const gotAmount = unitsToNumber(legs?.amountOut, gotUnits?.decimals);

  const prior = await priorSwapPrice(client, row, { manager, options });
  // The move is stated for the token the trader RECEIVED, because that is the side a reader
  // is asking about when they ask what a swap cost them. Unknown which side that was means
  // no move is reported — an unlabelled bps figure would be the wrong token's.
  const bps =
    prior.sqrtPriceX96 === null || paidIsToken0 === null
      ? null
      : priceMoveBps(prior.sqrtPriceX96, row.sqrtPriceX96, paidIsToken0 === false);

  // What the trade actually got per unit paid, against where the pool ENDED. It bundles the
  // fee and the trade's own impact together and is labelled as doing so: it is not a
  // slippage figure and it is not a fee figure.
  const executionPrice = paidAmount !== null && gotAmount !== null && paidAmount > 0 ? gotAmount / paidAmount : null;
  const pairPriceable = Number.isInteger(u0?.decimals) && Number.isInteger(u1?.decimals);
  const poolAfter =
    paidIsToken0 === null || !pairPriceable ? null : priceFromSqrtX96(row.sqrtPriceX96, u0.decimals, u1.decimals, paidIsToken0);
  const vsPoolBps =
    executionPrice !== null && poolAfter !== null && poolAfter > 0 ? round2((executionPrice / poolAfter - 1) * 10_000) : null;

  return {
    venue: row.venue,
    pool: {
      kind: isV4 ? "pool_id" : "address",
      id: isV4 ? row.poolId : row.pool,
      display: shortHex(isV4 ? row.poolId : row.pool),
      // A v4 pool has NO contract address of its own: every pool lives inside the singleton,
      // so this id must never be presented as a contract to look up.
      contract: isV4 ? manager.address : row.pool,
      known: Boolean(pair),
      reason: pair ? null : isV4 ? "initialize_log_unread" : "pool_getters_unread",
      currency0: c0,
      currency1: c1,
      currency0Symbol: u0?.symbol ?? null,
      currency1Symbol: u1?.symbol ?? null,
      tickSpacing: pair?.tickSpacing ?? null,
      hooks: pair?.hooks ?? null,
      hooked: pair?.hooked ?? null,
      hookNote:
        pair?.hooked === true
          ? "This pool names a HOOK — a contract that runs inside every swap on it and may set the fee per trade. The fee below is the one the log says was charged."
          : null,
    },
    paid: {
      currency: paidUnits?.address ?? null,
      symbol: paidUnits?.symbol ?? (paidUnits?.address ? shortHex(paidUnits.address) : null),
      amount: paidAmount,
      amountDisplay: amountDisplay(legs?.amountIn, paidUnits?.decimals),
      amountRaw: legs?.amountIn === undefined ? null : String(legs.amountIn),
      valueUsdDisplay:
        paidAmount !== null && paidUnits?.usdPerUnit ? displayNumber(paidAmount * paidUnits.usdPerUnit, "usd") : null,
    },
    received: {
      currency: gotUnits?.address ?? null,
      symbol: gotUnits?.symbol ?? (gotUnits?.address ? shortHex(gotUnits.address) : null),
      amount: gotAmount,
      amountDisplay: amountDisplay(legs?.amountOut, gotUnits?.decimals),
      amountRaw: legs?.amountOut === undefined ? null : String(legs.amountOut),
      valueUsdDisplay:
        gotAmount !== null && gotUnits?.usdPerUnit ? displayNumber(gotAmount * gotUnits.usdPerUnit, "usd") : null,
    },
    fee: {
      raw: row.fee,
      percent: feePercent(row.fee),
      display: feeDisplayOf(row.fee),
      source: row.feeSource,
      declaredAtInitialize: pair?.fee ?? null,
      declaredDisplay: pair?.fee === undefined || pair?.fee === null ? null : feeDisplayOf(pair.fee),
      // The two DO disagree in the wild, and reporting the pool's number as the fee paid
      // would be wrong by orders of magnitude on a hooked pool. Verified live: pool
      // 0x8a4e56bb… declares 105,573 at Initialize and charged 106,468 on this trade.
      differs:
        pair?.fee === undefined || pair?.fee === null || !Number.isInteger(row.fee) ? null : pair.fee !== row.fee,
      note: SWAP_NOTES.feeSource,
    },
    priceMove: {
      bps,
      display: bpsDisplay(bps),
      forCurrency: gotUnits?.address ?? null,
      basis: prior.basis,
      priorSwap: prior.at,
      sqrtPriceX96Before: prior.sqrtPriceX96 === null ? null : String(prior.sqrtPriceX96),
      sqrtPriceX96After: String(row.sqrtPriceX96),
      tickAfter: row.tick,
      note: bps === null ? SWAP_NOTES.priceMove : null,
    },
    execution: {
      pricePerUnitPaid: executionPrice,
      poolPriceAfter: poolAfter,
      vsPoolAfterBps: vsPoolBps,
      vsPoolAfterDisplay: bpsDisplay(vsPoolBps),
      note: "What this trade actually received per unit paid, compared with the pool's price once the swap had finished. It contains the fee AND the trade's own impact on the price, so it is neither a fee figure nor a slippage figure on its own.",
    },
    liquidityAfter: String(row.liquidity),
    // The pool's caller, never the trader. The trader is tx.from, on the result above.
    calledPool: row.sender,
    router: { address: row.sender, display: shortHex(row.sender), note: SWAP_NOTES.router },
    ...(row.venue === VENUES.V3 ? { outputRecipient: row.recipient } : {}),
    logIndex: row.logIndex,
    emittedBy: row.emitter,
    emitterIsConfirmedManager: isV4 ? sameAddress(row.emitter, manager.address) : null,
  };
}

/**
 * A v4 pool's key, out of its Initialize log.
 *
 * BOTH TOPICS ARE SENT, through viem's `event` + `args` — which is the path that actually
 * encodes them. lib/swap-log.js documents the trap: viem's getLogs has no `topics`
 * parameter, so a raw `topics: [...]` option is silently dropped and an unfiltered query
 * goes over the wire. `event` + `args` is what lib/dex-v4.js readV4Pools uses and what was
 * measured answering a whole-history query in 291ms.
 */
async function v4PoolKey(client, manager, poolId, options) {
  const pm = lower(manager);
  if (!pm || typeof client?.getLogs !== "function") return null;
  const res = await attempt(() =>
    withIndexerCache(`swappool:${pm}:${poolId}`, async () => {
      const logs = await client.getLogs({
        address: pm,
        event: V4_INITIALIZE_EVENT,
        args: { id: poolId },
        fromBlock: 0n,
        toBlock: "latest",
      });
      const hit = (Array.isArray(logs) ? logs : []).find((log) => String(log?.args?.id ?? "").toLowerCase() === poolId);
      if (!hit) throw new Error("no Initialize log for this pool id");
      const a = hit.args;
      const hooks = lower(a.hooks);
      return {
        currency0: lower(a.currency0),
        currency1: lower(a.currency1),
        fee: Number(a.fee),
        tickSpacing: Number(a.tickSpacing),
        hooks,
        hooked: hooks !== null && hooks !== NATIVE_CURRENCY,
        initializedAtBlock: hit.blockNumber === undefined ? null : Number(hit.blockNumber),
      };
    }),
  );
  return res.ok ? res.value : null;
}

/** A v3 pool's pair and fee: three immutable getters, batched into one round trip. */
async function v3PoolPair(client, pool) {
  const address = lower(pool);
  if (!address || typeof client?.readContract !== "function") return null;
  const res = await attempt(() =>
    withIndexerCache(`swapv3pair:${address}`, async () => {
      const [token0, token1, fee] = await Promise.all([
        client.readContract({ address, abi: V3_POOL_ABI, functionName: "token0" }),
        client.readContract({ address, abi: V3_POOL_ABI, functionName: "token1" }),
        client.readContract({ address, abi: V3_POOL_ABI, functionName: "fee" }),
      ]);
      const c0 = lower(token0);
      const c1 = lower(token1);
      if (!c0 || !c1) throw new Error("pool getters did not answer with addresses");
      return { currency0: c0, currency1: c1, fee: Number(fee), tickSpacing: null, hooks: null, hooked: false };
    }),
  );
  return res.ok ? res.value : null;
}

/**
 * THE POOL'S PRICE BEFORE THIS SWAP — the most recent PRIOR Swap in the same pool.
 *
 * This is exact rather than estimated, and the reason is a property of the AMM: sqrtPriceX96
 * in a Swap log is the price after that swap, and nothing but a swap moves it — adding or
 * removing liquidity does not. So the price entering swap N is the price leaving swap N-1,
 * and finding swap N-1 is one filtered log query.
 *
 * NOT FOUND IS UNKNOWN, NEVER ZERO AND NEVER "NO MOVE". A pool that saw no other trade
 * inside the lookback has no measurable move here, and reporting that as 0 bps would say the
 * trade moved nothing — which is the exact opposite of what a quiet, thin pool does.
 */
async function priorSwapPrice(client, row, { manager, options }) {
  const isV4 = row.venue === VENUES.V4;
  const address = isV4 ? lower(manager.address) : lower(row.pool);
  if (!address || typeof client?.request !== "function") {
    return { sqrtPriceX96: null, basis: "unread", at: null };
  }
  const to = row.blockNumber;
  const from = to > BigInt(PRIOR_SWAP_LOOKBACK_BLOCKS) ? to - BigInt(PRIOR_SWAP_LOOKBACK_BLOCKS) : 0n;
  const topics = isV4 ? [SWAP_TOPICS[VENUES.V4], row.poolId] : [SWAP_TOPICS[VENUES.V3]];

  const res = await attempt(() =>
    client.request({
      method: "eth_getLogs",
      params: [{ address, topics, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }],
    }),
  );
  if (!res.ok) return { sqrtPriceX96: null, basis: "unread", at: null };

  // Decoded and re-filtered client-side: the topics went over the wire through
  // client.request, which is the only way to send them, and correctness still does not
  // depend on the node having applied them.
  const earlier = [];
  for (const log of Array.isArray(res.value) ? res.value : []) {
    const decodedRow = isV4 ? decodeV4SwapLog(log) : decodeV3SwapLog(log, {});
    if (!decodedRow) continue;
    if (isV4 && decodedRow.poolId !== row.poolId) continue;
    if (decodedRow.blockNumber > row.blockNumber) continue;
    if (decodedRow.blockNumber === row.blockNumber && decodedRow.logIndex >= row.logIndex) continue;
    earlier.push(decodedRow);
  }
  earlier.sort(chainOrder);
  const last = earlier[earlier.length - 1] ?? null;
  if (!last) {
    return {
      sqrtPriceX96: null,
      // Read, and there was nothing to find: the pool was quiet through the whole lookback.
      // A different fact from a query that failed, and a different sentence.
      basis: "no_prior_swap_in_lookback",
      at: null,
      lookbackBlocks: PRIOR_SWAP_LOOKBACK_BLOCKS,
    };
  }
  return {
    sqrtPriceX96: last.sqrtPriceX96,
    basis: "prior_swap_in_pool",
    at: { block: last.block, txHash: last.txHash, logIndex: last.logIndex },
  };
}
