import { loadEnv } from "../lib/load-env.js";
loadEnv();

import { PublicKey } from "@solana/web3.js";
import { getSolanaConnection } from "../lib/solana.js";
import { fetchSignaturesForDisplay } from "../lib/inspect-service.js";

export default async function handler(req, res) {
  const address = String(req.query?.address ?? "").trim();
  const limit = Math.min(100, Math.max(1, Number(req.query?.limit ?? 15) || 15));
  if (!address) {
    res.status(400).json({ ok: false, error: "Missing ?address=<base58>" });
    return;
  }
  try {
    new PublicKey(address);
  } catch {
    res.status(400).json({ ok: false, error: "Invalid base58 address" });
    return;
  }
  try {
    const connection = getSolanaConnection();
    const signatures = await fetchSignaturesForDisplay(connection, address, limit);
    res.status(200).json({ ok: true, address, limit, signatures });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
}
