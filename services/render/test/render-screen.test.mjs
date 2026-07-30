// Tests for THE PER-REQUEST SCREEN — services/render/lib/screen.js, the predicate that
// every single thing a headless browser wants to fetch has to satisfy.
//
// WHY THIS FILE IS SEPARATE FROM test/safe-fetch.test.mjs. That file proves the SSRF
// ladder itself is sound. This one proves the browser layer actually USES it, and that
// the three things a browser can do which an HTTP GET cannot are handled:
//
//   1. a page fetches sub-resources from wherever it likes, including internal addresses;
//   2. a page can navigate ITSELF after load — meta-refresh, location =, a form submit —
//      so the URL that was screened is not necessarily the URL that gets rendered;
//   3. a page can name schemes an HTTP fetcher never meets: data:, blob:, file:, chrome:,
//      ws:. Some of those open no socket and are ordinary; some read this container's
//      disk. They are not the same and must not be treated the same.
//
// Fully offline: the predicate is pure.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { SUBRESOURCE_URL_CHARS, hostOf, sameSite, schemeOf, screenNavigation, screenRequest } from "../lib/screen.js";

/* ===================== 1. the ladder is the shared one ===================== */

test("a sub-resource aimed at this server's own network is refused, with the range named", () => {
  const cases = [
    ["http://localhost/admin", /localhost|internal/i],
    ["http://127.0.0.1/", /bare IP address/i],
    ["http://169.254.169.254/latest/meta-data/", /bare IP address/i],
    ["http://10.0.0.5/", /bare IP address/i],
    ["http://[::1]/", /bare IP address/i],
    ["http://metadata.google.internal/computeMetadata/v1/", /\.internal/i],
    ["http://redis.lan/", /\.lan/i],
    ["http://foo.localhost/", /\.localhost/i],
    ["http://vault/", /single-label/i],
    ["https://example.com:6379/", /port 6379/i],
    ["https://user:pass@example.com/", /credentials/i],
  ];
  for (const [url, why] of cases) {
    const v = screenRequest(url, { topLevel: false });
    assert.equal(v.allow, false, `${url} was allowed`);
    assert.match(v.reason, why, `${url} was refused without naming why`);
  }
});

test("an ordinary third-party sub-resource is allowed — screening must not break real pages", () => {
  for (const url of ["https://fonts.gstatic.com/s/x.woff2", "https://cdn.jsdelivr.net/npm/a.js", "http://example.com/img.png", "https://api.example.com/v1/tokens?limit=10"]) {
    const v = screenRequest(url, { topLevel: false });
    assert.equal(v.allow, true, `${url} was refused: ${v.reason}`);
    assert.equal(v.reason, null);
  }
});

/* ===================== 2. schemes a browser can name ===================== */

test("networkless schemes are allowed as sub-resources and refused as a navigation", () => {
  for (const url of ["data:image/png;base64,iVBOR", "blob:https://example.com/abc", "about:blank"]) {
    assert.equal(screenRequest(url, { topLevel: false }).allow, true, `${url} should be an allowed sub-resource`);
    const nav = screenRequest(url, { topLevel: true });
    assert.equal(nav.allow, false, `${url} should not be a permitted navigation`);
    assert.equal(nav.code, "networkless_navigation");
    assert.match(nav.reason, /no host, no certificate and no operator/i);
  }
});

test("schemes that reach this container or the browser's internals are refused everywhere", () => {
  const cases = [
    ["file:///etc/passwd", /filesystem/i],
    ["chrome://settings", /internal pages/i],
    ["devtools://devtools/bundled/x.js", /debugging interface/i],
    ["view-source:https://example.com", /internal pages/i],
    ["javascript:alert(1)", /script, not a fetch/i],
    ["ftp://example.com/x", /not a web protocol/i],
    ["ws://example.com/socket", /WebSocket/i],
    ["wss://example.com/socket", /WebSocket/i],
    ["gopher://example.com/", /Only http and https/i],
  ];
  for (const [url, why] of cases) {
    for (const topLevel of [true, false]) {
      const v = screenRequest(url, { topLevel });
      assert.equal(v.allow, false, `${url} allowed at topLevel=${topLevel}`);
      assert.match(v.reason, why, `${url} refused without naming why`);
    }
  }
});

/* ===================== 3. the page moving itself ===================== */

test("a navigation the page performs is screened again and the refusal names where it came from", () => {
  const v = screenNavigation("http://169.254.169.254/latest/meta-data/", { from: "the page" });
  assert.equal(v.allow, false);
  assert.match(v.reason, /the page tried to send this browser to/i);
  assert.match(v.reason, /169\.254\.169\.254/);
  assert.match(v.code, /^navigation_/);
});

test("a navigation to a legitimate page is allowed, so a redirect to www does not read as an attack", () => {
  const v = screenNavigation("https://www.ponsfamily.com/", { from: "the page" });
  assert.equal(v.allow, true);
  assert.equal(v.host, "www.ponsfamily.com");
});

test("an empty or unparseable URL is refused rather than falling through as allowed", () => {
  for (const raw of ["", "   ", null, undefined, 42, {}]) {
    assert.equal(screenRequest(raw, { topLevel: true }).allow, false, `${String(raw)} was allowed`);
  }
  const junk = screenRequest("http://exa mple.com/", { topLevel: false });
  assert.equal(junk.allow, false);
});

test("every refusal carries a code AND a sentence — a boolean is useless to whoever reads the render", () => {
  for (const url of ["http://127.0.0.1/", "file:///etc/passwd", "http://vault/", "data:text/html,x"]) {
    const v = screenRequest(url, { topLevel: true });
    assert.equal(v.allow, false);
    assert.ok(typeof v.code === "string" && v.code.length > 0, `${url} has no code`);
    assert.ok(typeof v.reason === "string" && v.reason.length > 20, `${url} has no sentence`);
  }
});

/* ===================== 4. the small helpers ===================== */

test("schemeOf and hostOf answer honestly and never throw", () => {
  assert.equal(schemeOf("HTTPS://Example.com/"), "https:");
  assert.equal(schemeOf("data:text/html,x"), "data:");
  assert.equal(schemeOf("not a url"), "");
  assert.equal(hostOf("https://WWW.Example.COM./x"), "www.example.com");
  assert.equal(hostOf("garbage"), null);
});

test("sameSite is the descriptive label it claims to be, and is never a security decision", () => {
  assert.equal(sameSite("https://a.example.com/", "https://b.example.com/"), true);
  assert.equal(sameSite("https://example.com/", "https://tracker.net/"), false);
  // The documented crudeness: no public-suffix list. Asserted so the limitation is
  // visible in the test file rather than only in a comment.
  assert.equal(sameSite("https://a.co.uk/", "https://b.co.uk/"), true);
});

/* ===== 5. the cap that is right for a pasted URL and wrong for a page's own API ===== */

// FOUND BY MEASURING, not by review. lib/safe-fetch.js caps a URL at 512 characters,
// which is correct for a URL somebody pasted or a token declared on chain. Applied to
// every sub-resource, it blocked www.ponsfamily.com's OWN market and wallet-identity
// endpoints — real first-party calls carrying 1,007, 2,669 and 5,757 characters of
// batched addresses — so the render showed a shell where a visitor sees a populated site.
// That is the exact failure this service exists to fix, reintroduced one layer down.

test("a page's own long API call is allowed, while the same length is refused for a target", () => {
  const long = `https://www.ponsfamily.com/api/pons-wallet-identity?addresses=${new Array(120).fill("0x0053bc8f80e2014e38d240b91127115d7d70cff9").join("%2C")}`;
  assert.ok(long.length > 5_000);

  const sub = screenRequest(long, { topLevel: false });
  assert.equal(sub.allow, true, `a first-party API call was refused: ${sub.reason}`);
  assert.equal(sub.host, "www.ponsfamily.com");

  // The supplied-URL cap is untouched: 512 characters is still the rule for the one URL
  // a person or a launch transaction handed us.
  const top = screenRequest(long, { topLevel: true });
  assert.equal(top.allow, false);
  assert.equal(top.code, "too_long");
});

test("dropping the query does NOT drop any rule that decides where a socket goes", () => {
  // The claim being tested: SSRF is decided by scheme, credentials, host and port, and a
  // query string cannot move a socket. So every one of those must still refuse, no matter
  // how long the query is that follows it.
  const tail = `?x=${"a".repeat(2_000)}`;
  const cases = [
    [`http://127.0.0.1/p${tail}`, /bare IP address/i],
    [`http://169.254.169.254/p${tail}`, /bare IP address/i],
    [`http://metadata.google.internal/p${tail}`, /\.internal/i],
    [`http://localhost/p${tail}`, /localhost/i],
    [`http://vault/p${tail}`, /single-label/i],
    [`https://example.com:6379/p${tail}`, /port 6379/i],
    [`https://user:pass@internal.example.com/p${tail}`, /credentials/i],
    [`file:///etc/passwd${tail}`, /filesystem/i],
  ];
  for (const [url, why] of cases) {
    const v = screenRequest(url, { topLevel: false });
    assert.equal(v.allow, false, `${url.slice(0, 60)}… was allowed`);
    assert.match(v.reason, why);
  }
});

test("a sub-resource URL is still bounded, just far more generously", () => {
  const huge = `https://example.com/?x=${"a".repeat(SUBRESOURCE_URL_CHARS)}`;
  const v = screenRequest(huge, { topLevel: false });
  assert.equal(v.allow, false);
  assert.equal(v.code, "too_long");
  assert.match(v.reason, /Pages legitimately issue long query strings/);
});

test("an allowed http(s) verdict carries the URL object the connection must use", () => {
  // The proxy connects to `verdict.url` rather than parsing the string a second time: two
  // parses are how a screen and a connection come to disagree about which host was
  // approved, and the one that decides the socket is the one that was not checked.
  const v = screenRequest("https://Example.COM/a/b?q=1", { topLevel: false });
  assert.equal(v.allow, true);
  assert.ok(v.url instanceof URL);
  assert.equal(v.url.hostname, "example.com");
  assert.equal(v.url.pathname, "/a/b");
  assert.equal(screenRequest("http://127.0.0.1/", { topLevel: false }).url, null, "a refusal must never hand back a URL to connect to");
});
