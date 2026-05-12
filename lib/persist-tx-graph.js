import { parsedToEventRow } from "./parse-tx.js";
import { extractTxGraph } from "./parse-tx-graph.js";

/**
 * Persist coarse event row plus signer / transfer / program / edge tables for one tx + scope.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{
 *   txSig: string,
 *   scopeAddress: string,
 *   slot: number | null,
 *   blockTime: number | null,
 *   parsedTx: import("@solana/web3.js").ParsedTransactionWithMeta | null,
 *   ingestedAt: string,
 * }} p
 */
export function persistIngestedTx(db, p) {
  const ev = parsedToEventRow(p.parsedTx);
  let parseNote = ev.parse_note;
  if (!p.parsedTx && !parseNote) parseNote = "getParsedTransaction_null";

  const graph = extractTxGraph(p.parsedTx, p.slot);

  const deleteEdges = db.prepare(`DELETE FROM edges WHERE tx_sig = ? AND scope_address = ?`);
  const deletePc = db.prepare(`DELETE FROM program_calls WHERE tx_sig = ? AND scope_address = ?`);
  const deleteTf = db.prepare(`DELETE FROM transfers WHERE tx_sig = ? AND scope_address = ?`);
  const deleteSig = db.prepare(`DELETE FROM signers WHERE tx_sig = ? AND scope_address = ?`);

  const insertEvent = db.prepare(`
    INSERT OR REPLACE INTO events
      (signature, scope_address, slot, block_time, fee_payer, event_type,
       programs_json, counterparties_json, parse_note, ingested_at)
    VALUES (@signature, @scope_address, @slot, @block_time, @fee_payer, @event_type,
            @programs_json, @counterparties_json, @parse_note, @ingested_at)
  `);

  const insertSigner = db.prepare(`
    INSERT OR REPLACE INTO signers (tx_sig, scope_address, address, role, ingested_at)
    VALUES (@tx_sig, @scope_address, @address, @role, @ingested_at)
  `);

  const insertTransfer = db.prepare(`
    INSERT OR REPLACE INTO transfers
      (tx_sig, scope_address, idx, from_address, to_address, mint, amount, slot, ingested_at)
    VALUES (@tx_sig, @scope_address, @idx, @from_address, @to_address, @mint, @amount, @slot, @ingested_at)
  `);

  const insertPc = db.prepare(`
    INSERT OR REPLACE INTO program_calls
      (tx_sig, scope_address, idx, program_id, instruction_name, slot, ingested_at)
    VALUES (@tx_sig, @scope_address, @idx, @program_id, @instruction_name, @slot, @ingested_at)
  `);

  const insertEdge = db.prepare(`
    INSERT OR IGNORE INTO edges
      (scope_address, from_address, to_address, tx_sig, slot, edge_type, mint, ingested_at)
    VALUES (@scope_address, @from_address, @to_address, @tx_sig, @slot, @edge_type, @mint, @ingested_at)
  `);

  const run = db.transaction(() => {
    deleteEdges.run(p.txSig, p.scopeAddress);
    deletePc.run(p.txSig, p.scopeAddress);
    deleteTf.run(p.txSig, p.scopeAddress);
    deleteSig.run(p.txSig, p.scopeAddress);

    insertEvent.run({
      signature: p.txSig,
      scope_address: p.scopeAddress,
      slot: p.slot ?? null,
      block_time: p.blockTime ?? null,
      fee_payer: ev.fee_payer,
      event_type: ev.event_type,
      programs_json: ev.programs_json,
      counterparties_json: ev.counterparties_json,
      parse_note: parseNote,
      ingested_at: p.ingestedAt,
    });

    for (const s of graph.signers) {
      insertSigner.run({
        tx_sig: p.txSig,
        scope_address: p.scopeAddress,
        address: s.address,
        role: s.role,
        ingested_at: p.ingestedAt,
      });
    }

    for (const t of graph.transfers) {
      insertTransfer.run({
        tx_sig: p.txSig,
        scope_address: p.scopeAddress,
        idx: t.idx,
        from_address: t.from_address,
        to_address: t.to_address,
        mint: t.mint,
        amount: t.amount,
        slot: p.slot ?? null,
        ingested_at: p.ingestedAt,
      });
    }

    for (const c of graph.programCalls) {
      insertPc.run({
        tx_sig: p.txSig,
        scope_address: p.scopeAddress,
        idx: c.idx,
        program_id: c.program_id,
        instruction_name: c.instruction_name,
        slot: p.slot ?? null,
        ingested_at: p.ingestedAt,
      });
    }

    for (const e of graph.edges) {
      insertEdge.run({
        scope_address: p.scopeAddress,
        from_address: e.from_address,
        to_address: e.to_address,
        tx_sig: p.txSig,
        slot: p.slot ?? null,
        edge_type: e.edge_type,
        mint: e.mint,
        ingested_at: p.ingestedAt,
      });
    }
  });

  run();
}
