import { loadEnv } from "../lib/load-env.js";
loadEnv();

import { getTursoClient, tursoFetchDbStats } from "../lib/turso.js";

export default async function handler(_req, res) {
  const client = getTursoClient();
  if (!client) {
    res.status(200).json({
      ok: true,
      database: "unconfigured",
      signaturesTotal: null,
      eventsTotal: null,
      byScope: [],
      hint: "Add TURSO_DATABASE_URL + TURSO_AUTH_TOKEN in Vercel, run npm run turso:schema, then sync data (or use local SQLite only).",
    });
    return;
  }
  try {
    const stats = await tursoFetchDbStats(client);
    res.status(200).json({ ok: true, database: "turso", ...stats });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
}
