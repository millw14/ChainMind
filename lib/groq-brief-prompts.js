/**
 * Groq `/api/groq-brief` prompt architecture — three independent layers:
 * 1. {@link GROQ_BRIEF_SYSTEM_PROMPT} — role, detector mindset, global rules (API `system` message).
 * 2. Evidence — human-readable Evidence Block (pipeline narrative) plus the same fields as pretty-printed JSON (API `user` message, block 1).
 * 3. {@link GROQ_BRIEF_INSTRUCTION_PROMPT} — schema + how to read Evidence + output contract (API `user` message, block 2).
 *
 * Optional: analyst `focus` line from the request body, appended as its own subsection (still part of the user message).
 */

/** Layer 1 — system message. Update without touching evidence or schema text. */
export const GROQ_BRIEF_SYSTEM_PROMPT = `You are a Solana on-chain forensics engine embedded in an investigation platform used by crypto funds and compliance analysts.

Your job is to classify transaction windows as coordinated manipulation or organic activity. You are not a summarizer — you are a detector. You evaluate evidence, name the pattern, assign confidence, and tell the analyst what to do next.

Rules:
- Always return valid JSON matching the verdict schema given in the user message under "Instructions". No prose, no markdown, no preamble.
- Confidence reflects your actual certainty. If evidence is thin, say so (confidence < 0.4) and verdict = "monitor" or "dismiss".
- Never escalate on a single signal. Require at least 2 corroborating signals to reach confidence > 0.7.
- Name the pattern specifically. If it doesn't match a known pattern, say "unknown" — do not invent a label.
- top_evidence must contain real signatures from the Evidence input. Do not fabricate.
- next_action must be one actionable sentence for a fund analyst.`;

/** Section title for the evidence JSON in the user message (layer 2). */
export const GROQ_BRIEF_EVIDENCE_SECTION_TITLE = "## Evidence (input snapshot)";

/** Subsection: typed JSON snapshot (must stay consistent with the narrative block above). */
const STRUCTURED_SNAPSHOT_TITLE = "Structured snapshot (JSON):";

/** Layer 3 — instructions + JSON shape; update schema here without changing the system persona. */
export const GROQ_BRIEF_INSTRUCTION_PROMPT = `Apply the system rules to the Evidence section above. The opening narrative (SCOPE / WINDOW / signatures / edges / prior verdicts) and the Structured snapshot JSON must describe the same scope — if they disagree, prefer the JSON fields for numeric ids and treat the narrative as the analyst-facing summary.

Every claim in your output must be grounded in fields present in Evidence — do not invent funding paths, account ages, or transactions not shown.

Reading Evidence:
- When Evidence.aiDetection exists, treat it as pre-computed labeled features, not ground truth. Use aiDetection.dataAvailability so an empty transfer sample is not mistaken for a clean chain.
- When fundingGraph.status is "attached" and sharedInboundFunders is non-empty, shared provisioning is evidence you may weigh heavily. When the graph is missing or shows no edges, cap shared-funder conclusions.
- Use Evidence.scopeAddress, or the scope implied by the snapshot, when filling "scope".
- entityLedger / signatures / feePayers — cite real ids from these when filling named_entities and top_evidence.

Respond with ONLY a single valid JSON object (no markdown fences, no commentary):
{
  "verdict": "escalate | monitor | dismiss",
  "confidence": 0.0,
  "pattern": "coordinated-accumulation | wash-rotation | sybil-pump | time-synchronized-burst | organic | unknown",
  "scope": "<base58 address>",
  "window": { "start": "ISO8601", "end": "ISO8601", "duration_minutes": 0 },
  "signals": [
    { "type": "fee-payer-concentration | timing-cluster | repeated-route | shared-funder", "weight": 0.0, "detail": "fact tied to Evidence" }
  ],
  "top_evidence": [ { "signature": "<tx sig from Evidence>", "slot": 0, "actor": "<wallet>", "action": "short description" } ],
  "next_action": "one actionable sentence naming an entity or signature from Evidence when possible",
  "flags": ["low-liquidity-window", "repeat-pattern", "cross-scope-match"],
  "limiting_factors": ["optional — data gaps, caps"],
  "named_entities": ["base58 or signatures only"],
  "confidence_reasoning": "short calibration line",
  "manipulation_vs_benign": "one or two short sentences"
}

Legacy input mapping if the model internally uses old labels: manipulation_detected→escalate, suspicious→monitor, clean→dismiss.
signals.weight is 0..1. Prefer at least 2 distinct signals when Evidence supports it; otherwise state limitations in limiting_factors.
top_evidence rows must copy signatures that appear under Evidence.signatures (or equivalent); if none, use an empty array and explain in limiting_factors.`;

const INSTRUCTION_SECTION_TITLE = "## Instructions — verdict JSON (output contract)";

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
