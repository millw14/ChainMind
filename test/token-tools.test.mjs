// Tests for the five token-side lookups (lib/token-evidence.js) and the
// arguments they are reached through (lib/ask-tools.js).
//
// Three things are being defended here.
//
//  1. COERCION. These tools take a target and a row count, and a model sends the
//     target under the wrong key, as a bare string, as a truncated 0x fragment,
//     or with a limit of 999. Every one of those has to become a valid lookup or
//     a sentence the model can act on — and a truncated address must be REFUSED
//     rather than fuzzy-matched, because a holder table drawn for whatever
//     contract happens to be named after the fragment is worse than an error.
//  2. THE TABLE SHAPE. Each list-shaped tool emits one table under the agreed key
//     with the columns its rows are keyed by, the upstream total when the indexer
//     gave one, and truncation flagged. A share with no supply to divide by stays
//     null: a holder printed as owning 0% of a token they demonstrably hold is
//     the sharpest false claim this product could make.
//  3. THE PATTERN CHECKS. Every finding carries the rows that produced it,
//     nothing firing is a real answer, and a check that could not run is
//     distinguishable from one that ran and matched nothing.
//
// Fully offline. Every lookup injects fake indexer calls through `calls`, and
// every dispatchTool call injects fake data modules through the third argument,
// so nothing in this file can reach Blockscout.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_NAMES,
  TOOL_SCHEMAS,
  coerceContractQuery,
  coerceHolderArgs,
  coercePatternQuery,
  coerceSearchArgs,
  coerceTransferArgs,
  dispatchTool,
  toolSubject,
} from "../lib/ask-tools.js";
import {
  PATTERN_LIMITS,
  clampRows,
  concentrationOf,
  contractInfo,
  detectPatterns,
  flagPatterns,
  holderRows,
  rankSearchResults,
  searchTokens,
  tokenHolders,
  tokenTransfers,
  transferRows,
} from "../lib/token-evidence.js";
import { PHRASE_STEPS, stepForTool } from "../lib/thinking-phrases.js";
import { isTable } from "../lib/table-shape.js";

const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const FAKE_NVDA = "0x465834d5ba3af2169e49b70a139448e59e3ca492";
const TX_HASH = `0x${"ab".repeat(32)}`;
const WALLET = (n) => `0x${String(n).padStart(40, "0")}`;

/** 18-decimal base units for a whole-token amount. */
const units = (n) => `${BigInt(Math.round(n * 1000))}${"0".repeat(15)}`;

const paramsOf = (name) => TOOL_SCHEMAS.find((s) => s.function.name === name).function.parameters;

/**
 * Indexer stand-in. Every call is a plain resolved value, and any getter left
 * undefined throws — so a lookup that reaches for a call this test did not
 * script fails loudly instead of silently hitting the network.
 */
function chain(overrides = {}) {
  const boom = (name) => () => Promise.reject(new Error(`unscripted call: ${name}`));
  return {
    getAddress: boom("getAddress"),
    getToken: boom("getToken"),
    getTokenActivity: boom("getTokenActivity"),
    getTokenCounters: boom("getTokenCounters"),
    getTokenHolders: boom("getTokenHolders"),
    getTransaction: boom("getTransaction"),
    searchChain: boom("searchChain"),
    listStockTokens: () => Promise.resolve([]),
    resolveSymbol: () => Promise.resolve({ ok: false, match: null }),
    verifiedByIssuer: () => Promise.resolve(false),
    ...overrides,
  };
}

/** The /tokens body for a token with 18 decimals and a known supply. */
const tokenBody = (extra = {}) => ({
  name: "NVIDIA • Robinhood Token",
  symbol: "NVDA",
  type: "ERC-20",
  decimals: "18",
  total_supply: units(1000),
  ...extra,
});

const holderItem = (address, whole) => ({ address: { hash: address }, value: units(whole) });

const transferItem = (from, to, whole, timestamp) => ({
  from: { hash: from },
  to: { hash: to },
  total: { value: units(whole), decimals: "18" },
  timestamp,
  transaction_hash: TX_HASH,
});

/* ============================ the catalogue ============================ */

test("the five token-side tools are registered with usable schemas", () => {
  for (const name of ["token_holders", "token_transfers", "flag_patterns", "contract_info", "search_tokens"]) {
    assert.ok(TOOL_NAMES.includes(name), `${name} is missing from TOOL_NAMES`);
    const params = paramsOf(name);
    assert.deepEqual(params.required, ["query"], `${name} must require its one target`);
    assert.equal(typeof params.properties.query.description, "string");
  }
  assert.equal(paramsOf("token_holders").properties.limit.maximum, 100);
  assert.equal(paramsOf("token_transfers").properties.limit.maximum, 100);
  assert.equal(paramsOf("search_tokens").properties.limit.maximum, 25);
  assert.equal(paramsOf("flag_patterns").properties.limit, undefined, "the checks are fixed, not tunable per call");
});

test("flag_patterns' description forbids the verdict it would be easiest to write", () => {
  const d = TOOL_SCHEMAS.find((s) => s.function.name === "flag_patterns").function.description;
  assert.match(d, /never verdicts/i);
  assert.match(d, /empty findings list/i, "the model has to be told that nothing firing is an answer");
});

test("each new tool names its own kind of work in the status line", () => {
  assert.equal(stepForTool("token_holders"), PHRASE_STEPS.HOLDERS);
  assert.equal(stepForTool("token_transfers"), PHRASE_STEPS.TRANSFERS);
  assert.equal(stepForTool("flag_patterns"), PHRASE_STEPS.PATTERNS);
  assert.equal(stepForTool("contract_info"), PHRASE_STEPS.CONTRACT);
  assert.equal(stepForTool("search_tokens"), PHRASE_STEPS.SEARCH);
});

test("the status subject comes off the coerced arguments, not the raw ones", () => {
  assert.equal(toolSubject("token_holders", { symbol: "$nvda" }), "NVDA");
  assert.equal(toolSubject("contract_info", { contract: NVDA }), "0xd060…9eec");
  // A search subject is a fragment, not a ticker: shouting it would misname it.
  assert.equal(toolSubject("search_tokens", { q: "coca cola" }), "coca cola");
  assert.equal(toolSubject("flag_patterns", { query: "0xabc" }), null, "a malformed call has no honest subject");
});

/* ============================== coercion ============================== */

test("the token-side coercers read the target out of whichever key it arrived under", () => {
  for (const coerce of [coerceHolderArgs, coerceTransferArgs, coercePatternQuery, coerceContractQuery]) {
    assert.equal(coerce({ query: "nvda" }).value, "nvda");
    assert.equal(coerce({ symbol: "$tsla" }).value, "$tsla");
    assert.equal(coerce({ token: "apple" }).value, "apple");
    assert.equal(coerce({ contract: NVDA }).value, NVDA);
    assert.equal(coerce("nvidia").value, "nvidia", "a bare string instead of an object");
    assert.equal(coerce({ query: "  coca   cola " }).value, "coca cola");
  }
});

test("the token-side coercers refuse a truncated 0x rather than fuzzy-matching it", () => {
  // "0xabc" reaching the token search can match an unrelated contract named after
  // the fragment, and the answer would be about the wrong token entirely.
  for (const coerce of [coerceHolderArgs, coerceTransferArgs, coercePatternQuery, coerceContractQuery]) {
    const res = coerce({ query: "0xabc123" });
    assert.equal(res.ok, false);
    assert.match(res.error, /40 hex/);
  }
  const search = coerceSearchArgs({ query: "0xabc123" });
  assert.equal(search.ok, false);
  assert.match(search.error, /truncated/i);
});

test("the token-side coercers send a transaction hash to the tool that reads one", () => {
  for (const coerce of [coerceHolderArgs, coerceTransferArgs, coercePatternQuery, coerceContractQuery]) {
    const res = coerce({ query: TX_HASH });
    assert.equal(res.ok, false);
    assert.match(res.error, /lookup_transaction/);
  }
});

test("the token-side coercers refuse an empty target or the user's whole sentence", () => {
  const cases = [
    [coerceHolderArgs, "token_holders"],
    [coerceTransferArgs, "token_transfers"],
    [coercePatternQuery, "flag_patterns"],
    [coerceContractQuery, "contract_info"],
  ];
  for (const [coerce, name] of cases) {
    for (const args of [undefined, null, {}, "", "   ", { query: "" }, { query: null }, []]) {
      const res = coerce(args);
      assert.equal(res.ok, false);
      assert.match(res.error, new RegExp(name), `${name} must name itself in the retry hint`);
    }
    const long = coerce({ query: "a".repeat(200) });
    assert.equal(long.ok, false);
    assert.match(long.error, /whole question/);
  }
});

test("an out-of-range row count is clamped rather than failing the call", () => {
  // A holder list is answerable at the default depth, so refusing a limit of 999
  // would cost a round trip to reach a number we can just pick.
  assert.equal(coerceHolderArgs({ query: "nvda", limit: 999 }).limit, 100);
  assert.equal(coerceHolderArgs({ query: "nvda", limit: 0 }).limit, 1);
  assert.equal(coerceHolderArgs({ query: "nvda", limit: -7 }).limit, 1);
  assert.equal(coerceHolderArgs({ query: "nvda", limit: "40" }).limit, 40, "a numeric string is still a number");
  assert.equal(coerceHolderArgs({ query: "nvda", limit: 12.9 }).limit, 12);
  assert.equal(coerceHolderArgs({ query: "nvda", limit: "loads" }).limit, 25, "junk falls back to the default");
  assert.equal(coerceHolderArgs({ query: "nvda" }).limit, 25);
  assert.equal(coerceHolderArgs({ query: "nvda", count: 5 }).limit, 5, "the wrong key still carries the count");
  assert.equal(coerceTransferArgs({ query: "nvda", top: 60 }).limit, 60);
  assert.equal(coerceTransferArgs({ query: "nvda", limit: 5000 }).limit, 100);
  assert.equal(coerceSearchArgs({ query: "nvid", limit: 999 }).limit, 25, "search has its own tighter bound");
  assert.equal(coerceSearchArgs({ query: "nvid" }).limit, 10);
});

test("clampRows never returns anything outside its bounds, whatever it is handed", () => {
  for (const raw of [undefined, null, "", "x", {}, [], true, NaN, Infinity, -Infinity, 1e9, -1e9]) {
    const n = clampRows(raw, 25, 100);
    assert.ok(Number.isInteger(n) && n >= 1 && n <= 100, `clampRows(${JSON.stringify(raw)}) = ${n}`);
  }
});

test("search_tokens keeps the fragments the other tools would reject", () => {
  // The whole point is a half-remembered string nobody can resolve yet.
  assert.equal(coerceSearchArgs({ query: "nvid" }).value, "nvid");
  assert.equal(coerceSearchArgs({ q: "coca cola" }).value, "coca cola");
  assert.equal(coerceSearchArgs("berk").value, "berk");
  assert.equal(coerceSearchArgs({ term: "gold" }).value, "gold");
  const missing = coerceSearchArgs({});
  assert.equal(missing.ok, false);
  assert.match(missing.error, /search_tokens/);
  assert.match(coerceSearchArgs({ query: "a".repeat(200) }).error, /too long/);
});

/* ============================= the dispatcher ============================= */

function toolFakes() {
  const calls = [];
  const log = (name, result) => (...args) => {
    calls.push({ name, args });
    return Promise.resolve(result);
  };
  return {
    calls,
    impls: {
      tokenHolders: log("tokenHolders", { ok: true, kind: "holders", evidence: {} }),
      tokenTransfers: log("tokenTransfers", { ok: true, kind: "transfers", evidence: {} }),
      flagPatterns: log("flagPatterns", { ok: true, kind: "patterns", evidence: {} }),
      contractInfo: log("contractInfo", { ok: true, kind: "contract", evidence: {} }),
      searchTokens: log("searchTokens", { ok: true, kind: "search", evidence: {} }),
    },
  };
}

test("dispatchTool hands each token-side tool its coerced arguments", async () => {
  const holders = toolFakes();
  assert.equal((await dispatchTool("token_holders", { symbol: "nvda", limit: 999 }, holders.impls)).kind, "holders");
  assert.deepEqual(holders.calls, [{ name: "tokenHolders", args: ["nvda", { limit: 100 }] }]);

  const transfers = toolFakes();
  await dispatchTool("token_transfers", { query: NVDA }, transfers.impls);
  assert.deepEqual(transfers.calls, [{ name: "tokenTransfers", args: [NVDA, { limit: 25 }] }]);

  const patterns = toolFakes();
  await dispatchTool("flag_patterns", "nvda", patterns.impls);
  assert.deepEqual(patterns.calls, [{ name: "flagPatterns", args: ["nvda"] }]);

  const contract = toolFakes();
  await dispatchTool("contract_info", { contract: FAKE_NVDA }, contract.impls);
  assert.deepEqual(contract.calls, [{ name: "contractInfo", args: [FAKE_NVDA] }]);

  const search = toolFakes();
  await dispatchTool("search_tokens", { q: "nvid", limit: 3 }, search.impls);
  assert.deepEqual(search.calls, [{ name: "searchTokens", args: ["nvid", { limit: 3 }] }]);
});

test("a badly formed token-side call spends no indexer time", async () => {
  for (const [tool, args] of [
    ["token_holders", { query: "0xabc" }],
    ["token_transfers", {}],
    ["flag_patterns", { query: TX_HASH }],
    ["contract_info", "   "],
    ["search_tokens", { query: "" }],
  ]) {
    const { impls, calls } = toolFakes();
    const res = await dispatchTool(tool, args, impls);
    assert.equal(res.ok, false, `${tool} accepted junk`);
    assert.equal(typeof res.error, "string");
    assert.deepEqual(calls, [], `${tool} called downstream on a bad argument`);
  }
});

test("a thrown token-side gatherer becomes an error the model can answer around", async () => {
  const boom = () => Promise.reject(new Error("socket hang up"));
  for (const [tool, args, key] of [
    ["token_holders", { query: "nvda" }, "tokenHolders"],
    ["token_transfers", { query: "nvda" }, "tokenTransfers"],
    ["flag_patterns", { query: "nvda" }, "flagPatterns"],
    ["contract_info", { query: "nvda" }, "contractInfo"],
    ["search_tokens", { query: "nvid" }, "searchTokens"],
  ]) {
    const { impls } = toolFakes();
    const res = await dispatchTool(tool, args, { ...impls, [key]: boom });
    assert.equal(res.ok, false, `${tool} let an exception escape`);
    assert.match(res.error, /socket hang up/);
    assert.match(res.error, /rather than guessing/);
  }
});

/* ============================== holders ============================== */

test("token_holders emits a table with the upstream total behind it", async () => {
  const res = await tokenHolders("NVDA", {
    limit: 3,
    calls: chain({
      getToken: () => Promise.resolve(tokenBody()),
      getTokenCounters: () => Promise.resolve({ token_holders_count: "29642" }),
      getTokenHolders: () =>
        Promise.resolve({
          items: [holderItem(WALLET(1), 500), holderItem(WALLET(2), 250), holderItem(WALLET(3), 100), holderItem(WALLET(4), 50)],
          next_page_params: { items_count: 50 },
        }),
    }),
  });

  assert.equal(res.ok, true);
  assert.equal(res.kind, "holders");
  const t = res.evidence.table;
  assert.ok(isTable(t), "a renderer must be able to draw it");
  assert.equal(t.id, "token-holders");
  assert.match(t.title, /Top 3 holders of NVDA/);
  assert.deepEqual(t.columns.map((c) => c.key), ["rank", "address", "amountDisplay", "percentDisplay"]);
  assert.equal(t.rowCount, 3, "the limit is respected");
  assert.equal(t.totalRows, 29642, "so the chrome can say \"3 of 29,642\"");
  assert.equal(t.truncated, true);
  assert.deepEqual(t.rows[0], { rank: 1, address: WALLET(1), amountDisplay: "500", percentDisplay: "50%" });
  assert.equal(res.evidence.holderCountDisplay, "29,642");
});

test("token_holders computes concentration over every row read, not the rows shown", async () => {
  // Asking for three holders must not turn the top-10 figure into a top-3 figure.
  const items = Array.from({ length: 12 }, (_, i) => holderItem(WALLET(i + 1), 50));
  const res = await tokenHolders("NVDA", {
    limit: 3,
    calls: chain({
      getToken: () => Promise.resolve(tokenBody()),
      getTokenCounters: () => Promise.resolve({ token_holders_count: 12 }),
      getTokenHolders: () => Promise.resolve({ items }),
    }),
  });

  const top10 = res.evidence.concentration.find((c) => c.rank === 10);
  const top25 = res.evidence.concentration.find((c) => c.rank === 25);
  assert.equal(top10.percent, 50, "ten holders of 5% each");
  assert.equal(top10.complete, true);
  assert.equal(top10.display, "50% across the top 10");
  // Only twelve holders came back, so a "top 25" is not one and must say so.
  assert.equal(top25.complete, false);
  assert.equal(top25.of, 12);
  assert.match(top25.display, /12 holders that could be read/);
});

test("a share with no supply to divide by is null, never zero", async () => {
  const res = await tokenHolders("NVDA", {
    calls: chain({
      getToken: () => Promise.resolve(tokenBody({ total_supply: null })),
      getTokenCounters: () => Promise.resolve({ token_holders_count: "" }),
      getTokenHolders: () => Promise.resolve({ items: [holderItem(WALLET(1), 500)] }),
    }),
  });

  assert.equal(res.evidence.topHolders[0].percent, null);
  assert.equal(res.evidence.topHolders[0].percentDisplay, null);
  assert.equal(res.evidence.table.rows[0].percentDisplay, null);
  for (const band of res.evidence.concentration) {
    assert.equal(band.percent, null, "an unmeasurable concentration is unknown, not 0%");
    assert.equal(band.display, null);
  }
  // Blockscout sends "" for a counter it has not computed; Number("") is 0.
  assert.equal(res.evidence.holderCount, null, "an uncounted holder base is not an empty one");
  assert.equal(res.evidence.table.totalRows, null);
  assert.match(res.evidence.table.note, /unknown, not a zero holding/);
});

test("a holder call that failed is an outage, never \"this token has no holders\"", async () => {
  const res = await tokenHolders("NVDA", {
    calls: chain({
      getToken: () => Promise.resolve(tokenBody()),
      getTokenCounters: () => Promise.resolve({ token_holders_count: 5 }),
      getTokenHolders: () => Promise.reject(Object.assign(new Error("gateway"), { status: 502 })),
    }),
  });

  assert.equal(res.ok, false);
  assert.match(res.error, /unknown, not absent/);
  assert.match(res.error, /502/);
  assert.doesNotMatch(res.error, /no holders/i);
});

test("amounts converted at a guessed precision say so instead of looking measured", async () => {
  // Without the token body there is no decimals figure, and 18 is a guess that
  // can be wrong by a trillion. The guess is stated rather than hidden.
  const res = await tokenHolders("NVDA", {
    calls: chain({
      getToken: () => Promise.reject(new Error("timeout")),
      getTokenCounters: () => Promise.resolve({ token_holders_count: 3 }),
      getTokenHolders: () => Promise.resolve({ items: [holderItem(WALLET(1), 500)] }),
    }),
  });

  assert.equal(res.ok, true);
  assert.deepEqual(res.evidence.unavailable, ["token"]);
  assert.equal(res.evidence.decimalsAssumed, true);
  assert.match(res.evidence.table.note, /assumed 18 decimals/);
});

test("an unknown ticker is only \"not found\" when the registry proves the point", async () => {
  // resolveSymbol reports "no token matching X" both when the ticker does not
  // exist and when nothing answered at all, because its inputs degrade to empty
  // rather than throwing. Reporting the second as the first would tell someone a
  // contract they hold is not on the chain.
  const down = await tokenHolders("ZZZZ", {
    calls: chain({
      resolveSymbol: () => Promise.resolve({ ok: false, match: null, reason: "No token matching \"ZZZZ\"." }),
      listStockTokens: () => Promise.resolve([]),
    }),
  });
  assert.equal(down.ok, false);
  assert.match(down.error, /unknown, not absent/);

  const genuinelyMissing = await tokenHolders("ZZZZ", {
    calls: chain({
      resolveSymbol: () => Promise.resolve({ ok: false, match: null, reason: "No token matching \"ZZZZ\" was found on Robinhood Chain." }),
      listStockTokens: () => Promise.resolve([{ symbol: "NVDA", address: NVDA }]),
    }),
  });
  assert.equal(genuinelyMissing.ok, false);
  assert.match(genuinelyMissing.error, /No token matching "ZZZZ"/);
  assert.doesNotMatch(genuinelyMissing.error, /unknown, not absent/);
});

test("a pasted contract address is read directly, with no ticker asserted about it", async () => {
  const res = await tokenHolders(FAKE_NVDA.toUpperCase().replace("0X", "0x"), {
    calls: chain({
      getToken: () => Promise.resolve(tokenBody()),
      getTokenCounters: () => Promise.resolve({ token_holders_count: 4 }),
      getTokenHolders: () => Promise.resolve({ items: [holderItem(WALLET(1), 5)] }),
      // resolveSymbol must never be reached for an address, so leaving it as the
      // failing default is the assertion.
    }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.evidence.address, FAKE_NVDA);
  assert.equal(res.evidence.symbol, "NVDA", "the symbol comes off the token body, not off a guess");
});

test("a hundred-row holder table still fits inside the prompt's evidence budget", async () => {
  // The table carries every row; the prose array is a short slice of it. Both
  // carrying all hundred would put this over MAX_EVIDENCE_CHARS (24,000) and the
  // table would be the half that got truncated away.
  const items = Array.from({ length: 100 }, (_, i) => holderItem(WALLET(i + 1), 5));
  const res = await tokenHolders("NVDA", {
    limit: 100,
    calls: chain({
      getToken: () => Promise.resolve(tokenBody()),
      getTokenCounters: () => Promise.resolve({ token_holders_count: 29642 }),
      getTokenHolders: () => Promise.resolve({ items }),
    }),
  });
  assert.equal(res.evidence.table.rowCount, 100);
  assert.equal(res.evidence.topHolders.length, 10, "the prose slice does not repeat the whole table");
  assert.ok(
    JSON.stringify(res.evidence, null, 2).length < 24_000,
    `evidence is ${JSON.stringify(res.evidence, null, 2).length} chars, past the budget`,
  );
});

/* ============================== transfers ============================== */

test("token_transfers emits a table and flags that it is the front of a longer list", async () => {
  const res = await tokenTransfers("NVDA", {
    limit: 2,
    calls: chain({
      getToken: () => Promise.resolve(tokenBody()),
      getTokenCounters: () => Promise.resolve({ transfers_count: "81234" }),
      getTokenActivity: () =>
        Promise.resolve({
          items: [
            transferItem(WALLET(1), WALLET(2), 10, "2026-07-27T10:00:00.000000Z"),
            transferItem(WALLET(2), WALLET(3), 20, "2026-07-27T09:00:00.000000Z"),
            transferItem(WALLET(3), WALLET(4), 30, "2026-07-27T08:00:00.000000Z"),
          ],
          next_page_params: { index: 2 },
        }),
    }),
  });

  assert.equal(res.ok, true);
  assert.equal(res.kind, "transfers");
  const t = res.evidence.table;
  assert.ok(isTable(t));
  assert.equal(t.id, "token-transfers");
  assert.deepEqual(t.columns.map((c) => c.key), ["time", "from", "to", "amountDisplay", "txHash"]);
  assert.equal(t.rowCount, 2);
  assert.equal(t.totalRows, 81234);
  assert.equal(t.truncated, true, "\"recent transfers\" is always a prefix");
  assert.equal(t.rows[0].from, WALLET(1));
  assert.equal(t.rows[0].amountDisplay, "10");
  assert.equal(t.rows[0].txHash, TX_HASH);
  // The span the sample actually covers, so "recent" is a measured word.
  assert.equal(res.evidence.window.spanDisplay, "2h 0m");
  assert.equal(res.evidence.transferCountDisplay, "81,234");
});

test("a transfer count the indexer withheld is unknown, not zero", async () => {
  const res = await tokenTransfers("NVDA", {
    calls: chain({
      getToken: () => Promise.resolve(tokenBody()),
      getTokenCounters: () => Promise.resolve({ transfers_count: "" }),
      getTokenActivity: () => Promise.resolve({ items: [transferItem(WALLET(1), WALLET(2), 10, "2026-07-27T10:00:00Z")] }),
    }),
  });
  assert.equal(res.evidence.transferCount, null);
  assert.equal(res.evidence.transferCountDisplay, null);
  assert.equal(res.evidence.table.totalRows, null);
  assert.equal(res.evidence.window, null, "one timestamp is not a span");
});

test("a transfers call that failed is an outage, never \"nothing has moved\"", async () => {
  const res = await tokenTransfers("NVDA", {
    calls: chain({
      getToken: () => Promise.resolve(tokenBody()),
      getTokenCounters: () => Promise.resolve({ transfers_count: 5 }),
      getTokenActivity: () => Promise.reject(new Error("timeout")),
    }),
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /unknown, not absent/);
});

/* ============================== patterns ============================== */

const at = (iso) => Date.parse(iso);

const flow = (from, to, amount, iso) => ({
  from,
  to,
  amount,
  amountDisplay: String(amount),
  time: iso,
  timeMs: at(iso),
  txHash: TX_HASH,
});

test("matched amounts from several addresses inside a short window are named, with their rows", () => {
  const { findings, checked } = detectPatterns({
    transfers: [
      flow(WALLET(1), WALLET(9), 100, "2026-07-27T10:00:00Z"),
      flow(WALLET(2), WALLET(9), 100.5, "2026-07-27T10:03:00Z"),
      flow(WALLET(3), WALLET(9), 100.2, "2026-07-27T10:07:00Z"),
    ],
    holders: null,
    symbol: "NVDA",
  });

  const hit = findings.find((f) => f.id === "matched_amounts");
  assert.ok(hit, "three near-identical amounts from three addresses in seven minutes");
  assert.equal(hit.evidence.distinctSenders, 3);
  assert.equal(hit.evidence.transfers, 3);
  assert.equal(hit.evidence.rows.length, 3, "the rows that produced it travel with it");
  assert.ok(hit.evidence.rows.every((r) => r.from && r.amount && r.at));
  assert.equal(hit.evidence.windowSeconds, 420);
  // An observation, not an accusation.
  assert.match(hit.reading, /not proof/i);
  assert.equal(checked.find((c) => c.check === "matched_amounts").fired, true);
});

test("the same amounts spread over a day are not a cluster", () => {
  const { findings } = detectPatterns({
    transfers: [
      flow(WALLET(1), WALLET(9), 100, "2026-07-26T02:00:00Z"),
      flow(WALLET(2), WALLET(9), 100, "2026-07-26T14:00:00Z"),
      flow(WALLET(3), WALLET(9), 100, "2026-07-27T09:00:00Z"),
    ],
    holders: null,
    symbol: "NVDA",
  });
  assert.equal(findings.length, 0, "\"inside a short window\" is half the claim");
});

test("matched amounts with no readable timestamps do not fire on half a claim", () => {
  const rows = [
    { ...flow(WALLET(1), WALLET(9), 100, "2026-07-27T10:00:00Z"), timeMs: null },
    { ...flow(WALLET(2), WALLET(9), 100, "2026-07-27T10:01:00Z"), timeMs: null },
    { ...flow(WALLET(3), WALLET(9), 100, "2026-07-27T10:02:00Z"), timeMs: null },
  ];
  const { findings } = detectPatterns({ transfers: rows, holders: null, symbol: "NVDA" });
  assert.equal(findings.some((f) => f.id === "matched_amounts"), false);
});

test("a dominant holder is reported with its address and share, and with what it does not prove", () => {
  const { findings } = detectPatterns({
    transfers: null,
    holders: holderRows([holderItem(WALLET(1), 910), holderItem(WALLET(2), 20)], 18, units(1000)),
    symbol: "NVDA",
  });
  const hit = findings.find((f) => f.id === "dominant_holder");
  assert.ok(hit);
  assert.equal(hit.evidence.address, WALLET(1));
  assert.equal(hit.evidence.percent, "91%");
  assert.match(hit.reading, /not by itself evidence/i);
});

test("a dominant share cannot be claimed without a supply to measure it against", () => {
  const { findings, checked } = detectPatterns({
    transfers: null,
    holders: holderRows([holderItem(WALLET(1), 910)], 18, null),
    symbol: "NVDA",
  });
  assert.equal(findings.length, 0);
  const check = checked.find((c) => c.check === "dominant_holder");
  assert.equal(check.ran, false);
  assert.equal(check.fired, null, "not run is not the same as ran and found nothing");
  assert.match(check.reason, /no total supply/);
});

test("one-way distribution out of a small set is named, and a mint is named as one", () => {
  const zero = "0x0000000000000000000000000000000000000000";
  const rows = Array.from({ length: 6 }, (_, i) =>
    flow(zero, WALLET(i + 1), 10, `2026-07-27T1${i}:00:00Z`),
  );
  const { findings } = detectPatterns({ transfers: rows, holders: null, symbol: "NVDA" });
  const hit = findings.find((f) => f.id === "one_way_distribution");
  assert.ok(hit);
  assert.equal(hit.evidence.distinctSenders, 1);
  assert.equal(hit.evidence.distinctReceivers, 6);
  assert.equal(hit.evidence.includesZeroAddress, true);
  assert.match(hit.reading, /minting or an airdrop/);
});

test("transfers landing inside a couple of minutes are flagged as one burst", () => {
  const rows = Array.from({ length: 6 }, (_, i) =>
    flow(WALLET(i + 1), WALLET(i + 20), i + 1, `2026-07-27T10:0${i}:00Z`),
  );
  const { findings } = detectPatterns({ transfers: rows, holders: null, symbol: "NVDA" });
  const hit = findings.find((f) => f.id === "tight_window");
  assert.ok(hit);
  assert.equal(hit.evidence.windowSeconds, 300);
  assert.ok(hit.evidence.rows.length > 0);
});

test("nothing firing is a real answer, and every check says whether it ran", () => {
  const { findings, checked } = detectPatterns({
    transfers: [
      flow(WALLET(1), WALLET(2), 1, "2026-07-25T10:00:00Z"),
      flow(WALLET(2), WALLET(1), 50, "2026-07-26T11:00:00Z"),
      flow(WALLET(3), WALLET(1), 900, "2026-07-27T12:00:00Z"),
    ],
    holders: holderRows([holderItem(WALLET(1), 50), holderItem(WALLET(2), 40)], 18, units(1000)),
    symbol: "NVDA",
  });
  assert.deepEqual(findings, []);
  assert.equal(checked.length, 4, "all four checks are accounted for");
  assert.equal(checked.find((c) => c.check === "matched_amounts").fired, false);
  assert.equal(checked.find((c) => c.check === "dominant_holder").fired, false);
  for (const c of checked) {
    if (!c.ran) assert.ok(c.reason, `${c.check} did not run and did not say why`);
  }
});

test("no finding exists without the evidence that produced it", () => {
  // Every shape this module can emit, in one pass: a finding with an empty or
  // missing evidence block would be an assertion with nothing behind it.
  const cases = [
    {
      transfers: [
        flow(WALLET(1), WALLET(9), 100, "2026-07-27T10:00:00Z"),
        flow(WALLET(2), WALLET(9), 100, "2026-07-27T10:01:00Z"),
        flow(WALLET(3), WALLET(9), 100, "2026-07-27T10:02:00Z"),
        flow(WALLET(4), WALLET(9), 100, "2026-07-27T10:03:00Z"),
        flow(WALLET(5), WALLET(9), 100, "2026-07-27T10:04:00Z"),
      ],
      holders: holderRows([holderItem(WALLET(1), 999)], 18, units(1000)),
      symbol: "NVDA",
    },
    { transfers: [], holders: [], symbol: null },
    { transfers: null, holders: null, symbol: null },
    {},
  ];
  for (const input of cases) {
    const { findings } = detectPatterns(input);
    for (const f of findings) {
      assert.equal(typeof f.id, "string");
      assert.ok(f.evidence && typeof f.evidence === "object");
      assert.ok(Object.keys(f.evidence).length > 0, `${f.id} fired with no evidence`);
      assert.ok(f.reading.length > 40, `${f.id} has no plain reading`);
      // No probability dressed as certainty.
      assert.doesNotMatch(f.reading, /\b(certain|definitely|proves|confirmed|guaranteed)\b/i);
    }
  }
});

test("flag_patterns says what it looked at, and never that nothing happened when it could not look", async () => {
  const res = await flagPatterns("NVDA", {
    calls: chain({
      getToken: () => Promise.resolve(tokenBody()),
      getTokenActivity: () => Promise.reject(new Error("timeout")),
      getTokenHolders: () => Promise.resolve({ items: [holderItem(WALLET(1), 950)] }),
    }),
  });

  assert.equal(res.ok, true);
  assert.deepEqual(res.evidence.unavailable, ["recentTransfers"]);
  assert.equal(res.evidence.sample.transfersRead, null, "a failed read is not a read of zero transfers");
  assert.equal(res.evidence.sample.holdersRead, 1);
  // The holder-side check still ran and fired; the transfer-side ones did not.
  assert.equal(res.evidence.findings.length, 1);
  assert.equal(res.evidence.checked.find((c) => c.check === "matched_amounts").ran, false);
  assert.match(res.evidence.disclaimer, /not verdicts/i);
});

test("flag_patterns with neither side readable is an outage, not a clean bill of health", async () => {
  const res = await flagPatterns("NVDA", {
    calls: chain({
      getToken: () => Promise.reject(new Error("timeout")),
      getTokenActivity: () => Promise.reject(new Error("timeout")),
      getTokenHolders: () => Promise.reject(new Error("timeout")),
    }),
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /unknown, not absent/);
});

test("flag_patterns over a quiet token says the checks found nothing, as a result", async () => {
  const res = await flagPatterns("NVDA", {
    calls: chain({
      getToken: () => Promise.resolve(tokenBody()),
      getTokenActivity: () =>
        Promise.resolve({
          items: [
            transferItem(WALLET(1), WALLET(2), 1, "2026-07-25T10:00:00Z"),
            transferItem(WALLET(2), WALLET(1), 44, "2026-07-26T10:00:00Z"),
            transferItem(WALLET(3), WALLET(4), 900, "2026-07-27T10:00:00Z"),
          ],
        }),
      getTokenHolders: () => Promise.resolve({ items: [holderItem(WALLET(1), 100), holderItem(WALLET(2), 90)] }),
    }),
  });

  assert.equal(res.ok, true);
  assert.deepEqual(res.evidence.findings, []);
  assert.match(res.evidence.summary, /nothing to flag/);
  assert.match(res.evidence.summary, /not a failed lookup/);
});

/* ============================ contract info ============================ */

test("contract_info reports the deployment record and reads the issuer off the deployer", async () => {
  const res = await contractInfo("NVDA", {
    calls: chain({
      getToken: () => Promise.resolve(tokenBody()),
      getAddress: () =>
        Promise.resolve({
          is_contract: true,
          is_verified: true,
          creator_address_hash: "0x1111111111111111111111111111111111111111",
          creation_tx_hash: TX_HASH,
        }),
      getTransaction: () => Promise.resolve({ timestamp: new Date(Date.now() - 3 * 86_400_000).toISOString() }),
      verifiedByIssuer: () => Promise.resolve(true),
    }),
  });

  assert.equal(res.ok, true);
  assert.equal(res.kind, "contract");
  assert.equal(res.evidence.address, NVDA);
  assert.equal(res.evidence.sourceVerified, true);
  assert.equal(res.evidence.creationTx, TX_HASH);
  assert.equal(res.evidence.issuerVerified, true);
  assert.equal(res.evidence.inVerifiedSnapshot, true);
  assert.equal(res.evidence.ageDays, 3);
  assert.match(res.evidence.reading, /verified snapshot/);
  assert.match(res.evidence.reading, /created within the last week/);
});

test("a deployer that is not the issuer is stated as that, and only when it was read", async () => {
  const someoneElse = "0x2222222222222222222222222222222222222222";
  const res = await contractInfo(FAKE_NVDA, {
    calls: chain({
      getToken: () => Promise.resolve(tokenBody()),
      getAddress: () =>
        Promise.resolve({ is_contract: true, is_verified: false, creator_address_hash: someoneElse, creation_tx_hash: null }),
      verifiedByIssuer: () => Promise.resolve(false),
    }),
  });

  assert.equal(res.evidence.issuerVerified, false);
  assert.equal(res.evidence.deployer, someoneElse);
  assert.equal(res.evidence.inVerifiedSnapshot, false);
  assert.equal(res.evidence.namedLikeEquity, true, "the name is reported, never trusted");
  assert.equal(res.evidence.ageDays, null, "no creation tx, so no age — not an age of zero");
  assert.match(res.evidence.reading, /the name is copyable, the deployer is not/);
});

test("a deployer that could not be read is unknown, never reported as not-the-issuer", async () => {
  const res = await contractInfo(FAKE_NVDA, {
    calls: chain({
      getToken: () => Promise.resolve(tokenBody()),
      getAddress: () => Promise.reject(new Error("timeout")),
      verifiedByIssuer: () => Promise.resolve(false),
    }),
  });

  assert.equal(res.ok, true, "the token body still landed, so there is an answer");
  assert.equal(res.evidence.issuerVerified, null, "fails to unknown, not to false");
  assert.equal(res.evidence.deployer, null);
  assert.equal(res.evidence.sourceVerified, null, "false would claim the source is unpublished");
  assert.ok(res.evidence.unavailable.includes("contract"));
  assert.match(res.evidence.reading, /could not be checked/);
});

/* ============================== search ============================== */

test("search_tokens ranks the issuer-verified contract above the lookalike wearing its ticker", async () => {
  const res = await searchTokens("nvda", {
    calls: chain({
      searchChain: () =>
        Promise.resolve({
          items: [
            { type: "token", address_hash: FAKE_NVDA, name: "NVIDIA • Robinhood Token", symbol: "NVDA", holders_count: "40000" },
            { type: "token", address_hash: NVDA, name: "NVIDIA • Robinhood Token", symbol: "NVDA", holders_count: "28899" },
            { type: "token", address_hash: WALLET(7), name: "NVDA Cat", symbol: "NVDACAT", holders_count: "3" },
          ],
        }),
    }),
  });

  assert.equal(res.ok, true);
  assert.equal(res.kind, "search");
  const t = res.evidence.table;
  assert.ok(isTable(t));
  assert.equal(t.id, "token-search");
  assert.deepEqual(t.columns.map((c) => c.key), ["rank", "symbol", "name", "verified", "holdersDisplay", "address"]);
  // A bigger holder count does not outrank being the contract Robinhood issued.
  assert.equal(t.rows[0].address, NVDA);
  assert.equal(t.rows[0].verified, "Yes");
  assert.equal(t.rows[1].address, FAKE_NVDA);
  assert.equal(t.rows[1].verified, "No");
  assert.equal(t.rows[2].symbol, "NVDACAT", "an exact ticker outranks one that merely starts with it");
  assert.equal(res.evidence.issuerVerifiedMatches, 1);
  assert.match(t.note, /not that it is a fake/);
});

test("search_tokens honours its limit and says the list is a prefix", async () => {
  const items = Array.from({ length: 8 }, (_, i) => ({
    type: "token",
    address_hash: WALLET(i + 1),
    name: `Gold Thing ${i}`,
    symbol: `GLD${i}`,
  }));
  const res = await searchTokens("gold", { limit: 3, calls: chain({ searchChain: () => Promise.resolve({ items }) }) });
  assert.equal(res.evidence.table.rowCount, 3);
  assert.equal(res.evidence.table.totalRows, 8);
  assert.equal(res.evidence.table.truncated, true);
  assert.equal(res.evidence.matches, 8);
});

test("a full search page with more upstream reports a floor, never a total", async () => {
  // Measured against the live explorer: "nvidia" comes back with 50 items AND a
  // next_page_params. Calling that page length the number of matches states a
  // total nobody counted.
  const items = Array.from({ length: 6 }, (_, i) => ({
    type: "token",
    address_hash: WALLET(i + 1),
    name: `Nvidia Thing ${i}`,
    symbol: `NVD${i}`,
  }));
  const res = await searchTokens("nvidia", {
    limit: 25,
    calls: chain({
      searchChain: () => Promise.resolve({ items, next_page_params: { q: "nvidia", "token[name]": "Nvidia Thing 5" } }),
    }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.evidence.matches, 6, "still the measured count of what was read");
  assert.equal(res.evidence.moreUpstream, true);
  assert.equal(res.evidence.table.totalRows, null, "an unmeasured total is null, not the page length");
  assert.equal(res.evidence.table.truncated, true, "a prefix must be flagged even when the limit was not hit");
  assert.match(res.evidence.table.note, /how many were read, not how many exist/);
  assert.match(res.evidence.note, /at least 6/);

  // The same page with no cursor IS the whole answer.
  const whole = await searchTokens("nvidia", {
    limit: 25,
    calls: chain({ searchChain: () => Promise.resolve({ items }) }),
  });
  assert.equal(whole.evidence.moreUpstream, false);
  assert.equal(whole.evidence.table.totalRows, 6);
  assert.equal(whole.evidence.table.truncated, false);
});

test("a search that matched nothing is a measured zero; a search that failed is not", async () => {
  const empty = await searchTokens("zzzz", { calls: chain({ searchChain: () => Promise.resolve({ items: [] }) }) });
  assert.equal(empty.ok, true);
  assert.equal(empty.evidence.matches, 0, "a body that arrived saying nothing matched is a real answer");
  assert.match(empty.evidence.note, /not a failed lookup/);

  const down = await searchTokens("zzzz", { calls: chain({ searchChain: () => Promise.reject(new Error("timeout")) }) });
  assert.equal(down.ok, false);
  assert.match(down.error, /unknown, not absent/);
});

test("search rows that are not tokens never reach the table", async () => {
  const res = await searchTokens("nvda", {
    calls: chain({
      searchChain: () =>
        Promise.resolve({
          items: [
            { type: "address", address: WALLET(4), name: "Some Wallet" },
            { type: "transaction", transaction_hash: TX_HASH },
            { type: "token", address_hash: NVDA, name: "NVIDIA • Robinhood Token", symbol: "NVDA" },
            { type: "token", address_hash: NVDA, name: "NVIDIA • Robinhood Token", symbol: "NVDA" },
          ],
        }),
    }),
  });
  assert.equal(res.evidence.matches, 1, "non-tokens dropped, the duplicate contract deduped");
});

/* ============================ pure row shaping ============================ */

test("row builders never emit a nested cell, so a table can always draw them", () => {
  const holders = holderRows([holderItem(WALLET(1), 5)], 18, units(10));
  const transfers = transferRows([transferItem(WALLET(1), WALLET(2), 5, "2026-07-27T10:00:00Z")], 18);
  for (const row of [...holders, ...transfers]) {
    for (const [key, value] of Object.entries(row)) {
      assert.ok(
        value === null || ["string", "number", "boolean"].includes(typeof value),
        `${key} is a ${typeof value}, which renders as "[object Object]"`,
      );
    }
  }
});

test("row builders survive the shapes an indexer actually sends", () => {
  assert.deepEqual(holderRows(null, 18, null), []);
  assert.deepEqual(transferRows(undefined, 18), []);
  const odd = holderRows([{}, { address: {}, value: "not-a-number" }], 18, units(10));
  assert.equal(odd.length, 2);
  assert.equal(odd[0].address, null);
  assert.equal(odd[0].amount, null);
});

test("concentrationOf refuses to sum what it could not measure", () => {
  assert.deepEqual(concentrationOf([], 10), { rank: 10, percent: null, counted: 0, of: 0, complete: false, display: null });
  const mixed = concentrationOf([{ percent: 10 }, { percent: null }, { percent: 20 }], 10);
  assert.equal(mixed.percent, 30, "an unknown share is skipped, not counted as zero");
  assert.equal(mixed.counted, 2);
  assert.equal(mixed.of, 3);
});

test("rankSearchResults is stable and keeps every row the search returned", () => {
  const rows = [
    { symbol: "AAPLX", name: "aapl clone", issuerVerified: false, holders: 5 },
    { symbol: "AAPL", name: "apple", issuerVerified: false, holders: 1 },
    { symbol: "ZZZ", name: "unrelated", issuerVerified: false, holders: 900 },
  ];
  const ranked = rankSearchResults(rows, "aapl");
  assert.equal(ranked.length, 3, "a row the search returned is a row the user may have meant");
  assert.equal(ranked[0].symbol, "AAPL");
  assert.deepEqual(ranked.map((r) => r.rank), [1, 2, 3]);
  assert.deepEqual(rankSearchResults(null, "x"), []);
});

test("the pattern thresholds are stated rather than buried", () => {
  for (const [key, value] of Object.entries(PATTERN_LIMITS)) {
    assert.equal(typeof value, "number", `${key} is not a number`);
    assert.ok(value > 0);
  }
  assert.ok(Object.isFrozen(PATTERN_LIMITS));
});
