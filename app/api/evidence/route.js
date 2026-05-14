/**
 * app/api/evidence/route.js
 *
 * GET /api/evidence?scope=<base58>&lookback=<hours>
 *
 * Returns the full evidence payload: timeline, wallet table, edges,
 * shared_funders, and summary.
 *
 * DB priority: Turso (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN) → local SQLite
 * (DATABASE_PATH or data/chainmind.db). Same pattern as /api/score fallback
 * via local file when Turso is unset.
 *
 * Query params:
 *   scope    {string}  required — base58 mint, wallet, or program
 *   lookback {number}  optional — hours (default 24, max 168)
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import Database from "better-sqlite3";

import { buildEvidencePayload } from "@/lib/evidence.js";
import { getTursoClient } from "@/lib/turso.js";

export const maxDuration = 60;
export const runtime = "nodejs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getDb() {
  const turso = getTursoClient();
  if (turso) return { kind: "turso", client: turso };

  const dbPath =
    process.env.DATABASE_PATH?.trim() || resolve(__dirname, "../../../data/chainmind.db");
  return { kind: "sqlite", client: new Database(dbPath, { readonly: true }) };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);

  const scope = searchParams.get("scope")?.trim();

  if (!scope) {
    return NextResponse.json(
      { error: "scope is required — pass a base58 Solana address" },
      { status: 400 },
    );
  }

  try {
    new PublicKey(scope);
  } catch {
    return NextResponse.json({ error: "scope is not a valid base58 Solana address" }, { status: 400 });
  }

  const lookbackH = Math.min(
    168,
    Math.max(1, parseInt(searchParams.get("lookback") ?? "24", 10) || 24),
  );

  let handle;
  try {
    handle = getDb();
  } catch (err) {
    console.error("[evidence] db init:", err?.message ?? err);
    return NextResponse.json(
      {
        error: "Database unavailable",
        detail:
          "Set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN, or DATABASE_PATH for local SQLite. " +
          "Run the pipeline first to populate data.",
      },
      { status: 503 },
    );
  }

  const db = handle.client;

  try {
    const payload = await buildEvidencePayload(db, scope, { lookbackH });
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("[evidence] build failed:", err?.message ?? err);
    return NextResponse.json(
      { error: "Evidence build failed", detail: String(err?.message ?? err) },
      { status: 500 },
    );
  } finally {
    if (handle.kind === "sqlite" && typeof db?.close === "function") {
      db.close();
    }
  }
}
