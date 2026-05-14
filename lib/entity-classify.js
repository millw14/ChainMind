/** Mainnet USDC mint — cited often when the watch target is a liquid token. */
export const USDC_MAINNET_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * Context for labeling base58 entities from a dashboard evidence snapshot.
 * @param {Record<string, any> | null} snapshot
 */
export function buildEntityClassificationContext(snapshot) {
  const scope = typeof snapshot?.address === "string" ? snapshot.address.trim() : "";
  const scopeHint = typeof snapshot?.scopeHumanHint === "string" ? snapshot.scopeHumanHint.trim() : null;

  /** @type {Map<string, number>} */
  const feePayerEvents = new Map();
  if (Array.isArray(snapshot?.walletAges)) {
    for (const w of snapshot.walletAges) {
      if (w?.address) feePayerEvents.set(String(w.address), Number(w.feePayerEventsInLookback) || 0);
    }
  }

  /** @type {Map<string, { failed: boolean }>} */
  const sigMeta = new Map();
  if (Array.isArray(snapshot?.signatures)) {
    for (const s of snapshot.signatures) {
      if (s?.signature) sigMeta.set(String(s.signature), { failed: Boolean(s.failed) });
    }
  }

  /** @type {Set<string>} */
  const programs = new Set();
  if (Array.isArray(snapshot?.topPrograms)) {
    for (const p of snapshot.topPrograms) {
      if (p?.program) programs.add(String(p.program));
    }
  }

  /** @type {Set<string>} */
  const topFeePayerAddresses = new Set();
  if (Array.isArray(snapshot?.walletAges) && snapshot.walletAges.length > 0) {
    const ranked = [...snapshot.walletAges]
      .filter((w) => w?.address)
      .sort((a, b) => (Number(b.feePayerEventsInLookback) || 0) - (Number(a.feePayerEventsInLookback) || 0));
    for (const w of ranked.slice(0, 3)) {
      topFeePayerAddresses.add(String(w.address));
    }
  }

  return { scope, scopeHint, feePayerEvents, sigMeta, programs, topFeePayerAddresses };
}

function shortenId(s) {
  if (!s || typeof s !== "string") return "—";
  if (s.length <= 14) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

/**
 * Classify a single base58 id (full address or signature).
 * @param {string} id
 * @param {ReturnType<typeof buildEntityClassificationContext>} ctx
 */
export function classifyEntityId(id, ctx) {
  if (!id || !ctx) {
    return { shortId: id || "—", role: "Unknown reference", fullId: id || "" };
  }
  const fullId = String(id).trim();

  if (fullId === ctx.scope) {
    const hint = ctx.scopeHint ? ` (${ctx.scopeHint})` : "";
    return { shortId: shortenId(fullId), role: `Scope / watch target${hint}`, fullId };
  }
  if (fullId === USDC_MAINNET_MINT) {
    return { shortId: shortenId(fullId), role: "USDC mint (mainnet)", fullId };
  }
  if (ctx.feePayerEvents.has(fullId)) {
    const ev = ctx.feePayerEvents.get(fullId) || 0;
    const top = ctx.topFeePayerAddresses?.has(fullId);
    return {
      shortId: shortenId(fullId),
      role: top
        ? `Suspicious fee payer — top co-activity in window (${ev} events)`
        : `Co-active fee payer (${ev} events in ingest window)`,
      fullId,
    };
  }
  if (ctx.sigMeta.has(fullId)) {
    const failed = ctx.sigMeta.get(fullId)?.failed;
    return {
      shortId: shortenId(fullId),
      role: failed ? "Failed tx signature" : "Recent tx signature (sample)",
      fullId,
    };
  }
  if (fullId.length >= 32 && fullId.length <= 44 && ctx.programs.has(fullId)) {
    return { shortId: shortenId(fullId), role: "Program ID (high activity in window)", fullId };
  }
  if (fullId.length >= 80) {
    return { shortId: shortenId(fullId), role: "Transaction signature (not matched to sample)", fullId };
  }
  if (fullId.length >= 32) {
    return { shortId: shortenId(fullId), role: "Wallet-like address (not in ingest top payers)", fullId };
  }
  return { shortId: fullId, role: "Reference", fullId };
}

const B58 = /[1-9A-HJ-NP-Za-km-z]{32,88}/g;

/**
 * Pull ids from a Groq named_entities line and classify (uses longest match first).
 * @param {string} line
 * @param {ReturnType<typeof buildEntityClassificationContext>} ctx
 */
export function classifyNamedEntityLine(line, ctx) {
  const raw = String(line ?? "").trim();
  if (!raw) {
    return { raw, rows: [] };
  }
  const matches = [...raw.matchAll(B58)].map((m) => m[0]);
  /** @type {{ shortId: string, role: string, fullId: string }[]} */
  const rows = [];
  const seen = new Set();
  for (const id of matches.sort((a, b) => b.length - a.length)) {
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push(classifyEntityId(id, ctx));
  }
  return { raw, rows };
}
