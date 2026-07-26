// Tests for the streaming half of /api/ask: the SSE wire parser (lib/sse.js),
// the mid-stream tool-syntax holdback (lib/ask-loop.js) and the streamed runner
// (lib/ask-runner.js runAskStream).
//
// Three failure modes are being defended, and each of them has been shipped by
// somebody before:
//
//  1. THE WIRE IS NOT TIDY. A chunk boundary can land inside a line, inside a
//     JSON object, or between the two newlines of a frame; proxies inject comment
//     keep-alives; one frame can be malformed. None of that may cost the answer.
//  2. TOOL SYNTAX MUST NOT REACH THE SCREEN. stripToolSyntax defends a whole
//     answer, which a streamed answer never is: by the time `</function>` arrives
//     the opener has already been rendered. So text is released only once it is
//     provably not the start of a construct — and the held tail must still be
//     flushed, because losing the last two words of every answer would be worse
//     than the bug it prevents.
//  3. A GREETING MUST NOT COST A LOOKUP. "hello" fired market_overview and came
//     back with a market summary. isSmallTalk is the pre-check that stops it, and
//     the test that matters is the NEGATIVE one: "hi, what is nvda" names a real
//     subject and must still route to the token lookup.
//
// Fully offline. There is no GROQ_API_KEY here and none is needed: `chat` is a
// scripted function, `streamChat` yields hand-written SSE text, and the gatherers
// are stubs. No live LLM round trip is exercised anywhere in this file.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { INTENTS, isSmallTalk } from "../lib/ask-intent.js";
import { createSseParser, deltaText, eventError } from "../lib/sse.js";
import { createToolSyntaxFilter, streamCleanText } from "../lib/ask-loop.js";
import { SMALL_TALK_FALLBACK, runAskStream } from "../lib/ask-runner.js";
import { displayNumber, finiteOrNull } from "../lib/format-number.js";
import { tokenDisplay } from "../lib/ask-evidence.js";

const ADDRESS = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const MODEL = "test-model";

/* ------------------------------ SSE fixtures ------------------------------ */

/** One `data:` frame carrying a content delta, exactly as Groq sends it. */
function frame(text) {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`;
}

/** A whole SSE body for an answer, terminator included. */
function body(...texts) {
  return `${texts.map(frame).join("")}data: [DONE]\n\n`;
}

/** Cut a string into fixed-size slices, the way a socket would. */
function slice(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** An async iterable over pre-made chunks, plus a record of what was consumed. */
function chunkStream(chunks) {
  const state = { consumed: 0, closed: false };
  const iterable = {
    async *[Symbol.asyncIterator]() {
      try {
        for (const chunk of chunks) {
          state.consumed += 1;
          yield chunk;
        }
      } finally {
        // Set when the consumer abandons us as well as on a clean end — this is
        // the reader-cleanup contract the route depends on.
        state.closed = true;
      }
    },
  };
  return { iterable, state };
}

/** Everything a text stream produced, joined. */
async function collect(chunks, options) {
  let out = "";
  for await (const piece of streamCleanText(chunks, options)) out += piece;
  return out;
}

/* ------------------------------ the wire parser ------------------------------ */

test("SSE parser reassembles frames split across chunk boundaries", async () => {
  const wire = body("Hello ", "world", "!");
  // One character at a time is the worst case a socket can hand us.
  for (const size of [1, 3, 7, 13, 512]) {
    assert.equal(await collect(chunkStream(slice(wire, size)).iterable), "Hello world!", `size ${size}`);
  }
});

test("SSE parser holds a partial line until its newline arrives", () => {
  const parser = createSseParser();
  const wire = frame("abc");
  const cut = Math.floor(wire.length / 2);
  // Half a JSON object must produce nothing at all, not a parse failure.
  assert.deepEqual(parser.push(wire.slice(0, cut)), []);
  assert.equal(parser.malformed, 0, "a partial line is not a malformed one");
  const events = parser.push(wire.slice(cut));
  assert.equal(events.length, 1);
  assert.equal(deltaText(events[0]), "abc");
});

test("SSE parser skips keep-alives, blank lines and non-data fields", async () => {
  const wire = [
    ": ping\n\n",
    "\n",
    "event: message\n",
    frame("one"),
    ": another keep-alive\n\n",
    "id: 42\n",
    "retry: 1000\n",
    frame(" two"),
    "data: [DONE]\n\n",
  ].join("");
  assert.equal(await collect(chunkStream([wire]).iterable), "one two");
});

test("SSE parser drops one malformed frame and keeps the rest of the answer", async () => {
  const wire = `${frame("before ")}data: {"choices":[{"delta":{"content":\n\ndata: not json at all\n\n${frame("after")}data: [DONE]\n\n`;
  const text = await collect(chunkStream([wire]).iterable);
  assert.match(text, /before/);
  assert.match(text, /after/, "a bad frame must not cost the frames behind it");
});

test("SSE parser counts malformed frames rather than throwing", () => {
  const parser = createSseParser();
  parser.push("data: {oops\n\n");
  parser.push("data: also-not-json\n\n");
  assert.equal(parser.malformed, 2);
  assert.equal(parser.done, false);
});

test("SSE parser latches closed at [DONE] and ignores anything after it", async () => {
  const wire = `${frame("kept")}data: [DONE]\n\n${frame(" discarded")}`;
  assert.equal(await collect(chunkStream([wire]).iterable), "kept");

  const parser = createSseParser();
  parser.push("data: [DONE]\n\n");
  assert.equal(parser.done, true);
  assert.deepEqual(parser.push(frame("more")), [], "a closed parser accepts nothing");
});

test("SSE parser tolerates CRLF terminators", async () => {
  const wire = `data: ${JSON.stringify({ choices: [{ delta: { content: "crlf" } }] })}\r\n\r\ndata: [DONE]\r\n\r\n`;
  assert.equal(await collect(chunkStream([wire]).iterable), "crlf");
});

test("SSE parser flushes a final line that arrived without its newline", () => {
  const parser = createSseParser();
  const wire = frame("truncated").replace(/\n\n$/, "");
  assert.deepEqual(parser.push(wire), []);
  const rest = parser.flush();
  assert.equal(rest.length, 1);
  assert.equal(deltaText(rest[0]), "truncated");
});

test("deltaText reads delta content, joins content parts, and ignores tool fragments", () => {
  assert.equal(deltaText({ choices: [{ delta: { content: "x" } }] }), "x");
  assert.equal(deltaText({ choices: [{ delta: { content: [{ text: "a" }, { text: "b" }] } }] }), "ab");
  assert.equal(deltaText({ choices: [{ delta: { role: "assistant" } }] }), "");
  assert.equal(deltaText({ choices: [{ delta: { tool_calls: [{}] }, finish_reason: null }] }), "");
  assert.equal(deltaText({ choices: [{ delta: {}, finish_reason: "stop" }] }), "");
  assert.equal(deltaText(null), "");
  assert.equal(deltaText({}), "");
  // A non-streaming body has no `delta` at all; a streaming one always does, so
  // reading `message` only in the former case cannot double an answer.
  assert.equal(deltaText({ choices: [{ message: { content: "whole" } }] }), "whole");
  assert.equal(deltaText({ choices: [{ delta: { content: "d" }, message: { content: "m" } }] }), "d");
});

test("an error reported inside the stream ends it and keeps what arrived", async () => {
  const wire = `${frame("partial answer")}data: ${JSON.stringify({ error: { message: "rate limited" } })}\n\n${frame(" never seen")}`;
  assert.equal(await collect(chunkStream([wire]).iterable), "partial answer");
  assert.equal(eventError({ error: { message: "boom" } }), "boom");
  assert.equal(eventError({ choices: [] }), null);
});

test("streamCleanText returns the chunk source when it stops early", async () => {
  const { iterable, state } = chunkStream([...slice(body("a", "b", "c"), 4), frame("unreachable")]);
  for await (const _piece of streamCleanText(iterable)) break; // abandon it
  assert.equal(state.closed, true, "abandoning the generator must close the reader beneath it");
});

test("streamCleanText stops at its character cap", async () => {
  const wire = body("x".repeat(50), "y".repeat(50));
  const text = await collect(chunkStream([wire]).iterable, { maxChars: 60 });
  assert.ok(text.length <= 100, "the cap bounds the answer");
  assert.ok(text.includes("x"), "what arrived first is kept");
});

/* --------------------------- the tool-syntax holdback --------------------------- */

test("the holdback filter never emits a tool call the model wrote mid-stream", () => {
  const filter = createToolSyntaxFilter();
  let out = "";
  // Split so the opener straddles chunks — the case a naive scrubber leaks.
  for (const piece of ["Here you go. <fun", "ction=rank_stocks", '{"metric":"holders"}', "</function>", " Done."]) {
    out += filter.push(piece);
  }
  out += filter.flush();
  assert.equal(out.includes("<function"), false, "no opener may reach the user");
  assert.equal(out.includes("rank_stocks"), false, "nor the arguments");
  assert.match(out, /Here you go\./);
  assert.match(out, /Done\./, "the prose on both sides survives");
});

test("the holdback filter withholds a partial opener instead of flushing it", () => {
  const filter = createToolSyntaxFilter();
  assert.equal(filter.push("all good "), "all good ");
  // "<f" could become "<function=" with the next chunk, so it waits.
  assert.equal(filter.push("<f"), "");
  assert.equal(filter.push("unction=lookup_token{}</function>"), "");
  assert.equal(filter.flush(), "");
});

test("the holdback filter releases a tail that turned out to be ordinary prose", () => {
  const filter = createToolSyntaxFilter();
  assert.equal(filter.push("price is <"), "price is ");
  // "< 5" cannot start any construct, so the held "<" comes straight back.
  assert.equal(filter.push(" 5"), "< 5");
  assert.equal(filter.flush(), "");
});

test("the holdback filter flushes its tail so an answer never loses its ending", () => {
  const filter = createToolSyntaxFilter();
  const emitted = filter.push("The answer ends here.");
  const tail = filter.flush();
  assert.equal(`${emitted}${tail}`, "The answer ends here.");
});

test("the holdback filter is transparent to prose: nothing lost, nothing glued", () => {
  // Stray "<" characters, double spaces and a chunk size that splits words: the
  // filter holds text back, so the invariant that matters is that every character
  // comes out exactly once, in order. (This is also why flush() trims the END of
  // its tail only — trimming the front would glue it to the last piece sent.)
  const source = "Top holder is 3 < 4 of supply, and a < b. Done.";
  const filter = createToolSyntaxFilter();
  let out = "";
  for (const piece of slice(source, 3)) out += filter.push(piece);
  out += filter.flush();
  assert.equal(out, source);
});

test("the holdback filter scrubs an unterminated construct at end of stream", () => {
  const filter = createToolSyntaxFilter();
  let out = filter.push("Answer. <|python_tag|>{\"name\":\"rank_stocks\"}");
  out += filter.flush();
  assert.equal(out.includes("python_tag"), false);
  assert.equal(out.includes("rank_stocks"), false);
  assert.match(out, /Answer\./);
});

test("a stream that dies mid-tool-call shows prose, never the half-written call", () => {
  const filter = createToolSyntaxFilter();
  // The closer never arrives, so TOOL_SYNTAX_RE cannot match it — the tail is cut.
  let out = filter.push("Here are the top holders. <function=rank_stocks{\"metric\":\"hol");
  out += filter.flush();
  // (The assembled answer is trimmed by the runner, so the trailing space is fine.)
  assert.equal(out.trim(), "Here are the top holders.");
  assert.equal(out.includes("<"), false);
  assert.equal(out.includes("rank_stocks"), false);
});

test("the holdback filter removes the end-of-turn markers models leak", () => {
  const filter = createToolSyntaxFilter();
  const out = filter.push("done<|eot_id|>") + filter.flush();
  assert.equal(out, "done");
});

test("a streamed answer arrives token by token with the syntax removed", async () => {
  const wire = body("Top holder", " is 0xd060", "…9eec.", "<|eom_id|>");
  const pieces = [];
  for await (const piece of streamCleanText(chunkStream(slice(wire, 9)).iterable)) pieces.push(piece);
  assert.ok(pieces.length > 1, "the point of streaming is more than one piece");
  const text = pieces.join("");
  assert.equal(text.includes("eom_id"), false);
  assert.match(text, /Top holder is 0xd060…9eec\./);
});

/* ------------------------------- small talk ------------------------------- */

test("isSmallTalk catches greetings, thanks and identity questions", () => {
  for (const q of [
    "hi",
    "Hi!",
    "hello",
    "hey there",
    "gm",
    "GM",
    "yo",
    "sup",
    "thanks",
    "thank you!",
    "ok thanks",
    "cheers",
    "who are you",
    "what are you",
    "whats your name",
    "what can you do",
    "are you a bot",
    "who r u",
    "how are you",
    "hows it going",
    "good morning",
    "good evening",
    "bye",
    // The product is asked in other languages, and a greeting is a greeting.
    "hola",
    "buenos dias",
    "buenos días",
    "merci",
    "danke",
    "olá",
  ]) {
    assert.equal(isSmallTalk(q), true, JSON.stringify(q));
  }
});

test("isSmallTalk refuses anything that names a real subject", () => {
  for (const q of [
    // THE case: a greeting plus a ticker is a ticker lookup.
    "hi, what is nvda",
    "hello what is trending",
    "hey whats the price of aapl",
    `hello ${ADDRESS}`,
    "what is the top stock",
    "how is the market doing",
    "whats going on",
    "whats new",
    "tell me about nvda",
    "top 10 stocks by market cap",
    "is nvda legit",
    "what is robinhood chain",
    "how does this work",
    "compare nvda and tsla",
    // Not small talk in any language we can read, so it routes normally.
    "привет",
    // Too long to be a social exchange.
    "hi hi hi hi hi hi hi hi",
    "",
    "   ",
  ]) {
    assert.equal(isSmallTalk(q), false, JSON.stringify(q));
  }
});

test("isSmallTalk is total: no input type throws", () => {
  for (const q of [null, undefined, 42, {}, [], () => {}]) {
    assert.equal(isSmallTalk(q), false);
  }
});

/* --------------------------- display strings on lookups --------------------------- */

test("tokenDisplay renders the four headline figures a lookup quotes", () => {
  const display = tokenDisplay({
    price: 206.71,
    marketCap: 4_160_816.92,
    volume24h: 1_836_055_688.37,
    holders: 28_899,
  });
  // The exact bug this exists for: 4160816.92 must not become $4,160,816,920.
  assert.equal(display.marketCap, "$4.16M");
  assert.equal(display.price, "$206.71");
  assert.equal(display.volume24h, "$1.84B");
  assert.equal(display.holders, "28,899", "a holder count is a count, not money");
});

test("tokenDisplay coerces the strings the indexer actually sends", () => {
  // Blockscout sends exchange_rate and circulating_market_cap as STRINGS.
  const display = tokenDisplay({ price: "206.71", marketCap: "4160816.92", volume24h: "", holders: "28899" });
  assert.equal(display.price, "$206.71");
  assert.equal(display.marketCap, "$4.16M");
  assert.equal(display.volume24h, null, "\"\" is a missing figure, never $0.00");
  assert.equal(display.holders, "28,899");
});

test("tokenDisplay leaves a missing figure missing", () => {
  assert.deepEqual(tokenDisplay({}), { price: null, marketCap: null, volume24h: null, holders: null });
  assert.deepEqual(tokenDisplay(), { price: null, marketCap: null, volume24h: null, holders: null });
  assert.deepEqual(tokenDisplay({ price: null, marketCap: undefined, volume24h: "N/A", holders: Number.NaN }), {
    price: null,
    marketCap: null,
    volume24h: null,
    holders: null,
  });
});

test("displayNumber and finiteOrNull behave the same in their new home", () => {
  assert.equal(displayNumber(null), null);
  assert.equal(displayNumber(Number.NaN), null);
  assert.equal(displayNumber(0), "$0.00");
  assert.equal(displayNumber(206.71), "$206.71");
  assert.equal(displayNumber(1200.5), "$1.20K");
  assert.equal(displayNumber(4_160_789.11), "$4.16M");
  assert.equal(displayNumber(1_836_055_688.37), "$1.84B");
  assert.equal(displayNumber(2.5e12), "$2.50T");
  assert.equal(displayNumber(28899, "count"), "28,899");
  assert.equal(finiteOrNull(""), null);
  assert.equal(finiteOrNull(null), null);
  assert.equal(finiteOrNull("N/A"), null);
  assert.equal(finiteOrNull("12.5"), 12.5);
  assert.equal(finiteOrNull(0), 0);
});

/* ------------------------------ the streamed runner ------------------------------ */

/** A `chat` that replays scripted non-streamed turns and records its payloads. */
function scriptedChat(turns) {
  const payloads = [];
  const chat = async (payload) => {
    payloads.push(payload);
    const turn = turns[payloads.length - 1];
    if (!turn) throw new Error(`no scripted turn ${payloads.length}`);
    if (turn instanceof Error) throw turn;
    return turn;
  };
  return { chat, payloads };
}

/** A `streamChat` that yields a scripted SSE body, recording what it was asked. */
function scriptedStream(texts, { chunkSize = 5, fail = null } = {}) {
  const payloads = [];
  const streamChat = async (payload) => {
    payloads.push(payload);
    if (fail) throw fail;
    return chunkStream(slice(body(...texts), chunkSize)).iterable;
  };
  return { streamChat, payloads };
}

/** An assistant turn that asks for tools, in the shape Groq returns. */
function toolTurn(calls) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map((c, i) => ({
            id: `call_${i}`,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
          })),
        },
      },
    ],
  };
}

/** Drain a runAskStream into its events. */
async function run(options) {
  const events = [];
  for await (const event of runAskStream(options)) events.push(event);
  return events;
}

const byType = (events, type) => events.filter((e) => e.type === type);
const joined = (events) => byType(events, "delta").map((e) => e.text).join("");

test("a greeting streams a social answer with no tool call and no lookup", async () => {
  const { chat, payloads } = scriptedChat([]);
  const { streamChat, payloads: streamed } = scriptedStream(["Hey! ", "Ask me about ", "a ticker like NVDA."]);
  const gatherEvidence = async () => {
    throw new Error("a greeting must not reach the indexer");
  };

  const events = await run({
    question: "hello",
    chat,
    streamChat,
    model: MODEL,
    deps: { gatherEvidence, marketOverview: gatherEvidence, rankStocks: gatherEvidence },
  });

  assert.equal(payloads.length, 0, "no routing completion is spent on a greeting");
  assert.equal(streamed.length, 1, "exactly one completion");
  assert.equal(streamed[0].stream, true);
  assert.equal("tools" in streamed[0], false, "no tools are even offered");

  assert.equal(events[0].type, "meta");
  assert.equal(events[0].intent, INTENTS.SMALL_TALK);
  assert.equal(events[0].intent, "small_talk", "the client labels the turn with this");
  assert.deepEqual(events[0].toolCalls, []);
  assert.equal(events[0].evidence, null);
  assert.ok(byType(events, "delta").length > 1, "it arrives in pieces");
  assert.equal(joined(events), "Hey! Ask me about a ticker like NVDA.");
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).answer, "Hey! Ask me about a ticker like NVDA.");
});

test("a greeting still gets an answer when the model is unreachable", async () => {
  const failure = Object.assign(new Error("Groq 503"), { status: 503 });
  const { streamChat } = scriptedStream([], { fail: failure });
  const events = await run({
    question: "gm",
    chat: async () => ({}),
    streamChat,
    model: MODEL,
  });
  // A greeting needs nothing looked up, so an outage cannot take it away.
  assert.equal(byType(events, "error").length, 0);
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).answer, SMALL_TALK_FALLBACK);
  assert.equal(joined(events), SMALL_TALK_FALLBACK);
});

test("a question about the founder streams the tool-free answer", async () => {
  // Live, this one was routed to market_overview and answered with "not
  // specified in the provided market overview". Streamed or not, a question
  // about a person must not reach a market tool: the routing turn that made
  // that mistake is never spent at all.
  const { chat, payloads } = scriptedChat([]);
  const { streamChat, payloads: streamed } = scriptedStream(["Who founded it ", "isn't on-chain."]);
  const forbidden = async () => {
    throw new Error("a question about people must not reach the chain");
  };

  const events = await run({
    question: "who is the founder?",
    chat,
    streamChat,
    model: MODEL,
    deps: { gatherEvidence: forbidden, marketOverview: forbidden, rankStocks: forbidden, dispatch: forbidden },
  });

  assert.equal(payloads.length, 0, "no routing completion, so no tool can be chosen");
  assert.equal(streamed.length, 1);
  assert.equal("tools" in streamed[0], false);
  assert.equal(events[0].type, "meta");
  assert.equal(events[0].intent, INTENTS.EXPLAIN_CHAIN);
  assert.deepEqual(events[0].toolCalls, []);
  assert.equal(typeof events[0].evidence.notOnChain, "string", "the factsheet says so outright");
  assert.equal(joined(events), "Who founded it isn't on-chain.");
  assert.equal(events.at(-1).type, "done");
});

test("a greeting plus a real subject is routed, not greeted", async () => {
  const { chat, payloads } = scriptedChat([toolTurn([{ name: "lookup_token", args: { query: "nvda" } }])]);
  const { streamChat, payloads: streamed } = scriptedStream(["NVDA trades at ", "$206.71."]);
  const dispatch = async (name, args) => ({
    ok: true,
    kind: "token",
    target: "NVDA",
    evidence: { token: { symbol: "NVDA", display: { price: "$206.71" } }, echo: { name, args } },
  });

  const events = await run({
    question: "hi, what is nvda",
    chat,
    streamChat,
    model: MODEL,
    deps: { dispatch },
  });

  assert.equal(payloads.length, 1, "one routing turn");
  assert.equal(streamed.length, 1, "one streamed answer turn — two completions in total");
  assert.equal("tools" in streamed[0], false, "the streamed turn can only produce prose");
  const meta = events[0];
  assert.equal(meta.type, "meta");
  assert.equal(meta.intent, INTENTS.EXPLAIN_TARGET);
  assert.deepEqual(meta.toolCalls, [{ name: "lookup_token", args: { query: "nvda" } }]);
  assert.equal(joined(events), "NVDA trades at $206.71.");
  assert.equal(events.at(-1).type, "done");
});

test("the routing turn is never streamed, and its transcript feeds the streamed one", async () => {
  const { chat, payloads } = scriptedChat([toolTurn([{ name: "market_overview", args: {} }])]);
  const { streamChat, payloads: streamed } = scriptedStream(["94 equities are listed."]);
  const dispatch = async () => ({ ok: true, kind: "overview", evidence: { totalStockTokens: 94 } });

  await run({ question: "whats trending", chat, streamChat, model: MODEL, deps: { dispatch } });

  assert.equal(payloads[0].stream, undefined, "tool_calls must be read whole, so no stream on the routing turn");
  assert.ok(Array.isArray(payloads[0].tools), "tools are offered there");
  const messages = streamed[0].messages;
  assert.equal(messages.at(-1).role, "tool", "the streamed turn answers from the tool result");
  assert.match(messages.at(-1).content, /totalStockTokens/);
});

test("the fast path spends its one completion on the streamed answer", async () => {
  const { chat, payloads } = scriptedChat([]);
  const { streamChat } = scriptedStream(["This wallet holds ", "0.5 ETH."]);
  const gatherEvidence = async (subject) => ({
    ok: true,
    kind: "address",
    target: subject,
    evidence: { address: subject, balanceEth: 0.5 },
  });

  const events = await run({
    question: ADDRESS,
    chat,
    streamChat,
    model: MODEL,
    deps: { gatherEvidence },
  });

  assert.equal(payloads.length, 0, "the fast path routes without the model");
  assert.equal(events[0].type, "meta");
  assert.equal(events[0].kind, "address");
  assert.equal(events[0].target, ADDRESS);
  assert.deepEqual(events[0].toolCalls, [{ name: "lookup_wallet", args: { address: ADDRESS } }]);
  assert.deepEqual(events[0].evidence, { address: ADDRESS, balanceEth: 0.5 });
  assert.equal(joined(events), "This wallet holds 0.5 ETH.");
});

test("a missed lookup is an error event carrying the status it deserves", async () => {
  const { streamChat, payloads: streamed } = scriptedStream(["never asked"]);
  const gatherEvidence = async () => ({
    ok: false,
    kind: "address",
    target: ADDRESS,
    error: "Address not found on Robinhood Chain.",
  });

  const events = await run({
    question: ADDRESS,
    chat: async () => ({}),
    streamChat,
    model: MODEL,
    deps: { gatherEvidence },
  });

  assert.equal(streamed.length, 0, "no completion is spent when there is nothing to explain");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.equal(events[0].status, 404);
  assert.match(events[0].error, /not found/);
});

test("an indexer outage on a missed lookup is retryable, not a 404", async () => {
  const { streamChat } = scriptedStream(["unused"]);
  const gatherEvidence = async () => ({
    ok: false,
    kind: "unavailable",
    target: ADDRESS,
    error: "The Robinhood Chain indexer did not answer.",
  });
  const events = await run({
    question: ADDRESS,
    chat: async () => ({}),
    streamChat,
    model: MODEL,
    deps: { gatherEvidence },
  });
  assert.equal(events[0].type, "error");
  assert.equal(events[0].status, 503);
});

test("a model that needs no lookup has its answer paced out, not re-requested", async () => {
  const prose = "Robinhood Chain is an Arbitrum Orbit rollup that settles to Ethereum, and it carries tokenized equities as ordinary ERC-20 contracts.";
  const { chat, payloads } = scriptedChat([{ choices: [{ message: { role: "assistant", content: prose } }] }]);
  const { streamChat, payloads: streamed } = scriptedStream(["unused"]);

  const events = await run({ question: "what is robinhood chain", chat, streamChat, model: MODEL });

  assert.equal(payloads.length, 1);
  assert.equal(streamed.length, 0, "no second completion for text we are already holding");
  assert.ok(byType(events, "delta").length > 3, "it still arrives in pieces");
  assert.equal(joined(events), prose, "and not one character is lost or duplicated");
  assert.equal(events.at(-1).answer, prose);
});

test("a stream that fails before it starts is an error event", async () => {
  const { chat } = scriptedChat([toolTurn([{ name: "market_overview", args: {} }])]);
  const { streamChat } = scriptedStream([], { fail: Object.assign(new Error("Groq 500"), { status: 500 }) });
  const dispatch = async () => ({ ok: true, kind: "overview", evidence: { totalStockTokens: 94 } });

  const events = await run({ question: "whats trending", chat, streamChat, model: MODEL, deps: { dispatch } });

  assert.equal(events[0].type, "meta", "the evidence still reaches the client");
  assert.equal(events.at(-1).type, "error");
  assert.equal(events.at(-1).status, 502);
});

test("a stream that dies mid-answer keeps the words that arrived", async () => {
  const { chat } = scriptedChat([toolTurn([{ name: "market_overview", args: {} }])]);
  const dispatch = async () => ({ ok: true, kind: "overview", evidence: { totalStockTokens: 94 } });
  const streamChat = async () => ({
    async *[Symbol.asyncIterator]() {
      yield frame("94 equities are listed");
      throw new Error("socket reset");
    },
  });

  const events = await run({ question: "whats trending", chat, streamChat, model: MODEL, deps: { dispatch } });

  assert.equal(joined(events), "94 equities are listed");
  assert.equal(events.at(-1).type, "done", "a partial answer is an answer, not an error");
  assert.equal(events.at(-1).answer, "94 equities are listed");
});

test("a stream with no text at all is reported rather than shown as blank", async () => {
  const { chat } = scriptedChat([toolTurn([{ name: "market_overview", args: {} }])]);
  const dispatch = async () => ({ ok: true, kind: "overview", evidence: { totalStockTokens: 94 } });
  const { streamChat } = scriptedStream([]);

  const events = await run({ question: "whats trending", chat, streamChat, model: MODEL, deps: { dispatch } });

  assert.equal(byType(events, "delta").length, 0);
  assert.equal(events.at(-1).type, "error");
  assert.match(events.at(-1).error, /Empty answer/);
});

test("an endpoint that rejects tools degrades to keyword routing and still streams", async () => {
  const rejected = Object.assign(new Error("Groq 400"), {
    status: 400,
    detail: "tool_choice is not supported",
  });
  const { chat, payloads } = scriptedChat([rejected]);
  const { streamChat } = scriptedStream(["The biggest is NVDA."]);
  const rankStocks = async () => ({ ok: true, kind: "ranking", evidence: { rows: [{ symbol: "NVDA" }] } });

  const events = await run({
    question: "top 5 stocks by market cap",
    chat,
    streamChat,
    model: MODEL,
    deps: { rankStocks },
  });

  assert.equal(payloads.length, 1, "the rejected routing turn is not retried");
  assert.equal(events[0].type, "meta");
  assert.equal(events[0].intent, INTENTS.RANK_STOCKS);
  assert.equal(joined(events), "The biggest is NVDA.");
});

test("runAskStream reports a bug as an error event instead of throwing at the route", async () => {
  const { streamChat } = scriptedStream(["unused"]);
  const events = await run({
    question: "top 5 stocks by market cap",
    chat: async () => ({}),
    streamChat,
    model: MODEL,
    // A gatherer that throws is the runner's problem, never the client's.
    deps: {
      dispatch: () => {
        throw new Error("boom");
      },
      rankStocks: () => {
        throw new Error("boom");
      },
    },
  });
  assert.equal(events.at(-1).type, "error");
  assert.ok(events.at(-1).error.length > 0);
});

test("runAskStream demands both clients", async () => {
  await assert.rejects(() => run({ question: "hi" }), /requires chat/);
  await assert.rejects(() => run({ question: "hi", chat: async () => ({}) }), /requires chat/);
});
