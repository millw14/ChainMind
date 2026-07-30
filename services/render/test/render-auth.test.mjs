// Tests for THE DOOR — services/render/lib/auth.js and the boot-time configuration that
// refuses to open it without a secret.
//
// The failure this file exists to prevent is a render service that starts with no
// authentication. That is not a missing feature, it is an open proxy that runs the
// caller's JavaScript from this host's IP and hands back a screenshot — so "no secret
// configured" must fail CLOSED at boot, and must also fail closed in checkAuth itself if
// it is somehow reached.
//
// Fully offline.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTH_HEADER, checkAuth } from "../lib/auth.js";
import { MIN_SECRET_CHARS, parseViewport, readConfig } from "../lib/config.js";

const SECRET = "s".repeat(40);

test("the right token in the right header is the only thing that gets in", () => {
  assert.equal(checkAuth(`Bearer ${SECRET}`, SECRET).ok, true);
  assert.equal(checkAuth(`bearer ${SECRET}`, SECRET).ok, true, "the scheme is case-insensitive per RFC 7235");
  assert.equal(checkAuth(`  Bearer   ${SECRET}  `, SECRET).ok, true, "surrounding whitespace is not a rejection");
});

test("every other shape is refused", () => {
  const cases = [
    [undefined, /no Authorization header/],
    ["", /no Authorization header/],
    [SECRET, /not a Bearer token/],
    ["Basic " + Buffer.from(`x:${SECRET}`).toString("base64"), /not a Bearer token/],
    ["Bearer ", /not a Bearer token/],
    [`Bearer ${SECRET}x`, /wrong length/],
    [`Bearer ${"s".repeat(39)}`, /wrong length/],
    [`Bearer ${"t".repeat(40)}`, /does not match/],
    [{ not: "a string" }, /no Authorization header/],
  ];
  for (const [header, why] of cases) {
    const r = checkAuth(header, SECRET);
    assert.equal(r.ok, false, `${JSON.stringify(header)} was let in`);
    assert.match(r.reason, why);
  }
});

test("with no secret configured, NOBODY is authenticated rather than everybody", () => {
  // The direction of this failure is the whole point. A check that treated a missing
  // secret as "no check required" would turn one bad deploy into an open proxy.
  for (const secret of ["", null, undefined, 0]) {
    assert.equal(checkAuth("Bearer anything", secret).ok, false);
    assert.equal(checkAuth("Bearer ", secret).ok, false);
  }
  assert.match(checkAuth("Bearer x", "").reason, /no shared secret is configured/);
});

test("the header name is lowercase, because that is how node:http presents it", () => {
  // A guard against the classic bug where the check reads `Authorization` off a headers
  // object whose keys node has already lowercased, and therefore never matches — which
  // would fail closed, but by accident rather than by design.
  assert.equal(AUTH_HEADER, AUTH_HEADER.toLowerCase());
  assert.equal(AUTH_HEADER, "authorization");
});

/* ============================ boot configuration ============================ */

test("the service refuses to start without a shared secret, and says how to make one", () => {
  const r = readConfig({});
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /RENDER_SHARED_SECRET is not set/);
  assert.match(r.problems[0], /open proxy/i);
  assert.match(r.problems[0], /randomBytes/, "a refusal that does not say how to fix it is half a refusal");
});

test("a short secret is refused, and the refusal says why length is what gets checked", () => {
  const r = readConfig({ RENDER_SHARED_SECRET: "changeme" });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], new RegExp(`under the ${MIN_SECRET_CHARS}-character minimum`));
});

test("a valid configuration carries the secret and nothing else that is secret", () => {
  const r = readConfig({ RENDER_SHARED_SECRET: SECRET, PORT: "9099" });
  assert.equal(r.ok, true);
  assert.equal(r.config.secret, SECRET);
  assert.equal(r.config.port, 9099);
  // THE INVARIANT THIS SERVICE IS DESIGNED AROUND: one credential and no others. If a
  // future change adds a Redis URL, an API key or a session secret to this object, this
  // assertion is where it should stop.
  const keys = Object.keys(r.config).filter((k) => /secret|key|token|password|credential|url|dsn|conn/i.test(k));
  assert.deepEqual(keys, ["secret"], `the config grew a second credential-shaped field: ${keys.join(", ")}`);
});

test("junk in a numeric variable falls back to the default instead of producing NaN bounds", () => {
  const r = readConfig({ RENDER_SHARED_SECRET: SECRET, RENDER_MAX_CONCURRENCY: "not a number", RENDER_NAV_TIMEOUT_MS: "" });
  assert.equal(r.ok, true);
  assert.equal(Number.isFinite(r.config.maxConcurrency), true);
  assert.equal(r.config.maxConcurrency, 2);
  assert.equal(r.config.navTimeoutMs, 15_000);
});

test("out-of-range numbers are clamped, so no environment variable can remove a bound", () => {
  const r = readConfig({ RENDER_SHARED_SECRET: SECRET, RENDER_MAX_CONCURRENCY: "9999", RENDER_TOTAL_TIMEOUT_MS: "600000", RENDER_JS_HEAP_MB: "1" });
  assert.equal(r.config.maxConcurrency, 16);
  assert.equal(r.config.totalTimeoutMs, 90_000);
  assert.equal(r.config.jsHeapMb, 64);
});

test("the sandbox is on unless it is explicitly turned off", () => {
  assert.equal(readConfig({ RENDER_SHARED_SECRET: SECRET }).config.disableSandbox, false);
  assert.equal(readConfig({ RENDER_SHARED_SECRET: SECRET, RENDER_DISABLE_SANDBOX: "0" }).config.disableSandbox, false);
  assert.equal(readConfig({ RENDER_SHARED_SECRET: SECRET, RENDER_DISABLE_SANDBOX: "false" }).config.disableSandbox, false);
  assert.equal(readConfig({ RENDER_SHARED_SECRET: SECRET, RENDER_DISABLE_SANDBOX: "1" }).config.disableSandbox, true);
});

test("there is NO way to reach ignoreHTTPSErrors from the environment", () => {
  // Certificate verification is not a knob. A render taken over a connection that did not
  // verify could not honestly be attributed to the site it names, so the correct answer
  // to a TLS failure is to REPORT it (see lib/outcome.js "tls"), never to switch the
  // check off. This asserts the absence, because absence is the feature.
  const r = readConfig({
    RENDER_SHARED_SECRET: SECRET,
    RENDER_ALLOW_INSECURE_TLS: "1",
    RENDER_IGNORE_HTTPS_ERRORS: "1",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
  });
  assert.equal(r.ok, true);
  const serialized = JSON.stringify(r.config);
  assert.equal(/insecure|ignoreHTTPS|rejectUnauthorized/i.test(serialized), false, "a TLS-weakening switch reached the configuration");
});

test("a viewport is parsed or refused, never guessed at", () => {
  assert.deepEqual(parseViewport("1024x768"), { parsed: true, value: { width: 1024, height: 768 } });
  assert.deepEqual(parseViewport(" 390 X 844 "), { parsed: true, value: { width: 390, height: 844 } });
  assert.equal(parseViewport("wide").parsed, false);
  assert.deepEqual(parseViewport(undefined).value, { width: 1280, height: 800 });
  const r = readConfig({ RENDER_SHARED_SECRET: SECRET, RENDER_VIEWPORT: "enormous" });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /Refusing to guess/);
});
