// Tests for the two cross-token lookups — holder_overlap and co_holdings — as the
// model and the reader actually meet them: the tool catalogue (lib/ask-tools.js), the
// evidence assembly (lib/token-evidence.js) and the prompt rules that govern how the
// figures may be quoted (lib/ask-runner.js).
//
// THE DEFECT BEING FIXED IS NOT A MISSING FEATURE. A real user on chainmind.fun asked
// "what wallet in this coin 0x31ba…c6cc also bought this: 0xa15c…7b32". There was no
// lookup for a relation between two tokens, so the model ran lookup_token on the FIRST
// address, printed its holders and never mentioned the second token — an easier
// question answered in place of the one asked, with nothing said about the swap. The
// user caught it in one line by naming a wallet that holds both.
//
// lib/cross-token.js has its own 34 tests for the measuring. What is defended HERE is
// everything that stands between that measurement and the reader:
//
//  1. THE CAPABILITY IS REACHABLE FROM THE MESSY REAL PHRASING. The pair arrives as an
//     array, as one string, or under two separate keys, and all three have to become
//     the same two-entry list — in the user's order, because the answer's order is the
//     question's order.
//  2. A RELATION WITH ONE SIDE MISSING IS REFUSED, AND THE REFUSAL NAMES THE
//     ALTERNATIVE. Answering a one-token "overlap" as a holder list would reintroduce
//     the original bug inside its own fix.
//  3. A BOUNDED COUNT REACHES THE READER AS "AT LEAST N". The quotable figure is a
//     STRING with the qualifier inside it, the raw count sits under a name no answer
//     would print, and the bound is in the table's title and note as well as the data.
//  4. EVERY TOKEN ASKED ABOUT IS IN THE ANSWER. The table carries a column pair per
//     token, so a wallet's position in the SECOND token is on the same row — a table
//     with only the first token's balances would be the original bug drawn as a grid.
//  5. A POOL, A BURN SINK AND A TOKEN CONTRACT ARE NOT WALLETS WITH A POSITION, and a
//     failed read is unknown rather than a wallet that does not hold.
//  6. THE PROMPT FORBIDS SILENT NARROWING. The rule, not the tool, is what stops the
//     next question with two subjects from being answered about one.
//
// Fully offline: every indexer call and the pool resolver are injected, so nothing in
// this file can reach Blockscout or an RPC.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_NAMES,
  TOOL_SCHEMAS,
  coerceCoHoldingArgs,
  coerceOverlapTokens,
  dispatchTool,
  toolSubject,
} from "../lib/ask-tools.js";
import { MAX_OVERLAP_ROWS, coHoldingsReport, holderOverlapReport } from "../lib/token-evidence.js";
import { MAX_EVIDENCE_CHARS } from "../lib/ask-loop.js";
import { MAX_TOKENS, OVERLAP_STRATEGIES } from "../lib/cross-token.js";
import { runWithBudget } from "../lib/request-budget.js";
import { ZERO_ADDRESS } from "../lib/holder-history.js";
import { PHRASE_STEPS, progressLabel, stepForTool } from "../lib/thinking-phrases.js";
import { SYSTEM_PROMPT } from "../lib/ask-runner.js";
import { isTable } from "../lib/table-shape.js";

/* --------------------------------- fixtures ------------------------------- */

/** The measured pair on chain 4663, and the addresses the user named. */
const A = "0x31ba1d706d9e6a4f183651d0f3631b6cfb2ac6cc"; // PIPECAT
const B = "0xa15cd06dd305269a0f48bebeb30aa3588fba7b32"; // Merrymen by Virtuals
const W_BOTH = "0x80fd2f3ed890db7e48cd3b007d8943f2bcc7bcbd";
/**
 * The address the measured session put at the head of the table as "PIPECAT's #1
 * holder", holding 52.4% of its supply.
 *
 * IT IS THE UNISWAP V4 POOLMANAGER, established later and by behaviour — 24,009 bytes,
 * extsload(bytes32), protocolFeeController(), no token0(). It is left here under this
 * name because the fixtures below supply a v4 verdict EXPLICITLY, which is the honest
 * reproduction of both worlds: with the check rejected or unread it is a large holder
 * carrying a caveat, and with the check confirmed it is a pool and leaves the count.
 * The test at the bottom of this file is that second case.
 */
const W_WHALE = "0x8366a39cc670b4001a1121b8f6a443a643e40951"; // the v4 PoolManager
const W_A_ONLY = "0x00000000000000000000000000000000000000a1";
const W_UNREADABLE = "0x00000000000000000000000000000000000000f1";
/** A wallet holding ONE base unit of each — a real position that rounds to 0.00%. */
const W_DUST = "0x00000000000000000000000000000000000000d1";
const POOL = "0x0000000000000000000000000000000000009911";

/** 9.5478e26 and 1e27 — the measured supplies. */
const SUPPLY_A = (954_780_000n * 10n ** 18n).toString();
const SUPPLY_B = (1_000_000_000n * 10n ** 18n).toString();

/** Whole tokens as 18-decimal base units. */
const bal = (n) => (BigInt(n) * 10n ** 18n).toString();

const BODIES = {
  [A]: { symbol: "PIPECAT", name: "PIPECAT", type: "ERC-20", decimals: "18", total_supply: SUPPLY_A, holders: "150" },
  [B]: {
    symbol: "MERRYMEN",
    name: "Merrymen by Virtuals",
    type: "ERC-20",
    decimals: "18",
    total_supply: SUPPLY_B,
    holders: "473",
  },
};

const holder = (address, amount) => ({ address: { hash: address }, value: bal(amount) });
/** A holder row carrying a raw base-unit value, for the dust case. */
const rawHolder = (address, raw) => ({ address: { hash: address }, value: String(raw) });
const entry = (token, amount) => ({
  token: { address_hash: token, symbol: BODIES[token]?.symbol ?? null, name: BODIES[token]?.name ?? null, decimals: "18" },
  value: bal(amount),
});

/** One page each: PIPECAT with the pool, the burn sink and its own contract in it. */
const PAGES = {
  [A]: [[holder(W_WHALE, 500_000_000), holder(W_BOTH, 32_099_881), holder(W_A_ONLY, 1_000), holder(POOL, 90_000_000), holder(ZERO_ADDRESS, 5_000_000), holder(A, 1_000_000), holder(W_UNREADABLE, 500), rawHolder(W_DUST, 1)]],
  [B]: [[holder(W_WHALE, 50_000_000), holder(W_BOTH, 14_454_873), holder(POOL, 80_000_000), holder(ZERO_ADDRESS, 4_000_000), holder(A, 900_000), holder(W_UNREADABLE, 7), rawHolder(W_DUST, 1)]],
};

const PORTFOLIOS = {
  [W_WHALE]: [entry(A, 500_000_000), entry(B, 50_000_000)],
  [W_BOTH]: [entry(A, 32_099_881), entry(B, 14_454_873)],
  [W_A_ONLY]: [entry(A, 1_000)],
  [POOL]: [entry(A, 90_000_000), entry(B, 80_000_000)],
  [ZERO_ADDRESS]: [entry(A, 5_000_000), entry(B, 4_000_000)],
  [A]: [entry(A, 1_000_000), entry(B, 900_000)],
};

/**
 * The indexer stand-in. Anything a lookup reaches for that this fixture did not
 * script rejects loudly, so a call that escaped to the network fails the test rather
 * than passing it slowly.
 *
 * `pageCap` truncates a token's walk by handing back a cursor forever, which is how a
 * list too long to read is reproduced without inventing ten thousand rows.
 */
function chain({ pages = PAGES, portfolios = PORTFOLIOS, bodies = BODIES, portfolioFails = new Set(), pageCap = null } = {}) {
  const boom = (name) => () => Promise.reject(new Error(`unscripted call: ${name}`));
  const seen = { holders: [], portfolios: [] };
  return {
    seen,
    calls: {
      getAddress: boom("getAddress"),
      getTokenActivity: boom("getTokenActivity"),
      getTokenCounters: boom("getTokenCounters"),
      getTransaction: boom("getTransaction"),
      searchChain: boom("searchChain"),
      getTokenTransfers: boom("getTokenTransfers"),
      getAddressTransactions: boom("getAddressTransactions"),
      listStockTokens: () => Promise.resolve([]),
      resolveSymbol: () => Promise.resolve({ ok: false, match: null }),
      snapshotMatch: () => null,
      verifiedByIssuer: () => Promise.resolve(false),
      getToken(address) {
        const body = bodies[String(address).toLowerCase()];
        return body ? Promise.resolve(body) : Promise.reject(Object.assign(new Error("not found"), { status: 404 }));
      },
      getTokenHolders(address, params = {}) {
        const token = String(address).toLowerCase();
        seen.holders.push({ token, params });
        const list = pages[token] ?? [];
        const index = Number(params?.page ?? 0);
        const items = list[index] ?? [];
        // A cursor that never ends: the walk stops on the page cap, which is what
        // makes the answer a labelled lower bound instead of a complete set.
        const more = pageCap === token || index + 1 < list.length;
        return Promise.resolve({ items, ...(more ? { next_page_params: { page: index + 1 } } : {}) });
      },
      getAddressTokenBalances(address) {
        const self = String(address).toLowerCase();
        seen.portfolios.push(self);
        if (portfolioFails.has(self)) return Promise.reject(Object.assign(new Error("boom"), { status: 500 }));
        return Promise.resolve(portfolios[self] ?? []);
      },
    },
  };
}

/** The pool sweep's seam — the RPC leg, answered without an RPC. */
const poolsFound = () => Promise.resolve({ found: { pool: POOL }, pools: [{ pool: POOL }], reason: null });
const poolsUnread = () => Promise.resolve(null);

/**
 * The v4 singleton check's seam. INJECTED EXPLICITLY rather than left to the real
 * resolver: with no RPC client that one returns "unread", and a fixture whose verdict
 * depends on the absence of a client is a fixture that changes meaning the day somebody
 * passes one. "rejected" is the default here — a settled negative — so these tests keep
 * measuring what they were written to measure.
 */
const v4Rejected = () =>
  Promise.resolve({ address: null, candidate: W_WHALE, status: "rejected", reason: "it answers token0()" });
const v4Confirmed = () => Promise.resolve({ address: W_WHALE, candidate: W_WHALE, status: "confirmed", reason: null });

/** The options every call here shares: injected indexer, no RPC client, fake pools. */
const wired = (fixture, extra = {}) => ({
  calls: fixture.calls,
  client: null,
  resolvePool: poolsFound,
  resolveV4PoolManager: v4Rejected,
  ...extra,
});

const byName = (name) => TOOL_SCHEMAS.find((s) => s.function.name === name);
const paramsOf = (name) => byName(name).function.parameters;
const descOf = (name) => byName(name).function.description;

/* ------------------------------ the catalogue ------------------------------ */

test("both cross-token tools are in the catalogue the model is sent", () => {
  for (const name of ["holder_overlap", "co_holdings"]) {
    assert.ok(TOOL_NAMES.includes(name), `${name} missing from TOOL_NAMES`);
    assert.ok(byName(name), `${name} missing from TOOL_SCHEMAS`);
  }
});

test("holder_overlap takes an ARRAY of 2 to MAX_TOKENS targets", () => {
  const props = paramsOf("holder_overlap").properties;
  assert.equal(props.tokens.type, "array");
  assert.equal(props.tokens.minItems, 2);
  assert.equal(props.tokens.maxItems, MAX_TOKENS);
  assert.deepEqual(paramsOf("holder_overlap").required, ["tokens"]);
});

test("holder_overlap's description carries the messy phrasings that broke it", () => {
  const d = descOf("holder_overlap").toLowerCase();
  // The measured question, and the shapes of it people actually type. The
  // description IS the router: if these are absent the model has no reason to pick
  // this tool over the single-token one, which is the whole original failure.
  for (const phrase of ["also bought", "who holds both", "same wallets in both", "overlap between"]) {
    assert.ok(d.includes(phrase), `holder_overlap must quote "${phrase}"`);
  }
  // And it must be reachable from a question that is not in English.
  assert.ok(/que wallets|quelles wallets|welche wallets/.test(d), "non-English phrasings missing");
});

test("each description states what the lookup CANNOT establish", () => {
  const overlap = descOf("holder_overlap");
  // Co-holding is not buying, and the tool has to say so where the model reads it —
  // the question that reaches it will often be worded "also bought".
  assert.match(overlap, /CURRENT CO-HOLDING and NOT buying/);
  assert.match(overlap, /airdrop/);
  assert.match(overlap, /at least N wallets/);
  assert.match(overlap, /never present any overlap as coordination/i);

  const co = descOf("co_holdings");
  assert.match(co, /BOUNDED SAMPLE/);
  assert.match(co, /not a pattern across the token/i);
  assert.match(co, /Holding is not buying/);
  assert.match(co, /sharedDisplay/);
});

test("both tools get their own progress step, and the overlap label names BOTH sides", () => {
  assert.equal(stepForTool("holder_overlap"), PHRASE_STEPS.OVERLAP);
  assert.equal(stepForTool("co_holdings"), PHRASE_STEPS.CO_HOLDINGS);

  const subject = toolSubject("holder_overlap", { tokens: [A, B] });
  // A status row naming one token tells the reader exactly the story the substituted
  // answer told, so both halves have to be in it.
  assert.match(subject, /0x31ba/);
  assert.match(subject, /0xa15c/);
  const label = progressLabel(PHRASE_STEPS.OVERLAP, subject);
  assert.ok(label.length <= 64, `progress label too long for the row: ${label}`);
});

/* ------------------------------ arg coercion ------------------------------ */

test("the pair arrives three different ways and becomes the same list, in order", () => {
  assert.deepEqual(coerceOverlapTokens({ tokens: [A, B] }).value, [A, B]);
  // The model sent one string instead of an array — the failure that made
  // compare_tokens need the same splitter.
  assert.deepEqual(coerceOverlapTokens({ tokens: `${A} and ${B}` }).value, [A, B]);
  // The model could not fit two tokens into one array and used two keys. The ORDER
  // matters: "the overlap of B and A" names the wrong token first in every sentence
  // that follows.
  assert.deepEqual(coerceOverlapTokens({ token_a: "pipecat", token_b: "merrymen" }).value, ["pipecat", "merrymen"]);
  assert.deepEqual(coerceOverlapTokens({ token: "nvda", other: "tsla" }).value, ["nvda", "tsla"]);
  assert.deepEqual(coerceOverlapTokens(["nvda", "tsla", "aapl"]).value, ["nvda", "tsla", "aapl"]);
});

test("a one-sided overlap is refused, and the error names the single-token lookups", () => {
  const one = coerceOverlapTokens({ tokens: ["nvda"] });
  assert.equal(one.ok, false);
  // The point of the sentence: a "relation" with one side missing must not be
  // answered as a holder list, which is the bug this tool exists to fix.
  assert.match(one.error, /at least 2 distinct tokens/);
  assert.match(one.error, /token_holders/);
  assert.match(one.error, /co_holdings/);
  assert.match(one.error, /wallet_portfolio/);

  const dupe = coerceOverlapTokens({ tokens: [A, A.toUpperCase()] });
  assert.equal(dupe.ok, false, "the same contract twice is not an overlap");

  const none = coerceOverlapTokens({});
  assert.equal(none.ok, false);
  assert.match(none.error, /Missing "tokens"/);
});

test("a truncated address is refused rather than searched for as a name", () => {
  const res = coerceOverlapTokens({ tokens: ["0xabc123", B] });
  assert.equal(res.ok, false);
  assert.match(res.error, /not a complete 0x contract address/);

  const hash = coerceOverlapTokens({ tokens: [`0x${"ab".repeat(32)}`, B] });
  assert.equal(hash.ok, false);
  assert.match(hash.error, /transaction hash/);

  const sentence = coerceOverlapTokens({ tokens: ["a".repeat(200), B] });
  assert.equal(sentence.ok, false);
  assert.match(sentence.error, /too long/);
});

test("co_holdings clamps its probe depth instead of failing on it", () => {
  const wide = coerceCoHoldingArgs({ query: "nvda", limit: 999 });
  assert.equal(wide.ok, true);
  assert.equal(wide.limit, paramsOf("co_holdings").properties.limit.maximum);
  assert.equal(coerceCoHoldingArgs({ query: "nvda" }).limit, 10);
  assert.equal(coerceCoHoldingArgs({}).ok, false, "a token is still required");
});

/* ------------------------------ the measured pair ------------------------------ */

test("the measured question yields BOTH tokens, the whale and the wallet the user named", async () => {
  const fixture = chain();
  const res = await holderOverlapReport([A, B], wired(fixture));
  assert.equal(res.ok, true);
  const e = res.evidence;

  // Both lists fit, so this is the complete set and says so — not a sample.
  assert.equal(e.strategy, OVERLAP_STRATEGIES.FULL);
  assert.equal(e.exact, true);
  assert.equal(e.isLowerBound, false);
  assert.match(e.countDisplay, /^4 wallets$/);
  assert.ok(!/at least/.test(e.countDisplay), "an exact count must not wear the qualifier");

  // EVERY token asked about is named. An overlap answer that mentions one of the two
  // contracts is the failure this lookup exists to fix.
  assert.deepEqual(e.tokens.map((t) => t.symbol), ["PIPECAT", "MERRYMEN"]);
  assert.equal(e.pair, "PIPECAT and MERRYMEN");

  const wallets = e.wallets.map((w) => w.address);
  assert.ok(wallets.includes(W_BOTH), "the wallet the user named must be in the overlap");
  assert.ok(wallets.includes(W_WHALE), "PIPECAT's majority holder must be in the overlap");
  // Largest position first: the 52.4% holder is the most interesting fact about the
  // pair and the substituted answer missed it entirely.
  assert.equal(e.wallets[0].address, W_WHALE);
  // The share as the sentence it must be quoted as, not a bare number.
  assert.match(e.wallets[0].largestShare, /^5\d(\.\d+)?% of PIPECAT$/);

  // The pool, the burn sink and the token contract hold both and are not positions.
  const excluded = e.excluded.map((x) => x.address);
  for (const address of [POOL, ZERO_ADDRESS, A]) {
    assert.ok(excluded.includes(address), `${address} must be labelled, not counted`);
    assert.ok(!wallets.includes(address), `${address} must not be counted as a wallet`);
  }
  assert.equal(e.count, e.wallets.length, "the headline counts only wallets with a position");
});

test("every row carries the wallet's position in EVERY token, not just the first", async () => {
  const fixture = chain();
  const res = await holderOverlapReport([A, B], wired(fixture));
  const table = res.evidence.table;
  assert.ok(isTable(table));

  // A column pair per token. A table with only the first token's balances in it
  // would be the original bug drawn as a grid.
  const labels = table.columns.map((c) => c.label);
  assert.ok(labels.some((l) => l.includes("PIPECAT")), "the first token must have columns");
  assert.ok(labels.some((l) => l.includes("MERRYMEN")), "the SECOND token must have columns");

  const row = table.rows.find((r) => r.address === W_BOTH);
  assert.ok(row, "the wallet the user named must be a row");
  // Compacted by lib/ask-evidence.js fmtTokenAmount, as every printed amount here
  // is — what matters is that BOTH tokens' amounts are on the row.
  assert.match(row.t0Amount, /^32\.1M$/, "its PIPECAT balance");
  assert.match(row.t1Amount, /^14\.45M$/, "its MERRYMEN balance");
  // Both shares present and neither of them a bare zero.
  assert.match(row.t0Share, /%$/);
  assert.match(row.t1Share, /%$/);
});

test("a position too small to round to a percent is never printed as 0%", async () => {
  // Measured live: a wallet holding 9.05e-12 of a 9.5e8 supply. pctOfSupply rounds to
  // two decimals, so the honest cell is "<0.01%" — a bare "0%" beside a real balance
  // is the coerce-to-zero mistake in rounding form.
  const fixture = chain();
  const res = await holderOverlapReport([A, B], wired(fixture));
  const dust = res.evidence.table.rows.find((r) => r.address === W_DUST);
  assert.ok(dust, "the dust wallet holds both and must be a row");
  assert.equal(dust.t0Share, "<0.01%");
  assert.equal(dust.t1Share, "<0.01%");
  assert.ok(!res.evidence.table.rows.some((r) => r.t0Share === "0%" || r.t1Share === "0%"), "no bare 0% anywhere");
  assert.match(res.evidence.table.note, /too small to round/);
});

test("the table note reads as sentences, whichever module wrote each fragment", async () => {
  // The fragments come from lib/cross-token.js, from here and from the pool sweep, and
  // only some punctuate themselves. Joined naively they ran together: "…not counted as
  // not holding A share shown as…".
  const fixture = chain({ pageCap: B });
  const res = await holderOverlapReport([A, B], wired(fixture));
  const note = res.evidence.table.note;
  // The exact seam that ran together: the truncation reason ends with "…unknown
  // rather than absent" and the share sentence follows it.
  assert.match(note, /rather than absent\. A share shown as/);
  assert.match(note, /\.$/, "the caption ends");
  assert.ok(!/\.\./.test(note), "and no fragment got a second full stop");
});

/* ------------------------------ bounds and honesty ------------------------------ */

test("a list that could not be finished makes the count a labelled lower bound", async () => {
  // MERRYMEN's walk never runs out of cursor, so it is read to the page cap and the
  // wallets past it are unknown rather than absent.
  const fixture = chain({ pageCap: B });
  const res = await holderOverlapReport([A, B], wired(fixture));
  assert.equal(res.ok, true);
  const e = res.evidence;

  assert.equal(e.exact, false);
  assert.equal(e.isLowerBound, true);
  // THE QUALIFIER IS INSIDE THE QUOTABLE STRING, the way holder_hold_time's
  // medianDisplay carries "at least N days". A caller cannot drop it by quoting.
  assert.match(e.countDisplay, /^at least \d+ wallets?$/);
  // And the truncation is in the DATA as well as the prose, so a reader of the
  // fields alone cannot mistake a part-read list for a complete one.
  const merrymen = e.tokens.find((t) => t.symbol === "MERRYMEN");
  assert.equal(merrymen.listComplete, false);
  assert.ok(merrymen.pagesRead > 0);
  assert.ok(typeof merrymen.listReason === "string" && merrymen.listReason.length > 0);
  // The bound is in the title too, because a title is the one line every reader reads.
  assert.match(e.table.title, /at least/);
  assert.match(e.table.note, /LOWER BOUND/);
  assert.equal(e.table.truncated, true);
});

test("a tight clock does NOT demote a readable pair to the probe", async () => {
  // A CLOCK CHECK IN THE PLAN WAS TRIED, MEASURED WORSE AND REMOVED, and this pins
  // that. Cold, PIPECAT + MERRYMEN is 13 pages ≈ 33s against 17s of lookup time, so
  // demoting it to the smallest-set probe looks like the affordable choice — but the
  // probe reads the base list LARGEST BALANCE FIRST and caps, and measured on this
  // pair the shared wallets are the SMALL PIPECAT positions: none of PIPECAT's top
  // five readable holders holds MERRYMEN, while the full intersection finds fourteen
  // wallets whose balances run down to 1e-18. The probe is a weaker instrument, not a
  // cheaper route to the same answer, and it is right only when a list cannot be paged
  // at all — which the page-count model already detects. So the plan costs PAGES, the
  // walk checks the clock per page, and a cut-short walk reports a labelled bound.
  const tight = await runWithBudget(
    () => holderOverlapReport([A, B], wired(chain())),
    { totalMs: 10_000, reserveMs: 2_000 },
  );
  assert.equal(tight.ok, true);
  assert.equal(tight.evidence.strategy, OVERLAP_STRATEGIES.FULL);
  assert.equal(tight.evidence.exact, true, "both lists still fit their page caps");
  // The estimate is STATED, so a truncated cold walk has something to be explained by.
  assert.match(tight.evidence.strategyReason, /a holder page measures on this indexer/);
  assert.match(tight.evidence.strategyReason, /reported per list rather than assumed/);
  assert.equal(tight.evidence.strategy, (await holderOverlapReport([A, B], wired(chain()))).evidence.strategy);
});

test("a candidate whose portfolio failed is unknown, never a wallet that does not hold", async () => {
  // PIPECAT is readable and MERRYMEN is not, so the smallest-set probe runs: read
  // PIPECAT's list, settle each candidate by its own portfolio. One of them 500s.
  const fixture = chain({ pageCap: B, portfolioFails: new Set([W_BOTH]) });
  const res = await holderOverlapReport([A, B], {
    ...wired(fixture),
    // Force the probe strategy by making the base list the only readable one.
  });
  assert.equal(res.ok, true);
  const e = res.evidence;

  if (e.strategy === OVERLAP_STRATEGIES.SMALLEST) {
    assert.ok(e.candidates, "the probe strategy must report its candidate accounting");
    const unknown = e.candidates.unknown.map((u) => u.address);
    assert.ok(unknown.includes(W_BOTH), "a failed probe is unknown");
    assert.ok(!e.wallets.some((w) => w.address === W_BOTH), "and is not counted as holding");
    assert.match(e.candidates.unknown[0].reason, /unknown, not no/);
    assert.equal(e.exact, false, "an unknown candidate makes the whole answer a floor");
  } else {
    // The full walk ran instead; the truncated list alone still has to bound it.
    assert.equal(e.exact, false);
    assert.match(e.countDisplay, /at least/);
  }
});

test("a bound explained only by the CANDIDATE probe still explains itself", async () => {
  // MEASURED LIVE, and it shipped as empty parentheses. The base list was read in
  // FULL (140 of 140 holders) and the candidate probe was the only thing cut short —
  // 27 of 60 answered, 33 refused by the indexer — so the reading's "the read was NOT
  // complete ()" had nothing between the brackets, which reads as a bug beside a
  // figure the reader is being asked to treat as a floor.
  // MERRYMEN reports 60,000 holders, so the plan reads PIPECAT and settles each of its
  // holders by portfolio — and every portfolio read fails.
  const fixture = chain({
    bodies: { ...BODIES, [B]: { ...BODIES[B], holders: "60000" } },
    portfolioFails: new Set(Object.keys(PORTFOLIOS)),
  });
  const res = await holderOverlapReport([A, B], wired(fixture));
  assert.equal(res.ok, true);
  const e = res.evidence;
  assert.equal(e.strategy, OVERLAP_STRATEGIES.SMALLEST);
  assert.equal(e.exact, false);
  assert.equal(e.count, 0, "every probe failed, so nothing could be confirmed");
  // An unread zero is NOT a measured zero, and the sentence has to say which.
  assert.match(e.reading, /That is not a finding that nothing overlaps/);
  assert.ok(!/\(\)/.test(e.reading), `empty parenthetical: ${e.reading}`);
  assert.match(e.reading, /could not be read at all and are unknown/);
  assert.match(e.countDisplay, /^at least 0 wallets$/);
  // And the base list's own reason is not quoted twice: the probe run's reason opens
  // with it, so the naive union printed the same sentence into one bracket twice.
  const bracket = e.reading.match(/NOT complete \(([^)]*)\)/)?.[1] ?? "";
  const clauses = bracket.split("; ").map((c) => c.trim());
  assert.equal(new Set(clauses).size, clauses.length, `a caveat is repeated verbatim: ${bracket}`);
});

test("a token that cannot be resolved fails the call rather than narrowing it", async () => {
  const fixture = chain();
  const res = await holderOverlapReport([A, "definitely-not-a-ticker"], wired(fixture));
  assert.equal(res.ok, false);
  // The whole point: intersecting only the tokens that resolved would answer a
  // narrower question than the one asked, which is the defect being fixed.
  assert.match(res.error, /could not be resolved/);
  assert.match(res.error, /narrower question/);
});

test("two spellings of one contract are refused with both spellings in the sentence", async () => {
  const fixture = chain();
  const res = await holderOverlapReport([A, A], wired(fixture));
  assert.equal(res.ok, false);
  assert.match(res.error, /same contract/);
  assert.match(res.error, /token_holders/);
});

test("an unidentified pool becomes a caveat, not a silent holder label", async () => {
  const fixture = chain();
  const res = await holderOverlapReport([A, B], { ...wired(fixture), resolvePool: poolsUnread });
  assert.equal(res.ok, true);
  assert.equal(res.evidence.poolStatus, "unread");
  assert.ok(res.evidence.poolCaveat, "an unread pool sweep must say so");
  assert.match(res.evidence.table.note, /liquidity pool/i);
});

test("nothing in the overlap evidence calls co-holding a purchase", async () => {
  const fixture = chain();
  const res = await holderOverlapReport([A, B], wired(fixture));
  const e = res.evidence;
  assert.equal(e.measured, "current_co_holding");
  // The user's phrasing was "also bought". Nothing here may repeat it as a claim —
  // the only place "bought" is allowed to appear is inside a denial of it.
  const prose = [e.reading, e.table.note, e.table.title].join(" ");
  assert.ok(!/\balso bought\b/i.test(prose), `prose must not claim a purchase: ${prose}`);
  assert.match(e.reading, /not a finding that they bought them/);
  assert.match(e.disclaimer, /not shared buying/);
  assert.match(e.disclaimer, /it does not say the wallet bought it/);
  // And nothing may harden into an accusation.
  assert.ok(!/\b(scam|rug|fraud|insider)\b/i.test(prose), "no verdict language");
});

/* ------------------------------ co-holdings ------------------------------ */

test("co_holdings refuses a count without both denominators", async () => {
  const fixture = chain();
  const res = await coHoldingsReport(A, wired(fixture));
  assert.equal(res.ok, true);
  const e = res.evidence;

  assert.ok(e.coverage.probed > 0);
  assert.equal(e.coverage.holderCount, 150, "the token's own holder count is the outer denominator");
  for (const row of e.tokens) {
    // "2 of the 3 probed holders" — the sample travels with the count so a row
    // cannot be read out of the table without it.
    assert.match(row.sharedDisplay, /of the \d+ probed holders?$/);
    assert.equal(row.ofProbed, e.coverage.probed);
  }
  // A bounded sample is never a fact about the token.
  assert.equal(e.coverage.complete, false);
  assert.equal(e.table.truncated, true);
  assert.match(e.table.note, /not a pattern across the token/i);
  assert.match(e.reading, /150 holders/);
});

test("co_holdings keys the tally by CONTRACT and leaves the subject out of it", async () => {
  const fixture = chain();
  const res = await coHoldingsReport(A, wired(fixture));
  const addresses = res.evidence.tokens.map((t) => t.address);
  assert.ok(addresses.includes(B), "the other token the holders hold");
  assert.ok(!addresses.includes(A), "the subject is not something ELSE they hold");
  // The pool's other liquidity is the market's, not a trader's other position.
  assert.ok(res.evidence.excluded.some((x) => x.address === POOL));
});

test("a holder whose portfolio failed is counted as unread, not as holding nothing", async () => {
  const fixture = chain({ portfolioFails: new Set([W_WHALE]) });
  const res = await coHoldingsReport(A, wired(fixture));
  assert.equal(res.ok, true);
  const e = res.evidence;
  assert.equal(e.coverage.probeFailed, 1);
  assert.match(e.reading, /unknown holdings, not empty ones/);
  assert.match(e.table.note, /could not be read/);
  assert.ok(e.unavailable?.includes("holderPortfolios"));
});

/* --------------------------- the prompt's own budget --------------------------- */

test("both cross-token results at their WIDEST fit the prompt's evidence budget", async () => {
  // MEASURED, AND IT DID NOT. An overlap row carries a position per token, so four
  // tokens and 200 wallets came to 102KB against lib/ask-loop.js MAX_EVIDENCE_CHARS of
  // 24,000 — and what a truncated blob loses is its TAIL: the bound, the denominators,
  // the reading and the disclaimer. Losing those to a row cap is the exact failure
  // this whole change exists to prevent, so the rows give way and the honesty stays.
  const T = [A, B, "0x00000000000000000000000000000000000000c1", "0x00000000000000000000000000000000000000c2"];
  const wide = Array.from({ length: 80 }, (_, i) => holder(`0x${String(i + 1).padStart(40, "0")}`, 1_000_000 - i));
  const bodies = {};
  const pages = {};
  const portfolios = {};
  for (const [i, t] of T.entries()) {
    bodies[t] = { symbol: `TOKEN${i}`, name: `Token number ${i}`, decimals: "18", total_supply: SUPPLY_B, holders: "300" };
    pages[t] = [wide.slice(0, 50), wide.slice(50)];
  }
  for (const h of wide) portfolios[h.address.hash] = T.map((t) => entry(t, 5));

  const fixture = chain({ pages, bodies, portfolios });
  const overlap = await holderOverlapReport(T, wired(fixture, { limit: MAX_OVERLAP_ROWS }));
  assert.equal(overlap.ok, true);
  const overlapChars = JSON.stringify(overlap.evidence).length;
  assert.ok(overlapChars < MAX_EVIDENCE_CHARS, `overlap evidence is ${overlapChars} chars, budget ${MAX_EVIDENCE_CHARS}`);
  // And every field the bound rides on survived.
  for (const key of ["countDisplay", "exact", "isLowerBound", "reading", "disclaimer", "strategyReason", "totalWallets"]) {
    assert.ok(key in overlap.evidence, `${key} must be in the evidence`);
  }
  // The table is a prefix of the count and says so rather than implying it is all.
  assert.equal(overlap.evidence.table.rows.length, MAX_OVERLAP_ROWS);
  assert.equal(overlap.evidence.table.totalRows, overlap.evidence.totalWallets);
  assert.equal(overlap.evidence.table.truncated, true);
  assert.equal(overlap.evidence.walletsTruncated, true, "the prose slice is a prefix too");
  assert.ok(overlap.evidence.wallets.length <= 8);

  const co = await coHoldingsReport(A, wired(fixture, { limit: 25 }));
  assert.equal(co.ok, true);
  const coChars = JSON.stringify(co.evidence).length;
  assert.ok(coChars < MAX_EVIDENCE_CHARS, `co-holding evidence is ${coChars} chars, budget ${MAX_EVIDENCE_CHARS}`);
  for (const key of ["coverage", "reading", "disclaimer", "tokenCount"]) {
    assert.ok(key in co.evidence, `${key} must be in the evidence`);
  }
  assert.ok(co.evidence.tokens.length <= 10, "the prose slice is short");
  assert.equal(co.evidence.table.truncated, true);
});

/* ------------------------------ the dispatcher ------------------------------ */

test("dispatchTool routes both tools and passes the coerced arguments through", async () => {
  const seen = [];
  const impls = {
    holderOverlapReport: (tokens, options) => {
      seen.push({ name: "holderOverlapReport", tokens, options });
      return Promise.resolve({ ok: true, kind: "overlap", evidence: { countDisplay: "14 wallets" } });
    },
    coHoldingsReport: (query, options) => {
      seen.push({ name: "coHoldingsReport", query, options });
      return Promise.resolve({ ok: true, kind: "coHoldings", evidence: { tokenCount: 0 } });
    },
  };

  const overlap = await dispatchTool("holder_overlap", { tokens: `${A} and ${B}`, limit: 5 }, impls);
  assert.equal(overlap.ok, true);
  assert.equal(overlap.kind, "overlap");
  assert.deepEqual(seen[0].tokens, [A, B], "the split pair is what reaches the gatherer");
  assert.equal(seen[0].options.limit, 5);

  const co = await dispatchTool("co_holdings", { query: "$nvda", limit: 3 }, impls);
  assert.equal(co.ok, true);
  assert.equal(seen[1].query, "$nvda");
  assert.equal(seen[1].options.limit, 3);
});

test("a malformed cross-token call becomes a recoverable sentence, never a throw", async () => {
  const impls = {
    holderOverlapReport: () => Promise.reject(new Error("should not be called")),
    coHoldingsReport: () => Promise.reject(new Error("should not be called")),
  };
  const bad = await dispatchTool("holder_overlap", { tokens: [A] }, impls);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /at least 2 distinct tokens/);

  const noToken = await dispatchTool("co_holdings", {}, impls);
  assert.equal(noToken.ok, false);
  assert.match(noToken.error, /Missing "query"/);
});

test("a gatherer that throws is answered as an unreadable overlap, not as none", async () => {
  const res = await dispatchTool(
    "holder_overlap",
    { tokens: [A, B] },
    { holderOverlapReport: () => Promise.reject(new Error("indexer down")) },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /indexer down/);
  assert.match(res.error, /could not be read/);
});

/* ------------------------------ the prompt rule ------------------------------ */

test("the prompt forbids silently narrowing a multi-subject question", () => {
  // THE RULE MATTERS MORE THAN THE TOOL. A catalogue gap explains why the model
  // reached for lookup_token; nothing in the prompt explained why it was allowed to
  // report that as the answer, and the next question with two subjects would do the
  // same thing with whatever tool was nearest.
  assert.match(SYSTEM_PROMPT, /Answering the whole question, never a smaller one/);
  assert.match(SYSTEM_PROMPT, /WHEN THE QUESTION NAMES TWO OR MORE SUBJECTS/);
  assert.match(SYSTEM_PROMPT, /IGNORING THE OTHER, WITH NO ACKNOWLEDGEMENT/);
  assert.match(SYSTEM_PROMPT, /cannot tell "the answer is about A" from "I forgot about B"/);
  assert.match(SYSTEM_PROMPT, /NEVER SUBSTITUTE THE NEAREST AVAILABLE LOOKUP/);
  // And it must name the lookups that DO answer a relation, or the rule is a
  // prohibition with no alternative.
  assert.match(SYSTEM_PROMPT, /holder_overlap/);
  assert.match(SYSTEM_PROMPT, /co_holdings/);
});

test("the prompt binds the overlap figures the way the evidence hands them over", () => {
  // The bound, the denominator, the unknowns and the restraint — each has to be a
  // rule, because each is a place a qualifier gets dropped between the data and prose.
  assert.match(SYSTEM_PROMPT, /"countDisplay" already reads "at least N wallets"/);
  assert.match(SYSTEM_PROMPT, /never print the raw "count" in its place/);
  assert.match(SYSTEM_PROMPT, /full_intersection/);
  assert.match(SYSTEM_PROMPT, /smallest_set_probe/);
  assert.match(SYSTEM_PROMPT, /sharedDisplay/);
  assert.match(SYSTEM_PROMPT, /coverage\.probeFailed/);
  assert.match(SYSTEM_PROMPT, /never call an overlap coordination, a bundle, insider activity, a cluster, a scam or a rug/);
  // "also bought" is the user's word and must not become the answer's.
  assert.match(SYSTEM_PROMPT, /A BALANCE IS NOT A PURCHASE/);
  assert.match(SYSTEM_PROMPT, /Never write "also bought" over a co-holding figure/);
});

test("the prompt says an overlap answer must name every token asked about", () => {
  assert.match(SYSTEM_PROMPT, /AN OVERLAP ACROSS TOKENS/);
  assert.match(SYSTEM_PROMPT, /NAME EVERY TOKEN/);
  assert.match(SYSTEM_PROMPT, /WHAT A TOKEN'S HOLDERS ALSO HOLD: lead with the DENOMINATOR/);
});

/* --------------------------- the v4 PoolManager --------------------------- */

test("the v4 PoolManager is not an interested wallet and is not the headline row", async () => {
  // THE REPRODUCED COMPLAINT, at the layer the user saw it. holder_overlap on
  // PIPECAT + MERRYMEN put 0x8366a39c… at the top of the table as the largest position
  // in the overlap. It is the Uniswap v4 PoolManager: v4 keeps every pool in one
  // contract and custodies every token in it, which is precisely why one address turns
  // up holding two unrelated tokens and looks like the most interesting wallet there.
  const fixture = chain();
  const res = await holderOverlapReport([A, B], wired(fixture, { resolveV4PoolManager: v4Confirmed }));
  const e = res.evidence;

  const wallets = e.wallets.map((w) => w.address);
  assert.ok(!wallets.includes(W_WHALE), "the v4 PoolManager must not be counted as a wallet");
  assert.notEqual(e.wallets[0].address, W_WHALE, "and must not be the headline row");
  assert.equal(e.wallets[0].address, W_BOTH, "the largest real position leads instead");

  // LABELLED AND LISTED, not silently dropped: the rows still reconcile against the
  // explorer's holder list, which is the same treatment the v3 pool gets.
  const row = e.excluded.find((x) => x.address === W_WHALE);
  assert.ok(row, "it belongs in `excluded`, with its reason");
  assert.match(row.roleReason, /Uniswap v4 PoolManager/);
  assert.match(e.excludedNote, /liquidity pool's balance is the market's/);
  assert.equal(e.count, e.wallets.length, "the headline counts only wallets with a position");
  assert.equal(e.v4Status, "confirmed");
  assert.equal(e.v4Caveat, null);
  // And the table a reader sees does not carry it either.
  assert.ok(!e.table.rows.some((r) => r.address === W_WHALE), "no v4 row in the table");
});

test("an unresolved v4 check labels nothing and says so — never a silent pass", async () => {
  const fixture = chain();
  const v4Unread = () =>
    Promise.resolve({ address: null, candidate: W_WHALE, status: "unread", reason: "the RPC did not answer" });
  const res = await holderOverlapReport([A, B], wired(fixture, { resolveV4PoolManager: v4Unread }));
  const e = res.evidence;

  assert.equal(e.v4Status, "unread");
  // The row stays a wallet, because nothing established what it is — and the caveat
  // that says so travels with it, in the evidence and in the reading.
  assert.ok(e.wallets.some((w) => w.address === W_WHALE));
  assert.match(e.v4Caveat, /was not established/);
  assert.match(e.reading, /v4 keeps every pool in one contract/);
});

test("the prompt names the v4 PoolManager as pooled liquidity and never as a wallet", () => {
  // The label is only half the fix. Without a rule, the model can still narrate an
  // excluded pool as "the biggest wallet" from the row it can see in `excluded`.
  assert.match(SYSTEM_PROMPT, /"poolVersion": "v4" IS THE UNISWAP V4 POOLMANAGER, NOT A WALLET/);
  assert.match(SYSTEM_PROMPT, /keeps every pool in ONE contract/);
  assert.match(SYSTEM_PROMPT, /never describe it as a wallet, a trader, a whale or a holder with a position/);
  // And the unresolved case has to be quotable rather than silently trusted.
  assert.match(SYSTEM_PROMPT, /If "v4Caveat" is present that check did NOT settle/);
});
