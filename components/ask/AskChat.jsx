"use client";

import { useCallback, useRef, useState } from "react";
import Conversation, { AskGreeting } from "@/components/ask/Conversation";
import { INTENTS, classifyIntent, isSmallTalk } from "@/lib/ask-intent";
import {
  IconCompare,
  IconRank,
  IconShield,
  IconTrend,
  IconWallet,
} from "@/components/icons/AskIcons";

/**
 * AskChat — `/ask`, which is now the overlay's conversation on a full-bleed page.
 *
 * It used to be its own thing: a static grid of example cards, a separate
 * composer, a separate fetch, a separate message renderer, no streaming. The
 * overlay's footer link pointed here, which meant "open full page" traded the
 * good experience for the stiff one. So the transcript, the composer and the
 * streaming all come from components/ask/Conversation.jsx now, and this file is
 * what is genuinely page-specific: the layout, the greeting, the carried-over
 * example prompts, and the `?q=` handoff from the landing hero.
 *
 * The example cards are gone but their questions are not — they are the same
 * suggestion chips the overlay uses, with AskIcons glyphs instead of emoji.
 */

/**
 * The prompts the retired card grid carried, one per thing the router can do, so
 * nobody has to guess that a bare ranking question works. `text` is the chip
 * label; `question` is what actually gets asked. Both addresses are real — the
 * issuer wallet behind the official equity tokens, and a live NVDA impostor — so
 * a press produces a genuine answer rather than a lookup failure on a placeholder.
 */
const SUGGESTIONS = [
  {
    Icon: IconTrend,
    text: "Price a ticker",
    question: "How is NVDA trading on Robinhood Chain right now?",
  },
  {
    Icon: IconRank,
    text: "Rank the market",
    question: "Which five stock tokens have the most holders?",
  },
  {
    Icon: IconCompare,
    text: "Set two side by side",
    question: "Compare NVDA and TSLA on price and holder count.",
  },
  {
    Icon: IconShield,
    text: "Check it is genuine",
    question: "Is the NVDA token at 0x465834D5BA3af2169E49B70A139448e59e3CA492 the official one?",
  },
  {
    Icon: IconWallet,
    text: "Read a wallet",
    question: "What is 0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046 and what has it been doing?",
  },
];

/** Shown when a `?q=` handoff arrives as something the router cannot place. */
const HANDOFF_NOTE =
  "I could not tell what that one is asking for — it is in the box below, so edit it and send. Name a ticker (NVDA), ask for a ranking (\"most holders\"), compare two stocks, or paste a 0x address.";

/** The `?q=` value, read defensively: no query string is the normal case. */
function handoffQuestion() {
  try {
    return String(new URLSearchParams(window.location.search).get("q") ?? "").trim();
  } catch {
    return "";
  }
}

export function AskChat() {
  const [note, setNote] = useState(null);

  // The handoff runs once, on the conversation's own terms: it hands back
  // `ask`/`prefill` when it is ready, which keeps this page out of the business
  // of owning transcript state it does not render.
  const handledRef = useRef(false);
  const onReady = useCallback((api) => {
    if (handledRef.current) return;
    handledRef.current = true;
    const question = handoffQuestion();
    if (!question) return;
    // "Actionable" means the router recognises it, not that it carries a 0x — a
    // ranking or a market question answers itself with no target at all, and a
    // greeting is answered without a lookup. Only a question nothing matches is
    // prefilled instead of sent.
    if (isSmallTalk(question) || classifyIntent(question).intent !== INTENTS.UNKNOWN) {
      api.ask(question);
      return;
    }
    api.prefill(question);
    setNote(HANDOFF_NOTE);
  }, []);

  return (
    // A fixed height rather than a min: the transcript is the scrolling region,
    // exactly as it is inside the overlay panel, so the composer stays pinned
    // instead of being pushed off the bottom of a long answer. 3rem/3.5rem is
    // the console header above it.
    <div className="mx-auto flex h-[calc(100dvh_-_3rem)] w-full max-w-3xl flex-col px-4 py-6 sm:h-[calc(100dvh_-_3.5rem)] sm:px-6 sm:py-10">
      <Conversation
        className="min-h-0 flex-1"
        suggestions={SUGGESTIONS}
        greeting={<AskGreeting as="h1" />}
        note={note}
        onReady={onReady}
        autoFocus
        footer={
          <p className="text-center font-mono text-[11px] text-cm-faint">
            Reads live Robinhood Chain data
          </p>
        }
      />
    </div>
  );
}
