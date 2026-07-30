// Tests for lib/depth-rank.js — the module that decides WHICH contract wearing a
// ticker actually has a market, and says so in a sentence.
//
// The fixtures are the live census of chain 4663, not invented numbers. 229
// distinct contracts have the exact symbol VLAD; the eighteen with the most
// holders were surveyed and exactly ONE of them has more than $100 of realisable
// quote-side liquidity. That distribution is the whole argument: a threshold
// chosen against it has to answer VLAD outright, because a menu for a case this
// lopsided would be its own failure.
//
// Every test here is offline — the probe is injected, so no RPC client is ever
// built and nothing touches the network. Run with: npm test
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resetIndexerCache } from "../lib/indexer-cache.js";
import {
  CAP_TO_DEPTH_RATIO,
  DOMINANCE_RATIO,
  MAX_DEPTH_PROBES,
  MEANINGFUL_DEPTH_USD,
  applyDepths,
  candidateLabel,
  capNotice,
  collisionNotice,
  depthShortlist,
  dominanceVerdict,
  measureDepths,
  probeQuoteDepth,
  quoteDepth,
  ratioLabel,
} from "../lib/depth-rank.js";

beforeEach(() => resetIndexerCache());
afterEach(() => resetIndexerCache());

/* ------------------------------ the live census ------------------------------ */

/**
 * The VLAD field as measured. `depth` is the quote side of each contract's Uniswap
 * v3 pool — what somebody else put in, and therefore what a seller could meet.
 * `marketCap` is supply times price, which is a different kind of number entirely.
 */
const CENSUS = [
  // The only row the indexer carries a price OR a volume for — the corroboration
  // leg, measured live and asymmetric exactly this way on chain 4663.
  { address: "0x31be8f7485e36928c9de86566c62da82d4b6bf81", symbol: "VLAD", name: "The Green Bull", company: "The Green Bull", holders: 1334, marketCap: 238397, price: 0.00023839681962609913, volume24h: 2808.23, depth: 69583.29 },
  { address: "0xbbdd266afd623136574ad7ebc8f6ca0d867e247c", symbol: "VLAD", name: "Vladhoods", company: "Vladhoods", holders: 7634, marketCap: 405629, price: null, depth: 3.92 },
  { address: "0x0000000000000000000000000000000000000003", symbol: "VLAD", name: "The Robinhoods", company: "The Robinhoods", holders: 2500, marketCap: 23208, price: null, depth: 2.52 },
  { address: "0x0000000000000000000000000000000000000004", symbol: "VLAD", name: "The Robinhood Guy", company: "The Robinhood Guy", holders: 9518, marketCap: 828456, price: null, depth: 1.5 },
  { address: "0xfd584f7397ed0f42266bca2f8e3fc264aa12d409", symbol: "VLAD", name: "The Robinhood", company: "The Robinhood", holders: 52214, marketCap: 3855217, price: null, depth: 1.03 },
  { address: "0x0000000000000000000000000000000000000006", symbol: "VLAD", name: "Vladhood", company: "Vladhood", holders: 13203, marketCap: 288996, price: null, depth: 0.34 },
];

const GREEN_BULL = CENSUS[0].address;
const ROBINHOOD = CENSUS[4].address;

/** The census as candidates, with depth already read — the shape ranking sees. */
const measured = () => CENSUS.map(({ depth, ...c }) => ({ ...c, quoteLiquidityUsd: depth }));

/** The census as it ARRIVES: search rows, no depth on any of them. */
const unmeasured = () => CENSUS.map(({ depth, ...c }) => ({ ...c }));

/** A probe backed by the census; anything not in it is unmeasurable. */
const censusProbe = (asked = []) => async (address) => {
  asked.push(address);
  return CENSUS.find((c) => c.address === address)?.depth ?? null;
};

/* ------------------------------ the shortlist ------------------------------ */

test("the shortlist puts the indexer-priced contract first, not the most-held one", async () => {
  // THE WHOLE REASON THE BOUND IS AFFORDABLE. Ranked on holders alone The Green
  // Bull is 6th of the survey and 229th-ish of the field, so a bound of six would
  // very nearly have dropped the only contract with a market. The indexer quoting
  // it is a second instrument having found the same thing — corroboration, used to
  // decide who gets measured first and never to decide who wins.
  const list = depthShortlist(unmeasured(), 3);
  assert.equal(list[0].address, GREEN_BULL);
  assert.equal(list[1].address, ROBINHOOD, "then the largest holder base");
  assert.equal(list.length, 3);
});

test("the shortlist is stable — the same collision shortlists the same contracts", () => {
  const a = depthShortlist(unmeasured(), 4).map((c) => c.address);
  const b = depthShortlist([...unmeasured()].reverse(), 4).map((c) => c.address);
  assert.deepEqual(a, b, "arrival order must not move a contract in or out of the probe set");
});

test("the shortlist honours the bound and defaults to it", () => {
  assert.equal(depthShortlist(unmeasured(), 2).length, 2);
  assert.equal(depthShortlist(unmeasured()).length, Math.min(MAX_DEPTH_PROBES, CENSUS.length));
  assert.equal(depthShortlist(unmeasured(), 0).length, Math.min(MAX_DEPTH_PROBES, CENSUS.length));
  assert.deepEqual(depthShortlist(null), []);
});

/* -------------------------------- measuring -------------------------------- */

test("measureDepths probes only the shortlist and reports what it dropped", async () => {
  const asked = [];
  const survey = await measureDepths(unmeasured(), { probe: censusProbe(asked), bound: 2 });

  assert.equal(asked.length, 2, "the bound is a bound, not a suggestion");
  assert.equal(survey.attempted, 2);
  assert.equal(survey.measured, 2);
  assert.equal(survey.failed, 0, "nothing failed, and that is a separate quantity from nothing dropped");
  // The four never asked about are DROPPED, which is not failed, not shallow and
  // not absent.
  assert.equal(survey.dropped, CENSUS.length - 2);
  assert.equal(survey.candidateCount, CENSUS.length);
});

test("attempted, measured, failed and dropped are four separate counts", async () => {
  // THE F3 REGRESSION. `probed` was the shortlist LENGTH and every sentence
  // downstream read it as measurements obtained, so five probes throwing and one
  // answering read as "measured 6". Four quantities, and none of them may stand in
  // for another.
  const survey = await measureDepths(unmeasured(), {
    bound: 4,
    probe: async (a) => (a === GREEN_BULL ? 69_583.29 : null),
  });
  assert.equal(survey.attempted, 4, "four probes were started");
  assert.equal(survey.measured, 1, "one of them produced a figure");
  assert.equal(survey.failed, 3, "and three ran and could not be read");
  assert.equal(survey.dropped, CENSUS.length - 4, "the bound never reached the rest");
  assert.equal(survey.probed, undefined, "the ambiguous field is gone, not redefined");
});

test("a probe that fails leaves its contract unknown, never at zero", async () => {
  const survey = await measureDepths(unmeasured(), {
    bound: 3,
    probe: async (a) => (a === GREEN_BULL ? null : 5),
  });
  assert.equal(survey.depths.has(GREEN_BULL), false, "no entry at all — 0 would be a claim");
  assert.equal(survey.measured, 2);
});

test("a probe that throws is caught and counts as unmeasured", async () => {
  const survey = await measureDepths(unmeasured(), {
    bound: 2,
    probe: async () => {
      throw new Error("rpc down");
    },
  });
  assert.equal(survey.measured, 0);
  assert.equal(survey.attempted, 2, "the attempt still happened and is still reported");
  assert.equal(survey.failed, 2, "as an attempt that failed, not as a measurement");
});

/* ------------------------ never cache a failed probe ----------------------- */

/** A market read that fails `failures` times and then answers. */
function flakyMarket(failures, depth = 69_583.29) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    read: async () => {
      calls += 1;
      if (calls <= failures) return { quoteLiquidityUsd: null, reason: "pool_read_failed" };
      return { quoteLiquidityUsd: depth, reason: undefined };
    },
  };
}

test("a failed depth probe is NEVER cached, so the next lookup asks again", async () => {
  // THE F4 REGRESSION. The fetcher used to RESOLVE with { quoteLiquidityUsd: null }
  // on a failure, and the cache stores whatever resolves — so one RPC blip wrote
  // "this contract has no depth" for the whole price TTL, contradicting the
  // never-cache-a-failure invariant lib/indexer-cache.js is built around, in the
  // exact ten-second window where the figure decides who owns a ticker.
  const market = flakyMarket(1);
  const client = { readContract: async () => null };

  const first = await probeQuoteDepth(GREEN_BULL, { client, marketData: market.read });
  assert.equal(first, null, "the failure is reported as unmeasured");

  const second = await probeQuoteDepth(GREEN_BULL, { client, marketData: market.read });
  // The venue travels with the figure — see depth-rank probeQuoteDepth. A band depth is
  // the same integral on either venue, so the number alone cannot say which produced it.
  assert.deepEqual(
    second,
    { depthUsd: 69_583.29, lowerBound: false, source: "uniswap_v3" },
    "a cached failure would have made this null too",
  );
  assert.equal(market.calls, 2, "and it really did go back to the chain");
});

test("a successful depth read IS cached — the invariant is about failures only", async () => {
  const market = flakyMarket(0);
  const client = { readContract: async () => null };
  const want = { depthUsd: 69_583.29, lowerBound: false, source: "uniswap_v3" };
  assert.deepEqual(await probeQuoteDepth(GREEN_BULL, { client, marketData: market.read }), want);
  assert.deepEqual(await probeQuoteDepth(GREEN_BULL, { client, marketData: market.read }), want);
  assert.equal(market.calls, 1, "the second call is served from the cache");
});

test("a chain-confirmed 'no pool' on BOTH venues is a measurement of zero, not a failed read", async () => {
  // The one zero in this module that is a fact: the chain answered and this token
  // has no market, so its tradeable depth really is nothing. Without this, a field
  // where most squatters have no pool at all would be permanently "partial" and
  // could never be reported as shallow.
  //
  // THE FIXTURE NOW CARRIES A V4 VERDICT, and that is the invariant narrowing rather
  // than the test being appeased. A v3 `no_pool` alone establishes only that nothing
  // trades this token ON V3 — see isMeasuredAbsence for the measured case where that
  // was false and a wrong zero was asserted.
  const client = { readContract: async () => null };
  const depth = await probeQuoteDepth(ROBINHOOD, {
    client,
    marketData: async () => ({ quoteLiquidityUsd: null, reason: "no_pool", v4: { status: "none" } }),
  });
  // Labelled "both_venues" and NOT "uniswap_v3": the zero was established by the pair of
  // them, and crediting one instrument with it would overstate what that one showed.
  assert.deepEqual(
    depth,
    { depthUsd: 0, lowerBound: false, source: "both_venues" },
    "a figure, and an EXACT one",
  );
});

test("a v3 'no pool' is NOT a zero when the token has Uniswap v4 pools", async () => {
  // The ranking half of D3, measured: PIPECAT has no v3 pool and eight v4 pools, one
  // carrying $45.90 of realisable depth. Recorded as a measured zero that is not a
  // missing figure but a wrong one, asserted — and a zero cannot be beaten, so it
  // would settle a ticker collision against the contract that actually has the market.
  const client = { readContract: async () => null };
  const depth = await probeQuoteDepth(ROBINHOOD, {
    client,
    marketData: async () => ({
      quoteLiquidityUsd: null,
      reason: "no_pool",
      v4: { status: "found_unpriced", poolCount: 8 },
    }),
  });
  assert.equal(depth, null, "unmeasured, which loses every comparison rather than winning one");
});

test("a v3 'no pool' is NOT a zero when the v4 read could not be made", async () => {
  const client = { readContract: async () => null };
  for (const status of ["unread", "skipped"]) {
    const depth = await probeQuoteDepth(ROBINHOOD, {
      client,
      marketData: async () => ({ quoteLiquidityUsd: null, reason: "no_pool", v4: { status } }),
    });
    assert.equal(depth, null, `${status} may not harden into a swept absence`);
  }
});

test("a v3 'no pool' with no v4 verdict at all is unmeasured, not a swept absence", async () => {
  // Nobody asked about v4, so nothing about v4 may be concluded — the same rule this
  // file applies to a probe that never ran.
  const client = { readContract: async () => null };
  const depth = await probeQuoteDepth(ROBINHOOD, {
    client,
    marketData: async () => ({ quoteLiquidityUsd: null, reason: "no_pool" }),
  });
  assert.equal(depth, null);
});

test("a probe with no client at all is unmeasured, and never zero", async () => {
  assert.equal(await probeQuoteDepth(GREEN_BULL, { client: null, marketData: async () => ({}) }), null);
});

test("applyDepths copies rather than mutating the caller's list", async () => {
  const rows = unmeasured();
  const survey = await measureDepths(rows, { probe: censusProbe() });
  const filled = applyDepths(rows, survey.depths);
  assert.equal(quoteDepth(filled.find((c) => c.address === GREEN_BULL)), 69583.29);
  assert.equal(quoteDepth(rows.find((c) => c.address === GREEN_BULL)), null, "the input is untouched");
});

/* -------------------------------- the verdict -------------------------------- */

test("VLAD is answered directly: one contract dominates by 17,750x", () => {
  const v = dominanceVerdict(measured());
  assert.equal(v.verdict, "dominant");
  assert.equal(v.ambiguous, false, "a menu for this field would be its own failure");
  assert.equal(v.winner.address, GREEN_BULL);
  assert.equal(v.topDepthUsd, 69583.29);
  assert.equal(v.runnerUpDepthUsd, 3.92);
  assert.ok(v.depthRatio > 17_000);
  assert.equal(v.contenders.length, 1);
});

test("the contract with 52,214 holders and a $3.86M cap does not win on either", () => {
  // Ranking on holders selects a token with $1.03 of realisable WETH over the one
  // with $69,583.29. That is the retracted diagnosis, and this is the assertion
  // that stops it coming back.
  const v = dominanceVerdict(measured());
  assert.notEqual(v.winner.address, ROBINHOOD);
  const mostHeld = CENSUS.reduce((a, b) => (b.holders > a.holders ? b : a));
  assert.equal(mostHeld.address, ROBINHOOD, "and it IS the most-held — that is the point");
  const biggestCap = CENSUS.reduce((a, b) => (b.marketCap > a.marketCap ? b : a));
  assert.equal(biggestCap.address, ROBINHOOD, "and the biggest notional cap");
});

test("two comparable markets are ambiguous and are asked about", () => {
  const rows = [
    { address: "0xa", symbol: "DUAL", name: "Alpha", quoteLiquidityUsd: 50_000 },
    { address: "0xb", symbol: "DUAL", name: "Beta", quoteLiquidityUsd: 30_000 },
  ];
  const v = dominanceVerdict(rows);
  assert.equal(v.verdict, "ambiguous");
  assert.equal(v.contenders.length, 2);
  assert.equal(v.contenders[0].address, "0xa", "deepest first");
});

test("the dominance threshold is exactly DOMINANCE_RATIO and is tested on both sides", () => {
  // The corroboration leg is held CONSTANT and pointed at 0xa in both halves, so
  // what moves the verdict here is the depth ratio and nothing else.
  const at = dominanceVerdict([
    { address: "0xa", symbol: "X", quoteLiquidityUsd: MEANINGFUL_DEPTH_USD * DOMINANCE_RATIO, volume24h: 5_000 },
    { address: "0xb", symbol: "X", quoteLiquidityUsd: MEANINGFUL_DEPTH_USD },
  ]);
  assert.equal(at.verdict, "ambiguous", "exactly at the ratio is still a choice");

  const past = dominanceVerdict([
    { address: "0xa", symbol: "X", quoteLiquidityUsd: MEANINGFUL_DEPTH_USD * DOMINANCE_RATIO + 1, volume24h: 5_000 },
    { address: "0xb", symbol: "X", quoteLiquidityUsd: MEANINGFUL_DEPTH_USD },
  ]);
  assert.equal(past.verdict, "dominant", "one step past it is settled");
});

test("a rival below the meaningful-depth floor is not a contender however close the ratio", () => {
  // $900 against $1,200 is a 1.3x gap and would be a near-tie on ratio alone.
  // Neither is a market anybody is choosing between, and only the top one clears
  // the floor, so there is nothing to ask about.
  const v = dominanceVerdict([
    { address: "0xa", symbol: "X", quoteLiquidityUsd: MEANINGFUL_DEPTH_USD + 200, volume24h: 5_000 },
    { address: "0xb", symbol: "X", quoteLiquidityUsd: MEANINGFUL_DEPTH_USD - 100 },
  ]);
  assert.equal(v.verdict, "dominant");
  assert.equal(v.contenders.length, 1);
});

/* ---------------------------- lower-bound depths -------------------------- */

test("A LOWER BOUND THAT ALREADY BEATS THE FIELD WINS OUTRIGHT", () => {
  // G1. A truncated tick walk returns everything it summed before the read budget
  // bit — a real integral over a shorter range, so the true depth is AT LEAST this.
  // Beating every (exact) rival by more than the ratio is therefore beating them by
  // more still, and the verdict stands rather than degrading.
  const v = dominanceVerdict([
    {
      address: "0xa",
      symbol: "X",
      quoteLiquidityUsd: MEANINGFUL_DEPTH_USD * DOMINANCE_RATIO + 1,
      depthIsLowerBound: true,
      volume24h: 5_000,
    },
    { address: "0xb", symbol: "X", quoteLiquidityUsd: MEANINGFUL_DEPTH_USD },
  ]);
  assert.equal(v.verdict, "dominant", "a floor that clears the field is enough to settle it");
  assert.equal(v.legs.depth.topIsLowerBound, true);
  assert.equal(v.legs.depth.rivalsLowerBound, false);
  assert.equal(v.legs.depth.boundInconclusive, false);
  // …but the SENTENCE may not round the floor up into a measurement.
  const notice = collisionNotice(v, "X");
  assert.match(notice, /at least/, "the figure is quoted as a floor");
  assert.match(notice, /LOWER BOUND/);
});

test("A LOWER BOUND ON A RIVAL SETTLES NOTHING — the ordering is not established", () => {
  // The rival could be deeper than the leader and nothing here can rule it out, so
  // the dominance claim is withdrawn rather than asserted over an unknown.
  const v = dominanceVerdict([
    { address: "0xa", symbol: "X", quoteLiquidityUsd: 50_000, volume24h: 5_000 },
    { address: "0xb", symbol: "X", quoteLiquidityUsd: MEANINGFUL_DEPTH_USD, depthIsLowerBound: true },
  ]);
  assert.equal(v.verdict, "partial", "measured, and inconclusive — not dominant");
  assert.equal(v.dominant, false);
  assert.equal(v.legs.depth.boundInconclusive, true);
  assert.equal(v.failedCount, 0, "and NOT because a probe failed");
  const notice = collisionNotice(v, "X");
  assert.match(notice, /Every probe answered; what is missing is exactness, not data/);
  assert.match(notice, /claim NEITHER that it dominates/);
});

test("a lower bound may never establish an ABSENCE — 'shallow' downgrades to 'partial'", () => {
  // "Nothing here clears the floor" is a claim about what is NOT there, and a figure
  // that only ever counts upward cannot support it: the truncated pool's real depth
  // could be well past the floor.
  const shallow = dominanceVerdict([
    { address: "0xa", symbol: "X", quoteLiquidityUsd: 40 },
    { address: "0xb", symbol: "X", quoteLiquidityUsd: 2 },
  ]);
  assert.equal(shallow.verdict, "shallow", "the control: exact figures, and none clears the floor");

  const bounded = dominanceVerdict([
    { address: "0xa", symbol: "X", quoteLiquidityUsd: 40, depthIsLowerBound: true },
    { address: "0xb", symbol: "X", quoteLiquidityUsd: 2 },
  ]);
  assert.equal(bounded.verdict, "partial");
  assert.equal(bounded.legs.depth.boundInconclusive, true);
  assert.doesNotMatch(
    collisionNotice(bounded, "X"),
    /has a market of any size/,
    "the absence sentence may not be reached from a floor",
  );
});

test("the lower-bound flag survives the probe, the survey and applyDepths intact", () => {
  // The qualifier has to travel WITH the number at every hop. A row that arrives
  // carrying a figure and having lost the flag is ranked as though it were exact,
  // which is precisely the claim the flag exists to prevent.
  const rows = [
    { address: "0xa", symbol: "X" },
    { address: "0xb", symbol: "X" },
  ];
  const applied = applyDepths(rows, new Map([["0xa", 500], ["0xb", 10]]), new Set(["0xa"]));
  assert.equal(applied[0].quoteLiquidityUsd, 500);
  assert.equal(applied[0].depthIsLowerBound, true);
  assert.equal(applied[1].depthIsLowerBound, false, "explicit false, never an absent key");

  const v = dominanceVerdict(applied);
  assert.equal(v.measuredRows[0].depthIsLowerBound, true, "and out the far side too");
  assert.equal(v.legs.depth.lowerBoundCount, 1);
});

test("a probe that answers with a bare number is taken as EXACT, never as a bound", async () => {
  // The safe reading of an ambiguous seam: a caller that knows about lower bounds
  // says so. Silence must not be read as "this might be a floor", because that would
  // make every legacy probe permanently inconclusive.
  const survey = await measureDepths(
    [
      { address: "0xa", symbol: "X" },
      { address: "0xb", symbol: "X" },
    ],
    { probe: async (a) => (a === "0xa" ? 50_000 : { depthUsd: 10, lowerBound: true }) },
  );
  assert.equal(survey.measured, 2);
  assert.deepEqual([...survey.lowerBounds], ["0xb"]);
});

/* -------------------------- the corroboration leg ------------------------- */

test("a depth gap with no second instrument behind it is 'uncorroborated', not dominance", () => {
  // The same rows as the test above with the volume removed. Depth is a snapshot of
  // capital that can be withdrawn; without a second measurement saying anything
  // happened, one rentable number does not get to name a winner.
  const v = dominanceVerdict([
    { address: "0xa", symbol: "X", quoteLiquidityUsd: MEANINGFUL_DEPTH_USD + 200 },
    { address: "0xb", symbol: "X", quoteLiquidityUsd: MEANINGFUL_DEPTH_USD - 100 },
  ]);
  assert.equal(v.verdict, "uncorroborated");
  assert.equal(v.dominant, false);
  assert.equal(v.ambiguous, false, "silence is not disagreement, so there is nothing to ask");
  assert.equal(v.winner.address, "0xa", "the deepest is still named");
  assert.equal(v.legs.trading.signal, null);
  assert.equal(v.legs.depth.leader, "0xa");
});

test("the legs naming different contracts is 'conflicted', and it asks", () => {
  const v = dominanceVerdict([
    { address: "0xa", symbol: "X", name: "Deep", quoteLiquidityUsd: 50_000 },
    { address: "0xb", symbol: "X", name: "Traded", quoteLiquidityUsd: 12, volume24h: 90_000 },
  ]);
  assert.equal(v.verdict, "conflicted");
  assert.equal(v.ambiguous, true, "the reader is asked, through the ambiguous path");
  assert.equal(v.dominant, false);
  assert.equal(v.legs.depth.leader, "0xa");
  assert.equal(v.legs.trading.leader, "0xb");
  assert.equal(v.legs.conflict, true);
  // The options are the two the legs named — NOT the depth contenders, which would
  // never include a squatter with all the volume and no pool.
  assert.deepEqual(v.contenders.map((c) => c.address), ["0xa", "0xb"]);
  assert.equal(v.contenders[1].volume24hUsd, 90_000, "each option carries both legs");
  assert.match(v.clarifyQuestion, /disagree/i);
});

test("volume outranks a quoted price, and two quoted prices name nobody", () => {
  // volume_24h is a record of trades that settled; an exchange_rate is the indexer
  // saying it found a market without saying how much went through it.
  const byVolume = dominanceVerdict([
    { address: "0xa", symbol: "X", quoteLiquidityUsd: 50_000, price: 1 },
    { address: "0xb", symbol: "X", quoteLiquidityUsd: 12, volume24h: 40 },
  ]);
  assert.equal(byVolume.legs.trading.signal, "volume_24h");
  assert.equal(byVolume.legs.trading.leader, "0xb", "the weaker signal on 0xa does not outrank it");

  // Two priced contracts, no volume anywhere: the indexer has not distinguished
  // them, so it names nobody rather than letting depth pick for it.
  const tied = dominanceVerdict([
    { address: "0xa", symbol: "X", quoteLiquidityUsd: 50_000, price: 1 },
    { address: "0xb", symbol: "X", quoteLiquidityUsd: 12, price: 2 },
  ]);
  assert.equal(tied.legs.trading.signal, null);
  assert.equal(tied.verdict, "uncorroborated");
});

test("a shallow field the indexer says traded may not be reported as an absence", () => {
  // Both legs point at the SAME contract and disagree about whether it is a market,
  // which is not a "which do you mean" question — so it does not become a menu. It
  // stays shallow, and the sentence that says nothing has a market is withdrawn.
  const v = dominanceVerdict([
    { address: "0xa", symbol: "X", quoteLiquidityUsd: 40, volume24h: 2_808.23 },
    { address: "0xb", symbol: "X", quoteLiquidityUsd: 2 },
  ]);
  assert.equal(v.verdict, "shallow");
  assert.equal(v.ambiguous, false);
  assert.equal(v.tradingContradiction, true);
  const notice = collisionNotice(v, "X");
  assert.match(notice, /point opposite ways/);
  assert.doesNotMatch(notice, /none of the contracts measured has a market/);
});

test("a field of dust is 'shallow', not a menu of dust", () => {
  const v = dominanceVerdict(measured().filter((c) => c.address !== GREEN_BULL));
  assert.equal(v.verdict, "shallow");
  assert.equal(v.ambiguous, false, "four contracts with a dollar each is not a choice");
  assert.equal(v.winner.address, CENSUS[1].address, "the deepest is still named");
});

test("nothing measured is 'unmeasured' — unknown, never none", () => {
  const v = dominanceVerdict(unmeasured());
  assert.equal(v.verdict, "unmeasured");
  assert.equal(v.topDepthUsd, null);
  assert.equal(v.measuredCount, 0);
  assert.equal(v.unmeasuredCount, CENSUS.length);
});

test("an unmeasured candidate never becomes a contender beside a measured one", () => {
  const v = dominanceVerdict([
    { address: "0xa", symbol: "X", quoteLiquidityUsd: 40_000 },
    { address: "0xb", symbol: "X", quoteLiquidityUsd: null },
    { address: "0xc", symbol: "X" },
  ]);
  assert.equal(v.contenders.length, 1);
  assert.equal(v.winner.address, "0xa");
  assert.equal(v.unmeasuredCount, 2, "but they are counted and reported");
  // …and one measured contract with no measured rival is not dominance over
  // anything. It is the deepest thing that answered, which is what "partial" says.
  assert.equal(v.verdict, "partial");
  assert.equal(v.dominant, false);
  assert.match(collisionNotice(v, "X"), /No rival was measured beside it/);
});

/* ------------------- a verdict may not outrun its sample ------------------- */

test("five failed probes and one $69.58K read is NOT dominance", () => {
  // THE F3 INVERSION. Six attempts, one success, and the old code emitted "That is
  // not a close call — report on this contract directly": dominance declared over
  // five rivals nobody could measure.
  const rows = measured().slice(0, 6).map((c, i) => (i === 0 ? c : { ...c, quoteLiquidityUsd: null }));
  const v = dominanceVerdict(rows, { candidateCount: 8, attempted: 6, measured: 1, failed: 5, dropped: 2, bound: 6 });
  assert.equal(v.verdict, "partial");
  assert.equal(v.dominant, false);
  assert.equal(v.winner.address, GREEN_BULL, "the deepest READ contract is still named");
  const s = collisionNotice(v, "VLAD");
  assert.match(s, /5 further contracts were probed and could not be read/);
  assert.match(s, /settles nothing/);
  assert.doesNotMatch(s, /not a close call/);
});

test("five failed probes and one $1.03 read is NOT 'nothing has a market'", () => {
  // THE F3 CASE AS EXECUTED BY THE AUDIT: 8 candidates, 6 probed, 5 throwing, and
  // the one that answered a $1.03 squatter. The old sentence read "Measured 6 of
  // the 8 contracts wearing VLAD … none holds as much as $1.00K … so say that
  // plainly" — five of those six were never measured at all.
  const rows = [
    { address: ROBINHOOD, symbol: "VLAD", name: "The Robinhood", quoteLiquidityUsd: 1.03 },
    ...CENSUS.slice(0, 5).map((c) => ({ address: c.address, symbol: "VLAD", name: c.name, quoteLiquidityUsd: null })),
  ];
  const v = dominanceVerdict(rows, { candidateCount: 8, attempted: 6, measured: 1, failed: 5, dropped: 2, bound: 6 });
  assert.equal(v.verdict, "partial", "not shallow — shallow is a claim about contracts nobody read");
  const s = collisionNotice(v, "VLAD");
  assert.match(s, /Measured 1 of the 8 contracts/, "the count is measurements obtained, not probes attempted");
  assert.match(s, /5 further contracts were probed and could not be read/);
  assert.doesNotMatch(s, /say that plainly/);
  assert.doesNotMatch(s, /has a market of any size/);
});

test("a bound that dropped candidates does not downgrade a clean sweep", () => {
  // A DROPPED CANDIDATE IS NOT A FAILED PROBE. The bound is a stated limit; a
  // failure is the measurement not happening. Conflating them would make every
  // 229-contract collision permanently "partial".
  const v = dominanceVerdict(measured(), { candidateCount: 229, attempted: 6, measured: 6, failed: 0, dropped: 223, bound: 6 });
  assert.equal(v.verdict, "dominant");
  assert.equal(v.failedCount, 0);
  assert.equal(v.dropped, 223);
});

/* ------------------------------- the sentences ------------------------------- */

test("the dominant notice names the contract, the gap and the bound", () => {
  const survey = { candidateCount: 229, attempted: 6, measured: 6, failed: 0, dropped: 223, bound: 6 };
  const s = collisionNotice(dominanceVerdict(measured(), survey), "VLAD");
  assert.match(s, /6 of the 229 contracts wearing VLAD that the explorer returned/);
  assert.match(s, /The Green Bull/);
  assert.match(s, /\$69\.58K/);
  assert.match(s, /do not offer the reader a menu/);
  assert.match(s, /223 more went unmeasured/, "the bound is stated, and what it dropped");
  assert.match(s, /unknown rather than shallow/);
});

test("the ambiguous notice tells the caller to ask, and lists what to ask about", () => {
  const v = dominanceVerdict([
    { address: "0xaaaa000000000000000000000000000000000001", symbol: "DUAL", name: "Alpha", quoteLiquidityUsd: 50_000 },
    { address: "0xbbbb000000000000000000000000000000000002", symbol: "DUAL", name: "Beta", quoteLiquidityUsd: 30_000 },
  ]);
  const s = collisionNotice(v, "DUAL");
  assert.match(s, /ask which contract they mean/);
  assert.match(s, /Alpha/);
  assert.match(s, /Beta/);
});

test("the unmeasured notice says unknown and does not say none", () => {
  const s = collisionNotice(dominanceVerdict(unmeasured()), "VLAD");
  assert.match(s, /unknown — not that none does/);
});

test("candidateLabel gives a reader something to tell two contracts apart by", () => {
  assert.equal(candidateLabel(CENSUS[0]), '0x31be…bf81 ("The Green Bull")');
  // A contract whose name IS its ticker adds nothing by repeating it.
  assert.equal(candidateLabel({ address: "0x31be8f7485e36928c9de86566c62da82d4b6bf81", symbol: "VLAD", name: "vlad" }), "0x31be…bf81");
});

test("ratioLabel reads as a multiple and never as money", () => {
  assert.equal(ratioLabel(3.43), "3.4×");
  assert.equal(ratioLabel(17750.8), "17,751×");
  assert.equal(ratioLabel(null), null);
  assert.equal(ratioLabel(Infinity), null);
});

/* ------------------------------ the naked cap ------------------------------ */

test("a cap towering over its depth may not be quoted alone", () => {
  const s = capNotice(3_855_217, 1.03);
  assert.match(s, /\$3\.86M/);
  assert.match(s, /\$1\.03/);
  assert.match(s, /notional/);
  // And it must not overcorrect into an accusation.
  assert.match(s, /not evidence of a scam/);
  assert.doesNotMatch(s, /rug|fraud|manipulat/i);
});

test("a cap proportionate to its depth needs no qualifier", () => {
  // The Green Bull: $238,397 behind $69,583.29 — 3.4x, and the liquidity notice
  // already states the depth. A second sentence here would only dilute the one
  // that fires when it matters.
  assert.equal(capNotice(238_397, 69_583.29), null);
});

test("the cap threshold is exactly CAP_TO_DEPTH_RATIO", () => {
  assert.equal(capNotice(CAP_TO_DEPTH_RATIO * 100 - 1, 100), null);
  assert.ok(capNotice(CAP_TO_DEPTH_RATIO * 100, 100), "at the ratio it fires");
});

test("unmeasured depth is neither deep nor thin, and the cap still gets a qualifier", () => {
  const s = capNotice(3_855_217, null);
  assert.match(s, /was not measured/);
  assert.match(s, /never that it is deep and never that it is thin/);
});

test("total liquidity that is the token valuing itself is named as circular", () => {
  // Vladhoods: liquidityUsd $363,783 against a quote side of $3.91. The big figure
  // is ~900M of the token priced at its own quote — the number a reader is most
  // likely to mistake for money.
  const s = capNotice(405_629, 3.91, 363_783);
  assert.match(s, /valuing ITSELF/);
  assert.match(s, /\$363\.78K/);
  assert.match(s, /\$3\.91/);
});

test("no cap means no notice — a missing figure is never qualified into existence", () => {
  assert.equal(capNotice(null, 1.03), null);
  assert.equal(capNotice("", 1.03), null);
  assert.equal(capNotice(0, 1.03), null);
});
