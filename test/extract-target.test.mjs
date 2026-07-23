// Tests for the composer's target matcher (lib/extract-target.js), used by
// components/ask/AskChat.jsx. The failure this guards against is silent: an
// unbounded match turns a malformed hex run into a different but perfectly
// valid-looking address, and the user is answered about someone else.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractTarget } from "../lib/extract-target.js";

const TX = `0x${"a".repeat(64)}`;
const ADDR = `0x${"b".repeat(40)}`;

test("extractTarget pulls a transaction hash out of a sentence", () => {
  assert.equal(extractTarget(`what happened in ${TX}?`), TX);
  assert.equal(extractTarget(TX), TX);
});

test("extractTarget pulls an address out of a sentence", () => {
  assert.equal(extractTarget(`explain ${ADDR} please`), ADDR);
  assert.equal(extractTarget(`(${ADDR})`), ADDR);
});

test("extractTarget prefers a transaction hash over an address", () => {
  assert.equal(extractTarget(`${ADDR} sent ${TX}`), TX, "address first in the text");
  assert.equal(extractTarget(`${TX} from ${ADDR}`), TX);
});

test("extractTarget keeps checksummed mixed case intact", () => {
  const addr = "0xCaf681a66D020601342297493863E78C959E5cb2";
  assert.equal(extractTarget(`is ${addr} a contract`), addr);
});

test("extractTarget refuses an over-long hex run", () => {
  // The bug: a 41-hex run used to yield its first 40 hex chars — a real-looking
  // address that belongs to nobody the user typed.
  assert.equal(extractTarget(`0x${"a".repeat(41)}`), null, "41 hex chars");
  assert.equal(extractTarget(`0x${"a".repeat(65)}`), null, "65 hex chars");
  assert.equal(extractTarget(`0x${"a".repeat(80)}`), null, "80 hex chars");
});

test("extractTarget refuses an under-long hex run", () => {
  assert.equal(extractTarget(`0x${"a".repeat(39)}`), null, "39 hex chars");
  assert.equal(extractTarget(`0x${"a".repeat(63)}`), null, "63 hex chars");
  assert.equal(extractTarget("0x"), null);
});

test("extractTarget refuses a hex run glued to more hex on the left", () => {
  assert.equal(extractTarget(`dead${ADDR.slice(2)}`), null);
});

test("extractTarget ignores a truncated hash but still finds a valid address", () => {
  assert.equal(extractTarget(`0x${"a".repeat(63)} and ${ADDR}`), ADDR);
});

test("extractTarget returns null for questions with no target", () => {
  assert.equal(extractTarget("Explain this wallet"), null);
  assert.equal(extractTarget("What is Robinhood Chain?"), null);
  assert.equal(extractTarget(`0x${"z".repeat(40)}`), null, "non-hex chars");
  assert.equal(extractTarget(""), null);
});

test("extractTarget tolerates non-string input", () => {
  assert.equal(extractTarget(null), null);
  assert.equal(extractTarget(undefined), null);
  assert.equal(extractTarget(42), null);
});
