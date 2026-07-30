/**
 * WHAT A SELLER COULD ACTUALLY REALISE — the Uniswap v3 tick ladder, integrated
 * across a price band.
 *
 * WHY THIS MODULE EXISTS, AND WHAT IT REPLACES. The depth figure this repo ranked
 * pools on used to be min(quote balance in the pool, the reserve implied by
 * liquidity()). Both halves were measured over DISJOINT SETS OF POSITIONS — the
 * balance is every position, in range and out; liquidity() is only the positions
 * spanning the current tick — so their minimum bounded NEITHER. Two positions in
 * one pool defeated it, and the attack was measured, not hypothesised:
 *
 *   1. A hair-width position straddling the current tick. Negligible capital, and
 *      because L is the amount of liquidity per unit of sqrt-price, an enormous L.
 *      Extrapolating that L across the whole curve reported $366,525 of "in-range"
 *      depth for a pool holding $3.94.
 *   2. A position whose range sits entirely ABOVE the current tick. With WETH as
 *      token0 it is 100% WETH, contributes NOTHING to liquidity(), sits in
 *      balanceOf, and is withdrawable at any moment.
 *
 * min(parked balance, huge extrapolation) = the parked amount. Measured: parking
 * 14 WETH behind a $3.94 pool flipped the VLAD verdict to "ambiguous" and named the
 * squatter the winner; 135 WETH made it "dominant". The parked half carries no
 * impermanent loss while out of range, so the cost was opportunity cost alone —
 * about $2.96 a day.
 *
 * WHAT THIS DOES INSTEAD. It walks the initialised ticks outward from the current
 * price, applying liquidityNet at each one, and sums the amount of QUOTE TOKEN each
 * range actually holds between the current price and a bound — the standard v3
 * depth calculation, the same arithmetic UniswapV3Pool.swap performs. Both halves
 * of the attack fall out structurally rather than being patched:
 *
 *   - the parked position lies outside the band, so the integration never reaches
 *     it and it is simply not counted;
 *   - the hair-width position contributes only the amount it really holds, because
 *     the integration STOPS at its upper tick instead of extrapolating past it.
 *
 * WHAT IT DOES NOT PROVE. Band depth is still RENTABLE in principle: nothing here
 * pins a block, watches for withdrawal, or asks how long the capital has been
 * there, and a pool that measures deep at read time can be empty a minute later.
 * What changed is where the capital has to sit. To show $X of band depth an
 * attacker must place ~$X of quote token IN RANGE, across the band, at the real
 * price, where any seller can trade against it — it is exposed, not parked. That
 * raises the cost from "opportunity cost on a refundable deposit" to "capital at
 * risk at the market price". IT IS NOT IMMUNITY, and no caller may present it as
 * such. Same-transaction flash liquidity genuinely cannot move it, and that one IS
 * a guarantee rather than a cost: every read here is of committed state at a mined
 * block.
 *
 * NULL, NEVER ZERO, NEVER A FALLBACK. If the ladder cannot be READ — a call that
 * threw, a word that did not answer, an unreadable spacing — the depth is unknown.
 * It never falls back to the balance and it never degrades to a zero.
 *
 * TRUNCATION IS NOT FAILURE, AND THE DIFFERENCE IS LOAD-BEARING. The read budgets
 * below used to REFUSE — return null — when a band held more initialised ticks than
 * they would pay for. That refusal was an attacker's primitive, and it was measured:
 * minting 71 dust positions into SOMEONE ELSE'S pool at a fine tick spacing costs
 * gas alone, pushes the tick count past the budget, and turns the victim's pool
 * UNMEASURED. Whatever the caller then did with an unmeasured pool, the attacker
 * chose it. An ordinary partial brownout — one tickBitmap word that did not answer —
 * produced the same state for free.
 *
 * So the ladder is now integrated OUTWARD FROM SPOT and a budget CAPS the walk
 * instead of cancelling it. Everything summed before the cap is genuinely realisable
 * — the walk crossed every initialised tick in between — so the figure is a valid
 * LOWER BOUND on depth, and it travels labelled as one (`lowerBound` per band, and
 * the tick range actually covered). Dust mints can now only CAP the bound; they
 * cannot invert an ordering, because a capped honest pool still reports orders of
 * magnitude more than a dust decoy reports in full.
 *
 * A LOWER BOUND IS NOT A MEASUREMENT, and no caller may quietly treat it as one. It
 * is sufficient to WIN a comparison outright (the true figure is at least this) and
 * never sufficient to LOSE one, or to establish that nothing is there.
 *
 * Server-side only, but nothing here is server-specific: no React, no Next, no
 * module-scope I/O, and the RPC client is injected. Exercised offline in
 * test/tick-depth.test.mjs and test/dex-price.test.mjs.
 */

/* --------------------------------- limits -------------------------------- */

/**
 * THE WIDE BAND: 1000 basis points, -10%. REPORTED CONTEXT, and no longer the
 * figure anything ranks on.
 *
 * WHY IT STOPPED RANKING. Capital at the EDGE of a wide band counts in full toward
 * it and is never traded through. Measured: $1,324 of single-sided WETH placed one
 * tick-spacing wide at -9.16% adds $1,328.05 to the -10% figure while the -2% figure
 * stays at $3.92. That capital is withdrawable at any block, and the only person who
 * could consume it is somebody selling the squatter's own token — so in practice it
 * is parked, not risked. Against the live field that is decisive: The Green Bull's
 * real -10% depth is $1,324.23, so ~$1,324 placed where nothing will ever trade
 * through it matched the honest token's headline figure.
 *
 * IT IS STILL WORTH READING. A pool deep at 10% and empty at 2% has all its
 * liquidity parked at the edge, and a reader shown one number cannot tell. Both
 * figures travel, and the wide one is context beside the ranking figure, never
 * instead of it.
 */
export const WIDE_BAND_BPS = 1000;

/**
 * THE RANKING BAND: 200 basis points, -2%.
 *
 * WHY THIS IS THE ONE THAT RANKS. The ranking is meant to pay for capital that is
 * genuinely EXPOSED — that a seller can trade through at close to the market price.
 * Within 2% of spot that is true: the capital is one ordinary trade away from being
 * taken, and on the 1% fee tier that matters here it is barely more than the round
 * trip costs. At the edge of a 10% band it is not true at all, which is what made
 * the wide figure cheap to inflate (see WIDE_BAND_BPS).
 *
 * WHAT IT COSTS US. The tight band is a smaller number and the honest token's margin
 * over the floor is no wider for the change: The Green Bull reads $259.33 here
 * against $1,324.23 at -10%. The floor moved with the measure rather than the
 * measure being kept to flatter the floor — see lib/dex-price.js THIN_LIQUIDITY_USD,
 * which derives the conversion from the band geometry and states the margin.
 *
 * THE CHEAP ATTACK STILL CANNOT LIVE INSIDE IT. A one-tick position is 0.01% wide
 * and contributes only what it holds, because the walk stops at its upper tick; -2%
 * is ~200 ticks, so a hair-width position is no cheaper here than it was at -10%.
 */
export const RANK_BAND_BPS = 200;

/**
 * How many tick-bitmap words one pool may read. A word covers 256 tick spacings:
 * 51,200 ticks at spacing 200 (the 1% tier), 15,360 at 60 (0.3%), 2,560 at 10
 * (0.05%) and 256 at 1 (0.01%). The widest band here is ~1,050 ticks, so every
 * tier but the last needs one or two words and the last needs at most six. Eight
 * is that worst case with room, and it bounds the read rather than the answer: the
 * band is the same width whatever the spacing.
 *
 * A CAP, NOT A REFUSAL. Words are read OUTWARD FROM SPOT and the budget stops the
 * read at a known tick, so the integral that comes back covers a stated range and is
 * a lower bound on the band. See readTickLadder.
 */
export const MAX_TICK_WORDS = 8;

/**
 * How many initialised ticks may be read for one pool.
 *
 * A CAP, NOT A REFUSAL — and this is the constant the griefing attack aimed at.
 * Refusing here made an attacker's dust mints into someone else's pool decide
 * whether that pool was measurable at all: 71 mints at the 0.05%/0.01% tiers, gas
 * only, and the victim went UNMEASURED. The ticks are now taken NEAREST-SPOT-FIRST
 * and the walk stops at the first one the budget could not reach, which is a tick
 * position we know exactly — so the sum is a lower bound over a stated range and the
 * attacker's mints can only shorten that range.
 *
 * 24 AND NOT 64, AND THE REASON IS THAT IT IS NOW ACTUALLY PAID. While the budget
 * REFUSED, it was reached and no tick was read; a crowded pool cost the bitmap words
 * and nothing more. Capping instead means the reads happen, and measured live on
 * chain 4663 that broke the lookup outright: a single batch of 64 eth_calls comes
 * back 429 Too Many Requests, the retry does too, and the ladder — which is now
 * allowed to be partial — went null for the whole pool. A cold single-token lookup
 * went from ~102 JSON-RPC calls to 370, and a four-contract VLAD collision from 4.9s
 * to 53s with every probe unmeasured. A budget that cannot be spent is not a budget.
 *
 * WHY 24 IS THE RIGHT NUMBER AND NOT JUST A SMALLER ONE. It is sized to the RANKING
 * band. -2% is ~202 ticks, which is 2 tick positions at the 1% tier's spacing of 200,
 * 4 at 0.3%, and 21 at 0.05% — so 24 covers the whole ranking band at every tier but
 * the finest, with slack. Only the 0.01% tier (spacing 1, ~202 positions in the band)
 * can truncate the ranking figure, and there a lower bound is exactly the right
 * answer. The WIDE band is 5× further out and will often come back as a lower bound
 * on a crowded pool; it is reported context, and it is labelled.
 *
 * WHY IT IS NOT RAISED INSTEAD. Raising it raises the price of every honest lookup to
 * make one dishonest one slightly less effective, and the lower bound already removes
 * the attacker's leverage: dust can shorten the covered range and can never invert an
 * ordering. Real pools here carry a handful of positions; at spacing 200 the whole
 * 10% band holds only ~6 tick positions, so this bound cannot be reached there at all.
 */
export const MAX_TICKS_READ = 24;

/** Uniswap v3's tick range, and the sqrt prices at its ends. */
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

const Q96 = 2n ** 96n;
const Q128 = 2n ** 128n;
const MAX_UINT256 = 2n ** 256n - 1n;

/* ---------------------------------- ABI ---------------------------------- */

/**
 * The three pool getters the ladder needs. `ticks` returns eight values and only
 * the second is used, but the whole tuple has to be declared or the decode is
 * wrong — viem reads the ABI, not the wire, to decide where each field ends.
 */
export const TICK_ABI = Object.freeze([
  { name: "tickSpacing", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "int24" }] },
  {
    name: "tickBitmap",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "wordPosition", type: "int16" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "ticks",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tick", type: "int24" }],
    outputs: [
      { name: "liquidityGross", type: "uint128" },
      { name: "liquidityNet", type: "int128" },
      { name: "feeGrowthOutside0X128", type: "uint256" },
      { name: "feeGrowthOutside1X128", type: "uint256" },
      { name: "tickCumulativeOutside", type: "int56" },
      { name: "secondsPerLiquidityOutsideX128", type: "uint160" },
      { name: "secondsOutside", type: "uint32" },
      { name: "initialized", type: "bool" },
    ],
  },
]);

/* ------------------------------- tick math -------------------------------- */

/**
 * sqrt(1.0001^tick) * 2^96 — Uniswap's TickMath.getSqrtRatioAtTick, in BigInt.
 *
 * Transcribed rather than approximated on purpose. The band bound is compared
 * against this on every step of the walk, and a float log/exp would drift by
 * fractions of a tick near the ends of the range — enough to include or exclude a
 * whole position. Null for a tick outside the representable range, never a clamp.
 *
 * @param {number} tick
 * @returns {bigint|null}
 */
export function getSqrtRatioAtTick(tick) {
  if (!Number.isInteger(tick)) return null;
  const absTick = tick < 0 ? -tick : tick;
  if (absTick > MAX_TICK) return null;

  let ratio = (absTick & 0x1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  if (absTick & 0x2) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if (absTick & 0x4) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if (absTick & 0x8) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if (absTick & 0x10) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if (absTick & 0x20) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if (absTick & 0x40) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if (absTick & 0x80) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if (absTick & 0x100) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if (absTick & 0x200) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if (absTick & 0x400) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if (absTick & 0x800) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if (absTick & 0x1000) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if (absTick & 0x2000) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if (absTick & 0x4000) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if (absTick & 0x8000) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if (absTick & 0x10000) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if (absTick & 0x20000) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if (absTick & 0x40000) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if (absTick & 0x80000) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;

  if (tick > 0) ratio = MAX_UINT256 / ratio;
  // Q128.128 down to Q64.96, rounding UP so the ratio never lands below the tick
  // it names — the same rounding the pool uses.
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** Integer square root, Newton's method with a bit-length seed. Null for negatives. */
function isqrt(n) {
  if (typeof n !== "bigint" || n < 0n) return null;
  if (n < 2n) return n;
  let x = 1n << (BigInt(n.toString(2).length) / 2n + 1n);
  for (;;) {
    const y = (x + n / x) / 2n;
    if (y >= x) return x;
    x = y;
  }
}

/**
 * The sqrt price at which the TARGET token has lost `bandBps` of its value against
 * the quote.
 *
 * The pool's sqrtPriceX96 is sqrt(token1 per token0) — so which direction "the
 * target falls" points in depends on which side the quote is. Selling the target
 * always pushes the price against the seller, and that is the only direction
 * integrated: quote is token0 means the target is token1, selling it makes token0
 * dearer in token1 terms and sqrtP RISES; quote is token1 means the target is
 * token0 and sqrtP FALLS. The magnitude is the same either way — sqrt(1 - band).
 *
 * @param {bigint} sqrtPriceX96
 * @param {number} bandBps - basis points of price loss, 1..9999
 * @param {boolean} quoteIsToken0
 * @returns {bigint|null}
 */
export function bandSqrtBound(sqrtPriceX96, bandBps, quoteIsToken0) {
  if (typeof sqrtPriceX96 !== "bigint" || sqrtPriceX96 <= 0n) return null;
  if (!Number.isInteger(bandBps) || bandBps <= 0 || bandBps >= 10_000) return null;
  // sqrt(1 - bps/10000) in Q96: sqrt((10000-bps) * 2^192 / 10000).
  const sqrtFactor = isqrt(((10_000n - BigInt(bandBps)) * Q96 * Q96) / 10_000n);
  if (sqrtFactor === null || sqrtFactor <= 0n) return null;
  const bound = quoteIsToken0
    ? (sqrtPriceX96 * Q96) / sqrtFactor // price rises
    : (sqrtPriceX96 * sqrtFactor) / Q96; // price falls
  if (bound <= MIN_SQRT_RATIO) return MIN_SQRT_RATIO;
  if (bound >= MAX_SQRT_RATIO) return MAX_SQRT_RATIO;
  return bound;
}

/**
 * HOW FAR A WALK ACTUALLY REACHED, expressed in the same units the bands are — basis
 * points of price movement away from spot.
 *
 * The inverse of bandSqrtBound: that maps "2%" to a sqrt price, this maps a sqrt price
 * back to the percentage it represents. It exists so a TRUNCATED read can name the
 * interval it covered rather than only admitting that it fell short of the one it was
 * asked for. "At least $31.26, read out to 0.31% of the 2% band" is a measurement a
 * reader can place; "the read was capped" alone is not.
 *
 * 1 - (edge/spot)^2 for a downward walk and 1 - (spot/edge)^2 for an upward one — the
 * same square that turns a sqrt price into a price. Done at twelve digits of fixed
 * point in BigInt before it ever meets a double, for the reason getSqrtRatioAtTick is
 * transcribed rather than approximated: these sqrt prices run past 2^160.
 *
 * NULL when the edge sits on the wrong side of spot, which is not a walk that happened.
 *
 * @param {bigint} sqrtPriceX96 - spot
 * @param {bigint} sqrtEdge - where the walk stopped
 * @param {boolean} quoteIsToken0 - the direction the seller pushes the price
 * @returns {number|null} basis points, 0..10000
 */
export function bandBpsAtSqrt(sqrtPriceX96, sqrtEdge, quoteIsToken0) {
  if (typeof sqrtPriceX96 !== "bigint" || sqrtPriceX96 <= 0n) return null;
  if (typeof sqrtEdge !== "bigint" || sqrtEdge <= 0n) return null;
  const up = Boolean(quoteIsToken0);
  // Whichever way the walk runs, the ratio taken is the one that is <= 1.
  const num = up ? sqrtPriceX96 : sqrtEdge;
  const den = up ? sqrtEdge : sqrtPriceX96;
  if (num > den) return null;
  const SCALE = 10n ** 12n;
  const ratio = Number((num * SCALE) / den) / Number(SCALE);
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  const bps = 10_000 * (1 - ratio * ratio);
  if (!Number.isFinite(bps) || bps < 0) return null;
  return bps > 10_000 ? 10_000 : bps;
}

/**
 * Quote-token amount released by one liquidity range, between two sqrt prices.
 *
 * These are the v3 reserve identities, exact and in BigInt:
 *   token0 out over [a,b], a<b:  L * 2^96 * (b - a) / (a * b)
 *   token1 out over [a,b], a<b:  L * (b - a) / 2^96
 * Division truncates, which UNDERSTATES by at most one base unit per range — the
 * safe direction for a figure a caller may quote as realisable.
 */
function amountOut(liquidity, sqrtLo, sqrtHi, quoteIsToken0) {
  if (liquidity <= 0n || sqrtHi <= sqrtLo) return 0n;
  return quoteIsToken0
    ? (liquidity * Q96 * (sqrtHi - sqrtLo)) / (sqrtLo * sqrtHi)
    : (liquidity * (sqrtHi - sqrtLo)) / Q96;
}

/**
 * WALK THE LADDER AND SUM WHAT IS REALLY THERE.
 *
 * Pure: given the pool's current state and the initialised ticks around it, this is
 * the same loop UniswapV3Pool.swap runs, minus the fee accounting — step to the
 * next initialised tick or the band bound, whichever comes first, take the quote
 * that range holds, cross the tick, apply liquidityNet, repeat.
 *
 * `ticks` MUST be every initialised tick between the current price and `sqrtBound`.
 * Running out of them is read as "there are no more", so a caller that truncated its
 * read and still passed the full band bound would silently extrapolate the last
 * range across the rest of the band — exactly the mistake this module exists to
 * stop. That is why a truncated read does NOT change the tick list it hands over: it
 * changes the BOUND, to the tick where coverage ends (see measureBandDepth). The
 * result is then a genuine integral over a shorter interval — a lower bound on the
 * band — rather than a guess about a longer one.
 *
 * @param {{ sqrtPriceX96: bigint, tick: number, liquidity: bigint,
 *   ticks: Array<{ tick: number, liquidityNet: bigint }>, sqrtBound: bigint,
 *   quoteIsToken0: boolean }} state
 * @returns {bigint|null} raw quote base units, or null if the state is incoherent
 */
export function integrateBand(state) {
  const { sqrtPriceX96, tick, liquidity, ticks, sqrtBound, quoteIsToken0 } = state ?? {};
  if (typeof sqrtPriceX96 !== "bigint" || sqrtPriceX96 <= 0n) return null;
  if (typeof liquidity !== "bigint" || liquidity < 0n) return null;
  if (typeof sqrtBound !== "bigint" || sqrtBound <= 0n) return null;
  if (!Number.isInteger(tick) || !Array.isArray(ticks)) return null;

  const up = Boolean(quoteIsToken0);
  // Ascending for the upward walk, descending for the downward one, and only the
  // ticks the walk can actually reach.
  const lane = ticks
    .filter((t) => (up ? t.tick > tick : t.tick <= tick))
    .sort((a, b) => (up ? a.tick - b.tick : b.tick - a.tick));

  let sqrt = sqrtPriceX96;
  let active = liquidity;
  let out = 0n;

  for (let i = 0; i <= lane.length; i += 1) {
    if (up ? sqrt >= sqrtBound : sqrt <= sqrtBound) break;
    const next = lane[i] ?? null;
    const sqrtNext = next === null ? sqrtBound : getSqrtRatioAtTick(next.tick);
    if (sqrtNext === null) return null;
    // Clamp the step to the band: past the bound is past the question.
    const to = up ? (sqrtNext > sqrtBound ? sqrtBound : sqrtNext) : sqrtNext < sqrtBound ? sqrtBound : sqrtNext;

    out += up ? amountOut(active, sqrt, to, true) : amountOut(active, to, sqrt, false);
    sqrt = to;
    if (next === null || to === sqrtBound) break;

    // Cross it. Upward adds liquidityNet, downward subtracts it — the pool's own
    // convention. A negative result is not a pool state that can exist, so it is
    // reported as unreadable rather than floored to zero and quoted.
    active = up ? active + next.liquidityNet : active - next.liquidityNet;
    if (active < 0n) return null;
  }

  return out;
}

/* ------------------------------- the reads -------------------------------- */

/** Floor division that stays floor for negative ticks, where >> and / disagree. */
function floorDiv(a, b) {
  return Math.floor(a / b);
}

/** Run a read without letting it fail the gather. Same shape as lib/dex-price.js. */
async function attempt(thunk) {
  try {
    return { ok: true, value: await thunk() };
  } catch {
    return { ok: false, value: null };
  }
}

/**
 * THE INITIALISED TICKS BETWEEN THE CURRENT PRICE AND THE BAND BOUND — as far
 * outward as the read budget reaches, and a statement of exactly how far that was.
 *
 * TWO ROUND TRIPS, BATCHED. The bitmap words come first, all of them issued in the
 * same tick so a batching transport packs them into one JSON-RPC array; the tick
 * entries the bitmaps revealed come second, the same way. A pool with one position
 * inside the band is 1 word + 2 entries; the worst case is bounded by MAX_TICK_WORDS
 * and MAX_TICKS_READ.
 *
 * OUTWARD FROM SPOT, AND A BUDGET CAPS THE RANGE RATHER THAN CANCELLING THE READ.
 * `[tickLow, tickHigh]` always has the current tick at one end — the walk only ever
 * runs in the direction the seller pushes the price — so "outward" is unambiguous:
 * words are read starting at the one containing spot, and ticks are kept
 * nearest-spot-first. When a budget bites, the returned `coverLow`/`coverHigh` name
 * the CONTIGUOUS tick interval, anchored at spot, inside which every initialised tick
 * is present in `ticks`, and `truncated` is true. Integrating to the edge of that
 * interval is exact; the caller must not integrate past it.
 *
 * FAILURE IS STILL NULL, AND IT IS A DIFFERENT THING FROM TRUNCATION. A word that
 * did not answer, a tick entry that threw, a malformed decode, incoherent params:
 * those are reads that did not happen, the ladder is unknown, and the answer is
 * null. A budget that was reached is a read that DID happen over a shorter range.
 * Conflating the two is what let an attacker manufacture "unmeasured" on demand.
 *
 * WHERE THE TWO BYTES COME FROM IS THE CALLER'S BUSINESS — `readBitmap` / `readTick`.
 * Uniswap v3 keeps each pool in its own contract with `tickBitmap` and `ticks` getters,
 * which is the default below. Uniswap v4 keeps EVERY pool in one singleton and exposes
 * the same two words through `extsload(bytes32)` at a computed storage slot, so
 * lib/dex-v4.js supplies its own pair of readers and inherits everything above.
 *
 * THE SEAM IS HERE AND NOT A SECOND COPY OF THIS FUNCTION, deliberately. What is subtle
 * in this file is not the reading — it is the BUDGET and the COVERAGE bookkeeping: which
 * words to take first, which tick the walk may integrate to once a cap bites, and the
 * difference between a capped read and an unread one. That reasoning is what an attacker
 * aims at (see MAX_TICKS_READ), and two copies of it would be two chances to get it
 * subtly different — with the v4 copy, the newer and less exercised one, quietly the
 * weaker. One implementation, two ways of fetching a word.
 *
 * @returns {Promise<{ ticks: Array<{ tick: number, liquidityNet: bigint }>,
 *   truncated: boolean, coverLow: number, coverHigh: number }|null>}
 */
export async function readTickLadder(client, pool, params, options = {}) {
  const { currentTick, tickSpacing, tickLow, tickHigh } = params ?? {};
  const readBitmap =
    typeof options.readBitmap === "function"
      ? options.readBitmap
      : (word) => client.readContract({ address: pool, abi: TICK_ABI, functionName: "tickBitmap", args: [word] });
  const readTick =
    typeof options.readTick === "function"
      ? options.readTick
      : (tick) => client.readContract({ address: pool, abi: TICK_ABI, functionName: "ticks", args: [tick] });
  // A caller that supplied BOTH readers never touches `client`, so it need not have
  // one. Anything short of both still falls back to the v3 contract calls and does.
  const hasReaders = typeof options.readBitmap === "function" && typeof options.readTick === "function";
  if (!hasReaders && (!client || typeof client.readContract !== "function")) return null;
  if (!Number.isInteger(currentTick) || !Number.isInteger(tickSpacing) || tickSpacing <= 0) return null;
  if (!Number.isInteger(tickLow) || !Number.isInteger(tickHigh) || tickHigh < tickLow) return null;

  const cachedRead = typeof options.cachedRead === "function" ? options.cachedRead : (_key, fetcher) => fetcher();
  const maxWords = Number.isInteger(options.maxWords) && options.maxWords > 0 ? options.maxWords : MAX_TICK_WORDS;
  const maxTicks = Number.isInteger(options.maxTicks) && options.maxTicks > 0 ? options.maxTicks : MAX_TICKS_READ;

  // WHICH END OF THE RANGE IS SPOT. measureBandDepth builds [tickLow, tickHigh] with
  // the current tick at one end, because a seller only ever pushes the price one way;
  // a request that straddles spot is read as running downward, which is the
  // conservative reading (it truncates the low side and covers the high side in full).
  const up = tickLow >= currentTick;

  const wordLow = floorDiv(floorDiv(tickLow, tickSpacing), 256);
  const wordHigh = floorDiv(floorDiv(tickHigh, tickSpacing), 256);
  if (wordHigh < wordLow) return null;

  // Ordered outward from spot, so slicing to the budget keeps the words nearest the
  // market — the only ones a seller reaches first anyway.
  const words = [];
  if (up) for (let w = wordLow; w <= wordHigh; w += 1) words.push(w);
  else for (let w = wordHigh; w >= wordLow; w -= 1) words.push(w);

  let truncated = false;
  let read = words;
  if (words.length > maxWords) {
    read = words.slice(0, maxWords);
    truncated = true;
  }

  // The tick interval the words actually read cover. A word covers 256 compressed
  // indices, so its last tick is (w*256 + 255) * spacing and its first is
  // w*256*spacing; beyond that edge an initialised tick could exist unseen.
  const lastWord = read[read.length - 1];
  let coverLow = tickLow;
  let coverHigh = tickHigh;
  if (truncated) {
    if (up) coverHigh = Math.min(tickHigh, (lastWord * 256 + 255) * tickSpacing);
    else coverLow = Math.max(tickLow, lastWord * 256 * tickSpacing);
  }

  const bitmaps = await Promise.all(
    read.map((w) =>
      attempt(() =>
        cachedRead(`bitmap:${pool}:${w}`, async () => {
          const raw = await readBitmap(w);
          return { raw: String(raw ?? "0") };
        }),
      ),
    ),
  );

  const candidates = [];
  for (let i = 0; i < read.length; i += 1) {
    const res = bitmaps[i];
    if (!res.ok || !res.value) return null; // one unread word is an unread ladder
    let bits;
    try {
      bits = BigInt(res.value.raw);
    } catch {
      return null;
    }
    if (bits < 0n) return null;
    for (let bit = 0; bit < 256 && bits > 0n; bit += 1) {
      if (((bits >> BigInt(bit)) & 1n) === 0n) continue;
      const t = (read[i] * 256 + bit) * tickSpacing;
      if (t < coverLow || t > coverHigh) continue;
      candidates.push(t);
    }
  }
  // Nearest spot first, so the budget below keeps the ticks the walk reaches first.
  candidates.sort((a, b) => (up ? a - b : b - a));

  if (candidates.length > maxTicks) {
    // The first tick we could NOT afford is a tick position we know exactly, and we
    // know there is no initialised tick between it and the last one we kept — so
    // coverage runs right up to it and the sum stays exact over that interval.
    const firstDropped = candidates[maxTicks];
    if (up) coverHigh = Math.min(coverHigh, firstDropped);
    else coverLow = Math.max(coverLow, firstDropped);
    candidates.length = maxTicks;
    truncated = true;
  }

  // No initialised tick inside the covered range is a real finding: that whole range
  // is one range at the pool's current liquidity. An empty list integrates correctly.
  if (!candidates.length) return { ticks: [], truncated, coverLow, coverHigh };

  const entries = await Promise.all(
    candidates.map((t) =>
      attempt(() =>
        cachedRead(`tick:${pool}:${t}`, async () => {
          const v = await readTick(t);
          const net = Array.isArray(v) ? v[1] : v?.liquidityNet;
          return { liquidityNet: String(net ?? "0") };
        }),
      ),
    ),
  );

  const out = [];
  for (let i = 0; i < candidates.length; i += 1) {
    if (!entries[i].ok || !entries[i].value) return null;
    let net;
    try {
      net = BigInt(entries[i].value.liquidityNet);
    } catch {
      return null;
    }
    // int128 out of a uint-shaped fake or a raw hex decode: fold it back to signed
    // rather than treating 2^128-1 as a liquidity of 3.4e38.
    if (net >= Q128 / 2n) net -= Q128;
    out.push({ tick: candidates[i], liquidityNet: net });
  }
  return { ticks: out, truncated, coverLow, coverHigh };
}

/**
 * BAND DEPTH FOR ONE POOL, in raw quote base units, for each band asked for — with
 * a per-band statement of whether the figure is exact or a lower bound.
 *
 * One ladder read serves every band — the widest one sets the tick range and the
 * narrower ones integrate over a prefix of the same ticks, so asking for -2%
 * alongside -10% costs nothing extra.
 *
 * WHERE A TRUNCATED READ LANDS. When the ladder came back truncated, the walk is
 * clamped to the edge of the covered range instead of the band bound, and only the
 * bands whose bound lies OUTSIDE that edge are flagged. This is why the tight band
 * usually survives a truncation intact: coverage is measured outward from spot, so
 * the nearest 2% is read long before a budget runs out on the far reaches of 10%.
 * That is the whole reason the ranking figure is the tight one and not the wide one.
 *
 * @param {object} client - viem-shaped, readContract only
 * @param {string} pool
 * @param {{ sqrtPriceX96: bigint, tick: number, liquidity: bigint, tickSpacing: number,
 *   quoteIsToken0: boolean }} state
 * @param {{ bands?: number[], cachedRead?: Function, maxWords?: number, maxTicks?: number }} [options]
 * @returns {Promise<{ amounts: Record<number, bigint>, lowerBound: Record<number, boolean>,
 *   ladderTruncated: boolean, coverLow: number, coverHigh: number,
 *   coveredBandBps: number|null }|null>} null only when the ladder could not be READ —
 *   never for a budget that was reached. `coveredBandBps` is how far the walk actually
 *   reached, in the bands' own units, and is null when nothing was capped.
 */
export async function measureBandDepth(client, pool, state, options = {}) {
  const { sqrtPriceX96, tick, liquidity, tickSpacing, quoteIsToken0 } = state ?? {};
  if (typeof sqrtPriceX96 !== "bigint" || sqrtPriceX96 <= 0n) return null;
  if (typeof liquidity !== "bigint" || liquidity < 0n) return null;
  if (!Number.isInteger(tick) || !Number.isInteger(tickSpacing) || tickSpacing <= 0) return null;

  const bands = (
    Array.isArray(options.bands) && options.bands.length ? options.bands : [WIDE_BAND_BPS, RANK_BAND_BPS]
  )
    .map(Number)
    .filter((b) => Number.isInteger(b) && b > 0 && b < 10_000);
  if (!bands.length) return null;

  const up = Boolean(quoteIsToken0);
  const widest = Math.max(...bands);
  const bounds = new Map();
  for (const b of bands) {
    const bound = bandSqrtBound(sqrtPriceX96, b, quoteIsToken0);
    if (bound === null) return null;
    bounds.set(b, bound);
  }

  // How many ticks the widest band spans. ln(1 - band) / ln(1.0001), padded by two
  // spacings so a rounding of one tick at either end cannot drop a position that
  // sits exactly on the boundary — the walk itself filters on the exact sqrt bound,
  // so the padding only ever costs a read, never accuracy.
  const span = Math.ceil(Math.abs(Math.log(1 - widest / 10_000) / Math.log(1.0001))) + 2 * tickSpacing + 1;
  const tickLow = up ? tick : Math.max(MIN_TICK, tick - span);
  const tickHigh = up ? Math.min(MAX_TICK, tick + span) : tick;

  const ladder = await readTickLadder(
    client,
    pool,
    { currentTick: tick, tickSpacing, tickLow, tickHigh },
    options,
  );
  if (ladder === null) return null;

  // The price at the edge of what was actually read. Only consulted when the read
  // was truncated: an untruncated range already reaches past every band bound, and
  // clamping to a tick boundary there would shave the figure for no reason.
  let coverSqrt = null;
  // The same edge, restated as a percentage, so a caller that has to TELL somebody the
  // read was capped can name the interval it does cover instead of only what it misses.
  let coveredBandBps = null;
  if (ladder.truncated) {
    coverSqrt = getSqrtRatioAtTick(up ? ladder.coverHigh : ladder.coverLow);
    if (coverSqrt === null) return null;
    coveredBandBps = bandBpsAtSqrt(sqrtPriceX96, coverSqrt, quoteIsToken0);
  }

  const amounts = {};
  const lowerBound = {};
  for (const b of bands) {
    const bandBound = bounds.get(b);
    // Whichever bound the walk reaches FIRST. If that is the coverage edge, the
    // figure is everything realisable up to there and the rest of the band is simply
    // not counted — an understatement, which is the only safe direction.
    const short = coverSqrt !== null && (up ? coverSqrt < bandBound : coverSqrt > bandBound);
    const amount = integrateBand({
      sqrtPriceX96,
      tick,
      liquidity,
      ticks: ladder.ticks,
      sqrtBound: short ? coverSqrt : bandBound,
      quoteIsToken0,
    });
    if (amount === null) return null;
    amounts[b] = amount;
    lowerBound[b] = short;
  }
  return {
    amounts,
    lowerBound,
    ladderTruncated: ladder.truncated,
    coverLow: ladder.coverLow,
    coverHigh: ladder.coverHigh,
    coveredBandBps,
  };
}
