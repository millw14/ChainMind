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
 * JSON-RPC URL. Prefer a dedicated endpoint (QuickNode, Chainstack, Alchemy)
 * for production rate limits; the public RPC is fine to develop against.
 */
export function getRpcUrl() {
  const custom = process.env.ROBINHOOD_RPC_URL?.trim();
  if (custom) return custom;
  return getChainConfig().rpcUrl;
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
