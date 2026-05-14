import { loadEnv } from "../lib/load-env.js";

loadEnv();

import { getSolanaConnection } from "../lib/solana.js";
import { getTursoClient, tursoUpsertWalletFirstSeen } from "../lib/turso.js";
import { fetchOldestSignatureForAddress } from "../lib/wallet-age-rpc.js";

function parseArgs(argv) {
  /** @type {string[]} */
  const addrs = [];
  let maxPages = 8;
  let throttleMs = 120;
  for (const a of argv) {
    if (a.startsWith("--max-pages=")) {
      maxPages = Math.min(40, Math.max(1, Number(a.split("=")[1]) || 8));
    } else if (a.startsWith("--throttle-ms=")) {
      throttleMs = Math.min(5000, Math.max(0, Number(a.split("=")[1]) || 0));
    } else if (!a.startsWith("--")) {
      addrs.push(a.trim());
    }
  }
  return { addrs, maxPages, throttleMs };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const { addrs, maxPages, throttleMs } = parseArgs(process.argv.slice(2));

if (addrs.length === 0) {
  console.error(
    "Usage: npm run wallet-age:backfill -- <base58> [base58 ...] [--max-pages=8] [--throttle-ms=120]\n" +
      "Fetches oldest signature per address via RPC and upserts Turso table wallet_first_seen.",
  );
  process.exit(1);
}

const turso = getTursoClient();
if (!turso) {
  console.error("Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.");
  process.exit(1);
}

const connection = getSolanaConnection();

let ok = 0;
for (let i = 0; i < addrs.length; i++) {
  const addr = addrs[i];
  try {
    const meta = await fetchOldestSignatureForAddress(connection, addr, { maxPages });
    if (!meta.signature) {
      console.warn("skip (no sigs):", addr.slice(0, 12) + "…", meta.err ?? "");
      continue;
    }
    await tursoUpsertWalletFirstSeen(turso, {
      address: addr,
      first_signature: meta.signature,
      first_slot: meta.slot,
      first_block_time: meta.blockTime,
      pages_walked: meta.pagesWalked,
      capped: meta.capped ? 1 : 0,
    });
    ok++;
    console.log(
      "OK",
      addr.slice(0, 8) + "…",
      "firstBlockTime=",
      meta.blockTime ?? "null",
      "capped=",
      meta.capped,
      "pages=",
      meta.pagesWalked,
    );
  } catch (e) {
    console.error("ERR", addr.slice(0, 8) + "…", String(e?.message ?? e));
  }
  if (throttleMs > 0 && i < addrs.length - 1) await sleep(throttleMs);
}

console.log("Done. Upserted", ok, "/", addrs.length);
