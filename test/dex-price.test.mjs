// Tests for the Uniswap v3 pool pricer (lib/dex-price.js) — the module that
// answers "what is this worth" for the ~every token the indexer leaves unpriced.
//
// Entirely offline. The RPC client is a fake built from a chain SPEC, and the
// indexer calls are injected, so nothing here touches the network. The numbers in
// the VLAD and USDG fixtures were read off Robinhood Chain live and are the
// regression anchor: if the decimals correction, the Q96 arithmetic or the token
// ordering ever drifts, those two assertions are what catches it.
//
// The other half of this file is about what must NOT happen. Four different
// failures — no pool, an unreadable pool, an uninitialised pool and a missing
// ETH/USD rate — have to produce four different reasons and, every one of them,
// a null rather than a zero. Run with: npm test
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resetIndexerCache } from "../lib/indexer-cache.js";
import {
  DEFAULT_FACTORY,
  DEFAULT_WETH,
  bigRatioToNumber,
  ethUsd,
  findPool,
  priceFromPool,
  priceFromSqrtX96,
  resetDexCache,
  resolvePool,
  supplyToNumber,
  tokenMarketData,
} from "../lib/dex-price.js";

/* ------------------------------- fixtures -------------------------------- */

const WETH = DEFAULT_WETH.toLowerCase();
const FACTORY = DEFAULT_FACTORY.toLowerCase();

/** Vladhoods — the token the whole method was verified against, live on chain 4663. */
const VLAD = "0xbbdd266afd623136574ad7ebc8f6ca0d867e247c";
const VLAD_POOL = "0xad19a21d400b6381a79e3b676241450ce4159f66";
/** slot0.sqrtPriceX96 as read from that pool. token0 = WETH, token1 = VLAD, fee 3000. */
const VLAD_SQRT = 172980936757921794081904939668374n;

/** "Global Dollar" — the one stablecoin candidate that passes the peg check. 6 decimals. */
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const USDG_POOL = "0x69bfaf19c9f377bb306a89aed9f6b07e2c1a8d9a";
const USDG_SQRT = 3484055974542775767007232n;

/** ETH/USD as Blockscout reported it at the time the fixtures were read. */
const ETH_USD = 1930.5;

/** 1B tokens at 18 decimals — VLAD's real supply, as the indexer sends it. */
const VLAD_SUPPLY_RAW = "1000000000000000000000000000";

const ZERO = "0x0000000000000000000000000000000000000000";

/* ------------------------------ the fake chain ---------------------------- */

/**
 * A viem-shaped read-only client backed by a plain object.
 *
 * Dispatches on functionName only, which is all lib/dex-price.js needs, and
 * matches addresses case-insensitively because the module lowercases everything
 * it derives while the fixtures are written the way an explorer shows them.
 *
 * `fail` is a set of "0xaddr:functionName" strings that throw instead of
 * answering — the seam for every "could not read" test, which is the half of this
 * module that cannot be exercised any other way.
 */
/** The tick spacing Uniswap v3 pairs with each standard fee tier. */
const SPACING_BY_FEE = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

/**
 * A pool's tick ladder, derived from the POSITIONS a fixture declares.
 *
 * A fixture says what is in the pool — `positions: [{ lower, upper, liquidity }]` —
 * and the bitmap and the per-tick liquidityNet are computed from that, exactly the
 * way the real contract computes them on mint. Writing the bitmap by hand would let
 * a fixture describe a pool that cannot exist, which is the one thing a regression
 * test for this must not do.
 *
 * A pool with no `positions` has an EMPTY ladder: no initialised tick anywhere, so
 * its liquidity() spans the whole band. That is a real shape — one full-range
 * position — and it is what the live Green Bull pool measures as.
 */
function tickLadder(p) {
  const spacing = p.tickSpacing ?? SPACING_BY_FEE[Number(p.fee)] ?? 60;
  const net = new Map();
  for (const pos of p.positions ?? []) {
    const L = BigInt(pos.liquidity);
    net.set(pos.lower, (net.get(pos.lower) ?? 0n) + L);
    net.set(pos.upper, (net.get(pos.upper) ?? 0n) - L);
  }
  return { spacing, net };
}

function fakeClient(spec) {
  const pools = {};
  for (const [addr, p] of Object.entries(spec.pools ?? {})) pools[addr.toLowerCase()] = p;
  const decimals = {};
  for (const [addr, d] of Object.entries(spec.decimals ?? {})) decimals[addr.toLowerCase()] = d;
  const supplies = {};
  for (const [addr, s] of Object.entries(spec.supplies ?? {})) supplies[addr.toLowerCase()] = s;
  const fail = new Set((spec.fail ?? []).map((s) => s.toLowerCase()));
  const calls = [];

  /** getPool is order-agnostic on the real factory, so the fake must be too. */
  function findPoolFor(a, b, fee) {
    for (const [addr, p] of Object.entries(pools)) {
      if (Number(p.fee) !== Number(fee)) continue;
      const t0 = p.token0.toLowerCase();
      const t1 = p.token1.toLowerCase();
      const x = a.toLowerCase();
      const y = b.toLowerCase();
      if ((t0 === x && t1 === y) || (t0 === y && t1 === x)) {
        // A pool the factory does not know about — a second deployment, or a
        // non-standard tier — is reachable only by the holder probe.
        return p.hiddenFromFactory ? null : addr;
      }
    }
    return null;
  }

  return {
    calls,
    async getBlockNumber() {
      if (spec.blockNumber == null) throw new Error("no block number");
      return BigInt(spec.blockNumber);
    },
    async readContract({ address, functionName, args }) {
      const a = String(address).toLowerCase();
      calls.push(`${a}:${functionName}`);
      // `fail` is lowercased wholesale on the way in, so the lookup has to be
      // too — otherwise "0x…:getPool" silently never matches and the outage
      // tests quietly assert nothing.
      if (fail.has(`${a}:${functionName}`.toLowerCase()) || fail.has(`${a}:*`)) {
        throw new Error(`fake read failure: ${functionName} @ ${a}`);
      }
      if (functionName === "getPool") {
        if (a !== FACTORY) throw new Error(`returned no data ("0x") for ${a}`);
        return findPoolFor(args[0], args[1], args[2]) ?? ZERO;
      }
      const pool = pools[a];
      if (pool) {
        if (functionName === "token0") return pool.token0;
        if (functionName === "token1") return pool.token1;
        if (functionName === "fee") return pool.fee;
        if (functionName === "liquidity") return pool.liquidity ?? 0n;
        if (functionName === "slot0") return [pool.sqrtPriceX96, pool.tick ?? 0, 0, 1, 1, 0, true];
        if (functionName === "tickSpacing") return tickLadder(pool).spacing;
        if (functionName === "tickBitmap") {
          const { spacing, net } = tickLadder(pool);
          const word = Number(args[0]);
          let bits = 0n;
          for (const t of net.keys()) {
            const compressed = Math.floor(t / spacing);
            if (Math.floor(compressed / 256) !== word) continue;
            bits |= 1n << BigInt(((compressed % 256) + 256) % 256);
          }
          return bits;
        }
        if (functionName === "ticks") {
          const { net } = tickLadder(pool);
          // An uninitialised tick answers with zeroes on the real contract too —
          // this getter never reverts, so the fake must not either.
          return [0n, net.get(Number(args[0])) ?? 0n, 0n, 0n, 0n, 0n, 0, net.has(Number(args[0]))];
        }
      }
      if (functionName === "decimals") {
        if (!(a in decimals)) throw new Error(`no decimals for ${a}`);
        return decimals[a];
      }
      if (functionName === "totalSupply") {
        if (!(a in supplies)) throw new Error(`no supply for ${a}`);
        return BigInt(supplies[a]);
      }
      if (functionName === "balanceOf") {
        const holder = String(args[0]).toLowerCase();
        const balances = spec.balances?.[holder] ?? {};
        const raw = Object.entries(balances).find(([t]) => t.toLowerCase() === a)?.[1];
        if (raw == null) throw new Error(`no balance for ${a} @ ${holder}`);
        return BigInt(raw);
      }
      throw new Error(`fake client: unhandled ${functionName} @ ${a}`);
    },
  };
}

/** Injected indexer calls. `holders` is a list of addresses, top-holder first. */
function fakeCalls({ holders, coinPrice = String(ETH_USD), statsFails = false, holdersFail = false } = {}) {
  return {
    async getStats() {
      if (statsFails) throw new Error("indexer down");
      return coinPrice === undefined ? {} : { coin_price: coinPrice };
    },
    async getTokenHolders() {
      if (holdersFail) throw new Error("indexer down");
      return { items: (holders ?? []).map((h) => ({ address: { hash: h } })) };
    },
  };
}

/**
 * VLADHOODS' POSITION IS A HAIR, and that is the whole point of this fixture.
 *
 * Measured on chain, the pool holds 0.002033 WETH and its liquidity() is enormous —
 * because the current price sits a FRACTION OF ONE TICK below the position's upper
 * bound. L is liquidity per unit of sqrt-price, so a position that narrow carries an
 * L that extrapolates to $366,536 of "in-range" reserve while holding $3.92. The
 * bounds below are the real tick spacing (60 at the 0.3% tier) with the current
 * tick 153779 sitting inside the last one, and the liquidity is set so the amount
 * the range actually holds is EXACTLY the 0.002033 WETH the pool's balance says it
 * holds — a fixture that could not describe a pool that cannot exist.
 */
const VLAD_TICK_LOWER = 153_720;
const VLAD_TICK_UPPER = 153_780;
const VLAD_L = 413888068841647431633006n;

/** The VLAD chain, exactly as measured: WETH is token0, VLAD is token1. */
function vladSpec(overrides = {}) {
  return {
    blockNumber: 1_234_567,
    decimals: { [WETH]: 18, [VLAD]: 18, ...(overrides.decimals ?? {}) },
    supplies: { [VLAD]: VLAD_SUPPLY_RAW },
    pools: {
      [VLAD_POOL]: {
        token0: WETH,
        token1: VLAD,
        fee: 3000,
        sqrtPriceX96: VLAD_SQRT,
        tick: 153779,
        liquidity: VLAD_L,
        positions: [{ lower: VLAD_TICK_LOWER, upper: VLAD_TICK_UPPER, liquidity: VLAD_L }],
      },
      ...(overrides.pools ?? {}),
    },
    // Measured: 900M VLAD against 0.00203 WETH. Deliberately lopsided.
    balances: {
      [VLAD_POOL]: { [VLAD]: "899990409252127352153120585", [WETH]: "2032777325389102" },
      ...(overrides.balances ?? {}),
    },
    ...(overrides.rest ?? {}),
  };
}

/** Relative-tolerance compare, for figures that go through a 20-digit mantissa. */
function close(actual, expected, rel = 1e-9, label = "") {
  assert.ok(
    typeof actual === "number" && Number.isFinite(actual),
    `${label} expected a finite number, got ${actual}`,
  );
  const drift = Math.abs(actual - expected) / Math.abs(expected);
  assert.ok(drift <= rel, `${label} ${actual} is ${drift} away from ${expected}`);
}

beforeEach(() => {
  resetDexCache();
  resetIndexerCache();
  delete process.env.UNISWAP_V3_QUOTE_TOKENS;
  delete process.env.UNISWAP_V3_FACTORY;
});

afterEach(() => {
  resetDexCache();
  resetIndexerCache();
  delete process.env.UNISWAP_V3_QUOTE_TOKENS;
  delete process.env.UNISWAP_V3_FACTORY;
});

/* ------------------------------ the anchor case --------------------------- */

test("the verified VLAD pool reproduces 2.0978e-7 WETH per token", async () => {
  const price = priceFromSqrtX96(VLAD_SQRT, 18, 18, false);
  close(price, 2.0977932235481013e-7, 1e-12, "VLAD/WETH");
});

test("priceFromPool prices VLAD end to end, through the factory", async () => {
  const client = fakeClient(vladSpec());
  const res = await priceFromPool(VLAD, { client, calls: fakeCalls() });

  assert.equal(res.ok, true);
  assert.equal(res.source, "uniswap_v3");
  assert.equal(res.pool, VLAD_POOL);
  assert.equal(res.fee, 3000);
  assert.equal(res.discovery, "factory");
  assert.equal(res.quote.address, WETH);
  assert.equal(res.quote.kind, "native");
  assert.equal(res.asOfBlock, 1_234_567);
  close(res.priceInQuote, 2.0977932235481013e-7, 1e-12, "priceInQuote");
  close(res.priceNative, 2.0977932235481013e-7, 1e-12, "priceNative");
  close(res.priceUsd, 0.000404978981805961, 1e-9, "priceUsd");
});

test("market cap on 1B tokens lands near $405K at ETH 1930.5", async () => {
  const client = fakeClient(vladSpec());
  const res = await tokenMarketData(VLAD, {
    client,
    calls: fakeCalls(),
    totalSupply: VLAD_SUPPLY_RAW,
    decimals: 18,
  });

  assert.equal(res.source, "uniswap_v3");
  close(res.marketCap, 404_978.98, 1e-6, "marketCap");
  close(res.price, 0.000404978981805961, 1e-9, "price");
  assert.equal(res.reason, undefined);
});

test("the caller's supply is used rather than re-read from the chain", async () => {
  // No totalSupply in the spec at all: a re-read would throw and lose the cap.
  const spec = vladSpec();
  delete spec.supplies;
  const client = fakeClient(spec);
  const res = await tokenMarketData(VLAD, {
    client,
    calls: fakeCalls(),
    totalSupply: VLAD_SUPPLY_RAW,
    decimals: 18,
  });
  close(res.marketCap, 404_978.98, 1e-6, "marketCap");
  assert.equal(
    client.calls.some((c) => c.endsWith(":totalSupply")),
    false,
    "should not have read totalSupply when the caller supplied it",
  );
});

/* --------------------------- decimals and ordering ------------------------ */

test("a 6-decimal quote against an 18-decimal token is corrected, not assumed", async () => {
  // The real WETH/USDG pool: token0 has 18 decimals, token1 has 6. Assuming 18
  // on both sides would be wrong by exactly 1e12.
  const perWeth = priceFromSqrtX96(USDG_SQRT, 18, 6, true);
  // Live ETH was ~1930; the pool has to agree to within a couple of percent or
  // the decimals correction is not being applied at all.
  assert.ok(perWeth > 1500 && perWeth < 2500, `USDG per WETH looked like ${perWeth}`);

  const naive = priceFromSqrtX96(USDG_SQRT, 18, 18, true);
  close(naive, perWeth / 1e12, 1e-12, "the uncorrected figure is 1e12 out");
});

test("token ordering inverts the price and nothing else", async () => {
  const asToken0 = priceFromSqrtX96(VLAD_SQRT, 18, 18, true);
  const asToken1 = priceFromSqrtX96(VLAD_SQRT, 18, 18, false);
  close(asToken1, 1 / asToken0, 1e-12, "inverse");
  close(asToken0, 4766913.657, 1e-6, "VLAD per WETH");
});

test("a pool with the target as token0 prices the same as its mirror", async () => {
  // Same pool state, target and quote swapped. The pricer must follow token0/
  // token1 off the contract, not the argument order it was called with.
  const MIRROR_TOKEN = "0x00000000000000000000000000000000000000a1";
  const MIRROR_POOL = "0x00000000000000000000000000000000000000b1";
  const client = fakeClient({
    blockNumber: 42,
    decimals: { [WETH]: 18, [MIRROR_TOKEN]: 18 },
    pools: {
      [MIRROR_POOL]: { token0: MIRROR_TOKEN, token1: WETH, fee: 3000, sqrtPriceX96: VLAD_SQRT, liquidity: 1n },
    },
    balances: { [MIRROR_POOL]: { [MIRROR_TOKEN]: "1", [WETH]: "1" } },
  });
  const res = await priceFromPool(MIRROR_TOKEN, { client, calls: fakeCalls() });
  assert.equal(res.ok, true);
  // Target is token0 here, so the pool figure is token1-per-token0 uninverted.
  close(res.priceInQuote, 4766913.657, 1e-6, "quote per target");
});

/* ------------------------------ quote assets ------------------------------ */

test("a stablecoin quote is accepted only when its own WETH pool proves the peg", async () => {
  const TOKEN = "0x00000000000000000000000000000000000000c1";
  const TOKEN_POOL = "0x00000000000000000000000000000000000000d1";
  // Price the token at 2 USDG. sqrt for token1-per-token0 = 2 with 18/6 decimals:
  // raw = 2 * 10^(6-18) = 2e-12, sqrtPriceX96 = sqrt(2e-12) * 2^96.
  const sqrt = BigInt(Math.floor(Math.sqrt(2e-12) * 2 ** 96));
  const client = fakeClient({
    blockNumber: 7,
    decimals: { [WETH]: 18, [USDG]: 6, [TOKEN]: 18 },
    pools: {
      [USDG_POOL]: { token0: WETH, token1: USDG, fee: 500, sqrtPriceX96: USDG_SQRT, liquidity: 725821910500262000n },
      [TOKEN_POOL]: { token0: TOKEN, token1: USDG, fee: 3000, sqrtPriceX96: sqrt, liquidity: 1n },
    },
    balances: { [TOKEN_POOL]: { [TOKEN]: "1000000000000000000", [USDG]: "2000000" } },
  });

  const res = await priceFromPool(TOKEN, { client, calls: fakeCalls() });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.quote.address, USDG, "should have used the stable quote");
  assert.equal(res.quote.kind, "stable");
  assert.equal(res.quote.verifiedBy, "weth_pool_peg_check");
  // 2 USDG, and USDG proved itself worth ~$1, so ~$2 — never $2 x 1930.
  close(res.priceUsd, 2, 0.02, "priceUsd");
  // The ETH leg is derived from the same two numbers, not a third source.
  close(res.priceNative, 2 / ETH_USD, 0.02, "priceNative");
});

test("ONE WEI of liquidity in a decoy at an earlier tier cannot capture the quote asset", async () => {
  // THE SATELLITE OF F1. verifyStableQuote used to RETURN INSIDE ITS FEE-TIER LOOP
  // — the exact shape removed from resolvePool — and its only bar was liquidity > 0.
  // Tier 3000 is read before 500, so one wei of L in a decoy USDG/WETH pool took
  // over the asset that sets the dollar value of every token priced through it, and
  // a decoy priced 100x off would have mispriced the lot.
  const TOKEN = "0x00000000000000000000000000000000000000c2";
  const TOKEN_POOL = "0x00000000000000000000000000000000000000d2";
  const USDG_DECOY = "0x00000000000000000000000000000000000dec02";
  const sqrt = BigInt(Math.floor(Math.sqrt(2e-12) * 2 ** 96));
  const client = fakeClient({
    blockNumber: 7,
    decimals: { [WETH]: 18, [USDG]: 6, [TOKEN]: 18 },
    pools: {
      // The real peg pool, at the LATER tier.
      [USDG_POOL]: { token0: WETH, token1: USDG, fee: 500, sqrtPriceX96: USDG_SQRT, liquidity: 725821910500262000n },
      // The decoy: earlier tier, one wei of L, and a price 100× off.
      [USDG_DECOY]: { token0: WETH, token1: USDG, fee: 3000, sqrtPriceX96: USDG_SQRT * 10n, liquidity: 1n },
      [TOKEN_POOL]: { token0: TOKEN, token1: USDG, fee: 3000, sqrtPriceX96: sqrt, liquidity: 1n },
    },
    balances: { [TOKEN_POOL]: { [TOKEN]: "1000000000000000000", [USDG]: "2000000" } },
  });

  const res = await priceFromPool(TOKEN, { client, calls: fakeCalls() });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.quote.address, USDG, "USDG is still a dollar, proved by its real pool");
  // The decoy priced ETH 100× off; had it been believed, USDG would have failed the
  // peg check outright and this token would have lost its price entirely.
  close(res.priceUsd, 2, 0.02, "and the token is still worth two dollars");
});

test("a stablecoin candidate whose every pool is dust is not a dollar at all", async () => {
  // The bar is a real quantity now, not "greater than zero". A candidate with a
  // perfectly-pegged price and nothing behind it does not get to define the dollar.
  const TOKEN = "0x00000000000000000000000000000000000000c3";
  const TOKEN_POOL = "0x00000000000000000000000000000000000000d3";
  const sqrt = BigInt(Math.floor(Math.sqrt(2e-12) * 2 ** 96));
  const client = fakeClient({
    blockNumber: 7,
    decimals: { [WETH]: 18, [USDG]: 6, [TOKEN]: 18 },
    pools: {
      [USDG_POOL]: { token0: WETH, token1: USDG, fee: 500, sqrtPriceX96: USDG_SQRT, liquidity: 1n },
      [TOKEN_POOL]: { token0: TOKEN, token1: USDG, fee: 3000, sqrtPriceX96: sqrt, liquidity: 1n },
    },
    balances: { [TOKEN_POOL]: { [TOKEN]: "1000000000000000000", [USDG]: "2000000" } },
  });

  const res = await priceFromPool(TOKEN, { client, calls: fakeCalls() });
  // No verified quote asset, so the token's only pool is against an unverified
  // token and there is nothing to price it in. Unpriced, not priced wrongly.
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no_pool");
});

test("A DoS ON THE USDG/WETH POOL IS UNREAD, NOT 'no_pool' — the G1 satellite", async () => {
  // THE WIDEST-BLAST-RADIUS VERSION OF THE SAME BUG. Knock over the quote asset's own
  // pool and USDG cannot be re-verified, so its fee tiers are never swept — and every
  // token that trades only against USDG used to come back "no_pool", a MEASURED
  // ABSENCE, which is not in POOL_UNREAD_REASONS and therefore silences every "we
  // could not look" guard downstream. One pool's outage asserting that a whole class
  // of tokens has no market is exactly what this codebase forbids.
  const TOKEN = "0x00000000000000000000000000000000000000c9";
  const TOKEN_POOL = "0x00000000000000000000000000000000000000d9";
  const sqrt = BigInt(Math.floor(Math.sqrt(2e-12) * 2 ** 96));
  const client = fakeClient({
    blockNumber: 7,
    decimals: { [WETH]: 18, [USDG]: 6, [TOKEN]: 18 },
    pools: {
      [USDG_POOL]: { token0: WETH, token1: USDG, fee: 500, sqrtPriceX96: USDG_SQRT, liquidity: 725821910500262000n },
      [TOKEN_POOL]: { token0: TOKEN, token1: USDG, fee: 3000, sqrtPriceX96: sqrt, liquidity: 1n },
    },
    balances: { [TOKEN_POOL]: { [TOKEN]: "1000000000000000000", [USDG]: "2000000" } },
    // The peg pool's ladder goes dark. Everything else on the chain is healthy.
    fail: [`${USDG_POOL}:tickBitmap`],
  });

  const res = await priceFromPool(TOKEN, { client, calls: fakeCalls({ holders: [] }) });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "quote_unverified", "unread — the USDG tiers were never swept");
  assert.notEqual(res.reason, "no_pool", "a pool that could not be measured is not an absence");
  assert.match(res.detail, /UNKNOWN/);
  assert.match(res.detail, /outage, not a token without a market/);

  // The control: the same chain with the pool readable prices the token fine, so the
  // reason above is about the outage and not about the fixture.
  resetDexCache();
  resetIndexerCache();
  const healthy = fakeClient({
    blockNumber: 7,
    decimals: { [WETH]: 18, [USDG]: 6, [TOKEN]: 18 },
    pools: {
      [USDG_POOL]: { token0: WETH, token1: USDG, fee: 500, sqrtPriceX96: USDG_SQRT, liquidity: 725821910500262000n },
      [TOKEN_POOL]: { token0: TOKEN, token1: USDG, fee: 3000, sqrtPriceX96: sqrt, liquidity: 1n },
    },
    balances: { [TOKEN_POOL]: { [TOKEN]: "1000000000000000000", [USDG]: "2000000" } },
  });
  const ok = await priceFromPool(TOKEN, { client: healthy, calls: fakeCalls({ holders: [] }) });
  assert.equal(ok.ok, true, ok.reason);
  close(ok.priceUsd, 2, 0.02, "two dollars, as before");
});

test("a token calling itself USDC is rejected as a quote when its pool disproves the peg", async () => {
  // The live impostor: symbol USDC, name "United States Dump Coin", a real WETH
  // pool, and a rate of 7.4e7 units per ETH. Symbol proves nothing; the pool does.
  const FAKE_USDC = "0xb36aaa5f814150d7c957ac946288af9e62648cd5";
  const FAKE_POOL = "0x15431309c9dac2c47591d65b426749560b648cb8";
  const TOKEN = "0x00000000000000000000000000000000000000e1";
  const TOKEN_POOL = "0x00000000000000000000000000000000000000f1";
  process.env.UNISWAP_V3_QUOTE_TOKENS = FAKE_USDC;

  // 7.4e7 fake-USDC per WETH, both 18 decimals.
  const sqrt = BigInt(Math.floor(Math.sqrt(7.401806e7) * 2 ** 96));
  const client = fakeClient({
    blockNumber: 9,
    decimals: { [WETH]: 18, [FAKE_USDC]: 18, [TOKEN]: 18 },
    pools: {
      [FAKE_POOL]: { token0: WETH, token1: FAKE_USDC, fee: 10000, sqrtPriceX96: sqrt, liquidity: 5n },
      // The only pool the token has is against the impostor.
      [TOKEN_POOL]: { token0: TOKEN, token1: FAKE_USDC, fee: 3000, sqrtPriceX96: VLAD_SQRT, liquidity: 1n },
    },
  });

  const res = await priceFromPool(TOKEN, { client, calls: fakeCalls() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no_pool", "an unverifiable quote must not price anything");
  assert.equal(res.priceUsd, undefined);
});

test("a stablecoin with a dead pool is not accepted, however well it is named", async () => {
  // Measured: USDE prices ETH at 1737 against a stats feed saying 1930, with zero
  // liquidity. Both halves of that are disqualifying on their own.
  const DEAD = "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34";
  const DEAD_POOL = "0x00000000000000000000000000000000000000aa";
  const sqrt = BigInt(Math.floor(Math.sqrt(1737.716) * 2 ** 96));
  const client = fakeClient({
    decimals: { [WETH]: 18, [DEAD]: 18 },
    pools: { [DEAD_POOL]: { token0: WETH, token1: DEAD, fee: 500, sqrtPriceX96: sqrt, liquidity: 0n } },
  });
  const { found } = await resolvePool(DEAD, { client, calls: fakeCalls() });
  // DEAD itself has no pool against a VERIFIED quote — its only pair is WETH,
  // which is verified, so it does resolve. The point is the reverse direction:
  assert.ok(found, "a WETH pair still resolves");
  assert.equal(found.quote.kind, "native", "and it is quoted in WETH, not in itself");
});

/* ------------------------------- discovery -------------------------------- */

test("the holder probe finds a pool the factory will not admit to", async () => {
  const spec = vladSpec();
  spec.pools[VLAD_POOL].hiddenFromFactory = true;
  const client = fakeClient(spec);
  const res = await priceFromPool(VLAD, {
    client,
    // The pool is the top holder of its own token, as measured.
    calls: fakeCalls({ holders: [VLAD_POOL, "0xb54500af7c3f9d7162adaa478b2329c3e9dbcc2c"] }),
  });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.pool, VLAD_POOL);
  assert.equal(res.discovery, "holder_probe", "a probe result must not be labelled a factory result");
  close(res.priceUsd, 0.000404978981805961, 1e-9, "priceUsd");
});

test("the holder probe is bounded and stops at the first real pool", async () => {
  const spec = vladSpec();
  spec.pools[VLAD_POOL].hiddenFromFactory = true;
  const client = fakeClient(spec);
  const decoys = Array.from({ length: 40 }, (_, i) => `0x${String(i).padStart(40, "0")}`);
  const res = await findPool(VLAD, {
    client,
    calls: fakeCalls({ holders: [...decoys, VLAD_POOL] }),
  });
  // Only the first MAX_HOLDER_PROBES holders are probed, and the pool is not
  // among them, so this is honestly a miss rather than a 40-address scan.
  assert.equal(res, null);
  const probes = client.calls.filter((c) => c.endsWith(":token0")).length;
  assert.ok(probes <= 10, `probed ${probes} candidates; the budget is a handful`);
});

test("a holder that answers token0/token1/fee but pairs nothing we know is not a pool", async () => {
  const IMPOSTOR = "0x00000000000000000000000000000000000000b9";
  const OTHER = "0x00000000000000000000000000000000000000ba";
  const spec = vladSpec();
  spec.pools[VLAD_POOL].hiddenFromFactory = true;
  spec.pools[IMPOSTOR] = { token0: VLAD, token1: OTHER, fee: 3000, sqrtPriceX96: VLAD_SQRT, hiddenFromFactory: true };
  spec.decimals[OTHER] = 18;
  const client = fakeClient(spec);
  const res = await findPool(VLAD, { client, calls: fakeCalls({ holders: [IMPOSTOR, VLAD_POOL] }) });
  assert.equal(res.pool, VLAD_POOL, "the pair against an unverified asset must be skipped");
});

/* --------------------- the decoy pool, and picking the deepest ------------ */

/**
 * The Green Bull, as measured live: its REAL pool is at fee tier 10000 and its
 * 3000 slot is EMPTY. That is what makes it the exact shape of the attack —
 * UniswapV3Factory.createPool is permissionless, 3000 is probed before 10000, and
 * one gas-only transaction from anybody at all used to redirect the whole
 * measurement onto an empty pool.
 */
const BULL = "0x31be8f7485e36928c9de86566c62da82d4b6bf81";
const BULL_POOL = "0x8f450b8ee34f07681b68bbb97729fcd4e8778417";
const BULL_SQRT = 226289476468206038830300558568184n;
const BULL_L = 38135985722764537379406n;
const BULL_TICK = 159_152;
/** 36.256 WETH held by the real pool — $69,992 at ETH 1930.5. */
const BULL_WETH_BALANCE = "36256000000000000000";
/**
 * THE BAND DEPTH THAT FALLS OUT OF THAT STATE, computed from the ladder and checked
 * against the live pool.
 *
 * The Green Bull's liquidity is one wide range with no initialised tick anywhere
 * near the market, so the whole band sits inside it: 0.685187 WETH realisable
 * before the price has moved 10%, and 0.134196 WETH before it has moved 2%. At the
 * fixture's ETH/USD of 1930.5 that is $1,322.75 and $259.06 — and the same code
 * against the live pool on chain 4663 reported $1,324.13 and $259.33 at ETH
 * 1932.97, which is the same figure to within the ETH move between the two reads.
 *
 * COMPARE THE TWO NUMBERS THIS REPLACES: $69,992 of WETH HELD, and $25,922 of
 * "in-range" reserve extrapolated from L. The pool is the same pool; those two were
 * measuring how much capital is present and how much a hypothetical uniform curve
 * would imply, and this one measures what a seller could actually get.
 */
const BULL_BAND_WETH = 0.685186723869438;
const BULL_TIGHT_WETH = 0.134195559143942;
const DECOY_POOL = "0x000000000000000000000000000000000000dec0";

function bullSpec(extraPools = {}, extraBalances = {}) {
  return {
    blockNumber: 9_000_001,
    decimals: { [WETH]: 18, [BULL]: 18 },
    supplies: { [BULL]: "1000000000000000000000000000" },
    pools: {
      [BULL_POOL]: {
        token0: WETH,
        token1: BULL,
        fee: 10000,
        sqrtPriceX96: BULL_SQRT,
        tick: BULL_TICK,
        liquidity: BULL_L,
      },
      ...extraPools,
    },
    balances: {
      [BULL_POOL]: { [BULL]: "500000000000000000000000000", [WETH]: BULL_WETH_BALANCE },
      ...extraBalances,
    },
  };
}

test("the real pool is found at tier 10000 with no decoy in the way", async () => {
  // The control for the two tests below: this is the answer that must not change.
  const res = await priceFromPool(BULL, { client: fakeClient(bullSpec()), calls: fakeCalls() });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.pool, BULL_POOL);
  assert.equal(res.fee, 10000);
  assert.equal(res.poolCount, 1);
  // THE RANKING FIGURE IS THE -2% BAND. The -10% figure is context beside it, and is
  // deliberately not what anything ranks on: capital at the far edge of a 10% band
  // counts toward it in full and is never traded through.
  close(res.quoteLiquidityUsd, BULL_TIGHT_WETH * ETH_USD, 1e-6, "ranking depth (-2%)");
  assert.equal(res.depthBandBps, 200);
  close(res.wideDepthUsd, BULL_BAND_WETH * ETH_USD, 1e-6, "and the -10% band beside it, as context");
  assert.equal(res.wideBandBps, 1000);
  assert.equal(res.depthIsLowerBound, false, "the whole band fitted the read budget");
  close(res.quoteBalanceUsd, 69_992, 1e-3, "and what it HOLDS is a third figure again");
  // The band figure is the ONE that ranks. Held is 270× larger and must never be it.
  assert.ok(res.quoteBalanceUsd > res.quoteLiquidityUsd * 250);
  assert.equal(res.thinLiquidity, false, "$259 clears the re-expressed $200 floor, barely");
});

test("an empty decoy pool at an earlier fee tier cannot capture the probe", async () => {
  // THE F1 REGRESSION, and the whole cost of the attack: one createPool call at
  // tier 3000, no capital, no ownership of the token. The old resolver returned
  // inside the loop on the first tier that existed, so this took the measured depth
  // from $69,992 to a MEASURED ZERO — not a null, so every "unmeasured" guard
  // downstream stayed silent — and flipped the ticker verdict to "shallow".
  const client = fakeClient(
    bullSpec(
      {
        [DECOY_POOL]: {
          token0: WETH,
          token1: BULL,
          fee: 3000,
          sqrtPriceX96: BULL_SQRT,
          tick: BULL_TICK,
          liquidity: 0n,
        },
      },
      { [DECOY_POOL]: { [BULL]: "0", [WETH]: "0" } },
    ),
  );
  const res = await priceFromPool(BULL, { client, calls: fakeCalls() });

  assert.equal(res.ok, true, res.reason);
  assert.equal(res.pool, BULL_POOL, "the funded pool wins on the only axis that decides");
  assert.equal(res.fee, 10000);
  assert.equal(res.poolCount, 2, "and the reader is told there were two");
  close(res.quoteLiquidityUsd, BULL_TIGHT_WETH * ETH_USD, 1e-6, "depth is unchanged by the decoy");
  assert.notEqual(res.quoteLiquidityUsd, 0);
});

/**
 * THE G1 PAYLOAD, and the rule that now stops it: when the pool we would have chosen
 * cannot be read, there is NO PRICE — not a price from whichever pool answered.
 *
 * The three-class order this replaces preferred an unmeasured pool over a measured
 * ZERO, which rescued exactly one case and lost every other: any decoy holding a
 * POSITIVE amount outranked the unread pool. Measured, $4.5e-12 of band depth in a
 * decoy was enough to take the price, reporting the token 100× wrong with a $40.48M
 * cap against a real $405K — and an ordinary partial brownout was all it took to arm.
 */
function unreadableRealPoolSpec(decoyDepth) {
  const spec = bullSpec(
    {
      [DECOY_POOL]: {
        token0: WETH,
        token1: BULL,
        fee: 3000,
        // A price 100× off is the payload: capture the probe and the token is
        // repriced, which is the whole point of deploying the decoy.
        sqrtPriceX96: BULL_SQRT / 10n,
        tick: BULL_TICK - 46_052,
        liquidity: decoyDepth,
      },
    },
    { [DECOY_POOL]: { [BULL]: "0", [WETH]: "0" } },
  );
  spec.fail = [`${BULL_POOL}:tickBitmap`];
  return spec;
}

test("A DUST DECOY MAY NOT SET THE PRICE WHEN THE REAL POOL WENT UNREAD", async () => {
  // 1 wei of liquidity: a POSITIVE measured depth, and absurdly small. Under the old
  // three-class order this beat the unread real pool outright.
  const res = await priceFromPool(BULL, { client: fakeClient(unreadableRealPoolSpec(1n)), calls: fakeCalls() });

  assert.equal(res.ok, false, "an outage may not be answered with somebody else's pool");
  assert.equal(res.reason, "pool_read_failed");
  assert.equal(res.priceUsd, undefined, "and certainly not with a price 100× wrong");
  assert.equal(res.pool, undefined);
});

test("an EMPTY decoy beside an unread real pool is the same answer, for the same reason", async () => {
  // The case the deleted rule existed for. It is covered by refusing to choose,
  // rather than by a preference ordering that a positive dust figure walks straight
  // past — and the outcome is honest either way: the price is unavailable.
  const res = await priceFromPool(BULL, { client: fakeClient(unreadableRealPoolSpec(0n)), calls: fakeCalls() });

  assert.equal(res.ok, false);
  assert.equal(res.reason, "pool_read_failed");
  assert.match(res.detail, /could not be read/);
});

test("71 DUST MINTS INTO A VICTIM'S POOL CAP THE FIGURE AND CANNOT CAPTURE THE PRICE", async () => {
  // THE G1 ATTACK END TO END. UniswapV3Pool.mint is permissionless: anybody can add
  // positions to a pool for a token they have nothing to do with. 71 one-tick dust
  // mints at the 0.01% tier pushed the victim past MAX_TICKS_READ, the read REFUSED,
  // and the pool went UNMEASURED — at which point the old three-class order handed
  // the price to any decoy holding a positive amount.
  const FINE_POOL = "0x0000000000000000000000000000000000000f1e";
  const dust = Array.from({ length: 71 }, (_, i) => ({
    lower: BULL_TICK + 1 + i * 2,
    upper: BULL_TICK + 2 + i * 2,
    liquidity: 1n,
  }));
  const client = fakeClient({
    blockNumber: 9_000_002,
    decimals: { [WETH]: 18, [BULL]: 18 },
    supplies: { [BULL]: "1000000000000000000000000000" },
    pools: {
      // The victim's real market, at the 0.01% tier where the spacing is 1 and the
      // griefing is cheapest.
      [FINE_POOL]: {
        token0: WETH,
        token1: BULL,
        fee: 100,
        sqrtPriceX96: BULL_SQRT,
        tick: BULL_TICK,
        liquidity: BULL_L,
        positions: [{ lower: BULL_TICK - 50_000, upper: BULL_TICK + 50_000, liquidity: BULL_L }, ...dust],
      },
      // The decoy that used to inherit the capture: an earlier tier, a price 100×
      // off, and a positive — absurdly small — measured depth.
      [DECOY_POOL]: {
        token0: WETH,
        token1: BULL,
        fee: 3000,
        sqrtPriceX96: BULL_SQRT / 10n,
        tick: BULL_TICK - 46_052,
        liquidity: 1n,
      },
    },
    balances: {
      [FINE_POOL]: { [BULL]: "500000000000000000000000000", [WETH]: BULL_WETH_BALANCE },
      [DECOY_POOL]: { [BULL]: "0", [WETH]: "0" },
    },
  });

  const res = await priceFromPool(BULL, { client, calls: fakeCalls() });

  assert.equal(res.ok, true, res.reason);
  assert.equal(res.pool, FINE_POOL, "the decoy must not inherit an outage it manufactured");
  assert.equal(res.depthIsLowerBound, true, "the griefed pool reports a floor, not a refusal");
  assert.ok(res.quoteLiquidityUsd > 0, "a lower bound, never a null and never a zero");
  // The decoy's price is 100× off — that is the payload, and it is not what was used.
  close(res.priceUsd, 0.00023664659397038684, 1e-9, "the honest pool's price, not the decoy's");
  assert.ok(res.priceUsd > 0.0001, "a captured probe would have reported ~1/100th of this");

  // …and the bound still buries what the decoy reports IN FULL. That is the property
  // that makes truncation safe: dust can shorten the range and nothing else.
  resetDexCache();
  resetIndexerCache();
  const decoyOnly = await priceFromPool(BULL, {
    client: fakeClient({
      blockNumber: 9_000_003,
      decimals: { [WETH]: 18, [BULL]: 18 },
      pools: {
        [DECOY_POOL]: {
          token0: WETH,
          token1: BULL,
          fee: 3000,
          sqrtPriceX96: BULL_SQRT / 10n,
          tick: BULL_TICK - 46_052,
          liquidity: 1n,
        },
      },
      balances: { [DECOY_POOL]: { [BULL]: "0", [WETH]: "0" } },
    }),
    calls: fakeCalls(),
  });
  assert.equal(decoyOnly.depthIsLowerBound, false, "the decoy's own figure is exact");
  assert.ok(
    res.quoteLiquidityUsd > decoyOnly.quoteLiquidityUsd * 1e6,
    `griefed floor ${res.quoteLiquidityUsd} still buries ${decoyOnly.quoteLiquidityUsd}`,
  );
});

/* ------------------ O1: the flag has to reach the comparison ---------------- */

/**
 * THE VICTIM'S POOL AT THE ONE TIER WHERE THE RANKING FIGURE CAN TRUNCATE.
 *
 * The rank band is ~202 ticks wide, and MAX_TICKS_READ is 24 — so a pool can only be
 * capped inside it when 24 tick positions fit in 202 ticks, which among the standard
 * tiers means spacing 1, the 0.01% tier, ALONE. The Green Bull's own pool (fee 10000,
 * spacing 200) and the USDG peg pool (fee 500, spacing 10) cannot be reached this way
 * at all. Real tokens do live there: The Robinhood 0xfd58…d409, 52,214 holders, has its
 * only pool at that tier.
 *
 * The geometry below is the live Green Bull's, moved to spacing 1: clean it measures
 * $259.06 over the -2% band, and 25 gas-only dust mints cap it to $31.26 — an 8.29×
 * understatement, covering the 0.2424% nearest the market instead of 2%.
 */
const FINE_POOL = "0x0000000000000000000000000000000000000f1e";
const DUST_25 = Array.from({ length: 25 }, (_, i) => ({
  lower: BULL_TICK + 1 + i * 2,
  upper: BULL_TICK + 2 + i * 2,
  liquidity: 1n,
}));
/** The capped figure that geometry produces, in dollars at the fixture's ETH/USD. */
const BULL_CAPPED_USD = 31.262561058474652;

function griefedSpec(decoyLiquidity) {
  return {
    blockNumber: 9_000_010,
    decimals: { [WETH]: 18, [BULL]: 18 },
    supplies: { [BULL]: "1000000000000000000000000000" },
    pools: {
      [FINE_POOL]: {
        token0: WETH,
        token1: BULL,
        fee: 100,
        sqrtPriceX96: BULL_SQRT,
        tick: BULL_TICK,
        liquidity: BULL_L,
        positions: [{ lower: BULL_TICK - 50_000, upper: BULL_TICK + 50_000, liquidity: BULL_L }, ...DUST_25],
      },
      // The decoy: a price 100× off, and a real — tiny — amount of capital placed
      // IN BAND, which is the only place it counts. No dust, so its own figure is exact.
      [DECOY_POOL]: {
        token0: WETH,
        token1: BULL,
        fee: 3000,
        sqrtPriceX96: BULL_SQRT / 10n,
        tick: BULL_TICK - 46_052,
        liquidity: decoyLiquidity,
      },
    },
    balances: {
      [FINE_POOL]: { [BULL]: "500000000000000000000000000", [WETH]: BULL_WETH_BALANCE },
      [DECOY_POOL]: { [BULL]: "1000000000000000000", [WETH]: "10000000000000000000" },
    },
  };
}

test("O1: A LOWER BOUND THAT SORTS SECOND HAS NOT BEEN SHOWN TO LOSE", async () => {
  // THE ATTACK, END TO END. lib/tick-depth.js caps rather than refuses and labels the
  // figure honestly; lib/depth-rank.js already reasons about that label. The pool
  // SELECTION in this module did not — deeperPool and measuredDepth ranked on
  // rankDepthUsd alone — so a bound that WON was safe and a bound that LOST was
  // treated as an exact figure that lost.
  //
  // Cost of the capture: ~25 gas-only dust mints into a pool the attacker has nothing
  // to do with, plus $31.32 of real in-band capital in a decoy at another tier. The
  // payload is a price 100× wrong ($236,646 of cap read as $23,664,659) reported with
  // NO FLAG ANYWHERE — the honest pool simply vanished from the ranking.
  const client = fakeClient(griefedSpec(461n * 10n ** 18n));
  const res = await priceFromPool(BULL, { client, calls: fakeCalls() });

  assert.equal(res.ok, false, "an unresolved comparison may not be answered with a price");
  assert.equal(res.reason, "depth_inconclusive");
  assert.equal(res.priceUsd, undefined, "and certainly not with the decoy's price");
  assert.equal(res.pool, undefined, "no pool was selected, because none was shown to be deepest");
  assert.match(res.detail, /LOWER BOUND/);
  assert.match(res.detail, /Every pool was read/, "not an outage — nothing failed");
  assert.notEqual(res.reason, "no_pool", "and certainly not an absence");

  // THE TEST HAS TO BITE. Measured on its own, the decoy really does out-sort the
  // capped victim — which is the whole capture, and the reason refusing is the only
  // honest outcome rather than a precaution against a case that cannot arise.
  resetDexCache();
  resetIndexerCache();
  const victimOnly = await priceFromPool(BULL, {
    client: fakeClient({
      ...griefedSpec(1n),
      pools: { [FINE_POOL]: griefedSpec(1n).pools[FINE_POOL] },
      balances: { [FINE_POOL]: griefedSpec(1n).balances[FINE_POOL] },
    }),
    calls: fakeCalls(),
  });
  assert.equal(victimOnly.ok, true, victimOnly.reason);
  assert.equal(victimOnly.depthIsLowerBound, true, "the dust capped it, and it says so");
  close(victimOnly.quoteLiquidityUsd, BULL_CAPPED_USD, 1e-9, "the capped figure");
  close(
    BULL_TIGHT_WETH * ETH_USD,
    BULL_CAPPED_USD * 8.287,
    1e-3,
    "8.29x understated — the whole leverage the attacker buys",
  );

  resetDexCache();
  resetIndexerCache();
  const decoyOnly = await priceFromPool(BULL, {
    client: fakeClient({
      ...griefedSpec(461n * 10n ** 18n),
      pools: { [DECOY_POOL]: griefedSpec(461n * 10n ** 18n).pools[DECOY_POOL] },
      balances: { [DECOY_POOL]: griefedSpec(461n * 10n ** 18n).balances[DECOY_POOL] },
    }),
    calls: fakeCalls(),
  });
  assert.equal(decoyOnly.depthIsLowerBound, false, "the decoy's own figure is exact");
  assert.ok(
    decoyOnly.quoteLiquidityUsd > victimOnly.quoteLiquidityUsd,
    `the decoy's ${decoyOnly.quoteLiquidityUsd} really does out-sort the capped ${victimOnly.quoteLiquidityUsd}`,
  );
  assert.ok(decoyOnly.quoteLiquidityUsd < 32, "on about $31.32 of capital");
  // The payload, stated in the units a reader would see: 100× too EXPENSIVE, which is
  // a $236,646 market cap reported as $23,664,659.
  close(decoyOnly.priceUsd, victimOnly.priceUsd * 100, 1e-3, "the decoy prices the token 100x high");
});

test("O1: A LOWER BOUND THAT BEATS THE FIELD STILL WINS OUTRIGHT — unchanged", async () => {
  // THE OTHER HALF, AND IT MUST NOT MOVE. A floor above the whole field is decisive:
  // the true figure is at least the bound, every rival is exact, so the separation
  // holds a fortiori. Refusing here as well would hand the attacker the same denial
  // the truncation fix removed — dust would once again decide whether a victim's pool
  // is usable, just through a different door.
  const client = fakeClient(griefedSpec(10n ** 20n)); // ~$6.79 exact, well under the floor
  const res = await priceFromPool(BULL, { client, calls: fakeCalls() });

  assert.equal(res.ok, true, res.reason);
  assert.equal(res.pool, FINE_POOL, "the capped honest pool is still chosen");
  assert.equal(res.poolCount, 2);
  assert.equal(res.depthIsLowerBound, true, "and its figure still travels labelled");
  close(res.quoteLiquidityUsd, BULL_CAPPED_USD, 1e-9, "at least this much");
  close(res.priceUsd, 0.00023664659397038684, 1e-9, "the honest pool's price, not the decoy's");
  // Below the $200 floor, but a bound may not establish thinness — it counts upward.
  assert.equal(res.thinLiquidity, null, "neither thin nor deep: a floor cannot show an absence");
  // AND THE CAPPED WALK NAMES WHAT IT COVERS, so the layer above can say so.
  close(res.depthCoveredBandBps, 24.242147821362803, 1e-9, "0.2424% of the 2% band");
});

test("O1: A BOUNDED PEG-POOL FIGURE BELOW THE BAR IS UNREAD, NOT 'not a dollar'", async () => {
  // verifyStableQuote compared a possibly-truncated rankDepthUsd against
  // MIN_STABLE_QUOTE_DEPTH_USD as though it were exact. A figure that only counts
  // upward can show a pool CLEARS the bar and can never show it does not — so dust
  // minted into the peg pool's tick range would have demoted a real dollar to a
  // stated "not a dollar", and every token priced only through it to "no_pool", a
  // MEASURED ABSENCE. The bar is the widest blast radius any measurement here has.
  const TOKEN = "0x00000000000000000000000000000000000000ca";
  const TOKEN_POOL = "0x00000000000000000000000000000000000000da";
  const sqrt = BigInt(Math.floor(Math.sqrt(2e-12) * 2 ** 96));
  // The peg pool moved to the 0.01% tier — the only one whose ranking figure can
  // truncate — carrying $2,000.04 of real depth, five times the $400 bar.
  const PEG_TICK = -200_648;
  const PEG_L = 4_533_000_000_000_000n;
  const pegDust = Array.from({ length: 25 }, (_, i) => ({
    lower: PEG_TICK + 1 + i * 2,
    upper: PEG_TICK + 2 + i * 2,
    liquidity: 1n,
  }));
  const chain = (positions) => ({
    blockNumber: 7,
    decimals: { [WETH]: 18, [USDG]: 6, [TOKEN]: 18 },
    pools: {
      [USDG_POOL]: {
        token0: WETH,
        token1: USDG,
        fee: 100,
        sqrtPriceX96: USDG_SQRT,
        tick: PEG_TICK,
        liquidity: PEG_L,
        positions,
      },
      [TOKEN_POOL]: { token0: TOKEN, token1: USDG, fee: 3000, sqrtPriceX96: sqrt, liquidity: 1n },
    },
    balances: { [TOKEN_POOL]: { [TOKEN]: "1000000000000000000", [USDG]: "2000000" } },
  });

  // 25 dust mints cap the peg pool's ranking figure to ~$246.90 — under the $400 bar,
  // and a LOWER BOUND, so nothing about the candidate has been established.
  const res = await priceFromPool(TOKEN, { client: fakeClient(chain(pegDust)), calls: fakeCalls({ holders: [] }) });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "quote_unverified", "the question is open, not answered 'no'");
  assert.notEqual(res.reason, "no_pool", "a bound below the bar is not a proven absence");
  assert.match(res.detail, /UNKNOWN/);

  // THE CONTROL, and it is what makes the assertion above about the bound rather than
  // about the fixture: the same chain with no dust reads $2,000 exact, clears the bar,
  // and prices the token at two dollars.
  resetDexCache();
  resetIndexerCache();
  const clean = await priceFromPool(TOKEN, { client: fakeClient(chain([])), calls: fakeCalls({ holders: [] }) });
  assert.equal(clean.ok, true, clean.reason);
  assert.equal(clean.quote.address, USDG, "USDG is a dollar when its pool is read in full");
  close(clean.priceUsd, 2, 0.02, "two dollars");

  // AND A CANDIDATE THAT IS GENUINELY DUST IS STILL REJECTED OUTRIGHT. The exact
  // reading is a stated negative and must not be softened into "unread" as well —
  // that would make the bar unenforceable.
  resetDexCache();
  resetIndexerCache();
  const dustPeg = chain([]);
  dustPeg.pools[USDG_POOL].liquidity = 1n;
  const rejected = await priceFromPool(TOKEN, { client: fakeClient(dustPeg), calls: fakeCalls({ holders: [] }) });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "no_pool", "read, exact, and genuinely too thin to be the dollar");
});

test("a LONE pool whose ladder failed still prices — nothing was chosen over anything", async () => {
  // The limit of the rule, stated: it is about SELECTION. With one candidate there is
  // no choice being made, so an unreadable ladder costs the DEPTH figure and not the
  // price, exactly as it always has.
  const spec = bullSpec();
  spec.fail = [`${BULL_POOL}:tickBitmap`];
  const res = await priceFromPool(BULL, { client: fakeClient(spec), calls: fakeCalls() });

  assert.equal(res.ok, true, res.reason);
  assert.equal(res.pool, BULL_POOL);
  assert.equal(res.quoteLiquidityUsd, null, "depth is honestly unknown");
  assert.equal(res.thinLiquidity, null, "which is neither thin nor deep");
});

test("of two FUNDED pools the deeper one is priced, whichever tier sorts first", async () => {
  // The case with no coverage at all before: a token with two real pools where the
  // SHALLOW one is probed first. Tier 3000 leads FEE_TIERS, so first-hit selection
  // would take the $19 pool and leave the $25.8K one unread.
  const SHALLOW_POOL = "0x0000000000000000000000000000000000005a10";
  const shallow = {
    token0: WETH,
    token1: BULL,
    fee: 3000,
    sqrtPriceX96: BULL_SQRT,
    tick: BULL_TICK,
    liquidity: BULL_L / 2_600n,
  };
  const client = fakeClient(
    bullSpec(
      { [SHALLOW_POOL]: shallow },
      { [SHALLOW_POOL]: { [BULL]: "1000000000000000000000", [WETH]: "10000000000000000" } },
    ),
  );
  const res = await priceFromPool(BULL, { client, calls: fakeCalls() });

  assert.equal(res.pool, BULL_POOL, "the deeper pool, not the earlier tier");
  assert.equal(res.fee, 10000);
  assert.equal(res.poolCount, 2);
  close(res.quoteLiquidityUsd, BULL_TIGHT_WETH * ETH_USD, 1e-6, "and its depth, not the shallow pool's");

  // …and the ordering is a MEASUREMENT, not a preference for tier 10000: make the
  // 3000 pool the deep one and it wins instead.
  resetDexCache();
  resetIndexerCache();
  const flipped = fakeClient({
    ...bullSpec(),
    pools: {
      [BULL_POOL]: { ...shallow, fee: 10000 },
      [SHALLOW_POOL]: { token0: WETH, token1: BULL, fee: 3000, sqrtPriceX96: BULL_SQRT, tick: BULL_TICK, liquidity: BULL_L },
    },
    balances: {
      [BULL_POOL]: { [BULL]: "1000000000000000000000", [WETH]: "10000000000000000" },
      [SHALLOW_POOL]: { [BULL]: "500000000000000000000000000", [WETH]: BULL_WETH_BALANCE },
    },
  });
  const res2 = await priceFromPool(BULL, { client: flipped, calls: fakeCalls() });
  assert.equal(res2.pool, SHALLOW_POOL, "the deep pool at tier 3000 now wins");
  assert.equal(res2.fee, 3000);
});

/* ---------------------- depth that cannot actually trade ------------------ */

/**
 * THE PARKED-POSITION ATTACK, priced. WETH is token0 in these pools, so a position
 * whose range sits ABOVE the current tick is 100% WETH: it contributes NOTHING to
 * liquidity(), sits in full in balanceOf, and is withdrawable at any moment. Under
 * the old min(balance, in-range·L) measure, parking 36.25 WETH behind a $3.94 pool
 * reported $69,994 of "depth" — the minimum of a parked balance and a huge
 * extrapolation is the parked balance. 135 WETH bought the VLAD ticker outright for
 * about $28 a day of opportunity cost.
 */
const PARKED_POOL = "0x0000000000000000000000000000000000009a2c";

/** A pool holding 36.25 WETH entirely in one position `distance` ticks away. */
function parkedSpec(distance) {
  const lower = Math.ceil((BULL_TICK + distance) / 200) * 200;
  return {
    blockNumber: 5,
    decimals: { [WETH]: 18, [BULL]: 18 },
    pools: {
      [PARKED_POOL]: {
        token0: WETH,
        token1: BULL,
        fee: 10000,
        sqrtPriceX96: BULL_SQRT,
        tick: BULL_TICK,
        // Zero ACTIVE liquidity: the position does not span the current tick.
        liquidity: 0n,
        positions: [{ lower, upper: lower + 200, liquidity: BULL_L * 40n }],
      },
    },
    balances: { [PARKED_POOL]: { [BULL]: "500000000000000000000000000", [WETH]: BULL_WETH_BALANCE } },
  };
}

test("WETH parked OUTSIDE the band is held, not depth, and cannot be rented into a ranking", async () => {
  // 5,000 ticks above the market is ~65% away — far outside the 10% band, and the
  // only place the capital is genuinely free to sit, because inside the band a
  // seller can trade against it.
  const res = await priceFromPool(BULL, { client: fakeClient(parkedSpec(5_000)), calls: fakeCalls() });

  assert.equal(res.ok, true, res.reason);
  assert.equal(res.quoteLiquidityUsd, 0, "the band is empty: nothing is realisable in it");
  close(res.quoteBalanceUsd, 69_992, 1e-3, "though the pool really does HOLD that much");
  assert.equal(res.thinLiquidity, true, "and $0 of realisable depth is thin, not deep");
});

test("the same capital moved INSIDE the band counts, because there it can be traded against", async () => {
  // The other half of the claim, and the reason the fix is structural rather than a
  // patch: nothing here detects an attacker. Capital placed where a seller can
  // reach it IS depth — that is what depth means — and the cost of looking deep is
  // now exposure at the market price rather than a refundable parked deposit.
  // Distance 0 puts the position 48 ticks above spot, well inside the -2% band.
  const res = await priceFromPool(BULL, { client: fakeClient(parkedSpec(0)), calls: fakeCalls() });

  assert.equal(res.ok, true, res.reason);
  assert.ok(res.quoteLiquidityUsd > 1_000, `in-band liquidity is depth: ${res.quoteLiquidityUsd}`);
  // …and still only what the range actually holds, never an extrapolation of L.
  assert.ok(res.quoteLiquidityUsd < res.quoteBalanceUsd, "and never more than the pool holds");
});

test("BAND-EDGE PLACEMENT BUYS THE WIDE FIGURE AND NOTHING THAT RANKS — the G2 regression", async () => {
  // THE ATTACK, PRICED. $1,324 of single-sided WETH one tick-spacing wide at -9.16%
  // used to count IN FULL toward the ranking figure, which was the -10% band — enough
  // to match The Green Bull's real $1,324.23 headline for capital parked where
  // nothing will ever trade through it, withdrawable at any block, and consumable
  // only by somebody selling the squatter's own token.
  //
  // One tick-spacing wide at 848–1,048 ticks above spot: -8.1% to -9.95% for a
  // token0-quoted pool, straddling the -9.16% the attack was measured at, and inside
  // the -10% band's ~1,054 ticks. The ranking band is ~202 ticks, so the position
  // sits far outside it and the ranking figure is untouched — which is the entire
  // reason the ranking moved to the tight band.
  const res = await priceFromPool(BULL, { client: fakeClient(parkedSpec(700)), calls: fakeCalls() });

  assert.equal(res.ok, true, res.reason);
  assert.equal(res.quoteLiquidityUsd, 0, "the edge position lifts the RANKING figure not at all");
  assert.ok(res.wideDepthUsd > 1_000, `and the wide figure it does lift is context only: ${res.wideDepthUsd}`);
  // The pool really does hold the money — that figure was never in dispute, and it is
  // reported as what it is.
  close(res.quoteBalanceUsd, 69_992, 1e-3, "held is a third quantity again");
  assert.equal(res.thinLiquidity, true, "$0 realisable near the market is thin, whatever sits at the edge");
});

test("a HAIR-WIDTH position contributes only what it holds, never its extrapolated L", async () => {
  // THE OTHER HALF OF F2. Vladhoods' single position is a fraction of one tick
  // wide, so its L extrapolates to $366,536 of "in-range" reserve behind $3.92 of
  // WETH — 93,073×. The integration stops at the position's UPPER TICK, so it can
  // only ever contribute the 0.002033 WETH that range really holds.
  const res = await priceFromPool(VLAD, { client: fakeClient(vladSpec()), calls: fakeCalls() });
  close(res.quoteLiquidityUsd, 3.9242766, 1e-5, "exactly what the range holds");
  close(res.quoteBalanceUsd, 3.9242766, 1e-5, "which is also all the pool has");
  // The extrapolation that USED to be reported here, for scale.
  const extrapolated = Number((VLAD_L * 2n ** 96n) / VLAD_SQRT) / 1e18 * ETH_USD;
  assert.ok(extrapolated > 300_000, `the old figure would have been ${extrapolated}`);
  assert.ok(res.quoteLiquidityUsd < extrapolated / 90_000, "and the ladder reports 1/93,000th of it");
});

test("depth is null, never zero, when the tick ladder cannot be read", async () => {
  // An unreadable bitmap word is an unread ladder. It must NOT fall back to the
  // balance — that is the rentable figure — and must not degrade to a zero.
  for (const broken of ["tickBitmap", "ticks", "tickSpacing", "liquidity"]) {
    resetDexCache();
    resetIndexerCache();
    const client = fakeClient({ ...vladSpec(), fail: [`${VLAD_POOL}:${broken}`] });
    const res = await priceFromPool(VLAD, { client, calls: fakeCalls() });
    assert.equal(res.ok, true, `${broken}: the PRICE is still readable`);
    assert.equal(res.quoteLiquidityUsd, null, `${broken}: depth is unknown, not zero`);
    assert.equal(res.thinLiquidity, null, `${broken}: unknown is neither thin nor deep`);
    // The balance is still reported — as the separate, labelled quantity it is.
    close(res.quoteBalanceUsd, 3.9242766, 1e-5, `${broken}: held is still readable`);
  }
});

/* -------------------------- the four distinct failures -------------------- */

test("no pool anywhere is 'no_pool' — and never a price of zero", async () => {
  const LONELY = "0x0000000000000000000000000000000000000ca1";
  const client = fakeClient({ decimals: { [WETH]: 18, [LONELY]: 18 }, pools: {} });
  const res = await priceFromPool(LONELY, { client, calls: fakeCalls({ holders: [] }) });

  assert.equal(res.ok, false);
  assert.equal(res.reason, "no_pool");
  assert.match(res.detail, /not priced at zero/);
  assert.equal(res.priceUsd, undefined);

  const market = await tokenMarketData(LONELY, { client, calls: fakeCalls({ holders: [] }), totalSupply: "1", decimals: 0 });
  assert.equal(market.price, null, "unpriced must be null, not 0");
  assert.equal(market.marketCap, null, "and so must the cap that would be derived from it");
  assert.equal(market.reason, "no_pool");
});

test("an outage during discovery is 'discovery_failed', not 'no_pool'", async () => {
  const LONELY = "0x0000000000000000000000000000000000000ca2";
  const client = fakeClient({
    decimals: { [WETH]: 18, [LONELY]: 18 },
    pools: {},
    fail: [`${FACTORY}:getPool`],
  });
  const res = await priceFromPool(LONELY, { client, calls: fakeCalls({ holdersFail: true }) });

  assert.equal(res.ok, false);
  assert.equal(res.reason, "discovery_failed", "a failed look must never read as an absence");
  assert.match(res.detail, /outage/);
  assert.equal(res.priceUsd, undefined);
});

test("a dead RPC with a healthy indexer is an outage, not 'no_pool'", async () => {
  // THE F5 REGRESSION. Every eth_call fails and Blockscout answers happily. The old
  // bookkeeping counted the holder LIST as evidence that the look had happened, so
  // a total RPC outage came out as reason "no_pool" — which is not in
  // POOL_UNREAD_REASONS, so it reached the answer layer as a MEASURED ABSENCE of a
  // market. The indexer being up says nothing whatever about the chain.
  const dead = {
    calls: [],
    async readContract() {
      throw new Error("rpc down");
    },
    async getBlockNumber() {
      throw new Error("rpc down");
    },
  };
  const calls = fakeCalls({ holders: [VLAD_POOL, "0xb54500af7c3f9d7162adaa478b2329c3e9dbcc2c"] });

  const resolved = await resolvePool(VLAD, { client: dead, calls });
  assert.equal(resolved.found, null);
  assert.equal(resolved.reason, "discovery_failed");
  assert.notEqual(resolved.reason, "no_pool", "an outage must never render as an absence");

  const res = await priceFromPool(VLAD, { client: dead, calls });
  assert.equal(res.reason, "discovery_failed");
  assert.match(res.detail, /outage, not a token without a market/);
});

test("a pool found but unreadable is 'pool_read_failed', not 'no_pool'", async () => {
  const client = fakeClient({ ...vladSpec(), fail: [`${VLAD_POOL}:slot0`] });
  const res = await priceFromPool(VLAD, { client, calls: fakeCalls() });

  assert.equal(res.ok, false);
  assert.equal(res.reason, "pool_read_failed");
  assert.equal(res.pool, VLAD_POOL, "we still know which pool we failed on");
  assert.match(res.detail, /could not fetch/);
  assert.equal(res.priceUsd, undefined);
});

test("an uninitialised pool is its own reason, not a zero price", async () => {
  const spec = vladSpec();
  spec.pools[VLAD_POOL].sqrtPriceX96 = 0n;
  const client = fakeClient(spec);
  const res = await priceFromPool(VLAD, { client, calls: fakeCalls() });

  assert.equal(res.ok, false);
  assert.equal(res.reason, "pool_not_initialised");
  assert.equal(res.priceUsd, undefined);
  assert.match(res.detail, /not a price of zero/);
});

test("a missing ETH price loses the dollars and keeps the ETH figure", async () => {
  const client = fakeClient(vladSpec());
  const res = await priceFromPool(VLAD, { client, calls: fakeCalls({ statsFails: true }) });

  assert.equal(res.ok, false);
  assert.equal(res.reason, "no_eth_price");
  assert.equal(res.priceUsd, undefined, "no dollar figure without a dollar reference");
  close(res.priceInQuote, 2.0977932235481013e-7, 1e-12, "the pool figure survives");
  assert.match(res.detail, /No fallback rate/);

  const market = await tokenMarketData(VLAD, {
    client,
    calls: fakeCalls({ statsFails: true }),
    totalSupply: VLAD_SUPPLY_RAW,
    decimals: 18,
  });
  assert.equal(market.price, null);
  assert.equal(market.marketCap, null);
  assert.equal(market.reason, "no_eth_price");
  close(market.priceInQuote, 2.0977932235481013e-7, 1e-12, "still carried");
});

test("a priced token with no readable supply has no market cap, not a zero one", async () => {
  const spec = vladSpec();
  delete spec.supplies;
  const client = fakeClient(spec);
  const res = await tokenMarketData(VLAD, { client, calls: fakeCalls() });
  close(res.price, 0.000404978981805961, 1e-9, "price");
  assert.equal(res.marketCap, null);
  assert.equal(res.marketCapReason, "supply_unknown");
});

/* -------------------------------- liquidity ------------------------------- */

test("liquidity comes back beside the price, and the thin side is flagged", async () => {
  const client = fakeClient(vladSpec());
  const res = await priceFromPool(VLAD, { client, calls: fakeCalls() });

  assert.equal(res.ok, true);
  // 0.002032777 WETH at $1930.5 — the only side anyone could actually realise.
  close(res.quoteLiquidityUsd, 3.9242766, 1e-5, "quote side");
  // Both sides together: the token side values 900M VLAD at its own quoted price.
  close(res.liquidityUsd, 364_482.3, 1e-4, "both sides");
  assert.equal(res.thinLiquidity, true, "$3.92 of depth is not a market");
  // And the price is NOT suppressed for it.
  close(res.priceUsd, 0.000404978981805961, 1e-9, "priceUsd stands");
});

test("an unreadable BALANCE leaves the held figure null and the depth intact", async () => {
  // The two are now INDEPENDENT reads of independent quantities, which is the point
  // of separating them: depth comes from the tick ladder and owes nothing to
  // balanceOf, so a pool whose balances cannot be read still has a measured depth
  // and an honestly unknown held figure. The reverse — an unreadable ladder — is
  // covered above and produces a null depth, never a fallback to the balance.
  const spec = vladSpec();
  delete spec.balances;
  const res = await priceFromPool(VLAD, { client: fakeClient(spec), calls: fakeCalls() });
  assert.equal(res.ok, true);
  assert.equal(res.liquidityUsd, null, "neither side of the pool could be totalled");
  assert.equal(res.quoteBalanceUsd, null, "what it HOLDS is unknown, not zero");
  close(res.quoteLiquidityUsd, 3.9242766, 1e-5, "and the ladder still says what is realisable");
  assert.equal(res.thinLiquidity, true);
});

/* --------------------------------- ethUsd --------------------------------- */

test("ethUsd reads coin_price and nothing else", async () => {
  assert.equal(await ethUsd({ calls: fakeCalls({ coinPrice: "1930.5" }) }), 1930.5);
  assert.equal(await ethUsd({ calls: fakeCalls({ coinPrice: 2100 }) }), 2100);
});

test("ethUsd is null — never a constant — when the stat is missing or junk", async () => {
  for (const bad of [null, "", "N/A", undefined, "0", 0, -5]) {
    const calls = { async getStats() { return bad === undefined ? {} : { coin_price: bad }; } };
    assert.equal(await ethUsd({ calls }), null, `coin_price ${JSON.stringify(bad)} must be null`);
  }
});

test("ethUsd is null when the stats endpoint fails", async () => {
  assert.equal(await ethUsd({ calls: fakeCalls({ statsFails: true }) }), null);
});

/* ------------------------------ the arithmetic ---------------------------- */

test("bigRatioToNumber survives the extremes a double would not", async () => {
  close(bigRatioToNumber(1n, 3n), 1 / 3, 1e-15, "a third");
  // Regression: undoing the digit shift by multiplying by 10 ** -17 rather than
  // dividing by 10 ** 17 made this 999.9999999999999. A round number has to come
  // back round, because these strings get quoted verbatim.
  assert.equal(bigRatioToNumber(1000n, 1n), 1000);
  assert.equal(bigRatioToNumber(10n ** 27n, 10n ** 18n), 1e9, "1B tokens at 18 decimals, exactly");
  close(bigRatioToNumber(10n ** 60n, 10n ** 30n), 1e30, 1e-15, "1e30");
  close(bigRatioToNumber(10n ** 30n, 10n ** 60n), 1e-30, 1e-15, "1e-30");
  assert.equal(bigRatioToNumber(0n, 5n), 0, "an exact zero is a real zero");
  assert.equal(bigRatioToNumber(5n, 0n), null, "divide by zero is unknown, not Infinity");
  // Past what a double can hold, in both directions: null, never Infinity or 0.
  assert.equal(bigRatioToNumber(10n ** 400n, 1n), null);
  assert.equal(bigRatioToNumber(1n, 10n ** 400n), null);
});

test("priceFromSqrtX96 refuses rather than inventing a zero", async () => {
  assert.equal(priceFromSqrtX96(0n, 18, 18, true), null, "an uninitialised pool has no price");
  assert.equal(priceFromSqrtX96(-1n, 18, 18, true), null);
  assert.equal(priceFromSqrtX96(VLAD_SQRT, 18, 999, true), null, "nonsense decimals are not priced");
  assert.equal(priceFromSqrtX96("172980936757921794081904939668374", 18, 18, true), null, "a string is not a BigInt");
});

test("supplyToNumber keeps precision past 2^53 and rejects junk", async () => {
  close(supplyToNumber(VLAD_SUPPLY_RAW, 18), 1e9, 1e-15, "1B tokens");
  close(supplyToNumber("123456789012345678901234567", 6), 123456789012345678901.234567, 1e-15, "6 decimals");
  assert.equal(supplyToNumber(0n, 18), 0, "a real zero supply is zero");
  assert.equal(supplyToNumber(null, 18), null);
  assert.equal(supplyToNumber("", 18), null);
  assert.equal(supplyToNumber("not a number", 18), null);
  assert.equal(supplyToNumber("1000", null), null, "unknown decimals means unknown supply");
});

/* --------------------------------- inputs --------------------------------- */

test("a non-address target is refused before any read", async () => {
  const client = fakeClient(vladSpec());
  const res = await priceFromPool("VLAD", { client, calls: fakeCalls() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "bad_address");
  assert.equal(client.calls.length, 0);
});

test("a missing client is a caller bug, and is neither an outage nor an absence of pools", async () => {
  // THREE facts, not two. "no_pool" would say the chain has nothing;
  // "discovery_failed" would blame the RPC for a call nobody made — and in
  // production a poolClient that failed to build would then make every token on
  // the chain look like a permanent brownout, with a sentence pointing at the
  // wrong thing. The reason names the caller instead.
  const res = await priceFromPool(VLAD, { calls: fakeCalls() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no_client");
  assert.notEqual(res.reason, "discovery_failed");
  assert.match(res.detail, /calling code/);
  assert.match(res.detail, /not an outage/);
  assert.equal(await findPool(VLAD, {}), null);

  const resolved = await resolvePool(VLAD, { calls: fakeCalls() });
  assert.equal(resolved.found, null);
  assert.equal(resolved.reason, "no_client");
});

/* --------------------------------- caching -------------------------------- */

test("the pool mapping is cached; a pool address does not move", async () => {
  const client = fakeClient(vladSpec());
  await priceFromPool(VLAD, { client, calls: fakeCalls() });
  const first = client.calls.filter((c) => c.endsWith(":getPool")).length;
  assert.ok(first > 0, "the first call has to ask the factory");

  client.calls.length = 0;
  await priceFromPool(VLAD, { client, calls: fakeCalls() });
  const second = client.calls.filter((c) => c === `${FACTORY}:getPool`).length;
  assert.equal(second, 0, "the second call must not re-derive the pool address");
});

test("a failed read is never cached", async () => {
  const spec = vladSpec();
  const client = fakeClient({ ...spec, fail: [`${VLAD_POOL}:slot0`] });
  const bad = await priceFromPool(VLAD, { client, calls: fakeCalls() });
  assert.equal(bad.reason, "pool_read_failed");

  // Same module state, a chain that now answers: the failure must not persist.
  const healthy = fakeClient(spec);
  const good = await priceFromPool(VLAD, { client: healthy, calls: fakeCalls() });
  assert.equal(good.ok, true, "a cached failure would have made this fail too");
});
