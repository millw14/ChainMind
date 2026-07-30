// Tests for DOES THIS QUESTION WANT AN INVESTIGATION — lib/research-intent.js.
//
// Two failures matter here and they are not symmetrical. A MISSED request costs the user
// one sentence ("ask again with the URL"); a FALSE one costs them a daily allowance and
// costs a third party a crawl they did not ask for. So the tests below are weighted
// toward the second: ordinary questions must start nothing, and a name must never become
// a target however strongly the question is worded.
//
// Pure module: no network, no store, nothing to inject. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { RESEARCH_WANT, detectResearchRequest, extractSubjectCandidates } from "../lib/research-intent.js";

/* ------------------------------- candidates -------------------------------- */

test("a URL is found with or without its scheme, and sentence punctuation is not part of it", () => {
  assert.deepEqual(extractSubjectCandidates("look at https://csl.fun/vault?x=1."), [
    { value: "https://csl.fun/vault?x=1", kind: "url" },
  ]);
  assert.deepEqual(extractSubjectCandidates("check csl.fun, then tell me"), [{ value: "https://csl.fun", kind: "url" }]);
});

test("a filename is not a host", () => {
  assert.deepEqual(extractSubjectCandidates("they quote src/chain.js and README.md"), []);
});

test("an address is a candidate; a truncated one is not", () => {
  assert.deepEqual(extractSubjectCandidates("what about 0x664f813ba5568966b8c7aaa03ef2218658a57777"), [
    { value: "0x664f813ba5568966b8c7aaa03ef2218658a57777", kind: "address" },
  ]);
  assert.deepEqual(extractSubjectCandidates("0x664f813ba55689"), []);
});

test("a host inside a URL is not also offered as a bare candidate", () => {
  const found = extractSubjectCandidates("https://csl.fun/docs and csl.fun again");
  assert.equal(found.length, 1);
  assert.equal(found[0].value, "https://csl.fun/docs");
});

/* -------------------------------- detection -------------------------------- */

test("ordinary questions want nothing, even when they carry a URL", () => {
  for (const q of [
    "how is nvda doing",
    "who holds the most tsla",
    "what is this address 0x664f813ba5568966b8c7aaa03ef2218658a57777",
    "whats on https://csl.fun",
    "top 5 stocks by market cap",
    "hello",
  ]) {
    assert.equal(detectResearchRequest(q).wanted, false, q);
  }
});

test("the words that name the ACT start one, on a URL or an address", () => {
  const url = detectResearchRequest("please do full diligence on https://csl.fun");
  assert.equal(url.wanted, true);
  assert.equal(url.want, RESEARCH_WANT.STRONG);
  assert.equal(url.subject.kind, "url");

  const address = detectResearchRequest("deep dive 0x664f813ba5568966b8c7aaa03ef2218658a57777");
  assert.equal(address.wanted, true);
  assert.equal(address.subject.kind, "address");

  for (const q of [
    "investigate https://csl.fun",
    "can you look into this properly https://csl.fun",
    "dig into https://csl.fun for me",
    "do a background check on https://csl.fun",
    "research this https://csl.fun",
  ]) {
    assert.equal(detectResearchRequest(q).wanted, true, q);
  }
});

test("the words that name the WORRY only start one when there is a URL to read", () => {
  // No URL: this is the ordinary project question the chain half already answers in
  // seconds, and a minutes-long job would spend an allowance to say the same thing.
  const bare = detectResearchRequest("is this a larp 0x664f813ba5568966b8c7aaa03ef2218658a57777");
  assert.equal(bare.wanted, false);

  const withUrl = detectResearchRequest("is this a larp https://csl.fun");
  assert.equal(withUrl.wanted, true);
  assert.equal(withUrl.want, RESEARCH_WANT.WEAK);
  assert.equal(withUrl.subject.given, "https://csl.fun");
});

test("A NAME IS NEVER A SUBJECT, however strongly the question is worded", () => {
  const res = detectResearchRequest("do full due diligence on the CSL project please");
  assert.equal(res.wanted, true);
  assert.equal(res.subject, null);
  assert.match(res.refusal, /will not go looking for a project's website by name/i);
  assert.match(res.refusal, /wrong people/i);
});

test("the target field counts as deliberately named as anything typed in the sentence", () => {
  const res = detectResearchRequest("investigate this properly", { target: "https://csl.fun/" });
  assert.equal(res.wanted, true);
  assert.equal(res.subject.given, "https://csl.fun/");
});

test("a URL beats an address, because the web half is what is being asked for", () => {
  const res = detectResearchRequest("deep dive on 0x664f813ba5568966b8c7aaa03ef2218658a57777 and https://csl.fun");
  assert.equal(res.subject.kind, "url");
});

test("pure and total: no input type throws and none of them wants anything", () => {
  for (const bad of [null, undefined, 42, {}, [], true]) {
    const res = detectResearchRequest(bad);
    assert.equal(res.wanted, false);
    assert.deepEqual(extractSubjectCandidates(bad), []);
  }
});
