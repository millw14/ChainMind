import { PublicKey } from "@solana/web3.js";

/**
 * Walk signature history pages until the oldest returned row (or cap).
 * RPC returns newest-first; we paginate with `before` toward older txs.
 *
 * @param {import("@solana/web3.js").Connection} connection
 * @param {string} address — base58
 * @param {{ maxPages?: number, commitment?: import("@solana/web3.js").Commitment }} [opts]
 */
export async function fetchOldestSignatureForAddress(connection, address, opts = {}) {
  const maxPages = Math.min(50, Math.max(1, Number(opts.maxPages) || 5));
  const commitment = opts.commitment ?? "confirmed";

  let before = undefined;
  /** @type {{ signature: string; slot?: number; blockTime?: number | null; err: any } | null} */
  let oldestInWindow = null;
  let pages = 0;
  let capped = false;

  const pk = new PublicKey(address);

  for (;;) {
    const sigs = await connection.getSignaturesForAddress(pk, { before, limit: 1000 }, commitment);
    pages += 1;
    if (sigs.length === 0) break;
    oldestInWindow = sigs[sigs.length - 1];
    if (sigs.length < 1000) {
      capped = false;
      break;
    }
    if (pages >= maxPages) {
      capped = true;
      break;
    }
    before = oldestInWindow.signature;
  }

  if (!oldestInWindow) {
    return {
      signature: null,
      slot: null,
      blockTime: null,
      pagesWalked: pages,
      capped: false,
      err: "no_signatures",
    };
  }

  return {
    signature: oldestInWindow.signature,
    slot: oldestInWindow.slot != null ? Number(oldestInWindow.slot) : null,
    blockTime:
      oldestInWindow.blockTime != null && Number.isFinite(Number(oldestInWindow.blockTime))
        ? Number(oldestInWindow.blockTime)
        : null,
    pagesWalked: pages,
    capped,
    err: oldestInWindow.err ?? null,
  };
}
