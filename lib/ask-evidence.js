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

async function safe(promise) {
  try {
    return await promise;
  } catch {
    return null;
  }
}

/**
 * Gather human-oriented evidence for one target (tx, token, or wallet) from
 * Blockscout. Every call is best-effort so partial data still yields an answer.
 *
 * @param {string} target - 0x address or 0x tx hash
 * @returns {Promise<{ ok: boolean, kind: string, target: string, evidence?: object, error?: string }>}
 */
export async function gatherEvidence(target) {
  const { kind, value } = classifyTarget(target);

  if (kind === "tx") {
    const [tx, logs] = await Promise.all([
      safe(getTransaction(value)),
      safe(getTransactionLogs(value)),
    ]);
    if (!tx) return { ok: false, kind, target: value, error: "Transaction not found on Robinhood Chain." };
    const logList = Array.isArray(logs?.items) ? logs.items : [];
    return {
      ok: true,
      kind,
      target: value,
      evidence: {
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
              token: t.token?.symbol ?? t.token?.name ?? null,
              from: t.from?.hash ?? null,
              to: t.to?.hash ?? null,
              amount: fmtTokenAmount(t.total?.value, t.total?.decimals ?? t.token?.decimals),
            }))
          : [],
        logCount: logList.length,
        decodedLogs: logList
          .slice(0, 8)
          .map((l) => l?.decoded?.method_call || l?.decoded?.name || null)
          .filter(Boolean),
      },
    };
  }

  if (kind === "address") {
    const addr = await safe(getAddress(value));
    if (!addr) return { ok: false, kind, target: value, error: "Address not found on Robinhood Chain." };

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
  const [token, counters, holders, activity] = await Promise.all([
    safe(getToken(value)),
    safe(getTokenCounters(value)),
    safe(getTokenHolders(value)),
    safe(getTokenActivity(value)),
  ]);
  // No token metadata from either source: it isn't a token after all. Emit wallet
  // evidence rather than a hollow all-null token record.
  if (!token && !addr.token) return await walletEvidence(value, addr);

  const t = token ?? addr.token ?? {};
  const decimals = numOr(t.decimals, 18);
  const rawSupply = t.total_supply ?? null;
  const holderCount = counters?.token_holders_count ?? t.holders ?? t.holders_count ?? null;

  const holderItems = Array.isArray(holders?.items) ? holders.items : [];
  const topHolders = holderItems.slice(0, 10).map((h) => ({
    address: h.address?.hash ?? null,
    amount: fmtTokenAmount(h.value, decimals),
    share: pctOfSupply(h.value, rawSupply),
  }));

  const activityItems = Array.isArray(activity?.items) ? activity.items : [];
  const recentTransfers = activityItems.slice(0, 8).map((x) => ({
    from: x.from?.hash ?? null,
    to: x.to?.hash ?? null,
    amount: fmtTokenAmount(x.total?.value, decimals),
    timestamp: x.timestamp ?? null,
  }));

  return {
    ok: true,
    kind: "token",
    target: value,
    evidence: {
      address: addr.hash ?? value,
      token: {
        name: t.name ?? null,
        symbol: t.symbol ?? null,
        type: t.type ?? null,
        decimals,
        totalSupply: rawSupply != null ? `${fmtTokenAmount(rawSupply, decimals)} ${t.symbol ?? ""}`.trim() : null,
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
      holderConcentrationTop10Pct: sumShares(topHolders),
      recentTransfers,
    },
  };
}

/** A wallet / non-token contract: balance, token holdings, activity, counterparties. */
async function walletEvidence(value, addr) {
  const [counters, balances, txs, transfers] = await Promise.all([
    safe(getAddressCounters(value)),
    safe(getAddressTokenBalances(value)),
    safe(getAddressTransactions(value)),
    safe(getTokenTransfers(value, { type: "ERC-20" })),
  ]);
  const txItems = Array.isArray(txs?.items) ? txs.items : [];
  const xferItems = Array.isArray(transfers?.items) ? transfers.items : [];
  const balItems = Array.isArray(balances) ? balances : Array.isArray(balances?.items) ? balances.items : [];

  const tokenHoldings = balItems
    .map((b) => ({
      token: b.token?.symbol ?? b.token?.name ?? null,
      amount: fmtTokenAmount(b.value, numOr(b.token?.decimals, 18)),
      valueUsd:
        b.token?.exchange_rate != null && b.value != null
          ? round2(Number(formatUnits(safeBig(b.value), numOr(b.token?.decimals, 18))) * Number(b.token.exchange_rate))
          : null,
    }))
    .filter((h) => h.token)
    .slice(0, 12);

  return {
    ok: true,
    kind: "address",
    target: value,
    evidence: {
      address: addr.hash ?? value,
      isContract: addr.is_contract ?? false,
      name: addr.name ?? null,
      balanceEth: addr.coin_balance != null ? weiToEth(addr.coin_balance) : null,
      totalTransactions: counters?.transactions_count ?? null,
      tokenTransferCount: counters?.token_transfers_count ?? null,
      tokenHoldings,
      recentTransfers: xferItems.slice(0, 8).map((x) => ({
        token: x.token?.symbol ?? x.token?.name ?? null,
        from: x.from?.hash ?? null,
        to: x.to?.hash ?? null,
        amount: fmtTokenAmount(x.total?.value, numOr(x.total?.decimals ?? x.token?.decimals, 18)),
      })),
      counterparties: uniqueCounterparties(txItems, value).slice(0, 8),
    },
  };
}

/* ----------------------------- helpers ----------------------------- */

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
