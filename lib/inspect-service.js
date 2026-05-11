import { PublicKey } from "@solana/web3.js";
import { withRpcRetry } from "./rpc-retry.js";

/**
 * @param {import("@solana/web3.js").Connection} connection
 * @param {string} address base58
 * @param {number} limit
 */
export async function fetchSignaturesForDisplay(connection, address, limit) {
  const pubkey = new PublicKey(address);
  const sigs = await withRpcRetry(() =>
    connection.getSignaturesForAddress(pubkey, { limit }),
  );
  return sigs.map((s) => ({
    signature: s.signature,
    slot: s.slot ?? null,
    blockTime: s.blockTime ?? null,
    err: s.err ?? null,
  }));
}
