import { Connection, clusterApiUrl } from "@solana/web3.js";

/** Primary chain for ChainMind */
export const FOCUS_CHAIN = "solana";

const CLUSTERS = new Set(["mainnet-beta", "devnet", "testnet"]);

function normalizeCluster(raw) {
  const c = (raw || "mainnet-beta").trim();
  if (!CLUSTERS.has(c)) {
    throw new Error(
      `Invalid SOLANA_CLUSTER "${c}". Use mainnet-beta, devnet, or testnet.`,
    );
  }
  return c;
}

/**
 * Public RPC URL. Prefer a dedicated endpoint (Helius, Triton, QuickNode) for production.
 */
export function getSolanaRpcUrl() {
  const custom = process.env.SOLANA_RPC_URL?.trim();
  if (custom) return custom;
  return clusterApiUrl(normalizeCluster(process.env.SOLANA_CLUSTER));
}

export function getSolanaConnection(commitment = "confirmed") {
  return new Connection(getSolanaRpcUrl(), {
    commitment,
    confirmTransactionInitialTimeout: 60_000,
  });
}

export function getSolanaCluster() {
  const url = process.env.SOLANA_RPC_URL?.trim();
  const cluster = process.env.SOLANA_CLUSTER?.trim();
  if (cluster && CLUSTERS.has(cluster)) return cluster;
  if (url) return "custom";
  return normalizeCluster(process.env.SOLANA_CLUSTER);
}
