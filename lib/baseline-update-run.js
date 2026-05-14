import { computeBaseline, fetchStaleBaselines, persistBaseline } from "./baseline-manager.js";
import { buildTimelineBucketsFromRows } from "./score-math.js";
import { fetchEventsForScope } from "./turso.js";

/**
 * @typedef {{ lastHours: number }} BaselineUpdateOpts
 */

/**
 * @param {import("@libsql/client").Client} client
 * @param {string} scopeAddress
 * @param {number} wm bucket width minutes (must match scope_baselines PK)
 * @param {BaselineUpdateOpts} opts
 * @returns {Promise<{ status: 'ok' | 'skip', detail?: string, baseline?: object }>}
 */
export async function updateBaselineForScope(client, scopeAddress, wm, opts) {
  const { lastHours } = opts;
  const cutoff = Math.floor(Date.now() / 1000) - lastHours * 3600;
  let rows;
  try {
    rows = await fetchEventsForScope(client, scopeAddress, cutoff);
  } catch (e) {
    return { status: "skip", detail: `turso fetch failed: ${String(e?.message ?? e)}` };
  }

  if (rows.length < 8) {
    return { status: "skip", detail: `insufficient events (${rows.length} — need ≥ 8)` };
  }

  const timelineBuckets = buildTimelineBucketsFromRows(rows, wm);
  if (timelineBuckets.length < 8) {
    return { status: "skip", detail: `insufficient buckets (${timelineBuckets.length} — need ≥ 8)` };
  }

  const baseline = computeBaseline(timelineBuckets, wm);
  if (!baseline) {
    return { status: "skip", detail: "computeBaseline returned null" };
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
