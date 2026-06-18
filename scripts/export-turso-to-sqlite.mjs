// Export the entire Turso database to a portable local SQLite file.
// Safe, read-only against Turso; builds data/chainmind-export.db which can be
// uploaded to a self-hosted libSQL instance. Paginates by rowid and uses the
// retrying Turso client, so the free-tier connection cap doesn't break the dump.
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { loadEnv } from "../lib/load-env.js";
loadEnv();
import { getTursoClient } from "../lib/turso.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const turso = getTursoClient();
if (!turso) {
  console.error("Set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN.");
  process.exit(1);
}

const outPath = resolve(root, "data/chainmind-export.db");
mkdirSync(dirname(outPath), { recursive: true });
const local = new Database(outPath);
local.pragma("journal_mode = WAL");

// Apply the full schema so every table exists in the export. Strip leading
// full-line comments per statement so "-- note\nCREATE TABLE ..." isn't skipped.
const schemaSql = readFileSync(resolve(root, "schema/turso.sql"), "utf8");
function stripLeadingComments(s) {
  const lines = s.split(/\r?\n/);
  while (lines.length && (lines[0].trim() === "" || lines[0].trim().startsWith("--"))) lines.shift();
  return lines.join("\n").trim();
}
for (const raw of schemaSql.split(/;\s*(?:\r?\n|$)/)) {
  const s = stripLeadingComments(raw.trim());
  if (!s) continue;
  try {
    local.exec(s + ";");
  } catch (e) {
    // index/table already exists or harmless — keep going
  }
}

// Tables to copy (from schema). Order doesn't matter — no FKs enforced.
const tablesRes = await turso.execute(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\'",
);
const skip = new Set((process.env.SKIP_TABLES ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const tables = tablesRes.rows.map((r) => String(r.name)).filter(Boolean).filter((t) => !skip.has(t));
if (skip.size) console.log("Skipping tables:", [...skip].join(", "));
console.log("Tables to export:", tables.join(", "));

const PAGE = Math.max(25, Number(process.env.EXPORT_PAGE_SIZE) || 1000);
for (const table of tables) {
  // Skip if the export DB doesn't have this table (schema mismatch) — report it.
  const cols = local.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (cols.length === 0) {
    console.log(`  ! ${table}: not in local schema — skipped`);
    continue;
  }
  const insert = local.prepare(
    `INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
  );
  // Keyset pagination by rowid — avoids deep OFFSET cost (which timed out/502'd on
  // big tables) and is resilient to restarts. Fetch rowid alongside the columns.
  let lastRowid = 0;
  let total = 0;
  for (;;) {
    const res = await turso.execute({
      sql: `SELECT rowid AS _rid, ${cols.join(", ")} FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      args: [lastRowid, PAGE],
    });
    const rows = res.rows;
    if (rows.length === 0) break;
    const tx = local.transaction((batch) => {
      for (const row of batch) insert.run(cols.map((c) => row[c] ?? null));
    });
    tx(rows);
    total += rows.length;
    lastRowid = Number(rows[rows.length - 1]._rid);
    if (rows.length < PAGE) break;
  }
  console.log(`  ✓ ${table}: ${total} rows`);
}

local.close();
console.log(`\nDone → ${outPath}`);
