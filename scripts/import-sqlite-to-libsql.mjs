// Import data/chainmind-export.db into a libSQL server (LIBSQL_URL + LIBSQL_TOKEN).
// Target is self-hosted (no connection cap), so we batch inserts via the Hrana
// pipeline. Idempotent (INSERT OR REPLACE). Assumes schema already applied.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createClient } from "@libsql/client/web";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const url = process.env.LIBSQL_URL;
const authToken = process.env.LIBSQL_TOKEN;
if (!url || !authToken) {
  console.error("Set LIBSQL_URL and LIBSQL_TOKEN.");
  process.exit(1);
}
const dst = createClient({ url, authToken });
const src = new Database(resolve(root, "data/chainmind-export.db"), { readonly: true });

const BATCH = Math.max(1, Number(process.env.IMPORT_BATCH) || 200);
const skip = new Set((process.env.SKIP_TABLES ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const tables = src
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
  .all()
  .map((r) => r.name)
  .filter((t) => !skip.has(t));

// Retry batches on transient network errors (ECONNRESET etc.) — the raw client has no retry.
async function batchWithRetry(stmts) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await dst.batch(stmts, "write");
    } catch (e) {
      if (attempt === 7 || !/ECONNRESET|fetch failed|socket|timeout|terminated|5\d\d|EPIPE/i.test(String(e?.message ?? e))) throw e;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
}

for (const table of tables) {
  const cols = src.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (cols.length === 0) continue;
  const rows = src.prepare(`SELECT ${cols.join(", ")} FROM ${table}`).all();
  if (rows.length === 0) {
    console.log(`  - ${table}: 0 rows`);
    continue;
  }
  const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).map((row) => ({
      sql,
      args: cols.map((c) => {
        const v = row[c];
        return typeof v === "bigint" ? Number(v) : v ?? null;
      }),
    }));
    await batchWithRetry(batch);
    done += batch.length;
    process.stdout.write(`  ${table}: ${done}/${rows.length}\r`);
  }
  console.log(`  ✓ ${table}: ${done} rows`);
}
src.close();
console.log("Import done.");
