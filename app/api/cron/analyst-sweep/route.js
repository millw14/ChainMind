import { NextResponse } from "next/server";
import { appBaseUrl } from "@/lib/app-base-url.js";
import { buildAlerts } from "@/lib/intel-alerts.js";
import { buildGroqEvidence } from "@/lib/groq-evidence.js";
import { GROQ_BRIEF_USER_FOCUS } from "@/lib/groq-brief-defaults.js";
import { GROQ_AUTO_CO_ACTIVITY } from "@/lib/groq-thresholds.js";
import { deriveRiskProfile } from "@/lib/risk-profile.js";

export const maxDuration = 120;
export const runtime = "nodejs";

/**
 * Secured scheduled sweep: Vercel Cron sends Authorization: Bearer CRON_SECRET when env is set.
 * @param {Request} request
 */
function authorizeCron(request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not set — add it in Vercel env to enable /api/cron/analyst-sweep" },
      { status: 503 },
    );
  }
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

async function fetchJson(url) {
  const r = await fetch(url, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  return { r, j };
}

/**
 * Runs on Vercel Cron (GET). Fetches score + inspect for CHAINMIND_CRON_SCOPE (or CHAINMIND_SCOPE).
 * If co-activity > GROQ_AUTO_CO_ACTIVITY, POSTs the same payload as the dashboard to /api/groq-brief (source=auto).
 */
export async function GET(request) {
  const denied = authorizeCron(request);
  if (denied) return denied;

  const scope = (process.env.CHAINMIND_CRON_SCOPE || process.env.CHAINMIND_SCOPE || "").trim();
  if (!scope) {
    return NextResponse.json(
      { error: "Set CHAINMIND_CRON_SCOPE or CHAINMIND_SCOPE to a base58 mint/wallet" },
      { status: 400 },
    );
  }

  const window = Math.min(60, Math.max(1, Number(process.env.CHAINMIND_CRON_SCORE_WINDOW ?? 5) || 5));
  const hours = Math.min(24 * 30, Math.max(1, Number(process.env.CHAINMIND_CRON_SCORE_HOURS ?? 168) || 168));
  const inspectLimit = Math.min(100, Math.max(1, Number(process.env.CHAINMIND_CRON_INSPECT_LIMIT ?? 12) || 12));

  const base = appBaseUrl();
  const scoreUrl = `${base}/api/score?scope=${encodeURIComponent(scope)}&window=${window}&hours=${hours}`;
  const inspectUrl = `${base}/api/inspect?address=${encodeURIComponent(scope)}&limit=${inspectLimit}`;
  const pingUrl = `${base}/api/ping`;

  const [scorePack, inspectPack, pingPack] = await Promise.all([
    fetchJson(scoreUrl),
    fetchJson(inspectUrl),
    fetchJson(pingUrl),
  ]);

  if (!scorePack.r.ok) {
    return NextResponse.json(
      { error: "Score request failed", status: scorePack.r.status, body: scorePack.j },
      { status: 502 },
    );
  }

  const score = scorePack.j;
  const inspect = inspectPack.r.ok
    ? inspectPack.j
    : { ok: false, error: inspectPack.j?.error ?? `HTTP ${inspectPack.r.status}` };
  const ping = pingPack.r.ok ? pingPack.j : { error: pingPack.j?.error ?? `HTTP ${pingPack.r.status}` };

  const risk = deriveRiskProfile(score);
  const coActivityScore =
    risk?.score0_100 != null && Number.isFinite(Number(risk.score0_100)) ? Number(risk.score0_100) / 100 : null;

  if (coActivityScore == null || coActivityScore <= GROQ_AUTO_CO_ACTIVITY) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "co_activity_below_threshold",
      scope,
      coActivityScore,
      threshold: GROQ_AUTO_CO_ACTIVITY,
    });
  }

  const intelAlerts = buildAlerts({ inspect, score, ping });
  const evidence = {
    ...buildGroqEvidence({ address: scope, score, inspect, risk }),
    rpcCluster: ping?.ok ? { cluster: ping.cluster, slot: ping.slot } : { error: ping?.error ?? "RPC unknown" },
    inspectLimit,
    automatedAlerts: intelAlerts.map((a) => ({
      severity: a.severity,
      title: a.title,
      detail: a.detail,
    })),
  };

  /** @type {Record<string, string>} */
  const groqHeaders = { "Content-Type": "application/json" };
  const briefSecret = process.env.GROQ_BRIEF_SECRET?.trim();
  if (briefSecret) groqHeaders.Authorization = `Bearer ${briefSecret}`;

  const groqRes = await fetch(`${base}/api/groq-brief`, {
    method: "POST",
    headers: groqHeaders,
    body: JSON.stringify({
      data: evidence,
      source: "auto",
      focus: GROQ_BRIEF_USER_FOCUS,
    }),
  });
  const groqJson = await groqRes.json().catch(() => ({}));
  if (!groqRes.ok) {
    return NextResponse.json(
      { error: "groq-brief failed", status: groqRes.status, body: groqJson },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    scope,
    coActivityScore,
    analysis: groqJson.analysis,
    webhook: groqJson.webhook,
    model: groqJson.model,
  });
}
