// Golden tests for the v2 event classifier (lib/parse-tx.js). Fixtures mirror the shape
// of connection.getParsedTransaction() output (account keys, top-level + inner parsed
// instructions). Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsedToEventRow } from "../lib/parse-tx.js";
import { SYSTEM_PROGRAM, TOKEN_PROGRAM } from "../lib/programs.js";

const RAYDIUM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const PUMPFUN = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

/** Build a minimal parsed-tx fixture. */
function tx({ keys = ["FeePayer1111", "Acct2222", "Acct3333"], ix = [], inner = [], err = null } = {}) {
  return {
    transaction: { message: { accountKeys: keys, instructions: ix } },
    meta: { innerInstructions: inner.length ? [{ index: 0, instructions: inner }] : [], err },
  };
}
const splIx = (type) => ({ programId: TOKEN_PROGRAM, program: "spl-token", parsed: { type, info: {} } });
const sysIx = (type) => ({ programId: SYSTEM_PROGRAM, program: "system", parsed: { type, info: { lamports: 1000 } } });
const rawIx = (programId) => ({ programId, accounts: [], data: "deadbeef" }); // partially-decoded (DEX)

const cases = [
  ["null tx → unknown", null, "unknown"],
  ["no message → unknown", {}, "unknown"],
  ["SPL mintTo → mint", tx({ ix: [splIx("mintTo")] }), "mint"],
  ["SPL burnChecked → burn", tx({ ix: [splIx("burnChecked")] }), "burn"],
  ["Raydium + transfer → swap", tx({ ix: [rawIx(RAYDIUM), splIx("transfer")] }), "swap"],
  ["pump.fun program → swap", tx({ ix: [rawIx(PUMPFUN)] }), "swap"],
  ["SPL transfer (no DEX) → transfer", tx({ ix: [splIx("transferChecked")] }), "transfer"],
  ["System transfer only → sol_transfer", tx({ ix: [sysIx("transfer")] }), "sol_transfer"],
  ["Token approve only → spl_other", tx({ ix: [splIx("approve")] }), "spl_other"],
  ["Unknown program only → other", tx({ ix: [rawIx("SomeRandomProgram111111111111111111111111")] }), "other"],
  // DEX call buried in inner instructions must still classify as swap.
  ["DEX in inner instructions → swap", tx({ ix: [rawIx("Router1111")], inner: [rawIx(RAYDIUM), splIx("transfer")] }), "swap"],
  // mint-first priority: a bonding-curve launch (mint + pump program) lands as mint.
  ["pump.fun + mintTo → mint (launch)", tx({ ix: [rawIx(PUMPFUN), splIx("mintTo")] }), "mint"],
];

for (const [name, input, expected] of cases) {
  test(name, () => {
    assert.equal(parsedToEventRow(input).event_type, expected);
  });
}

test("fee payer + counterparties extracted", () => {
  const row = parsedToEventRow(tx({ keys: ["Payer", "B", "C"], ix: [splIx("transfer")] }));
  assert.equal(row.fee_payer, "Payer");
  assert.deepEqual(JSON.parse(row.counterparties_json), ["B", "C"]);
});

test("on-chain error recorded in parse_note", () => {
  const row = parsedToEventRow(tx({ ix: [splIx("transfer")], err: { InstructionError: [0, "X"] } }));
  assert.match(row.parse_note, /^tx_err:/);
});

test("no v1 labels emitted (version marker)", () => {
  for (const [, input] of cases) {
    const et = parsedToEventRow(input).event_type;
    assert.ok(et !== "swap_eligible" && et !== "spl", `v2 must not emit v1 label, got ${et}`);
  }
});
