// Apply schema/turso.sql to a libSQL server given by LIBSQL_URL + LIBSQL_TOKEN.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client/web";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const url = process.env.LIBSQL_URL;
const authToken = process.env.LIBSQL_TOKEN;
if (!url || !authToken) {
  console.error("Set LIBSQL_URL and LIBSQL_TOKEN.");
  process.exit(1);
}
const c = createClient({ url, authToken });

const sql = readFileSync(resolve(root, "schema/turso.sql"), "utf8");
function stripLeadingComments(s) {
  const lines = s.split(/\r?\n/);
  while (lines.length && (lines[0].trim() === "" || lines[0].trim().startsWith("--"))) lines.shift();
  return lines.join("\n").trim();
}
let n = 0;
for (const raw of sql.split(/;\s*(?:\r?\n|$)/)) {
  const stmt = stripLeadingComments(raw.trim());
  if (!stmt) continue;
  await c.execute(stmt + ";");
  n++;
}
const t = await c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
console.log(`Applied ${n} statements. Tables now: ${t.rows.length}`);
console.log(t.rows.map((r) => r.name).join(", "));
