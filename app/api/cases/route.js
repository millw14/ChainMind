import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { appBaseUrl } from "@/lib/app-base-url.js";
import { buildInvestigationCasePayload } from "@/lib/case-file.js";
import { expandFundingTreeInbound } from "@/lib/funding-tree-turso.js";
import { buildTursoScoreBundle } from "@/lib/score-bundle.js";
import { getTursoClient, tursoInsertInvestigationCase } from "@/lib/turso.js";

export const maxDuration = 60;
export const runtime = "nodejs";

function authorizeCaseCreate(request) {
  const secret = process.env.CASE_CREATE_SECRET?.trim();
  if (!secret) return true;
  const h = request.headers.get("authorization") || "";
  return h === `Bearer ${secret}`;
}

export async function POST(request) {
  if (!authorizeCaseCreate(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized (set CASE_CREATE_SECRET or send Bearer token)" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const scope = String(body.scope ?? body.address ?? "").trim();
  if (!scope) {
    return NextResponse.json({ ok: false, error: "Missing scope (base58 mint or address)" }, { status: 400 });
  }
  try {
    new PublicKey(scope);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid base58 scope" }, { status: 400 });
  }

  const windowMinutes = Math.min(60, Math.max(1, Number(body.windowMinutes ?? body.window ?? 5) || 5));
  const lastHours = Math.min(24 * 30, Math.max(1, Number(body.lastHours ?? body.hours ?? 24) || 24));
  const title = body.title != null ? String(body.title).slice(0, 240) : null;
  const groqAnalysis =
    body.groqAnalysis != null && typeof body.groqAnalysis === "object" ? body.groqAnalysis : null;

  const fundingMaxDepth = Math.min(8, Math.max(1, Number(body.fundingMaxDepth) || 4));
  const fundingMaxNodes = Math.min(200, Math.max(24, Number(body.fundingMaxNodes) || 96));

  const client = getTursoClient();
  if (!client) {
    return NextResponse.json(
      { ok: false, error: "Turso not configured (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN)" },
      { status: 503 },
    );
  }

  try {
    const bundle = await buildTursoScoreBundle(
      client,
      { scope, windowMinutes, lastHours },
      { includeCaseInternal: true },
    );

    const seeds =
      Array.isArray(bundle.topPayerLinks) && bundle.topPayerLinks.length > 0
        ? bundle.topPayerLinks.slice(0, 16).map((x) => String(x.payer ?? "").trim()).filter(Boolean)
        : [];

    const internal = Object.getOwnPropertyDescriptor(bundle, "_caseInternal")?.value;
    const cutoff = internal?.cutoffUnix ?? Math.floor(Date.now() / 1000) - lastHours * 3600;

    const fundingTree = await expandFundingTreeInbound(client, scope, cutoff, seeds, {
      maxDepth: fundingMaxDepth,
      maxNodes: fundingMaxNodes,
    });

    const caseId = crypto.randomUUID();
    const createdAtIso = new Date().toISOString();

    const payload = buildInvestigationCasePayload(bundle, fundingTree, {
      caseId,
      createdAtIso,
      scope,
      windowMinutes,
      lastHours,
      groqAnalysis,
      title,
    });

    const base = appBaseUrl();
    payload.permalink = `${base}/investigation/${caseId}`;
    payload.apiJsonUrl = `${base}/api/cases/${caseId}`;
    payload.apiMarkdownUrl = `${base}/api/cases/${caseId}?format=markdown`;

    await tursoInsertInvestigationCase(client, {
      id: caseId,
      scope_address: scope,
      window_minutes: windowMinutes,
      last_hours: lastHours,
      payload: /** @type {Record<string, unknown>} */ (payload),
    });

    return NextResponse.json({
      ok: true,
      caseId,
      permalink: payload.permalink,
      apiJsonUrl: payload.apiJsonUrl,
      apiMarkdownUrl: payload.apiMarkdownUrl,
    });
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/no such table|SQLITE_UNKNOWN|investigation_cases/i.test(msg)) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Investigation table missing. Run npm run turso:schema (or apply schema/migrations/007_investigation_cases.sql) on this Turso DB.",
          detail: msg.slice(0, 400),
        },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: false, error: msg.slice(0, 800) }, { status: 500 });
  }
}
