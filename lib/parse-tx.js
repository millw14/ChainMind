import { SWAP_PROGRAM_HINTS, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./programs.js";

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

/** Base58 program id from a parsed/partially-decoded instruction. */
function ixProgramId(ix) {
  const pid = ix?.programId;
  if (!pid) return null;
  if (typeof pid === "string") return pid;
  return pid.toBase58?.() ?? pid.toString?.() ?? null;
}

/** Flatten top-level + inner (CPI) instructions — classification must see both, since
 *  a swap's DEX call or an SPL transfer often lives in inner instructions. */
function allInstructions(parsed) {
  const out = [];
  for (const ix of parsed?.transaction?.message?.instructions ?? []) out.push(ix);
  for (const inner of parsed?.meta?.innerInstructions ?? []) {
    for (const ix of inner?.instructions ?? []) out.push(ix);
  }
  return out;
}

/**
 * Coarse → richer event classification (Phase 2, v2). Reads parsed instruction *types*
 * (not just top-level program ids) across top-level + inner instructions to produce a
 * taxonomy detectors can reason about: swap / transfer / mint / burn / sol_transfer /
 * spl_other / other / unknown.
 *
 * The v2 taxonomy values are themselves the version marker — any row still labeled
 * `swap_eligible` or `spl` predates this classifier (find them with
 * `event_type IN ('swap_eligible','spl')` and re-parse via `npm run reparse`).
 *
 * Known limitation (deliverable 2 — program-specific decoders): LP add/remove and
 * swap direction (buy/sell) + named venue aren't distinguished yet. A DEX-program tx is
 * labeled `swap`; a pure mint (no DEX) is `mint`. So a launch-with-bonding-curve lands as
 * `mint` and an LP add on a raw AMM may land as `swap` — refined when per-venue decoders land.
 *
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

  // Top-level program ids — preserved as-is for programs_json (unchanged shape).
  const topProgramIds = [];
  for (const ix of msg.instructions ?? []) {
    const pid = ixProgramId(ix);
    if (pid) topProgramIds.push(pid);
  }
  const uniqueTop = [...new Set(topProgramIds)];

  // Classify from ALL instructions + their parsed types.
  const programIds = new Set();
  const splTypes = new Set();
  let hasSolTransfer = false;
  for (const ix of allInstructions(parsed)) {
    const pid = ixProgramId(ix);
    if (pid) programIds.add(pid);
    const type = ix?.parsed?.type;
    if (!type) continue;
    const prog = ix?.program;
    if (prog === "spl-token" || prog === "spl-token-2022" || pid === TOKEN_PROGRAM || pid === TOKEN_2022_PROGRAM) {
      splTypes.add(type);
    } else if (prog === "system" || pid === SYSTEM_PROGRAM) {
      if (type === "transfer" || type === "transferWithSeed") hasSolTransfer = true;
    }
  }

  const has = (...t) => t.some((x) => splTypes.has(x));
  const hasDex = [...programIds].some((p) => SWAP_PROGRAM_HINTS.has(p));
  const hasTokenProgram = programIds.has(TOKEN_PROGRAM) || programIds.has(TOKEN_2022_PROGRAM);

  let eventType;
  if (has("mintTo", "mintToChecked")) eventType = "mint";
  else if (has("burn", "burnChecked")) eventType = "burn";
  else if (hasDex) eventType = "swap";
  else if (has("transfer", "transferChecked")) eventType = "transfer";
  else if (hasSolTransfer) eventType = "sol_transfer";
  else if (hasTokenProgram) eventType = "spl_other";
  else eventType = "other";

  const parse_note = parsed.meta?.err ? `tx_err:${JSON.stringify(parsed.meta.err)}` : null;

  return {
    event_type: eventType,
    fee_payer: feePayer,
    programs_json: JSON.stringify(uniqueTop.slice(0, 48)),
    counterparties_json: JSON.stringify(counterparties.slice(0, 64)),
    parse_note,
  };
}
