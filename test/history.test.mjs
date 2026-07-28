// Tests for saved history (lib/history.js). The cases that carry the weight are
// the cross-wallet ones: one address must never be able to READ or DELETE
// another's, and the id in a delete request is the only thing here that ever
// comes from a client. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearHistory,
  deleteHistoryEntry,
  historyKey,
  historyMaxItems,
  listHistory,
  saveHistoryEntry,
} from "../lib/history.js";
import { createMemoryStore } from "../lib/store.js";

const ALICE = "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB";
const BOB = "0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046";

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

/** One saved turn, with defaults, so the tests read as what they are about. */
function save(store, address, question, answer = "An answer.") {
  return saveHistoryEntry({ store, address, question, answer, intent: "token" });
}

/* --------------------------------- basics --------------------------------- */

test("a saved turn comes back newest first, with what was asked and answered", async () => {
  const store = createMemoryStore();
  await save(store, ALICE, "What is NVDA doing?", "It is up.");
  await save(store, ALICE, "And TSLA?", "It is down.");

  const entries = await listHistory({ store, address: ALICE });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].question, "And TSLA?");
  assert.equal(entries[0].answer, "It is down.");
  assert.equal(entries[0].intent, "token");
  assert.ok(entries[0].id, "every entry has an id, or it could never be deleted");
});

test("a turn with no answer is not saved — a failed question is not history", async () => {
  const store = createMemoryStore();
  assert.equal(await saveHistoryEntry({ store, address: ALICE, question: "hi", answer: "" }), null);
  assert.equal(await saveHistoryEntry({ store, address: ALICE, question: "", answer: "words" }), null);
  assert.deepEqual(await listHistory({ store, address: ALICE }), []);
});

test("a long answer is stored truncated, and says that it was", async () => {
  await withEnv({ HISTORY_MAX_ANSWER_CHARS: "100" }, async () => {
    const store = createMemoryStore();
    await save(store, ALICE, "Explain everything.", "x".repeat(500));
    const [entry] = await listHistory({ store, address: ALICE });
    assert.ok(entry.answer.length <= 100);
    assert.match(entry.answer, /truncated/, "nothing cut short may read as complete");
  });
});

test("history is only ever keyed by a session address", () => {
  assert.equal(historyKey(ALICE), `hist:${ALICE.toLowerCase()}`);
  // Anything that is not an address is a bug in the caller, not a key to write.
  assert.throws(() => historyKey("alice"), /session address/);
  assert.throws(() => historyKey(""), /session address/);
  assert.throws(() => historyKey("hist:0x1234"), /session address/);
});

/* ------------------------------ address scope ----------------------------- */

test("one address cannot READ another's history", async () => {
  const store = createMemoryStore();
  await save(store, ALICE, "Alice's question");
  await save(store, BOB, "Bob's question");

  const alice = await listHistory({ store, address: ALICE });
  const bob = await listHistory({ store, address: BOB });
  assert.deepEqual(
    alice.map((e) => e.question),
    ["Alice's question"],
  );
  assert.deepEqual(
    bob.map((e) => e.question),
    ["Bob's question"],
  );
});

test("one address cannot DELETE another's entry, even holding its id", async () => {
  const store = createMemoryStore();
  const bobs = await save(store, BOB, "Bob's question");
  await save(store, ALICE, "Alice's question");

  // Alice knows Bob's id (say it leaked) and asks for it to be deleted as herself.
  const deleted = await deleteHistoryEntry({ store, address: ALICE, id: bobs.id });
  assert.equal(deleted, false, "the id is looked for inside Alice's own key only");

  const bob = await listHistory({ store, address: BOB });
  assert.equal(bob.length, 1, "and Bob still has it");
  assert.equal(bob[0].question, "Bob's question");

  // Alice's own entry deletes normally.
  const [alices] = await listHistory({ store, address: ALICE });
  assert.equal(await deleteHistoryEntry({ store, address: ALICE, id: alices.id }), true);
  assert.deepEqual(await listHistory({ store, address: ALICE }), []);
});

test("clearing takes one wallet's history and leaves everybody else's", async () => {
  const store = createMemoryStore();
  await save(store, ALICE, "One");
  await save(store, ALICE, "Two");
  await save(store, BOB, "Bob's");

  await clearHistory({ store, address: ALICE });
  assert.deepEqual(await listHistory({ store, address: ALICE }), []);
  assert.equal((await listHistory({ store, address: BOB })).length, 1);
});

test("a made-up id deletes nothing and answers the same as a stolen one", async () => {
  const store = createMemoryStore();
  await save(store, ALICE, "Mine");
  assert.equal(await deleteHistoryEntry({ store, address: ALICE, id: "definitelyNotAnId" }), false);
  assert.equal(await deleteHistoryEntry({ store, address: ALICE, id: "" }), false);
  // Not an id shape at all: refused before it can reach a query.
  assert.equal(await deleteHistoryEntry({ store, address: ALICE, id: "' OR 1=1 --" }), false);
  assert.equal((await listHistory({ store, address: ALICE })).length, 1);
});

/* ---------------------------------- the cap ------------------------------- */

test("at the cap the OLDEST entry drops and the newest is kept", async () => {
  await withEnv({ HISTORY_MAX_ITEMS: "3" }, async () => {
    const store = createMemoryStore();
    assert.equal(historyMaxItems(), 3);
    for (const q of ["one", "two", "three", "four"]) await save(store, ALICE, q);

    const entries = await listHistory({ store, address: ALICE });
    assert.equal(entries.length, 3, "the cap holds");
    assert.deepEqual(
      entries.map((e) => e.question),
      ["four", "three", "two"],
      "a save is never refused for being over the cap — the oldest makes room",
    );
  });
});

test("the cap cannot be raised past what the store will hold", async () => {
  await withEnv({ HISTORY_MAX_ITEMS: "100000" }, () => {
    assert.equal(historyMaxItems(), 500, "the store's own list ceiling still applies");
  });
});

/* ------------------------------ store contract ---------------------------- */

test("the store removes a list item by id, and only under its own key", async () => {
  const store = createMemoryStore();
  await store.append("k1", { id: "a", v: 1 });
  await store.append("k1", { id: "b", v: 2 });
  await store.append("k2", { id: "a", v: 3 });

  assert.equal(await store.removeFromList("k1", "a"), 1);
  assert.deepEqual(await store.list("k1"), [{ id: "b", v: 2 }]);
  assert.deepEqual(await store.list("k2"), [{ id: "a", v: 3 }], "the same id under another key is untouched");
  assert.equal(await store.removeFromList("k1", "nope"), 0);
});

test("a counter can be read without being spent", async () => {
  const store = createMemoryStore();
  assert.equal(await store.counter("c"), null, "an untouched counter is null, not zero");
  await store.increment("c", { ttlMs: 60_000 });
  await store.increment("c", { ttlMs: 60_000 });
  assert.equal((await store.counter("c")).value, 2);
  assert.equal((await store.counter("c")).value, 2, "reading it twice does not move it");
});
