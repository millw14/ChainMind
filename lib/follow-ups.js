/**
 * FOLLOW-UPS — the two or three chips offered under an answer that has settled.
 *
 * The empty state already has suggestion chips, and they work because a blank
 * transcript has no context to be wrong about. After an answer the same fixed
 * list is worse than nothing: "Read a wallet" under a wallet the user just read,
 * "Price a ticker" under a ranking of nine of them. A follow-up is only worth
 * offering if it continues THIS thread, so every chip here is derived from what
 * the answer actually contained — a holder the answer named, the deployer behind
 * the verdict, the second ticker in a ranking — and there is no fixed list to
 * fall back on.
 *
 * Three rules, and the third is the one that keeps this honest:
 *
 *  1. DERIVED, NOT AUTHORED. The inputs are the response's own `evidence`,
 *     `toolCalls` and tables. No chip exists that the answer did not supply the
 *     subject for.
 *  2. NEVER RE-ASK. A chip whose lookup is already in `toolCalls` would spend
 *     five seconds of indexer time to redraw what is on the screen, so anything
 *     the answer already looked up is filtered out by argument value.
 *  3. NEVER OFFER WHAT THE TOOLS CANNOT REACH. Every chip below maps onto one of
 *     the seven real tools: an address to lookup_wallet, a ticker to
 *     safety_check, rank_stocks or compare_tokens, the board to market_overview.
 *     The one that could go wrong is the full-table chip, and it is bounded — see
 *     FULL_TABLE_ROW_CAP. A chip that leads to "I could not do that" is worse
 *     than no chip, because the user pressed it on our invitation.
 *
 * Untrusted data crosses this module. A token's symbol comes off the chain and
 * anyone can mint one whose "symbol" is a sentence, so a symbol is only used when
 * it is ticker-shaped: a chip must never become a lever for putting attacker
 * text into the next question. Addresses are hex-tested for the same reason.
 *
 * Pure: no I/O, no state, no React. Safe to import from a client component.
 */

/** How many chips a settled answer offers. Two or three; never a wall of them. */
export const MAX_FOLLOW_UPS = 3;

/**
 * Icon names a chip can ask for. The client maps these onto the AskIcons set;
 * exported so that map can be checked against this list rather than guessed at.
 */
export const FOLLOW_UP_ICONS = Object.freeze(["table", "wallet", "shield", "rank", "compare", "trend"]);

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * A ticker as a chip may print and re-send it. Deliberately stricter than
 * anything the indexer will return: 1–12 characters, letters, digits, dot or
 * dash, no spaces. "NVDA" and "BRK.B" pass; a 16-character token "symbol" that
 * is really a sentence does not.
 */
const TICKER_RE = /^[A-Za-z][A-Za-z0-9.\-]{0,11}$/;

/**
 * The largest upstream row count worth offering to fetch in full.
 *
 * A table that says it is showing 25 of 28,899 holders is not one request away
 * from being complete — no tool here returns 28,899 rows, and a chip promising it
 * would be an invitation to a failure. Under this bound, asking for the rest is a
 * request a row-producing tool can plausibly serve, so the chip is offered; over
 * it, the chip is silently dropped.
 */
const FULL_TABLE_ROW_CAP = 100;

/** Metric field -> how a chip says it, and the counterpart to offer next. */
const METRICS = Object.freeze({
  marketCap: { word: "market cap", next: "holders" },
  holders: { word: "holder count", next: "marketCap" },
  price: { word: "price", next: "marketCap" },
  volume24h: { word: "24h volume", next: "marketCap" },
});

function isPlain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 0x4783C67b…C046 -> "0x4783…C046". Same shortening the answers use. */
function shortHex(value) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function asAddress(value) {
  return typeof value === "string" && ADDRESS_RE.test(value.trim()) ? value.trim() : null;
}

function asTicker(value) {
  const s = typeof value === "string" ? value.trim() : "";
  return s && TICKER_RE.test(s) ? s.toUpperCase() : null;
}

/**
 * The evidence blocks worth reading, one level deep.
 *
 * lib/ask-loop.js gives the evidence two shapes — one lookup returns its blob
 * bare, several return an object keyed by tool name — and the nested blocks a
 * single lookup carries (`token`, `stock`, `tokenizedEquities`) hold the symbols
 * and addresses this module is looking for. Flattening one level covers both
 * without either being special-cased. Deeper would start finding "addresses" in
 * whatever the indexer happens to nest next.
 */
function blocksOf(evidence) {
  if (!isPlain(evidence)) return [];
  const out = [evidence];
  for (const value of Object.values(evidence)) if (isPlain(value)) out.push(value);
  return out;
}

/** Every ticker the answer carried, in the order the evidence lists them. */
function symbolsIn(evidence) {
  const out = [];
  const add = (value) => {
    const t = asTicker(value);
    if (t && !out.includes(t)) out.push(t);
  };
  for (const block of blocksOf(evidence)) {
    add(block.symbol);
    // A ranking, an overview's three lists, and a comparison's entries.
    for (const key of ["rows", "items", "topByMarketCap", "topByHolders", "mostActive24h"]) {
      const list = block[key];
      if (!Array.isArray(list)) continue;
      for (const row of list) {
        // A comparison entry that could not be resolved has no numbers behind it,
        // so it is not something to offer a follow-up about.
        if (isPlain(row) && row.resolved !== false) add(row.symbol);
      }
    }
    // What a wallet holds and what a transaction moved: on those two answers the
    // ticker is the ONLY subject a follow-up can be about, and it lives under
    // `token` rather than `symbol`.
    for (const key of ["tokenHoldings", "recentTransfers", "tokenTransfers"]) {
      const list = block[key];
      if (!Array.isArray(list)) continue;
      for (const row of list) if (isPlain(row)) add(row.token);
    }
  }
  return out;
}

/** Every address the answer named, most interesting first. */
function addressesIn(evidence, tables) {
  const out = [];
  const add = (value) => {
    const a = asAddress(value);
    if (a && !out.some((v) => v.toLowerCase() === a.toLowerCase())) out.push(a);
  };

  for (const block of blocksOf(evidence)) {
    // The deployer behind a verdict is the single most useful next lookup there
    // is: "who minted this?" is what an impostor answer leaves the reader asking.
    add(block.deployer);
    for (const key of ["topHolders", "impostors"]) {
      const list = block[key];
      if (Array.isArray(list)) for (const row of list) if (isPlain(row)) add(row.address);
    }
    if (Array.isArray(block.counterparties)) for (const value of block.counterparties) add(value);
    add(block.from);
    add(block.to);
    add(block.creator);
    add(block.officialIssuer);
  }

  // A table from a tool this module has never heard of still names addresses in
  // its cells, and they are as good a follow-up as any block field.
  for (const table of tables) {
    const rows = Array.isArray(table?.rows) ? table.rows.slice(0, 12) : [];
    for (const row of rows) if (isPlain(row)) for (const value of Object.values(row)) add(value);
  }

  return out;
}

/** Addresses that are the answer's own subject, and so not a follow-up. */
function subjectsIn({ target, evidence, toolCalls }) {
  const seen = new Set();
  const add = (value) => {
    const a = asAddress(value);
    if (a) seen.add(a.toLowerCase());
  };
  add(target);
  for (const block of blocksOf(evidence)) {
    add(block.address);
    add(block.hash);
  }
  // Anything already looked up, by the value it was looked up with — the surest
  // test of "the answer on screen already covers this".
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    const args = call?.args;
    if (!isPlain(args)) continue;
    for (const value of Object.values(args)) {
      if (Array.isArray(value)) value.forEach(add);
      else add(value);
    }
  }
  return seen;
}

/** Which of the seven tools this answer already ran. */
function toolsUsed(toolCalls) {
  const set = new Set();
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    if (typeof call?.name === "string" && call.name.trim()) set.add(call.name.trim());
  }
  return set;
}

/** Tickers already looked up, so a chip cannot offer the same lookup twice. */
function tickersUsed(toolCalls) {
  const set = new Set();
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    const args = call?.args;
    if (!isPlain(args)) continue;
    for (const value of Object.values(args)) {
      const list = Array.isArray(value) ? value : [value];
      for (const entry of list) {
        const t = asTicker(entry);
        if (t) set.add(t);
      }
    }
  }
  return set;
}

/** "wallet-trace" -> "wallet trace". The noun a table's id is hiding. */
function nounFromId(id) {
  const slug = String(id ?? "").trim().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!slug || slug === "table") return "rows";
  return slug.length > 24 ? "rows" : slug;
}

/**
 * The metric a ranking was sorted on, if the evidence says so. rankStocks echoes
 * the field it actually sorted by, which is why this can be trusted to describe
 * the list on screen rather than what the user might have asked for.
 */
function rankingMetric(evidence) {
  for (const block of blocksOf(evidence)) {
    const metric = typeof block.metric === "string" ? block.metric.trim() : "";
    if (METRICS[metric]) return metric;
  }
  return null;
}

/**
 * The chips to offer under one settled answer.
 *
 * Order is priority: the most specific continuation first, the general "and the
 * market as a whole" last, and only the first MAX_FOLLOW_UPS survive. Returns
 * `[]` for anything with nothing to continue — a greeting, an error, an answer
 * that looked nothing up — rather than padding with something generic.
 *
 * @param {object} [answer]
 * @param {unknown} [answer.kind] - the gatherer's kind ("token", "ranking", …)
 * @param {unknown} [answer.target] - what the answer was about
 * @param {unknown} [answer.evidence] - the response's evidence, either shape
 * @param {unknown} [answer.toolCalls] - `[{ name, args }]`, what it looked up
 * @param {unknown} [answer.tables] - tables already extracted for the renderer
 * @returns {Array<{ id: string, icon: string, text: string, question: string }>}
 */
export function buildFollowUps({ kind, target, evidence, toolCalls, tables } = {}) {
  const tableList = (Array.isArray(tables) ? tables : []).filter(isPlain);
  const used = toolsUsed(toolCalls);

  // Nothing was looked up and nothing came back: a greeting, or a reply about
  // this product rather than about the chain. The empty state's own chips are the
  // right offer there, and this is not the place to duplicate them.
  if (!isPlain(evidence) && !used.size && !tableList.length) return [];

  const symbols = symbolsIn(evidence);
  const subject = subjectsIn({ target, evidence, toolCalls });
  const askedTickers = tickersUsed(toolCalls);
  const addresses = addressesIn(evidence, tableList).filter((a) => !subject.has(a.toLowerCase()));
  const chips = [];

  /** The subject a table is about, for a question that has to name it. */
  const tableSubject = asTicker(target) ?? symbols[0] ?? null;

  // 1. A table the answer only showed the top of, and the rest is within reach.
  for (const table of tableList) {
    // `Number(null)` is 0 and passes Number.isFinite, so coercing first would let
    // an UNKNOWN upstream total read as a real count of zero. The ordering of the
    // guards below happens to reject it anyway, which is exactly why it is worth
    // an explicit test: the chip text prints this number ("All 0 holders").
    const total = table.totalRows === null || table.totalRows === undefined ? NaN : Number(table.totalRows);
    const shown = Number(table.rowCount);
    if (!table.truncated || !Number.isFinite(total) || !Number.isFinite(shown)) continue;
    if (total <= shown || total > FULL_TABLE_ROW_CAP) continue;
    const noun = nounFromId(table.id);
    chips.push({
      id: `table:${table.id}`,
      icon: "table",
      text: `All ${total} ${noun}`,
      question: `List all ${total} ${noun}${tableSubject ? ` for ${tableSubject}` : ""} — the whole set, not just the top ${shown}.`,
    });
    break;
  }

  // 2. A specific address the answer named. The single most common thing a reader
  //    wants next: who is that holder, who deployed this, who did it trade with.
  const [nextAddress] = addresses;
  if (nextAddress) {
    chips.push({
      id: `address:${nextAddress.toLowerCase()}`,
      icon: "wallet",
      text: `Read ${shortHex(nextAddress)}`,
      question: `What is ${nextAddress} and what has it been doing?`,
    });
  }

  // 3. Is it the real one? Only for a ticker, and only when the answer has not
  //    already given a verdict — a safety chip under a safety answer is a loop.
  const verdictTicker = symbols.find((s) => !askedTickers.has(s));
  const safetyTicker = kind === "safety" || used.has("safety_check") ? null : (verdictTicker ?? symbols[0] ?? null);
  if (safetyTicker) {
    chips.push({
      id: `safety:${safetyTicker}`,
      icon: "shield",
      text: `Verify ${safetyTicker}`,
      question: `Is ${safetyTicker} the contract Robinhood actually issued? Check the deployer.`,
    });
  }

  // 4. A ranking, re-cut on the other axis. The list is already on screen sorted
  //    one way, and the interesting question is what changes when it is not.
  const metric = rankingMetric(evidence);
  if (metric) {
    const next = METRICS[METRICS[metric].next];
    chips.push({
      id: `rank:${METRICS[metric].next}`,
      icon: "rank",
      text: `Re-rank by ${next.word}`,
      question: `Rank Robinhood Chain's tokenized equities by ${next.word} instead.`,
    });
  }

  // 5. Two tickers in hand and no comparison made yet.
  if (!used.has("compare_tokens") && symbols.length >= 2) {
    const [a, b] = symbols;
    chips.push({
      id: `compare:${a}:${b}`,
      icon: "compare",
      text: `${a} vs ${b}`,
      question: `Compare ${a} and ${b} — price, market cap, holders and 24h volume.`,
    });
  }

  // 6. One ticker in hand: where it sits against everything else listed.
  if (!metric && !used.has("rank_stocks") && symbols.length === 1) {
    const [only] = symbols;
    chips.push({
      id: `context:${only}`,
      icon: "rank",
      text: `Where ${only} ranks`,
      question: `Where does ${only} sit among Robinhood Chain's tokenized equities by market cap and holders?`,
    });
  }

  // 7. The whole board — the one follow-up that needs no subject at all, and so
  //    the one that keeps a thin answer from offering nothing.
  if (!used.has("market_overview") && kind !== "overview") {
    chips.push({
      id: "market",
      icon: "trend",
      text: "Read the whole board",
      question: "How does the tokenized-equity market on Robinhood Chain look right now?",
    });
  }

  const seenId = new Set();
  const seenQuestion = new Set();
  const out = [];
  for (const chip of chips) {
    const q = chip.question.toLowerCase();
    if (seenId.has(chip.id) || seenQuestion.has(q)) continue;
    seenId.add(chip.id);
    seenQuestion.add(q);
    out.push(chip);
    if (out.length >= MAX_FOLLOW_UPS) break;
  }
  return out;
}
