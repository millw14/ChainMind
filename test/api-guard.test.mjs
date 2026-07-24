// Tests for the public-API abuse guards (lib/api-guard.js): the same-origin
// check that keeps third-party pages off our upstream budget, and the coarse
// in-memory rate limiter. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSameOriginRequest, clientIp, rateLimit } from "../lib/api-guard.js";

/** Minimal stand-in for a Request — the guards only ever read headers. */
function req(headers) {
  return { headers: new Headers(headers ?? {}) };
}

test("isSameOriginRequest trusts a same-origin Sec-Fetch-Site", () => {
  assert.equal(isSameOriginRequest(req({ "sec-fetch-site": "same-origin" })), true);
});

test("isSameOriginRequest trusts Sec-Fetch-Site: none (user-typed URL)", () => {
  assert.equal(isSameOriginRequest(req({ "sec-fetch-site": "none" })), true);
});

test("isSameOriginRequest rejects a cross-site Sec-Fetch-Site", () => {
  assert.equal(isSameOriginRequest(req({ "sec-fetch-site": "cross-site" })), false);
  assert.equal(isSameOriginRequest(req({ "sec-fetch-site": "same-site" })), false);
});

test("isSameOriginRequest rejects a real cross-site fetch", () => {
  // What a third-party page's browser actually sends: their Origin, our Host.
  const r = req({ "sec-fetch-site": "cross-site", origin: "https://evil.example", host: "chainmind.app" });
  assert.equal(isSameOriginRequest(r), false);
});

test("isSameOriginRequest accepts a matching Origin and Host", () => {
  assert.equal(isSameOriginRequest(req({ origin: "https://chainmind.app", host: "chainmind.app" })), true);
});

test("isSameOriginRequest prefers X-Forwarded-Host over Host", () => {
  const r = req({ origin: "https://chainmind.app", host: "internal:3000", "x-forwarded-host": "chainmind.app" });
  assert.equal(isSameOriginRequest(r), true);
});

test("isSameOriginRequest rejects a foreign Origin", () => {
  assert.equal(isSameOriginRequest(req({ origin: "https://evil.example", host: "chainmind.app" })), false);
});

test("isSameOriginRequest falls back to NEXT_PUBLIC_APP_URL", () => {
  const prev = process.env.NEXT_PUBLIC_APP_URL;
  process.env.NEXT_PUBLIC_APP_URL = "https://chainmind.app";
  try {
    // No Host header at all: only the configured app URL can vouch for it.
    assert.equal(isSameOriginRequest(req({ origin: "https://chainmind.app" })), true);
    assert.equal(isSameOriginRequest(req({ origin: "https://evil.example" })), false);
  } finally {
    if (prev === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = prev;
  }
});

test("isSameOriginRequest rejects a request with no usable headers", () => {
  assert.equal(isSameOriginRequest(req()), false);
  assert.equal(isSameOriginRequest(req({ origin: "not a url" })), false);
  assert.equal(isSameOriginRequest({}), false);
  assert.equal(isSameOriginRequest(null), false);
});

test("clientIp takes the first X-Forwarded-For hop", () => {
  assert.equal(clientIp(req({ "x-forwarded-for": "203.0.113.7, 70.41.3.18" })), "203.0.113.7");
  assert.equal(clientIp(req({ "x-forwarded-for": "  203.0.113.7  " })), "203.0.113.7");
});

test("clientIp falls back to a shared bucket when the header is absent", () => {
  assert.equal(clientIp(req()), "unknown");
  assert.equal(clientIp(null), "unknown");
});

test("rateLimit allows requests up to the limit", () => {
  const key = "test-under-limit";
  assert.deepEqual(rateLimit(key, 3, 60_000), { allowed: true, remaining: 2 });
  assert.deepEqual(rateLimit(key, 3, 60_000), { allowed: true, remaining: 1 });
  assert.deepEqual(rateLimit(key, 3, 60_000), { allowed: true, remaining: 0 });
});

test("rateLimit blocks once the limit is exceeded", () => {
  const key = "test-over-limit";
  for (let i = 0; i < 2; i += 1) assert.equal(rateLimit(key, 2, 60_000).allowed, true);
  assert.deepEqual(rateLimit(key, 2, 60_000), { allowed: false, remaining: 0 });
  assert.equal(rateLimit(key, 2, 60_000).allowed, false, "stays blocked inside the window");
});

test("rateLimit counts each key independently", () => {
  const a = "test-key-a";
  const b = "test-key-b";
  assert.equal(rateLimit(a, 1, 60_000).allowed, true);
  assert.equal(rateLimit(a, 1, 60_000).allowed, false);
  // b must not inherit a's exhausted bucket.
  assert.equal(rateLimit(b, 1, 60_000).allowed, true);
});

test("rateLimit starts a fresh window after the old one expires", async () => {
  const key = "test-window-reset";
  assert.equal(rateLimit(key, 1, 1).allowed, true);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(rateLimit(key, 1, 1).allowed, true, "expired bucket is replaced, not incremented");
});
