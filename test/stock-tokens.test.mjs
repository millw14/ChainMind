// Tests for the tokenized-equity registry (lib/stock-tokens.js): the name
// convention that marks a token as official, and the ranking that decides which
// contract a ticker resolves to. The ranking is the security-relevant half —
// impostor contracts wearing real tickers exist on Robinhood Chain, so a
// lookalike outranking the real NVDA is a wrong answer with money attached.
// Fully offline: only the pure helpers are exercised. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_ISSUER,
  isStockTokenName,
  normalizeQuery,
  pickBestMatch,
  stripStockSuffix,
  withHolderCounts,
  withQuoteDepth,
} from "../lib/stock-tokens.js";
import registry from "../config/stock-tokens.json" with { type: "json" };

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

test("the shared ' • Robinhood Token' suffix is not something a query can match", () => {
  // MEASURED LIVE, and it was a confidently wrong answer. Every one of the 94
  // official names ends in that suffix, so a substring test against the raw name
  // scored all 94 on the word "hood" — and "HOOD", a ticker four memecoins on this
  // chain wear, resolved to NVIDIA and came back official: true. The suffix names
  // the issuer, never the subject.
  assert.equal(pickBestMatch(POOL, "hood"), null);
  assert.equal(pickBestMatch(POOL, "robinhood"), null);
  assert.equal(pickBestMatch(POOL, "token"), null);
  // The company half of the same name still matches, which is the point of the tier.
  assert.equal(pickBestMatch(POOL, "nvid")?.address, NVDA.address);
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

/* ------------------- realisable depth, not holder count ------------------- */

/*
 * The VLAD collision, with the figures measured on chain 4663. 229 DISTINCT
 * contracts have the exact symbol VLAD, and of the eighteen with the most holders
 * exactly ONE has more than $100 of realisable quote-side liquidity:
 *
 *   The Green Bull  $69,583.29 depth |  1,334 holders | cap   $238,397
 *   Vladhoods            $3.92 depth |  7,634 holders | cap   $405,629
 *   The Robinhood        $1.03 depth | 52,214 holders | cap $3,855,217
 *
 * AN EARLIER DIAGNOSIS IN THIS FILE WAS WRONG AND IS RETRACTED. It held that the
 * indexer "happens to price whichever copycat" and that holder count should
 * therefore decide, and this block asserted The Robinhood as the answer. The
 * causation runs the other way: Blockscout prices The Green Bull BECAUSE it is
 * the one with a real market — its feed (cap $245,195.83) and our independent
 * pool math (cap $238,397) agree within 3%. Holder count is the actively harmful
 * figure: ranking on it selects a contract with $1.03 of realisable WETH behind a
 * $3.86M notional cap over the one with $69.6K of capital genuinely at risk.
 * Airdrops make 52,214 holders cheap.
 */
const GREEN_BULL = { address: "0x31be", symbol: "VLAD", name: "The Green Bull", company: "The Green Bull", holders: 1334, marketCap: 238397, price: 0.00023839681962609913 };
const ROBINHOOD = { address: "0xfd58", symbol: "VLAD", name: "The Robinhood", company: "The Robinhood", holders: 52214, marketCap: 3855217 };
const VLADHOODS = { address: "0xbbdd", symbol: "VLAD", name: "Vladhoods", company: "Vladhoods", holders: 7634, marketCap: 405629 };

/** The census with depth read — what the ranking sees once the pools are probed. */
const DEPTHS = { "0x31be": 69583.29, "0xbbdd": 3.92, "0xfd58": 1.03 };
const withDepth = (c) => ({ ...c, quoteLiquidityUsd: DEPTHS[c.address] ?? null });

test("realisable depth decides the ticker, not the holder count", () => {
  const pool = [GREEN_BULL, VLADHOODS, ROBINHOOD].map(withDepth);
  assert.equal(pickBestMatch(pool, "VLAD")?.address, GREEN_BULL.address);
  assert.equal(pickBestMatch([...pool].reverse(), "VLAD")?.address, GREEN_BULL.address, "order must not decide it");
});

test("a $3.86M notional cap and 52,214 holders lose to $69.6K of realisable WETH", () => {
  const pool = [GREEN_BULL, ROBINHOOD].map(withDepth);
  const best = pickBestMatch(pool, "VLAD");
  assert.equal(best.address, GREEN_BULL.address);
  assert.ok(ROBINHOOD.holders > GREEN_BULL.holders * 30, "and it IS the most held");
  assert.ok(ROBINHOOD.marketCap > GREEN_BULL.marketCap * 15, "and it does post the bigger cap");
});

test("a contract whose depth could not be measured never outranks one whose was", () => {
  // The conservative direction, and the same rule as everywhere else here: a
  // measured figure beats an absent one. A probe that failed must not win by
  // default, however large the holder count beside it.
  const measured = { address: "0x1", symbol: "VLAD", name: "A", company: "A", holders: 10, quoteLiquidityUsd: 12 };
  const unprobed = { address: "0x2", symbol: "VLAD", name: "B", company: "B", holders: 500_000, quoteLiquidityUsd: null };
  assert.equal(pickBestMatch([measured, unprobed], "VLAD")?.address, "0x1");
  assert.equal(pickBestMatch([unprobed, measured], "VLAD")?.address, "0x1");
});

test("with no depth measured on either side, the indexer's own tracking decides — NOT holders", () => {
  // THE ORDINARY-TUESDAY CASE, and it used to give the wrong answer. Depth is
  // read for a bounded shortlist and the probes can simply time out: measured
  // live, every probe failed in 2 of 4 cold VLAD lookups. This test used to
  // assert ROBINHOOD — 52,214 airdropped holders sitting behind $1.03 of
  // realisable WETH — because holders was the next rung down.
  //
  // Blockscout publishes a rate only for contracts it can find a market for, and
  // of the 229 VLAD contracts on this chain that is essentially just this one.
  // The fixtures carry exactly that: GREEN_BULL has a price, the other two do
  // not, which is what the live chain returns.
  const pool = [GREEN_BULL, VLADHOODS, ROBINHOOD];
  assert.equal(pickBestMatch(pool, "VLAD")?.address, GREEN_BULL.address);
});

test("holders still decides when nothing better separates the candidates", () => {
  // The rung is not gone, just outranked. With no depth, no volume and no rate
  // on any side there is nothing else to go on, and the equities — where no pool
  // is ever read — depend on it.
  const bare = [GREEN_BULL, VLADHOODS, ROBINHOOD].map(({ price, ...c }) => c);
  assert.equal(pickBestMatch(bare, "VLAD")?.address, ROBINHOOD.address);
});

test("real trading outranks a bare quote, and both outrank a large holder count", () => {
  // Volume is the discriminating field: /search rows carry a rate but never a
  // volume. Neither is a hard signal — a sole liquidity provider wash-trading
  // pays the fees to themselves — so both sit BELOW depth and above holders only
  // because holders costs an airdrop.
  const traded = { ...VLADHOODS, volume24h: 2808.22 };
  assert.equal(pickBestMatch([GREEN_BULL, traded, ROBINHOOD], "VLAD")?.address, traded.address);
  assert.equal(pickBestMatch([ROBINHOOD, GREEN_BULL], "VLAD")?.address, GREEN_BULL.address);
});

test("ISSUER VERIFICATION OUTRANKS THE DEEPEST POOL ON THE CHAIN", () => {
  // The invariant that must never bend: no memecoin outranks a real equity
  // sharing its ticker, whatever the market figures say. The deployer's key is a
  // stronger fact than any amount of pooled WETH.
  const realNvda = registry.tokens.find((t) => t.symbol === "NVDA");
  assert.ok(realNvda, "the snapshot must actually carry NVDA for this to prove anything");
  const equity = { address: realNvda.address, symbol: "NVDA", name: "NVIDIA • Robinhood Token", company: "NVIDIA", holders: 12, marketCap: null };
  const whale = {
    address: "0x465834d5000000000000000000000000000000ca",
    symbol: "NVDA",
    name: "NVIDIA • Robinhood Token",
    company: "NVIDIA",
    holders: 900_000,
    marketCap: 9e9,
    quoteLiquidityUsd: 50_000_000,
  };
  assert.equal(pickBestMatch([whale, equity], "NVDA")?.address, realNvda.address);
  assert.equal(pickBestMatch([equity, whale], "NVDA")?.address, realNvda.address);
  assert.equal(String(CANONICAL_ISSUER).toLowerCase(), "0x4783c67b63de2b358ac5951a7d41f47a38f3c046");
});

test("a known holder count is never displaced by an unknown one", () => {
  // However big the market cap beside it. A measured figure outranks an absent
  // one everywhere else in this codebase, and the ranking is no exception.
  const counted = { address: "0x1", symbol: "VLAD", name: "VLAD", company: "VLAD", holders: 3, marketCap: null };
  const uncounted = { address: "0x2", symbol: "VLAD", name: "VLAD", company: "VLAD", holders: null, marketCap: 9_000_000 };
  assert.equal(pickBestMatch([counted, uncounted], "VLAD")?.address, "0x1");
  assert.equal(pickBestMatch([uncounted, counted], "VLAD")?.address, "0x1");
});

test("the exact-symbol tier still outranks every figure", () => {
  // NVDACAT with a hundred times the holders is still not NVDA.
  const cat = { address: "0x1", symbol: "NVDACAT", name: "NVDACAT", company: "NVDACAT", holders: 900_000, marketCap: 9e9 };
  const real = { address: "0x2", symbol: "NVDA", name: "NVIDIA • Robinhood Token", company: "NVIDIA", holders: 12, marketCap: null };
  assert.equal(pickBestMatch([cat, real], "NVDA")?.address, "0x2");
});

test("withHolderCounts fills the count the explorer search does not send", async () => {
  // /api/v2/search rows carry name, symbol, supply and market cap — and no holder
  // count at all, so without this every candidate ties and market cap decides.
  const rows = [
    { ...GREEN_BULL, holders: null },
    { ...ROBINHOOD, holders: null },
    { ...VLADHOODS, holders: null },
  ];
  const asked = [];
  const filled = await withHolderCounts(rows, "VLAD", async (address) => {
    asked.push(address);
    return { "0x31be": 1335, "0xfd58": 52214, "0xbbdd": 7635 }[address] ?? null;
  });

  assert.deepEqual(asked.sort(), ["0x31be", "0xbbdd", "0xfd58"]);
  assert.equal(filled.find((r) => r.address === "0xfd58")?.holders, 52214, "the count is filled in");
  // The filled counts no longer decide this collision — the indexer's rate does,
  // one rung above — but they are still what separates candidates that tie there.
  assert.equal(pickBestMatch(filled, "VLAD")?.address, GREEN_BULL.address);
  assert.equal(rows[0].holders, null, "the caller's own list is not mutated");
});

test("withHolderCounts asks only about candidates that could actually win", async () => {
  const asked = [];
  const rows = [
    { address: "0x1", symbol: "VLAD", name: "VLAD", company: "VLAD", holders: null },
    { address: "0x2", symbol: "VLAD", name: "VLAD", company: "VLAD", holders: null },
    // A different ticker: outranked by the tiers, so no figure about it can change
    // the answer and no request should be spent on it.
    { address: "0x3", symbol: "VLADDOG", name: "VladDog", company: "VladDog", holders: null },
    // Already counted; nothing to fetch.
    { address: "0x4", symbol: "VLAD", name: "VLAD", company: "VLAD", holders: 10 },
  ];
  await withHolderCounts(rows, "VLAD", async (a) => (asked.push(a), 5));
  assert.deepEqual(asked.sort(), ["0x1", "0x2"]);
});

test("withHolderCounts leaves a candidate it could not read unknown, never zero", async () => {
  const rows = [
    { address: "0x1", symbol: "VLAD", name: "VLAD", company: "VLAD", holders: null },
    { address: "0x2", symbol: "VLAD", name: "VLAD", company: "VLAD", holders: null },
  ];
  const filled = await withHolderCounts(rows, "VLAD", async (a) => (a === "0x1" ? 40 : null));
  assert.equal(filled[0].holders, 40);
  assert.equal(filled[1].holders, null, "a failed probe is unknown; 0 would be a claim");
  // And the one it could measure wins, which is the conservative direction: it
  // never promotes an unknown over a known.
  assert.equal(pickBestMatch(filled, "VLAD")?.address, "0x1");
});

test("withHolderCounts spends nothing when there is no tie to break", async () => {
  const forbidden = async () => {
    throw new Error("no lookup should have been made");
  };
  await withHolderCounts([{ address: "0x1", symbol: "VLAD", name: "VLAD", company: "VLAD", holders: null }], "VLAD", forbidden);
  await withHolderCounts([], "VLAD", forbidden);
  await withHolderCounts(null, "VLAD", forbidden);
});

/* --------------------------- the depth probe --------------------------- */

test("withQuoteDepth measures the collision and hands the ticker to the deep pool", async () => {
  const asked = [];
  const { candidates, survey } = await withQuoteDepth([GREEN_BULL, VLADHOODS, ROBINHOOD], "VLAD", async (a) => {
    asked.push(a);
    return DEPTHS[a] ?? null;
  });
  assert.deepEqual(asked.sort(), ["0x31be", "0xbbdd", "0xfd58"]);
  assert.equal(pickBestMatch(candidates, "VLAD")?.address, GREEN_BULL.address);
  // Three quantities, not one: three probes started, three came back, none failed.
  assert.equal(survey.attempted, 3);
  assert.equal(survey.measured, 3);
  assert.equal(survey.failed, 0);
  assert.equal(survey.dropped, 0);
  assert.equal(GREEN_BULL.quoteLiquidityUsd, undefined, "the caller's own rows are not mutated");
});

test("withQuoteDepth is capped, and reports what the cap dropped", async () => {
  // Standing in for the 229 real ones. The bound is the whole reason this is
  // affordable, and what it left out has to travel with the answer rather than
  // being implied away.
  const many = Array.from({ length: 40 }, (_, i) => ({
    address: `0x${String(i).padStart(4, "0")}`,
    symbol: "VLAD",
    name: `VLAD ${i}`,
    company: `VLAD ${i}`,
    holders: 40 - i,
  }));
  const asked = [];
  const { survey } = await withQuoteDepth(many, "VLAD", async (a) => (asked.push(a), 1));
  assert.ok(asked.length <= survey.bound, `probed ${asked.length}, bound ${survey.bound}`);
  assert.equal(survey.attempted, asked.length);
  assert.equal(survey.measured, asked.length, "and every one of them answered");
  assert.equal(survey.candidateCount, 40);
  assert.equal(survey.dropped, 40 - asked.length);
  assert.ok(survey.dropped > 0, "the fixture must actually exceed the bound");
});

test("NVDA reads no pool at all — the issuer already settled it", async () => {
  const realNvda = registry.tokens.find((t) => t.symbol === "NVDA");
  const forbidden = async () => {
    throw new Error("an issuer-verified equity must never cost a pool read");
  };
  const rows = [
    { address: realNvda.address, symbol: "NVDA", name: "NVIDIA • Robinhood Token", company: "NVIDIA", holders: 12 },
    { address: "0x465834d5000000000000000000000000000000ca", symbol: "NVDA", name: "NVIDIA • Robinhood Token", company: "NVIDIA", holders: 900_000 },
  ];
  const { candidates, survey } = await withQuoteDepth(rows, "NVDA", forbidden);
  assert.equal(survey, null, "no measurement, so no verdict — null is 'not measured'");
  assert.equal(pickBestMatch(candidates, "NVDA")?.address, realNvda.address);
});

test("withQuoteDepth spends nothing when the tiers already decided it", async () => {
  const forbidden = async () => {
    throw new Error("no probe should have been made");
  };
  // One candidate in the tier, and a lookalike prefix that no depth could promote.
  const rows = [
    { address: "0x1", symbol: "VLAD", name: "VLAD", company: "VLAD", holders: 1 },
    { address: "0x2", symbol: "VLADDOG", name: "VladDog", company: "VladDog", holders: 99 },
  ];
  assert.equal((await withQuoteDepth(rows, "VLAD", forbidden)).survey, null);
  assert.equal((await withQuoteDepth([], "VLAD", forbidden)).survey, null);
  assert.equal((await withQuoteDepth(null, "VLAD", forbidden)).survey, null);
});
