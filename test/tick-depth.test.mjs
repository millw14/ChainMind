// Tests for lib/tick-depth.js — the v3 tick-ladder integral that replaced
// min(pool balance, the reserve implied by liquidity()) as the depth measure.
//
// WHY THE OLD MEASURE HAD TO GO, in one line: its two halves were computed over
// DISJOINT SETS OF POSITIONS — the balance covers every position, in range and out;
// liquidity() covers only the ones spanning the current tick — so their minimum
// bounded neither, and two positions in one pool defeated it. Measured, parking
// 14 WETH behind a $3.94 pool flipped the VLAD verdict and named the squatter the
// winner, for about $2.96 a day of opportunity cost.
//
// The arithmetic below is checked against Uniswap's own identities rather than
// against itself: getSqrtRatioAtTick is compared with 1.0001^tick, and the band
// integral is compared with the closed form for a single range, which is the only
// case where a closed form exists.
//
// Entirely offline — the reader is a fake with no network. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TICKS_READ,
  MAX_TICK_WORDS,
  RANK_BAND_BPS,
  WIDE_BAND_BPS,
  bandSqrtBound,
  getSqrtRatioAtTick,
  integrateBand,
  measureBandDepth,
  readTickLadder,
} from "../lib/tick-depth.js";

const Q96 = 2n ** 96n;
const POOL = "0x00000000000000000000000000000000000000aa";

/**
 * A BigInt Q96 value as a plain number, for comparing against float identities.
 * Both sides are cast BEFORE dividing: a fixed-point rescale in BigInt would floor
 * the ratio at the bottom of the tick range, where sqrt(1.0001^-887272) is 5.4e-20.
 */
const asFloat = (x) => Number(x) / Number(Q96);

function close(actual, expected, rel, label = "") {
  const drift = Math.abs(actual - expected) / Math.abs(expected);
  assert.ok(drift <= rel, `${label} ${actual} is ${drift} away from ${expected}`);
}

/* ------------------------------- tick math -------------------------------- */

test("getSqrtRatioAtTick is Uniswap's, not an approximation of it", () => {
  assert.equal(getSqrtRatioAtTick(0), Q96, "tick 0 is exactly 1.0");
  for (const tick of [1, -1, 60, -60, 153_780, -153_780, 887_272, -887_272]) {
    const ratio = asFloat(getSqrtRatioAtTick(tick));
    close(ratio, Math.sqrt(1.0001 ** tick), 1e-6, `tick ${tick}`);
  }
  // Outside the representable range is NULL, never a clamp — a clamped tick would
  // silently integrate a band that does not exist.
  assert.equal(getSqrtRatioAtTick(887_273), null);
  assert.equal(getSqrtRatioAtTick(-887_273), null);
  assert.equal(getSqrtRatioAtTick(1.5), null);
});

test("the band bound is sqrt(1 - band) in the direction the seller pushes the price", () => {
  const p = getSqrtRatioAtTick(0);
  // Quote is token1: the target is token0 and selling it pushes sqrtP DOWN.
  const down = bandSqrtBound(p, 1000, false);
  close(asFloat(down) ** 2, 0.9, 1e-9, "-10% down");
  // Quote is token0: the target is token1 and the same 10% loss pushes sqrtP UP.
  const up = bandSqrtBound(p, 1000, true);
  close(asFloat(up) ** 2, 1 / 0.9, 1e-9, "-10% up");
  close(asFloat(bandSqrtBound(p, 200, false)) ** 2, 0.98, 1e-9, "-2% down");
  // A band of nothing, or of everything, is not a band.
  assert.equal(bandSqrtBound(p, 0, true), null);
  assert.equal(bandSqrtBound(p, 10_000, true), null);
  assert.equal(bandSqrtBound(0n, 1000, true), null);
});

/* ------------------------------ the integral ------------------------------ */

test("one range wider than the band integrates to the closed form, both directions", () => {
  // The only case with a closed form: L constant across the whole band.
  //   token0 out = L·2^96·(b-a)/(a·b)     token1 out = L·(b-a)/2^96
  const L = 10n ** 20n;
  const sqrtP = getSqrtRatioAtTick(0);

  const up = bandSqrtBound(sqrtP, WIDE_BAND_BPS, true);
  const amount0 = integrateBand({ sqrtPriceX96: sqrtP, tick: 0, liquidity: L, ticks: [], sqrtBound: up, quoteIsToken0: true });
  assert.equal(amount0, (L * Q96 * (up - sqrtP)) / (sqrtP * up));

  const down = bandSqrtBound(sqrtP, WIDE_BAND_BPS, false);
  const amount1 = integrateBand({ sqrtPriceX96: sqrtP, tick: 0, liquidity: L, ticks: [], sqrtBound: down, quoteIsToken0: false });
  assert.equal(amount1, (L * (sqrtP - down)) / Q96);
});

test("A HAIR-WIDTH POSITION CONTRIBUTES ONLY WHAT IT HOLDS — the F2 half that inflated", () => {
  // A one-tick position carries an enormous L because L is liquidity per unit of
  // sqrt-price. Extrapolating that L across the curve is what reported $366,525 of
  // "in-range" depth behind a pool holding $3.94. The walk stops at the position's
  // UPPER tick, so it can only ever contribute the amount that range really holds.
  const L = 10n ** 24n;
  const sqrtP = getSqrtRatioAtTick(0);
  const upper = getSqrtRatioAtTick(1);
  const bound = bandSqrtBound(sqrtP, WIDE_BAND_BPS, true);

  const hair = integrateBand({
    sqrtPriceX96: sqrtP,
    tick: 0,
    liquidity: L,
    ticks: [{ tick: 1, liquidityNet: -L }],
    sqrtBound: bound,
    quoteIsToken0: true,
  });
  // Exactly the one-tick range, and nothing past it.
  assert.equal(hair, (L * Q96 * (upper - sqrtP)) / (sqrtP * upper));

  // The extrapolation the old measure would have taken: L across the whole band.
  const extrapolated = (L * Q96 * (bound - sqrtP)) / (sqrtP * bound);
  assert.ok(extrapolated / hair > 500n, `the ladder reports ${extrapolated / hair}× less`);
});

test("CAPITAL PARKED OUTSIDE THE BAND IS NEVER REACHED — the F2 half that was rentable", () => {
  // A position whose range is entirely above the current tick holds 100% token0,
  // contributes nothing to liquidity(), and sits in balanceOf. Outside the band the
  // integration simply never gets to it; inside the band it counts, because there a
  // seller can trade against it. That is the whole trade the band makes.
  const L = 10n ** 20n;
  const sqrtP = getSqrtRatioAtTick(0);
  const bound = bandSqrtBound(sqrtP, WIDE_BAND_BPS, true);
  const parkedFar = { tick: 5_000, liquidityNet: L * 1_000n };
  const parkedNear = { tick: 200, liquidityNet: L * 1_000n };

  const far = integrateBand({ sqrtPriceX96: sqrtP, tick: 0, liquidity: L, ticks: [parkedFar], sqrtBound: bound, quoteIsToken0: true });
  const none = integrateBand({ sqrtPriceX96: sqrtP, tick: 0, liquidity: L, ticks: [], sqrtBound: bound, quoteIsToken0: true });
  assert.equal(far, none, "5,000 ticks away is ~65% away: outside the band, uncounted");

  const near = integrateBand({ sqrtPriceX96: sqrtP, tick: 0, liquidity: L, ticks: [parkedNear], sqrtBound: bound, quoteIsToken0: true });
  assert.ok(near > none * 100n, "and inside the band it is depth, because it is exposed");
});

test("an incoherent ladder is null, never a floored guess", () => {
  const L = 10n ** 20n;
  const sqrtP = getSqrtRatioAtTick(0);
  const bound = bandSqrtBound(sqrtP, WIDE_BAND_BPS, true);
  // Crossing up out of more liquidity than is active is not a state a pool can be
  // in. Flooring it at zero would quote a figure derived from an impossible read.
  assert.equal(
    integrateBand({ sqrtPriceX96: sqrtP, tick: 0, liquidity: L, ticks: [{ tick: 10, liquidityNet: -L * 2n }], sqrtBound: bound, quoteIsToken0: true }),
    null,
  );
  assert.equal(integrateBand({ sqrtPriceX96: 0n, tick: 0, liquidity: L, ticks: [], sqrtBound: bound, quoteIsToken0: true }), null);
  assert.equal(integrateBand(null), null);
});

/* -------------------------------- the reads ------------------------------- */

/**
 * A pool reader backed by declared positions, the same shape the dex-price fixtures
 * use. `fail` names a function that throws instead of answering.
 */
function ladderClient({ spacing = 60, positions = [], fail = null } = {}) {
  const net = new Map();
  for (const p of positions) {
    net.set(p.lower, (net.get(p.lower) ?? 0n) + BigInt(p.liquidity));
    net.set(p.upper, (net.get(p.upper) ?? 0n) - BigInt(p.liquidity));
  }
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async readContract({ functionName, args }) {
      calls += 1;
      if (functionName === fail) throw new Error(`fake failure: ${functionName}`);
      if (functionName === "tickSpacing") return spacing;
      if (functionName === "tickBitmap") {
        let bits = 0n;
        for (const t of net.keys()) {
          const compressed = Math.floor(t / spacing);
          if (Math.floor(compressed / 256) !== Number(args[0])) continue;
          bits |= 1n << BigInt(((compressed % 256) + 256) % 256);
        }
        return bits;
      }
      if (functionName === "ticks") return [0n, net.get(Number(args[0])) ?? 0n, 0n, 0n, 0n, 0n, 0, true];
      throw new Error(`unhandled ${functionName}`);
    },
  };
}

test("the ladder read returns every initialised tick inside the band and nothing else", async () => {
  const client = ladderClient({
    positions: [
      { lower: -600, upper: 600, liquidity: 10n ** 20n },
      { lower: 60_000, upper: 60_060, liquidity: 10n ** 20n }, // far outside
    ],
  });
  const ladder = await readTickLadder(client, POOL, { currentTick: 0, tickSpacing: 60, tickLow: 0, tickHigh: 1_200 });
  assert.deepEqual(ladder.ticks.map((t) => t.tick), [600]);
  assert.equal(ladder.ticks[0].liquidityNet, -(10n ** 20n), "int128 comes back SIGNED, not 2^128 short");
  assert.equal(ladder.truncated, false, "the whole band fitted, so the figure is exact");
  assert.equal(ladder.coverLow, 0);
  assert.equal(ladder.coverHigh, 1_200);
});

test("ONE UNREADABLE WORD IS AN UNREADABLE LADDER — null, never a partial integral", async () => {
  for (const broken of ["tickBitmap", "ticks", null]) {
    const client = ladderClient({ positions: [{ lower: -600, upper: 600, liquidity: 10n ** 20n }], fail: broken });
    const ladder = await readTickLadder(client, POOL, { currentTick: 0, tickSpacing: 60, tickLow: 0, tickHigh: 1_200 });
    if (broken === null) assert.ok(Array.isArray(ladder?.ticks), "the control case reads fine");
    else assert.equal(ladder, null, `${broken}: a half-read ladder is not a measurement`);
  }
});

test("A READ BUDGET CAPS THE RANGE AND NAMES IT — it does not cancel the measurement", async () => {
  // THE G1 PRIMITIVE, AT THE LOWEST LEVEL. Both of these used to return null, and an
  // attacker could produce the second on someone else's pool with dust mints alone.
  // A refusal is a state an attacker can choose; a lower bound over a stated range is
  // not, because it can only ever be shortened.

  // Too many words: at spacing 1 a word covers 256 ticks, so a 100,000-tick request
  // is past MAX_TICK_WORDS. The words nearest SPOT are the ones read.
  const client = ladderClient({ spacing: 1 });
  const wide = await readTickLadder(client, POOL, { currentTick: 0, tickSpacing: 1, tickLow: 0, tickHigh: 100_000 });
  assert.equal(wide.truncated, true);
  assert.equal(wide.coverLow, 0, "coverage is anchored at spot");
  assert.equal(wide.coverHigh, MAX_TICK_WORDS * 256 - 1, "and runs to the last tick of the last word read");
  assert.ok(MAX_TICK_WORDS >= 6, "six words covers a 10% band at the finest spacing");

  // Too many ticks: more positions in the covered range than the budget reads. The
  // ones NEAREST SPOT are kept, and coverage stops at the first one dropped.
  const crowded = ladderClient({
    spacing: 1,
    positions: Array.from({ length: MAX_TICKS_READ }, (_, i) => ({ lower: i * 2 + 1, upper: i * 2 + 2, liquidity: 1n })),
  });
  const capped = await readTickLadder(crowded, POOL, { currentTick: 0, tickSpacing: 1, tickLow: 0, tickHigh: 250 });
  assert.equal(capped.truncated, true, "read, over a shorter range — not unmeasured");
  assert.equal(capped.ticks.length, MAX_TICKS_READ);
  assert.deepEqual(
    capped.ticks.map((t) => t.tick),
    Array.from({ length: MAX_TICKS_READ }, (_, i) => i + 1),
    "nearest spot first, contiguously",
  );
  assert.equal(capped.coverHigh, MAX_TICKS_READ + 1, "coverage runs up to the first tick we could not afford");
});

test("the DOWNWARD walk truncates on the near side too, never the far one", async () => {
  // Quote as token1 means the seller pushes the price DOWN, so spot is tickHigh and
  // "outward" is decreasing. Truncating the wrong end would drop the ticks nearest
  // the market — the only ones a seller actually reaches.
  const client = ladderClient({ spacing: 1 });
  const down = await readTickLadder(client, POOL, { currentTick: 0, tickSpacing: 1, tickLow: -100_000, tickHigh: 0 });
  assert.equal(down.truncated, true);
  assert.equal(down.coverHigh, 0, "coverage is anchored at spot");
  // Words 0, -1 … -7 are read; word -7 begins at tick -1792.
  assert.equal(down.coverLow, -(MAX_TICK_WORDS - 1) * 256, "and runs down to the first tick of the last word read");
});

test("both bands come out of ONE ladder read, and an unreadable one is null throughout", async () => {
  const client = ladderClient({ positions: [{ lower: -6_000, upper: 6_000, liquidity: 10n ** 20n }] });
  const state = { sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, liquidity: 10n ** 20n, tickSpacing: 60, quoteIsToken0: true };
  const before = client.calls;
  const bands = await measureBandDepth(client, POOL, state);
  assert.ok(bands.amounts[WIDE_BAND_BPS] > bands.amounts[RANK_BAND_BPS], "the wider band reaches more");
  assert.equal(bands.lowerBound[WIDE_BAND_BPS], false, "nothing was capped, so nothing is a bound");
  assert.equal(bands.lowerBound[RANK_BAND_BPS], false);
  assert.ok(client.calls - before <= 4, `one word plus its ticks, not a crawl (${client.calls - before} reads)`);

  const broken = ladderClient({ positions: [{ lower: -6_000, upper: 6_000, liquidity: 10n ** 20n }], fail: "tickBitmap" });
  assert.equal(await measureBandDepth(broken, POOL, state), null, "null, and never a zero");
  // A pool state that was never read is not a pool with no depth.
  assert.equal(await measureBandDepth(client, POOL, { ...state, liquidity: null }), null);
  assert.equal(await measureBandDepth(client, POOL, { ...state, tickSpacing: 0 }), null);
});

test("A GENUINELY FAILED READ IS STILL NULL — truncation and failure are not the same thing", async () => {
  // The distinction the whole fix rests on. A budget that was REACHED is a read that
  // happened over a shorter range; a call that THREW is a read that did not happen,
  // and no lower bound can be claimed from it because nothing was summed.
  const state = { sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, liquidity: 10n ** 20n, tickSpacing: 1, quoteIsToken0: true };
  const positions = Array.from({ length: 90 }, (_, i) => ({ lower: i * 2 + 1, upper: i * 2 + 2, liquidity: 1n }));

  const capped = await measureBandDepth(ladderClient({ spacing: 1, positions }), POOL, state);
  assert.ok(capped !== null, "over budget is measured, over a stated range");
  assert.equal(capped.ladderTruncated, true);

  for (const broken of ["tickBitmap", "ticks"]) {
    const dead = await measureBandDepth(ladderClient({ spacing: 1, positions, fail: broken }), POOL, state);
    assert.equal(dead, null, `${broken}: a read that did not happen has no lower bound to report`);
  }
});

test("DUST MINTED INTO A POOL CAN ONLY CAP THE FIGURE, NEVER INVERT AN ORDERING", async () => {
  // THE G1 ATTACK, MEASURED. 71 dust positions at the finest spacing used to push a
  // victim's pool past MAX_TICKS_READ and demote it to UNMEASURED, at which point
  // whatever else answered took the ranking. Now the victim reports a lower bound.
  const L = 10n ** 20n;
  const state = { sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, liquidity: L, tickSpacing: 1, quoteIsToken0: true };
  // One real, wide position — the honest pool — plus 71 one-tick dust mints on top
  // of it, each of them carrying a liquidity of 1 wei.
  const dust = Array.from({ length: 71 }, (_, i) => ({ lower: i * 2 + 1, upper: i * 2 + 2, liquidity: 1n }));
  const clean = await measureBandDepth(ladderClient({ spacing: 1, positions: [{ lower: -50_000, upper: 50_000, liquidity: L }] }), POOL, state);
  const griefed = await measureBandDepth(
    ladderClient({ spacing: 1, positions: [{ lower: -50_000, upper: 50_000, liquidity: L }, ...dust] }),
    POOL,
    state,
  );

  assert.ok(griefed !== null, "NOT unmeasured — that was the whole primitive");
  assert.equal(griefed.ladderTruncated, true, "the budget was reached, and it says so");
  assert.equal(griefed.lowerBound[RANK_BAND_BPS], true, "and the figure is labelled as a floor");
  const capped = griefed.amounts[RANK_BAND_BPS];
  assert.ok(capped > 0n, "a lower bound, not a zero");
  assert.ok(capped <= clean.amounts[RANK_BAND_BPS], "a cap understates; it can never overstate");

  // The point of the whole exercise: what survives still buries a dust decoy. The
  // decoy reports IN FULL and is not close.
  const decoy = await measureBandDepth(
    ladderClient({ spacing: 1, positions: [{ lower: -50_000, upper: 50_000, liquidity: 1n }] }),
    POOL,
    { ...state, liquidity: 1n },
  );
  assert.equal(decoy.lowerBound[RANK_BAND_BPS], false, "the decoy's own figure is exact");
  assert.ok(capped > decoy.amounts[RANK_BAND_BPS] * 1_000_000n, `griefed ${capped} still buries ${decoy.amounts[RANK_BAND_BPS]}`);
});

test("a truncated WIDE band leaves the RANK band exact when the cap falls outside it", async () => {
  // Why the ranking figure is the tight one and not the wide one, stated as an
  // invariant: coverage is measured outward from spot, so a budget that runs out on
  // the far reaches of 10% has already read all of 2%.
  const L = 10n ** 20n;
  const state = { sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, liquidity: L, tickSpacing: 10, quoteIsToken0: true };
  // -2% is ~202 ticks; -10% is ~1,054. Dust from tick 400 outward: past the tight
  // band, inside the wide one.
  const dust = Array.from({ length: 70 }, (_, i) => ({ lower: 400 + i * 20, upper: 410 + i * 20, liquidity: 1n }));
  const bands = await measureBandDepth(
    ladderClient({ spacing: 10, positions: [{ lower: -50_000, upper: 50_000, liquidity: L }, ...dust] }),
    POOL,
    state,
  );
  assert.equal(bands.ladderTruncated, true);
  assert.equal(bands.lowerBound[WIDE_BAND_BPS], true, "the wide walk stopped short");
  assert.equal(bands.lowerBound[RANK_BAND_BPS], false, "the ranking figure is untouched and EXACT");
});
