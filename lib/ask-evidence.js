import { formatUnits } from "viem";
import {
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

/** Classify a Robinhood Chain identifier from its shape. */
export function classifyTarget(raw) {
  const t = String(raw ?? "").trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(t)) return { kind: "tx", value: t };
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) return { kind: "address", value: t };
  return { kind: "unknown", value: t };
}

/**
 * Run one indexer call without letting it fail the whole gather. Takes a thunk
 * rather than a promise: a getter that throws synchronously (bad config, a URL
 * that won't build) never produces a promise to catch, so the throw escaped.
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
 * Gather human-oriented evidence for one target (tx, token, or wallet) from
 * Blockscout. Every call is best-effort so partial data still yields an answer.
 *
 * When some sub-calls fail the gather still succeeds, but says so: the failed
 * field names are listed in `evidence.unavailable` and the response is marked
 * `degraded: true`.
 *
 * @param {string} target - 0x address or 0x tx hash
 * @returns {Promise<{ ok: boolean, kind: string, target: string, degraded?: boolean, evidence?: object, error?: string }>}
 */
export async function gatherEvidence(target) {
  const { kind, value } = classifyTarget(target);

  if (kind === "tx") {
    const src = sources();
    const [txRes, logs] = await Promise.all([
      attempt(() => getTransaction(value)),
      src.get("decodedLogs", () => getTransactionLogs(value)),
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

  if (kind === "address") {
    const addrRes = await attempt(() => getAddress(value));
    if (!addrRes.ok || !addrRes.data) return lookupFailure(kind, value, addrRes.status, "Address");
    const addr = addrRes.data;

    // Blockscout sends `token: null` on every non-token contract, so presence of
    // the key says nothing — only a populated `token` object means it's a token.
    const isToken = Boolean(addr.token);
    return isToken ? await tokenEvidence(value, addr) : await walletEvidence(value, addr);
  }

  return {
    ok: false,
    kind,
    target: value,
    error: "Not a recognizable Robinhood Chain address (0x…40) or transaction hash (0x…64).",
  };
}

/** A token contract: metadata, supply, market data, top holders, recent transfers. */
async function tokenEvidence(value, addr) {
  const src = sources();
  const [token, counters, holders, activity] = await Promise.all([
    src.get("token", () => getToken(value)),
    src.get("tokenCounters", () => getTokenCounters(value)),
    src.get("topHolders", () => getTokenHolders(value)),
    src.get("recentTransfers", () => getTokenActivity(value)),
  ]);
  // No token metadata from either source: it isn't a token after all. Emit wallet
  // evidence rather than a hollow all-null token record.
  if (!token && !addr.token) return await walletEvidence(value, addr);

  const t = token ?? addr.token ?? {};
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
      address: addr.hash ?? value,
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
      },
      contract: {
        verified: addr.is_verified ?? null,
        creator: addr.creator_address_hash ?? null,
        creationTx: addr.creation_tx_hash ?? null,
      },
      topHolders,
      holderConcentrationTop10Pct: topHolders ? sumShares(topHolders) : null,
      recentTransfers,
    },
  };
}

/** A wallet / non-token contract: balance, token holdings, activity, counterparties. */
async function walletEvidence(value, addr) {
  const src = sources();
  const [counters, balances, txs, transfers] = await Promise.all([
    src.get("counters", () => getAddressCounters(value)),
    src.get("tokenHoldings", () => getAddressTokenBalances(value)),
    src.get("counterparties", () => getAddressTransactions(value)),
    src.get("recentTransfers", () => getTokenTransfers(value, { type: "ERC-20" })),
  ]);
  const txItems = Array.isArray(txs?.items) ? txs.items : [];
  const xferItems = Array.isArray(transfers?.items) ? transfers.items : [];
  const balItems = Array.isArray(balances) ? balances : Array.isArray(balances?.items) ? balances.items : [];

  // Each list stays null when its source failed, so a brownout can't be read as
  // "this wallet holds nothing / has never transferred".
  const tokenHoldings = balances
    ? balItems
        .map((b) => ({
          token: sanitizeLabel(b.token?.symbol, 16) ?? sanitizeLabel(b.token?.name),
          amount: fmtTokenAmount(b.value, numOr(b.token?.decimals, 18)),
          valueUsd:
            b.token?.exchange_rate != null && b.value != null
              ? round2(
                  Number(formatUnits(safeBig(b.value), numOr(b.token?.decimals, 18))) *
                    Number(b.token.exchange_rate),
                )
              : null,
        }))
        .filter((h) => h.token)
        .slice(0, 12)
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
export { compact, weiToEth, sumShares, fmtTokenAmount, pctOfSupply, sanitizeLabel };

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
