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

/** Address counters: total txs, token-transfer count, gas usage. */
export function getAddressCounters(address, opts) {
  return getJson(`${v2Base()}/addresses/${address}/counters`, opts);
}

/** ERC-20/721/1155 balances held by an address. */
export function getAddressTokenBalances(address, opts) {
  return getJson(`${v2Base()}/addresses/${address}/token-balances`, opts);
}

export { apiBase, v2Base };
