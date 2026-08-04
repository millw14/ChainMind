// Tests for usage tracking (lib/usage.js): questions counted, searches fed back,
// and visitors de-duplicated per id and per day, all on the memory store. The
// interesting cases are the ones that must NOT double count. Run with: npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetStore } from "../lib/store.js";
import { recordSearch, recordVisit, readUsage, utcDay } from "../lib/usage.js";

// Force the memory adapter and a stable salt for the whole file.
process.env.STORE_DRIVER = "memory";
process.env.SESSION_SECRET = "usage-test-secret-that-is-long-enough";

const WALLET = "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB";
const ELLIPSIS = "…";

beforeEach(async () => {
  await resetStore(); // a fresh, empty memory store per test
});

test("a search increments questions and lands in the recent feed", async () => {
  await recordSearch({ question: "who holds the most PIPECAT", target: "0xabc", ip: "1.1.1.1" });
  const u = await readUsage();
  assert.equal(u.questions.total, 1);
  assert.equal(u.questions.today, 1);
  assert.equal(u.recent.length, 1);
  assert.equal(u.recent[0].q, "who holds the most PIPECAT");
  assert.equal(u.recent[0].target, "0xabc");
  assert.match(u.recent[0].who, /^ip#[0-9a-f]{8}$/); // IP never stored raw
  assert.ok(u.recent[0].at > 0);
});

test("the feed is newest-first", async () => {
  await recordSearch({ question: "first", ip: "1.1.1.1" });
  await recordSearch({ question: "second", ip: "1.1.1.1" });
  const u = await readUsage();
  assert.equal(u.recent[0].q, "second");
  assert.equal(u.recent[1].q, "first");
});

test("a signed-in wallet shows as a short address, not the full one", async () => {
  await recordSearch({ question: "hi", address: WALLET, ip: "1.1.1.1" });
  const u = await readUsage();
  assert.equal(u.recent[0].who, "0xa5aa" + ELLIPSIS + "1feb"); // first 6 . last 4, lowercased
  assert.ok(!u.recent[0].who.includes(WALLET.slice(6, -4))); // middle never shown
});

test("the same visitor counts once, no matter how many questions", async () => {
  await recordSearch({ question: "q1", ip: "5.5.5.5" });
  await recordSearch({ question: "q2", ip: "5.5.5.5" });
  await recordSearch({ question: "q3", ip: "5.5.5.5" });
  const u = await readUsage();
  assert.equal(u.questions.total, 3);
  assert.equal(u.visitors.total, 1); // three questions, one person
});

test("different visitors each count once", async () => {
  await recordVisit({ ip: "5.5.5.5" });
  await recordVisit({ ip: "6.6.6.6" });
  await recordVisit({ ip: "5.5.5.5" }); // repeat . must not add
  const u = await readUsage();
  assert.equal(u.visitors.total, 2);
  assert.equal(u.visitors.today, 2);
});

test("a wallet and an IP are distinct identities", async () => {
  await recordVisit({ address: WALLET, ip: "5.5.5.5" });
  await recordVisit({ ip: "5.5.5.5" });
  const u = await readUsage();
  assert.equal(u.visitors.total, 2);
});

test("readUsage returns a day series ending today, newest first", async () => {
  await recordSearch({ question: "q", ip: "1.1.1.1" });
  const u = await readUsage({ days: 7 });
  assert.equal(u.days.length, 7);
  assert.equal(u.days[0].day, utcDay());
  assert.equal(u.days[0].questions, 1);
  assert.equal(u.days[0].visitors, 1);
});

test("the memory store is reported as not durable", async () => {
  const u = await readUsage();
  assert.equal(u.configured, false);
  assert.equal(u.driver, "memory");
  assert.ok(u.warnings.length > 0);
});
