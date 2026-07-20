// One-command off-site backup: dump the irreplaceable tables from the production
// libSQL → timestamped SQLite file → upload to Cloudflare R2.
// Run on demand or on a schedule. Env: TURSO_DATABASE_URL + TURSO_AUTH_TOKEN
// (or LIBSQL_URL + LIBSQL_TOKEN for an explicit target) + R2_* in .env.local.
//
//   node scripts/backup-and-upload.mjs            # critical tables only (small, fast)
//   node scripts/backup-and-upload.mjs --full     # full DB (large; over a flaky link this is slow)
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { loadEnv } from "../lib/load-env.js";
loadEnv();

const root = resolve(import.meta.dirname ?? ".", "..");
const full = process.argv.includes("--full");
if (
  !(process.env.LIBSQL_URL && process.env.LIBSQL_TOKEN) &&
  !(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN)
) {
  console.error("Set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN (or LIBSQL_URL + LIBSQL_TOKEN).");
  process.exit(1);
}

const ts = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
const kind = full ? "full" : "critical";
const outPath = resolve(root, `data/backups/${kind}-${ts}.db`);

// Regenerable tables (the worker rebuilds these from chain) — skipped for the small backup.
const REGENERABLE = "signatures,events,transfers,edges,signers,program_calls";

// export-turso-to-sqlite.mjs resolves the target itself: LIBSQL_URL/LIBSQL_TOKEN
// if set, else TURSO_DATABASE_URL/TURSO_AUTH_TOKEN — both inherited from process.env.
const env = {
  ...process.env,
  EXPORT_OUT_PATH: outPath,
  EXPORT_PAGE_SIZE: full ? "400" : "300",
  CHAINMIND_TURSO_RETRIES: "40",
  CHAINMIND_TURSO_RETRY_BASE_MS: "400",
  ...(full ? {} : { SKIP_TABLES: REGENERABLE }),
};

console.log(`[1/2] dumping ${kind} backup → ${outPath}`);
execFileSync(process.execPath, [resolve(root, "scripts/export-turso-to-sqlite.mjs")], { env, stdio: "inherit" });

console.log(`[2/2] uploading to R2 bucket ${process.env.R2_BUCKET}…`);
execFileSync(process.execPath, [resolve(root, "scripts/upload-backup-r2.mjs"), outPath], { env: process.env, stdio: "inherit" });

console.log("Backup + off-site upload complete.");
