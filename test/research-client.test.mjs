// Tests for THE APP'S SIDE OF THE RESEARCH SERVICE — lib/research-client.js.
//
// The rule under test is the one a job queue makes easy to break: THREE DIFFERENT
// NOTHINGS MUST STAY APART. "This deployment has no research service", "the service did
// not answer" and "the investigation found nothing" are three unrelated facts, and only
// the last one is about the subject at all. A poll that reported an outage as a failed job
// would put our downtime in a report about somebody's project.
//
// Fully offline: the transport is injected, so nothing here opens a socket.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RESEARCH_TRANSPORT,
  pollResearch,
  researchConfigured,
  researchServiceStatus,
  screenSubject,
  submitResearch,
} from "../lib/research-client.js";

const ENV = Object.freeze({
  RESEARCH_SERVICE_URL: "https://research.example.com",
  RESEARCH_SHARED_SECRET: "s".repeat(40),
});

const JOB_ID = "1f0cabc-2222-4444";

/** A stand-in service that answers with whatever a test needs, capturing the call. */
function serviceReturning(body, { status = 200, capture = null } = {}) {
  return async (url, init) => {
    if (capture) {
      capture.url = url;
      capture.init = init;
      capture.body = init?.body ? JSON.parse(init.body) : null;
    }
    return { status, json: async () => body };
  };
}

/** The shape the service actually returns for an accepted submission. */
function accepted(overrides = {}) {
  return {
    ok: true,
    status: "queued",
    deduped: false,
    id: JOB_ID,
    poll: `/research/${JOB_ID}`,
    subject: { given: "https://example.com/", kind: "url" },
    wallMs: 420_000,
    reading: "Queued. Poll the URL above; a report takes minutes, not seconds.",
    ...overrides,
  };
}

/* ------------------------------- configuration ------------------------------ */

test("configured means BOTH halves; one alone is not a deployment that can research", () => {
  assert.equal(researchConfigured({}), false);
  assert.equal(researchConfigured({ RESEARCH_SERVICE_URL: "https://x.example" }), false);
  assert.equal(researchConfigured({ RESEARCH_SHARED_SECRET: "x" }), false);
  assert.equal(researchConfigured(ENV), true);
});

test("a REJECTED setting is reported differently from an ABSENT one", () => {
  const absent = researchServiceStatus({});
  assert.equal(absent.configured, false);
  assert.equal(absent.problem, null);
  assert.match(absent.missing, /RESEARCH_SERVICE_URL/);

  const metadata = researchServiceStatus({ RESEARCH_SERVICE_URL: "http://169.254.169.254", RESEARCH_SHARED_SECRET: "s" });
  assert.equal(metadata.configured, false);
  assert.match(metadata.problem, /metadata/i);
});

/* -------------------------------- the subject ------------------------------- */

test("a subject is one URL or one address, screened through the app's own boundary", () => {
  assert.deepEqual(screenSubject("0x664f813ba5568966b8c7aaa03ef2218658a57777"), {
    ok: true,
    kind: "address",
    subject: "0x664f813ba5568966b8c7aaa03ef2218658a57777",
  });

  const url = screenSubject("https://csl.fun/");
  assert.equal(url.ok, true);
  assert.equal(url.kind, "url");

  // The SSRF ladder is lib/safe-fetch.js's and is not re-implemented here; these assert
  // that it is actually consulted rather than that it works.
  assert.equal(screenSubject("http://127.0.0.1:8080/").ok, false);
  assert.equal(screenSubject("http://169.254.169.254/latest/meta-data/").ok, false);
  assert.equal(screenSubject("ftp://example.com/x").ok, false);
  assert.equal(screenSubject("").ok, false);
  assert.equal(screenSubject(`https://example.com/${"a".repeat(400)}`).ok, false);
});

test("a refused subject costs nothing: the service is never contacted", async () => {
  let called = false;
  const res = await submitResearch("http://127.0.0.1/", {
    env: ENV,
    fetcher: async () => {
      called = true;
      return { status: 200, json: async () => ({}) };
    },
  });
  assert.equal(called, false);
  assert.equal(res.state, RESEARCH_TRANSPORT.REFUSED_SUBJECT);
  assert.match(res.reading, /NOTHING WAS INVESTIGATED/);
});

/* --------------------------------- submitting ------------------------------- */

test("an unconfigured deployment says so about ITSELF, and never about the subject", async () => {
  const res = await submitResearch("https://example.com/", { env: {}, fetcher: async () => assert.fail("must not be called") });
  assert.equal(res.state, RESEARCH_TRANSPORT.NOT_CONFIGURED);
  assert.match(res.reading, /THIS DEPLOYMENT/);
  assert.match(res.reading, /nothing at all about the subject/i);
  assert.equal(res.ok, false);
});

test("a configured-but-rejected URL is misconfigured, not missing", async () => {
  const res = await submitResearch("https://example.com/", {
    env: { RESEARCH_SERVICE_URL: "not a url", RESEARCH_SHARED_SECRET: "s".repeat(40) },
  });
  assert.equal(res.state, RESEARCH_TRANSPORT.MISCONFIGURED);
  assert.match(res.reading, /misconfigured/i);
});

test("a queued job comes back with an id, our own poll path, and the secret was sent", async () => {
  const capture = {};
  const res = await submitResearch("https://example.com/", {
    env: ENV,
    fetcher: serviceReturning(accepted(), { status: 202, capture }),
    requestedBy: "chainmind:0xabc",
  });

  assert.equal(res.ok, true);
  assert.equal(res.id, JOB_ID);
  assert.equal(res.state, "queued");
  assert.equal(res.deduped, false);
  // The poll path is OURS, built here — never the `poll` field out of the response body,
  // which is a path chosen by whatever answered.
  assert.equal(res.pollPath, `/api/research/${JOB_ID}`);
  assert.equal(res.reportPath, `/research/${JOB_ID}`);
  assert.equal(capture.url, "https://research.example.com/research");
  assert.equal(capture.init.headers.authorization, `Bearer ${ENV.RESEARCH_SHARED_SECRET}`);
  assert.equal(capture.body.subject, "https://example.com/");
  assert.equal(capture.body.requestedBy, "chainmind:0xabc");
  // No idempotency key by default: the service dedupes by subject, so one third party is
  // not read twice for one question asked twice.
  assert.equal(capture.body.idempotencyKey, undefined);
});

test("deduped travels, because being handed an earlier run is part of the answer", async () => {
  const res = await submitResearch("https://example.com/", {
    env: ENV,
    fetcher: serviceReturning(accepted({ deduped: true }), { status: 202 }),
  });
  assert.equal(res.deduped, true);
  assert.match(res.reading, /already submitted/i);
});

test("at capacity is its own state and says nothing was investigated", async () => {
  const res = await submitResearch("https://example.com/", {
    env: ENV,
    fetcher: serviceReturning({ ok: false, status: "at_capacity", reading: "This service already has 24 job(s) waiting." }, { status: 503 }),
  });
  assert.equal(res.state, RESEARCH_TRANSPORT.AT_CAPACITY);
  assert.equal(res.ok, false);
});

test("a body that is not the contract is an outage, not a job id to poll forever", async () => {
  const res = await submitResearch("https://example.com/", {
    env: ENV,
    fetcher: serviceReturning("<html>502 Bad Gateway</html>", { status: 200 }),
  });
  assert.equal(res.state, RESEARCH_TRANSPORT.UNREACHABLE);
  assert.equal(res.id, undefined);
});

test("a refusal from the service is a rejection, and the HTTP status travels", async () => {
  const res = await submitResearch("https://example.com/", {
    env: ENV,
    fetcher: serviceReturning({ ok: false, status: "unauthorized" }, { status: 401 }),
  });
  assert.equal(res.state, RESEARCH_TRANSPORT.REJECTED);
  assert.equal(res.httpStatus, 401);
});

test("a transport failure is ours, and says so in the sentence a reader sees", async () => {
  const res = await submitResearch("https://example.com/", {
    env: ENV,
    fetcher: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(res.state, RESEARCH_TRANSPORT.UNREACHABLE);
  assert.match(res.reading, /OUR OWN INFRASTRUCTURE/);
  assert.match(res.reading, /NOT A FACT ABOUT THE SUBJECT/);
});

/* ---------------------------------- polling --------------------------------- */

test("an id that is not id-shaped never reaches a URL path", async () => {
  const res = await pollResearch("../../healthz", { env: ENV, fetcher: async () => assert.fail("must not be called") });
  assert.equal(res.state, RESEARCH_TRANSPORT.UNKNOWN_JOB);
});

test("a finished job hands back its report with the status beside it", async () => {
  const capture = {};
  const res = await pollResearch(JOB_ID, {
    env: ENV,
    fetcher: serviceReturning(
      {
        ok: true,
        id: JOB_ID,
        status: "done",
        terminal: true,
        reading: "Concluded.",
        report: { schema: "chainmind-research-report/v1", findingCount: 4 },
        progress: { step: 9, findings: 4 },
      },
      { capture },
    ),
  });

  assert.equal(capture.url, `https://research.example.com/research/${JOB_ID}`);
  assert.equal(capture.init.method, "GET");
  assert.equal(res.state, "done");
  assert.equal(res.terminal, true);
  assert.equal(res.report.findingCount, 4);
});

test("a FAILED job still carries the partial report it really gathered", async () => {
  const res = await pollResearch(JOB_ID, {
    env: ENV,
    fetcher: serviceReturning({
      ok: true,
      id: JOB_ID,
      status: "failed",
      terminal: true,
      reading: "The model was unreachable.",
      report: { schema: "chainmind-research-report/v1", findingCount: 1 },
    }),
  });
  assert.equal(res.state, "failed");
  assert.equal(res.report.findingCount, 1);
});

test("a service that does not answer is NOT a failed job and NOT terminal", async () => {
  const res = await pollResearch(JOB_ID, {
    env: ENV,
    fetcher: async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    },
  });
  assert.equal(res.state, RESEARCH_TRANSPORT.UNREACHABLE);
  assert.equal(res.terminal, false);
  assert.match(res.reading, /MAY WELL STILL BE RUNNING/);
});

test("a 404 is a record that aged out, said as such rather than as a failure", async () => {
  const res = await pollResearch(JOB_ID, { env: ENV, fetcher: serviceReturning({ ok: false }, { status: 404 }) });
  assert.equal(res.state, RESEARCH_TRANSPORT.UNKNOWN_JOB);
  assert.match(res.reading, /does not mean the investigation failed/i);
});

test("polling an unconfigured deployment reports the deployment, not the job", async () => {
  const res = await pollResearch(JOB_ID, { env: {}, fetcher: async () => assert.fail("must not be called") });
  assert.equal(res.state, RESEARCH_TRANSPORT.NOT_CONFIGURED);
  assert.equal(res.terminal, false);
});
