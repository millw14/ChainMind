import { createServer } from "node:http";
import { getStore } from "../../lib/store.js";
import { AUTH_HEADER, checkAuth } from "../render/lib/auth.js";
import { readConfig } from "./lib/config.js";
import { JOB_STATUS, failJob, finishJob, heartbeat, readJob, startJob, submitJob } from "./lib/jobs.js";
import { createModelClient } from "./lib/model.js";
import { runInvestigation } from "./lib/loop.js";

/**
 * THE SERVICE — submit a job, poll it, collect the report. Three routes and nothing else.
 *
 * WHY THE DOOR IS THE RENDER SERVICE'S DOOR, IMPORTED RATHER THAN COPIED. Both services
 * answer the same question — does this caller hold the shared secret — and the answer has
 * one subtlety worth getting right (a timing-safe comparison, because `a === b` on strings
 * leaks how many leading bytes were correct). A second copy of that here would be a second
 * implementation the moment either changed, and the weaker one is always the one that gets
 * used. So `services/render/lib/auth.js` is imported across the directory boundary exactly
 * as `lib/safe-fetch.js` is, and the Dockerfile copies it in.
 *
 * WHY SUBMIT-AND-POLL RATHER THAN ONE LONG REQUEST. An investigation runs for minutes.
 * There is no honest HTTP request shape for that: a platform kills a long request, a proxy
 * times it out, a client gives up, and each of those discards work that was really done and
 * bandwidth somebody else really paid for. The 202 goes back in milliseconds; the work
 * happens against a job record that survives the connection; and the job's own heartbeat is
 * what makes a dead worker distinguishable from a slow one. See lib/jobs.js.
 *
 * WHAT THIS PROCESS HOLDS, and why that is defensible when the render service holds one
 * secret and nothing else: the Groq key, the store credentials, the render shared secret
 * and an optional read-only GitHub token. THIS PROCESS NEVER EXECUTES THIRD-PARTY CODE — it
 * makes HTTP requests through lib/safe-fetch.js and reads the bytes. When a page needs a
 * browser it calls services/render over HTTP, and the browser stays over there with its one
 * secret. The hostile code and the credentials live in different containers. A change that
 * puts a browser in this package would collapse that and is the wrong change. See
 * lib/config.js.
 *
 * Server-side only: no React.
 */

const boot = readConfig();
if (!boot.ok) {
  for (const p of boot.problems) console.error(`[research] CONFIGURATION: ${p}`);
  console.error("[research] Refusing to start. See services/research/README.md.");
  process.exit(1);
}
const config = boot.config;

/** A URL is short and a subject is one URL; anything longer is not one. */
const MAX_BODY_BYTES = 4_096;

const complete = createModelClient({ apiKey: process.env.GROQ_API_KEY || process.env.GEOQ_API_KEY });

/**
 * THE QUEUE THIS PROCESS ACTUALLY WORKS, held in memory beside the durable job records.
 *
 * The store holds the truth about every job — status, heartbeat, result — and this array
 * holds only the order this replica will pick them up in. That split is deliberate and it
 * has a consequence an operator must know about: WITH MORE THAN ONE REPLICA, TWO WORKERS
 * COULD CLAIM THE SAME JOB, because lib/store.js exposes no lock strong enough to prevent
 * it and inventing one on top of INCREMENT would be a lock whose failure mode is silent.
 * So this service runs at one replica, the README says so, and lib/jobs.js startJob
 * narrows rather than pretending to lock.
 */
const pending = [];
let draining = false;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://research.local");

  if (url.pathname === "/healthz") return health(req, res);

  const jobMatch = /^\/research\/([A-Za-z0-9-]{6,64})$/.exec(url.pathname);
  if (url.pathname !== "/research" && !jobMatch) {
    return send(res, 404, { ok: false, status: "not_found", reading: "This service has three routes: POST /research, GET /research/<id> and GET /healthz." });
  }

  const auth = checkAuth(req.headers[AUTH_HEADER], config.secret);
  if (!auth.ok) {
    // The LOG says which check failed; the RESPONSE does not. Telling an unauthenticated
    // caller how close they got is telling them how to get closer.
    console.warn(`[research] 401: ${auth.reason}`);
    res.setHeader("www-authenticate", "Bearer");
    return send(res, 401, { ok: false, status: "unauthorized", reading: "This service requires the shared secret as an Authorization: Bearer header." });
  }

  if (jobMatch) return await getJob(req, res, jobMatch[1]);
  return await postJob(req, res);
});

/**
 * SUBMIT. Answers in milliseconds with an id and a poll URL; the work happens afterwards.
 *
 * A submission that cannot be RECORDED is refused rather than started, because a job nobody
 * can poll is a job that has silently failed — the caller would wait for a result that has
 * no address.
 */
async function postJob(req, res) {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return send(res, 405, { ok: false, status: "bad_request", reading: "POST a JSON body of { \"subject\": \"https://…\" | \"0x…\" } to this route." });
  }

  let body = null;
  try {
    body = await readBody(req);
  } catch (e) {
    return send(res, 400, { ok: false, status: "bad_request", reading: String(e?.message ?? e).slice(0, 200) });
  }

  const subject = typeof body?.subject === "string" ? body.subject.trim() : "";
  if (!subject) return send(res, 400, { ok: false, status: "bad_request", reading: "The body must be JSON with a `subject` string: a URL or a 0x contract address." });

  if (pending.length >= config.maxQueued) {
    res.setHeader("retry-after", "30");
    return send(res, 503, {
      ok: false,
      status: "at_capacity",
      reading: `This service already has ${pending.length} job(s) waiting, which is its cap. NOTHING WAS INVESTIGATED and nothing here is a fact about the subject. Retry.`,
    });
  }

  let store = null;
  try {
    store = await getStore();
  } catch (e) {
    return send(res, 503, { ok: false, status: "unavailable", reading: `This service has no usable job store (${String(e?.message ?? e).slice(0, 160)}), so nothing was queued. An outage HERE, not a fact about the subject.` });
  }

  const submitted = await submitJob(store, {
    subject,
    requestedBy: typeof body?.requestedBy === "string" ? body.requestedBy : null,
    idempotencyKey: typeof body?.idempotencyKey === "string" ? body.idempotencyKey : null,
    limits: { wallMs: config.limits.wallMs, resultTtlMs: config.limits.RESULT_TTL_MS, queueWaitMs: config.limits.QUEUE_WAIT_MS },
  });
  if (!submitted.ok) return send(res, 409, { ok: false, status: "not_queued", reading: submitted.refusal });

  if (!submitted.deduped) {
    pending.push(submitted.job.id);
    drain();
  }
  return send(res, 202, {
    ok: true,
    status: submitted.job.status,
    /** DEDUPED IS PART OF THE ANSWER, not an implementation detail: a caller that retried
     *  needs to know it is being handed the earlier run rather than a new one. */
    deduped: submitted.deduped,
    id: submitted.job.id,
    poll: `/research/${submitted.job.id}`,
    subject: submitted.job.subject,
    wallMs: submitted.job.wallMs,
    reading: submitted.deduped
      ? "An investigation of this subject was already submitted and is being worked on or is finished. This is that job, not a second one — the same third party is not read twice for one question asked twice."
      : "Queued. Poll the URL above; a report takes minutes, not seconds.",
  });
}

/** POLL. The status is derived from the record and the clock, so a dead worker shows. */
async function getJob(req, res, id) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("allow", "GET");
    return send(res, 405, { ok: false });
  }
  let store = null;
  try {
    store = await getStore();
  } catch (e) {
    return send(res, 503, { ok: false, status: "unavailable", reading: `The job store did not answer (${String(e?.message ?? e).slice(0, 160)}). An outage HERE: it says nothing about whether the job ran.` });
  }
  const got = await readJob(store, id, { limits: { heartbeatStaleMs: config.limits.HEARTBEAT_STALE_MS, queueWaitMs: config.limits.QUEUE_WAIT_MS } });
  if (!got.ok) return send(res, got.notFound ? 404 : 503, { ok: false, status: "unknown", reading: got.refusal });

  const job = got.job;
  return send(res, 200, {
    ok: true,
    id: job.id,
    status: job.status,
    terminal: job.terminal,
    reading: job.reading,
    subject: job.subject ?? null,
    submittedAt: iso(job.submittedAt),
    startedAt: iso(job.startedAt),
    finishedAt: iso(job.finishedAt),
    deadlineAt: iso(job.deadlineAt),
    progress: job.progress ?? null,
    outcome: job.outcome ?? null,
    /**
     * THE REPORT TRAVELS ON A FAILED OR ABANDONED JOB TOO, when there is one. A partial
     * report is real evidence that was really gathered, and throwing it away because the
     * run did not finish would discard work somebody else's bandwidth already paid for.
     * The status above says it is partial, which is what stops it being read as complete.
     */
    report: job.report ?? null,
  });
}

/**
 * The health check. Unauthenticated, so it leaks nothing: no secret, no subjects, no
 * targets. Queue depth and uptime are not secrets, and they are what an operator needs.
 */
function health(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("allow", "GET");
    return send(res, 405, { ok: false });
  }
  send(res, 200, {
    ok: true,
    service: "chainmind-research",
    queued: pending.length,
    workers: config.workers,
    active: activeWorkers,
    model: config.model,
    renderAvailable: config.renderAvailable,
    githubToken: config.githubToken ? "configured" : "absent (anonymous GitHub rate limit applies)",
    uptimeMs: Math.round(process.uptime() * 1_000),
    node: process.version,
  });
}

/* ---------------------------------- the worker ---------------------------------- */

let activeWorkers = 0;

/** Start as many workers as the configuration allows and there is work for. */
function drain() {
  while (!draining && activeWorkers < config.workers && pending.length) {
    const id = pending.shift();
    activeWorkers += 1;
    work(id).finally(() => {
      activeWorkers -= 1;
      drain();
    });
  }
}

/**
 * WORK ONE JOB.
 *
 * The heartbeat runs on a timer rather than only at step boundaries, because a step can be
 * a 60-second model turn and a heartbeat that only fired between steps would look like a
 * dead worker every time the model was slow.
 */
async function work(id) {
  let store = null;
  try {
    store = await getStore();
  } catch (e) {
    console.error(`[research] ${id}: no store, cannot start (${String(e?.message ?? e)})`);
    return;
  }
  const limits = { heartbeatStaleMs: config.limits.HEARTBEAT_STALE_MS, queueWaitMs: config.limits.QUEUE_WAIT_MS, resultTtlMs: config.limits.RESULT_TTL_MS, wallMs: config.limits.wallMs };

  const started = await startJob(store, id, { worker: `pid${process.pid}`, limits });
  if (!started.ok) {
    console.warn(`[research] ${id}: not started — ${started.refusal}`);
    return;
  }
  const job = started.job;
  console.log(`[research] ${id}: started on ${job.subject?.given?.slice(0, 120)}`);

  let progress = { step: 0, findings: 0 };
  const beat = setInterval(() => {
    heartbeat(store, id, { progress, limits }).catch(() => {});
  }, config.limits.HEARTBEAT_MS);

  try {
    const { report, outcome } = await runInvestigation({
      subject: job.subject,
      config,
      complete,
      job,
      onStep: (event) => {
        if (event.phase === "step") progress = { step: event.step, findings: event.findings, remainingMs: event.remainingMs };
        if (event.phase === "tool") progress = { ...progress, lastTool: event.tool, lastSubject: event.subject };
      },
    });
    clearInterval(beat);
    /**
     * A LOOP THAT ENDED BECAUSE THE MODEL WAS UNREACHABLE IS A FAILED JOB, NOT A FINISHED
     * ONE, even though it produced a well-formed report. The distinction is the whole
     * discipline: a report with no findings because nothing could be asked is not a report
     * that found nothing.
     */
    const ourFault = outcome.status === "model_unavailable" || outcome.status === "model_failed_midway";
    if (ourFault) {
      await failJob(store, id, { reading: outcome.reading, report, outcome, limits });
      console.warn(`[research] ${id}: ${outcome.status} after ${outcome.steps} step(s)`);
    } else {
      await finishJob(store, id, { report, outcome, limits });
      console.log(`[research] ${id}: ${outcome.status} — ${outcome.steps} step(s), ${report.findingCount} finding(s), ${outcome.promptTokens + outcome.completionTokens} tokens, ${report.cost.fetchedBytes} bytes, ${outcome.elapsedMs}ms`);
    }
  } catch (e) {
    clearInterval(beat);
    // runInvestigation is written never to throw. If it does anyway, the one thing that must
    // NOT happen is a job left saying `running` forever — it would be reported as abandoned
    // a minute later, which is true but far less useful than the actual error.
    console.error(`[research] ${id}: unexpected`, e);
    await failJob(store, id, {
      reading: `This service failed while investigating: ${String(e?.message ?? e).slice(0, 200)}. NOTHING HERE IS A FACT ABOUT THE SUBJECT — it is a fault in this service.`,
      limits,
    }).catch(() => {});
  }
}

/* ---------------------------------- plumbing ---------------------------------- */

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return reject(new Error(`The request body declared ${declared} bytes, past the ${MAX_BODY_BYTES}-byte cap.`));
    }
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        return reject(new Error(`The request body ran past the ${MAX_BODY_BYTES}-byte cap.`));
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return reject(new Error("The request body was empty; it must be JSON with a `subject` string."));
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("The request body is not JSON."));
      }
    });
    req.on("error", (e) => reject(e));
  });
}

/** One JSON response shape, one place that sets the headers keeping it out of caches. */
function send(res, status, payload) {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    // A report about a third party has no business in any intermediary.
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "referrer-policy": "no-referrer",
  });
  res.end(body);
}

function iso(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.listen(config.port, () => {
  console.log(
    `[research] listening on :${config.port} — model ${config.model}, ${config.workers} worker(s), ` +
      `caps: ${config.limits.steps} steps / ${config.limits.toolCalls} calls / ${Math.round(config.limits.wallMs / 1000)}s / ` +
      `${config.limits.modelTokens} tokens / ${config.limits.fetchedBytes} bytes, render ${config.renderAvailable ? "available" : "NOT configured"}`,
  );
});

// Railway sends SIGTERM on redeploy. A job in flight cannot be finished in the grace
// period, so the honest thing is to stop taking new ones and let the ones running die
// visibly: their heartbeat stops, and a poller sees `abandoned` rather than waiting forever
// on a `running` record nobody will ever touch again.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    draining = true;
    console.log(`[research] ${signal}: draining — ${pending.length} queued job(s) will not be started, ${activeWorkers} in flight will stop and be reported as abandoned`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

export { config, pending };
