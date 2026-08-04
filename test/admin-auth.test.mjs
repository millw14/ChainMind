// Tests for the admin lock (lib/admin-auth.js): the password compare and the
// signed cookie. The cases that matter are the ways in should be REFUSED — no
// password configured, wrong password, no signing secret, a tampered cookie, and
// a cookie signed for a different purpose. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADMIN_COOKIE,
  clearedAdminCookie,
  createAdminCookie,
  isAdminConfigured,
  isAdminRequest,
  verifyAdminPassword,
} from "../lib/admin-auth.js";
import { createSessionCookie } from "../lib/session.js";

const SECRET = "admin-test-secret-that-is-long-enough-x";
const PASSWORD = "correct horse battery staple";

/** Run body with a given ADMIN_PASSWORD + SESSION_SECRET, then restore both. */
function withEnv({ password, secret }, body) {
  const prevP = process.env.ADMIN_PASSWORD;
  const prevS = process.env.SESSION_SECRET;
  if (password == null) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = password;
  if (secret == null) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = secret;
  try {
    return body();
  } finally {
    prevP === undefined ? delete process.env.ADMIN_PASSWORD : (process.env.ADMIN_PASSWORD = prevP);
    prevS === undefined ? delete process.env.SESSION_SECRET : (process.env.SESSION_SECRET = prevS);
  }
}

test("not configured without a password", () => {
  withEnv({ password: null, secret: SECRET }, () => {
    assert.equal(isAdminConfigured(), false);
    assert.equal(verifyAdminPassword("anything"), false);
  });
});

test("not configured without a signing secret", () => {
  withEnv({ password: PASSWORD, secret: null }, () => {
    assert.equal(isAdminConfigured(), false);
  });
});

test("configured with both", () => {
  withEnv({ password: PASSWORD, secret: SECRET }, () => {
    assert.equal(isAdminConfigured(), true);
  });
});

test("the right password verifies, wrong and near-miss do not", () => {
  withEnv({ password: PASSWORD, secret: SECRET }, () => {
    assert.equal(verifyAdminPassword(PASSWORD), true);
    assert.equal(verifyAdminPassword("wrong"), false);
    assert.equal(verifyAdminPassword(PASSWORD + " "), false); // length differs
    assert.equal(verifyAdminPassword(PASSWORD.toUpperCase()), false);
    assert.equal(verifyAdminPassword(""), false);
    assert.equal(verifyAdminPassword(undefined), false);
  });
});

test("a fresh cookie is accepted", () => {
  withEnv({ password: PASSWORD, secret: SECRET }, () => {
    const c = createAdminCookie();
    assert.equal(c.name, ADMIN_COOKIE);
    assert.equal(isAdminRequest(c.value), true);
  });
});

test("a tampered cookie is rejected", () => {
  withEnv({ password: PASSWORD, secret: SECRET }, () => {
    const c = createAdminCookie();
    assert.equal(isAdminRequest(c.value.slice(0, -3) + "aaa"), false);
    assert.equal(isAdminRequest(""), false);
    assert.equal(isAdminRequest(null), false);
  });
});

test("a cookie signed under a different secret is rejected", () => {
  const minted = withEnv({ password: PASSWORD, secret: SECRET }, () => createAdminCookie().value);
  withEnv({ password: PASSWORD, secret: "a-totally-different-secret-value-xx" }, () => {
    assert.equal(isAdminRequest(minted), false); // rotated key invalidates it
  });
});

test("a session cookie cannot masquerade as an admin cookie", () => {
  withEnv({ password: PASSWORD, secret: SECRET }, () => {
    // Same secret, different signing PURPOSE — must not cross over.
    const session = createSessionCookie("0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB");
    assert.equal(isAdminRequest(session.value), false);
  });
});

test("the cleared cookie is empty and expired", () => {
  const c = clearedAdminCookie();
  assert.equal(c.name, ADMIN_COOKIE);
  assert.equal(c.value, "");
  assert.equal(c.options.maxAge, 0);
});
