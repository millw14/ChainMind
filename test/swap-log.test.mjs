// Tests for lib/swap-log.js — the layer that makes a BUY and a SELL observable, which
// nothing in this codebase could do before it: the pool readers see STATE, so "who is
// dumping this" had no answer at all.
//
// THE DEFECT THIS FILE GUARDS AGAINST IS AN INVERTED SIGN. Whether a positive amount0
// means the pool received token0 or the swapper did decides buy-versus-sell for every row
// the feature will ever emit, and getting it backwards labels every buy a sell —
// confidently, with no symptom. Measured live on chain 4663 on 2026-07-30, the two venues
// use OPPOSITE conventions:
//
//   v4 amounts are the SWAPPER's delta. 1,140 of 1,140 consecutive-swap pairs across the 8
//   busiest PoolManager pools have amount0 > 0 exactly when sqrtPriceX96 moved UP — token0
//   leaving the pool — and the ERC-20 Transfers in those transactions agree (tx 0x9654a1ed…
//   pays token1 INTO the singleton for a positive amount0).
//
//   v3 amounts are the POOL's delta. 99 of 99 pairs on The Green Bull pool 0x8f450B8E… have
//   amount0 > 0 exactly when sqrtPriceX96 moved DOWN, and tx 0xcf522a23… transfers exactly
//   amount0 of WETH INTO the pool for a positive amount0.
//
// So the sign tests below assert BOTH conventions and assert that they differ. A change
// that "tidied" them into one rule would pass a test that only checked one venue.
//
// THE SECOND DEFECT CLASS IS AN UNREAD WINDOW READING AS A QUIET MARKET. "No sells in the
// last ten minutes" is only sayable if the whole window was read, so every test that
// removes a chunk asserts `complete: false`, `canSayNone: false` and a notice that says
// LOWER BOUND — a zero from blocks nobody read is the worst figure this module could emit.
//
// Entirely offline. The chain is a fake object with no network; the logs are built with
// viem's real ABI encoder so the decoders are exercised against the same bytes the node
// sends, not against a hand-made object that skips the decode.
// Run with: npm test
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters } from "viem";
import { resetIndexerCache } from "../lib/indexer-cache.js";
import {
  AMOUNT_SIGN_CONVENTION,
  BLOCKS_PER_SECOND,
  DEFAULT_WINDOW_BLOCKS,
  MAX_LOG_SPAN,
  MAX_WINDOW_CHUNKS,
  MIN_LOG_SPAN,
  SWAP_REASONS,
  SWAP_TOPICS,
  VENUES,
  attachTraders,
  blockChunks,
  blocksForSeconds,
  decodeV3SwapLog,
  decodeV4SwapLog,
  poolMapFromDiscovery,
  readLogWindow,
  readV3Swaps,
  readV4Swaps,
  summariseSwaps,
  swapDirection,
  swapNotice,
  tokenSwapFlow,
  traderLegs,
} from "../lib/swap-log.js";

beforeEach(() => resetIndexerCache());
afterEach(() => resetIndexerCache());

/* ------------------------------- the fixtures ------------------------------ */

const PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const NATIVE = "0x0000000000000000000000000000000000000000";
// The real busy v4 pool and its pair, read off the chain's own Initialize log:
// currency0 = native ETH, currency1 = 0x933f5e26…, fee 10000, tickSpacing 200, no hooks.
const BUSY_POOL = "0xecdfad017e07389b50799c19ed328d44a4eaa93a356f34ebc086fc22d4b6d7ea";
const BUSY_TOKEN = "0x933f5e26c2002ece2898dcaa308a4f3153a9be44";
const OTHER_POOL = "0x2134886a5763c5daef0a96d3d90e2200547479c1a4e51228df38d78def12b39f";
// The router every swap in that pool went through, and two real originators behind it.
const ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904";
const TRADER_A = "0x43f814dfd98b7caf05813cf76c635f70c02f70c3";
const TRADER_B = "0xe8a46bdd7ff2f577e324c81c65f5c41ea2dd0b15";

// The known-good v3 pool: token0 = WETH, token1 = The Green Bull, fee 10000.
const V3_POOL = "0x8f450b8ee34f07681b68bbb97729fcd4e8778417";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const GREENBULL = "0x31be8f7485e36928c9de86566c62da82d4b6bf81";
const V3_ROUTER = "0x2a7f3d7486641c77600b9b9256132755c8aebb4f";
const V3_RECIPIENT = "0xe58b3089df6667fbf99b75595a1671baf6797d6d";
const V3_TRADER = "0x49668f6fd1c547f7fa2727a6f8960c8e2fd8ca82";

const pad = (address) => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
const txHash = (n) => `0x${String(n).padStart(64, "a")}`;

/** A v4 Swap log, encoded exactly as the PoolManager emits one. */
function v4Log({ poolId = BUSY_POOL, sender = ROUTER, amount0, amount1, sqrtPriceX96, liquidity = 10n ** 20n, tick = 204287, fee = 10000, block, logIndex = 0, tx = 1 } = {}) {
  return {
    address: PM,
    topics: [SWAP_TOPICS[VENUES.V4], poolId, pad(sender)],
    data: encodeAbiParameters(
      [{ type: "int128" }, { type: "int128" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }, { type: "uint24" }],
      [amount0, amount1, sqrtPriceX96, liquidity, tick, fee],
    ),
    blockNumber: `0x${BigInt(block).toString(16)}`,
    transactionHash: txHash(tx),
    logIndex: `0x${logIndex.toString(16)}`,
  };
}

/** A v3 Swap log, encoded exactly as a pool contract emits one. */
function v3Log({ pool = V3_POOL, sender = V3_ROUTER, recipient = V3_RECIPIENT, amount0, amount1, sqrtPriceX96, liquidity = 36819258015569838458222n, tick = 161523, block, logIndex = 0, tx = 1 } = {}) {
  return {
    address: pool,
    topics: [SWAP_TOPICS[VENUES.V3], pad(sender), pad(recipient)],
    data: encodeAbiParameters(
      [{ type: "int256" }, { type: "int256" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }],
      [amount0, amount1, sqrtPriceX96, liquidity, tick],
    ),
    blockNumber: `0x${BigInt(block).toString(16)}`,
    transactionHash: txHash(tx),
    logIndex: `0x${logIndex.toString(16)}`,
  };
}

/**
 * A fake node. `request` is what the module prefers, because it is the only way to actually
 * send a topics filter — see readLogChunk. `plan` maps a chunk (its fromBlock) either to a
 * list of logs or to a thrown error, so a test can remove exactly one chunk from a window.
 */
function fakeChain({ logs = [], failFrom = new Set(), refuseWiderThan = null, transactions = {}, head = 23310099n } = {}) {
  const calls = [];
  return {
    calls,
    async request({ method, params }) {
      if (method !== "eth_getLogs") throw new Error(`unexpected method ${method}`);
      const [filter] = params;
      const from = BigInt(filter.fromBlock);
      const to = BigInt(filter.toBlock);
      calls.push({ address: filter.address, from, to, topics: filter.topics ?? null });
      // Refusal is by WIDTH, which is how the real node behaves: it declines when the result
      // would be too big, so the same start block succeeds once the range is narrow enough.
      if (refuseWiderThan !== null && to - from + 1n > BigInt(refuseWiderThan)) {
        // The node's own words for a range it will not serve, verified live.
        const error = new Error("Missing or invalid parameters.");
        error.code = -32602;
        throw error;
      }
      if (failFrom.has(from)) throw new Error("log query timed out");
      // Topics ARE honoured here, as this chain's node does honour them — and the module
      // must still be correct without that, which testTopicsIgnored below checks.
      const wanted = filter.topics?.[0] ?? null;
      return logs.filter((l) => {
        const block = BigInt(l.blockNumber);
        if (block < from || block > to) return false;
        if (l.address.toLowerCase() !== String(filter.address).toLowerCase()) return false;
        return !wanted || l.topics[0] === wanted;
      });
    },
    async getTransaction({ hash }) {
      const tx = transactions[hash];
      if (!tx) throw new Error("transaction not found");
      return tx;
    },
    async getBlockNumber() {
      return head;
    },
  };
}

const noSleep = async () => {};

/* ============================ THE SIGN CONVENTION ========================== */

test("the sign convention is opposite on the two venues, and both directions are asserted", () => {
  // v4: the amounts are the SWAPPER's delta. Positive = the swapper received it = BOUGHT.
  assert.equal(AMOUNT_SIGN_CONVENTION[VENUES.V4], "swapper");
  assert.equal(swapDirection(VENUES.V4, 26470626649044355n), "bought");
  assert.equal(swapDirection(VENUES.V4, -20277908888642560n), "sold");

  // v3: the amounts are the POOL's delta. Positive = the pool received it = SOLD.
  assert.equal(AMOUNT_SIGN_CONVENTION[VENUES.V3], "pool");
  assert.equal(swapDirection(VENUES.V3, 32802000000000000n), "sold");
  assert.equal(swapDirection(VENUES.V3, -28273749753261872n), "bought");

  // The whole point: the SAME sign means the OPPOSITE trade on the two venues. A refactor
  // that unified them would invert one of the two.
  assert.notEqual(swapDirection(VENUES.V3, 1n), swapDirection(VENUES.V4, 1n));
});

test("a zero amount of the subject token is not a direction", () => {
  // Defaulting it to either side would put a row in a count it does not belong in.
  assert.equal(swapDirection(VENUES.V4, 0n), null);
  assert.equal(swapDirection(VENUES.V3, 0n), null);
  assert.equal(swapDirection("uniswap_v9", 1n), null);
});

test("the legs are stated from the TRADER's side on both venues, so the two are comparable", () => {
  // v4, real row: a0=+26470626649044355 a1=-19452901164239130734948189. The swapper PAID
  // token1 (the Transfer went INTO the singleton) and RECEIVED token0.
  const v4 = traderLegs(VENUES.V4, 26470626649044355n, -19452901164239130734948189n);
  assert.deepEqual(v4, {
    inCurrency: 1,
    outCurrency: 0,
    amountIn: 19452901164239130734948189n,
    amountOut: 26470626649044355n,
  });

  // v3, real row: a0=+32802000000000000 a1=-324520060480457565279175. Positive amount0 is
  // WETH the POOL received, so the trader paid token0 — the opposite mapping, same output shape.
  const v3 = traderLegs(VENUES.V3, 32802000000000000n, -324520060480457565279175n);
  assert.deepEqual(v3, {
    inCurrency: 0,
    outCurrency: 1,
    amountIn: 32802000000000000n,
    amountOut: 324520060480457565279175n,
  });
});

test("the tick-direction evidence reproduces: a v4 buy of token0 raises the price, a v3 sale lowers it", async () => {
  // This is the live experiment in miniature. Two consecutive swaps in one pool; the second
  // one's sign has to agree with the direction sqrtPriceX96 moved, because selling token0
  // into a constant-product pool always makes token0 cheaper. If the module's convention
  // were flipped, the direction it reports would contradict the price move here.
  const chain = fakeChain({
    logs: [
      v4Log({ amount0: -74250000000000000n, amount1: 51438873192098644451827191n, sqrtPriceX96: 2032399047296026740068306916964461n, block: 100, tx: 1 }),
      v4Log({ amount0: 26366606305616130n, amount1: -17908845715476092865497522n, sqrtPriceX96: 2076819437924405193397467186482985n, block: 101, tx: 2 }),
    ],
  });
  const res = await readV4Swaps(chain, {
    manager: PM,
    fromBlock: 100,
    toBlock: 200,
    poolsById: poolMapFromDiscovery([{ poolId: BUSY_POOL, currency0: NATIVE, currency1: BUSY_TOKEN, fee: 10000, tickSpacing: 200, hooks: NATIVE, hooked: false }]),
    subject: NATIVE,
    sleep: noSleep,
  });

  const [first, second] = res.rows;
  assert.ok(second.sqrtPriceX96 > first.sqrtPriceX96, "the price of token0 rose between these two swaps");
  // The price rose, so token0 LEFT the pool, so the trader bought token0. The subject here
  // IS token0 (native ETH), and amount0 is positive.
  assert.equal(second.subject.direction, "bought");
  assert.equal(first.subject.direction, "sold");
});

/* ================================ DECODING ================================= */

test("a v4 Swap decodes every field, including the fee that was actually charged", async () => {
  const log = v4Log({ amount0: 5245271471425682n, amount1: -207252055458477811n, sqrtPriceX96: 2456107800846296324485782733409638n, liquidity: 12345n, tick: -412671, fee: 10990, block: 500, logIndex: 7, tx: 3 });
  const row = decodeV4SwapLog(log);
  assert.equal(row.venue, VENUES.V4);
  assert.equal(row.poolId, BUSY_POOL);
  assert.equal(row.sender, ROUTER);
  assert.equal(row.amount0, 5245271471425682n);
  assert.equal(row.amount1, -207252055458477811n);
  assert.equal(row.tick, -412671, "a negative tick read unsigned would be 16364545");
  // 252, 10000 and 10990 are all observed live. There is no tier set on this chain and the
  // fee is a property of the SWAP, not of the pool.
  assert.equal(row.fee, 10990);
  assert.equal(row.feeSource, "swap_log");
  assert.equal(row.block, 500);
  assert.equal(row.logIndex, 7);
});

test("a v3 Swap decodes per pool, and its fee comes from the pool or is null — never a guessed tier", () => {
  const log = v3Log({ amount0: 23693153245729870n, amount1: -243038204393310027777732n, sqrtPriceX96: 100n, block: 700 });

  const withFee = decodeV3SwapLog(log, { pool: V3_POOL, fee: 10000 });
  assert.equal(withFee.venue, VENUES.V3);
  assert.equal(withFee.pool, V3_POOL);
  assert.equal(withFee.sender, V3_ROUTER);
  assert.equal(withFee.recipient, V3_RECIPIENT, "the recipient is a third address and is carried, not discarded");
  assert.equal(withFee.fee, 10000);
  assert.equal(withFee.feeSource, "pool_contract");

  // Nobody told us the fee. It is UNKNOWN — the v3 event has no fee field, and a tier
  // guessed from a set would be a fabricated figure.
  const without = decodeV3SwapLog(log, { pool: V3_POOL });
  assert.equal(without.fee, null);
  assert.equal(without.feeSource, "unknown");
});

test("a log that is not exactly what it claims decodes to null rather than to a plausible wrong price", () => {
  const good = v4Log({ amount0: 1n, amount1: -1n, sqrtPriceX96: 1n, block: 1 });

  // Wrong topic0 — the client-side check that makes the server's filter optional.
  assert.equal(decodeV4SwapLog({ ...good, topics: [SWAP_TOPICS[VENUES.V3], good.topics[1], good.topics[2]] }), null);
  // A v3 log handed to the v4 decoder and vice versa. The data widths differ by one word,
  // and a six-word layout decodes an eight-word field without complaint.
  assert.equal(decodeV4SwapLog(v3Log({ amount0: 1n, amount1: -1n, sqrtPriceX96: 1n, block: 1 })), null);
  assert.equal(decodeV3SwapLog(good), null);
  // Truncated data.
  assert.equal(decodeV4SwapLog({ ...good, data: good.data.slice(0, -64) }), null);
  // Missing identity: a row with no block or no tx hash cannot be pointed at.
  assert.equal(decodeV4SwapLog({ ...good, blockNumber: undefined }), null);
  assert.equal(decodeV4SwapLog({ ...good, transactionHash: "0xnope" }), null);
  assert.equal(decodeV4SwapLog({ ...good, topics: [good.topics[0], good.topics[1]] }), null);
});

/* ============================== ATTRIBUTION =============================== */

test("a v4 swap whose poolId is unmapped stays a swap, unattributed — never dropped and never mis-attributed", async () => {
  const chain = fakeChain({
    logs: [
      v4Log({ poolId: BUSY_POOL, amount0: 1000n, amount1: -2000n, sqrtPriceX96: 100n, block: 10, tx: 1 }),
      v4Log({ poolId: OTHER_POOL, amount0: 3000n, amount1: -4000n, sqrtPriceX96: 200n, block: 11, tx: 2 }),
    ],
  });
  const res = await readV4Swaps(chain, {
    manager: PM,
    fromBlock: 10,
    toBlock: 20,
    poolsById: poolMapFromDiscovery([{ poolId: BUSY_POOL, currency0: NATIVE, currency1: BUSY_TOKEN, fee: 10000, tickSpacing: 200, hooks: NATIVE, hooked: false }]),
    subject: BUSY_TOKEN,
    sleep: noSleep,
  });

  assert.equal(res.rows.length, 2, "the unmapped swap is still reported");
  const [mapped, unmapped] = res.rows;
  assert.equal(mapped.pool.pairKnown, true);
  assert.equal(mapped.subject.token, BUSY_TOKEN);
  assert.equal(mapped.subject.direction, "sold", "amount1 is negative, so on v4 the swapper paid the subject token");

  // The unmapped one: the swap is real, the pair is UNKNOWN, and it is NOT attributed to the
  // token we asked about. Attributing it would invent a trade; dropping it would understate
  // a window that still claims to be complete.
  assert.equal(unmapped.pool.pairKnown, false);
  assert.equal(unmapped.pool.poolId, OTHER_POOL);
  assert.equal(unmapped.pool.currency0, null);
  assert.equal(unmapped.subject, null);
  assert.equal(unmapped.amount0, 3000n, "everything the log DID say is kept");
  assert.equal(res.unattributed, 1);
  assert.equal(res.complete, true, "a fully-read window with an unattributable row in it is still fully read");
  // The map was handed over WITHOUT asserting it is complete, so the excluded pool is UNKNOWN
  // rather than definitively somebody else's — the conservative default.
  assert.equal(unmapped.pool.pairUnknownReason, "pool_map_incomplete");

  const summary = summariseSwaps(res.rows, { complete: res.complete });
  assert.equal(summary.swaps, 2);
  assert.equal(summary.sold, 1);
  assert.equal(summary.undirected, 1, "the parts add up to the whole");
});

test("with no pool map at all, every v4 swap is UNKNOWN-paired and says which reason", async () => {
  const chain = fakeChain({ logs: [v4Log({ amount0: 1n, amount1: -1n, sqrtPriceX96: 1n, block: 10 })] });
  const res = await readV4Swaps(chain, { manager: PM, fromBlock: 10, toBlock: 20, subject: BUSY_TOKEN, sleep: noSleep });
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].pool.pairKnown, false);
  assert.equal(res.rows[0].pool.pairUnknownReason, "pool_map_unavailable");
  assert.equal(res.rows[0].subject, null);
  assert.equal(res.poolMap, null);
  assert.equal(res.unattributed, 1);
});

test("a v3 swap is decoded per pool and priced from sqrtPriceX96 when the decimals are known", async () => {
  // The real Green Bull pool: token0 = WETH (18), token1 = The Green Bull (18).
  const chain = fakeChain({
    logs: [v3Log({ amount0: 23693153245729870n, amount1: -243038204393310027777732n, sqrtPriceX96: 25054144837504793118641380156n, block: 300, tx: 5 })],
  });
  const res = await readV3Swaps(chain, {
    pools: [{ pool: V3_POOL, token0: WETH, token1: GREENBULL, fee: 10000 }],
    fromBlock: 300,
    toBlock: 400,
    subject: GREENBULL,
    decimals: { [WETH]: 18, [GREENBULL]: 18 },
    sleep: noSleep,
  });

  assert.equal(res.rows.length, 1);
  const row = res.rows[0];
  assert.equal(row.venue, VENUES.V3);
  assert.equal(row.pool.address, V3_POOL);
  assert.equal(row.pool.kind, "address");
  assert.equal(row.fee, 10000);
  // amount1 is NEGATIVE, so on v3 the pool PAID OUT the Green Bull: the trader bought it.
  assert.equal(row.subject.direction, "bought");
  assert.equal(row.subject.isToken0, false);
  assert.equal(row.subject.amountIn, 23693153245729870n, "the trader paid WETH");
  assert.equal(row.subject.amountOut, 243038204393310027777732n);
  assert.equal(row.subject.inCurrency, WETH);
  assert.equal(row.subject.outCurrency, GREENBULL);
  assert.ok(row.subject.price.counterpartyPerSubject > 0, "a price is stated when both decimals are known");
  assert.equal(row.subject.price.basis, "sqrtPriceX96");
  assert.equal(res.complete, true);
});

test("without decimals there is no price — never a raw ratio dressed as one", async () => {
  const chain = fakeChain({ logs: [v3Log({ amount0: 1n, amount1: -1n, sqrtPriceX96: 25054144837504793118641380156n, block: 300 })] });
  const res = await readV3Swaps(chain, {
    pools: [{ pool: V3_POOL, token0: WETH, token1: GREENBULL, fee: 10000 }],
    fromBlock: 300,
    toBlock: 400,
    subject: GREENBULL,
    sleep: noSleep,
  });
  const price = res.rows[0].subject.price;
  assert.equal(price.counterpartyPerSubject, null);
  assert.equal(price.subjectPerCounterparty, null);
  // On this chain a pair can span 18 decimals against 6, so an unadjusted ratio is wrong by
  // 10^12 and looks exactly like a price.
  assert.equal(price.reason, "decimals_unknown");
  assert.ok(res.rows[0].sqrtPriceX96 > 0n, "the exact, decimal-free figures are still there");
  assert.equal(res.rows[0].tick, 161523);
});

test("a v3 pool whose pair the caller could not supply yields unattributed rows, not wrong ones", async () => {
  const chain = fakeChain({ logs: [v3Log({ amount0: 1n, amount1: -1n, sqrtPriceX96: 1n, block: 300 })] });
  const res = await readV3Swaps(chain, { pools: [{ pool: V3_POOL, fee: 10000 }], fromBlock: 300, toBlock: 400, subject: GREENBULL, sleep: noSleep });
  assert.equal(res.rows[0].pool.pairKnown, false);
  assert.equal(res.rows[0].pool.pairUnknownReason, "pool_pair_not_supplied");
  assert.equal(res.rows[0].subject, null);
});

/* =========================== ROUTER VERSUS TRADER ========================== */

test("the sender is labelled a router and is NEVER reported as the trader", async () => {
  const chain = fakeChain({
    logs: [
      v4Log({ amount0: 1000n, amount1: -2000n, sqrtPriceX96: 100n, block: 10, tx: 1 }),
      v4Log({ amount0: -3000n, amount1: 4000n, sqrtPriceX96: 90n, block: 11, tx: 2 }),
    ],
    // The measured shape: one router address for every swap, different originators behind it.
    transactions: {
      [txHash(1)]: { from: TRADER_A, to: ROUTER },
      [txHash(2)]: { from: TRADER_B, to: "0xc41194138e051fc505fef93b3c44dbdb63da64a2" },
    },
  });
  const res = await readV4Swaps(chain, {
    manager: PM,
    fromBlock: 10,
    toBlock: 20,
    poolsById: poolMapFromDiscovery([{ poolId: BUSY_POOL, currency0: NATIVE, currency1: BUSY_TOKEN, fee: 10000, tickSpacing: 200, hooks: NATIVE, hooked: false }]),
    subject: BUSY_TOKEN,
    sleep: noSleep,
  });

  // Before the join: the sender is present and explicitly not the trader.
  for (const row of res.rows) {
    assert.equal(row.sender.address, ROUTER);
    assert.equal(row.sender.isTrader, false);
    assert.equal(row.sender.role, "pool_caller");
    assert.equal(row.trader.address, null, "no trader is claimed until a transaction says so");
  }

  const join = await attachTraders(chain, res.rows);
  assert.equal(join.resolved, 2);
  // Both originators landed, so the wallet counts are exact rather than a floor.
  assert.equal(summariseSwaps(res.rows, { complete: true }).walletsAreLowerBound, false);
  assert.equal(res.rows[0].trader.address, TRADER_A);
  assert.equal(res.rows[0].trader.source, "tx.from");
  assert.equal(res.rows[1].trader.address, TRADER_B);
  // Both rows share ONE sender and have DIFFERENT traders — the exact reason the sender
  // cannot stand in for the wallet.
  assert.notEqual(res.rows[0].trader.address, res.rows[1].trader.address);
  assert.equal(res.rows[0].sender.address, res.rows[1].sender.address);
});

test("a trader lookup that fails or is capped leaves the wallet unknown, never the router", async () => {
  const chain = fakeChain({
    logs: [
      v4Log({ amount0: 1n, amount1: -1n, sqrtPriceX96: 1n, block: 10, tx: 1 }),
      v4Log({ amount0: 1n, amount1: -1n, sqrtPriceX96: 1n, block: 11, tx: 2 }),
    ],
    transactions: { [txHash(2)]: { from: TRADER_B, to: ROUTER } },
  });
  const res = await readV4Swaps(chain, {
    manager: PM,
    fromBlock: 10,
    toBlock: 20,
    subject: BUSY_TOKEN,
    poolsById: poolMapFromDiscovery([{ poolId: BUSY_POOL, currency0: NATIVE, currency1: BUSY_TOKEN, fee: 10000, tickSpacing: 200, hooks: NATIVE, hooked: false }]),
    sleep: noSleep,
  });

  // Cap of one join, newest-first, so tx 2 resolves and tx 1 is never asked about.
  const join = await attachTraders(chain, res.rows, { maxJoins: 1 });
  assert.equal(join.joined, 1);
  assert.equal(join.resolved, 1);
  const [older, newer] = res.rows;
  assert.equal(newer.trader.address, TRADER_B);
  assert.equal(older.trader.address, null);
  assert.equal(older.trader.source, "not_joined");
  assert.notEqual(older.trader.address, ROUTER);
  // A capped join makes the WALLET counts a floor even though the window itself was complete.
  const capped = summariseSwaps(res.rows, { complete: true });
  assert.equal(capped.walletsAreLowerBound, true);

  // A join that was attempted and FAILED is "unread" — a different fact from never asking.
  const failing = fakeChain({ logs: [], transactions: {} });
  const rows = [{ ...older, trader: null }];
  await attachTraders(failing, rows);
  assert.equal(rows[0].trader.address, null);
  assert.equal(rows[0].trader.source, "unread");

  // No client that can join at all.
  const rows2 = [{ ...older, trader: null }];
  await attachTraders({}, rows2);
  assert.equal(rows2[0].trader.source, "no_client");
});

/* ============================== THE WINDOW ================================= */

test("a window wider than the ceiling is chunked, and the chunks tile it exactly", () => {
  const { chunks, truncatedFrom } = blockChunks(1_000_000n, 1_034_000n);
  assert.equal(chunks.length, 3, "34,000 blocks is three chunks at a 15,000 ceiling");
  assert.equal(truncatedFrom, null);
  assert.equal(chunks[0].fromBlock, 1_000_000n);
  assert.equal(chunks.at(-1).toBlock, 1_034_000n);
  for (let i = 1; i < chunks.length; i += 1) {
    assert.equal(chunks[i].fromBlock, chunks[i - 1].toBlock + 1n, "no gap and no overlap between chunks");
  }
  for (const c of chunks) assert.ok(c.toBlock - c.fromBlock + 1n <= BigInt(MAX_LOG_SPAN));
});

test("a window too wide for the chunk cap keeps the RECENT end and reports the rest unread", async () => {
  const span = BigInt(MAX_LOG_SPAN) * BigInt(MAX_WINDOW_CHUNKS) + 5_000n;
  const { chunks, truncatedFrom } = blockChunks(1_000_000n, 1_000_000n + span - 1n);
  assert.equal(chunks.length, MAX_WINDOW_CHUNKS);
  assert.equal(truncatedFrom, 1_000_000n, "the blocks the cap never asked about are named");
  assert.equal(chunks.at(-1).toBlock, 1_000_000n + span - 1n, "the head of the window is what was kept");

  const chain = fakeChain({ logs: [] });
  const res = await readLogWindow(chain, { address: PM, topic0: SWAP_TOPICS[VENUES.V4], fromBlock: 1_000_000n, toBlock: 1_000_000n + span - 1n, sleep: noSleep });
  assert.equal(res.complete, false, "a truncated window is not a complete one");
  assert.equal(res.blocksUnread, 5_000n);
  assert.ok(res.chunks.some((c) => c.reason === "window_truncated"));
});

test("a chunked window reads every chunk in sequence and returns the union of their logs", async () => {
  const logs = [
    v3Log({ amount0: 1n, amount1: -1n, sqrtPriceX96: 1n, block: 1_000_100, tx: 1 }),
    v3Log({ amount0: 2n, amount1: -2n, sqrtPriceX96: 2n, block: 1_016_000, tx: 2 }),
    v3Log({ amount0: 3n, amount1: -3n, sqrtPriceX96: 3n, block: 1_031_000, tx: 3 }),
  ];
  const chain = fakeChain({ logs });
  const res = await readLogWindow(chain, { address: V3_POOL, topic0: SWAP_TOPICS[VENUES.V3], fromBlock: 1_000_000n, toBlock: 1_034_000n, sleep: noSleep });

  assert.equal(chain.calls.length, 3, "three chunks, three calls");
  assert.equal(res.logs.length, 3, "one log from each chunk");
  assert.equal(res.complete, true);
  assert.equal(res.chunksRead, 3);
  assert.equal(res.chunksUnread, 0);
  assert.equal(res.blocksUnread, 0n);
  assert.equal(res.blocksRead, 34_001n);
  // The topic IS sent, because it works on this node and it is what makes a wide filtered
  // query cheap. Correctness does not depend on it — see the next test.
  for (const call of chain.calls) assert.deepEqual(call.topics, [SWAP_TOPICS[VENUES.V3]]);
});

test("the answer is identical when the node ignores the topics filter entirely", async () => {
  // A previous round of work concluded this RPC ignores topics. It does not — viem's getLogs
  // silently drops a raw `topics` option, so the filter was never sent — but a node, proxy or
  // client that DID ignore it must not change any answer. So: a chain that returns every log
  // regardless of the filter, mixed with logs of other events and other venues.
  const ignoringChain = {
    async request({ params }) {
      const [filter] = params;
      const from = BigInt(filter.fromBlock);
      const to = BigInt(filter.toBlock);
      return [
        // Noise the filter would have removed: a ModifyLiquidity log and a v3 Swap sitting
        // in the v4 singleton's stream.
        { address: PM, topics: ["0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec"], data: "0x", blockNumber: "0xa", transactionHash: txHash(9), logIndex: "0x0" },
        v3Log({ pool: PM, amount0: 1n, amount1: -1n, sqrtPriceX96: 1n, block: 10, tx: 8 }),
        v4Log({ amount0: 26470626649044355n, amount1: -19452901164239130734948189n, sqrtPriceX96: 100n, block: 10, tx: 1 }),
      ].filter((l) => {
        const b = BigInt(l.blockNumber);
        return b >= from && b <= to;
      });
    },
  };
  const res = await readV4Swaps(ignoringChain, {
    manager: PM,
    fromBlock: 10,
    toBlock: 20,
    poolsById: poolMapFromDiscovery([{ poolId: BUSY_POOL, currency0: NATIVE, currency1: BUSY_TOKEN, fee: 10000, tickSpacing: 200, hooks: NATIVE, hooked: false }]),
    subject: BUSY_TOKEN,
    sleep: noSleep,
  });
  assert.equal(res.rows.length, 1, "the client-side topic check removed the two non-v4-Swap logs");
  assert.equal(res.rows[0].subject.direction, "sold");
  assert.equal(res.decodeFailures, 0, "a log of another event is not a v4 Swap that failed to decode");
  assert.equal(res.complete, true);
});

test("a chunk the node refuses for its size is SPLIT rather than lost", async () => {
  // The refusal is deterministic — "Missing or invalid parameters." for a range whose result
  // is too big — so re-asking is pure cost and halving is the fix. Live: 16,000 blocks of the
  // PoolManager is 9,629 logs and fine; 17,000 fails instantly.
  const chain = fakeChain({
    logs: [v4Log({ amount0: 1n, amount1: -1n, sqrtPriceX96: 1n, block: 1_007_600, tx: 1 })],
    refuseWiderThan: 10_000,
  });
  const res = await readLogWindow(chain, { address: PM, topic0: SWAP_TOPICS[VENUES.V4], fromBlock: 1_000_000n, toBlock: 1_014_999n, sleep: noSleep });

  assert.equal(res.complete, true, "the window was fully read, just in smaller pieces");
  assert.equal(res.blocksUnread, 0n);
  assert.equal(res.logs.length, 1);
  const halves = chain.calls.filter((c) => c.to - c.from + 1n === 7_500n);
  assert.equal(halves.length, 2, "the refused 15,000-block chunk became two 7,500-block ones");
});

test("a refusal that splitting cannot fix ends as a labelled hole, not as an empty result", async () => {
  // Every sub-range refuses, all the way to the floor. The honest outcome is unread blocks.
  const chain = {
    async request() {
      const error = new Error("Missing or invalid parameters.");
      error.code = -32602;
      throw error;
    },
  };
  const res = await readLogWindow(chain, { address: PM, topic0: SWAP_TOPICS[VENUES.V4], fromBlock: 1_000_000n, toBlock: 1_002_000n, sleep: noSleep });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "window_unread");
  assert.equal(res.complete, false);
  assert.equal(res.blocksRead, 0n);
  assert.equal(res.blocksUnread, 2_001n, "every block is accounted for as unread");
  assert.ok(res.chunks.every((c) => c.status === "unread"));
  assert.ok(res.chunks.some((c) => c.reason === "range_refused"));
  // The floor exists so a refusal this module cannot fix does not halve its way through the
  // whole budget proving it — and no sub-range is ever produced narrower than that floor.
  for (const c of res.chunks) assert.ok(c.blocks >= BigInt(MIN_LOG_SPAN), `chunk of ${c.blocks} blocks is under the floor`);
});

/* ======================== THE LOWER BOUND, LABELLED ======================== */

test("an unread chunk makes every count a LOWER BOUND and removes the licence to say 'none'", async () => {
  const logs = [
    // Two sells in the chunk that lands.
    v4Log({ amount0: 1n, amount1: -1000n, sqrtPriceX96: 100n, block: 1_031_000, tx: 1 }),
    v4Log({ amount0: 2n, amount1: -2000n, sqrtPriceX96: 101n, block: 1_032_000, tx: 2 }),
    // A third swap sits in the chunk that fails, and must NOT be counted or implied absent.
    v4Log({ amount0: -5n, amount1: 5000n, sqrtPriceX96: 99n, block: 1_000_500, tx: 3 }),
  ];
  const chain = fakeChain({ logs, failFrom: new Set([1_000_000n]) });
  const res = await readV4Swaps(chain, {
    manager: PM,
    fromBlock: 1_000_000,
    toBlock: 1_034_000,
    poolsById: poolMapFromDiscovery([{ poolId: BUSY_POOL, currency0: NATIVE, currency1: BUSY_TOKEN, fee: 10000, tickSpacing: 200, hooks: NATIVE, hooked: false }]),
    subject: BUSY_TOKEN,
    sleep: noSleep,
  });

  assert.equal(res.ok, true, "the chunks that landed are real swaps and are reported");
  assert.equal(res.rows.length, 2);
  assert.equal(res.complete, false);
  assert.equal(res.reason, "window_partial");
  // The chunks are built backwards from the head, so the OLDEST is the ragged one: 34,001
  // blocks is 15,000 + 15,000 + 4,001, and the 4,001-block chunk is the one that failed.
  assert.equal(res.window.blocksUnread, 4_001n);
  assert.equal(res.window.chunksUnread, 1);

  const summary = summariseSwaps(res.rows, { complete: res.complete });
  assert.equal(summary.sold, 2);
  assert.equal(summary.atLeast, true, "the counts are floors");
  assert.equal(summary.canSayNone, false, "and no absence may be claimed from them");

  const notice = swapNotice(summary, res.window);
  assert.match(notice, /LOWER BOUND/);
  assert.match(notice, /at least 2 sells/);
  assert.match(notice, /4001 of the 34001 blocks/);
  assert.match(notice, /Do NOT say nothing traded/);
});

test("a fully-read window with an UNNAMEABLE pair in it still cannot claim an absence", async () => {
  // The subtle one, and it is not hypothetical: the live PoolManager window holds ~2,800 swaps
  // across every pool on the chain. If the map that says which of them belong to this token is
  // missing, the window is complete and the answer is still unknown — any of those rows could
  // be the subject's. `complete` alone would license "nobody sold", which is why canSayNone is
  // a narrower field than complete rather than an alias for it.
  const chain = fakeChain({
    logs: [
      v4Log({ poolId: OTHER_POOL, amount0: 1n, amount1: -1n, sqrtPriceX96: 1n, block: 10, tx: 1 }),
      v4Log({ poolId: OTHER_POOL, amount0: 2n, amount1: -2n, sqrtPriceX96: 2n, block: 11, tx: 2 }),
    ],
  });
  const noMap = await readV4Swaps(chain, { manager: PM, fromBlock: 10, toBlock: 20, subject: BUSY_TOKEN, sleep: noSleep });
  assert.equal(noMap.complete, true, "every block was read");
  const blind = summariseSwaps(noMap.rows, { complete: noMap.complete });
  assert.equal(blind.sold, 0);
  assert.equal(blind.undirectedUnknownPair, 2);
  assert.equal(blind.canSayNone, false, "a zero over unnameable pools is a shrug, not a measurement");
  assert.match(swapNotice(blind, noMap.window), /could NOT be identified/);
  assert.match(swapNotice(blind, noMap.window), /must not say nothing traded/);

  // With a COMPLETE map the identical rows become definitively other tokens' pools, and the
  // subject's zero becomes a real finding.
  const withMap = await readV4Swaps(chain, {
    manager: PM,
    fromBlock: 10,
    toBlock: 20,
    subject: BUSY_TOKEN,
    poolsById: poolMapFromDiscovery([{ poolId: BUSY_POOL, currency0: NATIVE, currency1: BUSY_TOKEN, fee: 10000, tickSpacing: 200, hooks: NATIVE, hooked: false }]),
    poolMapComplete: true,
    sleep: noSleep,
  });
  const known = summariseSwaps(withMap.rows, { complete: withMap.complete });
  assert.equal(known.undirected, 2);
  assert.equal(known.undirectedUnknownPair, 0, "discovery answered from the log index, so these are somebody else's");
  assert.equal(known.canSayNone, true);
  assert.equal(swapNotice(known, withMap.window), null);

  // AND THE DEFAULT IS THE CONSERVATIVE ONE. The same map without the completeness assertion
  // must not grant the same licence — a live run handed over an EMPTY map from an `unread`
  // discovery and would otherwise have labelled 4,315 other-pool swaps as definitively not
  // this token's, on the strength of a lookup that never happened.
  const unasserted = await readV4Swaps(chain, {
    manager: PM,
    fromBlock: 10,
    toBlock: 20,
    subject: BUSY_TOKEN,
    poolsById: poolMapFromDiscovery([]),
    sleep: noSleep,
  });
  const cautious = summariseSwaps(unasserted.rows, { complete: unasserted.complete });
  assert.equal(unasserted.rows[0].pool.pairUnknownReason, "pool_map_incomplete");
  assert.equal(cautious.undirectedUnknownPair, 2);
  assert.equal(cautious.canSayNone, false);
});

test("the originator join is bounded by its own clock as well as by its cap", async () => {
  // Measured: one eth_getTransaction on this node is ~400ms and a default window holds ~2,600
  // distinct transactions. Without a clock of its own the join would spend the whole request.
  let clock = 0;
  const chain = {
    async getTransaction({ hash }) {
      clock += 400;
      return { from: TRADER_A, to: ROUTER };
    },
  };
  const rows = [1, 2, 3, 4, 5, 6].map((n) => ({
    txHash: txHash(n),
    blockNumber: BigInt(n),
    logIndex: 0,
    sender: { address: ROUTER, isTrader: false },
  }));
  const join = await attachTraders(chain, rows, { now: () => clock, joinBudgetMs: 1_000, maxJoins: 100 });
  assert.equal(join.joined, 3, "three joins at 400ms fit inside a 1s ceiling; the fourth is not started");
  assert.equal(join.skippedForTime, true);
  const unjoined = rows.filter((r) => r.trader.address === null);
  assert.equal(unjoined.length, 3);
  for (const r of unjoined) {
    assert.equal(r.trader.source, "no_time");
    assert.notEqual(r.trader.address, ROUTER, "running out of time never promotes the router to trader");
  }
});

test("tokenSwapFlow joins only the rows that are this token's", async () => {
  // The live defect: 2,758 of 2,758 rows in the window belonged to other tokens' pools, and
  // joining them spent 9.7s naming wallets no caller could use.
  let joins = 0;
  const chain = fakeChain({
    logs: [
      v4Log({ poolId: BUSY_POOL, amount0: 1n, amount1: -1n, sqrtPriceX96: 1n, block: 23_310_000, tx: 1 }),
      v4Log({ poolId: OTHER_POOL, amount0: 2n, amount1: -2n, sqrtPriceX96: 2n, block: 23_310_001, tx: 2 }),
      v4Log({ poolId: OTHER_POOL, amount0: 3n, amount1: -3n, sqrtPriceX96: 3n, block: 23_310_002, tx: 3 }),
    ],
    transactions: { [txHash(1)]: { from: TRADER_A, to: ROUTER } },
    head: 23_310_099n,
  });
  const counting = {
    ...chain,
    async getTransaction(args) {
      joins += 1;
      return chain.getTransaction(args);
    },
  };
  const res = await tokenSwapFlow(BUSY_TOKEN, {
    client: counting,
    manager: PM,
    discovery: { status: "found", pools: [{ poolId: BUSY_POOL, currency0: NATIVE, currency1: BUSY_TOKEN, fee: 10000, tickSpacing: 200, hooks: NATIVE, hooked: false }] },
    sleep: noSleep,
  });
  assert.equal(joins, 1, "one join for the one row that is this token's, none for the other two");
  const v4 = res.venues[VENUES.V4];
  assert.equal(v4.rows.length, 3, "the other pools' swaps are still reported");
  // The SUMMARY, though, counts only this token's — a "swaps: 3" beside "sold: 1" would read
  // as two uncategorised trades of this token when they are two trades of other tokens.
  assert.equal(v4.summary.swaps, 1);
  assert.equal(v4.summary.sold, 1);
  assert.equal(v4.unattributed, 2, "and the excluded rows are still counted, on the venue result");
  // One join landed and it was the only row that needed one, so the wallet count is exact.
  assert.equal(v4.summary.tradersUnknown, 0);
  assert.equal(v4.summary.walletsAreLowerBound, false);
  assert.equal(v4.rows.find((r) => r.subject).trader.address, TRADER_A);
  for (const row of v4.rows.filter((r) => !r.subject)) {
    assert.equal(row.trader.address, null);
    assert.notEqual(row.trader.address, row.sender.address);
  }
});

test("a window that WAS fully read may say nobody sold — and a zero from it is a finding", async () => {
  // The live case: The Green Bull's v3 pool saw 0 swaps in the last 15,000 blocks and 100 in
  // the last 2,000,000. The first of those is a real, sayable absence.
  const chain = fakeChain({ logs: [] });
  const res = await readV3Swaps(chain, { pools: [{ pool: V3_POOL, token0: WETH, token1: GREENBULL, fee: 10000 }], fromBlock: 1_000_000, toBlock: 1_005_600, subject: GREENBULL, sleep: noSleep });

  assert.equal(res.ok, true);
  assert.equal(res.rows.length, 0);
  assert.equal(res.complete, true);
  const summary = summariseSwaps(res.rows, { complete: res.complete });
  assert.equal(summary.sold, 0);
  assert.equal(summary.canSayNone, true, "every block was read, so 'nobody sold' is a measurement");
  assert.equal(summary.atLeast, false);
  assert.equal(swapNotice(summary, res.windows[0]), null, "nothing to caveat");
});

test("a fetch that fails everywhere is UNKNOWN, never 'no swaps'", async () => {
  const chain = {
    async request() {
      throw new Error("log query timed out");
    },
  };
  const res = await readV4Swaps(chain, { manager: PM, fromBlock: 1_000_000, toBlock: 1_005_600, subject: BUSY_TOKEN, sleep: noSleep });

  assert.equal(res.ok, false);
  assert.equal(res.reason, "window_unread");
  assert.equal(res.rows.length, 0);
  assert.equal(res.complete, false);
  // The sentence has to say outage, and it must not be readable as a quiet market.
  assert.match(res.detail, /UNKNOWN/);
  assert.match(res.detail, /outage, not a quiet market/);

  const summary = summariseSwaps(res.rows, { complete: res.complete });
  assert.equal(summary.swaps, 0);
  assert.equal(summary.canSayNone, false, "zero swaps read is not zero swaps");
  assert.match(swapNotice(summary, null), /LOWER BOUND/);
});

test("a transient failure is retried and recovered — the measured ~10% blip", async () => {
  let attempts = 0;
  const chain = {
    async request({ params }) {
      attempts += 1;
      if (attempts === 1) throw new Error("log query timed out");
      const [filter] = params;
      const from = BigInt(filter.fromBlock);
      const to = BigInt(filter.toBlock);
      return [v4Log({ amount0: 1n, amount1: -1n, sqrtPriceX96: 1n, block: 1_000_100, tx: 1 })].filter((l) => {
        const b = BigInt(l.blockNumber);
        return b >= from && b <= to;
      });
    },
  };
  const res = await readLogWindow(chain, { address: PM, topic0: SWAP_TOPICS[VENUES.V4], fromBlock: 1_000_000n, toBlock: 1_005_600n, sleep: noSleep });
  assert.equal(attempts, 2, "asked again rather than degrading to a lower bound");
  assert.equal(res.complete, true);
  assert.equal(res.logs.length, 1);
});

/* ============================== THE ENTRY POINT ============================ */

test("tokenSwapFlow keeps the two venues apart and never blends their completeness", async () => {
  const chain = fakeChain({
    logs: [
      v4Log({ amount0: 26470626649044355n, amount1: -19452901164239130734948189n, sqrtPriceX96: 100n, block: 23_310_000, tx: 1 }),
      v3Log({ amount0: 23693153245729870n, amount1: -243038204393310027777732n, sqrtPriceX96: 25054144837504793118641380156n, block: 23_310_001, tx: 2 }),
    ],
    transactions: { [txHash(1)]: { from: TRADER_A, to: ROUTER }, [txHash(2)]: { from: V3_TRADER, to: V3_RECIPIENT } },
    head: 23_310_099n,
  });

  const res = await tokenSwapFlow(BUSY_TOKEN, {
    client: chain,
    manager: PM,
    // The map comes from lib/dex-v4.js discovery and is handed in, exactly as
    // lib/dex-price.js hands v4MarketData its own discovery to keep the log queries away
    // from the eth_call sweep.
    discovery: { status: "found", pools: [{ poolId: BUSY_POOL, currency0: NATIVE, currency1: BUSY_TOKEN, fee: 10000, tickSpacing: 200, hooks: NATIVE, hooked: false }] },
    v3Pools: [{ pool: V3_POOL, token0: WETH, token1: BUSY_TOKEN, fee: 10000 }],
    decimals: { [NATIVE]: 18, [BUSY_TOKEN]: 18, [WETH]: 18 },
    sleep: noSleep,
  });

  assert.equal(res.ok, true);
  assert.equal(res.window.blocks, BigInt(DEFAULT_WINDOW_BLOCKS));
  assert.equal(res.signConvention[VENUES.V4], "swapper");
  assert.equal(res.signConvention[VENUES.V3], "pool");

  const v4 = res.venues[VENUES.V4];
  const v3 = res.venues[VENUES.V3];
  assert.equal(v4.summary.sold, 1, "on v4 a negative subject amount is the swapper paying it in");
  assert.equal(v3.summary.bought, 1, "on v3 a negative subject amount is the pool paying it out");
  // Same sign of amount1, opposite trade. Two separate summaries, never one total.
  assert.ok(res.venues[VENUES.V4].summary !== res.venues[VENUES.V3].summary);
  assert.equal(v4.rows[0].trader.address, TRADER_A);
  assert.equal(v3.rows[0].trader.address, V3_TRADER);
  assert.notEqual(v3.rows[0].trader.address, v3.rows[0].sender.address);
});

test("tokenSwapFlow with unread v4 discovery reads no logs and reports UNKNOWN", async () => {
  // Without the map every swap in the singleton is indistinguishable between this token's
  // pool and any other's, so the window is not worth fetching and nothing may be concluded.
  const chain = fakeChain({ logs: [v4Log({ amount0: 1n, amount1: -1n, sqrtPriceX96: 1n, block: 23_310_000 })] });
  const res = await tokenSwapFlow(BUSY_TOKEN, {
    client: chain,
    manager: PM,
    discovery: { status: "unread", pools: [], reason: "discovery_failed" },
    sleep: noSleep,
  });
  const v4 = res.venues[VENUES.V4];
  assert.equal(v4.ok, false);
  assert.equal(v4.reason, "discovery_failed");
  assert.equal(v4.complete, false);
  assert.equal(v4.summary.canSayNone, false);
  assert.match(v4.detail, /UNKNOWN/);
  assert.equal(chain.calls.length, 0, "no logs were fetched, because none could have been attributed");

  // And the v3 side, with no pools supplied, is "we did not look" — not "it did not trade".
  assert.equal(res.venues[VENUES.V3].reason, "no_pools");
  assert.equal(res.venues[VENUES.V3].summary.canSayNone, false);
  assert.match(SWAP_REASONS.no_pools, /Nothing here says the token did not trade elsewhere/);
});

test("a declined venue has the same shape as a read one, so no caller can compute a NaN", async () => {
  // Measured on a live run: `rows.length - unattributed` printed NaN for a venue that had
  // declined, and a NaN sitting beside real figures is a number nobody can challenge.
  const chain = fakeChain({ logs: [] });
  const res = await tokenSwapFlow(BUSY_TOKEN, {
    client: chain,
    manager: PM,
    discovery: { status: "unread", pools: [] },
    sleep: noSleep,
  });
  for (const venue of [VENUES.V4, VENUES.V3]) {
    const v = res.venues[venue];
    assert.equal(v.ok, false);
    assert.deepEqual(v.rows, []);
    assert.equal(v.unattributed, 0);
    assert.equal(v.decodeFailures, 0);
    assert.equal(v.rowsCapped, false);
    assert.equal(v.complete, false);
    assert.ok(Number.isFinite(v.rows.length - v.unattributed), "the arithmetic a caller does is finite");
    assert.equal(typeof v.detail, "string");
  }
  assert.equal(res.venues[VENUES.V4].discovery.status, "unread");
});

test("v4 discovery is bounded, so a doomed lookup cannot eat the request", async () => {
  // Measured: readV4Pools is healthy alone (found in 1.0-2.4s) but behind a window read it
  // lost and spent 15.9s on four attempts and their backoff — against a 24s request budget.
  // The ceiling is imported from lib/dex-v4.js rather than re-chosen, so the two callers of
  // readV4Pools cannot drift apart.
  // Real milliseconds, kept small: the assertion needs the read to outlast the ceiling by a
  // wide margin, not by a long one. 15ms against 150ms is a 10x margin and a fifth of a second.
  const SLOW_MS = 150;
  let getLogsCalls = 0;
  const chain = {
    ...fakeChain({ logs: [] }),
    async getLogs() {
      getLogsCalls += 1;
      await new Promise((r) => setTimeout(r, SLOW_MS));
      return [];
    },
    async getBlockNumber() {
      return 23_310_099n;
    },
  };
  const started = Date.now();
  const res = await tokenSwapFlow(BUSY_TOKEN, { client: chain, manager: PM, discoveryBudgetMs: 15, sleep: noSleep });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < SLOW_MS, `the ceiling cut the wait at ${elapsed}ms rather than waiting ${SLOW_MS}ms`);
  const v4 = res.venues[VENUES.V4];
  assert.equal(v4.reason, "discovery_failed");
  assert.equal(v4.complete, false);
  assert.equal(v4.summary.canSayNone, false, "a discovery that timed out licenses no absence");
  assert.match(v4.detail, /UNKNOWN/);
  // THE LOSING READ IS NOT CANCELLED — it keeps going and warms the shared cache for the next
  // lookup, the same bargain lib/dex-price.js v4Discover strikes. Waited out here so the test
  // does not leave it pending.
  await new Promise((r) => setTimeout(r, SLOW_MS * 4));
  assert.ok(getLogsCalls >= 1, "the underlying discovery really was started");
});

test("bad inputs are refused as caller faults, not as absences", async () => {
  assert.equal((await tokenSwapFlow("not-an-address", { client: fakeChain({}) })).reason, "bad_address");
  assert.equal((await tokenSwapFlow(BUSY_TOKEN, { client: null })).reason, "no_client");
  assert.equal((await readLogWindow(fakeChain({}), { address: PM, fromBlock: 100, toBlock: 50 })).reason, "bad_window");
  assert.equal((await readLogWindow({}, { address: PM, fromBlock: 1, toBlock: 2 })).reason, "no_client");
  for (const reason of ["no_client", "bad_window", "window_unread", "pool_map_unavailable"]) {
    assert.equal(typeof SWAP_REASONS[reason], "string");
  }
});

test("the block/second conversion is rounded up and refuses junk", () => {
  assert.equal(BLOCKS_PER_SECOND, 9.4);
  // Ten minutes at the measured rate, which is the default window and one getLogs call.
  assert.equal(blocksForSeconds(600), 5_640);
  assert.ok(DEFAULT_WINDOW_BLOCKS <= MAX_LOG_SPAN, "the default window must fit in one call");
  assert.equal(blocksForSeconds(0), null);
  assert.equal(blocksForSeconds("soon"), null);
});
