import { loadEnv } from "../lib/load-env.js";
loadEnv();

import {
  FOCUS_CHAIN,
  getSolanaCluster,
  getSolanaConnection,
  getSolanaRpcUrl,
} from "../lib/solana.js";

function redactRpcUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    if (u.searchParams.has("api-key")) u.searchParams.set("api-key", "***");
    return u.toString();
  } catch {
    return url.slice(0, 48) + (url.length > 48 ? "…" : "");
  }
}

const connection = getSolanaConnection();

console.log("ChainMind ping");
console.log("--------------");
console.log("Focus chain :", FOCUS_CHAIN);
console.log("Cluster label:", getSolanaCluster());
console.log("RPC URL     :", redactRpcUrl(getSolanaRpcUrl()));
console.log("");

const version = await connection.getVersion();
const slot = await connection.getSlot("confirmed");

console.log("Solana answered OK.");
console.log("Version     :", version?.["solana-core"] ?? JSON.stringify(version));
console.log("Current slot:", slot);
console.log("");
console.log("(Slot ≈ a page number in the big shared notebook.)");
