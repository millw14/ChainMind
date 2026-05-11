import { loadEnv } from "../lib/load-env.js";
loadEnv();

import { PublicKey } from "@solana/web3.js";
import { computeCoactivityScoreFromRows } from "../lib/score-math.js";
import { getTursoClient, tursoFetchScoreRows } from "../lib/turso.js";

export default async function handler(req, res) {
  const scope = String(req.query?.scope ?? req.query?.address ?? "").trim();
  const windowMinutes = Math.min(60, Math.max(1, Number(req.query?.window ?? 5) || 5));
  const lastHours = Math.min(24 * 30, Math.max(1, Number(req.query?.hours ?? 24) || 24));

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

  const client = getTursoClient();
  if (!client) {
    res.status(200).json({
      ok: true,
      empty: true,
      database: "unconfigured",
      message: "Score needs events in Turso. Set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN, apply schema, ingest data.",
      scope,
      windowMinutes,
      lastHours,
    });
    return;
  }

  try {
    const cutoff = Math.floor(Date.now() / 1000) - lastHours * 3600;
    const rows = await tursoFetchScoreRows(client, scope, cutoff);
    const result = computeCoactivityScoreFromRows(rows, scope, windowMinutes, lastHours);
    res.status(200).json({ ...result, database: "turso" });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
}
