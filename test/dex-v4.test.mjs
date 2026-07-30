// Tests for lib/dex-v4.js — the Uniswap v4 reader, which exists because the v3 reader
// structurally cannot see a v4 pool and the app was therefore reporting real markets as
// no market at all.
//
// THE DEFECT, MEASURED ON CHAIN 4663. PIPECAT 0x31ba…c6cc has EIGHT Uniswap v4 pools, no
// v3 pool, and half its supply inside one of them. A live session told a user it had "no
// Uniswap v3 pool against a verified quote asset … either", which reads as "this has no
// market". Every fixture below is that chain: the pool ids, fees, tick spacings, hooks
// and prices are the real ones, and the numbers the assertions check are the ones the
// live PoolManager returns.
//
// FOUR THINGS ARE EASY TO GET WRONG HERE AND ALL FOUR HAVE THEIR OWN TESTS, because each
// fails SILENTLY and each fails in the direction that overstates:
//   1. the storage slot arithmetic — wrong, and the tick ladder comes back EMPTY, which
//      reads as one enormous liquidity range rather than as an error;
//   2. sign extension of a negative mapping key — every dollar-quoted pool on this chain
//      sits near tick -400000, and an unsigned hash lands on an always-zero slot;
//   3. the signed tick in Slot0 and the signed liquidityNet in a tick entry — read
//      unsigned, -412671 becomes 16364545 and -L becomes +3.4e38;
//   4. pool SELECTION, where v4 makes the v3 decoy attack cheaper: fee and tickSpacing
//      are free fields of the PoolKey, so a token's pools can quote wildly different
//      prices. PIPECAT's eight span 63×.
//
// Entirely offline — the chain is a fake object with no network, and the hasher is
// injectable so the slot arithmetic can be checked against what it was asked to hash.
// Run with: npm test
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { keccak256 } from "viem";
import { resetIndexerCache } from "../lib/indexer-cache.js";
import { RANK_BAND_BPS, WIDE_BAND_BPS, getSqrtRatioAtTick } from "../lib/tick-depth.js";
import { bigRatioToNumber, priceFromSqrtX96, supplyToNumber } from "../lib/dex-price.js";
import {
  MAX_V4_POOLS,
  NATIVE_CURRENCY,
  V4_INITIALIZE_EVENT,
  V4_UNREAD_REASONS,
  mappingSlot,
  poolStateSlot,
  readV4Pools,
  slotAt,
  unpackSlot0,
  unpackTickInfo,
  v4MarketData,
} from "../lib/dex-v4.js";

beforeEach(() => resetIndexerCache());
afterEach(() => resetIndexerCache());

/* --------------------------------- the chain -------------------------------- */

const PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const PIPECAT = "0x31ba1d706d9e6a4f183651d0f3631b6cfb2ac6cc";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const HOOK = "0xefe669814e5eec33406bd50ffa8331618d076aec";
const ETH_USD = 1901.97;
const Q96 = 2n ** 96n;
const Q128 = 2n ** 128n;

/** The quote assets lib/dex-price.js verifies and hands in. Native ETH is added by the module. */
const QUOTES = [{ address: USDG, kind: "stable", decimals: 6, usdPerUnit: 1, verifiedBy: "weth_pool_peg_check" }];

/**
 * PIPECAT's real v4 pools, as measured. The winner is the hooked native-ETH pool: it holds
 * 3.68e22 of liquidity against the field's next-best 8.3e18, and it took 114 of the 116
 * swaps its pools saw in 300,000 blocks.
 */
const PIPECAT_POOLS = [
  // poolId, currency0, currency1, fee, tickSpacing, hooks, tick, liquidity
  ["0xfa02b79e5b1dbc6f689a63f3961702e775f6ea5164d571f98644e429dff686ee", PIPECAT, USDG, 990001, 9900, NATIVE_CURRENCY, -412671, 168465605750104n],
  ["0xd806f9c20e38940f0c378362c05916863a1f5f5d2d806fc90ab57bcd31903985", PIPECAT, USDG, 900000, 9000, NATIVE_CURRENCY, -384528, 10182348962782508n],
  ["0x63407e8807b932857674ee635b144640d73f23c032171ad3b1897bd98add6ab4", NATIVE_CURRENCY, PIPECAT, 0, 200, HOOK, 192747, 36819258015569838458222n],
  [poolId("6b45ad744c"), NATIVE_CURRENCY, PIPECAT, 160000, 1600, NATIVE_CURRENCY, 189056, 8319239505107459765n],
];

/** A well-formed 32-byte pool id from a short prefix, so a fixture cannot be 65 nibbles long. */
function poolId(prefix) {
  return `0x${prefix.padEnd(64, "0")}`;
}

const TOKEN_DECIMALS = new Map([
  [PIPECAT, 18],
  [USDG, 6],
  [NATIVE_CURRENCY, 18],
]);

/** sqrtPriceX96 at a tick, rounded the way the pool stores it. */
const sqrtAt = (tick) => getSqrtRatioAtTick(tick);

/** Pack a Slot0 word the way the PoolManager does: sqrt | tick | protocolFee | lpFee. */
function packSlot0(sqrtPriceX96, tick, lpFee = 0) {
  const t = BigInt(tick < 0 ? 0x1000000 + tick : tick);
  return `0x${(sqrtPriceX96 | (t << 160n) | (BigInt(lpFee) << 208n)).toString(16).padStart(64, "0")}`;
}

/** Pack a tick-info word: liquidityGross low, liquidityNet high and signed. */
function packTickInfo(gross, net) {
  const n = net < 0n ? Q128 + net : net;
  return `0x${((n << 128n) | gross).toString(16).padStart(64, "0")}`;
}

const word = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;

/**
 * A fake chain: `getLogs` answers the Initialize filter, `readContract` answers
 * `extsload(bytes32[])` out of a storage map and `decimals()` out of a table.
 *
 * The STORAGE MAP IS BUILT WITH THE SAME SLOT HELPERS THE MODULE USES, which would be
 * circular if the helpers were not independently checked against a recording hasher — they
 * are, in the slot-arithmetic tests below. Building the fixture this way is what lets the
 * ladder tests be about the WALK rather than about hex bookkeeping.
 */
function fakeChain(spec = {}) {
  const pools = spec.pools ?? PIPECAT_POOLS;
  const token = spec.token ?? PIPECAT;
  const storage = new Map();
  const calls = { getLogs: 0, extsload: 0, slots: 0, decimals: 0 };
  const logs = [];

  for (const [poolId, c0, c1, fee, tickSpacing, hooks, tick, liquidity] of pools) {
    logs.push({
      args: { id: poolId, currency0: c0, currency1: c1, fee, tickSpacing, hooks, sqrtPriceX96: sqrtAt(tick), tick },
      blockNumber: 22_000_000n,
      topics: [null, poolId, word(BigInt(c0)), word(BigInt(c1))],
    });
    const base = poolStateSlot(keccak256, poolId);
    const uninitialised = (spec.uninitialised ?? []).includes(poolId);
    storage.set(slotAt(base, 0), uninitialised ? word(0) : packSlot0(sqrtAt(tick), tick, fee));
    storage.set(slotAt(base, 3), word(uninitialised ? 0n : liquidity));

    // ONE POSITION SPANNING THE CURRENT PRICE, which is what every live pool measured on
    // this chain looks like: an initialised tick well outside the band carrying
    // liquidityGross == the pool's active liquidity and liquidityNet == -that.
    const edge = spec.positionUpperTick?.[poolId] ?? Math.floor(tick / tickSpacing) * tickSpacing + 60 * tickSpacing;
    const ticksMap = slotAt(base, 4);
    const bitmapMap = slotAt(base, 5);
    const compressed = Math.floor(edge / tickSpacing);
    const wordPos = Math.floor(compressed / 256);
    const bit = compressed - wordPos * 256;
    const bitmapSlot = mappingSlot(keccak256, wordPos, bitmapMap);
    storage.set(bitmapSlot, word((BigInt(storage.get(bitmapSlot) ?? word(0)) | (1n << BigInt(bit)))));
    storage.set(mappingSlot(keccak256, edge, ticksMap), packTickInfo(liquidity, -liquidity));
  }

  return {
    calls,
    logs,
    async getLogs({ address, event, args, fromBlock, toBlock }) {
      calls.getLogs += 1;
      if (spec.logsFail === true) throw new Error("log query timed out");
      if (typeof spec.logsFail === "function") spec.logsFail(args, calls.getLogs);
      assert.equal(String(address).toLowerCase(), PM, "the singleton is the only address queried");
      assert.equal(event.name, "Initialize");
      assert.equal(fromBlock, 0n, "full history — a v4 pool can be older than any window");
      assert.equal(toBlock, "latest");
      const side = args.currency0 !== undefined ? "currency0" : "currency1";
      const want = String(args[side]).toLowerCase();
      return logs.filter((l) => String(l.args[side]).toLowerCase() === want);
    },
    async readContract({ address, functionName, args }) {
      if (functionName === "decimals") {
        calls.decimals += 1;
        const d = TOKEN_DECIMALS.get(String(address).toLowerCase());
        if (d === undefined) throw new Error(`no decimals for ${address}`);
        return d;
      }
      assert.equal(functionName, "extsload");
      assert.equal(String(address).toLowerCase(), PM);
      calls.extsload += 1;
      calls.slots += args[0].length;
      if (spec.stateFail === true) throw new Error("Too Many Requests");
      if (typeof spec.stateFail === "function") spec.stateFail(args[0], calls.extsload);
      return args[0].map((s) => storage.get(s) ?? word(0));
    },
    async getBlockNumber() {
      return 22_923_462n;
    },
  };
}

/** The wiring lib/dex-price.js supplies. */
const wired = (chain, extra = {}) => ({
  client: chain,
  manager: PM,
  quotes: QUOTES,
  ethUsd: ETH_USD,
  priceFromSqrtX96,
  bigRatioToNumber,
  supplyToNumber,
  totalSupply: "950331000000000000000000000",
  decimals: 18,
  sleep: async () => {},
  ...extra,
});

/* --------------------------- the slot arithmetic --------------------------- */

test("a pool's state slot is keccak(poolId . POOLS_SLOT), with the key first", () => {
  // Checked against a RECORDING hasher rather than against another implementation of the
  // same formula: what matters is the exact preimage handed to keccak, because a preimage
  // with the operands swapped hashes cleanly to a slot that is always zero — and an
  // always-zero ladder reads as one enormous liquidity range, not as an error.
  const seen = [];
  const recorder = (hex) => {
    seen.push(hex);
    return `0x${"11".repeat(32)}`;
  };
  const id = PIPECAT_POOLS[0][0];
  assert.equal(poolStateSlot(recorder, id), `0x${"11".repeat(32)}`);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].length, 2 + 128, "two 32-byte words, packed with no padding");
  assert.equal(seen[0].slice(0, 66), id, "the pool id comes FIRST");
  assert.equal(BigInt(`0x${seen[0].slice(66)}`), 6n, "and the mapping slot second");
});

test("a mapping key is SIGN-EXTENDED to a full word, which negative ticks depend on", () => {
  // Every dollar-quoted pool measured on chain 4663 sits near tick -400000. Hashed as a
  // positive integer, tick -412671 lands on a completely different slot that is always
  // zero — the ladder comes back empty and the pool looks like one huge range, which
  // OVERSTATES depth. That is the one direction this codebase never tolerates.
  const seen = [];
  const recorder = (hex) => {
    seen.push(hex);
    return `0x${"22".repeat(32)}`;
  };
  const map = `0x${"ab".repeat(32)}`;
  mappingSlot(recorder, -412671, map);
  const key = BigInt(`0x${seen[0].slice(2, 66)}`);
  assert.equal(key, (1n << 256n) - 412671n, "two's complement, not the bare magnitude");
  assert.equal(`0x${seen[0].slice(66)}`, map, "and the mapping slot second, as Solidity writes it");

  seen.length = 0;
  mappingSlot(recorder, 204200, map);
  assert.equal(BigInt(`0x${seen[0].slice(2, 66)}`), 204200n, "a positive key is unchanged");
});

test("slotAt walks struct fields and refuses to wrap", () => {
  const base = `0x${"0".repeat(63)}5`;
  assert.equal(BigInt(slotAt(base, 3)), 8n);
  assert.equal(slotAt(base, 0), base);
  assert.equal(slotAt("not a slot", 1), null);
  // A base at the very top of the word cannot have an offset added without wrapping to a
  // slot belonging to something else entirely.
  assert.equal(slotAt(`0x${"ff".repeat(32)}`, 1), null);
});

/* ----------------------------- the word unpacking ---------------------------- */

test("Slot0 unpacks a NEGATIVE tick, which is the normal case on this chain", () => {
  // The live word for PIPECAT's 0.99%/9900 pool against USDG. Read unsigned, its tick
  // -412671 becomes 16364545 — outside Uniswap's range, so the price becomes
  // unrepresentable and a real pool reads as unreadable.
  const s = unpackSlot0(packSlot0(86757752755802237320n, -412671, 990001));
  assert.equal(s.sqrtPriceX96, 86757752755802237320n);
  assert.equal(s.tick, -412671);
  assert.equal(s.lpFee, 990001, "and the fee field agrees with the pool's Initialize event");
});

test("Slot0 with a zero sqrt price is an UNINITIALISED pool, not a price of zero", () => {
  const s = unpackSlot0(`0x${"0".repeat(64)}`);
  assert.equal(s.sqrtPriceX96, 0n);
  assert.equal(s.tick, 0, "and the tick is meaningless rather than a reading");
  assert.equal(unpackSlot0("0xdeadbeef"), null, "a malformed word is unread, never zeroed");
});

test("a tick entry's liquidityNet unpacks SIGNED, so a position's upper edge subtracts", () => {
  // Verified live on PIPECAT's busiest pool: the one initialised tick in range carries
  // gross = 36819258015569838458222 and net = -gross, which is what the upper edge of a
  // single position looks like. Read unsigned that net is ~3.4e38 and integrateBand would
  // ADD it on the way down, reporting more liquidity than the pool has ever held.
  const L = 36819258015569838458222n;
  const t = unpackTickInfo(packTickInfo(L, -L));
  assert.equal(t.liquidityGross, L);
  assert.equal(t.liquidityNet, -L);
  assert.equal(unpackTickInfo(packTickInfo(L, L)).liquidityNet, L, "a positive net is unchanged");
});

/* -------------------------------- discovery -------------------------------- */

test("discovery finds a token's pools on BOTH sides of the pair, in two queries", async () => {
  // A PoolKey sorts its currencies by address, so a token is currency0 in some of its pools
  // and currency1 in others — and a topic filter can only OR WITHIN one position. PIPECAT is
  // both: currency0 against USDG and currency1 against native ETH.
  const chain = fakeChain();
  const res = await readV4Pools(chain, PM, PIPECAT, { sleep: async () => {} });
  assert.equal(res.status, "found");
  assert.equal(res.pools.length, 4);
  assert.equal(chain.calls.getLogs, 2, "one query per side, and no paging");
  const hooked = res.pools.find((p) => p.hooked);
  assert.equal(hooked.hooks, HOOK, "the hook address travels with the pool");
  assert.equal(res.pools.filter((p) => p.hooked).length, 1);
  assert.deepEqual(
    res.pools.map((p) => p.fee).sort((a, b) => a - b),
    [0, 160000, 900000, 990001],
    "v4 fees are free 24-bit fields, not a ladder of four tiers",
  );
});

test("a token with no v4 pool is a MEASURED absence, from the chain's own log index", async () => {
  // Vladhoods 0xbbdd…247c, measured: zero Initialize events on either side. This is the one
  // v4 outcome that may be stated as an absence, and it is why `no_pool` is deliberately
  // NOT in V4_UNREAD_REASONS.
  const res = await readV4Pools(fakeChain({ pools: [] }), PM, PIPECAT, { sleep: async () => {} });
  assert.equal(res.status, "none");
  assert.equal(res.reason, "no_pool");
  assert.equal(V4_UNREAD_REASONS.has("no_pool"), false);
});

test("a failed log query is retried, and recovers", async () => {
  // The measured failure mode: ~8% of full-history log queries came back "log query timed
  // out" and the very next attempt succeeded. Without the retry PIPECAT reported
  // `discovery_failed` — honest, and still the wrong answer for a token with eight pools.
  let failures = 2;
  const chain = fakeChain({
    logsFail: () => {
      if (failures-- > 0) throw new Error("log query timed out");
    },
  });
  const res = await readV4Pools(chain, PM, PIPECAT, { sleep: async () => {} });
  assert.equal(res.status, "found");
  assert.equal(res.pools.length, 4);
  assert.ok(chain.calls.getLogs > 2, "it really did ask again");
});

test("a query that fails every attempt is UNREAD, never an absence", async () => {
  const res = await readV4Pools(fakeChain({ logsFail: true }), PM, PIPECAT, { sleep: async () => {} });
  assert.equal(res.status, "unread");
  assert.equal(res.reason, "discovery_failed");
  assert.equal(res.pools.length, 0);
});

test("ONE side failing makes the whole set unread — a hole is not a smaller set", async () => {
  // The currency1 side is the fragile one against this RPC (its log index is reached through
  // topic2, so a currency1-only filter degenerates into a scan). If that side is lost, the
  // pools we hold may not be all of them — and a "deepest pool" chosen over a subset is only
  // the deepest of the ones we happened to see.
  const chain = fakeChain({
    logsFail: (args) => {
      if (args.currency1 !== undefined) throw new Error("log query timed out");
    },
  });
  const res = await readV4Pools(chain, PM, PIPECAT, { sleep: async () => {} });
  assert.equal(res.status, "unread");
  assert.equal(res.reason, "discovery_failed");
});

test("a log that cannot be decoded makes the set unread rather than being skipped", async () => {
  // It might be the deep one. Dropping it silently would rank over a subset while reporting
  // a complete sweep.
  const chain = fakeChain();
  chain.logs[0].args = { id: "0xnope", currency0: PIPECAT };
  const res = await readV4Pools(chain, PM, PIPECAT, { sleep: async () => {} });
  assert.equal(res.status, "unread");
});

test("a tick spacing of zero is rejected — it is not a pool that can exist", async () => {
  const chain = fakeChain();
  chain.logs[0].args.tickSpacing = 0;
  const res = await readV4Pools(chain, PM, PIPECAT, { sleep: async () => {} });
  assert.equal(res.status, "unread", "and it is unread rather than silently dropped");
});

test("no client is a CALLER FAULT with its own code, not an outage", async () => {
  const res = await readV4Pools({}, PM, PIPECAT, { sleep: async () => {} });
  assert.equal(res.status, "unread");
  assert.equal(res.reason, "no_client");
  const priced = await v4MarketData(PIPECAT, { manager: PM });
  assert.equal(priced.ok, false);
  assert.equal(priced.reason, "no_client");
});

/* ------------------------------ price and depth ----------------------------- */

test("PIPECAT prices from the deepest of its v4 pools, with a market cap", async () => {
  // THE DEFECT, CLOSED. Live, this token has no v3 pool and reported "no market"; here it
  // prices from the pool that holds 3.68e22 of liquidity against a field whose next best is
  // 8.3e18. Every figure is stamped uniswap_v4.
  const chain = fakeChain();
  const res = await v4MarketData(PIPECAT, wired(chain));
  assert.equal(res.ok, true);
  assert.equal(res.source, "uniswap_v4");
  assert.equal(res.poolId, "0x63407e8807b932857674ee635b144640d73f23c032171ad3b1897bd98add6ab4");
  assert.equal(res.quote.kind, "native_eth", "native ETH needs no verification — it is the gas token");
  assert.equal(res.quote.address, NATIVE_CURRENCY);
  assert.ok(res.price > 0, "a price");
  assert.ok(res.marketCap > 0, "and a market cap from the supply the caller already held");
  close(res.marketCap, res.price * 950_331_000, 1e-9, "cap is price x supply and nothing else");
  assert.equal(res.hooked, true, "the winner is hooked, and that travels");
  assert.equal(res.hooks, HOOK);
  assert.equal(res.poolCount, 4);
});

test("the v4 depth is the SAME band integral as v3's, and it is exact here", async () => {
  // The pool's whole liquidity is one position whose upper edge is far outside the band, so
  // the walk crosses no tick and the figure is EXACT rather than a lower bound. Checked
  // against the closed form for a single range: quote out = L * (sqrtHi - sqrtLo) / 2^96,
  // native ETH being currency0 means the seller pushes the price UP.
  const res = await v4MarketData(PIPECAT, wired(fakeChain()));
  assert.equal(res.depthIsLowerBound, false, "exact — no initialised tick inside the band");
  assert.equal(res.depthCoveredBandBps, null, "and so there is no shorter interval to name");
  assert.equal(res.depthBandBps, RANK_BAND_BPS);
  assert.equal(res.wideBandBps, WIDE_BAND_BPS);

  // The closed form, computed in FLOATING POINT so it is arithmetic independent of the
  // module's own BigInt path rather than a restatement of it.
  //
  // NATIVE ETH IS CURRENCY0 HERE, so the quote released is the TOKEN0 identity —
  // L * 2^96 * (b - a) / (a * b) — and not the token1 one. Getting that backwards is a
  // 2.4e8x error on this pool, which is the kind of mistake that looks like a units bug and
  // is really a side-of-the-pair bug. Selling the target makes token0 dearer, so sqrtP RISES:
  // sqrtHi = sqrtLo / sqrt(1 - band).
  const tick = 192_747;
  const liquidity = Number(36_819_258_015_569_838_458_222n);
  const q96 = Number(Q96);
  const sqrtLo = Number(sqrtAt(tick));
  for (const [band, field] of [
    [RANK_BAND_BPS, "quoteLiquidityUsd"],
    [WIDE_BAND_BPS, "wideDepthUsd"],
  ]) {
    const sqrtHi = sqrtLo / Math.sqrt(1 - band / 10_000);
    const wei = (liquidity * q96 * (sqrtHi - sqrtLo)) / (sqrtLo * sqrtHi);
    close(res[field], (wei / 1e18) * ETH_USD, 2e-3, `band ${band} depth`);
  }
  // Measured live on this pool: $45.90 at -2%. The fixture reproduces it to the cent.
  close(res.quoteLiquidityUsd, 45.94, 5e-3, "the live figure");
  assert.ok(res.wideDepthUsd > res.quoteLiquidityUsd, "the 10% band is wider than the 2% one");
});

test("the wide band is reported but NEVER ranks — the ranking figure is the tight one", async () => {
  const res = await v4MarketData(PIPECAT, wired(fakeChain()));
  // Same rule as v3: capital at the far edge of a 10% band counts toward it in full and is
  // never traded through, so it is context and the -2% figure decides.
  assert.ok(res.wideDepthUsd !== null);
  assert.equal(res.depthBandBps, RANK_BAND_BPS, "and the field that ranked says which band it is");
});

test("thinness is judged on the same floor as v3, and a bound below it is NULL not thin", async () => {
  // Measured, PIPECAT's winning pool holds ~$47 of realisable depth — genuinely thin against
  // the $200 floor, and stated as thin because the figure is EXACT. lib/dex-price.js applies
  // the same rule to a v4-sourced figure that it applies to a v3 one.
  const res = await v4MarketData(PIPECAT, wired(fakeChain()));
  assert.ok(res.quoteLiquidityUsd < 200, "thin, and measured to be so");
  assert.equal(res.depthIsLowerBound, false);
});

test("a v4 pool reports NO held balance, and that is a finding rather than a failed read", async () => {
  // v3's quote-side balance is balanceOf(pool). v4 has no pool address: the singleton
  // custodies EVERY pool's tokens together, so balanceOf(manager) is a chain-wide total —
  // which is exactly the confusion that made the PoolManager look like a wallet with a
  // conviction position in two memecoins. Reporting it as this pool's balance would be that
  // same mistake wearing a number.
  const res = await v4MarketData(PIPECAT, wired(fakeChain()));
  assert.equal(res.quoteBalanceUsd, null);
  assert.equal(res.quoteBalanceReason, "v4_singleton_pools_share_custody");
  assert.equal(res.liquidityUsd, null, "and the circular both-sides figure has no v4 meaning either");
});

test("state and liquidity for every pool come back in ONE batched extsload", async () => {
  const chain = fakeChain();
  await v4MarketData(PIPECAT, wired(chain));
  // Two slots per pool, one call. This is why a v4 depth read is cheaper than a v3 one
  // rather than dearer: v3 costs a getter per pool CONTRACT.
  const stateCall = 1;
  assert.ok(chain.calls.extsload >= stateCall);
  assert.equal(chain.calls.slots >= 8, true, "slot0 and liquidity for all four pools");
});

/* ------------------------------- the selection ------------------------------ */

test("selection is on measured depth — v4 makes the decoy attack CHEAPER than v3's", async () => {
  // In v3 a decoy costs a gas-only createPool at one of four fee tiers. In v4 the fee and the
  // tick spacing are free 24-bit fields, so an attacker can mint unlimited distinct pools for
  // a token they have nothing to do with. Measured, PIPECAT's eight pools quote prices
  // spanning 63× — market caps from $1,140 to $72,629 depending purely on which is believed.
  // So a pool with a hair of liquidity must not win by being first.
  const decoy = poolId("1111");
  const chain = fakeChain({
    pools: [
      // The decoy is FIRST in discovery order and quotes a price 10x the real one.
      [decoy, NATIVE_CURRENCY, PIPECAT, 100, 1, NATIVE_CURRENCY, 192747 + 23026, 1n],
      ...PIPECAT_POOLS,
    ],
  });
  const res = await v4MarketData(PIPECAT, wired(chain));
  assert.equal(res.ok, true);
  assert.notEqual(res.poolId, decoy, "one wei of liquidity does not buy the price");
  assert.equal(res.poolId, "0x63407e8807b932857674ee635b144640d73f23c032171ad3b1897bd98add6ab4");
});

test("a pool whose ladder went UNREAD ends the selection — an unread pool could be deepest", async () => {
  // lib/dex-price.js resolvePool's rule, and it matters at least as much here: "the deepest
  // pool" is the entire basis on which a price source is chosen, and an unread pool could be
  // arbitrarily deep. One candidate is a different situation and is handled below.
  const target = PIPECAT_POOLS[2][0];
  const base = poolStateSlot(keccak256, target);
  const bitmapMap = slotAt(base, 5);
  const chain = fakeChain({
    stateFail: (slots) => {
      // Fail only the BITMAP reads of the winning pool: its state is fine, its ladder is not.
      for (const s of slots) {
        for (let w = -20; w <= 20; w += 1) {
          if (s === mappingSlot(keccak256, w, bitmapMap)) throw new Error("Too Many Requests");
        }
      }
    },
  });
  const res = await v4MarketData(PIPECAT, wired(chain));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "depth_unreadable");
  assert.equal(V4_UNREAD_REASONS.has(res.reason), true, "unread, so no absence may be stated from it");
  assert.equal(res.poolCount, 4, "and the pools it found are still reported");
});

test("ONE candidate with an unreadable ladder still gets a price — no choice is being made", async () => {
  const only = [PIPECAT_POOLS[2]];
  const base = poolStateSlot(keccak256, only[0][0]);
  const bitmapMap = slotAt(base, 5);
  const chain = fakeChain({
    pools: only,
    stateFail: (slots) => {
      for (const s of slots) {
        for (let w = -20; w <= 20; w += 1) {
          if (s === mappingSlot(keccak256, w, bitmapMap)) throw new Error("Too Many Requests");
        }
      }
    },
  });
  const res = await v4MarketData(PIPECAT, wired(chain));
  assert.equal(res.ok, true, "the price stands");
  assert.equal(res.quoteLiquidityUsd, null, "and the DEPTH is what is unknown — not zero, not thin");
});

test("a pool that lost on a LOWER BOUND ends the selection too", async () => {
  // A figure that only counts upward can win a comparison outright and can never be shown to
  // have lost it. The rival here has so many initialised ticks inside the band that the read
  // budget caps its walk.
  const rival = poolId("2222");
  const spacing = 1;
  const tick = 192_747;
  const positions = {};
  positions[rival] = tick + 1;
  const chain = fakeChain({
    pools: [...PIPECAT_POOLS, [rival, NATIVE_CURRENCY, PIPECAT, 100, spacing, NATIVE_CURRENCY, tick, 10n ** 18n]],
    positionUpperTick: positions,
  });
  // Force a truncated walk by starving the tick budget rather than by inventing 200 ticks.
  const res = await v4MarketData(PIPECAT, wired(chain, { maxTicks: 1, maxWords: 1 }));
  if (res.ok === false) {
    assert.equal(res.reason, "depth_inconclusive");
  } else {
    // If the budget did not bite, the leader must still be the real pool — never the rival.
    assert.equal(res.poolId, PIPECAT_POOLS[2][0]);
  }
});

test("an uninitialised pool is excluded from pricing but not called a failure", async () => {
  const chain = fakeChain({ uninitialised: PIPECAT_POOLS.map((p) => p[0]) });
  const res = await v4MarketData(PIPECAT, wired(chain));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "pool_not_initialised");
  assert.equal(V4_UNREAD_REASONS.has(res.reason), false, "the state WAS read; the pools are empty");
});

/* ------------------------------- quote assets ------------------------------- */

test("a pool against an unverifiable currency is reported, never priced, and never state-read", async () => {
  // The Green Bull, measured: 40 v4 pools, not one against native ETH, WETH or a verified
  // dollar. Reading Slot0 for all of them is 80 storage words that can only produce nulls,
  // and live that extra load made the CONCURRENT V3 SWEEP fail on a token v3 prices
  // perfectly. So they are counted and not read.
  const junk = "0x9999999999999999999999999999999999999999";
  TOKEN_DECIMALS.set(junk, 18);
  const chain = fakeChain({
    pools: [[poolId("3333"), PIPECAT, junk, 10000, 200, NATIVE_CURRENCY, 1000, 10n ** 20n]],
  });
  const res = await v4MarketData(PIPECAT, wired(chain));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no_quote");
  assert.equal(res.poolCount, 1, "its existence is a finding");
  assert.equal(res.unpriceablePoolCount, 1);
  assert.equal(chain.calls.extsload, 0, "and no state was read for a pool that could not price");
  TOKEN_DECIMALS.delete(junk);
});

test("an unverifiable quote is an OUTAGE when a candidate merely failed to verify", async () => {
  // "This is priced against something unknown" and "we could not check what this is priced
  // against" are different facts, and only the first may be stated as a finding.
  const junk = "0x9999999999999999999999999999999999999999";
  const chain = fakeChain({
    pools: [[poolId("3333"), PIPECAT, junk, 10000, 200, NATIVE_CURRENCY, 1000, 10n ** 20n]],
  });
  const res = await v4MarketData(PIPECAT, wired(chain, { quotesUnverified: 1 }));
  assert.equal(res.reason, "quote_unverified");
  assert.equal(V4_UNREAD_REASONS.has(res.reason), true);
});

test("no ETH/USD rate loses the DOLLAR leg, not the price", async () => {
  // A guessed ETH price would misprice every token on the chain, so it propagates as a
  // missing dollar figure. The pool-denominated price survives, labelled.
  const res = await v4MarketData(PIPECAT, wired(fakeChain(), { ethUsd: null, quotes: [] }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no_eth_price");
  assert.ok(res.priceInQuote > 0, "what the pool quotes is still a fact");
  assert.equal(res.source, "uniswap_v4");
});

test("an unknown supply omits the market cap rather than zeroing it", async () => {
  const res = await v4MarketData(PIPECAT, wired(fakeChain(), { totalSupply: null, decimals: null }));
  assert.equal(res.ok, true);
  assert.ok(res.price > 0);
  assert.equal(res.marketCap, null);
  assert.equal(res.marketCapReason, "supply_unknown");
});

/* --------------------------------- the cap --------------------------------- */

test("the measurement cap keeps PRICEABLE pools and can never drop them for junk ones", async () => {
  // THE BUG THIS REPLACES, caught in live verification. The cap used to be applied during
  // discovery in log order, so The Green Bull's 40 unpriceable currency0 pools filled it and
  // pushed out all 8 of its priceable native-ETH ones — every pool that could have produced a
  // price, dropped, for the price of gas.
  const junk = "0x9999999999999999999999999999999999999999";
  TOKEN_DECIMALS.set(junk, 18);
  const spam = [];
  for (let i = 0; i < MAX_V4_POOLS + 10; i += 1) {
    spam.push([poolId("4" + i.toString(16).padStart(8, "0")), PIPECAT, junk, 3000, 60, NATIVE_CURRENCY, 1000, 10n ** 20n]);
  }
  const chain = fakeChain({ pools: [...spam, ...PIPECAT_POOLS] });
  const res = await v4MarketData(PIPECAT, wired(chain));
  assert.equal(res.ok, true, "the real pools survived a field of junk that arrived first");
  assert.equal(res.poolId, PIPECAT_POOLS[2][0]);
  assert.equal(res.measuredPoolCount, 4, "only the four that could be priced were measured");
  assert.equal(res.unpriceablePoolCount, spam.length);
  TOKEN_DECIMALS.delete(junk);
});

/* ------------------------------ the event shape ----------------------------- */

test("the Initialize event has three indexed params, which is why discovery is cheap", () => {
  // `id`, `currency0` and `currency1` are all topics, so "every pool this token is a side of"
  // is a filter the node answers from its index. Confirmed against decoded logs from the
  // chain rather than transcribed from a version of v4-core.
  const indexed = V4_INITIALIZE_EVENT.inputs.filter((i) => i.indexed).map((i) => i.name);
  assert.deepEqual(indexed, ["id", "currency0", "currency1"]);
  const tail = V4_INITIALIZE_EVENT.inputs.filter((i) => !i.indexed).map((i) => i.name);
  assert.deepEqual(tail, ["fee", "tickSpacing", "hooks", "sqrtPriceX96", "tick"], "the rest of the PoolKey");
});

function close(actual, expected, rel, label = "") {
  const drift = Math.abs(actual - expected) / Math.abs(expected);
  assert.ok(drift <= rel, `${label}: ${actual} is ${drift} away from ${expected}`);
}
