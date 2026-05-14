/**
 * Computes a calm-regime baseline from a timelineBuckets series.
 * Buckets must be sorted ascending by startSec (score-math.js guarantees this).
 *
 * Uses oldest 70% as baseline — excludes the recent signal window
 * which may already be the anomaly we're trying to detect against.
 *
 * @param {Array<{startSec: number, endSec: number, walletCount: number, eventCount: number}>} timelineBuckets
 * @param {number} bucketWidthMinutes
 * @returns {BaselineResult | null}
 */
export function computeBaseline(timelineBuckets, bucketWidthMinutes) {
  if (!Array.isArray(timelineBuckets) || timelineBuckets.length < 8) {
    return null; // not enough history for a meaningful baseline
  }

  const cutoff = Math.floor(timelineBuckets.length * 0.7);
  const baselineBuckets = timelineBuckets.slice(0, cutoff); // oldest 70%

  const eventCounts = baselineBuckets.map((b) => b.eventCount);
  const walletCounts = baselineBuckets.map((b) => b.walletCount);

  const meanEvent = mean(eventCounts);
  const stdEvent = std(eventCounts);
  const meanWallet = mean(walletCounts);
  const stdWallet = std(walletCounts);
  const regime = classifyRegime(eventCounts);

  // Warn if history is shallow — baseline covers < 2h at 1m buckets
  const spanSeconds = baselineBuckets[cutoff - 1].endSec - baselineBuckets[0].startSec;
  const shallowHistory = spanSeconds < 7200; // < 2h

  return {
    mean_event_count: round4(meanEvent),
    std_event_count: round4(stdEvent),
    mean_wallet_count: round4(meanWallet),
    std_wallet_count: round4(stdWallet),
    bucket_count: baselineBuckets.length,
    baseline_start_sec: baselineBuckets[0].startSec,
    baseline_end_sec: baselineBuckets[cutoff - 1].endSec,
    bucket_width_minutes: bucketWidthMinutes,
    regime,
    shallow_history: shallowHistory,
    span_hours: round4(spanSeconds / 3600),
  };
}

/**
 * Persists a baseline to Turso. INSERT OR REPLACE so re-runs update in place.
 *
 * @param {import("@libsql/client").Client} turso
 * @param {string} scopeAddress
 * @param {BaselineResult} baseline
 */
export async function persistBaseline(turso, scopeAddress, baseline) {
  if (!turso || !baseline) return;
  await turso.execute({
    sql: `INSERT OR REPLACE INTO scope_baselines
      (scope_address, bucket_width_minutes, baseline_start_sec, baseline_end_sec,
       mean_event_count, std_event_count, mean_wallet_count, std_wallet_count,
       bucket_count, regime, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      scopeAddress,
      baseline.bucket_width_minutes,
      baseline.baseline_start_sec,
      baseline.baseline_end_sec,
      baseline.mean_event_count,
      baseline.std_event_count,
      baseline.mean_wallet_count,
      baseline.std_wallet_count,
      baseline.bucket_count,
      baseline.regime,
      Math.floor(Date.now() / 1000),
    ],
  });
}

/**
 * Normalize a Turso `scope_baselines` row for computeZScores (see zscore-engine.js).
 *
 * @param {Record<string, unknown> | null | undefined} row
 * @returns {object | null}
 */
export function baselineRowForZScores(row) {
  if (!row || typeof row !== "object") return null;
  const std = Number(row.std_event_count);
  if (!Number.isFinite(std) || std <= 0) return null;
  return {
    mean_event_count: Number(row.mean_event_count),
    std_event_count: std,
    mean_wallet_count: Number(row.mean_wallet_count),
    std_wallet_count: Number(row.std_wallet_count),
    bucket_count: Number(row.bucket_count) || 0,
    regime: row.regime != null ? String(row.regime) : "unknown",
  };
}

/**
 * Fetches a stored baseline for a scope + bucket width.
 * Returns null if none exists yet.
 *
 * @param {import("@libsql/client").Client} turso
 * @param {string} scopeAddress
 * @param {number} bucketWidthMinutes
 */
export async function fetchBaseline(turso, scopeAddress, bucketWidthMinutes) {
  if (!turso) return null;
  try {
    const result = await turso.execute({
      sql: `SELECT * FROM scope_baselines
            WHERE scope_address = ? AND bucket_width_minutes = ?
            LIMIT 1`,
      args: [scopeAddress, bucketWidthMinutes],
    });
    return result.rows?.[0] ?? null;
  } catch (e) {
    console.error("[baseline-manager] fetchBaseline", e);
    return null;
  }
}

/**
 * Fetches all baselines older than maxAgeDays — used by baseline:update CLI
 * to find scopes that need refreshing.
 *
 * @param {import("@libsql/client").Client} turso
 * @param {number} maxAgeDays
 */
export async function fetchStaleBaselines(turso, maxAgeDays = 1) {
  if (!turso) return [];
  const cutoffSec = Math.floor(Date.now() / 1000) - maxAgeDays * 86400;
  try {
    const result = await turso.execute({
      sql: `SELECT scope_address, bucket_width_minutes, computed_at, regime
            FROM scope_baselines
            WHERE computed_at < ?
            ORDER BY computed_at ASC`,
      args: [cutoffSec],
    });
    return result.rows ?? [];
  } catch (e) {
    console.error("[baseline-manager] fetchStaleBaselines", e);
    return [];
  }
}

// --- math helpers ---

function mean(arr) {
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function std(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

function classifyRegime(eventCounts) {
  const m = mean(eventCounts);
  if (m === 0) return "unknown";
  const cv = std(eventCounts) / m; // coefficient of variation
  if (cv > 1.5) return "active"; // volatile — baseline less reliable
  if (cv < 0.5) return "calm"; // stable — high confidence baseline
  return "unknown";
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/**
 * @typedef {{
 *   mean_event_count: number,
 *   std_event_count: number,
 *   mean_wallet_count: number,
 *   std_wallet_count: number,
 *   bucket_count: number,
 *   baseline_start_sec: number,
 *   baseline_end_sec: number,
 *   bucket_width_minutes: number,
 *   regime: 'calm' | 'active' | 'unknown',
 *   shallow_history: boolean,
 *   span_hours: number,
 * }} BaselineResult
 */
