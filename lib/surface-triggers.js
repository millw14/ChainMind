/**
 * Autonomous “surface” rules: turn score/inspect payloads into suspicion signals without manual address entry.
 * Market-volume / oracle price / news correlation are **not** implemented — see externalRulesDocumentation().
 *
 * @typedef {{ ruleId: string, severity: 'critical' | 'high' | 'medium' | 'low', title: string, detail: string, entities: string[] }} SurfaceHit
 */

const DEFAULTS = {
  eventSpikeMult: 3,
  minFundedPayers: 5,
  densePayerMin: 14,
};

/**
 * Rules that need non-ChainMind data sources (DEX, headlines, indexing).
 */
export function externalRulesDocumentation() {
  return [
    {
      ruleId: "dex_volume_spike",
      description: "Token/market volume > 3× trailing 24h average inside ~15 minutes",
      requires: ["Per-market volume time series (DEX aggregator, indexer, or Jupiter/Birdeye-style API)."],
    },
    {
      ruleId: "price_move_uncorrelated",
      description: "Price move > ~8% with no correlated news/social signal",
      requires: ["Price feed", "optional news/social API or NLP classifier"],
    },
    {
      ruleId: "new_wallet_cluster_birth",
      description: "Cluster of new wallets with coordinated first txs",
      requires: ["Account creation slot / rentEpoch metadata, or heuristic across many first-seen payers"],
    },
  ];
}

/**
 * @param {Record<string, string | undefined>} [env]
 */
function optsFromEnv(env = process.env) {
  const g = (k, d) => {
    const v = env[k];
    if (v === undefined || v === "") return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  return {
    eventSpikeMult: g("SURFACE_EVENT_SPIKE_MULT", DEFAULTS.eventSpikeMult),
    minFundedPayers: g("SURFACE_MIN_FUNDED_PAYERS", DEFAULTS.minFundedPayers),
    densePayerMin: g("SURFACE_DENSE_PAYER_MIN", DEFAULTS.densePayerMin),
  };
}

/**
 * @param {any} score
 * @param {{ eventSpikeMult: number }} opt
 * @returns {SurfaceHit | null}
 */
function ruleIngestEventSpike(score, opt) {
  if (!score?.ok || score.empty) return null;
  const buckets = score.timelineBuckets;
  if (!Array.isArray(buckets) || buckets.length < 4) return null;
  const counts = buckets.map((b) => Number(b.eventCount) || 0);
  const sum = counts.reduce((a, b) => a + b, 0);
  const mean = sum / counts.length;
  const max = Math.max(...counts);
  if (mean <= 0 || max < opt.eventSpikeMult * mean) return null;
  return {
    ruleId: "ingest_event_spike",
    severity: max >= opt.eventSpikeMult * mean * 1.5 ? "high" : "medium",
    title: "Activity burst vs ingest baseline",
    detail: `Activity spike — ${max} events in ${score.windowMinutes ?? "?"}m, ${opt.eventSpikeMult}× above the baseline average of ${mean.toFixed(1)}.`,
    entities: typeof score.scope === "string" ? [score.scope] : [],
  };
}

/**
 * @param {any} score
 * @param {{ minFundedPayers: number }} opt
 * @returns {SurfaceHit[]}
 */
function ruleFundingHub(score, opt) {
  const fg = score?.fundingGraph;
  if (fg?.status !== "attached" || !Array.isArray(fg.sharedInboundFunders)) return [];
  /** @type {SurfaceHit[]} */
  const out = [];
  for (const row of fg.sharedInboundFunders) {
    const n = Number(row.recipientCount) || 0;
    if (n < opt.minFundedPayers) continue;
    const fund = String(row.funder ?? "");
    const payers = Array.isArray(row.recipientPayers) ? row.recipientPayers.map(String) : [];
    out.push({
      ruleId: "funding_hub_shared",
      severity: n >= opt.minFundedPayers + 2 ? "critical" : "high",
      title: "Shared funder fans out to many payers",
      detail: `Shared funder detected — one wallet funded ${n} active fee payers in this window.`,
      entities: [fund, ...payers].filter(Boolean),
    });
  }
  return out;
}

/**
 * @param {any} score
 * @param {{ densePayerMin: number }} opt
 * @returns {SurfaceHit | null}
 */
function ruleDensePayerBurst(score, opt) {
  if (!score?.ok || score.empty) return null;
  const peak = Number(score.peakBucketWalletCount ?? score.score ?? 0);
  if (peak < opt.densePayerMin) return null;
  return {
    ruleId: "dense_fee_payer_burst",
    severity: peak >= opt.densePayerMin + 4 ? "critical" : "high",
    title: "Coordinated fee-payer pressure",
    detail: `${peak} unique fee payers in a single ${score.windowMinutes ?? "?"}m window — coordination pressure above threshold.`,
    entities: typeof score.scope === "string" ? [score.scope] : [],
  };
}

/**
 * @param {{ score?: any, inspect?: any }} input
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ hits: SurfaceHit[], externalRulesPending: ReturnType<typeof externalRulesDocumentation> }}
 */
export function evaluateSurfaceTriggers(input, env) {
  const o = optsFromEnv(env);
  const score = input.score;
  /** @type {SurfaceHit[]} */
  const hits = [];

  const burst = ruleDensePayerBurst(score, o);
  if (burst) hits.push(burst);

  hits.push(...ruleFundingHub(score, o));

  const ev = ruleIngestEventSpike(score, o);
  if (ev) hits.push(ev);

  return { hits, externalRulesPending: externalRulesDocumentation() };
}
