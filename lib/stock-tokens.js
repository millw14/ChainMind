import { getAddress, getToken, getTokens, searchChain } from "./blockscout.js";
import { sanitizeLabel } from "./ask-evidence.js";
import stockRegistry from "../config/stock-tokens.json" with { type: "json" };

/**
 * The tokenized-equity registry for Robinhood Chain.
 *
 * Robinhood's equity tokens are ordinary ERC-20s named like
 * "NVIDIA • Robinhood Token" (NVDA). That NAME IS NOT PROOF OF ANYTHING:
 * 0x465834D5…CA492 is a live contract whose name and symbol are byte-identical
 * to the real NVDA token, and holder counts are cheap to inflate by airdrop on
 * an L2, so neither the suffix nor "it has more holders" can be the authority.
 *
 * The authority is the DEPLOYER. All 94 genuine equity tokens were deployed by
 * a single issuer address, which cannot be forged by anyone who does not hold
 * its key. config/stock-tokens.json snapshots that issuer plus the 94 verified
 * contract addresses; anything outside the snapshot is confirmed against the
 * issuer live before it is ever called official.
 *
 * Server-side only: no React, all chain data comes from lib/blockscout.js.
 */

/** Deployer of every genuine Robinhood equity token — the root of trust. */
export const CANONICAL_ISSUER = String(stockRegistry.issuer).toLowerCase();

/** Snapshot of verified contract addresses, lowercased for comparison. */
const CANONICAL_ADDRESSES = new Set(
  (stockRegistry.tokens ?? []).map((t) => String(t.address).toLowerCase()),
);

/** True when the address is a snapshotted, issuer-verified equity token. */
export function isCanonicalStockAddress(address) {
  return CANONICAL_ADDRESSES.has(String(address ?? "").toLowerCase());
}

/**
 * Confirm a contract was deployed by the canonical issuer. Used for tokens
 * listed after the snapshot was taken, so a new genuine listing is not called
 * an impostor. Fails closed: any lookup error returns false.
 * @param {string} address
 */
export async function verifiedByIssuer(address) {
  if (isCanonicalStockAddress(address)) return true;
  try {
    const info = await getAddress(address);
    return String(info?.creator_address_hash ?? "").toLowerCase() === CANONICAL_ISSUER;
  } catch {
    return false;
  }
}

/**
 * Tolerates the plain "*" bullet (some clients transliterate U+2022) and any
 * amount of surrounding whitespace, because the separator is the one part of
 * the convention that survives copy/paste badly.
 */
const STOCK_SUFFIX_RE = /\s*[•*]\s*Robinhood\s+Token\s*$/i;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Safety bound on the page-walk: a runaway cursor must not walk forever. */
const MAX_PAGES = 10;
const MAX_TOKENS = 500;

const DEFAULT_TTL_MS = 300_000;

/** True when a token name carries the official " • Robinhood Token" suffix. */
export function isStockTokenName(name) {
  if (typeof name !== "string") return false;
  return STOCK_SUFFIX_RE.test(name);
}

/** "NVIDIA • Robinhood Token" -> "NVIDIA". Non-stock names pass through. */
export function stripStockSuffix(name) {
  if (typeof name !== "string") return "";
  return name.replace(STOCK_SUFFIX_RE, "").trim();
}

/**
 * Split a user query into the forms the matchers need. Traders type "$NVDA",
 * "nvda" and "NVDA " interchangeably, and a stray "$" would otherwise make an
 * exact symbol compare fail and drop the caller into the impostor-prone search
 * fallback.
 *
 * @param {unknown} raw
 * @returns {{ raw: string, symbol: string, lower: string }}
 */
export function normalizeQuery(raw) {
  const flat = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\$+/, "")
    .trim();
  return { raw: flat, symbol: flat.toUpperCase(), lower: flat.toLowerCase() };
}

/**
 * Rank one candidate against a normalized query. Higher wins; 0 means "not a
 * match at all". The tiers exist so that an exact symbol always outranks a
 * lookalike that merely starts with it — NVDACAT must never beat NVDA.
 */
function scoreCandidate(candidate, q) {
  if (!candidate) return 0;
  const symbol = String(candidate.symbol ?? "").trim().toUpperCase();
  const company = String(candidate.company ?? "").trim().toLowerCase();
  const name = String(candidate.name ?? "").trim().toLowerCase();

  if (symbol && symbol === q.symbol) return 100;
  if (company && company === q.lower) return 90;
  if (name && name === q.lower) return 85;
  // Prefix matches need at least two characters; one letter matches half the
  // market and turns the ranking into a coin flip.
  if (company && q.lower.length >= 2 && company.startsWith(q.lower)) return 70;
  if (symbol && q.symbol.length >= 2 && symbol.startsWith(q.symbol)) return 50;
  if (q.lower.length >= 3 && (company.includes(q.lower) || name.includes(q.lower))) return 30;
  return 0;
}

/**
 * Descending compare that keeps unknowns last instead of poisoning the sort.
 * Plain `b - a` on two nulls yields NaN, which leaves the order undefined.
 */
function numDesc(a, b) {
  const x = Number.isFinite(a) ? a : -Infinity;
  const y = Number.isFinite(b) ? b : -Infinity;
  if (x === y) return 0;
  return y > x ? 1 : -1;
}

/**
 * Best candidate for a query, or null. Pure — no upstream calls — so the whole
 * ranking policy is unit-testable offline.
 *
 * @param {Array<object>} candidates
 * @param {string} query
 * @returns {object | null}
 */
export function pickBestMatch(candidates, query) {
  const q = normalizeQuery(query);
  if (!q.raw || !Array.isArray(candidates)) return null;

  let best = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, q);
    if (!score) continue;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
      continue;
    }
    // Equal relevance: prefer the contract more people actually hold, then the
    // bigger book. A scam clone is usually the thinner of the two.
    if (score === bestScore && best) {
      const byHolders = numDesc(best.holders, candidate.holders);
      if (byHolders > 0 || (byHolders === 0 && numDesc(best.marketCap, candidate.marketCap) > 0)) {
        best = candidate;
      }
    }
  }
  return best;
}

/* --------------------------- shaping --------------------------- */

function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Lowercased 0x address, or null when the field isn't an address at all. */
function normalizeAddress(v) {
  const s = String(v ?? "").trim();
  return ADDRESS_RE.test(s) ? s.toLowerCase() : null;
}

/**
 * Map a Blockscout token record onto the StockToken shape. Blockscout sends
 * every number as a string, so each one is coerced once here — callers get
 * Numbers or null and never a NaN they have to defend against.
 *
 * Names and symbols are attacker-controlled (anyone can mint a token whose
 * name is an instruction paragraph), so they go through sanitizeLabel before
 * anything renders or prompts with them. The suffix test runs on the raw name
 * first: sanitizeLabel truncates, and a long ETF name would lose its suffix.
 */
function makeToken(raw, address, rawName) {
  return {
    address,
    symbol: sanitizeLabel(raw.symbol, 16),
    name: sanitizeLabel(rawName, 72),
    company: sanitizeLabel(stripStockSuffix(rawName), 48) ?? sanitizeLabel(raw.symbol, 16),
    price: toNum(raw.exchange_rate),
    marketCap: toNum(raw.circulating_market_cap ?? raw.market_cap),
    volume24h: toNum(raw.volume_24h),
    holders: toNum(raw.holders_count ?? raw.holders),
    decimals: toNum(raw.decimals),
    type: raw.type ?? raw.token_type ?? null,
  };
}

/** A token-list / search row -> StockToken, or null when it isn't usable. */
function toToken(raw, { officialOnly = false } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const address = normalizeAddress(raw.address_hash ?? raw.address);
  const rawName = typeof raw.name === "string" ? raw.name : null;
  if (!address || !rawName) return null;
  if (officialOnly && !isStockTokenName(rawName)) return null;
  return makeToken(raw, address, rawName);
}

/** The narrow shape used for scam warnings — enough to identify, not to trade. */
function toImpostor(token) {
  return {
    address: token.address,
    symbol: token.symbol,
    name: token.name,
    holders: token.holders,
  };
}

function sameSymbol(a, b) {
  if (!a || !b) return false;
  return String(a).trim().toUpperCase() === String(b).trim().toUpperCase();
}

/* --------------------------- listing --------------------------- */

/**
 * Cursor params for the next page. Blockscout echoes its own cursor back as
 * `next_page_params`; nulls in it would stringify to the literal "null" and
 * poison the query, so they're dropped.
 */
function pageParams(next) {
  if (!next || typeof next !== "object") return null;
  const out = {};
  for (const [key, value] of Object.entries(next)) {
    if (value == null) continue;
    out[key] = String(value);
  }
  return Object.keys(out).length ? out : null;
}

function sameParams(a, b) {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a[k] === b[k]);
}

/**
 * Walk /tokens and keep the official equity tokens. Never throws: a page that
 * fails ends the walk and flips `partial`, because half a list plus an honest
 * "this is incomplete" beats an exception that takes the whole page down.
 */
async function walkTokenPages() {
  const tokens = [];
  const seen = new Set();
  let params = {};
  let scanned = 0;
  let partial = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    let body;
    try {
      body = await getTokens(params);
    } catch {
      partial = true;
      break;
    }

    const items = Array.isArray(body?.items) ? body.items : [];
    if (!items.length) break;

    for (const item of items) {
      scanned += 1;
      const token = toToken(item, { officialOnly: true });
      // Dedupe on address: a cursor that overlaps pages would otherwise list
      // the same equity twice.
      if (!token || seen.has(token.address)) continue;
      seen.add(token.address);
      tokens.push(token);
    }

    const next = pageParams(body.next_page_params);
    if (!next) break;
    if (scanned >= MAX_TOKENS || page === MAX_PAGES - 1) {
      // Stopped on the safety bound with more pages upstream: the list is a
      // prefix of the truth, so say so rather than implying completeness.
      partial = true;
      break;
    }
    // A cursor that repeats itself is an upstream bug; walking it loops forever.
    if (sameParams(next, params)) break;
    params = next;
  }

  tokens.sort((a, b) => numDesc(a.marketCap, b.marketCap) || numDesc(a.holders, b.holders));
  return { tokens, partial };
}

/**
 * In-memory, per-instance cache. Serverless spreads requests over many
 * instances, so this is a burst absorber and nothing more — never a source of
 * truth across deploys or regions.
 */
let cache = { at: 0, tokens: null };

/** Shared page-walk so a burst of callers triggers one upstream traversal. */
let inFlight = null;

function ttlMs() {
  const raw = toNum(process.env.STOCK_CACHE_TTL_MS);
  return raw != null && raw >= 0 ? raw : DEFAULT_TTL_MS;
}

/** Attach `partial` without making it part of the array's own iteration/JSON. */
function withPartial(tokens, partial) {
  Object.defineProperty(tokens, "partial", { value: partial, enumerable: false });
  return tokens;
}

async function refresh() {
  const { tokens, partial } = await walkTokenPages();

  // An empty partial result means the indexer was down, not that Robinhood
  // delisted 94 equities. Keep whatever we had and don't cache the hole —
  // otherwise one brownout blanks the app for a full TTL.
  if (partial && tokens.length === 0) {
    return cache.tokens ?? withPartial(tokens, true);
  }

  cache = { at: Date.now(), tokens: withPartial(tokens, partial) };
  return cache.tokens;
}

/**
 * Every official Robinhood equity/ETF token, biggest first.
 *
 * @param {{ force?: boolean }} [options] - force skips the cache
 * @returns {Promise<Array<object>>} StockToken[] (carries a non-enumerable
 *   `partial` flag when the walk was cut short)
 */
export async function listStockTokens({ force = false } = {}) {
  if (!force && cache.tokens && Date.now() - cache.at < ttlMs()) return cache.tokens;
  if (!force && inFlight) return inFlight;

  const run = refresh().finally(() => {
    if (inFlight === run) inFlight = null;
  });
  inFlight = run;
  return run;
}

/* --------------------------- resolving --------------------------- */

/** Explorer search -> StockToken[]. Best-effort: search is a nicety, not a dep. */
async function searchCandidates(query) {
  try {
    const body = await searchChain(query);
    const items = Array.isArray(body?.items) ? body.items : [];
    return items.map((item) => toToken(item)).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Other contracts wearing the same symbol as the resolved match. This is the
 * whole point of the module: NVDA resolves to Robinhood's contract, and the
 * two unrelated NVDA contracts on the same chain get named, not hidden.
 */
function findImpostors(candidates, symbol, address) {
  return candidates
    .filter((c) => c.address !== address && sameSymbol(c.symbol, symbol))
    .map(toImpostor);
}

/**
 * Resolve a ticker, company name or "$SYMBOL" to a token on Robinhood Chain.
 *
 * The official list is tried first, so `official: true` means "this is the
 * contract Robinhood issued". Only when nothing official matches does it fall
 * back to explorer search, and that result is flagged `official: false` —
 * callers must not present the two the same way.
 *
 * @param {string} query
 * @returns {Promise<{ ok: boolean, query: string, match: object|null, official: boolean, impostors: Array<object>, reason?: string }>}
 */
export async function resolveSymbol(query) {
  const q = normalizeQuery(query);
  const miss = { ok: false, query: q.raw, match: null, official: false, impostors: [] };
  if (!q.raw) return { ...miss, reason: "Empty query." };

  const official = await listStockTokens();
  const match = pickBestMatch(official, q.raw);

  if (match) {
    const candidates = await searchCandidates(match.symbol ?? q.raw);
    // The name suffix only got it into the list; the deployer decides whether
    // it is genuinely Robinhood's. A byte-identical clone fails here.
    const isOfficial = await verifiedByIssuer(match.address);
    return {
      ok: true,
      query: q.raw,
      match,
      official: isOfficial,
      impostors: findImpostors(candidates, match.symbol, match.address),
      ...(isOfficial
        ? {}
        : {
            reason:
              "This contract copies the official naming convention but was not deployed by Robinhood's issuer — treat it as unverified.",
          }),
    };
  }

  // Nothing official. Search the explorer, but exclude the official set from
  // the candidate pool so a near-miss there can't be re-labelled unofficial.
  const candidates = await searchCandidates(q.raw);
  const officialAddresses = new Set(official.map((t) => t.address));
  const outsiders = candidates.filter((c) => !officialAddresses.has(c.address));
  const best = pickBestMatch(outsiders, q.raw);
  if (!best) {
    return { ...miss, reason: `No token matching "${q.raw}" was found on Robinhood Chain.` };
  }

  return {
    ok: true,
    query: q.raw,
    match: best,
    official: false,
    impostors: findImpostors(candidates, best.symbol, best.address),
    reason: "Not an official Robinhood tokenized equity — treat this contract as unverified.",
  };
}

/**
 * Look up one token by 0x address or by symbol/company name.
 *
 * @param {string} x
 * @returns {Promise<object|null>} StockToken, or null when nothing resolves
 */
export async function getStockBySymbolOrAddress(x) {
  const q = normalizeQuery(x);
  if (!q.raw) return null;

  if (ADDRESS_RE.test(q.raw)) {
    const address = q.raw.toLowerCase();
    const list = await listStockTokens();
    const hit = list.find((t) => t.address === address);
    if (hit) return hit;
    // Not an equity token (or the walk was truncated) — ask the indexer
    // directly rather than reporting a real contract as nonexistent.
    try {
      const raw = await getToken(q.raw);
      const rawName = typeof raw?.name === "string" ? raw.name : null;
      if (!rawName) return null;
      return makeToken(raw, address, rawName);
    } catch {
      return null;
    }
  }

  const resolved = await resolveSymbol(q.raw);
  return resolved.ok ? resolved.match : null;
}
