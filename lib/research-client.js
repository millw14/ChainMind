import { validateUrl } from "./safe-fetch.js";

/**
 * THE APP'S SIDE OF THE RESEARCH SERVICE — submit a deep investigation, poll it,
 * collect the report, and keep every way that can fail distinguishable.
 *
 * WHY IT MIRRORS lib/render-client.js RATHER THAN INVENTING A SECOND SHAPE. Both
 * modules face the same problem: an optional Railway deployment this app talks to over
 * HTTP, whose absence, misconfiguration, unreachability and refusals must never reach a
 * reader as a fact about the party being investigated. That reasoning is written out in
 * lib/render-client.js and is not repeated here; what differs is the SHAPE of the call.
 *
 * A RENDER IS ONE ROUND TRIP. AN INVESTIGATION IS A JOB. It runs for minutes, so there
 * is no request that can hold it: the service answers a submission in milliseconds with
 * an id, and the report is collected later by polling. That is why this module has two
 * entry points rather than one, and why NEITHER of them is ever allowed to block a
 * question — see lib/research-job.js, which is what the ask path actually calls.
 *
 * THREE STATES THAT ARE ROUTINELY CONFUSED AND ARE KEPT APART HERE:
 *   not_configured  — this deployment has no research service. A fact about US.
 *   unreachable     — it is configured and did not answer. Also a fact about US, and in
 *                     particular NOT a statement that the job failed or that a subject
 *                     could not be read.
 *   the job's own status — queued, running, done, failed, abandoned, expired. Only these
 *                     say anything about the investigation, and only `done` says the
 *                     report under it is complete.
 * A poll that could not reach the service returns `unreachable` and NEVER `failed`: an
 * outage of ours must not be reported as an investigation that came back empty.
 *
 * Server-side only: no React.
 */

/**
 * The bounds, together.
 *
 * SUBMIT_TIMEOUT_MS IS SHORT ON PURPOSE. Submitting is one 202 the service answers from
 * memory, so anything past a couple of seconds is a sick service rather than a busy one —
 * and this call can happen on the ask path, where every second spent here is a second the
 * answer does not get. The job it starts runs for minutes; THIS call must not.
 */
export const RESEARCH_CLIENT_LIMITS = Object.freeze({
  SUBMIT_TIMEOUT_MS: 6_000,
  POLL_TIMEOUT_MS: 8_000,
  /** A subject is one URL or one address. Anything longer is not one. */
  MAX_SUBJECT_CHARS: 300,
  /** The service's own id shape, from services/research/server.js. */
  ID_RE: /^[A-Za-z0-9-]{6,64}$/,
});

/** The states this module returns that are about US rather than about a job. */
export const RESEARCH_TRANSPORT = Object.freeze({
  NOT_CONFIGURED: "not_configured",
  MISCONFIGURED: "misconfigured",
  UNREACHABLE: "service_unreachable",
  AT_CAPACITY: "at_capacity",
  REFUSED_SUBJECT: "refused_subject",
  REJECTED: "rejected",
  UNKNOWN_JOB: "unknown_job",
});

/** Whether a deep investigation is possible at all in this deployment. */
export function researchConfigured(env = process.env) {
  return Boolean(String(env.RESEARCH_SERVICE_URL ?? "").trim() && String(env.RESEARCH_SHARED_SECRET ?? "").trim());
}

/**
 * The service's base URL, checked against the policy that fits WHAT IT IS.
 *
 * Identical reasoning to lib/render-client.js serviceBase, and identical on purpose: this
 * is OUR OWN infrastructure, so a private hostname on a non-default port is its normal
 * shape (Railway private networking) and must be allowed — while `validateUrl`, which is
 * the policy for an INVESTIGATED TARGET, would refuse exactly that. The one address a
 * service of ours is never legitimately at stays refused.
 *
 * Returns a verdict rather than a bare value: configured-but-rejected is a different fact
 * from absent, and an operator told "not configured" about a variable they already set is
 * being sent to fix the wrong thing.
 */
function serviceBase(env) {
  const raw = String(env.RESEARCH_SERVICE_URL ?? "").trim().replace(/\/+$/, "");
  if (!raw) return { base: null, problem: null };

  let parsed = null;
  try {
    parsed = new URL(`${raw}/research`);
  } catch {
    return { base: null, problem: `RESEARCH_SERVICE_URL is not a URL: ${raw.slice(0, 80)}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { base: null, problem: `RESEARCH_SERVICE_URL must be http or https, not ${parsed.protocol}` };
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "169.254.169.254" || host === "metadata.google.internal" || host === "metadata") {
    return { base: null, problem: "RESEARCH_SERVICE_URL points at the cloud metadata endpoint, which is never a research service" };
  }
  return { base: raw, problem: null };
}

/** The configuration verdict on its own, for a caller that has not submitted anything. */
export function researchServiceStatus(env = process.env) {
  const { base, problem } = serviceBase(env);
  const secret = String(env.RESEARCH_SHARED_SECRET ?? "").trim();
  if (problem) return { configured: false, problem };
  if (!base || !secret) {
    const missing = [!base ? "RESEARCH_SERVICE_URL" : null, !secret ? "RESEARCH_SHARED_SECRET" : null].filter(Boolean).join(" and ");
    return { configured: false, problem: null, missing };
  }
  return { configured: true, problem: null };
}

/**
 * IS THIS A SUBJECT, AND MAY IT BE FETCHED AT ALL — decided HERE, before anything is
 * spent, with the app's existing boundary rather than a second one.
 *
 * The service screens every target itself and would refuse the same URLs; this check is
 * not a substitute for that and does not pretend to be. It exists so that a submission
 * that could only ever be refused does not cost the caller one of their daily jobs, does
 * not occupy a queue slot, and does not put a loopback or metadata address into a request
 * this app makes on somebody's behalf.
 *
 * A 0x40-hex address is a subject too — it is what lib/project-profile.js reads — and it
 * is not a URL, so it never reaches validateUrl.
 *
 * @param {unknown} raw
 * @returns {{ ok: boolean, kind?: "url"|"address", subject?: string, code?: string, refusal?: string }}
 */
export function screenSubject(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) {
    return { ok: false, code: "empty", refusal: "A deep investigation needs a subject: a URL, or a 0x contract address on this chain." };
  }
  if (text.length > RESEARCH_CLIENT_LIMITS.MAX_SUBJECT_CHARS) {
    return {
      ok: false,
      code: "too_long",
      refusal: `That subject is ${text.length} characters, past the ${RESEARCH_CLIENT_LIMITS.MAX_SUBJECT_CHARS}-character limit. A subject is one URL or one address.`,
    };
  }
  if (/^0x[0-9a-fA-F]{40}$/.test(text)) return { ok: true, kind: "address", subject: text };

  const target = validateUrl(text);
  if (!target.ok) return { ok: false, code: target.code, refusal: target.refusal };
  return { ok: true, kind: "url", subject: String(target.url) };
}

/**
 * SUBMIT ONE INVESTIGATION. Answers with an id and a poll path, or with a named failure.
 *
 * NEVER THROWS. Every exit carries a `state` and a finished sentence, because the caller
 * is a request handler that has an answer to deliver either way.
 *
 * `idempotencyKey` is deliberately NOT set by default. Left off, the service dedupes by
 * SUBJECT — the same third party is not investigated twice because two people asked the
 * same question in the same window — and the reply says `deduped: true` so the caller can
 * say so rather than implying a fresh run.
 *
 * @param {string} subject
 * @param {{ fetcher?: Function, env?: object, timeoutMs?: number, requestedBy?: string|null,
 *   idempotencyKey?: string|null }} [options]
 * @returns {Promise<object>}
 */
export async function submitResearch(subject, options = {}) {
  const env = options.env ?? process.env;

  const screened = screenSubject(subject);
  if (!screened.ok) {
    return {
      ok: false,
      state: RESEARCH_TRANSPORT.REFUSED_SUBJECT,
      code: screened.code,
      reading: `NOTHING WAS INVESTIGATED: ${screened.refusal}`,
    };
  }

  const { base, problem } = serviceBase(env);
  const secret = String(env.RESEARCH_SHARED_SECRET ?? "").trim();

  if (problem) {
    return {
      ok: false,
      state: RESEARCH_TRANSPORT.MISCONFIGURED,
      reading: `NO INVESTIGATION WAS STARTED because the research service is misconfigured: ${problem}. That is a fault in THIS DEPLOYMENT's settings and nothing at all about the subject. See services/research/README.md.`,
    };
  }
  if (!base || !secret) {
    const missing = [!base ? "RESEARCH_SERVICE_URL" : null, !secret ? "RESEARCH_SHARED_SECRET" : null].filter(Boolean).join(" and ");
    return {
      ok: false,
      state: RESEARCH_TRANSPORT.NOT_CONFIGURED,
      reading: `NO INVESTIGATION WAS STARTED because this deployment has no research service configured (${missing} not set). That is a fact about THIS DEPLOYMENT and nothing at all about the subject — the chain half of the answer is unaffected. See services/research/README.md.`,
    };
  }

  const got = await call({
    url: `${base}/research`,
    secret,
    timeoutMs: numberOr(options.timeoutMs, RESEARCH_CLIENT_LIMITS.SUBMIT_TIMEOUT_MS),
    fetcher: options.fetcher,
    body: {
      subject: screened.subject,
      ...(options.requestedBy ? { requestedBy: String(options.requestedBy).slice(0, 120) } : {}),
      ...(options.idempotencyKey ? { idempotencyKey: String(options.idempotencyKey).slice(0, 120) } : {}),
    },
  });

  if (got.transportError) {
    return {
      ok: false,
      state: RESEARCH_TRANSPORT.UNREACHABLE,
      reading: `THE RESEARCH SERVICE COULD NOT BE REACHED (${got.transportError}). THIS IS AN OUTAGE OF OUR OWN INFRASTRUCTURE AND IS NOT A FACT ABOUT THE SUBJECT — no investigation was started, and nothing was found or not found.`,
    };
  }

  const payload = got.body;
  const readable = payload && typeof payload === "object" && !Array.isArray(payload);

  if (got.httpStatus === 503) {
    return {
      ok: false,
      state: RESEARCH_TRANSPORT.AT_CAPACITY,
      reading: readable && typeof payload.reading === "string"
        ? payload.reading
        : "The research service is at capacity, so nothing was queued. NOTHING WAS INVESTIGATED and nothing here is a fact about the subject. Try again shortly.",
    };
  }

  // A body that is not the contract is an outage, not a submission — the same rule
  // lib/render-client.js holds to. A proxy error page and a half-deployed service both
  // parse into SOMETHING, and building a result out of it produces a job id that does
  // not exist and a poll that will never resolve.
  if (!readable || typeof payload.id !== "string" || !RESEARCH_CLIENT_LIMITS.ID_RE.test(payload.id) || payload.ok !== true) {
    if (got.httpStatus && got.httpStatus >= 400) {
      return {
        ok: false,
        state: RESEARCH_TRANSPORT.REJECTED,
        httpStatus: got.httpStatus,
        reading: `The research service refused this submission (HTTP ${got.httpStatus}${readable && typeof payload.reading === "string" ? `: ${payload.reading.slice(0, 200)}` : ""}). NOTHING WAS INVESTIGATED.`,
      };
    }
    return {
      ok: false,
      state: RESEARCH_TRANSPORT.UNREACHABLE,
      reading: "THE RESEARCH SERVICE ANSWERED WITH SOMETHING THAT IS NOT ITS RESPONSE CONTRACT, so no job id exists to poll. This is an outage of our own infrastructure and is not a fact about the subject.",
    };
  }

  return {
    ok: true,
    state: "queued",
    id: payload.id,
    /** Built HERE from our own route rather than from the service's `poll` field: a path
     *  taken out of a response body is a path chosen by whatever answered. */
    pollPath: `/api/research/${payload.id}`,
    reportPath: `/research/${payload.id}`,
    subject: { given: screened.subject, kind: screened.kind },
    deduped: payload.deduped === true,
    wallMs: Number.isFinite(payload.wallMs) ? payload.wallMs : null,
    reading: payload.deduped === true
      ? "An investigation of this subject was already submitted and is being worked on or is finished. This is that job, not a second one."
      : "Queued. It takes minutes, not seconds — the report appears on the link above when it is done.",
  };
}

/**
 * POLL ONE JOB. Returns the service's own view of it, or a named failure of ours.
 *
 * THE ONE THING THIS MUST NEVER DO is turn an outage into a verdict. A service that does
 * not answer produces `service_unreachable` with `terminal: false`, so the UI keeps
 * saying "we could not reach it just now" rather than "the investigation failed" — and a
 * job that really is still running is not mourned.
 *
 * @param {string} id
 * @param {{ fetcher?: Function, env?: object, timeoutMs?: number }} [options]
 * @returns {Promise<object>}
 */
export async function pollResearch(id, options = {}) {
  const env = options.env ?? process.env;
  const jobId = typeof id === "string" ? id.trim() : "";

  // Shape-checked before it is put in a path. The id comes from a URL, and a path
  // segment built out of unvalidated input is how one service's route becomes another's.
  if (!RESEARCH_CLIENT_LIMITS.ID_RE.test(jobId)) {
    return { ok: false, state: RESEARCH_TRANSPORT.UNKNOWN_JOB, terminal: true, reading: "That is not the shape of a research job id." };
  }

  const { base, problem } = serviceBase(env);
  const secret = String(env.RESEARCH_SHARED_SECRET ?? "").trim();
  if (problem) {
    return { ok: false, state: RESEARCH_TRANSPORT.MISCONFIGURED, terminal: false, reading: `The research service is misconfigured in this deployment: ${problem}. The job's own state is UNKNOWN — this says nothing about whether it ran.` };
  }
  if (!base || !secret) {
    return {
      ok: false,
      state: RESEARCH_TRANSPORT.NOT_CONFIGURED,
      terminal: false,
      reading: "This deployment has no research service configured, so no job can be read from it. That is a fact about THIS DEPLOYMENT.",
    };
  }

  const got = await call({
    url: `${base}/research/${jobId}`,
    secret,
    method: "GET",
    timeoutMs: numberOr(options.timeoutMs, RESEARCH_CLIENT_LIMITS.POLL_TIMEOUT_MS),
    fetcher: options.fetcher,
  });

  if (got.transportError) {
    return {
      ok: false,
      state: RESEARCH_TRANSPORT.UNREACHABLE,
      terminal: false,
      reading: `THE RESEARCH SERVICE DID NOT ANSWER (${got.transportError}). This is an outage of our own infrastructure: THE JOB MAY WELL STILL BE RUNNING, and nothing here says it failed or that anything was or was not found.`,
    };
  }

  const payload = got.body;
  const readable = payload && typeof payload === "object" && !Array.isArray(payload);

  if (got.httpStatus === 404) {
    return {
      ok: false,
      state: RESEARCH_TRANSPORT.UNKNOWN_JOB,
      terminal: true,
      reading: "The research service has no record of that job. A record expires after a while, so an old link can read this way; it does not mean the investigation failed.",
    };
  }
  if (!readable || typeof payload.status !== "string") {
    return {
      ok: false,
      state: RESEARCH_TRANSPORT.UNREACHABLE,
      terminal: false,
      reading: `The research service answered with something that is not its response contract${got.httpStatus ? ` (HTTP ${got.httpStatus})` : ""}. This is an outage of ours; the job's state is UNKNOWN.`,
    };
  }

  return {
    ok: true,
    state: payload.status,
    terminal: payload.terminal === true,
    reading: typeof payload.reading === "string" ? payload.reading : null,
    id: jobId,
    subject: payload.subject ?? null,
    submittedAt: payload.submittedAt ?? null,
    startedAt: payload.startedAt ?? null,
    finishedAt: payload.finishedAt ?? null,
    deadlineAt: payload.deadlineAt ?? null,
    progress: payload.progress ?? null,
    outcome: payload.outcome ?? null,
    /** A partial report travels on a failed or abandoned job. The STATUS is what stops it
     *  being read as complete, which is why both always travel together. */
    report: payload.report ?? null,
  };
}

/* --------------------------------- plumbing --------------------------------- */

/** One round trip, with the caller's clock attached. Never throws. */
async function call({ url, secret, method = "POST", body = null, timeoutMs, fetcher: injected }) {
  const fetcher = typeof injected === "function" ? injected : fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher(url, {
      method,
      headers: {
        authorization: `Bearer ${secret}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const parsed = await res.json().catch(() => null);
    return { httpStatus: res.status, body: parsed };
  } catch (e) {
    const aborted = e?.name === "AbortError";
    return {
      httpStatus: null,
      body: null,
      transportError: aborted ? `it did not answer within ${timeoutMs}ms` : String(e?.message ?? e).slice(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }
}

function numberOr(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
