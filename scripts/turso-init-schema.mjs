import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../lib/load-env.js";
import { getTursoClient } from "../lib/turso.js";

loadEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(__dirname, "..", "schema", "turso.sql");
const raw = readFileSync(sqlPath, "utf8");

const client = getTursoClient();
if (!client) {
  console.error("Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN (Turso dashboard).");
  process.exit(1);
}

/**
 * Strip leading full-line SQL comments so a block like
 * "-- comment\nCREATE TABLE ..." is not dropped by mistake.
 * @param {string} s
 */
function stripLeadingLineComments(s) {
  const lines = s.split(/\r?\n/);
  while (lines.length > 0) {
    const t = lines[0].trim();
    if (t === "" || t.startsWith("--")) lines.shift();
    else break;
  }
  return lines.join("\n").trim();
}

const parts = raw
  .split(/;\s*(?:\r?\n|$)/)
  .map((s) => stripLeadingLineComments(s.trim()))
  .filter((s) => s.length > 0);

for (const statement of parts) {
  await client.execute(statement + ";");
}

console.log("Turso schema applied:", parts.length, "statements.");
