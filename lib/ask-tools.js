import { gatherEvidence } from "./ask-evidence.js";
import {
  clampLimit,
  compareTargets,
  marketOverview,
  rankStocks,
  resolveDirection,
  resolveMetric,
  safetyReport,
} from "./market-evidence.js";
import { resolveSymbol } from "./stock-tokens.js";

/**
 * The tool catalogue for /api/ask — what lets the MODEL decide what to look up.
 *
 * lib/ask-intent.js routes with regexes and a keyword list. Measured against 16
 * realistic phrasings it routed 3: "hows nvda doin", "i wanna know about apple",
 * "nvda price", "whos got the most bags", "show me whats poppin", "top 3",
 * "nvidia", "que es nvda" and a typo'd "wut is robinhud chain" all fell through
 * to "I couldn't tell what to look up". Worse, "tsla vs nvda which is better"
 * DID classify as a comparison and then extracted zero targets, because bare
 * ticker candidates have to be uppercase to survive the stopword guard — so it
 * would have compared nothing and said so confidently.
 *
 * More keywords cannot fix that. Natural language is not a finite list, and the
 * lowercase-ticker failure shows the cost of guessing wrong: a confident answer
 * about nothing. So the routing decision moves to the model, and this module is
 * the interface it routes through — seven tools, and one dispatcher that turns a
 * tool call back into the evidence gatherers we already have.
 *
 * Two things carry the weight here:
 *
 *  1. THE DESCRIPTIONS. They are the router now. Each one says in plain language
 *     when to use the tool, quotes the casual phrasings people actually type, and
 *     says that arguments may arrive lowercase, as a company name, or in another
 *     language — because lib/stock-tokens.js resolveSymbol already handles all
 *     three ("tesla" -> TSLA, "$nvda" -> NVDA, "apple" -> AAPL). The extraction
 *     layer was the bottleneck, never the resolution layer.
 *  2. COERCION. A model will send a string where an array belongs, a limit of
 *     999, a metric of "banana", the value under the wrong key, or nothing at
 *     all. Every one of those has to become either a valid call or an error
 *     sentence the model can act on — never an exception, and never a silently
 *     different question than the user asked.
 *
 * dispatchTool never throws. Server-side only: no React.
 */

/* ------------------------------ shapes ------------------------------ */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * A ticker as lib/ask-evidence.js classifyTarget will accept it: letters and
 * digits only, no separators. Mirrored rather than imported because the point is
 * to know, before dispatching, whether gatherEvidence can take the string as-is
 * or whether it has to be resolved to a symbol first.
 */
const TICKER_RE = /^\$?[0-9A-Za-z]{1,10}$/;

/**
 * Argument length bound. The longest thing a caller legitimately passes is an
 * ETF's full name ("iShares 0-3 Month Treasury Bond ETF", 35 characters) or a
 * 42-character address. Anything past this is the model handing over the user's
 * whole sentence, which resolves to nothing — better to say so than to search
 * for it.
 */
const MAX_QUERY_CHARS = 96;

/** Absurd array sizes are refused outright; 2–4 is what a comparison means. */
const MAX_COMPARE_ENTRIES = 25;

/* ------------------------------ the catalogue ------------------------------ */

/**
 * OpenAI/Groq-compatible tool definitions.
 *
 * Frozen, and the shape is fixed: app/api/ask/route.js sends this array
 * verbatim as `tools` and matches responses back by `function.name`.
 */
export const TOOL_SCHEMAS = Object.freeze([
  {
    type: "function",
    function: {
      name: "lookup_token",
      description:
        "Look up ONE tokenized stock, ETF, token, ticker, company or 0x token contract on Robinhood Chain: price, market cap, holder count, 24h volume, total supply, top holders, recent transfers, and whether it is the contract Robinhood actually issued. " +
        "Use this for any question about a single company or ticker, however casually or informally it is phrased, and in any language: \"hows nvda doin\", \"nvda price\", \"i wanna know about apple\", \"nvidia\", \"how much apple\", \"que es nvda\", \"tell me about $tsla\", \"what is 0x1234...\". " +
        "The query does NOT need to be cleaned up first — a ticker in any case (\"NVDA\", \"nvda\", \"$tsla\"), a company name (\"apple\", \"tesla\", \"nvidia\", \"coca cola\") and a 0x contract address are all resolved for you, so pass the company or ticker the user meant and nothing else. " +
        "Do not pass the user's whole sentence. Fix an obvious typo before calling (\"nvdia\" -> \"nvidia\"). One target only: for two or more, use compare_tokens instead.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "A ticker (\"NVDA\", \"nvda\", \"$tsla\"), a company name (\"apple\", \"tesla\", \"nvidia\") or a 0x token contract address. Case and a leading \"$\" do not matter.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_wallet",
      description:
        "Look up ONE 0x wallet or account address (40 hex characters after 0x) on Robinhood Chain: its ETH balance, which tokens it holds and what they are worth, how many transactions it has, its recent transfers, and the addresses it interacts with. " +
        "Use this whenever the user pastes an address, however they ask about it and in whatever language: \"whats in 0xabc...\", \"who does this wallet trade with\", \"is this a whale\", \"cuanto tiene 0xabc...\". " +
        "If the address turns out to be a token contract rather than a wallet, this still works and returns the token's details. Use lookup_transaction instead for a longer 64-hex-character hash, and safety_check when the question is whether a contract is genuine.",
      parameters: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "A 0x wallet or contract address — 0x followed by exactly 40 hex characters.",
          },
        },
        required: ["address"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_transaction",
      description:
        "Look up ONE transaction by its 0x hash (64 hex characters after 0x): whether it succeeded, what method it called, who sent it and to whom, which tokens moved and how much, the fee paid, and its block and timestamp. " +
        "Use this whenever the user pastes a transaction hash, in any phrasing or language: \"what happened here 0xdead...\", \"did this go through\", \"explain this tx\", \"que paso en 0xdead...\". " +
        "A shorter 40-hex-character value is an address, not a transaction — use lookup_wallet for that.",
      parameters: {
        type: "object",
        properties: {
          hash: {
            type: "string",
            description: "A transaction hash — 0x followed by exactly 64 hex characters.",
          },
        },
        required: ["hash"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rank_stocks",
      description:
        "Get an ORDERED list of Robinhood Chain's tokenized equities by one metric. Use this for any question asking which are the biggest, smallest, most held, cheapest or most traded — including very casual or slangy phrasings, and other languages: \"top 3\", \"biggest stocks\", \"give me the biggest ones\", \"which one is worth the most\", \"whos got the most bags\" (that is holders), \"cheapest stock\", \"most traded today\", \"los mas grandes\". " +
        "Choose the metric from what the user actually asked about: marketCap for size/value/worth, holders for how many addresses hold it (\"most bags\", \"most popular\", \"most owners\"), price for per-token price (\"cheapest\", \"most expensive\"), volume24h for trading activity (\"most active\", \"most traded\"). " +
        "Use direction \"asc\" for the small/cheap/least end and \"desc\" for the big/most end. Set limit to the number the user asked for (\"top 3\" is 3); leave it out for a default of 10.",
      parameters: {
        type: "object",
        properties: {
          metric: {
            type: "string",
            enum: ["marketCap", "holders", "price", "volume24h"],
            description:
              "What to sort on. marketCap = size/value/worth (default), holders = how many addresses hold it, price = price per token, volume24h = 24h trading volume.",
          },
          direction: {
            type: "string",
            enum: ["desc", "asc"],
            description: "\"desc\" for the biggest/most/highest (default), \"asc\" for the smallest/cheapest/least.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 25,
            description: "How many rows to return, 1 to 25. Default 10.",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compare_tokens",
      description:
        "Compare TWO to FOUR tokenized stocks side by side — price, market cap, holders, 24h volume, and whether each is an official Robinhood contract. " +
        "Use this whenever the user names more than one company or ticker, in any phrasing, casing or language: \"tsla vs nvda which is better\", \"compare apple and tesla\", \"nvda or amd\", \"aapl vs msft vs googl\", \"cual es mejor, tsla o nvda\". " +
        "Pass each target as its own array entry, in the order the user said them — lowercase tickers, company names and 0x addresses are all resolved for you, so \"tsla\" and \"tesla\" are equally fine. " +
        "For a single target use lookup_token instead.",
      parameters: {
        type: "object",
        properties: {
          queries: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            items: {
              type: "string",
              description: "A ticker, company name or 0x token contract address.",
            },
            description:
              "The 2–4 things to compare, one per entry, in the order the user named them. Example: [\"tsla\", \"nvda\"].",
          },
        },
        required: ["queries"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "market_overview",
      description:
        "Get a chain-wide snapshot of Robinhood Chain's tokenized-equity market: how many equities are listed, the largest by market cap, the most widely held, the most traded in 24h, and the combined totals. Takes no arguments. " +
        "Use this when the question is about the market as a whole rather than any one token, however casually phrased and in any language: \"whats trending\", \"show me whats poppin\", \"hows the market\", \"whats good today\", \"give me an overview\", \"what is there\", \"que hay de nuevo\". " +
        "If the user names a specific company or ticker, use lookup_token or rank_stocks instead. " +
        "NEVER use this as a fallback for a question it does not answer. In particular, questions about people — a founder, a co-founder, a team, a CEO, who is behind the project, who built it, company history, funding, investors or the roadmap — are OFF-CHAIN and are not in this snapshot or in any other tool here: answer those with no tool call at all rather than returning market data for them.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "safety_check",
      description:
        "Check whether ONE token is the genuine Robinhood-issued contract or an impostor wearing a real ticker's name. Returns a verdict — official, impostor, unknown or not found — with the deployer, the official issuer, the genuine contract address, and any other contracts using the same ticker. " +
        "Use this whenever the question is about trust or authenticity, in any phrasing or language: \"is this a rug\", \"is this legit\", \"any of these legit?\", \"is 0x465... safe\", \"is this the real NVDA\", \"scam?\", \"es real este token\". " +
        "The target may be a ticker in any case, a company name or a 0x address. This checks ONE token per call — if the user asks about several, call it once for each.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description:
              "The token to verify: a ticker (\"NVDA\", \"nvda\"), a company name (\"nvidia\"), or a 0x contract address.",
          },
        },
        required: ["target"],
        additionalProperties: false,
      },
    },
  },
]);

/**
 * The tool names, for validation and tests.
 *
 * Written out rather than derived from TOOL_SCHEMAS on purpose: a derived list
 * agrees with the catalogue by construction and so proves nothing. This one can
 * disagree, and test/ask-tools.test.mjs checks that it does not.
 */
export const TOOL_NAMES = Object.freeze([
  "lookup_token",
  "lookup_wallet",
  "lookup_transaction",
  "rank_stocks",
  "compare_tokens",
  "market_overview",
  "safety_check",
]);

/* ------------------------------ arg coercion ------------------------------ */
/* Exported for test/ask-tools.test.mjs. These are where a malformed tool call
   becomes either a valid lookup or a recoverable sentence, so they are tested
   directly — no fake client, no network. */

function err(message) {
  return { ok: false, error: message };
}

/** Flatten whatever the model sent into a single-line string, or "". */
function flatten(v) {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return "";
  return v.replace(/\s+/g, " ").trim();
}

/**
 * First usable string among several candidate keys.
 *
 * The aliases matter: a model that has been told the argument is `query` still
 * sends `symbol`, `ticker` or `token` sometimes, and refusing those would cost a
 * round trip to learn nothing. A bare string in place of the arguments object is
 * accepted for the same reason.
 */
function pickString(args, keys) {
  if (typeof args === "string") return flatten(args);
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  for (const key of keys) {
    const value = flatten(args[key]);
    if (value) return value;
  }
  return "";
}

/**
 * Common validation for a single free-text target: present, not the whole
 * question, and — if it starts with 0x — actually a well-formed address or hash
 * rather than a truncated one. A half-copied address must not reach the token
 * search, where it can match some unrelated contract that happens to be named
 * after the fragment.
 */
function checkTargetString(value, { argName, purpose }) {
  if (!value) {
    return err(
      `Missing "${argName}". Call ${purpose} again with a ticker (e.g. "nvda"), a company name (e.g. "apple") or a 0x address.`,
    );
  }
  if (value.length > MAX_QUERY_CHARS) {
    return err(
      `"${argName}" is too long (${value.length} characters). Pass only the ticker, company name or 0x address — not the user's whole question.`,
    );
  }
  if (/^0x/i.test(value) && !ADDRESS_RE.test(value) && !TX_RE.test(value)) {
    return err(
      `"${value}" is not a complete Robinhood Chain identifier: an address is 0x plus 40 hex characters and a transaction hash is 0x plus 64. Pass the full value, or a ticker such as "nvda".`,
    );
  }
  return { ok: true, value };
}

/**
 * lookup_token's `query`. Accepts a ticker, company name or 0x address.
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function coerceTokenQuery(args) {
  const value = pickString(args, ["query", "symbol", "ticker", "token", "name", "company", "address", "target"]);
  const checked = checkTargetString(value, { argName: "query", purpose: "lookup_token" });
  if (!checked.ok) return checked;
  if (TX_RE.test(value)) {
    return err(
      `${value} is a transaction hash (64 hex characters), not a token. Use lookup_transaction for it.`,
    );
  }
  return checked;
}

/**
 * safety_check's `target`. Same shapes as lookup_token — the verdict path in
 * lib/market-evidence.js accepts a ticker or an address.
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function coerceSafetyTarget(args) {
  const value = pickString(args, ["target", "query", "token", "symbol", "ticker", "address", "contract"]);
  const checked = checkTargetString(value, { argName: "target", purpose: "safety_check" });
  if (!checked.ok) return checked;
  if (TX_RE.test(value)) {
    return err(
      `${value} is a transaction hash, not a token contract. Safety checks apply to tokens — pass a ticker or a 0x contract address.`,
    );
  }
  return checked;
}

/**
 * lookup_wallet's `address`. Strict: only a 40-hex address, and a 64-hex hash is
 * named as the other tool's job rather than rejected as junk.
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function coerceAddressArg(args) {
  const value = pickString(args, ["address", "wallet", "account", "holder", "query", "target"]);
  if (!value) {
    return err('Missing "address". Call lookup_wallet again with a 0x address (0x followed by 40 hex characters).');
  }
  if (TX_RE.test(value)) {
    return err(`${value} is a transaction hash, not a wallet address. Use lookup_transaction for it.`);
  }
  if (!ADDRESS_RE.test(value)) {
    return err(
      `"${value.slice(0, MAX_QUERY_CHARS)}" is not a wallet address. An address is 0x followed by exactly 40 hex characters. If this is a ticker or company name, use lookup_token instead.`,
    );
  }
  return { ok: true, value };
}

/**
 * lookup_transaction's `hash`. Strict for the same reason as the address above.
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function coerceHashArg(args) {
  const value = pickString(args, ["hash", "tx", "txHash", "tx_hash", "transaction", "transactionHash", "query", "target"]);
  if (!value) {
    return err('Missing "hash". Call lookup_transaction again with a transaction hash (0x followed by 64 hex characters).');
  }
  if (ADDRESS_RE.test(value)) {
    return err(`${value} is an address (40 hex characters), not a transaction hash. Use lookup_wallet for it.`);
  }
  if (!TX_RE.test(value)) {
    return err(
      `"${value.slice(0, MAX_QUERY_CHARS)}" is not a transaction hash. A hash is 0x followed by exactly 64 hex characters.`,
    );
  }
  return { ok: true, value };
}

/**
 * rank_stocks arguments, always valid.
 *
 * Every field falls back rather than failing: a ranking is answerable with no
 * arguments at all ("top stocks" means the biggest ten), so refusing a bogus
 * metric would cost a round trip to reach the same default. The coercion is safe
 * to be silent because lib/market-evidence.js echoes the metric and direction it
 * actually sorted on back in the evidence, so the answer cannot claim to be a
 * ranking by something it is not.
 *
 * @returns {{ metric: string, direction: "asc"|"desc", limit: number }}
 */
export function coerceRankArgs(args) {
  const source = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const metricRaw = pickString(source, ["metric", "by", "sort", "sortBy", "sort_by", "field"]);
  const directionRaw = pickString(source, ["direction", "order", "sortOrder", "sort_order", "dir"]);
  const limitRaw = source.limit ?? source.count ?? source.n ?? source.top ?? source.limitCount;
  return {
    // resolveMetric maps aliases ("market cap", "owners", "volume") onto the
    // StockToken field and defaults to marketCap; resolveDirection only goes
    // ascending when asked; clampLimit holds the row count to 1..25.
    metric: resolveMetric(metricRaw),
    direction: resolveDirection(directionRaw),
    limit: clampLimit(limitRaw, 10),
  };
}

/**
 * Separators a model uses when it sends a comparison as one string instead of an
 * array. Comma and semicolon split bare; the word-shaped ones require whitespace
 * on both sides, so "AT&T" stays one target and "S&P" is not cut in half.
 */
const COMPARE_SPLIT_RE = /\s*[,;]\s*|\s+(?:vs\.?|versus|or|and|&|\+)\s+|\s*\/\s*/i;

/**
 * compare_tokens' `queries`.
 *
 * Handles the failure that started this module: the model sends "tsla vs nvda"
 * as a single string, which as a one-element array would compare one thing with
 * nothing. Splitting it recovers the two targets; ending up with fewer than two
 * distinct ones is reported as an error naming lookup_token, because a
 * "comparison" of a single token is a lookup wearing the wrong label.
 *
 * The 2–4 bound in the schema is NOT enforced here on the upper side —
 * compareTargets caps at four and returns a note naming the ones it dropped,
 * which is honest, where silently truncating here would not be.
 *
 * @returns {{ ok: true, value: string[] } | { ok: false, error: string }}
 */
export function coerceCompareQueries(args) {
  let raw = null;
  if (Array.isArray(args)) raw = args;
  else if (typeof args === "string") raw = [args];
  else if (args && typeof args === "object") {
    for (const key of ["queries", "targets", "tokens", "symbols", "items", "list", "query"]) {
      const value = args[key];
      if (Array.isArray(value) || typeof value === "string") {
        raw = Array.isArray(value) ? value : [value];
        break;
      }
    }
  }

  if (!raw) {
    return err(
      'Missing "queries". Call compare_tokens again with an array of 2 to 4 tickers, company names or 0x addresses, e.g. ["tsla", "nvda"].',
    );
  }
  if (raw.length > MAX_COMPARE_ENTRIES) {
    return err(`Too many entries in "queries" (${raw.length}). Compare at most 4 things at a time.`);
  }

  // A single string may be the whole comparison ("tsla vs nvda"); anything past
  // the first entry is already split, so only that case is broken apart.
  const parts = raw.length === 1 && typeof raw[0] === "string" ? String(raw[0]).split(COMPARE_SPLIT_RE) : raw;

  const seen = new Set();
  const queries = [];
  for (const entry of parts) {
    const value = flatten(entry);
    if (!value) continue;
    if (value.length > MAX_QUERY_CHARS) {
      return err(
        `One entry in "queries" is too long (${value.length} characters). Each entry is a single ticker, company name or 0x address.`,
      );
    }
    if (/^0x/i.test(value) && !ADDRESS_RE.test(value)) {
      return err(
        `"${value}" is not a complete 0x contract address (0x plus 40 hex characters). Pass the full address, or a ticker such as "nvda".`,
      );
    }
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(value);
  }

  if (queries.length < 2) {
    return err(
      `A comparison needs at least 2 distinct targets${queries.length ? ` — only "${queries[0]}" was given` : ""}. Use lookup_token for a single token, or call compare_tokens again with both targets, e.g. ["tsla", "nvda"].`,
    );
  }
  return { ok: true, value: queries };
}

/* ------------------------------ the dispatcher ------------------------------ */

/**
 * The real implementations. Overridable per call so the dispatcher — arg
 * coercion, tool routing, error shaping — is fully testable offline: nothing
 * here may reach Blockscout during a unit test.
 */
const DEFAULT_IMPLS = Object.freeze({
  gatherEvidence,
  rankStocks,
  marketOverview,
  compareTargets,
  safetyReport,
  resolveSymbol,
});

/**
 * Run one model-chosen tool call and return the evidence for it.
 *
 * lookup_token reuses lib/ask-evidence.js gatherEvidence rather than assembling
 * the token evidence itself, because gatherEvidence's symbol path is the only
 * one that attaches the `stock` block — the resolver's verdict plus the
 * impostorWarning sentence, which the system prompt is required to lead with
 * when a ticker is not the official contract. Reimplementing the token path here
 * would have meant reimplementing that warning, and a second copy of a safety
 * message is a second chance to drop it. So:
 *   - a 0x address goes straight to gatherEvidence (token or wallet, it decides);
 *   - a ticker-shaped string goes straight to gatherEvidence, which resolves it;
 *   - anything else (a multi-word company name, which classifyTarget would call
 *     "unknown") is resolved here first, then handed back to gatherEvidence as
 *     the resolved symbol so the impostor block still comes along. That costs one
 *     extra resolveSymbol on the company-name path only, and listStockTokens is
 *     cached, so it is a cache read plus one explorer search.
 *
 * @param {string} name - one of TOOL_NAMES
 * @param {object} args - the model's arguments, trusted for nothing
 * @param {object} [impls] - test seam: overrides for the data modules
 * @returns {Promise<{ ok: true, kind?: string, evidence?: object } | { ok: false, error: string }>}
 */
export async function dispatchTool(name, args, impls) {
  const tool = typeof name === "string" ? name.trim() : "";
  if (!TOOL_NAMES.includes(tool)) {
    return err(
      `Unknown tool "${tool || String(name)}". Available tools: ${TOOL_NAMES.join(", ")}. Call one of those instead.`,
    );
  }

  const fns = impls && typeof impls === "object" ? { ...DEFAULT_IMPLS, ...impls } : DEFAULT_IMPLS;

  try {
    if (tool === "lookup_token") {
      const q = coerceTokenQuery(args);
      if (!q.ok) return q;
      return await lookupToken(q.value, fns);
    }

    if (tool === "lookup_wallet") {
      const a = coerceAddressArg(args);
      if (!a.ok) return a;
      return await fns.gatherEvidence(a.value);
    }

    if (tool === "lookup_transaction") {
      const h = coerceHashArg(args);
      if (!h.ok) return h;
      return await fns.gatherEvidence(h.value);
    }

    if (tool === "rank_stocks") {
      return await fns.rankStocks(coerceRankArgs(args));
    }

    if (tool === "compare_tokens") {
      const list = coerceCompareQueries(args);
      if (!list.ok) return list;
      return await fns.compareTargets(list.value);
    }

    if (tool === "market_overview") {
      // Arguments are ignored rather than rejected: an empty-parameter tool that
      // the model decorated with a stray field is still the right tool.
      return await fns.marketOverview();
    }

    // safety_check
    const t = coerceSafetyTarget(args);
    if (!t.ok) return t;
    return await fns.safetyReport(t.value);
  } catch (e) {
    // The gatherers are written not to throw, but a tool result is a prompt
    // input: an exception escaping here would 500 the route mid-conversation,
    // where a sentence lets the model finish the answer honestly.
    const detail = String(e?.message ?? e).slice(0, 200);
    return err(`The ${tool} lookup failed: ${detail}. Say the data could not be read rather than guessing.`);
  }
}

/** lookup_token's three paths. See dispatchTool's note for why each exists. */
async function lookupToken(query, fns) {
  if (ADDRESS_RE.test(query) || TICKER_RE.test(query)) {
    return await fns.gatherEvidence(query);
  }

  // A company name with a space in it: "coca cola", "berkshire hathaway".
  const resolved = await fns.resolveSymbol(query);
  const match = resolved?.ok ? resolved.match : null;
  if (!match?.address) {
    return err(
      `No token matching "${query}" was found on Robinhood Chain. ${
        /\s/.test(query)
          ? "If that was the user's whole question, call lookup_token again with just the company name or ticker."
          : "Check the spelling, or try the ticker instead of the company name."
      }`,
    );
  }

  const handle = TICKER_RE.test(String(match.symbol ?? "")) ? match.symbol : match.address;
  const res = await fns.gatherEvidence(handle);
  if (!res?.ok) return res;
  // Names what the free-text query was read as, so the answer can say "Coca-Cola
  // (KO)" instead of quietly answering about a ticker the user never typed.
  return {
    ...res,
    evidence: {
      ...res.evidence,
      resolvedQuery: { asked: query, symbol: match.symbol ?? null, address: match.address },
    },
  };
}
