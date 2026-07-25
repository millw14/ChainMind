/**
 * Intent router for /api/ask.
 *
 * The product started as a target-lookup explainer: every question had to carry
 * a 0x address, a hash or a ticker, and anything else was rejected. Most real
 * questions carry none of those — "what are the top stocks by market cap?",
 * "what is trending?", "which stock has the most holders?" — so the router's
 * job is to work out what the user is ASKING FOR before anything decides what
 * to look up.
 *
 * This module is deliberately PURE: string analysis only, no network, and no
 * imports from lib/blockscout.js or lib/stock-tokens.js. That keeps it fast
 * enough to run on every request, keeps it fully unit-testable without an
 * indexer, and keeps it out of the ask-evidence <-> stock-tokens import cycle.
 *
 * Nothing here decides whether a symbol is real — only that the user typed
 * something ticker-shaped. Resolution (and the impostor check that matters) is
 * still lib/stock-tokens.js's job.
 */

/** The intent names. Frozen: callers switch on these, so they are an API. */
export const INTENTS = Object.freeze({
  EXPLAIN_TARGET: "explain_target",
  COMPARE: "compare",
  RANK_STOCKS: "rank_stocks",
  MARKET_OVERVIEW: "market_overview",
  SAFETY_CHECK: "safety_check",
  EXPLAIN_CHAIN: "explain_chain",
  UNKNOWN: "unknown",
});

/* --------------------------- target extraction --------------------------- */

// Both hex patterns demand a non-hex boundary on each side, mirroring
// lib/extract-target.js. An unanchored match slices a valid-looking address out
// of a longer or truncated hex run, and the user is then answered confidently
// about an account they never typed. Over- and under-length runs must yield
// nothing at all rather than a plausible prefix.
const TX_RE = /(?:^|[^0-9a-fA-F])(0x[0-9a-fA-F]{64})(?![0-9a-fA-F])/g;
const ADDRESS_RE = /(?:^|[^0-9a-fA-F])(0x[0-9a-fA-F]{40})(?![0-9a-fA-F])/g;

/**
 * A ticker candidate: 1–5 letters, optional leading "$", not glued to any other
 * letter or digit. The leading-boundary character is consumed rather than
 * matched with a lookbehind, for parity with the patterns above.
 *
 * Case matters. Bare candidates must be UPPERCASE (checked after the match), so
 * the "now" in "what is trending now" cannot become NOW (ServiceNow) and the
 * "be"/"cost" in an ordinary sentence cannot become BE or COST — all three are
 * live tickers on this chain, which is exactly why they are not stopworded.
 * A "$" prefix is an explicit ticker marker, so "$tsla" is accepted in any case
 * and skips the stopword filter ("$ALL" means Allstate, not the word "all").
 */
const SYMBOL_CANDIDATE_RE = /(?:^|[^0-9A-Za-z$])(\$?)([A-Za-z]{1,5})(?![0-9A-Za-z])/g;

/**
 * Uppercase English that would otherwise read as a ticker. Without this, "What
 * are the TOP stocks" resolves TOP, and the answer is about some random token
 * instead of a ranking.
 *
 * Curated against config/stock-tokens.json: no word here collides with any of
 * the 94 live equity tokens. Words that DO collide (BE, NOW, COST, NU, PR, F,
 * P, ELF, USO) are intentionally absent — case sensitivity already keeps their
 * lowercase English uses out, and a stopword entry would make the real ticker
 * unaskable.
 */
const STOPWORDS = new Set([
  // articles, conjunctions, prepositions
  "A", "AN", "THE", "AND", "OR", "BUT", "NOR", "FOR", "SO", "YET", "IF", "THAN",
  "THEN", "AS", "AT", "BY", "IN", "INTO", "OF", "OFF", "ON", "ONTO", "OUT",
  "OVER", "PER", "TO", "UP", "VIA", "WITH", "FROM", "UNDER", "ABOUT", "ABOVE",
  "AFTER", "SINCE", "UNTIL", "WHILE", "VS",
  // pronouns and determiners
  "I", "ME", "MY", "MINE", "WE", "US", "OUR", "YOU", "YOUR", "IT", "ITS", "HE",
  "SHE", "HIS", "HER", "THEY", "THEM", "THEIR", "THIS", "THAT", "THESE",
  "THOSE", "ALL", "ANY", "BOTH", "EACH", "EVERY", "SOME", "NONE", "SUCH",
  "OTHER", "SAME", "ONE", "TWO", "TEN",
  // question words and verbs that show up shouted
  "WHAT", "WHICH", "WHO", "WHOM", "WHOSE", "WHEN", "WHERE", "WHY", "HOW",
  "IS", "ARE", "WAS", "WERE", "AM", "BEEN", "BEING", "DO", "DOES", "DID",
  "HAS", "HAVE", "HAD", "CAN", "COULD", "WILL", "WOULD", "SHALL", "MAY",
  "MIGHT", "MUST", "GET", "GOT", "SHOW", "TELL", "FIND", "GIVE", "LIST",
  "MAKE", "MADE", "SEND", "SENT", "HOLD", "HELD", "OWN", "OWNS", "BUY",
  "SELL", "SOLD", "KEEP", "NEED", "WANT", "LOOK", "SEE", "SAY", "USE",
  // ranking / metric vocabulary — never a ticker in these questions
  "TOP", "MOST", "LEAST", "BEST", "WORST", "BIG", "HUGE", "HIGH", "LOW",
  "MORE", "LESS", "MANY", "MUCH", "GOOD", "BAD", "NEW", "OLD", "NEXT",
  "LAST", "FIRST", "NOT", "NO", "YES", "ONLY", "JUST", "ALSO", "EVEN",
  "VERY", "TOO", "NOW", // see note above: "NOW" the ticker is only reachable as $NOW
  // chain and market nouns
  "CHAIN", "STOCK", "STOCKS", "TOKEN", "COIN", "COINS", "PRICE", "CAP",
  "MCAP", "VALUE", "WORTH", "TRADE", "MOVES", "MOVE", "WHALE", "SAFE",
  "SCAM", "RUG", "REAL", "FAKE", "LEGIT", "TRUST", "RISK", "RATE", "RANK",
  "DATA", "INFO", "NAME", "TIME", "DAY", "WEEK", "YEAR", "HOUR", "TODAY",
  "USD", "ETH", "GAS", "WEI", "NFT", "AI", "API", "URL", "DEX", "CEX",
]);

/**
 * Pull every target out of a free-text question.
 *
 * Lists are de-duplicated (case-insensitively for hex, by uppercased form for
 * symbols) with first-seen order preserved, because "compare NVDA and TSLA"
 * must keep NVDA first — the user's order is the answer's order.
 *
 * @param {unknown} text
 * @returns {{ txs: string[], addresses: string[], symbols: string[] }}
 */
export function extractTargets(text) {
  const s = typeof text === "string" ? text : "";
  return {
    txs: dedupe(collect(s, TX_RE, 1), (v) => v.toLowerCase()),
    addresses: dedupe(collect(s, ADDRESS_RE, 1), (v) => v.toLowerCase()),
    symbols: dedupe(collectSymbols(s), (v) => v),
  };
}

/** All capture-group matches of a global pattern, in order. */
function collect(s, re, group) {
  const out = [];
  for (const m of s.matchAll(re)) out.push(m[group]);
  return out;
}

/** Ticker-shaped runs, uppercased, with the stopword guard applied. */
function collectSymbols(s) {
  const out = [];
  for (const m of s.matchAll(SYMBOL_CANDIDATE_RE)) {
    const marked = m[1] === "$";
    const raw = m[2];
    // No "$": the user has to have typed it as a ticker, in caps, and it must
    // not be an ordinary English word.
    if (!marked) {
      if (raw !== raw.toUpperCase()) continue;
      if (STOPWORDS.has(raw)) continue;
    }
    out.push(raw.toUpperCase());
  }
  return out;
}

function dedupe(values, key) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const k = key(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

/* ------------------------------ classification ---------------------------- */

const SAFETY_RE =
  /\b(?:safe|safety|legit|legitimate|scam|scammy|rug|rugged|rugpull|real|fake|counterfeit|trust|trustworthy|trusted|verified|unverified|official|unofficial|impostor|imposter|genuine|authentic)\b/gi;

const COMPARE_RE = /\b(?:compare[ds]?|comparing|comparison|vs|versus|against|difference between)\b/gi;

const RANK_WORD_RE =
  /\b(?:top|biggest|largest|most|highest|lowest|best|worst|cheapest|smallest|leading|greatest|fewest|least)\b/gi;

const METRIC_HINT_RE =
  /\b(?:market\s*cap|marketcap|mcap|cap|holders?|owners?|prices?|expensive|priciest|cheap|cheapest|volumes?|traded|trading|value|valuable|worth)\b/gi;

/**
 * "top stocks", "10 biggest tokens", "best performing equities" — a ranking
 * word aimed at the universe of stock tokens is a ranking even with no metric
 * named; market cap is the sane default (see parseRankQuery).
 */
const BARE_RANK_RE =
  /\b(?:top|biggest|largest|best|worst|cheapest|smallest|most|leading)\s+(?:\d{1,3}\s+)?(?:[a-z]+\s+)?(?:stocks?|tokens?|equit(?:y|ies)|tickers?|compan(?:y|ies)|coins?)\b/gi;

const MARKET_RE =
  /\btrending\b|\bwhat(?:'s|s| is)\s+(?:happening|going on|new|hot|moving)\b|\boverview\b|\bsummary\s+of\s+the\s+chain\b|\bchain\s+summary\b|\bhow(?:'s|s| is)\s+the\s+market\b|\bmarket\s+(?:doing|today|overview|summary|update|activity)\b|\brecent\s+(?:whale\s+|big\s+|large\s+)?(?:moves|movements|activity|action|trades|transfers)\b|\bwhale\s+(?:moves|movements|activity|watch|trades|transactions|transfers)\b/gi;

/**
 * Conceptual questions the system prompt already answers. These must NOT reach
 * the indexer: "what is Robinhood Chain?" has no target to look up, and a
 * failed lookup would turn an easy answer into an error.
 */
const EXPLAIN_CHAIN_RE =
  /\bwhat\s+(?:is|are)\s+(?:a\s+|an\s+|the\s+)?(?:robinhood\s+chain|chainmind|tokenized\s+(?:equit(?:y|ies)|stocks?|shares?)|stock\s+tokens?|equity\s+tokens?)\b|\bhow\s+(?:does|do)\s+(?:this|it|they|chainmind|the\s+chain|robinhood\s+chain|stock\s+tokens?|tokenized\s+(?:stocks?|equities))\s+work\b|\bwhat\s+can\s+you\s+do\b|\bexplain\s+(?:robinhood\s+chain|the\s+chain|chainmind)\b|\bwhat\s+is\s+an?\s+(?:erc-?20|l2|rollup|orbit\s+chain)\b/gi;

/**
 * Decide what the question is asking for.
 *
 * Precedence when several signals fire:
 *   safety_check > compare > rank_stocks > market_overview > explain_target >
 *   explain_chain > unknown
 * "Is NVDA at 0x… the real one?" is a safety question that happens to name a
 * target, not a target lookup that happens to say "real" — so safety wins over
 * explain_target, and a ranking wins over the generic overview it also reads as.
 *
 * `matched` carries the trigger phrases that fired, lowercased, for logging and
 * for the caller to show its reasoning. `confidence` is a coarse 0–1 score;
 * compare in particular drops to 0.5 when the keyword fired but fewer than two
 * concrete targets were named, so a caller can fall back rather than try to
 * compare one thing with nothing.
 *
 * @param {unknown} question
 * @param {{ txs?: string[], addresses?: string[], symbols?: string[] }} [targets]
 *   result of extractTargets; recomputed from the question when omitted
 * @returns {{ intent: string, confidence: number, matched: string[] }}
 */
export function classifyIntent(question, targets) {
  const q = typeof question === "string" ? question : "";
  const t = targets && typeof targets === "object" ? targets : extractTargets(q);
  const txs = arr(t.txs);
  const addresses = arr(t.addresses);
  const symbols = arr(t.symbols);
  const targetCount = txs.length + addresses.length + symbols.length;
  const hasTarget = targetCount > 0;
  // Only named entities can be compared; two transaction hashes are a diff
  // request we do not serve, so they do not count toward the compare threshold.
  const comparableCount = addresses.length + symbols.length;

  const safety = hits(q, SAFETY_RE);
  if (safety.length && hasTarget) {
    return result(INTENTS.SAFETY_CHECK, 0.9, safety);
  }

  const compare = hits(q, COMPARE_RE);
  if (comparableCount >= 2 || compare.length) {
    const matched = compare.length ? compare : [`${comparableCount} targets`];
    // Two named targets is an unambiguous compare; the bare keyword is a guess.
    return result(INTENTS.COMPARE, comparableCount >= 2 ? 0.9 : 0.5, matched);
  }

  const rankWords = hits(q, RANK_WORD_RE);
  const metrics = hits(q, METRIC_HINT_RE);
  const bareRank = hits(q, BARE_RANK_RE);
  if ((rankWords.length && metrics.length) || bareRank.length) {
    return result(
      INTENTS.RANK_STOCKS,
      rankWords.length && metrics.length ? 0.85 : 0.7,
      unique([...rankWords, ...metrics, ...bareRank]),
    );
  }

  const market = hits(q, MARKET_RE);
  if (market.length && !hasTarget) {
    return result(INTENTS.MARKET_OVERVIEW, 0.75, market);
  }

  if (hasTarget) {
    // A hash or an address is exact; a bare ticker was inferred from shape.
    const exact = txs.length + addresses.length > 0;
    return result(INTENTS.EXPLAIN_TARGET, exact ? 0.9 : 0.8, [...txs, ...addresses, ...symbols]);
  }

  const chain = hits(q, EXPLAIN_CHAIN_RE);
  if (chain.length) {
    return result(INTENTS.EXPLAIN_CHAIN, 0.7, chain);
  }

  return result(INTENTS.UNKNOWN, 0, []);
}

function result(intent, confidence, matched) {
  return { intent, confidence, matched: unique(matched.map((m) => String(m).toLowerCase())) };
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function unique(values) {
  return [...new Set(values)];
}

/** Every distinct phrase a global pattern matches, lowercased and whitespace-flattened. */
function hits(s, re) {
  const out = [];
  for (const m of s.matchAll(re)) {
    const w = m[0].trim().replace(/\s+/g, " ").toLowerCase();
    if (w) out.push(w);
  }
  return unique(out);
}

/* ------------------------------ rank parsing ------------------------------ */

/** Sorting the caller can actually apply to a StockToken. */
const HOLDERS_RE = /\bholders?\b|\bholder\s*count\b|\bowners?\b|\bhold(?:ing|ers)\b/i;
const VOLUME_RE = /\bvolumes?\b|\btraded\b|\btrading\b|\bmost\s+active\b|\bturnover\b/i;
const PRICE_RE = /\bprices?\b|\bexpensive\b|\bpriciest\b|\bcheap(?:est)?\b|\bcosts?\b|\bper\s+share\b/i;
const MARKET_CAP_RE = /\bmarket\s*cap\b|\bmarketcap\b|\bmcap\b|\bcap\b|\bvaluable\b|\bvaluation\b|\bworth\b|\bsize\b/i;

/** Words that flip a ranking to ascending. */
const ASC_RE = /\bcheapest\b|\blowest\b|\bsmallest\b|\bworst\b|\bleast\b|\bfewest\b|\bbottom\b|\bascending\b/i;

/** "top 5", "best 3" — the count follows the ranking word. */
const COUNT_AFTER_RE = /\b(?:top|first|bottom|best|worst|cheapest|biggest|largest|smallest|highest|lowest)\s+(\d{1,3})\b/i;
/** "10 biggest", "5 stocks" — the count leads it. */
const COUNT_BEFORE_RE =
  /\b(\d{1,3})\s+(?:biggest|largest|top|best|worst|cheapest|smallest|highest|lowest|most|leading|stocks?|tokens?|equit(?:y|ies)|tickers?|compan(?:y|ies))\b/i;

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

/**
 * Turn a ranking question into sort parameters for the stock list.
 *
 * Defaults are marketCap / desc / 10: "top stocks" with nothing else said means
 * the biggest ones. Metric checks run holders -> volume -> price -> market cap
 * so the more specific word wins ("highest volume" is not a market-cap query),
 * and the limit is clamped to 1..25 because the caller pays for every row it
 * has to describe.
 *
 * @param {unknown} question
 * @returns {{ metric: "marketCap"|"holders"|"price"|"volume24h", direction: "desc"|"asc", limit: number }}
 */
export function parseRankQuery(question) {
  const q = typeof question === "string" ? question : "";

  let metric = "marketCap";
  if (HOLDERS_RE.test(q)) metric = "holders";
  else if (VOLUME_RE.test(q)) metric = "volume24h";
  else if (PRICE_RE.test(q)) metric = "price";
  else if (MARKET_CAP_RE.test(q)) metric = "marketCap";

  const direction = ASC_RE.test(q) ? "asc" : "desc";

  const m = q.match(COUNT_AFTER_RE) ?? q.match(COUNT_BEFORE_RE);
  const n = m ? Number.parseInt(m[1], 10) : NaN;
  const limit = Number.isFinite(n) ? Math.min(MAX_LIMIT, Math.max(1, n)) : DEFAULT_LIMIT;

  return { metric, direction, limit };
}
