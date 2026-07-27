import { gatherEvidence } from "./ask-evidence.js";
import {
  DEFAULT_MOVER_METRIC,
  clampLimit,
  compareTargets,
  marketOverview,
  metricOrNull,
  rankStocks,
  resolveDirection,
  resolveMetric,
  safetyReport,
  topMovers,
} from "./market-evidence.js";
import { resolveSymbol } from "./stock-tokens.js";
import {
  MAX_HOLDER_ROWS,
  MAX_SEARCH_ROWS,
  MAX_TRANSFER_ROWS,
  MAX_WHALE_ROWS,
  clampRows,
  contractInfo,
  flagPatterns,
  searchTokens,
  tokenHolders,
  tokenTransfers,
  whaleMoves,
} from "./token-evidence.js";
import {
  MAX_COUNTERPARTY_ROWS,
  clampCount,
  traceWallet,
  walletCounterparties,
  walletPortfolio,
} from "./wallet-evidence.js";

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
 * the interface it routes through — seventeen tools, and one dispatcher that
 * turns a tool call back into the evidence gatherers we already have.
 *
 * Seven of them answer a whole question in one shape ("tell me about NVDA", "rank
 * them", "is this legit"). Five go DEEPER into one token — its holders, its
 * recent transfers, the patterns in that flow, its deployment record, and a
 * search for a half-remembered ticker. The last five are the WALLET and MARKET
 * side of the same idea: what one address holds, what it did in one token, who
 * it deals with, the biggest recent moves in a ticker, and what is actually busy
 * across the board. They are separate tools rather than fields on lookup_token
 * and lookup_wallet because folding them in would mean every casual question
 * paid for every slice of it.
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
  {
    type: "function",
    function: {
      name: "token_holders",
      description:
        "Get the RANKED HOLDER LIST for ONE token: who holds it, how much each address holds, what share of total supply that is, and how much of the supply the top 10 and top 25 addresses sit on between them. " +
        "Use this whenever the question is about ownership or concentration rather than about price, however casually phrased and in any language: \"who holds nvda\", \"whos got the most\", \"top holders\", \"is this concentrated\", \"how much does the biggest wallet have\", \"whales\", \"quien tiene mas\". " +
        "The query may be a ticker in any case, a company name or a 0x contract address — all are resolved for you. Set limit to how many rows the user asked for (1 to 100); leave it out for 25. " +
        "lookup_token already gives a short holder summary — use this one when the holders ARE the question.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "A ticker (\"NVDA\", \"nvda\"), a company name (\"nvidia\") or a 0x token contract address.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "How many holders to return, 1 to 100. Default 25.",
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
      name: "token_transfers",
      description:
        "Get the RECENT TRANSFERS of ONE token — time, sender, recipient, amount and transaction hash for each, newest first. " +
        "Use this whenever the question is about movement or activity in a specific token, in any phrasing, casing or language: \"whats moving in nvda\", \"recent transfers\", \"has anything happened today\", \"whos been buying\", \"show me the flow\", \"any activity\", \"que se ha movido\". " +
        "The query may be a ticker in any case, a company name or a 0x contract address. Set limit to how many rows the user asked for (1 to 100); leave it out for 25. " +
        "This lists what moved; use flag_patterns when the question is what that movement LOOKS like, and lookup_wallet when the subject is one address rather than one token.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "A ticker (\"NVDA\", \"nvda\"), a company name (\"nvidia\") or a 0x token contract address.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "How many transfers to return, 1 to 100. Default 25.",
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
      name: "flag_patterns",
      description:
        "Run four fixed, explainable checks over ONE token's recent transfers and holder list, and report what they observed: several addresses moving near-identical amounts inside a short window, one address holding a dominant share of supply, one-way distribution out of a small set of senders, and transfers clustered into a very tight window. " +
        "Use this when the question is about how the activity LOOKS rather than what it is, in any phrasing or language: \"does this look organised\", \"is this wash trading\", \"anything weird here\", \"looks sus\", \"is someone farming this\", \"esto se ve raro\". " +
        "Each finding comes back with the exact addresses, amounts and timestamps behind it — repeat that evidence. These are OBSERVATIONS, never verdicts: never present one as proof of manipulation, fraud or intent, and never attach a likelihood to it. " +
        "An empty findings list means the checks ran and matched nothing, which is a real answer worth saying — say the checks found nothing to flag, not that the lookup failed. Use safety_check instead when the question is whether a contract is the genuine one.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "A ticker (\"NVDA\", \"nvda\"), a company name (\"nvidia\") or a 0x token contract address.",
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
      name: "contract_info",
      description:
        "Get the DEPLOYMENT RECORD of ONE contract: whether its source is published and verified, who deployed it, the transaction that created it, how old it is, and whether the deployer is Robinhood's official equity issuer. " +
        "Use this whenever the question is about the contract itself rather than its market, in any phrasing, casing or language: \"who deployed this\", \"when was it created\", \"is the contract verified\", \"how old is this token\", \"is the source published\", \"quien lo desplego\". " +
        "The query may be a ticker in any case, a company name or a 0x contract address. " +
        "This is a different question from safety_check: that one asks whether a token is the genuine one for its ticker and names the impostors; this one describes the contract's own provenance, and a contract can be genuine but brand new, or verified but not Robinhood's.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "A ticker (\"NVDA\", \"nvda\"), a company name (\"nvidia\") or a 0x contract address.",
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
      name: "search_tokens",
      description:
        "SEARCH Robinhood Chain for tokens whose name or symbol matches a partial or half-remembered string, ranked, with each result marked as an issuer-verified tokenized equity or not. " +
        "Use this when the user does not know the exact ticker, in any phrasing, casing or language: \"whats that nvidia one called\", \"find tokens with berk in the name\", \"is there a coca cola token\", \"search for gold\", \"which tickers start with mc\", \"busca tokens de apple\". " +
        "Pass just the fragment they remember, not their whole sentence. Several contracts on this chain wear the same ticker, so the results include lookalikes beside the genuine contract — say which rows are issuer-verified and which are not. " +
        "Set limit to how many results to show (1 to 25); leave it out for 10. Once the right ticker is identified, use lookup_token for its numbers or safety_check for a verdict on one contract.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "The partial ticker, token name or company to search for (\"nvid\", \"berk\", \"coca cola\").",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 25,
            description: "How many results to return, 1 to 25. Default 10.",
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
      name: "wallet_portfolio",
      description:
        "List EVERYTHING one 0x wallet holds: each token, how much of it, what that is worth in USD where the token has a price, and the wallet's ETH balance — sorted by value, biggest position first. " +
        "Use this whenever the question is about what an address is HOLDING rather than what it has done, however casually phrased and in any language: \"whats in this wallet\", \"whats this guy holding\", \"how much is 0xabc worth\", \"show me the bags\", \"does it hold any nvda\", \"que tiene esta wallet\". " +
        "Only the issuer-verified tokenized equities carry a price on this chain, so some holdings come back with no value: that is unpriced, never worthless, and the total covers the priced holdings only — say how many could not be valued. " +
        "Use lookup_wallet for a general picture of an address, trace_wallet for what it did in ONE token, and wallet_counterparties for who it deals with.",
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
      name: "trace_wallet",
      description:
        "Trace what ONE wallet has done in ONE token: how many times it received and how many times it sent, when it first and last moved, its net position across that history, what it holds now, and whether it has EVER sold. " +
        "Use this for any question about one address's behaviour in one ticker, in any phrasing, casing or language: \"has this wallet ever sold nvda\", \"is this guy accumulating\", \"when did they start buying tsla\", \"did they dump\", \"ha vendido alguna vez\". " +
        "Pass the wallet as address and the token as token — the token may be a ticker in any case (\"nvda\", \"$TSLA\"), a company name (\"apple\") or a 0x contract address. " +
        "The history walked is CAPPED. If the result's hasSold is null, no sale appeared in the transfers that could be read and whether it has ever sold is UNKNOWN — report that as \"no sale in the transfers read\", never as \"never sold\".",
      parameters: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "The wallet to trace — 0x followed by exactly 40 hex characters.",
          },
          token: {
            type: "string",
            description:
              "The token to trace it in: a ticker (\"NVDA\", \"nvda\"), a company name (\"nvidia\") or a 0x contract address.",
          },
        },
        required: ["address", "token"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wallet_counterparties",
      description:
        "List who a 0x address actually interacts with, ranked by how many interactions appear in its recent activity, each with a direction — sent to, received from, or both — and a mark on any counterparty that is one of Robinhood's verified tokenized-equity contracts. " +
        "Use this whenever the question is about relationships rather than balances, in any phrasing, casing or language: \"who does this wallet trade with\", \"who is it sending to\", \"whos on the other side of this\", \"is it touching the nvda contract\", \"con quien opera\". " +
        "It counts a recent sample of this address's transactions and token transfers, not its whole life, so the ranking is who it has dealt with LATELY — say so rather than calling a row its biggest counterparty ever. " +
        "Set limit to how many rows the user asked for (1 to 50); leave it out for 15.",
      parameters: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "The address whose counterparties to list — 0x followed by exactly 40 hex characters.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "How many counterparties to return, 1 to 50. Default 15.",
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
      name: "whale_moves",
      description:
        "List the LARGEST recent transfers of one token by amount, each with what share of total supply it moved and whether it was a mint, a burn or an ordinary transfer. This is the lookup for \"who is dumping\". " +
        "Use it whenever the question is about big movements in a specific token, however casually phrased and in any language: \"whos dumping nvda\", \"any whale moves\", \"biggest transfers today\", \"has someone sold a load of tsla\", \"who moved size\", \"quien esta vendiendo\". " +
        "The query may be a ticker in any case, a company name or a 0x contract address. Set limit to how many rows the user asked for (1 to 25); leave it out for 15. " +
        "These are the largest transfers WITHIN the recent sample the indexer returned — never the largest in the token's history — and a row marked mint or burn is not somebody selling. Use token_transfers when the question is what moved most RECENTLY rather than what moved biggest.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "A ticker (\"NVDA\", \"nvda\"), a company name (\"nvidia\") or a 0x token contract address.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 25,
            description: "How many transfers to return, 1 to 25. Default 15.",
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
      name: "top_movers",
      description:
        "List the most ACTIVE tokenized equities on Robinhood Chain right now — ranked on 24h volume by default — with each one's share of the combined total. " +
        "Use this for any question about what is busy or moving across the market rather than about one ticker, however casual or slangy the phrasing and in any language: \"whats moving\", \"whats hot today\", \"most active stocks\", \"whos got volume\", \"what is everyone trading\", \"que se esta moviendo\". " +
        "Choose metric from what was asked: volume24h for trading activity (the default), marketCap for size, holders for how widely held, price for per-token price. Set limit to the number asked for (1 to 25); leave it out for 10. " +
        "Only the equities the indexer published a figure for can appear here; the rest come back counted as unmeasured, which is missing data and not zero activity. Use rank_stocks when the user wants the biggest or smallest by a metric, and market_overview when they want the board as a whole.",
      parameters: {
        type: "object",
        properties: {
          metric: {
            type: "string",
            enum: ["volume24h", "marketCap", "holders", "price"],
            description:
              "What counts as \"moving\". volume24h = 24h trading activity (default), marketCap = size, holders = how many addresses hold it, price = price per token.",
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
  "token_holders",
  "token_transfers",
  "flag_patterns",
  "contract_info",
  "search_tokens",
  "wallet_portfolio",
  "trace_wallet",
  "wallet_counterparties",
  "whale_moves",
  "top_movers",
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
 * The shared coercion for the four token-side tools that take one target and
 * nothing else but a row count.
 *
 * They all accept exactly what lookup_token accepts — a ticker in any case, a
 * company name, a 0x contract address — so the rules are the same ones, in one
 * place: the wrong key still carries the value, a bare string stands in for the
 * arguments object, the user's whole sentence is refused rather than searched
 * for, a transaction hash is redirected to the tool that reads one, and a
 * TRUNCATED 0x string is refused outright. That last one is the reason this is
 * not just `pickString`: "0xabc" fuzzy-matched against the token search can hit
 * some unrelated contract named after the fragment, and a holder table drawn for
 * the wrong contract is worse than an error sentence.
 *
 * @param {unknown} args
 * @param {string} purpose - the tool name, quoted back so the model can retry
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
function coerceTokenTarget(args, purpose) {
  const value = pickString(args, [
    "query",
    "token",
    "symbol",
    "ticker",
    "name",
    "company",
    "address",
    "contract",
    "target",
  ]);
  const checked = checkTargetString(value, { argName: "query", purpose });
  if (!checked.ok) return checked;
  if (TX_RE.test(value)) {
    return err(
      `${value} is a transaction hash (64 hex characters), not a token. Use lookup_transaction for it, or pass a ticker such as "nvda".`,
    );
  }
  return checked;
}

/**
 * token_holders' arguments. Never fails on the limit alone: a holder list is
 * answerable at the default depth, so a limit of 999 is clamped to 100 rather
 * than costing a round trip to learn the bound. The clamp is safe to be silent
 * because the evidence echoes both `limit` and `rowsShown` back, so an answer
 * cannot claim to have read a hundred rows it did not get.
 *
 * @returns {{ ok: true, value: string, limit: number } | { ok: false, error: string }}
 */
export function coerceHolderArgs(args) {
  const target = coerceTokenTarget(args, "token_holders");
  if (!target.ok) return target;
  return { ok: true, value: target.value, limit: clampRows(pickCount(args), 25, MAX_HOLDER_ROWS) };
}

/**
 * token_transfers' arguments. Same shape and the same silent clamp as above.
 * @returns {{ ok: true, value: string, limit: number } | { ok: false, error: string }}
 */
export function coerceTransferArgs(args) {
  const target = coerceTokenTarget(args, "token_transfers");
  if (!target.ok) return target;
  return { ok: true, value: target.value, limit: clampRows(pickCount(args), 25, MAX_TRANSFER_ROWS) };
}

/**
 * flag_patterns' `query`. One target, no options — the checks and their
 * thresholds are fixed in lib/token-evidence.js and are deliberately not
 * something a caller can tune, because a threshold the model chose per question
 * would make the findings unreproducible.
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function coercePatternQuery(args) {
  return coerceTokenTarget(args, "flag_patterns");
}

/**
 * contract_info's `query`.
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function coerceContractQuery(args) {
  return coerceTokenTarget(args, "contract_info");
}

/**
 * search_tokens' arguments.
 *
 * Looser than the others by design: the whole point is a fragment nobody can
 * resolve yet, so "nvid", "coca cola" and "gold" all have to survive where
 * coerceTokenQuery's callers would resolve them or fail. Two guards remain — the
 * length cap, because the user's whole sentence matches nothing, and the
 * truncated-0x refusal, because a half-copied address must not be searched for
 * as a string and matched against a name.
 *
 * @returns {{ ok: true, value: string, limit: number } | { ok: false, error: string }}
 */
export function coerceSearchArgs(args) {
  const value = pickString(args, ["query", "q", "search", "term", "text", "name", "symbol", "ticker", "token"]);
  if (!value) {
    return err(
      'Missing "query". Call search_tokens again with the fragment the user remembers, e.g. "nvid" or "coca cola".',
    );
  }
  if (value.length > MAX_QUERY_CHARS) {
    return err(
      `"query" is too long (${value.length} characters). Search for the ticker or name fragment alone, not the user's whole question.`,
    );
  }
  if (/^0x/i.test(value) && !ADDRESS_RE.test(value)) {
    return err(
      `"${value}" is a truncated 0x value, and searching for it by name would match some unrelated contract. Pass the full 40-hex address, or the ticker or name to search for.`,
    );
  }
  return { ok: true, value, limit: clampRows(pickCount(args), 10, MAX_SEARCH_ROWS) };
}

/** The row count out of whichever key the model put it under. */
function pickCount(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  return args.limit ?? args.count ?? args.n ?? args.top ?? args.rows ?? args.size;
}

/**
 * The shared coercion for every tool whose subject is a WALLET.
 *
 * Strict, where the token-side coercion is forgiving: a token target can be a
 * ticker, a company name or an address and the resolver sorts it out, but an
 * address has exactly one shape and a near-miss cannot be resolved into the
 * right one. So a 64-hex hash is named as the other tool's job rather than
 * rejected as junk, a ticker is pointed at lookup_token, and everything else
 * says what an address actually looks like.
 *
 * @param {unknown} args
 * @param {string} purpose - the tool name, quoted back so the model can retry
 * @param {string[]} keys - the argument names that may carry the address
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
function coerceWalletAddress(args, purpose, keys = ["address", "wallet", "account", "holder", "query", "target"]) {
  const value = pickString(args, keys);
  if (!value) {
    return err(`Missing "address". Call ${purpose} again with a 0x address (0x followed by 40 hex characters).`);
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
 * lookup_wallet's `address`.
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function coerceAddressArg(args) {
  return coerceWalletAddress(args, "lookup_wallet");
}

/**
 * wallet_portfolio's `address`. Same rules; only the retry hint differs.
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function coercePortfolioArgs(args) {
  return coerceWalletAddress(args, "wallet_portfolio");
}

/**
 * wallet_counterparties' arguments. Never fails on the limit alone — the same
 * silent clamp the holder and transfer lists use, and safe for the same reason:
 * the evidence echoes `limit` and `rowsShown` back, so an answer cannot claim to
 * have read fifty counterparties it did not get.
 *
 * @returns {{ ok: true, value: string, limit: number } | { ok: false, error: string }}
 */
export function coerceCounterpartyArgs(args) {
  const address = coerceWalletAddress(args, "wallet_counterparties");
  if (!address.ok) return address;
  return { ok: true, value: address.value, limit: clampCount(pickCount(args), 15, MAX_COUNTERPARTY_ROWS) };
}

/**
 * trace_wallet's TWO arguments, which is what makes it the fiddliest call in the
 * catalogue: the model has to get a wallet and a token into the same object, and
 * the two are easy to swap or to merge into one field.
 *
 * So the address is looked for under the address-shaped keys first and, failing
 * that, under `query`/`target` — but only if what is there is actually
 * address-shaped, because those keys are just as likely to be carrying the
 * ticker. Whatever was taken as the address is then excluded from the token
 * search, so a single `{ query: "0xabc…" }` cannot end up tracing an address in
 * itself. Both halves are required: a trace with no token is a portfolio, and a
 * trace with no wallet is a transfer list, and each of those is another tool.
 *
 * @returns {{ ok: true, address: string, token: string } | { ok: false, error: string }}
 */
export function coerceTraceArgs(args) {
  const direct = pickString(args, ["address", "wallet", "account", "holder", "owner"]);
  const loose = pickString(args, ["query", "target"]);
  const rawAddress = direct || (ADDRESS_RE.test(loose) ? loose : "");

  if (!rawAddress) {
    return err(
      'Missing the wallet. Call trace_wallet again with "address" set to a 0x wallet address (0x plus 40 hex characters) and "token" set to the ticker, company name or 0x contract to trace it in.',
    );
  }
  const address = coerceWalletAddress({ address: rawAddress }, "trace_wallet", ["address"]);
  if (!address.ok) return address;

  // Anything that is not the address itself. The address keys are searched too,
  // in case the model put the ticker under `wallet` and the wallet under `token`.
  const candidates = ["token", "symbol", "ticker", "contract", "name", "company", "query", "target", "address"];
  let token = "";
  for (const key of candidates) {
    const value = pickString(args, [key]);
    if (!value || value.toLowerCase() === address.value.toLowerCase()) continue;
    token = value;
    break;
  }

  if (!token) {
    return err(
      `Missing the token. Call trace_wallet again with "address" set to ${address.value} and "token" set to the ticker (e.g. "nvda"), company name or 0x contract address to trace it in. To see everything that wallet holds instead, use wallet_portfolio.`,
    );
  }
  const checked = checkTargetString(token, { argName: "token", purpose: "trace_wallet" });
  if (!checked.ok) return checked;
  if (TX_RE.test(token)) {
    return err(
      `${token} is a transaction hash, not a token. Use lookup_transaction for it, or pass a ticker such as "nvda" as "token".`,
    );
  }
  return { ok: true, address: address.value, token };
}

/**
 * whale_moves' arguments — the same token target the other token-side tools
 * take, with its own tighter row bound.
 * @returns {{ ok: true, value: string, limit: number } | { ok: false, error: string }}
 */
export function coerceWhaleArgs(args) {
  const target = coerceTokenTarget(args, "whale_moves");
  if (!target.ok) return target;
  return { ok: true, value: target.value, limit: clampRows(pickCount(args), 15, MAX_WHALE_ROWS) };
}

/**
 * top_movers' arguments, always valid — for the reason coerceRankArgs is.
 *
 * The one thing it does NOT share with a ranking is the default: an unrecognized
 * metric there falls back to market cap, and here it falls back to 24h volume,
 * because "what's moving" is a question about activity and answering it with a
 * size ranking would answer a different one. metricOrNull is what makes the two
 * defaults possible from one alias table.
 *
 * @returns {{ metric: string, limit: number }}
 */
export function coerceMoverArgs(args) {
  const source = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const raw = pickString(source, ["metric", "by", "sort", "sortBy", "sort_by", "field"]);
  return {
    metric: metricOrNull(raw) ?? DEFAULT_MOVER_METRIC,
    limit: clampLimit(pickCount(source), 10),
  };
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

/* ------------------------------ what a call is about ------------------------------ */

/** How each sortable field is said out loud. */
const METRIC_WORDS = Object.freeze({
  marketCap: "market cap",
  holders: "holders",
  price: "price",
  volume24h: "24h volume",
});

/** 0x1234567890abcdef… -> "0x1234…cdef". The form every surface here uses. */
function shortHex(value) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** A target as a person would read it: SHOUTED ticker, shortened hex, plain name. */
function displayTarget(value) {
  const v = String(value ?? "").trim();
  if (!v) return null;
  if (ADDRESS_RE.test(v) || TX_RE.test(v)) return shortHex(v);
  const bare = v.replace(/^\$/, "");
  return /^[A-Za-z]{1,6}$/.test(bare) ? bare.toUpperCase() : bare;
}

/**
 * What a tool call is ABOUT, in a few words — for the status line the user reads
 * while the lookup runs ("pulling NVDA", "reading 0x4783…C046").
 *
 * Derived from the COERCED arguments, not the raw ones, and that is the whole
 * point: the model sends the value under `symbol` when the schema says `query`,
 * sends "$nvda" where the answer says NVDA, and sends `by: "market cap"` where
 * the field is `metric`. Reading the raw object would show the user a blank
 * status for a lookup that is running perfectly well. Running it through the same
 * coercers dispatchTool uses means the label names the thing the lookup will
 * actually be about, or nothing at all.
 *
 * Returns null rather than a guess: a malformed call has no honest subject, and
 * the step's own phrase ("pulling the ticker") is the right thing to show for it.
 * Never throws — a status line must not be able to fail a request.
 *
 * @param {unknown} name - a tool name, ideally one of TOOL_NAMES
 * @param {unknown} args - the model's arguments, trusted for nothing
 * @returns {string|null}
 */
export function toolSubject(name, args) {
  const tool = typeof name === "string" ? name.trim() : "";
  try {
    if (tool === "lookup_token") {
      const q = coerceTokenQuery(args);
      return q.ok ? displayTarget(q.value) : null;
    }
    if (tool === "safety_check") {
      const t = coerceSafetyTarget(args);
      return t.ok ? displayTarget(t.value) : null;
    }
    if (tool === "lookup_wallet") {
      const a = coerceAddressArg(args);
      return a.ok ? displayTarget(a.value) : null;
    }
    if (tool === "lookup_transaction") {
      const h = coerceHashArg(args);
      return h.ok ? displayTarget(h.value) : null;
    }
    if (tool === "token_holders") {
      const h = coerceHolderArgs(args);
      return h.ok ? displayTarget(h.value) : null;
    }
    if (tool === "token_transfers") {
      const t = coerceTransferArgs(args);
      return t.ok ? displayTarget(t.value) : null;
    }
    if (tool === "flag_patterns") {
      const p = coercePatternQuery(args);
      return p.ok ? displayTarget(p.value) : null;
    }
    if (tool === "contract_info") {
      const c = coerceContractQuery(args);
      return c.ok ? displayTarget(c.value) : null;
    }
    if (tool === "search_tokens") {
      // Not displayTarget: a search subject is a fragment, not an identifier, and
      // upper-casing "coca cola" into a ticker would misname the work.
      const s = coerceSearchArgs(args);
      return s.ok ? s.value : null;
    }
    if (tool === "wallet_portfolio") {
      const a = coercePortfolioArgs(args);
      return a.ok ? displayTarget(a.value) : null;
    }
    if (tool === "wallet_counterparties") {
      const a = coerceCounterpartyArgs(args);
      return a.ok ? displayTarget(a.value) : null;
    }
    if (tool === "trace_wallet") {
      // Both halves, because either alone misnames the work: "tracing NVDA"
      // does not say whose position, and "tracing 0x4783…C046" does not say in
      // what. Short enough for the status row — see cleanSubject's 28-char cap.
      const t = coerceTraceArgs(args);
      if (!t.ok) return null;
      const token = displayTarget(t.token);
      return token ? `${token} in ${shortHex(t.address)}` : null;
    }
    if (tool === "whale_moves") {
      const w = coerceWhaleArgs(args);
      return w.ok ? displayTarget(w.value) : null;
    }
    if (tool === "rank_stocks") {
      // Always valid — a ranking with no arguments is the biggest ten.
      return METRIC_WORDS[coerceRankArgs(args).metric] ?? null;
    }
    if (tool === "top_movers") {
      // Always valid too — "what's moving" with no arguments is 24h volume.
      return METRIC_WORDS[coerceMoverArgs(args).metric] ?? null;
    }
    if (tool === "compare_tokens") {
      const list = coerceCompareQueries(args);
      if (!list.ok) return null;
      // Three at most: a fourth entry pushes the status line past one line.
      const shown = list.value.slice(0, 3).map(displayTarget).filter(Boolean);
      return shown.length ? shown.join(" vs ") : null;
    }
    // market_overview names nothing: the whole board is the subject.
    return null;
  } catch {
    return null;
  }
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
  tokenHolders,
  tokenTransfers,
  flagPatterns,
  contractInfo,
  searchTokens,
  walletPortfolio,
  traceWallet,
  walletCounterparties,
  whaleMoves,
  topMovers,
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

    if (tool === "token_holders") {
      const h = coerceHolderArgs(args);
      if (!h.ok) return h;
      return await fns.tokenHolders(h.value, { limit: h.limit });
    }

    if (tool === "token_transfers") {
      const t = coerceTransferArgs(args);
      if (!t.ok) return t;
      return await fns.tokenTransfers(t.value, { limit: t.limit });
    }

    if (tool === "flag_patterns") {
      const p = coercePatternQuery(args);
      if (!p.ok) return p;
      return await fns.flagPatterns(p.value);
    }

    if (tool === "contract_info") {
      const c = coerceContractQuery(args);
      if (!c.ok) return c;
      return await fns.contractInfo(c.value);
    }

    if (tool === "search_tokens") {
      const s = coerceSearchArgs(args);
      if (!s.ok) return s;
      return await fns.searchTokens(s.value, { limit: s.limit });
    }

    if (tool === "wallet_portfolio") {
      const a = coercePortfolioArgs(args);
      if (!a.ok) return a;
      return await fns.walletPortfolio(a.value);
    }

    if (tool === "trace_wallet") {
      const t = coerceTraceArgs(args);
      if (!t.ok) return t;
      return await fns.traceWallet(t.address, t.token);
    }

    if (tool === "wallet_counterparties") {
      const c = coerceCounterpartyArgs(args);
      if (!c.ok) return c;
      return await fns.walletCounterparties(c.value, { limit: c.limit });
    }

    if (tool === "whale_moves") {
      const w = coerceWhaleArgs(args);
      if (!w.ok) return w;
      return await fns.whaleMoves(w.value, { limit: w.limit });
    }

    if (tool === "top_movers") {
      return await fns.topMovers(coerceMoverArgs(args));
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
