// Tests for NAMING THE CONTRACT on every symbol lookup, not just the 94
// issuer-verified equities.
//
// Measured live before this: asking about VLAD resolved to
// 0x31BE8f7485e36928C9De86566c62da82d4B6BF81, whose symbol is VLAD and whose NAME
// IS "The Green Bull". Two other contracts on the same chain also answer to VLAD.
// The answer quoted one contract's figures with total confidence and never said
// which one it had picked, so a reader holding a different VLAD saw numbers that
// looked simply wrong rather than numbers about a different token.
//
// Fully offline, and it now takes TWO stubs to be so. lib/stock-tokens.js reaches
// the indexer through lib/blockscout.js, which is one fetch, so globalThis.fetch
// is stubbed; and it reaches the CHAIN through the depth probe, which is RPC, so
// resolveSymbol's depthProbe seam is stubbed too. Run with: npm test
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveSymbol } from "../lib/stock-tokens.js";
import { resetIndexerCache } from "../lib/indexer-cache.js";
import { gatherEvidence } from "../lib/ask-evidence.js";
import registry from "../config/stock-tokens.json" with { type: "json" };

/* --------------------------- the VLAD collision --------------------------- */

const GREEN_BULL = "0x31be8f7485e36928c9de86566c62da82d4b6bf81";
const VLAD_PROPER = "0x5ad6fad7794f4118fa119dc6f5652f360f3b8eb5";
const VLADDY = "0xa9038d2c4e798d10dd46c2fdb1f72c9b397bbdad";

/**
 * The explorer's /search rows for "VLAD", as measured.
 *
 * THE GREEN BULL'S ROW CARRIES exchange_rate AND volume_24h and the others do not,
 * and that asymmetry is the live one: Blockscout quotes essentially nothing outside
 * the 94 verified equities, and it quotes this contract because it is the one with
 * a market. Those two fields are the CORROBORATION LEG — the second, independent
 * instrument a dominance verdict now has to have before it will name a winner.
 */
function vladSearchItems() {
  return [
    // Wins the tie on holders — and its name is nothing like the ticker.
    {
      address_hash: GREEN_BULL,
      name: "The Green Bull",
      symbol: "VLAD",
      holders_count: "1336",
      circulating_market_cap: "243000",
      exchange_rate: "0.00024519",
      volume_24h: "2808.23",
    },
    { address_hash: VLAD_PROPER, name: "VLAD", symbol: "VLAD", holders_count: "449" },
    { address_hash: VLADDY, name: "vladdy", symbol: "VLAD", holders_count: "202", circulating_market_cap: "7900" },
    // Neighbours that merely look similar: they must NOT inflate the count.
    { address_hash: `0x${"1".repeat(40)}`, name: "Vladhood", symbol: "VLADHOOD", holders_count: "12" },
    { address_hash: `0x${"2".repeat(40)}`, name: "VLADDOG", symbol: "VLADDOG", holders_count: "8" },
  ];
}

/**
 * The depth probe, stubbed. resolveSymbol reads the CHAIN as well as the indexer
 * now — the pool measurement goes out over RPC, not through lib/blockscout.js —
 * and the fetch stub below would only stop that by accident, because viem happens
 * to choke on a body that is not a JSON-RPC envelope. Passing a probe makes being
 * offline an assertion instead of a coincidence.
 *
 * The figures are the live census: The Green Bull holds $69,583.29 of realisable
 * quote-side liquidity and every other VLAD holds dust.
 */
const DEPTHS = { [GREEN_BULL]: 69583.29, [VLAD_PROPER]: 2.52, [VLADDY]: 0.34 };
const stubProbe = (asked = []) => async (address) => {
  asked.push(address);
  return DEPTHS[address] ?? null;
};

/**
 * Swap globalThis.fetch for a router over the two endpoints resolveSymbol uses:
 * the /tokens page walk (the official equity list) and /search.
 *
 * @param {{ tokens?: object, search?: (q: string) => object, address?: object }} routes
 *   - a route returning null answers 500, which is how an outage is spelled here.
 *   `address` backs the DEPLOYER check, which decides `official` on every branch.
 */
function stubChain({
  tokens = { items: [] },
  search = () => ({ items: vladSearchItems() }),
  address = { creator_address_hash: `0x${"9".repeat(40)}` },
} = {}) {
  const real = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    const body = u.includes("/search?")
      ? search(decodeURIComponent(u.split("q=")[1] ?? ""))
      : /\/addresses\//.test(u)
        ? address
        : tokens;
    if (body == null) {
      return { ok: false, status: 500, statusText: "Server Error", json: async () => null };
    }
    return { ok: true, status: 200, statusText: "OK", json: async () => body };
  };
  return {
    urls,
    restore() {
      globalThis.fetch = real;
    },
  };
}

let stockTtl;

beforeEach(() => {
  resetIndexerCache();
  // The equity list has its own 5-minute cache; a test must not inherit the
  // previous one's stubbed page walk.
  stockTtl = process.env.STOCK_CACHE_TTL_MS;
  process.env.STOCK_CACHE_TTL_MS = "0";
});

afterEach(() => {
  resetIndexerCache();
  if (stockTtl === undefined) delete process.env.STOCK_CACHE_TTL_MS;
  else process.env.STOCK_CACHE_TTL_MS = stockTtl;
});

test("an unofficial ticker resolves with its contract, its real name and the collision count", async () => {
  const chain = stubChain();
  try {
    const res = await resolveSymbol("VLAD", { depthProbe: stubProbe() });
    assert.equal(res.ok, true);
    assert.equal(res.official, false, "nothing outside the 94 is official");
    assert.equal(res.match.address, GREEN_BULL, "the ticker is not the identity — the address is");
    assert.equal(res.match.symbol, "VLAD");
    assert.equal(res.match.name, "The Green Bull", "the fact the old answer never mentioned");
    assert.equal(res.impostorsRead, true);
    assert.equal(res.impostors.length, 2, "VLADHOOD and VLADDOG wear different tickers");
    assert.deepEqual(
      res.impostors.map((i) => i.address).sort(),
      [VLAD_PROPER, VLADDY].sort(),
      "each collision is named, not just counted",
    );
  } finally {
    chain.restore();
  }
});

test("a name-shaped query still gets the collision check on the resolved TICKER", async () => {
  // The search runs on what the user typed. "green bull" finds the contract but
  // says nothing about who else answers to VLAD, so the check is re-run on the
  // symbol we landed on.
  const chain = stubChain({
    search: (q) =>
      q.toUpperCase() === "VLAD"
        ? { items: vladSearchItems() }
        : { items: [vladSearchItems()[0]] },
  });
  try {
    const res = await resolveSymbol("green bull", { depthProbe: stubProbe() });
    assert.equal(res.match.address, GREEN_BULL);
    assert.equal(res.match.symbol, "VLAD");
    assert.equal(res.impostorsRead, true);
    assert.equal(res.impostors.length, 2, "the query found one row; the ticker has three contracts");
  } finally {
    chain.restore();
  }
});

test("a collision search that did not answer is null, never zero", async () => {
  // An outage rendering as "no other contract uses this ticker" is the one place
  // where a missing check reads to the user as reassurance.
  const chain = stubChain({
    search: (q) => (q.toUpperCase() === "VLAD" ? null : { items: [vladSearchItems()[0]] }),
  });
  try {
    const res = await resolveSymbol("green bull", { depthProbe: stubProbe() });
    assert.equal(res.ok, true, "the token still resolved");
    assert.equal(res.match.address, GREEN_BULL);
    assert.equal(res.impostors, null, "null is 'we did not look', 0 would be a claim about the chain");
    assert.equal(res.impostorsRead, false);
  } finally {
    chain.restore();
  }
});

test("a search that never ran at all is unknown, not 'no such ticker'", async () => {
  const chain = stubChain({ search: () => null });
  try {
    const res = await resolveSymbol("VLAD", { depthProbe: stubProbe() });
    assert.equal(res.ok, false);
    assert.equal(res.impostors, null);
    assert.equal(res.impostorsRead, false);
    assert.match(res.reason, /unknown, not absent/);
  } finally {
    chain.restore();
  }
});

test("the ticker goes to the deepest pool, and the verdict travels with it", async () => {
  const chain = stubChain();
  const asked = [];
  try {
    const res = await resolveSymbol("VLAD", { depthProbe: stubProbe(asked) });
    assert.equal(res.match.address, GREEN_BULL);
    // Only the exact-symbol tier is probed: VLADHOOD and VLADDOG are already
    // outranked by the tiers, so no measurement about them can change the answer.
    assert.deepEqual(asked.sort(), [GREEN_BULL, VLADDY, VLAD_PROPER].sort());
    assert.equal(res.collision.verdict, "dominant");
    assert.equal(res.collision.topDepthUsd, 69583.29);
    assert.equal(res.collision.candidateCount, 3);
    assert.equal(res.collision.dropped, 0);
    assert.match(res.collision.notice, /do not offer the reader a menu/);
    // BOTH LEGS, AND THEY AGREE — which is what makes it dominance rather than one
    // rentable number naming a winner. The depth leg and the indexer's own trading
    // record point at the same contract.
    assert.equal(res.collision.legs.depth.leader, GREEN_BULL);
    assert.equal(res.collision.legs.trading.leader, GREEN_BULL);
    assert.equal(res.collision.legs.trading.signal, "volume_24h");
    assert.equal(res.collision.legs.agree, true);
    assert.match(res.collision.notice, /indexer independently agrees/);
  } finally {
    chain.restore();
  }
});

test("depth alone does not name a winner when the indexer is silent about everybody", async () => {
  // Strip the corroboration leg and nothing else. The depth gap is identical —
  // $69,583.29 against $2.52 — and it is no longer enough on its own, because a
  // depth snapshot is capital that can be moved and there is no second instrument
  // saying anything happened.
  const chain = stubChain({
    search: () => ({ items: vladSearchItems().map(({ exchange_rate, volume_24h, ...row }) => row) }),
  });
  try {
    const res = await resolveSymbol("VLAD", { depthProbe: stubProbe() });
    assert.equal(res.collision.verdict, "uncorroborated");
    assert.equal(res.collision.dominant, false, "not dominance on one leg");
    assert.equal(res.collision.ambiguous, false, "and not a menu either — nothing disagreed");
    assert.equal(res.collision.legs.trading.signal, null);
    assert.equal(res.match.address, GREEN_BULL, "it is still the contract to report on");
    assert.match(res.collision.notice, /second instrument is SILENT/);
    assert.match(res.collision.notice, /do NOT call it dominant/);
  } finally {
    chain.restore();
  }
});

test("a deep pool and the trading record naming DIFFERENT contracts asks instead of choosing", async () => {
  // The conflict the two legs exist to expose: all the pooled capital sits behind
  // one contract and every settled trade happened on another. Neither overrides the
  // other — depth can be withdrawn, volume already paid the fee — so the reader is
  // asked, and told what disagreed.
  const chain = stubChain({
    search: () => ({
      items: vladSearchItems().map((row) =>
        row.address_hash === GREEN_BULL
          ? { ...row, exchange_rate: undefined, volume_24h: undefined }
          : row.address_hash === VLAD_PROPER
            ? { ...row, exchange_rate: "0.0004", volume_24h: "51200" }
            : row,
      ),
    }),
  });
  try {
    const res = await resolveSymbol("VLAD", { depthProbe: stubProbe() });
    assert.equal(res.collision.verdict, "conflicted");
    assert.equal(res.collision.ambiguous, true, "it asks through the same path 'ambiguous' does");
    assert.equal(res.collision.legs.depth.leader, GREEN_BULL);
    assert.equal(res.collision.legs.trading.leader, VLAD_PROPER);
    assert.equal(res.collision.legs.conflict, true);
    assert.equal(res.collision.contenders.length, 2, "the two the legs named, not the depth contenders");
    assert.match(res.collision.notice, /two measurements DISAGREE/i);
    assert.match(res.collision.clarifyQuestion, /disagree/i);
  } finally {
    chain.restore();
  }
});

test("a probe that fails everywhere leaves the verdict unmeasured, and the ranking falls back", async () => {
  const chain = stubChain();
  try {
    const res = await resolveSymbol("VLAD", { depthProbe: async () => null });
    assert.equal(res.collision.verdict, "unmeasured");
    assert.equal(res.collision.topDepthUsd, null, "never zero");
    assert.match(res.collision.notice, /unknown — not that none does/);
    // Nothing measured, so holder count is what is left — and the answer still
    // ships rather than failing on an RPC that would not answer.
    assert.equal(res.match.address, GREEN_BULL, "1,336 holders is the most of the three");
  } finally {
    chain.restore();
  }
});

/* --------------------- official is a fact about the DEPLOYER --------------- */

test("a genuine equity found by the search fallback is still labelled official", async () => {
  // THE F6 REGRESSION, and the route into it is deterministic rather than exotic.
  // During an indexer brownout the /tokens page walk comes back empty, so
  // pickBestMatch over the official list finds nothing and the search fallback is
  // what selects the contract. `official` was hardcoded false on that branch, so
  // the REAL NVDA — snapshot address, issuer-verified, correctly chosen — was
  // reported as "not an official Robinhood tokenized equity".
  const realNvda = String(registry.tokens.find((t) => t.symbol === "NVDA").address).toLowerCase();
  const chain = stubChain({
    // The brownout: the equity list answers with nothing.
    tokens: { items: [] },
    search: () => ({
      items: [
        { address_hash: realNvda, name: "NVIDIA • Robinhood Token", symbol: "NVDA", holders_count: "28899" },
        { address_hash: `0x${"c".repeat(40)}`, name: "NVIDIA • Robinhood Token", symbol: "NVDA", holders_count: "900000" },
      ],
    }),
    address: { creator_address_hash: registry.issuer },
  });
  try {
    const res = await resolveSymbol("NVDA", { depthProbe: stubProbe() });
    assert.equal(res.match.address, realNvda, "the issuer check outranks 900,000 holders");
    assert.equal(res.official, true, "the deployer decides, not which branch found it");
    assert.equal(res.reason, undefined, "and it must not be described as unverified");
  } finally {
    chain.restore();
  }
});

test("a byte-identical clone the deployer disowns is still unofficial", async () => {
  // The other direction, so the fix cannot be "call everything official".
  const chain = stubChain({
    search: () => ({
      items: [{ address_hash: `0x${"c".repeat(40)}`, name: "NVIDIA • Robinhood Token", symbol: "NVDA", holders_count: "900000" }],
    }),
    address: { creator_address_hash: `0x${"9".repeat(40)}` },
  });
  try {
    const res = await resolveSymbol("NVDA", { depthProbe: stubProbe() });
    assert.equal(res.match.address, `0x${"c".repeat(40)}`);
    assert.equal(res.official, false);
    assert.match(res.reason, /Not an official Robinhood tokenized equity/);
  } finally {
    chain.restore();
  }
});

/* ----------------------- the evidence the model sees ----------------------- */

const TOKEN_CALLS = Object.freeze({
  // This token carries no exchange_rate, so the evidence layer reaches for its
  // Uniswap v3 pool. Stubbed to a measured "nothing trades this", which is the
  // only way this file stays offline — that one call reads the chain by RPC and
  // not through the fetch stub above.
  tokenMarketData: async () => ({ price: null, marketCap: null, source: "uniswap_v3", pool: null, reason: "no_pool" }),
  snapshotMatch: () => null,
  listStockTokens: async () => [],
  getTokenCounters: async () => ({ token_holders_count: 1336, transfers_count: 90 }),
  getTokenHolders: async () => ({ items: [] }),
  getTokenActivity: async () => ({ items: [] }),
  getAddress: async () => ({ hash: GREEN_BULL, is_verified: false, creator_address_hash: `0x${"9".repeat(40)}` }),
  getToken: async () => ({
    name: "The Green Bull",
    symbol: "VLAD",
    type: "ERC-20",
    decimals: "18",
    total_supply: "1000000000000000000000",
    circulating_market_cap: "243000",
  }),
});

/** gatherEvidence for a ticker, with the resolver's verdict supplied. */
function askTicker(symbol, resolved) {
  return gatherEvidence(symbol, { calls: { ...TOKEN_CALLS, resolveSymbol: async () => resolved } });
}

test("the stock block names the contract and its real name for an unofficial token", async () => {
  const res = await askTicker("vlad", {
    ok: true,
    query: "VLAD",
    match: { address: GREEN_BULL, symbol: "VLAD", name: "The Green Bull", company: "The Green Bull", marketCap: 243000, holders: 1336 },
    official: false,
    impostors: [
      { address: VLAD_PROPER, symbol: "VLAD", name: "VLAD", holders: 449 },
      { address: VLADDY, symbol: "VLAD", name: "vladdy", holders: 202 },
    ],
    impostorsRead: true,
  });

  assert.equal(res.ok, true);
  const stock = res.evidence.stock;
  assert.equal(stock.address, GREEN_BULL);
  assert.equal(stock.name, "The Green Bull", "the name travels with every symbol lookup now");
  assert.equal(stock.impostorCount, 2);
  assert.match(stock.identityNotice, /The Green Bull/);
  assert.match(stock.identityNotice, new RegExp(GREEN_BULL));
  assert.match(stock.identityNotice, /symbol is VLAD/);
});

test("a verified equity keeps exactly the wording it had", async () => {
  // Those already lead with a stronger warning and print the address in full; a
  // second, softer sentence beside it would only dilute it.
  const res = await askTicker("aapl", {
    ok: true,
    query: "AAPL",
    match: { address: GREEN_BULL, symbol: "AAPL", name: "Apple • Robinhood Token", company: "Apple" },
    official: true,
    impostors: [],
    impostorsRead: true,
  });
  const stock = res.evidence.stock;
  assert.equal(stock.identityNotice, null, "no second notice on the verified path");
  assert.equal(stock.impostorWarning, null, "and the existing warning is unchanged");
  assert.equal(stock.name, "Apple • Robinhood Token");
});

test("an indexer-quoted cap is still qualified by the depth the collision probe read", async () => {
  // THE GAP THIS CLOSES. The pool fallback only fires when the indexer had NO
  // quote, so a contract the indexer does price reached the answer with a market
  // cap and nothing beside it — which is exactly the shape "$3.86M behind $1.03"
  // arrives in. The collision resolver has already read that contract's pool to
  // decide the ticker, so the figure is in hand and costs nothing more.
  const res = await askTicker("vlad", {
    ok: true,
    query: "VLAD",
    match: { address: GREEN_BULL, symbol: "VLAD", name: "The Robinhood", company: "The Robinhood", price: 0.0004, marketCap: 3_855_217, holders: 52_214 },
    official: false,
    impostors: [],
    impostorsRead: true,
    collision: {
      symbol: "VLAD",
      verdict: "dominant",
      contenders: [],
      measuredRows: [{ address: GREEN_BULL, quoteLiquidityUsd: 1.03 }],
    },
  });

  const stock = res.evidence.stock;
  assert.equal(stock.priceSource, "indexer");
  assert.equal(stock.quoteLiquidityUsd, 1.03);
  assert.equal(stock.depthSource, "uniswap_v3");
  assert.match(stock.capNotice, /\$3\.86M/);
  assert.match(stock.capNotice, /\$1\.03/);
  // TWO INSTRUMENTS, NEVER BLENDED — the cap is the indexer's and the depth is
  // ours, and the sentence says which is which.
  assert.match(stock.capNotice, /two different instruments/);
  assert.match(stock.capNotice, /never blended/);
  assert.match(stock.capNotice, /not evidence of a scam/);
});

test("a cap proportionate to the depth measured beside it gets no qualifier", async () => {
  const res = await askTicker("vlad", {
    ok: true,
    query: "VLAD",
    match: { address: GREEN_BULL, symbol: "VLAD", name: "The Green Bull", company: "The Green Bull", price: 0.00023839681962609913, marketCap: 238_397, holders: 1334 },
    official: false,
    impostors: [],
    impostorsRead: true,
    collision: { symbol: "VLAD", verdict: "dominant", contenders: [], measuredRows: [{ address: GREEN_BULL, quoteLiquidityUsd: 69_583.29 }] },
  });
  const stock = res.evidence.stock;
  assert.equal(stock.quoteLiquidityUsd, 69_583.29);
  assert.equal(stock.capNotice, null, "$238K behind $69.6K needs no warning label");
});

test("a probe that ran and could not read this contract leaves the cap qualified as unknown", async () => {
  const res = await askTicker("vlad", {
    ok: true,
    query: "VLAD",
    match: { address: GREEN_BULL, symbol: "VLAD", name: "The Green Bull", company: "The Green Bull", marketCap: 3_855_217 },
    official: false,
    impostors: [],
    impostorsRead: true,
    // The measurement was attempted and this contract was not among the rows it
    // came back with.
    collision: { symbol: "VLAD", verdict: "unmeasured", contenders: [], measuredRows: [] },
  });
  const stock = res.evidence.stock;
  assert.equal(stock.quoteLiquidityUsd, null);
  assert.equal(stock.depthSource, null);
  // UNKNOWN depth, never deep and never thin.
  assert.match(stock.capNotice, /was not measured/);
  assert.match(stock.capNotice, /never that it is deep and never that it is thin/);
});

test("an issuer-verified equity gets no depth caveat, because no depth was ever sought", async () => {
  // NVDA's ticker is settled by its deployer, so no pool is read for it — and
  // hanging "how much of this is realisable was not measured" off a $4.63M equity
  // cap would be a caveat about a read nobody made. Measured live before this
  // gate existed: it fired, and it changed NVDA's answer.
  const res = await askTicker("nvda", {
    ok: true,
    query: "NVDA",
    match: { address: GREEN_BULL, symbol: "NVDA", name: "NVIDIA • Robinhood Token", company: "NVIDIA", price: 197.43, marketCap: 4_625_582 },
    official: true,
    impostors: [],
    impostorsRead: true,
    collision: null,
  });
  const stock = res.evidence.stock;
  assert.equal(stock.capNotice, null);
  assert.equal(stock.quoteLiquidityUsd, null);
  assert.equal(stock.collision, null, "null is 'not measured', never 'nothing dominates'");
});

test("an unofficial token whose name matches its ticker still gets its contract named", async () => {
  const res = await askTicker("vlad", {
    ok: true,
    query: "VLAD",
    match: { address: VLAD_PROPER, symbol: "VLAD", name: "VLAD", company: "VLAD" },
    official: false,
    impostors: null,
    impostorsRead: false,
  });
  const stock = res.evidence.stock;
  assert.match(stock.identityNotice, new RegExp(VLAD_PROPER), "which contract is always the first question");
  assert.doesNotMatch(stock.identityNotice, /whose name is/, "nothing differs, so nothing to flag");
  assert.equal(stock.impostorCount, null, "the scan did not run; that is not zero");
});
