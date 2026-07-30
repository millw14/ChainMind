import { decodeAbiParameters } from "viem";
import { priceFromSqrtX96 } from "./dex-price.js";
import { V4_DISCOVERY_BUDGET_MS, readV4Pools } from "./dex-v4.js";
import { priceCacheTtlMs, withIndexerCache } from "./indexer-cache.js";
import { readPageWithRetry } from "./page-retry.js";
import { noteBudgetSkip, outOfTimeFor } from "./request-budget.js";

/**
 * A BUY AND A SELL, MADE OBSERVABLE — the swap logs of both venues, decoded.
 *
 * WHY THIS EXISTS. Nothing in this codebase decoded a swap. lib/dex-price.js and
 * lib/dex-v4.js read pool STATE — what the price is now, how deep the book is — which
 * answers "what is this worth" and cannot answer "who is dumping it", "was that buying
 * or selling", or "has anyone traded this in the last ten minutes". Those are the
 * questions a holder actually asks, and the only record of them on chain is the Swap
 * event. This module reads that record and normalises it, and it does nothing else: it
 * discovers no pools, prices nothing in dollars, and forms no opinion about a wallet.
 *
 * THE ONE THING THAT HAD TO BE MEASURED BEFORE ANY OF IT COULD BE WRITTEN is the sign
 * convention — see AMOUNT_SIGN_CONVENTION. Get it backwards and every buy in this app is
 * labelled a sell, confidently, forever. It is measured two independent ways below, and
 * the two venues turned out to DISAGREE with each other, which is exactly the trap a
 * remembered convention walks into.
 *
 * WHAT IT REFUSES TO DO. A window it could not fully read yields a LOWER BOUND that says
 * so — never a count presented as complete, and never "nobody sold" derived from a read
 * that failed. "No sells in the last ten minutes" is sayable only when every block in the
 * window was actually read, which is why `complete` travels beside every count and why
 * `canSayNone` exists as a field rather than as something a caller infers.
 *
 * Server-side only: no React, no next/*. The chain client, the clock-sensitive pacing and
 * the pool map are all injected, so every path below is exercised offline in
 * test/swap-log.test.mjs against properly ABI-encoded fake logs.
 */

/* ---------------------------- THE SIGN CONVENTION -------------------------- */

/**
 * WHOSE BALANCE THE TWO AMOUNTS IN A SWAP LOG DESCRIBE. Measured live on chain 4663 on
 * 2026-07-30, two independent ways, and THE TWO VENUES DO NOT AGREE — which is the whole
 * reason this is a named constant with its evidence attached rather than a `> 0n` written
 * inline at four call sites.
 *
 *   uniswap_v3 -> "pool"    : a POSITIVE amount is what the POOL RECEIVED.
 *                             So a positive amount means the trader SOLD that token.
 *   uniswap_v4 -> "swapper" : a POSITIVE amount is what the SWAPPER RECEIVED.
 *                             So a positive amount means the trader BOUGHT that token.
 *
 * They are opposites. Carrying v3's convention into v4 — or trusting a recalled "Uniswap
 * emits pool deltas" — inverts every v4 row, and v4 is where this chain trades: of 1,979
 * PoolManager logs in a 3,000-block window, 1,808 were Swap.
 *
 * ── METHOD 1: THE PRICE HAS TO MOVE THE RIGHT WAY. Not a convention — selling token0
 * into a constant-product pool always makes token0 cheaper. sqrtPriceX96 in a Swap log is
 * the price AFTER that swap, so within ONE pool, in chain order, the difference between
 * consecutive logs is the move that the later swap caused. Correlate its sign against the
 * sign of amount0:
 *
 *   v4, PoolManager 0x8366a39c…, 8 busiest pools of a 3,000-block window, 1,140 consecutive
 *   pairs:  amount0 > 0 <-> sqrtPriceX96 moved UP  in 1,140 of 1,140.  Zero exceptions,
 *   zero ties. Price of token0 UP means token0 LEFT the pool, so a positive amount0 is
 *   token0 the pool PAID OUT and the swapper took. => "swapper".
 *
 *   v3, The Green Bull pool 0x8f450B8E…, 100 swaps over 2,000,000 blocks, 99 consecutive
 *   pairs:  amount0 > 0 <-> sqrtPriceX96 moved DOWN in 99 of 99. Price of token0 DOWN
 *   means token0 ENTERED the pool. => "pool". The exact opposite of v4.
 *
 * ── METHOD 2: FOLLOW THE ERC-20 TRANSFERS IN THE SAME TRANSACTION. Independent of any
 * curve argument — the token contract's own record of which way the custody went.
 *
 *   v4 pool 0xecdfad01… (currency0 = native ETH, currency1 = 0x933f5e26…):
 *     tx 0x9654a1ed…  a0=+26470626649044355  a1=-19452901164239130734948189
 *        -> Transfer of 19452901164239130734948189 of 0x933f5e26… INTO the PoolManager.
 *        Negative amount1 = the swapper PAID it. Positive amount0 = the swapper RECEIVED
 *        native ETH. Agrees with "swapper".
 *     tx 0x2ec1fdc3…  a0=-20277908888642560   a1=+19680050236786915236810464
 *        -> Transfer of that amount1 OUT OF the PoolManager. Positive = swapper received.
 *        Agrees with "swapper".
 *
 *   v3 pool 0x8f450B8E… (token0 = WETH 0x0Bd7D308…, token1 = The Green Bull 0x31BE8f74…):
 *     tx 0xcf522a23…  a0=+32802000000000000 -> Transfer of exactly that much WETH INTO the
 *        pool, and the Green Bull leg OUT of it. Positive = pool received. "pool".
 *     tx 0x591f93fc…  a0=-28273749753261872 -> that much WETH OUT OF the pool, Green Bull
 *        INTO it. Negative = pool paid out. "pool".
 *
 * BOTH METHODS AGREE, ON BOTH VENUES, WITH NO DISSENTING ROW. Had they disagreed the
 * correct action was to ship no direction at all; they did not, so direction is shipped.
 */
export const AMOUNT_SIGN_CONVENTION = Object.freeze({
  uniswap_v3: "pool",
  uniswap_v4: "swapper",
});

/** The two venues this module can decode, as the strings every row is stamped with. */
export const VENUES = Object.freeze({ V3: "uniswap_v3", V4: "uniswap_v4" });

/**
 * Event topic0s, computed and then CONFIRMED against live logs from this chain rather
 * than transcribed. The v4 pair was verified by decoding 1,808 real Swap logs out of a
 * PoolManager window; the v3 Swap topic by decoding 100 real ones out of the Green Bull
 * pool. A topic that is merely computed is a hash of a signature somebody typed.
 */
export const SWAP_TOPICS = Object.freeze({
  [VENUES.V4]: "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f",
  [VENUES.V3]: "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
});

/**
 * The unindexed tail of each Swap event, as the DATA ACTUALLY DECODES — verified field by
 * field against live logs, because a layout that is one word out still decodes without
 * error and yields a price nobody can tell is wrong.
 *
 * v4 is SIX words and carries `fee`: v4 fees are free 24-bit parameters and a hook may
 * change the fee per swap, so the fee that was actually charged is a property of the SWAP
 * and is in the log. Observed values include 252, 10000 and 10990 — there is no tier set
 * on this chain and nothing here assumes one.
 *
 * v3 is FIVE words and carries NO fee: a v3 pool's fee is immutable and lives on the pool
 * contract, so it is not in the event. A v3 row therefore reports the fee the CALLER
 * supplied from the pool, or null — never a guessed tier. See feeSource on each row.
 */
const V4_SWAP_DATA = Object.freeze([
  { name: "amount0", type: "int128" },
  { name: "amount1", type: "int128" },
  { name: "sqrtPriceX96", type: "uint160" },
  { name: "liquidity", type: "uint128" },
  { name: "tick", type: "int24" },
  { name: "fee", type: "uint24" },
]);

const V3_SWAP_DATA = Object.freeze([
  { name: "amount0", type: "int256" },
  { name: "amount1", type: "int256" },
  { name: "sqrtPriceX96", type: "uint160" },
  { name: "liquidity", type: "uint128" },
  { name: "tick", type: "int24" },
]);

/** Hex character counts of a complete data field. A short one is a truncated read. */
const V4_DATA_CHARS = 2 + 64 * V4_SWAP_DATA.length;
const V3_DATA_CHARS = 2 + 64 * V3_SWAP_DATA.length;

/* -------------------------------- the window ------------------------------- */

/**
 * BLOCKS PER SECOND ON THIS CHAIN, measured: ~9.4, about 813,000 blocks a day.
 *
 * Exported because "the last ten minutes" is a question people ask and a block count is
 * what the RPC takes, and the conversion has to happen somewhere honest. It is an
 * AVERAGE and it is labelled as one wherever it is used — a window derived from it is
 * approximately the requested duration, never exactly, and blocksForSeconds says so by
 * returning a figure a caller is expected to present as approximate.
 */
export const BLOCKS_PER_SECOND = 9.4;

/**
 * THE DEFAULT WINDOW: about the last ten minutes.
 *
 * WHY RECENT AND NOT DEEP. Measured, a 15,000-block chunk of the PoolManager is 9,163
 * logs and takes 2.7s; a day is ~813,000 blocks, which is 54 of those chunks and several
 * minutes of wall clock against a 24-second request budget. Recent-window analysis is
 * cheap and deep history is not, so the default is the cheap one and a caller that wants
 * more has to ask for it and pay for it.
 *
 * 5,600 blocks is ten minutes at the measured rate and fits in ONE getLogs call, which is
 * the property worth having: a single-call window either succeeds and is COMPLETE, or
 * fails and is honestly unread. No partial arithmetic, nothing to caveat.
 */
export const DEFAULT_WINDOW_BLOCKS = 5_600;

/**
 * THE WIDEST BLOCK SPAN ONE eth_getLogs MAY ASK FOR — 15,000, and the ceiling it sits
 * under is a RESULT-COUNT limit wearing a block-range limit's clothes.
 *
 * BINARY-SEARCHED LIVE, twice, on the PoolManager with no topic filter: 15,000 blocks
 * returned 9,163 logs and 16,000 returned 9,629, both fine; 17,000 through 1,000,000 all
 * failed instantly with "Missing or invalid parameters." The same query WITH a topic
 * filter behaves the same way — topics:[Swap] at 16,000 blocks returned 8,218 logs and at
 * 30,000 failed — so the filter does not buy range. But topics:[Swap, poolId] over
 * 1,000,000 blocks succeeded in 436ms with 249 logs, and topics:[Initialize, *, token]
 * over the whole 23,300,000-block history succeeded in 291ms with 40 logs. A wide range
 * is fine when the answer is small; the refusal tracks the SIZE OF THE RESULT, which
 * lands around 10,000 rows.
 *
 * WHICH IS WHY THE CHUNK ALSO SPLITS ON REFUSAL. No fixed span can be right, because
 * whether it fits depends on how busy the address is and this module does not get to know
 * that in advance. 15,000 is the measured-safe span for the busiest address on the chain;
 * splitBlocks halves anything the node still refuses. A quiet pool therefore costs one
 * call for a wide window and a busy one pays for its own density.
 */
export const MAX_LOG_SPAN = 15_000;

/**
 * How narrow a refused chunk may be split before the sub-range is given up as UNREAD.
 *
 * There has to be a floor. A refusal this module cannot fix by splitting — a malformed
 * request, an RPC that has changed its mind about the parameters — would otherwise
 * halve its way down to single blocks and spend the entire budget proving it. 250 blocks
 * is ~26 seconds of chain: if 250 blocks of one address will not fit in a response, the
 * problem is not the range, and the honest outcome is a labelled hole.
 */
export const MIN_LOG_SPAN = 250;

/**
 * How many times a refused chunk may halve. Six halvings take 15,000 blocks to 234, which is
 * already below MIN_LOG_SPAN — so this is the belt to that floor's braces, and it is what
 * bounds the recursion if either constant is ever reconfigured into disagreeing with the
 * other.
 *
 * The split itself requires TWICE the floor rather than merely more than it, so that no
 * sub-range is ever produced narrower than the floor a caller was promised: halving 251
 * blocks would yield two 125-block reads, which is the floor not holding.
 */
export const MAX_SPLIT_DEPTH = 6;

/**
 * Ceilings on ONE window read, so a caller that asks for a month cannot spend the request.
 *
 * MAX_WINDOW_CHUNKS is the cost bound: 8 chunks at 15,000 blocks is 120,000 blocks, about
 * three and a half hours of chain, and at the measured 2.7s for a dense chunk that is
 * already more than a request has. A window wider than the chunks allow is TRUNCATED and
 * labelled — the blocks that were never asked about are reported as unread, exactly as a
 * failed chunk is, because "we did not look there" is the same fact either way.
 *
 * MAX_WINDOW_LOGS and MAX_SWAP_ROWS are memory bounds. Hitting either makes every count
 * downstream a lower bound, which is why they are reported and not silently applied.
 */
export const MAX_WINDOW_CHUNKS = 8;
export const MAX_WINDOW_LOGS = 20_000;
export const MAX_SWAP_ROWS = 5_000;

/**
 * The least remaining request time that makes ONE chunk read worth STARTING.
 *
 * Measured: a dense 15,000-block PoolManager chunk takes 2.7-3.3s; a filtered or quiet one
 * is 230-550ms. 1,500ms is above the cheap case and below the dense one on purpose — the
 * question is whether an attempt can plausibly LAND, and a read started with 400ms left
 * fails on our own deadline and then reports an RPC outage, which is a claim about an
 * upstream that was never really asked. lib/page-retry.js draws the same line for retries.
 */
export const SWAP_MIN_MS = 1_500;

/**
 * THE HARD CEILING ON ONE WINDOW READ, for the reason lib/dex-v4.js
 * V4_DISCOVERY_BUDGET_MS exists: an honest "unknown" bought at the price of the rest of
 * the answer is not a good trade. Eight seconds fits two dense chunks and their retries,
 * or a dozen cheap ones. Past it the remaining chunks are unread and say so, and whatever
 * else the request was going to do still happens.
 */
export const SWAP_WINDOW_BUDGET_MS = 8_000;

/**
 * Pacing between SEQUENTIAL chunk reads.
 *
 * The chunks are read in sequence and never concurrently, which is not a style choice:
 * lib/dex-v4.js measured two log queries issued together reliably tripping this RPC's
 * rate limiter into 429s, and this repo has a standing measured warning that log queries
 * lose against the ~170-call eth_call sweep when the two overlap. Sequential issue is the
 * fix; the gap is the small remainder of it. 250ms rather than the 700ms dex-v4 uses,
 * because that figure was sized to separate two queries that had ALREADY been issued
 * concurrently, and because a chunk read here costs seconds — a quarter second between
 * them is pacing, not penance. It is not a substitute for the retry backoff, which is
 * lib/page-retry.js's business and is longer on purpose.
 */
export const SWAP_CHUNK_GAP_MS = 250;

/**
 * How many log rows may be joined back to their transactions to recover the real originator,
 * and the budget that join gets. Both numbers come from one measurement.
 *
 * ONE eth_getTransaction ON THIS NODE COSTS ~400ms. Measured six in a row: 401, 399, 402,
 * 399, 402, 416. It does not get cheaper with repetition and there is no batch form of it
 * here. So the join is not a cheap annotation, it is the most expensive thing in this module
 * per unit of information — and a default window on this chain holds ~2,600 DISTINCT
 * transactions, which at that rate is seventeen minutes.
 *
 * EIGHT, which is 3.2 seconds. It names the most recent eight traders out of a window,
 * newest first, which is what "who is selling right now" is actually asking; naming all of
 * them is not on the table at any cap. The first live run of this module used 24 and took
 * 11.5s for one lookup against a 24-second request budget shared with everything else —
 * the same trade lib/dex-v4.js V4_DISCOVERY_BUDGET_MS exists to refuse.
 *
 * ROWS PAST THE CAP KEEP `trader.address === null` AND SAY WHY. None of them is ever quietly
 * handed the router's address instead, which is the entire point of the field.
 */
export const MAX_TRADER_JOINS = 8;
export const SWAP_JOIN_BUDGET_MS = 3_500;

/* --------------------------------- failures -------------------------------- */

/**
 * Every way this module can decline, each with the sentence a caller should show. The
 * codes are not interchangeable, for the reason lib/dex-price.js REASONS gives: "nothing
 * traded here" and "we could not look" are different facts about the world.
 */
export const SWAP_REASONS = Object.freeze({
  no_client:
    "No chain client was supplied to the swap-log reader, so no swap logs were ever requested. That is a fault in the calling code, not an outage and not an absence of trading.",
  bad_address: "That is not a contract address, so it has no swap logs to read.",
  bad_window:
    "The block window given to the swap-log reader was not a usable range, so nothing was read. No claim can be made about trading in it.",
  window_unread:
    "None of the blocks in this window could be read — every log query failed — so whether anything traded in it is UNKNOWN. This is an outage, not a quiet market.",
  window_partial:
    "Part of this block window could not be read, so the swaps below are a LOWER BOUND on what happened in it. There may be more; there cannot be fewer.",
  no_time:
    "The request ran out of time before this window could be read, so it was not asked for. What traded in it is UNKNOWN — not nothing.",
  pool_map_unavailable:
    "The Uniswap v4 pool map could not be established, so these swaps cannot be attributed to a token pair. They are real swaps of UNKNOWN pairs — not swaps of the token asked about, and not an absence of them.",
  pool_map_incomplete:
    "The Uniswap v4 pool map for this token was not established as COMPLETE, so a swap in a pool outside it may still be this token's. Those swaps are UNKNOWN rather than other tokens', and nothing here can say this token did not trade.",
  discovery_failed:
    "This token's Uniswap v4 pools could not be listed, so its swaps could not be told apart from every other pool's inside the singleton. Whether it traded is UNKNOWN — an outage, not a quiet market.",
  no_pools:
    "No pools were supplied or found for this token on this venue, so there were no swap logs to read. Nothing here says the token did not trade elsewhere.",
});

/** Pair a failure code with its sentence. Always stamped with what was being read. */
function fail(reason, extra = {}) {
  return { ok: false, reason, detail: SWAP_REASONS[reason] ?? null, ...extra };
}

/**
 * A DECLINED VENUE HAS THE SAME SHAPE AS A READ ONE, minus the rows.
 *
 * Not tidiness. A caller that reads `rows.length - unattributed` off a venue that declined gets
 * NaN when `unattributed` is absent, and NaN printed beside real figures is a number nobody can
 * challenge. Every field a successful read publishes is present here as its honest empty value,
 * with `complete: false` doing the actual work of saying nothing was established.
 */
function venueFail(venue, reason, extra = {}) {
  return {
    ...fail(reason),
    venue,
    rows: [],
    unattributed: 0,
    decodeFailures: 0,
    rowsCapped: false,
    complete: false,
    ...extra,
  };
}

/* ------------------------------ small helpers ------------------------------ */

/** A 20-byte hex address, lowercased, or null. Everything else is not an address. */
function normalizeAddress(raw) {
  const s = String(raw ?? "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : null;
}

/** A 32-byte hex word, lowercased, or null. Pool ids and topics are both this. */
function normalizeWord(raw) {
  const s = String(raw ?? "").trim();
  return /^0x[0-9a-fA-F]{64}$/.test(s) ? s.toLowerCase() : null;
}

/** Case-insensitive address compare — the chain mixes case, our keys do not. */
function sameAddress(a, b) {
  const x = normalizeAddress(a);
  const y = normalizeAddress(b);
  return x !== null && y !== null && x === y;
}

/** The last 20 bytes of an indexed-address topic, lowercased, or null. */
function addressFromTopic(topic) {
  const w = normalizeWord(topic);
  return w ? normalizeAddress(`0x${w.slice(26)}`) : null;
}

/** A block number as a BigInt, or null. Accepts hex strings, numbers and BigInts alike. */
function toBlockNumber(raw) {
  if (typeof raw === "bigint") return raw >= 0n ? raw : null;
  if (typeof raw === "number") return Number.isInteger(raw) && raw >= 0 ? BigInt(raw) : null;
  const s = String(raw ?? "").trim();
  if (!s) return null;
  try {
    const n = BigInt(s);
    return n >= 0n ? n : null;
  } catch {
    return null;
  }
}

/** A log index as a Number, or null. Ordering within a block depends on it. */
function toLogIndex(raw) {
  const n = toBlockNumber(raw);
  return n === null ? null : Number(n);
}

/** eth_getLogs wants quantities as hex. */
function hexQuantity(n) {
  return `0x${n.toString(16)}`;
}

/** The default sleep. Injectable only so tests need not spend real milliseconds. */
function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Approximately how many blocks cover `seconds` of this chain.
 *
 * Rounded UP, so "the last ten minutes" errs toward reading slightly more of the chain
 * than asked rather than slightly less. Reading a few extra blocks costs nothing and
 * over-reports nothing; missing the tail of the window would understate what happened in
 * it, and an understatement presented as a window is the kind of quiet wrongness this
 * codebase exists to avoid.
 */
export function blocksForSeconds(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return null;
  return Math.ceil(s * BLOCKS_PER_SECOND);
}

/* --------------------------------- decoding -------------------------------- */

/**
 * ONE RAW LOG TO A DECODED SWAP, or null.
 *
 * NULL FOR ANYTHING THAT IS NOT EXACTLY WHAT IT CLAIMS. A log whose topic0 is not the
 * venue's Swap topic, whose topic count is wrong, or whose data is not the exact width of
 * the event's unindexed tail, is not a swap this module will half-decode. The failure mode
 * being avoided is specific: an eight-word data field decodes perfectly well against a
 * six-word layout and hands back a plausible price computed from the wrong bytes.
 *
 * THE TOPIC IS CHECKED HERE, CLIENT-SIDE, AND THAT IS THE POINT. Whether the node applied
 * the topics filter we sent is not something correctness may depend on — see readLogChunk.
 * Every log that arrives is re-checked against the topic we wanted, so a filter that did
 * nothing costs bandwidth and changes no answer.
 *
 * @param {object} log - a raw eth_getLogs row: { topics, data, blockNumber, transactionHash, logIndex }
 * @returns {object|null}
 */
export function decodeV4SwapLog(log) {
  const topics = Array.isArray(log?.topics) ? log.topics : null;
  if (!topics || topics.length !== 3) return null;
  if (normalizeWord(topics[0]) !== SWAP_TOPICS[VENUES.V4]) return null;
  const poolId = normalizeWord(topics[1]);
  const sender = addressFromTopic(topics[2]);
  if (!poolId || !sender) return null;
  const data = String(log.data ?? "");
  if (data.length !== V4_DATA_CHARS || !/^0x[0-9a-fA-F]*$/.test(data)) return null;

  let decoded;
  try {
    decoded = decodeAbiParameters(V4_SWAP_DATA, data);
  } catch {
    return null;
  }
  const [amount0, amount1, sqrtPriceX96, liquidity, tick, fee] = decoded;
  const base = baseFields(log);
  if (!base) return null;
  return {
    venue: VENUES.V4,
    poolId,
    sender,
    amount0,
    amount1,
    sqrtPriceX96,
    liquidity,
    tick: Number(tick),
    // THE FEE THAT WAS ACTUALLY CHARGED, out of the log itself. In v4 a hook may set it
    // per swap, so this is a fact about this trade and not about the pool.
    fee: Number(fee),
    feeSource: "swap_log",
    ...base,
  };
}

/**
 * The v3 equivalent. Two differences that matter and are not cosmetic.
 *
 * The topics are [topic0, sender, RECIPIENT] rather than [topic0, poolId, sender] — v3
 * pools are separate contracts, so the pool is the log's own address and there is no id;
 * and the second indexed field is where the output went, which is a third address that is
 * usually neither the trader nor the router. Measured on The Green Bull pool, tx
 * 0x947782d9…: sender 0x2a7f3d74…, recipient 0xe58b3089…, tx.from 0x49668f6f… — three
 * distinct addresses in one swap. See attachTraders.
 *
 * And the data has NO fee field, so `fee` is whatever the caller knew from the pool, or
 * null. Never a tier guessed from a set: on this chain the observed fees include 252 and
 * 10990, and there is no tier ladder to fall back on.
 */
export function decodeV3SwapLog(log, pool = {}) {
  const topics = Array.isArray(log?.topics) ? log.topics : null;
  if (!topics || topics.length !== 3) return null;
  if (normalizeWord(topics[0]) !== SWAP_TOPICS[VENUES.V3]) return null;
  const sender = addressFromTopic(topics[1]);
  const recipient = addressFromTopic(topics[2]);
  if (!sender || !recipient) return null;
  const data = String(log.data ?? "");
  if (data.length !== V3_DATA_CHARS || !/^0x[0-9a-fA-F]*$/.test(data)) return null;

  let decoded;
  try {
    decoded = decodeAbiParameters(V3_SWAP_DATA, data);
  } catch {
    return null;
  }
  const [amount0, amount1, sqrtPriceX96, liquidity, tick] = decoded;
  const base = baseFields(log);
  if (!base) return null;
  const address = normalizeAddress(log.address) ?? normalizeAddress(pool.pool);
  if (!address) return null;
  const fee = Number.isInteger(pool.fee) && pool.fee >= 0 ? pool.fee : null;
  return {
    venue: VENUES.V3,
    pool: address,
    sender,
    recipient,
    amount0,
    amount1,
    sqrtPriceX96,
    liquidity,
    tick: Number(tick),
    fee,
    // A v3 pool's fee is immutable and lives on the CONTRACT, not in the event, so where
    // the figure came from travels with it. `null` means nobody told us, which is not 0.
    feeSource: fee === null ? "unknown" : "pool_contract",
    ...base,
  };
}

/** Block, tx and log index — the identity of a log. Null when any of them is missing. */
function baseFields(log) {
  const block = toBlockNumber(log?.blockNumber);
  const logIndex = toLogIndex(log?.logIndex);
  const txHash = normalizeWord(log?.transactionHash);
  if (block === null || logIndex === null || !txHash) return null;
  return { blockNumber: block, block: Number(block), logIndex, txHash };
}

/** Chain order: block, then position within the block. Deterministic, so callers agree. */
function inChainOrder(a, b) {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  return a.logIndex - b.logIndex;
}

/* -------------------------------- direction -------------------------------- */

/**
 * DID THE TRADER BUY OR SELL THE SUBJECT TOKEN — the one derivation that AMOUNT_SIGN_CONVENTION
 * exists for, written once so no call site can re-guess it.
 *
 * The rule collapses to: on v4 the amounts are the SWAPPER's delta, so a positive amount
 * of the subject token means the swapper received it and BOUGHT; on v3 they are the POOL's
 * delta, so a positive amount of the subject token means the pool received it and the
 * trader SOLD. Both halves are measured — see the constant.
 *
 * A ZERO AMOUNT IS NOT A DIRECTION. It is returned as null rather than defaulted to one
 * side, because a swap that moved none of the subject token is not a buy and not a sell,
 * and a default here would put a row in a count it does not belong in.
 *
 * @param {string} venue - VENUES.V3 | VENUES.V4
 * @param {bigint} subjectAmount - the raw signed amount of the SUBJECT token from the log
 * @returns {"bought"|"sold"|null}
 */
export function swapDirection(venue, subjectAmount) {
  if (typeof subjectAmount !== "bigint" || subjectAmount === 0n) return null;
  const convention = AMOUNT_SIGN_CONVENTION[venue];
  if (!convention) return null;
  const positive = subjectAmount > 0n;
  return convention === "swapper" ? (positive ? "bought" : "sold") : positive ? "sold" : "bought";
}

/**
 * WHAT THE TRADER PAID AND WHAT THE TRADER RECEIVED, both as positive magnitudes with the
 * currency each belongs to.
 *
 * Stated from the TRADER's side on both venues on purpose, so a caller comparing a v3 row
 * with a v4 row is comparing the same thing. The two amounts in a swap always carry
 * opposite signs — verified across 1,354 v4 swaps — so exactly one of them is the leg paid
 * in and the other the leg taken out, and which is which is the convention question again.
 *
 * @returns {{ inCurrency: 0|1, outCurrency: 0|1, amountIn: bigint, amountOut: bigint }|null}
 */
export function traderLegs(venue, amount0, amount1) {
  if (typeof amount0 !== "bigint" || typeof amount1 !== "bigint") return null;
  const convention = AMOUNT_SIGN_CONVENTION[venue];
  if (!convention) return null;
  // "Did the trader PAY token0?" — negative on v4 (the swapper's own debit), positive on
  // v3 (the pool's credit). One expression, both conventions, stated once.
  const paidToken0 = convention === "swapper" ? amount0 < 0n : amount0 > 0n;
  const abs = (n) => (n < 0n ? -n : n);
  if (amount0 === 0n && amount1 === 0n) return null;
  return paidToken0
    ? { inCurrency: 0, outCurrency: 1, amountIn: abs(amount0), amountOut: abs(amount1) }
    : { inCurrency: 1, outCurrency: 0, amountIn: abs(amount1), amountOut: abs(amount0) };
}

/* ------------------------------- reading logs ------------------------------ */

/**
 * The block ranges one window is read as. Inclusive on both ends, in chain order.
 *
 * TRUNCATION IS REPORTED, NEVER SILENT. When the window needs more chunks than the cap
 * allows, the ranges returned cover only part of it and `truncatedFrom` says where the
 * unasked remainder starts. The MOST RECENT blocks are kept — a window asked about now is
 * a question about now, and the oldest end is the part a caller can most afford to lose —
 * and the dropped blocks travel as unread, because "we did not look there" is the same
 * fact whether a query failed or was never made.
 *
 * @returns {{ chunks: Array<{ fromBlock: bigint, toBlock: bigint }>, truncatedFrom: bigint|null }}
 */
export function blockChunks(fromBlock, toBlock, span = MAX_LOG_SPAN) {
  const from = toBlockNumber(fromBlock);
  const to = toBlockNumber(toBlock);
  if (from === null || to === null || to < from) return { chunks: [], truncatedFrom: null };
  const width = Number.isInteger(span) && span > 0 ? BigInt(Math.min(span, MAX_LOG_SPAN)) : BigInt(MAX_LOG_SPAN);

  const chunks = [];
  // Built backwards from the head so the cap drops the OLDEST blocks, then reversed into
  // chain order for the caller.
  let end = to;
  while (end >= from && chunks.length < MAX_WINDOW_CHUNKS) {
    const start = end - width + 1n > from ? end - width + 1n : from;
    chunks.push({ fromBlock: start, toBlock: end });
    if (start === from) {
      end = from - 1n;
      break;
    }
    end = start - 1n;
  }
  chunks.reverse();
  const covered = chunks.length ? chunks[0].fromBlock : null;
  const truncatedFrom = covered !== null && covered > from ? from : null;
  return { chunks, truncatedFrom };
}

/**
 * Does this failure mean "that range was too big for one response"?
 *
 * MEASURED MESSAGE, and it is unhelpfully generic: this node refuses an over-large query
 * with "Missing or invalid parameters." and JSON-RPC code -32602 — the same thing a
 * genuinely malformed request gets. It is treated as a size refusal because the params are
 * built here and are therefore well-formed by construction, and because being wrong about
 * it is cheap in exactly one direction: splitting a request that was malformed just fails
 * again at half the width and ends as a labelled hole, whereas failing to split a size
 * refusal loses blocks that were readable.
 */
function isSizeRefusal(error) {
  const message = String(error?.details ?? error?.shortMessage ?? error?.message ?? "");
  if (/missing or invalid parameter/i.test(message)) return true;
  if (/(too many results|response size|query returned more than|limit exceeded|range is too large)/i.test(message)) {
    return true;
  }
  return Number(error?.code) === -32602;
}

/**
 * ONE eth_getLogs, BY ADDRESS AND BLOCK RANGE, with the topic sent as a HINT.
 *
 * THE TOPICS FILTER IS AN OPTIMISATION AND NEVER A CORRECTNESS DEPENDENCY, and both
 * halves of that sentence were measured on this chain today.
 *
 * It works: a raw eth_getLogs against the PoolManager over 3,000 blocks returns 1,593 logs
 * with no topics, 0 with a nonsense topic, and 9 with the Initialize topic. It also earns
 * its keep — topics:[Initialize, *, token] answers over the whole 23,300,000-block history
 * in 291ms, a query that fails outright without the filter.
 *
 * A PREVIOUS ROUND OF WORK MEASURED THE OPPOSITE and concluded this RPC ignores topics
 * entirely. The reproduction is exact and the cause is client-side: viem's `getLogs`
 * accepts `event`/`events`/`args` and builds the topics from them — it has no `topics`
 * parameter at all, so a raw `topics: [...]` option is silently dropped and an EMPTY
 * filter goes over the wire. Verified side by side: `client.getLogs({ topics: [nonsense] })`
 * returns 1,593 logs where the same topics passed through `client.request` return 0. So
 * the filter was never sent, not ignored. lib/dex-v4.js readV4Pools is unaffected and is
 * NOT over-fetching: it passes `event` + `args`, which viem does encode into topics, and
 * its 40-log full-history answer is the node's own filtered result.
 *
 * BECAUSE THAT IS THE KIND OF THING THAT CAN BE TRUE AGAIN, the topic is re-checked on
 * every row by the decoders. If a future node, proxy or client library drops the filter,
 * this module reads more bytes and returns the same answer.
 *
 * The read goes through `client.request` for the reason above — it is the only way to
 * actually send a topic — and falls back to `client.getLogs` with no filter at all when a
 * client has no `request`. The fallback is heavier and equally correct.
 */
async function readLogChunk(client, { address, topic0, fromBlock, toBlock }) {
  const params = {
    address,
    fromBlock: hexQuantity(fromBlock),
    toBlock: hexQuantity(toBlock),
  };
  if (topic0) params.topics = [topic0];
  if (typeof client.request === "function") {
    const logs = await client.request({ method: "eth_getLogs", params: [params] });
    return Array.isArray(logs) ? logs : [];
  }
  // No `request`: ask by address and range only and let the decoders filter. Deliberately
  // WITHOUT viem's `event`/`args`, because those make viem decode and drop rows by its own
  // rules, and the shape this module wants back is the raw log.
  const logs = await client.getLogs({ address, fromBlock, toBlock });
  return Array.isArray(logs) ? logs : [];
}

/**
 * EVERY LOG OF ONE ADDRESS OVER ONE BLOCK WINDOW — chunked under the measured ceiling,
 * retried through the shared policy, split when the node refuses the range, and honest
 * about every block it did not manage to read.
 *
 * THE RESULT IS A WINDOW, NOT A LIST. `complete` is the field everything downstream turns
 * on: a count taken from an incomplete window is a lower bound and nothing else, and the
 * one sentence this module refuses to enable is "nothing traded" derived from blocks that
 * were never read. `blocksUnread` and `chunks` are there so a caller can say WHERE the
 * hole is rather than merely that there is one.
 *
 * FAILURE HANDLING, IN THE ORDER IT HAPPENS. lib/page-retry.js first, because the measured
 * failure on this indexer is a ~10% transient blip and the very next attempt gets the same
 * page. Then, if the failure looks like a size refusal, the range is HALVED and each half
 * is read the same way, down to MIN_LOG_SPAN. Then the sub-range is unread and labelled.
 * Nothing here ever returns an empty list for a range it could not read.
 *
 * @param {object} client - viem-shaped; needs `request` (preferred) or `getLogs`
 * @param {{ address: string, topic0?: string|null, fromBlock: bigint|number,
 *   toBlock: bigint|number, span?: number, sleep?: Function, attempts?: number,
 *   budgetMs?: number, now?: () => number, label?: string }} options
 */
export async function readLogWindow(client, options = {}) {
  const address = normalizeAddress(options.address);
  if (!client || (typeof client.request !== "function" && typeof client.getLogs !== "function")) {
    return { ...fail("no_client"), logs: [], chunks: [], complete: false };
  }
  if (!address) return { ...fail("bad_address"), logs: [], chunks: [], complete: false };

  const from = toBlockNumber(options.fromBlock);
  const to = toBlockNumber(options.toBlock);
  if (from === null || to === null || to < from) {
    return { ...fail("bad_window"), logs: [], chunks: [], complete: false };
  }

  const topic0 = normalizeWord(options.topic0);
  const sleep = typeof options.sleep === "function" ? options.sleep : wait;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const label = typeof options.label === "string" && options.label.trim() ? options.label.trim() : `logs ${address}`;
  const budgetMs = Number.isFinite(options.budgetMs) && options.budgetMs > 0 ? options.budgetMs : SWAP_WINDOW_BUDGET_MS;
  const startedAt = now();
  const spent = () => now() - startedAt;

  const { chunks: ranges, truncatedFrom } = blockChunks(from, to, options.span);
  const chunks = [];
  const logs = [];
  let capped = false;

  /** One range, retried, then halved if the node refused its size. */
  const readRange = async (lo, hi, depth) => {
    const width = hi - lo + 1n;
    // The budget is checked BEFORE the attempt, so a read that cannot land is not started
    // and then reported as an outage. Same line lib/page-retry.js draws for its retries.
    if (spent() >= budgetMs || outOfTimeFor(SWAP_MIN_MS)) {
      noteBudgetSkip(label);
      chunks.push({ fromBlock: lo, toBlock: hi, blocks: width, status: "unread", reason: "no_time", logCount: 0 });
      return;
    }

    /**
     * A SIZE REFUSAL IS DETERMINISTIC, SO IT IS NOT RE-ASKED AND NOT WAITED OUT.
     *
     * The retry policy stays lib/page-retry.js's — it is the one place that decides how hard
     * to re-ask this node, and three copies of that would drift. What is local is the
     * knowledge that ONE of the two failure modes here cannot be fixed by asking again: a
     * blip is transient and a range the node refuses for its size will be refused
     * identically forever. So the read short-circuits its own later attempts and the backoff
     * between them collapses to nothing, which turns a refused chunk into an immediate split
     * instead of 550ms of penance per level of recursion.
     */
    let lastError = null;
    let refusedForSize = false;
    const pacedSleep = (ms) => (refusedForSize ? Promise.resolve() : sleep(ms));

    const res = await readPageWithRetry(
      async (attempt) => {
        if (attempt > 1 && refusedForSize) throw lastError;
        try {
          // Cached, so two questions about the same recent window in the same warm instance
          // cost one read. The key is an EXPLICIT range — no "latest" — so an entry can never
          // stand for a different set of blocks than the one it was fetched for. A failure is
          // never stored; see lib/indexer-cache.js.
          return await cachedRead(`${address}:${topic0 ?? "all"}:${lo}-${hi}`, async () => ({
            logs: await readLogChunk(client, { address, topic0, fromBlock: lo, toBlock: hi }),
          }));
        } catch (error) {
          lastError = error;
          if (isSizeRefusal(error)) refusedForSize = true;
          throw error;
        }
      },
      {
        minMs: SWAP_MIN_MS,
        label,
        sleep: pacedSleep,
        attempts: options.attempts,
      },
    );

    if (res.ok) {
      const got = Array.isArray(res.value?.logs) ? res.value.logs : [];
      let kept = 0;
      for (const log of got) {
        if (logs.length >= MAX_WINDOW_LOGS) {
          capped = true;
          break;
        }
        logs.push(log);
        kept += 1;
      }
      chunks.push({
        fromBlock: lo,
        toBlock: hi,
        blocks: width,
        // A chunk whose logs were cut by the memory cap did not fully land, and calling it
        // "read" would let a truncated list be counted as a complete one.
        status: kept === got.length ? "read" : "capped",
        reason: kept === got.length ? null : "row_cap",
        logCount: kept,
      });
      return;
    }

    const splittable = refusedForSize && width >= BigInt(MIN_LOG_SPAN) * 2n && depth < MAX_SPLIT_DEPTH;
    if (!splittable) {
      chunks.push({
        fromBlock: lo,
        toBlock: hi,
        blocks: width,
        status: "unread",
        // stoppedForTime is a different fact from "it failed again", and the reader gets a
        // different sentence for each. So is a refusal this module ran out of room to split.
        reason: res.stoppedForTime ? "no_time" : refusedForSize ? "range_refused" : "query_failed",
        httpStatus: res.status ?? null,
        logCount: 0,
      });
      return;
    }
    const mid = lo + width / 2n - 1n;
    await readRange(lo, mid, depth + 1);
    if (spent() < budgetMs) await sleep(SWAP_CHUNK_GAP_MS);
    await readRange(mid + 1n, hi, depth + 1);
  };

  for (let i = 0; i < ranges.length; i += 1) {
    // SEQUENTIAL, with a gap. See SWAP_CHUNK_GAP_MS: concurrent log queries against this
    // node were measured turning one transient failure into a rate limit.
    if (i > 0) await sleep(SWAP_CHUNK_GAP_MS);
    await readRange(ranges[i].fromBlock, ranges[i].toBlock, 0);
  }

  chunks.sort((a, b) => (a.fromBlock === b.fromBlock ? 0 : a.fromBlock < b.fromBlock ? -1 : 1));

  // THE BLOCKS THE CHUNK CAP NEVER ASKED ABOUT are unread in exactly the sense a failed
  // query's are — nobody looked — so they get a chunk record of their own rather than
  // quietly shrinking the window the caller thinks it asked for.
  if (truncatedFrom !== null) {
    const firstAsked = ranges[0].fromBlock;
    chunks.unshift({
      fromBlock: truncatedFrom,
      toBlock: firstAsked - 1n,
      blocks: firstAsked - truncatedFrom,
      status: "unread",
      reason: "window_truncated",
      httpStatus: null,
      logCount: 0,
    });
  }

  let blocksRead = 0n;
  let blocksUnread = 0n;
  for (const c of chunks) {
    if (c.status === "unread") blocksUnread += c.blocks;
    else blocksRead += c.blocks;
  }

  const complete = blocksUnread === 0n && !capped;
  const anyRead = chunks.some((c) => c.status !== "unread");
  return {
    ok: anyRead,
    reason: anyRead ? (complete ? null : "window_partial") : "window_unread",
    detail: anyRead ? (complete ? null : SWAP_REASONS.window_partial) : SWAP_REASONS.window_unread,
    logs,
    chunks,
    window: { fromBlock: from, toBlock: to, blocks: to - from + 1n },
    blocksRead,
    blocksUnread,
    chunksRead: chunks.filter((c) => c.status === "read").length,
    chunksUnread: chunks.filter((c) => c.status === "unread").length,
    capped,
    /**
     * THE FIELD EVERYTHING ELSE HANGS ON. True only when every block in the window was
     * actually read and no cap trimmed a row — which is the only circumstance in which a
     * caller may say a swap did NOT happen.
     */
    complete,
  };
}

/** Chunk reads go through the shared cache on the price TTL, namespaced so keys cannot collide. */
function cachedRead(key, fetcher) {
  return withIndexerCache(`swaplog:${key}`, fetcher, { ttlMs: priceCacheTtlMs() });
}

/* ------------------------------- attribution ------------------------------- */

/**
 * The pool metadata a v4 poolId needs to become a token pair, keyed by poolId.
 *
 * BUILT FROM lib/dex-v4.js readV4Pools AND NOT REBUILT HERE, which is the instruction and
 * also the right call: the Initialize map is that module's product, it already knows the
 * three routes that were rejected for building it, and a second discovery path would be a
 * second thing to keep correct about a fact the first one establishes.
 *
 * @param {Array<object>} pools - readV4Pools rows
 * @returns {Map<string, object>}
 */
export function poolMapFromDiscovery(pools) {
  const map = new Map();
  for (const pool of Array.isArray(pools) ? pools : []) {
    const poolId = normalizeWord(pool?.poolId);
    if (!poolId) continue;
    map.set(poolId, pool);
  }
  return map;
}

/**
 * WHAT A ROW SAYS ABOUT ITS PAIR WHEN NOBODY CAN NAME IT.
 *
 * A swap in a pool this module cannot identify is still a swap that happened, and it is
 * kept — with `pairKnown: false` and a reason — because the two alternatives are both
 * wrong. Dropping it under-reports the window while the window still claims to be
 * complete. Attributing it to the token being asked about invents a trade. So it stays,
 * unattributed, and it is counted separately from the rows that are attributed.
 */
/**
 * The one unattributable reason that is SAFE for an absence claim.
 *
 * "This poolId is not in the map" means something different depending on how the map was
 * built. When it came from a COMPLETE discovery — readV4Pools answering from the chain's own
 * log index — a poolId outside it is definitively another token's pool, so excluding it takes
 * nothing away from the subject and "nobody sold the subject" is still sayable. When the map
 * is missing or partial, the same row might BE the subject's and nobody can tell, so no
 * absence may be claimed at all. Two identical-looking rows, two different licences, which is
 * why the distinction is a code rather than a comment. See summariseSwaps.
 */
const PAIR_UNKNOWN_SAFE_FOR_ABSENCE = "not_this_token_pool";

function unattributedPair(reason) {
  return {
    pairKnown: false,
    pairUnknownReason: reason,
    currency0: null,
    currency1: null,
    tickSpacing: null,
    hooks: null,
    hooked: null,
  };
}

/** The pair fields of a known pool, plus the hook flag, which is never dropped. */
function knownPair(pool) {
  return {
    pairKnown: true,
    pairUnknownReason: null,
    currency0: pool.currency0 ?? null,
    currency1: pool.currency1 ?? null,
    tickSpacing: Number.isInteger(pool.tickSpacing) ? pool.tickSpacing : null,
    hooks: pool.hooks ?? null,
    hooked: typeof pool.hooked === "boolean" ? pool.hooked : null,
  };
}

/**
 * The price this swap left the pool at, in human units, from sqrtPriceX96.
 *
 * NULL WHEN THE DECIMALS ARE NOT KNOWN, never a raw ratio. sqrtPriceX96^2 / 2^192 is
 * token1-per-token0 in ATOMIC units, and on this chain a pair can span 18 decimals against
 * 6 — so an unadjusted figure is not the price by a factor of 10^12, and it looks exactly
 * like a price. The tick and sqrtPriceX96 are on every row regardless: they are exact,
 * decimal-free, and enough to compare two swaps in the same pool.
 */
function pricedAt(sqrtPriceX96, decimals0, decimals1, subjectIsToken0) {
  const d0 = Number(decimals0);
  const d1 = Number(decimals1);
  if (!Number.isInteger(d0) || !Number.isInteger(d1)) {
    return { subjectPerCounterparty: null, counterpartyPerSubject: null, basis: "sqrtPriceX96", reason: "decimals_unknown" };
  }
  // priceFromSqrtX96's last argument is "is the token I want priced token0", and it returns
  // the price OF that token IN the other one.
  const counterpartyPerSubject = priceFromSqrtX96(sqrtPriceX96, d0, d1, subjectIsToken0);
  const subjectPerCounterparty = priceFromSqrtX96(sqrtPriceX96, d0, d1, !subjectIsToken0);
  return {
    subjectPerCounterparty,
    counterpartyPerSubject,
    basis: "sqrtPriceX96",
    reason: counterpartyPerSubject === null ? "price_out_of_range" : null,
  };
}

/**
 * ONE DECODED SWAP, TURNED INTO A ROW ABOUT THE SUBJECT TOKEN.
 *
 * The subject is what makes "bought" and "sold" mean anything: a swap is a buy of one side
 * and a sell of the other, so a direction with no named subject is not a fact. When the
 * subject is not a side of the pair — or the pair is unknown — the row carries `subject:
 * null` and keeps everything that IS known about the swap.
 */
function subjectView(decoded, pair, subject, decimals) {
  if (!pair.pairKnown || !subject) return null;
  const isToken0 = sameAddress(pair.currency0, subject);
  const isToken1 = sameAddress(pair.currency1, subject);
  if (!isToken0 && !isToken1) return null;

  const amount = isToken0 ? decoded.amount0 : decoded.amount1;
  const legs = traderLegs(decoded.venue, decoded.amount0, decoded.amount1);
  const direction = swapDirection(decoded.venue, amount);
  const d0 = decimals?.[String(pair.currency0).toLowerCase()];
  const d1 = decimals?.[String(pair.currency1).toLowerCase()];
  return {
    token: subject,
    isToken0,
    direction,
    // The subject's own leg and the counterparty's, as positive magnitudes from the
    // TRADER's side. `amountIn` is what the trader paid, whichever token that is.
    amountIn: legs?.amountIn ?? null,
    amountOut: legs?.amountOut ?? null,
    inCurrency: legs ? (legs.inCurrency === 0 ? pair.currency0 : pair.currency1) : null,
    outCurrency: legs ? (legs.outCurrency === 0 ? pair.currency0 : pair.currency1) : null,
    subjectAmount: amount,
    price: pricedAt(decoded.sqrtPriceX96, d0, d1, isToken0),
  };
}

/**
 * THE `sender` IN A SWAP LOG IS A ROUTER, NOT THE TRADER. Said on every row, as a field.
 *
 * MEASURED, and it is not a subtlety. In v4 tx 0x9654a1ed… the Swap log's sender topic is
 * 0x88767899… and the transaction's `to` is that same contract, while `tx.from` — the human
 * — is 0x43f814df…. In tx 0x2ec1fdc3… the sender topic is again 0x88767899… but the
 * transaction went to 0xc4119413…, so the sender is not even the contract the user called.
 * Across a whole busy pool the sender topic was ONE address for all 185 swaps by dozens of
 * different originators. On v3 it is worse: tx 0x947782d9… has sender 0x2a7f3d74…,
 * recipient 0xe58b3089… and tx.from 0x49668f6f… — three distinct addresses, none of them
 * derivable from another.
 *
 * So a row that reported `sender` as the trader would tell a user that one router address
 * is dumping their token, which is both false and unfalsifiable from the row alone.
 * `sender` is always labelled as the caller of the pool, and the trader is a SEPARATE
 * field that is either recovered from tx.from or explicitly absent.
 */
function senderView(decoded) {
  return {
    address: decoded.sender,
    // Not "possibly a router": the sender is BY CONSTRUCTION whatever contract called the
    // pool. On a routed swap that is the router; on a direct one it is the trader's own
    // contract. It is never known from the log alone to be the originator.
    role: "pool_caller",
    isTrader: false,
    note: "This is the contract that called the pool — a router or aggregator in almost every case, not the wallet that traded.",
  };
}

/**
 * THE ACTUAL ORIGINATOR, from a log-to-transaction join. One eth_getTransaction per
 * DISTINCT tx hash, bounded and budget-gated.
 *
 * WHY IT IS WORTH DOING AT ALL. "Who is dumping this" is a question about a wallet, and the
 * log cannot answer it — see senderView. `tx.from` can, cheaply, because swap logs cluster
 * into far fewer transactions than rows.
 *
 * WHY IT IS CAPPED AND WHY AN UNJOINED ROW SAYS SO. A window with 1,800 swaps would be
 * 1,800 round trips, which is not a join, it is an outage waiting to happen — and the
 * measured warning in this repo is that log queries and a large eth_call sweep against this
 * node do not coexist. So a bounded number of hashes are joined and every row states which
 * address it is reporting: `trader.source` is "tx.from" when the join landed and
 * "not_joined" or "unread" when it did not. NO ROW EVER FALLS BACK TO THE SENDER. A
 * confident wrong wallet is the failure this whole field exists to prevent.
 *
 * @param {object} client - needs `getTransaction`
 * @param {Array<object>} rows - rows to annotate, mutated in place
 */
export async function attachTraders(client, rows, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const limit = Number.isInteger(options.maxJoins) && options.maxJoins >= 0 ? options.maxJoins : MAX_TRADER_JOINS;
  const canJoin = client && typeof client.getTransaction === "function";
  const now = typeof options.now === "function" ? options.now : Date.now;
  const budgetMs =
    Number.isFinite(options.joinBudgetMs) && options.joinBudgetMs > 0 ? options.joinBudgetMs : SWAP_JOIN_BUDGET_MS;
  const startedAt = now();

  // Newest first: if only some hashes can be joined, the ones worth naming are the recent
  // ones, which is what a "who is selling right now" question is about.
  const hashes = [];
  const seen = new Set();
  for (const row of [...list].sort((a, b) => inChainOrder(b, a))) {
    if (!seen.has(row.txHash)) {
      seen.add(row.txHash);
      hashes.push(row.txHash);
    }
  }

  const byHash = new Map();
  // Which hashes were actually ASKED ABOUT, so a row can distinguish "the lookup failed" from
  // "the lookup never happened". Both leave the wallet unknown and they are not the same fact.
  const attempted = new Set();
  let joined = 0;
  let skippedForTime = false;
  for (const hash of hashes) {
    if (!canJoin || joined >= limit) break;
    // Two clocks, both measured against ~400ms per join: the join's OWN ceiling, so a busy
    // window cannot spend the request on annotations, and the request's, so it cannot spend
    // the answer either.
    if (now() - startedAt >= budgetMs || outOfTimeFor(SWAP_MIN_MS)) {
      skippedForTime = true;
      noteBudgetSkip("swap originator lookup (tx.from)");
      break;
    }
    joined += 1;
    attempted.add(hash);
    try {
      const tx = await cachedRead(`tx:${hash}`, async () => {
        const t = await client.getTransaction({ hash });
        return { from: normalizeAddress(t?.from), to: normalizeAddress(t?.to) };
      });
      if (tx?.from) byHash.set(hash, tx);
    } catch {
      // A failed join is an unread originator, never a wrong one.
    }
  }

  for (const row of list) {
    const tx = byHash.get(row.txHash);
    if (tx?.from) {
      row.trader = {
        address: tx.from,
        source: "tx.from",
        note: "The transaction's originator — the wallet that signed this trade.",
      };
      row.txTo = tx.to ?? null;
      continue;
    }
    row.trader = {
      address: null,
      source: !canJoin ? "no_client" : attempted.has(row.txHash) ? "unread" : skippedForTime ? "no_time" : "not_joined",
      note: "The wallet behind this swap was NOT established. It is not the sender address above, which is the router.",
    };
  }
  return { joined, distinctTransactions: hashes.length, resolved: byHash.size, cappedAt: limit, skippedForTime };
}

/* ------------------------------ venue readers ----------------------------- */

/**
 * EVERY v4 SWAP IN A WINDOW, out of the singleton, keyed back to pools by poolId.
 *
 * The PoolManager is one address holding every pool on the chain, so this is one window
 * read for all of them at once — which is why v4 is the cheap venue to watch and v3 is
 * per-pool. Rows whose poolId is not in `poolsById` are KEPT and marked unattributed; see
 * unattributedPair for why that is the only defensible option.
 *
 * `poolMapComplete` DEFAULTS TO FALSE, AND THAT DEFAULT IS THE POINT. Whether a poolId
 * outside the map is definitively another token's pool or possibly this one's depends on
 * whether the map is the WHOLE set, which only the caller knows — and a live run of this
 * module proved why the conservative default matters: readV4Pools came back `unread`, the
 * caller handed over the resulting EMPTY map anyway, and 4,315 swaps were labelled "not this
 * token's pool" on the strength of a discovery that never happened. Everything downstream
 * then held a licence to say the token had not traded. A caller who has a complete map has to
 * say so; a caller who forgets gets UNKNOWN, which is the answer that cannot be wrong.
 *
 * @param {object} client
 * @param {{ manager: string, fromBlock: bigint|number, toBlock: bigint|number,
 *   poolsById?: Map<string, object>, poolMapComplete?: boolean, subject?: string|null,
 *   decimals?: object }} options
 */
export async function readV4Swaps(client, options = {}) {
  const manager = normalizeAddress(options.manager);
  if (!manager) return venueFail(VENUES.V4, "bad_address");

  const window = await readLogWindow(client, {
    address: manager,
    topic0: SWAP_TOPICS[VENUES.V4],
    fromBlock: options.fromBlock,
    toBlock: options.toBlock,
    span: options.span,
    sleep: options.sleep,
    attempts: options.attempts,
    budgetMs: options.budgetMs,
    now: options.now,
    label: options.label ?? "uniswap v4 swap logs",
  });
  if (!window.ok && !window.logs.length) {
    return {
      ok: false,
      venue: VENUES.V4,
      reason: window.reason ?? "window_unread",
      detail: window.detail ?? SWAP_REASONS.window_unread,
      rows: [],
      window,
      complete: false,
      unattributed: 0,
      decodeFailures: 0,
    };
  }

  const poolsById = options.poolsById instanceof Map ? options.poolsById : null;
  const mapReason = !poolsById
    ? "pool_map_unavailable"
    : options.poolMapComplete === true
      ? PAIR_UNKNOWN_SAFE_FOR_ABSENCE
      : "pool_map_incomplete";
  const subject = normalizeAddress(options.subject);
  const rows = [];
  let unattributed = 0;
  let decodeFailures = 0;
  let rowsCapped = false;

  for (const log of window.logs) {
    const decoded = decodeV4SwapLog(log);
    // NOT A DECODE WE MAY SHRUG OFF. A log that carried this topic and would not decode is
    // a swap we cannot describe, so it is counted — a window with decode failures in it is
    // not a complete window.
    if (!decoded) {
      if (normalizeWord(log?.topics?.[0]) === SWAP_TOPICS[VENUES.V4]) decodeFailures += 1;
      continue;
    }
    if (rows.length >= MAX_SWAP_ROWS) {
      rowsCapped = true;
      break;
    }
    const pool = poolsById?.get(decoded.poolId) ?? null;
    const pair = pool ? knownPair(pool) : unattributedPair(mapReason);
    const subjectRow = subjectView(decoded, pair, subject, options.decimals);
    if (!subjectRow) unattributed += 1;
    rows.push({
      venue: VENUES.V4,
      pool: { kind: "pool_id", poolId: decoded.poolId, address: manager, fee: pool?.fee ?? null, ...pair },
      blockNumber: decoded.blockNumber,
      block: decoded.block,
      txHash: decoded.txHash,
      logIndex: decoded.logIndex,
      amount0: decoded.amount0,
      amount1: decoded.amount1,
      sqrtPriceX96: decoded.sqrtPriceX96,
      liquidity: decoded.liquidity,
      tick: decoded.tick,
      // The fee this SWAP was charged, out of the log. `pool.fee` above is the pool's own
      // Initialize fee, kept beside it rather than instead of it — and the two DO disagree in
      // the wild, verified live: pool 0x818914e6… declares fee 8388608 at Initialize (0x800000,
      // the dynamic-fee flag rather than a rate) and its hook charged 16000 on every swap in a
      // 5,600-block window. Reporting the pool's number as the fee paid would have been wrong
      // by three orders of magnitude on a hooked pool.
      fee: decoded.fee,
      feeSource: decoded.feeSource,
      sender: senderView(decoded),
      trader: { address: null, source: "not_joined", note: "Not joined to a transaction; see attachTraders." },
      subject: subjectRow,
    });
  }
  rows.sort(inChainOrder);

  const complete = window.complete && decodeFailures === 0 && !rowsCapped;
  return {
    ok: true,
    venue: VENUES.V4,
    reason: complete ? null : "window_partial",
    detail: complete ? null : SWAP_REASONS.window_partial,
    rows,
    window,
    unattributed,
    decodeFailures,
    rowsCapped,
    /** See readLogWindow: the only licence to say a swap did not happen. */
    complete,
    poolMap: poolsById ? { known: poolsById.size, source: "dex-v4 Initialize discovery" } : null,
  };
}

/**
 * EVERY v3 SWAP IN A WINDOW, per pool contract.
 *
 * ONE WINDOW READ PER POOL, because a v3 pool is its own address and there is no singleton
 * to sweep. That is the venue's shape and not a shortcoming — the reads are cheap for the
 * same reason: measured, the whole Green Bull pool over 2,000,000 blocks is 123 logs in
 * 546ms, where 15,000 blocks of the v4 singleton is 9,163 in 2.7s.
 *
 * A POOL THAT COULD NOT BE READ DOES NOT MAKE THE OTHERS WRONG, but it does make the
 * TOTAL a lower bound, so each pool carries its own window and the combined `complete` is
 * the AND of all of them.
 *
 * @param {{ pools: Array<{ pool: string, token0?: string, token1?: string, fee?: number }> }} options
 */
export async function readV3Swaps(client, options = {}) {
  const pools = (Array.isArray(options.pools) ? options.pools : [])
    .map((p) => ({ ...p, pool: normalizeAddress(p?.pool) }))
    .filter((p) => p.pool);
  if (!pools.length) return venueFail(VENUES.V3, "no_pools", { windows: [] });

  const subject = normalizeAddress(options.subject);
  const rows = [];
  const windows = [];
  let unattributed = 0;
  let decodeFailures = 0;
  let rowsCapped = false;
  let anyRead = false;

  for (let i = 0; i < pools.length; i += 1) {
    const pool = pools[i];
    // Sequential across pools for the same reason chunks are sequential within one window.
    if (i > 0) await (typeof options.sleep === "function" ? options.sleep : wait)(SWAP_CHUNK_GAP_MS);
    const window = await readLogWindow(client, {
      address: pool.pool,
      topic0: SWAP_TOPICS[VENUES.V3],
      fromBlock: options.fromBlock,
      toBlock: options.toBlock,
      span: options.span,
      sleep: options.sleep,
      attempts: options.attempts,
      budgetMs: options.budgetMs,
      now: options.now,
      label: options.label ?? `uniswap v3 swap logs ${pool.pool}`,
    });
    windows.push({ pool: pool.pool, ...window });
    if (window.ok) anyRead = true;

    // token0/token1 come from the CALLER, which is where they are already known: the v3
    // reader resolves them for pricing. They are not re-read here, both to avoid a second
    // source of truth and because the measured warning in this repo is that log queries and
    // an eth_call sweep against this node must not overlap.
    const pair = pool.token0 && pool.token1
      ? { pairKnown: true, pairUnknownReason: null, currency0: normalizeAddress(pool.token0), currency1: normalizeAddress(pool.token1), tickSpacing: null, hooks: null, hooked: false }
      : unattributedPair("pool_pair_not_supplied");

    for (const log of window.logs) {
      const decoded = decodeV3SwapLog(log, pool);
      if (!decoded) {
        if (normalizeWord(log?.topics?.[0]) === SWAP_TOPICS[VENUES.V3]) decodeFailures += 1;
        continue;
      }
      if (rows.length >= MAX_SWAP_ROWS) {
        rowsCapped = true;
        break;
      }
      const subjectRow = subjectView(decoded, pair, subject, options.decimals);
      if (!subjectRow) unattributed += 1;
      rows.push({
        venue: VENUES.V3,
        pool: { kind: "address", address: decoded.pool, poolId: null, fee: decoded.fee, ...pair },
        blockNumber: decoded.blockNumber,
        block: decoded.block,
        txHash: decoded.txHash,
        logIndex: decoded.logIndex,
        amount0: decoded.amount0,
        amount1: decoded.amount1,
        sqrtPriceX96: decoded.sqrtPriceX96,
        liquidity: decoded.liquidity,
        tick: decoded.tick,
        fee: decoded.fee,
        feeSource: decoded.feeSource,
        sender: senderView(decoded),
        // The RECIPIENT is carried because it is in the log and it is a third address that
        // is usually neither the trader nor the router — see senderView's measurements. It
        // is never presented as the trader either.
        recipient: { address: decoded.recipient, role: "output_recipient", isTrader: false },
        trader: { address: null, source: "not_joined", note: "Not joined to a transaction; see attachTraders." },
        subject: subjectRow,
      });
    }
  }
  rows.sort(inChainOrder);

  const complete = windows.every((w) => w.complete) && decodeFailures === 0 && !rowsCapped;
  return {
    ok: anyRead,
    venue: VENUES.V3,
    reason: anyRead ? (complete ? null : "window_partial") : "window_unread",
    detail: anyRead ? (complete ? null : SWAP_REASONS.window_partial) : SWAP_REASONS.window_unread,
    rows,
    windows,
    unattributed,
    decodeFailures,
    rowsCapped,
    complete,
  };
}

/* --------------------------------- summary -------------------------------- */

/**
 * BUYS AND SELLS OF THE SUBJECT TOKEN, counted — with the bound attached.
 *
 * EVERY COUNT HERE IS A FLOOR WHEN `complete` IS FALSE, and that is stated in the shape
 * rather than left to a caller's discipline: `atLeast` is true exactly when the numbers are
 * bounds, and `canSayNone` is the separate, narrower permission to state an ABSENCE. A zero
 * from an incomplete window is the single most dangerous figure this module can produce —
 * "nobody sold" read off blocks nobody read — so `canSayNone` is false for it and the
 * notice says why.
 *
 * ROWS WITH NO DIRECTION ARE NOT SILENTLY DISCARDED. A swap in an unattributable pool, or
 * one that moved none of the subject token, is counted in `undirected` so the parts add up
 * to the whole.
 */
export function summariseSwaps(rows, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const complete = options.complete === true;
  const buyers = new Set();
  const sellers = new Set();
  let bought = 0;
  let sold = 0;
  let undirected = 0;
  let undirectedUnknownPair = 0;
  let tradersUnknown = 0;

  for (const row of list) {
    const direction = row?.subject?.direction ?? null;
    if (direction === "bought") bought += 1;
    else if (direction === "sold") sold += 1;
    else {
      undirected += 1;
      // A row nobody could NAME might be the subject's own trade. It does not make the counts
      // wrong, but it does remove the licence to call the subject's zero an absence.
      if (row?.pool?.pairKnown === false && row.pool.pairUnknownReason !== PAIR_UNKNOWN_SAFE_FOR_ABSENCE) {
        undirectedUnknownPair += 1;
      }
      continue;
    }
    const trader = row?.trader?.address ?? null;
    if (!trader) {
      tradersUnknown += 1;
      continue;
    }
    (direction === "bought" ? buyers : sellers).add(trader);
  }

  return {
    swaps: list.length,
    bought,
    sold,
    undirected,
    // The subset of `undirected` that could turn out to BE the subject's, because nobody
    // could name its pair. Reported, not folded away: it is the difference between a zero
    // that is a measurement and a zero that is a shrug.
    undirectedUnknownPair,
    // Wallet counts are over the rows whose ORIGINATOR was established. They are a floor
    // even in a complete window, because an unjoined row's wallet is unknown rather than
    // absent — which is why the number of those travels beside them.
    distinctBuyers: buyers.size,
    distinctSellers: sellers.size,
    tradersUnknown,
    /**
     * THE WALLET COUNTS ARE A FLOOR WHENEVER ANY ORIGINATOR WENT UNJOINED, independently of
     * whether the window was complete — and it is a field rather than something a caller
     * derives from `tradersUnknown > 0`, because the two numbers sit side by side and "3
     * distinct sellers" out of 48 sells is the sentence this flag exists to stop.
     */
    walletsAreLowerBound: tradersUnknown > 0 || !complete,
    complete,
    atLeast: !complete,
    /**
     * MAY A CALLER SAY "NOBODY SOLD"? Only with a fully-read window AND no row whose pair
     * could not be named. This is the field the brief's one forbidden sentence turns on, and
     * it is deliberately NARROWER than `complete`: a window can be read end to end and still
     * contain swaps that might have been the subject's, which is not an absence of them.
     */
    canSayNone: complete && undirectedUnknownPair === 0,
  };
}

/**
 * The sentence that travels with a summary, or null when there is nothing to caveat.
 *
 * A finished sentence rather than a flag, the same convention as lib/request-budget.js
 * budgetNotice: the model must not have to derive "this is a floor" from a boolean, and a
 * bound the reader cannot see is a lie by omission.
 */
export function swapNotice(summary, window = null) {
  if (!summary || summary.canSayNone) return null;

  // A window read end to end whose rows could not all be NAMED is a different caveat from a
  // window with holes in it, and the reader needs the right one.
  if (summary.complete) {
    return `Every block in this window was read, but ${summary.undirectedUnknownPair} of the ${summary.swaps} swaps in it are in pools whose token pair could NOT be identified — any of them could be this token's. So at least ${summary.sold} sells and at least ${summary.bought} buys is a LOWER BOUND, and you must not say nothing traded.`;
  }

  const parts = [];
  if (window?.blocksUnread) {
    parts.push(
      `${window.blocksUnread} of the ${window.window?.blocks ?? "?"} blocks in this window could not be read`,
    );
  }
  parts.push(
    `so these figures are a LOWER BOUND: at least ${summary.sold} sells and at least ${summary.bought} buys, possibly more`,
  );
  return `${parts.join(", ")}. Do NOT say nothing traded, and do not present these counts as complete — the unread blocks are UNKNOWN, not empty.`;
}

/* ------------------------------- the entry point -------------------------- */

/**
 * WHO BOUGHT AND WHO SOLD ONE TOKEN, over a recent window, on both venues.
 *
 * WHAT IT DOES NOT DO: discover. The v4 PoolManager address and the v3 pool list are
 * INJECTED, because both are already resolved upstream (lib/dex-price.js
 * resolveV4PoolManager and resolvePool) and because the measured contention warning in this
 * repo is explicit — the ~170-call eth_call sweep and log queries against this node must
 * not run at the same time or the log queries lose. A reader that quietly kicked off its
 * own sweep would recreate exactly that. The v4 pool MAP is the one exception, and it is
 * not rebuilt either: readV4Pools is called, which is the map lib/dex-v4.js already owns.
 *
 * THE VENUES ARE NEVER BLENDED. Each side comes back under its own key with its own
 * completeness, exactly as lib/dex-price.js keeps v3 and v4 figures apart, so nothing above
 * can add a lower bound from one venue to an exact count from the other and present the sum
 * as a fact.
 *
 * DISCOVERY GOES FIRST, AND THE ORDER IS LOAD-BEARING. Measured while verifying this module:
 * readV4Pools is healthy on its own — `found` in 1.0-2.4s for three different tokens — but run
 * immediately after an eight-chunk window read it came back `unread` twice in a row, which is
 * this repo's standing contention warning reproduced with a new pair of readers. So the cheap,
 * fragile log query that NAMES the pools happens before the expensive one that fills them, and
 * a caller that already holds a discovery result should hand it in rather than let this
 * function re-run it behind its own window reads.
 *
 * @param {string} tokenAddress
 * @param {{ client: object, manager?: string|null, discovery?: object, v3Pools?: Array<object>,
 *   toBlock?: bigint|number, windowBlocks?: number, decimals?: object, joinTraders?: boolean,
 *   sleep?: Function, now?: () => number, budgetMs?: number }} options
 */
export async function tokenSwapFlow(tokenAddress, options = {}) {
  const token = normalizeAddress(tokenAddress);
  if (!token) return fail("bad_address");
  const client = options.client;
  if (!client || (typeof client.request !== "function" && typeof client.getLogs !== "function")) {
    return fail("no_client");
  }

  const head = toBlockNumber(options.toBlock) ?? (await readHeadBlock(client));
  if (head === null) return fail("bad_window");
  const width = Number.isInteger(options.windowBlocks) && options.windowBlocks > 0 ? options.windowBlocks : DEFAULT_WINDOW_BLOCKS;
  const fromBlock = head - BigInt(width) + 1n > 0n ? head - BigInt(width) + 1n : 0n;
  const shared = {
    fromBlock,
    toBlock: head,
    subject: token,
    decimals: options.decimals,
    sleep: options.sleep,
    now: options.now,
    budgetMs: options.budgetMs,
    span: options.span,
    attempts: options.attempts,
  };

  /* ----------------------------------- v4 ---------------------------------- */
  const manager = normalizeAddress(options.manager);
  let v4;
  if (!manager) {
    // An unresolved manager is an OUTAGE and not an absence: the singleton that holds every
    // v4 pool was simply never asked. Same line lib/dex-v4.js v4MarketData draws.
    v4 = venueFail(VENUES.V4, "pool_map_unavailable");
  } else {
    const discovery = options.discovery ?? (await boundedDiscovery(client, manager, token, options));
    if (discovery.status === "unread") {
      // WITHOUT THE MAP THE LOGS ARE UNREADABLE AS EVIDENCE, so they are not read at all.
      // Every swap in the singleton would be indistinguishable between "this token's pool"
      // and "some other token's pool", and a window we cannot attribute is not cheaper to
      // fetch than one we do not fetch.
      v4 = venueFail(VENUES.V4, "discovery_failed", { discovery: { status: "unread", poolCount: null } });
    } else {
      const poolsById = poolMapFromDiscovery(discovery.pools);
      v4 = await readV4Swaps(client, {
        ...shared,
        manager,
        poolsById,
        label: "uniswap v4 swap logs",
        // Asserted only on this branch, where discovery came back `found` or `none` — it
        // answered from the chain's own log index, so a poolId outside the map is another
        // token's pool rather than a hole. The `unread` case above never reaches here.
        poolMapComplete: true,
      });
      v4.discovery = { status: discovery.status, poolCount: discovery.pools?.length ?? 0 };
    }
  }

  /* ----------------------------------- v3 ---------------------------------- */
  const v3Pools = Array.isArray(options.v3Pools) ? options.v3Pools : [];
  const v3 = v3Pools.length
    ? await readV3Swaps(client, { ...shared, pools: v3Pools, label: "uniswap v3 swap logs" })
    : venueFail(VENUES.V3, "no_pools", { windows: [] });

  /* ------------------------------ originators ----------------------------- */
  // AFTER the log reads and never beside them: the measured contention warning applies to
  // this join too — it is eth_getTransaction traffic against the same node.
  //
  // ONLY THE ROWS THAT ARE ACTUALLY THIS TOKEN'S ARE JOINED, and that is a correctness-shaped
  // cost fix. A default window on this chain holds ~2,600 distinct transactions across every
  // pool in the singleton, and at the measured ~400ms per join the first live run of this
  // function spent 9.7 of its 11.5 seconds naming the originators of OTHER TOKENS' trades —
  // wallets no caller of tokenSwapFlow can use for anything. The unattributed rows keep their
  // stated `trader: null`, which is what they should say either way.
  const rows = [...(v4.rows ?? []), ...(v3.rows ?? [])].filter((row) => row.subject).sort(inChainOrder);
  const join =
    options.joinTraders === false
      ? { joined: 0, distinctTransactions: 0, resolved: 0, cappedAt: 0, skippedForTime: false }
      : await attachTraders(client, rows, options);

  /**
   * WHAT A PER-TOKEN SUMMARY IS ALLOWED TO COUNT.
   *
   * Not every row in the window. A default v4 window holds ~3,700 swaps across every pool in
   * the singleton, and a summary reading `swaps: 3788, bought: 56` invites exactly the wrong
   * reading — that 3,732 trades of this token went uncategorised. Rows in pools discovery
   * proved are OTHER tokens' are therefore excluded from the count entirely.
   *
   * UNNAMEABLE ROWS ARE NOT EXCLUDED, and that asymmetry is the honest half. A row nobody
   * could identify might BE this token's, so it stays in — where it lands in
   * `undirectedUnknownPair` and withdraws the licence to claim an absence. Excluding it would
   * quietly restore that licence.
   */
  const countable = (row) => row.subject || row.pool?.pairUnknownReason !== PAIR_UNKNOWN_SAFE_FOR_ABSENCE;
  const v4Summary = summariseSwaps((v4.rows ?? []).filter(countable), { complete: v4.complete === true });
  const v3Summary = summariseSwaps((v3.rows ?? []).filter(countable), { complete: v3.complete === true });
  return {
    ok: Boolean(v4.ok || v3.ok),
    token,
    window: { fromBlock, toBlock: head, blocks: head - fromBlock + 1n, approxSeconds: Math.round(width / BLOCKS_PER_SECOND) },
    signConvention: AMOUNT_SIGN_CONVENTION,
    venues: {
      [VENUES.V4]: { ...v4, summary: v4Summary, notice: swapNotice(v4Summary, v4.window) },
      [VENUES.V3]: { ...v3, summary: v3Summary, notice: swapNotice(v3Summary, v3.windows?.[0] ?? null) },
    },
    originators: {
      ...join,
      note: "Wallets come from tx.from. A row whose join did not land reports no wallet — never the router in the sender field.",
    },
  };
}

/**
 * readV4Pools UNDER THE SAME CEILING lib/dex-price.js v4Discover puts it under, and the number
 * is IMPORTED rather than re-chosen so the two callers cannot drift apart.
 *
 * MEASURED, ON THIS MODULE'S OWN FIRST LIVE RUNS. readV4Pools is healthy in isolation — three
 * tokens, `found` in 1.0s, 1.5s and 2.4s. Run behind a window read it lost, and losing is not
 * cheap: it spends four attempts and 4.7 seconds of backoff (see lib/dex-v4.js
 * V4_LOG_BACKOFF_MS), which measured out at 15.9 SECONDS for one doomed discovery against a
 * 24-second request budget. Honest — it reported UNREAD — and it had eaten the whole answer to
 * do it, which is the exact trade V4_DISCOVERY_BUDGET_MS was created to refuse.
 *
 * lib/dex-price.js applies the ceiling itself, so readV4Pools carries none of its own and a
 * NEW caller gets no protection unless it asks. This is that ask. The race does not cancel the
 * underlying read: it keeps running and warms the shared cache for the next lookup, the same
 * bargain v4Discover strikes.
 *
 * FIVE SECONDS IS TIGHT FOR A TOKEN WITH MANY POOLS, AND THAT IS WHY discoveryBudgetMs EXISTS.
 * Measured on 0x894e1ec2… (188 v4 pools): the default ceiling lost the race on a cold run
 * whose first log query blipped, reporting `discovery_failed` honestly for a token that trades
 * heavily; raised to 12s the same call came back `found` and the whole flow finished in 7.3s
 * with 370 attributed swaps. The DEFAULT stays the shared 5s, because that number was sized
 * against a v4 read that runs in front of the v3 sweep and inventing a second one here is the
 * drift this comment exists to prevent. A caller that is NOT competing with the sweep — which
 * tokenSwapFlow, doing discovery first and alone, is not — can raise it knowingly.
 */
async function boundedDiscovery(client, manager, token, options) {
  const ceiling =
    Number.isFinite(options.discoveryBudgetMs) && options.discoveryBudgetMs > 0
      ? options.discoveryBudgetMs
      : V4_DISCOVERY_BUDGET_MS;
  return Promise.race([
    readV4Pools(client, manager, token, options),
    new Promise((resolve) => {
      // Unref'd so a bounded read that lost the race cannot hold a process open on its own.
      setTimeout(() => resolve({ status: "unread", pools: [], poolsDropped: 0, reason: "discovery_failed" }), ceiling).unref?.();
    }),
  ]);
}

/** The head block, when the client can say. Never invented; null means the window is unknown. */
async function readHeadBlock(client) {
  if (!client || typeof client.getBlockNumber !== "function") return null;
  try {
    return toBlockNumber(await client.getBlockNumber());
  } catch {
    return null;
  }
}
