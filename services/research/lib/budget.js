/**
 * THE LEDGER THAT SPENDS ONE INVESTIGATION'S BUDGET, AND SAYS WHICH CAP RAN OUT.
 *
 * WHY THIS IS A MODULE AND NOT FIVE COUNTERS IN THE LOOP. The dominant economic risk in an
 * agentic loop is RUNAWAY — the model decides what happens next, so nothing in the design
 * bounds the work except the numbers written down here. Five counters scattered through
 * the loop are five numbers nobody can total and, worse, five places where "did we run
 * out?" is answered differently. One ledger has three properties the scattered version
 * cannot have:
 *
 *   1. EVERY SPEND GOES THROUGH ONE FUNCTION, so a resource that is not charged for is a
 *      resource that was not spent, not one that was forgotten.
 *   2. THE REPORT CAN SAY WHICH CAP BIT. "This investigation stopped because it had used
 *      12MB of the 12MB it may fetch" is a different fact from "it stopped because it ran
 *      out of steps", and a reader deciding whether the answer is complete needs to know
 *      which. A job that hits a cap SAYS SO.
 *   3. A CAP CAN BE CHECKED BEFORE THE WORK RATHER THAN AFTER. `mayAfford` answers
 *      "is there room for a 512KB read" before the socket is opened, which is the only
 *      point at which the answer is useful.
 *
 * THE HARD RULE THIS FILE EXISTS TO SERVE: A BOUND IS NEVER PRESENTED AS AN EXACT FIGURE.
 * `spentBytes` is what was actually counted; `fetchedBytesCapped` says whether counting
 * stopped early. A reader must never be handed "12,000,000 bytes fetched" as though the
 * investigation happened to land exactly on the ceiling.
 *
 * PURE apart from the clock, which is injectable. Never throws. Server-side only: no React.
 */

/** The resources a step can run out of, and the sentence each one deserves. */
const RESOURCES = Object.freeze({
  steps: {
    unit: "steps",
    reading: (used, cap) =>
      `The loop reached its step cap: ${used} of ${cap} decision steps were taken. What it had NOT yet decided to look at was therefore never looked at — unexamined, not absent.`,
  },
  toolCalls: {
    unit: "tool calls",
    reading: (used, cap) =>
      `The loop reached its tool-call cap: ${used} of ${cap} lookups were made. Anything it would have looked up next was NOT looked up — unexamined, not absent.`,
  },
  fetchedBytes: {
    unit: "bytes fetched",
    reading: (used, cap) =>
      `The loop reached its download cap: ${used} bytes of a ${cap}-byte allowance were fetched. Later reads were refused before the request was made, so what they would have contained is UNREAD rather than empty.`,
  },
  wallMs: {
    unit: "milliseconds of wall clock",
    reading: (used, cap) =>
      `The loop ran out of time: ${used}ms of a ${cap}ms allowance. It stopped where it was; everything it had not reached is unexamined, and nothing about the remaining time is a fact about the subject.`,
  },
  modelTokens: {
    unit: "model tokens",
    reading: (used, cap) =>
      `The loop reached its model-token cap: ${used} of ${cap} prompt+completion tokens. The transcript grows with every round, so a long investigation ends here rather than at the step cap. What it had not yet reasoned about is unexamined.`,
  },
});

/**
 * Open a budget for one investigation.
 *
 * @param {{ limits: object, now?: () => number }} input
 * @returns {object} the ledger
 */
export function createBudget({ limits, now = Date.now } = {}) {
  const caps = {
    steps: numberOr(limits?.steps, 12),
    toolCalls: numberOr(limits?.toolCalls, 40),
    fetchedBytes: numberOr(limits?.fetchedBytes, 8_000_000),
    wallMs: numberOr(limits?.wallMs, 5 * 60_000),
    modelTokens: numberOr(limits?.modelTokens, 200_000),
  };
  const startedAt = now();
  const used = { steps: 0, toolCalls: 0, fetchedBytes: 0, modelTokens: 0 };
  /** Every cap that was actually reached, in the order it was reached. */
  const hit = [];

  function elapsed() {
    return Math.max(0, now() - startedAt);
  }

  function noteHit(name) {
    if (!hit.some((h) => h.resource === name)) {
      const spent = name === "wallMs" ? elapsed() : used[name];
      hit.push({ resource: name, used: spent, cap: caps[name], reading: RESOURCES[name].reading(spent, caps[name]) });
    }
    return false;
  }

  return {
    caps: Object.freeze({ ...caps }),
    startedAt,

    /**
     * Whether there is room for one more of something, WITHOUT spending it.
     *
     * `amount` matters for bytes: asking "is there room for the 512KB this fetch may
     * return" before opening the socket is the only time the answer changes a decision.
     * The wall clock is checked on every call whatever is asked for, because it runs out
     * whether or not anything is spent.
     *
     * @param {"steps"|"toolCalls"|"fetchedBytes"|"modelTokens"} resource
     * @param {number} [amount]
     * @returns {boolean}
     */
    mayAfford(resource, amount = 1) {
      if (elapsed() >= caps.wallMs) return noteHit("wallMs");
      if (!Object.hasOwn(used, resource)) return true;
      const want = Number.isFinite(amount) && amount > 0 ? amount : 1;
      if (used[resource] + want > caps[resource]) return noteHit(resource);
      return true;
    },

    /**
     * Charge for work that has happened. Charging AFTER rather than reserving before is
     * deliberate for bytes: a fetch that returns 3KB should not be charged 512KB, and a
     * ledger that over-charged would refuse reads it could afford.
     */
    spend(resource, amount = 1) {
      if (!Object.hasOwn(used, resource)) return;
      const n = Number.isFinite(amount) && amount > 0 ? amount : 0;
      used[resource] += n;
      if (used[resource] >= caps[resource]) noteHit(resource);
    },

    /** Milliseconds left, floored at zero. Never negative, never Infinity. */
    remainingMs() {
      return Math.max(0, caps.wallMs - elapsed());
    },

    /** Which caps were reached, in order. Empty means the loop stopped for its own reasons. */
    hits() {
      return hit.map((h) => ({ ...h }));
    },

    /**
     * THE COST BLOCK, and it is part of the product rather than telemetry.
     *
     * A reader deciding how much weight to put on a report needs to know it cost eleven
     * model calls and 340KB of somebody's bandwidth, and whether it stopped because it was
     * finished or because it ran out. `capped` on each line is what keeps a bound from
     * being read as an exact measurement.
     */
    snapshot() {
      const ms = elapsed();
      return {
        elapsedMs: ms,
        steps: { used: used.steps, cap: caps.steps, capped: used.steps >= caps.steps },
        toolCalls: { used: used.toolCalls, cap: caps.toolCalls, capped: used.toolCalls >= caps.toolCalls },
        fetchedBytes: { used: used.fetchedBytes, cap: caps.fetchedBytes, capped: used.fetchedBytes >= caps.fetchedBytes },
        modelTokens: { used: used.modelTokens, cap: caps.modelTokens, capped: used.modelTokens >= caps.modelTokens },
        wallMs: { used: ms, cap: caps.wallMs, capped: ms >= caps.wallMs },
        hit: hit.map((h) => ({ ...h })),
        reading: hit.length
          ? `THIS INVESTIGATION STOPPED AT A CAP, NOT AT AN ANSWER. ${hit.map((h) => h.reading).join(" ")} Everything the loop had not reached is UNEXAMINED, and an unexamined thing is not an absent one.`
          : "No cap was reached: the loop stopped because it had nothing further it judged worth looking at, not because it ran out of steps, calls, bytes, tokens or time. That is not the same as having checked everything — see what was not checked.",
      };
    },
  };
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
