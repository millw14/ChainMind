import { getChainConfig } from "./chain.js";

/**
 * Blockscout REST client — the indexer/explorer layer for Robinhood Chain.
 * Replaces Helius for address history, token transfers, logs, and metadata.
 *
 * Docs: https://robinhoodchain.blockscout.com/api-docs (v2 REST API).
 * A BLOCKSCOUT_API_KEY (Pro) raises rate limits but is optional for dev.
 */
function apiBase() {
  const custom = process.env.BLOCKSCOUT_API_URL?.trim();
  return (custom || getChainConfig().blockscoutApi).replace(/\/$/, "");
}

/** v2 REST base (richer JSON than the legacy `?module=` API). */
function v2Base() {
  return apiBase().replace(/\/api$/, "/api/v2");
}

/**
 * Per-call budget. Without it a hung indexer holds the request open until the
 * platform kills the function, so the route never gets to fail cleanly.
 */
const TIMEOUT_MS = 8_000;

/**
 * Budget for a call whose result is DETAIL rather than the answer — a token's top
 * holders, its recent transfers. Shorter than TIMEOUT_MS on purpose: measured
 * against this indexer, /tokens/{a}/transfers takes 4.5s and /holders 4.3s where
 * /tokens/{a} takes 1.1s, and "how is NVDA doing" is answered by the latter. A
 * caller that puts its enrichment on this deadline loses one field to a stalled
 * endpoint (and says so) instead of holding the whole reply for it.
 */
const ENRICHMENT_TIMEOUT_MS = 6_000;

/**
 * An options bag for the getters below that expires the request after `ms`.
 *
 * Aborting is the half that matters beyond the clock: giving up locally while the
 * fetch runs on leaves the socket held and the indexer working on an answer
 * nobody will read, which on a rate-limited key costs the NEXT question too.
 * A non-numeric or non-positive `ms` falls back to the full budget rather than
 * aborting instantly — a bad deadline must not become a hard failure.
 *
 * @param {number} ms
 * @returns {{ signal: AbortSignal }}
 */
export function deadline(ms) {
  const n = Number(ms);
  return { signal: AbortSignal.timeout(Number.isFinite(n) && n > 0 ? n : TIMEOUT_MS) };
}

/**
 * Carries the upstream HTTP status so callers can tell a genuine 404 ("no such
 * address") from an outage (5xx, rate limit, abort) — reporting the second as
 * the first tells the user something false about the chain. Transport failures
 * throw the platform's own error with no `status`, which reads as unknown.
 */
export class BlockscoutError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "BlockscoutError";
    this.status = status ?? null;
  }
}

async function getJson(url, { signal } = {}) {
  const key = process.env.BLOCKSCOUT_API_KEY?.trim();
  const headers = key ? { Authorization: `Bearer ${key}` } : undefined;
  const res = await fetch(url, { headers, signal: signal ?? AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    throw new BlockscoutError(`Blockscout ${res.status} ${res.statusText} for ${url}`, res.status);
  }
  return res.json();
}

/** Address overview: balance, contract flag, token metadata if it's a token. */
export function getAddress(address, opts) {
  return getJson(`${v2Base()}/addresses/${address}`, opts);
}

/** Native + ERC-20/721/1155 transactions touching an address (paginated). */
export function getAddressTransactions(address, params = {}, opts) {
  const q = new URLSearchParams(params).toString();
  return getJson(`${v2Base()}/addresses/${address}/transactions${q ? `?${q}` : ""}`, opts);
}

/** Token transfers (ERC-20/721/1155) for an address. */
export function getTokenTransfers(address, params = {}, opts) {
  const q = new URLSearchParams(params).toString();
  return getJson(`${v2Base()}/addresses/${address}/token-transfers${q ? `?${q}` : ""}`, opts);
}

/** Single transaction with decoded input and status. */
export function getTransaction(hash, opts) {
  return getJson(`${v2Base()}/transactions/${hash}`, opts);
}

/** Emitted logs for a transaction (decoded when the ABI is known). */
export function getTransactionLogs(hash, opts) {
  return getJson(`${v2Base()}/transactions/${hash}/logs`, opts);
}

/** Token (ERC-20/721/1155) metadata: name, symbol, decimals, supply, holders, price. */
export function getToken(address, opts) {
  return getJson(`${v2Base()}/tokens/${address}`, opts);
}

/** Token counters: holder count and total transfer count. */
export function getTokenCounters(address, opts) {
  return getJson(`${v2Base()}/tokens/${address}/counters`, opts);
}

/** Top holders of a token (address + balance), ranked by balance. */
export function getTokenHolders(address, params = {}, opts) {
  const q = new URLSearchParams(params).toString();
  return getJson(`${v2Base()}/tokens/${address}/holders${q ? `?${q}` : ""}`, opts);
}

/** Recent transfers of a token (movement of the token itself). */
export function getTokenActivity(address, params = {}, opts) {
  const q = new URLSearchParams(params).toString();
  return getJson(`${v2Base()}/tokens/${address}/transfers${q ? `?${q}` : ""}`, opts);
}

/**
 * Global token list, newest-indexed first and paginated: pass the previous
 * response's `next_page_params` straight back in as `params` to walk it.
 */
export function getTokens(params = {}, opts) {
  const q = new URLSearchParams(params).toString();
  return getJson(`${v2Base()}/tokens${q ? `?${q}` : ""}`, opts);
}

/**
 * Explorer-wide search across tokens, addresses, blocks and transactions.
 * Matches on symbol and name, so it returns impostors alongside the real
 * contract — the caller decides which is which.
 */
export function searchChain(query, opts) {
  return getJson(`${v2Base()}/search?q=${encodeURIComponent(query)}`, opts);
}

/** Address counters: total txs, token-transfer count, gas usage. */
export function getAddressCounters(address, opts) {
  return getJson(`${v2Base()}/addresses/${address}/counters`, opts);
}

/** ERC-20/721/1155 balances held by an address. */
export function getAddressTokenBalances(address, opts) {
  return getJson(`${v2Base()}/addresses/${address}/token-balances`, opts);
}

export { apiBase, v2Base, TIMEOUT_MS, ENRICHMENT_TIMEOUT_MS };
