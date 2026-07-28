import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { ASK_BUDGET_MS, MAX_DURATION_S } from "../lib/request-budget.js";

/**
 * The number 30 is written twice — `export const maxDuration` in
 * app/api/ask/route.js, and MAX_DURATION_S here — and it has to be.
 *
 * Next reads the route's segment config by STATIC ANALYSIS, before any import is
 * resolved, so `export const maxDuration = MAX_DURATION_S` is not a runtime
 * question: it fails the build with `Unknown identifier "MAX_DURATION_S" at
 * "maxDuration"`. That happened, and no test caught it, because every other test
 * imports the module rather than compiling it — `npm test` was 730/730 green
 * while `npm run build` was broken.
 *
 * So the duplication is forced, and this file is what makes it safe. The failure
 * mode being guarded against is a silent drift that puts the request's own budget
 * on the WRONG SIDE of the platform's kill switch — a budget of 30s under a 20s
 * ceiling means the guard never fires and every slow request dies as a 504
 * instead of degrading to a partial answer.
 */
test("the route's maxDuration literal still matches MAX_DURATION_S", async () => {
  const source = await readFile(new URL("../app/api/ask/route.js", import.meta.url), "utf8");

  const declared = source.match(/^export const maxDuration = (\d+);$/m);
  assert.ok(
    declared,
    "app/api/ask/route.js must export `maxDuration` as a bare integer literal — " +
      "Next cannot resolve an identifier or an expression there, and the build fails if it is one",
  );

  assert.equal(
    Number(declared[1]),
    MAX_DURATION_S,
    "app/api/ask/route.js maxDuration has drifted from MAX_DURATION_S in lib/request-budget.js. " +
      "Change both, or the request budget lands on the wrong side of the platform's kill switch.",
  );
});

test("the ask budget leaves margin under the platform kill switch", () => {
  const ceilingMs = MAX_DURATION_S * 1_000;
  assert.ok(
    ASK_BUDGET_MS < ceilingMs,
    `ASK_BUDGET_MS (${ASK_BUDGET_MS}) must be under the ${ceilingMs}ms ceiling, or the guard never fires`,
  );
  // Enough room to serialise and flush a degraded answer after the budget trips.
  // Without it the request is killed mid-write and the user gets the 504 anyway,
  // which is the whole failure this budget exists to replace.
  assert.ok(
    ceilingMs - ASK_BUDGET_MS >= 2_000,
    `only ${ceilingMs - ASK_BUDGET_MS}ms of margin: too little to finish writing the partial answer`,
  );
});
