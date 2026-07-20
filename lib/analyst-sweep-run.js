import { buildAlerts } from "@/lib/intel-alerts.js";
import { buildGroqEvidence } from "@/lib/groq-evidence.js";
import { GROQ_BRIEF_USER_FOCUS } from "@/lib/groq-brief-defaults.js";
import { GROQ_AUTO_CO_ACTIVITY } from "@/lib/groq-thresholds.js";
import { deriveRiskProfile } from "@/lib/risk-profile.js";
import { internalAuthHeaders } from "@/lib/api-auth.js";

/** @param {string} url */
async function fetchJson(url) {
  const r = await fetch(url, { headers: internalAuthHeaders() });
  const j = await r.json().catch(() => ({}));
  return { r, j };
}

/**
 * Single-scope analyst sweep: score + inspect, optional Groq when co-activity &gt; threshold.
 *
 * @param {{
 *   baseUrl: string,
 *   scope: string,
 *   window: number,
 *   hours: number,
 *   inspectLimit: number,
 * }} params
 */
export async function runAnalystSweepForScope(params) {
  const { baseUrl, scope, window, hours, inspectLimit } = params;
  const base = baseUrl.replace(/\/$/, "");
  const scoreUrl = `${base}/api/score?scope=${encodeURIComponent(scope)}&window=${window}&hours=${hours}`;
  const inspectUrl = `${base}/api/inspect?address=${encodeURIComponent(scope)}&limit=${inspectLimit}`;
  const pingUrl = `${base}/api/ping`;

  const [scorePack, inspectPack, pingPack] = await Promise.all([
    fetchJson(scoreUrl),
    fetchJson(inspectUrl),
    fetchJson(pingUrl),
  ]);

  if (!scorePack.r.ok) {
    return {
      scope,
      ok: false,
      error: "score_failed",
      status: scorePack.r.status,
      body: scorePack.j,
    };
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
    return {
      scope,
      ok: true,
      skipped: true,
      reason: "co_activity_below_threshold",
      coActivityScore,
      threshold: GROQ_AUTO_CO_ACTIVITY,
    };
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
  const briefSecret =
    process.env.CHAINMIND_OPERATOR_SECRET?.trim() ||
    process.env.GROQ_BRIEF_SECRET?.trim() ||
    process.env.CRON_SECRET?.trim();
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
    return {
      scope,
      ok: false,
      error: "groq_brief_failed",
      status: groqRes.status,
      body: groqJson,
      coActivityScore,
    };
  }

  return {
    scope,
    ok: true,
    coActivityScore,
    analysis: groqJson.analysis,
    webhook: groqJson.webhook,
    model: groqJson.model,
  };
}
