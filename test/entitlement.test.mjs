// Tests for the token gate's balance read (lib/entitlement.js). The cases that
// matter are the ones where the chain did NOT answer: an unreadable balance must
// come back as "could not verify" and never as "holds nothing", because the
// second is a claim about somebody's wallet that we were never told.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ENTITLEMENT,
  UNVERIFIED_REASON,
  checkEntitlement,
  clearEntitlementCache,
  gateConfig,
  gateStatus,
  isEntitled,
  setEntitlementClock,
} from "../lib/entitlement.js";

/** The token the gate is being tested against on chain 4663 (COVENANT, 18 dp). */
const TOKEN = "0xde358e0a0afe80c081121bc7e2bf8852fc6827d6";
const HOLDER = "0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb";

/** Run a body with a controlled set of env vars, restoring whatever was there. */
async function withEnv(vars, body) {
  const previous = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  clearEntitlementCache();
  try {
    return await body();
  } finally {
    clearEntitlementCache();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Silence the deliberate operator-facing warnings while asserting on them. */
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

/**
 * A stand-in for the app's RPC client. `checkEntitlement` takes one so a test can
 * decide what the chain said — including "nothing at all", which is the whole
 * point of this file.
 */
function fakeClient(answers) {
  const calls = [];
  return {
    calls,
    async readContract({ functionName }) {
      calls.push(functionName);
      const answer = answers[functionName];
      if (answer instanceof Error) throw answer;
      if (typeof answer === "function") return answer();
      return answer;
    },
  };
}

const OK = { decimals: 18, symbol: "COVENANT", balanceOf: 0n };

/* ------------------------------ the threshold ----------------------------- */

test("a threshold of 1000 means 1000 TOKENS, not 1000 wei", async () => {
  await withEnv({ GATE_TOKEN_ADDRESS: TOKEN, GATE_TOKEN_MIN: "1000" }, async () => {
    const justUnder = await checkEntitlement({
      address: HOLDER,
      client: fakeClient({ ...OK, balanceOf: 999n * 10n ** 18n }),
    });
    assert.equal(justUnder.state, ENTITLEMENT.BELOW);
    assert.equal(justUnder.thresholdRaw, (1000n * 10n ** 18n).toString());

    clearEntitlementCache();
    const exactly = await checkEntitlement({
      address: HOLDER,
      client: fakeClient({ ...OK, balanceOf: 1000n * 10n ** 18n }),
    });
    assert.equal(exactly.state, ENTITLEMENT.ENTITLED, "at the threshold is entitled, not above it");
    assert.equal(isEntitled(exactly), true);
  });
});

test("one wei short of the threshold is below it", async () => {
  await withEnv({ GATE_TOKEN_ADDRESS: TOKEN, GATE_TOKEN_MIN: "1000" }, async () => {
    const res = await checkEntitlement({
      address: HOLDER,
      client: fakeClient({ ...OK, balanceOf: 1000n * 10n ** 18n - 1n }),
    });
    assert.equal(res.state, ENTITLEMENT.BELOW);
  });
});

test("decimals are read from the contract, not assumed to be 18", async () => {
  // A 6-decimal token with a pinned decimals env: 1000 tokens is 1e9 base units,
  // and assuming 18 would put the bar a trillion times too high.
  await withEnv(
    { GATE_TOKEN_ADDRESS: TOKEN, GATE_TOKEN_MIN: "1000", GATE_TOKEN_DECIMALS: "6" },
    async () => {
      const res = await checkEntitlement({
        address: HOLDER,
        client: fakeClient({ decimals: 6, symbol: "USDX", balanceOf: 1_000_000_000n }),
      });
      assert.equal(res.state, ENTITLEMENT.ENTITLED);
      assert.equal(res.thresholdRaw, "1000000000");
      assert.equal(res.balanceTokens, "1000");
    },
  );
});

/* ------------------------- could not verify ≠ zero ------------------------ */

test("a failed balance read is UNVERIFIED, never below the threshold", async () => {
  await withEnv({ GATE_TOKEN_ADDRESS: TOKEN, GATE_TOKEN_MIN: "1000" }, async () => {
    await quiet(async () => {
      const res = await checkEntitlement({
        address: HOLDER,
        client: fakeClient({ ...OK, balanceOf: new Error("RPC timeout") }),
      });
      assert.equal(res.state, ENTITLEMENT.UNVERIFIED);
      assert.equal(res.reason, UNVERIFIED_REASON.READ_FAILED);
      assert.equal(res.balanceRaw, null, "an outage must not produce a balance");
      assert.equal(res.balanceTokens, null);
      assert.equal(isEntitled(res), false, "unverified is not entitled either");
    });
  });
});

test("a non-numeric balanceOf result is unverified — missing data is not zero", async () => {
  await withEnv({ GATE_TOKEN_ADDRESS: TOKEN, GATE_TOKEN_MIN: "1000" }, async () => {
    await quiet(async () => {
      const res = await checkEntitlement({
        address: HOLDER,
        client: fakeClient({ ...OK, balanceOf: null }),
      });
      assert.equal(res.state, ENTITLEMENT.UNVERIFIED);
      assert.equal(res.balanceRaw, null);
    });
  });
});

test("an unreadable decimals() is unverified rather than a guessed 18", async () => {
  await withEnv({ GATE_TOKEN_ADDRESS: TOKEN, GATE_TOKEN_MIN: "1000" }, async () => {
    await quiet(async () => {
      const res = await checkEntitlement({
        address: HOLDER,
        client: fakeClient({ decimals: new Error("reverted"), symbol: "X", balanceOf: 10n ** 30n }),
      });
      // The balance would have cleared the bar under an assumed 18. Guessing is
      // what this refuses to do.
      assert.equal(res.state, ENTITLEMENT.UNVERIFIED);
      assert.equal(res.reason, UNVERIFIED_REASON.READ_FAILED);
    });
  });
});

test("no configured token is unverified, and nobody is entitled by default", async () => {
  await withEnv({ GATE_TOKEN_ADDRESS: null, GATE_TOKEN_MIN: null }, async () => {
    const res = await checkEntitlement({ address: HOLDER, client: fakeClient(OK) });
    assert.equal(res.state, ENTITLEMENT.UNVERIFIED);
    assert.equal(res.reason, UNVERIFIED_REASON.NOT_CONFIGURED);
    assert.equal(gateStatus().configured, false);
  });
});

test("a malformed gate config fails closed and says so", async () => {
  await withEnv({ GATE_TOKEN_ADDRESS: "not-an-address" }, async () => {
    await quiet(async () => {
      assert.match(gateConfig().error ?? "", /GATE_TOKEN_ADDRESS/);
      const res = await checkEntitlement({ address: HOLDER, client: fakeClient(OK) });
      assert.equal(res.state, ENTITLEMENT.UNVERIFIED);
      assert.equal(res.reason, UNVERIFIED_REASON.BAD_CONFIG);
    });
  });
  await withEnv({ GATE_TOKEN_ADDRESS: TOKEN, GATE_TOKEN_MIN: "1e21" }, async () => {
    await quiet(async () => {
      const res = await checkEntitlement({ address: HOLDER, client: fakeClient(OK) });
      assert.equal(res.reason, UNVERIFIED_REASON.BAD_CONFIG, "a threshold must be a plain token count");
    });
  });
});

test("a claimed address that is not an address is unverified", async () => {
  await withEnv({ GATE_TOKEN_ADDRESS: TOKEN }, async () => {
    const res = await checkEntitlement({ address: "0xnope", client: fakeClient(OK) });
    assert.equal(res.state, ENTITLEMENT.UNVERIFIED);
    assert.equal(res.reason, UNVERIFIED_REASON.BAD_ADDRESS);
  });
});

/* --------------------------------- caching -------------------------------- */

test("a measured entitlement is cached for the TTL, then re-read", async () => {
  await withEnv({ GATE_TOKEN_ADDRESS: TOKEN, GATE_TOKEN_MIN: "1", GATE_CACHE_TTL_MS: "60000" }, async () => {
    let now = 1_000_000;
    const restore = setEntitlementClock(() => now);
    try {
      const client = fakeClient({ ...OK, balanceOf: 5n * 10n ** 18n });
      const first = await checkEntitlement({ address: HOLDER, client });
      assert.equal(first.state, ENTITLEMENT.ENTITLED);
      assert.equal(first.cached, false);

      const second = await checkEntitlement({ address: HOLDER, client });
      assert.equal(second.cached, true, "inside the TTL the chain is not asked again");
      assert.equal(client.calls.filter((c) => c === "balanceOf").length, 1);

      // A holder can sell right after signing in, which is why the entitlement
      // has a shelf life rather than lasting the session.
      now += 60_001;
      const third = await checkEntitlement({ address: HOLDER, client });
      assert.equal(third.cached, false);
      assert.equal(client.calls.filter((c) => c === "balanceOf").length, 2);
    } finally {
      restore();
    }
  });
});

test("a FAILED read is never cached — an outage must not stick", async () => {
  await withEnv({ GATE_TOKEN_ADDRESS: TOKEN, GATE_TOKEN_MIN: "1", GATE_CACHE_TTL_MS: "60000" }, async () => {
    await quiet(async () => {
      const failing = fakeClient({ ...OK, balanceOf: new Error("RPC down") });
      await checkEntitlement({ address: HOLDER, client: failing });
      await checkEntitlement({ address: HOLDER, client: failing });
      assert.equal(
        failing.calls.filter((c) => c === "balanceOf").length,
        2,
        "the second call must go back to the chain",
      );

      // And the moment the chain answers, the answer is the current one.
      const working = fakeClient({ ...OK, balanceOf: 9n * 10n ** 18n });
      const res = await checkEntitlement({ address: HOLDER, client: working });
      assert.equal(res.state, ENTITLEMENT.ENTITLED);
    });
  });
});

test("the cache is keyed per address — one holder's answer is not another's", async () => {
  await withEnv({ GATE_TOKEN_ADDRESS: TOKEN, GATE_TOKEN_MIN: "1000" }, async () => {
    const rich = await checkEntitlement({
      address: HOLDER,
      client: fakeClient({ ...OK, balanceOf: 5000n * 10n ** 18n }),
    });
    const poor = await checkEntitlement({
      address: "0x4783c67b63de2b358ac5951a7d41f47a38f3c046",
      client: fakeClient({ ...OK, balanceOf: 1n }),
    });
    assert.equal(rich.state, ENTITLEMENT.ENTITLED);
    assert.equal(poor.state, ENTITLEMENT.BELOW);
  });
});
