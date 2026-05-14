import { NextResponse } from "next/server";
import { investigationCaseToMarkdown } from "@/lib/case-markdown.js";
import { getTursoClient, tursoFetchInvestigationCase } from "@/lib/turso.js";

export const runtime = "nodejs";

/**
 * @param {import("next/server").NextRequest} request
 * @param {{ params: Promise<{ id: string }> }} ctx
 */
export async function GET(request, ctx) {
  const { id: rawId } = await ctx.params;
  const id = String(rawId ?? "").trim();
  if (!id) {
    return NextResponse.json({ ok: false, error: "Missing case id" }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const format = (searchParams.get("format") ?? "").toLowerCase();

  const client = getTursoClient();
  if (!client) {
    return NextResponse.json({ ok: false, error: "Turso not configured" }, { status: 503 });
  }

  const row = await tursoFetchInvestigationCase(client, id);
  if (!row) {
    return NextResponse.json({ ok: false, error: "Case not found" }, { status: 404 });
  }

  if (format === "markdown" || format === "md") {
    const md = investigationCaseToMarkdown(row.payload);
    return new NextResponse(md, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `inline; filename="chainmind-case-${id}.md"`,
      },
    });
  }

  const frozen = {
    ok: true,
    case: {
      id: row.id,
      scope_address: row.scope_address,
      created_at: row.created_at,
      window_minutes: row.window_minutes,
      last_hours: row.last_hours,
      ...row.payload,
    },
  };

  return NextResponse.json(frozen);
}
