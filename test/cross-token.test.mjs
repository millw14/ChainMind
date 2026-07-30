// Tests for lib/cross-token.js — relations across tokens and wallets: which
// wallets hold ALL of these tokens, what else a token's holders hold, and what one
// named wallet holds.
//
// THE SCENARIO BELOW IS THE MEASURED ONE, rebuilt offline. A real user on
// chainmind.fun asked which wallet in 0x31ba…c6cc "also bought" 0xa15c…7b32; the app
// had no tool for a relation, so it ran a single-token lookup on the FIRST address,
// printed its holders and never mentioned the second token. Live on chain 4663 the
// true answer is 14 wallets, including 0x80fd…bcbd (the wallet the user named, with
// 32,099,881 PIPECAT and 14,454,873 MERRYMEN). The biggest balance in that
// intersection, 0x8366…0951 on ~50% of PIPECAT's supply, is NOT a wallet at all — it is
// the Uniswap v4 PoolManager, and it was printed as the headline row until the role
// rules learned to see it. 150 + 473 holders is 13 indexer calls.
//
// The nine claims these tests exist to pin down:
//   1. two small lists read in full give an EXACT intersection, and it says so;
//   2. a list cut short by the page cap gives a labelled LOWER BOUND, and the
//      truncation is visible in the DATA and not only in the prose;
//   3. a list too big to read selects the smallest-set probe, and the result
//      REPORTS which strategy ran;
//   4. a pool, a burn sink and a token contract are never presented as interested
//      wallets, whichever strategy ran;
//   5. three tokens intersect to the wallets in all three, not in any two;
//   6. an empty overlap from complete lists is a MEASURED zero, and an empty
//      overlap from a part-read one is NOT the same fact;
//   7. a page or a probe the indexer refused surfaces as unknown, and never shrinks
//      the answer silently;
//   8. a page that DROPPED is re-asked before any of that, because the measured
//      failure is random and ~10% per page — so the usual outcome used to be a
//      needlessly truncated answer, and a retry that cannot be afforded is reported
//      as a shortage of TIME rather than as an indexer outage;
//   9. the Uniswap v4 PoolManager is a pool, not the most interesting wallet in the
//      overlap — identified by BEHAVIOUR, and an unresolved check caveats instead of
//      quietly promoting it back to a holder.
//
// And the honesty that spans all of them: nothing here reports co-holding as
// buying, and every count carries its denominators.
//
// Entirely offline: the indexer and the pool resolver are both injected, so nothing
// here touches the network. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_COHOLDING_HOLDERS,
  HOLDER_PAGE_SIZE,
  MAX_CANDIDATES_PROBED,
  MAX_TOKENS,
  OVERLAP_STRATEGIES,
  coHoldings,
  holderOverlap,
  walletTokenPositions,
} from "../lib/cross-token.js";
import { HOLDER_ROLES, ZERO_ADDRESS } from "../lib/holder-history.js";
import { runWithBudget } from "../lib/request-budget.js";

/* --------------------------------- fixtures ------------------------------- */

/** A distinct 20-byte address from a hex prefix, so every fixture reads as itself. */
const addr = (prefix) => `0x${prefix}${"0".repeat(40 - prefix.length)}`;

const A = addr("31ba1d706d"); // PIPECAT
const B = addr("a15cd06dd3"); // Merrymen by Virtuals
const C = addr("c0ffee11"); // a third token, for the three-way overlap
const W_BOTH = addr("80fd2f3ed8"); // the wallet the user named
const W_WHALE = addr("8366a39cc6"); // PIPECAT's #1 holder, 52.4% of supply
const W_A_ONLY = addr("aa11");
const W_B_ONLY = addr("bb22");
const POOL_A = addr("9911");

/** 9.5478e26 and 1e27 — PIPECAT's and MERRYMEN's measured supplies. */
const SUPPLY_A = (954_780_000n * 10n ** 18n).toString();
const SUPPLY_B = (1_000_000_000n * 10n ** 18n).toString();

/** Whole tokens as base units at 18 decimals. */
const bal = (n) => (BigInt(n) * 10n ** 18n).toString();

const tokenBodies = {
  [A]: { symbol: "PIPECAT", name: "PIPECAT", decimals: "18", total_supply: SUPPLY_A, holders: "150" },
  [B]: { symbol: "MERRYMEN", name: "Merrymen by Virtuals", decimals: "18", total_supply: SUPPLY_B, holders: "473" },
  [C]: { symbol: "THIRD", name: "Third Token", decimals: "18", total_supply: SUPPLY_B, holders: "40" },
};

/** A holder-list page in the shape the indexer answers: items[].address.hash + value. */
const holder = (address, amount) => ({ address: { hash: address }, value: bal(amount) });

/**
 * PIPECAT's list, one page. It contains the pool, the burn sink and the token's own
 * contract because the measured one did — three addresses in a balance-ranked list
 * that are not wallets with a position.
 */
const PAGES_A = [
  [holder(W_WHALE, 500_000_000), holder(W_BOTH, 32_099_881), holder(W_A_ONLY, 1_000), holder(POOL_A, 90_000_000), holder(ZERO_ADDRESS, 5_000_000), holder(A, 1_000_000)],
];

/** MERRYMEN's list, two pages — so a page cap has something to cut. */
const PAGES_B = [
  [holder(W_WHALE, 50_000_000), holder(W_B_ONLY, 2_000), holder(POOL_A, 80_000_000)],
  [holder(W_BOTH, 14_454_873), holder(ZERO_ADDRESS, 4_000_000), holder(A, 900_000)],
];

/** The third token: only W_BOTH of the overlapping pair is in it. */
const PAGES_C = [[holder(W_BOTH, 7_000), holder(W_B_ONLY, 12)]];

/** A /token-balances entry, the shape one wallet's portfolio row arrives in. */
const entry = (token, amount, extra = {}) => ({
  token: {
    address_hash: token,
    symbol: tokenBodies[token]?.symbol ?? null,
    name: tokenBodies[token]?.name ?? null,
    decimals: "18",
    ...extra,
  },
  value: bal(amount),
});

const PORTFOLIOS = {
  [W_WHALE]: [entry(A, 500_000_000), entry(B, 50_000_000)],
  [W_BOTH]: [entry(A, 32_099_881), entry(B, 14_454_873), entry(C, 7_000)],
  [W_A_ONLY]: [entry(A, 1_000)],
  [POOL_A]: [entry(A, 90_000_000), entry(B, 80_000_000)],
  [ZERO_ADDRESS]: [entry(A, 5_000_000), entry(B, 4_000_000)],
  [A]: [entry(A, 1_000_000), entry(B, 900_000)],
};

/**
 * A fake indexer. Every call is recorded, so the bounds — which lists were read at
 * all, how many pages, how many portfolio probes — are asserted rather than assumed.
 *
 * `pageFails` maps a token to the 1-based page number that throws, which is how a
 * mid-walk HTTP 500 is reproduced: the pages before it arrived, the ones after are
 * unknown.
 */
function fakeIndexer({
  pages = { [A]: PAGES_A, [B]: PAGES_B, [C]: PAGES_C },
  portfolios = PORTFOLIOS,
  bodies = tokenBodies,
  tokenFails = new Set(),
  pageFails = new Map(),
  pageFlakes = new Map(),
  portfolioFails = new Set(),
} = {}) {
  const seen = { tokens: [], holders: [], portfolios: [] };
  // How many times each flaky page has thrown so far, so a page can fail N times and
  // then answer — the MEASURED shape of this indexer, and the one a retry recovers.
  const flaked = new Map();
  const calls = {
    async getToken(address) {
      seen.tokens.push(address);
      if (tokenFails.has(address)) throw Object.assign(new Error("indexer down"), { status: 503 });
      const body = bodies[address];
      if (!body) throw Object.assign(new Error("not found"), { status: 404 });
      return body;
    },
    async getTokenHolders(address, params = {}) {
      const page = Number(params?.page ?? 0);
      seen.holders.push({ address, page });
      if (pageFails.get(address) === page + 1) throw Object.assign(new Error("indexer down"), { status: 503 });
      const flake = pageFlakes.get(address);
      if (flake && flake.page === page + 1) {
        const key = `${address}:${page}`;
        const already = flaked.get(key) ?? 0;
        if (already < (flake.times ?? 1)) {
          flaked.set(key, already + 1);
          throw Object.assign(new Error("indexer down"), { status: 503 });
        }
      }
      const list = pages[address] ?? [];
      const items = list[page] ?? [];
      return { items, next_page_params: page + 1 < list.length ? { page: page + 1 } : null };
    },
    async getAddressTokenBalances(address) {
      seen.portfolios.push(address);
      if (portfolioFails.has(address)) throw Object.assign(new Error("indexer down"), { status: 500 });
      return portfolios[address] ?? [];
    },
  };
  return { calls, seen };
}

/** A pool resolver that names POOL_A, the way lib/dex-price.js resolvePool would. */
const poolFound = async () => ({ found: { pool: POOL_A }, pools: [{ pool: POOL_A }], reason: null, poolCount: 1 });
/** The chain answered: this token has no pool at all. */
const poolNone = async () => ({ found: null, pools: [], reason: "no_pool", poolCount: 0 });
/** Nobody could look. Not the same fact, and the module must not conflate them. */
const poolUnread = async () => ({ found: null, pools: [], reason: "discovery_failed", poolCount: 0 });

/**
 * The v4 singleton check's three verdicts, in lib/dex-price.js resolveV4PoolManager's
 * shape. Injected rather than derived, because the real one asks the CHAIN how an
 * address behaves and there is no chain here — which is also why W_WHALE stands in for
 * the singleton: what classifyRole compares is the address the verdict carries, so a
 * fixture cannot accidentally depend on a hardcoded mainnet address.
 */
const v4Confirmed = async () => ({ address: W_WHALE, candidate: W_WHALE, status: "confirmed", reason: null });
const v4Rejected = async () => ({
  address: null,
  candidate: W_WHALE,
  status: "rejected",
  reason: "the address answers token0()/token1()",
});
const v4Unread = async () => ({ address: null, candidate: W_WHALE, status: "unread", reason: "the RPC did not answer" });

const walletFor = (result, address) => result.wallets.find((w) => w.address === address) ?? null;
const positionIn = (row, token) => row.positions.find((p) => p.token === token) ?? null;

/* ---------------------------- 1. exact intersection ----------------------- */

test("two small holder lists read in full give an EXACT intersection that says so", async () => {
  const { calls, seen } = fakeIndexer();
  const res = await holderOverlap([A, B], { calls, resolvePool: poolFound });

  assert.equal(res.ok, true);
  assert.equal(res.strategy, OVERLAP_STRATEGIES.FULL);
  assert.equal(res.exact, true);
  assert.equal(res.isLowerBound, false);
  // Two wallets, and the three non-wallets are not among them.
  assert.equal(res.count, 2);
  assert.equal(res.countDisplay, "2 wallets");
  assert.deepEqual(res.wallets.map((w) => w.address), [W_WHALE, W_BOTH]);
  assert.match(res.reading, /^Exactly 2 wallets hold PIPECAT and MERRYMEN\./);
  assert.match(res.reading, /complete set/);
  // No hedge on an exact answer — "at least" must not appear anywhere.
  assert.doesNotMatch(res.countDisplay, /at least/i);

  // Every list was read to the end, and the data says so without the prose.
  for (const t of res.tokens) {
    assert.equal(t.listComplete, true);
    assert.equal(t.listReason, null);
  }
  assert.equal(res.tokens.find((t) => t.address === B).pagesRead, 2);
  // 1 page of A + 2 of B, and one token body each. No portfolio probe at all.
  assert.equal(seen.holders.length, 3);
  assert.deepEqual([...seen.tokens].sort(), [A, B].sort());
  assert.deepEqual(seen.portfolios, []);
});

test("the biggest position leads, and each wallet carries its balance and share in EVERY token", async () => {
  const { calls } = fakeIndexer();
  const res = await holderOverlap([A, B], { calls, resolvePool: poolFound });

  // The single most interesting fact about this pair: PIPECAT's #1 holder is in it.
  const whale = res.wallets[0];
  assert.equal(whale.address, W_WHALE);
  assert.ok(positionIn(whale, A).percent > 50, "the whale holds a majority of PIPECAT");
  assert.match(positionIn(whale, A).percentDisplay, /^52\./);
  assert.match(res.reading, /largest position among them is 0x8366/);

  // The wallet the user named, with both balances present and both shares measured.
  const named = walletFor(res, W_BOTH);
  assert.ok(named, "the wallet the user named is in the overlap");
  assert.equal(positionIn(named, A).amount, 32_099_881);
  assert.equal(positionIn(named, B).amount, 14_454_873);
  assert.equal(positionIn(named, A).symbol, "PIPECAT");
  assert.equal(positionIn(named, B).symbol, "MERRYMEN");
  for (const p of named.positions) {
    assert.equal(typeof p.percent, "number");
    assert.equal(p.percentUnknownReason, null);
    assert.equal(p.source, "holder_list");
  }
});

test("co-holding is never reported as buying", async () => {
  const { calls } = fakeIndexer();
  const res = await holderOverlap([A, B], { calls, resolvePool: poolFound });

  assert.equal(res.measured, "current_co_holding");
  assert.match(res.disclaimer, /CURRENT CO-HOLDING, not shared buying/);
  assert.match(res.disclaimer, /airdrops, migrations/);
  assert.match(res.reading, /not a finding that they bought them/);
  // The word the user's own question used, and the one this module may never claim.
  const prose = `${res.reading} ${res.disclaimer} ${res.strategyReason}`;
  assert.doesNotMatch(prose, /\bbought both\b/i);
  // And no accusation anywhere, on a pair that shares a majority holder.
  assert.doesNotMatch(prose, /scam|rug|fraud|insider|manipulat|wash/i);
  // Coordination appears exactly once, as a REFUSAL to claim it.
  assert.match(prose, /Nothing here is evidence of coordination or wrongdoing/);
  assert.match(prose, /not a finding that they act together/);
});

/* ----------------------- 2. truncation and lower bounds ------------------- */

test("a page cap turns the same question into a labelled LOWER BOUND", async () => {
  // Holder counts unreadable, so nothing can be planned from a count and the walk
  // itself has to report how far it got.
  const { calls } = fakeIndexer({ tokenFails: new Set([A, B]) });
  const res = await holderOverlap([A, B], { calls, resolvePool: poolFound, maxPages: 1 });

  assert.equal(res.exact, false);
  assert.equal(res.isLowerBound, true);
  // W_BOTH lives on page 2 of MERRYMEN and is therefore MISSING from this answer —
  // which is exactly why the count may not be presented as the whole set.
  assert.equal(res.count, 1);
  assert.equal(res.countDisplay, "at least 1 wallet");
  assert.equal(walletFor(res, W_BOTH), null);
  assert.match(res.reading, /AT LEAST 1 wallet/);
  assert.match(res.reading, /LOWER BOUND, not the complete set/);
  assert.match(res.reading, /There may be more; there are not fewer/);

  // THE TRUNCATION IS IN THE DATA, not only in the prose.
  const b = res.tokens.find((t) => t.address === B);
  assert.equal(b.listComplete, false);
  assert.equal(b.pagesRead, 1);
  assert.match(b.listReason, /unknown rather than absent/);
});

test("a failed page surfaces as unknown and never shrinks the answer silently", async () => {
  const { calls } = fakeIndexer({ pageFails: new Map([[B, 2]]) });
  const res = await holderOverlap([A, B], { calls, resolvePool: poolFound });

  const b = res.tokens.find((t) => t.address === B);
  // Page 1 arrived, page 2 threw. The list is part-read, NOT finished.
  assert.equal(b.pagesRead, 1);
  assert.equal(b.listComplete, false);
  assert.match(b.listReason, /HTTP 503/);
  assert.match(b.listReason, /unknown, not absent/);
  assert.ok(res.unavailable.includes(`holders:${B}`));

  // The answer shrinks to one wallet, and says out loud that it is a floor.
  assert.equal(res.exact, false);
  assert.equal(res.count, 1);
  assert.equal(res.countDisplay, "at least 1 wallet");
  assert.match(res.reading, /did not answer for page 2/);
});

/* ---------------------- 2b. the retry that recovers a page ---------------- */

/** No real waiting: the backoff is policy, and lib/page-retry.js owns its own tests. */
const noWait = { retry: { sleep: async () => {} } };

test("a page that drops once is RE-ASKED, and the answer stays exact instead of becoming a floor", async () => {
  // THE MEASURED DEFECT. This indexer drops roughly one page in ten at random and
  // answers the retry: two live runs of the real tool over PIPECAT + MERRYMEN returned
  // "at least 1 wallet" and then "at least 4 wallets" for a pair that shares 14, while a
  // hand walk that retried returned all 474 MERRYMEN holders every time. Without the
  // retry this is exactly the test above — one wallet, a lower bound, W_BOTH missing.
  const { calls } = fakeIndexer({ pageFlakes: new Map([[B, { page: 2, times: 1 }]]) });
  const res = await holderOverlap([A, B], { calls, resolvePool: poolFound, ...noWait });

  assert.equal(res.exact, true);
  assert.equal(res.isLowerBound, false);
  assert.equal(res.count, 2);
  assert.equal(res.countDisplay, "2 wallets");
  // The wallet the user named lives on MERRYMEN's page 2 — the page that dropped.
  assert.ok(walletFor(res, W_BOTH), "the wallet on the recovered page is in the answer");
  assert.doesNotMatch(res.reading, /at least|LOWER BOUND/i);

  const b = res.tokens.find((t) => t.address === B);
  assert.equal(b.listComplete, true);
  assert.equal(b.listReason, null);
  assert.equal(b.pagesRead, 2);
  // WHAT COMPLETENESS COST, in the data: three reads for two pages, one of them retried.
  assert.equal(b.pageAttempts, 3);
  assert.equal(b.retriedPages, 1);
  // And the token that never faltered paid nothing extra.
  const a = res.tokens.find((t) => t.address === A);
  assert.equal(a.retriedPages, 0);
  assert.equal(a.pageAttempts, a.pagesRead);
});

test("two drops on one page are still recovered; the bound is on attempts, not on luck", async () => {
  const { calls } = fakeIndexer({ pageFlakes: new Map([[B, { page: 1, times: 2 }]]) });
  const res = await holderOverlap([A, B], { calls, resolvePool: poolFound, ...noWait });
  assert.equal(res.exact, true);
  assert.equal(res.count, 2);
  assert.equal(res.tokens.find((t) => t.address === B).retriedPages, 1);
});

test("a page that fails EVERY attempt is still an honest lower bound, and says how often it was asked", async () => {
  // The retry does not remove the honesty layer, it only makes it fire less often. A
  // genuinely-down endpoint must read exactly as it did before: part-read, HTTP status
  // named, the holders beyond it unknown rather than absent.
  const { calls, seen } = fakeIndexer({ pageFails: new Map([[B, 2]]) });
  const res = await holderOverlap([A, B], { calls, resolvePool: poolFound, ...noWait });

  const b = res.tokens.find((t) => t.address === B);
  assert.equal(b.listComplete, false);
  assert.equal(b.pagesRead, 1);
  assert.match(b.listReason, /HTTP 503/);
  assert.match(b.listReason, /on 3 attempts/);
  assert.match(b.listReason, /unknown, not absent/);
  assert.equal(res.exact, false);
  assert.equal(res.countDisplay, "at least 1 wallet");
  // Bounded cost: page 2 of B was asked three times and no more.
  assert.equal(seen.holders.filter((h) => h.address === B && h.page === 1).length, 3);
});

test("a retry the request cannot afford is reported as TIME, not as an indexer outage", async () => {
  // THE DISTINCTION THE TASK TURNS ON. A page that failed three times is an outage; a
  // page that failed once with no budget left to ask again is a request that ran out of
  // time. Blaming an upstream that was asked once and never re-asked would be the same
  // conflation this module refuses everywhere else.
  const { calls, seen } = fakeIndexer({ pageFails: new Map([[B, 2]]) });
  const res = await runWithBudget(
    () => holderOverlap([A, B], { calls, resolvePool: poolFound, ...noWait }),
    // Enough to start the first read of every page, never enough to fund a retry.
    { totalMs: 1_250, reserveMs: 0 },
  );

  const b = res.tokens.find((t) => t.address === B);
  assert.equal(b.listComplete, false);
  assert.match(b.listReason, /no time left to ask again/);
  assert.doesNotMatch(b.listReason, /attempts/);
  assert.match(b.listReason, /unknown, not absent/);
  assert.equal(res.exact, false);
  assert.equal(seen.holders.filter((h) => h.address === B && h.page === 1).length, 1);
});

test("a token whose own body could not be read leaves shares unknown, never zero", async () => {
  const { calls } = fakeIndexer({ tokenFails: new Set([B]) });
  const res = await holderOverlap([A, B], { calls, resolvePool: poolFound });

  assert.ok(res.unavailable.includes(`token:${B}`));
  // The lists still intersect, but nothing may be claimed as exact off a token whose
  // supply and symbol are unknown.
  assert.equal(res.exact, false);
  const named = walletFor(res, W_BOTH);
  const missing = positionIn(named, B);
  assert.equal(missing.percent, null);
  assert.equal(missing.percentDisplay, null);
  assert.match(missing.percentUnknownReason, /unknown rather than zero/);
  assert.match(res.reading, /missing rather than zero/);
});

/* ------------------------- 3. the smallest-set probe ---------------------- */

test("a list too big to read selects the smallest-set probe, and reports that it did", async () => {
  // MERRYMEN as the measured 52,214-holder VLAD contract: ~1,045 pages, unreadable.
  const bodies = { ...tokenBodies, [B]: { ...tokenBodies[B], holders: "52214" } };
  const { calls, seen } = fakeIndexer({ bodies });
  const res = await holderOverlap([A, B], { calls, resolvePool: poolFound });

  assert.equal(res.strategy, OVERLAP_STRATEGIES.SMALLEST);
  assert.equal(res.base.address, A);
  assert.match(res.strategyReason, /52,214 holders/);
  assert.match(res.strategyReason, /SMALLEST list was read/);
  assert.match(res.strategyReason, /must hold the smallest one/);
  assert.match(res.reading, /through its own portfolio/);

  // ONLY the small list was paged, and each of its holders cost one portfolio call.
  assert.ok(seen.holders.every((h) => h.address === A), "the big list is never paged");
  assert.deepEqual([...seen.portfolios].sort(), PAGES_A[0].map((h) => h.address.hash).sort());

  // Same answer as the full intersection, and still exact: the base list was
  // complete, every candidate was probed, and none of the probes failed.
  assert.equal(res.exact, true);
  assert.equal(res.count, 2);
  assert.equal(res.countDisplay, "2 wallets");
  assert.deepEqual(res.wallets.map((w) => w.address), [W_WHALE, W_BOTH]);
  assert.equal(res.candidates.complete, true);
  assert.equal(res.candidates.probed, 6);
  assert.equal(res.candidates.unknownCount, 0);

  // The balance for the unread token comes from the wallet's own portfolio, and the
  // row says so rather than implying it came off a holder list nobody read.
  const named = walletFor(res, W_BOTH);
  assert.equal(positionIn(named, A).source, "holder_list");
  assert.equal(positionIn(named, B).source, "portfolio");
  assert.equal(positionIn(named, B).amount, 14_454_873);
});

test("a candidate whose portfolio did not answer is UNKNOWN, not a wallet that does not hold", async () => {
  const bodies = { ...tokenBodies, [B]: { ...tokenBodies[B], holders: "52214" } };
  const { calls } = fakeIndexer({ bodies, portfolioFails: new Set([W_BOTH]) });
  const res = await holderOverlap([A, B], { calls, resolvePool: poolFound });

  // The wallet is neither in the overlap nor excluded from it — it is unknown.
  assert.equal(walletFor(res, W_BOTH), null);
  assert.equal(res.candidates.unknownCount, 1);
  assert.equal(res.candidates.unknown[0].address, W_BOTH);
  assert.match(res.candidates.unknown[0].reason, /HTTP 500/);
  assert.match(res.candidates.unknown[0].reason, /unknown, not no/);

  // And one unreadable candidate is enough to stop the answer claiming to be whole.
  assert.equal(res.exact, false);
  assert.equal(res.countDisplay, "at least 1 wallet");
  assert.match(res.candidates.reason, /not counted as holding, and not counted as not holding/);
});

test("a candidate cap bites the smallest positions and is reported, never hidden", async () => {
  const bodies = { ...tokenBodies, [B]: { ...tokenBodies[B], holders: "52214" } };
  const { calls, seen } = fakeIndexer({ bodies });
  const res = await holderOverlap([A, B], { calls, resolvePool: poolFound, maxCandidates: 2 });

  // Probed largest balance first, so the majority holder is never the one dropped.
  assert.deepEqual(seen.portfolios, [W_WHALE, POOL_A]);
  assert.equal(res.candidates.attempted, 2);
  assert.equal(res.candidates.of, 6);
  assert.equal(res.candidates.complete, false);
  assert.equal(res.exact, false);
  assert.match(res.candidates.reason, /2 candidates of the 6 holders read/);
  assert.match(res.candidates.reason, /unknown rather than excluded/);
  assert.equal(res.countDisplay, "at least 1 wallet");
  assert.ok(MAX_CANDIDATES_PROBED >= 2, "the cap is a bound a caller may lower, not raise past");
});

/* ------------------------------ 4. role labels ---------------------------- */

test("a pool, the burn address and a token contract are never presented as wallets", async () => {
  const { calls } = fakeIndexer();
  const res = await holderOverlap([A, B], { calls, resolvePool: poolFound });

  // All three hold both tokens, and none of them is a wallet with a position.
  const roles = new Map(res.excluded.map((e) => [e.address, e.role]));
  assert.equal(roles.get(POOL_A), HOLDER_ROLES.POOL);
  assert.equal(roles.get(ZERO_ADDRESS), HOLDER_ROLES.BURN);
  assert.equal(roles.get(A), HOLDER_ROLES.CONTRACT);
  assert.equal(res.excludedCount, 3);
  for (const address of [POOL_A, ZERO_ADDRESS, A]) {
    assert.equal(walletFor(res, address), null, `${address} must not be listed as a wallet`);
  }
  // POOL_A holds more of both tokens than anybody: without the labels it would be
  // the headline row.
  assert.notEqual(res.wallets[0].address, POOL_A);
  assert.match(res.excludedNote, /not wallets with a position/);
  assert.match(res.reading, /3 addresses in the intersection are not a wallet/);
  // Kept and labelled rather than dropped, so the rows reconcile against the explorer.
  assert.equal(res.excluded.find((e) => e.address === POOL_A).positions.length, 2);
  assert.match(res.excluded.find((e) => e.address === ZERO_ADDRESS).roleReason, /burned, not held/);
});

test("the same three are excluded under the smallest-set probe too", async () => {
  const bodies = { ...tokenBodies, [B]: { ...tokenBodies[B], holders: "52214" } };
  const { calls } = fakeIndexer({ bodies });
  const res = await holderOverlap([A, B], { calls, resolvePool: poolFound });

  assert.deepEqual(res.excluded.map((e) => e.role).sort(), [HOLDER_ROLES.BURN, HOLDER_ROLES.CONTRACT, HOLDER_ROLES.POOL].sort());
  assert.equal(res.count, 2);
});

test("an unidentified pool is a stated caveat, not a silent promotion to wallet", async () => {
  const { calls } = fakeIndexer();
  const res = await holderOverlap([A, B], { calls, resolvePool: poolUnread });

  assert.equal(res.poolStatus, "unread");
  assert.match(res.poolCaveat, /may in fact be a liquidity pool/);
  assert.match(res.reading, /may in fact be a liquidity pool/);
  // With nobody able to say which address is the pool, POOL_A is in the wallet list
  // — and the caveat above is the only honest way to publish that list.
  assert.ok(walletFor(res, POOL_A));
  // The burn sink and the contract need no RPC, so those two rules still hold.
  assert.equal(walletFor(res, ZERO_ADDRESS), null);
  assert.equal(walletFor(res, A), null);
});

test("the chain answering \"no pool\" is not the same as nobody looking", async () => {
  const { calls } = fakeIndexer();
  const res = await holderOverlap([A, B], { calls, resolvePool: poolNone });
  assert.equal(res.poolStatus, "none");
  assert.equal(res.poolCaveat, null);
});

test("the Uniswap v4 PoolManager is excluded as a pool and is never the headline row", async () => {
  // THE REPRODUCED COMPLAINT. W_WHALE holds a majority of A and a slice of B, which is
  // what made it the most interesting "wallet" in the overlap. It is the v4 singleton:
  // v4 keeps every pool in ONE contract that custodies every token, so one address is a
  // large holder of many unrelated tokens for reasons that have nothing to do with
  // conviction. It has no token0(), so no factory sweep can ever put it in `pools` —
  // hence a separate, behaviour-established address rather than a wider sweep.
  const { calls } = fakeIndexer();
  const res = await holderOverlap([A, B], { calls, resolvePool: poolFound, resolveV4PoolManager: v4Confirmed });

  assert.equal(walletFor(res, W_WHALE), null, "the singleton must not be a wallet with a position");
  assert.notEqual(res.wallets[0].address, W_WHALE, "and must not lead the table");
  assert.equal(res.wallets[0].address, W_BOTH, "the largest real position leads instead");
  assert.equal(res.count, 1);

  const row = res.excluded.find((e) => e.address === W_WHALE);
  assert.ok(row, "labelled and listed, so the rows reconcile against the explorer");
  assert.equal(row.role, HOLDER_ROLES.POOL);
  assert.equal(row.poolVersion, "v4");
  assert.match(row.roleReason, /Uniswap v4 PoolManager/);
  // NOT attributed to either token: the singleton holds all of them, so a sentence
  // saying "PIPECAT's v4 PoolManager" would be wrong about what it is.
  assert.equal(row.roleToken, null);
  assert.equal(res.v4PoolManager, W_WHALE);
  assert.equal(res.v4Status, "confirmed");
  assert.equal(res.v4Caveat, null);
  assert.ok(!res.unavailable.includes("v4_pool_identification"));
});

test("an unresolved v4 check labels nothing and states the gap", async () => {
  const { calls } = fakeIndexer();
  const res = await holderOverlap([A, B], { calls, resolvePool: poolFound, resolveV4PoolManager: v4Unread });

  assert.equal(res.v4Status, "unread");
  assert.ok(res.unavailable.includes("v4_pool_identification"));
  // The row stays a wallet, because nothing established what it is — and the answer
  // says so rather than implying every row below is somebody's position.
  assert.ok(walletFor(res, W_WHALE));
  assert.match(res.v4Caveat, /was not established/);
  assert.match(res.reading, /v4 keeps every pool in one contract/);
});

test("a settled v4 negative carries no caveat — the check ran and answered", async () => {
  const { calls } = fakeIndexer();
  const res = await holderOverlap([A, B], { calls, resolvePool: poolFound, resolveV4PoolManager: v4Rejected });
  assert.equal(res.v4Status, "rejected");
  assert.equal(res.v4PoolManager, null);
  assert.equal(res.v4Caveat, null);
  assert.ok(!res.unavailable.includes("v4_pool_identification"));
  // And the address is back to being what the fixture says it is: a large holder.
  assert.ok(walletFor(res, W_WHALE));
});

/* ---------------------------- 5. three tokens ----------------------------- */

test("three tokens intersect to the wallets in ALL three, not in any two", async () => {
  const { calls } = fakeIndexer();
  const res = await holderOverlap([A, B, C], { calls, resolvePool: poolFound });

  assert.equal(res.ok, true);
  assert.equal(res.exact, true);
  // W_WHALE holds A and B but not C, so it drops out; W_BOTH holds all three.
  assert.deepEqual(res.wallets.map((w) => w.address), [W_BOTH]);
  assert.equal(res.countDisplay, "1 wallet");
  assert.equal(res.wallets[0].positions.length, 3);
  assert.deepEqual(res.wallets[0].positions.map((p) => p.token), [A, B, C]);
  assert.match(res.reading, /hold PIPECAT, MERRYMEN and THIRD/);
  assert.equal(res.tokens.length, 3);
});

test("the overall page budget is divided between the lists, not checked after the fact", async () => {
  const { calls } = fakeIndexer();
  const two = await holderOverlap([A, B], { calls, resolvePool: poolFound });
  const three = await holderOverlap([A, B, C], { calls, resolvePool: poolFound });

  // Two lists may spend the per-list cap each; three get a third of the overall
  // budget apiece, so a plan can never promise a complete read it cannot afford.
  assert.equal(two.limits.pagesPerList, 12);
  assert.equal(three.limits.pagesPerList, 10);
  assert.ok(three.limits.pagesPerList * 3 <= three.limits.maxTotalPages);
});

test("a wallet list longer than the row limit says so instead of implying it is all of them", async () => {
  const { calls } = fakeIndexer();
  const res = await holderOverlap([A, B], { calls, resolvePool: poolFound, limit: 1 });

  assert.equal(res.count, 2, "the COUNT is of every wallet found, not of the rows printed");
  assert.equal(res.totalWallets, 2);
  assert.equal(res.wallets.length, 1);
  assert.equal(res.walletsTruncated, true);
  assert.match(res.reading, /1 row of the 2 wallets found is listed below/);
  // Still exact: printing fewer rows is not reading less data.
  assert.equal(res.exact, true);
  assert.equal(res.countDisplay, "2 wallets");
});

test("more tokens than the module will read is refused, not half-answered", async () => {
  const { calls } = fakeIndexer();
  const many = [A, B, C, addr("dd01"), addr("dd02")];
  const res = await holderOverlap(many, { calls, resolvePool: poolFound });
  assert.equal(res.ok, false);
  assert.match(res.error, new RegExp(`at most ${MAX_TOKENS}`));
});

test("one token, or the same token twice, is refused rather than answered as an overlap", async () => {
  const { calls } = fakeIndexer();
  const one = await holderOverlap([A], { calls });
  assert.equal(one.ok, false);
  assert.match(one.error, /at least two token contract addresses/);

  const twice = await holderOverlap([A, A.toUpperCase()], { calls });
  assert.equal(twice.ok, false);
  assert.match(twice.error, /same contract was given twice/);
});

/* ------------------------ 6. empty: measured or unread -------------------- */

test("an empty overlap from complete lists is a MEASURED zero", async () => {
  // Two tokens with no address in common at all.
  const pages = {
    [A]: [[holder(W_A_ONLY, 10)]],
    [B]: [[holder(W_B_ONLY, 10)]],
  };
  const { calls } = fakeIndexer({ pages });
  const res = await holderOverlap([A, B], { calls, resolvePool: poolNone });

  assert.equal(res.ok, true);
  assert.equal(res.count, 0);
  assert.equal(res.exact, true);
  assert.equal(res.isLowerBound, false);
  assert.equal(res.countDisplay, "0 wallets");
  assert.match(res.reading, /No wallet holds PIPECAT and MERRYMEN\./);
  assert.match(res.reading, /MEASURED zero/);
  assert.match(res.reading, /genuinely share no holder/);
});

test("an empty overlap from a part-read list is NOT the same fact", async () => {
  // The same disjoint pair, except MERRYMEN's list runs to two pages and only the
  // first is read. Nothing overlapped in what was read — which is not a finding.
  const pages = {
    [A]: [[holder(W_A_ONLY, 10)]],
    [B]: [[holder(W_B_ONLY, 10)], [holder(W_A_ONLY, 5)]],
  };
  const { calls } = fakeIndexer({ pages, tokenFails: new Set([A, B]) });
  const res = await holderOverlap([A, B], { calls, resolvePool: poolNone, maxPages: 1 });

  assert.equal(res.count, 0);
  assert.equal(res.exact, false);
  assert.equal(res.isLowerBound, true);
  // The two empties must not read alike, and they do not.
  assert.doesNotMatch(res.reading, /MEASURED zero/);
  assert.match(res.reading, /was NOT complete/);
  assert.match(res.reading, /not a finding that nothing overlaps/);
  assert.match(res.reading, /one of them may well hold/);
});

/* ------------------------- 7. first acquisition leg ----------------------- */

test("the acquisition leg reports an acquisition, and refuses to call it a purchase", async () => {
  const NOW = Date.parse("2026-07-29T00:00:00.000Z");
  const DAY = 86_400_000;
  // One exact history, and one full 50-row page — which means the true first
  // acquisition is EARLIER than the oldest row read.
  const page = (oldestBlock, agoDays, count) => ({
    items: Array.from({ length: count }, (_, i) => ({
      block_number: oldestBlock + i * 10,
      timestamp: new Date(NOW - agoDays * DAY + i * 60_000).toISOString(),
    })).reverse(),
    next_page_params: count >= HOLDER_PAGE_SIZE ? { block_number: oldestBlock } : null,
  });
  const { calls } = fakeIndexer();
  // getTokenTransfers is lib/holder-history.js's seam, injected so nothing here can
  // reach the network through the reused probe.
  calls.getTokenTransfers = async (address, params) =>
    params.token === A ? page(4_050_099, 21.5, 6) : page(9_142_261, 15.6, HOLDER_PAGE_SIZE);

  const res = await holderOverlap([A, B], { calls, resolvePool: poolFound, acquisitions: true, now: NOW });
  assert.equal(res.acquisitions.ran, true);
  assert.match(res.acquisitions.note, /an ACQUISITION, not a purchase/);
  assert.match(res.acquisitions.note, /airdrop, a contract migration/);
  assert.doesNotMatch(res.acquisitions.note, /\bbought\b/i);

  const named = res.acquisitions.wallets.find((w) => w.address === W_BOTH);
  const inA = named.tokens.find((t) => t.token === A);
  const inB = named.tokens.find((t) => t.token === B);
  assert.equal(inA.status, "measured");
  assert.equal(inA.isLowerBound, false);
  assert.equal(inA.heldForDisplay, "21.5 days");
  // The qualifier is inside the string, so no caller can quote the figure without it.
  assert.equal(inB.isLowerBound, true);
  assert.equal(inB.heldForDisplay, "at least 15.6 days");
});

test("the acquisition leg is off unless asked for", async () => {
  const { calls, seen } = fakeIndexer();
  const res = await holderOverlap([A, B], { calls, resolvePool: poolFound });
  assert.equal(res.acquisitions, null);
  assert.deepEqual(seen.portfolios, []);
});

/* ------------------------------- coHoldings -------------------------------- */

test("coHoldings reports what else the top holders hold, with both denominators", async () => {
  const bodies = { ...tokenBodies, [A]: { ...tokenBodies[A], holders: "52214" } };
  const { calls, seen } = fakeIndexer({ bodies });
  const res = await coHoldings(A, { calls, resolvePool: poolFound });

  assert.equal(res.ok, true);
  assert.equal(res.symbol, "PIPECAT");
  // Three of the six top holders are the pool, the burn sink and the contract, so
  // three wallets were probed — and a pool's other liquidity is not "what these
  // wallets are also in".
  assert.equal(res.coverage.probed, 3);
  assert.deepEqual([...seen.portfolios].sort(), [W_WHALE, W_BOTH, W_A_ONLY].sort());
  assert.equal(res.excludedCount, 3);
  assert.equal(res.coverage.complete, false);

  // The subject token is not something "else" these wallets hold.
  assert.ok(!res.tokens.some((t) => t.address === A));
  const merrymen = res.tokens.find((t) => t.address === B);
  assert.equal(merrymen.holders, 2);
  assert.equal(merrymen.ofProbed, 3);
  assert.equal(merrymen.sharedDisplay, "2 of the 3 probed holders");
  assert.deepEqual(merrymen.wallets.map((w) => w.address).sort(), [W_WHALE, W_BOTH].sort());
  assert.equal(merrymen.totalAmount, 64_454_873);
  assert.equal(merrymen.totalAmountCounted, 2);

  // BOTH denominators in the prose: 3 probed, out of 52,214 that exist.
  assert.match(res.reading, /3 holders of PIPECAT's 52,214 holders/);
  assert.match(res.reading, /not a pattern across the token/);
  assert.match(res.disclaimer, /not a finding about the token's holder base/);
  assert.doesNotMatch(`${res.reading} ${res.disclaimer}`, /scam|rug|fraud|coordinat/i);
});

test("coHoldings counts a failed probe as unknown rather than shrinking the denominator", async () => {
  const { calls } = fakeIndexer({ portfolioFails: new Set([W_BOTH]) });
  const res = await coHoldings(A, { calls, resolvePool: poolFound });

  assert.equal(res.coverage.probed, 2);
  assert.equal(res.coverage.attempted, 3);
  assert.equal(res.coverage.probeFailed, 1);
  assert.equal(res.coverage.failures[0].address, W_BOTH);
  assert.match(res.coverage.failures[0].reason, /unknown, not none/);
  assert.ok(res.unavailable.includes("holderPortfolios"));
  assert.match(res.reading, /missing from every count above/);
  assert.match(res.reading, /a floor rather than a total/);
});

test("coHoldings reads a holder list that failed as unknown, never as no holders", async () => {
  const { calls } = fakeIndexer({ pageFails: new Map([[A, 1]]) });
  const res = await coHoldings(A, { calls, resolvePool: poolFound });
  assert.equal(res.ok, false);
  assert.match(res.error, /unknown, not absent/);
  assert.match(res.error, /HTTP 503/);
});

test("coHoldings states the pool caveat rather than letting an unread lookup pass as a clean list", async () => {
  const { calls, seen } = fakeIndexer();
  const res = await coHoldings(A, { calls, resolvePool: poolUnread });

  assert.ok(res.unavailable.includes("pool_identification"));
  assert.match(res.reading, /may in fact be a liquidity pool/);
  // With nobody able to name the pool it gets probed like a wallet — which is only
  // publishable because the sentence above travels with it.
  assert.ok(seen.portfolios.includes(POOL_A));
  // The two rules that need no RPC still hold, so those two are never probed.
  assert.ok(!seen.portfolios.includes(ZERO_ADDRESS));
  assert.ok(!seen.portfolios.includes(A));
});

test("coHoldings bounds how many holders it probes, and says how many that was", async () => {
  const { calls, seen } = fakeIndexer();
  const res = await coHoldings(A, { calls, resolvePool: poolFound, limit: 2 });
  assert.equal(seen.holders[0].address, A);
  assert.equal(res.coverage.holdersRead, 6);
  assert.equal(res.coverage.attempted, 2);
  assert.equal(seen.portfolios.length, 2);
  assert.ok(DEFAULT_COHOLDING_HOLDERS >= 2);
});

/* -------------------------- walletTokenPositions -------------------------- */

test("one wallet's positions answer \"does it hold X and Y\" in a single call", async () => {
  const { calls, seen } = fakeIndexer();
  const res = await walletTokenPositions(W_BOTH, { calls, tokens: [A, B] });

  assert.equal(res.ok, true);
  assert.equal(seen.portfolios.length, 1, "one call answers the whole question");
  assert.equal(res.complete, true);
  assert.equal(res.count, 3);
  assert.equal(res.heldCount, 2);
  assert.equal(res.notHeldCount, 0);
  assert.deepEqual(res.asked.map((a) => a.held), [true, true]);
  assert.equal(res.asked[0].position.amount, 32_099_881);
  assert.match(res.reading, /It DOES hold PIPECAT/);
  assert.match(res.reading, /not what it bought/);
  assert.equal(res.measured, "current_holdings");
});

test("a token absent from a whole portfolio is a MEASURED absence", async () => {
  const { calls } = fakeIndexer();
  const res = await walletTokenPositions(W_A_ONLY, { calls, tokens: [A, B] });

  const b = res.asked.find((a) => a.token === B);
  assert.equal(b.held, false);
  assert.equal(b.position, null);
  assert.match(b.reason, /measured absence/);
  assert.equal(res.notHeldCount, 1);
  assert.match(res.reading, /does NOT hold/);
});

test("a portfolio that did not answer is an error, never an empty wallet", async () => {
  const { calls } = fakeIndexer({ portfolioFails: new Set([W_BOTH]) });
  const res = await walletTokenPositions(W_BOTH, { calls, tokens: [A, B] });
  assert.equal(res.ok, false);
  assert.match(res.error, /unknown, not absent/);
  assert.match(res.error, /HTTP 500/);
});

test("a paged portfolio can prove holding but never absence", async () => {
  const { calls } = fakeIndexer();
  // The endpoint has never been observed paging; if it ever does, the body is a
  // PAGE and every "does not hold" verdict has to drop to unknown.
  calls.getAddressTokenBalances = async () => ({ items: [entry(A, 5)], next_page_params: { fiat_value: "1" } });
  const res = await walletTokenPositions(W_BOTH, { calls, tokens: [A, B] });

  assert.equal(res.complete, false);
  assert.equal(res.asked.find((a) => a.token === A).held, true);
  const b = res.asked.find((a) => a.token === B);
  assert.equal(b.held, null);
  assert.equal(res.unknownCount, 1);
  assert.match(b.reason, /proves nothing/);
  assert.match(res.reading, /could not be established/);
});

test("a wallet with no token balances at all is a measured empty portfolio", async () => {
  const { calls } = fakeIndexer();
  const res = await walletTokenPositions(addr("beef01"), { calls, tokens: [A] });
  assert.equal(res.ok, true);
  assert.equal(res.count, 0);
  assert.equal(res.complete, true);
  assert.equal(res.asked[0].held, false);
});

test("a value order that puts the unpriced last, and never at zero", async () => {
  const { calls } = fakeIndexer();
  calls.getAddressTokenBalances = async () => [
    entry(A, 1_000, { exchange_rate: null }),
    entry(B, 5, { exchange_rate: "2.5" }),
  ];
  const res = await walletTokenPositions(W_BOTH, { calls });

  // The priced row leads even though its balance is smaller; the unpriced row is
  // last WITHOUT being valued at $0.
  assert.deepEqual(res.positions.map((p) => p.token), [B, A]);
  assert.equal(res.positions[0].valueUsd, 12.5);
  assert.equal(res.positions[1].valueUsd, null);
  assert.equal(res.positions[1].valueDisplay, null);
  assert.equal(res.positions[1].priced, false);
});

test("junk in place of an address is refused with a sentence, not a crash", async () => {
  const { calls } = fakeIndexer();
  const wallet = await walletTokenPositions("not-an-address", { calls });
  assert.equal(wallet.ok, false);
  assert.match(wallet.error, /is not a wallet address/);

  const token = await coHoldings("PIPECAT", { calls });
  assert.equal(token.ok, false);
  assert.match(token.error, /is not a token contract address/);
});
