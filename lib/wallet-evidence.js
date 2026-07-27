import { formatUnits } from "viem";
import {
  ENRICHMENT_TIMEOUT_MS,
  TIMEOUT_MS,
  deadline,
  getAddress,
  getAddressCounters,
  getAddressTokenBalances,
  getAddressTransactions,
  getTokenTransfers,
} from "./blockscout.js";
import { fmtTokenAmount, sanitizeLabel, weiToEth } from "./ask-evidence.js";
import {
  isCanonicalStockAddress,
  listStockTokens,
  resolveSymbol,
  snapshotByAddress,
  snapshotMatch,
} from "./stock-tokens.js";
import { resolveTokenTarget } from "./token-evidence.js";
import { displayNumber, finiteOrNull } from "./format-number.js";
import { compareByField } from "./market-evidence.js";
import { buildTable, col } from "./table-shape.js";

/**
 * THE WALLET-SIDE LOOKUPS — the three questions about an ADDRESS that
 * lib/ask-evidence.js answers only in passing.
 *
 * gatherEvidence's wallet path returns twelve holdings, eight transfers and a
 * bare list of counterparty addresses. That is the right answer to "what is
 * 0xabc" and the wrong answer to three questions people actually ask about a
 * wallet they are watching:
 *
 *   "what is this wallet holding, and what is it worth"  -> walletPortfolio
 *   "what has this wallet done in NVDA — has it ever sold" -> traceWallet
 *   "who does this address actually deal with"            -> walletCounterparties
 *
 * Each of the three is a different shape of the same address, and each is where
 * a specific false claim is easiest to make. They are stated here so the code
 * below can be read against them:
 *
 *  1. AN UNPRICED HOLDING IS NOT A WORTHLESS ONE. Blockscout quotes the
 *     issuer-verified equities and nothing else, so most ERC-20s come back with
 *     no exchange_rate at all. Sorting a portfolio with those coerced to 0 puts
 *     every unpriced token at the bottom as "the smallest position", and totals
 *     that include them as zero understate the wallet. They sort LAST in value
 *     order without being called small, and the total says out loud that it
 *     covers the priced rows only.
 *  2. A CAPPED HISTORY IS A SAMPLE, AND "NEVER SOLD" IS A CLAIM ABOUT ALL OF IT.
 *     traceWallet walks at most MAX_TRACE_TRANSFERS transfers. If no sale
 *     appears in those, the honest answer is "no sale in the transfers read",
 *     not "this wallet has never sold" — so `hasSold` is TRUE, FALSE or NULL,
 *     and null is what a truncated walk with no outgoing transfer produces.
 *  3. A RANKING OVER RECENT ACTIVITY IS NOT A RANKING OVER A LIFETIME.
 *     walletCounterparties counts one page of transactions and one of token
 *     transfers. "Its biggest counterparty" would be a claim about a history
 *     nobody read, so the evidence carries what was sampled and what the address
 *     counters say the total is.
 *
 * Everything is best-effort and nothing throws: each function returns
 * `{ ok, kind, evidence }` or `{ ok: false, error }`, which is the contract
 * lib/ask-tools.js dispatches on.
 *
 * Server-side only: no React. Every chain read goes through lib/blockscout.js,
 * and therefore through the TTL cache and single-flight gate in
 * lib/indexer-cache.js.
 */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The burn/mint address — a counterparty in the data, not in the world. */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Row bounds. Wider than any answer quotes, narrow enough to stay promptable. */
export const MAX_PORTFOLIO_ROWS = 50;
export const MAX_COUNTERPARTY_ROWS = 50;

/**
 * How far back traceWallet walks one wallet's transfers in one token.
 *
 * Three pages rather than one because the wallet's transfer feed is not filtered
 * by token on every deployment (see the walk below), so a single page can be
 * mostly other tokens and match almost nothing. Three rather than ten because
 * each page is a round trip against a rate-limited indexer, and a walk that
 * costs six seconds to prove a wallet never sold is a walk the user abandoned.
 */
const MAX_TRACE_PAGES = 3;
export const MAX_TRACE_TRANSFERS = 150;

/**
 * How many rows travel in the PROSE half of the evidence, beside the table, and
 * how many the trace table itself carries.
 *
 * Same reasoning as lib/token-evidence.js: the table is the list and the array
 * is the two or three rows an answer names. A hundred and fifty transfers
 * repeated in both halves is roughly 40KB against lib/ask-loop.js
 * MAX_EVIDENCE_CHARS of 24,000, and the table is the half that would get cut.
 */
const TRACE_TABLE_ROWS = 40;
const PROSE_HOLDINGS = 10;
const PROSE_TRACE = 8;
const PROSE_COUNTERPARTIES = 12;

/* ------------------------------ plumbing ------------------------------ */

/**
 * The indexer calls, overridable per call — the same test seam
 * lib/ask-evidence.js and lib/token-evidence.js use. Nothing in this module may
 * reach Blockscout during a unit test.
 *
 * resolveSymbol / snapshotMatch / listStockTokens are here because
 * resolveTokenTarget (lib/token-evidence.js) takes this same bag: trace_wallet
 * resolves its token half through exactly the code the token-side lookups use.
 */
const DEFAULT_CALLS = Object.freeze({
  getAddress,
  getAddressCounters,
  getAddressTokenBalances,
  getAddressTransactions,
  getTokenTransfers,
  listStockTokens,
  resolveSymbol,
  snapshotMatch,
});

function withCalls(options) {
  const o = options && typeof options === "object" ? options : {};
  return o.calls && typeof o.calls === "object" ? { ...DEFAULT_CALLS, ...o.calls } : DEFAULT_CALLS;
}

/**
 * Run one indexer call without letting it fail the whole gather. A thunk rather
 * than a promise, for the reason lib/ask-evidence.js gives: a getter that throws
 * synchronously never produces a promise to catch.
 */
async function attempt(thunk) {
  try {
    return { ok: true, data: await thunk(), status: null };
  } catch (e) {
    return { ok: false, data: null, status: e?.status ?? null };
  }
}

/**
 * The `unavailable` bookkeeping, in the shape lib/ask-evidence.js established:
 * a call that failed names the evidence field it was going to fill, so the model
 * can say the field could not be read instead of reading it as empty.
 */
function tracker() {
  const unavailable = [];
  return {
    unavailable,
    miss(name) {
      unavailable.push(name);
    },
    gaps() {
      return unavailable.length ? { unavailable: [...unavailable] } : {};
    },
  };
}

function nowIso() {
  return new Date().toISOString();
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Lowercased 0x address, or null when the field is not an address at all. */
function lowerAddress(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return ADDRESS_RE.test(s) ? s : null;
}

/** 0x1234567890abcdef… -> "0x1234…cdef", the form every surface here uses. */
function shortHex(value) {
  const v = String(value ?? "");
  return v.length > 12 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v;
}

/**
 * A base-unit amount as a Number, or null. Separate from fmtTokenAmount because
 * these amounts have to be SUMMED and COMPARED, and a compacted "1.23M" cannot
 * be added to anything.
 */
function amountNumber(raw, decimals) {
  if (raw == null) return null;
  try {
    const d = Number.isFinite(Number(decimals)) ? Number(decimals) : 18;
    const n = Number(formatUnits(BigInt(raw), d));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** An indexer timestamp as epoch milliseconds, or null when it is unreadable. */
function timeMs(value) {
  if (value == null) return null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

/** "2h 14m", "6 days" — a span said the way a reader would say it. */
function spanWords(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

/** The known timestamps of a row list, ascending. */
function knownTimes(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((r) => r?.timeMs)
    .filter((t) => typeof t === "number" && Number.isFinite(t))
    .sort((a, b) => a - b);
}

/** The failure sentence for a call that never answered. Never "not found". */
function unavailableError(what, status) {
  return {
    ok: false,
    error: `The Robinhood Chain indexer did not answer${status ? ` (HTTP ${status})` : ""}, so ${what} could not be read — unknown, not absent. Try again shortly.`,
  };
}

/** The one guard every function here shares: this has to be an address. */
function requireAddress(address, purpose) {
  const self = lowerAddress(address);
  if (self) return { ok: true, value: self };
  return {
    ok: false,
    error: `"${String(address ?? "").slice(0, 64)}" is not a wallet address, so ${purpose} cannot be looked up. An address is 0x followed by exactly 40 hex characters.`,
  };
}

/**
 * Cursor params for the next page. Blockscout echoes its own cursor back as
 * `next_page_params`; nulls in it would stringify to the literal "null" and
 * poison the query. Kept local rather than shared with lib/stock-tokens.js:
 * that module's copy is part of the registry walk, and one page-walker reaching
 * into another's internals is how two walks end up having to change together.
 */
function cursorParams(next) {
  if (!next || typeof next !== "object") return null;
  const out = {};
  for (const [key, value] of Object.entries(next)) {
    if (value == null) continue;
    out[key] = String(value);
  }
  return Object.keys(out).length ? out : null;
}

/** True when two param bags are the same request — a cursor that repeats loops. */
function sameParams(a, b) {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a[k] === b[k]);
}

/**
 * A row count for a list, clamped into range. Junk falls back rather than
 * failing, for the reason lib/token-evidence.js clampRows gives: the question is
 * answerable at the default depth, so refusing a limit of "loads" would cost a
 * round trip to reach the same number.
 *
 * @param {unknown} raw
 * @param {number} fallback
 * @param {number} max
 * @returns {number}
 */
export function clampCount(raw, fallback, max) {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, n));
}

/** The items array off a Blockscout body that is sometimes bare, sometimes paged. */
function itemsOf(body) {
  if (Array.isArray(body)) return body;
  return Array.isArray(body?.items) ? body.items : [];
}

/** The contract a token-transfer row belongs to, however the indexer keyed it. */
function tokenAddressOf(item) {
  return lowerAddress(item?.token?.address ?? item?.token?.address_hash ?? item?.token_address);
}

/* ------------------------------ pure cores ------------------------------ */
/* Exported for test/wallet-tools.test.mjs. The row shaping, the value ordering
   and the counterparty tally are where a missing figure would become a claimed
   one, so all three are testable with no network at all. */

/**
 * Raw token balances -> flat printable rows, ordered by USD value with the
 * unpriced last.
 *
 * The ordering is the whole point and it is not `b.valueUsd - a.valueUsd`: that
 * returns NaN for every unpriced row and leaves the order undefined, and the
 * obvious "treat null as 0" fix states that a token nobody quotes is worth
 * nothing. compareByField (lib/market-evidence.js) is the one comparator in this
 * codebase that keeps unknowns last in both directions, and it is reused here
 * rather than re-derived.
 *
 * Every cell is a primitive because these rows go straight into a table, where a
 * nested object renders as "[object Object]".
 *
 * @param {Array<object>} items - raw getAddressTokenBalances items
 * @returns {Array<object>}
 */
export function portfolioRows(items) {
  const rows = (Array.isArray(items) ? items : [])
    .map((entry) => {
      const token = entry?.token && typeof entry.token === "object" ? entry.token : {};
      const decimals = finiteOrNull(token.decimals);
      const d = decimals ?? 18;
      const amount = amountNumber(entry?.value, d);
      const price = finiteOrNull(token.exchange_rate);
      // Both halves have to be real: an amount with no price and a price with no
      // readable amount are equally unvaluable, and neither is worth $0.
      const valueUsd = price !== null && amount !== null ? round2(amount * price) : null;
      const address = lowerAddress(token.address ?? token.address_hash ?? entry?.token_address);
      const verified = snapshotByAddress(address);
      return {
        symbol: sanitizeLabel(token.symbol, 16) ?? sanitizeLabel(token.name, 24),
        name: sanitizeLabel(token.name, 48),
        address,
        amount,
        amountDisplay: fmtTokenAmount(entry?.value, d),
        priceUsd: price,
        priceDisplay: displayNumber(price, "usd"),
        valueUsd,
        valueDisplay: displayNumber(valueUsd, "usd"),
        // Stated rather than inferred from a null, so an answer can say how many
        // rows it could not value without counting nulls itself.
        priced: valueUsd !== null,
        // Which of these are the equities Robinhood actually issued.
        equity: verified?.symbol ?? null,
        issuerVerified: Boolean(verified) || isCanonicalStockAddress(address),
        decimalsAssumed: decimals === null,
      };
    })
    .filter((row) => row.symbol || row.address);

  return rows.sort(compareByField("valueUsd", "desc")).map((row, i) => ({ ...row, rank: i + 1 }));
}

/**
 * Raw transfer rows -> what one wallet did, from that wallet's point of view.
 *
 * `direction` is relative to the wallet and is the field everything else here is
 * built on: "in" is a transfer this address received, "out" is one it sent. A
 * transfer touching neither side is "other" — it cannot happen on a feed keyed
 * by the address, but if a filter ever returns one it must not be counted as a
 * sale.
 *
 * @param {Array<object>} items - raw getTokenTransfers items
 * @param {string} self - the wallet the feed belongs to
 * @returns {Array<object>}
 */
export function traceRows(items, self) {
  const me = lowerAddress(self);
  return (Array.isArray(items) ? items : []).map((x, i) => {
    const decimals = finiteOrNull(x?.total?.decimals ?? x?.token?.decimals);
    const d = decimals ?? 18;
    const from = lowerAddress(x?.from?.hash ?? x?.from);
    const to = lowerAddress(x?.to?.hash ?? x?.to);
    const direction = from === me && to === me ? "self" : to === me ? "in" : from === me ? "out" : "other";
    return {
      rank: i + 1,
      time: x?.timestamp ?? null,
      timeMs: timeMs(x?.timestamp),
      direction,
      // Pre-rendered, because "in"/"out" in a drawn table is a puzzle.
      directionDisplay:
        direction === "in" ? "received" : direction === "out" ? "sent" : direction === "self" ? "self-transfer" : "unrelated",
      counterparty: direction === "in" ? from : direction === "out" ? to : (to ?? from),
      from,
      to,
      amount: amountNumber(x?.total?.value, d),
      amountDisplay: fmtTokenAmount(x?.total?.value, d),
      txHash: x?.transaction_hash ?? x?.tx_hash ?? null,
      decimalsAssumed: decimals === null,
    };
  });
}

/**
 * Sum the amounts that could actually be read, and say how many that was.
 *
 * The `counted`/`of` pair is the same discipline lib/token-evidence.js
 * concentrationOf uses: a total over eight of ten rows is a real figure about
 * eight rows, and it becomes a lie only if it is quoted as if it covered ten.
 */
function sumAmounts(rows) {
  const known = rows.map((r) => r?.amount).filter((n) => typeof n === "number" && Number.isFinite(n));
  return {
    total: known.length ? round2(known.reduce((acc, n) => acc + n, 0)) : null,
    counted: known.length,
    of: rows.length,
  };
}

/**
 * Who an address deals with, tallied across every feed it appears in.
 *
 * Counts INTERACTIONS, not value: a wallet's relationship with a router it
 * touches forty times is the thing being asked about, and totalling USD across
 * two feeds with different tokens would be a number with no unit. Direction is
 * kept per side so "both" is distinguishable from "only ever sent to".
 *
 * @param {Array<{ items: Array<object>, kind: string }>} feeds
 * @param {string} self
 * @returns {Array<object>} ranked rows, each with `rank` set
 */
export function counterpartyRows(feeds, self) {
  const me = lowerAddress(self);
  const map = new Map();

  const touch = (other, side, at, kind) => {
    const key = lowerAddress(other);
    if (!key || key === me) return;
    const row = map.get(key) ?? {
      address: key,
      interactions: 0,
      sent: 0,
      received: 0,
      transactions: 0,
      tokenTransfers: 0,
      lastSeenMs: null,
      lastSeen: null,
    };
    row.interactions += 1;
    row[side] += 1;
    if (kind === "transaction") row.transactions += 1;
    else row.tokenTransfers += 1;
    if (typeof at === "number" && (row.lastSeenMs === null || at > row.lastSeenMs)) {
      row.lastSeenMs = at;
      row.lastSeen = new Date(at).toISOString();
    }
    map.set(key, row);
  };

  for (const feed of Array.isArray(feeds) ? feeds : []) {
    for (const item of Array.isArray(feed?.items) ? feed.items : []) {
      const from = lowerAddress(item?.from?.hash ?? item?.from);
      const to = lowerAddress(item?.to?.hash ?? item?.to);
      const at = timeMs(item?.timestamp);
      // A contract creation has no `to`; a row touching neither side is not this
      // wallet's counterparty at all and is dropped rather than half-counted.
      if (from === me && to && to !== me) touch(to, "sent", at, feed.kind);
      else if (to === me && from && from !== me) touch(from, "received", at, feed.kind);
    }
  }

  return [...map.values()]
    // The shared nulls-last comparator, so an unknown count could never rank
    // first. Ties fall back to the address, which makes two runs over the same
    // sample produce the same table; recency lives in the row, not the order.
    .sort(compareByField("interactions", "desc"))
    .map((row, i) => {
      const verified = snapshotByAddress(row.address);
      return {
        ...row,
        rank: i + 1,
        direction: row.sent && row.received ? "both" : row.sent ? "sent to" : "received from",
        equity: verified?.symbol ?? null,
        issuerVerified: Boolean(verified) || isCanonicalStockAddress(row.address),
        isZeroAddress: row.address === ZERO_ADDRESS,
      };
    });
}

/* ------------------------------ 1. portfolio ------------------------------ */

/**
 * Everything one address holds: each token, how much, what it is worth, and the
 * ETH balance underneath it.
 *
 * The total is the part that has to be read carefully. It sums the PRICED
 * holdings and nothing else, and `unpricedCount` travels beside it, because on
 * this chain most ERC-20s carry no quote at all — a portfolio that says
 * "$41,203" while eleven of its nineteen holdings were unvalued has told the
 * reader something false about their own wallet. There is no path here that
 * treats an unpriced holding as $0, and none that sorts it as the smallest.
 *
 * @param {string} address - a 0x wallet or contract address
 * @param {{ calls?: object }} [options]
 * @returns {Promise<{ ok: boolean, kind?: string, evidence?: object, error?: string }>}
 */
export async function walletPortfolio(address, options = {}) {
  const calls = withCalls(options);
  const checked = requireAddress(address, "a portfolio");
  if (!checked.ok) return checked;
  const self = checked.value;

  try {
    const src = tracker();
    // All three at once: the balances are the answer, the overview carries the
    // ETH underneath it, and the counters are context that must not gate either.
    const overviewPromise = attempt(() => calls.getAddress(self, deadline(TIMEOUT_MS)));
    const balancesPromise = attempt(() => calls.getAddressTokenBalances(self, deadline(TIMEOUT_MS)));
    const countersPromise = attempt(() => calls.getAddressCounters(self, deadline(ENRICHMENT_TIMEOUT_MS)));

    const overviewRes = await overviewPromise;
    if (!overviewRes.ok) src.miss("balanceEth");
    const balancesRes = await balancesPromise;
    if (!balancesRes.ok) src.miss("holdings");
    const countersRes = await countersPromise;
    if (!countersRes.ok) src.miss("activity");

    const addr = overviewRes.data ?? null;
    if (!addr && !balancesRes.data) {
      if (overviewRes.status === 404) {
        return { ok: false, error: `Nothing exists at ${self} on Robinhood Chain.` };
      }
      return unavailableError(`the holdings of ${shortHex(self)}`, overviewRes.status ?? balancesRes.status);
    }

    // null, not []: a failed balances call is not a wallet holding nothing.
    const all = balancesRes.data ? portfolioRows(itemsOf(balancesRes.data)) : null;
    const rows = all ? all.slice(0, MAX_PORTFOLIO_ROWS) : [];
    const priced = all ? all.filter((r) => r.priced) : [];
    const unpricedCount = all ? all.length - priced.length : null;
    const totalValueUsd = priced.length ? round2(priced.reduce((acc, r) => acc + r.valueUsd, 0)) : null;
    const balanceEth = addr?.coin_balance != null ? weiToEth(addr.coin_balance) : null;

    const valuationNote = all
      ? unpricedCount
        ? `${priced.length} of ${all.length} holdings carry a price on this indexer, and the total is the sum of those only. The other ${unpricedCount} could not be valued — this indexer prices the issuer-verified tokenized equities and little else, so unpriced means unquoted, not worthless.`
        : all.length
          ? `Every one of the ${all.length} holdings carried a price, so the total covers all of them.`
          : "The indexer returned no token balances for this address — a measured empty wallet, not a failed lookup."
      : null;

    const table = all
      ? buildTable({
          id: "wallet-portfolio",
          title: `${rows.length} token holding${rows.length === 1 ? "" : "s"} in ${shortHex(self)}`,
          columns: [
            col("rank", "#", "right"),
            col("symbol", "Token"),
            col("amountDisplay", "Amount", "right"),
            col("priceDisplay", "Price", "right"),
            col("valueDisplay", "Value", "right"),
            col("address", "Contract"),
          ],
          rows,
          // A measured count from a body that arrived, so "50 of 118" is real.
          totalRows: all.length,
          truncated: rows.length < all.length,
          note: [
            "Sorted by USD value, with the holdings this indexer carries no price for last — unpriced is not zero-value and is not the smallest position.",
            valuationNote,
            "Balances and prices are the indexer's at the time of the lookup.",
          ]
            .filter(Boolean)
            .join(" "),
        })
      : null;

    return {
      ok: true,
      kind: "portfolio",
      evidence: {
        ...src.gaps(),
        address: self,
        isContract: addr?.is_contract ?? null,
        name: sanitizeLabel(addr?.name),
        // ETH is the gas token here, so it is quoted in ETH and never folded
        // into the USD total — there is no ETH/USD feed on this indexer.
        balanceEth,
        balanceEthDisplay: balanceEth === null ? null : `${balanceEth} ETH`,
        totalTransactions: finiteOrNull(countersRes.data?.transactions_count),
        tokenTransferCount: finiteOrNull(countersRes.data?.token_transfers_count),
        // null when the call failed: zero holdings is a claim about the wallet.
        holdingsRead: all ? all.length : null,
        rowsShown: rows.length,
        pricedCount: all ? priced.length : null,
        unpricedCount,
        // The priced portion ONLY, and the note beside it says so.
        totalValueUsd,
        totalValueDisplay: displayNumber(totalValueUsd, "usd"),
        valuationNote,
        issuerVerifiedHoldings: all ? all.filter((r) => r.issuerVerified).length : null,
        // The most valuable few, for the rows the prose names. Every row the
        // caller gets is in the table below — see PROSE_HOLDINGS.
        holdings: all ? all.slice(0, PROSE_HOLDINGS) : null,
        ...(table ? { table } : {}),
        asOf: nowIso(),
      },
    };
  } catch (e) {
    return { ok: false, error: `The portfolio could not be read: ${String(e?.message ?? e).slice(0, 200)}.` };
  }
}

/* ------------------------------ 2. trace ------------------------------ */

/**
 * What ONE wallet did in ONE token: how many times it received, how many times
 * it sent, when it started, when it last moved, where that leaves it, and
 * whether it has ever sold at all.
 *
 * That last flag is the reason this lookup exists. "Accumulated and never
 * distributed" is a real and interesting reading of an address, and it is one
 * that a truncated history cannot support: absence of a sale in the transfers
 * read is not absence of a sale. So `hasSold` has three states —
 *
 *   true  — an outgoing transfer was seen, and it is in the table
 *   false — none was seen AND the walk reached the end of the history
 *   null  — none was seen but the walk was cut short, so this is UNKNOWN
 *
 * — and `reading` is written here rather than left to the model, because the
 * difference between "has never sold" and "has not sold in the 150 transfers I
 * could read" is exactly the sentence that must not be improvised.
 *
 * @param {string} address - the wallet
 * @param {string} token - ticker, company name or 0x contract address
 * @param {{ calls?: object }} [options]
 * @returns {Promise<{ ok: boolean, kind?: string, evidence?: object, error?: string }>}
 */
export async function traceWallet(address, token, options = {}) {
  const calls = withCalls(options);
  const checked = requireAddress(address, "a wallet's history in one token");
  if (!checked.ok) return checked;
  const self = checked.value;

  try {
    const target = await resolveTokenTarget(token, calls);
    if (!target.ok) return target;

    const src = tracker();
    // The wallet's current balance of this token, started now so it overlaps the
    // walk. It is what turns "net +400 across the transfers read" into something
    // checkable, and losing it costs that one field.
    const balancesPromise = attempt(() => calls.getAddressTokenBalances(self, deadline(ENRICHMENT_TIMEOUT_MS)));

    /*
     * THE WALK. `token` is passed as a filter because Blockscout v2 accepts one
     * on this endpoint, and every row is ALSO matched on the contract address
     * locally — if a deployment ignores the parameter, the filter still happens,
     * it just costs more pages to fill. Believing the parameter alone would mean
     * counting another token's transfers as this one's.
     */
    let params = { type: "ERC-20", token: target.address };
    const matched = [];
    let scanned = 0;
    let pages = 0;
    let next = null;
    let cutShort = false;

    for (; pages < MAX_TRACE_PAGES; pages += 1) {
      const res = await attempt(() => calls.getTokenTransfers(self, params, deadline(TIMEOUT_MS)));
      if (!res.ok || !res.data) {
        if (pages === 0) {
          src.miss("transfers");
          return unavailableError(
            `what ${shortHex(self)} has done in ${target.symbol ?? shortHex(target.address)}`,
            res.status,
          );
        }
        // Some pages landed. Keep them, and say the history stops here.
        cutShort = true;
        break;
      }

      const items = itemsOf(res.data);
      scanned += items.length;
      for (const item of items) {
        if (tokenAddressOf(item) === target.address) matched.push(item);
      }

      next = cursorParams(res.data?.next_page_params);
      if (!next || matched.length >= MAX_TRACE_TRANSFERS) break;
      const following = { ...next, type: "ERC-20", token: target.address };
      // A cursor that repeats itself is an upstream bug; walking it loops
      // forever. Stopping there is NOT reaching the end of the history, so it
      // counts as cut short — otherwise a broken cursor would license the
      // strongest claim this function makes, that the wallet has never sold.
      if (sameParams(following, params)) {
        cutShort = true;
        break;
      }
      params = following;
    }

    // More upstream than we read, or a page that never came back: either way the
    // history in hand is a prefix, and every claim below is bounded by it.
    const truncated = Boolean(next) || cutShort;

    const rows = traceRows(matched, self);
    const inRows = rows.filter((r) => r.direction === "in");
    const outRows = rows.filter((r) => r.direction === "out");
    const selfRows = rows.filter((r) => r.direction === "self");
    const received = sumAmounts(inRows);
    const sent = sumAmounts(outRows);
    const netPosition =
      received.total === null && sent.total === null ? null : round2((received.total ?? 0) - (sent.total ?? 0));

    // The three states. Only a complete walk can turn "no sale seen" into false.
    const hasSold = outRows.length > 0 ? true : truncated ? null : false;

    const times = knownTimes(rows);
    const balancesRes = await balancesPromise;
    if (!balancesRes.ok) src.miss("currentBalance");
    const held = balancesRes.data ? currentHolding(itemsOf(balancesRes.data), target.address) : null;
    const symbol = target.symbol ?? null;

    const shown = rows.slice(0, TRACE_TABLE_ROWS);
    const table = buildTable({
      id: "wallet-trace",
      title: `${rows.length} transfer${rows.length === 1 ? "" : "s"} of ${symbol ?? shortHex(target.address)} by ${shortHex(self)}`,
      columns: [
        col("rank", "#", "right"),
        col("time", "Time"),
        col("directionDisplay", "Direction"),
        col("counterparty", "Counterparty"),
        col("amountDisplay", "Amount", "right"),
        col("txHash", "Transaction"),
      ],
      rows: shown,
      totalRows: rows.length,
      truncated: truncated || shown.length < rows.length,
      note: [
        `Matched on the token's contract address across the ${scanned} most recent transfer${scanned === 1 ? "" : "s"} of this wallet that the indexer returned.`,
        truncated
          ? "The walk stopped before the end of this wallet's history, so these are its most recent transfers in this token and not all of them."
          : "The walk reached the end of what the indexer holds for this wallet in this token.",
        "\"received\" and \"sent\" are transfers in and out; on-chain that covers airdrops, mints and wallet-to-wallet moves as well as trades.",
      ].join(" "),
    });

    return {
      ok: true,
      kind: "trace",
      evidence: {
        ...src.gaps(),
        wallet: self,
        token: {
          address: target.address,
          symbol,
          company: target.company ?? null,
          issuerVerified: target.snapshotted,
        },
        // What the numbers below are computed over. Every one of these bounds
        // the claim an answer is allowed to make.
        transfersRead: rows.length,
        transfersScanned: scanned,
        pagesRead: Math.min(pages + 1, MAX_TRACE_PAGES),
        historyComplete: !truncated,
        truncated,
        // The requested counts. `basis` says what they actually mean, because a
        // transfer in is an acquisition and not necessarily a purchase.
        buys: inRows.length,
        sells: outRows.length,
        selfTransfers: selfRows.length,
        basis:
          "A transfer in is counted as a buy and a transfer out as a sell. On-chain that is acquisition and disposal — an airdrop, a mint or a move between the same owner's wallets counts the same as a trade.",
        received: { ...received, display: received.total === null ? null : `${received.total} ${symbol ?? ""}`.trim() },
        sent: { ...sent, display: sent.total === null ? null : `${sent.total} ${symbol ?? ""}`.trim() },
        netPosition,
        netPositionDisplay: netPosition === null ? null : `${netPosition} ${symbol ?? ""}`.trim(),
        // TRUE, FALSE or NULL — see the header of this function.
        hasSold,
        soldInSample: outRows.length > 0,
        firstSeen: times.length ? new Date(times[0]).toISOString() : null,
        lastSeen: times.length ? new Date(times[times.length - 1]).toISOString() : null,
        activitySpan: times.length >= 2 ? spanWords(times[times.length - 1] - times[0]) : null,
        // What it actually holds now, so the net figure above is checkable.
        currentBalance: held,
        reading: traceReading({ rows, inRows, outRows, hasSold, truncated, symbol, netPosition, held }),
        recentTransfers: rows.slice(0, PROSE_TRACE),
        table,
        asOf: nowIso(),
      },
    };
  } catch (e) {
    return { ok: false, error: `The wallet's history in that token could not be read: ${String(e?.message ?? e).slice(0, 200)}.` };
  }
}

/** What this wallet holds of the traced token right now, or null. */
function currentHolding(items, tokenAddress) {
  for (const entry of Array.isArray(items) ? items : []) {
    const token = entry?.token && typeof entry.token === "object" ? entry.token : {};
    if (lowerAddress(token.address ?? token.address_hash ?? entry?.token_address) !== tokenAddress) continue;
    const decimals = finiteOrNull(token.decimals);
    const d = decimals ?? 18;
    const amount = amountNumber(entry?.value, d);
    const price = finiteOrNull(token.exchange_rate);
    const valueUsd = price !== null && amount !== null ? round2(amount * price) : null;
    return {
      amount,
      amountDisplay: fmtTokenAmount(entry?.value, d),
      valueUsd,
      valueDisplay: displayNumber(valueUsd, "usd"),
    };
  }
  // The balances body arrived and this token was not in it, which is a real
  // answer: the wallet holds none of it now.
  return { amount: 0, amountDisplay: "0", valueUsd: null, valueDisplay: null };
}

/**
 * The trace said in sentences — one per fact that is actually established.
 *
 * Written here for the reason contractReading is: "has never sold" and "has not
 * sold in what I could read" are different statements, only one of them is
 * supportable from a capped walk, and the wording of that distinction is not
 * something to re-derive per answer.
 */
function traceReading({ rows, inRows, outRows, hasSold, truncated, symbol, netPosition, held }) {
  const ticker = symbol ?? "this token";
  if (!rows.length) {
    return truncated
      ? `No transfer of ${ticker} by this wallet appears in the transfers that could be read, and the walk stopped short of the end of its history — so this is "none found in the sample", not "never touched it".`
      : `This wallet has no transfers of ${ticker} in the indexer's history for it at all.`;
  }

  const lines = [
    `${rows.length} transfer${rows.length === 1 ? "" : "s"} of ${ticker} by this wallet were read: ${inRows.length} in, ${outRows.length} out.`,
  ];

  if (hasSold === false) {
    lines.push(
      `Every one of them was incoming, and the walk covered this wallet's whole history in ${ticker} — it accumulated and never distributed.`,
    );
  } else if (hasSold === null) {
    lines.push(
      `None of them was outgoing, but the walk stopped before the end of its history, so whether it has ever sold ${ticker} is unknown rather than no. Say that no sale appears in the transfers read.`,
    );
  } else {
    lines.push(`It has sent ${ticker} out, so it is not a wallet that has only ever accumulated.`);
  }

  if (netPosition !== null) {
    lines.push(
      `Net across the transfers read: ${netPosition >= 0 ? "+" : ""}${netPosition} ${ticker}${truncated ? ", over that sample rather than over its whole history" : ""}.`,
    );
  }
  if (held && typeof held.amount === "number") {
    lines.push(`It currently holds ${held.amountDisplay} ${ticker}.`);
  }
  return lines.join(" ");
}

/* ------------------------------ 3. counterparties ------------------------------ */

/**
 * Who an address actually deals with, ranked by how often.
 *
 * Two feeds are counted rather than one: native transactions and ERC-20
 * transfers. On a chain whose point is tokenized equities, an address's real
 * relationships are mostly in the second, and a counterparty list built from
 * transactions alone would miss the token contracts and routers it works
 * through. Both are one page each — this is a picture of recent dealing, and the
 * evidence says so beside the address's total transaction count, so nobody reads
 * "its biggest counterparty" off a sample of fifty rows.
 *
 * @param {string} address
 * @param {{ limit?: number, calls?: object }} [options]
 * @returns {Promise<{ ok: boolean, kind?: string, evidence?: object, error?: string }>}
 */
export async function walletCounterparties(address, options = {}) {
  const calls = withCalls(options);
  const checked = requireAddress(address, "an address's counterparties");
  if (!checked.ok) return checked;
  const self = checked.value;
  const limit = clampCount(options?.limit, 15, MAX_COUNTERPARTY_ROWS);

  try {
    const src = tracker();
    const txPromise = attempt(() => calls.getAddressTransactions(self, {}, deadline(TIMEOUT_MS)));
    const transferPromise = attempt(() => calls.getTokenTransfers(self, { type: "ERC-20" }, deadline(TIMEOUT_MS)));
    const countersPromise = attempt(() => calls.getAddressCounters(self, deadline(ENRICHMENT_TIMEOUT_MS)));

    const txRes = await txPromise;
    if (!txRes.ok) src.miss("transactions");
    const transferRes = await transferPromise;
    if (!transferRes.ok) src.miss("tokenTransfers");
    const countersRes = await countersPromise;
    if (!countersRes.ok) src.miss("activity");

    if (!txRes.data && !transferRes.data) {
      return unavailableError(
        `who ${shortHex(self)} interacts with`,
        txRes.status ?? transferRes.status,
      );
    }

    const txItems = txRes.data ? itemsOf(txRes.data) : [];
    const transferItems = transferRes.data ? itemsOf(transferRes.data) : [];
    const ranked = counterpartyRows(
      [
        { items: txItems, kind: "transaction" },
        { items: transferItems, kind: "transfer" },
      ],
      self,
    );
    const rows = ranked.slice(0, limit);
    // A next page on either feed means the tally is over a window, not a life.
    const sampleTruncated = Boolean(txRes.data?.next_page_params) || Boolean(transferRes.data?.next_page_params);
    const totalTransactions = finiteOrNull(countersRes.data?.transactions_count);
    const totalTransfers = finiteOrNull(countersRes.data?.token_transfers_count);

    const table = buildTable({
      id: "wallet-counterparties",
      title: `${rows.length} address${rows.length === 1 ? "" : "es"} ${shortHex(self)} deals with`,
      columns: [
        col("rank", "#", "right"),
        col("address", "Counterparty"),
        col("equity", "Robinhood equity"),
        col("direction", "Direction"),
        col("interactions", "Interactions", "right"),
        col("lastSeen", "Last seen"),
      ],
      rows,
      totalRows: ranked.length,
      truncated: rows.length < ranked.length || sampleTruncated,
      note: [
        // Each feed is described only if it actually answered: "0 transactions"
        // for a call that failed would read as an address that has never
        // transacted, which is the whole class of claim this file refuses.
        `Counted over ${[
          txRes.data ? `the ${txItems.length} most recent transaction${txItems.length === 1 ? "" : "s"}` : null,
          transferRes.data ? `${transferItems.length} token transfer${transferItems.length === 1 ? "" : "s"}` : null,
        ]
          .filter(Boolean)
          .join(" and ")} the indexer returned for this address${
          totalTransactions !== null ? `, out of ${displayNumber(totalTransactions, "count")} transactions in total` : ""
        }.${txRes.data && transferRes.data ? "" : " One of the two feeds did not answer, so this counts only the other."}`,
        sampleTruncated
          ? "There is more history upstream, so this ranks who it has dealt with recently rather than who it has dealt with most."
          : "That is this address's whole history in the indexer's answer.",
        "The \"Robinhood equity\" column names the counterparty when it is one of the issuer-verified tokenized-equity contracts; a blank means it is not in that verified set, not that it is suspicious.",
      ].join(" "),
    });

    return {
      ok: true,
      kind: "counterparties",
      evidence: {
        ...src.gaps(),
        address: self,
        // What was counted, so no answer can imply a wider sweep.
        sampled: {
          transactions: txRes.data ? txItems.length : null,
          tokenTransfers: transferRes.data ? transferItems.length : null,
          moreUpstream: sampleTruncated,
        },
        totalTransactions,
        totalTokenTransfers: totalTransfers,
        distinctCounterparties: ranked.length,
        rowsShown: rows.length,
        limit,
        equityCounterparties: ranked.filter((r) => r.issuerVerified).length,
        // The busiest few, for the rows the prose names. Every row the caller
        // asked for is in the table below — repeating all fifty here would put
        // this result past lib/ask-loop.js MAX_EVIDENCE_CHARS on its own, and
        // the table is the half that would get truncated away.
        counterparties: rows.slice(0, PROSE_COUNTERPARTIES),
        note: "Ranked by how many interactions appear in the recent sample above, not by value moved and not over the address's whole history. A counterparty seen once is still a counterparty; a blank equity column only means the address is not one of the verified equity contracts.",
        table,
        asOf: nowIso(),
      },
    };
  } catch (e) {
    return { ok: false, error: `The counterparties could not be read: ${String(e?.message ?? e).slice(0, 200)}.` };
  }
}
