/**
 * THE WAIT, SAID OUT LOUD — the status words shown while a question is answered.
 *
 * The measured shape of a lookup is not going to change: Blockscout answers
 * getAddress in 5179ms, getTokenActivity in 4516ms and getTokenHolders in
 * 4332ms, so a ticker question is roughly 5.6 seconds end to end no matter how
 * well the calls are parallelised. That time is spent on real work, and the only
 * honest thing to do with it is say what the work IS. Three animated dots say
 * nothing; a line that reads "counting the float" says the holder list is being
 * read, and the same five seconds stop feeling like a stall.
 *
 * Two rules make that trustworthy rather than decorative:
 *
 *  1. THE PHRASE IS PINNED TO THE STEP. Every pool below belongs to one kind of
 *     work, and lib/ask-runner.js emits the step alongside the label, so a holder
 *     lookup cannot say it is reading the tape and the answer turn cannot claim
 *     to be verifying a deployer. A status line that lies about what is happening
 *     is worse than no status line.
 *  2. NOTHING HERE IS CUTESY ABOUT MONEY. The audience trades on this chain.
 *     Market vocabulary — the tape, the float, the cap table, the ledger — is
 *     theirs and reads as competence; a joke about someone's position does not.
 *
 * The phrases are original to this product. They are lowercase and short because
 * they sit in a mono status row beside a spinner-sized avatar, and a line that
 * wraps at 360px would move the transcript while it rotates.
 *
 * Pure data plus three lookups: no I/O, no state, no React. Imported by
 * lib/ask-runner.js on the server (to label the event) and by
 * components/ask/Conversation.jsx on the client (to rotate through the pool).
 */

/**
 * The steps a progress event can name. `step` doubles as the phrase-pool key —
 * one name, so the event, the pool and the client's rotation cannot disagree.
 */
export const PHRASE_STEPS = Object.freeze({
  ROUTING: "routing",
  TOKEN: "token",
  WALLET: "wallet",
  TRANSACTION: "transaction",
  RANKING: "ranking",
  MARKET: "market",
  COMPARE: "compare",
  SAFETY: "safety",
  HOLDERS: "holders",
  TRANSFERS: "transfers",
  PATTERNS: "patterns",
  HOLD_TIME: "holdTime",
  BUNDLE: "bundle",
  OVERLAP: "overlap",
  CO_HOLDINGS: "coHoldings",
  CONTRACT: "contract",
  SEARCH: "search",
  PORTFOLIO: "portfolio",
  TRACE: "trace",
  COUNTERPARTIES: "counterparties",
  WHALES: "whales",
  MOVERS: "movers",
  CLARIFY: "clarify",
  WRITING: "writing",
});

/**
 * The pools, one per step. Rotated through in order while that step is the work
 * in flight, so the first phrase of each pool is the one most likely to be seen
 * and reads as the plainest description of the step.
 */
export const THINKING_PHRASES = Object.freeze({
  [PHRASE_STEPS.ROUTING]: Object.freeze([
    "reading the question",
    "picking the right ledger",
    "lining up the lookup",
    "working out what to pull",
    "checking what's on the board",
  ]),
  [PHRASE_STEPS.TOKEN]: Object.freeze([
    "pulling the ticker",
    "marking it to market",
    "counting the float",
    "reading the contract",
    "checking the last print",
    "sizing up the cap",
  ]),
  [PHRASE_STEPS.WALLET]: Object.freeze([
    "walking the wallet",
    "tallying the holdings",
    "following the money",
    "reading the balances",
    "seeing who it trades with",
  ]),
  [PHRASE_STEPS.TRANSACTION]: Object.freeze([
    "checking the ledger",
    "unpacking the transfer",
    "reading the receipt",
    "tracing the hops",
    "counting what moved",
  ]),
  [PHRASE_STEPS.RANKING]: Object.freeze([
    "sorting the board",
    "stacking them by size",
    "running the leaderboard",
    "lining up the field",
    "putting them in order",
  ]),
  [PHRASE_STEPS.MARKET]: Object.freeze([
    "reading the tape",
    "scanning the listings",
    "totting up the board",
    "taking the market's measure",
    "adding up the caps",
  ]),
  [PHRASE_STEPS.COMPARE]: Object.freeze([
    "setting them side by side",
    "number against number",
    "measuring the gap",
    "weighing both books",
  ]),
  [PHRASE_STEPS.SAFETY]: Object.freeze([
    "checking the paperwork",
    "matching the deployer",
    "walking the cap table",
    "comparing the contracts",
    "asking who minted it",
  ]),
  // The seven deeper token lookups. Each pool has to be distinguishable from the
  // TOKEN one at a glance: they run on the same subject and often in the same
  // answer, so "pulling the ticker" appearing for a holder walk would tell the
  // reader the wrong thing about what the five seconds are being spent on.
  [PHRASE_STEPS.HOLDERS]: Object.freeze([
    "reading the cap table",
    "ranking the holders",
    "counting the float",
    "sizing the top of the book",
    "seeing who's actually holding",
  ]),
  [PHRASE_STEPS.TRANSFERS]: Object.freeze([
    "walking the transfers",
    "reading the last prints",
    "following the flow",
    "listing what moved",
    "pulling the blotter",
  ]),
  [PHRASE_STEPS.PATTERNS]: Object.freeze([
    "reading the shape of the flow",
    "matching amounts against each other",
    "checking the timing",
    "looking for clustering",
    "seeing which way it moves",
  ]),
  // Both of these walk each top holder's first acquisition, which takes seconds
  // and looks like nothing from outside. The pools say WHOSE history is being
  // read, so the wait reads as work on the cap table rather than as a stall.
  [PHRASE_STEPS.HOLD_TIME]: Object.freeze([
    "dating the top holders",
    "finding when they first bought",
    "walking each holder back",
    "measuring how long they've held",
    "sorting the old money from the new",
  ]),
  [PHRASE_STEPS.BUNDLE]: Object.freeze([
    "checking when they each arrived",
    "lining the first buys up",
    "looking for a cluster",
    "seeing who came in together",
    "comparing the entry blocks",
  ]),
  // These two are the longest waits in the catalogue — an overlap can be thirteen
  // holder pages and a co-holding run is one portfolio read per holder. The pools
  // name BOTH SIDES of the work, because the wait itself is the reader's only
  // assurance that the second token is being read rather than quietly dropped.
  [PHRASE_STEPS.OVERLAP]: Object.freeze([
    "reading both cap tables",
    "crossing the holder lists",
    "looking for wallets in both",
    "matching one list against the other",
    "finding the addresses they share",
  ]),
  [PHRASE_STEPS.CO_HOLDINGS]: Object.freeze([
    "opening the holders' bags",
    "reading what else they hold",
    "walking each portfolio",
    "tallying their other positions",
    "seeing what this crowd is in",
  ]),
  [PHRASE_STEPS.CONTRACT]: Object.freeze([
    "reading the deployment",
    "finding who deployed it",
    "pulling the creation tx",
    "dating the contract",
    "checking the source",
  ]),
  [PHRASE_STEPS.SEARCH]: Object.freeze([
    "searching the listings",
    "matching the name",
    "sifting the tickers",
    "checking what answers to that",
    "turning up the candidates",
  ]),
  // The five wallet-and-board lookups. WALLET already exists and describes the
  // general "what is this address" walk, so these have to read as narrower work
  // than that one: a portfolio is being priced, a position is being traced
  // through one ticker, a counterparty list is being tallied.
  [PHRASE_STEPS.PORTFOLIO]: Object.freeze([
    "tallying the holdings",
    "pricing what it holds",
    "adding up the positions",
    "sorting the book by value",
    "checking what carries a price",
  ]),
  [PHRASE_STEPS.TRACE]: Object.freeze([
    "tracing the position",
    "counting the buys and sells",
    "walking its history in the name",
    "checking whether it ever sold",
    "netting it out",
  ]),
  [PHRASE_STEPS.COUNTERPARTIES]: Object.freeze([
    "mapping the counterparties",
    "seeing who it deals with",
    "counting the interactions",
    "checking both directions",
    "naming the other side",
  ]),
  [PHRASE_STEPS.WHALES]: Object.freeze([
    "looking for size",
    "finding the big prints",
    "measuring the moves against supply",
    "ranking the blocks",
    "seeing who moved the most",
  ]),
  [PHRASE_STEPS.MOVERS]: Object.freeze([
    "finding what's moving",
    "reading the volume",
    "sorting the board by activity",
    "seeing what's busy",
    "checking who has a bid",
  ]),
  // The one step where nothing is being read. ask_clarification returns without
  // touching the indexer, so this pool is on screen for a few hundred
  // milliseconds at most — and it must not sound like a lookup, because there
  // isn't one: what is happening is the question being weighed, not the chain.
  [PHRASE_STEPS.CLARIFY]: Object.freeze([
    "weighing the readings",
    "two ways to read that",
    "narrowing it down",
    "working out which one you mean",
  ]),
  [PHRASE_STEPS.WRITING]: Object.freeze([
    "writing it up",
    "putting numbers to words",
    "drafting the read",
    "checking the figures twice",
    "tightening the lines",
  ]),
});

/**
 * What a step with no pool falls back to. Never empty: the client renders
 * whatever this returns, and an empty status row is the one outcome worse than a
 * generic phrase.
 */
const GENERIC = Object.freeze(["reading the chain", "pulling the numbers", "checking the ledger"]);

/** Tool name -> the step whose phrases describe what that tool is doing. */
const TOOL_STEP = Object.freeze({
  lookup_token: PHRASE_STEPS.TOKEN,
  lookup_wallet: PHRASE_STEPS.WALLET,
  lookup_transaction: PHRASE_STEPS.TRANSACTION,
  rank_stocks: PHRASE_STEPS.RANKING,
  market_overview: PHRASE_STEPS.MARKET,
  compare_tokens: PHRASE_STEPS.COMPARE,
  safety_check: PHRASE_STEPS.SAFETY,
  token_holders: PHRASE_STEPS.HOLDERS,
  token_transfers: PHRASE_STEPS.TRANSFERS,
  flag_patterns: PHRASE_STEPS.PATTERNS,
  holder_hold_time: PHRASE_STEPS.HOLD_TIME,
  bundle_check: PHRASE_STEPS.BUNDLE,
  holder_overlap: PHRASE_STEPS.OVERLAP,
  co_holdings: PHRASE_STEPS.CO_HOLDINGS,
  contract_info: PHRASE_STEPS.CONTRACT,
  search_tokens: PHRASE_STEPS.SEARCH,
  wallet_portfolio: PHRASE_STEPS.PORTFOLIO,
  trace_wallet: PHRASE_STEPS.TRACE,
  wallet_counterparties: PHRASE_STEPS.COUNTERPARTIES,
  whale_moves: PHRASE_STEPS.WHALES,
  top_movers: PHRASE_STEPS.MOVERS,
  ask_clarification: PHRASE_STEPS.CLARIFY,
});

/**
 * The step a tool call belongs to. An unknown tool — a new one, or a name the
 * model invented — is still work in progress, so it gets the routing pool rather
 * than nothing.
 *
 * @param {unknown} tool
 * @returns {string}
 */
export function stepForTool(tool) {
  const name = typeof tool === "string" ? tool.trim() : "";
  return TOOL_STEP[name] ?? PHRASE_STEPS.ROUTING;
}

/**
 * The phrases for one step, in rotation order.
 *
 * @param {unknown} step
 * @returns {readonly string[]} never empty
 */
export function phrasesFor(step) {
  const key = typeof step === "string" ? step.trim() : "";
  return THINKING_PHRASES[key] ?? GENERIC;
}

/**
 * Subject text as it may appear in a status line: one line, no control
 * characters, short enough not to wrap the row.
 *
 * The subject comes from the model's tool arguments, which come from the user's
 * question — untrusted text on its way to the screen. React escapes it, so the
 * job here is only to stop it from breaking the layout.
 */
function cleanSubject(subject) {
  const flat = String(subject ?? "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return "";
  return flat.length > 28 ? `${flat.slice(0, 27)}…` : flat;
}

/**
 * The lead phrase for a step, naming the subject where there is one.
 *
 * This is the `label` the server puts on the progress event: it is the phrase
 * that agrees most exactly with the work, because it is the only one that can
 * carry the thing being looked at ("pulling NVDA" rather than "pulling the
 * ticker"). The client shows it first and then rotates through the rest of the
 * pool, which are subject-free by design — a phrase repeated with the ticker
 * glued onto it five times reads as a template, not as a status.
 *
 * @param {unknown} step - one of PHRASE_STEPS
 * @param {unknown} [subject] - a ticker, a shortened address, a metric name
 * @returns {string} never empty
 */
export function progressLabel(step, subject) {
  const key = typeof step === "string" ? step.trim() : "";
  const s = cleanSubject(subject);
  if (!s) return phrasesFor(key)[0];
  switch (key) {
    case PHRASE_STEPS.TOKEN:
      return `pulling ${s}`;
    case PHRASE_STEPS.WALLET:
      return `reading ${s}`;
    case PHRASE_STEPS.TRANSACTION:
      return `tracing ${s}`;
    case PHRASE_STEPS.RANKING:
      return `sorting the board by ${s}`;
    case PHRASE_STEPS.COMPARE:
      return `setting ${s} side by side`;
    case PHRASE_STEPS.SAFETY:
      return `checking who minted ${s}`;
    case PHRASE_STEPS.HOLDERS:
      return `reading ${s}'s cap table`;
    case PHRASE_STEPS.TRANSFERS:
      return `walking ${s} transfers`;
    case PHRASE_STEPS.PATTERNS:
      return `reading the flow in ${s}`;
    case PHRASE_STEPS.HOLD_TIME:
      return `dating ${s}'s top holders`;
    case PHRASE_STEPS.BUNDLE:
      return `checking when ${s} holders arrived`;
    // The subject already carries both tokens ("PIPECAT + MERRYMEN"), and it has to:
    // a status line naming one side of an overlap tells the reader the same story the
    // substituted answer told.
    case PHRASE_STEPS.OVERLAP:
      return `crossing ${s}`;
    case PHRASE_STEPS.CO_HOLDINGS:
      return `reading what ${s} holders also hold`;
    case PHRASE_STEPS.CONTRACT:
      return `checking who deployed ${s}`;
    case PHRASE_STEPS.SEARCH:
      return `searching for ${s}`;
    case PHRASE_STEPS.PORTFOLIO:
      return `pricing what ${s} holds`;
    // The subject here already carries both halves ("NVDA in 0x4783…C046"),
    // because a trace of a position is not named by either one alone.
    case PHRASE_STEPS.TRACE:
      return `tracing ${s}`;
    case PHRASE_STEPS.COUNTERPARTIES:
      return `mapping who ${s} deals with`;
    case PHRASE_STEPS.WHALES:
      return `looking for size in ${s}`;
    case PHRASE_STEPS.MOVERS:
      return `finding the movers by ${s}`;
    // None of these four has a subject to name: the board, the question, the
    // ambiguity in it and the writing are all about the whole turn.
    case PHRASE_STEPS.MARKET:
    case PHRASE_STEPS.ROUTING:
    case PHRASE_STEPS.CLARIFY:
    case PHRASE_STEPS.WRITING:
    default:
      return phrasesFor(key)[0];
  }
}
