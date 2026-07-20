// Tests for chain-backed wallet age stats (lib/wallet-ledger-age.js): history-capped
// rows (page-cap hit while walking signatures — busy old wallets look hours old) must
// not count as young, and the capped total must be surfaced. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWalletLedgerAge } from "../lib/wallet-ledger-age.js";
import { ledgerCohortYouthNorm01 } from "../lib/ai-detectors.js";

const NOW = 1_700_000_000;
const dbRow = (address, ageDays, capped) => ({
  address,
  first_signature: `sig-${address}`,
  first_slot: 1,
  first_block_time: NOW - Math.round(ageDays * 86400),
  capped,
});

test("capped rows are excluded from young7d and surfaced in cappedCount", () => {
  const out = buildWalletLedgerAge(
    ["W1", "W2", "W3"],
    [
      dbRow("W1", 2, 0), // genuinely young
      dbRow("W2", 2, 1), // busy old wallet with capped history — looks 2d old
      dbRow("W3", 400, 0), // old
    ],
    NOW,
  );
  assert.equal(out.youngWalletsUnder7d, 1);
  assert.equal(out.cappedCount, 1);
  assert.equal(out.payersWithData, 3);
  const w2 = out.rows.find((r) => r.address === "W2");
  assert.equal(w2.historyCapped, true);
});

test("uncapped young wallets still count", () => {
  const out = buildWalletLedgerAge(["W1", "W2"], [dbRow("W1", 1, 0), dbRow("W2", 3, 0)], NOW);
  assert.equal(out.youngWalletsUnder7d, 2);
  assert.equal(out.cappedCount, 0);
});

test("median age for cohort-youth norm skips history-capped rows", () => {
  // Two capped "2-day-old" rows would otherwise drag the median to 2d.
  const ledger = buildWalletLedgerAge(
    ["W1", "W2", "W3"],
    [dbRow("W1", 2, 1), dbRow("W2", 2, 1), dbRow("W3", 500, 0)],
    NOW,
  );
  const youth = ledgerCohortYouthNorm01(ledger);
  assert.equal(youth.medianAgeDays, 500);
  assert.equal(youth.youngFrac, 0);
});
