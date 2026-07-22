import {
  getAddress,
  getAddressTransactions,
  getToken,
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
 * Gather compact, human-oriented evidence for one target (address or tx) from
 * Blockscout. Every call is best-effort so partial data still yields an answer.
 * The shape is intentionally small so it fits comfortably in a Groq prompt.
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
        tokenTransferCount: Array.isArray(tx.token_transfers) ? tx.token_transfers.length : null,
        logCount: logList.length,
        decodedLogs: logList
          .slice(0, 8)
          .map((l) => l?.decoded?.method_call || l?.decoded?.name || null)
          .filter(Boolean),
      },
    };
  }

  if (kind === "address") {
    const [addr, txs, transfers] = await Promise.all([
      safe(getAddress(value)),
      safe(getAddressTransactions(value)),
      safe(getTokenTransfers(value, { type: "ERC-20" })),
    ]);
    if (!addr) return { ok: false, kind, target: value, error: "Address not found on Robinhood Chain." };

    const isToken = Boolean(addr.token) || addr.is_contract === true;
    const token = isToken ? await safe(getToken(value)) : null;
    const txItems = Array.isArray(txs?.items) ? txs.items : [];
    const xferItems = Array.isArray(transfers?.items) ? transfers.items : [];

    return {
      ok: true,
      kind,
      target: value,
      evidence: {
        address: addr.hash ?? value,
        isContract: addr.is_contract ?? false,
        balanceEth: addr.coin_balance != null ? weiToEth(addr.coin_balance) : null,
        name: addr.name ?? addr.token?.name ?? token?.name ?? null,
        token: token
          ? {
              name: token.name ?? null,
              symbol: token.symbol ?? null,
              type: token.type ?? null,
              decimals: token.decimals ?? null,
              totalSupply: token.total_supply ?? null,
              holders: token.holders ?? token.holders_count ?? null,
            }
          : null,
        recentTxCount: txItems.length,
        recentTransfers: xferItems.slice(0, 8).map((t) => ({
          token: t.token?.symbol ?? t.token?.name ?? null,
          from: t.from?.hash ?? null,
          to: t.to?.hash ?? null,
          value: t.total?.value ?? t.value ?? null,
        })),
        counterparties: uniqueCounterparties(txItems, value).slice(0, 8),
      },
    };
  }

  return {
    ok: false,
    kind,
    target: value,
    error: "Not a recognizable Robinhood Chain address (0x…40) or transaction hash (0x…64).",
  };
}

function weiToEth(wei) {
  try {
    const n = BigInt(wei);
    // 6-dp string without pulling in a bignum formatter
    const whole = n / 1_000_000_000_000n; // to micro-eth
    return Number(whole) / 1_000_000;
  } catch {
    return null;
  }
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
