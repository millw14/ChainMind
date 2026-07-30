import { noteBudgetSkip, outOfTimeFor } from "./request-budget.js";

/**
 * ONE PAGE OF A PAGINATED WALK, RETRIED — because on this indexer a walk is cut
 * short by FLAKINESS far more often than by the end of the list.
 *
 * WHY THIS EXISTS, MEASURED. lib/cross-token.js holderOverlap stopped on the first
 * failed page and correctly downgraded its answer to a lower bound. The answer was
 * honest and it was also needlessly small: the failures are random, roughly one page
 * in ten, and the very next attempt gets the same page. Measured on MERRYMEN
 * 0xa15c…7b32 (474 holders, 10 pages), a hand walk that retried recovered every
 * failure and returned all 474 holders every time, while two live runs of the real
 * tool over PIPECAT + MERRYMEN returned "at least 1 wallet" and then "at least 4
 * wallets" for a pair whose true overlap is 14. At ~10% per page a ten-page walk has
 * roughly a 65% chance of losing at least one page, which is why the truncated answer
 * was the NORMAL outcome rather than the unlucky one.
 *
 * Pacing is not the cause and a gap does not help: the same walk with a 220ms gap
 * between pages failed just as often, and the retry is what recovered it. So the fix
 * is to ask again, not to ask more slowly.
 *
 * WHY IT IS SHARED RATHER THAN COPIED INTO EACH WALK. The three walks in this
 * codebase (holder lists in lib/cross-token.js, a wallet's transfers in
 * lib/wallet-evidence.js, the token list in lib/stock-tokens.js) each keep their own
 * cursor helpers on purpose — a page-walker reaching into another's internals is how
 * two walks end up having to change together. But how many times to re-ask a
 * rate-limited indexer, and when re-asking becomes a worse use of the remaining
 * budget than an honest lower bound, is one POLICY about one upstream. Three copies
 * of that would drift, and the drift would show up as one lookup quietly retrying
 * ten times while another gave up on the first blip.
 *
 * WHY A RETRY IS SAFE AND CHEAP HERE. lib/indexer-cache.js never stores a failure,
 * so the second attempt genuinely goes upstream, and a page that DID land is already
 * cached — so a retried walk re-reads nothing it has already got.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: hide the outcome. It reports how many attempts
 * were spent and whether the last one was withheld for time, so the caller can keep
 * saying exactly why its answer is bounded. A page that failed three times and a page
 * that failed once with no budget left to try again are two different facts about the
 * world, and the sentence a reader gets is different for each.
 *
 * Server-side only: no React, no next/*. The clock and the sleep are injectable, so
 * test/page-retry.test.mjs exercises every branch offline and instantly.
 */

/**
 * How many times one page may be ASKED FOR, in total.
 *
 * THREE — one attempt plus two retries. At the measured ~10% per-page failure rate,
 * one retry takes a page's chance of being lost from 10% to 1% and two takes it to
 * 0.1%, which turns a ten-page walk from "usually truncated" (65%) into "essentially
 * always complete" (1%). A fourth attempt buys another factor of ten against a
 * failure mode that is already below the odds of the request being killed for time,
 * and against a genuinely-down indexer every extra attempt is pure cost. Three is
 * where the two curves cross.
 */
export const PAGE_ATTEMPTS = 3;

/**
 * How long to wait before each retry, indexed by the attempt that just failed.
 *
 * SHORT, and that is deliberate. The measured failures are not rate limiting — a
 * 220ms gap between pages did not reduce them and the immediate retry recovered them
 * — so the backoff is there to let a transient blip pass, not to serve a penance.
 * It still GROWS, because the one case where waiting matters is the case these
 * numbers cannot distinguish from a blip: an indexer under real load, where hammering
 * is what keeps it under load. Half a second of total backoff against a page that
 * measures seconds is noise in the walk's cost and the difference between a
 * recovered page and a lower bound.
 */
export const PAGE_BACKOFF_MS = Object.freeze([150, 400]);

/** The default sleep. Injectable only so tests need not spend real milliseconds. */
function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Read one page, retrying a failure while the request can still afford to.
 *
 * THE BUDGET IS CHECKED BEFORE THE RETRY, NEVER AFTER IT. A retry started with 300ms
 * left fails on our own clamped deadline (see lib/blockscout.js deadline) and then
 * reports an indexer outage — a claim about an upstream that was never really asked,
 * which is the exact conflation lib/request-budget.js outOfTimeFor exists to prevent.
 * So the question asked here is "is another attempt worth STARTING", and when the
 * answer is no the walk gets an honest lower bound instead of a fabricated outage.
 *
 * A GENUINELY-DOWN INDEXER CANNOT COST THE WHOLE BUDGET. The attempts are bounded and
 * every one of them is gated on the clock, so the worst case is `attempts` reads and
 * the backoff between them — and the first of those reads is one the walk was going to
 * make anyway.
 *
 * @param {() => Promise<any>} read - performs the page read; may throw
 * @param {{ attempts?: number, minMs?: number, backoffMs?: number[], label?: string,
 *   sleep?: (ms: number) => Promise<void> }} [options] - `minMs` is what ONE read is
 *   worth starting with (the caller's own figure); `label` is recorded via
 *   noteBudgetSkip when a retry is withheld for time, so the bound reaches the reader.
 * @returns {Promise<{ ok: boolean, value: any, status: number|null, attempts: number,
 *   retried: boolean, stoppedForTime: boolean }>} `attempts` is how many reads were
 *   actually spent, and `stoppedForTime` says the last failure was NOT re-asked
 *   because the request had no time for it — a different fact from "it failed again".
 */
export async function readPageWithRetry(read, options = {}) {
  const limit =
    Number.isInteger(options.attempts) && options.attempts > 0 ? Math.min(options.attempts, 10) : PAGE_ATTEMPTS;
  const backoff = Array.isArray(options.backoffMs) ? options.backoffMs : PAGE_BACKOFF_MS;
  const minMs = Number.isFinite(options.minMs) && options.minMs > 0 ? options.minMs : 0;
  const sleep = typeof options.sleep === "function" ? options.sleep : wait;
  const label = typeof options.label === "string" && options.label.trim() ? options.label.trim() : null;

  let status = null;
  for (let spent = 1; ; spent += 1) {
    try {
      const value = await read(spent);
      return { ok: true, value, status: null, attempts: spent, retried: spent > 1, stoppedForTime: false };
    } catch (error) {
      // The status travels even when every attempt failed, because "HTTP 503" and
      // "the request never answered" are different sentences for the reader.
      status = error?.status ?? status;
      if (spent >= limit) {
        return { ok: false, value: null, status, attempts: spent, retried: spent > 1, stoppedForTime: false };
      }
      const pause = Number.isFinite(backoff[spent - 1]) ? backoff[spent - 1] : (backoff[backoff.length - 1] ?? 0);
      // The backoff is part of what the retry costs, so it is inside the question.
      if (outOfTimeFor(pause + minMs)) {
        if (label) noteBudgetSkip(label);
        return { ok: false, value: null, status, attempts: spent, retried: spent > 1, stoppedForTime: true };
      }
      if (pause > 0) await sleep(pause);
    }
  }
}
