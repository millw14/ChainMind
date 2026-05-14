import { buildEntityClassificationContext, classifyEntityId } from "./entity-classify.js";

/**
 * Build typed entity ledger rows from a dashboard snapshot (same ids Groq may cite).
 *
 * @param {Record<string, any>} d
 */
function buildEntityLedgerFromSnapshot(d) {
  const ctx = buildEntityClassificationContext(d);
  const seen = new Set();
  /** @type {{ fullId: string, shortId: string, role: string }[]} */
  const ledger = [];

  const pushId = (id) => {
    const fullId = String(id ?? "").trim();
    if (!fullId || seen.has(fullId)) return;
    seen.add(fullId);
    const c = classifyEntityId(fullId, ctx);
    ledger.push({ fullId, shortId: c.shortId, role: c.role });
  };

  if (ctx.scope) pushId(ctx.scope);
  if (Array.isArray(d.walletAges)) {
    for (const w of d.walletAges) {
      if (w?.address) pushId(w.address);
    }
  }
  if (Array.isArray(d.topPrograms)) {
    for (const p of d.topPrograms.slice(0, 8)) {
      if (p?.program) pushId(p.program);
    }
  }
  if (Array.isArray(d.signatures)) {
    for (const s of d.signatures.slice(0, 24)) {
      if (s?.signature) pushId(s.signature);
    }
  }

  return ledger.slice(0, 56);
}

/**
 * Narrow evidence object for the Groq *user* message — concrete addresses, sigs, timing, rates.
 * Built from the full dashboard/cron snapshot (POST `data`).
 *
 * @param {unknown} fullSnapshot
 */
export function buildGroqUserEvidence(fullSnapshot) {
  if (!fullSnapshot || typeof fullSnapshot !== "object") {
    return {
      address: null,
      scope: null,
      scopeAddress: null,
      coActivityScore: null,
      score: null,
      distinctPayers: null,
      distinctPayersWholeWindow: null,
      distinctFeePayersWholeWindow: null,
      peakBucketWalletCount: null,
      peakBucketStartsIso: null,
      windowMinutes: null,
      lastHours: null,
      lookbackHours: null,
      eventsCounted: null,
      typeBreakdown: {},
      topPrograms: [],
      drivers: [],
      priorVerdicts: [],
      feePayers: [],
      signatures: [],
      timeDeltas: null,
      failureRate: null,
      entityLedger: [],
      transferEdgesSample: [],
      payerOverlapPriorWindowsPct: null,
      distinctFeePayersPeak: null,
      timeWindow: null,
      fundingGraph: {
        status: "not_attached",
        reason: "no_snapshot",
        note: "Pass a dashboard evidence object to attach funding + entities.",
      },
      accountAge: { status: "not_fetched", note: "Not in export." },
    };
  }

  const d = /** @type {Record<string, any>} */ (fullSnapshot);

  /** @type {string[]} */
  const feePayers = [];
  if (Array.isArray(d.walletAges)) {
    for (const w of d.walletAges) {
      if (w?.address) feePayers.push(String(w.address));
    }
  }

  const rawSigs = Array.isArray(d.signatures) ? d.signatures : [];
  const n = rawSigs.length;
  const failed = rawSigs.filter((s) => s?.failed || s?.err).length;
  const failureRate = n > 0 ? Math.round((failed / n) * 1000) / 1000 : null;

  const signatures = rawSigs.slice(0, 24).map((s) => {
    const blockTimeIso =
      s.blockTimeIso ||
      (s.blockTime != null && Number.isFinite(Number(s.blockTime))
        ? new Date(Number(s.blockTime) * 1000).toISOString()
        : undefined);
    return {
      signature: s.signature,
      slot: s.slot ?? null,
      failed: Boolean(s.failed || s.err),
      ...(blockTimeIso ? { blockTimeIso } : {}),
    };
  });

  const timeDeltas = computeTimeDeltas(rawSigs);

  const entityLedger = buildEntityLedgerFromSnapshot(d);

  const fundingGraph =
    d.fundingGraph && typeof d.fundingGraph === "object"
      ? d.fundingGraph
      : { status: "not_attached", reason: "field_missing_on_snapshot" };

  const accountAge =
    d.accountAge && typeof d.accountAge === "object"
      ? d.accountAge
      : { status: "not_fetched", note: "Wallet first-tx not loaded — use wallet-age:backfill or score lazy-fetch env." };

  const addr =
    (typeof d.address === "string" && d.address.trim()) ||
    (typeof d.scopeAddress === "string" && d.scopeAddress.trim()) ||
    (typeof d.scope === "string" && d.scope.trim()) ||
    null;

  const lastH =
    d.lastHours != null && Number.isFinite(Number(d.lastHours))
      ? Math.round(Number(d.lastHours))
      : d.lookbackHours != null && Number.isFinite(Number(d.lookbackHours))
        ? Math.round(Number(d.lookbackHours))
        : null;

  const winM =
    d.windowMinutes != null && Number.isFinite(Number(d.windowMinutes))
      ? Math.round(Number(d.windowMinutes))
      : null;

  const wholeRaw =
    d.distinctPayersWholeWindow != null && Number.isFinite(Number(d.distinctPayersWholeWindow))
      ? Number(d.distinctPayersWholeWindow)
      : d.distinctFeePayersWholeWindow != null && Number.isFinite(Number(d.distinctFeePayersWholeWindow))
        ? Number(d.distinctFeePayersWholeWindow)
        : null;

  const distinctPayersRaw =
    d.distinctPayers != null && Number.isFinite(Number(d.distinctPayers))
      ? Number(d.distinctPayers)
      : wholeRaw;

  const typeBreakdown =
    d.typeBreakdown && typeof d.typeBreakdown === "object" && !Array.isArray(d.typeBreakdown) ? d.typeBreakdown : {};

  const topPrograms = Array.isArray(d.topPrograms) ? d.topPrograms.slice(0, 8) : [];
  const drivers = Array.isArray(d.drivers) ? d.drivers : [];
  const priorVerdicts = Array.isArray(d.priorVerdicts) ? d.priorVerdicts : [];

  const transferEdgesSample = Array.isArray(d.transferEdgesSample)
    ? d.transferEdgesSample.slice(0, 40).filter((x) => x && typeof x === "object")
    : [];

  return {
    ...d,
    address: addr,
    scope: addr,
    scopeAddress: addr,
    coActivityScore: d.coActivityScore ?? d.score ?? null,
    score: d.score ?? d.coActivityScore ?? null,
    distinctPayers: distinctPayersRaw ?? wholeRaw ?? null,
    distinctPayersWholeWindow: wholeRaw,
    distinctFeePayersWholeWindow: wholeRaw,
    distinctFeePayersPeak:
      d.distinctFeePayers != null && Number.isFinite(Number(d.distinctFeePayers))
        ? Number(d.distinctFeePayers)
        : d.peakBucketWalletCount != null && Number.isFinite(Number(d.peakBucketWalletCount))
          ? Number(d.peakBucketWalletCount)
          : null,
    distinctFeePayers:
      d.distinctFeePayers != null && Number.isFinite(Number(d.distinctFeePayers))
        ? Number(d.distinctFeePayers)
        : d.peakBucketWalletCount != null && Number.isFinite(Number(d.peakBucketWalletCount))
          ? Number(d.peakBucketWalletCount)
          : null,
    peakBucketWalletCount:
      d.peakBucketWalletCount != null && Number.isFinite(Number(d.peakBucketWalletCount))
        ? Number(d.peakBucketWalletCount)
        : null,
    peakBucketStartsIso: typeof d.peakBucketStartsIso === "string" ? d.peakBucketStartsIso : null,
    windowMinutes: winM,
    lastHours: lastH,
    lookbackHours: lastH,
    eventsCounted:
      d.eventsCounted != null && Number.isFinite(Number(d.eventsCounted)) ? Math.round(Number(d.eventsCounted)) : null,
    typeBreakdown,
    topPrograms,
    drivers,
    priorVerdicts,
    feePayers: feePayers.slice(0, 16),
    signatures,
    timeDeltas,
    failureRate,
    sampledTxCount: n,
    transferEdgesSample,
    payerOverlapPriorWindowsPct:
      typeof d.payerOverlapPriorWindowsPct === "number" && Number.isFinite(d.payerOverlapPriorWindowsPct)
        ? d.payerOverlapPriorWindowsPct
        : null,
    fundingNarrative: typeof d.fundingOverlap === "string" ? d.fundingOverlap : null,
    fundingGraph,
    entityLedger,
    accountAge,
  };
}

/**
 * @param {any[]} sigRows — items with blockTimeIso or blockTime
 */
function computeTimeDeltas(sigRows) {
  /** @type {number[]} */
  const times = [];
  for (const s of sigRows) {
    let t = null;
    if (s?.blockTimeIso) {
      const ms = Date.parse(s.blockTimeIso);
      if (Number.isFinite(ms)) t = Math.floor(ms / 1000);
    } else if (s?.blockTime != null && Number.isFinite(Number(s.blockTime))) {
      t = Number(s.blockTime);
    }
    if (t != null) times.push(t);
  }
  times.sort((a, b) => b - a);
  if (times.length === 0) {
    return { hasTimestamps: false, note: "No block times in sample — deltas unavailable." };
  }
  const now = Math.floor(Date.now() / 1000);
  const newestToNowSec = now - times[0];
  const oldest = times[times.length - 1];
  const sampleSpanSec = times[0] - oldest;
  /** @type {number[]} */
  const intervalsSec = [];
  for (let i = 0; i < Math.min(times.length - 1, 20); i++) {
    intervalsSec.push(times[i] - times[i + 1]);
  }
  return {
    hasTimestamps: true,
    sampleSpanSeconds: sampleSpanSec,
    secondsFromNewestTxToNow: newestToNowSec,
    intervalsBetweenConsecutiveSamplesSec: intervalsSec,
  };
}
