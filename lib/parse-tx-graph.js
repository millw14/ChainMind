import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { decodeInstruction, TokenInstruction } from "@solana/spl-token";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./programs.js";

/**
 * @typedef {{ address: string, role: "fee_payer" | "signer" }} GraphSigner
 * @typedef {{ idx: number, from_address: string, to_address: string, mint: string | null, amount: string }} GraphTransfer
 * @typedef {{ idx: number, program_id: string, instruction_name: string }} GraphProgramCall
 * @typedef {{ from_address: string, to_address: string, edge_type: string, mint: string | null }} GraphEdge
 */

/**
 * @param {unknown} p
 */
function b58(p) {
  if (p == null) return null;
  if (typeof p === "string") return p;
  if (typeof p === "object" && "pubkey" in /** @type {any} */ (p)) {
    const pk = /** @type {{ pubkey?: unknown }} */ (p).pubkey;
    return b58(pk);
  }
  if (typeof /** @type {any} */ (p).toBase58 === "function") return /** @type {{ toBase58: () => string }} */ (p).toBase58();
  return String(p);
}

/**
 * Flat account key list + signer flags for legacy / v0 parsed txs.
 * @param {import("@solana/web3.js").ParsedTransactionWithMeta} parsed
 */
function expandAccountKeys(parsed) {
  /** @type {string[]} */
  const keys = [];
  /** @type {boolean[]} */
  const signerFlags = [];

  const msg = parsed.transaction.message;
  const raw = msg.accountKeys ?? [];

  for (const k of raw) {
    if (typeof k === "string") {
      keys.push(k);
      signerFlags.push(false);
    } else if (k && typeof k === "object" && "pubkey" in k) {
      keys.push(b58(/** @type {{ pubkey: unknown }} */ (k).pubkey) ?? "");
      signerFlags.push(/** @type {{ signer?: boolean }} */ (k).signer === true);
    } else if (k && typeof /** @type {any} */ (k).toBase58 === "function") {
      keys.push(/** @type {{ toBase58: () => string }} */ (k).toBase58());
      signerFlags.push(false);
    }
  }

  const loaded = parsed.meta?.loadedAddresses;
  if (loaded?.writable?.length) {
    for (const p of loaded.writable) {
      keys.push(b58(p) ?? "");
      signerFlags.push(false);
    }
  }
  if (loaded?.readonly?.length) {
    for (const p of loaded.readonly) {
      keys.push(b58(p) ?? "");
      signerFlags.push(false);
    }
  }

  return { keys, signerFlags };
}

/**
 * @param {import("@solana/web3.js").ParsedTransactionWithMeta} parsed
 * @param {string[]} keys
 */
function buildAtaOwnerAndMint(parsed, keys) {
  /** @type {Map<string, string>} ATA pubkey → wallet owner */
  const ownerOfAta = new Map();
  /** @type {Map<string, string>} ATA pubkey → mint */
  const mintOfAta = new Map();

  const merge = (arr) => {
    for (const b of arr ?? []) {
      const ata = keys[b.accountIndex];
      if (!ata) continue;
      if (b.owner) ownerOfAta.set(ata, typeof b.owner === "string" ? b.owner : b58(b.owner) ?? "");
      if (b.mint) mintOfAta.set(ata, b.mint);
    }
  };

  merge(parsed.meta?.preTokenBalances);
  merge(parsed.meta?.postTokenBalances);

  return { ownerOfAta, mintOfAta };
}

/**
 * @param {unknown} ix
 */
function programIdOf(ix) {
  const raw = /** @type {{ programId?: unknown; program?: unknown }} */ (ix);
  return b58(raw.programId ?? raw.program);
}

/**
 * @param {unknown} ix
 * @param {string[]} accountKeys
 */
function compiledInstructionToTx(ix, accountKeys) {
  const pidStr = programIdOf(ix);
  if (!pidStr || typeof /** @type {{ data?: unknown }} */ (ix).data !== "string") return null;
  const accIdxs = /** @type {{ accounts?: number[] }} */ (ix).accounts;
  if (!accIdxs?.length) return null;

  let dataBuf;
  try {
    dataBuf = Buffer.from(bs58.decode(/** @type {{ data: string }} */ (ix).data));
  } catch {
    return null;
  }

  try {
    const programId = new PublicKey(pidStr);
    const keys = accIdxs.map((idx) => {
      const pkStr = accountKeys[idx];
      if (!pkStr) throw new Error("missing account index");
      return {
        pubkey: new PublicKey(pkStr),
        isSigner: false,
        isWritable: true,
      };
    });

    return new TransactionInstruction({
      programId,
      keys,
      data: dataBuf,
    });
  } catch {
    return null;
  }
}

/**
 * @param {import("@solana/web3.js").TransactionInstruction} ti
 * @param {PublicKey} programPk
 */
function decodeSplTransferLike(ti, programPk) {
  try {
    return decodeInstruction(ti, programPk);
  } catch {
    return null;
  }
}

/**
 * @param {ReturnType<decodeInstruction>} dec
 */
function splDecodedInstructionName(dec) {
  const t = /** @type {{ data?: { instruction?: number } }} */ (dec).data?.instruction;
  const map = {
    [TokenInstruction.Transfer]: "transfer",
    [TokenInstruction.TransferChecked]: "transferChecked",
    [TokenInstruction.MintTo]: "mintTo",
    [TokenInstruction.MintToChecked]: "mintToChecked",
    [TokenInstruction.Burn]: "burn",
    [TokenInstruction.BurnChecked]: "burnChecked",
    [TokenInstruction.Approve]: "approve",
    [TokenInstruction.CloseAccount]: "closeAccount",
  };
  return map[/** @type {number} */ (t)] ?? `spl_ix_${String(t ?? "?")}`;
}

/**
 * Apply SPL decoded transfer-like instructions to transfers + edges.
 * @returns {boolean} true when a transfer row was produced
 */
function applyDecodedSpl(dec, transferIdx, transfers, edges, ownerOfAta, mintOfAta) {
  const ins = /** @type {{ data?: { instruction?: number; amount?: bigint } }} */ (dec).data?.instruction;

  if (ins === TokenInstruction.Transfer || ins === TokenInstruction.TransferChecked) {
    const k = /** @type {{ keys: { source: { pubkey: PublicKey }; destination: { pubkey: PublicKey }; owner: { pubkey: PublicKey }; mint?: { pubkey: PublicKey } } }} */ (
      dec
    ).keys;
    const srcAta = k.source.pubkey.toBase58();
    const dstAta = k.destination.pubkey.toBase58();
    const authority = k.owner.pubkey.toBase58();
    const destWallet = ownerOfAta.get(dstAta) ?? dstAta;
    const amt =
      /** @type {{ data?: { amount?: bigint } }} */ (dec).data?.amount != null
        ? String(/** @type {{ data: { amount: bigint } }} */ (dec).data.amount)
        : "";
    let mint =
      ins === TokenInstruction.TransferChecked && k.mint
        ? k.mint.pubkey.toBase58()
        : mintOfAta.get(srcAta) ?? mintOfAta.get(dstAta) ?? null;

    transfers.push({
      idx: transferIdx,
      from_address: authority,
      to_address: destWallet,
      mint,
      amount: amt || "0",
    });
    edges.push({
      from_address: authority,
      to_address: destWallet,
      edge_type: "token_transfer",
      mint,
    });
    return true;
  }

  if (ins === TokenInstruction.MintTo || ins === TokenInstruction.MintToChecked) {
    const k = /** @type {{ keys: { mint: { pubkey: PublicKey }; destination: { pubkey: PublicKey }; authority: { pubkey: PublicKey } } }} */ (
      dec
    ).keys;
    const mint = k.mint.pubkey.toBase58();
    const dstAta = k.destination.pubkey.toBase58();
    const auth = k.authority.pubkey.toBase58();
    const destWallet = ownerOfAta.get(dstAta) ?? dstAta;
    const amt =
      /** @type {{ data?: { amount?: bigint } }} */ (dec).data?.amount != null
        ? String(/** @type {{ data: { amount: bigint } }} */ (dec).data.amount)
        : "";
    transfers.push({
      idx: transferIdx,
      from_address: auth,
      to_address: destWallet,
      mint,
      amount: amt || "0",
    });
    edges.push({
      from_address: auth,
      to_address: destWallet,
      edge_type: "mint_to",
      mint,
    });
    return true;
  }

  if (ins === TokenInstruction.Burn || ins === TokenInstruction.BurnChecked) {
    const k = /** @type {{ keys: { account: { pubkey: PublicKey }; mint: { pubkey: PublicKey }; owner: { pubkey: PublicKey } } }} */ (
      dec
    ).keys;
    const mint = k.mint.pubkey.toBase58();
    const auth = k.owner.pubkey.toBase58();
    const ata = k.account.pubkey.toBase58();
    const amt =
      /** @type {{ data?: { amount?: bigint } }} */ (dec).data?.amount != null
        ? String(/** @type {{ data: { amount: bigint } }} */ (dec).data.amount)
        : "";
    transfers.push({
      idx: transferIdx,
      from_address: auth,
      to_address: ata,
      mint,
      amount: amt || "0",
    });
    edges.push({
      from_address: auth,
      to_address: ata,
      edge_type: "burn",
      mint,
    });
    return true;
  }

  return false;
}

/**
 * JsonParsed SPL instructions from RPC.
 * @param {unknown} ix
 * @param {number} transferIdx
 * @param {GraphTransfer[]} transfers
 * @param {GraphEdge[]} edges
 * @param {Map<string, string>} ownerOfAta
 */
function handleJsonSpl(ix, transferIdx, transfers, edges, ownerOfAta) {
  const parsed = /** @type {{ parsed?: { type?: string; info?: Record<string, unknown> } }} */ (ix).parsed;
  if (!parsed?.type || !parsed.info) return false;

  const t = parsed.type;
  const info = parsed.info;

  if (t === "transfer" || t === "transferChecked") {
    const authority = typeof info.authority === "string" ? info.authority : b58(info.authority);
    const destAta = typeof info.destination === "string" ? info.destination : b58(info.destination);
    const mint =
      typeof info.mint === "string"
        ? info.mint
        : info.mint != null
          ? b58(info.mint)
          : null;
    if (!authority || !destAta) return false;

    const tok = /** @type {{ tokenAmount?: { amount?: string } }} */ (info).tokenAmount;
    const amount = tok?.amount ?? (typeof info.amount === "string" ? info.amount : String(info.amount ?? "0"));

    const destWallet = ownerOfAta.get(destAta) ?? destAta;

    transfers.push({
      idx: transferIdx,
      from_address: authority,
      to_address: destWallet,
      mint,
      amount,
    });
    edges.push({
      from_address: authority,
      to_address: destWallet,
      edge_type: "token_transfer",
      mint,
    });
    return true;
  }

  if (t === "mintTo" || t === "mintToChecked") {
    const mint = typeof info.mint === "string" ? info.mint : b58(info.mint);
    const destAta =
      (typeof info.account === "string" ? info.account : b58(info.account)) ||
      (typeof info.destination === "string" ? info.destination : b58(info.destination));
    const auth =
      (typeof info.mintAuthority === "string" ? info.mintAuthority : b58(info.mintAuthority)) ||
      (typeof info.authority === "string" ? info.authority : b58(info.authority));
    if (!mint || !destAta || !auth) return false;
    const tok = /** @type {{ tokenAmount?: { amount?: string } }} */ (info).tokenAmount;
    const amount = tok?.amount ?? String(info.amount ?? "0");
    const destWallet = ownerOfAta.get(destAta) ?? destAta;
    transfers.push({
      idx: transferIdx,
      from_address: auth,
      to_address: destWallet,
      mint,
      amount,
    });
    edges.push({
      from_address: auth,
      to_address: destWallet,
      edge_type: "mint_to",
      mint,
    });
    return true;
  }

  if (t === "burn" || t === "burnChecked") {
    const mint = typeof info.mint === "string" ? info.mint : b58(info.mint);
    const ata = typeof info.account === "string" ? info.account : b58(info.account);
    const auth = typeof info.authority === "string" ? info.authority : b58(info.authority);
    if (!mint || !ata || !auth) return false;
    const tok = /** @type {{ tokenAmount?: { amount?: string } }} */ (info).tokenAmount;
    const amount = tok?.amount ?? String(info.amount ?? "0");
    transfers.push({
      idx: transferIdx,
      from_address: auth,
      to_address: ata,
      mint,
      amount,
    });
    edges.push({
      from_address: auth,
      to_address: ata,
      edge_type: "burn",
      mint,
    });
    return true;
  }

  return false;
}

/**
 * Extract wallets & token flows & program trace for graph persistence.
 *
 * @param {import("@solana/web3.js").ParsedTransactionWithMeta | null} parsed
 * @param {number | null} slot
 */
export function extractTxGraph(parsed, slot) {
  /** @type {GraphSigner[]} */
  const signers = [];
  /** @type {GraphTransfer[]} */
  const transfers = [];
  /** @type {GraphProgramCall[]} */
  const programCalls = [];
  /** @type {GraphEdge[]} */
  const edges = [];

  if (!parsed?.transaction?.message) {
    return { signers, transfers, programCalls, edges, feePayer: null };
  }

  const { keys, signerFlags } = expandAccountKeys(parsed);
  const { ownerOfAta, mintOfAta } = buildAtaOwnerAndMint(parsed, keys);

  const feePayer = keys[0] ?? null;

  /** @type {Map<string, GraphSigner>} */
  const signerDedupe = new Map();

  if (feePayer) {
    signerDedupe.set(`${feePayer}\0fee_payer`, { address: feePayer, role: "fee_payer" });
  }

  keys.forEach((addr, i) => {
    if (!addr) return;
    if (signerFlags[i]) {
      signerDedupe.set(`${addr}\0signer`, { address: addr, role: "signer" });
    }
  });

  signers.push(...signerDedupe.values());

  let transferIdx = 0;
  let pcIdx = 0;

  /**
   * @param {unknown} ix
   */
  function processIx(ix) {
    const pidStr = programIdOf(ix);
    if (!pidStr) return;

    let ixName =
      /** @type {{ parsed?: { type?: string } }} */ (ix).parsed?.type != null
        ? String(/** @type {{ parsed: { type: string } }} */ (ix).parsed.type)
        : "unknown";

    const handledJsonSpl = handleJsonSpl(ix, transferIdx, transfers, edges, ownerOfAta);
    if (handledJsonSpl) transferIdx++;

    if (
      !handledJsonSpl &&
      (pidStr === TOKEN_PROGRAM || pidStr === TOKEN_2022_PROGRAM) &&
      /** @type {{ parsed?: unknown }} */ (ix).parsed == null
    ) {
      const ti = compiledInstructionToTx(ix, keys);
      if (ti) {
        const programPk = ti.programId;
        const dec = decodeSplTransferLike(ti, programPk);
        if (dec) {
          ixName = splDecodedInstructionName(dec);
          const did = applyDecodedSpl(dec, transferIdx, transfers, edges, ownerOfAta, mintOfAta);
          if (did) transferIdx++;
        }
      }
    }

    if (ixName === "unknown" && pidStr) ixName = "raw";

    programCalls.push({
      idx: pcIdx++,
      program_id: pidStr,
      instruction_name: ixName,
    });
  }

  const outer = parsed.transaction.message.instructions ?? [];
  for (const ix of outer) processIx(ix);

  const innerBlocks = parsed.meta?.innerInstructions ?? [];
  for (const block of innerBlocks) {
    for (const ix of block.instructions ?? []) processIx(ix);
  }

  const signerWalletSet = new Set(
    signers.filter((s) => s.role === "signer").map((s) => s.address),
  );

  if (feePayer) {
    for (const w of signerWalletSet) {
      if (w !== feePayer) {
        edges.push({
          from_address: feePayer,
          to_address: w,
          edge_type: "fee_payer_cosigner",
          mint: null,
        });
      }
    }
  }

  /** @type {Set<string>} */
  const edgeDedupe = new Set();
  const dedupedEdges = [];
  for (const e of edges) {
    const k = `${e.from_address}|${e.to_address}|${e.edge_type}|${e.mint ?? ""}`;
    if (edgeDedupe.has(k)) continue;
    edgeDedupe.add(k);
    dedupedEdges.push(e);
  }

  return {
    signers,
    transfers,
    programCalls,
    edges: dedupedEdges,
    feePayer,
    slot,
  };
}
