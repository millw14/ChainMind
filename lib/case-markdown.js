/**
 * @param {Record<string, unknown>} payload
 */
export function investigationCaseToMarkdown(payload) {
  if (!payload || typeof payload !== "object") return "# Case\n\n(empty)\n";

  const p = /** @type {Record<string, any>} */ (payload);
  const lines = [];
  lines.push(`# ChainMind investigation: ${p.title ?? p.caseId ?? "case"}`);
  lines.push("");
  lines.push(`- **Case ID:** \`${p.caseId}\``);
  lines.push(`- **Scope:** \`${p.scopeAddress}\``);
  lines.push(`- **Created:** ${p.createdAt}`);
  lines.push(`- **Window:** ${p.params?.windowMinutes ?? "?"} min buckets, **Lookback:** ${p.params?.lastHours ?? "?"} h`);
  lines.push("");

  const risk = p.riskProfile;
  if (risk) {
    lines.push("## Risk summary");
    lines.push(`- **Tier:** ${risk.tier}`);
    lines.push(`- **Score (0–100):** ${risk.score0_100 ?? "—"}`);
    lines.push(`- **Model:** ${risk.model ?? "—"}`);
    lines.push(`- ${risk.blurb ?? ""}`);
    lines.push("");
  }

  if (Array.isArray(p.detectorFlags) && p.detectorFlags.length) {
    lines.push("## Named detectors");
    for (const d of p.detectorFlags) {
      lines.push(`- **${d.detector}** (${d.triggered ? "triggered" : "clear"}) — ${d.severity}: ${d.summary ?? ""}`);
    }
    lines.push("");
  }

  if (Array.isArray(p.flaggedWallets) && p.flaggedWallets.length) {
    lines.push("## Top fee payers (cohort)");
    for (const w of p.flaggedWallets.slice(0, 14)) {
      lines.push(
        `- \`${w.address}\` — ${w.feePayerEventsInLookback} events in lookback (rank ${w.rank}); composite ${w.compositeScore0_100 ?? "—"}`,
      );
    }
    lines.push("");
  }

  const ft = p.fundingTree;
  if (ft && typeof ft === "object") {
    lines.push("## Funding tree (inbound expansion)");
    lines.push(`- **Nodes:** ${ft.nodeCount}, **Edges:** ${ft.edgeCount}, **Seeds:** ${ft.seedCount}`);
    lines.push(`- ${ft.note ?? ""}`);
    lines.push("");
  }

  if (Array.isArray(p.evidenceRows) && p.evidenceRows.length) {
    lines.push("## Evidence rows (sample)");
    for (const r of p.evidenceRows.slice(0, 40)) {
      const bits = [
        r.kind,
        r.slot != null ? `slot ${r.slot}` : null,
        r.action,
        r.from ? `from ${String(r.from).slice(0, 8)}…` : null,
        r.to ? `to ${String(r.to).slice(0, 8)}…` : null,
        r.amount != null ? `amt ${r.amount}` : null,
        r.tx_sig ? `\`${String(r.tx_sig).slice(0, 12)}…\`` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      lines.push(`- ${bits}`);
    }
    lines.push("");
  }

  if (p.groqAnalysis && typeof p.groqAnalysis === "object") {
    lines.push("## Groq narrative (structured)");
    lines.push("```json");
    lines.push(JSON.stringify(p.groqAnalysis, null, 2).slice(0, 12000));
    lines.push("```");
    lines.push("");
  }

  lines.push("---");
  lines.push(p.chainMindNote ?? "");

  return lines.join("\n");
}
