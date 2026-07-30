import { FINDING_GROUPS } from "./dossier.js";
import { PROVENANCE } from "./targets.js";

/**
 * THE REPORT — structured, sourced, bounded, and with no verdict in it anywhere.
 *
 * WHY IT IS A SHAPE AND NOT AN ESSAY. The reference investigation was persuasive for two
 * reasons that have nothing to do with writing quality: it SEPARATED what is real and
 * substantial from what is thin, and it CITED SOMETHING FOR EVERY CLAIM. Both of those are
 * structural properties. A model asked for "a thorough write-up" produces neither reliably;
 * a report assembled out of findings that each carry their group, their evidence and their
 * evidence's provenance has both by construction, and a reader can check any line of it
 * without trusting the paragraph around it.
 *
 * THE FOUR SECTIONS THAT MAKE IT DILIGENCE RATHER THAN A SUMMARY:
 *
 *   findings    — grouped, each with evidence and each evidence entry with its source and
 *                 how that source was reached.
 *   checked     — every target actually reached, with its provenance. A reader can see that
 *                 half the report rests on pages the subject itself wrote.
 *   notChecked  — stated as loudly as what was checked. A report that lists findings and
 *                 stops is read as exhaustive.
 *   declined    — everything the loop refused to follow and why, including anything a page
 *                 tried to steer it toward. This section is the one a shorter report would
 *                 drop, and it is the one that tells a reader the investigation had a
 *                 boundary at all.
 *
 * THE HARD RULES, ENFORCED HERE RATHER THAN REQUESTED IN A PROMPT:
 *
 *   - NO VERDICT ON INTENT OR HONESTY. scrubVerdictLanguage runs over every string the
 *     model authored, whatever the prompt said, and redacts the verdict words. A prompt is
 *     a request; this is a control.
 *   - MISSING DATA IS NEVER ZERO and AN OUTAGE IS NEVER AN ABSENCE. Anything that could not
 *     be read appears under what was NOT checked with the reason, and never as a finding.
 *   - A BOUND IS NEVER PRESENTED AS EXACT. The caps block carries `capped` per resource and
 *     says which cap bit.
 *
 * PURE. Never throws. Server-side only: no React.
 */

export const REPORT_SCHEMA = "chainmind-research-report/v1";

/**
 * THE WORDS THIS REPORT WILL NOT PRINT, AND THE ONE MECHANISM THAT MAKES THAT TRUE.
 *
 * The output is a document about IDENTIFIABLE PEOPLE AND BUSINESSES. Anonymous founders, a
 * young domain, a small treasury and a launchpad deployment are FACTS a reader weighs;
 * none of them is evidence of dishonesty, and a single word can turn a page of correct
 * measurements into an accusation that the measurements do not support.
 *
 * WHY REDACTION AND NOT REJECTION. Dropping a finding that contains a banned word would
 * silently lose the observation underneath it — usually a real one, phrased badly. Redacting
 * the word keeps the observation, makes the edit visible in `languageScrubbed`, and cannot
 * fail open: there is no path by which a scrubbed string reaches the reader unscrubbed.
 *
 * `honeypot` is deliberately NOT on this list. It names a specific, checkable contract
 * behaviour — a token that can be bought and not sold — and banning the term would stop the
 * report describing something real. The words below are all conclusions about people.
 */
const VERDICT_WORDS = Object.freeze([
  "scam", "scams", "scammer", "scammers", "scamming",
  "fraud", "frauds", "fraudulent", "fraudster", "fraudsters",
  "rug", "rugs", "rugged", "rugpull", "rugpulls", "rugpulled",
  "larp", "larping", "larps",
  "ponzi", "ponzis",
  "grift", "grifter", "grifters", "grifting",
  "swindle", "swindler",
  "con artist", "conman", "con man",
]);

const VERDICT_RE = new RegExp(`\\b(?:${VERDICT_WORDS.map((w) => w.replace(/\s/g, "\\s+")).join("|")})\\b`, "gi");

/**
 * Redact verdict words from one model-authored string.
 *
 * PURE. Returns the scrubbed text and what was taken out, so the edit is reported rather
 * than performed silently — a reader who can see that a word was removed can ask why, and
 * a reader who cannot see it is being managed.
 *
 * @param {unknown} text
 * @returns {{ text: string|null, removed: string[] }}
 */
export function scrubVerdictLanguage(text) {
  if (typeof text !== "string" || !text) return { text: text == null ? null : String(text), removed: [] };
  const removed = [];
  const out = text.replace(VERDICT_RE, (m) => {
    removed.push(m.toLowerCase());
    return "[verdict word removed]";
  });
  return { text: out, removed };
}

/**
 * ASSEMBLE THE REPORT.
 *
 * @param {object} input
 * @returns {object} the finished report; never throws
 */
export function buildReport({
  job,
  subject,
  dossier,
  ledger,
  budget,
  summary,
  outcome,
  model,
  startedAt,
  finishedAt,
  toolSources = [],
  renderAvailable = true,
} = {}) {
  const scrubbed = [];
  const scrub = (text) => {
    const r = scrubVerdictLanguage(text);
    if (r.removed.length) scrubbed.push(...r.removed);
    return r.text;
  };

  const findings = (dossier?.findings?.() ?? []).map((f) => ({
    id: f.id,
    group: f.group,
    groupLabel: f.groupLabel,
    statement: scrub(f.statement),
    /**
     * THE FINDING'S OWN PROVENANCE FLOOR, restated in words beside the number. A reader
     * scanning a list must be able to see, without opening the evidence, that a finding
     * rests entirely on what the subject published about itself.
     */
    restsOn: provenanceSentence(f.provenanceFloor, f.evidence),
    provenanceFloor: f.provenanceFloor,
    evidence: f.evidence.map((e) => ({
      what: scrub(e.what),
      quote: scrub(e.quote),
      source: {
        url: e.sourceUrl,
        provenance: e.provenance,
        provenanceLabel: e.provenanceLabel,
        provenanceStrength: e.provenanceStrength,
        howItWasReached: PROVENANCE[e.provenance]?.reading ?? null,
        retrievedAt: e.retrievedAt,
        tool: e.tool,
      },
    })),
  }));

  const byGroup = [];
  for (const [group, label] of Object.entries(FINDING_GROUPS)) {
    const rows = findings.filter((f) => f.group === group);
    if (rows.length) byGroup.push({ group, label, count: rows.length, findings: rows });
  }

  const targets = (ledger?.list?.() ?? []).map((t) => ({
    url: t.url,
    host: t.host,
    provenance: t.provenance,
    provenanceLabel: t.provenanceLabel,
    provenanceStrength: t.provenanceStrength,
    anchored: t.anchored,
    depth: t.depth,
    foundIn: t.foundIn,
    requests: t.requests,
    bytes: t.bytes,
    reached: t.requests > 0,
    outcomes: t.outcomes,
  }));

  const declined = (ledger?.declines?.() ?? []).map((d) => ({ url: d.url, provenance: d.provenance, code: d.code, reason: d.reason }));
  const steered = declined.filter((d) => d.code === "steering");
  const machineDirected = dossier?.machineDirected?.() ?? [];
  const caps = budget?.snapshot?.() ?? null;
  const wander = ledger?.wander?.() ?? null;

  const notChecked = [
    ...(dossier?.notChecked?.() ?? []),
    ...standingNotChecked({
      renderAvailable,
      caps,
      /**
       * WHETHER THE CHAIN WAS READ AT ALL, answered from the SOURCES rather than from the
       * target list. A chain lookup produces a `chain:0x…` source and no URL target, so
       * asking the targets produced "the chain half was not checked" on a run whose
       * findings were half chain records — caught in a live run against csl.fun.
       */
      chainRead: (toolSources ?? []).some((s) => String(s?.url ?? "").startsWith("chain:")),
    }),
  ];

  return {
    schema: REPORT_SCHEMA,
    jobId: job?.id ?? null,
    /**
     * THE SUBJECT, AS THE USER GAVE IT. Not normalised into something else and not
     * "resolved" into a project name: the whole point of the provenance discipline is that
     * this run is about the thing that was named, and everything else it touched is
     * reported as a detour from it with a stated reason.
     */
    subject: {
      given: subject?.given ?? null,
      kind: subject?.kind ?? null,
      anchorHosts: ledger?.anchorHosts?.() ?? [],
      note: "Everything below is anchored to this. A target that is not on an anchor host was reached by following something, and the target list says what.",
    },
    outcome: {
      status: outcome?.status ?? "unknown",
      reading: outcome?.reading ?? null,
      steps: outcome?.steps ?? 0,
      startedAt: startedAt ? new Date(startedAt).toISOString() : null,
      finishedAt: finishedAt ? new Date(finishedAt).toISOString() : null,
      model: model ?? null,
    },

    /** The model's own two-to-five sentences, scrubbed. Findings, not a verdict. */
    summary: scrub(summary) ?? null,

    findings: byGroup,
    findingCount: findings.length,
    findingsNote:
      findings.length
        ? "Every finding names what was observed and cites where it came from. `restsOn` says how the source was reached: a finding resting only on the subject's own pages is the subject's account of itself, whatever its figures are."
        : "NO FINDINGS WERE RECORDED. That is a fact about this RUN — it looked and recorded nothing it could evidence — and not a finding that there was nothing to find. Read the caps block and the target list before concluding anything from an empty report.",

    checked: {
      targets,
      reached: targets.filter((t) => t.reached).length,
      proposed: targets.length,
      hostsContacted: wander?.hosts ?? [],
      note: "Every address this run actually requested, with how it came to be a target and how many bytes came back. A reader can see from this which sources the findings rest on and how much of the report is the subject describing itself.",
    },

    /**
     * WHAT WAS REFUSED, AND WHY — the section a shorter report would drop.
     *
     * A loop that follows whatever it reads has no boundary; a loop that has one has a list
     * of things it did not do, and publishing that list is the only way a reader can tell
     * the two apart. The `steering` entries are the most informative: a page that tries to
     * route its own audit is doing something worth reporting, and the refusal is the
     * evidence that it did not work.
     */
    declined: {
      entries: declined,
      count: declined.length,
      steeringAttempts: steered.length,
      note: declined.length
        ? "Targets this investigation refused to follow, with the rule each one broke. A refusal is NOT a finding about the subject: a wander cap and a depth cap are limits of this run, and something not followed is unexamined rather than absent."
        : "Nothing was refused: every target proposed passed the screen, the wander cap and the depth cap.",
      steeringNote: steered.length
        ? "SOME OF THE SUBJECT'S OWN CONTENT NAMED A TARGET IN THE SAME TEXT AS INSTRUCTIONS ADDRESSED AT AN AUTOMATED REVIEWER, and those targets were NOT followed — following one would have been obeying the instruction. The words are quoted under machineDirectedText. This is an observation about the content, not an accusation about anybody: some matches are ordinary marketing copy."
        : null,
    },

    machineDirectedText: {
      found: machineDirected.length > 0,
      findings: machineDirected,
      reading: machineDirected.length
        ? "TEXT ADDRESSED AT AN AUTOMATED REVIEWER RATHER THAN AT A PERSON WAS FOUND IN THE SUBJECT'S OWN CONTENT. Each entry has the words and where they were found. ITS INSTRUCTIONS WERE NOT FOLLOWED AND ARE QUOTED AS EVIDENCE, NEVER OBEYED. It is NOT by itself evidence of dishonesty — a claim of having been audited and a standard screen-reader-only class both match — and the reader should judge the words."
        : "No text addressed at an automated reviewer was found in what was read. The absence of one signal in the bytes that were fetched, NOT a clearance.",
    },

    rejectedClaims: {
      entries: dossier?.rejections?.() ?? [],
      note: "Findings this run tried to record and could not, almost always because the evidence cited a source that was never fetched. Listed because a reader is entitled to know the report had a citation check and that it fired.",
    },

    notChecked,
    notCheckedNote:
      "STATED AS LOUDLY AS WHAT WAS CHECKED, because a report that lists findings and stops is read as exhaustive. Everything here is UNEXAMINED, which is not the same as absent, empty or zero.",

    caps: caps
      ? {
          ...caps,
          wander: wander
            ? {
                ...wander,
                note: "The wander cap bounds how far this run travelled from what the user asked about. Anchor hosts are the ones the user named or the chain declared; off-anchor hosts were reached by following something written in content, and are capped.",
              }
            : null,
        }
      : null,

    cost: {
      modelCalls: outcome?.modelCalls ?? 0,
      promptTokens: outcome?.promptTokens ?? 0,
      completionTokens: outcome?.completionTokens ?? 0,
      totalTokens: (outcome?.promptTokens ?? 0) + (outcome?.completionTokens ?? 0),
      fetchedBytes: caps?.fetchedBytes?.used ?? 0,
      requests: (wander?.hosts ?? []).reduce((n, h) => n + h.requests, 0),
      wallMs: caps?.wallMs?.used ?? null,
      note: "What this investigation cost, including somebody else's bandwidth. Figures marked `capped` in the caps block are BOUNDS, not measurements: a run that stopped at its byte cap fetched at least that much and would have fetched more.",
    },

    languageScrubbed: [...new Set(scrubbed)],
    languageScrubbedNote: scrubbed.length
      ? "Words that state a verdict about people — the report will not print them whatever else it says — were removed from the text above and are listed here so the edit is visible rather than silent. The observations they were attached to were kept."
      : null,

    disclaimer:
      "OBSERVATIONS ABOUT A PROJECT, ITS WEBSITE, ITS PUBLISHED CODE AND ITS CHAIN RECORD. NOT A VERDICT ABOUT IT AND NOT A VERDICT ABOUT ANY PERSON. Nothing here establishes that anyone is dishonest, that a project is fake, or what anybody intended — none of that is measurable from outside, and nothing was measured that could support it. A project can be new, small, anonymous, thinly capitalised, template-built, launchpad-deployed and entirely honest; an enormous number are. Where a figure came from the subject's own site or API it is that party's own output and is quoted as a claim. Where a search found nothing, read whether the search was COMPLETE before treating it as an absence. Weigh the facts; the conclusion is the reader's.",
  };
}

/**
 * How much weight a finding's weakest source can carry, in a sentence.
 *
 * TWO QUESTIONS, NOT ONE, AND CONFLATING THEM WAS A REAL BUG CAUGHT IN A LIVE RUN. "How was
 * this source CHOSEN" and "who WROTE what it says" are independent, and the first version of
 * this function only asked the first. So a finding quoting a marketing sentence off a
 * home page the USER had pasted came out as "the subject did not choose them" — true about
 * the address, false about the words, and false in the direction that lends the subject's
 * own copy the authority of an independent record.
 *
 * A chain record is the one source here that nobody wrote for a reader. Everything else —
 * a page, an API response, a README, a commit message — is the party under examination's
 * own output, however the address for it was arrived at.
 */
function provenanceSentence(floor, evidence = []) {
  const everySourceIsChain = evidence.length > 0 && evidence.every((e) => String(e.sourceUrl ?? "").startsWith("chain:"));
  if (everySourceIsChain) {
    return "Every source behind this finding is a chain record — what was deployed, by whom, and when. Nobody wrote it for a reader, and it is the only class of evidence in this report that the subject did not author.";
  }
  if (floor >= 4) {
    return "The sources behind this finding were chosen by the user or declared on chain, so the subject did not pick where to look — but the CONTENT at them was written by the party under examination. Read the words as their account of themselves.";
  }
  if (floor >= 2) {
    return "At least one source behind this finding is content the party under examination published, and was reached by following something they published. Both the words and the decision to look there are theirs.";
  }
  return "At least one source behind this finding is a path the model guessed at on a site the investigation had already reached. Whatever answered is real and is the subject's own output; the decision to look there was nobody's statement.";
}

/**
 * The things that are ALWAYS unchecked by this service, whether or not the model thought to
 * say so — including the two it must never do.
 */
function standingNotChecked({ renderAvailable, chainRead, caps }) {
  const items = [
    "Who is behind the project. No identity, company registration, court record or corporate filing was looked up, and none would have been.",
    "Whether any claim made by the subject is true. Audits, partnerships, teams, backers, roadmaps and revenue figures were quoted, never verified.",
    "Anything behind a login, a paywall, a CAPTCHA or a rate limit; anything on a path the site's robots.txt asks automated clients not to fetch.",
    "Whether a site or repository BELONGS to the subject, beyond the link being given by the user, declared on chain in the launch transaction, or written in content the subject published. NOTHING HERE WAS FOUND BY SEARCHING FOR A NAME, and nothing ever will be: reporting on a business that merely shares a name would be a claim about the wrong people.",
    "Private repositories, deleted history, unpublished code, and anything a repository's owner chose not to make public — invisible from outside, and their absence is not evidence.",
    "Any contract's source code as compiled and deployed. Published source and deployed bytecode were not compared.",
  ];
  if (!renderAvailable) {
    items.push("What a JavaScript-built page shows a visitor: no browser render was available in this deployment, so such a page was read as the shell its server sends. That is a fact about this deployment and nothing about any site.");
  }
  if (!chainRead) {
    items.push("THE CHAIN. No contract was read, so nothing here is corroborated by the one class of evidence the subject did not write, and no link between an address and this website was established on chain.");
  }
  if (caps?.hit?.length) {
    items.push(`Whatever this run would have looked at next: it stopped at a cap (${caps.hit.map((h) => h.resource).join(", ")}), not at the end of the trail.`);
  }
  return items;
}
