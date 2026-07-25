import { getAddress } from "./blockscout.js";
import {
  CANONICAL_ISSUER,
  getStockBySymbolOrAddress,
  isCanonicalStockAddress,
  isStockTokenName,
  listStockTokens,
  normalizeQuery,
  resolveSymbol,
} from "./stock-tokens.js";
import { sanitizeLabel } from "./ask-evidence.js";
import stockRegistry from "../config/stock-tokens.json" with { type: "json" };

/**
 * Evidence for questions that name no single target.
 *
 * lib/ask-evidence.js answers "tell me about X" — it needs an X. Most of what
 * people actually ask a chain explorer has no X in it: "what are the top stocks
 * by market cap", "what's trending", "compare NVDA and TSLA", "is this token
 * safe". Those are market-shaped questions, and this module gathers the facts
 * for them off the same sources: lib/stock-tokens.js for the equity registry,
 * lib/blockscout.js for anything read live off Robinhood Chain.
 *
 * Two rules run through every function here:
 *
 *  1. Missing data is reported as missing. A null market cap is never summed as
 *     zero, never sorted as zero, and never ranked #1 in an ascending sort. The
 *     aggregates say how many entries they could not count.
 *  2. Nothing throws. A route that gets `{ ok: false, error }` can tell the user
 *     the truth; a route that gets an exception can only 500 at them.
 *
 * safetyReport is the safety-critical one: it answers "is this the real NVDA?",
 * and the answer is decided by the DEPLOYER, never by the name. It fails closed —
 * anything it could not check comes back "unknown_token", never "official".
 *
 * Server-side only: no React.
 */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Ranking bound. 25 rows is already more than any answer quotes. */
const MAX_LIMIT = 25;

/** How many targets one comparison may hold before it stops being a comparison. */
const MAX_COMPARE = 4;

/** Rows per list in the overview, and impostors named in a safety report. */
const TOP_N = 5;

/** Snapshot lookups, so "the genuine NVDA is 0x…" survives an indexer outage. */
const SNAPSHOT_BY_SYMBOL = new Map(
  (stockRegistry.tokens ?? []).map((t) => [String(t.symbol).toUpperCase(), t]),
);

/** The same snapshot keyed by contract, so a verdict survives an outage too. */
const SNAPSHOT_BY_ADDRESS = new Map(
  (stockRegistry.tokens ?? []).map((t) => [String(t.address).toLowerCase(), t]),
);

const SNAPSHOT_COUNT = (stockRegistry.tokens ?? []).length;

/* ----------------------------- pure helpers ----------------------------- */
/* Exported for test/market-evidence.test.mjs: the sort, the aggregation and
   the comparison cap are where the honesty rules actually live, and they must
   be testable without touching the network. */

/** Sortable fields of a StockToken, keyed by what a user is likely to type. */
const METRIC_ALIASES = new Map([
  ["marketcap", "marketCap"],
  ["cap", "marketCap"],
  ["size", "marketCap"],
  ["value", "marketCap"],
  ["holders", "holders"],
  ["holder", "holders"],
  ["owners", "holders"],
  ["volume", "volume24h"],
  ["volume24h", "volume24h"],
  ["24hvolume", "volume24h"],
  ["activity", "volume24h"],
  ["price", "price"],
]);

/** The metrics a ranking may sort on. */
export const RANKABLE_METRICS = ["marketCap", "holders", "volume24h", "price"];

/**
 * Map a caller's metric onto a StockToken field, defaulting to market cap.
 * Punctuation is dropped first so "market_cap", "market cap" and "marketCap"
 * are one key rather than three misses that each silently fall back.
 */
export function resolveMetric(raw) {
  const key = String(raw ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return METRIC_ALIASES.get(key) ?? "marketCap";
}

/** "asc" only when the caller clearly asked for the small end. */
export function resolveDirection(raw) {
  const key = String(raw ?? "").toLowerCase().trim();
  const ascending = ["asc", "ascending", "up", "lowest", "smallest", "bottom", "least", "worst"];
  return ascending.includes(key) ? "asc" : "desc";
}

/** Row count for a ranking, clamped to 1..25. Junk falls back to 10. */
export function clampLimit(limit, fallback = 10) {
  const n = Math.trunc(Number(limit));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

/** A finite Number, or null. Blockscout's "" and "N/A" must not become NaN. */
function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Comparator over one metric that keeps unknowns last in BOTH directions.
 *
 * This is the whole reason the sort is its own function. The obvious
 * `(a, b) => a[metric] - b[metric]` returns NaN for a token whose market cap
 * the indexer never priced, which leaves the order undefined; and the obvious
 * "treat null as 0" fix puts every unpriced token at the top of a "smallest
 * first" list, so ChainMind would answer "the smallest tokenized equity is X"
 * about a token whose size it does not know. Unknown is not small.
 *
 * Ties break on symbol then address so two runs over the same set — in either
 * input order — produce the same ranking.
 */
export function compareByMetric(metric = "marketCap", direction = "desc") {
  const field = resolveMetric(metric);
  // -1 keeps the smaller value in front, which is what "asc" means.
  const sign = resolveDirection(direction) === "asc" ? -1 : 1;
  return (a, b) => {
    const x = numOrNull(a?.[field]);
    const y = numOrNull(b?.[field]);
    if (x === null && y === null) return tieBreak(a, b);
    if (x === null) return 1;
    if (y === null) return -1;
    if (x === y) return tieBreak(a, b);
    return x < y ? sign : -sign;
  };
}

function tieBreak(a, b) {
  const as = String(a?.symbol ?? "");
  const bs = String(b?.symbol ?? "");
  if (as !== bs) return as < bs ? -1 : 1;
  const aa = String(a?.address ?? "");
  const ba = String(b?.address ?? "");
  if (aa === ba) return 0;
  return aa < ba ? -1 : 1;
}

/** Sorted copy — the cached registry array must never be reordered in place. */
export function sortByMetric(list, metric = "marketCap", direction = "desc") {
  const items = (Array.isArray(list) ? list : []).filter((t) => t && typeof t === "object");
  return items.sort(compareByMetric(metric, direction));
}

/** One ranked row: identity plus the four numbers every market answer quotes. */
export function toRow(token, index) {
  return {
    rank: index + 1,
    symbol: token?.symbol ?? null,
    company: token?.company ?? null,
    address: token?.address ?? null,
    price: numOrNull(token?.price),
    marketCap: numOrNull(token?.marketCap),
    holders: numOrNull(token?.holders),
    volume24h: numOrNull(token?.volume24h),
  };
}

/** Pure core of rankStocks: registry in, ranked rows out. */
export function buildRanking(list, { metric = "marketCap", direction = "desc", limit = 10 } = {}) {
  const field = resolveMetric(metric);
  const dir = resolveDirection(direction);
  const rows = sortByMetric(list, field, dir).slice(0, clampLimit(limit)).map(toRow);
  return { metric: field, direction: dir, count: rows.length, rows };
}

/**
 * Sum market caps and holder counts across the registry, counting only the
 * entries that actually carry a number and reporting how many did not.
 *
 * "$4.1B across 94 stocks" when 11 of them were unpriced is a fabricated total.
 * The missing counts let the answer say "across the 83 with a published market
 * cap", and an all-null field totals to null rather than a confident $0.
 */
export function aggregateTotals(list) {
  const items = Array.isArray(list) ? list : [];
  let capSum = 0;
  let capCount = 0;
  let holderSum = 0;
  let holderCount = 0;

  for (const token of items) {
    const cap = numOrNull(token?.marketCap);
    if (cap !== null) {
      capSum += cap;
      capCount += 1;
    }
    const holders = numOrNull(token?.holders);
    if (holders !== null) {
      holderSum += holders;
      holderCount += 1;
    }
  }

  return {
    combinedMarketCap: capCount ? Math.round(capSum * 100) / 100 : null,
    totalHolders: holderCount ? holderSum : null,
    countedMarketCap: capCount,
    countedHolders: holderCount,
    missingMarketCap: items.length - capCount,
    missingHolders: items.length - holderCount,
  };
}

/** Pure core of marketOverview. */
export function buildOverview(list) {
  const items = (Array.isArray(list) ? list : []).filter((t) => t && typeof t === "object");
  const top = (metric) => sortByMetric(items, metric, "desc").slice(0, TOP_N).map(toRow);
  return {
    totalStockTokens: items.length,
    topByMarketCap: top("marketCap"),
    topByHolders: top("holders"),
    mostActive24h: top("volume24h"),
    aggregate: aggregateTotals(items),
  };
}

/**
 * Normalize, de-duplicate and cap a comparison request.
 *
 * The cap is silent failure waiting to happen — someone asks about six tickers,
 * four come back, and the answer reads as if six were considered. So the dropped
 * ones are returned and named in a note the model can repeat verbatim.
 */
export function capQueries(queries, max = MAX_COMPARE) {
  const raw = Array.isArray(queries) ? queries : [queries];
  const seen = new Set();
  const unique = [];
  for (const entry of raw) {
    const q = normalizeQuery(entry).raw;
    if (!q) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(q);
  }

  const kept = unique.slice(0, max);
  const dropped = unique.slice(max);
  return {
    kept,
    dropped,
    truncated: dropped.length > 0,
    note: dropped.length
      ? `Only the first ${max} targets were compared; ${dropped.join(", ")} ${dropped.length === 1 ? "was" : "were"} left out.`
      : null,
  };
}

/* ----------------------------- shared plumbing ----------------------------- */

function nowIso() {
  return new Date().toISOString();
}

function lowerOrNull(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return ADDRESS_RE.test(s) ? s : null;
}

/** One short sentence for the caller, with the upstream status when there is one. */
function failure(e, what) {
  const status = e?.status ?? null;
  return {
    ok: false,
    error: `${what}${status ? ` (HTTP ${status})` : ""}. Try again shortly.`,
  };
}

/**
 * The registry, or null when the walk came back empty.
 *
 * Empty is never a fact: 94 equities are live, so zero rows means the indexer
 * did not answer. Ranking or averaging that hole would publish "there are no
 * tokenized stocks on Robinhood Chain", which is false.
 */
async function registry() {
  const list = await listStockTokens();
  return Array.isArray(list) && list.length ? list : null;
}

/** The `partial` flag listStockTokens hangs off the array, when it is set. */
function partialFlag(list) {
  return list?.partial ? { partial: true } : {};
}

/* ------------------------------- rankings ------------------------------- */

/**
 * Rank the tokenized equities by one metric — the evidence behind "what are the
 * top stocks by market cap" and "which one has the most holders".
 *
 * @param {{ metric?: string, direction?: string, limit?: number }} [options]
 * @returns {Promise<{ ok: boolean, kind?: string, evidence?: object, error?: string }>}
 */
export async function rankStocks({ metric = "marketCap", direction = "desc", limit = 10 } = {}) {
  try {
    const list = await registry();
    if (!list) {
      return {
        ok: false,
        error:
          "The Robinhood Chain indexer did not return the tokenized-equity list, so nothing can be ranked right now. Try again shortly.",
      };
    }
    return {
      ok: true,
      kind: "ranking",
      evidence: {
        ...buildRanking(list, { metric, direction, limit }),
        asOf: nowIso(),
        // Says the ranking is over a prefix of the market, not all of it.
        ...partialFlag(list),
      },
    };
  } catch (e) {
    return failure(e, "The tokenized-equity list could not be read");
  }
}

/**
 * A whole-market snapshot — the evidence behind "what's trending on Robinhood
 * Chain" and any question that names no ticker at all.
 *
 * @returns {Promise<{ ok: boolean, kind?: string, evidence?: object, error?: string }>}
 */
export async function marketOverview() {
  try {
    const list = await registry();
    if (!list) {
      return {
        ok: false,
        error:
          "The Robinhood Chain indexer did not return the tokenized-equity list, so the market overview is unavailable. Try again shortly.",
      };
    }
    return {
      ok: true,
      kind: "overview",
      evidence: { ...buildOverview(list), asOf: nowIso(), ...partialFlag(list) },
    };
  } catch (e) {
    return failure(e, "The market overview could not be built");
  }
}

/* ------------------------------ comparison ------------------------------ */

/** The comparison row for one target, with every number defaulting to unknown. */
function comparisonBase(query) {
  return {
    query,
    resolved: false,
    symbol: null,
    company: null,
    address: null,
    price: null,
    marketCap: null,
    holders: null,
    volume24h: null,
    official: false,
    // null, not 0: "no impostors" is a claim we have not earned on this path.
    impostorCount: null,
  };
}

function filled(query, token, { official, impostorCount }) {
  return {
    query,
    resolved: true,
    symbol: token.symbol ?? null,
    company: token.company ?? null,
    address: token.address ?? null,
    price: numOrNull(token.price),
    marketCap: numOrNull(token.marketCap),
    holders: numOrNull(token.holders),
    volume24h: numOrNull(token.volume24h),
    official: Boolean(official),
    impostorCount,
  };
}

/**
 * Resolve one comparison target. Never rejects: a target that cannot be found
 * has to stay in the array — dropping it is how "compare NVDA and TSLA" quietly
 * became a one-token answer in the first place.
 */
async function compareOne(query) {
  const base = comparisonBase(query);
  try {
    if (ADDRESS_RE.test(query)) {
      const token = await getStockBySymbolOrAddress(query);
      if (!token) {
        return {
          ...base,
          reason: await unresolvedReason(query, `No contract at ${query} was found on Robinhood Chain.`),
        };
      }
      // Address path: the snapshot settles it offline, otherwise ask the chain.
      const official = isCanonicalStockAddress(token.address) || (await deployedByIssuer(token.address));
      return filled(query, token, { official, impostorCount: null });
    }

    const resolved = await resolveSymbol(query);
    if (!resolved?.ok || !resolved.match) {
      return {
        ...base,
        reason: await unresolvedReason(
          query,
          resolved?.reason ?? `No token matching "${query}" was found on Robinhood Chain.`,
        ),
      };
    }
    const impostors = Array.isArray(resolved.impostors) ? resolved.impostors : [];
    return filled(query, resolved.match, {
      official: resolved.official,
      impostorCount: impostors.length,
    });
  } catch (e) {
    const status = e?.status ? ` (HTTP ${e.status})` : "";
    return { ...base, reason: `"${query}" could not be looked up${status}.` };
  }
}

/**
 * Why a target did not resolve. An unreachable indexer must not be reported as
 * "no such token": absence is a claim about the chain, and we did not look.
 */
async function unresolvedReason(query, fallback) {
  try {
    if (await registry()) return fallback;
  } catch {
    /* fall through to the honest version */
  }
  return `The Robinhood Chain indexer did not answer, so "${query}" could not be looked up — unknown, not absent.`;
}

/** True only when the indexer names the canonical issuer as deployer. */
async function deployedByIssuer(address) {
  try {
    const info = await getAddress(address);
    return lowerOrNull(info?.creator_address_hash) === CANONICAL_ISSUER;
  } catch {
    return false;
  }
}

/**
 * Side-by-side evidence for two to four targets — "compare NVDA and TSLA",
 * which previously resolved only the first ticker and answered about it alone.
 *
 * Unresolvable entries stay in `items` with `resolved: false` and a reason, so
 * the answer can say which one it could not find instead of comparing fewer
 * things than it was asked about.
 *
 * @param {Array<string>|string} queries - tickers and/or 0x addresses
 * @returns {Promise<{ ok: boolean, kind?: string, evidence?: object, error?: string }>}
 */
export async function compareTargets(queries) {
  const capped = capQueries(queries);
  if (!capped.kept.length) {
    return { ok: false, error: "Nothing to compare: name at least one ticker or 0x address." };
  }

  try {
    const items = await Promise.all(capped.kept.map((q) => compareOne(q)));

    const notes = [];
    if (capped.note) notes.push(capped.note);

    const missing = items.filter((i) => !i.resolved);
    if (missing.length) {
      notes.push(
        `${missing.length} of ${items.length} targets could not be resolved on Robinhood Chain: ${missing.map((i) => i.query).join(", ")}.`,
      );
    }
    const unofficial = items.filter((i) => i.resolved && !i.official);
    if (unofficial.length) {
      notes.push(
        `Not an official Robinhood tokenized equity: ${unofficial.map((i) => i.symbol ?? i.query).join(", ")}.`,
      );
    }

    return {
      ok: true,
      kind: "comparison",
      evidence: { items, notes: notes.length ? notes.join(" ") : null, asOf: nowIso() },
    };
  } catch (e) {
    return failure(e, "The comparison could not be completed");
  }
}

/* -------------------------------- safety -------------------------------- */

/**
 * Split a collision list into the few worth naming and how many there are. The
 * count has to come from the full list: "5 other contracts use this ticker"
 * when the search found 19 understates the mess by a factor of four.
 */
export function collisions(impostors, selfAddress) {
  const self = String(selfAddress ?? "").toLowerCase();
  const rows = (Array.isArray(impostors) ? impostors : []).filter(
    (i) => String(i?.address ?? "").toLowerCase() !== self,
  );
  return { rows: rows.slice(0, TOP_N), total: rows.length };
}

/**
 * Other contracts wearing the same ticker, excluding the one being reported on.
 * Best-effort: the explorer search is a nicety, and losing it must not turn a
 * safety check into an error.
 */
async function otherContractsWithSymbol(symbol, selfAddress) {
  if (!symbol) return { rows: [], total: 0 };
  try {
    const resolved = await resolveSymbol(symbol);
    return collisions(resolved?.impostors, selfAddress);
  } catch {
    return { rows: [], total: 0 };
  }
}

/**
 * The genuine contract for a ticker: the offline snapshot first, then the live
 * registry. Snapshot first on purpose — this address is what a warning tells
 * someone to hold instead, so it must not depend on an indexer being up.
 */
export function genuineFor(symbol, list) {
  const key = String(symbol ?? "").trim().toUpperCase();
  if (!key) return null;
  const snap = SNAPSHOT_BY_SYMBOL.get(key);
  if (snap) return { symbol: snap.symbol, company: snap.company, address: String(snap.address).toLowerCase() };
  const live = (Array.isArray(list) ? list : []).find(
    (t) => String(t?.symbol ?? "").toUpperCase() === key,
  );
  return live ? { symbol: live.symbol, company: live.company, address: live.address } : null;
}

function safetyEvidence(fields) {
  return { ok: true, kind: "safety", evidence: fields };
}

/**
 * Answer "is this the real one?" for a ticker or a contract address.
 *
 * The name proves nothing. 0x465834D5…CA492 is a live contract whose name and
 * symbol are byte-identical to Robinhood's NVDA token, and holder counts are
 * cheap to inflate by airdrop on an L2, so neither the "• Robinhood Token"
 * suffix nor "it has lots of holders" can decide this. The deployer decides:
 * every genuine equity token was deployed by CANONICAL_ISSUER, whose key nobody
 * else holds.
 *
 * Verdicts:
 *   official      — in the verified snapshot, or deployed by the canonical issuer
 *   impostor      — dressed as a Robinhood equity, deployed by someone else
 *   unknown_token — could not be verified, including every lookup failure
 *   not_found     — nothing on Robinhood Chain matches the query at all
 *
 * FAILS CLOSED: an indexer that will not answer produces "unknown_token" with a
 * reason, never "official". Being unhelpful is recoverable; blessing a scam
 * contract is not.
 *
 * @param {string} target - ticker ("NVDA", "$tsla") or 0x contract address
 * @returns {Promise<{ ok: boolean, kind?: string, evidence?: object, error?: string }>}
 */
export async function safetyReport(target) {
  const query = normalizeQuery(target).raw;
  const base = {
    query,
    address: null,
    symbol: null,
    name: null,
    official: false,
    issuer: null,
    expectedIssuer: CANONICAL_ISSUER,
    deployer: null,
    verifiedContract: null,
    holders: null,
    marketCap: null,
    impostors: [],
    impostorCount: 0,
  };

  if (!query) {
    return { ok: false, error: "No token to check: name a ticker (e.g. NVDA) or a 0x contract address." };
  }

  try {
    let list = null;
    try {
      list = await registry();
    } catch {
      list = null;
    }

    let token = null;
    let address = null;
    let sameTicker = { rows: [], total: 0 };

    if (ADDRESS_RE.test(query)) {
      address = query.toLowerCase();
      // May be null: the address can be a wallet or a non-token contract, which
      // is still a perfectly good thing to report on.
      token = await getStockBySymbolOrAddress(address);
      sameTicker = await otherContractsWithSymbol(token?.symbol, address);
    } else {
      const resolved = await resolveSymbol(query);
      if (!resolved?.ok || !resolved.match?.address) {
        // No registry means the indexer never answered — "no such ticker" there
        // would be a confident lie, so it fails closed instead.
        if (!list) {
          return safetyEvidence({
            ...base,
            verdict: "unknown_token",
            reasons: [
              `The Robinhood Chain indexer did not return the tokenized-equity list, so "${query}" could not be verified. Treat it as unverified until it can be checked.`,
            ],
          });
        }
        return safetyEvidence({
          ...base,
          verdict: "not_found",
          reasons: [resolved?.reason ?? `No token matching "${query}" was found on Robinhood Chain.`],
        });
      }
      token = resolved.match;
      address = token.address;
      sameTicker = collisions(resolved.impostors, address);
    }

    // The deciding call. Its failure is tracked rather than swallowed, because
    // "we could not check the deployer" and "the deployer is someone else" are
    // different answers and only one of them is an accusation.
    let addr = null;
    let lookupStatus = null;
    let lookupFailed = false;
    try {
      addr = await getAddress(address);
    } catch (e) {
      lookupFailed = true;
      lookupStatus = e?.status ?? null;
    }

    if (lookupFailed && lookupStatus === 404 && !token) {
      return safetyEvidence({
        ...base,
        address,
        verdict: "not_found",
        reasons: [`Nothing exists at ${address} on Robinhood Chain.`],
      });
    }

    const deployer = lowerOrNull(addr?.creator_address_hash);
    const snapshotted = isCanonicalStockAddress(address);
    const official = snapshotted || (deployer !== null && deployer === CANONICAL_ISSUER);

    // The suffix test runs on the indexer's raw name: sanitizeLabel truncates,
    // and a long ETF name would lose the very suffix being tested for.
    const rawName = typeof addr?.token?.name === "string" ? addr.token.name : null;
    // The snapshot is the last fallback for identity: when the indexer is down,
    // "0xaf3d…f9 is the genuine AAPL" is still a fact we hold locally.
    const snapEntry = SNAPSHOT_BY_ADDRESS.get(address);
    const symbol = token?.symbol ?? sanitizeLabel(addr?.token?.symbol, 16) ?? snapEntry?.symbol ?? null;
    const name = token?.name ?? sanitizeLabel(rawName, 72);
    const genuine = genuineFor(symbol, list);
    // Wearing the costume: the official naming convention, or a ticker that
    // belongs to one of the 94 genuine equities, at a different address.
    const mimics =
      isStockTokenName(rawName) ||
      isStockTokenName(token?.name) ||
      Boolean(genuine && genuine.address !== address);

    const reasons = [];
    let verdict;

    if (official) {
      verdict = "official";
      reasons.push(
        snapshotted
          ? `${address} is one of the ${SNAPSHOT_COUNT} contracts in ChainMind's verified snapshot of Robinhood's tokenized equities.`
          : `${address} was deployed by Robinhood's issuer ${CANONICAL_ISSUER}, which is what makes a tokenized equity genuine.`,
      );
      if (!snapshotted) {
        reasons.push("It was listed after the snapshot was taken, but the deployer matches, so it is genuine.");
      }
      if (sameTicker.total) {
        reasons.push(
          `${sameTicker.total} other contract${sameTicker.total === 1 ? "" : "s"} on Robinhood Chain use the ticker ${symbol ?? "this ticker"}; the official one is ${address}.`,
        );
      }
    } else if (lookupFailed) {
      verdict = "unknown_token";
      reasons.push(
        `The indexer did not answer${lookupStatus ? ` (HTTP ${lookupStatus})` : ""}, so the deployer of ${address} could not be checked. It is not confirmed as official — treat it as unverified.`,
      );
    } else if (!deployer) {
      verdict = "unknown_token";
      reasons.push(
        `No deployer is recorded for ${address}, so it cannot be confirmed as one of Robinhood's tokenized equities. Treat it as unverified.`,
      );
      if (!addr?.token && addr?.is_contract === false) {
        reasons.push("This address is a wallet, not a token contract.");
      }
    } else if (mimics) {
      verdict = "impostor";
      reasons.push(
        `${address} is dressed as a Robinhood tokenized equity but was deployed by ${deployer}, not Robinhood's issuer ${CANONICAL_ISSUER}. The name and symbol are copyable; the deployer is not.`,
      );
    } else {
      verdict = "unknown_token";
      reasons.push(
        `${address} was deployed by ${deployer}, not Robinhood's issuer ${CANONICAL_ISSUER}, and it does not use the official tokenized-equity naming convention. It is some other token, not a Robinhood equity.`,
      );
    }

    // The single most useful sentence for someone holding the wrong contract.
    if (verdict !== "official" && genuine && genuine.address !== address) {
      reasons.push(`The genuine ${genuine.symbol} token is ${genuine.address}.`);
    }

    return safetyEvidence({
      ...base,
      address,
      symbol: symbol ?? null,
      name: name ?? null,
      official,
      // Only ever the canonical issuer: a caller that prints `issuer` can never
      // print an impostor's deployer as though Robinhood had issued it.
      issuer: official ? CANONICAL_ISSUER : null,
      expectedIssuer: CANONICAL_ISSUER,
      deployer,
      verifiedContract: addr?.is_verified ?? null,
      holders: numOrNull(token?.holders ?? addr?.token?.holders ?? addr?.token?.holders_count),
      marketCap: numOrNull(token?.marketCap ?? addr?.token?.circulating_market_cap),
      // The named few, then how many there really are.
      impostors: sameTicker.rows,
      impostorCount: sameTicker.total,
      verdict,
      reasons,
    });
  } catch (e) {
    return failure(e, `"${query}" could not be safety-checked`);
  }
}
