import { keccak256 } from "viem";
import { finiteOrNull } from "./format-number.js";
import { priceCacheTtlMs, withIndexerCache } from "./indexer-cache.js";
import { readPageWithRetry } from "./page-retry.js";
import { RANK_BAND_BPS, WIDE_BAND_BPS, measureBandDepth } from "./tick-depth.js";

/**
 * Price a token from its UNISWAP V4 pools, because the v3 reader structurally cannot
 * see them and the app was therefore reporting real markets as no market at all.
 *
 * WHY THIS EXISTS, MEASURED ON CHAIN 4663. lib/dex-price.js reads Uniswap v3 only: a
 * factory that maps a token pair to a per-pool CONTRACT, and a pool contract answering
 * token0()/token1()/slot0(). Uniswap v4 has none of that shape — every pool on the chain
 * lives inside one singleton, the PoolManager at 0x8366a39c…, which custodies every token
 * and has no pair to name. So a token whose market is v4 came back from the v3 sweep as
 * `no_pool`, and a live session told a user that PIPECAT 0x31ba…c6cc had "no Uniswap v3
 * pool against a verified quote asset … either", which reads as "this has no market".
 * PIPECAT has EIGHT v4 pools, half its supply sits in one of them, and the busiest of
 * them took 114 of the 116 swaps its pools saw in the last 300,000 blocks. Technically
 * true, materially wrong, and the same class of confidently-wrong answer this codebase
 * has spent many rounds eliminating.
 *
 * WHAT IT IS NOT. It is not a replacement for the v3 reader and it is not a second
 * opinion to be averaged with one. v3 is untouched, it is still preferred wherever it
 * produces a price, and every figure that leaves here is stamped `source: "uniswap_v4"`
 * so the layer above can never merge the two into one unlabelled number. A token with
 * markets on both venues gets both stated, separately.
 *
 * THE THREE THINGS THAT WERE VERIFIED LIVE BEFORE THIS FILE WAS WRITTEN, because every
 * one of them is a place where a plausible guess is wrong:
 *
 *   1. DISCOVERY. `eth_getLogs` against the singleton, filtered on the Initialize topic
 *      and on the token in the currency0 or currency1 topic slot, returns a token's pools
 *      over the WHOLE chain history in ~360ms per side. See V4_POOLS_SLOT's neighbours
 *      below and readV4Pools for the routes that were rejected and why.
 *   2. LIVE STATE. `extsload` at keccak256(poolId . 6) is the pool's Slot0 and +3 is its
 *      liquidity. Slot 6 was established by probing 0..10 and is confirmed twice over:
 *      the sqrtPriceX96 and tick in that word agree with each other, and the lpFee field
 *      agrees with the fee in the pool's own Initialize event.
 *   3. THE TICK LADDER. The bitmap and tick-info mappings are readable the same way, so
 *      v4 depth is the SAME integral over the SAME band as v3's, not a weaker cousin —
 *      see measureV4Depth. Confirmed on PIPECAT's busiest pool, where the initialised
 *      tick found at 204200 carries a liquidityGross exactly equal to the pool's active
 *      liquidity, which is what a single position spanning the current price looks like.
 *
 * Server-side only, but nothing here is server-specific: no React, no Next, no
 * module-scope I/O. The chain client and the quote assets are both injected, so every
 * path below is exercised offline in test/dex-v4.test.mjs.
 */

/* -------------------------------- addresses ------------------------------- */

/**
 * NATIVE ETH, WHICH IS A REAL CURRENCY IN V4 AND HAS NO CONTRACT.
 *
 * v3 can only pair ERC-20s, so it trades WRAPPED ether and lib/dex-price.js has to
 * establish WHICH of the several contracts calling itself "Wrapped Ether" on this chain
 * is the real one — by its role as token0 of funded pools, because the symbol proves
 * nothing here. v4 removed the problem: a PoolKey may name the zero address and mean the
 * chain's own gas token. Measured, PIPECAT's four deepest pools are quoted in it.
 *
 * IT IS THE ONE QUOTE ASSET ON THIS CHAIN THAT NEEDS NO VERIFICATION, and that is a
 * fact about the protocol rather than a convenience: there is no contract to impersonate,
 * no symbol to squat, and no peg to check. Its dollar value is the ETH/USD rate the rest
 * of the app already converts through. Every OTHER v4 quote asset is an ERC-20 and is
 * held to exactly the same bar as a v3 one — it has to arrive in `quotes` having passed
 * lib/dex-price.js's own verification. This module verifies nothing itself, on purpose.
 */
export const NATIVE_CURRENCY = "0x0000000000000000000000000000000000000000";

/* --------------------------------- storage -------------------------------- */

/**
 * THE STORAGE SLOT OF THE POOLMANAGER'S `_pools` MAPPING — read off the chain, not off
 * a version of v4-core, and cross-checked twice.
 *
 * WHY IT IS A CONSTANT AT ALL. v4 exposes no getters for pool state: the singleton's
 * whole read surface is `extsload(bytes32)`, which returns a raw storage word. To ask it
 * anything you have to know where the answer lives. That number is set by the layout of
 * the deployed contract, so it is a FACT ABOUT THIS DEPLOYMENT and had to be measured.
 *
 * HOW IT WAS ESTABLISHED. Every candidate 0..10 was probed against a pool whose
 * Initialize event we already held. Ten of them returned a zero word. Slot 6 returned a
 * word whose low 160 bits are a sqrtPriceX96 that agrees with the tick in the next 24
 * bits (tick -412671 implies sqrt 8.6e19; the word says 86757752755802237320), and whose
 * top field is an lpFee of 990001 — exactly the fee in that pool's own Initialize event.
 * Two independent agreements on a word that eleven-to-one could have been noise.
 *
 * IT IS OVERRIDABLE for the same reason lib/dex-price.js's factory address is: a chain
 * can carry a second deployment with a different layout, and a hard-coded number that has
 * gone stale is worse than a configurable one. A junk override falls back rather than
 * breaking every read — and a WRONG override cannot invent a market, because an
 * uninitialised-looking word (sqrtPriceX96 of zero) is reported as an uninitialised pool
 * and never as a price.
 */
const DEFAULT_POOLS_SLOT = 6n;

/**
 * Offsets inside one pool's state struct, from v4-core's own layout: Slot0 first, then
 * the two fee-growth accumulators, then liquidity, then the `ticks` and `tickBitmap`
 * mappings. They are relative to the pool's base slot, so they are independent of
 * DEFAULT_POOLS_SLOT and did not need probing separately — but the two that this module
 * actually reads were both confirmed against live pools anyway (liquidity against the
 * initialised tick's liquidityGross, the mappings against a pool with a known position).
 */
const SLOT0_OFFSET = 0n;
const LIQUIDITY_OFFSET = 3n;
const TICKS_OFFSET = 4n;
const TICK_BITMAP_OFFSET = 5n;

/* --------------------------------- limits --------------------------------- */

/**
 * How many v4 pools of one token may be MEASURED — the bound on the tick-ladder reads,
 * which are the only part of a v4 lookup whose cost grows with the pool count.
 *
 * WHY A BOUND AT ALL. Anyone can initialise a v4 pool for any token for one gas-only
 * transaction, and the fee and tick spacing are free 24-bit fields of the PoolKey rather
 * than a fixed ladder of four tiers — so the number of pools a token CAN have is unbounded
 * in a way v3's never was. Measured on chain 4663: PIPECAT has 8, MERRYMEN 19, The Green
 * Bull 48, Vladhoods none. 64 clears the largest real count with room.
 *
 * WHERE IT IS APPLIED, AND THIS IS THE PART THAT WAS WRONG FIRST TIME. The cap used to be
 * applied during DISCOVERY, in log order — every pool where the token is currency0, then
 * every pool where it is currency1. Verified live, that was actively harmful: The Green Bull
 * has 40 pools as currency0 against counterparties nothing can value and 8 as currency1
 * against NATIVE ETH, so a cap of 24 filled itself with the 40 unpriceable ones and dropped
 * every pool that could actually have produced a price. A spammer needed no capital to do
 * that on purpose. The cap now applies where the QUOTE ASSETS ARE KNOWN, and pools that can
 * be priced are kept first, so it can only ever drop pools that were never going to price
 * the token — and a token with 65 priceable pools loses the tail rather than the head.
 *
 * WHAT IT COSTS WHEN IT BITES is reported and never silently absorbed: `poolsDropped` says
 * how many were not measured, because the deepest pool could in principle be among them.
 */
export const MAX_V4_POOLS = 64;

/**
 * A hard ceiling on how many Initialize logs are kept at all, so a token somebody has
 * spammed ten thousand pools for cannot turn one lookup into an unbounded array. Far above
 * MAX_V4_POOLS because these are free — the log query returns them whatever we do — and the
 * only thing this protects is memory.
 */
const MAX_V4_POOLS_RETAINED = 600;

/**
 * The least remaining request time that makes a v4 read worth STARTING.
 *
 * Measured cold against chain 4663: two `eth_getLogs` at ~360ms each, one batched
 * `extsload` per pool for Slot0 and liquidity, then the ladder — under two seconds for a
 * token with eight pools. Below this there is no outcome the read can reach, and starting
 * it anyway produces a timeout that has to be reported as "the chain could not be read" —
 * a claim about an RPC that was never really asked. See lib/page-retry.js, which draws the
 * same line one layer down.
 */
export const V4_MIN_MS = 2_000;

/**
 * How long to wait before re-asking for a LOG QUERY — longer than the shared page policy,
 * and the difference was measured rather than guessed.
 *
 * lib/page-retry.js backs off 150ms then 400ms, which is right for its own upstream: those
 * failures are transient blips and it verified that pacing does not reduce them. A log query
 * against this RPC behaves differently, and the first live run of this module proved it. The
 * two sides of the pair were issued CONCURRENTLY; the second came back "log query timed
 * out", and then all four retries at the shared backoff came back 429 Too Many Requests —
 * so the retry that exists to recover a blip instead converted one into a rate limit and
 * PIPECAT reported `discovery_failed`. Honest, and still the wrong answer.
 *
 * Paced, the same query is reliable: 16 of 16 full-history queries succeeded at ~360ms each
 * with 700ms between them, against 2 failures in 24 unpaced ones. So the two sides are now
 * issued in SEQUENCE rather than together — 720ms serial is nothing against the budget, and
 * concurrency here was buying 360ms in exchange for the answer — and a retry waits long
 * enough to be a retry rather than a second offence.
 *
 * FOUR ATTEMPTS RATHER THAN THE SHARED THREE, AND THE BURST IS NOT HYPOTHETICAL. This read
 * runs alongside the v3 sweep, which is ~170 JSON-RPC calls on the same endpoint in the same
 * couple of seconds, so the window a v4 log query has to survive is one this app opens
 * itself. Measured, that window is a few seconds wide: a burst that failed three queries in
 * a row was clear by the next round. The backoff is sized to outlast it rather than to
 * expire inside it — and every one of those waits is still gated on the request's remaining
 * time by lib/page-retry.js, so a genuinely-down RPC cannot spend a budget it has no chance
 * of using. A read that gives up half a second before it would have succeeded reports an
 * outage, and an outage reported for a market that exists is the defect this file closes.
 */
const V4_LOG_BACKOFF_MS = Object.freeze([700, 1_500, 2_500]);

/** Attempts per log query. See V4_LOG_BACKOFF_MS for why it is one more than the shared policy. */
const V4_LOG_ATTEMPTS = 4;

/**
 * THE HARD CEILING ON DISCOVERY — because discovery is the one part of this module that runs
 * IN FRONT of the v3 sweep, and a read that runs long there does not merely fail, it takes the
 * v3 answer down with it.
 *
 * MEASURED, AND THIS IS WHY THE NUMBER EXISTS. When the log queries succeed they cost ~370-670ms
 * each. When the currency1 side is doomed — the node returns "log query timed out" after about
 * 2.3s, and for a token whose counterparty is a high-cardinality asset like native ETH that is
 * the common case under load — four attempts plus their backoff is about 14 seconds. Verified
 * live on The Green Bull, that made one lookup take 28.0s against an ASK_BUDGET_MS of 24s: the
 * v4 side reported UNREAD, honestly, having spent the budget the v3 answer needed. An honest
 * "unknown" bought at the price of the answer is not a good trade.
 *
 * FIVE SECONDS. It fits two full attempts plus the first backoff, so a single transient blip —
 * the failure the retry exists for — is still recovered. What it gives up is the third and
 * fourth attempts against an endpoint that is refusing, which is exactly the case where more
 * attempts were never going to help. Past this, the v4 side is UNREAD and says so, and the v3
 * sweep gets the rest of the budget intact.
 *
 * IT IS A CEILING, NOT A REPLACEMENT FOR THE BUDGET GATE. lib/page-retry.js still refuses to
 * start a retry the request has no time for; this bounds the case where the request has plenty
 * of time and one upstream is determined to spend all of it.
 */
export const V4_DISCOVERY_BUDGET_MS = 5_000;

/* ---------------------------------- ABIs ---------------------------------- */

/**
 * The Initialize event, as the singleton actually emits it — confirmed against decoded
 * logs from the chain rather than transcribed from a version of v4-core.
 *
 * THREE INDEXED PARAMETERS IS THE WHOLE REASON DISCOVERY IS CHEAP. `id`, `currency0` and
 * `currency1` are all topics, so "every pool this token is a side of" is a topic filter
 * the node answers from its index — no paging, no scanning, no block-range chunking. The
 * unindexed tail carries the rest of the PoolKey (fee, tickSpacing, hooks), which is what
 * turns a poolId back into a pair anyone can check.
 */
export const V4_INITIALIZE_EVENT = Object.freeze({
  type: "event",
  name: "Initialize",
  inputs: Object.freeze([
    { name: "id", type: "bytes32", indexed: true },
    { name: "currency0", type: "address", indexed: true },
    { name: "currency1", type: "address", indexed: true },
    { name: "fee", type: "uint24", indexed: false },
    { name: "tickSpacing", type: "int24", indexed: false },
    { name: "hooks", type: "address", indexed: false },
    { name: "sqrtPriceX96", type: "uint160", indexed: false },
    { name: "tick", type: "int24", indexed: false },
  ]),
});

/**
 * `extsload(bytes32[])`, the BATCH overload, and the reason a v4 depth read is cheaper
 * than a v3 one rather than dearer.
 *
 * v3 costs one eth_call per getter per pool CONTRACT. v4 reads raw words out of one
 * contract, and this overload takes as many slots as you like in a single call — verified
 * live, a two-slot request comes back as a two-element array. So a token's entire pool
 * state (Slot0 and liquidity for every pool it has) is ONE eth_call, and the ladder adds
 * two more. The single-slot overload is deliberately not declared here: two entries
 * called `extsload` make the call ambiguous to encode, and the batch form does everything
 * the single one does.
 */
export const V4_STATE_ABI = Object.freeze([
  {
    name: "extsload",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "slots", type: "bytes32[]" }],
    outputs: [{ type: "bytes32[]" }],
  },
]);

const ERC20_DECIMALS_ABI = Object.freeze([
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
]);

/* -------------------------------- failures -------------------------------- */

/**
 * Every way this module can decline to name a v4 price, each with the sentence a caller
 * should show — and the codes are not interchangeable, for the reason lib/dex-price.js
 * REASONS gives: "nothing trades this on v4 here" and "we could not ask" are different
 * facts about the world, and collapsing the second into the first tells the user
 * something false about the chain.
 */
export const V4_REASONS = Object.freeze({
  no_pool:
    "No Uniswap v4 pool exists for this token on Robinhood Chain — the PoolManager has never emitted an Initialize event naming it as either side of a pair. That is a stated absence, read from the chain's own log index, and it is not a price of zero.",
  manager_unknown:
    "The Uniswap v4 PoolManager could not be identified this call, so the singleton that holds every v4 pool was never asked about this token. Whether it has a v4 market is UNKNOWN — an outage, not a token without a market.",
  discovery_failed:
    "The Uniswap v4 pool lookup did not complete — the log query failed on every attempt — so whether this token has a v4 pool is unknown. This is an outage, not a token without a market.",
  no_client:
    "No chain client was supplied to the Uniswap v4 reader, so the chain was never asked whether this token has a v4 pool. That is a fault in the calling code, not an outage and not a token without a market.",
  state_read_failed:
    "This token has Uniswap v4 pools, but the PoolManager's state could not be read for them, so no price could be derived. The price exists; we could not fetch it.",
  no_quote:
    "This token's Uniswap v4 pools are all paired against currencies that could not be established as a value reference — neither native ETH nor a verified dollar stablecoin — so a pool price exists but cannot be stated in dollars. Unpriceable against an unknown asset is not unpriced.",
  quote_unverified:
    "A quote asset this token's Uniswap v4 pools are paired against could not be re-verified this call, so those pools were not priced. Whether this token has a v4 market in dollars is UNKNOWN. This is an outage, not a token without a market.",
  pool_not_initialised:
    "This token's Uniswap v4 pools exist but none of them holds a price yet — every one reports a sqrtPriceX96 of zero, which is a pool nobody has ever put a price into. That is an empty pool, not a price of zero.",
  depth_unreadable:
    "This token's Uniswap v4 pools were found and more than one of them could carry the price, but at least one pool's tick ladder could not be READ — so which of them has the greatest realisable depth was never established. The price is stated from the deepest pool, so no price is stated. An unread pool could be arbitrarily deep; this is an outage inside a comparison, not a token without a market.",
  depth_inconclusive:
    "This token has more than one Uniswap v4 pool and which is the deepest was NOT established: a pool that ranked below the leader reported a LOWER BOUND — its tick walk was capped by the read budget — so its real depth may exceed the leader's. Every pool was read; what is missing is exactness, not data. A figure that understates cannot be shown to have lost, so no pool was chosen. This is an unresolved comparison, not a token without a market.",
  no_eth_price:
    "This token's Uniswap v4 pool gave a price in its quote asset, but the ETH/USD rate could not be read, so it could not be converted to dollars. No fallback rate is used, because a guessed ETH price would misprice every token on the chain.",
  price_out_of_range:
    "The Uniswap v4 pool's price is outside the range a double can represent, so no dollar figure can be stated for it honestly.",
  bad_address: "That is not a contract address, so it has no Uniswap v4 pool to read.",
});

/** Pair a v4 failure code with its sentence. Always stamped with the venue. */
function fail(reason, extra = {}) {
  return { ok: false, reason, detail: V4_REASONS[reason] ?? null, source: "uniswap_v4", ...extra };
}

/**
 * Which v4 reasons mean the question is UNANSWERED rather than answered "no".
 *
 * Exported because the layer that writes sentences has to know the difference and must
 * not re-derive it from a string match — the whole point of a code is that the set it
 * belongs to is stated once. `no_pool` is deliberately absent: it is the one v4 outcome
 * that IS a measured absence, and it is measured by the chain's own log index rather than
 * by a sweep that might have missed a tier.
 */
export const V4_UNREAD_REASONS = Object.freeze(
  new Set([
    "manager_unknown",
    "discovery_failed",
    "no_client",
    "state_read_failed",
    "quote_unverified",
    "depth_unreadable",
    "depth_inconclusive",
  ]),
);

/* ------------------------------ small helpers ----------------------------- */

/** A 20-byte hex address, lowercased, or null. Everything else is not an address. */
function normalizeAddress(raw) {
  const s = String(raw ?? "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : null;
}

/** A 32-byte hex word, lowercased, or null. Pool ids and storage slots are both this. */
function normalizeWord(raw) {
  const s = String(raw ?? "").trim();
  return /^0x[0-9a-fA-F]{64}$/.test(s) ? s.toLowerCase() : null;
}

/** Case-insensitive address compare — the chain mixes case, our keys do not. */
function sameAddress(a, b) {
  const x = normalizeAddress(a);
  const y = normalizeAddress(b);
  return x !== null && x === y;
}

/**
 * The hasher every storage slot below is derived with.
 *
 * INJECTABLE, AND THE REASON IS NOT PURITY. The slot arithmetic — a mapping key
 * sign-extended to a full word, a struct offset added to a keccak output — is the part of
 * this module that has no observable output of its own: get it wrong and the ladder comes
 * back EMPTY, which reads as one enormous liquidity range rather than as an error. So the
 * arithmetic is exercised offline against a stub hasher that records exactly what it was
 * asked to hash, which is the only way to test it without a chain. Production passes
 * nothing and gets viem's.
 */
function hasher(options) {
  return typeof options?.keccak === "function" ? options.keccak : keccak256;
}

/** Run a read without letting it fail the whole gather. Same shape as lib/dex-price.js. */
async function attempt(thunk) {
  try {
    return { ok: true, value: await thunk() };
  } catch {
    return { ok: false, value: null };
  }
}

/** a * b, with null in and null out — never 0 for a missing factor. */
function mul(a, b) {
  if (a == null || b == null) return null;
  const n = a * b;
  return Number.isFinite(n) ? n : null;
}

/** The configured `_pools` slot, env override first. Junk falls back rather than breaking. */
function poolsSlot() {
  const raw = String(process.env.UNISWAP_V4_POOLS_SLOT ?? "").trim();
  if (!raw) return DEFAULT_POOLS_SLOT;
  try {
    const n = BigInt(raw);
    return n >= 0n && n < 1000n ? n : DEFAULT_POOLS_SLOT;
  } catch {
    return DEFAULT_POOLS_SLOT;
  }
}

/**
 * Volatile v4 reads go through the shared indexer cache on the PRICE TTL, exactly as
 * lib/dex-price.js's do and for the same reason: the contract that cache enforces is the
 * one wanted here — a successful read is held briefly, a FAILURE IS NEVER HELD AT ALL,
 * and concurrent duplicates collapse into one call. Keys are namespaced "v4:" so they
 * cannot collide with an indexer URL or with the v3 reader's "dex:" keys.
 */
function cachedRead(key, fetcher) {
  return withIndexerCache(`v4:${key}`, fetcher, { ttlMs: priceCacheTtlMs() });
}

/* ------------------------------ storage slots ----------------------------- */

/**
 * The base storage slot of one pool's state inside the singleton.
 *
 * keccak256(poolId . slot) — the ordinary Solidity mapping-slot formula, with the key
 * first. Injected rather than imported so this module needs no crypto dependency of its
 * own and the arithmetic stays testable with a stub hasher.
 *
 * @param {(hex: string) => string} keccak - keccak256 over a hex string
 * @param {string} poolId
 * @returns {string|null}
 */
export function poolStateSlot(keccak, poolId) {
  const id = normalizeWord(poolId);
  if (!id || typeof keccak !== "function") return null;
  const slotWord = poolsSlot().toString(16).padStart(64, "0");
  return normalizeWord(keccak(`0x${id.slice(2)}${slotWord}`));
}

/** base + n, as a 32-byte word. Struct fields sit at consecutive slots. */
export function slotAt(base, offset) {
  const b = normalizeWord(base);
  if (b === null) return null;
  const n = BigInt(b) + BigInt(offset);
  if (n < 0n || n >= 1n << 256n) return null;
  return `0x${n.toString(16).padStart(64, "0")}`;
}

/**
 * The slot of `mapping[key]` where the mapping itself lives at `mappingSlot`.
 *
 * THE KEY IS SIGN-EXTENDED TO A FULL WORD, and that is the part it is easy to get wrong.
 * Both v4 mappings this module reads are keyed by a SIGNED integer — `int16` for a bitmap
 * word position, `int24` for a tick — and Solidity stores the key for the hash by writing
 * the value into a 32-byte slot, which sign-extends it. Tick -412671 hashed as a positive
 * 0x…f96b81 rather than as two's-complement 0xfff…f96b81 lands on a completely different,
 * always-zero slot: the ladder would come back empty and the pool would look like one
 * enormous range. That reads as MORE depth than exists, which is the one direction this
 * codebase never tolerates. Every negative tick on chain 4663 goes through here, and
 * PIPECAT's dollar-quoted pools all sit near tick -400000.
 */
export function mappingSlot(keccak, key, mappingSlotWord) {
  const m = normalizeWord(mappingSlotWord);
  if (m === null || typeof keccak !== "function") return null;
  const k = BigInt(key);
  const word = (k < 0n ? (1n << 256n) + k : k).toString(16).padStart(64, "0");
  if (word.length !== 64) return null;
  return normalizeWord(keccak(`0x${word}${m.slice(2)}`));
}

/**
 * Unpack a v4 Slot0 word: sqrtPriceX96 in the low 160 bits, then tick, protocolFee and
 * lpFee in 24 bits each.
 *
 * THE TICK IS SIGNED and has to be folded back from 24-bit two's complement. Read as
 * unsigned, PIPECAT's -412671 becomes 16364545 — a tick outside Uniswap's range
 * altogether, which would make its price unrepresentable and the pool look unreadable.
 * Every dollar-quoted pool measured on this chain has a negative tick, so this is the
 * normal case and not an edge one.
 *
 * A ZERO WORD IS AN UNINITIALISED POOL, not a price of zero — the caller must treat
 * `sqrtPriceX96 === 0n` as "nobody has ever put a price in here".
 */
export function unpackSlot0(word) {
  const w = normalizeWord(word);
  if (w === null) return null;
  const value = BigInt(w);
  const sqrtPriceX96 = value & ((1n << 160n) - 1n);
  let tick = Number((value >> 160n) & 0xffffffn);
  if (tick >= 0x800000) tick -= 0x1000000;
  return {
    sqrtPriceX96,
    tick,
    protocolFee: Number((value >> 184n) & 0xffffffn),
    lpFee: Number((value >> 208n) & 0xffffffn),
  };
}

/**
 * Unpack a v4 tick-info word: liquidityGross low, liquidityNet high, signed.
 *
 * liquidityNet folded back from int128 rather than read as a uint, for the reason the tick
 * above is: the net at the UPPER edge of a position is negative, and read unsigned it
 * becomes ~3.4e38. lib/tick-depth.js integrateBand would then ADD that on the way down
 * instead of subtracting it and report a range with more liquidity than the pool has ever
 * held. Verified live on PIPECAT's busiest pool, whose one initialised tick in range
 * carries net = -liquidityGross = -36819258015569838458222.
 */
export function unpackTickInfo(word) {
  const w = normalizeWord(word);
  if (w === null) return null;
  const value = BigInt(w);
  const Q128 = 1n << 128n;
  let liquidityNet = value >> 128n;
  if (liquidityNet >= Q128 / 2n) liquidityNet -= Q128;
  return { liquidityGross: value & (Q128 - 1n), liquidityNet };
}

/* -------------------------------- discovery ------------------------------- */

/**
 * EVERY V4 POOL A TOKEN IS A SIDE OF — from the chain's own log index, in two queries.
 *
 * HOW, AND WHAT WAS REJECTED. Four routes were measured before this one was chosen:
 *
 *   - `eth_getLogs` on the singleton, filtered by the Initialize topic AND the token in
 *     the currency0 or currency1 topic slot, fromBlock 0 to latest. CHOSEN. ~360ms per
 *     side over full chain history, no paging. Two queries and not one because a PoolKey
 *     sorts its currencies by address, so a token is currency0 in some of its pools and
 *     currency1 in others, and a topic filter can only OR WITHIN one position.
 *   - Blockscout's v2 `/addresses/{a}/logs`. REJECTED: it takes no topic filter at all
 *     (HTTP 422, "Unexpected field: topic0"), so it would mean paging 50 logs at a time
 *     through the singleton's entire history to find one token's pools.
 *   - Blockscout's legacy `?module=logs&action=getLogs`, which DOES filter by topic and
 *     did answer correctly in ~700ms. REJECTED as the primary route: measured over 24
 *     paced calls it returned HTTP 429 on 9 of them. Kept in mind as a fallback and not
 *     built, because a second route would double the code that has to be right for a
 *     fact the first route already establishes 92% of the time and retries into ~100%.
 *   - Computing poolIds by hashing candidate PoolKeys. REJECTED: fee and tickSpacing are
 *     free 24-bit parameters in v4 rather than a fixed ladder of four tiers, and hooks is
 *     an arbitrary address. Guessing would silently MISS pools — measured, PIPECAT's
 *     pools use fees of 0, 9000, 160000, 870000, 900000, 970090 and 990001, none of which
 *     is a v3 tier — and a miss here reads as "no market".
 *
 * IT IS RETRIED, BECAUSE THE FAILURE IS THE SAME ONE D1 WAS ABOUT. Unpaced, 2 of 24 log
 * queries came back "log query timed out" — roughly 8%, transient, and the very next
 * attempt succeeded; paced at 700ms, 16 of 16 succeeded in ~360ms. So this is upstream
 * flakiness rather than a range problem or a rate limit, and the answer is to ask again.
 * The shared policy in lib/page-retry.js is used rather than a local loop for the reason
 * given there: how hard to re-ask one upstream is one policy, and three copies drift.
 *
 * THREE OUTCOMES, KEPT APART. `found` with pools; `none`, which is a MEASURED ABSENCE
 * because the node answered from its log index and there is nothing there; and `unread`,
 * where a query failed every attempt and NOTHING may be concluded. A partial answer is
 * `unread` too: if the currency0 side answered and the currency1 side did not, the pools
 * we have are real but the set is incomplete, and a set with a hole in it cannot be
 * ranked — the deepest pool could be in the half we never saw.
 *
 * @param {object} client - viem-shaped; needs `getLogs`
 * @param {string} manager - the PoolManager, already verified by BEHAVIOUR upstream
 * @param {string} token
 * @param {{ sleep?: Function, attempts?: number }} [options]
 * @returns {Promise<{ status: "found"|"none"|"unread", pools: Array<object>,
 *   poolsDropped: number, reason: string|null }>}
 */
export async function readV4Pools(client, manager, token, options = {}) {
  const address = normalizeAddress(token);
  const pm = normalizeAddress(manager);
  if (!address) return { status: "unread", pools: [], poolsDropped: 0, reason: "bad_address" };
  if (!pm) return { status: "unread", pools: [], poolsDropped: 0, reason: "manager_unknown" };
  if (!client || typeof client.getLogs !== "function") {
    return { status: "unread", pools: [], poolsDropped: 0, reason: "no_client" };
  }

  /**
   * One side of the pair. Cached on the price TTL rather than forever: a pool's EXISTENCE
   * is permanent once created, but "this token has no v4 pool" expires the moment somebody
   * creates one, and the two answers come back from the same query. A short TTL is correct
   * for the pair of them; a permanent one would make a new pool invisible until restart.
   */
  const side = async (position) => {
    const res = await readPageWithRetry(
      () =>
        cachedRead(`pools:${pm}:${address}:${position}`, async () => {
          const logs = await client.getLogs({
            address: pm,
            event: V4_INITIALIZE_EVENT,
            args: position === 0 ? { currency0: address } : { currency1: address },
            fromBlock: 0n,
            toBlock: "latest",
          });
          return { logs: Array.isArray(logs) ? logs.map(readInitializeLog) : null };
        }),
      {
        minMs: V4_MIN_MS,
        label: `uniswap v4 pool discovery (currency${position})`,
        sleep: options.sleep,
        attempts: options.attempts ?? V4_LOG_ATTEMPTS,
        backoffMs: options.backoffMs ?? V4_LOG_BACKOFF_MS,
      },
    );
    return res.ok ? res.value?.logs ?? null : null;
  };

  // IN SEQUENCE, NOT TOGETHER. See V4_LOG_BACKOFF_MS: run concurrently these two queries
  // reliably tripped this RPC's rate limiter, and the 360ms that bought was paid for with
  // the answer. A page that DID land is already in the cache, so a caller retrying the whole
  // lookup re-reads only the side that failed.
  const asCurrency0 = await side(0);
  const asCurrency1 = await side(1);
  // A HOLE IN THE SET IS NOT A SMALLER SET. Either side failing means the pools we hold
  // may not be all of them, and a ranking over a subset would name a "deepest pool" that
  // is only the deepest of the ones we happened to see.
  if (asCurrency0 === null || asCurrency1 === null) {
    return { status: "unread", pools: [], poolsDropped: 0, reason: "discovery_failed" };
  }

  const seen = new Set();
  const pools = [];
  let poolsDropped = 0;
  // Discovery order is log order, which is chain order — deterministic, so the tie-break
  // at the end of the depth compare resolves the same way on every call.
  for (const log of [...asCurrency0, ...asCurrency1]) {
    // A log we could not decode is not a pool we may drop silently: it might be the deep
    // one, so it makes the whole set unrankable, exactly as a failed query does.
    if (log === null) return { status: "unread", pools: [], poolsDropped: 0, reason: "discovery_failed" };
    if (seen.has(log.poolId)) continue;
    if (!sameAddress(log.currency0, address) && !sameAddress(log.currency1, address)) continue;
    // The MEASUREMENT cap is applied by the caller, where the quote assets are known — see
    // MAX_V4_POOLS. This ceiling is only about not holding an unbounded array.
    if (pools.length >= MAX_V4_POOLS_RETAINED) {
      poolsDropped += 1;
      continue;
    }
    seen.add(log.poolId);
    pools.push(log);
  }

  if (!pools.length) return { status: "none", pools: [], poolsDropped, reason: "no_pool" };
  return { status: "found", pools, poolsDropped, reason: null };
}

/**
 * One Initialize log to a PoolKey. Null when anything about it is not what it claims —
 * a decode that half-worked is a pool we do not actually know the shape of.
 *
 * Accepts viem's decoded `args` and a plain object alike, so a fake chain in a test can
 * hand over the same shape without a real ABI decoder — the same accommodation
 * lib/dex-price.js readSlot0 makes for tuple-or-object returns.
 */
function readInitializeLog(log) {
  const a = log?.args ?? log ?? null;
  if (!a || typeof a !== "object") return null;
  const poolId = normalizeWord(a.id);
  const currency0 = normalizeAddress(a.currency0);
  const currency1 = normalizeAddress(a.currency1);
  const hooks = normalizeAddress(a.hooks);
  const fee = Number(a.fee);
  const tickSpacing = Number(a.tickSpacing);
  if (!poolId || !currency0 || !currency1 || hooks === null) return null;
  // A tick spacing of zero or a negative one is not a pool that can exist, and it would
  // make every slot below it a division by zero.
  if (!Number.isInteger(fee) || fee < 0 || !Number.isInteger(tickSpacing) || tickSpacing <= 0) return null;
  const block = Number(log?.blockNumber ?? a.blockNumber);
  return {
    poolId,
    currency0,
    currency1,
    fee,
    tickSpacing,
    hooks,
    // A HOOK IS A CONTRACT THAT RUNS INSIDE THE SWAP, so it is carried on every pool and
    // never dropped. See v4MarketData for what it does and does not change about a figure.
    hooked: !sameAddress(hooks, NATIVE_CURRENCY),
    initializedAtBlock: Number.isFinite(block) ? block : null,
  };
}

/* -------------------------------- pool state ------------------------------ */

/**
 * Slot0 AND liquidity for every pool, LIVE, in one batched `extsload`.
 *
 * LIVE STATE RATHER THAN THE LAST SWAP EVENT, and the difference is the whole reason this
 * function exists. A v4 Swap log carries sqrtPriceX96, liquidity and tick, so a recent
 * swap yields a price with no storage arithmetic at all — which is genuinely tempting and
 * genuinely worse. That price is AS OF THAT SWAP: on a pool whose last trade was weeks
 * ago it is a stale quote wearing a current one's clothes, and there is no honest way to
 * present it as the price now. Measured on PIPECAT, 5 of its 8 pools saw no swap at all in
 * the last 300,000 blocks, so the event route would have had nothing to say about most of
 * them while their live state was one call away. Storage is read at the head block, so
 * every figure here is current by construction and `asOfBlock` is a fact rather than a
 * caveat.
 *
 * TWO SLOTS PER POOL, ONE CALL FOR ALL OF THEM. `extsload(bytes32[])` takes the whole
 * list, so a token with eight pools costs one round trip where the v3 equivalent is four
 * getters per pool contract.
 *
 * NULL IS UNREAD, NEVER EMPTY. A call that threw or came back the wrong length leaves
 * every pool unmeasured; it never degrades to a pool with no liquidity, which is a
 * measurement nobody took.
 *
 * @returns {Promise<Map<string, { sqrtPriceX96: bigint, tick: number, lpFee: number,
 *   liquidity: bigint }>|null>}
 */
export async function readV4PoolState(client, manager, pools, options = {}) {
  const pm = normalizeAddress(manager);
  const keccak = hasher(options);
  if (!pm) return null;
  if (!client || typeof client.readContract !== "function") return null;
  if (!Array.isArray(pools) || !pools.length) return null;

  const bases = [];
  const slots = [];
  for (const pool of pools) {
    const base = poolStateSlot(keccak, pool.poolId);
    const slot0 = slotAt(base, SLOT0_OFFSET);
    const liquidity = slotAt(base, LIQUIDITY_OFFSET);
    if (base === null || slot0 === null || liquidity === null) return null;
    bases.push({ poolId: pool.poolId, base });
    slots.push(slot0, liquidity);
  }

  /**
   * RETRIED, BECAUSE THIS ONE CALL IS THE WHOLE PRICE.
   *
   * Every v4 pool's Slot0 and liquidity come back in a single `extsload`, which is what makes
   * this cheap — and also means one rate-limited response costs the entire v4 answer for the
   * token, where the v3 equivalent would lose one pool of several. Measured live: this call
   * came back rate-limited during a burst and The Green Bull reported `state_read_failed`
   * having priced fine a minute earlier. The shared policy from lib/page-retry.js is used
   * rather than a local loop for the reason given there, and it is safe for the reason given
   * there too: lib/indexer-cache.js never stores a failure, so the retry really does go
   * upstream, and the budget is checked before each one.
   */
  const res = await readPageWithRetry(
    () =>
      cachedRead(`state:${pm}:${slots.join(",")}`, async () => {
        const words = await client.readContract({
          address: pm,
          abi: V4_STATE_ABI,
          functionName: "extsload",
          args: [slots],
        });
        if (!Array.isArray(words) || words.length !== slots.length) {
          throw new Error("v4 state read returned the wrong shape");
        }
        // Strings, not BigInts: the cache round-trips values through structuredClone and a
        // decoded word has to survive it. Same reason lib/dex-price.js readSlot0 does this.
        return { words: words.map((w) => String(w)) };
      }),
    { minMs: V4_MIN_MS, label: "uniswap v4 pool state", sleep: options.sleep, backoffMs: options.backoffMs ?? V4_LOG_BACKOFF_MS },
  );
  if (!res.ok || !res.value) return null;

  const out = new Map();
  for (let i = 0; i < bases.length; i += 1) {
    const slot0 = unpackSlot0(res.value.words[i * 2]);
    const liquidityWord = normalizeWord(res.value.words[i * 2 + 1]);
    if (slot0 === null || liquidityWord === null) return null;
    out.set(bases[i].poolId, {
      base: bases[i].base,
      sqrtPriceX96: slot0.sqrtPriceX96,
      tick: slot0.tick,
      lpFee: slot0.lpFee,
      protocolFee: slot0.protocolFee,
      liquidity: BigInt(liquidityWord),
    });
  }
  return out;
}

/* ---------------------------------- depth --------------------------------- */

/**
 * WHAT A SELLER COULD ACTUALLY REALISE FROM A V4 POOL — the SAME integral over the SAME
 * band as the v3 figure, measured with the same instrument.
 *
 * THIS COULD HAVE BEEN MUCH WEAKER AND THE WEAKER VERSION IS WORTH NAMING, because the
 * brief permitted it. Without the tick ladder the only rigorous v4 depth available is the
 * amount realisable between spot and the nearest TICK-SPACING BOUNDARY: initialised ticks
 * can only sit on multiples of the pool's spacing, so liquidity is provably constant
 * across the enclosing aligned interval and that amount is a true lower bound needing no
 * extra reads at all. It was implemented and measured, and it was too blunt to decide
 * anything: on PIPECAT's busiest pool it read $11.90 where the real band depth is $45.90,
 * and three of the eight pools came back as lower bounds of $0.00 — figures that count
 * upward only, so they cannot be shown to have LOST a comparison, so no pool could be
 * selected and PIPECAT would have stayed unpriced. An honest measurement that cannot
 * distinguish the market from seven empty pools is not yet an answer.
 *
 * SO THE LADDER IS READ, and in v4 that is CHEAPER than in v3 rather than dearer: the
 * bitmap words and tick entries are storage words in the singleton, so they batch. The
 * budget, the ordering-outward-from-spot, the coverage bookkeeping and the
 * capped-versus-unread distinction are all lib/tick-depth.js's, reached through its
 * `readBitmap` / `readTick` seam. Nothing about how a truncated walk is turned into a
 * labelled lower bound is reimplemented here — see readTickLadder for why that matters.
 *
 * WHAT IS GENUINELY WEAKER ABOUT A V4 FIGURE, AND IT IS NOT THE INTEGRAL. A pool may name
 * a HOOK, a contract the singleton calls inside the swap, which can charge a dynamic fee
 * or return a delta of its own. So for a hooked pool this figure is what the POOL'S
 * COMMITTED STATE holds across the band — a true statement about the state, and not a
 * promise about what a swap returns. Measured, PIPECAT's busiest pool is hooked. That is
 * reported as `hooked` and stated in the notice; it is not silently discounted, because a
 * discount nobody can compute is a fabricated figure, and it is not suppressed either,
 * because suppressing the deepest pool on the chain would recreate the very absence this
 * module exists to remove.
 *
 * @returns {Promise<{ amounts: object, lowerBound: object, coveredBandBps: number|null,
 *   ladderTruncated: boolean }|null>} null ONLY when the ladder could not be READ.
 */
export async function measureV4Depth(client, manager, pool, state, quoteIsToken0, options = {}) {
  const pm = normalizeAddress(manager);
  const keccak = hasher(options);
  if (!pm || !state) return null;
  const ticksMap = slotAt(state.base, TICKS_OFFSET);
  const bitmapMap = slotAt(state.base, TICK_BITMAP_OFFSET);
  if (ticksMap === null || bitmapMap === null) return null;

  /** One storage word out of the singleton. The batching transport packs these. */
  const word = async (slot) => {
    if (slot === null) throw new Error("v4 slot could not be computed");
    const words = await client.readContract({
      address: pm,
      abi: V4_STATE_ABI,
      functionName: "extsload",
      args: [[slot]],
    });
    if (!Array.isArray(words) || words.length !== 1) throw new Error("v4 word read returned the wrong shape");
    return String(words[0]);
  };

  return measureBandDepth(
    client,
    // The poolId stands in for the pool ADDRESS, which v4 does not have. It is only ever
    // a cache key inside the ladder read, and it is the right one: two pools in the same
    // singleton must not share a bitmap entry.
    pool.poolId,
    {
      sqrtPriceX96: state.sqrtPriceX96,
      tick: state.tick,
      liquidity: state.liquidity,
      tickSpacing: pool.tickSpacing,
      quoteIsToken0,
    },
    {
      ...options,
      cachedRead,
      readBitmap: (wordPosition) => word(mappingSlot(keccak, wordPosition, bitmapMap)),
      readTick: async (tick) => unpackTickInfo(await word(mappingSlot(keccak, tick, ticksMap))),
    },
  );
}

/* --------------------------------- pricing -------------------------------- */

/**
 * Human-units price of the target denominated in the other currency of the pair.
 *
 * Delegated to lib/dex-price.js's own `priceFromSqrtX96` rather than rewritten, because
 * it is the same identity over the same encoding — a v4 Slot0 sqrtPriceX96 means exactly
 * what a v3 slot0 one does — and a second copy of the decimals correction is a second
 * place for the 10^d0 / 10^d1 to be the wrong way round. It arrives as an injected
 * function so this module does not import the v3 module and create a cycle.
 */
function priceInQuoteOf(priceFromSqrtX96, state, decimals0, decimals1, targetIsToken0) {
  if (typeof priceFromSqrtX96 !== "function") return null;
  return priceFromSqrtX96(state.sqrtPriceX96, decimals0, decimals1, targetIsToken0);
}

/** decimals() for a currency, or 18 for native ETH, which has no contract to ask. */
async function readDecimals(client, currency, cache) {
  const address = normalizeAddress(currency);
  if (!address) return null;
  if (sameAddress(address, NATIVE_CURRENCY)) return 18;
  if (cache.has(address)) return cache.get(address);
  const res = await attempt(() =>
    client.readContract({ address, abi: ERC20_DECIMALS_ABI, functionName: "decimals" }),
  );
  if (!res.ok) return null;
  const n = Number(res.value);
  if (!Number.isInteger(n) || n < 0 || n > 77) return null;
  cache.set(address, n);
  return n;
}

/**
 * Which of two measured v4 pools is the deeper, as a sort compare.
 *
 * Deliberately the same shape as lib/dex-price.js deeperPool: unmeasured sorts last so it
 * cannot be chosen (the CALLER checks separately for its presence and refuses to select),
 * dollars are the only figure comparable across quote assets, the wide band breaks a tie
 * on the ranking figure and can never overturn one, and everything else falls through to a
 * deterministic order so the same token resolves to the same pool on every call.
 */
function deeperV4Pool(a, b) {
  // UNMEASURED means THE LADDER WAS NOT READ, and nothing else. It used to mean "has no
  // dollar figure", which is a different and much broader thing — with no ETH/USD rate every
  // pool's dollar depth is null while every ladder read perfectly, so the whole field sorted
  // as unmeasured and the caller reported `depth_unreadable`: an outage, asserted, about
  // reads that all succeeded. The missing dollar leg has its own code (`no_eth_price`) and
  // reaches it by way of a selection that still works.
  const ua = !a.depthRead;
  const ub = !b.depthRead;
  if (ua !== ub) return ua ? 1 : -1;
  if (ua && ub) return a.discoveryIndex - b.discoveryIndex;

  const byRank = compareV4Depth(a, b, a.depthUsd, b.depthUsd, a.depthQuoteUnits, b.depthQuoteUnits);
  if (byRank !== 0) return byRank;
  const byWide = compareV4Depth(a, b, a.wideDepthUsd, b.wideDepthUsd, a.wideDepthQuoteUnits, b.wideDepthQuoteUnits);
  if (byWide !== 0) return byWide;
  return a.discoveryIndex - b.discoveryIndex;
}

/**
 * Descending compare of two v4 depth readings — dollars first, then the raw quote AMOUNT but
 * only when both pools are quoted in the same asset.
 *
 * The same three-tier rule as lib/dex-price.js compareDepth, and the middle tier is the point:
 * comparing 3 native ETH against 3 USDG would be arithmetic on two different units, so it is
 * refused rather than fudged. Two pools with no dollar leg and different quote assets are
 * simply not ordered by depth, and the deterministic tie-break decides — which is honest,
 * because nothing here can say which is deeper.
 */
function compareV4Depth(a, b, usdA, usdB, unitsA, unitsB) {
  const ua = finiteOrNull(usdA);
  const ub = finiteOrNull(usdB);
  if (ua !== null && ub !== null) return ua === ub ? 0 : ub > ua ? 1 : -1;
  if (sameAddress(a.quote?.address, b.quote?.address)) {
    const na = finiteOrNull(unitsA);
    const nb = finiteOrNull(unitsB);
    if (na !== null && nb !== null) return na === nb ? 0 : nb > na ? 1 : -1;
  }
  // One priced in dollars and one not: the priced one is the comparable figure.
  if (ua !== ub) return ua === null ? 1 : -1;
  return 0;
}

/**
 * PRICE AND MARKET CAP FOR A TOKEN FROM ITS UNISWAP V4 POOLS — the one call
 * lib/dex-price.js tokenMarketData makes into this module.
 *
 * THE SELECTION RULE IS THE V3 ONE, and it is not a formality: v4 makes the attack it
 * defends against CHEAPER. In v3 a decoy pool costs a gas-only `createPool` at one of
 * four fee tiers; in v4 the fee and the tick spacing are free 24-bit fields of the
 * PoolKey, so an attacker can mint unlimited distinct pools for a token they have nothing
 * to do with and there is no tier list to sweep exhaustively. Measured on PIPECAT, its
 * eight pools quote prices spanning 1.2e-6 to 7.6e-5 — a 63× spread, and therefore market
 * caps from $1,140 to $72,629 depending purely on which pool is believed. So the choice is
 * made on measured realisable depth and on nothing else, and:
 *
 *   - a pool whose ladder went UNREAD ends the selection once there is more than one
 *     candidate (`depth_unreadable`). An unread pool could be arbitrarily deep, so nothing
 *     establishes that the pool which answered is the deepest — and "the deepest" is the
 *     entire basis on which a price source is chosen.
 *   - a pool that LOST on a LOWER BOUND also ends it (`depth_inconclusive`). A figure that
 *     counts upward has not been shown to have lost.
 *   - a bound on the LEADER is decisive and is kept: the true figure is at least that and
 *     every rival is exact, so a floor above the whole field settles the order. Measured,
 *     PIPECAT resolves exactly here — its busiest pool reads $45.90 against a field whose
 *     best rival is $0.46.
 *   - ONE candidate is a different situation and is left alone: no choice is being made,
 *     so an unreadable ladder costs the DEPTH figure and not the price.
 *
 * @param {string} tokenAddress
 * @param {{ client?: object, manager?: string|null, quotes?: Array<object>,
 *   quotesUnverified?: number, ethUsd?: number|null, keccak?: Function,
 *   priceFromSqrtX96?: Function, totalSupply?: string|bigint|null, decimals?: number|null,
 *   supplyToNumber?: Function, bands?: number[] }} [options]
 */
export async function v4MarketData(tokenAddress, options = {}) {
  const token = normalizeAddress(tokenAddress);
  if (!token) return fail("bad_address");

  const client = options.client;
  if (!client || typeof client.readContract !== "function" || typeof client.getLogs !== "function") {
    return fail("no_client");
  }
  const manager = normalizeAddress(options.manager);
  // The manager is verified by BEHAVIOUR upstream (lib/dex-price.js resolveV4PoolManager)
  // and never by this module, so an unresolved one is an outage here and not an absence:
  // the singleton that holds every v4 pool was simply never asked.
  if (!manager) return fail("manager_unknown");

  /**
   * DISCOVERY MAY ALREADY HAVE HAPPENED, and when it has it is because the caller needed it
   * to happen SOMEWHERE QUIET. See lib/dex-price.js v4Discover: the log queries are the one
   * fragile read in this module, and running them alongside the v3 sweep's ~170 concurrent
   * eth_calls made them fail on the two live tokens with the largest pool sets. So the caller
   * is allowed to do that step first, on its own, and hand the result in — everything after
   * this line is batched eth_calls and overlaps the v3 sweep happily.
   *
   * An absent `discovery` means "do it here", which keeps this function usable on its own.
   */
  const found = options.discovery ?? (await readV4Pools(client, manager, token, options));
  if (found.status === "unread") return fail(found.reason ?? "discovery_failed");
  if (found.status === "none") return fail("no_pool", { poolCount: 0 });
  if (!Array.isArray(found.pools) || !found.pools.length) return fail("no_pool", { poolCount: 0 });

  const quotes = Array.isArray(options.quotes) ? options.quotes : [];
  const ethPrice = finiteOrNull(options.ethUsd);
  // NATIVE ETH LEADS, and it is prepended here rather than handed in because it is a v4
  // fact: only a v4 PoolKey can name the zero address and mean the chain's gas token.
  // Its dollar value is the ETH/USD rate, and null propagates rather than defaulting —
  // a guessed ETH price would misprice every token on the chain.
  const quoteList = [
    { address: NATIVE_CURRENCY, kind: "native_eth", decimals: 18, usdPerUnit: ethPrice, verifiedBy: "chain_native_asset" },
    ...quotes,
  ];

  /**
   * WHICH POOLS GET MEASURED, when there are more than the budget pays for.
   *
   * PRICEABLE FIRST — a pool paired against a currency we can value, before one paired
   * against a currency we cannot. See MAX_V4_POOLS for the live case this exists for: The
   * Green Bull's 40 unpriceable pools filled a cap applied in log order and pushed out all 8
   * of its priceable ones, which is a result an attacker can arrange for the price of gas.
   *
   * Within each group the order is DISCOVERY ORDER, which is chain order — so the same token
   * measures the same pools on every call rather than the set moving with whichever query
   * settled first. The sort is stable, so it preserves that.
   */
  const withQuote = (pool) => {
    const other = sameAddress(pool.currency0, token) ? pool.currency1 : pool.currency0;
    return quoteList.findIndex((q) => sameAddress(q.address, other));
  };
  const ordered = found.pools
    .map((pool, discoveryIndex) => ({ pool, discoveryIndex, quoteIndex: withQuote(pool) }))
    .filter((row) => row.quoteIndex >= 0);
  const selected = ordered.slice(0, MAX_V4_POOLS);
  // Everything the cap kept out, added to whatever discovery's own ceiling already dropped.
  const poolsDropped = (found.poolsDropped ?? 0) + (ordered.length - selected.length);

  /**
   * A POOL AGAINST A CURRENCY WE CANNOT VALUE IS NOT READ AT ALL, and that is a cost fix with
   * a correctness fix inside it.
   *
   * The cost: The Green Bull has 48 v4 pools and not one of them is paired against native
   * ETH, WETH or a verified dollar — they are all against other tokens. Reading Slot0 and
   * liquidity for all 48 is 96 storage words, and measured live that extra load was enough to
   * make the CONCURRENT V3 SWEEP fail: the same lookup came back `discovery_failed` on the v3
   * side, having priced the token correctly a minute earlier. Spending reads that can only
   * produce nulls, at the price of the answer that was already working, is the worst possible
   * trade.
   *
   * The correctness: those reads could never have produced a figure. A pool's price is only a
   * price once its quote side has a dollar value, and none of these has one — so what is
   * skipped is a null, not a measurement. The pools are still REPORTED (see `unpriceable`
   * below): a reader is told they exist and that nothing here can value them, which is a
   * finding, and it is why the outcome is `no_quote` rather than `no_pool`.
   */
  const unpriceable = found.pools.length - ordered.length;
  if (!selected.length) {
    const shell = {
      source: "uniswap_v4",
      poolCount: found.pools.length,
      measuredPoolCount: 0,
      poolsDropped,
      unpriceablePoolCount: unpriceable,
      pools: found.pools.slice(0, MAX_V4_POOLS).map((pool) => ({
        poolId: pool.poolId,
        currency0: pool.currency0,
        currency1: pool.currency1,
        fee: pool.fee,
        tickSpacing: pool.tickSpacing,
        hooks: pool.hooks,
        hooked: pool.hooked,
        // NOT READ, which is neither "uninitialised" nor "empty" — the state was never asked
        // for, because no price could come of it either way.
        initialised: null,
        quote: null,
        priceInQuote: null,
        quoteLiquidityUsd: null,
        depthIsLowerBound: false,
        depthRead: false,
      })),
      hookedPoolCount: found.pools.filter((p) => p.hooked).length,
    };
    return { ...fail(finiteOrNull(options.quotesUnverified) > 0 ? "quote_unverified" : "no_quote"), ...shell };
  }

  const state = await readV4PoolState(
    client,
    manager,
    selected.map((s) => s.pool),
    options,
  );
  if (state === null) return fail("state_read_failed", { poolCount: selected.length, poolsDropped });

  const decimalsCache = new Map();
  if (Number.isInteger(Number(options.decimals))) decimalsCache.set(token, Number(options.decimals));
  const bands = Array.isArray(options.bands) && options.bands.length ? options.bands : [WIDE_BAND_BPS, RANK_BAND_BPS];

  const measured = await Promise.all(
    selected.map(async ({ pool, discoveryIndex, quoteIndex }) => {
      const st = state.get(pool.poolId) ?? null;
      const targetIsToken0 = sameAddress(pool.currency0, token);
      const other = targetIsToken0 ? pool.currency1 : pool.currency0;
      const quote = quoteIndex < 0 ? null : quoteList[quoteIndex];
      const row = {
        ...pool,
        discoveryIndex,
        targetIsToken0,
        quote,
        quoteIndex: quoteIndex < 0 ? quoteList.length : quoteIndex,
        state: st,
        // An uninitialised pool holds no price. It is a real reading of the pool and not
        // a failure, so it stays in the field with a depth of null and is excluded below.
        initialised: st !== null && st.sqrtPriceX96 > 0n,
        depthUsd: null,
        depthIsLowerBound: false,
        depthCoveredBandBps: null,
        wideDepthUsd: null,
        wideDepthIsLowerBound: false,
        depthRead: false,
      };
      // Only a pool that could actually price the token is worth a ladder read: a pool
      // against an unverifiable currency cannot produce a dollar figure however deep it is.
      if (!row.initialised || quote === null) return row;

      const [d0, d1] = await Promise.all([
        readDecimals(client, pool.currency0, decimalsCache),
        readDecimals(client, pool.currency1, decimalsCache),
      ]);
      if (d0 === null || d1 === null) return row;
      row.decimals0 = d0;
      row.decimals1 = d1;
      row.priceInQuote = priceInQuoteOf(options.priceFromSqrtX96, st, d0, d1, targetIsToken0);

      const depth = await attempt(() =>
        measureV4Depth(client, manager, pool, st, !targetIsToken0, { ...options, bands }),
      ).then((r) => (r.ok ? r.value : null));
      if (depth === null) return row;

      const quoteScale = 10n ** BigInt(quote.decimals ?? (sameAddress(other, NATIVE_CURRENCY) ? 18 : 18));
      // A raw 0n is a MEASURED nothing — the ladder was read and the band is empty — so it
      // has to survive the ratio helper's "too small to represent" null.
      const toUnits = (raw) =>
        raw === undefined || raw === null ? null : raw === 0n ? 0 : options.bigRatioToNumber?.(raw, quoteScale) ?? null;
      const rankUnits = toUnits(depth.amounts[RANK_BAND_BPS]);
      const wideUnits = bands.includes(WIDE_BAND_BPS) ? toUnits(depth.amounts[WIDE_BAND_BPS]) : null;
      row.depthRead = true;
      row.depthQuoteUnits = rankUnits;
      row.depthUsd = mul(rankUnits, finiteOrNull(quote.usdPerUnit));
      row.depthIsLowerBound = Boolean(depth.lowerBound[RANK_BAND_BPS]);
      row.depthCoveredBandBps = depth.lowerBound[RANK_BAND_BPS] ? finiteOrNull(depth.coveredBandBps) : null;
      row.wideDepthQuoteUnits = wideUnits;
      row.wideDepthUsd = mul(wideUnits, finiteOrNull(quote.usdPerUnit));
      row.wideDepthIsLowerBound = Boolean(depth.lowerBound[WIDE_BAND_BPS]);
      return row;
    }),
  );

  const shell = {
    source: "uniswap_v4",
    // HOW MANY POOLS THE TOKEN HAS, not how many were measured — the two differ exactly when
    // the cap bit, and `poolsDropped` beside it is what makes the difference legible. Saying
    // "8 pools" for a token with 65 would be reporting the budget as the world.
    poolCount: found.pools.length,
    measuredPoolCount: measured.length,
    poolsDropped,
    // Pools paired against a currency nothing here can value. Reported, because their
    // EXISTENCE is a finding even though their state was never read — see the early return
    // above for why reading it would have cost the answer and bought a column of nulls.
    unpriceablePoolCount: unpriceable,
    // EVERY POOL FOUND, so a caller can say a choice was made over a named field rather
    // than presenting one pool as though it were the only one. Trimmed to what a reader
    // could act on: the identity of the pool, its pair, and what was measured for it.
    pools: measured.map(summarizeRow),
    hookedPoolCount: measured.filter((r) => r.hooked).length,
  };

  // A pool nobody has priced yet is a stated reading; a field where NONE of them is
  // initialised is a stated absence of a price rather than a failure to read one.
  // Every pool that got this far has a quote asset — that is what `selected` filtered on —
  // so the only thing left to exclude is a pool nobody has ever put a price into. A field
  // where NONE of them is initialised is a stated absence of a price, not a failure to read
  // one: the state WAS read and every Slot0 came back zero.
  const quoted = measured.filter((r) => r.initialised);
  if (!quoted.length) return { ...fail("pool_not_initialised"), ...shell };

  const ranked = [...quoted].sort(deeperV4Pool);
  // The rules below are lib/dex-price.js resolvePool's, and only ever apply to a CHOICE:
  // with one candidate no selection is being made, so an unread ladder costs the depth
  // figure and not the price.
  // A LADDER THAT WAS NOT READ, and not merely a figure with no dollar leg — see
  // deeperV4Pool. A missing ETH/USD rate leaves every dollar figure null while every read
  // succeeded, and reporting that as an unreadable pool is an outage nobody observed.
  if (ranked.length > 1 && ranked.some((r) => !r.depthRead)) {
    return { ...fail("depth_unreadable"), ...shell };
  }
  if (ranked.length > 1 && ranked.slice(1).some((r) => r.depthIsLowerBound)) {
    return { ...fail("depth_inconclusive"), ...shell };
  }

  const best = ranked[0];
  const priceInQuote = finiteOrNull(best.priceInQuote);
  if (priceInQuote === null) return { ...fail("price_out_of_range"), ...shell, pool: best.poolId };

  const priceUsd = mul(priceInQuote, finiteOrNull(best.quote.usdPerUnit));
  const priceNative =
    best.quote.kind === "native_eth" || best.quote.kind === "native"
      ? priceInQuote
      : ethPrice !== null && ethPrice > 0
        ? mul(priceUsd, 1 / ethPrice)
        : null;

  const asOfBlock = await readBlockNumber(client);
  const base = {
    ...shell,
    pool: best.poolId,
    poolId: best.poolId,
    fee: best.fee,
    tickSpacing: best.tickSpacing,
    hooks: best.hooks,
    hooked: best.hooked,
    quote: {
      address: best.quote.address,
      kind: best.quote.kind,
      verifiedBy: best.quote.verifiedBy ?? null,
      usdPerUnit: finiteOrNull(best.quote.usdPerUnit),
    },
    priceInQuote,
    priceNative,
    asOfBlock,
  };

  if (priceUsd === null) return { ...fail("no_eth_price"), ...base };

  const supply = options.supplyToNumber?.(options.totalSupply, options.decimals) ?? null;
  const marketCap = mul(supply, priceUsd);
  return {
    ok: true,
    ...base,
    price: priceUsd,
    priceUsd,
    marketCap,
    // BAND DEPTH, measured by lib/tick-depth.js over the same band as the v3 figure and
    // named the same way — but reached through `source: "uniswap_v4"`, which every layer
    // above carries, so the two can never be shown as one unlabelled number.
    quoteLiquidityUsd: best.depthUsd,
    depthIsLowerBound: best.depthIsLowerBound,
    depthCoveredBandBps: best.depthCoveredBandBps,
    wideDepthUsd: best.wideDepthUsd,
    wideDepthIsLowerBound: best.wideDepthIsLowerBound,
    depthBandBps: RANK_BAND_BPS,
    wideBandBps: WIDE_BAND_BPS,
    // WHAT THE POOL HOLDS IS DELIBERATELY ABSENT, and its absence is a finding rather
    // than an omission. In v3 the quote-side balance is balanceOf(pool) and means this
    // pool's holdings. In v4 there is no pool address: the singleton custodies EVERY
    // pool's tokens, so balanceOf(manager) is the sum over every pool on the chain — the
    // very confusion that made the PoolManager look like a wallet with a conviction
    // position in two tokens. Reporting it as this pool's balance would be the same
    // mistake wearing a number.
    quoteBalanceUsd: null,
    quoteBalanceReason: "v4_singleton_pools_share_custody",
    liquidityUsd: null,
    ...(marketCap === null ? { marketCapReason: "supply_unknown" } : {}),
  };
}

/** One measured pool, trimmed to what a reader could act on. */
function summarizeRow(r) {
  return {
    poolId: r.poolId,
    currency0: r.currency0,
    currency1: r.currency1,
    fee: r.fee,
    tickSpacing: r.tickSpacing,
    hooks: r.hooks,
    hooked: r.hooked,
    initialised: r.initialised,
    quote: r.quote ? { address: r.quote.address, kind: r.quote.kind } : null,
    priceInQuote: finiteOrNull(r.priceInQuote),
    quoteLiquidityUsd: r.depthUsd,
    depthIsLowerBound: r.depthIsLowerBound,
    // TRUE means the ladder answered. False with a null depth is UNREAD, which is not
    // shallow — the two are different facts and a single null cannot carry both.
    depthRead: r.depthRead,
  };
}

/** The block the reads landed on, when the client can say. Never invented. */
async function readBlockNumber(client) {
  if (typeof client?.getBlockNumber !== "function") return null;
  const res = await attempt(() => client.getBlockNumber());
  if (!res.ok || res.value == null) return null;
  const n = Number(res.value);
  return Number.isFinite(n) ? n : null;
}
