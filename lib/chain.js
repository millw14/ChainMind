import { createPublicClient, defineChain, http } from "viem";

/** Primary chain — Robinhood Chain (Arbitrum-based Ethereum L2). */
export const FOCUS_CHAIN = "robinhood";

/** Mainnet: chain ID 4663, gas token ETH. Testnet: 46630. */
const NETWORKS = {
  mainnet: {
    id: 4663,
    name: "Robinhood Chain",
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    explorerUrl: "https://robinhoodchain.blockscout.com",
    blockscoutApi: "https://robinhoodchain.blockscout.com/api",
  },
  testnet: {
    id: 46630,
    name: "Robinhood Chain Testnet",
    rpcUrl: "https://rpc.testnet.chain.robinhood.com",
    explorerUrl: "https://robinhoodchain-testnet.blockscout.com",
    blockscoutApi: "https://robinhoodchain-testnet.blockscout.com/api",
  },
};

function normalizeNetwork(raw) {
  const n = (raw || "mainnet").trim();
  if (!NETWORKS[n]) {
    throw new Error(`Invalid ROBINHOOD_NETWORK "${n}". Use mainnet or testnet.`);
  }
  return n;
}

/** Resolved config for the active network. */
export function getChainConfig() {
  const net = normalizeNetwork(process.env.ROBINHOOD_NETWORK);
  return { network: net, ...NETWORKS[net] };
}

/**
 * Compose an Alchemy URL from a template + key.
 *
 * We deliberately do NOT hard-code an Alchemy hostname for Robinhood Chain:
 * guessing a subdomain that turns out to be wrong would silently break every
 * eth_* call for anyone who only set ALCHEMY_API_KEY. So the host has to come
 * from the operator via ALCHEMY_RPC_TEMPLATE (default: empty = feature off),
 * e.g. "https://<host>/v2/{key}". `{key}` is substituted; a template without
 * the placeholder gets the key appended as a path segment.
 *
 * The documented, zero-guesswork path is ALCHEMY_RPC_URL — paste the full URL
 * (key included) that Alchemy's dashboard shows and skip the template entirely.
 */
function alchemyFromTemplate() {
  const template = process.env.ALCHEMY_RPC_TEMPLATE?.trim();
  const key = process.env.ALCHEMY_API_KEY?.trim();
  if (!template || !key) return null;
  if (template.includes("{key}")) return template.replaceAll("{key}", key);
  return `${template.replace(/\/+$/, "")}/${key}`;
}

/**
 * JSON-RPC URL. Precedence: ROBINHOOD_RPC_URL (explicit override, any provider)
 * → ALCHEMY_RPC_URL (full Alchemy URL) → ALCHEMY_RPC_TEMPLATE + ALCHEMY_API_KEY
 * → the public RPC. All of them are optional: with zero config the app runs on
 * the public endpoint, which is fine to develop against but rate-limited.
 */
export function getRpcUrl() {
  const custom = process.env.ROBINHOOD_RPC_URL?.trim();
  if (custom) return custom;
  const alchemy = process.env.ALCHEMY_RPC_URL?.trim();
  if (alchemy) return alchemy;
  return alchemyFromTemplate() || getChainConfig().rpcUrl;
}

/** viem chain definition for the active network. */
export function getViemChain() {
  const cfg = getChainConfig();
  return defineChain({
    id: cfg.id,
    name: cfg.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [getRpcUrl()] } },
    blockExplorers: { default: { name: "Blockscout", url: cfg.explorerUrl } },
  });
}

/**
 * Read-only viem client for eth_* calls.
 *
 * viem defaults to a 10s transport timeout plus 3 retries with backoff, which
 * can outlast a caller's own deadline. Pass `timeout` / `retryCount` when the
 * caller is on a tight budget (the health check); omitting them keeps viem's
 * defaults for everyone else.
 *
 * @param {{ timeout?: number, retryCount?: number }} [options]
 */
export function getPublicClient(options = {}) {
  const transport = {};
  if (options.timeout != null) transport.timeout = options.timeout;
  if (options.retryCount != null) transport.retryCount = options.retryCount;
  return createPublicClient({
    chain: getViemChain(),
    transport: http(getRpcUrl(), transport),
  });
}
