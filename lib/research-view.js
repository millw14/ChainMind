/**
 * A FINISHED INVESTIGATION, ARRANGED FOR READING — and nothing else.
 *
 * WHY THE PRESENTATION IS A PURE MODULE AND NOT JSX. Three of this product's hard rules
 * are decided at exactly the moment a report is turned into something a person reads, and
 * all three are invisible in a component tree:
 *
 *   MISSING IS NOT ZERO. A report from a service that did not send `findingCount` must
 *   render "not reported" and never "0 findings". In JSX that is `report.findingCount ?? 0`
 *   written once by somebody in a hurry, and there is no test that catches it.
 *   AN OUTAGE IS NOT AN ABSENCE. A job that failed carries a partial report, and the
 *   banner over it is the only thing standing between "we could not finish" and "there
 *   was nothing to find".
 *   A BOUND IS NEVER EXACT. `capped: true` on a resource means every figure downstream of
 *   it is a floor, and the words "at least" have to actually appear.
 *
 * So the arrangement happens here, in a module `node --test` can load, and
 * components/research/ReportView.jsx renders what this returns without deciding anything.
 *
 * IT NEVER INVENTS AND NEVER RE-WORDS. Every sentence in the output is either the
 * service's own — the report is written to be read, and its notes carry the caveats — or
 * one of the few written in this file about THIS DEPLOYMENT's failure to reach it. In
 * particular the verdict-word scrub has already run on the service side, over strings the
 * model authored; nothing here re-writes model text, because a second pass that reworded
 * anything would be a second author nobody can see.
 *
 * PURE. Never throws, any input. Server-side or client-side: no React in here either.
 */

/** How a status should read, and whether the reader should keep waiting. */
export const JOB_TONE = Object.freeze({
  WAITING: "waiting",
  GOOD: "good",
  PARTIAL: "partial",
  BAD: "bad",
  UNKNOWN: "unknown",
});

/**
 * Every status this UI can be handed, with the ONE sentence that must not be got wrong in
 * each case. The service writes its own `reading` and it is shown as well — these are the
 * app's framing, and they exist because "failed" and "abandoned" and "we could not reach
 * the service" are three different things that a careless UI renders as one red box.
 */
const STATUS_VIEW = Object.freeze({
  queued: { label: "Queued", tone: JOB_TONE.WAITING, poll: true, blurb: "Waiting for a worker. Nothing has been read yet." },
  running: { label: "Investigating", tone: JOB_TONE.WAITING, poll: true, blurb: "Running now. It takes minutes, not seconds." },
  done: { label: "Complete", tone: JOB_TONE.GOOD, poll: false, blurb: "The loop stopped on its own terms. Read what was NOT checked before treating anything as absent." },
  failed: {
    label: "Failed",
    tone: JOB_TONE.BAD,
    poll: false,
    blurb:
      "This investigation did not finish, and the reason was on OUR side. Anything below was really gathered before it stopped; it is partial, and a partial report is not a finding that there was nothing more to find.",
  },
  abandoned: {
    label: "Abandoned",
    tone: JOB_TONE.BAD,
    poll: false,
    blurb:
      "The worker running this job stopped answering — a redeploy, a crash or a container killed for memory. HOW FAR IT GOT IS UNKNOWN. Nothing here is a fact about the subject.",
  },
  expired: {
    label: "Expired",
    tone: JOB_TONE.UNKNOWN,
    poll: false,
    blurb: "The service no longer holds this job's record. That is a retention limit here, not an outcome of the investigation.",
  },
  service_unreachable: {
    label: "Service unreachable",
    tone: JOB_TONE.UNKNOWN,
    poll: true,
    blurb:
      "We could not reach the research service just now. THIS IS AN OUTAGE OF OUR OWN INFRASTRUCTURE: the job may well still be running, and nothing here says it failed or that anything was or was not found.",
  },
  not_configured: {
    label: "Not available here",
    tone: JOB_TONE.UNKNOWN,
    poll: false,
    blurb: "This deployment has no research service configured. A fact about this installation and nothing about any subject.",
  },
  /**
   * The two states that are about the READER rather than about the job. They are in the
   * same table because the page renders one header either way, and a reader who is simply
   * not signed in must not be shown "Unknown" — that reads as a broken investigation.
   */
  needs_sign_in: {
    label: "Sign in to read this",
    tone: JOB_TONE.UNKNOWN,
    poll: false,
    blurb: "A research report is shown to the wallet that started it. Nothing here has failed.",
  },
  not_yours: {
    label: "Not found",
    tone: JOB_TONE.UNKNOWN,
    poll: false,
    blurb:
      "No research job with that id was started by this wallet on this deployment. Records age out after a few days, so an old link reads this way too — it does not mean an investigation failed.",
  },
  unavailable: {
    label: "Service unreachable",
    tone: JOB_TONE.UNKNOWN,
    poll: true,
    blurb:
      "We could not reach the research service just now. THIS IS AN OUTAGE OF OUR OWN INFRASTRUCTURE: the job may well still be running, and nothing here says it failed.",
  },
});

/**
 * ONE JOB, AS A HEADER.
 *
 * @param {object|null} job the block from lib/research-job.js readResearch, or a poll
 * @returns {object}
 */
export function viewJob(input) {
  const job = input && typeof input === "object" ? input : {};
  const raw = typeof job.state === "string" && job.state !== "job" ? job.state : typeof job.status === "string" ? job.status : null;
  const status = raw ?? (job.job && typeof job.job.state === "string" ? job.job.state : null);
  const inner = job.job && typeof job.job === "object" ? job.job : job;

  const view = (status && STATUS_VIEW[status]) ?? {
    label: "Unknown",
    tone: JOB_TONE.UNKNOWN,
    poll: false,
    blurb: "This job's state could not be established. That is a gap in what we know, not an outcome.",
  };

  const progress = inner.progress && typeof inner.progress === "object" ? inner.progress : null;
  return {
    id: typeof inner.id === "string" ? inner.id : null,
    status: status ?? "unknown",
    label: view.label,
    tone: view.tone,
    /** Whether a client should keep polling. False on every terminal state AND on the
     *  states where polling cannot help; true where the answer may still change. */
    keepPolling: view.poll === true && inner.terminal !== true && job.terminal !== true,
    blurb: view.blurb,
    /** The service's own sentence, kept beside ours rather than instead of it. */
    serviceReading: typeof (job.reading ?? inner.reading) === "string" ? (job.reading ?? inner.reading) : null,
    subject: inner.subject ?? null,
    submittedAt: inner.submittedAt ?? null,
    startedAt: inner.startedAt ?? null,
    finishedAt: inner.finishedAt ?? null,
    progress: progress
      ? {
          step: numberOrNull(progress.step),
          findings: numberOrNull(progress.findings),
          lastTool: typeof progress.lastTool === "string" ? progress.lastTool : null,
          lastSubject: typeof progress.lastSubject === "string" ? progress.lastSubject : null,
        }
      : null,
  };
}

/**
 * ONE REPORT, ARRANGED.
 *
 * @param {object|null} report the service's report object
 * @param {{ status?: string|null }} [options] the job status it arrived with, which is
 *   what decides whether this report may be read as complete
 * @returns {object|null} null only when there is genuinely no report
 */
export function viewReport(report, options = {}) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return null;
  const status = typeof options.status === "string" ? options.status : null;

  const complete = status === "done";
  const caps = capsView(report.caps);

  return {
    schema: typeof report.schema === "string" ? report.schema : null,
    jobId: typeof report.jobId === "string" ? report.jobId : null,

    /**
     * THE BANNER, and it is the most load-bearing string on the page. A report under a
     * status that is not `done` is partial by definition, and a reader who scrolls
     * straight to the findings must have been told so above them.
     */
    banner: complete
      ? caps.hit.length
        ? {
            tone: JOB_TONE.PARTIAL,
            text: `THIS INVESTIGATION STOPPED AT A CAP, NOT AT AN ANSWER (${caps.hit.map((h) => h.resource).join(", ")}). Everything it had not reached is UNEXAMINED, and an unexamined thing is not an absent one.`,
          }
        : null
      : {
          tone: JOB_TONE.PARTIAL,
          text: `THIS REPORT IS PARTIAL: the job is ${status ?? "in an unknown state"}, so what is below is what had been gathered when it stopped. Read nothing here as a complete picture, and read no absence into what is missing.`,
        },

    subject: {
      given: str(report.subject?.given),
      kind: str(report.subject?.kind),
      anchorHosts: arr(report.subject?.anchorHosts),
      note: str(report.subject?.note),
    },

    outcome: {
      status: str(report.outcome?.status),
      reading: str(report.outcome?.reading),
      /** Missing is not zero: a report that did not carry a step count says so. */
      steps: numberOrNull(report.outcome?.steps),
      model: str(report.outcome?.model),
      startedAt: str(report.outcome?.startedAt),
      finishedAt: str(report.outcome?.finishedAt),
    },

    summary: report.summary
      ? {
          text: String(report.summary),
          note: "Written by the model from the findings below, and passed through the same redaction as everything else it wrote. It is a summary of observations, not a verdict.",
        }
      : null,

    groups: groupsView(report.findings),
    findingCount: numberOrNull(report.findingCount),
    findingsNote: str(report.findingsNote),

    checked: {
      targets: arr(report.checked?.targets).map((t) => ({
        url: str(t?.url),
        host: str(t?.host),
        provenance: str(t?.provenance),
        provenanceLabel: str(t?.provenanceLabel),
        provenanceStrength: numberOrNull(t?.provenanceStrength),
        anchored: t?.anchored === true,
        depth: numberOrNull(t?.depth),
        foundIn: str(t?.foundIn),
        requests: numberOrNull(t?.requests),
        bytes: numberOrNull(t?.bytes),
        reached: t?.reached === true,
        outcomes: arr(t?.outcomes),
      })),
      reached: numberOrNull(report.checked?.reached),
      proposed: numberOrNull(report.checked?.proposed),
      hostsContacted: arr(report.checked?.hostsContacted),
      note: str(report.checked?.note),
    },

    declined: {
      entries: arr(report.declined?.entries).map((d) => ({
        url: str(d?.url),
        provenance: str(d?.provenance),
        code: str(d?.code),
        reason: str(d?.reason),
      })),
      count: numberOrNull(report.declined?.count),
      steeringAttempts: numberOrNull(report.declined?.steeringAttempts),
      note: str(report.declined?.note),
      steeringNote: str(report.declined?.steeringNote),
    },

    machineDirectedText: {
      found: report.machineDirectedText?.found === true,
      findings: arr(report.machineDirectedText?.findings),
      reading: str(report.machineDirectedText?.reading),
    },

    rejectedClaims: {
      entries: arr(report.rejectedClaims?.entries),
      note: str(report.rejectedClaims?.note),
    },

    /** Rendered as loudly as the findings. A report that lists findings and stops is read
     *  as exhaustive, which is the single easiest way for this page to mislead. */
    notChecked: arr(report.notChecked).map((n) => String(n)),
    notCheckedNote: str(report.notCheckedNote),

    caps,
    cost: costView(report.cost, caps),

    languageScrubbed: arr(report.languageScrubbed).map((w) => String(w)),
    languageScrubbedNote: str(report.languageScrubbedNote),
    disclaimer: str(report.disclaimer),
  };
}

/* --------------------------------- sections --------------------------------- */

/**
 * FINDINGS, GROUPED, WITH EVERY QUOTE MARKED FOR WHOSE WORDS IT IS.
 *
 * THE MARK IS COMPUTED HERE AND NOT TAKEN FROM THE REPORT, because it is the one thing on
 * this page a reader cannot reconstruct: a figure quoted out of `/api/vault` and a figure
 * read off the chain look identical in a paragraph, and only one of them was written by
 * the party being investigated. `chain:` sources are the only class in the whole report
 * that nobody wrote for a reader — everything else, however the address for it was
 * arrived at, is the subject's own output.
 */
function groupsView(groups) {
  return arr(groups).map((g) => ({
    group: str(g?.group),
    label: str(g?.label),
    count: numberOrNull(g?.count),
    findings: arr(g?.findings).map((f) => ({
      id: str(f?.id),
      statement: str(f?.statement),
      restsOn: str(f?.restsOn),
      provenanceFloor: numberOrNull(f?.provenanceFloor),
      evidence: arr(f?.evidence).map((e) => {
        const url = str(e?.source?.url);
        const chain = typeof url === "string" && url.startsWith("chain:");
        const quote = str(e?.quote);
        return {
          what: str(e?.what),
          quote,
          /** The fence, per quote, in the shape the component renders. */
          quoted: quote
            ? {
                text: quote,
                subjectsOwnWords: !chain,
                label: chain
                  ? "Read from the chain. Nobody wrote this for a reader."
                  : "THE INVESTIGATED PARTY'S OWN WORDS, quoted as their account of themselves — not as an established fact.",
              }
            : null,
          source: {
            url,
            isChainRecord: chain,
            provenance: str(e?.source?.provenance),
            provenanceLabel: str(e?.source?.provenanceLabel),
            provenanceStrength: numberOrNull(e?.source?.provenanceStrength),
            howItWasReached: str(e?.source?.howItWasReached),
            retrievedAt: str(e?.source?.retrievedAt),
            tool: str(e?.source?.tool),
          },
        };
      }),
    })),
  }));
}

/**
 * THE CAPS, AS ROWS, WITH EVERY CAPPED FIGURE MARKED AS A FLOOR.
 *
 * `capped: true` is not decoration. It means the run stopped counting, so the number
 * beside it is the least it spent and not what it would have spent — which is why the row
 * carries the words rather than leaving them to a footnote somebody scrolls past.
 */
function capsView(caps) {
  const rows = [];
  const source = caps && typeof caps === "object" ? caps : null;
  const RESOURCES = [
    ["steps", "Decision steps"],
    ["toolCalls", "Tool calls"],
    ["fetchedBytes", "Bytes fetched"],
    ["modelTokens", "Model tokens"],
    ["wallMs", "Wall clock (ms)"],
  ];
  for (const [key, label] of RESOURCES) {
    const row = source?.[key];
    if (!row || typeof row !== "object") continue;
    const capped = row.capped === true;
    rows.push({
      resource: key,
      label,
      used: numberOrNull(row.used),
      cap: numberOrNull(row.cap),
      capped,
      /** The wording a reader needs beside the number, not under the table. */
      reading: capped
        ? "This ceiling was reached, so the figure is AT LEAST this much — a bound, not a measurement."
        : "Within its ceiling: this is what was actually spent.",
    });
  }
  return {
    rows,
    hit: arr(source?.hit).map((h) => ({
      resource: str(h?.resource),
      used: numberOrNull(h?.used),
      cap: numberOrNull(h?.cap),
      reading: str(h?.reading),
    })),
    reading: str(source?.reading),
    wander: source?.wander && typeof source.wander === "object" ? source.wander : null,
    /** No caps block at all is a gap in the report, not a run that had no limits. */
    present: Boolean(source),
    absentNote: source ? null : "This report carried no caps block, so what it cost and whether it stopped at a limit are UNKNOWN here.",
  };
}

/** What it cost, including somebody else's bandwidth. Capped figures stay bounds. */
function costView(cost, caps) {
  if (!cost || typeof cost !== "object") {
    return { present: false, rows: [], note: "This report carried no cost block." };
  }
  const bytesCapped = caps.rows.some((r) => r.resource === "fetchedBytes" && r.capped);
  const tokensCapped = caps.rows.some((r) => r.resource === "modelTokens" && r.capped);
  return {
    present: true,
    rows: [
      { label: "Model calls", value: numberOrNull(cost.modelCalls), bound: false },
      { label: "Tokens", value: numberOrNull(cost.totalTokens), bound: tokensCapped },
      { label: "Bytes fetched", value: numberOrNull(cost.fetchedBytes), bound: bytesCapped },
      { label: "Requests made", value: numberOrNull(cost.requests), bound: false },
      { label: "Wall clock (ms)", value: numberOrNull(cost.wallMs), bound: false },
    ],
    note: str(cost.note),
  };
}

/* --------------------------------- helpers ---------------------------------- */

/** A string, or null. Never "" and never "undefined" printed at a reader. */
function str(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

/** A finite number, or NULL — never a zero standing in for a figure nobody sent. */
function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}
