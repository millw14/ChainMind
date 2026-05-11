import { NextResponse } from "next/server";
import { getTursoClient, tursoFetchDbStats } from "@/lib/turso.js";

export const maxDuration = 30;
export const runtime = "nodejs";

export async function GET() {
  const client = getTursoClient();
  if (!client) {
    return NextResponse.json({
      ok: true,
      database: "unconfigured",
      signaturesTotal: null,
      eventsTotal: null,
      byScope: [],
      hint: "Add TURSO_DATABASE_URL + TURSO_AUTH_TOKEN in Vercel. Run npm run turso:schema then npm run turso:sync locally.",
    });
  }
  try {
    const stats = await tursoFetchDbStats(client);
    return NextResponse.json({ ok: true, database: "turso", ...stats });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String(e?.message ?? e) },
      { status: 500 },
    );
  }
}
