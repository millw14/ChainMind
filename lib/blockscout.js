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

async function getJson(url) {
  const key = process.env.BLOCKSCOUT_API_KEY?.trim();
  const headers = key ? { Authorization: `Bearer ${key}` } : undefined;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Blockscout ${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
}

/** Address overview: balance, contract flag, token metadata if it's a token. */
export function getAddress(address) {
  return getJson(`${v2Base()}/addresses/${address}`);
}

/** Native + ERC-20/721/1155 transactions touching an address (paginated). */
export function getAddressTransactions(address, params = {}) {
  const q = new URLSearchParams(params).toString();
  return getJson(`${v2Base()}/addresses/${address}/transactions${q ? `?${q}` : ""}`);
}

/** Token transfers (ERC-20/721/1155) for an address. */
export function getTokenTransfers(address, params = {}) {
  const q = new URLSearchParams(params).toString();
  return getJson(`${v2Base()}/addresses/${address}/token-transfers${q ? `?${q}` : ""}`);
}

/** Single transaction with decoded input and status. */
export function getTransaction(hash) {
  return getJson(`${v2Base()}/transactions/${hash}`);
}

/** Emitted logs for a transaction (decoded when the ABI is known). */
export function getTransactionLogs(hash) {
  return getJson(`${v2Base()}/transactions/${hash}/logs`);
}

/** Token (ERC-20/721/1155) metadata: name, symbol, decimals, supply, holders, price. */
export function getToken(address) {
  return getJson(`${v2Base()}/tokens/${address}`);
}

/** Token counters: holder count and total transfer count. */
export function getTokenCounters(address) {
  return getJson(`${v2Base()}/tokens/${address}/counters`);
}

/** Top holders of a token (address + balance), ranked by balance. */
export function getTokenHolders(address, params = {}) {
  const q = new URLSearchParams(params).toString();
  return getJson(`${v2Base()}/tokens/${address}/holders${q ? `?${q}` : ""}`);
}

/** Recent transfers of a token (movement of the token itself). */
export function getTokenActivity(address, params = {}) {
  const q = new URLSearchParams(params).toString();
  return getJson(`${v2Base()}/tokens/${address}/transfers${q ? `?${q}` : ""}`);
}

/** Address counters: total txs, token-transfer count, gas usage. */
export function getAddressCounters(address) {
  return getJson(`${v2Base()}/addresses/${address}/counters`);
}

/** ERC-20/721/1155 balances held by an address. */
export function getAddressTokenBalances(address) {
  return getJson(`${v2Base()}/addresses/${address}/token-balances`);
}

export { apiBase, v2Base };
