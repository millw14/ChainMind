import { formatUnits } from "viem";
import {
  ENRICHMENT_TIMEOUT_MS,
  TIMEOUT_MS,
  deadline,
  getAddress,
  getAddressCounters,
  getAddressTokenBalances,
  getAddressTransactions,
  getToken,
  getTokenActivity,
  getTokenCounters,
  getTokenHolders,
  getTokenTransfers,
  getTransaction,
  getTransactionLogs,
} from "./blockscout.js";
import { listStockTokens, resolveSymbol, snapshotMatch } from "./stock-tokens.js";
import { displayNumber, finiteOrNull } from "./format-number.js";
import { buildTable, col } from "./table-shape.js";

/**
 * A ticker the way a trader types it: "NVDA", "$tsla", "aapl". Deliberately
 * narrow — letters and digits only, no separators — so a half-typed hash or a
 * sentence can't masquerade as a symbol and get sent to the token search.
 */
const SYMBOL_RE = /^\$?[0-9A-Za-z]{1,10}$/;

/** Classify a Robinhood Chain identifier from its shape. */
export function classifyTarget(raw) {
  const t = String(raw ?? "").trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(t)) return { kind: "tx", value: t };
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) return { kind: "address", value: t };
  // A malformed 0x… string is a broken hash, not a ticker: "0xabc" belongs in
  // "that isn't a valid address", not in a symbol lookup that may well hit some
  // unrelated contract calling itself 0XABC.
  if (!/^0x/i.test(t) && SYMBOL_RE.test(t)) {
    return { kind: "symbol", value: t.replace(/^\$/, "").toUpperCase() };
  }
  return { kind: "unknown", value: t };
}

/**
 * Run one indexer call without letting it fail the whole gather. Takes a thunk
 * rather than a promise: a getter that throws synchronously (bad config, a URL
 * that won't build) never produces a promise to catch, so the throw escaped.
 *
 * It is also what makes STARTING a call before knowing whether we want its
 * result safe. The overlapping below hands promises around and awaits them
 * several steps later; an eager promise that rejects with nothing attached in the
 * same turn is an unhandled rejection, which by default takes the process down.
 * Because attempt() catches at the moment of creation, a call can be fired,
 * abandoned, and never looked at.
 *
 * @param {() => Promise<any>} thunk
 */
async function attempt(thunk) {
  try {
    return { ok: true, data: await thunk() };
  } catch (e) {
    return { ok: false, data: null, status: e?.status ?? null };
  }
}

/*
 * FINDING, so the next person does not repeat two dead ends.
 *
 * The holder table is emitted only when getTokenHolders lands, and measured
 * against the public indexer that call succeeds roughly half the time: 3 of 6
 * raw calls returned (1.6-4.4s each), the rest hung until the deadline cut
 * them. Two fixes were tried and NEITHER worked:
 *
 *   - Promoting holders to the longer "essential" deadline: 2/5, no better
 *     than the 3/5 it replaced. Raising a deadline against an endpoint that
 *     drops requests only buys longer hangs.
 *   - One bounded retry on a status-less failure: 3/6, no better, and it
 *     added up to 6s to the worst case. Reverted.
 *
 * The failures are not all timeouts — one came back in 2992ms carrying a
 * status, which reads like rate limiting, quite possibly self-inflicted by
 * testing in a tight loop. Tuning this layer is the wrong lever. The right one
 * was the short-lived cache in front of the hot reads, and it now exists:
 * lib/indexer-cache.js sits under every getter, so a repeat lookup inside the
 * TTL makes no request at all and a burst of identical ones makes exactly one.
 * That removes the self-inflicted half of the problem. It does NOT make a cold
 * holders call more likely to land — the first read still pays full price and
 * still misses sometimes — so the deadline notes above stand.
 */

/**
 * Only a 404 from the indexer means "this does not exist on Robinhood Chain".
 * Every other failure — 5xx, rate limit, timeout, network — means we could not
 * look, and answering "not found" there is a confident lie about the chain.
 */
function lookupFailure(kind, value, status, noun) {
  if (status === 404) {
    return { ok: false, kind, target: value, error: `${noun} not found on Robinhood Chain.` };
  }
  return {
    ok: false,
    kind: "unavailable",
    target: value,
    error: `The Robinhood Chain indexer did not answer${status ? ` (HTTP ${status})` : ""}, so this ${noun.toLowerCase()} could not be looked up. Try again shortly.`,
  };
}

/**
 * Collects the sub-calls that failed. Swallowing every error into null turned a
 * brownout into empty holder / transfer lists, which read as "there are none" —
 * an invented negative fact. Naming the missing sources in the evidence lets the
 * model honour its own rule about saying so when evidence is absent.
 */
function sources() {
  const unavailable = [];
  return {
    unavailable,
    /**
     * @param {string} name - the evidence field this call feeds
     * @param {() => Promise<any>} thunk
     */
    async get(name, thunk) {
      const res = await attempt(thunk);
      if (!res.ok) unavailable.push(name);
      return res.data;
    },
    /**
     * Same bookkeeping for a call that is ALREADY RUNNING — an attempt() promise
     * started earlier so it could overlap something else.
     *
     * @param {string} name - the evidence field this call feeds
     * @param {Promise<{ ok: boolean, data: any, status?: number|null }>} started
     */
    async claim(name, started) {
      const res = await started;
      if (!res.ok) unavailable.push(name);
      return res.data;
    },
    /** Mark a field missing for a reason other than its own call failing. */
    miss(name) {
      unavailable.push(name);
    },
  };
}

/** `unavailable: [...]` for the evidence block, omitted when nothing failed. */
function gaps(src) {
  return src.unavailable.length ? { unavailable: [...src.unavailable] } : {};
}

/** `degraded: true` for the response, omitted when nothing failed. */
function degraded(src) {
  return src.unavailable.length ? { degraded: true } : {};
}

/**
 * The four headline figures as FINISHED STRINGS, for the model to copy verbatim.
 *
 * lib/market-evidence.js toRow has attached these to every ranking, overview and
 * comparison row since a model turned a $4.16M market cap into $4.16B by sliding
 * the decimal point. The single-target lookup went through this file instead and
 * did not attach them, so the one path a user is most likely to take — paste a
 * ticker, get its numbers — was still handing the model a raw float and asking
 * it to do the formatting. Observed live: a lookup answered "$4,160,816.92"
 * straight off the raw number. That one happened to be right.
 *
 * Values arrive from the indexer as strings as often as numbers, so each is
 * coerced through finiteOrNull first: "" must become null, not $0.00.
 *
 * @param {{ price?: unknown, marketCap?: unknown, volume24h?: unknown, holders?: unknown }} [figures]
 * @returns {{ price: string|null, marketCap: string|null, volume24h: string|null, holders: string|null }}
 */
export function tokenDisplay(figures = {}) {
  const f = figures && typeof figures === "object" ? figures : {};
  return {
    price: displayNumber(finiteOrNull(f.price), "price"),
    marketCap: displayNumber(finiteOrNull(f.marketCap), "usd"),
    volume24h: displayNumber(finiteOrNull(f.volume24h), "usd"),
    // A holder count is a count of addresses, not money: "28,899", never "$28.90K".
    holders: displayNumber(finiteOrNull(f.holders), "count"),
  };
}

/**
 * WHY A TOKEN HAS NO PRICE, said once, instead of three bare nulls.
 *
 * Blockscout quotes the issuer-verified tokenized equities and nothing else, so
 * an ordinary ERC-20 comes back with exchange_rate, circulating_market_cap and
 * volume_24h all null. Those nulls are correct and must not be papered over with
 * a guess — but reported as three unexplained absences they read as three
 * separate failures, and a reviewer who asked an unlisted token for its price got
 * an answer that opened by listing what it could not do. Naming the reason turns
 * the same fact from a dead end into something about the contract.
 *
 * Three states, and the third must never be collapsed into the second: a price
 * this indexer never carried is a property of the token; a price it could not be
 * asked for is an outage, and the figure may well exist.
 *
 * @param {unknown} price - exchange_rate exactly as the indexer sent it
 * @param {boolean} marketDataRead - whether the token endpoint answered at all
 * @returns {{ priceStatus: "indexed"|"not_indexed"|"unavailable", priceStatusReason: string|null }}
 */
function priceAvailability(price, marketDataRead) {
  if (finiteOrNull(price) !== null) return { priceStatus: "indexed", priceStatusReason: null };
  if (!marketDataRead) {
    return {
      priceStatus: "unavailable",
      priceStatusReason:
        "The indexer's token endpoint did not answer, so price, market cap and 24h volume could not be read — an outage, not a token without a price.",
    };
  }
  return {
    priceStatus: "not_indexed",
    priceStatusReason:
      "No price feed for this contract — only the issuer-verified tokenized equities carry price, market cap and 24h volume on this indexer. Unpriced is not priced at zero.",
  };
}

/* --------------------------- scheduling policy --------------------------- */

/**
 * Per-field budgets. `essential` is what the answer is made of; `enrichment` is
 * the detail around it and gets the shorter deadline, so one stalled endpoint
 * costs one field instead of the whole reply. The numbers, and why they differ,
 * live in lib/blockscout.js.
 */
const DEADLINES = Object.freeze({ essential: TIMEOUT_MS, enrichment: ENRICHMENT_TIMEOUT_MS });

/**
 * The indexer functions, overridable per call — the same test seam as
 * lib/ask-tools.js dispatchTool's third argument.
 *
 * What this file decides is WHEN each call starts and how long it may take.
 * Neither is observable in the returned evidence and neither is testable against
 * a real endpoint, so the calls have to be injectable to be tested at all.
 */
const DEFAULT_CALLS = Object.freeze({
  getAddress,
  getAddressCounters,
  getAddressTokenBalances,
  getAddressTransactions,
  getToken,
  getTokenActivity,
  getTokenCounters,
  getTokenHolders,
  getTokenTransfers,
  getTransaction,
  getTransactionLogs,
  listStockTokens,
  resolveSymbol,
  snapshotMatch,
});

/**
 * Fold the optional second argument into the shape the internals use. Absent,
 * partial or junk options must land on exactly the old behaviour — no hint, the
 * real indexer, the real deadlines — because every existing caller passes none.
 */
function withOptions(options) {
  const o = options && typeof options === "object" ? options : {};
  return {
    known: normalizeKnown(o.known),
    calls: o.calls && typeof o.calls === "object" ? { ...DEFAULT_CALLS, ...o.calls } : DEFAULT_CALLS,
    deadlines: o.deadlines && typeof o.deadlines === "object" ? { ...DEADLINES, ...o.deadlines } : DEADLINES,
  };
}

/**
 * A caller's claim about what the target already is.
 *
 * Only `kind: "token"` skips work. The address is optional — a hint with none is
 * a claim about whatever target it was passed alongside — but an address that is
 * PRESENT and malformed voids the whole hint: the hint buys a 5.2s round trip, so
 * one that is already wrong about something must fall back to looking rather than
 * be half-believed. Anything else normalizes to null.
 *
 * @param {unknown} known
 * @returns {{ kind: "token", address: string|null, symbol: string|null, company: string|null, official: boolean } | null}
 */
function normalizeKnown(known) {
  if (!known || typeof known !== "object" || known.kind !== "token") return null;
  const raw = typeof known.address === "string" ? known.address.trim() : "";
  const address = classifyTarget(raw).kind === "address" ? raw : null;
  if (known.address != null && !address) return null;
  return {
    kind: "token",
    address,
    symbol: sanitizeLabel(known.symbol, 16),
    company: sanitizeLabel(known.company),
    official: Boolean(known.official),
  };
}

/** Case-insensitive address compare — the snapshot is lowercased, the chain isn't. */
function sameAddress(a, b) {
  if (!a || !b) return false;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/**
 * The three calls that IDENTIFY a contract, all started at once.
 *
 * `getToken` is the one that decides: a 200 means the indexer knows a token here,
 * a 404 means it does not, and at a measured 1.1s it answers that question about
 * 4s sooner than the address overview did. The overview still runs — it carries
 * the balance a wallet needs and the creator/verified block a token wants — but it
 * no longer gates anything, so its 5.2s overlaps everything instead of preceding
 * it. `getTokenCounters` is fired on spec at 0.3s: on a wallet it is one wasted
 * 404, and paying that beats waiting 0.3s more once the kind is known.
 *
 * @param {string} value
 * @param {{ calls: object, deadlines: object }} o
 * @param {{ overviewEssential: boolean }} opts - false when the caller already
 *   knows this is a token, so the overview is enrichment rather than the gate
 */
function startProbe(value, o, { overviewEssential }) {
  return {
    token: attempt(() => o.calls.getToken(value, deadline(o.deadlines.essential))),
    counters: attempt(() => o.calls.getTokenCounters(value, deadline(o.deadlines.essential))),
    overview: attempt(() =>
      o.calls.getAddress(value, deadline(overviewEssential ? o.deadlines.essential : o.deadlines.enrichment)),
    ),
  };
}

/**
 * Top holders and recent transfers — the two slowest endpoints on the indexer.
 *
 * Holders used to be enrichment: nobody asked for it by name, so a stall could
 * drop it without costing the answer anything. The holder TABLE changed that.
 * The table is built from this call, so when it misses its deadline the answer
 * silently loses its headline feature — measured at 2 failures in 5 runs on the
 * 6s enrichment budget against a call that takes ~4.3s. It is answer-critical
 * now, so it gets the essential deadline. Recent transfers is still detail
 * nobody names, and keeps the shorter one.
 */
function startTokenEnrichment(value, o) {
  return {
    holders: attempt(() => o.calls.getTokenHolders(value, {}, deadline(o.deadlines.enrichment))),
    activity: attempt(() => o.calls.getTokenActivity(value, {}, deadline(o.deadlines.enrichment))),
  };
}

/**
 * The wallet-shaped calls. None of them needs the address overview's body, only
 * the address itself, so they start the moment the kind is known rather than
 * after the overview lands.
 */
function startWalletCalls(value, o) {
  return {
    counters: attempt(() => o.calls.getAddressCounters(value, deadline(o.deadlines.essential))),
    balances: attempt(() => o.calls.getAddressTokenBalances(value, deadline(o.deadlines.essential))),
    txs: attempt(() => o.calls.getAddressTransactions(value, {}, deadline(o.deadlines.enrichment))),
    transfers: attempt(() =>
      o.calls.getTokenTransfers(value, { type: "ERC-20" }, deadline(o.deadlines.enrichment)),
    ),
  };
}

/**
 * Gather human-oriented evidence for one target (tx, token, or wallet) from
 * Blockscout. Every call is best-effort so partial data still yields an answer.
 *
 * When some sub-calls fail the gather still succeeds, but says so: the failed
 * field names are listed in `evidence.unavailable` and the response is marked
 * `degraded: true`. A call cut off by its deadline counts as failed — a field
 * that timed out is reported missing, never as an empty list or a zero.
 *
 * @param {string} target - 0x address, 0x tx hash, or a ticker like "NVDA"/"$tsla"
 * @param {object} [options]
 * @param {{ kind: "token", address?: string, symbol?: string, company?: string, official?: boolean }} [options.known]
 *   What the caller already knows about the target. `kind: "token"` with a
 *   matching address skips the address-overview gate entirely: for a verified
 *   equity token, "is this a token or a wallet" is a question we can already
 *   answer, and paying 5.2s to be told again is 5.2s of dead air.
 * @param {object} [options.calls] - test seam: overrides for the indexer calls
 * @param {{ essential?: number, enrichment?: number }} [options.deadlines] - test seam
 * @returns {Promise<{ ok: boolean, kind: string, target: string, degraded?: boolean, evidence?: object, error?: string }>}
 */
export async function gatherEvidence(target, options) {
  const { kind, value } = classifyTarget(target);
  const o = withOptions(options);

  if (kind === "tx") {
    const src = sources();
    const [txRes, logs] = await Promise.all([
      attempt(() => o.calls.getTransaction(value, deadline(o.deadlines.essential))),
      // The decoded logs are colour on top of the transaction itself, so they get
      // the shorter deadline: a stalled logs call costs `decodedLogs`, not the tx.
      src.get("decodedLogs", () => o.calls.getTransactionLogs(value, deadline(o.deadlines.enrichment))),
    ]);
    if (!txRes.ok || !txRes.data) return lookupFailure(kind, value, txRes.status, "Transaction");
    const tx = txRes.data;
    const logList = Array.isArray(logs?.items) ? logs.items : [];
    return {
      ok: true,
      kind,
      target: value,
      ...degraded(src),
      evidence: {
        ...gaps(src),
        hash: tx.hash,
        status: tx.status ?? tx.result ?? null,
        method: tx.method ?? tx.decoded_input?.method_call ?? null,
        from: tx.from?.hash ?? tx.from ?? null,
        to: tx.to?.hash ?? tx.to ?? null,
        valueEth: tx.value != null ? weiToEth(tx.value) : null,
        feeEth: tx.fee?.value != null ? weiToEth(tx.fee.value) : null,
        blockNumber: tx.block_number ?? tx.block ?? null,
        timestamp: tx.timestamp ?? null,
        tokenTransfers: Array.isArray(tx.token_transfers)
          ? tx.token_transfers.slice(0, 8).map((t) => ({
              token: sanitizeLabel(t.token?.symbol, 16) ?? sanitizeLabel(t.token?.name),
              from: t.from?.hash ?? null,
              to: t.to?.hash ?? null,
              amount: fmtTokenAmount(t.total?.value, t.total?.decimals ?? t.token?.decimals),
            }))
          : [],
        // null, not 0/[], when the log call failed — "no logs" is a claim.
        logCount: logs ? logList.length : null,
        decodedLogs: logs
          ? logList
              .slice(0, 8)
              .map((l) => l?.decoded?.method_call || l?.decoded?.name || null)
              .filter(Boolean)
          : null,
      },
    };
  }

  if (kind === "address") return await addressEvidence(value, o);

  if (kind === "symbol") return await symbolEvidence(value, o);

  return {
    ok: false,
    kind,
    target: value,
    error:
      "Not a recognizable Robinhood Chain address (0x…40), transaction hash (0x…64) or ticker (1–10 letters/digits, e.g. NVDA).",
  };
}

/**
 * A bare 0x address, where the kind is either already known or has to be found.
 *
 * The old shape of this was: await the address overview (measured 5.2s), read one
 * boolean off it, then start the four calls that actually answer the question
 * (~4.5s). Ten seconds, of which five bought a single bit of information. Neither
 * half remains: with a hint nothing is gated on the overview at all, and without
 * one the question "which kind is this" is asked concurrently with the work, by
 * the cheapest call that can answer it.
 */
async function addressEvidence(value, o) {
  // A hint for some OTHER address is a stale hint, not a shortcut: it would label
  // this contract with facts about a different one, so it is dropped and we look.
  const known = o.known && (!o.known.address || sameAddress(o.known.address, value)) ? o.known : null;
  const probe = startProbe(value, o, { overviewEssential: !known });

  if (known) {
    // Already known to be a token, so nothing waits on the overview at all.
    return await tokenEvidence(value, o, probe, startTokenEnrichment(value, o));
  }

  const tokenRes = await probe.token;
  if (tokenRes.ok && tokenRes.data) {
    return await tokenEvidence(value, o, probe, startTokenEnrichment(value, o));
  }
  if (tokenRes.status === 404) {
    // A 404 from /tokens is a definite "not a token", so the wallet calls start
    // now and run alongside the overview rather than behind it.
    const wallet = startWalletCalls(value, o);
    const ovRes = await probe.overview;
    if (!ovRes.ok || !ovRes.data) return lookupFailure("address", value, ovRes.status, "Address");
    return await walletEvidence(value, ovRes.data, o, wallet);
  }

  // /tokens neither confirmed nor denied (5xx, rate limit, timeout). Fall back to
  // the signal this path used before: Blockscout sends `token: null` on every
  // non-token contract, so only a populated `token` object means it's a token.
  const ovRes = await probe.overview;
  if (!ovRes.ok || !ovRes.data) {
    return lookupFailure("address", value, ovRes.status ?? tokenRes.status, "Address");
  }
  return ovRes.data.token
    ? await tokenEvidence(value, o, probe, startTokenEnrichment(value, o))
    : await walletEvidence(value, ovRes.data, o, startWalletCalls(value, o));
}

/**
 * A ticker ("NVDA", "$tsla"): resolve it to a contract, then run the ordinary
 * token path against that address.
 *
 * Resolution is the dangerous half. Several unrelated contracts wear the same
 * ticker on this chain, so the resolver's verdict — official or not, and who
 * else answers to the symbol — travels with the evidence as a `stock` block
 * instead of being discarded the moment an address exists.
 *
 * It is also the half that used to be paid for twice. For 94 tickers the contract
 * address is a synchronous Map hit (lib/stock-tokens.js snapshotMatch), yet the
 * token calls waited for the resolver's own network round trips and then for a
 * getAddress gate. Here the snapshot address starts the token calls immediately,
 * in the same window as the resolver, and the resolver's answer is used for the
 * `stock` block it alone can build. The cost is one duplicate /tokens request
 * (the resolver fetches the same body to get its live figures) and, if the
 * resolver ends up naming a different contract than the snapshot, a handful of
 * abandoned ones. Both are bounded and cheap; the sequence they remove was not.
 */
async function symbolEvidence(symbol, o) {
  const preAddress = o.known?.address ?? snapshotAddress(symbol, o);
  const pre = preAddress ? startTokenCalls(preAddress, o) : null;

  const resolvedRes = await attempt(() => o.calls.resolveSymbol(symbol));
  const resolved = resolvedRes.data;
  const match = resolved?.ok ? resolved.match : null;

  if (!match?.address) {
    // An empty equity registry means the indexer never answered, not that
    // Robinhood delisted everything — "no such ticker" there would be a lie.
    const listRes = await attempt(() => o.calls.listStockTokens());
    const list = Array.isArray(listRes.data) ? listRes.data : [];
    if (!list.length) return lookupFailure("symbol", symbol, null, "Ticker");
    return {
      ok: false,
      kind: "symbol",
      target: symbol,
      error: resolved?.reason ?? `No token matching "${symbol}" was found on Robinhood Chain.`,
    };
  }

  const address = match.address;
  // The resolver only ever returns TOKENS, so there is nothing for a getAddress
  // gate to decide here either. Its overview is fetched as the enrichment it is:
  // when it fails the `contract` block is reported missing, where it used to fail
  // the whole ticker lookup that already had every headline figure in hand.
  const started = pre && sameAddress(pre.address, address) ? pre : startTokenCalls(address, o);

  const base = await tokenEvidence(address, o, started.probe, started.enrich);
  if (!base.ok) return base;
  // First key, not last: the prompt truncates serialized evidence at a hard
  // character cap, and the impostor warning is the one field that must never be
  // the thing that got cut.
  return { ...base, evidence: { stock: stockBlock(match, resolved), ...base.evidence } };
}

/** Every token-path call for one address, all in flight, tagged with the address. */
function startTokenCalls(address, o) {
  return {
    address,
    probe: startProbe(address, o, { overviewEssential: false }),
    enrich: startTokenEnrichment(address, o),
  };
}

/**
 * The snapshotted contract address for a ticker, or null. Synchronous, so unlike
 * every other lookup here it has no attempt() around it — a throw would escape
 * into the caller and turn a fast path into a 500.
 */
function snapshotAddress(symbol, o) {
  try {
    const v = o.calls.snapshotMatch(symbol)?.address;
    const s = typeof v === "string" ? v.trim() : "";
    return classifyTarget(s).kind === "address" ? s : null;
  } catch {
    return null;
  }
}

/**
 * The ticker-level summary the model answers from: the headline numbers plus,
 * crucially, WHICH CONTRACT they came from and whether it is the one Robinhood
 * issued. `impostorWarning` and `identityNotice` are ready-made sentences rather
 * than flags, because the count and the contract's real name are the parts a
 * reader needs and the model must not have to derive either.
 */
function stockBlock(match, resolved) {
  // NULL, not []: lib/stock-tokens.js returns null when the explorer search did
  // not answer, and an empty array here would become "no other contract uses
  // this ticker" — an outage reading as the all-clear, on the one field where
  // that is dangerous.
  const impostors = Array.isArray(resolved?.impostors) ? resolved.impostors : null;
  const official = Boolean(resolved?.official);
  return {
    symbol: match.symbol ?? null,
    company: match.company ?? null,
    // THE NAME ON THE CONTRACT, carried for every symbol lookup and not only the
    // verified ones. "The Green Bull" answering to VLAD is the single most useful
    // fact in that answer and it used to reach the model only as a token-block
    // field nothing pointed at.
    name: match.name ?? null,
    address: match.address,
    price: match.price ?? null,
    marketCap: match.marketCap ?? null,
    volume24h: match.volume24h ?? null,
    holders: match.holders ?? null,
    // Copy these verbatim rather than formatting the four raw figures above.
    display: tokenDisplay(match),
    official,
    impostorWarning: impostorWarning(match, impostors, official),
    // Which contract these figures belong to, in one clause, for everything that
    // is not an issuer-verified equity. Null for the verified ones — they already
    // get impostorWarning, which says more and prints the address in full.
    identityNotice: identityNotice(match, official),
    // Named, not just counted: "3 others exist" is useless if the reader can't
    // tell which contract is in their wallet. null when the scan did not run.
    impostors: impostors ? impostors.slice(0, 5) : null,
    // How many there are, or null for "not checked". The boolean is spelled out
    // beside it so a reader of the evidence never has to infer the difference
    // between an empty list and an absent one.
    impostorCount: impostors ? impostors.length : null,
    impostorsRead: Boolean(impostors),
  };
}

/** Two labels are the same string once case and padding stop mattering. */
function sameLabel(a, b) {
  if (!a || !b) return false;
  return String(a).trim().toUpperCase() === String(b).trim().toUpperCase();
}

/**
 * WHICH CONTRACT these figures are for, said in one clause.
 *
 * The impostor problem, one layer out. Inside the 94 issuer-verified equities a
 * ticker is already treated as non-identity; outside them it was treated as an
 * identity, which is exactly backwards — that is where collisions are commonest
 * and least policed. Measured: VLAD resolves to 0x31BE…BF81, whose symbol is VLAD
 * and whose NAME IS "The Green Bull", while two more contracts on the same chain
 * also answer to VLAD. The answer quoted one contract's figures with full
 * confidence and never said which one it had picked, so a reader looking at a
 * different VLAD saw numbers that looked simply wrong rather than numbers about a
 * different token.
 *
 * Null for an issuer-verified equity: that path already leads with a stronger
 * warning and prints the address in full, and a second, softer sentence beside it
 * would only dilute it.
 *
 * @param {object} match - the resolved token
 * @param {boolean} official - issuer-verified equity
 * @returns {string|null}
 */
function identityNotice(match, official) {
  if (official) return null;
  const symbol = match.symbol ?? null;
  const name = match.name ?? null;
  if (name && symbol && !sameLabel(name, symbol)) {
    return `These figures are for ${match.address}, a contract whose symbol is ${symbol} but whose name is "${name}" — say which contract you are reporting on, because more than one can wear a ticker.`;
  }
  return `These figures are for ${match.address}${symbol ? `, the contract the ticker ${symbol} resolved to` : ""} — say which contract you are reporting on, because more than one can wear a ticker.`;
}

/**
 * One sentence naming the collision, or null when there is nothing to warn
 * about. A null `impostors` is the third case and it gets its own sentence:
 * saying nothing there would let "no warning" mean both "checked, clean" and
 * "never checked".
 */
function impostorWarning(match, impostors, official) {
  const symbol = match.symbol ?? "this ticker";
  const n = impostors ? impostors.length : null;
  const parts = [];

  if (!official) {
    parts.push(
      `${symbol} did not match an official "• Robinhood Token" contract, so ${match.address} is an unverified third-party token, not a Robinhood tokenized equity.`,
    );
  }
  if (n === null) {
    parts.push(
      `The explorer search did not answer, so whether other contracts on Robinhood Chain also use the ticker ${symbol} could not be checked — unknown, not none.`,
    );
  } else if (n > 0) {
    const others = `${n} other contract${n === 1 ? "" : "s"} on Robinhood Chain also use${n === 1 ? "s" : ""} the ticker ${symbol}`;
    parts.push(official ? `${others}; the official one is ${match.address}.` : `${others}.`);
  }

  return parts.length ? parts.join(" ") : null;
}

/**
 * A token contract: metadata, supply, market data, top holders, recent transfers.
 *
 * Every call arrives already in flight, so these awaits cost the slowest one and
 * not the sum. They are sequential rather than a Promise.all purely so the
 * `unavailable` list comes out in a fixed order — with four concurrent calls,
 * Promise.all's array order says nothing about which one failed first.
 *
 * @param {string} value
 * @param {{ calls: object, deadlines: object }} o
 * @param {{ token: Promise, counters: Promise, overview: Promise }} probe
 * @param {{ holders: Promise, activity: Promise }} enrich
 */
/**
 * Rows of the holder table the client draws. Twenty-five, not the ten the prose
 * quotes.
 *
 * The whole page is already in hand — one getTokenHolders call fetched it, and
 * `topHolders` is a ten-row slice of the same list — so the depth costs no extra
 * request and no extra second. It is capped anyway: rows travel to the model as
 * prompt text, and the shared evidence budget is not worth spending on a hundred
 * addresses nobody asked about.
 */
const TABLE_HOLDERS = 25;

/**
 * The holder list, as a table.
 *
 * Every figure is a string the same helpers already formatted for the prose, so
 * the table and the sentence above it cannot disagree about what a wallet holds.
 * A share that could not be computed — no total supply to divide by — stays null
 * rather than becoming "0%": a holder printed as owning zero percent of a token
 * they demonstrably hold is the exact false claim this codebase refuses to make.
 *
 * @param {Array<object>} items - raw getTokenHolders items
 * @param {number} decimals
 * @param {unknown} rawSupply
 * @param {string|null} symbol
 * @param {unknown} holderCount - the upstream total, if the counters returned one
 * @returns {object} a lib/table-shape.js table
 */
function holdersTable(items, decimals, rawSupply, symbol, holderCount) {
  const rows = items.slice(0, TABLE_HOLDERS).map((h, i) => {
    const share = pctOfSupply(h.value, rawSupply);
    return {
      rank: i + 1,
      address: h.address?.hash ?? null,
      amount: fmtTokenAmount(h.value, decimals),
      share: share === null ? null : `${share}%`,
    };
  });
  return buildTable({
    id: "holders",
    title: `Top ${rows.length} holders${symbol ? ` of ${symbol}` : ""}`,
    columns: [
      col("rank", "#", "right"),
      col("address", "Holder"),
      col("amount", "Amount", "right"),
      col("share", "Share of supply", "right"),
    ],
    rows,
    totalRows: holderCount,
    note:
      "Amounts are the indexer's balances at the time of the lookup, and the share is of total supply. A blank share means no supply figure came back to divide by, not a zero holding.",
  });
}

async function tokenEvidence(value, o, probe, enrich) {
  const src = sources();
  const token = await src.claim("token", probe.token);
  const counters = await src.claim("tokenCounters", probe.counters);
  const holders = await src.claim("topHolders", enrich.holders);
  const activity = await src.claim("recentTransfers", enrich.activity);

  // The overview is not the gate on this path — it supplies the `contract` block
  // and nothing else, so losing it costs that block by name.
  const overviewRes = await probe.overview;
  const addr = overviewRes.data ?? null;
  if (!addr) src.miss("contract");

  // No token metadata from either source: it isn't a token after all. Emit wallet
  // evidence rather than a hollow all-null token record — and if the overview is
  // missing too, nothing at all was readable, which is an outage and not a fact
  // about this address.
  if (!token && !addr?.token) {
    if (!addr) return lookupFailure("token", value, overviewRes.status, "Token");
    return await walletEvidence(value, addr, o, startWalletCalls(value, o));
  }

  const t = token ?? addr?.token ?? {};
  const name = sanitizeLabel(t.name);
  const symbol = sanitizeLabel(t.symbol, 16);
  const decimals = numOr(t.decimals, 18);
  const rawSupply = t.total_supply ?? null;
  const holderCount = counters?.token_holders_count ?? t.holders ?? t.holders_count ?? null;

  // A list stays null when its source failed: [] would assert "no holders".
  const holderItems = Array.isArray(holders?.items) ? holders.items : [];
  const topHolders = holders
    ? holderItems.slice(0, 10).map((h) => ({
        address: h.address?.hash ?? null,
        amount: fmtTokenAmount(h.value, decimals),
        share: pctOfSupply(h.value, rawSupply),
      }))
    : null;

  const activityItems = Array.isArray(activity?.items) ? activity.items : [];
  const recentTransfers = activity
    ? activityItems.slice(0, 8).map((x) => ({
        from: x.from?.hash ?? null,
        to: x.to?.hash ?? null,
        amount: fmtTokenAmount(x.total?.value, decimals),
        timestamp: x.timestamp ?? null,
      }))
    : null;

  return {
    ok: true,
    kind: "token",
    target: value,
    ...degraded(src),
    evidence: {
      ...gaps(src),
      address: addr?.hash ?? value,
      token: {
        name,
        symbol,
        type: t.type ?? null,
        decimals,
        totalSupply: rawSupply != null ? `${fmtTokenAmount(rawSupply, decimals)} ${symbol ?? ""}`.trim() : null,
        holders: holderCount,
        transfers: counters?.transfers_count ?? null,
        priceUsd: t.exchange_rate ?? null,
        marketCapUsd: t.circulating_market_cap ?? null,
        volume24hUsd: t.volume_24h ?? null,
        // Why the three figures above are null, when they are — `token` is the
        // /tokens body, so a falsy one means nobody could be asked for a quote.
        ...priceAvailability(t.exchange_rate, Boolean(token)),
        // Copy these verbatim rather than formatting the raw figures above.
        display: tokenDisplay({
          price: t.exchange_rate,
          marketCap: t.circulating_market_cap,
          volume24h: t.volume_24h,
          holders: holderCount,
        }),
      },
      // null, not a record of nulls, when the overview never landed: three
      // "unknown" fields read as "unverified, no creator", which is a claim.
      contract: addr
        ? {
            verified: addr.is_verified ?? null,
            creator: addr.creator_address_hash ?? null,
            creationTx: addr.creation_tx_hash ?? null,
          }
        : null,
      topHolders,
      holderConcentrationTop10Pct: topHolders ? sumShares(topHolders) : null,
      recentTransfers,
      // The rows behind `topHolders`, deeper and drawable. Only when the holder
      // call actually landed: an absent table is the client drawing nothing,
      // whereas an empty one would assert that this token has no holders.
      ...(holderItems.length ? { table: holdersTable(holderItems, decimals, rawSupply, symbol, holderCount) } : {}),
    },
  };
}

/**
 * A wallet / non-token contract: balance, token holdings, activity, counterparties.
 *
 * Like tokenEvidence, the four calls arrive already running; awaiting them in a
 * fixed order costs nothing and makes `unavailable` deterministic.
 *
 * @param {string} value
 * @param {object} addr - the address overview, already fetched
 * @param {{ calls: object, deadlines: object }} o
 * @param {{ counters: Promise, balances: Promise, txs: Promise, transfers: Promise }} started
 */
async function walletEvidence(value, addr, o, started) {
  const src = sources();
  const counters = await src.claim("counters", started.counters);
  const balances = await src.claim("tokenHoldings", started.balances);
  const txs = await src.claim("counterparties", started.txs);
  const transfers = await src.claim("recentTransfers", started.transfers);

  const txItems = Array.isArray(txs?.items) ? txs.items : [];
  const xferItems = Array.isArray(transfers?.items) ? transfers.items : [];
  const balItems = Array.isArray(balances) ? balances : Array.isArray(balances?.items) ? balances.items : [];

  // Each list stays null when its source failed, so a brownout can't be read as
  // "this wallet holds nothing / has never transferred".
  const tokenHoldings = balances
    ? balItems
        .map((b) => {
          // NOT rounded here. round2 turned a holding worth fractions of a cent
          // into the number 0, and 0 renders as "$0.00" — a real position
          // reported as worthless. Presentation belongs to displayNumber, which
          // says "<$0.01" for a small non-zero value; this keeps the figure it
          // was given so the rounding decision is made once, at the edge.
          const valueUsd =
            b.token?.exchange_rate != null && b.value != null
              ? Number(formatUnits(safeBig(b.value), numOr(b.token?.decimals, 18))) *
                Number(b.token.exchange_rate)
              : null;
          return {
            token: sanitizeLabel(b.token?.symbol, 16) ?? sanitizeLabel(b.token?.name),
            // Carried so two holdings wearing one symbol can be told apart, and
            // so an answer can name the contract it means. Blockscout calls it
            // address_hash on a balance row; `address` is undefined here and
            // silently produced a collision list of nulls.
            address:
              typeof b.token?.address_hash === "string"
                ? b.token.address_hash.toLowerCase()
                : typeof b.token?.address === "string"
                  ? b.token.address.toLowerCase()
                  : null,
            amount: fmtTokenAmount(b.value, numOr(b.token?.decimals, 18)),
            valueUsd,
            // A holding's USD value is the other number in this file a model was
            // left to format itself. Same rule as everywhere else: copy the string.
            display: { valueUsd: displayNumber(finiteOrNull(valueUsd), "usd") },
          };
        })
        .filter((h) => h.token)
        .slice(0, 12)
    : null;

  // Two holdings under one ticker is the shape an impostor makes, and this
  // wallet really does hold two different contracts both calling themselves
  // DIH. Rendered as a bare list they read as one position counted twice, so
  // the collision is named here rather than left for the reader to notice.
  const symbolCollisions = tokenHoldings
    ? Object.entries(
        tokenHoldings.reduce((acc, h) => {
          const key = String(h.token ?? "").toUpperCase();
          if (key) (acc[key] ??= []).push(h.address);
          return acc;
        }, {}),
      )
        .filter(([, addresses]) => addresses.length > 1)
        .map(([symbol, addresses]) => ({ symbol, contracts: addresses }))
    : null;

  return {
    ok: true,
    kind: "address",
    target: value,
    ...degraded(src),
    evidence: {
      ...gaps(src),
      address: addr.hash ?? value,
      isContract: addr.is_contract ?? false,
      name: sanitizeLabel(addr.name),
      balanceEth: addr.coin_balance != null ? weiToEth(addr.coin_balance) : null,
      totalTransactions: counters?.transactions_count ?? null,
      tokenTransferCount: counters?.token_transfers_count ?? null,
      tokenHoldings,
      ...(symbolCollisions && symbolCollisions.length ? { symbolCollisions } : {}),
      recentTransfers: transfers
        ? xferItems.slice(0, 8).map((x) => ({
            token: sanitizeLabel(x.token?.symbol, 16) ?? sanitizeLabel(x.token?.name),
            from: x.from?.hash ?? null,
            to: x.to?.hash ?? null,
            amount: fmtTokenAmount(x.total?.value, numOr(x.total?.decimals ?? x.token?.decimals, 18)),
          }))
        : null,
      counterparties: txs ? uniqueCounterparties(txItems, value).slice(0, 8) : null,
    },
  };
}

/* ----------------------------- helpers ----------------------------- */

/** Control chars, zero-width and bidi marks — anything that can fake structure. */
const LABEL_JUNK = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\ufeff]/g;

/**
 * Flatten an indexer-supplied label (token name/symbol, address name) into a
 * short single-line string. These values are attacker-controlled: anyone can
 * mint a token whose name is an instruction paragraph and airdrop 1 wei to a
 * wallet, so it surfaces in the evidence of an innocent lookup. Stripping
 * newlines and invisible characters stops a name from faking prompt structure;
 * the cap stops it from drowning the real facts.
 *
 * @param {unknown} s
 * @param {number} [max] - hard character cap (names ~48, symbols ~16)
 * @returns {string | null}
 */
function sanitizeLabel(s, max = 48) {
  if (s == null) return null;
  const flat = String(s).replace(LABEL_JUNK, " ").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function numOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function safeBig(v) {
  try {
    return BigInt(v);
  } catch {
    return 0n;
  }
}

function weiToEth(wei) {
  try {
    // Full 18-decimal conversion: the old BigInt divide floored to micro-eth,
    // biasing every value downward and zeroing anything under 1e-6 ETH.
    const n = Number(formatUnits(BigInt(wei), 18));
    if (!Number.isFinite(n)) return null;
    return Number(n.toPrecision(9));
  } catch {
    return null;
  }
}

/** Format a raw token amount (base units) into a compact human string. */
function fmtTokenAmount(raw, decimals) {
  if (raw == null) return null;
  try {
    const n = Number(formatUnits(BigInt(raw), numOr(decimals, 18)));
    if (!Number.isFinite(n)) return String(raw);
    return compact(n);
  } catch {
    return String(raw);
  }
}

function compact(n) {
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${round2(n / 1e12)}T`;
  if (abs >= 1e9) return `${round2(n / 1e9)}B`;
  if (abs >= 1e6) return `${round2(n / 1e6)}M`;
  if (abs >= 1e3) return `${round2(n / 1e3)}K`;
  if (abs >= 1) return String(round2(n));
  // Only trim trailing zeros on plain decimals — on exponent notation the regex
  // eats the exponent's own zeros ("1.00e-10" -> "1.00e-1", off by 10^9).
  const s = n.toPrecision(3);
  return s.includes("e") ? s : s.replace(/\.?0+$/, "");
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Percent of total supply a raw balance represents (0–100, 2dp). */
function pctOfSupply(rawBalance, rawSupply) {
  try {
    const bal = Number(rawBalance);
    const sup = Number(rawSupply);
    if (!Number.isFinite(bal) || !Number.isFinite(sup) || sup <= 0) return null;
    return round2((bal / sup) * 100);
  } catch {
    return null;
  }
}

function sumShares(holders) {
  // Coercing unknown shares to 0 made a missing-supply case look like a
  // confident "top 10 hold 0%". Only count shares we actually computed.
  const shares = holders.map((h) => h.share).filter((s) => typeof s === "number" && Number.isFinite(s));
  if (!shares.length) return null;
  return round2(shares.reduce((acc, s) => acc + s, 0));
}

/* Exported for tests (test/ask-evidence.test.mjs); not part of the public API. */
export { compact, weiToEth, sumShares, fmtTokenAmount, pctOfSupply, priceAvailability, sanitizeLabel };

function uniqueCounterparties(txItems, self) {
  const lower = self.toLowerCase();
  const seen = new Set();
  for (const t of txItems) {
    const from = t.from?.hash?.toLowerCase();
    const to = t.to?.hash?.toLowerCase();
    if (from && from !== lower) seen.add(from);
    if (to && to !== lower) seen.add(to);
  }
  return [...seen];
}
