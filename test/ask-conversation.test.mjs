// Tests for the turn that answers anything — lib/ask-conversation.js and the
// two paths in lib/ask-runner.js that reach it.
//
// THE DEFECT THESE EXIST FOR, from a phone on the live site. Two questions:
//
//   "Which wallet bought catecoin on Solana 2hrs ago"
//   "I got rugged"
//
// and one canned reply, byte-identical for both: "I couldn't tell what to look
// up. Try a ticker (NVDA), …". A template, not an answer.
//
// WHAT IS REAL HERE AND WHAT IS NOT. The detector, the prompt assembly, the
// figure scan and the written floor are real and are what these tests are about.
// The MODEL is fake — a scripted function with the upstream's contract — so
// nothing here proves the model writes a good sentence. It proves the machinery
// around that sentence: that the right question reaches the conversational turn,
// that the turn is handed the scope it needs, that no tools are offered, and
// that an answer carrying a figure cannot reach a user however the model behaves.
// The prose itself was checked against the live model separately.
//
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

import { INTENTS, detectForeignVenue, isUnroutableDistress, looksLikeDistress } from "../lib/ask-intent.js";
import {
  CAPABILITY_BRIEF,
  CONVERSATION_PROMPT,
  containsFigure,
  conversationFallback,
  conversationPayload,
  guardConversationAnswer,
  scopeNote,
} from "../lib/ask-conversation.js";
import { runAsk, runAskStream } from "../lib/ask-runner.js";
import { CORPUS } from "../scripts/routing-corpus.mjs";

const MODEL = "test-model";

/** An assistant turn that answers. */
function proseTurn(content) {
  return { choices: [{ message: { role: "assistant", content } }] };
}

/** An assistant turn with nothing in it at all — the shape that degrades. */
function emptyTurn() {
  return { choices: [{ message: { role: "assistant", content: null } }] };
}

function scriptedChat(turns) {
  const payloads = [];
  const chat = async (payload) => {
    payloads.push(payload);
    const turn = turns[payloads.length - 1];
    if (!turn) throw new Error(`no scripted turn ${payloads.length}`);
    if (turn instanceof Error) throw turn;
    return typeof turn === "function" ? turn(payload) : turn;
  };
  return { chat, payloads };
}

/** Everything an event stream produced, collected. */
async function collect(stream) {
  const events = [];
  for await (const e of stream) events.push(e);
  return events;
}

/* ------------------------------ knowing its scope ------------------------------ */

test("a question about another chain is answered here, not sent to a lookup", async () => {
  // The live question, verbatim. It must not reach the router: there is no tool
  // for Solana, and the router spending a turn hunting a Solana memecoin in a
  // Robinhood Chain index is how it ended up saying it could not tell what to
  // look up for a question that was completely clear.
  const { chat, payloads } = scriptedChat([proseTurn("Solana isn't something I can see.")]);
  const res = await runAsk({
    question: "Which wallet bought catecoin on Solana 2hrs ago",
    chat,
    model: MODEL,
    deps: { dispatch: async () => assert.fail("no lookup may run for a question about another chain") },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.intent, INTENTS.CONVERSATION);
  assert.equal(res.body.evidence, null);
  assert.equal(payloads.length, 1, "one completion, no routing turn");
  assert.equal(payloads[0].tools, undefined, "and no tools on it");
});

test("the turn is told which chain was named, and told to name it back", () => {
  const scope = detectForeignVenue("Which wallet bought catecoin on Solana 2hrs ago");
  assert.deepEqual(scope, { venue: "Solana", matched: ["on solana"] });

  const note = scopeNote(scope);
  assert.match(note, /Solana/, "the chain the user asked about is named");
  assert.match(note, /Robinhood Chain only/i, "and so is the limit");
  assert.match(note, /Do not state any fact about Solana/i, "and nothing is claimed about it");

  const payload = conversationPayload({
    question: "Which wallet bought catecoin on Solana 2hrs ago",
    model: MODEL,
    scope,
  });
  const user = payload.messages.at(-1).content;
  assert.ok(user.includes(note), "the note rides with the question");
  assert.ok(user.includes("catecoin"), "and so does the question itself");
  assert.equal(payload.tools, undefined);
});

test("the written floor for another chain names that chain and the limit", () => {
  const answer = conversationFallback({ scope: { venue: "Solana" } });
  assert.match(answer, /Solana/);
  assert.match(answer, /Robinhood Chain/);
  // The shared-name case, which is the expensive direction of wrong: a token on
  // THIS chain can carry a Solana memecoin's name, so the floor offers to look
  // rather than closing the door.
  assert.match(answer, /contract address/i);
  assert.equal(containsFigure(answer), false);
});

test("a bare token name is NOT out of scope — a name is not a chain", async () => {
  // "catecoin" on its own names no chain. There may well be a contract called
  // that here, and refusing it as somebody else's would be the failure that
  // costs a user their answer rather than merely their patience.
  assert.equal(detectForeignVenue("who bought catecoin"), null);
  assert.equal(detectForeignVenue("is catecoin legit"), null);

  const dispatched = [];
  const { chat } = scriptedChat([
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "search_tokens", arguments: JSON.stringify({ query: "catecoin" }) } },
            ],
          },
        },
      ],
    },
    proseTurn("Nothing by that name is deployed here."),
  ]);
  await runAsk({
    question: "who bought catecoin",
    chat,
    model: MODEL,
    deps: {
      dispatch: async (name) => {
        dispatched.push(name);
        return { ok: true, kind: "search", target: "catecoin", evidence: { results: [] } };
      },
    },
  });
  assert.deepEqual(dispatched, ["search_tokens"], "it went to the router, exactly as it should have");
});

test("the scope check fires on none of the 106 routing-corpus rows", () => {
  // THE OVER-TRIGGER GUARD, and it has already earned its keep: "wut is robinhud
  // chain" — a typo'd question about THIS chain — matched the generic "<name>
  // chain" shape until that shape was made to require a locative. Every row here
  // is a question the router is supposed to answer, so a single hit is a user
  // losing an answer they should have got.
  const fired = CORPUS.filter((row) => detectForeignVenue(row.q)).map((row) => row.id);
  assert.deepEqual(fired, [], `the scope check must not intercept routable questions: ${fired.join(", ")}`);
});

test("the chain this product IS cannot be read as another one", () => {
  // Robinhood Chain is an Arbitrum Orbit rollup that settles to Ethereum, so
  // both words appear in perfectly ordinary questions ABOUT it.
  for (const q of [
    "does this settle on ethereum",
    "is it an ethereum l2",
    "how does the arbitrum orbit chain work",
    "wut is robinhud chain",
    "what chain is this",
    "i got rugged here",
  ]) {
    assert.equal(detectForeignVenue(q), null, `must not read "${q}" as somebody else's chain`);
  }
});

test("a chain nobody listed is still recognised by shape", () => {
  // The list cannot contain a chain launched next month, so the shape has to
  // carry the ones the names miss.
  assert.deepEqual(detectForeignVenue("who bought this on the zorp chain"), {
    venue: "Zorp",
    matched: ["on the zorp chain"],
  });
  assert.equal(detectForeignVenue("i aped on pump.fun and got rugged")?.venue, "Solana");
});

/* ------------------------------ distress ------------------------------ */

test("a distress message gets a real capability, not sympathy and not a menu", async () => {
  // Measured live before this gate existed: the router answered "I got rugged"
  // with ask_clarification, and the reply was the literal echo "I got rugged"
  // plus three radio buttons asking what the user meant. Nothing needed
  // clarifying — the sentence was clear, it named nothing, and the useful move
  // is to say what can be read from an address and then ask for one.
  const { chat, payloads } = scriptedChat([proseTurn("Paste the contract and I'll show you who held it and who sold.")]);
  const res = await runAsk({
    question: "I got rugged",
    chat,
    model: MODEL,
    deps: { dispatch: async () => assert.fail("there is nothing named here to look up") },
  });

  assert.equal(res.status, 200, "somebody who lost money is not a client error");
  assert.equal(res.body.intent, INTENTS.CONVERSATION);
  assert.equal(res.body.answer, "Paste the contract and I'll show you who held it and who sold.");
  assert.equal(payloads.length, 1, "no routing turn is bought for a sentence that names nothing");

  // What the model was ASKED for is the part this test can actually pin down.
  const system = payloads[0].messages[0].content;
  assert.match(system, /WHEN SOMEONE HAS LOST MONEY/);
  assert.match(system, /ASK FOR THE ADDRESS/);
  assert.match(system, /Never assert that it WAS a rug/);
  assert.match(system, /never state anyone's intent/i);
});

test("distress that NAMES something is still a lookup", async () => {
  // The expensive direction. "is this a rug tsla" is distress vocabulary wrapped
  // around a real subject, and it is a corpus row: a target-count test would
  // have swallowed it, because extraction is case-sensitive and lowercase "tsla"
  // is not a target. The whitelist is what keeps it with the router.
  for (const q of [
    "is this a rug tsla",
    "did nvda get rugged",
    "is catecoin a scam",
    "i got rugged by 0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
  ]) {
    assert.equal(isUnroutableDistress(q), false, `"${q}" names something and must be routed`);
  }
  // And an interface with something in view means the question is about that.
  const { chat, payloads } = scriptedChat([proseTurn("Here is what that contract looks like.")]);
  await runAsk({
    question: "I got rugged",
    target: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
    chat,
    model: MODEL,
    deps: { dispatch: async () => ({ ok: true, kind: "token", target: "x", evidence: {} }) },
  });
  assert.ok(payloads[0].tools, "with a target in view it is a real lookup, and tools are offered");
});

test("the distress gate fires on none of the 106 routing-corpus rows", () => {
  const fired = CORPUS.filter((row) => isUnroutableDistress(row.q)).map((row) => row.id);
  assert.deepEqual(fired, [], `distress must not intercept routable questions: ${fired.join(", ")}`);
});

test("the written floor for distress offers the four things it can actually read", () => {
  assert.equal(looksLikeDistress("I got rugged"), true);
  assert.equal(looksLikeDistress("i think i got scammed"), true);
  assert.equal(looksLikeDistress("what is nvda"), false);

  const answer = conversationFallback({ distress: true });
  // Each of these is a lookup lib/ask-tools.js implements — token_holders,
  // bundle_check, the pool reads, and the sell side of recent_trades. An offer
  // the product cannot honour would be worse than the template it replaced.
  assert.match(answer, /contract address/i);
  assert.match(answer, /holds it and how concentrated/i);
  assert.match(answer, /picked up together/i);
  assert.match(answer, /sold/i);
  // Never a verdict, never an accusation.
  assert.match(answer, /can't tell you what anyone meant/i);
  assert.equal(containsFigure(answer), false);
});

test("every capability the prompt offers is one a tool implements", async () => {
  const { TOOL_NAMES } = await import("../lib/ask-tools.js");
  for (const name of [
    "token_holders",
    "bundle_check",
    "recent_trades",
    "contract_info",
    "safety_check",
    "wallet_portfolio",
    "holder_hold_time",
  ]) {
    assert.ok(TOOL_NAMES.includes(name), `${name} is offered in the brief and must exist`);
  }
  assert.ok(CONVERSATION_PROMPT.includes(CAPABILITY_BRIEF), "the brief is part of the prompt, not a second copy");
});

/* ------------------------------ vagueness ------------------------------ */

test("a vague message asks for the one thing it needs, and never for a rewrite", () => {
  assert.match(CONVERSATION_PROMPT, /WHEN THE MESSAGE IS VAGUE/);
  assert.match(CONVERSATION_PROMPT, /Do not ask them to rephrase/i);
  assert.match(CONVERSATION_PROMPT, /One question, not a list of options/);

  const answer = conversationFallback({});
  assert.match(answer, /contract address|wallet|transaction hash|ticker/i);
  assert.equal(containsFigure(answer), false);
});

/* ------------------------------ the line it must not cross ------------------------------ */

test("an answer carrying a figure is discarded, not printed", async () => {
  // The structural half of the honesty rule. The prompt asks for no numerals;
  // this proves what happens when the model writes one anyway, which at
  // temperature 0.6 is a question of when rather than whether.
  const { chat } = scriptedChat([proseTurn("Catecoin has 4,812 holders and a $2.1M market cap on Solana.")]);
  const res = await runAsk({
    question: "hows catecoin doing on solana",
    chat,
    model: MODEL,
    deps: { dispatch: async () => assert.fail("no lookup runs here") },
  });

  assert.equal(res.status, 200);
  assert.ok(!res.body.answer.includes("4,812"), "the fabricated holder count never reaches the user");
  assert.ok(!res.body.answer.includes("$2.1M"), "nor the fabricated market cap");
  assert.equal(containsFigure(res.body.answer), false);
  assert.match(res.body.answer, /Solana/, "and the reply is still the right reply to the question asked");
});

test("the scan catches the shapes a figure actually takes", () => {
  for (const bad of [
    "It trades at $4.16.",
    "About 12,000 holders.",
    "Roughly 900k tokens moved.",
    "The top holder has 43% of supply.",
    "It has 812 holders.",
    "Market cap is around 2 million.",
    "Send it to 0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec.",
    "Deployed in 2021.",
    "3 ETH went out.",
  ]) {
    assert.equal(containsFigure(bad), true, `must reject: ${bad}`);
  }

  // Numbers whose value cannot have come from a lookup. Rejecting these would
  // make the guard fire on the product's own honest sentences.
  for (const fine of [
    "I read Robinhood Chain, an Ethereum Layer-2 with chain id 4663.",
    'Ask for a ranking like "top 10 stocks by market cap".',
    "They are ordinary ERC-20 contracts.",
    "You asked about a trade 2 hrs ago — send me the hash.",
    "I can show 24h volume once you name a token.",
  ]) {
    assert.equal(containsFigure(fine), false, `must allow: ${fine}`);
  }
});

test("the prompt and every written reply are themselves figure-free", () => {
  assert.equal(containsFigure(CONVERSATION_PROMPT), false);
  assert.equal(containsFigure(conversationFallback({})), false);
  assert.equal(containsFigure(conversationFallback({ distress: true })), false);
  assert.equal(containsFigure(conversationFallback({ scope: { venue: "Bitcoin" } })), false);
});

test("the guard reports why it rejected, so a rejection can be read in the logs", () => {
  const clean = guardConversationAnswer("Send me the contract and I'll take it apart.");
  assert.deepEqual(clean, {
    answer: "Send me the contract and I'll take it apart.",
    blocked: false,
    reason: null,
  });

  const blocked = guardConversationAnswer("It has 4,812 holders.", { question: "I got rugged" });
  assert.equal(blocked.blocked, true);
  assert.match(blocked.reason, /figure/);
  assert.match(blocked.answer, /contract address/i, "and the distress reply is what replaced it");

  const empty = guardConversationAnswer("   ");
  assert.equal(empty.blocked, true);
  assert.equal(empty.reason, "empty");
});

/* ------------------------------ the model being gone ------------------------------ */

test("an unreachable model still yields something honest rather than a crash", async () => {
  const dead = async () => {
    const err = new Error("Groq 503");
    err.status = 503;
    throw err;
  };
  const res = await runAsk({
    question: "Which wallet bought catecoin on Solana 2hrs ago",
    chat: dead,
    model: MODEL,
    deps: { dispatch: async () => assert.fail("no lookup runs here") },
  });

  // A 502 for this question would be absurd: nothing was going to be looked up,
  // so the outage took nothing away that the answer needed.
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.body.answer, /Solana/, "it still names the chain that was asked about");
  assert.match(res.body.answer, /Robinhood Chain/, "and still says what it does read");
  assert.equal(containsFigure(res.body.answer), false);
  assert.equal(res.body.evidence, null);
});

test("a conversational turn whose completion dies still offers the real capability", async () => {
  // Nothing was going to be looked up for this one, so the outage took nothing
  // away that the answer needed. The floor is what the user gets, and it is
  // still an answer rather than an error.
  const chat = async () => {
    throw new Error("socket hang up");
  };
  const res = await runAsk({ question: "I got rugged", chat, model: MODEL, deps: { dispatch: async () => ({ ok: true }) } });

  assert.equal(res.status, 200);
  assert.equal(res.body.intent, INTENTS.CONVERSATION);
  assert.match(res.body.answer, /contract address/i);
  assert.match(res.body.answer, /who holds it/i);
  assert.equal(containsFigure(res.body.answer), false);
});

test("an outage on a question that needed the model is still reported as an outage", async () => {
  // The line the floor must not cross in the other direction. "hows nvda doin"
  // is a real question about a real token and the model has to route it, so a
  // dead upstream is a genuine failure — answering it with a cheerful "send me a
  // contract address" would let an outage read as an ordinary reply, which is
  // the same lie as letting it read as an absence. Only the paths that never
  // needed the model degrade silently.
  const dead = async () => {
    const err = new Error("Groq 503");
    err.status = 503;
    throw err;
  };
  const res = await runAsk({ question: "hows nvda doin", chat: dead, model: MODEL, deps: { dispatch: async () => ({ ok: true }) } });

  assert.equal(res.status, 502);
  assert.equal(res.body.ok, false);
});

/* ------------------------------ streamed ------------------------------ */

test("the streamed conversational turn paces a guarded answer, never a raw one", async () => {
  // It is the ONE path here that does not stream token by token, and that is the
  // guarantee: a figure cannot be unsaid once it is on the screen, so the scan
  // has to see the whole answer before any of it is sent.
  const events = await collect(
    runAskStream({
      question: "Which wallet bought catecoin on Solana 2hrs ago",
      chat: async () => proseTurn("Catecoin has 4,812 holders on Solana."),
      streamChat: async () => assert.fail("this turn must not be streamed straight through"),
      model: MODEL,
      deps: { dispatch: async () => assert.fail("no lookup runs here") },
    }),
  );

  const meta = events.find((e) => e.type === "meta");
  assert.equal(meta.intent, INTENTS.CONVERSATION);
  assert.equal(meta.evidence, null);
  assert.deepEqual(meta.toolCalls, []);

  const done = events.at(-1);
  assert.equal(done.type, "done");
  assert.equal(containsFigure(done.answer), false);
  assert.ok(!done.answer.includes("4,812"));

  const streamed = events
    .filter((e) => e.type === "delta")
    .map((e) => e.text)
    .join("");
  assert.equal(streamed, done.answer, "what arrived is exactly what was assembled");
});

test("the streamed fallback floor reaches the conversational turn too", async () => {
  // Routing unavailable AND the keyword router cannot route it: the streamed
  // path used to emit the template as an `error` event with status 400.
  const events = await collect(
    runAskStream({
      question: "wat do i even do with this",
      chat: async (payload) => (payload.tools ? emptyTurn() : proseTurn("Send me a contract address and I'll start there.")),
      streamChat: async () => assert.fail("no evidence turn should be streamed"),
      model: MODEL,
      deps: { dispatch: async () => ({ ok: true }) },
    }),
  );

  assert.equal(events.some((e) => e.type === "error"), false, "not an error any more");
  assert.equal(events.find((e) => e.type === "meta").intent, INTENTS.CONVERSATION);
  assert.equal(events.at(-1).answer, "Send me a contract address and I'll start there.");
});

test("a fabricated PERCENTAGE is caught — the % branch was dead regex", () => {
  // /…(?:%|percent|bps)\b/ put ONE word boundary after the alternation, and \b needs a
  // word character beside it. `%` is not one, so the symbol branch demanded a word
  // character AFTER the percent sign, which prose never has. Measured: "90%" false,
  // "90% of supply" false, "90%x" TRUE. The guard passed fabricated percentages from a
  // turn that read nothing. Its old test was green via the keyword-near-digit pattern,
  // because "holder" happened to sit within that pattern's window.
  for (const s of [
    "The dev holds 90% of supply.",
    "The top wallets hold 87% between them.",
    "Roughly 60% of the supply moved in the first block.",
    "It is down 99% from its high.",
    "The deployer still has 45%.",
    "90 percent of supply",
  ]) {
    assert.equal(containsFigure(s), true, `a figure slipped through: ${s}`);
  }
  // The replies this turn is actually for carry no figure and must survive.
  for (const s of [
    "I read Robinhood Chain only and cannot see Solana.",
    "Give me the contract address and I can tell you who holds it.",
  ]) {
    assert.equal(containsFigure(s), false, `a clean reply was rejected: ${s}`);
  }
});
