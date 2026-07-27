// Tests for the market-wide evidence gatherers (lib/market-evidence.js): the
// ranking sort, the aggregate totals, and the comparison cap. These are the
// three places where a missing number could quietly become a claimed one —
// an unpriced token ranked "smallest", a $0 market cap folded into a market
// total, or a sixth ticker dropped from a comparison without saying so.
// Fully offline: only the exported pure helpers are exercised, no network.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RANKABLE_METRICS,
  aggregateTotals,
  buildOverview,
  buildRanking,
  capQueries,
  clampLimit,
  collisions,
  compareByMetric,
  displayNumber,
  genuineFor,
  resolveDirection,
  resolveMetric,
  sortByMetric,
  toRow,
} from "../lib/market-evidence.js";

/** Stand-ins for the live registry, including two the indexer never priced. */
const NVDA = {
  address: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
  symbol: "NVDA",
  company: "NVIDIA",
  price: 207.9,
  marketCap: 9_000_000,
  holders: 26_505,
  volume24h: 120_000,
};
const AAPL = {
  address: "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9",
  symbol: "AAPL",
  company: "Apple",
  price: 321.52,
  marketCap: 5_000_000,
  holders: 25_196,
  volume24h: 90_000,
};
const TSLA = {
  address: "0x00000000000000000000000000000000000000aa",
  symbol: "TSLA",
  company: "Tesla",
  price: 323.2,
  marketCap: 1_000_000,
  holders: 18_629,
  volume24h: 300_000,
};
const SGOV = {
  address: "0x00000000000000000000000000000000000000cc",
  symbol: "SGOV",
  company: "iShares 0-3 Month Treasury Bond ETF",
  price: 100.71,
  marketCap: 250_000,
  holders: 400,
  volume24h: null,
};
/** Listed but unpriced: the case that breaks a naive sort and a naive sum. */
const UNPRICED = {
  address: "0x00000000000000000000000000000000000000dd",
  symbol: "AAOI",
  company: "Applied Optoelectronics",
  price: null,
  marketCap: null,
  holders: null,
  volume24h: null,
};
const ALSO_UNPRICED = {
  address: "0x00000000000000000000000000000000000000ee",
  symbol: "ZZZ",
  company: "Zeta",
  price: null,
  marketCap: null,
  holders: 12,
  volume24h: null,
};

const POOL = [SGOV, UNPRICED, NVDA, ALSO_UNPRICED, TSLA, AAPL];

const symbolsOf = (rows) => rows.map((r) => r.symbol);

/* ------------------------------- the sort ------------------------------- */

test("descending rank puts the biggest first and unknowns last", () => {
  const sorted = sortByMetric(POOL, "marketCap", "desc");
  assert.deepEqual(symbolsOf(sorted), ["NVDA", "AAPL", "TSLA", "SGOV", "AAOI", "ZZZ"]);
});

test("ascending rank keeps unknowns last, not first", () => {
  // The bug this guards: treating a null market cap as 0 would make AAOI the
  // "smallest tokenized equity", which asserts a size nobody published.
  const sorted = sortByMetric(POOL, "marketCap", "asc");
  assert.deepEqual(symbolsOf(sorted), ["SGOV", "TSLA", "AAPL", "NVDA", "AAOI", "ZZZ"]);
  assert.equal(sorted.at(-1).marketCap, null);
  assert.equal(sorted.at(-2).marketCap, null);
});

test("a token with no value for the metric never ranks first in either direction", () => {
  for (const metric of RANKABLE_METRICS) {
    for (const direction of ["asc", "desc"]) {
      const top = sortByMetric(POOL, metric, direction)[0];
      assert.notEqual(top[metric], null, `${metric}/${direction} ranked an unknown value first`);
    }
  }
});

test("the comparator is NaN-safe on strings, nulls and junk", () => {
  const cmp = compareByMetric("marketCap", "desc");
  assert.equal(cmp({ marketCap: null }, { marketCap: null }), 0, "two unknowns are equal");
  assert.equal(cmp({ marketCap: null }, { marketCap: 5 }), 1, "unknown sinks");
  assert.equal(cmp({ marketCap: 5 }, { marketCap: null }), -1, "known floats");
  assert.equal(cmp({ marketCap: "" }, { marketCap: 5 }), 1, "empty string is unknown");
  assert.equal(cmp({ marketCap: "not a number" }, { marketCap: 5 }), 1);
  assert.equal(cmp(undefined, { marketCap: 5 }), 1, "a missing candidate sinks");
  // Blockscout sends every number as a string; those must still sort as numbers.
  assert.equal(cmp({ marketCap: "900" }, { marketCap: "1000" }), 1);
});

test("sorting is stable across input order and does not mutate the registry", () => {
  const original = [...POOL];
  const forward = symbolsOf(sortByMetric(POOL, "holders", "desc"));
  const backward = symbolsOf(sortByMetric([...POOL].reverse(), "holders", "desc"));
  assert.deepEqual(forward, backward, "input order must not decide the ranking");
  assert.deepEqual(POOL, original, "the cached registry array was reordered in place");
});

test("sortByMetric drops malformed entries instead of throwing", () => {
  const sorted = sortByMetric([null, undefined, "nope", NVDA, {}], "marketCap", "desc");
  assert.equal(sorted[0].symbol, "NVDA");
  assert.equal(sorted.length, 2, "only the objects survive");
});

/* ----------------------------- metric parsing ----------------------------- */

test("resolveMetric maps what a user types onto a StockToken field", () => {
  assert.equal(resolveMetric("marketCap"), "marketCap");
  assert.equal(resolveMetric("market cap"), "marketCap");
  assert.equal(resolveMetric("market_cap"), "marketCap");
  assert.equal(resolveMetric("holders"), "holders");
  assert.equal(resolveMetric("owners"), "holders");
  assert.equal(resolveMetric("volume"), "volume24h");
  assert.equal(resolveMetric("volume24h"), "volume24h");
  assert.equal(resolveMetric("price"), "price");
});

test("resolveMetric falls back to market cap rather than sorting on nothing", () => {
  assert.equal(resolveMetric("sharpe ratio"), "marketCap");
  assert.equal(resolveMetric(""), "marketCap");
  assert.equal(resolveMetric(null), "marketCap");
  assert.equal(resolveMetric(undefined), "marketCap");
});

test("resolveDirection only goes ascending when asked to", () => {
  assert.equal(resolveDirection("asc"), "asc");
  assert.equal(resolveDirection("ASCENDING"), "asc");
  assert.equal(resolveDirection("smallest"), "asc");
  assert.equal(resolveDirection("desc"), "desc");
  assert.equal(resolveDirection("biggest"), "desc");
  assert.equal(resolveDirection(null), "desc");
});

test("clampLimit holds the row count to 1..25", () => {
  assert.equal(clampLimit(10), 10);
  assert.equal(clampLimit(1), 1);
  assert.equal(clampLimit(0), 1);
  assert.equal(clampLimit(-5), 1);
  assert.equal(clampLimit(500), 25);
  assert.equal(clampLimit(7.9), 7, "fractional limits truncate");
  assert.equal(clampLimit("3"), 3, "a numeric string is still a number");
  assert.equal(clampLimit("all"), 10, "junk falls back to the default");
  assert.equal(clampLimit(undefined), 10);
});

/* ------------------------------- rankings ------------------------------- */

test("buildRanking numbers ranks from 1 and reports what it sorted on", () => {
  const ranking = buildRanking(POOL, { metric: "holders", direction: "desc", limit: 3 });
  assert.equal(ranking.metric, "holders");
  assert.equal(ranking.direction, "desc");
  assert.equal(ranking.count, 3);
  assert.deepEqual(symbolsOf(ranking.rows), ["NVDA", "AAPL", "TSLA"]);
  assert.deepEqual(
    ranking.rows.map((r) => r.rank),
    [1, 2, 3],
  );
});

test("buildRanking clamps the limit and never reports more rows than exist", () => {
  assert.equal(buildRanking(POOL, { limit: 500 }).count, POOL.length);
  assert.equal(buildRanking(POOL, { limit: 0 }).count, 1);
  assert.equal(buildRanking([], { limit: 10 }).count, 0);
  assert.deepEqual(buildRanking([], { limit: 10 }).rows, []);
});

test("buildRanking defaults to the biggest by market cap", () => {
  const ranking = buildRanking(POOL);
  assert.equal(ranking.metric, "marketCap");
  assert.equal(ranking.direction, "desc");
  assert.equal(ranking.rows[0].symbol, "NVDA");
});

test("toRow carries identity plus the four headline numbers, unknowns as null", () => {
  const row = toRow({ ...UNPRICED, marketCap: "1200.5" }, 4);
  assert.deepEqual(row, {
    rank: 5,
    symbol: "AAOI",
    company: "Applied Optoelectronics",
    address: UNPRICED.address,
    price: null,
    marketCap: 1200.5,
    holders: null,
    volume24h: null,
    // Pre-rendered so the model copies a string instead of formatting a float.
    display: { price: null, marketCap: "$1.20K", holders: null, volume24h: null },
  });
});

test("display strings never slide a decimal point", () => {
  // The live regression: 4160789.1145265275 was answered as $4,160,789,114.53,
  // a thousandfold overstatement, because the model formatted the float itself.
  const row = toRow({ symbol: "NVDA", marketCap: 4160789.1145265275, holders: 28899, price: 206.71 }, 0);
  assert.equal(row.display.marketCap, "$4.16M");
  assert.equal(row.display.holders, "28,899");
  assert.equal(row.display.price, "$206.71");
  assert.equal(row.marketCap, 4160789.1145265275, "the raw value stays exact");
});

test("displayNumber handles each magnitude and refuses non-numbers", () => {
  assert.equal(displayNumber(null), null);
  assert.equal(displayNumber(Number.NaN), null);
  assert.equal(displayNumber(0), "$0.00");
  assert.equal(displayNumber(206.71), "$206.71");
  assert.equal(displayNumber(1200.5), "$1.20K");
  assert.equal(displayNumber(4_160_789.11), "$4.16M");
  assert.equal(displayNumber(1_836_055_688.37), "$1.84B");
  assert.equal(displayNumber(2.5e12), "$2.50T");
  assert.equal(displayNumber(28899, "count"), "28,899");
});

/* ------------------------------ aggregates ------------------------------ */

test("aggregateTotals sums only the numbers it has and counts the ones it does not", () => {
  const agg = aggregateTotals(POOL);
  assert.equal(agg.combinedMarketCap, 9_000_000 + 5_000_000 + 1_000_000 + 250_000);
  assert.equal(agg.countedMarketCap, 4);
  assert.equal(agg.missingMarketCap, 2, "AAOI and ZZZ have no market cap");
  assert.equal(agg.totalHolders, 26_505 + 25_196 + 18_629 + 400 + 12);
  assert.equal(agg.countedHolders, 5);
  assert.equal(agg.missingHolders, 1, "only AAOI has no holder count");
});

test("aggregateTotals reports an all-unknown field as null, not as zero", () => {
  // "$0 combined market cap" reads as a fact about the market; it is not one.
  const agg = aggregateTotals([UNPRICED, { ...UNPRICED, symbol: "XX", holders: null }]);
  assert.equal(agg.combinedMarketCap, null);
  assert.equal(agg.totalHolders, null);
  assert.equal(agg.missingMarketCap, 2);
  assert.equal(agg.missingHolders, 2);
});

test("aggregateTotals treats non-numeric indexer values as missing", () => {
  const agg = aggregateTotals([{ marketCap: "", holders: "N/A" }, { marketCap: "500", holders: "10" }]);
  assert.equal(agg.combinedMarketCap, 500, "the numeric string counts");
  assert.equal(agg.missingMarketCap, 1);
  assert.equal(agg.totalHolders, 10);
  assert.equal(agg.missingHolders, 1);
});

test("aggregateTotals survives an empty or junk registry", () => {
  for (const input of [[], null, undefined, "nope"]) {
    const agg = aggregateTotals(input);
    assert.equal(agg.combinedMarketCap, null);
    assert.equal(agg.totalHolders, null);
    assert.equal(agg.missingMarketCap, 0);
  }
});

test("buildOverview ranks three ways off one registry read", () => {
  const overview = buildOverview(POOL);
  assert.equal(overview.totalStockTokens, 6);
  assert.equal(overview.topByMarketCap[0].symbol, "NVDA");
  assert.equal(overview.topByHolders[0].symbol, "NVDA");
  assert.equal(overview.mostActive24h[0].symbol, "TSLA", "volume, not size");
  assert.equal(overview.topByMarketCap.length, 5, "top five, even when six exist");
  assert.equal(overview.aggregate.missingMarketCap, 2);
});

/* ------------------------------ comparison ------------------------------ */

test("capQueries keeps four targets and names the ones it dropped", () => {
  const capped = capQueries(["NVDA", "TSLA", "AAPL", "SPY", "SGOV", "MSFT"]);
  assert.deepEqual(capped.kept, ["NVDA", "TSLA", "AAPL", "SPY"]);
  assert.deepEqual(capped.dropped, ["SGOV", "MSFT"]);
  assert.equal(capped.truncated, true);
  assert.match(capped.note, /SGOV, MSFT/, "the dropped targets must be quotable");
  assert.match(capped.note, /first 4/);
});

test("capQueries says nothing when nothing was dropped", () => {
  const capped = capQueries(["NVDA", "TSLA"]);
  assert.deepEqual(capped.kept, ["NVDA", "TSLA"]);
  assert.equal(capped.truncated, false);
  assert.equal(capped.note, null);
});

test("capQueries normalizes tickers and de-duplicates them", () => {
  const capped = capQueries(["  $nvda ", "NVDA", "tsla"]);
  assert.deepEqual(capped.kept, ["nvda", "tsla"], "one contract per comparison row");
  assert.equal(capped.truncated, false);
});

test("capQueries drops empties and accepts a bare string", () => {
  assert.deepEqual(capQueries(["", "   ", null, undefined, "NVDA"]).kept, ["NVDA"]);
  assert.deepEqual(capQueries("NVDA").kept, ["NVDA"]);
  assert.deepEqual(capQueries([]).kept, []);
  assert.deepEqual(capQueries(null).kept, []);
});

test("capQueries keeps 0x addresses intact alongside tickers", () => {
  const capped = capQueries([NVDA.address, "TSLA"]);
  assert.deepEqual(capped.kept, [NVDA.address, "TSLA"]);
});

/* --------------------------- ticker collisions --------------------------- */

const clone = (n) => ({
  address: `0x${String(n).padStart(40, "0")}`,
  symbol: "NVDA",
  name: "NVIDIA • Robinhood Token",
  holders: n,
});

test("collisions names a few but counts them all", () => {
  // "5 other contracts use this ticker" when 19 do understates the mess by a
  // factor of four, so the count must come off the full list, not the slice.
  const found = collisions([1, 2, 3, 4, 5, 6, 7].map(clone), NVDA.address);
  assert.equal(found.total, 7);
  assert.equal(found.rows.length, 5);
});

test("collisions never lists the contract being reported on as its own impostor", () => {
  const self = { address: NVDA.address.toUpperCase(), symbol: "NVDA", name: "NVIDIA • Robinhood Token" };
  const found = collisions([self, clone(2)], NVDA.address);
  assert.equal(found.total, 1, "case must not smuggle the target back in");
  assert.equal(found.rows[0].holders, 2);
});

test("collisions tells an empty search apart from a search that never ran", () => {
  // An ARRAY is a search that answered, so zero collisions is a measured zero.
  assert.deepEqual(collisions([], NVDA.address), { rows: [], total: 0 });

  // Anything else is a scan that did not happen. Reporting 0 there would say
  // "no other contract wears this ticker" on the strength of an outage — the
  // one direction of this answer that reassures a reader holding a fake.
  for (const input of [null, undefined, "nope", 0, {}]) {
    assert.deepEqual(
      collisions(input, NVDA.address),
      { rows: [], total: null },
      "an unread collision scan is unknown, never none",
    );
  }
});

/* ------------------------ the genuine-contract hint ------------------------ */

test("genuineFor answers from the offline snapshot", () => {
  // This is the address a scam warning tells someone to hold instead, so it
  // must resolve without an indexer and must not drift.
  assert.deepEqual(genuineFor("NVDA"), {
    symbol: "NVDA",
    company: "NVIDIA",
    address: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
  });
  assert.equal(genuineFor("aapl").address, "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9");
  assert.equal(genuineFor(" tsla ").address, "0x322f0929c4625ed5bad873c95208d54e1c003b2d");
});

test("genuineFor falls back to the live registry for a post-snapshot listing", () => {
  const listed = { symbol: "NEWCO", company: "New Co", address: "0x00000000000000000000000000000000000000ff" };
  assert.deepEqual(genuineFor("NEWCO", [listed]), listed);
});

test("genuineFor invents nothing when the ticker is not a Robinhood equity", () => {
  assert.equal(genuineFor("WSTETH"), null);
  assert.equal(genuineFor(""), null);
  assert.equal(genuineFor(null), null);
  assert.equal(genuineFor("NEWCO", []), null);
});
