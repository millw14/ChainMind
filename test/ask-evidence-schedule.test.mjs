// Tests for HOW lib/ask-evidence.js schedules its indexer calls: what it skips when
// the caller already knows the answer, what it overlaps when it doesn't, and what it
// does when a slow endpoint misses its deadline.
//
// Measured live before this: "hows nvda doin" took ~15s to first text against a model
// that answered in 593ms, because gatherEvidence awaited a 5.2s address lookup purely
// to decide token-vs-wallet and only then started the 4.5s token calls. None of that
// is visible in the returned evidence — only in WHEN each call happens — so every test
// here drives injected fakes through the `calls` and `deadlines` seams and asserts on
// call order and on deadlines, never on the network. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { gatherEvidence } from "../lib/ask-evidence.js";
import { BlockscoutError } from "../lib/blockscout.js";

/** AAPL as snapshotted in config/stock-tokens.json — a known-canonical equity token. */
const TOKEN = "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9";
const OTHER_TOKEN = `0x${"d".repeat(40)}`;
const WALLET = `0x${"b".repeat(40)}`;
const PEER = `0x${"c".repeat(40)}`;
const ISSUER = "0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046";

const KNOWN_TOKEN = { kind: "token", address: TOKEN, symbol: "AAPL", company: "Apple", official: true };

/* ------------------------------ fake indexer ------------------------------ */

/**
 * Records every call by name in the order it was STARTED, which is the whole
 * subject of this file, and honours the AbortSignal the module hands it — a fake
 * that ignored the signal could not show a deadline working.
 */
function recorder() {
  const log = [];

  /**
   * @param {string} name
   * @param {{ body?: any, ms?: number, status?: number|null, hang?: boolean }} [behaviour]
   *   `hang` answers a minute from now — i.e. never, next to any deadline in this
   *   file. It is a real timer rather than a promise nobody resolves because
   *   AbortSignal.timeout's own timer is unref'd: with nothing else holding the
   *   loop open, the abort would never fire and the test would hang instead of
   *   observing the deadline.
   */
  function call(name, { body = {}, ms = 0, status = null, hang = false } = {}) {
    return (...args) => {
      const last = args[args.length - 1];
      const signal = last && typeof last === "object" ? last.signal : null;
      log.push(name);
      return new Promise((resolve, reject) => {
        const finish = () =>
          status ? reject(new BlockscoutError(`fake ${status}`, status)) : resolve(body);
        const timer = setTimeout(finish, hang ? 60_000 : ms);
        // AbortSignal.timeout's reason is a TimeoutError DOMException, which is
        // what the real fetch would reject with.
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error("aborted"));
        });
      });
    };
  }

  return {
    log,
    call,
    saw: (name) => log.includes(name),
    /** A call that only answers once the test releases it. */
    gated(name, body = {}) {
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      return { fn: () => (log.push(name), gate.then(() => body)), release: () => release() };
    },
  };
}

/** Let every queued microtask and zero-delay timer run before asserting. */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

function tokenBody() {
  return {
    name: "Apple • Robinhood Token",
    symbol: "AAPL",
    type: "ERC-20",
    decimals: "18",
    total_supply: "1000000000000000000000",
    exchange_rate: "212.5",
    circulating_market_cap: "4160816.92",
    volume_24h: "98765.43",
  };
}

function overviewBody(extra = {}) {
  return {
    hash: TOKEN,
    is_verified: true,
    creator_address_hash: ISSUER,
    creation_tx_hash: `0x${"e".repeat(64)}`,
    token: tokenBody(),
    ...extra,
  };
}

function walletOverviewBody() {
  return { hash: WALLET, is_contract: false, name: "whale", coin_balance: "1000000000000000000", token: null };
}

/**
 * What lib/dex-price.js answers for a token nothing trades: a MEASURED absence,
 * not a failure. The default for every test here, so no test can reach the RPC —
 * `tokenMarketData` is the one entry in the call seam that is not an indexer call,
 * and left unstubbed it would open a real connection to chain 4663.
 */
function noPool() {
  return {
    price: null,
    marketCap: null,
    liquidityUsd: null,
    quoteLiquidityUsd: null,
    source: "uniswap_v3",
    quote: null,
    pool: null,
    fee: null,
    asOfBlock: null,
    priceInQuote: null,
    priceNative: null,
    reason: "no_pool",
    detail: "No Uniswap v3 pool for this token against any verified quote asset on Robinhood Chain.",
  };
}

/** VLAD as read live off chain 4663: a real pool price with four dollars behind it. */
function vladPool() {
  return {
    price: 0.00040468946392557093,
    marketCap: 404689.46392557095,
    liquidityUsd: 364220.5577297926,
    quoteLiquidityUsd: 3.921471393954625,
    // Vladhoods' single position is a hair wide and sits at the market, so its
    // realisable depth and what it HOLDS are the same figure to the cent — which is
    // exactly the case the old evidence layer treated as needing no qualification.
    quoteBalanceUsd: 3.921471393954625,
    // The RANKING figure is the -2% band; the -10% figure is context beside it.
    depthIsLowerBound: false,
    wideDepthUsd: 3.921471393954625,
    wideDepthIsLowerBound: false,
    depthBandBps: 200,
    wideBandBps: 1000,
    source: "uniswap_v3",
    quote: {
      address: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
      kind: "native",
      verifiedBy: "reference_asset",
      usdPerUnit: 1929.12,
    },
    pool: "0xad19a21d400b6381a79e3b676241450ce4159f66",
    fee: 3000,
    asOfBlock: 20845278,
    priceInQuote: 2.0977931073524247e-7,
    priceNative: 2.0977931073524247e-7,
    thinLiquidity: true,
    discovery: "factory",
  };
}

/** The five token-path calls, all fast and all successful. */
function tokenCalls(r, over = {}) {
  return {
    tokenMarketData: r.call("tokenMarketData", { body: noPool() }),
    getToken: r.call("getToken", { body: tokenBody() }),
    getTokenCounters: r.call("getTokenCounters", { body: { token_holders_count: 28899, transfers_count: 4321 } }),
    getTokenHolders: r.call("getTokenHolders", { body: { items: [{ address: { hash: WALLET }, value: "500000000000000000000" }] } }),
    getTokenActivity: r.call("getTokenActivity", {
      body: { items: [{ from: { hash: WALLET }, to: { hash: PEER }, total: { value: "1000000000000000000" }, timestamp: "2026-07-25T00:00:00Z" }] },
    }),
    getAddress: r.call("getAddress", { body: overviewBody() }),
    ...over,
  };
}

/** The four wallet-path calls, all fast and all successful. */
function walletCalls(r, over = {}) {
  return {
    getAddressCounters: r.call("getAddressCounters", { body: { transactions_count: 12, token_transfers_count: 4 } }),
    getAddressTokenBalances: r.call("getAddressTokenBalances", {
      body: [{ token: { symbol: "AAPL", decimals: "18", exchange_rate: "212.5" }, value: "2000000000000000000" }],
    }),
    getAddressTransactions: r.call("getAddressTransactions", { body: { items: [{ from: { hash: WALLET }, to: { hash: PEER } }] } }),
    getTokenTransfers: r.call("getTokenTransfers", { body: { items: [] } }),
    ...over,
  };
}

/* ------------------------------ the known hint ------------------------------ */

test("a `known: token` hint starts every token call without waiting for the address overview", async () => {
  const r = recorder();
  const overview = r.gated("getAddress", overviewBody());
  const calls = tokenCalls(r, { getAddress: overview.fn });

  const pending = gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls });
  await flush();

  // With the old gate, getAddress was the ONLY call made until it answered.
  assert.deepEqual(
    [...r.log].sort(),
    ["getAddress", "getToken", "getTokenActivity", "getTokenCounters", "getTokenHolders"],
    "all five calls are in flight while the address overview is still open",
  );

  overview.release();
  const res = await pending;
  assert.equal(res.ok, true);
  assert.equal(res.kind, "token");
  assert.equal(res.evidence.token.symbol, "AAPL");
  assert.equal(res.evidence.token.holders, 28899);
  assert.equal(res.degraded, undefined, "nothing failed, so nothing is degraded");
});

/**
 * Did the token enrichment start before the probe answered? True only when the
 * hint was believed. Releasing the gate before asserting matters: a failed
 * assertion mid-gather would otherwise leave a promise pending forever and take
 * the rest of the file down with it.
 */
async function skippedTheGate(known) {
  const r = recorder();
  const probe = r.gated("getToken", tokenBody());
  const pending = gatherEvidence(TOKEN, { known, calls: tokenCalls(r, { getToken: probe.fn }) });
  await flush();
  const early = r.saw("getTokenHolders");
  probe.release();
  const res = await pending;
  return { early, res };
}

test("the hint is ignored when it names a different address than the target", async () => {
  // A hint about OTHER_TOKEN says nothing about TOKEN; believing it would label
  // this contract with another one's facts.
  const { early, res } = await skippedTheGate({ kind: "token", address: OTHER_TOKEN });
  assert.equal(early, false, "kind is unknown again, so enrichment waits for the probe");
  assert.equal(res.kind, "token");
});

test("a malformed hint falls back to looking instead of being believed", async () => {
  for (const known of [{ kind: "token", address: "0xnope" }, { kind: "wallet", address: TOKEN }, "token", null]) {
    const { early, res } = await skippedTheGate(known);
    assert.equal(early, false, `hint ${JSON.stringify(known)} must not skip the probe`);
    assert.equal(res.kind, "token");
  }
});

test("a hint with no address at all still speaks for the target it came with", async () => {
  const { early } = await skippedTheGate({ kind: "token", official: true });
  assert.equal(early, true);
});

/* ------------------------------ the symbol path ------------------------------ */

test("a snapshotted ticker starts the token calls in the same window as the resolver", async () => {
  const r = recorder();
  const resolver = r.gated("resolveSymbol", {
    ok: true,
    query: "AAPL",
    match: { address: TOKEN, symbol: "AAPL", company: "Apple", price: 212.5, marketCap: 4160816.92, holders: 28899 },
    official: true,
    impostors: [],
  });
  const calls = tokenCalls(r, { resolveSymbol: resolver.fn });

  const pending = gatherEvidence("aapl", { calls });
  await flush();

  // The address for 94 tickers is a synchronous Map hit, so waiting for the
  // resolver's own round trips before starting these was pure latency.
  assert.equal(r.saw("getToken"), true, "token metadata is already being fetched");
  assert.equal(r.saw("getTokenHolders"), true, "so is the enrichment");
  assert.equal(r.saw("getAddress"), true, "so is the overview, which no longer gates anything");

  resolver.release();
  const res = await pending;
  assert.equal(res.ok, true);
  assert.equal(res.kind, "token");
  assert.equal(Object.keys(res.evidence)[0], "stock", "the impostor block still leads the evidence");
  assert.equal(res.evidence.stock.official, true);
  assert.equal(res.evidence.token.display.marketCap, "$4.16M");
});

test("an impostor scan that never ran is unknown, not an all-clear", async () => {
  const r = recorder();
  const base = { ok: true, query: "AAPL", match: { address: TOKEN, symbol: "AAPL", company: "Apple" }, official: true };

  // The explorer search failed, so lib/stock-tokens.js hands back null. An empty
  // array here would have produced no warning at all, and "no warning" is what a
  // reader takes as "checked, and nothing else wears this ticker".
  const unread = await gatherEvidence("aapl", {
    calls: tokenCalls(r, { resolveSymbol: r.call("resolveSymbol", { body: { ...base, impostors: null } }) }),
  });
  assert.equal(unread.ok, true);
  assert.equal(unread.evidence.stock.impostors, null, "null, never [] — nothing was read");
  assert.equal(unread.evidence.stock.impostorCount, null);
  assert.equal(unread.evidence.stock.impostorsRead, false);
  assert.match(unread.evidence.stock.impostorWarning, /could not be checked — unknown, not none/);

  // The search DID answer and found nothing: that silence is earned.
  const r2 = recorder();
  const clean = await gatherEvidence("aapl", {
    calls: tokenCalls(r2, { resolveSymbol: r2.call("resolveSymbol", { body: { ...base, impostors: [] } }) }),
  });
  assert.deepEqual(clean.evidence.stock.impostors, []);
  assert.equal(clean.evidence.stock.impostorCount, 0);
  assert.equal(clean.evidence.stock.impostorsRead, true);
  assert.equal(clean.evidence.stock.impostorWarning, null, "an official ticker with no collisions warns about nothing");
});

test("a ticker lookup survives an address overview that never answers", async () => {
  const r = recorder();
  const calls = tokenCalls(r, {
    getAddress: r.call("getAddress", { hang: true }),
    resolveSymbol: r.call("resolveSymbol", {
      body: { ok: true, query: "AAPL", match: { address: TOKEN, symbol: "AAPL", company: "Apple" }, official: true, impostors: [] },
    }),
  });

  const res = await gatherEvidence("aapl", { calls, deadlines: { essential: 5_000, enrichment: 25 } });
  // This used to be a dead end: getAddress failing returned "Token not found" /
  // "the indexer did not answer" for a ticker whose every headline figure was
  // already in hand.
  assert.equal(res.ok, true);
  assert.equal(res.evidence.token.symbol, "AAPL");
  assert.equal(res.evidence.contract, null, "not a record of nulls, which would read as unverified");
  assert.ok(res.evidence.unavailable.includes("contract"));
  assert.equal(res.degraded, true);
});

/* ------------------------------ no hint: overlap ------------------------------ */

test("a bare address decides token-vs-wallet from the token probe, not the overview", async () => {
  const r = recorder();
  const overview = r.gated("getAddress", overviewBody());
  const calls = { ...tokenCalls(r, { getAddress: overview.fn }), ...walletCalls(r) };

  const pending = gatherEvidence(TOKEN, { calls });
  await flush();
  // The probe (1.1s live) has answered; the overview (5.2s live) has not, and the
  // enrichment is already running anyway.
  assert.equal(r.saw("getTokenHolders"), true, "the token path started off the probe alone");
  assert.equal(r.saw("getAddressCounters"), false, "and the wallet path was never speculatively fired");

  overview.release();
  const res = await pending;
  assert.equal(res.kind, "token");
  assert.equal(res.evidence.contract.creator, ISSUER);
});

test("a 404 from the token probe starts the wallet calls before the overview lands", async () => {
  const r = recorder();
  const overview = r.gated("getAddress", walletOverviewBody());
  const calls = {
    ...walletCalls(r),
    getToken: r.call("getToken", { status: 404 }),
    getTokenCounters: r.call("getTokenCounters", { status: 404 }),
    getAddress: overview.fn,
  };

  const pending = gatherEvidence(WALLET, { calls });
  await flush();
  assert.equal(r.saw("getAddressCounters"), true, "not a token, so the wallet calls run alongside the overview");
  assert.equal(r.saw("getTokenHolders"), false, "and no token enrichment is wasted");

  overview.release();
  const res = await pending;
  assert.equal(res.ok, true);
  assert.equal(res.kind, "address");
  assert.equal(res.evidence.balanceEth, 1);
  assert.equal(res.evidence.totalTransactions, 12);
  assert.equal(res.evidence.tokenHoldings.length, 1);
  assert.deepEqual(res.evidence.counterparties, [PEER.toLowerCase()]);
  assert.equal(res.degraded, undefined, "the two 404s were the probe, not evidence fields");
});

test("an unreadable token probe still branches on the overview's own token field", async () => {
  const r = recorder();
  // 500, not 404: the indexer did not say "no token here", so the old signal —
  // a populated `token` object on the address overview — has to decide.
  const calls = tokenCalls(r, { getToken: r.call("getToken", { status: 500 }) });
  const res = await gatherEvidence(TOKEN, { calls });
  assert.equal(res.kind, "token");
  assert.equal(res.evidence.token.symbol, "AAPL", "metadata fell back to the overview's copy");
  assert.ok(res.evidence.unavailable.includes("token"));
  assert.equal(res.degraded, true);

  const r2 = recorder();
  const res2 = await gatherEvidence(WALLET, {
    calls: { ...walletCalls(r2), getToken: r2.call("getToken", { status: 500 }), getTokenCounters: r2.call("getTokenCounters", { status: 500 }), getAddress: r2.call("getAddress", { body: walletOverviewBody() }) },
  });
  assert.equal(res2.kind, "address", "no token on the overview means wallet");
});

test("a target nothing can be read about is still a failure, with the old wording", async () => {
  const r = recorder();
  const notFound = await gatherEvidence(WALLET, {
    calls: { ...walletCalls(r), getToken: r.call("getToken", { status: 404 }), getAddress: r.call("getAddress", { status: 404 }) },
  });
  assert.equal(notFound.ok, false);
  assert.equal(notFound.kind, "address");
  assert.match(notFound.error, /not found on Robinhood Chain/);

  const r2 = recorder();
  const brownout = await gatherEvidence(WALLET, {
    calls: { ...walletCalls(r2), getToken: r2.call("getToken", { status: 503 }), getAddress: r2.call("getAddress", { status: 503 }) },
  });
  // An outage must never be reported as "this address does not exist".
  assert.equal(brownout.ok, false);
  assert.equal(brownout.kind, "unavailable");
  assert.match(brownout.error, /did not answer \(HTTP 503\)/);
});

/* ------------------------------ the price gap ------------------------------ */

/*
 * Blockscout prices the issuer-verified tokenized equities and nothing else, so
 * an unlisted ERC-20 answers with exchange_rate / circulating_market_cap /
 * volume_24h all null. A reviewer asked one for its price and got an answer that
 * opened by listing three things it could not do. The nulls stay — inventing a
 * quote would be far worse — but the evidence now carries WHY, so the reason can
 * be one clause at the end instead of the whole reply.
 */

/** The same token body with the three market fields absent, as an unlisted one is. */
function unpricedTokenBody() {
  const { exchange_rate, circulating_market_cap, volume_24h, ...rest } = tokenBody();
  return { ...rest, name: "Andy", symbol: "ANDY", total_supply: "1000000000000000000000000000" };
}

test("a token the indexer never priced says why, instead of three bare nulls", async () => {
  const r = recorder();
  const calls = tokenCalls(r, {
    getToken: r.call("getToken", { body: unpricedTokenBody() }),
    getAddress: r.call("getAddress", { body: overviewBody({ token: unpricedTokenBody(), is_verified: false }) }),
  });

  const res = await gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls });

  assert.equal(res.ok, true);
  assert.equal(res.evidence.token.priceStatus, "not_indexed");
  assert.match(res.evidence.token.priceStatusReason, /no price feed for this contract/i);
  assert.match(res.evidence.token.priceStatusReason, /issuer-verified tokenized equities/i);
  // The absence itself is unchanged: still null, still never zero, still not
  // listed as a failed source — nothing failed, the feed does not exist.
  assert.equal(res.evidence.token.priceUsd, null);
  assert.equal(res.evidence.token.marketCapUsd, null);
  assert.equal(res.evidence.token.display.price, null);
  assert.equal(res.degraded, undefined);
  // And everything the answer should actually lead with is present.
  assert.equal(res.evidence.token.holders, 28899);
  assert.equal(res.evidence.token.transfers, 4321);
  assert.equal(res.evidence.token.totalSupply, "1B ANDY");
});

test("a verified equity is untouched — a real quote is still just a quote", async () => {
  const r = recorder();
  const res = await gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls: tokenCalls(r) });

  assert.equal(res.evidence.token.priceStatus, "indexed");
  assert.equal(res.evidence.token.priceStatusReason, null, "nothing to explain when the price is there");
  assert.equal(res.evidence.token.priceUsd, "212.5");
  assert.equal(res.evidence.token.display.marketCap, "$4.16M");
  assert.equal(res.evidence.token.display.volume24h, "$98.77K");
});

test("an indexer that could not be asked is 'unavailable', never 'not priced'", async () => {
  const r = recorder();
  // The token endpoint fails outright; metadata falls back to the overview's
  // copy, which here carries no market fields either. The figures may well
  // exist — nobody managed to look — so this must not read as a token nobody prices.
  const calls = tokenCalls(r, {
    getToken: r.call("getToken", { status: 500 }),
    getAddress: r.call("getAddress", { body: overviewBody({ token: unpricedTokenBody() }) }),
  });

  const res = await gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls });

  assert.equal(res.evidence.token.priceStatus, "unavailable");
  assert.match(res.evidence.token.priceStatusReason, /outage, not a token without a price/i);
  assert.ok(res.evidence.unavailable.includes("token"));
  assert.equal(res.degraded, true);
});

/* ---------------------------- the pool fallback ---------------------------- */

/*
 * Blockscout prices the 94 issuer-verified equities and essentially nothing else,
 * which meant the app answered "no price available" for exactly the tokens people
 * trade. The chain itself knows: Uniswap v3 is deployed on 4663 and the pools are
 * real. lib/dex-price.js reads them; these tests are about what the evidence layer
 * does with the answer — and, as importantly, when it declines to ask.
 */

test("a token the indexer does not price is priced from its Uniswap v3 pool", async () => {
  const r = recorder();
  const calls = tokenCalls(r, {
    getToken: r.call("getToken", { body: unpricedTokenBody() }),
    getAddress: r.call("getAddress", { body: overviewBody({ token: unpricedTokenBody() }) }),
    tokenMarketData: r.call("tokenMarketData", { body: vladPool() }),
  });

  const res = await gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls });
  const token = res.evidence.token;

  // "not_indexed" is no longer the end of the story: this token is PRICED.
  assert.equal(token.priceStatus, "pool_priced");
  assert.equal(token.priceSource, "uniswap_v3");
  assert.equal(token.priceUsd, 0.00040468946392557093);
  assert.equal(token.marketCapUsd, 404689.46392557095);
  // The strings the model copies, not the floats beside them.
  assert.equal(token.display.price, "$0.0004047");
  assert.equal(token.display.marketCap, "$404.69K");
  // A pool has no 24h volume to give, and an absent figure stays absent.
  assert.equal(token.volume24hUsd, null);
  assert.equal(token.display.volume24h, null);
  assert.equal(res.degraded, undefined, "a pool price is not a degraded answer");

  // WHERE IT CAME FROM, on the evidence rather than left to be inferred.
  assert.equal(token.pool.address, "0xad19a21d400b6381a79e3b676241450ce4159f66");
  assert.equal(token.pool.fee, 3000);
  assert.equal(token.pool.feeTier, "0.3%");
  assert.equal(token.pool.quote.address, "0x0bd7d308f8e1639fab988df18a8011f41eacad73");
  assert.equal(token.pool.quote.label, "WETH");
  assert.equal(token.pool.liquidityUsd, 364220.5577297926);
  assert.equal(token.pool.quoteLiquidityUsd, 3.921471393954625);
  assert.equal(token.pool.display.quoteLiquidity, "$3.92");
  assert.match(token.pool.sourceNotice, /derived from the Uniswap v3 pool 0xad19a2/i);
  assert.match(token.pool.sourceNotice, /against WETH/);
  assert.match(token.pool.sourceNotice, /not quoted by a price feed/);
});

test("a pool price with four dollars behind it says so", async () => {
  const r = recorder();
  const calls = tokenCalls(r, {
    getToken: r.call("getToken", { body: unpricedTokenBody() }),
    getAddress: r.call("getAddress", { body: overviewBody({ token: unpricedTokenBody() }) }),
    tokenMarketData: r.call("tokenMarketData", { body: vladPool() }),
  });

  const { pool } = (await gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls })).evidence.token;

  // 900M tokens against 0.002 WETH: the price is arithmetically right and the
  // amount of it anybody could realise is four dollars.
  assert.equal(pool.thinLiquidity, true);
  assert.match(pool.liquidityNotice, /\$3\.92/);
  assert.match(pool.liquidityNotice, /a small trade moves it/);
});

test("a pool whose held and realisable figures are EQUAL is still qualified", async () => {
  // THE F1-BY-WAY-OF-F2 REGRESSION. The held figure used to be mentioned only when
  // it exceeded the realisable one by 10%, so the qualification was conditional on a
  // DISCREPANCY — and a forged pool has none: an attacker who puts everything into
  // one narrow position at the market has held == realisable exactly. The honest
  // pool with genuine capital parked out of band carried the caveat and the forgery
  // carried none, and the sourceNotice then cited depth-based selection as grounds
  // for trusting it. What was measured is now stated positively, always.
  const r = recorder();
  const calls = tokenCalls(r, {
    getToken: r.call("getToken", { body: unpricedTokenBody() }),
    getAddress: r.call("getAddress", { body: overviewBody({ token: unpricedTokenBody() }) }),
    tokenMarketData: r.call("tokenMarketData", { body: vladPool() }),
  });

  const { pool } = (await gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls })).evidence.token;
  assert.equal(pool.quoteBalanceUsd, pool.quoteLiquidityUsd, "the two figures are identical here");
  // WHAT was measured, and over WHAT BAND — stated whether or not they differ.
  assert.match(pool.liquidityNotice, /before the price moved 2% against them/);
  assert.match(pool.liquidityNotice, /integrated over the pool's tick ladder/);
  // The WIDE band is stated as context and labelled as the place capital can hide.
  assert.match(
    pool.liquidityNotice,
    /out to 10%, where capital can sit without ever being traded through, it is \$3\.92/,
  );
  assert.match(pool.liquidityNotice, /The pool HOLDS \$3\.92/, "held is named even when equal");

  // …and the same sentence still names the gap when there IS one.
  const r2 = recorder();
  const gapped = tokenCalls(r2, {
    getToken: r2.call("getToken", { body: unpricedTokenBody() }),
    getAddress: r2.call("getAddress", { body: overviewBody({ token: unpricedTokenBody() }) }),
    tokenMarketData: r2.call("tokenMarketData", {
      body: { ...vladPool(), quoteLiquidityUsd: 1_324.13, quoteBalanceUsd: 69_679.77, thinLiquidity: false },
    }),
  });
  const wide = (await gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls: gapped })).evidence.token.pool;
  assert.match(wide.liquidityNotice, /\$1\.32K of WETH realisable/);
  assert.match(wide.liquidityNotice, /The pool HOLDS \$69\.68K/);
  assert.match(wide.liquidityNotice, /present and not realisable within it/);
});

test("an unreadable HELD figure is stated as unknown, never dropped or zeroed", async () => {
  const r = recorder();
  const calls = tokenCalls(r, {
    getToken: r.call("getToken", { body: unpricedTokenBody() }),
    getAddress: r.call("getAddress", { body: overviewBody({ token: unpricedTokenBody() }) }),
    tokenMarketData: r.call("tokenMarketData", { body: { ...vladPool(), quoteBalanceUsd: null } }),
  });
  const { pool } = (await gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls })).evidence.token;
  assert.equal(pool.quoteBalanceUsd, null);
  assert.match(pool.liquidityNotice, /could not be read, so the gap between held and realisable is unknown/);
});

test("a market cap towering over its depth never travels naked", async () => {
  // Measured on chain 4663: The Robinhood posts a $3,855,217 cap on $1.03 of
  // realisable WETH. The figure is arithmetically correct and a reader given it
  // without the second one is misled, so the qualifier is built here rather than
  // left to the model to remember.
  const r = recorder();
  const calls = tokenCalls(r, {
    getToken: r.call("getToken", { body: unpricedTokenBody() }),
    getAddress: r.call("getAddress", { body: overviewBody({ token: unpricedTokenBody() }) }),
    tokenMarketData: r.call("tokenMarketData", {
      body: { ...vladPool(), marketCap: 3_855_217, liquidityUsd: 3_855_000, quoteLiquidityUsd: 1.03 },
    }),
  });

  const { pool } = (await gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls })).evidence.token;

  assert.match(pool.capNotice, /\$3\.86M/);
  assert.match(pool.capNotice, /\$1\.03/);
  assert.match(pool.capNotice, /notional/);
  // TOTAL liquidity is not depth, and the difference is the token valuing itself.
  assert.match(pool.liquidityNotice, /valuing ITSELF/);
  assert.match(pool.liquidityNotice, /circular, and not depth/);
  // And it must not overcorrect into an accusation.
  assert.match(pool.capNotice, /not evidence of a scam/);
  assert.doesNotMatch(pool.capNotice, /rug|fraud|manipulat/i);
});

test("a cap proportionate to its depth gets no qualifier", async () => {
  // The Green Bull: $238,397 behind $69,583.29. The liquidity notice already
  // states the depth; a second sentence would only dilute the one that matters.
  const r = recorder();
  const calls = tokenCalls(r, {
    getToken: r.call("getToken", { body: unpricedTokenBody() }),
    getAddress: r.call("getAddress", { body: overviewBody({ token: unpricedTokenBody() }) }),
    tokenMarketData: r.call("tokenMarketData", {
      body: {
        ...vladPool(),
        price: 0.00023839681962609913,
        marketCap: 238_397,
        liquidityUsd: 101_691,
        quoteLiquidityUsd: 69_583.29,
        thinLiquidity: false,
      },
    }),
  });

  const { pool } = (await gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls })).evidence.token;

  assert.equal(pool.capNotice, null);
  assert.equal(pool.thinLiquidity, false);
  assert.match(pool.liquidityNotice, /\$69\.58K/);
  assert.doesNotMatch(pool.liquidityNotice, /valuing ITSELF/);
});

test("a pool read nobody supplied a client for blames the caller, not the chain", async () => {
  // "no_client" is a third fact beside "no pool" and "the RPC failed". Reported as
  // an absence it would say the chain has nothing; reported as an outage it would
  // blame an upstream that was never called — and a poolClient that failed to
  // build would then make every unpriced token on the chain look like a permanent
  // brownout, forever.
  const r = recorder();
  const calls = tokenCalls(r, {
    getToken: r.call("getToken", { body: unpricedTokenBody() }),
    getAddress: r.call("getAddress", { body: overviewBody({ token: unpricedTokenBody() }) }),
    tokenMarketData: r.call("tokenMarketData", {
      body: {
        ...noPool(),
        reason: "no_client",
        detail: "No RPC client was supplied to the pool reader, so the chain was never asked.",
      },
    }),
  });

  const res = await gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls });
  const { pool, priceStatus } = res.evidence.token;

  assert.equal(pool.reason, "no_client");
  assert.equal(pool.outage, true, "never 'no pool exists' — nobody looked");
  assert.equal(pool.misconfigured, true, "and it is OUR fault, which is a different sentence");
  assert.equal(priceStatus, "unavailable", "unknown, not unpriced");
  assert.ok(res.evidence.unavailable.includes("poolPrice"));
});

test("depth nobody could measure is neither thin nor deep", async () => {
  const r = recorder();
  const calls = tokenCalls(r, {
    getToken: r.call("getToken", { body: unpricedTokenBody() }),
    getAddress: r.call("getAddress", { body: overviewBody({ token: unpricedTokenBody() }) }),
    tokenMarketData: r.call("tokenMarketData", {
      body: { ...vladPool(), liquidityUsd: null, quoteLiquidityUsd: null, thinLiquidity: null },
    }),
  });

  const { pool } = (await gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls })).evidence.token;

  assert.equal(pool.priced, true, "the price stands; only its depth is unknown");
  assert.equal(pool.thinLiquidity, null, "null, never false — unmeasured is not deep");
  assert.match(pool.liquidityNotice, /unmeasured, not deep and not thin/);
});

test("O2: A BOUND BELOW THE FLOOR IS A CAPPED MEASUREMENT, NOT SILENCE", async () => {
  // BOTH ARRIVE HERE AS thinLiquidity === null, AND ONLY ONE OF THEM IS SILENCE.
  // lib/dex-price.js reports null for a depth it could not read AND for a LOWER BOUND
  // that lands below the floor — the second correctly, because a figure that only
  // counts upward cannot show a pool is thin. This notice took the same branch for
  // both and told the reader "the tick ladder did not answer" about a read that DID
  // answer, discarding a real $31.26 the same block still carries. A measurement
  // reported as silence is the mirror of an outage reported as an absence.
  const r = recorder();
  const calls = tokenCalls(r, {
    getToken: r.call("getToken", { body: unpricedTokenBody() }),
    getAddress: r.call("getAddress", { body: overviewBody({ token: unpricedTokenBody() }) }),
    tokenMarketData: r.call("tokenMarketData", {
      body: {
        ...vladPool(),
        // The griefed 0.01%-tier geometry: 25 dust mints cap $259.06 to $31.26, the
        // walk covering the 0.2424% nearest the market instead of the full 2%.
        quoteLiquidityUsd: 31.262561058474652,
        quoteBalanceUsd: 69_679.77,
        depthIsLowerBound: true,
        depthCoveredBandBps: 24.242147821362803,
        thinLiquidity: null,
      },
    }),
  });

  const { pool } = (await gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls })).evidence.token;

  assert.equal(pool.thinLiquidity, null, "a bound may not establish thinness");
  assert.equal(pool.depthIsLowerBound, true);
  assert.equal(pool.depthCoveredBandBps, 24.242147821362803);
  // THE FIGURE IS REPORTED, in its "at least" sense.
  assert.match(pool.liquidityNotice, /at least \$31\.26/);
  // THE READ IS DESCRIBED AS CAPPED, WITH THE RANGE IT COVERS NAMED.
  assert.match(pool.liquidityNotice, /LOWER BOUND/);
  assert.match(pool.liquidityNotice, /covered the 0\.242% nearest the market/);
  assert.match(pool.liquidityNotice, /short of 2%/);
  // AND THE SILENCE WORDING IS GONE — that read happened.
  assert.doesNotMatch(pool.liquidityNotice, /did not answer/);
  assert.doesNotMatch(pool.liquidityNotice, /unmeasured, not deep and not thin/);
  assert.match(pool.liquidityNotice, /do NOT say the depth is unknown/);
  assert.match(pool.liquidityNotice, /Do NOT call this pool thin/);
  // …AND IT IS STILL NOT AN ACCUSATION. Thin depth is a fact about a pool, and this
  // is not even that — the sentence must not harden into a claim about anyone.
  assert.doesNotMatch(pool.liquidityNotice, /rug|fraud|scam|manipulat/i);
});

test("O2: A READ THAT GENUINELY THREW STILL READS AS SILENCE", async () => {
  // The other side of the same branch, and it must not move. "The tick ladder did not
  // answer" is reserved for reads that did not happen — no figure, no bound, nothing
  // summed — and the reader has to be able to tell the two apart.
  const r = recorder();
  const calls = tokenCalls(r, {
    getToken: r.call("getToken", { body: unpricedTokenBody() }),
    getAddress: r.call("getAddress", { body: overviewBody({ token: unpricedTokenBody() }) }),
    tokenMarketData: r.call("tokenMarketData", {
      body: {
        ...vladPool(),
        quoteLiquidityUsd: null,
        quoteBalanceUsd: null,
        // A failed read has NO lower bound to report: nothing was integrated.
        depthIsLowerBound: false,
        depthCoveredBandBps: null,
        thinLiquidity: null,
      },
    }),
  });

  const { pool } = (await gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls })).evidence.token;

  assert.equal(pool.quoteLiquidityUsd, null);
  assert.match(pool.liquidityNotice, /the tick ladder did not answer/);
  assert.match(pool.liquidityNotice, /unmeasured, not deep and not thin/);
  assert.doesNotMatch(pool.liquidityNotice, /at least/, "there is no figure to be 'at least'");
  assert.doesNotMatch(pool.liquidityNotice, /capped/);
});

test("O2: an unresolved depth comparison is unread, and is NOT called an outage", async () => {
  // The reason lib/dex-price.js returns when a pool that sorted below the leader
  // reported a lower bound. It must count as UNREAD everywhere that asks "may this be
  // stated as an absence" — it may not — and must NOT be described as a read that
  // failed, because every pool answered. What is missing is exactness, not data.
  const r = recorder();
  const calls = tokenCalls(r, {
    getToken: r.call("getToken", { body: unpricedTokenBody() }),
    getAddress: r.call("getAddress", { body: overviewBody({ token: unpricedTokenBody() }) }),
    tokenMarketData: r.call("tokenMarketData", {
      body: {
        ...noPool(),
        reason: "depth_inconclusive",
        detail: "…a pool that ranked below the leader reported a LOWER BOUND… Every pool was read.",
      },
    }),
  });

  const res = await gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls });
  const { pool, priceStatus, priceStatusReason } = res.evidence.token;

  assert.equal(pool.reason, "depth_inconclusive");
  assert.equal(pool.outage, true, "never 'no pool exists' — the question is open");
  assert.equal(pool.misconfigured, false);
  assert.equal(priceStatus, "unavailable");
  assert.match(priceStatusReason, /all read but did not settle which is the deepest/);
  assert.match(priceStatusReason, /unresolved comparison, not an outage/);
  assert.doesNotMatch(priceStatusReason, /could not be read either/);
});

test("O2: a bound ABOVE the floor names its covered range too", async () => {
  // The same qualifier on the path where the pool is not thin: the figure clears the
  // floor, so `thinLiquidity` is a real false — and the sentence still has to say the
  // walk was capped and how far it got, or "at least $X" is a claim with no shape.
  const r = recorder();
  const calls = tokenCalls(r, {
    getToken: r.call("getToken", { body: unpricedTokenBody() }),
    getAddress: r.call("getAddress", { body: overviewBody({ token: unpricedTokenBody() }) }),
    tokenMarketData: r.call("tokenMarketData", {
      body: {
        ...vladPool(),
        quoteLiquidityUsd: 1_324.13,
        quoteBalanceUsd: 69_679.77,
        depthIsLowerBound: true,
        depthCoveredBandBps: 24.242147821362803,
        thinLiquidity: false,
      },
    }),
  });

  const { pool } = (await gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls })).evidence.token;
  assert.equal(pool.thinLiquidity, false);
  assert.match(pool.liquidityNotice, /at least \$1\.32K of WETH realisable/);
  assert.match(pool.liquidityNotice, /capped after the 0\.242% nearest the market/);
  assert.match(pool.liquidityNotice, /Say “at least”/);
});

test("an indexer-priced token never touches the pool", async () => {
  const r = recorder();
  const res = await gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls: tokenCalls(r) });

  // The 94 equities keep their feed and pay none of the RPC latency: this is a
  // fallback, not a replacement, and the common path must not get slower.
  assert.equal(r.saw("tokenMarketData"), false, "no pool read when the indexer already priced it");
  assert.equal(res.evidence.token.priceSource, "indexer");
  assert.equal(res.evidence.token.pool, null);
  assert.equal(res.evidence.token.priceUsd, "212.5");
});

test("a pool read that could not answer is 'unavailable', never 'no price'", async () => {
  const r = recorder();
  const calls = tokenCalls(r, {
    getToken: r.call("getToken", { body: unpricedTokenBody() }),
    getAddress: r.call("getAddress", { body: overviewBody({ token: unpricedTokenBody() }) }),
    tokenMarketData: r.call("tokenMarketData", {
      body: {
        ...noPool(),
        reason: "discovery_failed",
        detail: "The pool lookup did not complete — the RPC and the indexer both failed to answer.",
      },
    }),
  });

  const res = await gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls });

  // Whether this token has a market is now UNKNOWN. Reporting it as unpriced
  // would be an outage rendered as a fact about the chain.
  assert.equal(res.evidence.token.priceStatus, "unavailable");
  assert.match(res.evidence.token.priceStatusReason, /could not be read either/i);
  assert.match(res.evidence.token.priceStatusReason, /an outage, not a token without a price/i);
  assert.equal(res.evidence.token.priceUsd, null, "and never zero");
  assert.ok(res.evidence.unavailable.includes("poolPrice"), "named as a missing source");
  assert.equal(res.degraded, true);
});

test("a pool read that throws costs the pool price and nothing else", async () => {
  const r = recorder();
  const calls = tokenCalls(r, {
    getToken: r.call("getToken", { body: unpricedTokenBody() }),
    getAddress: r.call("getAddress", { body: overviewBody({ token: unpricedTokenBody() }) }),
    tokenMarketData: r.call("tokenMarketData", { status: 500 }),
  });

  const res = await gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls });

  assert.equal(res.ok, true, "the rest of the answer still ships");
  assert.equal(res.evidence.token.priceStatus, "unavailable");
  assert.equal(res.evidence.token.pool, null);
  assert.ok(res.evidence.unavailable.includes("poolPrice"));
  // Everything the answer actually leads with is untouched.
  assert.equal(res.evidence.token.holders, 28899);
  assert.equal(res.evidence.token.totalSupply, "1B ANDY");
});

test("a pool read that blows its budget is a missing source, not a missing market", async () => {
  const r = recorder();
  const calls = tokenCalls(r, {
    getToken: r.call("getToken", { body: unpricedTokenBody() }),
    getAddress: r.call("getAddress", { body: overviewBody({ token: unpricedTokenBody() }) }),
    // A promise nobody resolves, not the `hang` timer: the pool read takes no
    // AbortSignal, so a 60s timer inside the fake would outlive the deadline it
    // is meant to demonstrate and hold the test runner open for a full minute.
    tokenMarketData: () => new Promise(() => {}),
  });

  const res = await gatherEvidence(TOKEN, {
    known: KNOWN_TOKEN,
    calls,
    deadlines: { essential: 5_000, enrichment: 5_000, pool: 25 },
  });

  assert.equal(res.ok, true);
  assert.equal(res.evidence.token.priceStatus, "unavailable");
  assert.ok(res.evidence.unavailable.includes("poolPrice"));
});

test("a token with neither feed nor pool says so plainly, once", async () => {
  const r = recorder();
  const calls = tokenCalls(r, {
    getToken: r.call("getToken", { body: unpricedTokenBody() }),
    getAddress: r.call("getAddress", { body: overviewBody({ token: unpricedTokenBody() }) }),
  });

  const res = await gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls });

  assert.equal(res.evidence.token.priceStatus, "not_indexed");
  assert.equal(res.evidence.token.priceSource, null);
  assert.match(res.evidence.token.priceStatusReason, /no price feed for this contract/i);
  assert.match(res.evidence.token.priceStatusReason, /no Uniswap v3 pool/i);
  assert.match(res.evidence.token.priceStatusReason, /Unpriced is not priced at zero/i);
  assert.equal(res.evidence.token.priceUsd, null);
  assert.equal(res.evidence.token.pool.priced, false);
  assert.equal(res.degraded, undefined, "nothing failed — there is simply no market");
});

test("the stock block does not contradict the token block about the same contract", async () => {
  const r = recorder();
  // The resolver only ever holds the indexer's figures, and the indexer prices
  // almost nothing outside the 94 equities. Left alone, the block the model reads
  // FIRST said there was no price while the one below it carried a real one.
  const calls = tokenCalls(r, {
    getToken: r.call("getToken", { body: unpricedTokenBody() }),
    getAddress: r.call("getAddress", { body: overviewBody({ token: unpricedTokenBody() }) }),
    tokenMarketData: r.call("tokenMarketData", { body: vladPool() }),
    resolveSymbol: r.call("resolveSymbol", {
      body: {
        ok: true,
        query: "ANDY",
        match: { address: TOKEN, symbol: "ANDY", name: "Andy", company: "Andy", price: null, marketCap: null, holders: 7635 },
        official: false,
        impostors: [],
      },
    }),
  });

  const res = await gatherEvidence("andy", { calls });
  const { stock, token } = res.evidence;

  assert.equal(stock.price, token.priceUsd);
  assert.equal(stock.marketCap, token.marketCapUsd);
  assert.equal(stock.display.price, "$0.0004047");
  assert.equal(stock.display.marketCap, "$404.69K");
  assert.equal(stock.priceSource, "uniswap_v3");
  assert.match(stock.priceSourceNotice, /derived from the Uniswap v3 pool/i);
  // Volume has no pool equivalent, so it stays absent in both.
  assert.equal(stock.display.volume24h, null);
});

test("a token with more than one pool says the figures came from the deepest", async () => {
  // F1's disclosure half. Anyone may deploy an empty pool for a token they have
  // nothing to do with, so the pool a price comes from is now a CHOICE — and a
  // choice the reader is told about rather than left to assume away.
  const r = recorder();
  const calls = tokenCalls(r, {
    getToken: r.call("getToken", { body: unpricedTokenBody() }),
    getAddress: r.call("getAddress", { body: overviewBody({ token: unpricedTokenBody() }) }),
    tokenMarketData: r.call("tokenMarketData", { body: { ...vladPool(), poolCount: 2 } }),
  });

  const { pool } = (await gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls })).evidence.token;
  assert.equal(pool.poolCount, 2);
  assert.match(pool.sourceNotice, /2 Uniswap v3 pools; the figures come from whichever measured the greatest realisable depth/);
  // THE SENTENCE THAT MUST NOT COME BACK. It used to end by offering the selection
  // rule — "the choice is made on tradeable depth" — as a reason to trust the
  // result, while that rule was exactly what an attacker games: a pool with rented
  // depth would have been chosen the same way. Naming your own defence as grounds
  // for belief tells the reader something false about what was proved.
  assert.doesNotMatch(pool.sourceNotice, /the choice is made on tradeable depth/);
  assert.match(pool.sourceNotice, /not a warrant of authenticity/);

  // …and one pool says nothing extra, because there was no choice to disclose.
  const r2 = recorder();
  const single = tokenCalls(r2, {
    getToken: r2.call("getToken", { body: unpricedTokenBody() }),
    getAddress: r2.call("getAddress", { body: overviewBody({ token: unpricedTokenBody() }) }),
    tokenMarketData: r2.call("tokenMarketData", { body: { ...vladPool(), poolCount: 1 } }),
  });
  const one = (await gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls: single })).evidence.token;
  assert.doesNotMatch(one.pool.sourceNotice, /DEEPEST/);
});

test("a SOLE indexer-priced contract still cannot quote its cap naked", async () => {
  // THE F7 REGRESSION. lib/stock-tokens.js withQuoteDepth measures nothing when the
  // top relevance tier holds ONE contract, so `collision` is null — and the cap
  // qualifier used to be gated on a collision existing. The commonest shape of the
  // bug it exists to stop therefore slipped straight through: a lone squatter the
  // indexer happens to price, reaching the answer with a $3.86M cap and nothing
  // beside it, while the prompt read the silence as proof of proportionality.
  const r = recorder();
  const calls = tokenCalls(r, {
    getToken: r.call("getToken", { body: unpricedTokenBody() }),
    getAddress: r.call("getAddress", { body: overviewBody({ token: unpricedTokenBody() }) }),
    resolveSymbol: r.call("resolveSymbol", {
      body: {
        ok: true,
        query: "SOLO",
        match: { address: TOKEN, symbol: "SOLO", name: "Solo", company: "Solo", price: 0.004, marketCap: 3_855_217, holders: 52_214 },
        official: false,
        impostors: [],
        // One candidate in the tier: nothing was measured, and null here means
        // NOT MEASURED rather than "nothing dominates".
        collision: null,
      },
    }),
  });

  const { stock } = (await gatherEvidence("solo", { calls })).evidence;

  assert.equal(stock.marketCap, 3_855_217);
  assert.equal(stock.quoteLiquidityUsd, null, "no depth was read, and null says so");
  assert.ok(stock.capNotice, "the cap may not travel alone just because nobody measured its depth");
  assert.match(stock.capNotice, /was not measured/);
  assert.match(stock.capNotice, /never that it is deep and never that it is thin/);
});

test("an issuer-verified equity is NOT given a caveat about a read nobody made", async () => {
  // The overcorrection this stays clear of: NVDA never reads a pool, because the
  // deployer settles its ticker, and hanging "how much of this is realisable was
  // not measured" off a real equity's cap would be a caveat about nothing.
  const r = recorder();
  const calls = tokenCalls(r, {
    resolveSymbol: r.call("resolveSymbol", {
      body: {
        ok: true,
        query: "AAPL",
        match: { address: TOKEN, symbol: "AAPL", company: "Apple", price: 240, marketCap: 4_160_816, holders: 28_899 },
        official: true,
        impostors: [],
        collision: null,
      },
    }),
  });

  const { stock } = (await gatherEvidence("aapl", { calls })).evidence;
  assert.equal(stock.official, true);
  assert.equal(stock.capNotice, null);
});

test("the pool read runs alongside the enrichment, not behind it", async () => {
  const r = recorder();
  const holders = r.gated("getTokenHolders", { items: [] });
  const calls = tokenCalls(r, {
    getToken: r.call("getToken", { body: unpricedTokenBody() }),
    getAddress: r.call("getAddress", { body: overviewBody({ token: unpricedTokenBody() }) }),
    getTokenHolders: holders.fn,
    tokenMarketData: r.call("tokenMarketData", { body: vladPool() }),
  });

  const pending = gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls });
  await flush();

  // The token body is the only thing it waits for — it has to know the indexer
  // has no quote before it may ask the chain. Everything after that overlaps.
  assert.equal(r.saw("tokenMarketData"), true, "started while the holder call is still open");
  holders.release();
  assert.equal((await pending).evidence.token.priceStatus, "pool_priced");
});

/* ------------------------------ deadlines ------------------------------ */

test("an enrichment call that misses its deadline is reported unavailable, not empty", async () => {
  const r = recorder();
  const calls = tokenCalls(r, { getTokenHolders: r.call("getTokenHolders", { hang: true }) });

  const res = await gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls, deadlines: { essential: 5_000, enrichment: 25 } });

  assert.equal(res.ok, true, "the answer still arrives");
  assert.equal(res.degraded, true);
  assert.ok(res.evidence.unavailable.includes("topHolders"), "named as missing");
  assert.equal(res.evidence.topHolders, null, "null, never [] — an empty list asserts there are no holders");
  assert.equal(res.evidence.holderConcentrationTop10Pct, null, "and never 0%, which would be a claim");
  // The field that timed out is the only casualty.
  assert.ok(Array.isArray(res.evidence.recentTransfers));
  assert.equal(res.evidence.token.symbol, "AAPL");
  assert.ok(!res.evidence.unavailable.includes("token"));
});

test("the enrichment deadline is shorter than the essential one, and only cuts enrichment", async () => {
  const r = recorder();
  const calls = tokenCalls(r, {
    // Slower than the enrichment deadline, faster than the essential one: token
    // metadata is the answer, so it gets to finish.
    getToken: r.call("getToken", { body: tokenBody(), ms: 60 }),
    getTokenActivity: r.call("getTokenActivity", { hang: true }),
  });

  const res = await gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls, deadlines: { essential: 5_000, enrichment: 25 } });
  assert.equal(res.evidence.token.symbol, "AAPL", "the essential call outlived the enrichment deadline");
  assert.ok(res.evidence.unavailable.includes("recentTransfers"));
  assert.equal(res.evidence.recentTransfers, null);
});

test("every call is handed a deadline signal", async () => {
  const seen = [];
  const spy = (name) => (...args) => {
    const last = args[args.length - 1];
    seen.push([name, Boolean(last && typeof last === "object" && last.signal instanceof AbortSignal)]);
    return Promise.resolve({});
  };
  const calls = {
    getToken: spy("getToken"),
    getTokenCounters: spy("getTokenCounters"),
    getTokenHolders: spy("getTokenHolders"),
    getTokenActivity: spy("getTokenActivity"),
    getAddress: spy("getAddress"),
    // Not one of the five, and deliberately not spied: it takes no signal because
    // it is not an indexer call. Stubbed only so this stays offline — an empty
    // token body reads as unpriced, which is what sends the gather to the pool.
    tokenMarketData: async () => ({ price: null, source: "uniswap_v3", reason: "no_pool" }),
  };
  // An empty body from getToken/getAddress makes this a "not a token after all"
  // gather; what matters is that all five were called with a signal.
  await gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls: { ...calls, ...walletCalls(recorder()) } });
  assert.equal(seen.length, 5);
  for (const [name, hadSignal] of seen) assert.ok(hadSignal, `${name} was called without a deadline`);
});

/* ------------------------------ no options at all ------------------------------ */

test("gatherEvidence with no options touches nothing it did not touch before", async () => {
  // The junk-options cases must land on the real defaults rather than throwing,
  // because every existing caller passes exactly one argument.
  for (const options of [undefined, null, {}, "hint", 7, { known: undefined, calls: null, deadlines: 0 }]) {
    const res = await gatherEvidence("not a target at all", options);
    assert.equal(res.ok, false);
    assert.equal(res.kind, "unknown");
    assert.match(res.error, /Not a recognizable Robinhood Chain address/);
  }
});

test("the transaction path keeps its shape and puts logs on the enrichment deadline", async () => {
  const r = recorder();
  const hash = `0x${"a".repeat(64)}`;
  const calls = {
    getTransaction: r.call("getTransaction", {
      body: { hash, status: "ok", method: "transfer", from: { hash: WALLET }, to: { hash: PEER }, value: "1000000000000000000", fee: { value: "21000000000000" }, block_number: 42, timestamp: "2026-07-25T00:00:00Z", token_transfers: [] },
      ms: 40,
    }),
    getTransactionLogs: r.call("getTransactionLogs", { hang: true }),
  };

  const res = await gatherEvidence(hash, { calls, deadlines: { essential: 5_000, enrichment: 20 } });
  assert.equal(res.ok, true);
  assert.equal(res.kind, "tx");
  assert.equal(res.valueEth, undefined);
  assert.equal(res.evidence.valueEth, 1);
  assert.equal(res.evidence.feeEth, 0.000021);
  assert.equal(res.evidence.logCount, null, "null, not 0 — a timed-out logs call is not 'no logs'");
  assert.equal(res.evidence.decodedLogs, null);
  assert.ok(res.evidence.unavailable.includes("decodedLogs"));
});
