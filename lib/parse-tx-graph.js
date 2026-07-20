import { PublicKey, SystemProgram, SystemInstruction, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { decodeInstruction, TokenInstruction } from "@solana/spl-token";
import { INFRA_ACCOUNTS, NATIVE_SOL_TRANSFER, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./programs.js";

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
  const accIdxs = /** @type {{ accounts?: (number | string | PublicKey)[] }} */ (ix).accounts;
  if (!accIdxs?.length) return null;

  let dataBuf;
  try {
    dataBuf = Buffer.from(bs58.decode(/** @type {{ data: string }} */ (ix).data));
  } catch {
    return null;
  }

  try {
    const programId = new PublicKey(pidStr);
    // RPC PartiallyDecodedInstruction carries PublicKey / base58 strings in
    // `accounts`; only compiled instructions carry numeric indices into accountKeys.
    const keys = accIdxs.map((acc) => {
      const pkStr = typeof acc === "number" ? accountKeys[acc] : b58(acc);
      if (!pkStr) throw new Error("missing account key");
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
 * @param {Map<string, string>} mintOfAta
 */
function handleJsonSpl(ix, transferIdx, transfers, edges, ownerOfAta, mintOfAta) {
  const parsed = /** @type {{ parsed?: { type?: string; info?: Record<string, unknown> } }} */ (ix).parsed;
  if (!parsed?.type || !parsed.info) return false;

  const t = parsed.type;
  const info = parsed.info;

  if (t === "transfer" || t === "transferChecked") {
    const authority = typeof info.authority === "string" ? info.authority : b58(info.authority);
    const sourceAta = typeof info.source === "string" ? info.source : b58(info.source);
    const destAta = typeof info.destination === "string" ? info.destination : b58(info.destination);
    // Plain `transfer` carries no mint field — resolve via pre/postTokenBalances
    // (mintOfAta), mirroring applyDecodedSpl, so detectors see the mint.
    const mint =
      typeof info.mint === "string"
        ? info.mint
        : info.mint != null
          ? b58(info.mint)
          : mintOfAta.get(sourceAta) ?? mintOfAta.get(destAta) ?? null;
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
 * JsonParsed System Program lamport transfers.
 * @param {unknown} ix
 * @param {number} transferIdx
 * @param {GraphTransfer[]} transfers
 * @param {GraphEdge[]} edges
 */
function handleJsonSystem(ix, transferIdx, transfers, edges) {
  const pidStr = programIdOf(ix);
  if (pidStr !== SystemProgram.programId.toBase58()) return false;
  const parsed = /** @type {{ parsed?: { type?: string; info?: Record<string, unknown> } }} */ (ix).parsed;
  if (!parsed?.type || !parsed.info) return false;
  const t = parsed.type;
  const info = parsed.info;

  if (t === "transfer") {
    const source = typeof info.source === "string" ? info.source : b58(info.source);
    const dest = typeof info.destination === "string" ? info.destination : b58(info.destination);
    const lamports = info.lamports != null ? String(info.lamports) : "0";
    if (!source || !dest) return false;
    transfers.push({
      idx: transferIdx,
      from_address: source,
      to_address: dest,
      mint: NATIVE_SOL_TRANSFER,
      amount: lamports,
    });
    edges.push({
      from_address: source,
      to_address: dest,
      edge_type: "native_transfer",
      mint: NATIVE_SOL_TRANSFER,
    });
    return true;
  }

  if (t === "transferWithSeed") {
    const source = typeof info.source === "string" ? info.source : b58(info.source);
    const dest =
      (typeof info.to === "string" ? info.to : b58(info.to)) ||
      (typeof info.destination === "string" ? info.destination : b58(info.destination));
    const lamports = info.lamports != null ? String(info.lamports) : "0";
    if (!source || !dest) return false;
    transfers.push({
      idx: transferIdx,
      from_address: source,
      to_address: dest,
      mint: NATIVE_SOL_TRANSFER,
      amount: lamports,
    });
    edges.push({
      from_address: source,
      to_address: dest,
      edge_type: "native_transfer",
      mint: NATIVE_SOL_TRANSFER,
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

    let xferAdded = handleJsonSpl(ix, transferIdx, transfers, edges, ownerOfAta, mintOfAta);
    if (!xferAdded) xferAdded = handleJsonSystem(ix, transferIdx, transfers, edges);

    if (
      !xferAdded &&
      (pidStr === TOKEN_PROGRAM || pidStr === TOKEN_2022_PROGRAM) &&
      /** @type {{ parsed?: unknown }} */ (ix).parsed == null
    ) {
      const ti = compiledInstructionToTx(ix, keys);
      if (ti) {
        const programPk = ti.programId;
        const dec = decodeSplTransferLike(ti, programPk);
        if (dec) {
          ixName = splDecodedInstructionName(dec);
          xferAdded = applyDecodedSpl(dec, transferIdx, transfers, edges, ownerOfAta, mintOfAta);
        }
      }
    }

    if (!xferAdded && pidStr === SystemProgram.programId.toBase58() && /** @type {{ parsed?: unknown }} */ (ix).parsed == null) {
      const ti = compiledInstructionToTx(ix, keys);
      if (ti) {
        try {
          const typ = SystemInstruction.decodeInstructionType(ti);
          if (typ === "Transfer") {
            const d = SystemInstruction.decodeTransfer(ti);
            transfers.push({
              idx: transferIdx,
              from_address: d.fromPubkey.toBase58(),
              to_address: d.toPubkey.toBase58(),
              mint: NATIVE_SOL_TRANSFER,
              amount: String(d.lamports),
            });
            edges.push({
              from_address: d.fromPubkey.toBase58(),
              to_address: d.toPubkey.toBase58(),
              edge_type: "native_transfer",
              mint: NATIVE_SOL_TRANSFER,
            });
            xferAdded = true;
            ixName = "transfer";
          } else if (typ === "TransferWithSeed") {
            const d = SystemInstruction.decodeTransferWithSeed(ti);
            transfers.push({
              idx: transferIdx,
              from_address: d.fromPubkey.toBase58(),
              to_address: d.toPubkey.toBase58(),
              mint: NATIVE_SOL_TRANSFER,
              amount: String(d.lamports),
            });
            edges.push({
              from_address: d.fromPubkey.toBase58(),
              to_address: d.toPubkey.toBase58(),
              edge_type: "native_transfer",
              mint: NATIVE_SOL_TRANSFER,
            });
            xferAdded = true;
            ixName = "transferWithSeed";
          }
        } catch {
          /* non-transfer system ix */
        }
      }
    }

    if (xferAdded) transferIdx++;

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

  // Inbound native funding to feePayer, inferred from balance deltas — a FALLBACK
  // used only when no explicit inbound transfer to the fee payer was decoded above.
  // Tightened to avoid phantom funders (see lib/funding-graph-summary.js): the
  // candidate's SOL loss must actually match the fee payer's gain, dust + infra /
  // program accounts are excluded, and we take the closest amount match (not the
  // first loser — which in a swap is usually an unrelated router/vault).
  if (feePayer) {
    const alreadyHasExplicitInbound = edges.some(
      (e) => e.edge_type === "native_transfer" && e.to_address === feePayer,
    );
    if (!alreadyHasExplicitInbound) {
      const preBalances = parsed.meta?.preBalances ?? [];
      const postBalances = parsed.meta?.postBalances ?? [];
      const txFee = Number(parsed.meta?.fee) || 0;
      const minLamports = Math.max(0, Number(process.env.CHAINMIND_FUNDING_MIN_LAMPORTS) || 1_000_000);
      const REL_SLOP = 0.1;
      const invokedPrograms = new Set(programCalls.map((p) => p.program_id));
      const feePayerIdx = keys.indexOf(feePayer);

      if (feePayerIdx >= 0) {
        const feePayerGain = (postBalances[feePayerIdx] ?? 0) - (preBalances[feePayerIdx] ?? 0);

        if (feePayerGain >= minLamports) {
          // Loss must plausibly explain the gain: at least the gain, and not far above
          // it (a swap loser's loss dwarfs the payer's gain → rejected by `upper`).
          const upper = feePayerGain * (1 + REL_SLOP) + txFee;
          /** @type {{ addr: string, diff: number } | null} */
          let best = null;
          for (let i = 0; i < keys.length; i++) {
            if (i === feePayerIdx) continue;
            const addr = keys[i];
            if (!addr || INFRA_ACCOUNTS.has(addr) || invokedPrograms.has(addr)) continue;
            const loss = (preBalances[i] ?? 0) - (postBalances[i] ?? 0);
            if (loss < minLamports || loss < feePayerGain || loss > upper) continue;
            const diff = Math.abs(loss - feePayerGain);
            if (!best || diff < best.diff) best = { addr, diff };
          }
          if (best) {
            edges.push({
              from_address: best.addr,
              to_address: feePayer,
              edge_type: "native_transfer",
              mint: null,
            });
          }
        }
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
