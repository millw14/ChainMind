import { appBaseUrl } from "./app-base-url.js";
import { buildGroqEvidence } from "./groq-evidence.js";
import { GROQ_BRIEF_USER_FOCUS } from "./groq-brief-defaults.js";
import { buildAlerts } from "./intel-alerts.js";
import { getGeoqApiKey } from "./geoq.js";
import { deriveRiskProfile } from "./risk-profile.js";

/**
 * Same evidence shape as /api/cron/analyst-sweep → POST /api/groq-brief.
 * Uses HTTP to `/api/groq-brief` so all auth + normalization stay in one place.
 *
 * @param {{
 *   scope: string,
 *   scoreBundle: Record<string, unknown>,
 *   inspectLimit?: number,
 * }} p
 * @returns {Promise<{ analysis: unknown, model?: string, webhook?: unknown }>}
 */
export async function runGroqBriefForInvestigationCase(p) {
  getGeoqApiKey();

  const { scope, scoreBundle } = p;
  const inspectLimit = Math.min(100, Math.max(1, Number(p.inspectLimit) || 12));
  const base = appBaseUrl();

  const [inspectRes, pingRes] = await Promise.all([
    fetch(`${base}/api/inspect?address=${encodeURIComponent(scope)}&limit=${inspectLimit}`, {
      cache: "no-store",
    }),
    fetch(`${base}/api/ping`, { cache: "no-store" }),
  ]);

  const inspect = inspectRes.ok ? await inspectRes.json().catch(() => ({})) : { ok: false, error: `HTTP ${inspectRes.status}` };
  const ping = pingRes.ok ? await pingRes.json().catch(() => ({})) : { error: `HTTP ${pingRes.status}` };

  const risk = deriveRiskProfile(scoreBundle);
  const intelAlerts = buildAlerts({ inspect, score: scoreBundle, ping });
  const evidence = {
    ...buildGroqEvidence({ address: scope, score: scoreBundle, inspect, risk }),
    rpcCluster: ping?.ok ? { cluster: ping.cluster, slot: ping.slot } : { error: ping?.error ?? "RPC unknown" },
    inspectLimit,
    automatedAlerts: intelAlerts.map((a) => ({
      severity: a.severity,
      title: a.title,
      detail: a.detail,
    })),
  };

  /** @type {Record<string, string>} */
  const headers = { "Content-Type": "application/json" };
  const briefSecret = process.env.GROQ_BRIEF_SECRET?.trim();
  if (briefSecret) headers.Authorization = `Bearer ${briefSecret}`;

  const groqRes = await fetch(`${base}/api/groq-brief`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      data: evidence,
      source: "case",
      focus: GROQ_BRIEF_USER_FOCUS,
    }),
  });

  const groqJson = await groqRes.json().catch(() => ({}));
  if (!groqRes.ok) {
    const err =
      typeof groqJson?.error === "string"
        ? groqJson.error
        : groqRes.status === 401
          ? "groq-brief returned 401 — check GROQ_BRIEF_SECRET matches this request"
          : `groq-brief HTTP ${groqRes.status}`;
    throw new Error(err);
  }

  return groqJson;
}
