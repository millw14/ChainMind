/**
 * Groq `/api/groq-brief` prompt architecture — DETECTION-FIRST rewrite.
 *
 * Key change from previous version:
 * The model now runs a 3-phase internal process before emitting a verdict:
 *   Phase 1 — SIGNAL SCAN: enumerate every signal present in the evidence, weighted by data quality.
 *   Phase 2 — ADVERSARIAL TEST: commit to the strongest manipulation case AND strongest benign case.
 *   Phase 3 — VERDICT GATE: only escalate if ≥2 signals with combined weight > 0.6 survive Phase 2.
 *
 * This forces detection before classification, not rationalization after.
 */

// ---------------------------------------------------------------------------
// SYSTEM PROMPT
// ---------------------------------------------------------------------------

export const GROQ_BRIEF_SYSTEM_PROMPT = `
You are a Solana on-chain forensics engine embedded in an investigation platform used by crypto funds and compliance analysts.

Your role is DETECTOR, not summarizer. You do not describe what happened. You determine whether it is manipulation.

══════════════════════════════════════════════
PHASE 1 — SIGNAL SCAN (run this before setting any verdict)
══════════════════════════════════════════════
Before classifying, enumerate every signal present in the evidence.
For each signal, assign a raw weight based on DATA QUALITY RULES below.
A signal with no on-chain backing (no signatures, no wallets, no timestamps) has weight 0.0 — do not use it.

DATA QUALITY RULES — apply these to every signal:
- coActivityScore alone: max weight 0.3. It is a heuristic, not proof.
- coActivityScore + distinctPayers with real wallet addresses: max weight 0.5.
- transferEdgesSample with ≥2 shared fee payers across different wallets: weight 0.6–0.8.
- fundingGraph with explicit sharedInboundFunders array length > 0 AND funding tx signatures present: weight 0.7–0.9. If sharedInboundFunders array is empty or missing: weight 0.0 — do NOT assign shared-funder signal.
- walletEvidence.shared_funders with ≥1 on-chain signature: weight up to 0.85.
- priorVerdicts with 2+ prior escalations on same scope SPACED AT LEAST 6 hours apart: add recurrence signal weight 0.6. If all prior verdicts are within the same 6-hour window, treat as one event — weight 0.2 maximum. Repeated scans of the same window are NOT recurrence.
- timeDeltas.intervalsBetweenConsecutiveSamplesSec with median < 3s across ≥5 txs: weight 0.5–0.7.
- Missing fundingGraph (status = "not_attached"): this is a LIMITING FACTOR, not evidence. Do not infer funding from it.
- Empty or null fields: weight 0.0. Never invent values for absent fields.

SIGNAL TYPES (use only these labels):
  fee-payer-concentration | timing-cluster | repeated-route | shared-funder | recurrence | velocity-spike

══════════════════════════════════════════════
PHASE 2 — ADVERSARIAL TEST (required before verdict)
══════════════════════════════════════════════
After scanning signals, you must argue both sides before resolving:

FOR MANIPULATION: State the single strongest piece of on-chain evidence that points to coordination.
  Be specific — name a wallet, signature, or metric. If you cannot name one, the case is weak.

AGAINST MANIPULATION: State the single strongest reason this could be organic.
  Consider: is this a high-traffic token? Is the fee-payer concentration explained by a DEX aggregator?
  Is the timing cluster explained by a single block rather than coordinated actors?

Only after completing both sides do you assign verdict and confidence.

══════════════════════════════════════════════
PHASE 3 — VERDICT GATE
══════════════════════════════════════════════
- "escalate": requires ≥2 signals surviving Phase 2 with combined weight > 0.6.
  At least ONE signal must be backed by a real on-chain entity (wallet address or tx signature).
  recurrence alone or recurrence + fee-payer-concentration alone is NOT sufficient to escalate — recurrence only adds weight when a funding or timing signal already exists independently.
- "monitor": 1 signal with weight ≥ 0.3, or 2+ signals all below 0.4.
- "dismiss": no signals with weight ≥ 0.3, or all evidence fails DATA QUALITY RULES.

Never escalate on coActivityScore alone.
Never escalate if fundingGraph.status = "not_attached" is the only graph signal.

══════════════════════════════════════════════
PATTERN DEFINITIONS (use only these labels)
══════════════════════════════════════════════
- coordinated-accumulation: multiple wallets buying in tight time cluster; fee payers share a common funder
- wash-rotation: same value cycling between a small closed set of wallets repeatedly
- sybil-pump: high unique wallet count but shallow per-wallet activity; coordinated timing; low organic depth
- time-synchronized-burst: activity spikes across nominally unrelated wallets in the same slot range
- organic: no corroborating signals; activity consistent with normal use for this asset type
- unknown: signals present but insufficient to name a pattern

══════════════════════════════════════════════
HARD RULES
══════════════════════════════════════════════
1. Return ONLY a valid JSON object. No prose, no markdown, no preamble.
2. top_evidence must contain only real signatures or wallet addresses present in the input. Never fabricate.
3. next_action must be exactly one actionable sentence naming a specific entity or signature from the evidence when possible.
4. If evidence is insufficient, return verdict = "dismiss", confidence < 0.3, pattern = "unknown".
5. signals array must be populated BEFORE verdict is assigned — the signals drive the verdict, not the reverse.
6. named_entities: only base58 addresses or tx signatures. No labels like "wallet A".
7. If fundingGraph.sharedInboundFunders is empty, null, or missing — shared-funder signal weight MUST be 0.0. Never assign shared-funder weight from fee-payer overlap alone.
8. If sharedInboundFunders has fewer entries than the detail claims, cap weight at 0.3.
9. limiting_factors must list what is concretely absent (e.g. "fundingGraph not attached — shared funder unverifiable").

══════════════════════════════════════════════
OUTPUT SCHEMA — every field mandatory
══════════════════════════════════════════════
{
  "verdict": "escalate | monitor | dismiss",
  "confidence": 0.0–1.0,
  "pattern": "one pattern label from the list above",
  "scope": "<address from input>",
  "window": {
    "start": "ISO8601 or null",
    "end": "ISO8601 or null",
    "duration_minutes": number
  },
  "signals": [
    {
      "type": "fee-payer-concentration | timing-cluster | repeated-route | shared-funder | recurrence | velocity-spike",
      "weight": 0.0–1.0,
      "detail": "<one specific fact from the evidence — must reference a real value, address, or signature>"
    }
  ],
  "top_evidence": [
    {
      "signature": "<tx sig or wallet address from input — never fabricated>",
      "slot": number_or_null,
      "actor": "<wallet>",
      "action": "<short description>"
    }
  ],
  "next_action": "<one sentence — name a specific wallet or signature when possible>",
  "flags": ["low-liquidity-window", "repeat-pattern", "cross-scope-match"],
  "confidence_reasoning": "<why you assigned this confidence — reference specific signal weights and what is missing>",
  "named_entities": ["<base58 addresses or tx signatures only>"],
  "manipulation_vs_benign": {
    "for": "<strongest on-chain fact pointing to manipulation — name an entity or signature>",
    "against": "<strongest reason this is organic — be specific>"
  },
  "reasoning": ["<Phase 1 signal scan summary>", "<Phase 2 adversarial test result>", "<Phase 3 gate outcome>"],
  "next_steps": ["<action 1>", "<action 2>", "<action 3>"],
  "limiting_factors": ["<concrete missing evidence that would change this verdict>"]
}
`.trim();

// ---------------------------------------------------------------------------
// USER MESSAGE BUILDER
// ---------------------------------------------------------------------------

/**
 * Builds the user-turn message sent to Groq.
 *
 * Key change: adds an explicit SIGNAL INVENTORY hint so the model
 * knows which fields to prioritize before it starts reasoning.
 *
 * @param {string} evidenceNarrative - formatted text block from buildGroqEvidenceBlockText
 * @param {string} evidenceJson - raw JSON string of the evidence object
 * @param {string|null|undefined} focus - optional analyst focus hint from the dashboard
 */
export function buildGroqBriefUserContent(evidenceNarrative, evidenceJson, focus) {
  const focusLine = focus?.trim() ? `ANALYST FOCUS: ${focus.trim()}\n\n` : "";

  // Parse the evidence to inject a signal inventory hint.
  // This tells the model exactly which high-value fields are populated
  // before it reads the full blob — preventing it from skipping past them.
  let inventoryHint = "";
  try {
    const parsed = JSON.parse(evidenceJson);
    const hints = [];

    if (parsed.coActivityScore != null)
      hints.push(`coActivityScore = ${parsed.coActivityScore} (heuristic only — max signal weight 0.3 alone)`);

    if (parsed.distinctPayers != null || parsed.distinctPayersWholeWindow != null)
      hints.push(`distinctPayers = ${parsed.distinctPayers ?? parsed.distinctPayersWholeWindow}`);

    const hasFundingGraph =
      parsed.fundingGraph &&
      typeof parsed.fundingGraph === "object" &&
      parsed.fundingGraph.status !== "not_attached" &&
      parsed.fundingGraph.status !== "field_missing_on_snapshot";

    const sharedFunderCount = hasFundingGraph
      ? (parsed.fundingGraph.sharedInboundFunders?.length ??
          parsed.fundingGraph.shared_funders?.length ??
          parsed.fundingGraph.sharedFunders?.length ??
          0)
      : 0;

    hints.push(
      `fundingGraph = ${
        hasFundingGraph
          ? `ATTACHED — ${sharedFunderCount} shared funder(s) found${sharedFunderCount > 0 ? " — HIGH WEIGHT SIGNAL" : ""}`
          : "NOT ATTACHED — cannot verify funder links"
      }`,
    );

    const hasWalletEvidence =
      parsed.walletEvidence &&
      Array.isArray(parsed.walletEvidence?.wallets) &&
      parsed.walletEvidence.wallets.length > 0;
    hints.push(`walletEvidence = ${hasWalletEvidence ? `${parsed.walletEvidence.wallets.length} wallets present` : "absent"}`);

    const hasTransferEdges = Array.isArray(parsed.transferEdgesSample) && parsed.transferEdgesSample.length > 0;
    hints.push(`transferEdgesSample = ${hasTransferEdges ? `${parsed.transferEdgesSample.length} edges` : "empty"}`);

    const hasTimeDeltas = parsed.timeDeltas?.hasTimestamps === true;
    hints.push(
      `timeDeltas = ${hasTimeDeltas ? `span ${parsed.timeDeltas.sampleSpanSeconds}s, ${parsed.timeDeltas.intervalsBetweenConsecutiveSamplesSec?.length ?? 0} intervals` : "no timestamps"}`,
    );

    const priorCount = Array.isArray(parsed.priorVerdicts) ? parsed.priorVerdicts.length : 0;
    hints.push(`priorVerdicts = ${priorCount} (${priorCount >= 2 ? "recurrence signal applies" : "below recurrence threshold"})`);

    if (hints.length > 0) {
      inventoryHint = `SIGNAL INVENTORY (pre-scan — use DATA QUALITY RULES to weight these):\n${hints.map((h) => `  · ${h}`).join("\n")}\n\n`;
    }
  } catch {
    // If JSON parse fails, skip the hint — model still has the raw block
  }

  const narrative = typeof evidenceNarrative === "string" ? evidenceNarrative.trim() : "";
  const json = typeof evidenceJson === "string" ? evidenceJson.trim() : "";

  return `${focusLine}${inventoryHint}EVIDENCE BLOCK:
${narrative}

RAW EVIDENCE JSON (ground truth — base all top_evidence entries on fields present here):
${json}

TASK:
Phase 1 — Scan every signal in the evidence. Weight each by data quality rules. Populate signals[] first.
Phase 2 — Argue for and against manipulation. Commit to a specific on-chain fact on each side.
Phase 3 — Apply the verdict gate. Escalate only if ≥2 signals survive with combined weight > 0.6 and at least one references a real entity.
Return only the JSON verdict object. No prose before or after.`;
}

// ---------------------------------------------------------------------------
// SCHEMA REFERENCE (for docs / external templates)
// ---------------------------------------------------------------------------

export const GROQ_BRIEF_VERDICT_SCHEMA_JSON = `{
  "verdict": "escalate | monitor | dismiss",
  "confidence": 0.0,
  "pattern": "coordinated-accumulation | wash-rotation | sybil-pump | time-synchronized-burst | organic | unknown",
  "scope": "<base58 address>",
  "window": { "start": "ISO8601", "end": "ISO8601", "duration_minutes": 0 },
  "signals": [
    { "type": "fee-payer-concentration | timing-cluster | repeated-route | shared-funder | recurrence | velocity-spike", "weight": 0.0, "detail": "specific fact from evidence" }
  ],
  "top_evidence": [
    { "signature": "<tx sig from input — never fabricated>", "slot": 0, "actor": "<wallet>", "action": "short description" }
  ],
  "next_action": "one actionable sentence naming a specific entity or signature",
  "flags": ["low-liquidity-window", "repeat-pattern", "cross-scope-match"],
  "limiting_factors": ["concrete missing evidence"],
  "named_entities": ["base58 or signatures only"],
  "confidence_reasoning": "specific calibration — reference signal weights",
  "manipulation_vs_benign": {
    "for": "strongest on-chain fact pointing to manipulation",
    "against": "strongest reason this is organic"
  },
  "reasoning": ["phase 1 summary", "phase 2 adversarial result", "phase 3 gate outcome"],
  "next_steps": ["action 1", "action 2", "action 3"]
}`;
