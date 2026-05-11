import { loadEnv } from "../lib/load-env.js";
loadEnv();

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { PublicKey } from "@solana/web3.js";
import { getSolanaCluster, getSolanaConnection, getSolanaRpcUrl } from "../lib/solana.js";
import { withRpcRetry } from "../lib/rpc-retry.js";
import { fetchSignaturesForDisplay } from "../lib/inspect-service.js";
import { openDb } from "../lib/db.js";
import { computeCoactivityScore } from "../lib/score-core.js";

function redactRpcUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    if (u.searchParams.has("api-key")) u.searchParams.set("api-key", "***");
    return u.toString();
  } catch {
    return url.slice(0, 48) + (url.length > 48 ? "…" : "");
  }
}

const app = express();
const PORT = Number(process.env.PORT ?? "3847");

const __dirname = dirname(fileURLToPath(import.meta.url));
app.use(express.static(join(__dirname, "..", "public")));

app.get("/api/ping", async (_req, res) => {
  try {
    const connection = getSolanaConnection();
    const version = await withRpcRetry(() => connection.getVersion());
    const slot = await withRpcRetry(() => connection.getSlot("confirmed"));
    res.json({
      ok: true,
      cluster: getSolanaCluster(),
      rpcUrl: redactRpcUrl(getSolanaRpcUrl()),
      version: version?.["solana-core"] ?? version,
      slot,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message ?? e) });
  }
});

app.get("/api/inspect", async (req, res) => {
  const address = String(req.query.address ?? "").trim();
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 15) || 15));
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
    res.json({ ok: true, address, limit, signatures });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message ?? e) });
  }
});

app.get("/api/db-stats", (_req, res) => {
  try {
    const db = openDb();
    const sigTotal = db.prepare(`SELECT COUNT(*) AS c FROM signatures`).get().c;
    const evtTotal = db.prepare(`SELECT COUNT(*) AS c FROM events`).get().c;
    const byScope = db
      .prepare(
        `
        WITH scopes AS (
          SELECT DISTINCT scope_address AS scope FROM signatures
          UNION
          SELECT DISTINCT scope_address AS scope FROM events
        )
        SELECT
          scopes.scope,
          (SELECT COUNT(*) FROM signatures s WHERE s.scope_address = scopes.scope) AS signatures,
          (SELECT COUNT(*) FROM events e WHERE e.scope_address = scopes.scope) AS events
        FROM scopes
        ORDER BY events DESC, signatures DESC
      `,
      )
      .all();
    db.close();
    res.json({ ok: true, signaturesTotal: sigTotal, eventsTotal: evtTotal, byScope });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message ?? e) });
  }
});

app.get("/api/score", (req, res) => {
  const scope = String(req.query.scope ?? req.query.address ?? "").trim();
  const windowMinutes = Math.min(
    60,
    Math.max(1, Number(req.query.window ?? 5) || 5),
  );
  const lastHours = Math.min(
    24 * 30,
    Math.max(1, Number(req.query.hours ?? 24) || 24),
  );
  if (!scope) {
    res.status(400).json({ ok: false, error: "Missing ?scope=<base58>" });
    return;
  }
  try {
    new PublicKey(scope);
  } catch {
    res.status(400).json({ ok: false, error: "Invalid base58 address" });
    return;
  }
  try {
    const db = openDb();
    const result = computeCoactivityScore(db, scope, windowMinutes, lastHours);
    db.close();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message ?? e) });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`ChainMind dashboard: http://127.0.0.1:${PORT}/`);
});
