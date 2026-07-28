/**
 * Prove an address belongs to whoever is holding the browser — with a signature,
 * and never with a transaction.
 *
 * THE ONE THING THIS FEATURE MUST NEVER DO is put a transaction, an approval, a
 * permit or an EIP-712 typed-data blob in front of the user. Every one of those
 * can move funds or authorise moving them later, and a sign-in prompt is exactly
 * where a user has been trained to click through. So this file builds a plain
 * personal_sign message, says in the signed text itself that it cannot spend
 * anything, and there is no code path anywhere in the flow that touches gas or an
 * allowance. If that ever stops being true, this comment is the thing that was
 * lied to.
 *
 * WHAT MAKES A SIGNATURE SAFE TO ACCEPT. Four things have to be true at once, and
 * dropping any one of them turns a captured signature into a permanent login:
 *   - the nonce was issued BY US (it is looked up in our store, not parsed from
 *     the request),
 *   - it is SINGLE USE (consumed with an atomic take, so two concurrent replays
 *     cannot both find it),
 *   - it has NOT EXPIRED (minutes, not hours),
 *   - and it is BOUND to this browser's pre-session cookie — the nonce is STORED
 *     UNDER the pre-session id, so there is no request field an attacker could
 *     point at someone else's nonce. A nonce farmed from another page is not
 *     "rejected" here so much as unreachable.
 *
 * WHY THE MESSAGE IS REBUILT SERVER-SIDE. The client sends { address, signature }
 * and nothing else. We reconstruct the exact bytes from what WE stored — our
 * domain, our chain id, our nonce, our issued-at — and recover the signer from
 * those. That makes "signature farmed on another domain", "signature for a
 * different chain" and "nonce swapped after signing" all impossible to smuggle
 * past us, because none of those fields are ever taken from the request. The cost
 * is that those failures are indistinguishable from each other at the crypto step
 * — see SIGNATURE_MISMATCH below, which is honest about that rather than logging
 * a reason it cannot actually know.
 *
 * KNOWN LIMIT: recovery only proves control of an EOA key. A smart-contract
 * wallet (ERC-1271) signs with a contract, has nothing to recover, and will be
 * rejected here. Supporting it means an on-chain isValidSignature call, which is
 * a different feature with a different failure mode (an RPC outage becoming a
 * login outage) and is deliberately not smuggled in.
 */
import { isAddress, getAddress, recoverMessageAddress } from "viem";
import { getChainConfig } from "./chain.js";
import { shortAddress } from "./session.js";
import { randomBytes } from "node:crypto";

/** Default nonce lifetime. Long enough to read a wallet prompt, short enough that
 *  a signature scraped from a screenshot is worthless by the time it is used. */
const DEFAULT_NONCE_TTL_MS = 5 * 60 * 1000;

/**
 * How long a consumed-or-expired nonce stays findable past its own expiry.
 *
 * The store TTL is deliberately LONGER than the nonce TTL so that a late
 * signature comes back as "expired" — a thing we can explain to the user and
 * count in logs — instead of "unknown", which looks identical to an attack.
 */
const NONCE_STORE_GRACE_MS = 60 * 1000;

/** Rejection reasons. Distinct in the logs; all one generic message to the client. */
export const REJECT = {
  BAD_ADDRESS: "bad-address",
  BAD_SIGNATURE_FORMAT: "bad-signature-format",
  NO_PRE_SESSION: "no-pre-session",
  NONCE_UNKNOWN: "nonce-unknown",
  NONCE_EXPIRED: "nonce-expired",
  DOMAIN_MISMATCH: "domain-mismatch",
  /** No domain is configured, so there is no domain to bind a signature to. A
   *  challenge minted without one is a challenge that binds nothing. */
  DOMAIN_UNCONFIGURED: "domain-unconfigured",
  CHAIN_MISMATCH: "chain-mismatch",
  /** The recovered signer is not the claimed address. A different key, another
   *  site's domain, another chain id or a tampered nonce all land here — we do
   *  not pretend to tell them apart, because telling them apart would mean
   *  trusting a client-supplied message, which is the bug this design removes. */
  SIGNATURE_MISMATCH: "signature-mismatch",
};

/** Nonce lifetime, read per call so a deploy can shorten it without a rebuild. */
export function nonceTtlMs() {
  const n = Number(process.env.AUTH_NONCE_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_NONCE_TTL_MS;
}

/**
 * Where a nonce lives: under the PRE-SESSION id, not under the nonce itself.
 *
 * That is what makes /api/auth/verify able to take nothing but { address,
 * signature } — the server looks up the challenge by the httpOnly cookie it
 * issued, so there is no field in the request that could name someone else's
 * nonce. It also means one browser has at most one live challenge, and asking
 * for a second replaces the first.
 */
function nonceKey(preSessionId) {
  return `auth:nonce:${preSessionId}`;
}

/**
 * The domain this server signs in under, as a bare host — FROM CONFIGURATION AND
 * NOWHERE ELSE.
 *
 * IT MUST NEVER COME FROM A HEADER. Host and X-Forwarded-Host are both written by
 * the caller (or by a proxy that was told what to write), so deriving the domain
 * from them lets anyone who can set that header make this app mint a challenge
 * naming THEIR site — and then redeem, here, a signature the victim gave on that
 * other site. Cross-site signature replay is the exact thing the domain binding
 * exists to prevent, so the binding cannot be built out of a value the attacker
 * chooses. It reads server config, or it returns null.
 *
 * NULL IS FAIL CLOSED. An unconfigured deployment must be unable to sign anyone
 * in — not able to sign them in unsafely. Both ends check: app/api/auth/nonce
 * refuses to mint a challenge without a domain, and verifySignIn below refuses to
 * redeem one, so neither half can be talked into a header-derived value.
 *
 * AUTH_DOMAIN is accepted as a bare host for deployments whose public origin is
 * not the one NEXT_PUBLIC_APP_URL names (a custom domain in front of a Vercel
 * URL, say). A malformed value returns null rather than falling back to anything:
 * a typo must break sign-in loudly, not quietly downgrade it.
 *
 * @returns {string|null}
 */
export function authDomain() {
  const configured = process.env.AUTH_DOMAIN?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!configured) return null;
  // A full origin ("https://chainmind.fun") and a bare host ("chainmind.fun")
  // are both accepted; the second is what an operator types by instinct.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(configured) ? configured : `https://${configured}`;
  try {
    const host = new URL(candidate).host.toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

/**
 * The exact bytes the user is asked to sign.
 *
 * Every field that matters is IN the message: the domain (so a signature farmed
 * elsewhere does not verify here), the chain id (so one farmed for another
 * network does not either), the nonce (so it is single-use) and the timestamps
 * (so it ages out). The closing sentence is not decoration — it is the only part
 * of the prompt most people will read, and it is the truth: this signature
 * cannot move anything.
 *
 * @param {{ domain: string, address: string, chainId: number, nonce: string,
 *           issuedAt: string, expiresAt: string }} fields
 * @returns {string}
 */
export function buildSignInMessage({ domain, address, chainId, nonce, issuedAt, expiresAt }) {
  return [
    `${domain} wants you to sign in with your wallet.`,
    "",
    `Address: ${address}`,
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expires At: ${expiresAt}`,
    "",
    "Signing this proves you control this address. It is not a transaction:",
    "it cannot move funds, grant an allowance, or spend gas.",
  ].join("\n");
}

/**
 * Issue a single-use nonce bound to a pre-session.
 *
 * The address is NOT part of the record. It is claimed at verify time and the
 * message is rebuilt around it then, so one nonce cannot be pre-committed to an
 * address the user has not chosen yet in their wallet.
 *
 * @param {{ store: object, domain: string, preSessionId: string, chainId?: number, now?: number }} args
 * @returns {Promise<{ nonce: string, domain: string, chainId: number, issuedAt: string, expiresAt: string }>}
 */
export async function issueNonce({ store, domain, preSessionId, chainId, now = Date.now() }) {
  if (!domain) throw new Error("issueNonce needs a domain.");
  if (!preSessionId) throw new Error("issueNonce needs a pre-session id.");

  const id = getChainConfig().id;
  const record = {
    nonce: randomBytes(32).toString("base64url"),
    // Normalised here so the stored value and the one verify compares against
    // are the same shape; a case difference must not read as a different site.
    domain: String(domain).trim().toLowerCase(),
    chainId: Number.isFinite(Number(chainId)) ? Number(chainId) : id,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + nonceTtlMs()).toISOString(),
  };
  // The grace lets an expired nonce be reported as expired rather than unknown.
  await store.set(nonceKey(preSessionId), record, {
    ttlMs: nonceTtlMs() + NONCE_STORE_GRACE_MS,
  });
  return { ...record };
}

/** Structured, truncated, and never carrying a signature or a key. */
function logReject(reason, fields = {}) {
  const parts = Object.entries(fields)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}=${v}`);
  console.warn(`[auth] rejected reason=${reason}${parts.length ? ` ${parts.join(" ")}` : ""}`);
}

/**
 * Verify a sign-in and consume the nonce.
 *
 * Order matters: the nonce is consumed BEFORE the signature is checked. A failed
 * verification still burns it, so an attacker cannot use a wrong guess to probe
 * whether a nonce is live and then reuse it — and a replay of a captured
 * signature finds nothing to redeem.
 *
 * @param {{ store: object, address: string, signature: string,
 *           preSessionId: string|null, domain?: string|null, now?: number }} args
 *   `domain` defaults to the configured one — a caller cannot opt out of the
 *   check by omitting it, only name the same value the challenge was minted with.
 * @returns {Promise<{ ok: true, address: string } | { ok: false, reason: string }>}
 */
export async function verifySignIn({
  store,
  address,
  signature,
  preSessionId,
  domain = authDomain(),
  now = Date.now(),
}) {
  const expected = typeof domain === "string" ? domain.trim().toLowerCase() : "";
  const claimed = typeof address === "string" ? address.trim() : "";
  if (!isAddress(claimed)) {
    logReject(REJECT.BAD_ADDRESS);
    return { ok: false, reason: REJECT.BAD_ADDRESS };
  }
  const checksummed = getAddress(claimed);

  const sig = typeof signature === "string" ? signature.trim() : "";
  // 65 bytes hex. Checked by shape so a malformed body is a cheap rejection
  // rather than an exception inside viem.
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) {
    logReject(REJECT.BAD_SIGNATURE_FORMAT, { address: shortAddress(checksummed) });
    return { ok: false, reason: REJECT.BAD_SIGNATURE_FORMAT };
  }

  if (!preSessionId) {
    logReject(REJECT.NO_PRE_SESSION, { address: shortAddress(checksummed) });
    return { ok: false, reason: REJECT.NO_PRE_SESSION };
  }

  // Consumed here, before any signature work: a replay of a captured signature
  // finds nothing left to redeem, and a wrong guess cannot be used to probe
  // whether a challenge is still live and then retried against the real one.
  const record = await store.take(nonceKey(preSessionId));
  if (!record || typeof record.nonce !== "string") {
    logReject(REJECT.NONCE_UNKNOWN, { address: shortAddress(checksummed) });
    return { ok: false, reason: REJECT.NONCE_UNKNOWN };
  }
  if (new Date(record.expiresAt).getTime() <= now) {
    logReject(REJECT.NONCE_EXPIRED, { address: shortAddress(checksummed) });
    return { ok: false, reason: REJECT.NONCE_EXPIRED };
  }
  // THE DOMAIN IS CHECKED AT BOTH ENDS, and it is REQUIRED at this one. An
  // absent `domain` used to mean "skip the check", which made the binding
  // optional exactly when configuration was missing — the case where it matters
  // most. Now a caller that cannot name the domain cannot redeem anything, and
  // the nonce has already been consumed above, so probing costs a challenge.
  if (!expected) {
    logReject(REJECT.DOMAIN_UNCONFIGURED, { issued: record.domain });
    return { ok: false, reason: REJECT.DOMAIN_UNCONFIGURED };
  }
  if (record.domain !== expected) {
    // The challenge names a host other than the one this server signs in under.
    // A nonce minted under a spoofed Host header lands here and dies here.
    logReject(REJECT.DOMAIN_MISMATCH, { issued: record.domain, seen: expected });
    return { ok: false, reason: REJECT.DOMAIN_MISMATCH };
  }
  if (record.chainId !== getChainConfig().id) {
    // The server switched networks between issue and verify. Nothing signed
    // against the old chain id should be honoured under the new one.
    logReject(REJECT.CHAIN_MISMATCH, { issued: record.chainId, now: getChainConfig().id });
    return { ok: false, reason: REJECT.CHAIN_MISMATCH };
  }

  const message = buildSignInMessage({
    domain: record.domain,
    address: checksummed,
    chainId: record.chainId,
    nonce: record.nonce,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
  });

  let recovered = null;
  try {
    recovered = await recoverMessageAddress({ message, signature: sig });
  } catch {
    // Malformed-but-well-shaped signatures (bad v byte, non-canonical s) land
    // here. Same outcome as a wrong signer.
    recovered = null;
  }
  if (!recovered || getAddress(recovered) !== checksummed) {
    logReject(REJECT.SIGNATURE_MISMATCH, {
      claimed: shortAddress(checksummed),
      recovered: recovered ? shortAddress(getAddress(recovered)) : "none",
    });
    return { ok: false, reason: REJECT.SIGNATURE_MISMATCH };
  }

  return { ok: true, address: checksummed };
}

/** What every rejection tells the client. One sentence, no oracle. */
export const GENERIC_REJECTION = "Could not verify that signature. Start the sign-in again.";
