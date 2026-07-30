// Tests for lib/swap-evidence.js — the three answers built on the swap layer, and for the
// catalogue wiring that lets the model reach them.
//
// THREE DEFECT CLASSES ARE BEING DEFENDED AGAINST HERE, and they are not the same shape.
//
//  1. AN UNREAD WINDOW READING AS A QUIET MARKET. "Nobody is selling" is not a sentence a
//     block range can support; "no sell was observed in the 5,640 blocks read" is. So every
//     test that removes a chunk asserts canSayNone false AND that no observedNone sentence
//     is produced, and the complete-window tests assert the opposite pair. A zero from
//     blocks nobody read is the worst figure this product can print.
//  2. A ROUTER PRINTED AS A TRADER. Measured live, ONE router address was behind 212 of 213
//     swaps of one token; naming it as the seller would tell a holder that one contract is
//     dumping their bag. Rows that were not joined must carry a null trader and a reason,
//     never the sender.
//  3. A MEASUREMENT HARDENING INTO AN INTENT CLAIM. Concentration is countable and wash
//     trading is not, so the refusal lives in the evidence itself and is asserted here —
//     including the half that is easy to drop, that the pattern's ABSENCE proves nothing.
//
// Entirely offline. The chain is a fake object with no network, the logs are built with
// viem's real ABI encoder so the decoders run against the same bytes a node sends, and the
// two expensive discovery legs are injected: `manager` is supplied so the PoolManager check
// never runs, and `v3Pools` is supplied so the ~170-call eth_call sweep never runs.
// Run with: npm test
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters } from "viem";
import { resetIndexerCache } from "../lib/indexer-cache.js";
import { SWAP_TOPICS, VENUES } from "../lib/swap-log.js";
import {
  TOOL_NAMES,
  TOOL_SCHEMAS,
  coerceRecentTradesArgs,
  coerceSwapDetailArgs,
  coerceVolumeArgs,
  dispatchTool,
  toolSubject,
} from "../lib/ask-tools.js";
import { stepForTool, PHRASE_STEPS, phrasesFor, progressLabel } from "../lib/thinking-phrases.js";
import {
  DEFAULT_TRADE_MINUTES,
  MAX_TRADE_MINUTES,
  SWAP_NOTES,
  V4_DYNAMIC_FEE_FLAG,
  curatedForJoin,
  feeDisplayOf,
  feePercent,
  joinCapFor,
  priceMoveBps,
  realVolume,
  recentTrades,
  roundTripShapes,
  swapDetail,
  tallyTraders,
  tradeRow,
  v3ChunksFor,
  volumeShape,
} from "../lib/swap-evidence.js";

beforeEach(() => resetIndexerCache());
afterEach(() => resetIndexerCache());

/* -------------------------------- the fixtures ---------------------------- */

const PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const NATIVE = "0x0000000000000000000000000000000000000000";
// A real busy v4 pool of this chain, its token, and the router every swap went through.
const POOL = "0xb9948c59b1f7c4937a61862ff21ec26b75bda3af8ac9fe5d41455a8533e9dcf4";
const TOKEN = "0xa01a9b43590bbdced87cc5f224b18f51da107c20";
const OTHER_POOL = "0x2134886a5763c5daef0a96d3d90e2200547479c1a4e51228df38d78def12b39f";
const ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904";
const TRADER_A = "0x4e40ceacc9d16dad54f90daffd3a7291cacc0884";
const TRADER_B = "0xc8abe77da874e049eed85eedacbc200a07c515d1";

// The known-good v3 pool: token0 = WETH, token1 = The Green Bull, fee 10000.
const V3_POOL = "0x8f450b8ee34f07681b68bbb97729fcd4e8778417";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const GREENBULL = "0x31be8f7485e36928c9de86566c62da82d4b6bf81";
const V3_ROUTER = "0x2a7f3d7486641c77600b9b9256132755c8aebb4f";
const V3_RECIPIENT = "0xe58b3089df6667fbf99b75595a1671baf6797d6d";

const HEAD = 23_355_497n;
const ETH_USD = 1924.87;

const pad = (address) => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
const txHash = (n) => `0x${String(n).padStart(64, "e")}`;
const noSleep = async () => {};

/** A v4 Swap log, encoded exactly as the PoolManager emits one. */
function v4Log({
  poolId = POOL,
  sender = ROUTER,
  amount0,
  amount1,
  sqrtPriceX96 = 2_032_399_047_296_026_740_068_306_916_964_461n,
  liquidity = 10n ** 20n,
  tick = 204287,
  fee = 10000,
  block,
  logIndex = 0,
  tx = 1,
} = {}) {
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
function v3Log({
  pool = V3_POOL,
  sender = V3_ROUTER,
  recipient = V3_RECIPIENT,
  amount0,
  amount1,
  sqrtPriceX96 = 1_140_000_000_000_000_000_000_000_000_000n,
  liquidity = 36_819_258_015_569_838_458_222n,
  tick = 161523,
  block,
  logIndex = 0,
  tx = 1,
} = {}) {
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
 * A fake node.
 *
 * `request` is what the window reader prefers (it is the only way to send a topics filter),
 * `getLogs` is what v4 discovery uses through viem's event/args encoding, and `readContract`
 * answers the three things this module ever asks a contract: decimals, symbol and balanceOf.
 */
function fakeChain({
  logs = [],
  pools = [{ poolId: POOL, currency0: NATIVE, currency1: TOKEN, fee: 10000, tickSpacing: 200, hooks: NATIVE }],
  failFrom = new Set(),
  transactions = {},
  receipts = {},
  decimals = { [TOKEN]: 18, [NATIVE]: 18, [GREENBULL]: 18, [WETH]: 18 },
  symbols = { [TOKEN]: "JUG", [GREENBULL]: "GBULL", [WETH]: "WETH" },
  balances = {},
  head = HEAD,
  discoveryFails = false,
} = {}) {
  const calls = { request: [], readContract: [], getLogs: [] };
  return {
    calls,
    async request({ method, params }) {
      if (method !== "eth_getLogs") throw new Error(`unexpected method ${method}`);
      const [filter] = params;
      const from = BigInt(filter.fromBlock);
      const to = BigInt(filter.toBlock);
      calls.request.push({ address: filter.address, from, to, topics: filter.topics ?? null });
      if (failFrom.has(from)) throw new Error("log query timed out");
      const [topic0, topic1] = filter.topics ?? [];
      return logs.filter((l) => {
        const block = BigInt(l.blockNumber);
        if (block < from || block > to) return false;
        if (l.address.toLowerCase() !== String(filter.address).toLowerCase()) return false;
        if (topic0 && l.topics[0] !== topic0) return false;
        return !topic1 || l.topics[1] === topic1;
      });
    },
    async getLogs({ args }) {
      calls.getLogs.push(args);
      if (discoveryFails) throw new Error("discovery query failed");
      // Initialize discovery: by currency for readV4Pools, by id for one pool's key.
      return pools
        .filter((p) => {
          if (args?.id) return p.poolId === args.id;
          if (args?.currency0) return p.currency0 === args.currency0.toLowerCase();
          if (args?.currency1) return p.currency1 === args.currency1.toLowerCase();
          return true;
        })
        .map((p) => ({ args: { ...p, id: p.poolId }, blockNumber: 23_000_000n }));
    },
    async readContract({ address, functionName, args }) {
      calls.readContract.push({ address, functionName });
      const key = String(address).toLowerCase();
      if (functionName === "decimals") {
        if (decimals[key] === undefined) throw new Error("no decimals()");
        return decimals[key];
      }
      if (functionName === "symbol") {
        if (symbols[key] === undefined) throw new Error("no symbol()");
        return symbols[key];
      }
      if (functionName === "balanceOf") {
        const held = balances[String(args?.[0]).toLowerCase()];
        if (held === undefined) throw new Error("balanceOf reverted");
        return held;
      }
      if (functionName === "token0") return WETH;
      if (functionName === "token1") return GREENBULL;
      if (functionName === "fee") return 10000;
      throw new Error(`unexpected call ${functionName}`);
    },
    async getTransaction({ hash }) {
      const tx = transactions[hash];
      if (!tx) throw new Error("transaction not found");
      return tx;
    },
    async getTransactionReceipt({ hash }) {
      const r = receipts[hash];
      if (!r) throw new Error("receipt not found");
      return r;
    },
    async getBlockNumber() {
      return head;
    },
  };
}

/**
 * The indexer seam.
 *
 * ALL FOUR ENDPOINTS ARE STUBBED, not just the one an address-shaped query reaches. The
 * resolver seam falls back to the real Blockscout client for anything it is not given, so a
 * test that passed only getToken and then asked about a TICKER made a live network call —
 * caught by its own runtime, at 10.7 seconds for one assertion.
 */
function fakeCalls({ token = TOKEN, symbol = "JUG", decimals = 18, fail = false } = {}) {
  return {
    async getToken(address) {
      if (fail) throw new Error("indexer down");
      assert.equal(String(address).toLowerCase(), token);
      return { name: "Juggernaut", symbol, decimals: String(decimals), total_supply: "1000000000000000000000000000" };
    },
    snapshotMatch: () => null,
    async resolveSymbol() {
      return { ok: false, reason: 'No token matching "not-an-address" was found on Robinhood Chain.' };
    },
    // Non-empty, so an unresolvable ticker reads as "no such token" rather than as an outage.
    async listStockTokens() {
      return [{ symbol: "NVDA", address: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec" }];
    },
  };
}

/** The options every offline run shares: no discovery, no clock, no network. */
function offline(extra = {}) {
  return { calls: fakeCalls(), ethUsd: ETH_USD, manager: PM, v3Pools: [], sleep: noSleep, ...extra };
}

/** A window of real-shaped v4 swaps of TOKEN against native ETH. */
function busyWindow() {
  const base = Number(HEAD) - 400;
  return [
    // Two sells and two buys, sizes deliberately unequal so the ranking is testable.
    v4Log({ amount0: 148_889_971_264_126_682n, amount1: -13_650_742_242_722_904_540_099_809n, block: base, tx: 1 }),
    v4Log({ amount0: -24_750_000_000_000_000n, amount1: 2_272_544_786_613_256_784_986_775n, block: base + 10, tx: 2 }),
    v4Log({ amount0: 24_118_406_500_383_553n, amount1: -2_259_363_335_703_561_184_675_286n, block: base + 20, tx: 3 }),
    v4Log({ amount0: -173_250_000_000_000_000n, amount1: 15_505_738_977_861_302_678_738_373n, block: base + 30, tx: 4 }),
  ];
}

/* ============================== the pure cores ============================= */

test("a fee is read as the rate it is, and a missing fee is never 0%", () => {
  // 1%, and the one everybody would guess wrong: 998,114 hundred-thousandths is 99.81%, on a
  // real trade measured live. There is no tier set on this chain.
  assert.equal(feePercent(10000), 1);
  assert.equal(feeDisplayOf(10000), "1%");
  assert.equal(feeDisplayOf(998114), "99.8114%");
  assert.equal(feeDisplayOf(106468), "10.6468%");
  assert.equal(feeDisplayOf(252), "0.0252%");
  assert.equal(feeDisplayOf(0), "0%");
  // EXACT, NOT ROUNDED, and this pair is why: measured live, a pool declared 990,000 and
  // charged 990,001 on the swap. At two decimals both render "99%", so the result would say
  // the two figures differ while printing them identically.
  assert.notEqual(feeDisplayOf(990000), feeDisplayOf(990001));
  assert.equal(feeDisplayOf(990001), "99.0001%");

  // A v3 Swap event carries NO fee. Number(null) is 0, so the naive coercion would print a
  // free trade nobody had.
  for (const missing of [null, undefined, "", true]) {
    assert.equal(feePercent(missing), null, `${String(missing)} is not a fee of zero`);
    assert.equal(feeDisplayOf(missing), null);
  }
});

test("the v4 dynamic-fee flag is reported as a flag, never as a 838% rate", () => {
  // 0x800000 declared at Initialize means the hook sets the fee per swap. Verified live: a
  // pool declaring it charged 16,000 on every swap in a window.
  assert.equal(V4_DYNAMIC_FEE_FLAG, 0x800000);
  assert.equal(feePercent(V4_DYNAMIC_FEE_FLAG), null);
  assert.match(feeDisplayOf(V4_DYNAMIC_FEE_FLAG), /dynamic/);
  assert.doesNotMatch(feeDisplayOf(V4_DYNAMIC_FEE_FLAG), /838/);
});

test("a price move is computed from the sqrt ratio and inverts for the other token", () => {
  // Two real consecutive sqrtPriceX96 readings from one pool: 8671513068283828063453578781826200
  // then 8669982178337753437921448110331278. token0 got cheaper by ~35 bps.
  const before = 8_671_513_068_283_828_063_453_578_781_826_200n;
  const after = 8_669_982_178_337_753_437_921_448_110_331_278n;
  const t0 = priceMoveBps(before, after, true);
  const t1 = priceMoveBps(before, after, false);
  assert.ok(t0 < 0 && t0 > -50, `token0 fell a little, got ${t0}`);
  assert.ok(t1 > 0 && t1 < 50, `token1 rose a little, got ${t1}`);
  // Not exact negatives of each other — a ratio's inverse is not its negation — but close at
  // this size, and always opposite in sign.
  assert.equal(Math.sign(t0), -Math.sign(t1));

  // A MEASURED move too small to show at two decimals is not a move of zero. Two readings a
  // hair apart: the figure survives rather than rounding away, which is what a large trade
  // against a deep pool actually looks like.
  const tiny = priceMoveBps(10n ** 30n, 10n ** 30n + 10n ** 24n, true);
  assert.ok(tiny > 0 && tiny < 0.05, `a hair's move stays non-zero, got ${tiny}`);

  // Junk is unknown, never a move of zero.
  assert.equal(priceMoveBps(0n, after, true), null);
  assert.equal(priceMoveBps(before, 0n, true), null);
  assert.equal(priceMoveBps(null, after, true), null);
});

test("the join cap and the v3 window shrink with the clock instead of overrunning it", () => {
  // No budget open — a script or a test — buys the full allowance.
  assert.equal(joinCapFor(Infinity), 8);
  assert.equal(v3ChunksFor(Infinity), 8);
  // ~400ms per join, measured: four seconds is eight, one second is none worth starting.
  assert.equal(joinCapFor(4000), 8);
  assert.equal(joinCapFor(2500), 5);
  assert.equal(joinCapFor(900), 0);
  // The v3 read always gets at least one chunk: a narrow read that completes beats none.
  assert.equal(v3ChunksFor(1000), 1);
  assert.ok(v3ChunksFor(6000) >= 1 && v3ChunksFor(6000) <= 8);
});

test("the curated join set holds at most `limit` transactions and leads with the biggest sells", () => {
  const rows = [
    fakeRow({ direction: "sold", raw: 5n * 10n ** 18n, block: 10, tx: "0xa" }),
    fakeRow({ direction: "sold", raw: 900n * 10n ** 18n, block: 11, tx: "0xb" }),
    fakeRow({ direction: "bought", raw: 700n * 10n ** 18n, block: 12, tx: "0xc" }),
    fakeRow({ direction: "bought", raw: 1n * 10n ** 18n, block: 13, tx: "0xd" }),
  ];
  const picked = curatedForJoin(rows, TOKEN, 18, 2);
  const hashes = new Set(picked.map((r) => r.txHash));
  // THE CAP IS ON DISTINCT TRANSACTIONS, and it has to be: attachTraders takes hashes
  // newest-first out of whatever list it is given, so a longer list would spend the joins on
  // the newest rows and silently discard this ranking.
  assert.equal(hashes.size, 2);
  assert.ok(hashes.has("0xb"), "the biggest sell is named first");
  assert.equal(curatedForJoin(rows, TOKEN, 18, 0).length, 0);
  assert.equal(curatedForJoin(null, TOKEN, 18, 4).length, 0);
});

test("the trader tally aggregates named wallets only and never counts an unnamed row", () => {
  const rows = [
    fakeRow({ direction: "sold", raw: 10n ** 18n, block: 1, tx: "0xa", trader: TRADER_A }),
    fakeRow({ direction: "bought", raw: 3n * 10n ** 18n, block: 2, tx: "0xb", trader: TRADER_A }),
    fakeRow({ direction: "sold", raw: 7n * 10n ** 18n, block: 3, tx: "0xc", trader: null }),
  ];
  const tally = tallyTraders(rows, TOKEN, 18);
  assert.equal(tally.length, 1, "the unnamed row contributes no wallet");
  assert.equal(tally[0].address, TRADER_A);
  assert.equal(tally[0].buys, 1);
  assert.equal(tally[0].sells, 1);
  assert.equal(tally[0].bought, 3);
  assert.equal(tally[0].sold, 1);
});

test("the volume shape counts swaps, transactions and pool callers as three different things", () => {
  const rows = [
    fakeRow({ direction: "bought", raw: 90n * 10n ** 18n, block: 1, tx: "0xa" }),
    fakeRow({ direction: "sold", raw: 10n * 10n ** 18n, block: 2, tx: "0xa" }),
    fakeRow({ direction: "bought", raw: 10n * 10n ** 18n, block: 3, tx: "0xb", sender: "0x39b38686a19836ac10162c490e4558e120cbbe5f" }),
  ];
  const shape = volumeShape(rows, { token: TOKEN, decimals: 18 });
  assert.equal(shape.swaps, 3);
  // Two of the three swaps are ONE transaction: a routed trade is not two trades.
  assert.equal(shape.transactions, 2);
  assert.equal(shape.buys, 2);
  assert.equal(shape.sells, 1);
  assert.equal(shape.poolCallers.distinct, 2);
  assert.equal(shape.topShares[0].rank, 1);
  assert.equal(shape.topShares[0].percent, 81.82, "90 of 110 units sit in the largest swap");
  assert.match(shape.buyShareDisplay, /% of the volume was buying/);
  assert.equal(shape.unsizedSwaps, 0);
});

test("a round-trip shape needs the same pool, opposite sides and a near-equal size", () => {
  const size = 1_000n * 10n ** 18n;
  const rows = [
    fakeRow({ direction: "bought", raw: size, block: 100, tx: "0xa" }),
    // Same size, same pool, 5 blocks later, other side: a shape.
    fakeRow({ direction: "sold", raw: size, block: 105, tx: "0xb" }),
    // Same size and side-reversal but a DIFFERENT pool: not a round trip.
    fakeRow({ direction: "bought", raw: size, block: 110, tx: "0xc", pool: OTHER_POOL }),
    fakeRow({ direction: "sold", raw: size, block: 2000, tx: "0xd" }),
  ];
  const trips = roundTripShapes(rows, { token: TOKEN, decimals: 18 });
  assert.equal(trips.length, 1);
  assert.equal(trips[0].blocksApart, 5);
  assert.equal(trips[0].pool, POOL);
  // NOBODY LOOKED is not "different wallets". Only a confirmed pair may be reported as one.
  assert.equal(trips[0].sameWallet, null);

  const named = roundTripShapes(
    [
      fakeRow({ direction: "bought", raw: size, block: 100, tx: "0xa", trader: TRADER_A }),
      fakeRow({ direction: "sold", raw: size, block: 105, tx: "0xb", trader: TRADER_A }),
    ],
    { token: TOKEN, decimals: 18 },
  );
  assert.equal(named[0].sameWallet, true);
});

test("a row prints the trader or nothing, and never the router in its place", () => {
  const currencies = new Map([
    [TOKEN, { address: TOKEN, decimals: 18, symbol: "JUG", usdPerUnit: null }],
    [NATIVE, { address: NATIVE, decimals: 18, symbol: "ETH", usdPerUnit: ETH_USD }],
  ]);
  const row = tradeRow(fakeRow({ direction: "sold", raw: 5n * 10n ** 18n, counterRaw: 10n ** 17n, block: Number(HEAD) - 94, tx: "0xa" }), {
    token: TOKEN,
    currencies,
    head: HEAD,
    rank: 1,
  });
  assert.equal(row.side, "sold");
  assert.equal(row.amountDisplay, "5");
  assert.equal(row.counterSymbol, "ETH");
  assert.equal(row.valueUsdDisplay, "$192.49", "0.1 ETH at the supplied rate");
  assert.equal(row.trader, null);
  assert.equal(row.traderSource, "not_joined");
  assert.equal(row.router, ROUTER, "the pool's caller is reported as the router, in its own field");
  assert.match(row.ago, /^~10s ago$/, "94 blocks at 9.4 blocks/second");
});

/**
 * A decoded-swap-shaped row, the way lib/swap-log.js hands one over. Hand-built rather than
 * decoded so the pure cores can be exercised without a chain at all.
 */
function fakeRow({ direction, raw, counterRaw = 10n ** 17n, block, tx, trader = null, pool = POOL, sender = ROUTER }) {
  const bought = direction === "bought";
  return {
    venue: VENUES.V4,
    pool: { kind: "pool_id", poolId: pool, address: PM, fee: 10000, pairKnown: true, currency0: NATIVE, currency1: TOKEN, hooked: false },
    blockNumber: BigInt(block),
    block,
    txHash: tx,
    logIndex: 0,
    fee: 10000,
    feeSource: "swap_log",
    sqrtPriceX96: 1n,
    liquidity: 1n,
    tick: 0,
    sender: { address: sender, role: "pool_caller", isTrader: false },
    trader: { address: trader, source: trader ? "tx.from" : "not_joined" },
    subject: {
      token: TOKEN,
      isToken0: false,
      direction,
      amountIn: bought ? counterRaw : raw,
      amountOut: bought ? raw : counterRaw,
      inCurrency: bought ? NATIVE : TOKEN,
      outCurrency: bought ? TOKEN : NATIVE,
      subjectAmount: bought ? raw : -raw,
      price: { subjectPerCounterparty: null, counterpartyPerSubject: null, basis: "sqrtPriceX96", reason: null },
    },
  };
}

/* ============================== recent trades ============================== */

test("recent trades splits buys from sells with their sizes and names the wallets it could", async () => {
  const chain = fakeChain({
    logs: busyWindow(),
    transactions: {
      [txHash(1)]: { from: TRADER_A, to: ROUTER },
      [txHash(2)]: { from: TRADER_B, to: ROUTER },
      [txHash(3)]: { from: TRADER_A, to: ROUTER },
      [txHash(4)]: { from: TRADER_B, to: ROUTER },
    },
    balances: { [TRADER_A]: 52_399_597n * 10n ** 18n, [TRADER_B]: 0n },
  });
  const res = await recentTrades(TOKEN, offline({ client: chain }));
  assert.equal(res.ok, true);
  assert.equal(res.kind, "trades");
  const e = res.evidence;

  // The subject is token1 of a native-ETH pool: two sells and two buys, from the trader's side.
  assert.equal(e.swaps, 4);
  assert.equal(e.sellCount, 2);
  assert.equal(e.buyCount, 2);
  assert.equal(e.sells.length, 2);
  assert.ok(e.sells.every((row) => row.side === "sold"));
  assert.ok(e.buys.every((row) => row.side === "bought"));
  // Sizes, in the subject token, with a dollar figure off the native-ETH leg.
  assert.equal(e.sells[0].counterSymbol, "ETH");
  assert.ok(e.sells[0].valueUsd > 0, "the ETH leg carries a rate, so the row has a value");
  assert.equal(e.sells[0].feeDisplay, "1%");

  // The wallets, and what they still hold. A zero that balanceOf ANSWERED is a measured zero.
  const a = e.traders.find((t) => t.address === TRADER_A);
  const b = e.traders.find((t) => t.address === TRADER_B);
  assert.equal(a.balanceSource, "balanceOf");
  assert.equal(a.balanceDisplay, "52.4M");
  assert.equal(b.balance, 0);
  assert.equal(b.balanceSource, "balanceOf");
  assert.equal(b.balanceNote, null);
});

test("a fully-read window with no swaps says so in a finished sentence, and one with holes does not", async () => {
  const clean = fakeChain({ logs: [] });
  const quiet = await recentTrades(TOKEN, offline({ client: clean }));
  const v4 = quiet.evidence.venues[VENUES.V4];
  assert.equal(v4.complete, true);
  assert.equal(v4.canSayNone, true);
  // THE HONEST NEGATIVE NAMES THE BLOCKS. "Nobody is selling" is not available at any window.
  assert.match(v4.observedNone, /No swap of this token was observed on Uniswap v4 in blocks \d+-\d+/);
  assert.match(v4.observedNone, /every block in that window was read/);
  assert.equal(v4.notice, null);

  // Now break the read. Same empty result set, entirely different licence.
  //
  // The cache is cleared first ON PURPOSE: the first run above already fetched this exact
  // address-and-range and lib/indexer-cache.js would serve it, which is correct behaviour
  // (that window really was read) and would make this assertion test nothing.
  resetIndexerCache();
  const from = HEAD - 5639n;
  const broken = fakeChain({ logs: [], failFrom: new Set([from]) });
  const partial = await recentTrades(TOKEN, offline({ client: broken }));
  const side = partial.evidence.venues[VENUES.V4];
  assert.equal(side.complete, false);
  assert.equal(side.canSayNone, false);
  assert.equal(side.observedNone, null, "an unread window produces no absence sentence at all");
  assert.match(side.notice, /LOWER BOUND/);
  assert.match(side.notice, /Do NOT say nothing traded/);
});

test("a v4 discovery that never landed does not license an absence either", async () => {
  const chain = fakeChain({ logs: busyWindow(), discoveryFails: true });
  const res = await recentTrades(TOKEN, offline({ client: chain, discoveryBudgetMs: 200 }));
  const v4 = res.evidence.venues[VENUES.V4];
  assert.equal(v4.complete, false);
  assert.equal(v4.canSayNone, false);
  assert.equal(v4.observedNone, null);
  // An outage, said as one: the singleton was never usable as evidence, so nothing about
  // this token's v4 trading was established.
  assert.match(v4.detail, /UNKNOWN/);
});

test("the two venues carry their own windows and are never added together", async () => {
  const v3Swaps = [
    // v3's convention is the POOL's delta: a positive amount1 is Green Bull the pool
    // RECEIVED, so the trader SOLD it. The opposite reading of the same sign on v4.
    v3Log({ amount0: -28_273_749_753_261_872n, amount1: 324_520_060_480_457_565_279_175n, block: Number(HEAD) - 90_000, tx: 7 }),
    v3Log({ amount0: 32_802_000_000_000_000n, amount1: -300_000_000_000_000_000_000_000n, block: Number(HEAD) - 200, tx: 8 }),
  ];
  const chain = fakeChain({ logs: [...busyWindow(), ...v3Swaps], transactions: {} });
  const res = await recentTrades(GREENBULL, {
    ...offline({ client: chain }),
    calls: fakeCalls({ token: GREENBULL, symbol: "GBULL" }),
    // Supplied rather than swept: the sweep is ~170 eth_calls and is not a unit test's business.
    v3Pools: [{ pool: V3_POOL, token0: WETH, token1: GREENBULL, fee: 10000 }],
  });
  const e = res.evidence;
  const v3 = e.venues[VENUES.V3];
  const v4 = e.venues[VENUES.V4];

  assert.equal(v3.read, true);
  assert.equal(v3.swaps, 2);
  assert.equal(v3.sells, 1, "positive amount1 on v3 is the pool receiving, so the trader sold");
  assert.equal(v3.buys, 1);
  // THE WINDOWS DIFFER ON PURPOSE, and each venue reports its own.
  assert.ok(v3.window.blocks > v4.window.blocks, "the sparse venue is read over a wider span");
  assert.notEqual(v3.window.fromBlock, v4.window.fromBlock);
  assert.equal(e.countsSpanTwoWindows, true);
  assert.match(e.countsSpanNote, /two different block ranges/);
  assert.match(SWAP_NOTES.venues, /must not be added together/);
});

test("a token with no v4 pool does not have the singleton read at all, and says why", async () => {
  // Discovery answers from the chain's own log index over the WHOLE history, so "no pool"
  // is a measured fact and not an assumption — which makes reading 5,640 blocks of the
  // busiest address on the chain to confirm it pure waste. Measured live, that waste is what
  // pushed a v3-only token's actual market out of a real request's budget.
  const chain = fakeChain({ logs: busyWindow(), pools: [] });
  const res = await recentTrades(TOKEN, offline({ client: chain }));
  const v4 = res.evidence.venues[VENUES.V4];

  const windowReads = chain.calls.request.filter((c) => String(c.address).toLowerCase() === PM);
  assert.equal(windowReads.length, 0, "the singleton's window was never asked for");
  assert.equal(v4.reason, "no_v4_pool");
  assert.equal(v4.swaps, 0);
  // The absence IS claimable here, and the sentence says what it rests on: no pool, no swap.
  assert.equal(v4.complete, true);
  assert.equal(v4.canSayNone, true);
  assert.match(v4.detail, /whole history of the singleton's Initialize log/);
});

test("no v3 pool is a stated fact about v3, not a silent absence", async () => {
  const res = await recentTrades(TOKEN, offline({ client: fakeChain({ logs: busyWindow() }) }));
  const v3 = res.evidence.venues[VENUES.V3];
  assert.equal(v3.read, false);
  assert.equal(v3.reason, "no_pools");
  assert.equal(v3.canSayNone, false, "a venue that was not read licenses nothing");
  assert.match(v3.detail, /v4 is where trading happens/);
  assert.equal(res.evidence.v3Pools.poolCount, 0);
});

test("an unreadable token precision leaves amounts unconverted rather than wrong by 10^12", async () => {
  // The indexer body fails AND the contract will not answer decimals(). On this chain a pair
  // can span 18 decimals against 6, so a guessed precision is not a small error.
  const chain = fakeChain({ logs: busyWindow(), decimals: { [NATIVE]: 18 } });
  const res = await recentTrades(TOKEN, {
    ...offline({ client: chain }),
    calls: fakeCalls({ fail: true }),
  });
  assert.equal(res.evidence.decimalsUnknown, true);
  assert.match(res.evidence.decimalsNote, /raw base-unit figures/);
  const row = res.evidence.sells[0] ?? res.evidence.buys[0];
  assert.equal(row.amountDisplay, null, "no size is printed at an assumed precision");
  assert.ok(row.amountRaw.length > 0, "the exact base-unit figure is still there");
});

test("bad input is refused as a caller fault, never as a quiet market", async () => {
  const bad = await recentTrades("not-an-address", offline({ client: fakeChain({}) }));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /No token to look up|not.*found/i);

  const noClient = await recentTrades(TOKEN, { ...offline(), client: null });
  assert.equal(noClient.ok, false);
  assert.match(noClient.error, /No RPC client/);
});

/* =============================== real volume =============================== */

test("real volume reports measurements per venue and refuses the intent claim in the evidence", async () => {
  const chain = fakeChain({
    logs: busyWindow(),
    transactions: { [txHash(1)]: { from: TRADER_A, to: ROUTER }, [txHash(3)]: { from: TRADER_A, to: ROUTER } },
    balances: { [TRADER_A]: 1n },
  });
  const res = await realVolume(TOKEN, offline({ client: chain }));
  assert.equal(res.ok, true);
  assert.equal(res.kind, "volumeQuality");
  const e = res.evidence;
  const v4 = e.perVenue[VENUES.V4];

  assert.equal(v4.measured.swaps, 4);
  assert.equal(v4.measured.transactions, 4);
  assert.equal(v4.measured.buys, 2);
  assert.equal(v4.measured.sells, 2);
  assert.ok(v4.concentration.topShares.length >= 1);
  assert.equal(v4.concentration.poolCallers.distinct, 1, "one router fronted every swap");
  assert.match(v4.concentration.poolCallers.note, /not the wallet that traded/);
  // Each venue's figures sit under its own window, so nothing above can average two periods.
  assert.ok(v4.window.blocks > 0);

  // THE REFUSAL IS DATA, not a caveat somebody has to remember to add.
  assert.equal(e.inference.claim, "wash trading");
  assert.equal(e.inference.measurable, false);
  assert.match(e.inference.statement, /Wash trading is a claim about INTENT/);
  assert.match(e.inference.statement, /Never assert wash trading/);
  // The half that is easy to drop: a clean window is not a clearance.
  assert.match(e.inference.absence, /absence of this pattern proves nothing/);
  assert.match(e.inference.absence, /pays the fee to itself/);
  assert.match(e.inference.ordering, /never be described as front-running/);
});

test("the named wallets in a volume answer carry their denominator", async () => {
  const chain = fakeChain({
    logs: busyWindow(),
    transactions: { [txHash(1)]: { from: TRADER_A, to: ROUTER } },
    balances: {},
  });
  const e = (await realVolume(TOKEN, offline({ client: chain }))).evidence;
  assert.equal(e.namedWallets.wallets, 1);
  assert.equal(e.namedWallets.ofSwaps, 4);
  assert.match(e.namedWallets.display, /1 wallet named out of 4 transactions carrying 4 swaps/);
  assert.match(e.namedWallets.note, /never be presented as a share of the token's trading/);
});

/* =============================== swap detail =============================== */

/** A receipt whose logs are viem-shaped, which is what getTransactionReceipt returns. */
function receipt(logs, { block = HEAD, status = "success" } = {}) {
  return {
    status,
    blockNumber: block,
    gasUsed: 514_108n,
    effectiveGasPrice: 20_016_000n,
    logs: logs.map((l) => ({
      address: l.address,
      topics: l.topics,
      data: l.data,
      blockNumber: BigInt(l.blockNumber),
      logIndex: Number(BigInt(l.logIndex)),
      transactionHash: l.transactionHash,
    })),
  };
}

test("one swap is explained with the fee that was actually charged, and the declared one beside it", async () => {
  // The real 99.81% trade, in miniature: fee 998,114 charged where the pool declared 998,112.
  const swap = v4Log({ amount0: 854_147_483n, amount1: -163_700_781_567_901_247_938_428n, fee: 998114, block: Number(HEAD), tx: 9 });
  const chain = fakeChain({
    logs: [swap],
    pools: [{ poolId: POOL, currency0: NATIVE, currency1: TOKEN, fee: 998112, tickSpacing: 19900, hooks: NATIVE }],
    transactions: { [txHash(9)]: { from: TRADER_A, to: ROUTER, input: "0x99e1d016aaaa" } },
    receipts: { [txHash(9)]: receipt([swap]) },
  });
  const res = await swapDetail(txHash(9), { client: chain, manager: PM, ethUsd: ETH_USD });
  assert.equal(res.ok, true);
  assert.equal(res.kind, "swap");
  const s = res.evidence.swaps[0];

  assert.equal(res.evidence.trader, TRADER_A, "the signer is the trader");
  assert.equal(s.router.address, ROUTER, "the pool's caller is the router and says so");
  assert.equal(s.fee.raw, 998114);
  assert.equal(s.fee.display, "99.8114%");
  assert.equal(s.fee.declaredAtInitialize, 998112);
  assert.notEqual(s.fee.display, s.fee.declaredDisplay, "two different fees must not print the same");
  // The two DO disagree in the wild, and reporting the pool's number as the fee paid would be
  // wrong by orders of magnitude on a hooked pool.
  assert.equal(s.fee.differs, true);
  assert.equal(s.paid.symbol, "JUG");
  assert.equal(s.received.symbol, "ETH");
  assert.equal(s.paid.amountRaw, "163700781567901247938428");
  assert.equal(s.pool.kind, "pool_id");
  assert.equal(s.pool.contract, PM, "a v4 pool has no address of its own; the singleton does");
});

test("a pool with no earlier swap in the lookback reports the move as UNKNOWN, never as zero", async () => {
  const swap = v4Log({ amount0: 854_147_483n, amount1: -163_700_781_567_901_247_938_428n, fee: 998114, block: Number(HEAD), tx: 9 });
  const chain = fakeChain({
    logs: [swap],
    transactions: { [txHash(9)]: { from: TRADER_A, to: ROUTER } },
    receipts: { [txHash(9)]: receipt([swap]) },
  });
  const s = (await swapDetail(txHash(9), { client: chain, manager: PM, ethUsd: ETH_USD })).evidence.swaps[0];
  assert.equal(s.priceMove.bps, null);
  assert.equal(s.priceMove.basis, "no_prior_swap_in_lookback");
  assert.match(s.priceMove.note, /UNKNOWN, never zero/);
});

test("an earlier swap in the same pool makes the move exact, and it is the received token's move", async () => {
  const before = v4Log({ amount0: 1n, amount1: -1n, sqrtPriceX96: 8_671_513_068_283_828_063_453_578_781_826_200n, block: Number(HEAD) - 20, tx: 10 });
  const swap = v4Log({ amount0: -24_750_000_000_000_000n, amount1: 2_272_544_786_613_256_784_986_775n, sqrtPriceX96: 8_669_982_178_337_753_437_921_448_110_331_278n, block: Number(HEAD), tx: 11 });
  const chain = fakeChain({
    logs: [before, swap],
    transactions: { [txHash(11)]: { from: TRADER_B, to: ROUTER } },
    receipts: { [txHash(11)]: receipt([swap]) },
  });
  const s = (await swapDetail(txHash(11), { client: chain, manager: PM, ethUsd: ETH_USD })).evidence.swaps[0];
  assert.equal(s.priceMove.basis, "prior_swap_in_pool");
  assert.equal(s.priceMove.priorSwap.block, Number(HEAD) - 20);
  assert.ok(Number.isFinite(s.priceMove.bps));
  // The trader paid token0 (native ETH) and received token1, so the move reported is token1's.
  assert.equal(s.priceMove.forCurrency, TOKEN);
  assert.match(s.priceMove.display, /^[+-]/);
});

test("a transaction with no Swap event says which venues were checked", async () => {
  const chain = fakeChain({
    transactions: { [txHash(12)]: { from: TRADER_A, to: ROUTER } },
    receipts: { [txHash(12)]: receipt([]) },
  });
  const res = await swapDetail(txHash(12), { client: chain, manager: PM, ethUsd: ETH_USD });
  assert.equal(res.ok, true);
  assert.equal(res.evidence.swapCount, 0);
  assert.equal(res.evidence.noSwap, true);
  assert.match(res.evidence.noSwapReason, /no Uniswap v3 or Uniswap v4 Swap event/);
  assert.match(res.evidence.noSwapReason, /some other venue would not be visible/);
});

test("a v3 swap in a transaction is decoded from the pool's own getters", async () => {
  const swap = v3Log({ amount0: 32_802_000_000_000_000n, amount1: -300_000_000_000_000_000_000_000n, block: Number(HEAD), tx: 13 });
  const chain = fakeChain({
    transactions: { [txHash(13)]: { from: TRADER_A, to: V3_ROUTER } },
    receipts: { [txHash(13)]: receipt([swap]) },
  });
  const s = (await swapDetail(txHash(13), { client: chain, manager: PM, ethUsd: ETH_USD })).evidence.swaps[0];
  assert.equal(s.venue, VENUES.V3);
  assert.equal(s.pool.kind, "address");
  assert.equal(s.pool.currency0, WETH);
  assert.equal(s.pool.currency1, GREENBULL);
  // v3's amounts are the POOL's delta: a positive amount0 is WETH the pool received, so the
  // trader PAID WETH. Getting this backwards on one venue is the defect the layer exists for.
  assert.equal(s.paid.symbol, "WETH");
  assert.equal(s.received.symbol, "GBULL");
  // A v3 pool's fee is immutable and lives on the contract, never in the event.
  assert.equal(s.fee.declaredAtInitialize, 10000);
});

test("a hash that is not a hash, and a transaction that is not there, are different failures", async () => {
  const bad = await swapDetail("0xabc", { client: fakeChain({}) });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /64 hex characters/);

  const missing = await swapDetail(txHash(99), { client: fakeChain({}), manager: PM });
  assert.equal(missing.ok, false);
  // "no such transaction" and "we could not read it" are different facts and get different
  // sentences; this fake says the first.
  assert.match(missing.error, /exists on this chain|not been mined/);
});

/* ============================ the catalogue wiring ========================= */

test("the three swap tools are in the catalogue, the name list and the phrase map", () => {
  for (const name of ["recent_trades", "real_volume", "swap_detail"]) {
    assert.ok(TOOL_NAMES.includes(name), `${name} is in TOOL_NAMES`);
    const schema = TOOL_SCHEMAS.find((s) => s.function.name === name);
    assert.ok(schema, `${name} has a schema`);
    assert.equal(schema.type, "function");
    assert.equal(schema.function.parameters.additionalProperties, false);
    // The description is the router now, so it has to carry the phrasings AND the limits.
    assert.ok(schema.function.description.length > 400, `${name}'s description is substantial`);
    assert.match(schema.function.description, /CANNOT ESTABLISH|MUST NOT BE ASSERTED|cannot say/i);
    // Every tool needs a status phrase, or the reader watches a generic spinner.
    assert.notEqual(stepForTool(name), PHRASE_STEPS.ROUTING, `${name} has its own phrase pool`);
    assert.ok(phrasesFor(stepForTool(name)).length >= 4);
    assert.ok(progressLabel(stepForTool(name), "NVDA").includes("NVDA"));
  }
});

test("each description names the bound that its answer is most likely to overstate", () => {
  const byName = (n) => TOOL_SCHEMAS.find((s) => s.function.name === n).function.description;
  // recent_trades: the negative it cannot support, and the router.
  assert.match(byName("recent_trades"), /CANNOT SAY NOBODY IS SELLING/);
  assert.match(byName("recent_trades"), /observed in the N blocks read/);
  assert.match(byName("recent_trades"), /NOT THE TRADER/);
  assert.match(byName("recent_trades"), /never say front-ran/i);
  // real_volume: the intent claim, and the absence that proves nothing.
  assert.match(byName("real_volume"), /WASH TRADING IS NOT ONE OF THESE MEASUREMENTS/);
  assert.match(byName("real_volume"), /ABSENCE PROVES NOTHING/);
  // swap_detail: the fees that are not tiers.
  assert.match(byName("swap_detail"), /99\.81%/);
  assert.match(byName("swap_detail"), /UNKNOWN, NEVER ZERO/);
});

test("the swap tools' arguments survive whatever shape the model sends", () => {
  assert.deepEqual(coerceRecentTradesArgs({ query: "nvda" }), { ok: true, value: "nvda", minutes: DEFAULT_TRADE_MINUTES });
  // The window arrives as minutes, as hours, as a bare string, and under other keys.
  assert.equal(coerceRecentTradesArgs({ query: "nvda", minutes: 20 }).minutes, 20);
  assert.equal(coerceRecentTradesArgs({ query: "nvda", minutes: "1h" }).minutes, MAX_TRADE_MINUTES, "an hour is clamped to the ceiling, not refused");
  assert.equal(coerceRecentTradesArgs({ query: "nvda", window: "5m" }).minutes, 5);
  assert.equal(coerceRecentTradesArgs({ query: "nvda", minutes: "banana" }).minutes, DEFAULT_TRADE_MINUTES);
  assert.equal(coerceRecentTradesArgs({ token: "0xa01a9b43590bbdced87cc5f224b18f51da107c20" }).value.length, 42);
  assert.equal(coerceRecentTradesArgs({}).ok, false);
  assert.equal(coerceVolumeArgs({ query: "nvda", minutes: 999 }).minutes, MAX_TRADE_MINUTES);

  // A truncated address must never be fuzzy-matched to some other contract.
  assert.equal(coerceRecentTradesArgs({ query: "0xabc" }).ok, false);

  const hash = `0x${"ab".repeat(32)}`;
  assert.deepEqual(coerceSwapDetailArgs({ hash }), { ok: true, value: hash });
  assert.deepEqual(coerceSwapDetailArgs({ tx: hash }), { ok: true, value: hash });
  const asAddress = coerceSwapDetailArgs({ hash: TOKEN });
  assert.equal(asAddress.ok, false);
  assert.match(asAddress.error, /recent_trades/, "the error names the tool that answers that question");
});

test("the dispatcher routes each swap tool to its gatherer with the coerced arguments", async () => {
  const seen = [];
  const impls = {
    recentTrades: (...args) => (seen.push(["recentTrades", args]), Promise.resolve({ ok: true, kind: "trades", evidence: {} })),
    realVolume: (...args) => (seen.push(["realVolume", args]), Promise.resolve({ ok: true, kind: "volumeQuality", evidence: {} })),
    swapDetail: (...args) => (seen.push(["swapDetail", args]), Promise.resolve({ ok: true, kind: "swap", evidence: {} })),
  };
  const hash = `0x${"cd".repeat(32)}`;
  assert.equal((await dispatchTool("recent_trades", { query: "nvda", minutes: "2h" }, impls)).kind, "trades");
  assert.equal((await dispatchTool("real_volume", { query: "nvda" }, impls)).kind, "volumeQuality");
  assert.equal((await dispatchTool("swap_detail", { hash }, impls)).kind, "swap");

  assert.deepEqual(seen[0], ["recentTrades", ["nvda", { minutes: MAX_TRADE_MINUTES }]]);
  assert.deepEqual(seen[1], ["realVolume", ["nvda", { minutes: DEFAULT_TRADE_MINUTES }]]);
  assert.deepEqual(seen[2], ["swapDetail", [hash]]);

  // A malformed call becomes a sentence the model can act on, never a throw.
  const bad = await dispatchTool("swap_detail", { hash: "nope" }, impls);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /transaction hash/);

  // The status line names the subject off the COERCED arguments, not the raw ones.
  assert.equal(toolSubject("recent_trades", { symbol: "$nvda" }), "NVDA");
  assert.equal(toolSubject("real_volume", {}), null);
  assert.equal(toolSubject("swap_detail", { hash }), "0xcdcd…cdcd");
});
