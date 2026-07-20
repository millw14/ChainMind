import { NextResponse } from "next/server";
import { hasOperatorAuth, isSameOriginBrowser } from "@/lib/api-auth.js";
import { getTursoClient, tursoFetchDbStats } from "@/lib/turso.js";

export const maxDuration = 30;
export const runtime = "nodejs";

export async function GET(request) {
  const client = getTursoClient();
  if (!client) {
    return NextResponse.json({
      ok: true,
      database: "unconfigured",
      signaturesTotal: null,
      eventsTotal: null,
      edgesTotal: null,
      byScope: [],
      graphFundingEdgeTypes: ["token_transfer", "fee_payer_cosigner", "mint_to", "native_transfer"],
      hint: "Add TURSO_DATABASE_URL + TURSO_AUTH_TOKEN in Vercel. Run npm run turso:schema then npm run turso:sync locally.",
    });
  }
  try {
    const stats = await tursoFetchDbStats(client);
    // The per-scope breakdown enumerates every address under investigation with how
    // deeply it's indexed — operator or the dashboard's own same-origin fetch. The
    // public (external-script) response keeps aggregate totals + scope count.
    if (!hasOperatorAuth(request) && !isSameOriginBrowser(request)) {
      return NextResponse.json({
        ok: true,
        database: "turso",
        signaturesTotal: stats.signaturesTotal,
        eventsTotal: stats.eventsTotal,
        edgesTotal: stats.edgesTotal,
        scopeCount: stats.byScope.length,
        byScope: [],
        graphFundingEdgeTypes: stats.graphFundingEdgeTypes,
        restricted: true,
      });
    }
    return NextResponse.json({ ok: true, database: "turso", ...stats });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String(e?.message ?? e) },
      { status: 500 },
    );
  }
}
