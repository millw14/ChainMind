import { computeBaseline, fetchStaleBaselines, persistBaseline } from "./baseline-manager.js";
import { computeCoactivityScoreFromRows } from "./score-math.js";
import { tursoFetchScoreRows } from "./turso.js";

/**
 * @typedef {{ lastHours: number, force: boolean }} BaselineUpdateOpts
 */

/**
 * @param {import("@libsql/client").Client} client
 * @param {string} scopeAddress
 * @param {number} wm bucket width minutes (must match scope_baselines PK)
 * @param {BaselineUpdateOpts} opts
 * @returns {Promise<{ status: 'ok' | 'skip', detail?: string, baseline?: object }>}
 */
export async function updateBaselineForScope(client, scopeAddress, wm, opts) {
  const { lastHours, force } = opts;
  const cutoff = Math.floor(Date.now() / 1000) - lastHours * 3600;
  const rows = await tursoFetchScoreRows(client, scopeAddress, cutoff);
  const result = computeCoactivityScoreFromRows(rows, scopeAddress, wm, lastHours);

  if (!result.ok || result.empty) {
    return { status: "skip", detail: `no events in ${lastHours}h lookback` };
  }

  const tb = result.timelineBuckets;
  const baseline = computeBaseline(tb, wm);
  if (!baseline) {
    const n = Array.isArray(tb) ? tb.length : 0;
    return { status: "skip", detail: `need ≥8 timeline buckets (have ${n})` };
  }

  if (baseline.shallow_history && !force) {
    return { status: "skip", detail: "shallow=true" };
  }

  await persistBaseline(client, scopeAddress, baseline);
  return { status: "ok", baseline };
}

/**
 * @param {import("@libsql/client").Client} client
 * @param {{ address: string, note?: string }[]} scopes
 * @param {number} windowMinutes
 * @param {BaselineUpdateOpts} opts
 */
export async function updateBaselinesForWatchlist(client, scopes, windowMinutes, opts) {
  /** @type {{ scope: string, status: string, detail?: string, regime?: string, bucket_count?: number, span_hours?: number, shallow?: boolean }[]} */
  const results = [];
  for (const s of scopes) {
    const r = await updateBaselineForScope(client, s.address, windowMinutes, opts);
    const row = {
      scope: s.address,
      status: r.status,
      ...(r.detail ? { detail: r.detail } : {}),
    };
    if (r.status === "ok" && r.baseline) {
      row.regime = r.baseline.regime;
      row.bucket_count = r.baseline.bucket_count;
      row.span_hours = r.baseline.span_hours;
      row.shallow = r.baseline.shallow_history;
    }
    results.push(row);
  }
  return results;
}

/**
 * @param {import("@libsql/client").Client} client
 * @param {number} staleDays
 * @param {BaselineUpdateOpts} opts
 */
export async function updateBaselinesForStaleRows(client, staleDays, opts) {
  const stale = await fetchStaleBaselines(client, staleDays);
  /** @type {{ scope: string, bucketWidthMinutes: number, status: string, detail?: string, regime?: string, bucket_count?: number, span_hours?: number, shallow?: boolean }[]} */
  const results = [];
  for (const row of stale) {
    const addr = String(row.scope_address ?? "");
    const wm = Number(row.bucket_width_minutes);
    if (!addr || !Number.isFinite(wm) || wm < 1) continue;
    const r = await updateBaselineForScope(client, addr, wm, opts);
    const out = {
      scope: addr,
      bucketWidthMinutes: wm,
      status: r.status,
      ...(r.detail ? { detail: r.detail } : {}),
    };
    if (r.status === "ok" && r.baseline) {
      out.regime = r.baseline.regime;
      out.bucket_count = r.baseline.bucket_count;
      out.span_hours = r.baseline.span_hours;
      out.shallow = r.baseline.shallow_history;
    }
    results.push(out);
  }
  return { staleRowCount: stale.length, results };
}
