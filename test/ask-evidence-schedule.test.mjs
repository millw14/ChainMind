// Tests for HOW lib/ask-evidence.js schedules its indexer calls: what it skips when
// the caller already knows the answer, what it overlaps when it doesn't, and what it
// does when a slow endpoint misses its deadline.
//
// Measured live before this: "hows nvda doin" took ~15s to first text against a model
// that answered in 593ms, because gatherEvidence awaited a 5.2s address lookup purely
// to decide token-vs-wallet and only then started the 4.5s token calls. None of that
// is visible in the returned evidence — only in WHEN each call happens — so every test
// here drives injected fakes through the `calls` and `deadlines` seams and asserts on
// call order and on deadlines, never on the network. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { gatherEvidence } from "../lib/ask-evidence.js";
import { BlockscoutError } from "../lib/blockscout.js";

/** AAPL as snapshotted in config/stock-tokens.json — a known-canonical equity token. */
const TOKEN = "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9";
const OTHER_TOKEN = `0x${"d".repeat(40)}`;
const WALLET = `0x${"b".repeat(40)}`;
const PEER = `0x${"c".repeat(40)}`;
const ISSUER = "0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046";

const KNOWN_TOKEN = { kind: "token", address: TOKEN, symbol: "AAPL", company: "Apple", official: true };

/* ------------------------------ fake indexer ------------------------------ */

/**
 * Records every call by name in the order it was STARTED, which is the whole
 * subject of this file, and honours the AbortSignal the module hands it — a fake
 * that ignored the signal could not show a deadline working.
 */
function recorder() {
  const log = [];

  /**
   * @param {string} name
   * @param {{ body?: any, ms?: number, status?: number|null, hang?: boolean }} [behaviour]
   *   `hang` answers a minute from now — i.e. never, next to any deadline in this
   *   file. It is a real timer rather than a promise nobody resolves because
   *   AbortSignal.timeout's own timer is unref'd: with nothing else holding the
   *   loop open, the abort would never fire and the test would hang instead of
   *   observing the deadline.
   */
  function call(name, { body = {}, ms = 0, status = null, hang = false } = {}) {
    return (...args) => {
      const last = args[args.length - 1];
      const signal = last && typeof last === "object" ? last.signal : null;
      log.push(name);
      return new Promise((resolve, reject) => {
        const finish = () =>
          status ? reject(new BlockscoutError(`fake ${status}`, status)) : resolve(body);
        const timer = setTimeout(finish, hang ? 60_000 : ms);
        // AbortSignal.timeout's reason is a TimeoutError DOMException, which is
        // what the real fetch would reject with.
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error("aborted"));
        });
      });
    };
  }

  return {
    log,
    call,
    saw: (name) => log.includes(name),
    /** A call that only answers once the test releases it. */
    gated(name, body = {}) {
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      return { fn: () => (log.push(name), gate.then(() => body)), release: () => release() };
    },
  };
}

/** Let every queued microtask and zero-delay timer run before asserting. */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

function tokenBody() {
  return {
    name: "Apple • Robinhood Token",
    symbol: "AAPL",
    type: "ERC-20",
    decimals: "18",
    total_supply: "1000000000000000000000",
    exchange_rate: "212.5",
    circulating_market_cap: "4160816.92",
    volume_24h: "98765.43",
  };
}

function overviewBody(extra = {}) {
  return {
    hash: TOKEN,
    is_verified: true,
    creator_address_hash: ISSUER,
    creation_tx_hash: `0x${"e".repeat(64)}`,
    token: tokenBody(),
    ...extra,
  };
}

function walletOverviewBody() {
  return { hash: WALLET, is_contract: false, name: "whale", coin_balance: "1000000000000000000", token: null };
}

/** The five token-path calls, all fast and all successful. */
function tokenCalls(r, over = {}) {
  return {
    getToken: r.call("getToken", { body: tokenBody() }),
    getTokenCounters: r.call("getTokenCounters", { body: { token_holders_count: 28899, transfers_count: 4321 } }),
    getTokenHolders: r.call("getTokenHolders", { body: { items: [{ address: { hash: WALLET }, value: "500000000000000000000" }] } }),
    getTokenActivity: r.call("getTokenActivity", {
      body: { items: [{ from: { hash: WALLET }, to: { hash: PEER }, total: { value: "1000000000000000000" }, timestamp: "2026-07-25T00:00:00Z" }] },
    }),
    getAddress: r.call("getAddress", { body: overviewBody() }),
    ...over,
  };
}

/** The four wallet-path calls, all fast and all successful. */
function walletCalls(r, over = {}) {
  return {
    getAddressCounters: r.call("getAddressCounters", { body: { transactions_count: 12, token_transfers_count: 4 } }),
    getAddressTokenBalances: r.call("getAddressTokenBalances", {
      body: [{ token: { symbol: "AAPL", decimals: "18", exchange_rate: "212.5" }, value: "2000000000000000000" }],
    }),
    getAddressTransactions: r.call("getAddressTransactions", { body: { items: [{ from: { hash: WALLET }, to: { hash: PEER } }] } }),
    getTokenTransfers: r.call("getTokenTransfers", { body: { items: [] } }),
    ...over,
  };
}

/* ------------------------------ the known hint ------------------------------ */

test("a `known: token` hint starts every token call without waiting for the address overview", async () => {
  const r = recorder();
  const overview = r.gated("getAddress", overviewBody());
  const calls = tokenCalls(r, { getAddress: overview.fn });

  const pending = gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls });
  await flush();

  // With the old gate, getAddress was the ONLY call made until it answered.
  assert.deepEqual(
    [...r.log].sort(),
    ["getAddress", "getToken", "getTokenActivity", "getTokenCounters", "getTokenHolders"],
    "all five calls are in flight while the address overview is still open",
  );

  overview.release();
  const res = await pending;
  assert.equal(res.ok, true);
  assert.equal(res.kind, "token");
  assert.equal(res.evidence.token.symbol, "AAPL");
  assert.equal(res.evidence.token.holders, 28899);
  assert.equal(res.degraded, undefined, "nothing failed, so nothing is degraded");
});

/**
 * Did the token enrichment start before the probe answered? True only when the
 * hint was believed. Releasing the gate before asserting matters: a failed
 * assertion mid-gather would otherwise leave a promise pending forever and take
 * the rest of the file down with it.
 */
async function skippedTheGate(known) {
  const r = recorder();
  const probe = r.gated("getToken", tokenBody());
  const pending = gatherEvidence(TOKEN, { known, calls: tokenCalls(r, { getToken: probe.fn }) });
  await flush();
  const early = r.saw("getTokenHolders");
  probe.release();
  const res = await pending;
  return { early, res };
}

test("the hint is ignored when it names a different address than the target", async () => {
  // A hint about OTHER_TOKEN says nothing about TOKEN; believing it would label
  // this contract with another one's facts.
  const { early, res } = await skippedTheGate({ kind: "token", address: OTHER_TOKEN });
  assert.equal(early, false, "kind is unknown again, so enrichment waits for the probe");
  assert.equal(res.kind, "token");
});

test("a malformed hint falls back to looking instead of being believed", async () => {
  for (const known of [{ kind: "token", address: "0xnope" }, { kind: "wallet", address: TOKEN }, "token", null]) {
    const { early, res } = await skippedTheGate(known);
    assert.equal(early, false, `hint ${JSON.stringify(known)} must not skip the probe`);
    assert.equal(res.kind, "token");
  }
});

test("a hint with no address at all still speaks for the target it came with", async () => {
  const { early } = await skippedTheGate({ kind: "token", official: true });
  assert.equal(early, true);
});

/* ------------------------------ the symbol path ------------------------------ */

test("a snapshotted ticker starts the token calls in the same window as the resolver", async () => {
  const r = recorder();
  const resolver = r.gated("resolveSymbol", {
    ok: true,
    query: "AAPL",
    match: { address: TOKEN, symbol: "AAPL", company: "Apple", price: 212.5, marketCap: 4160816.92, holders: 28899 },
    official: true,
    impostors: [],
  });
  const calls = tokenCalls(r, { resolveSymbol: resolver.fn });

  const pending = gatherEvidence("aapl", { calls });
  await flush();

  // The address for 94 tickers is a synchronous Map hit, so waiting for the
  // resolver's own round trips before starting these was pure latency.
  assert.equal(r.saw("getToken"), true, "token metadata is already being fetched");
  assert.equal(r.saw("getTokenHolders"), true, "so is the enrichment");
  assert.equal(r.saw("getAddress"), true, "so is the overview, which no longer gates anything");

  resolver.release();
  const res = await pending;
  assert.equal(res.ok, true);
  assert.equal(res.kind, "token");
  assert.equal(Object.keys(res.evidence)[0], "stock", "the impostor block still leads the evidence");
  assert.equal(res.evidence.stock.official, true);
  assert.equal(res.evidence.token.display.marketCap, "$4.16M");
});

test("a ticker lookup survives an address overview that never answers", async () => {
  const r = recorder();
  const calls = tokenCalls(r, {
    getAddress: r.call("getAddress", { hang: true }),
    resolveSymbol: r.call("resolveSymbol", {
      body: { ok: true, query: "AAPL", match: { address: TOKEN, symbol: "AAPL", company: "Apple" }, official: true, impostors: [] },
    }),
  });

  const res = await gatherEvidence("aapl", { calls, deadlines: { essential: 5_000, enrichment: 25 } });
  // This used to be a dead end: getAddress failing returned "Token not found" /
  // "the indexer did not answer" for a ticker whose every headline figure was
  // already in hand.
  assert.equal(res.ok, true);
  assert.equal(res.evidence.token.symbol, "AAPL");
  assert.equal(res.evidence.contract, null, "not a record of nulls, which would read as unverified");
  assert.ok(res.evidence.unavailable.includes("contract"));
  assert.equal(res.degraded, true);
});

/* ------------------------------ no hint: overlap ------------------------------ */

test("a bare address decides token-vs-wallet from the token probe, not the overview", async () => {
  const r = recorder();
  const overview = r.gated("getAddress", overviewBody());
  const calls = { ...tokenCalls(r, { getAddress: overview.fn }), ...walletCalls(r) };

  const pending = gatherEvidence(TOKEN, { calls });
  await flush();
  // The probe (1.1s live) has answered; the overview (5.2s live) has not, and the
  // enrichment is already running anyway.
  assert.equal(r.saw("getTokenHolders"), true, "the token path started off the probe alone");
  assert.equal(r.saw("getAddressCounters"), false, "and the wallet path was never speculatively fired");

  overview.release();
  const res = await pending;
  assert.equal(res.kind, "token");
  assert.equal(res.evidence.contract.creator, ISSUER);
});

test("a 404 from the token probe starts the wallet calls before the overview lands", async () => {
  const r = recorder();
  const overview = r.gated("getAddress", walletOverviewBody());
  const calls = {
    ...walletCalls(r),
    getToken: r.call("getToken", { status: 404 }),
    getTokenCounters: r.call("getTokenCounters", { status: 404 }),
    getAddress: overview.fn,
  };

  const pending = gatherEvidence(WALLET, { calls });
  await flush();
  assert.equal(r.saw("getAddressCounters"), true, "not a token, so the wallet calls run alongside the overview");
  assert.equal(r.saw("getTokenHolders"), false, "and no token enrichment is wasted");

  overview.release();
  const res = await pending;
  assert.equal(res.ok, true);
  assert.equal(res.kind, "address");
  assert.equal(res.evidence.balanceEth, 1);
  assert.equal(res.evidence.totalTransactions, 12);
  assert.equal(res.evidence.tokenHoldings.length, 1);
  assert.deepEqual(res.evidence.counterparties, [PEER.toLowerCase()]);
  assert.equal(res.degraded, undefined, "the two 404s were the probe, not evidence fields");
});

test("an unreadable token probe still branches on the overview's own token field", async () => {
  const r = recorder();
  // 500, not 404: the indexer did not say "no token here", so the old signal —
  // a populated `token` object on the address overview — has to decide.
  const calls = tokenCalls(r, { getToken: r.call("getToken", { status: 500 }) });
  const res = await gatherEvidence(TOKEN, { calls });
  assert.equal(res.kind, "token");
  assert.equal(res.evidence.token.symbol, "AAPL", "metadata fell back to the overview's copy");
  assert.ok(res.evidence.unavailable.includes("token"));
  assert.equal(res.degraded, true);

  const r2 = recorder();
  const res2 = await gatherEvidence(WALLET, {
    calls: { ...walletCalls(r2), getToken: r2.call("getToken", { status: 500 }), getTokenCounters: r2.call("getTokenCounters", { status: 500 }), getAddress: r2.call("getAddress", { body: walletOverviewBody() }) },
  });
  assert.equal(res2.kind, "address", "no token on the overview means wallet");
});

test("a target nothing can be read about is still a failure, with the old wording", async () => {
  const r = recorder();
  const notFound = await gatherEvidence(WALLET, {
    calls: { ...walletCalls(r), getToken: r.call("getToken", { status: 404 }), getAddress: r.call("getAddress", { status: 404 }) },
  });
  assert.equal(notFound.ok, false);
  assert.equal(notFound.kind, "address");
  assert.match(notFound.error, /not found on Robinhood Chain/);

  const r2 = recorder();
  const brownout = await gatherEvidence(WALLET, {
    calls: { ...walletCalls(r2), getToken: r2.call("getToken", { status: 503 }), getAddress: r2.call("getAddress", { status: 503 }) },
  });
  // An outage must never be reported as "this address does not exist".
  assert.equal(brownout.ok, false);
  assert.equal(brownout.kind, "unavailable");
  assert.match(brownout.error, /did not answer \(HTTP 503\)/);
});

/* ------------------------------ deadlines ------------------------------ */

test("an enrichment call that misses its deadline is reported unavailable, not empty", async () => {
  const r = recorder();
  const calls = tokenCalls(r, { getTokenHolders: r.call("getTokenHolders", { hang: true }) });

  const res = await gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls, deadlines: { essential: 5_000, enrichment: 25 } });

  assert.equal(res.ok, true, "the answer still arrives");
  assert.equal(res.degraded, true);
  assert.ok(res.evidence.unavailable.includes("topHolders"), "named as missing");
  assert.equal(res.evidence.topHolders, null, "null, never [] — an empty list asserts there are no holders");
  assert.equal(res.evidence.holderConcentrationTop10Pct, null, "and never 0%, which would be a claim");
  // The field that timed out is the only casualty.
  assert.ok(Array.isArray(res.evidence.recentTransfers));
  assert.equal(res.evidence.token.symbol, "AAPL");
  assert.ok(!res.evidence.unavailable.includes("token"));
});

test("the enrichment deadline is shorter than the essential one, and only cuts enrichment", async () => {
  const r = recorder();
  const calls = tokenCalls(r, {
    // Slower than the enrichment deadline, faster than the essential one: token
    // metadata is the answer, so it gets to finish.
    getToken: r.call("getToken", { body: tokenBody(), ms: 60 }),
    getTokenActivity: r.call("getTokenActivity", { hang: true }),
  });

  const res = await gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls, deadlines: { essential: 5_000, enrichment: 25 } });
  assert.equal(res.evidence.token.symbol, "AAPL", "the essential call outlived the enrichment deadline");
  assert.ok(res.evidence.unavailable.includes("recentTransfers"));
  assert.equal(res.evidence.recentTransfers, null);
});

test("every call is handed a deadline signal", async () => {
  const seen = [];
  const spy = (name) => (...args) => {
    const last = args[args.length - 1];
    seen.push([name, Boolean(last && typeof last === "object" && last.signal instanceof AbortSignal)]);
    return Promise.resolve({});
  };
  const calls = {
    getToken: spy("getToken"),
    getTokenCounters: spy("getTokenCounters"),
    getTokenHolders: spy("getTokenHolders"),
    getTokenActivity: spy("getTokenActivity"),
    getAddress: spy("getAddress"),
  };
  // An empty body from getToken/getAddress makes this a "not a token after all"
  // gather; what matters is that all five were called with a signal.
  await gatherEvidence(TOKEN, { known: KNOWN_TOKEN, calls: { ...calls, ...walletCalls(recorder()) } });
  assert.equal(seen.length, 5);
  for (const [name, hadSignal] of seen) assert.ok(hadSignal, `${name} was called without a deadline`);
});

/* ------------------------------ no options at all ------------------------------ */

test("gatherEvidence with no options touches nothing it did not touch before", async () => {
  // The junk-options cases must land on the real defaults rather than throwing,
  // because every existing caller passes exactly one argument.
  for (const options of [undefined, null, {}, "hint", 7, { known: undefined, calls: null, deadlines: 0 }]) {
    const res = await gatherEvidence("not a target at all", options);
    assert.equal(res.ok, false);
    assert.equal(res.kind, "unknown");
    assert.match(res.error, /Not a recognizable Robinhood Chain address/);
  }
});

test("the transaction path keeps its shape and puts logs on the enrichment deadline", async () => {
  const r = recorder();
  const hash = `0x${"a".repeat(64)}`;
  const calls = {
    getTransaction: r.call("getTransaction", {
      body: { hash, status: "ok", method: "transfer", from: { hash: WALLET }, to: { hash: PEER }, value: "1000000000000000000", fee: { value: "21000000000000" }, block_number: 42, timestamp: "2026-07-25T00:00:00Z", token_transfers: [] },
      ms: 40,
    }),
    getTransactionLogs: r.call("getTransactionLogs", { hang: true }),
  };

  const res = await gatherEvidence(hash, { calls, deadlines: { essential: 5_000, enrichment: 20 } });
  assert.equal(res.ok, true);
  assert.equal(res.kind, "tx");
  assert.equal(res.valueEth, undefined);
  assert.equal(res.evidence.valueEth, 1);
  assert.equal(res.evidence.feeEth, 0.000021);
  assert.equal(res.evidence.logCount, null, "null, not 0 — a timed-out logs call is not 'no logs'");
  assert.equal(res.evidence.decodedLogs, null);
  assert.ok(res.evidence.unavailable.includes("decodedLogs"));
});
