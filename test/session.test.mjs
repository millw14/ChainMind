// Tests for the signed session cookie (lib/session.js). The interesting cases are
// all the ways a cookie can be WRONG — tampered, truncated, expired, signed for a
// different purpose, or signed with no secret at all. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearedCookie,
  createPreSessionCookie,
  createSessionCookie,
  isSessionConfigured,
  MIN_SECRET_CHARS,
  PRE_SESSION_COOKIE,
  readPreSessionCookie,
  readSessionCookie,
  SESSION_COOKIE,
  SessionUnconfiguredError,
  setSessionClock,
  shortAddress,
  signPayload,
  getSessionSecret,
} from "../lib/session.js";

const SECRET = "test-secret-that-is-long-enough-to-be-allowed";
const ADDRESS = "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB";

/** Every test states the secret it runs under; none of them inherit one. */
function withSecret(secret, body) {
  const previous = process.env.SESSION_SECRET;
  if (secret == null) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = secret;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous;
  }
}

/* ------------------------------ fail closed ------------------------------- */

test("a missing secret fails closed — no session can be issued", () => {
  withSecret(null, () => {
    assert.equal(isSessionConfigured(), false);
    assert.throws(() => getSessionSecret(), SessionUnconfiguredError);
    assert.throws(() => createSessionCookie(ADDRESS), SessionUnconfiguredError);
    assert.throws(() => createPreSessionCookie(), SessionUnconfiguredError);
  });
});

test("a missing secret fails closed on the READ side too", () => {
  // The dangerous shape of this bug is an unsigned cookie being accepted, so the
  // reader has to refuse as hard as the writer does — and without throwing, since
  // an unauthenticated visitor is an ordinary case.
  const cookie = withSecret(SECRET, () => createSessionCookie(ADDRESS).value);
  withSecret(null, () => {
    const res = readSessionCookie(cookie);
    assert.equal(res.ok, false);
    assert.equal(res.reason, "unconfigured");
  });
});

test("a too-short secret is treated as no secret", () => {
  withSecret("x".repeat(MIN_SECRET_CHARS - 1), () => {
    assert.equal(isSessionConfigured(), false);
    assert.throws(() => getSessionSecret(), /too short/);
  });
});

/* ------------------------------ happy path -------------------------------- */

test("a session round-trips the address, lowercased and non-empty", () => {
  withSecret(SECRET, () => {
    const cookie = createSessionCookie(ADDRESS);
    assert.equal(cookie.name, SESSION_COOKIE);
    const res = readSessionCookie(cookie.value);
    assert.equal(res.ok, true);
    assert.equal(res.address, ADDRESS.toLowerCase());
    assert.equal(res.expiresAt, cookie.expiresAt);
  });
});

test("the session cookie is httpOnly, SameSite=Lax and path-scoped", () => {
  withSecret(SECRET, () => {
    const { options } = createSessionCookie(ADDRESS);
    assert.equal(options.httpOnly, true);
    assert.equal(options.sameSite, "lax");
    assert.equal(options.path, "/");
    assert.ok(options.maxAge > 0);
  });
});

test("the cookie is Secure in production", () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    withSecret(SECRET, () => {
      assert.equal(createSessionCookie(ADDRESS).options.secure, true);
    });
  } finally {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  }
});

/* -------------------------------- tampering ------------------------------- */

test("a tampered payload is rejected — the address is not attacker-settable", () => {
  withSecret(SECRET, () => {
    const good = createSessionCookie(ADDRESS).value;
    const [encoded, mac] = good.split(".");

    // Swap in a completely different address, keeping the signature. This is the
    // attack the HMAC exists for: without it, a session is a free-text claim.
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    payload.address = "0x000000000000000000000000000000000000dead";
    const forged = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${mac}`;

    const res = readSessionCookie(forged);
    assert.equal(res.ok, false);
    assert.equal(res.reason, "bad-signature");
  });
});

test("a tampered signature is rejected", () => {
  withSecret(SECRET, () => {
    const good = createSessionCookie(ADDRESS).value;
    const [encoded, mac] = good.split(".");
    // The character is changed in the MIDDLE of the MAC, never at its end. A
    // 32-byte MAC is 43 base64url characters — 258 bits of alphabet for 256 bits
    // of value — so the final character carries two bits that decode away, and
    // rewriting it can leave the decoded MAC byte-identical. This assertion used
    // to do exactly that roughly one run in sixteen: a test that passed by
    // accident and pronounced the gate sound while checking nothing.
    const at = Math.floor(mac.length / 2);
    const flipped = `${encoded}.${mac.slice(0, at)}${mac[at] === "A" ? "B" : "A"}${mac.slice(at + 1)}`;
    assert.notEqual(flipped, good, "the tampering has to actually change the MAC");
    assert.equal(readSessionCookie(flipped).ok, false);
  });
});

test("a truncated signature is rejected rather than throwing", () => {
  withSecret(SECRET, () => {
    const good = createSessionCookie(ADDRESS).value;
    const [encoded] = good.split(".");
    // timingSafeEqual throws on a length mismatch; a short MAC must not 500.
    assert.equal(readSessionCookie(`${encoded}.AAAA`).reason, "bad-signature");
  });
});

test("a cookie signed with a different secret is rejected", () => {
  const foreign = withSecret("a-completely-different-secret-value-here!", () =>
    createSessionCookie(ADDRESS).value,
  );
  withSecret(SECRET, () => {
    assert.equal(readSessionCookie(foreign).ok, false);
  });
});

test("garbage and absence are rejected without throwing", () => {
  withSecret(SECRET, () => {
    for (const bad of [undefined, null, "", "no-dot", ".", "abc.", 42, {}]) {
      const res = readSessionCookie(bad);
      assert.equal(res.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
    }
  });
});

test("a validly signed cookie with no usable address is still not a session", () => {
  withSecret(SECRET, () => {
    // Signed by us, so the MAC checks out — but there is nothing to be logged in
    // AS. An address is the entire content of a session.
    const token = signPayload("session", { v: 1, address: "not-an-address", exp: Date.now() + 1000 });
    assert.equal(readSessionCookie(token).reason, "malformed");
  });
});

/* --------------------------------- expiry --------------------------------- */

test("an expired session is rejected", () => {
  withSecret(SECRET, () => {
    let now = 1_000_000;
    const restore = setSessionClock(() => now);
    try {
      const cookie = createSessionCookie(ADDRESS, { ttlMs: 60_000 });
      now += 59_999;
      assert.equal(readSessionCookie(cookie.value).ok, true);
      now += 1;
      assert.equal(readSessionCookie(cookie.value).reason, "expired");
    } finally {
      restore();
    }
  });
});

/* --------------------------- purpose separation --------------------------- */

test("a pre-session token cannot be used as a session cookie", () => {
  withSecret(SECRET, () => {
    const pre = createPreSessionCookie();
    assert.equal(pre.name, PRE_SESSION_COOKIE);
    assert.equal(readPreSessionCookie(pre.value).id, pre.id);

    // Same secret, different purpose. Without domain separation in the MAC input
    // this token — handed to anyone who asks for a nonce — would be a valid
    // session envelope.
    assert.equal(readSessionCookie(pre.value).ok, false);
    const session = createSessionCookie(ADDRESS);
    assert.equal(readPreSessionCookie(session.value).ok, false);
  });
});

test("each pre-session gets its own id", () => {
  withSecret(SECRET, () => {
    assert.notEqual(createPreSessionCookie().id, createPreSessionCookie().id);
  });
});

/* --------------------------------- logout --------------------------------- */

test("the cleared cookie both empties the value and expires it", () => {
  const cleared = clearedCookie(SESSION_COOKIE);
  assert.equal(cleared.value, "");
  assert.equal(cleared.options.maxAge, 0);
  assert.equal(cleared.options.httpOnly, true);
  withSecret(SECRET, () => {
    assert.equal(readSessionCookie(cleared.value).ok, false);
  });
});

/* --------------------------------- logging -------------------------------- */

test("shortAddress truncates — a full address never reaches a log line", () => {
  assert.equal(shortAddress(ADDRESS), "0xA5aA…1feB");
  assert.equal(shortAddress(""), "(none)");
  assert.equal(shortAddress(null), "(none)");
});
