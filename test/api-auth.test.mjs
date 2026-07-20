// Tests for the shared route auth helpers (lib/api-auth.js): the cron guard's
// 503/401/pass semantics, the timing-safe compare on length mismatch, and the
// operator bearer check. Run with: npm test
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { requireCronAuth, hasOperatorAuth, clientIp } from "../lib/api-auth.js";

const ENV_KEYS = ["CRON_SECRET", "CHAINMIND_OPERATOR_SECRET", "GROQ_BRIEF_SECRET"];
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

test("clientIp: first x-forwarded-for hop, 'unknown' when absent", () => {
  const withXff = new Request("http://localhost/", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } });
  assert.equal(clientIp(withXff), "1.2.3.4");
  assert.equal(clientIp(new Request("http://localhost/")), "unknown");
});
