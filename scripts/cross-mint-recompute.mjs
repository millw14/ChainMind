import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../lib/load-env.js";
import { recomputeCrossMintIntel } from "../lib/cross-mint-intel.js";
import { getTursoClient } from "../lib/turso.js";
import { loadWatchlist } from "../lib/watchlist.js";

loadEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));

const client = getTursoClient();
if (!client) {
  console.error("Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.");
  process.exit(1);
}

let scopes;
try {
  scopes = loadWatchlist(join(__dirname, ".."));
} catch (e) {
  console.error(e);
  process.exit(1);
}

if (!scopes.length) {
  console.error("No watchlist scopes.");
  process.exit(1);
}

const hours = Math.min(24 * 30, Math.max(1, Number(process.env.SURFACE_SCORE_HOURS ?? 168) || 168));
const topN = Math.min(48, Math.max(5, Number(process.env.CROSS_MINT_TOP_PAYERS ?? 18) || 18));
const minCluster = Math.min(24, Math.max(2, Number(process.env.CROSS_MINT_MIN_CLUSTER ?? 3) || 3));

const result = await recomputeCrossMintIntel(
  client,
  scopes.map((s) => s.address),
  { lookbackHours: hours, topN, minClusterMembers: minCluster },
);

console.log(JSON.stringify(result, null, 2));
