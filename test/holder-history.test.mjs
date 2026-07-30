// Tests for lib/holder-history.js — first acquisition for a token's top holders,
// and the two readings taken off one pass of it.
//
// THE SCENARIO BELOW IS THE MEASURED ONE, rebuilt offline. Against The Green Bull
// on chain 4663 the top ten "holders" contained the Uniswap pool, the burn address
// and the token contract itself; two addresses shared first-acquisition block
// 4052329 with two more within ~2,200 blocks; two histories came back as full
// 50-row pages (so their first acquisition is EARLIER than the page shows); and one
// address returned no transfers at all. Every one of those is a distinct way for a
// naive version of this module to state something false, so every one of them has
// a test here.
//
// The four claims these tests exist to pin down:
//   1. a truncated page is a LOWER BOUND and says so, in the figure and the prose;
//   2. an unread history is UNKNOWN — never a hold time of zero, never a fresh buy;
//   3. the pool, the burn address and the contract are labelled and kept OUT of the
//      holder statistics, while still appearing in the rows;
//   4. a tight cluster is reported as coordination and never as intent, and
//      scattered acquisitions are not reported as a cluster at all.
//
// Entirely offline: the indexer and the pool resolver are both injected, so nothing
// here touches the network. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUNDLE_LIMITS,
  HOLDER_ROLES,
  MAX_HOLDERS_PROBED,
  TRANSFER_PAGE_SIZE,
  ZERO_ADDRESS,
  analyzeHolderHistory,
  detectBundle,
  fundingSources,
  holdTimeSummary,
  holderFirstAcquisition,
} from "../lib/holder-history.js";

/* --------------------------------- fixtures ------------------------------- */

const DAY = 86_400_000;
const NOW = Date.parse("2026-07-29T00:00:00.000Z");

/** A distinct 20-byte address from a hex prefix, so every fixture reads as itself. */
const addr = (prefix) => `0x${prefix}${"0".repeat(40 - prefix.length)}`;

const TOKEN = addr("31be8f7485");
const POOL = addr("8f450b8ee3");
/**
 * The Uniswap v4 PoolManager singleton, as measured on chain 4663. It is here as a
 * fixture and never as a rule: lib/dex-price.js resolveV4PoolManager establishes the
 * identity by BEHAVIOUR, and these tests inject its verdict rather than the address.
 */
const V4_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const H_EARLY_A = addr("42607b2e4f");
const H_EARLY_B = addr("875813ae0a");
const H_EARLY_C = addr("71f2f1c2dc");
const H_LATE_A = addr("fc283d4db5");
const H_LATE_B = addr("c15d9678a1");
const H_TRUNCATED = addr("fa23da5065");
const H_SILENT = addr("a226c8cd4a");
const FUNDER = addr("f00dfeed");

/** An address's token-transfer page: `count` rows ending at `oldest`. */
function history({ oldestBlock, agoDays, count = 3, nextPage = false }) {
  const items = [];
  for (let i = 0; i < count; i += 1) {
    items.push({
      block_number: oldestBlock + i * 1_000,
      timestamp: new Date(NOW - agoDays * DAY + i * 60_000).toISOString(),
    });
  }
  // Newest first, the way the endpoint answers — the module must not depend on it.
  items.reverse();
  return { items, next_page_params: nextPage ? { block_number: oldestBlock } : null };
}

/** A full page: the shape that makes a hold time a lower bound. */
function fullHistory({ oldestBlock, agoDays }) {
  return history({ oldestBlock, agoDays, count: TRANSFER_PAGE_SIZE, nextPage: true });
}

/**
 * The measured top-ten, as flattened holder rows. The pool, the burn address and
 * the token itself are in it because they were in the real one.
 */
const TOP_HOLDERS = [
  { address: H_EARLY_A, percent: 12.5 },
  { address: POOL, percent: 20.1 },
  { address: ZERO_ADDRESS, percent: 9.4 },
  { address: H_LATE_A, percent: 5.2 },
  { address: TOKEN, percent: 4.1 },
  { address: H_LATE_B, percent: 3.3 },
  { address: H_EARLY_B, percent: 2.8 },
  { address: H_EARLY_C, percent: 2.2 },
  { address: H_TRUNCATED, percent: 1.9 },
  { address: H_SILENT, percent: 1.1 },
];

const MEASURED_HISTORY = {
  [H_EARLY_A]: history({ oldestBlock: 4_050_099, agoDays: 21.5, count: 6 }),
  [POOL]: fullHistory({ oldestBlock: 21_538_348, agoDays: 1.2 }),
  [ZERO_ADDRESS]: history({ oldestBlock: 4_052_329, agoDays: 21.5, count: 7 }),
  [H_LATE_A]: history({ oldestBlock: 9_142_261, agoDays: 15.6, count: 5 }),
  [TOKEN]: history({ oldestBlock: 4_175_794, agoDays: 21.4, count: 1 }),
  [H_LATE_B]: history({ oldestBlock: 7_979_829, agoDays: 17.0, count: 19 }),
  [H_EARLY_B]: history({ oldestBlock: 4_050_279, agoDays: 21.5, count: 17 }),
  [H_EARLY_C]: history({ oldestBlock: 4_052_329, agoDays: 21.5, count: 4 }),
  [H_TRUNCATED]: fullHistory({ oldestBlock: 7_853_322, agoDays: 17.1 }),
  [H_SILENT]: { items: [], next_page_params: null },
};

/**
 * A fake indexer. Every call is recorded, so the bound on how many holders get
 * probed is asserted rather than assumed.
 */
function fakeIndexer({ transfers = {}, holders = null, holdersFail = false, txs = {}, fail = new Set() } = {}) {
  const seen = { transfers: [], txs: [], holders: 0 };
  const calls = {
    async getTokenHolders() {
      seen.holders += 1;
      if (holdersFail) throw Object.assign(new Error("indexer down"), { status: 503 });
      return { items: holders ?? [] };
    },
    async getTokenTransfers(address, params) {
      seen.transfers.push({ address, params });
      if (fail.has(address)) throw Object.assign(new Error("indexer down"), { status: 503 });
      return transfers[address] ?? { items: [], next_page_params: null };
    },
    async getAddressTransactions(address, params) {
      seen.txs.push({ address, params });
      if (fail.has(address)) throw Object.assign(new Error("indexer down"), { status: 503 });
      return txs[address] ?? { items: [], next_page_params: null };
    },
  };
  return { calls, seen };
}

/** A pool resolver that names POOL, the way lib/dex-price.js resolvePool would. */
const poolFound = async () => ({ found: { pool: POOL }, pools: [{ pool: POOL }], reason: null, poolCount: 1 });
/** The chain answered: this token has no pool at all. */
const poolNone = async () => ({ found: null, pools: [], reason: "no_pool", poolCount: 0 });
/** Nobody could look. Not the same fact, and the module must not conflate them. */
const poolUnread = async () => ({ found: null, pools: [], reason: "discovery_failed", poolCount: 0 });

/**
 * The three v4 verdicts, in the shape lib/dex-price.js resolveV4PoolManager returns.
 *
 * "rejected" is the DEFAULT for the measured fixture, because that fixture is about a
 * v3 pool and a settled negative is what leaves `unavailable` empty. Unread is a
 * separate fact and gets its own tests: an unresolved check must caveat, never pass.
 */
const v4Rejected = async () => ({
  address: null,
  candidate: V4_MANAGER,
  status: "rejected",
  reason: "the address answers token0()/token1(), so it is not the v4 PoolManager singleton",
});
const v4Confirmed = async () => ({ address: V4_MANAGER, candidate: V4_MANAGER, status: "confirmed", reason: null });
const v4Unread = async () => ({
  address: null,
  candidate: V4_MANAGER,
  status: "unread",
  reason: "neither extsload(bytes32) nor protocolFeeController() answered",
});

function runMeasured(overrides = {}) {
  const { calls, seen } = fakeIndexer({ transfers: MEASURED_HISTORY, ...overrides.indexer });
  return holderFirstAcquisition(TOKEN, {
    holders: TOP_HOLDERS,
    calls,
    now: NOW,
    resolvePool: poolFound,
    resolveV4PoolManager: v4Rejected,
    ...overrides.options,
  }).then((analysis) => ({ analysis, seen }));
}

const rowFor = (analysis, address) => analysis.holders.find((h) => h.address === address);

/* ------------------------------- truncation ------------------------------- */

test("a full transfer page is a LOWER BOUND on hold time, and every surface says so", async () => {
  const { analysis } = await runMeasured();
  const row = rowFor(analysis, H_TRUNCATED);

  assert.equal(row.status, "measured");
  assert.equal(row.isLowerBound, true);
  assert.equal(row.holdDays, 17.1);
  // The qualifier is baked into the string, so a caller cannot quote the figure
  // without it. This is the whole reason holdDisplay exists.
  assert.equal(row.holdDisplay, "at least 17.1 days");
  assert.match(row.reason, /older transfers/i);
  assert.match(row.reason, /earlier/i);

  // And the bound propagates: every order statistic is monotone in its inputs, so
  // a median over a set containing a lower bound is itself a lower bound.
  const summary = holdTimeSummary(analysis);
  assert.equal(summary.lowerBounds, 1);
  assert.equal(summary.isLowerBound, true);
  assert.match(summary.medianDisplay, /^at least /);
  assert.match(summary.reading, /LOWER BOUND/);
  assert.match(summary.reading, /true median is at least this, never less/);
});

test("a next-page cursor alone makes a short page a lower bound", async () => {
  const short = history({ oldestBlock: 1_000_000, agoDays: 3, count: 4, nextPage: true });
  const { calls } = fakeIndexer({ transfers: { [H_LATE_A]: short } });
  const { holders } = await holderFirstAcquisition(TOKEN, {
    holders: [{ address: H_LATE_A, percent: 1 }],
    calls,
    now: NOW,
    resolvePool: poolNone,
  });
  assert.equal(holders[0].isLowerBound, true);
  assert.equal(holders[0].holdDisplay, "at least 3 days");
});

test("a short page with no cursor is EXACT, and is not hedged", async () => {
  const { analysis } = await runMeasured();
  const row = rowFor(analysis, H_LATE_A);
  assert.equal(row.isLowerBound, false);
  assert.equal(row.holdDisplay, "15.6 days");
  assert.equal(row.reason, null);
});

/* -------------------------------- unknowns -------------------------------- */

test("zero transfers returned is UNKNOWN, never a hold time of zero", async () => {
  const { analysis } = await runMeasured();
  const row = rowFor(analysis, H_SILENT);

  assert.equal(row.status, "unknown");
  assert.equal(row.firstBlock, null);
  assert.equal(row.firstTimestamp, null);
  // The three ways this could have been rendered as a fresh buy, all refused.
  assert.equal(row.holdDays, null);
  assert.equal(row.holdDisplay, null);
  assert.equal(row.isLowerBound, false);
  assert.match(row.reason, /unread history, not a new buyer/);

  const summary = holdTimeSummary(analysis);
  assert.equal(summary.unknown, 1);
  assert.deepEqual(summary.unknownRows.map((r) => r.address), [H_SILENT]);
  assert.match(summary.reading, /Unknown is not zero days/);
});

test("a probe the indexer refused stays unknown and never becomes a fresh buy", async () => {
  const { analysis } = await runMeasured({ indexer: { fail: new Set([H_EARLY_A]) } });
  const row = rowFor(analysis, H_EARLY_A);

  assert.equal(row.status, "unknown");
  assert.equal(row.holdDays, null);
  assert.equal(row.firstBlock, null);
  assert.match(row.reason, /HTTP 503/);
  assert.match(row.reason, /not recent, and not none/);

  // An outage must not shrink the cluster into existence either: the failed
  // address is simply not eligible, and the count of eligible rows says so.
  const bundle = detectBundle(analysis);
  assert.ok(!bundle.cluster.some((c) => c.address === H_EARLY_A));
  assert.ok(bundle.ineligible.some((i) => i.address === H_EARLY_A));
});

test("rows that carry no block number are unknown rather than guessed at", async () => {
  const { calls } = fakeIndexer({
    transfers: { [H_LATE_A]: { items: [{ timestamp: new Date(NOW).toISOString() }], next_page_params: null } },
  });
  const { holders } = await holderFirstAcquisition(TOKEN, {
    holders: [{ address: H_LATE_A, percent: 1 }],
    calls,
    now: NOW,
    resolvePool: poolNone,
  });
  assert.equal(holders[0].status, "unknown");
  assert.match(holders[0].reason, /none carried a block number/);
});

/* --------------------------------- roles ---------------------------------- */

test("the pool, the burn address and the contract are labelled, kept, and excluded", async () => {
  const { analysis } = await runMeasured();

  assert.equal(rowFor(analysis, POOL).role, HOLDER_ROLES.POOL);
  assert.equal(rowFor(analysis, ZERO_ADDRESS).role, HOLDER_ROLES.BURN);
  assert.equal(rowFor(analysis, TOKEN).role, HOLDER_ROLES.CONTRACT);
  assert.equal(rowFor(analysis, H_EARLY_A).role, HOLDER_ROLES.HOLDER);
  assert.match(rowFor(analysis, POOL).roleReason, /liquidity, not a position/);

  // KEPT, not dropped — the rows still reconcile against the explorer's top ten,
  // and each non-holder carries its own first activity.
  assert.equal(analysis.holders.length, TOP_HOLDERS.length);
  assert.equal(rowFor(analysis, POOL).holdDisplay, "at least 1.2 days");

  const summary = holdTimeSummary(analysis);
  assert.equal(summary.excludedCount, 3);
  assert.deepEqual(
    summary.excluded.map((e) => e.role).sort(),
    [HOLDER_ROLES.BURN, HOLDER_ROLES.CONTRACT, HOLDER_ROLES.POOL],
  );
  // The pool's 1.2 days is the shortest figure in the table and would have dragged
  // the middle of the distribution to something no holder experienced.
  assert.equal(summary.holders, 7);
  assert.equal(summary.measured, 6);
  assert.ok(summary.minDays > 1.2, "the pool must not be the minimum hold time");
  assert.match(summary.reading, /the Uniswap pool — liquidity, not conviction/);
  assert.match(summary.reading, /the burn address/);
  assert.match(summary.reading, /the token contract itself/);
});

test("the median is taken over real holders alone, and the arithmetic is checked", async () => {
  const { analysis } = await runMeasured();
  const summary = holdTimeSummary(analysis);
  // 15.6, 17.0, 17.1, 21.5, 21.5, 21.5 -> the two middle values are 17.1 and 21.5.
  assert.equal(summary.medianDays, 19.3);
  assert.equal(summary.minDays, 15.6);
  assert.equal(summary.maxDays, 21.5);
  assert.equal(summary.exact, 5);
  assert.equal(summary.lowerBounds, 1);
  assert.equal(summary.rangeDisplay, "15.6 days to 21.5 days");
});

test("a pool that could not be identified is a stated caveat, not a silent pass", async () => {
  const { analysis } = await runMeasured({ options: { resolvePool: poolUnread } });

  assert.equal(analysis.poolStatus, "unread");
  assert.ok(analysis.unavailable.includes("pool_identification"));
  // Unlabelled, because nothing established what it is — and the summary says the
  // figures may therefore contain a pool rather than quietly implying they do not.
  assert.equal(rowFor(analysis, POOL).role, HOLDER_ROLES.HOLDER);
  const summary = holdTimeSummary(analysis);
  assert.match(summary.poolCaveat, /may in fact be the pool/);
  assert.match(summary.reading, /provisional/);
});

test("a chain that answered \"no pool\" carries no caveat", async () => {
  const { analysis } = await runMeasured({ options: { resolvePool: poolNone } });
  assert.equal(analysis.poolStatus, "none");
  assert.equal(analysis.unavailable.length, 0);
  assert.equal(holdTimeSummary(analysis).poolCaveat, null);
});

/* --------------------------- the v4 PoolManager --------------------------- */

test("the Uniswap v4 PoolManager is labelled a pool, not a holder, and kept out of the figures", async () => {
  // THE REPRODUCED COMPLAINT, one layer down from where it was seen: this address has
  // no token0(), so no factory sweep can ever put it in `pools`, and it held 50.5% of
  // PIPECAT's supply while being presented as the most interesting wallet in an overlap.
  const { analysis } = await runMeasured({
    options: {
      holders: [{ address: V4_MANAGER, percent: 50.5 }, ...TOP_HOLDERS],
      resolveV4PoolManager: v4Confirmed,
    },
    indexer: { transfers: { ...MEASURED_HISTORY, [V4_MANAGER]: history({ oldestBlock: 21_538_348, agoDays: 1.2 }) } },
  });

  const row = rowFor(analysis, V4_MANAGER);
  assert.equal(row.role, HOLDER_ROLES.POOL);
  assert.equal(row.poolVersion, "v4");
  assert.match(row.roleReason, /Uniswap v4 PoolManager/);
  assert.match(row.roleReason, /pooled liquidity rather than a position/);
  assert.equal(analysis.v4PoolManager, V4_MANAGER);
  assert.equal(analysis.v4Status, "confirmed");
  // And a confirmed check is not a gap: nothing goes in `unavailable` for it.
  assert.ok(!analysis.unavailable.includes("v4_pool_identification"));

  const summary = holdTimeSummary(analysis);
  // It is EXCLUDED from the statistics and still LISTED, the same treatment the v3
  // pool gets — its 1.2 days is liquidity's age and would be the minimum otherwise.
  assert.ok(summary.excluded.some((e) => e.address === V4_MANAGER && e.poolVersion === "v4"));
  assert.ok(summary.minDays > 1.2, "the v4 manager must not set the minimum hold time");
  assert.match(summary.reading, /the Uniswap v4 PoolManager — pooled liquidity, not conviction/);
  // Named as the singleton and NOT as "the Uniswap pool", which would imply this
  // token's own pool rather than the one contract that holds every pool on the chain.
  assert.equal(summary.v4Caveat, null);
});

test("a v4 check that did not settle is a stated caveat, never a silent holder", async () => {
  const { analysis } = await runMeasured({
    options: {
      holders: [{ address: V4_MANAGER, percent: 50.5 }, ...TOP_HOLDERS],
      resolveV4PoolManager: v4Unread,
    },
    indexer: { transfers: { ...MEASURED_HISTORY, [V4_MANAGER]: history({ oldestBlock: 21_538_348, agoDays: 1.2 }) } },
  });

  assert.equal(analysis.v4Status, "unread");
  assert.ok(analysis.unavailable.includes("v4_pool_identification"));
  // Unlabelled, because nothing established what it is — and the summary says so
  // rather than quietly implying every row below is somebody's position.
  assert.equal(rowFor(analysis, V4_MANAGER).role, HOLDER_ROLES.HOLDER);
  const summary = holdTimeSummary(analysis);
  assert.match(summary.v4Caveat, /was not established/);
  assert.match(summary.reading, /v4 keeps every pool in one contract/);
});

test("the v3 sweep and the v4 check are separate verdicts and are reported separately", async () => {
  const { analysis } = await runMeasured({
    options: { resolvePool: poolUnread, resolveV4PoolManager: v4Confirmed },
  });
  assert.equal(analysis.poolStatus, "unread");
  assert.equal(analysis.v4Status, "confirmed");
  assert.ok(analysis.unavailable.includes("pool_identification"));
  assert.ok(!analysis.unavailable.includes("v4_pool_identification"));
  // With the v3 sweep already caveating every unlabelled row, the v4 clause is not
  // repeated — one gap, one sentence.
  assert.equal(holdTimeSummary(analysis).v4Caveat, null);
});

test("a pool sweep that declined to pick a winner still labels its candidates", async () => {
  // lib/dex-price.js returns found:null with the candidates intact when the
  // selection is unsettled. Identifying a pool is a weaker question than pricing
  // through one, so the addresses are still usable here.
  const inconclusive = async () => ({ found: null, pools: [{ pool: POOL }], reason: "depth_inconclusive", poolCount: 1 });
  const { analysis } = await runMeasured({ options: { resolvePool: inconclusive } });
  assert.equal(analysis.poolStatus, "resolved");
  assert.equal(rowFor(analysis, POOL).role, HOLDER_ROLES.POOL);
});

/* ---------------------------- bundle detection ---------------------------- */

test("a tight launch cluster is detected, sized, and framed as coordination only", async () => {
  const { analysis } = await runMeasured();
  const bundle = detectBundle(analysis);

  assert.equal(bundle.found, true);
  assert.equal(bundle.kind, "launch");
  assert.deepEqual(
    bundle.cluster.map((c) => c.address).sort(),
    [H_EARLY_A, H_EARLY_B, H_EARLY_C].sort(),
  );
  assert.equal(bundle.firstBlock, 4_050_099);
  assert.equal(bundle.lastBlock, 4_052_329);
  assert.equal(bundle.blockSpan, 2_230);
  assert.equal(bundle.covers.addresses, 3);
  // Five real holders were pinned exactly; the truncated and the silent ones were
  // not, and the reader is owed that denominator.
  assert.equal(bundle.covers.ofEligible, 5);
  assert.equal(bundle.covers.ofHolders, 7);
  assert.equal(bundle.supply.percent, 17.5);
  assert.equal(bundle.supply.complete, true);

  assert.match(bundle.reading, /EVIDENCE OF COORDINATION, not proof of intent/);
  assert.match(bundle.reading, /airdrop/);
  assert.match(bundle.reading, /migration/);
  assert.match(bundle.reading, /consistent with a cluster at launch/);
  // Only the top holders were probed, and the sentence must not imply otherwise.
  assert.match(bundle.reading, /an earlier buyer outside that set would not appear/);
});

test("truncated first acquisitions are ineligible for clustering, with the reason", async () => {
  const { analysis } = await runMeasured();
  const bundle = detectBundle(analysis);
  const truncated = bundle.ineligible.find((i) => i.address === H_TRUNCATED);
  assert.ok(truncated, "the truncated holder must be reported, not dropped");
  assert.match(truncated.reason, /no later than the block read/);
  assert.match(bundle.reading, /evidence neither for nor against/);
});

test("two truncated rows sharing a page boundary are not a cluster", async () => {
  // The failure this rule prevents: a truncated page gives an UPPER bound on the
  // first block, so busy addresses converge on the same observed block for reasons
  // that have nothing to do with when they bought.
  const busy = {};
  const holders = [];
  for (let i = 0; i < 4; i += 1) {
    const a = addr(`bee${i}`);
    holders.push({ address: a, percent: 10 });
    busy[a] = fullHistory({ oldestBlock: 21_000_000, agoDays: 1 });
  }
  const { calls } = fakeIndexer({ transfers: busy });
  const analysis = await holderFirstAcquisition(TOKEN, { holders, calls, now: NOW, resolvePool: poolNone });
  const bundle = detectBundle(analysis);
  assert.equal(bundle.found, false);
  assert.equal(bundle.eligible, 0);
  assert.match(bundle.reading, /it is a finding that we could not tell/);
});

test("scattered first acquisitions are NOT reported as a bundle", async () => {
  const spread = {};
  const holders = [];
  const blocks = [1_000_000, 5_000_000, 9_000_000, 13_000_000, 17_000_000];
  blocks.forEach((block, i) => {
    const a = addr(`cafe${i}`);
    holders.push({ address: a, percent: 4 });
    spread[a] = history({ oldestBlock: block, agoDays: 20 - i * 3, count: 3 });
  });
  const { calls } = fakeIndexer({ transfers: spread });
  const analysis = await holderFirstAcquisition(TOKEN, { holders, calls, now: NOW, resolvePool: poolNone });
  const bundle = detectBundle(analysis);

  assert.equal(bundle.found, false);
  assert.equal(bundle.kind, null);
  assert.deepEqual(bundle.cluster, []);
  assert.equal(bundle.eligible, 5);
  assert.equal(bundle.tightest, 1);
  assert.match(bundle.reading, /No bundle/);
  assert.match(bundle.reading, /bought at separate times/);
});

test("a cluster with something already holding before it is a LATER buy, not a launch", async () => {
  // A truncated row is useful in exactly one direction: its observed block is no
  // earlier than its true first acquisition, so a truncated row seen BEFORE the
  // cluster proves activity predating it.
  const early = { ...MEASURED_HISTORY, [H_TRUNCATED]: fullHistory({ oldestBlock: 3_000_000, agoDays: 25 }) };
  const { calls } = fakeIndexer({ transfers: early });
  const analysis = await holderFirstAcquisition(TOKEN, {
    holders: TOP_HOLDERS,
    calls,
    now: NOW,
    resolvePool: poolFound,
  });
  const bundle = detectBundle(analysis);
  assert.equal(bundle.found, true);
  assert.equal(bundle.kind, "later");
  assert.equal(bundle.basis, "probed");
  assert.match(bundle.reading, /coordinated buy AFTER launch/);
});

test("a caller that knows the token's first block settles launch-versus-later outright", async () => {
  const { analysis } = await runMeasured();
  const launch = detectBundle(analysis, { tokenFirstBlock: 4_050_099 });
  assert.equal(launch.kind, "launch");
  assert.equal(launch.basis, "token_first_block");
  assert.match(launch.reading, /the token's own earliest activity/);

  const later = detectBundle(analysis, { tokenFirstBlock: 1_000_000 });
  assert.equal(later.kind, "later");
  assert.equal(later.basis, "token_first_block");
});

test("the cluster window and the minimum size are the knobs, and they bind", async () => {
  const { analysis } = await runMeasured();
  // One block of tolerance splits the measured cluster apart.
  assert.equal(detectBundle(analysis, { windowBlocks: 100 }).found, false);
  // And a stricter minimum refuses a cluster it would otherwise have named.
  assert.equal(detectBundle(analysis, { minCluster: 4 }).found, false);
  assert.equal(BUNDLE_LIMITS.MIN_CLUSTER, 3);
});

test("an unknown supply share is not summed as zero", async () => {
  const holders = TOP_HOLDERS.map((h) => (h.address === H_EARLY_B ? { address: h.address } : h));
  const { calls } = fakeIndexer({ transfers: MEASURED_HISTORY });
  const analysis = await holderFirstAcquisition(TOKEN, { holders, calls, now: NOW, resolvePool: poolFound });
  const bundle = detectBundle(analysis);
  assert.equal(bundle.supply.counted, 2);
  assert.equal(bundle.supply.of, 3);
  assert.equal(bundle.supply.complete, false);
  assert.equal(bundle.supply.percent, 14.7);
  assert.match(bundle.reading, /NOT counted as zero, so the real total is higher/);
});

/* ------------------------------ cost and bounds --------------------------- */

test("the probe is bounded at MAX_HOLDERS_PROBED however long the list is", async () => {
  const many = [];
  const transfers = {};
  for (let i = 0; i < 40; i += 1) {
    const a = addr(`d${i.toString(16)}dd`);
    many.push({ address: a, percent: 1 });
    transfers[a] = history({ oldestBlock: 1_000_000 + i * 100_000, agoDays: 5 });
  }
  const { calls, seen } = fakeIndexer({ transfers });
  const analysis = await holderFirstAcquisition(TOKEN, { holders: many, calls, now: NOW, resolvePool: poolNone });
  assert.equal(seen.transfers.length, MAX_HOLDERS_PROBED);
  assert.equal(analysis.holders.length, MAX_HOLDERS_PROBED);
  // One call per holder, each scoped to this token — the cheap path.
  assert.deepEqual(seen.transfers[0].params, { token: TOKEN });
});

test("`limit` narrows the probe and the rows stay in balance order", async () => {
  const { calls, seen } = fakeIndexer({ transfers: MEASURED_HISTORY });
  const analysis = await holderFirstAcquisition(TOKEN, {
    holders: TOP_HOLDERS,
    calls,
    now: NOW,
    limit: 3,
    resolvePool: poolFound,
  });
  assert.equal(seen.transfers.length, 3);
  assert.deepEqual(analysis.holders.map((h) => h.address), [H_EARLY_A, POOL, ZERO_ADDRESS]);
  assert.deepEqual(analysis.holders.map((h) => h.rank), [1, 2, 3]);
});

test("a holder list that was handed over is not fetched again", async () => {
  const { seen } = await runMeasured();
  assert.equal(seen.holders, 0);
});

test("a holder list the indexer would not serve is an outage, not an empty token", async () => {
  const { calls } = fakeIndexer({ holdersFail: true });
  const analysis = await holderFirstAcquisition(TOKEN, { calls, now: NOW, resolvePool: poolNone });
  assert.equal(analysis.ok, false);
  assert.match(analysis.error, /unknown, not empty/);
  assert.ok(analysis.unavailable.includes("holders"));
});

test("a token address that is not one is a caller error, not an outage", async () => {
  const analysis = await holderFirstAcquisition("nvda", { calls: fakeIndexer().calls });
  assert.equal(analysis.ok, false);
  assert.match(analysis.error, /not a token contract address/);
});

test("block numbers arriving as strings are read, not discarded", async () => {
  const asStrings = {
    items: [{ block_number: "4050099", timestamp: new Date(NOW - 2 * DAY).toISOString() }],
    next_page_params: null,
  };
  const { calls } = fakeIndexer({ transfers: { [H_EARLY_A]: asStrings } });
  const { holders } = await holderFirstAcquisition(TOKEN, {
    holders: [{ address: H_EARLY_A, percent: 1 }],
    calls,
    now: NOW,
    resolvePool: poolNone,
  });
  assert.equal(holders[0].firstBlock, 4_050_099);
  assert.equal(holders[0].holdDays, 2);
});

/* --------------------------- funding attribution -------------------------- */

/** A native transaction list for an address, oldest inbound transfer included. */
function inbound(to, rows, { nextPage = false } = {}) {
  return {
    items: rows.map((r) => ({
      block_number: r.block,
      from: { hash: r.from },
      to: { hash: to },
    })),
    next_page_params: nextPage ? { block_number: 1 } : null,
  };
}

test("a common funder behind the cluster is reported, and framed as plumbing", async () => {
  const cluster = [
    { address: H_EARLY_A, firstBlock: 4_050_099 },
    { address: H_EARLY_B, firstBlock: 4_050_279 },
    { address: H_EARLY_C, firstBlock: 4_052_329 },
  ];
  const { calls } = fakeIndexer({
    txs: {
      [H_EARLY_A]: inbound(H_EARLY_A, [{ block: 4_050_000, from: FUNDER }]),
      [H_EARLY_B]: inbound(H_EARLY_B, [{ block: 4_050_010, from: FUNDER }]),
      [H_EARLY_C]: inbound(H_EARLY_C, [{ block: 4_050_020, from: FUNDER }]),
    },
  });
  const funding = await fundingSources(cluster, { calls });

  assert.equal(funding.ran, true);
  assert.equal(funding.commonFunder, FUNDER);
  assert.equal(funding.covered, 3);
  assert.equal(funding.established, true);
  assert.match(funding.reading, /received their first funds from the same address/);
  assert.match(funding.reading, /still not proof of intent/);
  assert.match(funding.reading, /exchanges, bridges and airdrop distributors/);
});

test("funding that arrived AFTER the buy is not funding for it", async () => {
  const cluster = [{ address: H_EARLY_A, firstBlock: 4_050_099 }];
  const { calls } = fakeIndexer({
    txs: { [H_EARLY_A]: inbound(H_EARLY_A, [{ block: 9_000_000, from: FUNDER }]) },
  });
  const funding = await fundingSources(cluster, { calls });
  assert.equal(funding.commonFunder, null);
  assert.equal(funding.funders[0].funder, null);
});

test("a full transaction page cannot establish the FIRST funder", async () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ block: 4_000_000 + i, from: FUNDER }));
  const cluster = [
    { address: H_EARLY_A, firstBlock: 4_050_099 },
    { address: H_EARLY_B, firstBlock: 4_050_279 },
  ];
  const { calls } = fakeIndexer({
    txs: {
      [H_EARLY_A]: inbound(H_EARLY_A, rows, { nextPage: true }),
      [H_EARLY_B]: inbound(H_EARLY_B, rows, { nextPage: true }),
    },
  });
  const funding = await fundingSources(cluster, { calls });
  assert.equal(funding.commonFunder, FUNDER);
  assert.equal(funding.established, false);
  assert.match(funding.reading, /earliest funder READ rather than one established as the first/);
});

test("no shared funder is a weak negative and says so", async () => {
  const cluster = [
    { address: H_EARLY_A, firstBlock: 4_050_099 },
    { address: H_EARLY_B, firstBlock: 4_050_279 },
  ];
  const { calls } = fakeIndexer({
    txs: {
      [H_EARLY_A]: inbound(H_EARLY_A, [{ block: 4_000_000, from: FUNDER }]),
      [H_EARLY_B]: inbound(H_EARLY_B, [{ block: 4_000_001, from: addr("beef") }]),
    },
  });
  const funding = await fundingSources(cluster, { calls });
  assert.equal(funding.commonFunder, null);
  assert.match(funding.reading, /weak negative, not a clearing/);
});

test("a skipped funding check reads as skipped, never as no common funder", async () => {
  const funding = await fundingSources([], { calls: fakeIndexer().calls });
  assert.equal(funding.ran, false);
  assert.equal(funding.commonFunder, null);
  assert.match(funding.reading, /not a finding that the addresses were funded separately/);
});

/* ------------------------------- one call --------------------------------- */

test("analyzeHolderHistory serves both readings from one pass, and funds only a cluster", async () => {
  const { calls, seen } = fakeIndexer({
    transfers: MEASURED_HISTORY,
    txs: {
      [H_EARLY_A]: inbound(H_EARLY_A, [{ block: 4_050_000, from: FUNDER }]),
      [H_EARLY_B]: inbound(H_EARLY_B, [{ block: 4_050_010, from: FUNDER }]),
      [H_EARLY_C]: inbound(H_EARLY_C, [{ block: 4_050_020, from: FUNDER }]),
    },
  });
  const out = await analyzeHolderHistory(TOKEN, {
    holders: TOP_HOLDERS,
    calls,
    now: NOW,
    resolvePool: poolFound,
    funding: true,
  });

  assert.equal(out.ok, true);
  assert.equal(out.holdTime.medianDays, 19.3);
  assert.equal(out.bundle.kind, "launch");
  assert.equal(out.funding.commonFunder, FUNDER);
  // ONE pass of transfer probes served both readings: ten holders, ten calls.
  assert.equal(seen.transfers.length, 10);
  assert.equal(seen.txs.length, 3);
});

test("no cluster means no funding calls are paid for", async () => {
  const spread = {};
  const holders = [];
  [1_000_000, 5_000_000, 9_000_000].forEach((block, i) => {
    const a = addr(`ace${i}`);
    holders.push({ address: a, percent: 4 });
    spread[a] = history({ oldestBlock: block, agoDays: 10 });
  });
  const { calls, seen } = fakeIndexer({ transfers: spread });
  const out = await analyzeHolderHistory(TOKEN, {
    holders,
    calls,
    now: NOW,
    resolvePool: poolNone,
    funding: true,
  });
  assert.equal(out.bundle.found, false);
  assert.equal(out.funding, null);
  assert.equal(seen.txs.length, 0);
});

/* ------------------------------- the hard rule ---------------------------- */

test("no reading this module can produce calls anything a scam", async () => {
  const { analysis } = await runMeasured();
  const readings = [
    holdTimeSummary(analysis).reading,
    detectBundle(analysis).reading,
    detectBundle(analysis, { windowBlocks: 10 }).reading,
    (await fundingSources(detectBundle(analysis).cluster, { calls: fakeIndexer().calls })).reading,
    ...analysis.holders.map((h) => h.reason).filter(Boolean),
  ];
  for (const reading of readings) {
    assert.doesNotMatch(reading, /\bscam|\brug\b|\bfraud/i, reading);
  }
});
