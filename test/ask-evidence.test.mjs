// Tests for the Ask evidence formatters (lib/ask-evidence.js): target classification
// plus the number helpers that feed the model. These guard the failure modes where a
// helper returns a confident-but-wrong value (mangled exponents, floored wei, a 0%
// concentration that really means "unknown"). Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTarget, compact, weiToEth, sumShares } from "../lib/ask-evidence.js";

test("classifyTarget recognizes a 64-hex transaction hash", () => {
  const hash = `0x${"a".repeat(64)}`;
  assert.deepEqual(classifyTarget(hash), { kind: "tx", value: hash });
});

test("classifyTarget recognizes a 40-hex address", () => {
  const addr = `0x${"b".repeat(40)}`;
  assert.deepEqual(classifyTarget(addr), { kind: "address", value: addr });
});

test("classifyTarget accepts mixed-case (checksummed) addresses", () => {
  const addr = "0xCaf681a66D020601342297493863E78C959E5cb2";
  assert.deepEqual(classifyTarget(addr), { kind: "address", value: addr });
});

test("classifyTarget trims surrounding whitespace", () => {
  const addr = `0x${"c".repeat(40)}`;
  assert.deepEqual(classifyTarget(`  ${addr}\n`), { kind: "address", value: addr });
});

test("classifyTarget rejects junk, over-long and under-long input", () => {
  assert.equal(classifyTarget("what is this token").kind, "unknown");
  assert.equal(classifyTarget(`0x${"a".repeat(41)}`).kind, "unknown", "41 hex chars");
  assert.equal(classifyTarget(`0x${"a".repeat(39)}`).kind, "unknown", "39 hex chars");
  assert.equal(classifyTarget(`0x${"a".repeat(65)}`).kind, "unknown", "65 hex chars");
  assert.equal(classifyTarget(`0x${"z".repeat(40)}`).kind, "unknown", "non-hex chars");
  assert.equal(classifyTarget(null).kind, "unknown");
  assert.equal(classifyTarget(undefined).kind, "unknown");
});

test("compact abbreviates large magnitudes", () => {
  assert.equal(compact(1), "1");
  assert.equal(compact(999), "999");
  assert.equal(compact(1500), "1.5K");
  assert.equal(compact(2.5e6), "2.5M");
  assert.equal(compact(3e9), "3B");
  assert.equal(compact(1.5e12), "1.5T");
});

test("compact keeps sub-1 values readable", () => {
  assert.equal(compact(0.5), "0.5");
  assert.equal(compact(0), "0");
});

test("compact never mangles exponent notation", () => {
  // Regression: a trailing-zero trim used to eat the exponent's own zeros, so
  // 1e-10 rendered as "1.00e-1" — off by a factor of 10^9.
  for (const n of [1e-9, 1e-10, 1e-18, 1e-20, 2.5e-10]) {
    const out = compact(n);
    assert.equal(Number(out), Number(n.toPrecision(3)), `compact(${n}) = ${out}`);
    assert.ok(!/e-?$/.test(out), `compact(${n}) has a truncated exponent: ${out}`);
  }
});

test("weiToEth converts at full 18-decimal precision", () => {
  assert.equal(weiToEth("0"), 0);
  assert.equal(weiToEth("1000000000000000000"), 1);
  assert.equal(weiToEth(1000000000000000000n), 1);
});

test("weiToEth does not floor dust to zero", () => {
  // 1 wei used to floor to 0 via a BigInt divide to micro-eth.
  assert.equal(weiToEth("1"), 1e-18);
  assert.ok(weiToEth("1") > 0);
});

test("weiToEth handles gwei-scale gas fees without downward bias", () => {
  // 21000 gas at 1 gwei = 2.1e13 wei = 0.000021 ETH.
  assert.equal(weiToEth("21000000000000"), 0.000021);
  // 21000 gas at 0.001 gwei = 2.1e10 wei — under the old 1e-6 floor.
  assert.equal(weiToEth("21000000000"), 2.1e-8);
});

test("weiToEth returns null on unparseable input", () => {
  assert.equal(weiToEth("abc"), null);
  assert.equal(weiToEth(null), null);
  assert.equal(weiToEth(undefined), null);
  assert.equal(weiToEth("1.5"), null);
});

test("sumShares totals numeric shares", () => {
  assert.equal(sumShares([{ share: 10 }, { share: 5.5 }, { share: 0.25 }]), 15.75);
});

test("sumShares returns null when no share is known", () => {
  // Missing total supply makes every share null; reporting 0 would tell the
  // model the top 10 holders own 0% of the token.
  assert.equal(sumShares([{ share: null }, { share: null }]), null);
  assert.equal(sumShares([]), null);
});

test("sumShares ignores unknown shares in a mixed set", () => {
  assert.equal(sumShares([{ share: 12.5 }, { share: null }, { share: 7.5 }]), 20);
  assert.equal(sumShares([{ share: null }, { share: 3 }]), 3);
});

test("sumShares distinguishes a real zero from an unknown share", () => {
  assert.equal(sumShares([{ share: 0 }, { share: 0 }]), 0);
});
