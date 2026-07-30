// Tests for THE WHOLE APP-SIDE LIFECYCLE of a deep investigation — lib/research-job.js.
//
// Submit, poll, collect; who may; who may read it back; and every way it does not happen.
// Four properties are being pinned down, and each one is a bug this feature would
// otherwise ship with:
//
//   1. AN UNCONFIGURED DEPLOYMENT BEHAVES EXACTLY AS IT DID BEFORE and says so. No queue,
//      no charge, no sign-in prompt for a button that could never work.
//   2. NOTHING IS CHARGED FOR A JOB THAT DID NOT START. A service outage must not take a
//      day's allowance from somebody who got no investigation.
//   3. A REPORT IS NOT PUBLIC. A job id is a capability; the report is about identifiable
//      people, and only the wallet that started one can read it.
//   4. THE JOB'S OWN OUTCOME AND OUR ABILITY TO REACH IT ARE DIFFERENT FACTS, all the way
//      out to the sentence a reader sees.
//
// Fully offline: injected store, injected transport. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { RESEARCH_JOB, publicResearchBlock, readResearch, researchForAsk, startResearch } from "../lib/research-job.js";
import { createMemoryStore } from "../lib/store.js";
import { createSessionCookie } from "../lib/session.js";
import { researchQuotaKey } from "../lib/research-access.js";

const SECRET = "test-secret-that-is-long-enough-to-be-allowed";
const ADDRESS = "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB";
const OTHER = "0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046";
const JOB_ID = "1f0cabc-2222-4444";

const ENV = Object.freeze({
  RESEARCH_SERVICE_URL: "https://research.example.com",
  RESEARCH_SHARED_SECRET: "s".repeat(40),
  RESEARCH_DAILY_JOBS: "1",
});

async function withEnv(vars, body) {
  const previous = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await body();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function quiet(body) {
  const { warn, error } = console;
  console.warn = () => {};
  console.error = () => {};
  try {
    return await body();
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

/** Sign in as a wallet. The gate is deliberately unconfigured, so this is the free tier. */
const session = (address = ADDRESS) => createSessionCookie(address).value;

/** A service that accepts every submission and answers every poll from a script. */
function fakeService({ submit = null, poll = null, onSubmit = null } = {}) {
  return async (url, init) => {
    if (init?.method === "GET") {
      return { status: poll?.status ?? 200, json: async () => poll?.body ?? {} };
    }
    if (onSubmit) onSubmit(JSON.parse(init.body));
    return {
      status: submit?.status ?? 202,
      json: async () =>
        submit?.body ?? {
          ok: true,
          status: "queued",
          deduped: false,
          id: JOB_ID,
          subject: { given: "https://csl.fun/", kind: "url" },
          wallMs: 420_000,
          reading: "Queued.",
        },
    };
  };
}

/** How many jobs the ledger says this wallet has spent today. */
async function spent(store, address = ADDRESS) {
  const row = await store.counter(researchQuotaKey(address));
  return row ? row.value : 0;
}

/* ------------------------- not configured is a state ------------------------ */

test("with no research service, nothing is queued, nothing is charged, and it says why", async () => {
  await withEnv({ SESSION_SECRET: SECRET, GATE_TOKEN_ADDRESS: null }, async () => {
    const store = createMemoryStore();
    const res = await startResearch({
      subject: "https://csl.fun/",
      sessionCookie: session(),
      store,
      env: {},
      fetcher: async () => assert.fail("the service must not be contacted"),
    });

    assert.equal(res.state, RESEARCH_JOB.NOT_CONFIGURED);
    assert.match(res.reading, /THIS INSTALLATION/);
    assert.match(res.reading, /nothing about the subject/i);
    assert.equal(await spent(store), 0);
    assert.equal(res.id, null);
  });
});

test("an unconfigured deployment does not ask anybody to sign in first", async () => {
  await withEnv({ SESSION_SECRET: SECRET, GATE_TOKEN_ADDRESS: null }, async () => {
    // Anonymous AND unconfigured: the answer must be the deployment's limit, because
    // connecting a wallet would not help and saying so would be a lie of omission.
    const res = await startResearch({ subject: "https://csl.fun/", store: createMemoryStore(), env: {} });
    assert.equal(res.state, RESEARCH_JOB.NOT_CONFIGURED);
  });
});

/* ---------------------------------- the gate -------------------------------- */

test("anonymous cannot start one, and the service is never contacted", async () => {
  await withEnv({ SESSION_SECRET: SECRET, GATE_TOKEN_ADDRESS: null }, async () => {
    const res = await startResearch({
      subject: "https://csl.fun/",
      store: createMemoryStore(),
      env: ENV,
      fetcher: async () => assert.fail("the service must not be contacted"),
    });
    assert.equal(res.state, RESEARCH_JOB.NEEDS_SIGN_IN);
  });
});

test("a subject that is not a subject is refused before the gate is even spent", async () => {
  await withEnv({ SESSION_SECRET: SECRET, GATE_TOKEN_ADDRESS: null }, async () => {
    const store = createMemoryStore();
    const res = await startResearch({
      subject: "http://127.0.0.1:9000/admin",
      sessionCookie: session(),
      store,
      env: ENV,
      fetcher: async () => assert.fail("the service must not be contacted"),
    });
    assert.equal(res.state, RESEARCH_JOB.REFUSED_SUBJECT);
    assert.equal(await spent(store), 0);
  });
});

/* --------------------------------- the happy ------------------------------- */

test("a started job is recorded, charged once, and the second one is refused", async () => {
  await withEnv({ SESSION_SECRET: SECRET, GATE_TOKEN_ADDRESS: null }, async () => {
    const store = createMemoryStore();
    const sent = [];
    const fetcher = fakeService({ onSubmit: (b) => sent.push(b) });

    const first = await startResearch({ subject: "https://csl.fun/", sessionCookie: session(), store, env: ENV, fetcher });
    assert.equal(first.state, RESEARCH_JOB.STARTED);
    assert.equal(first.id, JOB_ID);
    assert.equal(first.reportPath, `/research/${JOB_ID}`);
    assert.equal(first.ownerRecorded, true);
    assert.equal(await spent(store), 1);
    assert.equal(sent.length, 1);
    // The service learns a shortened address and nothing else about the caller.
    assert.match(sent[0].requestedBy, /^chainmind:0x/);
    assert.equal(sent[0].requestedBy.length <= 22, true);

    const second = await startResearch({ subject: "https://example.com/", sessionCookie: session(), store, env: ENV, fetcher });
    assert.equal(second.state, RESEARCH_JOB.OUT_OF_ALLOWANCE);
    assert.equal(await spent(store), 1);
    assert.equal(sent.length, 1); // the second one never reached the service
  });
});

test("a job that could not be started costs nothing", async () => {
  await withEnv({ SESSION_SECRET: SECRET, GATE_TOKEN_ADDRESS: null }, async () => {
    const store = createMemoryStore();
    const res = await startResearch({
      subject: "https://csl.fun/",
      sessionCookie: session(),
      store,
      env: ENV,
      fetcher: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    assert.equal(res.state, RESEARCH_JOB.UNAVAILABLE);
    assert.equal(await spent(store), 0);

    // And the allowance is still there afterwards.
    const retry = await startResearch({ subject: "https://csl.fun/", sessionCookie: session(), store, env: ENV, fetcher: fakeService() });
    assert.equal(retry.state, RESEARCH_JOB.STARTED);
  });
});

test("the service being at capacity is its own state and also costs nothing", async () => {
  await withEnv({ SESSION_SECRET: SECRET, GATE_TOKEN_ADDRESS: null }, async () => {
    const store = createMemoryStore();
    const res = await startResearch({
      subject: "https://csl.fun/",
      sessionCookie: session(),
      store,
      env: ENV,
      fetcher: fakeService({ submit: { status: 503, body: { ok: false, status: "at_capacity", reading: "Full." } } }),
    });
    assert.equal(res.state, RESEARCH_JOB.AT_CAPACITY);
    assert.equal(await spent(store), 0);
  });
});

/* --------------------------------- reading back ----------------------------- */

test("only the wallet that started a job can read it, and a stranger learns nothing", async () => {
  await withEnv({ SESSION_SECRET: SECRET, GATE_TOKEN_ADDRESS: null }, async () => {
    const store = createMemoryStore();
    const fetcher = fakeService({
      poll: { body: { ok: true, id: JOB_ID, status: "done", terminal: true, reading: "Concluded.", report: { findingCount: 3 } } },
    });

    await startResearch({ subject: "https://csl.fun/", sessionCookie: session(), store, env: ENV, fetcher });

    const owner = await readResearch({ id: JOB_ID, sessionCookie: session(), store, env: ENV, fetcher });
    assert.equal(owner.state, "job");
    assert.equal(owner.job.report.findingCount, 3);

    const stranger = await readResearch({ id: JOB_ID, sessionCookie: session(OTHER), store, env: ENV, fetcher });
    assert.equal(stranger.state, RESEARCH_JOB.NOT_YOURS);
    assert.equal(stranger.job, null);

    const anonymous = await readResearch({ id: JOB_ID, store, env: ENV, fetcher });
    assert.equal(anonymous.state, RESEARCH_JOB.NEEDS_SIGN_IN);
    assert.equal(anonymous.job, null);
  });
});

test("a failed job hands over its partial report, with the status that stops it reading as complete", async () => {
  await withEnv({ SESSION_SECRET: SECRET, GATE_TOKEN_ADDRESS: null }, async () => {
    const store = createMemoryStore();
    const submitter = fakeService();
    await startResearch({ subject: "https://csl.fun/", sessionCookie: session(), store, env: ENV, fetcher: submitter });

    const failed = fakeService({
      poll: {
        body: {
          ok: true,
          id: JOB_ID,
          status: "failed",
          terminal: true,
          reading: "The model was unreachable after 3 steps.",
          report: { findingCount: 1, caps: { hit: [] } },
        },
      },
    });
    const got = await readResearch({ id: JOB_ID, sessionCookie: session(), store, env: ENV, fetcher: failed });
    assert.equal(got.state, "job");
    assert.equal(got.job.state, "failed");
    assert.equal(got.job.report.findingCount, 1);
    assert.equal(got.terminal, true);
  });
});

test("a job that hit a cap comes back with the cap named, not as a finished answer", async () => {
  await withEnv({ SESSION_SECRET: SECRET, GATE_TOKEN_ADDRESS: null }, async () => {
    const store = createMemoryStore();
    await startResearch({ subject: "https://csl.fun/", sessionCookie: session(), store, env: ENV, fetcher: fakeService() });

    const capped = fakeService({
      poll: {
        body: {
          ok: true,
          id: JOB_ID,
          status: "done",
          terminal: true,
          reading: "Stopped at a cap.",
          report: {
            findingCount: 2,
            caps: {
              steps: { used: 14, cap: 14, capped: true },
              hit: [{ resource: "steps", used: 14, cap: 14, reading: "The loop reached its step cap." }],
              reading: "THIS INVESTIGATION STOPPED AT A CAP, NOT AT AN ANSWER.",
            },
          },
        },
      },
    });
    const got = await readResearch({ id: JOB_ID, sessionCookie: session(), store, env: ENV, fetcher: capped });
    assert.equal(got.job.report.caps.hit[0].resource, "steps");
    assert.match(got.job.report.caps.reading, /STOPPED AT A CAP/);
  });
});

test("a service we cannot reach is not a lost job: the caller is told to keep waiting", async () => {
  await withEnv({ SESSION_SECRET: SECRET, GATE_TOKEN_ADDRESS: null }, async () => {
    const store = createMemoryStore();
    await startResearch({ subject: "https://csl.fun/", sessionCookie: session(), store, env: ENV, fetcher: fakeService() });

    const got = await readResearch({
      id: JOB_ID,
      sessionCookie: session(),
      store,
      env: ENV,
      fetcher: async () => {
        throw new Error("ETIMEDOUT");
      },
    });
    assert.equal(got.state, RESEARCH_JOB.UNAVAILABLE);
    assert.equal(got.terminal, false);
    assert.match(got.reading, /outage of our own infrastructure/i);
  });
});

test("a store that will not answer is not permission", async () => {
  await withEnv({ SESSION_SECRET: SECRET, GATE_TOKEN_ADDRESS: null }, async () => {
    const store = {
      ...createMemoryStore(),
      get: async () => {
        throw new Error("the store is down");
      },
    };
    const got = await quiet(() =>
      readResearch({ id: JOB_ID, sessionCookie: session(), store, env: ENV, fetcher: fakeService() }),
    );
    assert.equal(got.state, RESEARCH_JOB.NOT_YOURS);
  });
});

/* --------------------------------- the ask path ----------------------------- */

test("an ordinary question starts nothing at all", async () => {
  await withEnv({ SESSION_SECRET: SECRET, GATE_TOKEN_ADDRESS: null }, async () => {
    const res = await researchForAsk({
      question: "how is nvda doing today",
      sessionCookie: session(),
      store: createMemoryStore(),
      env: ENV,
      fetcher: async () => assert.fail("the service must not be contacted"),
    });
    assert.equal(res.wanted, false);
    assert.equal(res.state, RESEARCH_JOB.NOT_WANTED);
    assert.equal(publicResearchBlock(res), null);
  });
});

test("a question asking for diligence on a URL starts a job and says why", async () => {
  await withEnv({ SESSION_SECRET: SECRET, GATE_TOKEN_ADDRESS: null }, async () => {
    const store = createMemoryStore();
    const res = await researchForAsk({
      question: "can you do full diligence on https://csl.fun please",
      sessionCookie: session(),
      store,
      env: ENV,
      fetcher: fakeService(),
    });
    assert.equal(res.wanted, true);
    assert.equal(res.state, RESEARCH_JOB.STARTED);

    const view = publicResearchBlock(res);
    assert.equal(view.state, RESEARCH_JOB.STARTED);
    assert.equal(view.reportPath, `/research/${JOB_ID}`);
    assert.ok(view.matched.length > 0); // the reader can see what was read as the request
    assert.equal("id" in view, true);
  });
});

test("a diligence request naming no URL is refused, and says a name is not a subject", async () => {
  await withEnv({ SESSION_SECRET: SECRET, GATE_TOKEN_ADDRESS: null }, async () => {
    const res = await researchForAsk({
      question: "please do a deep dive on the covenant project",
      sessionCookie: session(),
      store: createMemoryStore(),
      env: ENV,
      fetcher: async () => assert.fail("the service must not be contacted"),
    });
    assert.equal(res.wanted, true);
    assert.equal(res.state, RESEARCH_JOB.REFUSED_SUBJECT);
    assert.match(res.reading, /by name/i);
  });
});

test("the ask path never blocks: a dead service returns a block, not a throw", async () => {
  await withEnv({ SESSION_SECRET: SECRET, GATE_TOKEN_ADDRESS: null }, async () => {
    const res = await researchForAsk({
      question: "investigate https://csl.fun properly",
      sessionCookie: session(),
      store: createMemoryStore(),
      env: ENV,
      fetcher: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    assert.equal(res.state, RESEARCH_JOB.UNAVAILABLE);
    assert.equal(typeof res.reading, "string");
    assert.ok(res.reading.length > 0);
  });
});
