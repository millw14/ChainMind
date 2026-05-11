import { SWAP_PROGRAM_HINTS, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./programs.js";

/**
 * @param {import("@solana/web3.js").AccountMeta | import("@solana/web3.js").PublicKey | string | { pubkey?: import("@solana/web3.js").PublicKey }} k
 */
function keyToB58(k) {
  if (k == null) return null;
  if (typeof k === "string") return k;
  if (typeof k === "object" && "pubkey" in k && k.pubkey) {
    return k.pubkey.toBase58?.() ?? String(k.pubkey);
  }
  return k.toBase58?.() ?? null;
}

/**
 * @param {import("@solana/web3.js").ParsedTransactionWithMeta | null} parsed
 */
export function parsedToEventRow(parsed) {
  if (!parsed?.transaction?.message) {
    return {
      event_type: "unknown",
      fee_payer: null,
      programs_json: "[]",
      counterparties_json: "[]",
      parse_note: "no_parsed_message",
    };
  }

  const msg = parsed.transaction.message;
  const keys = msg.accountKeys ?? [];
  const feePayer = keys.length ? keyToB58(keys[0]) : null;
  const counterparties = keys
    .slice(1)
    .map((a) => keyToB58(a))
    .filter(Boolean);

  const programIds = [];
  for (const ix of msg.instructions ?? []) {
    const pid = ix.programId?.toBase58?.() ?? ix.programId?.toString?.();
    if (pid) programIds.push(pid);
  }
  const unique = [...new Set(programIds)];

  let eventType = "other";
  let parse_note = null;
  if (unique.some((p) => SWAP_PROGRAM_HINTS.has(p))) {
    eventType = "swap_eligible";
  } else if (unique.includes(TOKEN_PROGRAM) || unique.includes(TOKEN_2022_PROGRAM)) {
    eventType = "spl";
  }

  if (parsed.meta?.err) {
    parse_note = `tx_err:${JSON.stringify(parsed.meta.err)}`;
  }

  return {
    event_type: eventType,
    fee_payer: feePayer,
    programs_json: JSON.stringify(unique.slice(0, 48)),
    counterparties_json: JSON.stringify(counterparties.slice(0, 64)),
    parse_note,
  };
}
