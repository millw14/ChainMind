/**
 * Does this address hold enough of the gating token to be off the free tier?
 *
 * THE BALANCE IS READ HERE, BY US, FROM OUR OWN RPC CLIENT. Nothing in this file
 * takes a balance, a token, a decimals or an entitlement from a request body, a
 * header or a cookie. The only thing the caller supplies is an address, and that
 * address comes from a signed session cookie the server minted itself. A gate that
 * believes a client-reported balance is not a gate, and it is the single most
 * common way token gates are bypassed.
 *
 * THREE STATES, NEVER TWO. "Verified below the threshold" and "we could not read
 * the chain" are different facts about the world and they get different names here:
 *
 *   entitled   — we read the balance and it is at or above the threshold.
 *   below      — we read the balance and it is under the threshold.
 *   unverified — we did NOT read it. An RPC outage, a timeout, a token that is not
 *                configured, a decimals call that failed. This state must never be
 *                collapsed into `below`: doing so tells a holder they hold nothing,
 *                which is a lie the chain never told us.
 *
 * Callers act on the distinction (see lib/quota.js): an unverified user keeps the
 * free daily allowance — they do not silently get unlimited access, and they are
 * not told they own zero.
 *
 * THE CACHE IS SHORT AND NEVER HOLDS A FAILURE. A holder can sell the block after
 * signing in, so an entitlement is a fact with a shelf life: it is re-read every
 * few minutes rather than checked on every question (an eth_call per request, on a
 * path already near its time budget) or trusted for the whole session (wrong the
 * moment they sell). Failures are never cached, because caching one would turn a
 * three-second RPC blip into three minutes of everyone being unverifiable.
 *
 * The cache is process-local. On Railway that is one map for the whole app; on
 * Vercel it is one per lambda, which means the same address may be re-read on
 * another instance. That is the correct way for a cache to be wrong — it costs an
 * extra eth_call, never an extra entitlement.
 *
 * CONFIGURATION IS ENTIRELY ENV-DRIVEN, deliberately: the token being gated on
 * during testing is not the token that will ship, and swapping it must not be a
 * code change. See .env.example for the full list.
 */
import { getAddress, isAddress, parseUnits, formatUnits } from "viem";
import { getPublicClient } from "./chain.js";
import { shortAddress } from "./session.js";

/** The three answers this module can give. Compared by value everywhere. */
export const ENTITLEMENT = Object.freeze({
  ENTITLED: "entitled",
  BELOW: "below",
  UNVERIFIED: "unverified",
});

/**
 * Why an answer is `unverified`. The state is what callers branch on; the reason
 * is what the user is told, because "the gate is not configured" and "the chain
 * did not answer" need different sentences and different people to fix them.
 */
export const UNVERIFIED_REASON = Object.freeze({
  NOT_CONFIGURED: "not-configured",
  BAD_CONFIG: "bad-config",
  BAD_ADDRESS: "bad-address",
  READ_FAILED: "read-failed",
});

/** Default threshold when a token is configured without one: hold at least one. */
const DEFAULT_MIN_TOKENS = "1";

/** How long an entitlement is reused. Minutes, not the session — see the header. */
const DEFAULT_CACHE_TTL_MS = 3 * 60 * 1000;

/**
 * Deadline for the balance read.
 *
 * This runs BEFORE the expensive part of /api/ask, on a route whose whole budget
 * is 30s. A slow RPC must cost the question a couple of seconds and then be
 * reported as unverified — not sit there spending the budget the answer needs.
 */
const DEFAULT_RPC_TIMEOUT_MS = 2_500;

/** Entries kept in the entitlement cache before the oldest is dropped. */
const MAX_CACHE_ENTRIES = 5_000;

/** Just the three calls this file makes. A full ERC-20 ABI would be noise. */
const ERC20_ABI = Object.freeze([
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
]);

/** Clock seam; see lib/store.js for why. Production never touches it. */
let clock = () => Date.now();

/**
 * Swap the clock for a test, and get a restore function back.
 * @param {() => number} fn
 * @returns {() => void}
 */
export function setEntitlementClock(fn) {
  const previous = clock;
  clock = typeof fn === "function" ? fn : previous;
  return () => {
    clock = previous;
  };
}

/** Trimmed env read; an empty string counts as unset. */
function env(name) {
  const raw = process.env[name];
  const s = raw == null ? "" : String(raw).trim();
  return s || null;
}

/**
 * The gate's configuration, as the environment currently describes it.
 *
 * Read per call rather than at module load so a redeploy that changes the token
 * takes effect without a rebuild, and so tests can set the env per case.
 *
 * @returns {{ configured: boolean, tokenAddress: string|null, minTokens: string,
 *             decimals: number|null, symbol: string|null, error: string|null }}
 */
export function gateConfig() {
  const rawToken = env("GATE_TOKEN_ADDRESS");
  if (!rawToken) {
    return {
      configured: false,
      tokenAddress: null,
      minTokens: DEFAULT_MIN_TOKENS,
      decimals: null,
      symbol: null,
      error: null,
    };
  }
  if (!isAddress(rawToken)) {
    return {
      configured: false,
      tokenAddress: null,
      minTokens: DEFAULT_MIN_TOKENS,
      decimals: null,
      symbol: null,
      error: `GATE_TOKEN_ADDRESS ("${rawToken}") is not an address.`,
    };
  }

  // A threshold is a TOKEN COUNT, never wei: an operator writing 1000 means a
  // thousand tokens, and scaling it by decimals is this module's job, not theirs.
  const minTokens = env("GATE_TOKEN_MIN") ?? DEFAULT_MIN_TOKENS;
  if (!/^\d+(\.\d+)?$/.test(minTokens)) {
    return {
      configured: false,
      tokenAddress: null,
      minTokens: DEFAULT_MIN_TOKENS,
      decimals: null,
      symbol: null,
      error: `GATE_TOKEN_MIN ("${minTokens}") is not a plain token count like 1000 or 0.5.`,
    };
  }

  // Decimals can be pinned to save an eth_call, but a WRONG pin silently rescales
  // the threshold by orders of magnitude, so it is validated hard and otherwise
  // read from the contract.
  const rawDecimals = env("GATE_TOKEN_DECIMALS");
  let decimals = null;
  if (rawDecimals != null) {
    const n = Number(rawDecimals);
    if (!Number.isInteger(n) || n < 0 || n > 36) {
      return {
        configured: false,
        tokenAddress: null,
        minTokens: DEFAULT_MIN_TOKENS,
        decimals: null,
        symbol: null,
        error: `GATE_TOKEN_DECIMALS ("${rawDecimals}") is not a whole number of decimals (0-36).`,
      };
    }
    decimals = n;
  }

  return {
    configured: true,
    tokenAddress: getAddress(rawToken),
    minTokens,
    decimals,
    symbol: env("GATE_TOKEN_SYMBOL"),
    error: null,
  };
}

/** How long an entitlement is reused before the chain is asked again. */
export function entitlementCacheTtlMs() {
  const n = Number(process.env.GATE_CACHE_TTL_MS);
  // 0 is a legitimate setting — it disables the cache — so only reject NaN and
  // negatives, and let an explicit zero through.
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CACHE_TTL_MS;
}

/** Deadline for one balance read. */
export function entitlementRpcTimeoutMs() {
  const n = Number(process.env.GATE_RPC_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RPC_TIMEOUT_MS;
}

/* ---------------------------------- cache --------------------------------- */

/** `${token}:${address}` -> { result, expiresAt }. Insertion order is the queue. */
const cache = new Map();

/** token address -> { decimals, symbol }. Both are immutable on chain, so this
 *  one has no TTL: re-reading them would be an eth_call spent on a constant. */
const metadata = new Map();

/** Drop every cached entitlement and token metadata. Tests, and token swaps. */
export function clearEntitlementCache() {
  cache.clear();
  metadata.clear();
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= clock()) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

function cachePut(key, result) {
  const ttl = entitlementCacheTtlMs();
  if (ttl <= 0) return;
  cache.delete(key);
  cache.set(key, { result, expiresAt: clock() + ttl });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/* --------------------------------- reading -------------------------------- */

/** The shape every caller gets back, so no branch can forget a field. */
function result(state, fields = {}) {
  return {
    state,
    reason: null,
    address: null,
    token: null,
    symbol: null,
    decimals: null,
    /** Raw base units as a decimal string — bigint does not survive JSON. */
    balanceRaw: null,
    /** The same balance in whole tokens, for copy. Null when never read. */
    balanceTokens: null,
    thresholdRaw: null,
    thresholdTokens: null,
    cached: false,
    checkedAt: clock(),
    ...fields,
  };
}

/**
 * Token decimals and symbol, read once per process.
 *
 * Decimals failing is fatal to the check — without it the threshold cannot be
 * scaled, and guessing 18 would move the bar by six orders of magnitude on a
 * 6-decimal token. Symbol failing is not: it only appears in copy, and a token
 * with no readable symbol is a naming problem, not a balance problem.
 *
 * @returns {Promise<{ decimals: number, symbol: string|null }|null>} null on failure
 */
async function tokenMetadata(client, tokenAddress, configuredSymbol) {
  const known = metadata.get(tokenAddress);
  if (known) return known;

  const [dec, sym] = await Promise.allSettled([
    client.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: "decimals" }),
    client.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: "symbol" }),
  ]);

  if (dec.status !== "fulfilled") return null;
  const decimals = Number(dec.value);
  // A contract that answers decimals() with something absurd is not an ERC-20 we
  // can price a threshold against; unverified is the honest outcome.
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;

  const symbol =
    configuredSymbol ??
    (sym.status === "fulfilled" && typeof sym.value === "string" && sym.value.trim()
      ? sym.value.trim().slice(0, 16)
      : null);

  const entry = { decimals, symbol };
  metadata.set(tokenAddress, entry);
  return entry;
}

/**
 * Read one address's entitlement.
 *
 * @param {{ address: string, client?: object, force?: boolean }} args
 *   `client` is a seam for tests — production passes nothing and gets the app's
 *   own RPC client. `force` skips the cache (used after a sign-in, where the
 *   answer is worth one fresh read).
 * @returns {Promise<object>} see result() for the shape; never throws
 */
export async function checkEntitlement({ address, client = null, force = false } = {}) {
  const cfg = gateConfig();

  if (cfg.error) {
    // A misconfigured gate is an operator problem and it must be loud. It is NOT
    // "this user holds nothing" — nobody has been measured against anything.
    console.error(`[gate] ${cfg.error} Token gating is off until it is fixed.`);
    return result(ENTITLEMENT.UNVERIFIED, { reason: UNVERIFIED_REASON.BAD_CONFIG });
  }
  if (!cfg.configured) {
    return result(ENTITLEMENT.UNVERIFIED, { reason: UNVERIFIED_REASON.NOT_CONFIGURED });
  }

  const claimed = typeof address === "string" ? address.trim() : "";
  if (!isAddress(claimed)) {
    return result(ENTITLEMENT.UNVERIFIED, { reason: UNVERIFIED_REASON.BAD_ADDRESS });
  }
  const holder = getAddress(claimed);

  const key = `${cfg.tokenAddress}:${holder.toLowerCase()}`;
  if (!force) {
    const hit = cacheGet(key);
    if (hit) return { ...hit, cached: true };
  }

  // batch packs the same-tick eth_calls into one JSON-RPC request (verified live
  // against chain 4663 — see lib/chain.js). retryCount 0 because the caller is on
  // a deadline: a retry would spend the budget twice for the same answer.
  const rpc =
    client ??
    getPublicClient({ timeout: entitlementRpcTimeoutMs(), retryCount: 0, batch: true });

  let meta;
  try {
    meta = await tokenMetadata(rpc, cfg.tokenAddress, cfg.symbol);
  } catch {
    meta = null;
  }
  if (!meta) {
    console.warn(`[gate] could not read token metadata for ${shortAddress(cfg.tokenAddress)}`);
    return result(ENTITLEMENT.UNVERIFIED, {
      reason: UNVERIFIED_REASON.READ_FAILED,
      address: holder,
      token: cfg.tokenAddress,
      symbol: cfg.symbol,
    });
  }

  let thresholdRaw;
  try {
    thresholdRaw = parseUnits(cfg.minTokens, meta.decimals);
  } catch {
    console.error(`[gate] GATE_TOKEN_MIN ("${cfg.minTokens}") cannot be scaled to ${meta.decimals} decimals.`);
    return result(ENTITLEMENT.UNVERIFIED, { reason: UNVERIFIED_REASON.BAD_CONFIG });
  }

  let balance;
  try {
    balance = await rpc.readContract({
      address: cfg.tokenAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [holder],
    });
  } catch (e) {
    console.warn(`[gate] balance read failed for ${shortAddress(holder)} — ${String(e?.message ?? e)}`);
    return result(ENTITLEMENT.UNVERIFIED, {
      reason: UNVERIFIED_REASON.READ_FAILED,
      address: holder,
      token: cfg.tokenAddress,
      symbol: meta.symbol,
      decimals: meta.decimals,
      thresholdRaw: thresholdRaw.toString(),
      thresholdTokens: cfg.minTokens,
    });
  }

  // A missing answer is not a zero balance. An RPC that returns null, undefined or
  // anything that is not a bigint has told us nothing, and "nothing" must not be
  // rounded down into "you hold none of it".
  if (typeof balance !== "bigint") {
    console.warn(`[gate] balanceOf returned a non-numeric result for ${shortAddress(holder)}`);
    return result(ENTITLEMENT.UNVERIFIED, {
      reason: UNVERIFIED_REASON.READ_FAILED,
      address: holder,
      token: cfg.tokenAddress,
      symbol: meta.symbol,
      decimals: meta.decimals,
      thresholdRaw: thresholdRaw.toString(),
      thresholdTokens: cfg.minTokens,
    });
  }

  const answer = result(balance >= thresholdRaw ? ENTITLEMENT.ENTITLED : ENTITLEMENT.BELOW, {
    address: holder,
    token: cfg.tokenAddress,
    symbol: meta.symbol,
    decimals: meta.decimals,
    balanceRaw: balance.toString(),
    balanceTokens: formatUnits(balance, meta.decimals),
    thresholdRaw: thresholdRaw.toString(),
    thresholdTokens: cfg.minTokens,
  });

  // Only a MEASURED answer is cached. Caching an outage would turn a blip into
  // minutes of everyone being unverifiable, which is the failure this module is
  // most careful about everywhere else.
  cachePut(key, answer);
  return answer;
}

/** True only for a measured, at-or-above-threshold balance. */
export function isEntitled(entitlement) {
  return entitlement?.state === ENTITLEMENT.ENTITLED;
}

/**
 * What the gate is set to, for a health endpoint or the client's copy.
 *
 * The token address and threshold are public by nature — they are on chain and in
 * the marketing — so there is nothing here worth hiding from a visitor.
 */
export function gateStatus() {
  const cfg = gateConfig();
  return {
    configured: cfg.configured,
    token: cfg.tokenAddress,
    minTokens: cfg.configured ? cfg.minTokens : null,
    symbol: cfg.configured ? (cfg.symbol ?? metadata.get(cfg.tokenAddress)?.symbol ?? null) : null,
    cacheTtlMs: entitlementCacheTtlMs(),
    ...(cfg.error ? { error: cfg.error } : {}),
  };
}
