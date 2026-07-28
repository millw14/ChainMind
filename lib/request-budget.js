import { AsyncLocalStorage } from "node:async_hooks";

/**
 * ONE CLOCK FOR THE WHOLE REQUEST — the thing that stands between a slow lookup
 * and a 504.
 *
 * WHY THIS EXISTS. Every stage of /api/ask already had a timeout, and every one of
 * them was a FIXED number chosen against the stage in isolation: 8s per indexer
 * call (lib/blockscout.js), 6s for enrichment, 14s for the Uniswap fallback
 * (lib/ask-evidence.js POOL_TIMEOUT_MS), 12s per depth probe (lib/depth-rank.js),
 * 20s for the streamed completion. Every one of those is defensible on its own and
 * they do not add up to anything: measured cold on chain 4663, a memecoin ticker
 * took 49.0s end to end and a ticker collision 31.3s, both against a platform
 * ceiling of 30s. The platform then KILLS the invocation, which is the worst
 * outcome available — the work already done is discarded, the partial evidence and
 * its `unavailable` entries are thrown away, and the reader gets a bare 504 that
 * says nothing. A degraded honest answer beats a gateway timeout every time.
 *
 * WHAT IT DOES. app/api/ask/route.js opens a budget derived from its own
 * `maxDuration`, and every stage below asks how much of it is LEFT rather than
 * consulting its own constant. A call that cannot fit is not started; one that can
 * is given the smaller of its own budget and what remains.
 *
 * WHY AsyncLocalStorage AND NOT A PARAMETER. The deadline has to reach
 * lib/blockscout.js `deadline()`, which is eight call frames below the route
 * through the runner, the tool loop, the tool dispatcher, the evidence gatherer,
 * the resolver, the depth ranker and the pool reader. Threading a budget argument
 * through all of that would touch every signature on the way and would be silently
 * wrong the first time one of them forgot to forward it. An ambient store is
 * forwarded by construction.
 *
 * WHEN THERE IS NO BUDGET — every unit test, every script, `next build` — the
 * remaining time is Infinity and every clamp below is the identity function. That
 * is deliberate: this module can only ever SHORTEN a deadline that already
 * existed, never lengthen one and never introduce one where there was none.
 *
 * Server-side only: no React, no next/* imports.
 */

const storage = new AsyncLocalStorage();

/**
 * The platform ceiling, in seconds. app/api/ask/route.js re-exports this as its
 * own `maxDuration` rather than writing 30 twice — the whole budget below is
 * derived from it, and two copies that drifted would put the budget on the wrong
 * side of the kill.
 */
export const MAX_DURATION_S = 30;

/**
 * What is NOT ours to spend, out of that ceiling.
 *
 * The clock the platform kills on starts before our handler does and stops after
 * its last byte is written: cold module load, the JSON body read, response
 * serialization and the socket write are all inside the 30s and outside anything
 * this file can see. Six seconds is the margin for that, which is why the budget
 * below is 24s and not 30s. A margin that is too generous costs a little of the
 * slowest answer; one that is too tight costs the whole answer.
 */
export const PLATFORM_MARGIN_MS = 6_000;

/** Everything one request may spend, from the moment the handler starts. */
export const ASK_BUDGET_MS = MAX_DURATION_S * 1_000 - PLATFORM_MARGIN_MS;

/**
 * Time held back for the model to WRITE the answer, and never lent to lookups.
 *
 * Measured: time-to-first-token is ~390ms and a 700-token answer streams in a few
 * seconds. Seven is that with room for a slow turn — and it is a RESERVE rather
 * than a timeout, which is the point: the lookups are told the budget ends seven
 * seconds before it really does, so an over-running gather eats its own field and
 * not the sentence that reports it. An answer with holes in it is a product; an
 * answer that never arrives is a 504.
 */
export const ANSWER_RESERVE_MS = 7_000;

/**
 * Open a budget for one request and run `fn` inside it.
 *
 * Nested calls do NOT restart the clock — the outermost budget wins, because a
 * request has exactly one deadline and an inner stage must not be able to grant
 * itself more time than the request has left.
 *
 * @param {() => Promise<any>} fn
 * @param {{ totalMs?: number, reserveMs?: number }} [options]
 * @returns {Promise<any>} whatever `fn` returns
 */
export function runWithBudget(fn, { totalMs = ASK_BUDGET_MS, reserveMs = ANSWER_RESERVE_MS } = {}) {
  if (storage.getStore()) return fn();
  const total = Number.isFinite(totalMs) && totalMs > 0 ? totalMs : ASK_BUDGET_MS;
  const reserve = Number.isFinite(reserveMs) && reserveMs >= 0 ? reserveMs : ANSWER_RESERVE_MS;
  return storage.run({ endsAt: Date.now() + total, reserveMs: reserve, skips: new Set() }, fn);
}

/**
 * The same, for a generator — runAskStream is one, and a generator body runs on
 * the consumer's stack rather than the one that created it, so wrapping the CALL
 * would leave the store behind the moment the first `yield` returned control.
 * Wrapping each `next()` is what keeps the context attached across every step.
 *
 * @param {() => AsyncGenerator} makeGenerator
 * @param {{ totalMs?: number, reserveMs?: number }} [options]
 * @returns {AsyncGenerator}
 */
export function generatorWithBudget(makeGenerator, options) {
  if (storage.getStore()) return makeGenerator();
  const total = Number.isFinite(options?.totalMs) && options.totalMs > 0 ? options.totalMs : ASK_BUDGET_MS;
  const reserve =
    Number.isFinite(options?.reserveMs) && options.reserveMs >= 0 ? options.reserveMs : ANSWER_RESERVE_MS;
  const store = { endsAt: Date.now() + total, reserveMs: reserve, skips: new Set() };
  const inner = storage.run(store, makeGenerator);
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: (value) => storage.run(store, () => inner.next(value)),
    return: (value) => storage.run(store, () => inner.return(value)),
    throw: (error) => storage.run(store, () => inner.throw(error)),
  };
}

/** True when a budget is open. Nothing below changes behaviour when it is not. */
export function budgetActive() {
  return Boolean(storage.getStore());
}

/**
 * Milliseconds until the HARD end of the request — the point the platform kills
 * it. Infinity when no budget is open. Never negative: zero means "no time".
 */
export function remainingMs() {
  const store = storage.getStore();
  if (!store) return Infinity;
  return Math.max(0, store.endsAt - Date.now());
}

/**
 * Milliseconds until the end of the LOOKUP half of the request — the hard end
 * less the answer reserve. This is the number every chain read should ask for;
 * `remainingMs` is for the completion that writes the answer.
 */
export function remainingWorkMs() {
  const store = storage.getStore();
  if (!store) return Infinity;
  return Math.max(0, store.endsAt - store.reserveMs - Date.now());
}

/**
 * Should a stage that needs at least `minMs` to be worth starting be skipped?
 *
 * The question is deliberately "is it worth STARTING", not "has time run out". A
 * pool read given 900ms of a 14s budget will fail, and having failed it reports an
 * outage — "the RPC did not answer" — which is a claim about an upstream that was
 * never really asked. Not starting it and saying so is the honest version of the
 * same shortage.
 *
 * @param {number} minMs
 */
export function outOfTimeFor(minMs) {
  const need = Number.isFinite(minMs) && minMs > 0 ? minMs : 0;
  return remainingWorkMs() < need;
}

/**
 * A per-call timeout, capped by what the request has left.
 *
 * Floored at 1ms rather than 0: lib/blockscout.js reads a non-positive deadline as
 * "no opinion, use the full budget", so a clamp that returned 0 would hand a
 * request with no time left the LONGEST timeout available — exactly backwards.
 *
 * @param {number} ms - what the stage would ask for on its own
 * @param {{ hard?: boolean }} [options] - `hard` measures against the request's
 *   real end rather than the lookup deadline. For the completion that writes the
 *   answer, which is what the reserve is being held for.
 */
export function clampTimeout(ms, { hard = false } = {}) {
  const want = Number(ms);
  const budget = hard ? remainingMs() : remainingWorkMs();
  if (!Number.isFinite(budget)) return want;
  if (!Number.isFinite(want) || want <= 0) return Math.max(1, budget);
  return Math.max(1, Math.min(want, budget));
}

/**
 * Record that something was NOT DONE because the request ran short of time.
 *
 * A bound the reader cannot see is a lie by omission, and this is how the bound
 * gets out: lib/ask-evidence.js turns whatever accumulates here into a finished
 * sentence in the evidence, beside the `unavailable` list it already emits. Names
 * are evidence-field names, so the two lists read alike.
 *
 * @param {string} name
 */
export function noteBudgetSkip(name) {
  const store = storage.getStore();
  const label = String(name ?? "").trim();
  if (!store || !label) return;
  store.skips.add(label);
}

/** Everything skipped for time so far in this request, in the order recorded. */
export function budgetSkips() {
  const store = storage.getStore();
  return store ? [...store.skips] : [];
}

/**
 * The sentence that travels with those skips, or null when nothing was skipped.
 *
 * A finished sentence rather than a flag, the same convention as capNotice and
 * liquidityNotice: the reader needs to know a figure is missing because the clock
 * ran out and NOT because the chain says there is nothing there, and the model
 * must not have to derive that difference from a boolean.
 *
 * @param {string[]} [names] - defaults to this request's skips
 * @returns {string|null}
 */
export function budgetNotice(names = budgetSkips()) {
  const list = Array.isArray(names) ? names.filter(Boolean) : [];
  if (!list.length) return null;
  return `These reads were skipped to keep this answer inside its time limit: ${list.join(", ")}. They are UNKNOWN — not zero, not empty, and not a finding that there is nothing there. Say plainly that they were not read this time.`;
}
