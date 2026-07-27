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
// Fully offline: lib/stock-tokens.js reaches the chain only through
// lib/blockscout.js, which is one fetch, so globalThis.fetch is a stub here and no
// network is touched. Run with: npm test
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveSymbol } from "../lib/stock-tokens.js";
import { resetIndexerCache } from "../lib/indexer-cache.js";
import { gatherEvidence } from "../lib/ask-evidence.js";

/* --------------------------- the VLAD collision --------------------------- */

const GREEN_BULL = "0x31be8f7485e36928c9de86566c62da82d4b6bf81";
const VLAD_PROPER = "0x5ad6fad7794f4118fa119dc6f5652f360f3b8eb5";
const VLADDY = "0xa9038d2c4e798d10dd46c2fdb1f72c9b397bbdad";

/** The explorer's /search rows for "VLAD", as measured. */
function vladSearchItems() {
  return [
    // Wins the tie on holders — and its name is nothing like the ticker.
    { address_hash: GREEN_BULL, name: "The Green Bull", symbol: "VLAD", holders_count: "1336", circulating_market_cap: "243000" },
    { address_hash: VLAD_PROPER, name: "VLAD", symbol: "VLAD", holders_count: "449" },
    { address_hash: VLADDY, name: "vladdy", symbol: "VLAD", holders_count: "202", circulating_market_cap: "7900" },
    // Neighbours that merely look similar: they must NOT inflate the count.
    { address_hash: `0x${"1".repeat(40)}`, name: "Vladhood", symbol: "VLADHOOD", holders_count: "12" },
    { address_hash: `0x${"2".repeat(40)}`, name: "VLADDOG", symbol: "VLADDOG", holders_count: "8" },
  ];
}

/**
 * Swap globalThis.fetch for a router over the two endpoints resolveSymbol uses:
 * the /tokens page walk (the official equity list) and /search.
 *
 * @param {{ tokens?: object, search?: (q: string) => object }} routes - a route
 *   returning null answers 500, which is how an outage is spelled here.
 */
function stubChain({ tokens = { items: [] }, search = () => ({ items: vladSearchItems() }) } = {}) {
  const real = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    const body = u.includes("/search?") ? search(decodeURIComponent(u.split("q=")[1] ?? "")) : tokens;
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
    const res = await resolveSymbol("VLAD");
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
    const res = await resolveSymbol("green bull");
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
    const res = await resolveSymbol("green bull");
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
    const res = await resolveSymbol("VLAD");
    assert.equal(res.ok, false);
    assert.equal(res.impostors, null);
    assert.equal(res.impostorsRead, false);
    assert.match(res.reason, /unknown, not absent/);
  } finally {
    chain.restore();
  }
});

/* ----------------------- the evidence the model sees ----------------------- */

const TOKEN_CALLS = Object.freeze({
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
