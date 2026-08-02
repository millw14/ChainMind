"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { INTENTS } from "@/lib/ask-intent";
import { createSseParser } from "@/lib/sse";
import { collectTables } from "@/lib/table-shape";
import { buildFollowUps } from "@/lib/follow-ups";
import AnswerTable from "@/components/ask/AnswerTable";
import ThinkingStatus from "@/components/ask/ThinkingStatus";
import { ResearchNotice } from "@/components/research/ResearchNotice";
import {
  IconCompare,
  IconRank,
  IconSend,
  IconShield,
  IconSparkle,
  IconTable,
  IconTrend,
  IconWallet,
} from "@/components/icons/AskIcons";

/**
 * Conversation — THE conversation. Transcript, composer, streaming, intent tags,
 * thinking state, abort and sequence guards, and the answer renderer, in one
 * component that both surfaces mount.
 *
 * It exists because there were two of them. The landing overlay answered in
 * place with a live transcript, while `/ask` — the route the overlay's own footer
 * link advertises — was a static card grid with its own composer, its own fetch
 * and its own message renderer. Two experiences for one product, and the link
 * pointed at the worse one. So the conversation was pulled out of the overlay
 * rather than copied into the page: AskOverlay keeps only the overlay (backdrop,
 * bloom, glows, greeting, scroll lock, Escape, close), and components/ask/AskChat
 * renders this same component full-bleed.
 *
 * STREAMING is the other half. Answers used to arrive all at once after a wait of
 * several seconds — the model had been writing the whole time and the reader was
 * watching three dots. The request now asks for `stream: true` and reads the SSE
 * events lib/ask-runner.js emits:
 *
 *   progress → what is being read right now, shown where the dots were. Optional
 *           by design: no event ever arriving is a supported case, and the dots
 *           are what fills the row then (see ThinkingStatus).
 *   meta  → create the assistant message and its intent tag immediately, so the
 *           turn is labelled before a single word of it exists. It also carries
 *           the evidence, which is where the answer's tables and its follow-up
 *           chips come from;
 *   delta → append (batched, see FLUSH_MS) so the answer types out live;
 *   done  → replace the accumulated text with the server's assembled answer and
 *           drop the caret;
 *   error → render as ordinary assistant text. A 400 for a vague question is
 *           deliberate guidance, and it must never look like a crash.
 *
 * Nothing here depends on the stream working. If the request fails, if the reply
 * is not an event stream, or if the body cannot be read, the same question is
 * re-sent as the plain JSON request the product already ran on, and the answer
 * lands whole. Content is never left permanently invisible.
 */

/** Signature "bloom" curve: fast out of the gate, long soft settle. */
export const BLOOM_EASE = [0.16, 1, 0.3, 1];

/**
 * How often buffered deltas are written to state (ms).
 *
 * Groq sends a frame per token, which is tens of state updates a second — each
 * one re-rendering the transcript and re-parsing the answer's blocks. Buffering
 * into one update every ~50ms is still well under the eye's threshold for
 * "typing" and keeps a 700-token answer smooth instead of stuttering.
 */
const FLUSH_MS = 50;

/**
 * How close to the bottom still counts as following along (px).
 *
 * Auto-scroll only happens inside this band. Someone who has scrolled up to
 * re-read the top of an answer is reading, and yanking them back down mid-stream
 * is the single rudest thing a streaming transcript can do.
 */
const STICK_SLACK_PX = 96;

/** Shown when a reply arrives with no answer text in it at all. */
const EMPTY_ANSWER = "I did not get an answer back for that one. Try asking it a different way.";

/** Shown when the response is unreadable (HTML error page, truncated body, …). */
const UNKNOWN_ERROR = "Something went wrong on my side. Try that again in a moment.";

/** Shown when the request never reached the route at all (offline, DNS, TLS). */
const NETWORK_ERROR = "I could not reach the chain just now. Check your connection and try again.";

/**
 * Default prompts — what the landing overlay opens on, since it passes none of
 * its own. Labels short so the row wraps on narrow screens; the `question` is
 * what actually gets sent, which is why a two-word chip can carry a real
 * contract address. Both addresses are live (a known NVDA impostor, and the
 * issuer wallet behind the official equity tokens), so a press returns an answer
 * rather than a lookup failure on a placeholder.
 *
 * They read like a terminal rather than a tutorial: the audience already trades
 * on-chain, and "Why did this token move?" against no target was neither.
 *
 * The glyphs are components rather than emoji so they inherit `currentColor`
 * and can tint with the chip on hover.
 */
const DEFAULT_SUGGESTIONS = [
  {
    Icon: IconTrend,
    text: "Price a ticker",
    question: "NVDA — price, market cap, holders and top-10 concentration.",
  },
  {
    Icon: IconRank,
    text: "Top by market cap",
    question: "Top 10 stock tokens by market cap.",
  },
  {
    Icon: IconShield,
    text: "Verify a contract",
    question: "Is the NVDA token at 0x465834D5BA3af2169E49B70A139448e59e3CA492 the official one?",
  },
  {
    Icon: IconWallet,
    text: "Read a wallet",
    question: "What is 0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046 and what has it been doing?",
  },
];

/**
 * Accepts `["a", "b"]`, `[{ icon, text }]` (legacy emoji form) or
 * `[{ Icon, text, question }]` and normalises to one object shape, so callers can
 * pass the simplest thing that works and the chip renderer stays branch-light.
 *
 * `question` is what gets asked when the chip is pressed; it defaults to the
 * label. That split is what lets a chip read "Check it is genuine" while sending
 * a full question with a real contract address in it.
 */
function normalizeSuggestions(list) {
  const source = Array.isArray(list) && list.length > 0 ? list : DEFAULT_SUGGESTIONS;
  const out = [];
  for (let i = 0; i < source.length; i += 1) {
    const item = source[i];
    if (typeof item === "string") {
      const text = item.trim();
      if (text) out.push({ Icon: null, icon: "", text, question: text });
    } else if (item && typeof item.text === "string") {
      const text = item.text.trim();
      if (text) {
        const question = typeof item.question === "string" ? item.question.trim() : "";
        out.push({
          Icon: typeof item.Icon === "function" ? item.Icon : null,
          icon: typeof item.icon === "string" ? item.icon : "",
          text,
          question: question || text,
        });
      }
    }
  }
  return out;
}

/** Local-clock greeting. Never called during render — see AskGreeting's effect. */
function timeGreeting(hour) {
  if (hour < 12) return "Good morning!";
  if (hour < 18) return "Good afternoon!";
  return "Good evening!";
}

/**
 * The greeting headline both surfaces open on.
 *
 * Passed to Conversation as its `greeting`, so it lives in the empty state and
 * disappears the moment a transcript exists. The line is neutral on the server
 * and on the first client render — the time-aware version is swapped in from an
 * effect, so SSR and hydration markup agree.
 *
 * @param {Object} props
 * @param {string} [props.name="ChainMind"] Name the assistant introduces itself with.
 * @param {string} [props.as="h2"] Heading tag. The overlay is a dialog inside a
 *   page that already has an h1; the `/ask` page has none, so it passes "h1".
 * @returns {JSX.Element} The headline and its subtitle.
 */
export function AskGreeting({ name = "ChainMind", as: Heading = "h2" }) {
  const [greeting, setGreeting] = useState("Hello!");

  useEffect(() => {
    setGreeting(timeGreeting(new Date().getHours()));
  }, []);

  return (
    <div>
      <Heading className="text-center text-[clamp(2rem,5vw,3.25rem)] font-semibold leading-[1.08] text-cm-text">
        {greeting}
      </Heading>
      <p className="mx-auto mt-4 max-w-xl text-center text-lg text-cm-muted sm:text-xl">
        I am {name} — ask me anything about Robinhood Chain.
      </p>
    </div>
  );
}

/**
 * Router intents, rendered as a short human tag. Anything unmapped falls back to
 * the raw name with underscores opened up, so a new server intent still shows
 * something readable instead of vanishing.
 */
const INTENT_LABELS = {
  [INTENTS.EXPLAIN_TARGET]: "lookup",
  [INTENTS.COMPARE]: "compare",
  [INTENTS.RANK_STOCKS]: "ranking",
  [INTENTS.MARKET_OVERVIEW]: "market",
  [INTENTS.SAFETY_CHECK]: "safety",
  [INTENTS.EXPLAIN_CHAIN]: "chain",
  [INTENTS.SMALL_TALK]: "",
  // No tag, for the same reason small talk has none: nothing was looked up, so
  // there is no lookup to label and "conversation" would only be the product
  // narrating itself.
  [INTENTS.CONVERSATION]: "",
};

function intentLabel(intent) {
  if (typeof intent !== "string" || !intent || intent === INTENTS.UNKNOWN) return "";
  const mapped = INTENT_LABELS[intent];
  if (typeof mapped === "string") return mapped;
  return intent.replace(/_/g, " ");
}

/** Touch devices should never get an on-screen keyboard they did not ask for. */
function isCoarsePointer() {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches
    );
  } catch {
    return false;
  }
}

/**
 * Splits an answer into paragraph and bullet-list blocks.
 *
 * The model is prompted to answer in short "* " bullets, so raw asterisks would
 * read as broken punctuation. This is deliberately *not* markdown: only two
 * block kinds exist, no inline syntax is touched, and nothing new is installed.
 * Dashes are not treated as bullets — "- 4.2% today" is a real sentence opener
 * in this product, and mis-reading it as a list is worse than leaving it plain.
 *
 * @param {string} text Raw answer text.
 * @returns {Array<{type: "p", text: string}|{type: "ul", items: string[]}>} Blocks in order.
 */
function parseBlocks(text) {
  const lines = String(text == null ? "" : text).split("\n");
  const blocks = [];
  let para = [];
  let bullets = [];

  const flushPara = () => {
    if (para.length > 0) {
      blocks.push({ type: "p", text: para.join("\n") });
      para = [];
    }
  };
  const flushBullets = () => {
    if (bullets.length > 0) {
      blocks.push({ type: "ul", items: bullets });
      bullets = [];
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/\s+$/, "");
    const bullet = /^\s*[*•]\s+(.+)$/.exec(line);
    if (bullet) {
      flushPara();
      bullets.push(bullet[1]);
      continue;
    }
    flushBullets();
    // A blank line ends the paragraph instead of joining into it, so the model's
    // own spacing survives without stacking empty <p> elements.
    if (!line.trim()) {
      flushPara();
      continue;
    }
    para.push(line);
  }
  flushBullets();
  flushPara();
  return blocks;
}

/**
 * A bullet marker that has arrived without its text yet.
 *
 * Mid-stream, "\n* " exists for one flush before the words behind it do, and
 * parseBlocks would render that instant as a paragraph containing a lone
 * asterisk. Held back until there is something to bullet.
 */
function trimDanglingBullet(text) {
  return String(text == null ? "" : text).replace(/(?:^|\n)[ \t]*[*•][ \t]*$/, "");
}

/**
 * The streaming cursor. Sits at the very end of the text and vanishes on `done`.
 *
 * Under reduced motion it is a static block rather than a blinking one — the
 * caret still says "more is coming", it just does not flash to say it.
 *
 * @param {Object} props
 * @param {boolean} props.reduce Whether motion is unwelcome.
 * @returns {JSX.Element} The caret.
 */
function Caret({ reduce }) {
  const shape = "ml-0.5 inline-block h-[0.95em] w-[2px] translate-y-[0.14em] rounded-sm bg-cm-accent";
  if (reduce) return <span aria-hidden="true" className={shape} />;
  return (
    <motion.span
      aria-hidden="true"
      className={shape}
      animate={{ opacity: [1, 0.15, 1] }}
      transition={{ duration: 1, ease: "easeInOut", repeat: Infinity }}
    />
  );
}

/**
 * Renders one assistant answer: plain paragraphs with newlines preserved, plus
 * simple bullet runs promoted to a real list.
 *
 * @param {Object} props
 * @param {string} props.text The answer body.
 * @param {string} [props.className] Classes for the wrapper (colour, size).
 * @param {React.ReactNode} [props.caret] Rendered inside the LAST block, so the
 *   cursor follows the text instead of sitting on its own line below it.
 * @returns {JSX.Element} The formatted answer.
 */
function AnswerBody({ text, className = "", caret = null }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);

  if (blocks.length === 0) {
    return (
      <p className={`whitespace-pre-wrap break-words ${className}`}>
        {text}
        {caret}
      </p>
    );
  }

  const last = blocks.length - 1;

  return (
    <div className={className}>
      {blocks.map((block, index) =>
        block.type === "ul" ? (
          <ul key={`b-${index}`} className="my-2.5 space-y-1.5 first:mt-0 last:mb-0">
            {block.items.map((item, itemIndex) => (
              <li key={`i-${itemIndex}`} className="flex gap-2.5">
                <span
                  aria-hidden="true"
                  className="mt-[0.6em] h-1 w-1 shrink-0 rounded-full bg-cm-accent"
                />
                <span className="min-w-0 whitespace-pre-wrap break-words">
                  {item}
                  {index === last && itemIndex === block.items.length - 1 ? caret : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p key={`b-${index}`} className="my-2.5 whitespace-pre-wrap break-words first:mt-0 last:mb-0">
            {block.text}
            {index === last ? caret : null}
          </p>
        ),
      )}
    </div>
  );
}

/** The assistant's mark. Sits beside every reply and beside the thinking dots. */
function AssistantAvatar() {
  return (
    <span
      aria-hidden="true"
      className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-cm-elevated text-cm-accent ring-1 ring-cm-accent-ring"
    >
      <IconSparkle size={14} />
    </span>
  );
}

/**
 * The glyph a follow-up chip asks for, by the name lib/follow-ups.js uses. Kept
 * as a map rather than baked into the chip data so the derivation stays a pure
 * server-safe module with no React in it.
 */
const FOLLOW_UP_ICONS = {
  table: IconTable,
  wallet: IconWallet,
  shield: IconShield,
  rank: IconRank,
  compare: IconCompare,
  trend: IconTrend,
};

/**
 * The chips offered under a settled answer.
 *
 * Every one of them is derived from what the answer actually contained — see
 * lib/follow-ups.js — so this only draws them. Rendered as buttons in a group
 * rather than as a list: they are actions, and a press sends the question
 * immediately rather than filling the composer, because a follow-up the reader
 * then has to press Enter on is two gestures for one intention.
 *
 * @param {Object} props
 * @param {Array<{id: string, icon: string, text: string, question: string}>} props.items
 * @param {(question: string) => void} props.onPick
 * @param {boolean} props.reduce
 * @returns {JSX.Element|null}
 */
function FollowUps({ items, onPick, reduce }) {
  if (!items.length) return null;
  return (
    <motion.div
      role="group"
      aria-label="Follow-up questions"
      className="mt-3.5 flex flex-wrap gap-2"
      // Fades in from a LEGIBLE opacity, not from zero — the same rule
      // ThinkingStatus states for its phrase. These chips are the only thing
      // offering the next question, and an animation that never runs must leave
      // them dim rather than leave them invisible.
      initial={reduce ? { opacity: 1 } : { opacity: 0.35, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0 } : { duration: 0.28, ease: BLOOM_EASE, delay: 0.08 }}
    >
      {items.map((item) => {
        const Icon = FOLLOW_UP_ICONS[item.icon] ?? null;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onPick(item.question)}
            title={item.question}
            className="group flex items-center gap-1.5 rounded-full border border-cm-border-subtle bg-cm-surface px-3 py-1.5 text-[13px] text-cm-muted transition hover:border-cm-border hover:text-cm-text"
          >
            {Icon ? (
              <Icon size={13} className="shrink-0 text-cm-faint transition-colors group-hover:text-cm-accent" />
            ) : null}
            <span>{item.text}</span>
          </button>
        );
      })}
    </motion.div>
  );
}

/* --------------------------- clarification options --------------------------- */

/**
 * How many options a clarification may show. The server already caps at four
 * (lib/ask-tools.js MAX_CLARIFY_OPTIONS); this is the client refusing to trust
 * the wire, which it has to, because the JSON fallback path, an older deployment
 * and a proxy that rewrote the body all reach this function too.
 */
const MAX_CLARIFY_OPTIONS = 4;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The `{ question, options }` block out of a response's evidence, or null.
 *
 * Two shapes, and the second one is defensive. A clarification returns its
 * evidence bare, because lib/ask-loop.js runs the tool alone; but evidence keyed
 * by tool name is what several lookups in one turn produce, and an older
 * deployment, a proxy that rewrote the body or any future turn that does key it
 * would put the block one level down. Missing that case would silently drop a
 * question the assistant has already asked in its prose, leaving the reader a
 * question with no way to answer it.
 */
function clarificationBlock(evidence) {
  if (!isPlainObject(evidence)) return null;
  if (Array.isArray(evidence.options)) return evidence;
  const nested = evidence.ask_clarification;
  return isPlainObject(nested) && Array.isArray(nested.options) ? nested : null;
}

/**
 * The options one assistant message is offering, as chips.
 *
 * `label` is what gets SENT — verbatim, as the reader's next question — so an
 * entry without a usable one is dropped rather than rendered as a blank button.
 * A message with no options at all yields `[]`, and the caller draws nothing:
 * the question itself is ordinary answer text and has already been rendered, so
 * a clarification that arrives empty degrades to a question the reader can just
 * answer in the composer.
 *
 * @param {object} message
 * @returns {Array<{id: string, label: string, hint: string}>}
 */
function clarificationOptions(message) {
  if (!message || message.role !== "assistant") return [];
  const block = clarificationBlock(message.evidence);
  if (!block) return [];
  // `kind` is the server's own word for the turn; the options array standing
  // alone is accepted too, so a reply that lost its kind still works.
  if (message.kind !== "clarification" && !Array.isArray(block.options)) return [];

  const out = [];
  const seen = new Set();
  for (const entry of block.options) {
    const label =
      typeof entry === "string"
        ? entry.trim()
        : isPlainObject(entry) && typeof entry.label === "string"
          ? entry.label.trim()
          : "";
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `${message.id}:${out.length}`,
      label,
      hint: isPlainObject(entry) && typeof entry.hint === "string" ? entry.hint.trim() : "",
    });
    if (out.length >= MAX_CLARIFY_OPTIONS) break;
  }
  return out;
}

/**
 * The readings offered under a clarification, as pressable questions.
 *
 * Deliberately shaped like the follow-up chips rather than like a modal: same
 * border, surface and hover tokens, sitting in the transcript under the question
 * that prompted them, because this IS the conversation continuing and not a
 * dialog interrupting it. They stack rather than wrap — each label is a whole
 * question and can carry a hint beneath it, which a pill in a wrapping row
 * cannot hold without truncating the thing the reader is being asked to choose.
 *
 * `disabled` is the stale guard. Once one has been pressed, and for every
 * clarification that is no longer the newest turn, the set stops being pressable
 * so a question from four turns ago cannot be fired into the middle of a
 * different thread. They stay VISIBLE — the transcript should still show what
 * was asked — just inert.
 *
 * @param {Object} props
 * @param {Array<{id: string, label: string, hint: string}>} props.items
 * @param {(label: string) => void} props.onPick
 * @param {boolean} props.disabled
 * @param {boolean} props.reduce
 * @returns {JSX.Element|null}
 */
function ClarifyOptions({ items, onPick, disabled, reduce }) {
  if (!items.length) return null;
  return (
    <motion.div
      role="group"
      aria-label="Ways to read that question"
      className="mt-3.5 flex flex-col items-start gap-2"
      // From a legible opacity, never from zero: these chips are the only way to
      // answer the question above them, and an animation that fails to run must
      // leave them dim rather than leave them invisible.
      initial={reduce ? { opacity: 1 } : { opacity: 0.35, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0 } : { duration: 0.28, ease: BLOOM_EASE, delay: 0.08 }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          disabled={disabled}
          onClick={() => onPick(item.label)}
          className="group flex max-w-full items-start gap-2 rounded-2xl border border-cm-border-subtle bg-cm-surface px-3.5 py-2 text-left text-[13px] text-cm-muted transition hover:border-cm-border hover:text-cm-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-accent disabled:cursor-default disabled:opacity-45 disabled:hover:border-cm-border-subtle disabled:hover:text-cm-muted"
        >
          <IconSend
            size={13}
            className="mt-[0.2em] shrink-0 text-cm-faint transition-colors group-hover:text-cm-accent"
          />
          <span className="min-w-0">
            <span className="block break-words">{item.label}</span>
            {item.hint ? <span className="mt-0.5 block break-words text-cm-faint">{item.hint}</span> : null}
          </span>
        </button>
      ))}
    </motion.div>
  );
}

/** POST one question. `stream` picks the SSE reply over the JSON one. */
function askRequest(question, stream, signal) {
  return fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(stream ? { question, stream: true } : { question }),
    signal,
  });
}

/**
 * Re-broadcast the caller's standing, which the gate attaches to every reply.
 *
 * The numbers come from the server on the very request that changed them (see
 * lib/ask-access.js quotaHeaders), so the header widget updates without polling
 * — and without this component knowing anything about wallets. A reply with no
 * quota headers (an older deploy, a proxy that strips them) broadcasts nothing at
 * all rather than a guess: a missing figure must not arrive as a zero.
 *
 * @param {Response} res
 */
function announceQuota(res) {
  try {
    const state = res.headers.get("x-quota-state");
    if (!state) return;
    const limit = res.headers.get("x-quota-limit");
    const remaining = res.headers.get("x-quota-remaining");
    window.dispatchEvent(
      new CustomEvent("chainmind:quota", {
        detail: {
          state,
          unlimited: limit === "unlimited",
          limit: limit && limit !== "unlimited" ? Number(limit) : null,
          remaining: remaining == null ? null : Number(remaining),
          resetsAt: res.headers.get("x-quota-reset"),
          degraded: res.headers.get("x-quota-degraded") === "1",
        },
      }),
    );
  } catch {
    /* headers unreadable, or no CustomEvent: the panel still has /api/quota */
  }
}

/**
 * Read one SSE body to the end, handing each parsed event to `onEvent`.
 *
 * `reader.cancel()` in `finally` is what releases the socket, and it runs on
 * every exit: a normal end, the `[DONE]` latch, and an abort throwing out of
 * `read()`. Decoding with `{ stream: true }` matters — a multi-byte character
 * can straddle two network chunks, and decoding each independently would turn
 * every Spanish or French answer into mojibake.
 *
 * @param {ReadableStream} body
 * @param {(event: object) => void} onEvent
 */
async function readEvents(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();

  const drain = (events) => {
    for (let i = 0; i < events.length; i += 1) onEvent(events[i]);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text) drain(parser.push(text));
      if (parser.done) break;
    }
    if (!parser.done) {
      const tail = decoder.decode();
      if (tail) drain(parser.push(tail));
      // A body that closed one byte early still left a whole line behind.
      drain(parser.flush());
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed: nothing to release */
    }
  }
}

/**
 * Settle every message left mid-stream, and drop the ones with nothing in them.
 *
 * Called whenever a new question supersedes an older one. A cancelled stream
 * must not leave a half message with a caret stuck blinking on it forever, and
 * an assistant bubble that never received a word is not worth keeping at all.
 */
function settleStale(list) {
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const message = list[i];
    if (!message.streaming) {
      out.push(message);
      continue;
    }
    if (!String(message.text ?? "").trim()) continue;
    out.push({ ...message, streaming: false });
  }
  return out;
}

/**
 * Conversation — the shared ask surface.
 *
 * @param {Object} props
 * @param {Array<string|{icon?: string, Icon?: Function, text: string, question?: string}>} [props.suggestions]
 *   Chip prompts for the empty state; falls back to a built-in set when omitted.
 * @param {React.ReactNode} [props.greeting] Rendered above the chips while the
 *   transcript is empty, and gone the moment it is not.
 * @param {React.ReactNode} [props.note] A quiet line under the chips — used by
 *   the `?q=` handoff to explain a question it could not route.
 * @param {React.ReactNode} [props.footer] Rendered below the composer (the
 *   overlay's "Open full page" line lives here).
 * @param {boolean} [props.autoFocus=false] Focus the composer on mount. Ignored
 *   on coarse pointers so touch devices do not get an unrequested keyboard.
 * @param {number} [props.autoFocusDelay=0] ms to wait first, so the focus does
 *   not land in the middle of a panel's entrance animation.
 * @param {string} [props.className] Classes for the flex column wrapper.
 * @param {(text: string) => void} [props.onFirstMessage] Called once, with the
 *   first question asked — the signal a host uses to retire its own intro.
 * @param {(text: string) => void} [props.onSend] Called with every question.
 * @param {(api: {ask: (text: string) => void, prefill: (text: string) => void}) => void} [props.onReady]
 *   Called once after mount with a handle on the conversation, which is how the
 *   `/ask` page replays a `?q=` handoff into a surface it does not own.
 * @returns {JSX.Element} The transcript, the composer and everything between.
 */
export default function Conversation({
  suggestions,
  greeting = null,
  note = null,
  footer = null,
  autoFocus = false,
  autoFocusDelay = 0,
  className = "",
  onFirstMessage,
  onSend,
  onReady,
}) {
  const reduce = useReducedMotion() ?? false;

  const [value, setValue] = useState("");
  const [messages, setMessages] = useState([]);
  const [pending, setPending] = useState(false);
  // The latest `progress` event, or null when none has arrived for this request —
  // which is the normal case for the JSON fallback and for an older deployment.
  // One piece of state, not one per message: only one request is ever in flight.
  const [status, setStatus] = useState(null);

  const inputRef = useRef(null);
  const listRef = useRef(null);

  // Callbacks through refs: a host that re-creates them inline must not be able
  // to re-run effects or invalidate `send`.
  const firstRef = useRef(onFirstMessage);
  const sendNotifyRef = useRef(onSend);
  const readyRef = useRef(onReady);
  firstRef.current = onFirstMessage;
  sendNotifyRef.current = onSend;
  readyRef.current = onReady;

  // One controller per in-flight request, one monotonic sequence number to
  // decide which reply is still wanted, and a mounted flag so nothing sets
  // state after teardown.
  const abortRef = useRef(null);
  const seqRef = useRef(0);
  const mountedRef = useRef(true);
  const idRef = useRef(0);
  const askedRef = useRef(false);

  // Whether the reader is following along at the bottom of the transcript.
  const stickRef = useRef(true);

  // The question currently being answered, and one an unmount took away. React
  // StrictMode unmounts and remounts a component with its state intact, which
  // aborts a request the transcript is still waiting for: without these the
  // thinking dots would spin forever under a `?q=` handoff in development.
  const inFlightRef = useRef(null);
  const resumeRef = useRef(null);

  // The delta buffer: which message it belongs to, which request produced it,
  // the text not yet written to state, and the timer that will write it.
  const writerRef = useRef({ id: 0, seq: 0, text: "", timer: null });

  const chips = useMemo(() => normalizeSuggestions(suggestions), [suggestions]);
  const hasConversation = messages.length > 0 || pending;
  const streamingNow = messages.some((message) => message.streaming);

  // Mount flag, and the last line of defence: whatever is in flight, and
  // whatever is buffered to be flushed, dies with the component.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // An unanswered question is worth resuming if this turns out to have been
      // a remount rather than a teardown; see the resume effect below.
      resumeRef.current = inFlightRef.current;
      if (abortRef.current) abortRef.current.abort();
      abortRef.current = null;
      const writer = writerRef.current;
      if (writer.timer) clearTimeout(writer.timer);
      writer.timer = null;
      writer.text = "";
    };
  }, []);

  /** Is this request still the one whose answer is wanted? */
  const live = useCallback((seq) => mountedRef.current && seq === seqRef.current, []);

  const clearFlush = useCallback(() => {
    const writer = writerRef.current;
    if (writer.timer) clearTimeout(writer.timer);
    writer.timer = null;
  }, []);

  /** Write everything buffered into its message, in ONE state update. */
  const flushWriter = useCallback(() => {
    const writer = writerRef.current;
    if (writer.timer) clearTimeout(writer.timer);
    writer.timer = null;
    const chunk = writer.text;
    writer.text = "";
    if (!chunk || !live(writer.seq)) return;
    const id = writer.id;
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text: m.text + chunk } : m)));
  }, [live]);

  /** Buffer one delta; the timer is what turns a token storm into ~20 renders/s. */
  const pushDelta = useCallback(
    (seq, id, text) => {
      if (!text || !live(seq)) return;
      const writer = writerRef.current;
      writer.seq = seq;
      writer.id = id;
      writer.text += text;
      if (!writer.timer) writer.timer = setTimeout(flushWriter, FLUSH_MS);
    },
    [flushWriter, live],
  );

  const focusInput = useCallback(() => {
    if (isCoarsePointer()) return;
    const node = inputRef.current;
    if (node && typeof node.focus === "function") node.focus();
  }, []);

  /** Add a finished assistant message (the non-streaming paths). */
  const appendAssistant = useCallback((message) => {
    idRef.current += 1;
    const id = idRef.current;
    setPending(false);
    // The answer is here, so there is nothing left to say about the wait.
    setStatus(null);
    setMessages((prev) =>
      settleStale(prev).concat({
        id,
        role: "assistant",
        text: "",
        intent: "",
        tables: [],
        evidence: null,
        toolCalls: [],
        kind: null,
        target: null,
        research: null,
        ...message,
      }),
    );
  }, []);

  /** Render a `{ ok, … }` / `{ ok: false, error }` JSON reply as one message. */
  const renderJson = useCallback(
    (res, data, seq) => {
      announceQuota(res);
      if (!live(seq)) return;
      if (res.ok && data && data.ok) {
        const answer = String(data.answer == null ? "" : data.answer).trim();
        appendAssistant({
          text: answer || EMPTY_ANSWER,
          intent: intentLabel(data.intent),
          // The JSON reply carries the same evidence the stream's `meta` does, so
          // the fallback path gets its tables and its follow-ups too.
          tables: collectTables(data.evidence),
          evidence: data.evidence ?? null,
          toolCalls: Array.isArray(data.toolCalls) ? data.toolCalls : [],
          kind: typeof data.kind === "string" ? data.kind : null,
          target: typeof data.target === "string" ? data.target : null,
          // A deep investigation the server started (or explained why it did not) for
          // this question. It is not part of the answer and never changes it.
          research: isPlainObject(data.research) ? data.research : null,
          ...(answer ? {} : { error: true }),
        });
        return;
      }
      // A 400 here is usually deliberate guidance ("name a ticker…"), not a
      // crash, so every failure reads as an ordinary, quieter reply.
      const message =
        data && typeof data.error === "string" && data.error.trim() ? data.error.trim() : UNKNOWN_ERROR;
      appendAssistant({ text: message, error: true });
    },
    [appendAssistant, live],
  );

  /**
   * The streaming attempt.
   *
   * @returns {Promise<"answered"|"aborted"|"retry">} "retry" means nothing
   *   usable reached the screen and the plain JSON request should be tried.
   */
  const runStream = useCallback(
    async (question, seq, controller) => {
      let assistantId = 0;
      let started = false; // the assistant message exists
      let delivered = 0; // characters of answer handed over
      let finished = false; // done or error already rendered
      let statusCleared = false; // the waiting row has already been taken down
      /**
       * The investigation block, which can arrive BEFORE the assistant message exists.
       *
       * The server sends it the moment the submission settles and never waits for the
       * answer, so on a slow first token it genuinely does arrive first. Holding it here
       * and applying it whenever the message appears is what stops that ordering from
       * dropping it on the floor.
       */
      let research = null;

      /** Attach the block to this turn, whenever both halves exist. */
      const applyResearch = () => {
        if (!research || !started || !live(seq)) return;
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, research } : m)));
      };

      /** Create the assistant message. Called by `meta`, or by the first delta. */
      const ensure = (meta) => {
        if (started || !live(seq)) return;
        started = true;
        idRef.current += 1;
        assistantId = idRef.current;
        const intent = intentLabel(meta && meta.intent);
        // The tag and the avatar appear before any text does, so the turn is
        // labelled while it is still being written. The evidence arrives on the
        // same event, which is what lets the table and the follow-up chips be
        // built from data rather than from the prose.
        setPending(false);
        setMessages((prev) =>
          settleStale(prev).concat({
            id: assistantId,
            role: "assistant",
            text: "",
            intent,
            streaming: true,
            tables: collectTables(meta && meta.evidence),
            evidence: (meta && meta.evidence) ?? null,
            toolCalls: Array.isArray(meta && meta.toolCalls) ? meta.toolCalls : [],
            kind: typeof (meta && meta.kind) === "string" ? meta.kind : null,
            target: typeof (meta && meta.target) === "string" ? meta.target : null,
            research,
          }),
        );
      };

      /** End the stream on this message: flush the tail, drop the caret. */
      const settle = (finalText, isError) => {
        flushWriter();
        if (!live(seq)) return;
        // Belt and braces for an answer that finished without a single delta.
        setStatus(null);
        if (!started) return;
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== assistantId) return m;
            const raw = typeof finalText === "string" && finalText ? finalText : m.text;
            const empty = !String(raw ?? "").trim();
            return {
              ...m,
              text: empty ? EMPTY_ANSWER : raw,
              streaming: false,
              error: Boolean(m.error) || isError || empty,
            };
          }),
        );
      };

      /**
       * Nothing arrived: take the empty bubble back off the screen.
       *
       * A bubble that DID receive words is never discarded — a partial answer is
       * the reply, exactly as the server treats one.
       */
      const discard = () => {
        clearFlush();
        writerRef.current.text = "";
        // Whatever the stream had been reporting is over. The JSON retry that
        // follows emits no progress at all, and a phrase left behind from the
        // abandoned attempt would be describing work nobody is doing.
        if (live(seq)) setStatus(null);
        if (!started || delivered > 0) return;
        started = false;
        if (!live(seq)) return;
        setMessages((prev) => prev.filter((m) => m.id !== assistantId));
      };

      const onEvent = (event) => {
        const type = event && typeof event.type === "string" ? event.type : "";
        if (type === "progress") {
          // What is being read, right now. A malformed one is dropped rather than
          // shown as a blank row: ThinkingStatus falls back to the dots for it.
          const step = typeof event.step === "string" ? event.step.trim() : "";
          if (!step || !live(seq)) return;
          setStatus({ step, label: typeof event.label === "string" ? event.label.trim() : "" });
          return;
        }
        if (type === "meta") {
          ensure(event);
          return;
        }
        if (type === "research") {
          // Its own frame rather than a field on `meta`, because it settles on a
          // different clock: the answer must never wait for it, so it cannot be part of
          // the event that opens the answer.
          research = isPlainObject(event.block) ? event.block : null;
          applyResearch();
          return;
        }
        if (type === "delta") {
          const text = typeof event.text === "string" ? event.text : "";
          if (!text) return;
          ensure(null);
          // The answer has started, so the status row's job is over — and it goes
          // on the first delta, not on `done`, so the phrase is never left sitting
          // under text that is already arriving. Once, not per delta.
          if (!statusCleared) {
            statusCleared = true;
            if (live(seq)) setStatus(null);
          }
          delivered += text.length;
          pushDelta(seq, assistantId, text);
          return;
        }
        if (type === "done") {
          ensure(null);
          const answer = typeof event.answer === "string" ? event.answer.trim() : "";
          // The server's assembled answer wins over the accumulated one: it is
          // the same text, and taking it closes any gap a dropped frame left.
          settle(answer, false);
          finished = true;
          return;
        }
        if (type === "error") {
          ensure(null);
          const text =
            typeof event.error === "string" && event.error.trim() ? event.error.trim() : UNKNOWN_ERROR;
          // Words already delivered ARE the answer; the failure only ends it.
          settle(delivered > 0 ? "" : text, delivered === 0);
          finished = true;
        }
      };

      let res;
      try {
        res = await askRequest(question, true, controller.signal);
      } catch (e) {
        if (e && e.name === "AbortError") return "aborted";
        // Offline, blocked, or a proxy that hates event streams. The plain
        // request reports it in the one place the user is looking.
        return "retry";
      }

      announceQuota(res);

      const contentType = String(res.headers.get("content-type") ?? "").toLowerCase();

      // A guard rejected this before the streaming branch was reached (415, 403,
      // 429, 400): the body is the same JSON it always was, and it is an answer.
      if (!contentType.includes("text/event-stream")) {
        if (!contentType.includes("application/json")) return "retry";
        const data = await res.json().catch(() => null);
        if (!data) return "retry";
        renderJson(res, data, seq);
        return "answered";
      }

      if (!res.body || typeof res.body.getReader !== "function") return "retry";

      try {
        await readEvents(res.body, onEvent);
      } catch (e) {
        if ((e && e.name === "AbortError") || controller.signal.aborted) {
          discard();
          return "aborted";
        }
        if (finished) return "answered";
        if (delivered > 0) {
          settle("", false);
          return "answered";
        }
        discard();
        return "retry";
      }

      if (controller.signal.aborted) {
        discard();
        return "aborted";
      }
      if (finished) return "answered";
      // The socket closed without a terminator. Whatever arrived still stands.
      if (delivered > 0) {
        settle("", false);
        return "answered";
      }
      discard();
      return "retry";
    },
    [clearFlush, flushWriter, live, pushDelta, renderJson],
  );

  /** The plain JSON request — the fallback, and the shape this route always had. */
  const runJson = useCallback(
    async (question, seq, controller) => {
      let res;
      let data;
      try {
        res = await askRequest(question, false, controller.signal);
        data = await res.json().catch(() => null);
      } catch (e) {
        if (e && e.name === "AbortError") return;
        if (!live(seq)) return;
        appendAssistant({ text: NETWORK_ERROR, error: true });
        return;
      }
      renderJson(res, data, seq);
    },
    [appendAssistant, live, renderJson],
  );

  /**
   * Ask one question.
   *
   * `resume` re-issues a question whose request an unmount aborted: the turn is
   * already in the transcript and the hosts have already been notified, so it
   * repeats the REQUEST and nothing else.
   */
  const send = useCallback(
    async (text, resume = false) => {
      const trimmed = String(text == null ? "" : text).trim();
      if (!trimmed) return;

      if (!resume) {
        if (typeof sendNotifyRef.current === "function") sendNotifyRef.current(trimmed);
        if (!askedRef.current) {
          askedRef.current = true;
          if (typeof firstRef.current === "function") firstRef.current(trimmed);
        }
      }

      // Supersede anything still running. The abort covers a request still on
      // the wire; the sequence bump covers one that already resolved and is
      // waiting to render, so a slow answer can never overwrite a newer one.
      if (abortRef.current) abortRef.current.abort();
      clearFlush();
      writerRef.current = { id: 0, seq: 0, text: "", timer: null };
      // A superseded request's last phrase must not describe the new one's wait.
      setStatus(null);
      seqRef.current += 1;
      const seq = seqRef.current;
      const controller = new AbortController();
      abortRef.current = controller;

      inFlightRef.current = trimmed;
      if (resume) {
        // Nothing to add: the question is already on screen. Anything the
        // aborted attempt left mid-stream is settled so it cannot keep a caret.
        setMessages((prev) => settleStale(prev));
      } else {
        idRef.current += 1;
        const userId = idRef.current;
        setValue("");
        setMessages((prev) => settleStale(prev).concat({ id: userId, role: "user", text: trimmed }));
        focusInput();
      }
      setPending(true);
      // They just asked, so they want the answer: follow it again even if they
      // had scrolled away from the bottom of the last one.
      stickRef.current = true;

      const outcome = await runStream(trimmed, seq, controller);
      if (outcome === "retry") await runJson(trimmed, seq, controller);
      // An abort is either a supersede (a newer request owns everything now) or
      // an unmount (the resume effect owns it). Either way, hands off.
      if (outcome === "aborted") return;

      if (!mountedRef.current) return;
      if (abortRef.current === controller) abortRef.current = null;
      if (seq === seqRef.current) {
        inFlightRef.current = null;
        setPending(false);
      }
    },
    [clearFlush, focusInput, runJson, runStream],
  );

  // A stable handle, handed over once. `send` is stable too, but going through
  // the ref means a host can hold this object for the component's whole life.
  const sendRef = useRef(send);
  sendRef.current = send;

  // A question whose request died with a previous mount. Re-issued rather than
  // re-asked, so the transcript does not grow a duplicate of it.
  useEffect(() => {
    const question = resumeRef.current;
    resumeRef.current = null;
    if (question) sendRef.current(question, true);
  }, []);

  const readyFiredRef = useRef(false);
  useEffect(() => {
    if (readyFiredRef.current) return;
    readyFiredRef.current = true;
    const notify = readyRef.current;
    if (typeof notify !== "function") return;
    notify({
      ask: (text) => sendRef.current(text),
      prefill: (text) => setValue(String(text == null ? "" : text)),
    });
  }, []);

  const handleFormSubmit = useCallback(
    (event) => {
      event.preventDefault();
      send(value);
    },
    [send, value],
  );

  // Focus on mount, after any entrance animation has mostly settled.
  useEffect(() => {
    if (!autoFocus) return undefined;
    const timer = setTimeout(focusInput, Math.max(0, autoFocusDelay));
    return () => clearTimeout(timer);
  }, [autoFocus, autoFocusDelay, focusInput]);

  /** Track whether the reader is still at the bottom, per scroll. */
  const onListScroll = useCallback(() => {
    const node = listRef.current;
    if (!node) return;
    stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= STICK_SLACK_PX;
  }, []);

  /**
   * An upward wheel or trackpad gesture means "I am reading", and it says so
   * immediately — before the scroll event it causes has been dispatched, and even
   * when it causes none because the position is already at the top. Coming back
   * down to the bottom re-arms the follow through onListScroll above.
   */
  const onListWheel = useCallback((event) => {
    if (event && event.deltaY < 0) stickRef.current = false;
  }, []);

  // Follow the growing answer — but only for a reader who is already at the
  // bottom. Someone who scrolled up to re-read is reading; see STICK_SLACK_PX.
  //
  // The move is always instant, and deliberately so. A smooth scroll restarted
  // every FLUSH_MS fights itself and never reaches the end; worse, `behavior:
  // "smooth"` is compositor-driven and silently does nothing at all in some
  // contexts (measured: a pane that is not compositing frames leaves scrollTop
  // exactly where it was), which would strand the newest text off-screen behind
  // an animation that never ran. The easing that carries the feel here is the
  // message's own fade-in, which cannot hide content if it fails.
  useEffect(() => {
    if (!stickRef.current) return;
    const node = listRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages, pending, streamingNow]);

  /**
   * The follow-up chips, and which message they belong under.
   *
   * Only ever the NEWEST answer: chips under an older turn would send a question
   * about evidence the reader has scrolled past, and a transcript with four rows
   * of them is a menu rather than a conversation. Nothing is offered while a
   * request is in flight, or under an error — a failed lookup has no thread to
   * continue.
   */
  /**
   * The one clarification whose options may still be pressed: the newest turn's,
   * and only until it has been answered.
   *
   * Everything older renders inert (see ClarifyOptions' `disabled`), which is
   * what stops a stale set from being fired into the middle of a later thread —
   * pressing an option sends a user message, so the clarification stops being the
   * newest turn the moment one is chosen, and `clarified` covers the instant
   * before that state lands.
   */
  const activeClarifyId = useMemo(() => {
    if (pending || streamingNow) return 0;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant" || last.streaming || last.error || last.clarified) return 0;
    return clarificationOptions(last).length ? last.id : 0;
  }, [messages, pending, streamingNow]);

  /** Retire one clarification's options the moment one of them is pressed. */
  const pickClarification = useCallback(
    (id, label) => {
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, clarified: true } : m)));
      send(label);
    },
    [send],
  );

  const followUps = useMemo(() => {
    if (pending || streamingNow) return { id: 0, items: [] };
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant" || last.streaming || last.error) return { id: 0, items: [] };
    // A clarification's options ARE its follow-ups. Offering "Read the whole
    // board" beside "Who holds the most?" would answer the question we just
    // asked with a third thing nobody chose.
    if (clarificationOptions(last).length) return { id: 0, items: [] };
    return {
      id: last.id,
      items: buildFollowUps({
        kind: last.kind,
        target: last.target,
        evidence: last.evidence,
        toolCalls: last.toolCalls,
        tables: last.tables,
      }),
    };
  }, [messages, pending, streamingNow]);

  // Messages land already visible under reduced motion — nothing to un-hide.
  const msgInitial = reduce ? { opacity: 1 } : { opacity: 0, y: 8 };
  const msgAnimate = reduce ? { opacity: 1 } : { opacity: 1, y: 0 };
  /** Assistant turns trail their question slightly, so nothing pops in pairs. */
  const msgTransition = (role) =>
    reduce
      ? { duration: 0 }
      : { duration: 0.32, ease: BLOOM_EASE, delay: role === "assistant" ? 0.06 : 0 };

  return (
    <div className={`flex min-h-0 w-full flex-col ${className}`}>
      {hasConversation ? (
        // Transcript: the only scrolling region, so the composer below it stays
        // pinned and the surface behind it stays put.
        <div
          ref={listRef}
          onScroll={onListScroll}
          onWheel={onListWheel}
          // Scroll anchoring OFF. Chrome nudges scrollTop to keep an anchor
          // element visually still when content above it changes — and a
          // streaming answer changes constantly. Measured: it dragged a reader
          // who had scrolled up back to the bottom mid-answer, and the scroll
          // event it synthesised then re-armed the follow-along. The transcript's
          // scroll position has exactly one owner, and it is the effect below.
          style={{ overflowAnchor: "none" }}
          aria-live="polite"
          aria-busy={streamingNow || pending ? "true" : "false"}
          className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain pb-2 pr-1 sm:pr-2"
        >
          {messages.map((message) => {
            // Recomputed per render rather than stored on the message: it is a
            // read of at most four entries, and deriving it keeps one source of
            // truth for what the server actually sent.
            const clarifyOptions = clarificationOptions(message);
            return message.role === "user" ? (
              <motion.div
                key={message.id}
                className="flex justify-end"
                initial={msgInitial}
                animate={msgAnimate}
                transition={msgTransition("user")}
              >
                <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl border border-cm-border-subtle bg-cm-surface px-4 py-2.5 text-[15px] leading-relaxed text-cm-text">
                  {message.text}
                </div>
              </motion.div>
            ) : (
              <motion.div
                key={message.id}
                className="flex gap-3"
                initial={msgInitial}
                animate={msgAnimate}
                transition={msgTransition("assistant")}
              >
                <AssistantAvatar />
                <div className="min-w-0 flex-1">
                  {message.intent ? (
                    <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-cm-faint">
                      {message.intent}
                    </p>
                  ) : null}
                  {message.streaming && !String(message.text ?? "").trim() ? (
                    // Labelled, but not written yet. The status row stands in for
                    // the first word and is gone the instant it arrives.
                    <div className="flex min-h-[24px] items-center">
                      <ThinkingStatus status={status} reduce={reduce} />
                    </div>
                  ) : (
                    <AnswerBody
                      text={message.streaming ? trimDanglingBullet(message.text) : message.text}
                      caret={message.streaming ? <Caret reduce={reduce} /> : null}
                      className={`text-[15px] leading-relaxed ${
                        message.error ? "text-cm-muted" : "text-cm-subtle"
                      }`}
                    />
                  )}

                  {/* The rows the answer is about, under the prose that reads
                      them. Driven entirely by the columns descriptor, so a new
                      table-producing tool needs nothing here. */}
                  {message.tables && message.tables.length > 0
                    ? message.tables.map((table, index) => (
                        <AnswerTable key={`t-${message.id}-${table.id ?? index}`} table={table} />
                      ))
                    : null}

                  {/* The readings on offer, when the turn asked a question back
                      instead of answering one. Drawn from the evidence, so a
                      clarification that arrived with nothing usable in it leaves
                      just the question text rather than an empty chip row. */}
                  <ClarifyOptions
                    items={clarifyOptions}
                    onPick={(label) => pickClarification(message.id, label)}
                    disabled={message.id !== activeClarifyId}
                    reduce={reduce}
                  />

                  {/* The half of the answer that is not in this request: a deep
                      investigation that was started, or the reason one was not. Under the
                      answer because it does not change it — the chain half above stands
                      on its own whatever the job eventually reports. */}
                  {message.research ? <ResearchNotice block={message.research} /> : null}

                  {message.id === followUps.id ? (
                    <FollowUps items={followUps.items} onPick={send} reduce={reduce} />
                  ) : null}
                </div>
              </motion.div>
            );
          })}

          {pending ? (
            <div className="flex gap-3">
              <AssistantAvatar />
              <div className="flex min-h-[28px] items-center">
                <ThinkingStatus status={status} reduce={reduce} />
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        // Short by design, but it still scrolls rather than spilling out of the
        // surface on a very short viewport. `my-auto` is what lets the same
        // markup sit snug inside the overlay's content-height panel AND centre
        // itself in the free space of a full-page column.
        <div className="my-auto min-h-0 overflow-y-auto overscroll-contain">
          {greeting}

          <div className="mt-8 flex flex-wrap items-center justify-center gap-2 sm:gap-2.5">
            {chips.map((chip) => (
              <button
                key={chip.text}
                type="button"
                onClick={() => send(chip.question)}
                // The tint is an inline style rather than `bg-cm-surface/70`, and
                // the hover border is full strength rather than `/50`, because the
                // theme colours are bare `var(--cm-*)` with no `<alpha-value>`
                // slot: Tailwind cannot build an alpha channel from one, so it
                // emits NO RULE AT ALL for the slash form. Verified against a
                // utilities build — `bg-cm-surface/70` and `hover:border-cm-accent/50`
                // produced zero bytes, so these chips had no background and their
                // border never moved on hover despite the `transition` promising it.
                // color-mix keeps the token indirection that a hardcoded rgba
                // would throw away.
                style={{ backgroundColor: "color-mix(in srgb, var(--cm-surface) 70%, transparent)" }}
                className="group flex items-center gap-2 rounded-full border border-cm-border px-4 py-2 text-sm text-cm-subtle transition hover:border-cm-accent hover:text-cm-text"
              >
                {chip.Icon ? (
                  <chip.Icon
                    size={15}
                    className="shrink-0 text-cm-muted transition-colors group-hover:text-cm-accent"
                  />
                ) : chip.icon ? (
                  <span aria-hidden="true" className="text-[13px] leading-none">
                    {chip.icon}
                  </span>
                ) : null}
                <span>{chip.text}</span>
              </button>
            ))}
          </div>

          {note ? (
            <p className="mx-auto mt-6 max-w-xl text-center text-sm leading-relaxed text-cm-muted">
              {note}
            </p>
          ) : null}
        </div>
      )}

      <form
        onSubmit={handleFormSubmit}
        // Same dropped-alpha story as the chips above: `bg-cm-surface/60` built to
        // nothing, which left the composer as a bare outline over whatever the
        // page put behind it. The blur was doing all the work alone.
        style={{ backgroundColor: "color-mix(in srgb, var(--cm-surface) 60%, transparent)" }}
        className="mt-8 flex w-full shrink-0 items-center gap-3 rounded-2xl border border-cm-border px-5 py-4 backdrop-blur"
      >
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={hasConversation ? "Ask a follow-up" : "Ask anything about the chain"}
          aria-label="Ask anything about the chain"
          autoComplete="off"
          spellCheck="false"
          className="min-w-0 flex-1 bg-transparent text-cm-text outline-none placeholder:text-cm-faint"
        />
        <button
          type="submit"
          aria-label="Send"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cm-accent text-cm-on-accent transition hover:opacity-90 disabled:opacity-40"
          disabled={value.trim().length === 0}
        >
          <IconSend size={16} />
        </button>
      </form>

      {footer ? <div className="mt-5 shrink-0">{footer}</div> : null}
    </div>
  );
}
