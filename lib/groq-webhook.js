/**
 * High-confidence verdict outbound (Slack/custom HTTP).
 * Uses CHAINMIND_VERDICT_WEBHOOK_URL; optional CHAINMIND_VERDICT_WEBHOOK_SECRET as Bearer.
 */

const WEBHOOK_TIMEOUT_MS = 15_000;

/**
 * @param {object} payload - JSON-serializable body
 * @returns {Promise<{ ok: boolean, status?: number, skipped?: boolean, error?: string }>}
 */
export async function sendVerdictWebhook(payload) {
  const url = process.env.CHAINMIND_VERDICT_WEBHOOK_URL?.trim();
  if (!url) {
    return { ok: true, skipped: true };
  }

  const secret = process.env.CHAINMIND_VERDICT_WEBHOOK_SECRET?.trim();
  /** @type {Record<string, string>} */
  const headers = { "Content-Type": "application/json" };
  if (secret) {
    headers.Authorization = `Bearer ${secret}`;
  }

  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), WEBHOOK_TIMEOUT_MS);
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(tid);
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: t.slice(0, 500) || res.statusText };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    const msg = e?.name === "AbortError" ? "Webhook timeout" : String(e?.message ?? e);
    return { ok: false, error: msg };
  }
}
