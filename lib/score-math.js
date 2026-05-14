/**
 * Build time-bucket timeline for Z-score / charts (optional event_type filter).
 *
 * @param {Array<{ fee_payer: string, block_time: number, event_type?: string }>} rows
 * @param {number} windowMinutes
 * @param {Set<string> | null} eventTypes when set, only rows whose event_type is in this set
 * @returns {{ startSec: number, endSec: number, walletCount: number, eventCount: number }[]}
 */
export function buildTimelineBucketsFromRows(rows, windowMinutes, eventTypes = null) {
  const bucketSec = windowMinutes * 60;
  /** @type {Map<number, Set<string>>} */
  const buckets = new Map();
  /** @type {Map<number, number>} */
  const bucketEventCounts = new Map();

  for (const r of rows) {
    if (eventTypes && !eventTypes.has(String(r.event_type ?? "other"))) continue;
    const t = r.block_time;
    const b = Math.floor(t / bucketSec);
    if (!buckets.has(b)) buckets.set(b, new Set());
    buckets.get(b).add(r.fee_payer);
    bucketEventCounts.set(b, (bucketEventCounts.get(b) ?? 0) + 1);
  }

  const timelineBuckets = [...buckets.entries()]
    .map(([bucketKey, walletSet]) => ({
      startSec: bucketKey * bucketSec,
      endSec: (bucketKey + 1) * bucketSec,
      walletCount: walletSet.size,
      eventCount: bucketEventCounts.get(bucketKey) ?? 0,
    }))
    .sort((a, b) => a.startSec - b.startSec);

  return timelineBuckets.length > 320
    ? timelineBuckets.slice(timelineBuckets.length - 320)
    : timelineBuckets;
}

/**
 * Pure co-activity scoring (no database import — safe for Vercel bundles).
 *
 * @param {Array<{ fee_payer: string, block_time: number, programs_json: string, event_type: string }>} rows
 * @param {string} scope
 * @param {number} windowMinutes
 * @param {number} lastHours
 */
export function computeCoactivityScoreFromRows(rows, scope, windowMinutes, lastHours) {
  if (rows.length === 0) {
    return {
      ok: true,
      empty: true,
      scope,
      windowMinutes,
      lastHours,
      message: "No events in this lookback — run backfill + ingest-events first (or sync data to Turso).",
    };
  }

  const bucketSec = windowMinutes * 60;
  /** @type {Map<number, Set<string>>} */
  const buckets = new Map();
  /** @type {Map<number, number>} */
  const bucketEventCounts = new Map();
  /** @type {Map<string, number>} */
  const payerEventCounts = new Map();
  /** @type {Map<string, number>} */
  const programHits = new Map();
  /** @type {Map<string, number>} */
  const typeHits = new Map();

  for (const r of rows) {
    const t = r.block_time;
    const b = Math.floor(t / bucketSec);
    if (!buckets.has(b)) buckets.set(b, new Set());
    buckets.get(b).add(r.fee_payer);
    bucketEventCounts.set(b, (bucketEventCounts.get(b) ?? 0) + 1);

    if (r.fee_payer) {
      payerEventCounts.set(r.fee_payer, (payerEventCounts.get(r.fee_payer) ?? 0) + 1);
    }

    typeHits.set(r.event_type, (typeHits.get(r.event_type) ?? 0) + 1);

    try {
      const progs = JSON.parse(r.programs_json ?? "[]");
      for (const p of progs) {
        programHits.set(p, (programHits.get(p) ?? 0) + 1);
      }
    } catch {
      /* ignore */
    }
  }

  let bestBucket = null;
  let bestCount = 0;
  for (const [k, set] of buckets) {
    if (set.size > bestCount) {
      bestCount = set.size;
      bestBucket = k;
    }
  }

  const topPrograms = [...programHits.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([program, count]) => ({ program, count }));

  const typeBreakdown = Object.fromEntries(
    [...typeHits.entries()].sort((a, b) => b[1] - a[1]),
  );

  const bucketStarts = bestBucket != null ? bestBucket * bucketSec : null;
  const distinctPayers = new Set(rows.map((r) => r.fee_payer)).size;

  const timelineTail = buildTimelineBucketsFromRows(rows, windowMinutes, null);

  const topPayerLinks = [...payerEventCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 18)
    .map(([payer, events]) => ({ payer, events }));

  const walletGraph = {
    center: scope,
    nodes: [
      { id: scope, kind: "scope", label: scope, eventCount: rows.length },
      ...topPayerLinks.map(({ payer, events }) => ({
        id: payer,
        kind: "wallet",
        label: payer,
        eventCount: events,
      })),
    ],
    links: topPayerLinks.map(({ payer, events }) => ({
      source: scope,
      target: payer,
      events,
    })),
  };

  const drivers = [
    `In one ${windowMinutes}-minute slice, at most ${bestCount} different wallets paid fees for txs touching this scope.`,
    `Across the last ${lastHours}h, ${rows.length} parsed events met filters.`,
  ];
  if (topPrograms[0]) {
    drivers.push(
      `Most common program id: ${topPrograms[0].program} (${topPrograms[0].count} events).`,
    );
  }

  return {
    ok: true,
    empty: false,
    scope,
    windowMinutes,
    lastHours,
    eventsCounted: rows.length,
    distinctPayersWholeWindow: distinctPayers,
    score: bestCount,
    scoreLabel: "max distinct fee payers in any single time bucket",
    peakBucketStartsIso: bucketStarts != null ? new Date(bucketStarts * 1000).toISOString() : null,
    peakBucketWalletCount: bestCount,
    typeBreakdown,
    topPrograms,
    timelineBuckets: timelineTail,
    walletGraph,
    drivers,
    limitation:
      "Busy tokens score high from normal traffic; not proof of collusion — pair with funding graphs and calibration.",
  };
}
