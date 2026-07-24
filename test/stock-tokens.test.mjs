// Tests for the tokenized-equity registry (lib/stock-tokens.js): the name
// convention that marks a token as official, and the ranking that decides which
// contract a ticker resolves to. The ranking is the security-relevant half —
// impostor contracts wearing real tickers exist on Robinhood Chain, so a
// lookalike outranking the real NVDA is a wrong answer with money attached.
// Fully offline: only the pure helpers are exercised. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isStockTokenName,
  normalizeQuery,
  pickBestMatch,
  stripStockSuffix,
} from "../lib/stock-tokens.js";

test("isStockTokenName accepts the official bullet suffix", () => {
  assert.equal(isStockTokenName("NVIDIA • Robinhood Token"), true);
  assert.equal(isStockTokenName("Tesla • Robinhood Token"), true);
  assert.equal(isStockTokenName("Apple • Robinhood Token"), true);
});

test("isStockTokenName tolerates bullet and whitespace variants", () => {
  assert.equal(isStockTokenName("NVIDIA * Robinhood Token"), true, "asterisk bullet");
  assert.equal(isStockTokenName("NVIDIA   •   Robinhood   Token"), true, "extra spaces");
  assert.equal(isStockTokenName("NVIDIA • Robinhood Token   "), true, "trailing space");
  assert.equal(isStockTokenName("NVIDIA • robinhood token"), true, "case-insensitive");
});

test("isStockTokenName rejects names without the suffix", () => {
  assert.equal(isStockTokenName("NVIDIA"), false);
  assert.equal(isStockTokenName("Robinhood Token"), false, "suffix needs its bullet");
  assert.equal(isStockTokenName("NVIDIA • Robinhood Token Clone"), false, "suffix must end the name");
  assert.equal(isStockTokenName("SPDR S&P 500 ETF Trust"), false);
  assert.equal(isStockTokenName(""), false);
  assert.equal(isStockTokenName(null), false);
  assert.equal(isStockTokenName(undefined), false);
  assert.equal(isStockTokenName(42), false, "non-strings are not names");
});

test("stripStockSuffix returns the company name", () => {
  assert.equal(stripStockSuffix("NVIDIA • Robinhood Token"), "NVIDIA");
  assert.equal(stripStockSuffix("Tesla * Robinhood Token"), "Tesla");
  assert.equal(stripStockSuffix("Berkshire Hathaway Inc.  •  Robinhood Token"), "Berkshire Hathaway Inc.");
});

test("stripStockSuffix leaves unrelated names alone", () => {
  assert.equal(stripStockSuffix("SPDR S&P 500 ETF Trust"), "SPDR S&P 500 ETF Trust");
  assert.equal(stripStockSuffix("  Wrapped Ether  "), "Wrapped Ether");
  assert.equal(stripStockSuffix(null), "");
});

test("normalizeQuery strips the trader's dollar sign and folds whitespace", () => {
  assert.deepEqual(normalizeQuery("  $nvda "), { raw: "nvda", symbol: "NVDA", lower: "nvda" });
  assert.deepEqual(normalizeQuery("Berkshire   Hathaway"), {
    raw: "Berkshire Hathaway",
    symbol: "BERKSHIRE HATHAWAY",
    lower: "berkshire hathaway",
  });
  assert.equal(normalizeQuery(null).raw, "");
});

/** Stand-ins for the live set: the official token plus its real-world clones. */
const NVDA = {
  address: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
  symbol: "NVDA",
  name: "NVIDIA • Robinhood Token",
  company: "NVIDIA",
  holders: 4200,
  marketCap: 9_000_000,
};
const NVDA_CLONE = {
  address: "0xdecf74e4aa6ff30b1612e65665aaf650bedecba3",
  symbol: "NVDA",
  name: "NVDA",
  company: "NVDA",
  holders: 3,
  marketCap: null,
};
const NVDACAT = {
  address: "0x00000000000000000000000000000000000000ca",
  symbol: "NVDACAT",
  name: "NVDA Cat",
  company: "NVDA Cat",
  holders: 900,
  marketCap: 12_000,
};
const TSLA = {
  address: "0x00000000000000000000000000000000000000aa",
  symbol: "TSLA",
  name: "Tesla • Robinhood Token",
  company: "Tesla",
  holders: 3100,
  marketCap: 7_000_000,
};
const TSLA_CLONE = {
  address: "0x00000000000000000000000000000000000000bb",
  symbol: "TSLAX",
  name: "Tesla Rewards",
  company: "Tesla Rewards",
  holders: 12,
  marketCap: null,
};
const SGOV = {
  address: "0x00000000000000000000000000000000000000cc",
  symbol: "SGOV",
  name: "iShares 0-3 Month Treasury Bond ETF • Robinhood Token",
  company: "iShares 0-3 Month Treasury Bond ETF",
  holders: 800,
  marketCap: 1_000_000,
};

const POOL = [NVDACAT, NVDA_CLONE, NVDA, TSLA_CLONE, TSLA, SGOV];

test("pickBestMatch prefers an exact symbol over a lookalike prefix", () => {
  // NVDACAT is listed first and NVDA_CLONE shares the ticker outright; the
  // exact-symbol tier plus the holder tie-break must still land on the real one.
  assert.equal(pickBestMatch(POOL, "NVDA")?.address, NVDA.address);
});

test("pickBestMatch is case-insensitive and ignores a leading $", () => {
  assert.equal(pickBestMatch(POOL, "nvda")?.address, NVDA.address);
  assert.equal(pickBestMatch(POOL, "$NVDA")?.address, NVDA.address);
  assert.equal(pickBestMatch(POOL, "  $tsla  ")?.address, TSLA.address);
});

test("pickBestMatch resolves a company name to its ticker", () => {
  // "tesla" also prefixes "Tesla Rewards"; the exact company name must win.
  assert.equal(pickBestMatch(POOL, "tesla")?.address, TSLA.address);
  assert.equal(pickBestMatch(POOL, "NVIDIA")?.address, NVDA.address);
});

test("pickBestMatch falls back to a substring of the company name", () => {
  assert.equal(pickBestMatch(POOL, "treasury bond")?.address, SGOV.address);
});

test("pickBestMatch breaks ties toward the widely held contract", () => {
  const thin = { address: "0x1", symbol: "AAPL", name: "AAPL", company: "AAPL", holders: 2, marketCap: null };
  const real = {
    address: "0x2",
    symbol: "AAPL",
    name: "Apple • Robinhood Token",
    company: "Apple",
    holders: 5000,
    marketCap: 5_000_000,
  };
  assert.equal(pickBestMatch([thin, real], "AAPL")?.address, "0x2");
  assert.equal(pickBestMatch([real, thin], "AAPL")?.address, "0x2", "order must not decide it");
});

test("pickBestMatch falls back to market cap when holder counts are unknown", () => {
  const small = { address: "0x1", symbol: "SPY", name: "SPY", company: "SPY", holders: null, marketCap: 10 };
  const big = { address: "0x2", symbol: "SPY", name: "SPY", company: "SPY", holders: null, marketCap: 10_000 };
  assert.equal(pickBestMatch([small, big], "SPY")?.address, "0x2");
});

test("pickBestMatch returns null rather than a loose guess", () => {
  assert.equal(pickBestMatch(POOL, "ZZZZ"), null);
  assert.equal(pickBestMatch(POOL, ""), null);
  assert.equal(pickBestMatch(POOL, "$"), null);
  assert.equal(pickBestMatch(POOL, null), null);
  assert.equal(pickBestMatch([], "NVDA"), null);
  assert.equal(pickBestMatch(null, "NVDA"), null);
});

test("pickBestMatch ignores a single-letter query instead of matching everything", () => {
  // "N" prefixes NVIDIA and NVDACAT; a one-character prefix is noise, not intent.
  assert.equal(pickBestMatch(POOL, "N"), null);
});

test("pickBestMatch survives malformed candidates", () => {
  const pool = [null, undefined, {}, { symbol: null, name: null, company: null }, NVDA];
  assert.equal(pickBestMatch(pool, "NVDA")?.address, NVDA.address);
});
