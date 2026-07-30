// Tests for THE QUEUE — services/research/lib/jobs.js.
//
// THE FAILURE THIS FILE EXISTS TO PREVENT, above every other: A CRASHED JOB MUST NOT LOOK
// LIKE A FINISHED ONE. A worker killed for memory, a container redeployed mid-run, a
// process that panicked — each leaves a record saying `running` that nothing will ever
// touch again. A poller that trusted the stored status would either wait forever or read a
// half-written result as a report about somebody's business.
//
// So deriveStatus is pure and is tested directly, with no store and no worker: it is the
// crashed-worker guarantee, and everything else here is plumbing around it.
//
// Fully offline, against lib/store.js's in-memory adapter.
// Run with: npm test (from the repository root)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "../../../lib/store.js";
import {
  JOB_STATUS,
  deriveStatus,
  failJob,
  finishJob,
  heartbeat,
  idempotencyHash,
  jobKey,
  readJob,
  startJob,
  submitJob,
} from "../lib/jobs.js";

const LIMITS = { heartbeatStaleMs: 60_000, queueWaitMs: 120_000, wallMs: 300_000, resultTtlMs: 3_600_000 };

/* --------------------------- the crashed-worker guarantee --------------------------- */

test("a running job that went silent is ABANDONED, never running and never done", () => {
  const job = { id: "j", status: JOB_STATUS.running, startedAt: 0, heartbeatAt: 1_000, deadlineAt: 300_000 };

  const alive = deriveStatus(job, 30_000, LIMITS);
  assert.equal(alive.status, JOB_STATUS.running);
  assert.equal(alive.terminal, false);

  const dead = deriveStatus(job, 1_000 + 60_001, LIMITS);
  assert.equal(dead.status, JOB_STATUS.abandoned);
  assert.equal(dead.terminal, true, "an abandoned job must be terminal or a poller waits forever");
  assert.match(dead.reading, /worker is gone/);
  assert.match(dead.reading, /OUTAGE OF THIS SERVICE AND IS NOT A FACT ABOUT THE SUBJECT/);
  assert.match(dead.reading, /HOW FAR IT GOT IS UNKNOWN/);
});

test("a running job past its own wall-clock deadline is visible as over-running", () => {
  const job = { id: "j", status: JOB_STATUS.running, startedAt: 0, heartbeatAt: 100_000, deadlineAt: 60_000, progress: { step: 4, findings: 2 } };
  const d = deriveStatus(job, 100_100, LIMITS);
  assert.equal(d.status, JOB_STATUS.running, "a heartbeating worker is still running");
  assert.match(d.reading, /PAST ITS OWN WALL-CLOCK DEADLINE/);
  assert.match(d.reading, /fault in this service/);
});

test("a job nobody ever picked up EXPIRES rather than sitting queued forever", () => {
  const job = { id: "j", status: JOB_STATUS.queued, submittedAt: 0 };
  assert.equal(deriveStatus(job, 60_000, LIMITS).status, JOB_STATUS.queued);
  const gone = deriveStatus(job, 120_001, LIMITS);
  assert.equal(gone.status, JOB_STATUS.expired);
  assert.equal(gone.terminal, true);
  assert.match(gone.reading, /NOTHING WAS INVESTIGATED/);
  assert.match(gone.reading, /nothing whatever about the subject/);
});

test("an unknown id and an unreadable status are both said plainly, not guessed at", () => {
  const missing = deriveStatus(null, 0, LIMITS);
  assert.equal(missing.status, "unknown");
  assert.match(missing.reading, /must not be reported as the first/);

  const junk = deriveStatus({ status: "half-way" }, 0, LIMITS);
  assert.equal(junk.status, "unknown");
  assert.match(junk.reading, /fault here, not as anything about the subject/);
});

test("terminal states are reported from the record and are not overridden by the clock", () => {
  const long = 10 * 24 * 3_600_000;
  assert.equal(deriveStatus({ status: JOB_STATUS.done, heartbeatAt: 0 }, long, LIMITS).status, JOB_STATUS.done);
  assert.equal(deriveStatus({ status: JOB_STATUS.failed, heartbeatAt: 0 }, long, LIMITS).status, JOB_STATUS.failed);
});

/* ---------------------------------- the lifecycle ---------------------------------- */

test("the whole happy lifecycle, and the status a caller sees at each point", async () => {
  const store = createMemoryStore();
  const submitted = await submitJob(store, { subject: "https://example.com/", limits: LIMITS });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.job.status, JOB_STATUS.queued);
  assert.equal(submitted.job.subject.kind, "url");
  assert.equal(submitted.job.wallMs, LIMITS.wallMs);

  const id = submitted.job.id;
  const started = await startJob(store, id, { limits: LIMITS });
  assert.equal(started.ok, true);
  assert.equal(started.job.status, JOB_STATUS.running);
  assert.ok(started.job.deadlineAt > started.job.startedAt, "a running job must carry a deadline a poller can see");

  assert.equal(await heartbeat(store, id, { progress: { step: 2, findings: 1 }, limits: LIMITS }), true);
  const mid = await readJob(store, id, { limits: LIMITS });
  assert.equal(mid.job.status, JOB_STATUS.running);
  assert.equal(mid.job.progress.step, 2);

  const done = await finishJob(store, id, { report: { schema: "x", findingCount: 3 }, outcome: { steps: 5 }, limits: LIMITS });
  assert.equal(done.ok, true);
  const polled = await readJob(store, id, { limits: LIMITS });
  assert.equal(polled.job.status, JOB_STATUS.done);
  assert.equal(polled.job.terminal, true);
  assert.equal(polled.job.report.findingCount, 3, "the status and the report are written together, so there is no window where done has nothing under it");
});

test("a job started twice is refused the second time", async () => {
  const store = createMemoryStore();
  const { job } = await submitJob(store, { subject: "https://example.com/a", limits: LIMITS });
  assert.equal((await startJob(store, job.id, { limits: LIMITS })).ok, true);
  const second = await startJob(store, job.id, { limits: LIMITS });
  assert.equal(second.ok, false);
  assert.match(second.refusal, /not queued/);
});

test("a heartbeat on a job that is not running does nothing rather than resurrecting it", async () => {
  const store = createMemoryStore();
  const { job } = await submitJob(store, { subject: "https://example.com/b", limits: LIMITS });
  assert.equal(await heartbeat(store, job.id, { limits: LIMITS }), false, "a queued job must not be heartbeatable");
  await startJob(store, job.id, { limits: LIMITS });
  await finishJob(store, job.id, { report: {}, limits: LIMITS });
  assert.equal(await heartbeat(store, job.id, { limits: LIMITS }), false, "a finished job must not be dragged back to running");
});

test("a failure keeps whatever partial report there was, and says whose fault it was", async () => {
  const store = createMemoryStore();
  const { job } = await submitJob(store, { subject: "https://example.com/c", limits: LIMITS });
  await startJob(store, job.id, { limits: LIMITS });
  await failJob(store, job.id, {
    reading: "The model endpoint failed. THIS IS AN OUTAGE OF THIS SERVICE, NOT A FACT ABOUT THE SUBJECT.",
    report: { findingCount: 1 },
    limits: LIMITS,
  });
  const polled = await readJob(store, job.id, { limits: LIMITS });
  assert.equal(polled.job.status, JOB_STATUS.failed);
  assert.equal(polled.job.report.findingCount, 1, "evidence really gathered must not be thrown away because the run did not finish");
  assert.match(polled.job.reading, /NOT A FACT ABOUT THE SUBJECT/);
});

/* --------------------------------- idempotency --------------------------------- */

test("a retry of the same subject returns the SAME job rather than starting a second one", async () => {
  const store = createMemoryStore();
  const first = await submitJob(store, { subject: "https://example.com/x", limits: LIMITS });
  const retry = await submitJob(store, { subject: "https://example.com/x/", limits: LIMITS });
  assert.equal(retry.ok, true);
  assert.equal(retry.deduped, true, "a retry that started a second investigation would read the same third party twice");
  assert.equal(retry.job.id, first.job.id);
});

test("an explicit idempotencyKey makes a deliberate re-run a different job", async () => {
  const store = createMemoryStore();
  const a = await submitJob(store, { subject: "https://example.com/y", limits: LIMITS });
  const b = await submitJob(store, { subject: "https://example.com/y", idempotencyKey: "second-look", limits: LIMITS });
  assert.equal(b.deduped, false);
  assert.notEqual(b.job.id, a.job.id);
});

test("the idempotency hash is stable across trivial differences and sensitive to real ones", () => {
  assert.equal(idempotencyHash({ subject: "https://A.example.com/" }), idempotencyHash({ subject: " https://a.example.com " }));
  assert.notEqual(idempotencyHash({ subject: "https://a.example.com/" }), idempotencyHash({ subject: "https://b.example.com/" }));
  assert.notEqual(idempotencyHash({ subject: "https://a.example.com/" }), idempotencyHash({ subject: "https://a.example.com/", idempotencyKey: "k" }));
});

/* ------------------------------- the store failing ------------------------------- */

test("a submission that cannot be RECORDED is refused, not started", async () => {
  const broken = { ...createMemoryStore(), increment: async () => { throw new Error("redis unreachable"); } };
  const out = await submitJob(broken, { subject: "https://example.com/z", limits: LIMITS });
  assert.equal(out.ok, false);
  assert.match(out.refusal, /redis unreachable/);
  assert.match(out.refusal, /a job nobody can poll is a job that has silently failed/i);
});

test("a store that will not answer a poll is an outage HERE, and says so", async () => {
  const broken = { ...createMemoryStore(), get: async () => { throw new Error("timeout"); } };
  const out = await readJob(broken, "anything", { limits: LIMITS });
  assert.equal(out.ok, false);
  assert.match(out.refusal, /says nothing about whether the job ran/);
});

test("the key namespace is stable — a rename would orphan every job in flight", () => {
  assert.equal(jobKey("abc"), "research:job:v1:abc");
});
