import { flattenUntrusted } from "../../../lib/site-analysis.js";

/**
 * THE RUNNING RECORD OF WHAT THIS INVESTIGATION HAS ESTABLISHED — what the loop knows at
 * any moment, and the thing the report is built out of at the end.
 *
 * WHY THE MODEL WRITES FINDINGS THROUGH A TOOL INSTEAD OF WRITING A REPORT AT THE END.
 * A model asked to summarise ten rounds of fetched text at the end of a long transcript
 * will produce fluent prose in which the true parts and the remembered-wrong parts are
 * indistinguishable, and the citations, if any, are reconstructed. Recording each finding
 * AT THE MOMENT the evidence is in front of it means:
 *
 *   - EVERY FINDING CARRIES ITS SOURCE, because the tool will not accept one without.
 *   - A FINDING CITING A URL THIS INVESTIGATION NEVER REACHED IS REJECTED, with a sentence
 *     the model can act on. That is the anti-fabrication control, and it is mechanical
 *     rather than a request in a prompt.
 *   - THE REPORT IS STRUCTURED BY CONSTRUCTION, so grouping, evidence and provenance are
 *     fields rather than paragraph conventions that drift.
 *
 * WHAT A FINDING IS ALLOWED TO BE. An observation with evidence. Not a verdict, not an
 * inference about intent, and not a conclusion about a person. See lib/report.js
 * scrubVerdictLanguage, which is the last line of that defence and runs whatever the
 * prompt said.
 *
 * PURE apart from the clock. Never throws. Server-side only: no React.
 */

/**
 * The groups a finding can belong to.
 *
 * GROUPED BECAUSE THE REFERENCE ANALYSIS WAS PERSUASIVE FOR THIS REASON: it separated what
 * is real and substantial from what is thin, instead of presenting one undifferentiated
 * list in which a live backend and a three-dollar vault carry the same weight. The groups
 * are about the KIND of fact, not about how damning it is — there is no "red flags" group,
 * because that would be a verdict wearing a heading.
 */
export const FINDING_GROUPS = Object.freeze({
  what_it_is: "What the thing is, in its own description and in what it serves",
  what_runs: "What is actually running — endpoints that answer, data that changes, code that exists",
  scale: "Size and activity, as measured, with the denominator each figure is out of",
  provenance_and_history: "Where it came from and how long it has existed — registration, first commit, deployment",
  people_and_claims: "Claims made about the project, and what could and could not be checked about them",
  code: "What the published source contains, and what a complete search over it did and did not find",
  chain: "What the chain records, which is the only class of evidence here that the subject did not write",
  discrepancy: "Places where two sources say different things, with both sources quoted",
  machine_directed_text: "Text found in the subject's own content that is addressed at an automated reviewer rather than at a person",
});

/**
 * Open a dossier for one investigation.
 *
 * @param {{ subject: object, now?: () => number }} input
 */
export function createDossier({ subject, now = Date.now } = {}) {
  const findings = [];
  const observations = [];
  const machineDirected = [];
  const notChecked = new Set();
  const rejected = [];

  return {
    subject,

    /**
     * RECORD ONE FINDING, OR REFUSE IT AND SAY WHY.
     *
     * `verifySource` is supplied by the caller and is the mechanical citation check: it
     * answers whether a URL was actually reached by this investigation. A finding whose
     * evidence points somewhere nothing was ever fetched is not a weaker finding, it is a
     * fabricated one, and it is refused rather than downgraded.
     *
     * @param {object} input
     * @param {(url: string) => object|null} verifySource
     * @returns {{ ok: true, finding: object } | { ok: false, refusal: string }}
     */
    record(input, verifySource) {
      const group = typeof input?.group === "string" && Object.hasOwn(FINDING_GROUPS, input.group) ? input.group : null;
      if (!group) {
        return {
          ok: false,
          refusal: `"${String(input?.group ?? "").slice(0, 40)}" is not one of the finding groups. Use one of: ${Object.keys(FINDING_GROUPS).join(", ")}.`,
        };
      }
      const statement = flattenUntrusted(input?.statement, 600);
      if (!statement || statement.length < 12) {
        return { ok: false, refusal: "A finding needs a statement of at least a dozen characters saying what was observed." };
      }

      const rawEvidence = Array.isArray(input?.evidence) ? input.evidence : [];
      if (!rawEvidence.length) {
        return {
          ok: false,
          refusal: "A finding with no evidence is not recorded. Every finding needs at least one evidence entry with the URL it came from and what was seen there — a report whose claims cannot be traced to a source is the thing this whole service exists not to produce.",
        };
      }

      const evidence = [];
      for (const e of rawEvidence.slice(0, 6)) {
        const sourceUrl = typeof e?.sourceUrl === "string" ? e.sourceUrl.trim() : "";
        const source = sourceUrl ? verifySource(sourceUrl) : null;
        if (!source) {
          return {
            ok: false,
            refusal: `The evidence cites ${sourceUrl ? `"${sourceUrl.slice(0, 160)}"` : "no source URL"}, which is not something this investigation actually fetched. Cite only URLs that appear in the targets this run reached; if the fact came from the chain lookup, cite "chain:" followed by the address. A citation to a source that was never read is refused, not downgraded.`,
          };
        }
        evidence.push({
          what: flattenUntrusted(e?.what, 300) ?? "an observation",
          quote: flattenUntrusted(e?.quote, 400),
          sourceUrl: source.url,
          provenance: source.provenance,
          provenanceLabel: source.provenanceLabel,
          provenanceStrength: source.provenanceStrength,
          retrievedAt: source.retrievedAt ?? null,
          tool: source.tool ?? null,
        });
      }

      const finding = {
        id: `f${findings.length + 1}`,
        group,
        groupLabel: FINDING_GROUPS[group],
        statement,
        evidence,
        /**
         * THE WEAKEST PROVENANCE IN THE EVIDENCE DECIDES THE FINDING'S OWN. A finding
         * corroborated by the chain and by the project's own page is only as strong as the
         * page for whatever the chain does not say, and a reader scanning a list needs the
         * floor rather than the ceiling.
         */
        provenanceFloor: evidence.reduce((min, e) => Math.min(min, e.provenanceStrength ?? 1), 4),
        recordedAt: now(),
      };
      findings.push(finding);
      return { ok: true, finding };
    },

    /** A finding the model tried to record and could not. Reported: a rejected citation is
     *  itself worth a reader knowing about. */
    noteRejection(refusal, attempted) {
      rejected.push({ refusal: String(refusal).slice(0, 400), attempted: flattenUntrusted(attempted?.statement, 200), at: now() });
    },

    /** Every tool outcome, in order — the audit trail of what was actually done. */
    observe(entry) {
      observations.push({ ...entry, at: now() });
    },

    /**
     * TEXT IN THE SUBJECT'S OWN CONTENT ADDRESSED AT AN AUTOMATED REVIEWER.
     *
     * Collected separately from findings because it is a different kind of fact and must
     * never be diluted into the ordinary ones: a page that tries to steer its own review
     * is informative about that page, its instructions were not followed, and it is NOT by
     * itself evidence of dishonesty — plenty of matches are ordinary marketing copy or
     * standard accessibility markup.
     */
    noteMachineDirected(entries, where) {
      for (const e of Array.isArray(entries) ? entries : []) {
        if (machineDirected.length >= 24) break;
        const row = {
          kind: e?.kind ?? "directive",
          quote: flattenUntrusted(e?.quote, 300),
          where: e?.where ?? where ?? null,
          at: now(),
        };
        // DE-DUPLICATED, because the same page is often read twice — once raw and once
        // rendered — and a report listing one finding four times reads as four attempts.
        // Matched on all three fields: the same words in two different places IS two
        // findings, and collapsing those would hide where they were.
        if (machineDirected.some((m) => m.kind === row.kind && m.quote === row.quote && m.where === row.where)) continue;
        machineDirected.push(row);
      }
    },

    /** Something this run deliberately did not do, in the reader's words rather than ours. */
    noteNotChecked(sentence) {
      const s = flattenUntrusted(sentence, 400);
      if (s) notChecked.add(s);
    },

    findings: () => findings.map((f) => ({ ...f })),
    observations: () => observations.map((o) => ({ ...o })),
    machineDirected: () => machineDirected.map((m) => ({ ...m })),
    rejections: () => rejected.map((r) => ({ ...r })),
    notChecked: () => [...notChecked],

    /**
     * WHAT THE MODEL SEES OF ITS OWN PROGRESS, each round.
     *
     * Short on purpose. The transcript already holds every tool result; repeating the
     * findings in full would double the token spend that the token cap exists to bound.
     * What it needs is the shape of what it has: how many findings, in which groups, and
     * what it has not touched.
     */
    digest() {
      const byGroup = {};
      for (const f of findings) byGroup[f.group] = (byGroup[f.group] ?? 0) + 1;
      return {
        findings: findings.length,
        byGroup,
        machineDirectedText: machineDirected.length,
        rejectedFindings: rejected.length,
        lastStatements: findings.slice(-4).map((f) => `${f.id} [${f.group}] ${f.statement}`),
      };
    },
  };
}
