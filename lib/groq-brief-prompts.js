/**
 * Groq `/api/groq-brief` prompt architecture — three independent layers:
 * 1. {@link GROQ_BRIEF_SYSTEM_PROMPT} — role, detector mindset, global rules (API `system` message).
 * 2. Evidence — human-readable Evidence Block (pipeline narrative) plus the same fields as pretty-printed JSON (API `user` message, block 1).
 * 3. {@link GROQ_BRIEF_INSTRUCTION_PROMPT} — Instruction Block (pattern rubric), verdict {@link GROQ_BRIEF_VERDICT_SCHEMA_JSON}, and Evidence-reading notes (API `user` message, block 2).
 *
 * Optional: analyst `focus` line from the request body, appended as its own subsection (still part of the user message).
 */

/** Layer 1 — system message. Update without touching evidence or schema text. */
export const GROQ_BRIEF_SYSTEM_PROMPT = `
You are a Solana on-chain forensics engine embedded in an investigation platform used by crypto funds and compliance analysts.

Your job is to CLASSIFY transaction windows as coordinated manipulation or organic activity.
You are a DETECTOR, not a summarizer. You evaluate evidence, name the pattern, assign confidence, and tell the analyst what to do next.

RULES — follow every one without exception:
1. Return ONLY a valid JSON object. No prose, no markdown, no preamble, no explanation outside the JSON.
2. Confidence reflects your actual certainty. Thin evidence → confidence < 0.4, verdict = "monitor" or "dismiss".
3. Never set verdict = "escalate" on a single signal. Require at least 2 corroborating signals with combined weight > 0.6.
4. Name the pattern from this list only: coordinated-accumulation | wash-rotation | sybil-pump | time-synchronized-burst | organic | unknown. Never invent a label.
5. top_evidence must contain only real signatures or wallet addresses present in the input. Never fabricate.
6. next_action must be exactly one actionable sentence for a fund analyst.
7. If evidence is insufficient to classify, return verdict = "dismiss", confidence < 0.3, pattern = "unknown", and explain in confidence_reasoning.
8. Check priorVerdicts — if this scope has been flagged 2+ times in priorVerdicts, that is itself a corroborating signal; add a signal of type "recurrence" with weight 0.6 and note it in confidence_reasoning.

PATTERN DEFINITIONS:
- coordinated-accumulation: multiple wallets buying in tight time cluster, fee payers share a common funder
- wash-rotation: same value cycling between a small closed set of wallets repeatedly
- sybil-pump: high unique wallet count but shallow per-wallet activity, coordinated timing, low organic depth
- time-synchronized-burst: activity spikes across nominally unrelated wallets in the same slot range
- organic: no corroborating signals, activity consistent with normal use for this asset type

REQUIRED OUTPUT SCHEMA — every field mandatory:
{
  "verdict": "escalate | monitor | dismiss",
  "confidence": 0.0–1.0,
  "pattern": "one of the five named patterns above",
  "scope": "<address from input>",
  "window": { "start": "ISO8601 or null", "end": "ISO8601 or null", "duration_minutes": number },
  "signals": [
    { "type": "fee-payer-concentration | timing-cluster | repeated-route | shared-funder | recurrence", "weight": 0.0–1.0, "detail": "one specific fact from the evidence" }
  ],
  "top_evidence": [
    { "signature": "<tx sig or wallet>", "slot": number_or_null, "actor": "<wallet>", "action": "<short description>" }
  ],
  "next_action": "<one sentence for an analyst>",
  "flags": ["low-liquidity-window", "repeat-pattern", "cross-scope-match"],
  "confidence_reasoning": "<why you assigned this confidence — be specific about what is missing or present>",
  "named_entities": ["<wallets or programs worth flagging>"],
  "manipulation_vs_benign": "<one paragraph: strongest case FOR manipulation vs strongest case AGAINST>",
  "reasoning": ["<step-by-step chain of inference, one item per logical step>"],
  "next_steps": ["<ranked list of 3 analyst actions>"],
  "limiting_factors": ["<what evidence is absent that would change this verdict>"]
}
`.trim();

/** Section title for the evidence JSON in the user message (layer 2). */
export const GROQ_BRIEF_EVIDENCE_SECTION_TITLE = "## Evidence (input snapshot)";

/** Subsection: typed JSON snapshot (must stay consistent with the narrative block above). */
const STRUCTURED_SNAPSHOT_TITLE = "Structured snapshot (JSON):";

/** Machine-readable verdict shape (embedded in user message; substitute for `{{verdict_schema_json}}` in external templates). */
export const GROQ_BRIEF_VERDICT_SCHEMA_JSON = `{
  "verdict": "escalate | monitor | dismiss",
  "confidence": 0.0,
  "pattern": "coordinated-accumulation | wash-rotation | sybil-pump | time-synchronized-burst | organic | unknown",
  "scope": "<base58 address>",
  "window": { "start": "ISO8601", "end": "ISO8601", "duration_minutes": 0 },
  "signals": [
    { "type": "fee-payer-concentration | timing-cluster | repeated-route | shared-funder | recurrence", "weight": 0.0, "detail": "fact tied to Evidence" }
  ],
  "top_evidence": [ { "signature": "<tx sig from Evidence>", "slot": 0, "actor": "<wallet>", "action": "short description" } ],
  "next_action": "one actionable sentence naming an entity or signature from Evidence when possible",
  "flags": ["low-liquidity-window", "repeat-pattern", "cross-scope-match"],
  "limiting_factors": ["optional — data gaps, caps"],
  "named_entities": ["base58 or signatures only"],
  "confidence_reasoning": "short calibration line",
  "manipulation_vs_benign": "one or two short sentences"
}`;

/** Layer 3 — pattern rubric + schema + how to read Evidence + output contract (API `user` message, block 2). */
export const GROQ_BRIEF_INSTRUCTION_PROMPT = `Apply the system rules to the Evidence section above. The opening narrative (SCOPE / WINDOW / signatures / edges / prior verdicts) and the Structured snapshot JSON must describe the same scope — if they disagree, prefer the JSON fields for numeric ids and treat the narrative as the analyst-facing summary.

Every claim in your output must be grounded in fields present in Evidence — do not invent funding paths, account ages, or transactions not shown.

Instruction Block
Evaluate the above window against these patterns:
1. coordinated-accumulation — multiple wallets buying in tight time cluster, fee payers linked
2. wash-rotation — same value moving between a small set of wallets repeatedly
3. sybil-pump — high unique wallet count but shallow per-wallet activity, coordinated timing
4. time-synchronized-burst — activity spikes across unrelated wallets at the same slot range
5. organic — no corroborating signals, activity consistent with normal use

Return ONLY a JSON object matching this schema:
${GROQ_BRIEF_VERDICT_SCHEMA_JSON}

Do not return anything outside the JSON object.

Reading Evidence:
- When Evidence.aiDetection exists, treat it as pre-computed labeled features, not ground truth. Use aiDetection.dataAvailability so an empty transfer sample is not mistaken for a clean chain.
- When fundingGraph.status is "attached" and sharedInboundFunders is non-empty, shared provisioning is evidence you may weigh heavily. When the graph is missing or shows no edges, cap shared-funder conclusions.
- Use Evidence.scopeAddress, or the scope implied by the snapshot, when filling "scope".
- entityLedger / signatures / feePayers — cite real ids from these when filling named_entities and top_evidence.

Legacy input mapping if the model internally uses old labels: manipulation_detected→escalate, suspicious→monitor, clean→dismiss.
signals.weight is 0..1. Prefer at least 2 distinct signals when Evidence supports it; otherwise state limitations in limiting_factors.
top_evidence rows must copy signatures that appear under Evidence.signatures (or equivalent); if none, use an empty array and explain in limiting_factors.`;

const INSTRUCTION_SECTION_TITLE = "## Instruction Block — verdict JSON (output contract)";

const ANALYST_NOTE_TITLE = "## Analyst note (optional)";

/**
 * Build the full `user` message: evidence narrative + JSON snapshot + instruction block + optional focus.
 * @param {string} evidenceBlockText narrative block from buildGroqEvidenceBlockText
 * @param {string} evidencePrettyJson pretty-printed JSON string (already truncated at caller if needed)
 * @param {string | null | undefined} focusLine optional per-request note (e.g. GROQ_BRIEF_USER_FOCUS)
 */
export function buildGroqBriefUserContent(evidenceBlockText, evidencePrettyJson, focusLine) {
  const block = typeof evidenceBlockText === "string" ? evidenceBlockText.trim() : "";
  const json = typeof evidencePrettyJson === "string" ? evidencePrettyJson.trim() : "";
  const parts = [
    GROQ_BRIEF_EVIDENCE_SECTION_TITLE,
    block,
    "",
    STRUCTURED_SNAPSHOT_TITLE,
    json,
    "",
    INSTRUCTION_SECTION_TITLE,
    GROQ_BRIEF_INSTRUCTION_PROMPT.trim(),
  ];
  const note = typeof focusLine === "string" ? focusLine.trim() : "";
  if (note) {
    parts.push("", ANALYST_NOTE_TITLE, note);
  }
  return parts.join("\n");
}
