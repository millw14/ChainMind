import { RESEARCH_ACCESS, chargeResearchJob, publicResearchAccess, resolveResearchAccess } from "./research-access.js";
import { RESEARCH_TRANSPORT, pollResearch, researchConfigured, screenSubject, submitResearch } from "./research-client.js";
import { detectResearchRequest } from "./research-intent.js";
import { getStore } from "./store.js";

/**
 * START ONE DEEP INVESTIGATION, AND READ ONE BACK — the whole app-side decision in two
 * calls, so that the route above it is a guard and an adapter and nothing else.
 *
 * IT LIVES IN lib/ FOR THE SAME REASON lib/ask-access.js DOES: the route imports
 * "next/server" and the "@/" alias and so cannot be loaded by `node --test`, and this is
 * exactly the code that has to be tested — a gate, an allowance and a poll nobody can
 * exercise are three things nobody knows the shape of. Everything here takes an injected
 * store and an injected fetcher; production passes neither and gets the real ones.
 *
 * THE ORDER OF THE CHECKS IS DELIBERATE AND IS NOT THE OBVIOUS ONE:
 *   1. IS THE FEATURE CONFIGURED AT ALL. First, because "this deployment cannot do that"
 *      must never arrive dressed as "you are out of allowance" or as a sign-in prompt.
 *      A visitor asked to connect a wallet for a button that could never work either way
 *      has been lied to.
 *   2. IS THE SUBJECT A SUBJECT. Before the gate, because a refusal here costs nothing
 *      and telling somebody they have spent their allowance on a typo is worse.
 *   3. WHO IS ASKING, AND HAVE THEY GOT ONE LEFT. lib/research-access.js.
 *   4. SUBMIT — and only then charge. See resolveResearchAccess for why that ordering.
 *
 * THE JOB HAS AN OWNER AND THE REPORT IS NOT PUBLIC. A report is about identifiable
 * people and businesses; a job id in a URL is a capability, and one that is only ever six
 * to sixty-four characters of somebody else's id is not an access control. So a record of
 * WHO submitted each job is written here, in the app's own store, and readResearch will
 * not return a report to a session that has no such record. The research service itself
 * knows nothing about wallets and should not.
 *
 * NOTHING HERE EVER BLOCKS ON THE JOB. Submitting is one 202; the investigation runs for
 * minutes against a record that outlives the request. See services/research/README.md.
 *
 * Server-side only: no React.
 */

/** What happened, in one word. The UI and the ask path both switch on this. */
export const RESEARCH_JOB = Object.freeze({
  STARTED: "started",
  /** The service recognised this subject as one already being investigated. */
  DEDUPED: "deduped",
  NOT_CONFIGURED: "not_configured",
  MISCONFIGURED: "misconfigured",
  NEEDS_SIGN_IN: "needs_sign_in",
  OUT_OF_ALLOWANCE: "out_of_allowance",
  DISABLED: "disabled",
  REFUSED_SUBJECT: "refused_subject",
  UNAVAILABLE: "unavailable",
  AT_CAPACITY: "at_capacity",
  REJECTED: "rejected",
  /** Reading: no job of that id belongs to this caller (or the record has aged out). */
  NOT_YOURS: "not_yours",
  /** The question was not asking for an investigation. Nothing happened, and that is fine. */
  NOT_WANTED: "not_wanted",
});

/**
 * How long the app remembers who submitted a job.
 *
 * Longer than the service keeps its result would be a link that resolves to nothing;
 * shorter would be a report the owner cannot open while the service still holds it. Three
 * days is the service's own result TTL, and if an operator changes theirs the failure is
 * benign in one direction only — which is why readResearch distinguishes "no record here"
 * from "the service has no record".
 */
export const OWNER_RECORD_TTL_MS = 3 * 24 * 60 * 60_000;

/**
 * START ONE.
 *
 * @param {{ subject: string, sessionCookie?: string|null, ip?: string, store?: object|null,
 *   env?: object, fetcher?: Function, now?: number }} args
 * @returns {Promise<object>} never throws; always has `state` and a finished `reading`
 */
export async function startResearch({
  subject,
  sessionCookie = null,
  ip = "unknown",
  store = null,
  env = process.env,
  fetcher = undefined,
  now = Date.now(),
} = {}) {
  // 1. CONFIGURED AT ALL. Cheapest, and the one whose answer must not be disguised.
  if (!researchConfigured(env)) {
    return block({
      state: RESEARCH_JOB.NOT_CONFIGURED,
      reading:
        "Deep investigations are not available on this deployment: no research service is configured. That is a fact about THIS INSTALLATION and nothing about the subject — the chain half of every answer is unaffected. See services/research/README.md.",
    });
  }

  // 2. A SUBJECT, BEFORE ANYTHING IS SPENT.
  const screened = screenSubject(subject);
  if (!screened.ok) {
    return block({ state: RESEARCH_JOB.REFUSED_SUBJECT, code: screened.code, reading: screened.refusal });
  }

  // 3. WHO IS ASKING.
  const resolved = store ?? (await openStore());
  const access = await resolveResearchAccess({ sessionCookie, ip, store: resolved, now, env });
  if (!access.allowed) {
    const state =
      access.state === RESEARCH_ACCESS.ANONYMOUS
        ? RESEARCH_JOB.NEEDS_SIGN_IN
        : access.state === RESEARCH_ACCESS.DISABLED
          ? RESEARCH_JOB.DISABLED
          : RESEARCH_JOB.OUT_OF_ALLOWANCE;
    return block({ state, reading: access.message, access: publicResearchAccess(access) });
  }

  // 4. SUBMIT.
  const submitted = await submitResearch(screened.subject, {
    env,
    fetcher,
    // The service logs this and nothing else about the caller. A shortened address is
    // enough to tell two jobs apart in a log and is already public on chain; a full
    // session, an IP or a question would be neither necessary nor ours to hand over.
    requestedBy: `chainmind:${String(access.address).slice(0, 10)}`,
  });

  if (!submitted.ok) {
    const state =
      submitted.state === RESEARCH_TRANSPORT.AT_CAPACITY
        ? RESEARCH_JOB.AT_CAPACITY
        : submitted.state === RESEARCH_TRANSPORT.MISCONFIGURED
          ? RESEARCH_JOB.MISCONFIGURED
          : submitted.state === RESEARCH_TRANSPORT.REFUSED_SUBJECT
            ? RESEARCH_JOB.REFUSED_SUBJECT
            : submitted.state === RESEARCH_TRANSPORT.REJECTED
              ? RESEARCH_JOB.REJECTED
              : RESEARCH_JOB.UNAVAILABLE;
    // NOTHING WAS CHARGED. A job that never started costs no allowance, which is the
    // whole reason the charge comes after the submission rather than before it.
    return block({ state, reading: submitted.reading, access: publicResearchAccess(access) });
  }

  // The owner record first, then the charge: a job the caller cannot open is worse than
  // a job that was not counted, and both are better than either happening silently.
  const recorded = await rememberOwner(resolved, { id: submitted.id, address: access.address, subject: screened.subject, now });
  const charged = await chargeResearchJob({ store: resolved, address: access.address, limit: access.limit, now });

  return block({
    state: submitted.deduped ? RESEARCH_JOB.DEDUPED : RESEARCH_JOB.STARTED,
    id: submitted.id,
    pollPath: submitted.pollPath,
    reportPath: submitted.reportPath,
    subject: submitted.subject,
    wallMs: submitted.wallMs,
    reading: `${submitted.reading} Nothing is decided while it runs, and the answer above is unaffected by it.`,
    access: publicResearchAccess({ ...access, used: charged.used, remaining: charged.remaining, degraded: access.degraded || charged.degraded }),
    /** Said out loud rather than swallowed: without it the owner cannot open the report
     *  from another tab, and a link that quietly does not work is the worst of the three
     *  outcomes here. */
    ownerRecorded: recorded,
    ...(recorded
      ? {}
      : {
          warning:
            "This deployment could not record who started this job, so the report may not open from a link. The investigation itself is unaffected — it is running on the research service.",
        }),
  });
}

/**
 * READ ONE BACK, for the caller who started it.
 *
 * A poll is cheap and is NOT metered: refusing to show somebody a report they have
 * already paid for, because they refreshed the page too often, would be a limit that only
 * ever punishes the person waiting. The per-minute limiter on the route is what stops a
 * poll loop becoming a hammer.
 *
 * @param {{ id: string, sessionCookie?: string|null, store?: object|null, env?: object,
 *   fetcher?: Function, now?: number }} args
 * @returns {Promise<object>} never throws
 */
export async function readResearch({
  id,
  sessionCookie = null,
  store = null,
  env = process.env,
  fetcher = undefined,
  now = Date.now(),
} = {}) {
  if (!researchConfigured(env)) {
    return block({
      state: RESEARCH_JOB.NOT_CONFIGURED,
      reading:
        "Deep investigations are not available on this deployment: no research service is configured, so there is no job to read. A fact about THIS INSTALLATION.",
    });
  }

  const resolved = store ?? (await openStore());
  const access = await resolveResearchAccess({ sessionCookie, store: resolved, now, env });
  if (!access.address) {
    return block({
      state: RESEARCH_JOB.NEEDS_SIGN_IN,
      reading: "A research report is shown to the wallet that started it. Connect and sign in to open yours.",
    });
  }

  const owned = await ownsJob(resolved, { id, address: access.address });
  if (!owned) {
    // DELIBERATELY THE SAME ANSWER FOR "somebody else's job" AND "no such job". Telling a
    // caller that an id exists but is not theirs is telling them ids can be probed for.
    return block({
      state: RESEARCH_JOB.NOT_YOURS,
      reading:
        "No research job with that id was started by this wallet on this deployment. Records age out after a few days, so an old link can read this way too.",
    });
  }

  const polled = await pollResearch(id, { env, fetcher });
  return block({
    state: polled.ok ? "job" : polled.state === RESEARCH_TRANSPORT.UNKNOWN_JOB ? RESEARCH_JOB.NOT_YOURS : RESEARCH_JOB.UNAVAILABLE,
    reading: polled.reading,
    job: polled.ok ? polled : null,
    /** An outage of ours is never terminal: the job may well still be running, and a UI
     *  that stops polling on it would abandon a report that is on its way. */
    terminal: polled.ok ? polled.terminal === true : polled.state === RESEARCH_TRANSPORT.UNKNOWN_JOB,
  });
}

/**
 * THE ASK PATH'S ENTRY POINT: a question that wants an investigation gets one STARTED.
 *
 * WHY IT STARTS ONE RATHER THAN SUGGESTING ONE. "Check this project out properly" asked
 * of a 24-second request budget has exactly two honest answers, and "here is a paragraph"
 * is not either of them. The other one — the chain half now, the web half in minutes, and
 * a link to it — is what this makes possible.
 *
 * IT MUST NEVER BLOCK THE QUESTION. The caller runs this CONCURRENTLY with the answer and
 * attaches whatever came back; a submission is one 202 and is bounded at six seconds by
 * lib/research-client.js, and an answer must not wait even that long for something that
 * is not part of it. Nothing here can make an answer late, and nothing here can make one
 * fail — every exit is a block with a state and a finished sentence.
 *
 * WHAT IT DOES NOT DO: it does not answer the question, it does not change the answer, and
 * it does not turn a name into a target. See lib/research-intent.js.
 *
 * @returns {Promise<object>} always has `wanted` and `state`
 */
export async function researchForAsk({
  question,
  target = null,
  sessionCookie = null,
  ip = "unknown",
  store = null,
  env = process.env,
  fetcher = undefined,
  now = Date.now(),
} = {}) {
  const detected = detectResearchRequest(question, { target });
  if (!detected.wanted) {
    return { ...block({ state: RESEARCH_JOB.NOT_WANTED, reading: "" }), wanted: false, want: detected.want, matched: detected.matched };
  }

  // Wanted, but aimed at nothing that may be fetched — usually a project named rather
  // than linked. Reported to the reader as a limit of the feature, because it is one.
  if (!detected.subject) {
    return {
      ...block({ state: RESEARCH_JOB.REFUSED_SUBJECT, reading: detected.refusal }),
      wanted: true,
      want: detected.want,
      matched: detected.matched,
    };
  }

  const started = await startResearch({ subject: detected.subject.given, sessionCookie, ip, store, env, fetcher, now });
  return { ...started, wanted: true, want: detected.want, matched: detected.matched };
}

/**
 * The block trimmed to what a client may render, in the ONE shape both the streamed and
 * the JSON reply carry — a second shape for the same fact is how one of them drifts.
 */
export function publicResearchBlock(block_) {
  if (!block_ || block_.wanted !== true) return null;
  return {
    state: block_.state,
    reading: block_.reading || "",
    id: block_.id ?? null,
    reportPath: block_.reportPath ?? null,
    subject: block_.subject ?? null,
    /** What the question said that was read as a request to investigate. Shown so a
     *  reader can see WHY a job started, and disagree with it. */
    matched: Array.isArray(block_.matched) ? block_.matched.slice(0, 4) : [],
    access: block_.access ?? null,
    ...(block_.warning ? { warning: block_.warning } : {}),
  };
}

/* --------------------------------- internals -------------------------------- */

/** The block shape, so no branch can quietly omit a field a caller switches on. */
function block(fields) {
  return {
    state: RESEARCH_JOB.UNAVAILABLE,
    id: null,
    pollPath: null,
    reportPath: null,
    subject: null,
    reading: "",
    job: null,
    access: null,
    terminal: false,
    ...fields,
  };
}

/**
 * The ownership record. Keyed by job AND address, so the service's own subject-level
 * de-duplication still works: two people who ask about the same site share one
 * investigation and each hold their own claim on it.
 */
function ownerKey(id, address) {
  return `research:owner:${String(id)}:${String(address ?? "").trim().toLowerCase()}`;
}

async function rememberOwner(store, { id, address, subject, now }) {
  if (typeof store?.set !== "function") return false;
  try {
    await store.set(ownerKey(id, address), { subject, submittedAt: new Date(now).toISOString() }, { ttlMs: OWNER_RECORD_TTL_MS });
    return true;
  } catch (e) {
    console.warn(`[research] owner record not written for ${id} — ${String(e?.message ?? e)}`);
    return false;
  }
}

async function ownsJob(store, { id, address }) {
  if (typeof store?.get !== "function") return false;
  try {
    return Boolean(await store.get(ownerKey(id, address)));
  } catch (e) {
    // A store that will not answer is not permission. The caller is told the record was
    // not found, which is true, rather than being shown a report on a failed lookup.
    console.error(`[research] owner lookup failed for ${id} — ${String(e?.message ?? e)}`);
    return false;
  }
}

/** The app's store if there is one, and null if there is not. */
async function openStore() {
  try {
    return await getStore();
  } catch (e) {
    console.error(`[research] no usable store — ${String(e?.message ?? e)}`);
    return null;
  }
}
