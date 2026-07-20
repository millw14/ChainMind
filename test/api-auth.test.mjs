// Tests for the shared route auth helpers (lib/api-auth.js): the cron guard's
// 503/401/pass semantics, the timing-safe compare on length mismatch, and the
// operator bearer check. Run with: npm test
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { requireCronAuth, hasOperatorAuth, isSameOriginBrowser, clientIp } from "../lib/api-auth.js";

const ENV_KEYS = ["CRON_SECRET", "CHAINMIND_OPERATOR_SECRET", "GROQ_BRIEF_SECRET", "NEXT_PUBLIC_APP_URL"];
/** @type {Record<string, string | undefined>} */
let saved = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const req = (auth) =>
  new Request("http://localhost/api/cron/test", { headers: auth ? { authorization: auth } : {} });

test("requireCronAuth: unset CRON_SECRET → 503 naming the route", async () => {
  const res = requireCronAuth(req("Bearer whatever"), "/api/cron/test");
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /CRON_SECRET.*\/api\/cron\/test/);
});

test("requireCronAuth: wrong token → 401", async () => {
  process.env.CRON_SECRET = "topsecret";
  const res = requireCronAuth(req("Bearer notsecret"), "/api/cron/test");
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "Unauthorized" });
});

test("requireCronAuth: missing header → 401", () => {
  process.env.CRON_SECRET = "topsecret";
  assert.equal(requireCronAuth(req(null), "/api/cron/test").status, 401);
});

test("requireCronAuth: valid Bearer token → null (authorized)", () => {
  process.env.CRON_SECRET = "topsecret";
  assert.equal(requireCronAuth(req("Bearer topsecret"), "/api/cron/test"), null);
});

test("requireCronAuth: length-mismatched token rejects without throwing (timingSafeEqual guard)", () => {
  process.env.CRON_SECRET = "topsecret";
  // timingSafeEqual throws on unequal buffer lengths — the guard must pre-check.
  for (const auth of ["Bearer x", `Bearer topsecret-and-then-some`, "", "topsecret"]) {
    assert.equal(requireCronAuth(req(auth), "/api/cron/test").status, 401);
  }
});

test("hasOperatorAuth: no header or no configured secret → false", () => {
  assert.equal(hasOperatorAuth(req(null)), false);
  assert.equal(hasOperatorAuth(req("Bearer anything")), false);
});

test("hasOperatorAuth: matches CHAINMIND_OPERATOR_SECRET and legacy env keys", () => {
  process.env.CHAINMIND_OPERATOR_SECRET = "op-secret";
  process.env.GROQ_BRIEF_SECRET = "legacy-secret";
  assert.equal(hasOperatorAuth(req("Bearer op-secret")), true);
  assert.equal(hasOperatorAuth(req("Bearer legacy-secret")), false); // not passed as legacy key
  assert.equal(hasOperatorAuth(req("Bearer legacy-secret"), ["GROQ_BRIEF_SECRET"]), true);
  assert.equal(hasOperatorAuth(req("Bearer wrong"), ["GROQ_BRIEF_SECRET"]), false);
});

/** @param {Record<string, string>} headers */
const originReq = (headers) => new Request("http://dash.example/api/groq-brief", { method: "POST", headers });

test("isSameOriginBrowser: Sec-Fetch-Site same-origin is enough", () => {
  assert.equal(isSameOriginBrowser(originReq({ "sec-fetch-site": "same-origin" })), true);
  assert.equal(isSameOriginBrowser(originReq({ "sec-fetch-site": "cross-site" })), false);
});

test("isSameOriginBrowser: Origin matching the request's own host passes without NEXT_PUBLIC_APP_URL", () => {
  // Browsers that omit Fetch Metadata must not be locked out of their own dashboard.
  assert.equal(
    isSameOriginBrowser(originReq({ origin: "https://dash.example", host: "dash.example" })),
    true,
  );
  assert.equal(
    isSameOriginBrowser(originReq({ origin: "https://preview-xyz.vercel.app", host: "preview-xyz.vercel.app" })),
    true,
  );
});

test("isSameOriginBrowser: honors x-forwarded-host ahead of host", () => {
  assert.equal(
    isSameOriginBrowser(originReq({ origin: "https://app.example", "x-forwarded-host": "app.example", host: "internal:3000" })),
    true,
  );
});

test("isSameOriginBrowser: a genuinely foreign Origin is rejected", () => {
  assert.equal(isSameOriginBrowser(originReq({ origin: "https://evil.example", host: "dash.example" })), false);
  process.env.NEXT_PUBLIC_APP_URL = "https://dash.example";
  assert.equal(isSameOriginBrowser(originReq({ origin: "https://evil.example", host: "other.internal" })), false);
});

test("isSameOriginBrowser: falls back to NEXT_PUBLIC_APP_URL when the proxy rewrites Host", () => {
  process.env.NEXT_PUBLIC_APP_URL = "https://dash.example";
  assert.equal(isSameOriginBrowser(originReq({ origin: "https://dash.example", host: "internal-lb:8080" })), true);
});

test("isSameOriginBrowser: no Origin and no Fetch Metadata → false (server-to-server)", () => {
  assert.equal(isSameOriginBrowser(originReq({})), false);
  assert.equal(isSameOriginBrowser(originReq({ origin: "not a url", host: "dash.example" })), false);
});

test("clientIp: first x-forwarded-for hop, 'unknown' when absent", () => {
  const withXff = new Request("http://localhost/", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } });
  assert.equal(clientIp(withXff), "1.2.3.4");
  assert.equal(clientIp(new Request("http://localhost/")), "unknown");
});
