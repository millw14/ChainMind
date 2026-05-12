/**
 * Webhook alert formatting + detector fan-out for incremental watch loops.
 *
 * @typedef {import("./detectors/shared.js").DetectorResult} DetectorResult
 * @typedef {import("./detectors/shared.js").DetectorEvidence} DetectorEvidence
 *
 * @typedef {{
 *   flag: string,
 *   confidence: number,
 *   scope: string,
 *   triggered_at: string,
 *   summary: string,
 *   evidence: DetectorEvidence[],
 * }} AlertPayload
 */

/** @typedef {"generic" | "discord" | "slack"} WebhookKind */

import { buildAdjacencyFromEdges } from "./graph.js";
import {
  detectWashTrading,
  detectSybilPump,
  detectFeePayerConcentration,
  detectCoordinatedAccumulation,
} from "./detectors/index.js";

/**
 * @param {string | URL} url
 * @returns {WebhookKind}
 */
export function inferWebhookKind(url) {
  const s = String(url);
  if (s.includes("discord.com/api/webhooks") || s.includes("discordapp.com/api/webhooks")) return "discord";
  if (s.includes("hooks.slack.com")) return "slack";
  return "generic";
}

/**
 * @param {DetectorResult} result
 * @param {string} scope base58 scope_address the watcher is bound to
 * @param {string} [triggeredAt] ISO8601 (default now UTC)
 * @returns {AlertPayload}
 */
export function toAlertPayload(result, scope, triggeredAt) {
  const when = triggeredAt ?? new Date().toISOString();
  return {
    flag: result.flag,
    confidence: result.confidence,
    scope,
    triggered_at: when,
    summary: result.summary,
    evidence: result.evidence,
  };
}

/**
 * @param {AlertPayload} payload
 */
export function payloadToJsonBody(payload) {
  return JSON.stringify(payload);
}

/**
 * Discord incoming webhook payload (rich embed).
 * @param {AlertPayload} payload
 */
export function discordWebhookBody(payload) {
  const fields = payload.evidence.slice(0, 20).map((e, i) => ({
    name: `#${i + 1}${e.wallet ? ` · ${String(e.wallet).slice(0, 12)}…` : ""}`,
    value: String(e.action).slice(0, 900),
    inline: false,
  }));
  return JSON.stringify({
    embeds: [
      {
        title: `ChainMind · ${payload.flag}`,
        description: `**${(payload.confidence * 100).toFixed(1)}%** · ${payload.scope.slice(0, 12)}…\n${payload.summary.slice(0, 1800)}`,
        color: 0xf97316,
        fields,
        timestamp: payload.triggered_at,
      },
    ],
  });
}

/**
 * Slack incoming webhook (mrkdwn text body).
 * @param {AlertPayload} payload
 */
export function slackWebhookBody(payload) {
  const lines = [
    `*ChainMind* · *${payload.flag}* · ${(payload.confidence * 100).toFixed(1)}%`,
    `*Scope:* \`${payload.scope}\``,
    `*When:* ${payload.triggered_at}`,
    payload.summary,
    "",
    ...payload.evidence.slice(0, 12).map((e, i) => `• ${i + 1}. ${e.action}`),
  ];
  return JSON.stringify({ text: lines.join("\n").slice(0, 35_000) });
}

/**
 * @param {string} url
 * @param {string} body serialized JSON string
 * @param {WebhookKind} kind
 */
export async function postWebhook(url, body, kind) {
  const headers = { "Content-Type": "application/json" };
  if (kind === "slack") headers["User-Agent"] = "ChainMind-Alerts/1.0";

  const res = await fetch(url, { method: "POST", headers, body });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Webhook HTTP ${res.status}: ${t.slice(0, 500)}`);
  }
}

/**
 * @param {string} url
 * @param {AlertPayload} payload
 * @param {WebhookKind | "auto"} kind
 */
export async function sendAlert(url, payload, kind = "auto") {
  const k = kind === "auto" ? inferWebhookKind(url) : kind;
  let body;
  if (k === "discord") body = discordWebhookBody(payload);
  else if (k === "slack") body = slackWebhookBody(payload);
  else body = payloadToJsonBody(payload);

  await postWebhook(url, body, k);
}

/**
 * Heuristic: decide mint-hint + focal wallet for detector inputs from scoped DB rows.
 * @param {import("better-sqlite3").Database} db
 * @param {string} scope watch target (token mint or wallet pubkey)
 * @returns {{ mintHint: string | null, focalWallet: string, mode: "mint" | "wallet" }}
 */
export function inferWatchContext(db, scope) {
  const asMintCount = Number(
    db.prepare(`SELECT COUNT(*) AS c FROM transfers WHERE scope_address = ? AND mint = ?`).get(scope, scope)?.c ?? 0,
  );

  /** @type {{ mint: string, n: number } | undefined} */
  const dom = db.prepare(
    `
    SELECT mint AS mint, COUNT(*) AS n
    FROM transfers
    WHERE scope_address = ? AND mint IS NOT NULL
    GROUP BY mint
    ORDER BY n DESC
    LIMIT 1
  `,
  ).get(scope);

  const dominantMint = dom?.mint ? String(dom.mint) : null;

  if (asMintCount >= 6 || dominantMint === scope) {
    const focalRow = db
      .prepare(
        `
      SELECT w AS w, SUM(n) AS tot FROM (
        SELECT from_address AS w, COUNT(*) AS n
        FROM transfers
        WHERE scope_address = ? AND mint = ?
        GROUP BY from_address
        UNION ALL
        SELECT to_address AS w, COUNT(*) AS n
        FROM transfers
        WHERE scope_address = ? AND mint = ?
        GROUP BY to_address
      )
      GROUP BY w
      ORDER BY tot DESC
      LIMIT 1
    `,
      )
      .get(scope, scope, scope, scope);
    const focalWallet = focalRow?.w ? String(focalRow.w) : scope;
    return { mintHint: scope, focalWallet, mode: "mint" };
  }

  return {
    mintHint: dominantMint,
    focalWallet: scope,
    mode: "wallet",
  };
}

/**
 * Run the four detectors with shared graph + inferred mint/focal.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {import("./graph.js").AdjacencyGraph} graph
 * @param {string} scope
 * @param {{ mintHint: string | null, focalWallet: string }} ctx
 * @returns {DetectorResult[]}
 */
export function runAllDetectors(db, graph, scope, ctx) {
  /** @type {DetectorResult[]} */
  const out = [];
  const base = { db, scopeAddress: scope };

  try {
    out.push(detectWashTrading(graph, ctx.focalWallet, { ...base, mint: ctx.mintHint ?? undefined }));
  } catch (e) {
    console.error("detectWashTrading:", e);
  }

  try {
    out.push(detectSybilPump(graph, ctx.focalWallet, { ...base, mint: ctx.mintHint ?? undefined }));
  } catch (e) {
    console.error("detectSybilPump:", e);
  }

  if (ctx.mintHint) {
    try {
      out.push(detectFeePayerConcentration(graph, ctx.focalWallet, { ...base, mint: ctx.mintHint }));
    } catch (e) {
      console.error("detectFeePayerConcentration:", e);
    }

    try {
      out.push(detectCoordinatedAccumulation(graph, ctx.focalWallet, { ...base, mint: ctx.mintHint }));
    } catch (e) {
      console.error("detectCoordinatedAccumulation:", e);
    }
  }

  return out;
}

export { buildAdjacencyFromEdges };

/**
 * @typedef {{
 *   key: string,
 *   lastSentAt: number,
 *   lastConfidence: number,
 *   lastHash: string,
 * }} ThrottleEntry
 */

/** @param {string} s */
function shortHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/**
 * @param {DetectorResult} r
 */
function evidenceHash(r) {
  const slice = r.evidence.slice(0, 12).map((e) => `${e.wallet ?? ""}|${e.slot ?? ""}|${e.action}`);
  return shortHash(slice.join("\u001f"));
}

/**
 * @param {Map<string, ThrottleEntry>} map
 * @param {string} scope
 * @param {DetectorResult} r
 * @param {number} cooldownMs
 * @param {number} confidenceDelta
 */
export function shouldEmit(map, scope, r, cooldownMs, confidenceDelta) {
  const key = `${scope}:${r.flag}`;
  const now = Date.now();
  const h = evidenceHash(r);
  let cur = map.get(key);
  if (!cur) {
    cur = { key, lastSentAt: 0, lastConfidence: -1, lastHash: "" };
    map.set(key, cur);
  }

  if (r.confidence <= 0) return false;

  const cooldownOk = now - cur.lastSentAt >= cooldownMs;
  const stronger = r.confidence >= cur.lastConfidence + confidenceDelta;
  const newEvidence = h !== cur.lastHash;

  if (cur.lastSentAt === 0) return true;
  return cooldownOk || stronger || newEvidence;
}

/**
 * @param {Map<string, ThrottleEntry>} map
 * @param {string} scope
 * @param {DetectorResult} r
 */
export function recordEmitted(map, scope, r) {
  const key = `${scope}:${r.flag}`;
  const cur = map.get(key) ?? { key, lastSentAt: 0, lastConfidence: -1, lastHash: "" };
  cur.lastSentAt = Date.now();
  cur.lastConfidence = r.confidence;
  cur.lastHash = evidenceHash(r);
  map.set(key, cur);
}
