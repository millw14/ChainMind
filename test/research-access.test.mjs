// Tests for WHO MAY START A DEEP INVESTIGATION — lib/research-access.js.
//
// Two things are being pinned down, and they pull in opposite directions:
//
//   1. A JOB IS NOT A QUESTION. It costs minutes, up to 320,000 model tokens and up to
//      12MB fetched from third parties who agreed to none of it, so it is metered on its
//      OWN ledger, requires a session, and is capped even for a verified holder.
//   2. THE LEDGER IS NEVER READ AS A VERDICT. A counter that cannot be read is `degraded`
//      and not "spent"; a charge that cannot be recorded falls back to a per-process
//      floor and says so, rather than silently becoming unlimited or refusing the feature.
//
// Fully offline: the store is lib/store.js's in-memory adapter and nothing here opens a
// socket. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RESEARCH_ACCESS,
  RESEARCH_TIER,
  chargeResearchJob,
  publicResearchAccess,
  researchAllowance,
  researchQuotaKey,
  resolveResearchAccess,
} from "../lib/research-access.js";
import { createMemoryStore } from "../lib/store.js";
import { createSessionCookie } from "../lib/session.js";
import { utcDayKey } from "../lib/quota.js";

const SECRET = "test-secret-that-is-long-enough-to-be-allowed";
const ADDRESS = "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB";

/** Run a body with a controlled set of env vars, restoring whatever was there. */
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

/** Silence the deliberate operator-facing errors while asserting on their effect. */
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

const signedIn = () => createSessionCookie(ADDRESS).value;

/* -------------------------------- allowances -------------------------------- */

test("the two tiers have different numbers, and a holder still has one", () => {
  assert.equal(researchAllowance(RESEARCH_TIER.SIGNED_IN, {}), 1);
  assert.equal(researchAllowance(RESEARCH_TIER.HOLDER, {}), 5);
  assert.ok(researchAllowance(RESEARCH_TIER.HOLDER, {}) > researchAllowance(RESEARCH_TIER.SIGNED_IN, {}));
  // Not Infinity, not null, not absent: a number. Somebody else's bandwidth is what is
  // being spent, and no token balance is their consent to spend it.
  assert.equal(Number.isFinite(researchAllowance(RESEARCH_TIER.HOLDER, {})), true);
});

test("zero is meaningful and is preserved; nonsense falls back to the default", () => {
  assert.equal(researchAllowance(RESEARCH_TIER.SIGNED_IN, { RESEARCH_DAILY_JOBS: "0" }), 0);
  assert.equal(researchAllowance(RESEARCH_TIER.HOLDER, { RESEARCH_HOLDER_DAILY_JOBS: "12" }), 12);
  assert.equal(researchAllowance(RESEARCH_TIER.SIGNED_IN, { RESEARCH_DAILY_JOBS: "banana" }), 1);
  assert.equal(researchAllowance(RESEARCH_TIER.SIGNED_IN, { RESEARCH_DAILY_JOBS: "-3" }), 1);
});

test("the counter key is per wallet per UTC day, and there is no IP branch at all", () => {
  const key = researchQuotaKey(ADDRESS, Date.parse("2026-07-30T11:00:00Z"));
  assert.equal(key, `research:${utcDayKey(Date.parse("2026-07-30T11:00:00Z"))}:addr:${ADDRESS.toLowerCase()}`);
});

/* ----------------------------------- gate ----------------------------------- */

test("anonymous is refused, and the refusal says what would change it", async () => {
  await withEnv({ SESSION_SECRET: SECRET, GATE_TOKEN_ADDRESS: null }, async () => {
    const access = await resolveResearchAccess({ store: createMemoryStore(), ip: "203.0.113.9" });
    assert.equal(access.state, RESEARCH_ACCESS.ANONYMOUS);
    assert.equal(access.allowed, false);
    assert.equal(access.address, null);
    assert.match(access.message, /sign/i);
    // The one thing a visitor being asked to connect a wallet has to be told.
    assert.match(access.message, /cannot move funds/i);
  });
});

test("a signed-in caller is allowed, and asking does not spend anything", async () => {
  await withEnv({ SESSION_SECRET: SECRET, GATE_TOKEN_ADDRESS: null, RESEARCH_DAILY_JOBS: "2" }, async () => {
    const store = createMemoryStore();
    const cookie = signedIn();

    const first = await resolveResearchAccess({ store, sessionCookie: cookie });
    assert.equal(first.state, RESEARCH_ACCESS.ALLOWED);
    assert.equal(first.limit, 2);
    assert.equal(first.used, 0);
    assert.equal(first.remaining, 2);

    // Peeking twice more must still leave two: a read is a read.
    await resolveResearchAccess({ store, sessionCookie: cookie });
    const third = await resolveResearchAccess({ store, sessionCookie: cookie });
    assert.equal(third.remaining, 2);
  });
});

test("spending the allowance closes it, and the message says when it comes back", async () => {
  await withEnv({ SESSION_SECRET: SECRET, GATE_TOKEN_ADDRESS: null, RESEARCH_DAILY_JOBS: "1" }, async () => {
    const store = createMemoryStore();
    const cookie = signedIn();

    const before = await resolveResearchAccess({ store, sessionCookie: cookie });
    assert.equal(before.allowed, true);

    const charged = await chargeResearchJob({ store, address: ADDRESS, limit: before.limit });
    assert.equal(charged.used, 1);
    assert.equal(charged.remaining, 0);
    assert.equal(charged.degraded, false);

    const after = await resolveResearchAccess({ store, sessionCookie: cookie });
    assert.equal(after.state, RESEARCH_ACCESS.SPENT);
    assert.equal(after.allowed, false);
    assert.match(after.message, /00:00 UTC/);
  });
});

test("an allowance of zero switches the tier off without pretending it is spent", async () => {
  await withEnv({ SESSION_SECRET: SECRET, GATE_TOKEN_ADDRESS: null, RESEARCH_DAILY_JOBS: "0" }, async () => {
    const access = await resolveResearchAccess({ store: createMemoryStore(), sessionCookie: signedIn() });
    assert.equal(access.state, RESEARCH_ACCESS.DISABLED);
    assert.equal(access.allowed, false);
    assert.equal(access.limit, 0);
  });
});

test("an unreadable counter is UNKNOWN, not zero and not spent", async () => {
  await withEnv({ SESSION_SECRET: SECRET, GATE_TOKEN_ADDRESS: null, RESEARCH_DAILY_JOBS: "1" }, async () => {
    const store = {
      ...createMemoryStore(),
      counter: async () => {
        throw new Error("the store is down");
      },
    };
    const access = await quiet(() => resolveResearchAccess({ store, sessionCookie: signedIn() }));
    assert.equal(access.degraded, true);
    assert.equal(access.remaining, null); // NOT 0
    assert.equal(access.allowed, true); // an outage of ours does not take the feature away
  });
});

test("a charge that cannot be recorded falls back to a floor and reports it", async () => {
  const charged = await quiet(() => chargeResearchJob({ store: { increment: null }, address: ADDRESS, limit: 1 }));
  assert.equal(charged.degraded, true);
  assert.equal(Number.isFinite(charged.used), true);
});

test("the public view carries the standing and not the wallet", async () => {
  await withEnv({ SESSION_SECRET: SECRET, GATE_TOKEN_ADDRESS: null }, async () => {
    const access = await resolveResearchAccess({ store: createMemoryStore(), sessionCookie: signedIn() });
    const view = publicResearchAccess(access);
    assert.equal(view.state, RESEARCH_ACCESS.ALLOWED);
    assert.equal("address" in view, false);
    assert.equal("entitlement" in view, false);
  });
});
