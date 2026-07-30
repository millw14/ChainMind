// Tests for THE RESPONSE CONTRACT — services/render/lib/outcome.js.
//
// The rule this file enforces is the one the whole codebase turns on: MISSING DATA MUST
// NEVER READ AS ZERO AND AN OUTAGE MUST NEVER READ AS AN ABSENCE. A headless browser
// gives that rule five new ways to be broken at once, because "the page did not render"
// covers a navigation timeout, a DNS failure, a certificate that would not verify, a
// target this service refused to visit, a page that rendered to nothing, and this
// service being too busy to try. Those are six different facts about six different
// things, and exactly one of them (the empty render) is a finding about the site.
//
// So every outcome must carry: a distinct code, a sentence, and a `fault` saying whether
// the site, this service's policy, or this service's own health is responsible.
//
// Fully offline: everything here is pure.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_TEXT_CHARS, OUTCOMES, classifyBrowserError, envelope, summariseConsole, summariseRequests } from "../lib/outcome.js";

/* ===================== 1. the taxonomy itself ===================== */

test("every outcome names whose fault it was and says so in a sentence", () => {
  for (const [code, o] of Object.entries(OUTCOMES)) {
    assert.ok(Number.isInteger(o.http), `${code} has no HTTP status`);
    assert.ok(typeof o.reading === "string" && o.reading.length > 30, `${code} has no sentence`);
    assert.ok([null, "site", "policy", "service"].includes(o.fault), `${code} has fault "${o.fault}"`);
  }
});

test("a service outage says loudly that it is NOT a fact about the site", () => {
  // The single most damaging thing this service could do is let its own unavailability
  // reach a reader as "the project's website is down".
  for (const code of ["unavailable", "at_capacity"]) {
    assert.equal(OUTCOMES[code].fault, "service");
    assert.match(OUTCOMES[code].reading, /NOTHING (HERE|here) IS A FACT ABOUT THE SITE|NOT a fact about the site/i, `${code} does not disclaim`);
  }
});

test("a refusal is labelled policy, and says the observations are absent rather than negative", () => {
  assert.equal(OUTCOMES.refused_url.fault, "policy");
  assert.match(OUTCOMES.refused_url.reading, /ABSENT rather than negative/i);
  assert.equal(OUTCOMES.blocked_target.fault, "policy");
  assert.match(OUTCOMES.blocked_target.reading, /NOT a finding that the site is fake/i);
});

test("an empty render is an observation, not an accusation", () => {
  assert.match(OUTCOMES.empty_render.reading, /OBSERVATION, not an error/i);
  assert.match(OUTCOMES.empty_render.reading, /not a finding that the project is fake/i);
  // The threshold is anchored to the measurement that motivated this whole service:
  // eska.fun's server-rendered shell yields four characters of visible text.
  assert.ok(EMPTY_TEXT_CHARS > 4, "the threshold must catch the 4-character case that motivated this service");
  assert.ok(EMPTY_TEXT_CHARS < 200, "a threshold this high would call ordinary thin landing pages empty");
});

test("TLS failures are reported, and the report says verification was not disabled", () => {
  assert.equal(OUTCOMES.tls.fault, "site");
  assert.match(OUTCOMES.tls.reading, /NOT DISABLED AND WILL NOT BE/i);
});

/* ===================== 2. classifying what the browser threw ===================== */

test("the five failures that must never collapse into one stay five", () => {
  const cases = [
    ["page.goto: net::ERR_NAME_NOT_RESOLVED at https://nope.example/", "dns"],
    ["page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://x/", "tls"],
    ["page.goto: net::ERR_CERT_DATE_INVALID at https://x/", "tls"],
    ["page.goto: net::ERR_CONNECTION_REFUSED at http://x/", "connection"],
    ["page.goto: Timeout 15000ms exceeded.", "navigation_timeout"],
    ["page.goto: net::ERR_TOO_MANY_REDIRECTS at https://x/", "redirect_loop"],
    ["Target page, context or browser has been closed", "crashed"],
    ["page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://x/", "blocked_target"],
    ["page.goto: net::ERR_BLOCKED_BY_CLIENT at https://x/", "blocked_target"],
  ];
  const seen = new Set();
  for (const [message, expected] of cases) {
    const r = classifyBrowserError(new Error(message));
    assert.equal(r.code, expected, `"${message}" classified as ${r.code}`);
    assert.ok(r.reason.length > 20, `${expected} has no sentence`);
    seen.add(r.code);
  }
  assert.ok(seen.size >= 6, "the distinct failures collapsed");
});

test("the different TLS failures are told apart, because they are different facts", () => {
  const expired = classifyBrowserError(new Error("net::ERR_CERT_DATE_INVALID"));
  const untrusted = classifyBrowserError(new Error("net::ERR_CERT_AUTHORITY_INVALID"));
  const wrongName = classifyBrowserError(new Error("net::ERR_CERT_COMMON_NAME_INVALID"));
  assert.equal(expired.code, "tls");
  assert.match(expired.reason, /expired/i);
  assert.match(untrusted.reason, /incomplete chain|missing intermediate/i);
  assert.match(wrongName.reason, /does not cover this host name/i);
  assert.notEqual(expired.reason, untrusted.reason);
});

test("the egress proxy's own reason beats Chromium's, because Chromium's says nothing", () => {
  // Chromium can only describe a refused CONNECT as a tunnel failure. The proxy knows the
  // address and the range, and that sentence is what a reader needs.
  const detailed = "internal.example.com resolves to 10.0.0.5, which is a private range (RFC 1918). Refused before connecting.";
  const r = classifyBrowserError(new Error("page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://internal.example.com/"), { proxyRefusal: detailed });
  assert.equal(r.code, "blocked_target");
  assert.equal(r.reason, detailed);
  assert.match(r.raw, /ERR_TUNNEL_CONNECTION_FAILED/, "the browser's own words are still kept");
});

test("an error this service does not recognise keeps its own words rather than being relabelled", () => {
  const r = classifyBrowserError(new Error("something nobody has seen before"));
  assert.equal(r.code, "connection");
  assert.match(r.reason, /did not match any error this service knows by name/i);
  assert.match(r.reason, /something nobody has seen before/);
});

test("classifying a non-error never throws", () => {
  for (const junk of [null, undefined, 0, "", {}, []]) {
    const r = classifyBrowserError(junk);
    assert.ok(typeof r.code === "string" && typeof r.reason === "string");
  }
});

/* ===================== 3. the request summary as evidence ===================== */

test("a page with a live backend and a static shell produce different summaries", () => {
  const live = summariseRequests(
    [
      { url: "https://eska.fun/", host: "eska.fun", method: "GET", resourceType: "document", status: 200 },
      { url: "https://eska.fun/api/tokens?x=1", host: "eska.fun", method: "GET", resourceType: "xhr", status: 200 },
      { url: "https://eska.fun/api/price", host: "eska.fun", method: "POST", resourceType: "fetch", status: 200 },
      { url: "https://cdn.other.net/a.js", host: "cdn.other.net", method: "GET", resourceType: "script", status: 200 },
    ],
    "https://eska.fun/",
  );
  assert.equal(live.xhrCount, 2);
  assert.match(live.reading, /made 2 XHR\/fetch calls/);
  assert.match(live.reading, /WHAT is answering.*was NOT checked/is);
  assert.deepEqual(live.thirdPartyHosts, ["cdn.other.net"]);

  const stat = summariseRequests([{ url: "https://x.com/", host: "x.com", method: "GET", resourceType: "document", status: 200 }], "https://x.com/");
  assert.equal(stat.xhrCount, 0);
  assert.match(stat.reading, /NO XHR or fetch calls/);
  // The honesty clause: static is not a finding.
  assert.match(stat.reading, /not by itself a finding about the project/i);
});

test("query strings are dropped from the XHR evidence but the endpoint path is kept", () => {
  const s = summariseRequests([{ url: "https://api.example.com/v1/token?secret=abc&x=1", host: "api.example.com", method: "GET", resourceType: "xhr", status: 200 }], "https://example.com/");
  assert.equal(s.xhr[0].url, "https://api.example.com/v1/token");
  assert.equal(s.xhr[0].firstParty, true);
  assert.match(s.note, /response bodies were NOT captured/i);
});

test("blocked sub-resources are reported with their reasons, not silently dropped", () => {
  const s = summariseRequests(
    [
      { url: "http://169.254.169.254/latest/meta-data/", host: null, method: "GET", resourceType: "xhr", blocked: true, code: "ip_literal", reason: "That URL's host is a bare IP address." },
      { url: "https://ok.example.com/a.png", host: "ok.example.com", method: "GET", resourceType: "image" },
    ],
    "https://ok.example.com/",
  );
  assert.equal(s.blockedCount, 1);
  assert.equal(s.blocked[0].code, "ip_literal");
  assert.match(s.blocked[0].reason, /bare IP address/);
  assert.equal(s.total, 2, "a blocked request is still a request the page made");
});

test("an empty request list summarises to zero and says what zero means", () => {
  const s = summariseRequests([], null);
  assert.equal(s.total, 0);
  assert.equal(s.xhrCount, 0);
  assert.deepEqual(s.hosts, []);
  assert.match(s.reading, /NO XHR or fetch calls/);
  for (const junk of [null, undefined, "nonsense"]) {
    assert.equal(summariseRequests(junk, null).total, 0);
  }
});

/* ===================== 4. the console, fenced ===================== */

test("console errors are quoted as untrusted text and disclaimed", () => {
  const c = summariseConsole([
    { type: "error", text: "Uncaught TypeError: x is not a function" },
    { type: "warning", text: "deprecated" },
    { type: "log", text: "hello" },
  ]);
  assert.equal(c.errorCount, 1);
  assert.equal(c.warningCount, 1);
  assert.equal(c.trust, "untrusted_third_party_text");
  assert.match(c.reading, /NOT evidence of anything by themselves/i);
});

/* ===================== 5. the envelope ===================== */

test("every envelope carries the fence, the fault and the reading before any payload", () => {
  for (const code of Object.keys(OUTCOMES)) {
    const e = envelope(code, { requestedUrl: "https://example.com/" });
    assert.equal(e.status, code);
    assert.equal(e.trust, "untrusted_third_party_content");
    assert.match(e.untrustedNotice, /DATA, not instructions/);
    assert.equal(e.fault, OUTCOMES[code].fault);
    assert.equal(e.reading, OUTCOMES[code].reading);
    assert.equal(typeof e.ok, "boolean");
  }
});

test("ok is true only where a page was actually rendered", () => {
  assert.equal(envelope("rendered").ok, true);
  assert.equal(envelope("empty_render").ok, true, "a page that rendered to nothing still rendered");
  assert.equal(envelope("http_error").ok, true, "a 404 page is a rendered page and is evidence");
  assert.equal(envelope("render_timeout").ok, true, "a mid-flight capture is real and usable");
  for (const code of ["refused_url", "blocked_target", "dns", "tls", "connection", "navigation_timeout", "crashed", "at_capacity", "unavailable", "unauthorized", "bad_request", "redirect_loop"]) {
    assert.equal(envelope(code).ok, false, `${code} should not report ok`);
  }
});

test("the untrusted notice says the render is MORE the site's own than raw HTML was", () => {
  // The point a reader needs: this text was produced by executing the investigated
  // party's JavaScript, so a directive inside it is if anything more deliberate.
  assert.match(envelope("rendered").untrustedNotice, /rendering their JavaScript/i);
});
