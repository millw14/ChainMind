import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

import { loadEnv } from "../lib/load-env.js";
loadEnv();

import { PublicKey } from "@solana/web3.js";
import { openDb } from "../lib/db.js";
import { getTursoClient } from "../lib/turso.js";

function parseFlags(argv) {
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  const positional = [];
  for (const a of argv) {
    if (a.startsWith("--")) {
      const raw = a.slice(2);
      const eq = raw.indexOf("=");
      if (eq === -1) flags[raw] = true;
      else flags[raw.slice(0, eq)] = raw.slice(eq + 1);
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

const { flags, positional } = parseFlags(process.argv.slice(2));
const address =
  positional[0]?.trim() ||
  process.env.CHAINMIND_SCOPE?.trim() ||
  process.env.TARGET_ADDRESS?.trim() ||
  "";

const lookbackH = Math.min(
  24 * 90,
  Math.max(1, Number(flags.hours ?? process.env.EVIDENCE_LOOKBACK_HOURS ?? "24") || 24),
);

if (!address) {
  console.error(`
Usage:
  npm run evidence -- <base58-scope> [--hours=24] [--from-downloads] [--module=<path-to-evidence.js>]

  --from-downloads   Import ~/Downloads/evidence.js (your copy on disk)
  --module=          Absolute or relative path to evidence.js (overrides default)

Default module: lib/evidence.js (repo). Turso is used when TURSO_DATABASE_URL + TURSO_AUTH_TOKEN are set; else local DATABASE_PATH / data/chainmind.db.
`);
  process.exit(1);
}

try {
  new PublicKey(address);
} catch {
  console.error("Invalid base58 address:", address);
  process.exit(1);
}

const scope = address.trim();

/** @type {string} */
let modulePath;
if (typeof flags.module === "string" && flags.module.trim()) {
  modulePath = flags.module.trim();
} else if (flags["from-downloads"] === true || flags.fromDownloads === true) {
  modulePath = join(homedir(), "Downloads", "evidence.js");
} else {
  modulePath = resolve(__dirname, "../lib/evidence.js");
}

const resolvedModule = resolve(modulePath);
const modUrl = pathToFileURL(resolvedModule).href;

let buildEvidencePayload;
try {
  ({ buildEvidencePayload } = await import(modUrl));
} catch (e) {
  console.error(`Failed to import evidence module from:\n  ${modulePath}\n  (${modUrl})`);
  console.error(e);
  process.exit(1);
}

if (typeof buildEvidencePayload !== "function") {
  console.error("Module must export buildEvidencePayload");
  process.exit(1);
}

const turso = getTursoClient();
const db = turso ?? openDb();

console.error(
  `[run-evidence] scope=${scope.slice(0, 8)}… lookback=${lookbackH}h backend=${turso ? "turso" : "sqlite"} module=${modulePath}`,
);

const payload = await buildEvidencePayload(db, scope, { lookbackH });
console.log(JSON.stringify(payload, null, 2));
