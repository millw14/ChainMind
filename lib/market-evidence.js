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
import { displayNumber } from "./format-number.js";
import { buildTable, col } from "./table-shape.js";
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
 * Map a caller's metric onto a StockToken field, or null when it names none.
 * Punctuation is dropped first so "market_cap", "market cap" and "marketCap"
 * are one key rather than three misses that each silently fall back.
 *
 * Separate from resolveMetric because "unrecognized" and "market cap" are not
 * the same answer for every caller: a ranking defaults to size, while "what is
 * moving" defaults to activity, and neither can pick its own default if the
 * fallback has already been applied. resolveMetric is this plus one default.
 */
export function metricOrNull(raw) {
  const key = String(raw ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return METRIC_ALIASES.get(key) ?? null;
}

/** Map a caller's metric onto a StockToken field, defaulting to market cap. */
export function resolveMetric(raw) {
  return metricOrNull(raw) ?? "marketCap";
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
  return compareByField(resolveMetric(metric), direction);
}

/**
 * The same comparator over ANY numeric field, for rows that are not registry
 * entries — a wallet's holdings by USD value, a token's transfers by amount.
 *
 * Exported so those callers reuse this ordering instead of writing a second one:
 * every hand-rolled `(a, b) => b.x - a.x` in this codebase would be a fresh
 * chance to sort NaN into the middle of a list, or to put "unpriced" at the top
 * of "smallest first" and answer a question about a figure nobody measured.
 * Unknown is not small, in any list.
 *
 * @param {string} field - the numeric property to order on
 * @param {"desc"|"asc"} [direction]
 * @returns {(a: object, b: object) => number}
 */
export function compareByField(field, direction = "desc") {
  const key = String(field ?? "");
  // -1 keeps the smaller value in front, which is what "asc" means.
  const sign = resolveDirection(direction) === "asc" ? -1 : 1;
  return (a, b) => {
    const x = numOrNull(a?.[key]);
    const y = numOrNull(b?.[key]);
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

/**
 * The pre-rendered money/count strings the model copies instead of formatting a
 * raw float itself. It now lives in lib/format-number.js so that
 * lib/ask-evidence.js — the single-target lookup path, which needs exactly the
 * same strings — can import it without closing a second import cycle through
 * this file (see that module's header). Re-exported here because toRow's callers
 * and test/market-evidence.test.mjs already import it from lib/market-evidence.js,
 * and the behaviour is byte-for-byte what it always was.
 */
export { displayNumber };

/** One ranked row: identity plus the four numbers every market answer quotes. */
export function toRow(token, index) {
  const price = numOrNull(token?.price);
  const marketCap = numOrNull(token?.marketCap);
  const holders = numOrNull(token?.holders);
  const volume24h = numOrNull(token?.volume24h);
  return {
    rank: index + 1,
    symbol: token?.symbol ?? null,
    company: token?.company ?? null,
    address: token?.address ?? null,
    price,
    marketCap,
    holders,
    volume24h,
    // Copy these verbatim rather than formatting the raw numbers above.
    display: {
      price: displayNumber(price, "price"),
      marketCap: displayNumber(marketCap, "usd"),
      holders: displayNumber(holders, "count"),
      volume24h: displayNumber(volume24h, "usd"),
    },
  };
}

/** Pure core of rankStocks: registry in, ranked rows out. */
export function buildRanking(list, { metric = "marketCap", direction = "desc", limit = 10 } = {}) {
  const field = resolveMetric(metric);
  const dir = resolveDirection(direction);
  const rows = sortByMetric(list, field, dir).slice(0, clampLimit(limit)).map(toRow);
  return { metric: field, direction: dir, count: rows.length, rows };
}

/** How a metric is named in a table's title. */
const METRIC_WORDS = Object.freeze({
  marketCap: "market cap",
  holders: "holder count",
  volume24h: "24h volume",
  price: "price",
});

/**
 * A ranking, as a table the client can draw and export.
 *
 * The rows exist already — `toRow` built them, and the prose answer reads the same
 * ones — so this is a reshaping rather than a second pass over the registry: no
 * extra call, no extra latency, nothing recomputed. What it adds is FLATNESS.
 * toRow nests its formatted strings under `display`, which lib/table-shape.js
 * forbids in a cell (a nested object renders as "[object Object]" and exports to
 * CSV as garbage), so each display string is lifted onto the row beside the rank
 * and the symbol.
 *
 * The formatted strings are what the columns point at, deliberately. A raw
 * marketCap of 4160789.11 printed verbatim is unreadable in a dense table, and
 * having the renderer format it would put number formatting in two places that
 * could then disagree — displayNumber is already the one place this product
 * decides what a figure looks like.
 *
 * @param {Array<object>} rows - the output of buildRanking().rows
 * @param {string} field - the resolved metric the list is sorted on
 * @param {string} dir - "asc" or "desc"
 * @param {number|null} total - how many equities the registry holds, if known
 * @returns {object} a lib/table-shape.js table
 */
function rankingTable(rows, field, dir, total) {
  const word = METRIC_WORDS[field] ?? field;
  return buildTable({
    id: "ranking",
    title: `${rows.length} tokenized ${rows.length === 1 ? "equity" : "equities"} by ${word}${dir === "asc" ? ", smallest first" : ""}`,
    columns: [
      col("rank", "#", "right"),
      col("symbol", "Ticker"),
      col("company", "Company"),
      col("price", "Price", "right"),
      col("marketCap", "Market cap", "right"),
      col("holders", "Holders", "right"),
      col("volume24h", "24h volume", "right"),
      col("address", "Contract"),
    ],
    rows: rows.map((row) => ({
      rank: row.rank,
      symbol: row.symbol,
      company: row.company,
      price: row.display?.price ?? null,
      marketCap: row.display?.marketCap ?? null,
      holders: row.display?.holders ?? null,
      volume24h: row.display?.volume24h ?? null,
      address: row.address,
    })),
    // How many exist upstream, so "10 of 94 shown" is a measured statement rather
    // than an inference. buildTable drops a total it cannot trust.
    totalRows: total,
  });
}

/**
 * Metrics that mean something when they are ADDED UP across the board.
 *
 * Market caps and 24h volumes sum to a market total, so a row's share of that
 * total is a real figure. A price does not — "$4,100 of prices" is nothing — and
 * holder counts double-count every address that holds two tokens, so a "share of
 * all holders" would be a percentage of a number that does not exist. Those two
 * get no share column rather than a plausible-looking wrong one.
 */
const ADDITIVE_METRICS = new Set(["marketCap", "volume24h"]);

/** What "what is moving" sorts on when the caller names nothing: activity. */
export const DEFAULT_MOVER_METRIC = "volume24h";

/**
 * Pure core of topMovers: registry in, the most active equities out.
 *
 * The one thing this does that buildRanking does not is DROP the entries whose
 * metric the indexer never published, rather than sorting them last. A ranking
 * is a list of everything in an order, so an unpriced token belongs at the end
 * of it; "the most active equities right now" is a claim about the figure
 * itself, and a token with no volume figure is not quiet — it is unmeasured. It
 * cannot be placed in that list at all, so it is counted out loud instead
 * (`unmeasured`) and the answer says so.
 *
 * @param {Array<object>} list - the equity registry
 * @param {{ metric?: string, limit?: number }} [options]
 */
export function buildMovers(list, { metric = DEFAULT_MOVER_METRIC, limit = 10 } = {}) {
  const field = resolveMetric(metric);
  const rowLimit = clampLimit(limit);
  const items = (Array.isArray(list) ? list : []).filter((t) => t && typeof t === "object");
  const measured = items.filter((t) => numOrNull(t[field]) !== null);
  const kind = field === "holders" ? "count" : "usd";

  const combined = ADDITIVE_METRICS.has(field) && measured.length
    ? Math.round(measured.reduce((acc, t) => acc + numOrNull(t[field]), 0) * 100) / 100
    : null;

  const rows = measured
    // A copy: the cached registry array must never be reordered in place.
    .slice()
    .sort(compareByField(field, "desc"))
    .slice(0, rowLimit)
    .map((token, i) => {
      const base = toRow(token, i);
      const value = numOrNull(token[field]);
      const share = combined !== null && combined > 0 && value !== null
        ? Math.round((value / combined) * 10000) / 100
        : null;
      return {
        ...base,
        metric: field,
        metricValue: value,
        // Flat display strings beside the nested `display` block, because these
        // rows also become table cells and a table cell may not nest.
        metricDisplay: displayNumber(value, kind),
        priceDisplay: base.display?.price ?? null,
        share,
        shareDisplay: share === null ? null : `${share}%`,
      };
    });

  return {
    metric: field,
    limit: rowLimit,
    count: rows.length,
    // How many of the listed equities carried this figure at all, and how many
    // did not — the second number is what stops "the 10 most active" from
    // reading as "the only 10 with any activity".
    measured: measured.length,
    unmeasured: items.length - measured.length,
    totalStockTokens: items.length,
    combined,
    combinedDisplay: displayNumber(combined, kind),
    rows,
  };
}

/**
 * The movers, as a table the client can draw and export.
 *
 * The share column appears only for a metric that can honestly be summed (see
 * ADDITIVE_METRICS), and the price column only when price is not already the
 * metric — a table with "Price" twice under two different headings is a table
 * that invites the reader to compare a figure with itself.
 *
 * @param {object} built - the output of buildMovers
 * @returns {object} a lib/table-shape.js table
 */
function moversTable(built) {
  const word = METRIC_WORDS[built.metric] ?? built.metric;
  const additive = ADDITIVE_METRICS.has(built.metric);
  const columns = [
    col("rank", "#", "right"),
    col("symbol", "Ticker"),
    col("company", "Company"),
    col("metricDisplay", word.charAt(0).toUpperCase() + word.slice(1), "right"),
  ];
  if (additive) columns.push(col("shareDisplay", "Share of total", "right"));
  if (built.metric !== "price") columns.push(col("priceDisplay", "Price", "right"));
  columns.push(col("address", "Contract"));

  return buildTable({
    id: "top-movers",
    title: `${built.rows.length} most active tokenized ${built.rows.length === 1 ? "equity" : "equities"} by ${word}`,
    columns,
    rows: built.rows,
    // The rankable population, not the whole registry: a row that carried no
    // figure was never a candidate for this list.
    totalRows: built.measured,
    truncated: built.rows.length < built.measured,
    note: [
      `Ranked on ${word} as the indexer published it at lookup time.`,
      built.unmeasured
        ? `${built.unmeasured} of the ${built.totalStockTokens} listed equities carried no ${word} figure and are not in this list — unmeasured, not inactive.`
        : null,
      additive && built.combinedDisplay
        ? `Shares are of ${built.combinedDisplay}, the combined ${word} of the ${built.measured} equities that carried one.`
        : null,
    ]
      .filter(Boolean)
      .join(" "),
  });
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
async function registry(load = listStockTokens) {
  const list = await load();
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
    const ranking = buildRanking(list, { metric, direction, limit });
    return {
      ok: true,
      kind: "ranking",
      evidence: {
        ...ranking,
        // The same rows, drawn rather than recited. Last in the object so the
        // blocks an answer reads first are still the ones it reads first.
        table: rankingTable(ranking.rows, ranking.metric, ranking.direction, list.length),
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

/**
 * The most active tokenized equities right now — the evidence behind "what's
 * moving", "what's busy today" and "which ones are actually trading".
 *
 * Sorted on the same registry rankStocks reads, so it costs the same cached
 * walk and no extra indexer call. What differs is the population: only the
 * equities that carry the metric can be in the list, and the ones that do not
 * are counted rather than ranked last (see buildMovers).
 *
 * An empty list is a real answer here and is returned as one: if the indexer
 * published no 24h volume for any listed equity, `count` is 0, `unmeasured`
 * says how many that was, and nothing pretends the market is asleep.
 *
 * @param {{ metric?: string, limit?: number, calls?: { listStockTokens?: Function } }} [options]
 *   `calls` is the test seam the token-side lookups use: the registry walk is
 *   the only I/O here, and injecting it is what makes the table assertable with
 *   no indexer. lib/ask-tools.js never passes it — coerceMoverArgs builds a
 *   fresh object carrying only the metric and the limit.
 * @returns {Promise<{ ok: boolean, kind?: string, evidence?: object, error?: string }>}
 */
export async function topMovers({ metric = DEFAULT_MOVER_METRIC, limit = 10, calls } = {}) {
  try {
    const list = await registry(
      typeof calls?.listStockTokens === "function" ? calls.listStockTokens : listStockTokens,
    );
    if (!list) {
      return {
        ok: false,
        error:
          "The Robinhood Chain indexer did not return the tokenized-equity list, so the most active equities cannot be read right now. Try again shortly.",
      };
    }
    const built = buildMovers(list, { metric, limit });
    return {
      ok: true,
      kind: "movers",
      evidence: {
        ...built,
        metricWord: METRIC_WORDS[built.metric] ?? built.metric,
        note: built.count
          ? built.unmeasured
            ? `${built.unmeasured} of the ${built.totalStockTokens} listed equities carried no ${METRIC_WORDS[built.metric] ?? built.metric} figure, so they could not be ranked here — that is unmeasured, not zero activity.`
            : null
          : `The indexer published no ${METRIC_WORDS[built.metric] ?? built.metric} for any of the ${built.totalStockTokens} listed equities, so nothing can be ranked on it. That is a missing feed, not a still market.`,
        table: moversTable(built),
        asOf: nowIso(),
        // Says the list is over a prefix of the market, not all of it.
        ...partialFlag(list),
      },
    };
  } catch (e) {
    return failure(e, "The most active tokenized equities could not be read");
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
    // null when the collision scan did not run: an unread search is not a clean
    // ticker, and this column sits beside price and market cap where a 0 reads
    // as a measured figure.
    return filled(query, resolved.match, {
      official: resolved.official,
      impostorCount: Array.isArray(resolved.impostors) ? resolved.impostors.length : null,
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
 *
 * A NULL list is the scan that never ran (see lib/stock-tokens.js
 * searchCandidates), and it produces `total: null` — unknown. Zero would say the
 * explorer was asked and found nothing, which is the opposite of what happened,
 * and it would say it in the direction that reassures.
 */
export function collisions(impostors, selfAddress) {
  if (!Array.isArray(impostors)) return { rows: [], total: null };
  const self = String(selfAddress ?? "").toLowerCase();
  const rows = impostors.filter((i) => String(i?.address ?? "").toLowerCase() !== self);
  return { rows: rows.slice(0, TOP_N), total: rows.length };
}

/**
 * Other contracts wearing the same ticker, excluding the one being reported on.
 * Best-effort in that losing it must not turn a safety check into an error — but
 * never silently: a failure comes back as `total: null`, and safetyReport says so
 * in its reasons rather than reporting no collisions.
 */
async function otherContractsWithSymbol(symbol, selfAddress) {
  // Nothing to collide with: no symbol was read, so no scan was possible.
  if (!symbol) return { rows: [], total: null };
  try {
    const resolved = await resolveSymbol(symbol);
    return collisions(resolved?.impostors, selfAddress);
  } catch {
    return { rows: [], total: null };
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
    // null, not 0: on every path that reaches this base the collision scan was
    // not run, and "0 other contracts use this ticker" is a finding.
    impostorCount: null,
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
    // null total = not scanned yet. Every assignment below either measures it or
    // leaves it unknown; nothing turns it into zero.
    let sameTicker = { rows: [], total: null };

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

    // The collision scan is a SEPARATE lookup from the deployer check, so it can
    // fail on its own — and when it does, silence reads as "nothing else uses
    // this ticker". The verdict above still stands; only the collision half is
    // unknown, and this is the sentence that keeps the two apart.
    // Guarded on `symbol` because an address with no ticker at all — a wallet, a
    // non-token contract — has no collisions to look for, and saying a scan was
    // missed there would invent a gap.
    if (sameTicker.total === null && symbol) {
      reasons.push(
        `The explorer search did not answer, so whether other contracts on Robinhood Chain also use the ticker ${symbol} could not be checked — unknown, not none.`,
      );
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
