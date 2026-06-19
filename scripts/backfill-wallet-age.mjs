// Bounded wallet-age backfill: resolve oldest-signature (wallet age) for the top
// fee-payers that lack a wallet_first_seen row, so the fresh-wallet-cohort detector
// has data. RPC-heavy (paginates per wallet) — capped + throttled. Run on demand.
//
// Env: SOLANA_RPC_URL (+ data/.libsql-auth.json for the libSQL target).
import fs from "node:fs";
import { loadEnv } from "../lib/load-env.js";
loadEnv();
import { createClient } from "@libsql/client/web";
import { getSolanaConnection } from "../lib/solana.js";
import { tursoUpsertWalletFirstSeen } from "../lib/turso.js";
import { fetchOldestSignatureForAddress } from "../lib/wallet-age-rpc.js";

const LIMIT = Math.max(1, Number(process.env.WALLET_AGE_BACKFILL_LIMIT) || 120);
const MAX_PAGES = Math.max(1, Number(process.env.WALLET_AGE_MAX_PAGES) || 4);
const THROTTLE = Math.max(0, Number(process.env.WALLET_AGE_THROTTLE_MS) || 150);

const { token } = JSON.parse(fs.readFileSync("data/.libsql-auth.json", "utf8"));
const client = createClient({ url: "https://libsql-production-9bc3.up.railway.app", authToken: token });
const connection = getSolanaConnection();

const res = await client.execute({
  sql: `SELECT e.fee_payer AS payer, COUNT(*) AS n
        FROM events e
        LEFT JOIN wallet_first_seen w ON w.address = e.fee_payer
        WHERE e.fee_payer IS NOT NULL AND w.address IS NULL
        GROUP BY e.fee_payer ORDER BY n DESC LIMIT ?`,
  args: [LIMIT],
});
const payers = res.rows.map((r) => String(r.payer)).filter(Boolean);
console.log(`resolving wallet age for ${payers.length} top fee-payers (maxPages=${MAX_PAGES})…`);

let ok = 0;
for (let i = 0; i < payers.length; i++) {
  const addr = payers[i];
  try {
    const meta = await fetchOldestSignatureForAddress(connection, addr, { maxPages: MAX_PAGES });
    if (meta.signature) {
      await tursoUpsertWalletFirstSeen(client, {
        address: addr,
        first_signature: meta.signature,
        first_slot: meta.slot,
        first_block_time: meta.blockTime,
        pages_walked: meta.pagesWalked,
        capped: meta.capped ? 1 : 0,
      });
      ok++;
    }
  } catch (e) {
    /* skip */
  }
  if (i % 20 === 0) process.stdout.write(`  ${i}/${payers.length} (ok ${ok})\r`);
  if (THROTTLE) await new Promise((r) => setTimeout(r, THROTTLE));
}
console.log(`\nDone. Upserted ${ok}/${payers.length} wallet ages.`);
