// Tests for wallet sign-in (lib/wallet-auth.js).
//
// The signatures here are REAL: a throwaway private key signs with viem and the
// verifier recovers from it. Nothing about the crypto is mocked, because the bugs
// worth catching in a token gate — a replayed nonce, a signature farmed on another
// domain, a signature that belongs to a different address — all live in the gap
// between "the maths checks out" and "the maths checks out about the right thing".
// A mocked verifier passes every one of them. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createMemoryStore } from "../lib/store.js";
import { getChainConfig } from "../lib/chain.js";
import {
  authDomain,
  buildSignInMessage,
  issueNonce,
  REJECT,
  verifySignIn,
} from "../lib/wallet-auth.js";

const DOMAIN = "chainmind.fun";
const PRE_SESSION = "pre-session-id-under-test";

/**
 * Run a body with ONLY the given domain variables set — everything else that
 * could name a domain is cleared, so "nothing configured" really is nothing.
 */
function withDomainEnv(vars, body) {
  const names = ["AUTH_DOMAIN", "NEXT_PUBLIC_APP_URL"];
  const previous = {};
  for (const name of names) {
    previous[name] = process.env[name];
    if (vars[name] == null) delete process.env[name];
    else process.env[name] = vars[name];
  }
  try {
    return body();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

/** A fresh throwaway key per test. Never a real one, never persisted. */
function throwawayAccount() {
  return privateKeyToAccount(generatePrivateKey());
}

/** Issue a challenge and sign it exactly as an honest client would. */
async function signChallenge(account, challenge, overrides = {}) {
  const message = buildSignInMessage({
    domain: challenge.domain,
    address: account.address,
    chainId: challenge.chainId,
    nonce: challenge.nonce,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    ...overrides,
  });
  return account.signMessage({ message });
}

async function setup() {
  const store = createMemoryStore();
  const account = throwawayAccount();
  const challenge = await issueNonce({ store, domain: DOMAIN, preSessionId: PRE_SESSION });
  return { store, account, challenge };
}

/* -------------------------------- happy path ------------------------------ */

test("a valid signature logs in", async () => {
  const { store, account, challenge } = await setup();
  const signature = await signChallenge(account, challenge);

  const res = await verifySignIn({
    store,
    address: account.address,
    signature,
    preSessionId: PRE_SESSION,
    domain: DOMAIN,
  });

  assert.equal(res.ok, true);
  assert.equal(res.address, account.address, "the checksummed address comes back");
});

test("a lowercased address still verifies — casing is not identity", async () => {
  const { store, account, challenge } = await setup();
  const signature = await signChallenge(account, challenge);
  const res = await verifySignIn({
    store,
    address: account.address.toLowerCase(),
    signature,
    preSessionId: PRE_SESSION,
    domain: DOMAIN,
  });
  assert.equal(res.ok, true);
  assert.equal(res.address, account.address);
});

test("the signed message names the chain and promises it is not a transaction", async () => {
  const { challenge } = await setup();
  const message = buildSignInMessage({
    domain: challenge.domain,
    address: "0x0000000000000000000000000000000000000001",
    chainId: challenge.chainId,
    nonce: challenge.nonce,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
  });
  assert.match(message, new RegExp(`^${DOMAIN} wants you to sign in`));
  assert.match(message, new RegExp(`Chain ID: ${getChainConfig().id}`));
  assert.match(message, /Nonce: /);
  assert.match(message, /Issued At: /);
  // Invariant: the user is told, in the bytes they are signing, that this cannot
  // move funds. If this assertion is ever deleted, so was the promise.
  assert.match(message, /not a transaction/);
  assert.match(message, /cannot move funds, grant an allowance, or spend gas/);
});

/* --------------------------------- replay --------------------------------- */

test("a replayed nonce is rejected", async () => {
  const { store, account, challenge } = await setup();
  const signature = await signChallenge(account, challenge);

  const first = await verifySignIn({
    store,
    address: account.address,
    signature,
    preSessionId: PRE_SESSION,
    domain: DOMAIN,
  });
  assert.equal(first.ok, true);

  // The exact same signature again. Without single-use nonces this is a
  // permanent login for anyone who ever captured it.
  const second = await verifySignIn({
    store,
    address: account.address,
    signature,
    preSessionId: PRE_SESSION,
    domain: DOMAIN,
  });
  assert.equal(second.ok, false);
  assert.equal(second.reason, REJECT.NONCE_UNKNOWN);
});

test("a failed attempt still burns the nonce", async () => {
  const { store, account, challenge } = await setup();
  const good = await signChallenge(account, challenge);

  // Wrong signer first: the challenge is consumed even though nothing verified,
  // so a wrong guess cannot be used to probe whether it is still live.
  const other = throwawayAccount();
  const bad = await signChallenge(other, challenge);
  const failed = await verifySignIn({
    store,
    address: account.address,
    signature: bad,
    preSessionId: PRE_SESSION,
    domain: DOMAIN,
  });
  assert.equal(failed.reason, REJECT.SIGNATURE_MISMATCH);

  const retry = await verifySignIn({
    store,
    address: account.address,
    signature: good,
    preSessionId: PRE_SESSION,
    domain: DOMAIN,
  });
  assert.equal(retry.ok, false);
  assert.equal(retry.reason, REJECT.NONCE_UNKNOWN);
});

test("asking for a second challenge replaces the first", async () => {
  const { store, account, challenge } = await setup();
  const signature = await signChallenge(account, challenge);
  await issueNonce({ store, domain: DOMAIN, preSessionId: PRE_SESSION });

  const res = await verifySignIn({
    store,
    address: account.address,
    signature,
    preSessionId: PRE_SESSION,
    domain: DOMAIN,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, REJECT.SIGNATURE_MISMATCH);
});

/* --------------------------------- expiry --------------------------------- */

test("an expired nonce is rejected", async () => {
  const { store, account, challenge } = await setup();
  const signature = await signChallenge(account, challenge);

  const expiredAt = new Date(challenge.expiresAt).getTime();
  const res = await verifySignIn({
    store,
    address: account.address,
    signature,
    preSessionId: PRE_SESSION,
    domain: DOMAIN,
    now: expiredAt,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, REJECT.NONCE_EXPIRED, "expiry is inclusive of the boundary");
});

test("a nonce one millisecond before expiry still works", async () => {
  const { store, account, challenge } = await setup();
  const signature = await signChallenge(account, challenge);
  const res = await verifySignIn({
    store,
    address: account.address,
    signature,
    preSessionId: PRE_SESSION,
    domain: DOMAIN,
    now: new Date(challenge.expiresAt).getTime() - 1,
  });
  assert.equal(res.ok, true);
});

/* ------------------------------ wrong address ----------------------------- */

test("a signature for a different address is rejected", async () => {
  const { store, challenge } = await setup();
  const signer = throwawayAccount();
  const victim = throwawayAccount();

  // Signed by `signer`, but claiming to be `victim`. The recovered address is the
  // one that decides, never the one in the request body.
  const signature = await signChallenge(signer, challenge);
  const res = await verifySignIn({
    store,
    address: victim.address,
    signature,
    preSessionId: PRE_SESSION,
    domain: DOMAIN,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, REJECT.SIGNATURE_MISMATCH);
});

test("a signature over someone else's address in the message is rejected", async () => {
  const { store, account, challenge } = await setup();
  const victim = throwawayAccount();
  // The right key signs a message naming the VICTIM's address, then claims to be
  // the victim. The server rebuilds around the claimed address, so the bytes it
  // recovers from are not the bytes that were signed.
  const signature = await signChallenge(account, challenge, { address: victim.address });
  const res = await verifySignIn({
    store,
    address: victim.address,
    signature,
    preSessionId: PRE_SESSION,
    domain: DOMAIN,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, REJECT.SIGNATURE_MISMATCH);
});

test("a malformed address is rejected before any crypto runs", async () => {
  const { store, account, challenge } = await setup();
  const signature = await signChallenge(account, challenge);
  for (const bad of ["", "0x", "not-an-address", null, "0x123"]) {
    const res = await verifySignIn({
      store,
      address: bad,
      signature,
      preSessionId: PRE_SESSION,
      domain: DOMAIN,
    });
    assert.equal(res.reason, REJECT.BAD_ADDRESS);
  }
});

test("a malformed signature is rejected by shape, not by exception", async () => {
  const { store, account } = await setup();
  for (const bad of ["", "0x", "deadbeef", null, `0x${"a".repeat(129)}`]) {
    const res = await verifySignIn({
      store,
      address: account.address,
      signature: bad,
      preSessionId: PRE_SESSION,
      domain: DOMAIN,
    });
    assert.equal(res.reason, REJECT.BAD_SIGNATURE_FORMAT);
  }
});

/* ------------------------------ wrong domain ------------------------------ */

test("a signature farmed for another domain is rejected", async () => {
  const { store, account, challenge } = await setup();
  // What a phishing page gets: the real key, signing a message that names THEIR
  // domain. Replaying it here fails because the server rebuilds the message with
  // its own domain — the domain is never taken from the request.
  const signature = await signChallenge(account, challenge, { domain: "evil.example" });

  const res = await verifySignIn({
    store,
    address: account.address,
    signature,
    preSessionId: PRE_SESSION,
    domain: DOMAIN,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, REJECT.SIGNATURE_MISMATCH);
});

test("a signature for another chain id is rejected", async () => {
  const { store, account, challenge } = await setup();
  const signature = await signChallenge(account, challenge, { chainId: 1 });
  const res = await verifySignIn({
    store,
    address: account.address,
    signature,
    preSessionId: PRE_SESSION,
    domain: DOMAIN,
  });
  assert.equal(res.reason, REJECT.SIGNATURE_MISMATCH);
});

test("a nonce issued for one host cannot be redeemed on another", async () => {
  const { store, account, challenge } = await setup();
  const signature = await signChallenge(account, challenge);
  const res = await verifySignIn({
    store,
    address: account.address,
    signature,
    preSessionId: PRE_SESSION,
    domain: "staging.chainmind.fun",
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, REJECT.DOMAIN_MISMATCH);
});

/* ---------------------------- pre-session binding ------------------------- */

test("a nonce cannot be redeemed without the pre-session it was issued to", async () => {
  const { store, account, challenge } = await setup();
  const signature = await signChallenge(account, challenge);
  const res = await verifySignIn({
    store,
    address: account.address,
    signature,
    preSessionId: null,
    domain: DOMAIN,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, REJECT.NO_PRE_SESSION);
});

test("another browser's pre-session cannot reach this challenge", async () => {
  const { store, account, challenge } = await setup();
  const signature = await signChallenge(account, challenge);
  const res = await verifySignIn({
    store,
    address: account.address,
    signature,
    preSessionId: "someone-elses-pre-session",
    domain: DOMAIN,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, REJECT.NONCE_UNKNOWN);
});

/* ---------------------------------- misc ---------------------------------- */

test("each challenge carries its own nonce", async () => {
  const store = createMemoryStore();
  const a = await issueNonce({ store, domain: DOMAIN, preSessionId: "a" });
  const b = await issueNonce({ store, domain: DOMAIN, preSessionId: "b" });
  assert.notEqual(a.nonce, b.nonce);
  assert.ok(a.nonce.length >= 40, "a nonce needs real entropy behind it");
});

test("issueNonce refuses to make an unbound challenge", async () => {
  const store = createMemoryStore();
  await assert.rejects(() => issueNonce({ store, domain: DOMAIN, preSessionId: "" }));
  await assert.rejects(() => issueNonce({ store, domain: "", preSessionId: "x" }));
});

/* ---------------------------- the signed domain ---------------------------- */

test("authDomain reads server configuration and nothing else", () => {
  withDomainEnv({ NEXT_PUBLIC_APP_URL: "https://chainmind.fun" }, () => {
    assert.equal(authDomain(), "chainmind.fun");
  });
  // A bare host is what an operator types by instinct; accept it.
  withDomainEnv({ AUTH_DOMAIN: "ChainMind.Fun" }, () => {
    assert.equal(authDomain(), "chainmind.fun");
  });
  // AUTH_DOMAIN wins: a custom domain in front of the deployment's own URL.
  withDomainEnv({ AUTH_DOMAIN: "chainmind.fun", NEXT_PUBLIC_APP_URL: "https://x.vercel.app" }, () => {
    assert.equal(authDomain(), "chainmind.fun");
  });
});

test("authDomain ignores the Host and X-Forwarded-Host headers entirely", () => {
  // H1. Passing a request in must change nothing: those headers are written by
  // whoever is calling, and a domain taken from them is a domain an attacker
  // picks — which is precisely the cross-site signature replay the binding
  // exists to stop.
  const spoofed = {
    headers: new Headers({ host: "evil.example", "x-forwarded-host": "evil.example" }),
  };
  withDomainEnv({ NEXT_PUBLIC_APP_URL: "https://chainmind.fun" }, () => {
    assert.equal(authDomain(spoofed), "chainmind.fun");
  });
  withDomainEnv({}, () => {
    assert.equal(authDomain(spoofed), null, "no config means no domain, never the header");
  });
});

test("authDomain fails closed on nothing configured and on a malformed value", () => {
  withDomainEnv({}, () => assert.equal(authDomain(), null));
  withDomainEnv({ NEXT_PUBLIC_APP_URL: "   " }, () => assert.equal(authDomain(), null));
  // A typo must break sign-in loudly rather than quietly downgrade it.
  withDomainEnv({ AUTH_DOMAIN: "http://" }, () => assert.equal(authDomain(), null));
  withDomainEnv({ NEXT_PUBLIC_APP_URL: "not a url" }, () => assert.equal(authDomain(), null));
});

test("a challenge minted under a spoofed Host is unredeemable", async () => {
  // The end-to-end shape of H1: an attacker gets a challenge naming their site,
  // has the victim sign it there, and brings the signature back here. The
  // signature is genuine; the domain in the record is not ours, so it dies.
  const store = createMemoryStore();
  const account = throwawayAccount();
  const challenge = await issueNonce({ store, domain: "evil.example", preSessionId: PRE_SESSION });
  const signature = await signChallenge(account, challenge);

  const result = await verifySignIn({
    store,
    address: account.address,
    signature,
    preSessionId: PRE_SESSION,
    domain: DOMAIN,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, REJECT.DOMAIN_MISMATCH);
});

test("verify fails closed when no domain is configured", async () => {
  // An unconfigured deployment must be unable to sign anyone in — not able to
  // sign them in with the check skipped, which is what an optional domain meant.
  const store = createMemoryStore();
  const account = throwawayAccount();
  const challenge = await issueNonce({ store, domain: DOMAIN, preSessionId: PRE_SESSION });
  const signature = await signChallenge(account, challenge);

  const result = await withDomainEnv({}, () =>
    verifySignIn({
      store,
      address: account.address,
      signature,
      preSessionId: PRE_SESSION,
      // Not passed at all: the default is the configured domain, which is none.
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, REJECT.DOMAIN_UNCONFIGURED);
});
