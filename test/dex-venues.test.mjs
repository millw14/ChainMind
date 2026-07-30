// Tests for the TWO-VENUE seam: how lib/dex-price.js tokenMarketData chooses between a
// Uniswap v3 price and a Uniswap v4 one, and how lib/ask-evidence.js turns that choice into
// sentences a reader can act on.
//
// WHY THIS IS ITS OWN FILE. test/dex-v4.test.mjs is about whether the v4 reader reads v4
// correctly. This is about the four questions that only exist once there are two venues, and
// every one of them is a place where the honest answer and the convenient one differ:
//
//   1. WHICH FIGURES WIN when both venues have a market. v3 does, always — it is the
//      instrument this repo has audited over many rounds, and The Green Bull must not move.
//   2. WHETHER "no v3 pool" MAY BE REPORTED AS "no market". Only when v4 also came back a
//      stated absence. Measured on chain 4663, PIPECAT has no v3 pool and eight v4 pools.
//   3. WHAT A FAILED V4 READ IS ALLOWED TO SAY. Not "false", not "no market" — unknown.
//      This is the bug live verification actually caught: `alsoOnUniswapV4` was a boolean
//      and reported FALSE for The Green Bull, which has 48 v4 pools, because its log query
//      failed.
//   4. WHETHER A FIGURE EVER TRAVELS UNLABELLED. It may not, on any path.
//
// Entirely offline: the v4 reader is injected and the v3 chain is a fake that answers the
// factory with the zero address. Run with: npm test
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resetIndexerCache } from "../lib/indexer-cache.js";
import { resetDexCache, tokenMarketData } from "../lib/dex-price.js";
import { V4_DISCOVERY_BUDGET_MS } from "../lib/dex-v4.js";
import { gatherEvidence } from "../lib/ask-evidence.js";

beforeEach(() => {
  resetIndexerCache();
  resetDexCache();
});
afterEach(() => {
  resetIndexerCache();
  resetDexCache();
});

const TOKEN = "0x31ba1d706d9e6a4f183651d0f3631b6cfb2ac6cc"; // PIPECAT
const POOL_ID = "0x63407e8807b932857674ee635b144640d73f23c032171ad3b1897bd98add6ab4";
const V3_POOL = "0x8f450b8ee34f07681b68bbb97729fcd4e8778417";
const HOOK = "0xefe669814e5eec33406bd50ffa8331618d076aec";
const ZERO = `0x${"0".repeat(40)}`;

/**
 * A chain on which NO v3 pool exists — every factory slot answers the zero address, which is
 * a stated absence rather than a failure, and nothing else answers.
 *
 * `getLogs` is deliberately absent so the real v4 reader would decline with `no_client`; every
 * test here injects its own v4 result instead, which is the seam.
 */
function noV3Chain() {
  return {
    async readContract({ functionName }) {
      if (functionName === "getPool") return ZERO;
      if (functionName === "decimals") return 18;
      throw new Error("nothing else answers");
    },
  };
}

/** Blockscout's side, stubbed: an ETH price and no holders to probe. */
const noIndexer = {
  getStats: async () => ({ coin_price: 1901.97 }),
  getTokenHolders: async () => ({ items: [] }),
};

/** What lib/dex-v4.js answers for PIPECAT: priced, from the hooked native-ETH pool. */
function v4Priced(over = {}) {
  return async () => ({
    ok: true,
    source: "uniswap_v4",
    poolId: POOL_ID,
    pool: POOL_ID,
    fee: 0,
    tickSpacing: 200,
    hooks: HOOK,
    hooked: true,
    poolCount: 8,
    measuredPoolCount: 8,
    poolsDropped: 0,
    unpriceablePoolCount: 0,
    hookedPoolCount: 1,
    pools: [],
    quote: { address: ZERO, kind: "native_eth", verifiedBy: "chain_native_asset", usdPerUnit: 1901.97 },
    price: 8.785241e-6,
    priceUsd: 8.785241e-6,
    marketCap: 8348.89,
    priceInQuote: 4.619022e-9,
    priceNative: 4.619022e-9,
    quoteLiquidityUsd: 47.83,
    depthIsLowerBound: false,
    depthCoveredBandBps: null,
    wideDepthUsd: 244.24,
    wideDepthIsLowerBound: false,
    quoteBalanceUsd: null,
    quoteBalanceReason: "v4_singleton_pools_share_custody",
    liquidityUsd: null,
    asOfBlock: 22_923_462,
    ...over,
  });
}

/** What it answers for a token with no v4 pool: a MEASURED absence, from the log index. */
const v4None = async () => ({
  ok: false,
  source: "uniswap_v4",
  reason: "no_pool",
  detail: "No Uniswap v4 pool exists for this token on Robinhood Chain.",
  poolCount: 0,
});

/** What it answers when the log query failed: unknown, and emphatically not "none". */
const v4Unread = async () => ({
  ok: false,
  source: "uniswap_v4",
  reason: "discovery_failed",
  detail: "The Uniswap v4 pool lookup did not complete.",
  poolCount: null,
});

/** Pools found, none of them priceable — a real finding that is still not a price. */
const v4Unpriced = async () => ({
  ok: false,
  source: "uniswap_v4",
  reason: "no_quote",
  detail: "This token's Uniswap v4 pools are all paired against currencies that could not be established as a value reference.",
  poolCount: 48,
  unpriceablePoolCount: 48,
});

const wire = (v4) => ({
  client: noV3Chain(),
  calls: noIndexer,
  v4MarketData: v4,
  totalSupply: "950331000000000000000000000",
  decimals: 18,
});

/* --------------------------- v4 carries the answer -------------------------- */

test("a token with no v3 pool but a v4 one is PRICED, from v4, and says so", async () => {
  // THE DEFECT. Live, this reported reason `no_pool` and the answer layer said "no Uniswap v3
  // pool … either", which reads as "this has no market". PIPECAT's market is a v4 pool holding
  // half its supply.
  const res = await tokenMarketData(TOKEN, wire(v4Priced()));
  assert.equal(res.source, "uniswap_v4", "every figure below is stamped with the venue");
  assert.equal(res.price, 8.785241e-6);
  assert.equal(res.marketCap, 8348.89);
  assert.equal(res.pool, POOL_ID);
  assert.equal(res.hooked, true, "and the hook travels with it");
  assert.equal(res.hooks, HOOK);
  // WHAT V3 SAID IS KEPT, not discarded: "no v3 pool, and the price comes from v4" is a more
  // useful and more honest statement than either half alone.
  assert.equal(res.v3Reason, "no_pool");
  assert.equal(res.reason, undefined, "and the result is not a failure at all");
});

test("a v4-sourced depth is judged on the SAME floor as a v3 one", async () => {
  const thin = await tokenMarketData(TOKEN, wire(v4Priced()));
  assert.equal(thin.quoteLiquidityUsd, 47.83);
  assert.equal(thin.thinLiquidity, true, "$47.83 against the $200 floor, and the figure is exact");

  const deep = await tokenMarketData(TOKEN, wire(v4Priced({ quoteLiquidityUsd: 5_000 })));
  assert.equal(deep.thinLiquidity, false);

  // A LOWER BOUND BELOW THE FLOOR IS NULL, NOT THIN — a figure that only counts upward can
  // show a pool IS deep enough and can never show it is not. Same rule as v3's.
  const bounded = await tokenMarketData(TOKEN, wire(v4Priced({ quoteLiquidityUsd: 12, depthIsLowerBound: true })));
  assert.equal(bounded.thinLiquidity, null);
});

test("a v4-sourced result reports NO held balance and no both-sides total", async () => {
  // Neither quantity exists per pool in v4: the singleton custodies every pool's tokens
  // together. A number here would be a chain-wide total presented as this pool's liquidity —
  // the exact confusion that made the PoolManager look like a wallet.
  const res = await tokenMarketData(TOKEN, wire(v4Priced()));
  assert.equal(res.quoteBalanceUsd, null);
  assert.equal(res.liquidityUsd, null);
});

/* ------------------------- v3 wins where v3 answers ------------------------- */

test("a token with markets on BOTH venues keeps its v3 figures, and says the other exists", async () => {
  // The Green Bull must not move: v3 is the instrument this repo has audited over many rounds
  // and it prices that token to within 0.2% of the indexer's independent feed. An unlabelled
  // v4 figure displacing it would be a regression dressed as a feature.
  const r = recorder();
  const res = await gatherEvidence(TOKEN, {
    known: { kind: "token", address: TOKEN },
    calls: bullCalls(r, {
      tokenMarketData: async () => ({ ...v3Bull(), v4: v4Block("found_unpriced", { poolCount: 48 }), alsoOnUniswapV4: true }),
    }),
  });
  const pool = res.evidence.token.pool;
  assert.equal(pool.source, "uniswap_v3");
  assert.equal(pool.venue, "Uniswap v3");
  assert.equal(pool.priceUsd, 0.0001801604);
  assert.equal(pool.address, V3_POOL, "a v3 pool is named by its contract");
  assert.equal(pool.poolId, null, "and has no pool id");
  assert.equal(pool.alsoOnUniswapV4, true);
  assert.match(pool.sourceNotice, /Uniswap v3 pool 0x8f450b8e/);
  assert.match(pool.sourceNotice, /ALSO has 48 Uniswap v4 pool/);
  assert.match(pool.sourceNotice, /never be added to or averaged/);
});

test("a v4-sourced price is presented as v4's, with the pool ID and not an address", async () => {
  const r = recorder();
  const res = await gatherEvidence(TOKEN, {
    known: { kind: "token", address: TOKEN },
    calls: bullCalls(r, {
      tokenMarketData: async () => ({
        ...v3Bull(),
        source: "uniswap_v4",
        pool: POOL_ID,
        hooked: true,
        hooks: HOOK,
        tickSpacing: 200,
        v3Reason: "no_pool",
        v4: v4Block("priced", { poolCount: 8 }),
      }),
    }),
  });
  const token = res.evidence.token;
  assert.equal(token.priceStatus, "pool_priced");
  assert.equal(token.priceSource, "uniswap_v4", "the model is told which venue, not a constant");
  assert.equal(token.pool.venue, "Uniswap v4");
  assert.equal(token.pool.address, null, "there is no v4 pool contract to look up");
  assert.equal(token.pool.poolId, POOL_ID);
  assert.match(token.pool.sourceNotice, /inside the v4 PoolManager singleton/);
  assert.match(token.pool.sourceNotice, /names a HOOK at 0xefe66981/);
  assert.match(token.pool.sourceNotice, /Uniswap v3 was swept .* and has no pool for it/);
  assert.match(token.priceStatusReason, /32-byte pool ID/);
  // The held-balance clause must say the quantity does not EXIST, not that it failed to read.
  assert.match(token.pool.liquidityNotice, /custodies EVERY pool's tokens together/);
  assert.doesNotMatch(token.pool.liquidityNotice, /could not be read/);
});

test("a v4 price reached because the v3 side FAILED does not claim v3 was swept", async () => {
  // "v3 has no pool" and "v3 did not answer" are different facts, and only the first may be
  // stated. Claiming a sweep that never completed would be inventing a measurement.
  const r = recorder();
  const res = await gatherEvidence(TOKEN, {
    known: { kind: "token", address: TOKEN },
    calls: bullCalls(r, {
      tokenMarketData: async () => ({
        ...v3Bull(),
        source: "uniswap_v4",
        pool: POOL_ID,
        v3Reason: "pool_read_failed",
        v4: v4Block("priced", { poolCount: 8 }),
      }),
    }),
  });
  const notice = res.evidence.token.pool.sourceNotice;
  assert.match(notice, /NOT settled this call \(pool_read_failed\)/);
  assert.doesNotMatch(notice, /swept/);
});

/* ------------------- what a failed v4 read may and may not say -------------- */

test("an unread v4 side leaves 'also trades on v4' UNKNOWN, never false", async () => {
  // THE BUG LIVE VERIFICATION CAUGHT. The field was a boolean and a `||` over a null count
  // produced FALSE — "this token does not trade on v4" — for The Green Bull, whose v4 log
  // query failed and which has 48 v4 pools.
  const priced = await tokenMarketData(TOKEN, {
    ...wire(v4Unread),
    client: {
      async readContract({ functionName }) {
        if (functionName === "getPool") return ZERO;
        return 18;
      },
    },
  });
  assert.equal(priced.alsoOnUniswapV4, null, "unknown");
  assert.equal(priced.v4.status, "unread");
  assert.equal(priced.v4.outage, true);

  const swept = await tokenMarketData(TOKEN, wire(v4None));
  assert.equal(swept.alsoOnUniswapV4, false, "and only a real negative earns false");
});

test("v4 pools found but not priceable still means the token trades on v4", async () => {
  // The Green Bull's shape: 48 v4 pools, none of them against a currency this app can value.
  // "We found pools and could not price them" is a POSITIVE finding about the market's
  // existence and a negative one about its value, and the two must not be collapsed — reading
  // the unpriced half as "no v4 market" would lose the fact that 48 pools exist.
  const res = await tokenMarketData(TOKEN, wire(v4Unpriced));
  assert.equal(res.alsoOnUniswapV4, true, "48 pools is 48 pools whether or not they can be priced");
  assert.equal(res.v4.status, "found_unpriced");
  assert.equal(res.v4.poolCount, 48);
  assert.equal(res.v4.unpriceablePoolCount, 48);
  assert.equal(res.v4.priced, false, "and no price is claimed from them");
  assert.equal(res.v4.outage, false, "nor is this an outage — the pools were read");
});

test("a v3 'no pool' beside an unread v4 may NOT be reported as having no market", async () => {
  const r = recorder();
  const res = await gatherEvidence(TOKEN, {
    known: { kind: "token", address: TOKEN },
    calls: bullCalls(r, {
      getToken: async () => unpriced(),
      tokenMarketData: async () => ({ ...noPoolResult(), v4: v4Block("unread") }),
    }),
  });
  const token = res.evidence.token;
  assert.equal(token.priceStatus, "unavailable", "not 'not_indexed', which asserts an absence");
  assert.match(token.priceStatusReason, /Uniswap v4 side could not be read/);
  assert.match(token.priceStatusReason, /an outage, not a token without a market/);
  assert.equal(token.pool.marketSettled, false);
});

test("a v4 read skipped for time is neither an outage nor an absence", async () => {
  const r = recorder();
  const res = await gatherEvidence(TOKEN, {
    known: { kind: "token", address: TOKEN },
    calls: bullCalls(r, {
      getToken: async () => unpriced(),
      tokenMarketData: async () => ({ ...noPoolResult(), v4: v4Block("skipped") }),
    }),
  });
  const reason = res.evidence.token.priceStatusReason;
  assert.match(reason, /NOT READ this time/);
  assert.match(reason, /nothing was measured and nothing failed/i);
  // The sentence names the word only to forbid it — "do not describe this as an outage".
  assert.match(reason, /do not describe this as an outage/i);
});

test("v4 pools that exist but could not be priced means the market is UNKNOWN, not absent", async () => {
  const r = recorder();
  const res = await gatherEvidence(TOKEN, {
    known: { kind: "token", address: TOKEN },
    calls: bullCalls(r, {
      getToken: async () => unpriced(),
      tokenMarketData: async () => ({ ...noPoolResult(), v4: v4Block("found_unpriced", { poolCount: 48 }) }),
    }),
  });
  const reason = res.evidence.token.priceStatusReason;
  assert.match(reason, /It DOES have 48 Uniswap v4 pool/);
  assert.match(reason, /HAS an on-chain market/);
  assert.equal(res.evidence.token.priceStatus, "unavailable");
});

test("only BOTH venues answering 'nothing here' may be reported as no market", async () => {
  // Vladhoods 0xbbdd…247c, measured: no v3 pool and zero v4 Initialize events. This is the one
  // combination that earns the absence, and the sentence says both venues were read.
  const r = recorder();
  const res = await gatherEvidence(TOKEN, {
    known: { kind: "token", address: TOKEN },
    calls: bullCalls(r, {
      getToken: async () => unpriced(),
      tokenMarketData: async () => ({ ...noPoolResult(), v4: v4Block("none", { poolCount: 0 }) }),
    }),
  });
  const token = res.evidence.token;
  assert.equal(token.priceStatus, "not_indexed");
  assert.match(token.priceStatusReason, /BOTH venues were read and neither has a market for it/);
  assert.match(token.priceStatusReason, /never emitted an Initialize event naming it/);
  assert.equal(token.pool.marketSettled, true);
});

test("no v4 verdict at all is UNSETTLED, matching what lib/depth-rank.js makes of it", async () => {
  // Nobody asked about v4, so nothing about v4 may be concluded. The two consumers must agree
  // about a missing verdict or the same token would be "no market" in a sentence and "unknown"
  // in a ranking on the same page.
  const r = recorder();
  const res = await gatherEvidence(TOKEN, {
    known: { kind: "token", address: TOKEN },
    calls: bullCalls(r, { getToken: async () => unpriced(), tokenMarketData: async () => noPoolResult() }),
  });
  assert.equal(res.evidence.token.pool.marketSettled, false);
});

test("a hanging v4 discovery cannot spend the v3 answer's budget", async () => {
  // MEASURED LIVE, AND THIS IS WHY THE CEILING EXISTS. Discovery runs in FRONT of the v3 sweep,
  // so a doomed log query does not merely fail — it takes the v3 answer down with it. Four
  // attempts against a node returning "log query timed out" after 2.3s cost about 14 seconds,
  // and one Green Bull lookup took 28.0s against an ASK_BUDGET_MS of 24s: the v4 side reported
  // UNREAD, honestly, having spent the time v3 needed. An honest "unknown" bought at the price
  // of the answer is not a good trade.
  //
  // The real reader is used here, not the seam — the point is the CEILING around it, so it has
  // to be the code path that ceiling wraps.
  const hangs = {
    async readContract({ functionName }) {
      if (functionName === "getPool") return ZERO;
      if (functionName === "decimals") return 18;
      // The v4 manager check must SETTLE, or discovery is skipped before the ceiling matters.
      if (functionName === "extsload") return `0x${"0".repeat(64)}`;
      if (functionName === "protocolFeeController") return ZERO;
      throw new Error("nothing else answers");
    },
    // Slower than the ceiling it is being raced against, which is the shape live discovery has
    // when the node is refusing: it does answer, far too late to be worth waiting for.
    getLogs: () => new Promise((resolve) => setTimeout(() => resolve([]), 2_000)),
  };
  const started = Date.now();
  const res = await tokenMarketData(TOKEN, {
    client: hangs,
    calls: noIndexer,
    totalSupply: "950331000000000000000000000",
    decimals: 18,
    // The production ceiling is 5s; the test asserts the MECHANISM, not the constant, so it
    // uses a short one rather than spending five real seconds proving arithmetic.
    v4DiscoveryBudgetMs: 60,
  });
  const spent = Date.now() - started;
  assert.ok(V4_DISCOVERY_BUDGET_MS >= 1_000, "the production ceiling is a real budget, not a token value");
  assert.ok(spent < 1_500, `discovery was bounded, took ${spent}ms`);
  assert.equal(res.v4.status, "unread");
  assert.equal(res.v4.outage, true, "a read that never returned is an outage");
  assert.equal(res.alsoOnUniswapV4, null, "and NOT false — nothing was established");
  assert.equal(res.reason, "no_pool", "while the v3 finding is reported exactly as v3 made it");
});

/* --------------------------------- fixtures -------------------------------- */

/** The v4 block lib/dex-price.js attaches, in each of its states. */
function v4Block(status, over = {}) {
  return {
    source: "uniswap_v4",
    status,
    priced: status === "priced",
    outage: status === "unread",
    skipped: status === "skipped",
    reason: { priced: null, none: "no_pool", unread: "discovery_failed", skipped: "out_of_time", found_unpriced: "no_quote" }[status] ?? null,
    detail: "…",
    poolCount: null,
    ...over,
  };
}

/** The Green Bull's v3 figures, as measured live on chain 4663. */
function v3Bull() {
  return {
    source: "uniswap_v3",
    price: 0.0001801604,
    marketCap: 180_160.36,
    priceInQuote: 9.434e-8,
    priceNative: 9.434e-8,
    quoteLiquidityUsd: 217.06,
    quoteBalanceUsd: 69_679,
    liquidityUsd: 249_839,
    depthIsLowerBound: false,
    depthCoveredBandBps: null,
    wideDepthUsd: 1108.28,
    wideDepthIsLowerBound: false,
    depthBandBps: 200,
    wideBandBps: 1000,
    thinLiquidity: false,
    quote: { address: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", kind: "native", verifiedBy: "reference_asset", usdPerUnit: 1909.73 },
    pool: V3_POOL,
    fee: 10_000,
    poolCount: 1,
    asOfBlock: 22_929_159,
    discovery: "factory",
  };
}

/** A v3 sweep that found nothing — a measured absence about v3 and only about v3. */
function noPoolResult() {
  return {
    source: "uniswap_v3",
    price: null,
    marketCap: null,
    quoteLiquidityUsd: null,
    quote: null,
    pool: null,
    fee: null,
    reason: "no_pool",
    detail: "No Uniswap v3 pool for this token against any verified quote asset on Robinhood Chain.",
  };
}

const unpriced = () => ({
  address: TOKEN,
  name: "PIPECAT",
  symbol: "PIPECAT",
  decimals: "18",
  type: "ERC-20",
  total_supply: "950331000000000000000000000",
  exchange_rate: null,
  circulating_market_cap: null,
  volume_24h: null,
  holders: "474",
});

function recorder() {
  return { saw: [] };
}

/** The token path's calls, all successful and all fast. Only `tokenMarketData` varies. */
function bullCalls(r, over = {}) {
  return {
    getToken: async () => ({ ...unpriced(), exchange_rate: null }),
    getTokenCounters: async () => ({ token_holders_count: 474, transfers_count: 900 }),
    getTokenHolders: async () => ({ items: [] }),
    getTokenActivity: async () => ({ items: [] }),
    getAddress: async () => ({ hash: TOKEN, is_contract: true, is_verified: true, token: unpriced() }),
    listStockTokens: async () => ({ ok: false, tokens: [] }),
    resolveSymbol: async () => ({ ok: false }),
    snapshotMatch: async () => null,
    ...over,
  };
}
