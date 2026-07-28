// Tests for the public-API abuse guards (lib/api-guard.js): the same-origin
// check that keeps third-party pages off our upstream budget, and the coarse
// in-memory rate limiter. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clientIdentity,
  clientIp,
  isSameOriginRequest,
  rateLimit,
  trustedIpHeader,
  trustedProxyHops,
  UNKNOWN_CALLER,
} from "../lib/api-guard.js";

/** Minimal stand-in for a Request — the guards only ever read headers. */
function req(headers) {
  return { headers: new Headers(headers ?? {}) };
}

/** Run a body with a controlled set of env vars, restoring whatever was there. */
function withEnv(vars, body) {
  const previous = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return body();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
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

/* ----------------------------- caller identity ---------------------------- */

test("clientIp takes the hop OUR proxy appended, not the one the caller wrote", () => {
  // X-Forwarded-For is a list each proxy APPENDS to. With one trusted proxy the
  // last entry is the address it saw the connection come from; everything to the
  // left of it is whatever the caller chose to send.
  assert.equal(clientIp(req({ "x-forwarded-for": "203.0.113.7, 70.41.3.18" })), "70.41.3.18");
  assert.equal(clientIp(req({ "x-forwarded-for": "  203.0.113.7  " })), "203.0.113.7");
});

test("a spoofed X-Forwarded-For cannot mint a new identity", () => {
  // THE H2 REGRESSION. The attacker prepends anything they like; the real address
  // is still the entry the edge appended, so every one of these is the same
  // caller and spends the same allowance.
  const real = "198.51.100.9";
  const identities = new Set(
    ["", "1.2.3.4", "9.9.9.9, 8.8.8.8", "not-an-ip", `${real}, 10.0.0.1`].map((spoof) =>
      clientIp(req({ "x-forwarded-for": spoof ? `${spoof}, ${real}` : real })),
    ),
  );
  assert.deepEqual([...identities], [real], "every spoofed prefix resolves to one identity");
});

test("clientIdentity says when it does NOT trust what it found", () => {
  const direct = clientIdentity(req());
  assert.equal(direct.ip, UNKNOWN_CALLER);
  assert.equal(direct.trusted, false, "no forwarded header at all is not an identity");

  const good = clientIdentity(req({ "x-forwarded-for": "203.0.113.7, 70.41.3.18" }));
  assert.equal(good.trusted, true);
  assert.equal(good.source, "x-forwarded-for");
});

test("TRUSTED_PROXY_HOPS counts from the right", async () => {
  // Cloudflare in front of your own nginx: two appended hops, so the client is
  // two from the end.
  await withEnv({ TRUSTED_PROXY_HOPS: "2", VERCEL: null, TRUSTED_IP_HEADER: null }, () => {
    assert.equal(clientIp(req({ "x-forwarded-for": "evil, 203.0.113.7, 70.41.3.18" })), "203.0.113.7");
  });
  // A list shorter than the configured chain did not come through that chain.
  await withEnv({ TRUSTED_PROXY_HOPS: "2", VERCEL: null, TRUSTED_IP_HEADER: null }, () => {
    assert.equal(clientIp(req({ "x-forwarded-for": "203.0.113.7" })), UNKNOWN_CALLER);
  });
});

test("TRUSTED_PROXY_HOPS=0 refuses to read X-Forwarded-For at all", async () => {
  await withEnv({ TRUSTED_PROXY_HOPS: "0", VERCEL: null, TRUSTED_IP_HEADER: null }, () => {
    const id = clientIdentity(req({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }));
    assert.equal(id.ip, UNKNOWN_CALLER);
    assert.equal(id.trusted, false);
  });
});

test("a platform header the caller cannot forge wins over X-Forwarded-For", async () => {
  await withEnv({ TRUSTED_IP_HEADER: "cf-connecting-ip" }, () => {
    const r = req({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4, 5.6.7.8" });
    assert.equal(clientIp(r), "203.0.113.7");
  });
});

test("a configured platform header that is absent does NOT fall back to a spoofable one", async () => {
  await withEnv({ TRUSTED_IP_HEADER: "cf-connecting-ip" }, () => {
    // Falling back here would hand the spoofer back exactly what naming the
    // header took away.
    assert.equal(clientIp(req({ "x-forwarded-for": "1.2.3.4" })), UNKNOWN_CALLER);
  });
});

test("VERCEL selects the edge-written header without any extra configuration", async () => {
  await withEnv({ VERCEL: "1", TRUSTED_IP_HEADER: null }, () => {
    assert.equal(trustedIpHeader(), "x-vercel-forwarded-for");
    const r = req({ "x-vercel-forwarded-for": "203.0.113.7", "x-forwarded-for": "1.2.3.4" });
    assert.equal(clientIp(r), "203.0.113.7");
  });
});

test("trustedProxyHops defaults to one and ignores nonsense", async () => {
  await withEnv({ TRUSTED_PROXY_HOPS: null }, () => assert.equal(trustedProxyHops(), 1));
  await withEnv({ TRUSTED_PROXY_HOPS: "  " }, () => assert.equal(trustedProxyHops(), 1));
  await withEnv({ TRUSTED_PROXY_HOPS: "banana" }, () => assert.equal(trustedProxyHops(), 1));
  await withEnv({ TRUSTED_PROXY_HOPS: "-3" }, () => assert.equal(trustedProxyHops(), 1));
  await withEnv({ TRUSTED_PROXY_HOPS: "3" }, () => assert.equal(trustedProxyHops(), 3));
});

test("clientIp falls back to a shared bucket when the header is absent", () => {
  // ONE bucket, not a fresh one each time: "I have no identity" is the claim any
  // caller can always make, so it must not be the cheapest way to a new allowance.
  assert.equal(clientIp(req()), UNKNOWN_CALLER);
  assert.equal(clientIp(null), UNKNOWN_CALLER);
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
