// Tests for THE SSRF BOUNDARY — lib/safe-fetch.js, the only way this server fetches
// a URL somebody else chose.
//
// This file is the security test for the whole web half, and it is written from the
// attacker's side rather than the caller's. Six things are defended:
//
//  1. THE CLOUD METADATA ENDPOINT. 169.254.169.254 hands over the instance's
//     credentials to anything that can GET it. It is blocked as a literal, as a
//     resolved address, as an IPv4-mapped IPv6 address, through NAT64, and as a
//     redirect target.
//  2. LOOPBACK AND EVERY PRIVATE RANGE, in both address families, including the
//     ranges people forget: carrier-grade NAT, unique-local IPv6, and the v6 forms
//     that carry a v4 address inside them.
//  3. DNS REBINDING. The check and the connect must read the same bytes. They do,
//     because guardedLookup IS the resolver the socket uses — so a test that makes
//     the resolver answer a private address proves the connect never happens.
//  4. REDIRECTS. A public host answering "302 Location: http://127.0.0.1/" is the
//     realistic attack, and every hop gets the whole validation ladder again.
//  5. THE CAPS. Bytes, redirects and wall-clock time are bounded, and a truncated
//     read says it was truncated rather than presenting a prefix as the page.
//  6. EVERY REFUSAL SAYS WHY. A boolean is useless to a reader deciding what a
//     diligence report means, and worse to whoever has to debug it.
//
// Fully offline. The transport is injected for the redirect tests and the resolver
// is injected for the rebinding tests, so nothing here opens a socket — which is
// also the point: a local test server is unreachable BY DESIGN, because localhost
// and non-default ports are exactly what this module refuses.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SAFE_FETCH_LIMITS,
  classifyIp,
  guardedLookup,
  safeFetch,
  userAgent,
  validateUrl,
} from "../lib/safe-fetch.js";

/* ========================= 1. address classification ========================= */

test("every address that reaches this server's own network is blocked, with a reason", () => {
  const blocked = [
    ["127.0.0.1", /loopback/i],
    ["127.255.255.254", /loopback/i],
    ["0.0.0.0", /this network/i],
    ["10.0.0.1", /private/i],
    ["10.255.255.255", /private/i],
    ["172.16.0.1", /private/i],
    ["172.31.255.255", /private/i],
    ["192.168.1.1", /private/i],
    ["169.254.169.254", /metadata/i],
    ["169.254.0.1", /link-local/i],
    ["100.64.0.1", /carrier-grade NAT/i],
    ["198.18.0.1", /benchmark/i],
    ["224.0.0.1", /multicast/i],
    ["240.0.0.1", /reserved/i],
    ["255.255.255.255", /broadcast/i],
  ];
  for (const [ip, why] of blocked) {
    const r = classifyIp(ip);
    assert.equal(r.blocked, true, `${ip} was not blocked`);
    assert.match(r.reason, why, `${ip} was blocked without naming why`);
  }
});

test("the IPv6 equivalents are blocked too, including the forms that hide an IPv4 address", () => {
  const blocked = [
    ["::1", /loopback/i],
    ["::", /unspecified/i],
    ["fc00::1", /unique-local/i],
    ["fd12:3456::1", /unique-local/i],
    ["fe80::1", /link-local/i],
    ["ff02::1", /multicast/i],
    // The three that carry a v4 address and are the reason a prefix test is not enough.
    ["::ffff:127.0.0.1", /127\.0\.0\.1/],
    ["::ffff:169.254.169.254", /169\.254\.169\.254/],
    ["64:ff9b::a9fe:a9fe", /169\.254\.169\.254/],
    ["2002:7f00:1::", /6to4/i],
    ["2001:0:1::", /teredo/i],
  ];
  for (const [ip, why] of blocked) {
    const r = classifyIp(ip);
    assert.equal(r.blocked, true, `${ip} was not blocked`);
    assert.match(r.reason, why, `${ip} was blocked without naming why`);
  }
});

test("ordinary public addresses are allowed, in both families", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "93.184.216.34", "2606:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(classifyIp(ip).blocked, false, `${ip} was blocked and should not be`);
  }
});

test("an address the classifier cannot parse is BLOCKED, never allowed", () => {
  // DEFAULT DENY. A classifier that fell open on an encoding it did not understand
  // would be defeated by whichever encoding it did not understand.
  for (const junk of ["", null, undefined, "nonsense", "999.1.1.1", "1.2.3", "::gg", {}]) {
    assert.equal(classifyIp(junk).blocked, true, `${String(junk)} was not blocked`);
  }
});

/* ============================ 2. URL validation ============================ */

test("only http and https are fetched, and the refusal names the scheme", () => {
  for (const url of ["file:///etc/passwd", "gopher://x.com/", "ftp://x.com/", "data:text/html,hi", "ipfs://bafy"]) {
    const r = validateUrl(url);
    assert.equal(r.ok, false, `${url} was accepted`);
    assert.equal(r.code, "scheme");
    assert.match(r.refusal, /http and https/i);
  }
  assert.equal(validateUrl("https://example.org/x").ok, true);
  assert.equal(validateUrl("http://example.org/x").ok, true);
});

test("credentials in a URL are refused — they disguise the host and would be sent onward", () => {
  const r = validateUrl("https://user:pass@evil.org@example.org/");
  assert.equal(r.ok, false);
  assert.equal(r.code, "credentials");
  assert.match(r.refusal, /never sends credentials/i);
});

test("a bare IP host is refused whatever it points at, and a private one says which range", () => {
  for (const url of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "https://10.0.0.1/", "http://[::1]/"]) {
    const r = validateUrl(url);
    assert.equal(r.ok, false, `${url} was accepted`);
    assert.equal(r.code, "ip_literal");
  }
  // A PUBLIC IP literal is refused too: a project's website has a name.
  assert.equal(validateUrl("https://8.8.8.8/").ok, false);
  assert.match(validateUrl("http://169.254.169.254/").refusal, /link-local|metadata/i);
});

test("internal names and suffixes are refused BEFORE any DNS lookup", () => {
  const cases = [
    ["http://localhost/", "internal_name"],
    ["http://metadata.google.internal/computeMetadata/v1/", "internal_suffix"],
    ["http://something.local/", "internal_suffix"],
    ["http://box.lan/", "internal_suffix"],
    ["http://svc.corp/", "internal_suffix"],
    ["http://abc.onion/", "internal_suffix"],
    ["http://intranet/", "single_label"],
    ["http://instance-data/", "internal_name"],
  ];
  for (const [url, code] of cases) {
    const r = validateUrl(url);
    assert.equal(r.ok, false, `${url} was accepted`);
    assert.equal(r.code, code, `${url} refused for the wrong reason`);
  }
});

test("a trailing dot does not smuggle a host past the suffix checks", () => {
  // "something.local." is the same name as "something.local" to a resolver.
  assert.equal(validateUrl("http://something.local./").ok, false);
  assert.equal(validateUrl("http://localhost./").ok, false);
});

test("only the default ports are fetched", () => {
  assert.equal(validateUrl("http://example.org:8080/").ok, false);
  assert.equal(validateUrl("https://example.org:9200/").ok, false);
  assert.equal(validateUrl("https://example.org:443/").ok, true);
  assert.equal(validateUrl("http://example.org:80/").ok, true);
  assert.match(validateUrl("http://example.org:6379/").refusal, /port 6379/);
});

test("invisible and control characters in a URL are refused, not stripped", () => {
  // A zero-width space inside a hostname makes two different names look identical.
  // Rewriting it would fetch a URL nobody asked for and report it under the other's name.
  const zwsp = `https://exam${String.fromCharCode(0x200b)}ple.org/`;
  const r = validateUrl(zwsp);
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad_characters");
  assert.match(r.refusal, /never rewritten/i);
  assert.equal(validateUrl("https://example.org/a b").ok, false, "a space is not silently encoded");
});

test("an over-long URL is refused with its length, and an unparseable one says so", () => {
  const long = `https://example.org/${"a".repeat(SAFE_FETCH_LIMITS.MAX_URL_CHARS)}`;
  assert.equal(validateUrl(long).code, "too_long");
  assert.equal(validateUrl("not a url at all").ok, false);
  assert.equal(validateUrl("").code, "empty");
  assert.equal(validateUrl(null).code, "empty");
});

/* ======================= 3. resolution and DNS rebinding ======================= */

/** A resolver that answers whatever the test says, in node:dns lookup shape. */
function resolverFor(addresses) {
  return (_host, _opts, cb) => cb(null, addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
}

test("a name resolving into a blocked range fails before the socket is opened", async () => {
  const record = {};
  const lookup = guardedLookup({ record, resolve: resolverFor(["169.254.169.254"]) });
  const err = await new Promise((resolve) => lookup("evil.example.org", { all: true }, (e) => resolve(e)));
  assert.ok(err, "the lookup allowed a metadata address");
  assert.equal(err.code, "EBLOCKEDADDRESS");
  assert.match(err.message, /169\.254\.169\.254/);
  assert.match(err.message, /metadata/i);
  assert.equal(record.blocked.address, "169.254.169.254");
});

test("a name resolving to BOTH a public and a private address fails entirely", async () => {
  // The shape of a rebinding attempt. Connecting to the "good" half would be
  // co-operating with it, so the whole name is refused and the message says why.
  const lookup = guardedLookup({ resolve: resolverFor(["93.184.216.34", "127.0.0.1"]) });
  const err = await new Promise((resolve) => lookup("rebind.example.org", { all: true }, (e) => resolve(e)));
  assert.ok(err);
  assert.equal(err.code, "EBLOCKEDADDRESS");
  assert.match(err.message, /rebinding/i);
});

test("the guarded lookup answers both callback shapes, so it cannot break either connect path", async () => {
  const lookup = guardedLookup({ resolve: resolverFor(["93.184.216.34", "2606:4700::1111"]) });
  const all = await new Promise((resolve) => lookup("x.example.org", { all: true }, (_e, a) => resolve(a)));
  assert.deepEqual(all, [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:4700::1111", family: 6 },
  ]);
  const one = await new Promise((resolve) => lookup("x.example.org", { all: false }, (_e, a, f) => resolve([a, f])));
  assert.deepEqual(one, ["93.184.216.34", 4]);
  const v6 = await new Promise((resolve) => lookup("x.example.org", { all: false, family: 6 }, (_e, a, f) => resolve([a, f])));
  assert.deepEqual(v6, ["2606:4700::1111", 6]);
});

test("safeFetch on a host that resolves to loopback refuses without connecting", async () => {
  // End to end through the real transport: the connect never happens, because the
  // resolver the socket would have used is the one that refused.
  const res = await safeFetch("https://rebind.example.org/", { resolve: resolverFor(["127.0.0.1"]) });
  assert.equal(res.ok, false);
  assert.equal(res.code, "blocked_address");
  assert.match(res.refusal, /127\.0\.0\.1/);
  assert.match(res.refusal, /loopback/i);
});

/* ============================ 4. the redirect ladder ============================ */

/** A fake wire. Every check in safeFetch and guardedLookup stays in the path. */
function transportFrom(script) {
  return async (url) => {
    const key = String(url);
    const step = script[key];
    if (!step) throw new Error(`unscripted request to ${key}`);
    if (step.redirectTo) {
      return { ok: true, status: step.status ?? 302, headers: {}, location: step.redirectTo, bytes: 0, truncated: false, buffer: Buffer.alloc(0), remoteAddress: null };
    }
    const body = Buffer.from(step.body ?? "", "utf8");
    return {
      ok: true,
      status: step.status ?? 200,
      headers: { "content-type": step.contentType ?? "text/html", ...(step.headers ?? {}) },
      location: null,
      bytes: body.length,
      truncated: step.truncated ?? false,
      buffer: body,
      remoteAddress: "93.184.216.34",
    };
  };
}

test("a redirect from a public host into the cloud metadata endpoint is refused, not followed", async () => {
  // THE ATTACK THIS MODULE EXISTS FOR. A perfectly ordinary domain answers 302
  // Location: http://169.254.169.254/latest/meta-data/ and the credentials go out.
  const res = await safeFetch("https://friendly.example.org/", {
    transport: transportFrom({ "https://friendly.example.org/": { redirectTo: "http://169.254.169.254/latest/meta-data/" } }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, "blocked_redirect");
  assert.match(res.refusal, /169\.254\.169\.254/);
  assert.match(res.refusal, /bare IP address/i);
  // The hop is recorded as attempted and NOT followed, so a report can say so.
  assert.equal(res.redirects.length, 1);
  assert.equal(res.redirects[0].followed, false);
});

test("a redirect into loopback is refused the same way", async () => {
  const res = await safeFetch("https://friendly.example.org/", {
    transport: transportFrom({ "https://friendly.example.org/": { redirectTo: "http://127.0.0.1:80/admin" } }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, "blocked_redirect");
  assert.match(res.refusal, /127\.0\.0\.1/);
});

test("a redirect into a non-http scheme or an internal name is refused", async () => {
  for (const target of ["file:///etc/passwd", "http://metadata.google.internal/", "http://localhost/"]) {
    const res = await safeFetch("https://friendly.example.org/", {
      transport: transportFrom({ "https://friendly.example.org/": { redirectTo: target } }),
    });
    assert.equal(res.ok, false, `${target} was followed`);
    assert.equal(res.code, "blocked_redirect");
  }
});

test("an ordinary canonicalising redirect IS followed, and both URLs travel", async () => {
  const res = await safeFetch("https://example.org/", {
    transport: transportFrom({
      "https://example.org/": { redirectTo: "https://www.example.org/" },
      "https://www.example.org/": { body: "<html><body>hello</body></html>" },
    }),
    resolve: resolverFor(["93.184.216.34"]),
  });
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  // A finding about a page must be able to name the page that answered.
  assert.equal(res.requestedUrl, "https://example.org/");
  assert.equal(res.finalUrl, "https://www.example.org/");
  assert.equal(res.redirectCount, 1);
  assert.equal(res.redirects[0].followed, true);
  assert.match(res.body, /hello/);
});

test("the redirect chain is capped, and the cap is reported rather than silently followed", async () => {
  const script = {};
  for (let i = 0; i <= 8; i++) script[`https://h${i}.example.org/`] = { redirectTo: `https://h${i + 1}.example.org/` };
  const res = await safeFetch("https://h0.example.org/", { transport: transportFrom(script) });
  assert.equal(res.ok, false);
  assert.equal(res.code, "redirect_cap");
  assert.equal(res.redirects.length, SAFE_FETCH_LIMITS.MAX_REDIRECTS);
});

/* ============================== 5. the caps and the body ============================== */

test("a truncated response says it was truncated instead of presenting a prefix as the page", async () => {
  const res = await safeFetch("https://example.org/", {
    transport: transportFrom({ "https://example.org/": { body: "<html>abc", truncated: true } }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.truncated, true);
  assert.match(res.truncationNote, /NOT examined/i);
  assert.match(res.truncationNote, /unread, not absent/i);
});

test("a non-textual response is not decoded, and says so", async () => {
  const res = await safeFetch("https://example.org/x.pdf", {
    transport: transportFrom({ "https://example.org/x.pdf": { body: "%PDF-1.7 binary junk", contentType: "application/pdf" } }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.body, null);
  assert.equal(res.bodyDecoded, false);
  assert.match(res.bodyNote, /not text/i);
  assert.match(res.bodyNote, /NOT decoded or examined/i);
});

test("only the headers that answer \"whose infrastructure is this\" are kept", async () => {
  const res = await safeFetch("https://example.org/", {
    transport: transportFrom({
      "https://example.org/": {
        body: "<html></html>",
        headers: { server: "cloudflare", "x-vercel-id": "iad1::abc", "set-cookie": "session=secret", authorization: "Bearer x" },
      },
    }),
  });
  assert.equal(res.headers.server, "cloudflare");
  assert.equal(res.headers["x-vercel-id"], "iad1::abc");
  // A whole header bag is both a size problem and a place to hide text aimed at a
  // reader-machine; a cookie is never diligence evidence.
  assert.equal(res.headers["set-cookie"], undefined);
  assert.equal(res.headers.authorization, undefined);
});

test("the user agent identifies this server honestly and is contactable", () => {
  // A diligence tool that pretended to be a browser would be indistinguishable from
  // the scrapers operators block, and this one wants to be blockable if unwanted.
  const ua = userAgent();
  assert.match(ua, /ChainMindBot/);
  assert.match(ua, /https:\/\//);
  assert.ok(!/Mozilla/.test(ua), "the user agent must not impersonate a browser");
});

test("a refusal always carries a sentence, never a bare boolean", async () => {
  const refusals = [
    validateUrl("file:///x"),
    validateUrl("http://localhost/"),
    validateUrl("https://8.8.8.8/"),
    validateUrl("https://example.org:8080/"),
    await safeFetch("https://rebind.example.org/", { resolve: resolverFor(["10.0.0.5"]) }),
  ];
  for (const r of refusals) {
    assert.equal(r.ok, false);
    assert.equal(typeof r.refusal, "string");
    assert.ok(r.refusal.length > 40, `refusal too terse: ${r.refusal}`);
  }
});
