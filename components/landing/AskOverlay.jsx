"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import {
  IconBolt,
  IconClose,
  IconSend,
  IconSparkle,
  IconTrace,
  IconTrend,
  IconWallet,
} from "@/components/icons/AskIcons";

/** Signature "bloom" curve: fast out of the gate, long soft settle. */
const BLOOM_EASE = [0.16, 1, 0.3, 1];

/** Fallback reveal delay (ms). If the panel animation never runs, force it visible. */
const FORCE_REVEAL_MS = 900;

/** Shown when the route answers 200 but the answer body came back empty. */
const EMPTY_ANSWER = "I did not get an answer back for that one. Try asking it a different way.";

/** Shown when the response is unreadable (HTML error page, truncated body, …). */
const UNKNOWN_ERROR = "Something went wrong on my side. Try that again in a moment.";

/** Shown when the request never reached the route at all (offline, DNS, TLS). */
const NETWORK_ERROR = "I could not reach the chain just now. Check your connection and try again.";

/**
 * Default prompts. Kept short so the chip row wraps nicely on narrow screens.
 * The glyphs are components rather than emoji so they inherit `currentColor`
 * and can tint with the chip on hover.
 */
const DEFAULT_SUGGESTIONS = [
  { Icon: IconWallet, text: "Explain this wallet" },
  { Icon: IconTrend, text: "Why did this token move?" },
  { Icon: IconTrace, text: "Trace this transaction" },
  { Icon: IconBolt, text: "What is Robinhood Chain?" },
];

/**
 * Accepts `["a", "b"]`, `[{ icon, text }]` (legacy emoji form) or
 * `[{ Icon, text }]` and normalises to one object shape, so callers can pass the
 * simplest thing that works and the chip renderer stays branch-light.
 */
function normalizeSuggestions(list) {
  const source = Array.isArray(list) && list.length > 0 ? list : DEFAULT_SUGGESTIONS;
  const out = [];
  for (let i = 0; i < source.length; i += 1) {
    const item = source[i];
    if (typeof item === "string") {
      const text = item.trim();
      if (text) out.push({ Icon: null, icon: "", text });
    } else if (item && typeof item.text === "string") {
      const text = item.text.trim();
      if (text) {
        out.push({
          Icon: typeof item.Icon === "function" ? item.Icon : null,
          icon: typeof item.icon === "string" ? item.icon : "",
          text,
        });
      }
    }
  }
  return out;
}

/** Local-clock greeting. Never called during render — see the mount effect. */
function timeGreeting(hour) {
  if (hour < 12) return "Good morning!";
  if (hour < 18) return "Good afternoon!";
  return "Good evening!";
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
 * Renders one assistant answer: plain paragraphs with newlines preserved, plus
 * simple bullet runs promoted to a real list.
 *
 * @param {Object} props
 * @param {string} props.text The answer body.
 * @param {string} [props.className] Classes for the wrapper (colour, size).
 * @returns {JSX.Element} The formatted answer.
 */
function AnswerBody({ text, className = "" }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);

  if (blocks.length === 0) {
    return <p className={`whitespace-pre-wrap break-words ${className}`}>{text}</p>;
  }

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
                <span className="min-w-0 whitespace-pre-wrap break-words">{item}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p key={`b-${index}`} className="my-2.5 whitespace-pre-wrap break-words first:mt-0 last:mb-0">
            {block.text}
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
 * AskOverlay — a full-screen conversational surface that blooms open from a
 * trigger: the backdrop fades while the panel scales up on a long settle curve,
 * over two slowly drifting radial glows.
 *
 * It answers in place. A question posts to `/api/ask` and the reply lands in an
 * in-panel transcript, so follow-ups continue in the same surface instead of
 * throwing the reader onto another route mid-thought. `/ask` stays reachable
 * through a quiet footer link, never as a forced redirect.
 *
 * Fully controlled. The overlay is mounted only while `open` is true; Escape,
 * the close button, and backdrop clicks all route through `onClose`. Body scroll
 * is locked while open and always restored on close or unmount. Closing drops
 * the transcript, so the next opening starts on the greeting again.
 *
 * Safety behaviours: the panel is force-revealed by a fallback timer if its
 * entrance animation never runs, `prefers-reduced-motion` collapses everything
 * to a plain fade with static glows and a written thinking line, autofocus is
 * skipped on coarse pointers so mobile keyboards do not slam open, and every
 * request is abortable — a superseded or closed-over answer can never land.
 *
 * @param {Object} props
 * @param {boolean} props.open Whether the overlay is shown.
 * @param {() => void} [props.onClose] Called on Escape, backdrop click, or the X button.
 * @param {(text: string) => void} [props.onSubmit] Notified with the trimmed
 *   question; the overlay still answers in place regardless of what it does.
 * @param {Array<string|{icon?: string, Icon?: Function, text: string}>} [props.suggestions]
 *   Chip prompts; falls back to a built-in set when omitted or empty.
 * @param {string} [props.greetingName="ChainMind"] Name the assistant introduces itself with.
 * @param {string} [props.href="/ask"] Target of the footer's full-page link.
 * @returns {JSX.Element} An `AnimatePresence` wrapper that renders the overlay while open.
 */
export default function AskOverlay({
  open,
  onClose,
  onSubmit,
  suggestions,
  greetingName = "ChainMind",
  href = "/ask",
}) {
  const reduce = useReducedMotion();

  // Neutral on the server and on the first client render; the real time-aware
  // line is swapped in from an effect so SSR and hydration markup agree.
  const [greeting, setGreeting] = useState("Hello!");
  const [value, setValue] = useState("");
  const [forced, setForced] = useState(false);
  const [messages, setMessages] = useState([]);
  const [pending, setPending] = useState(false);

  const inputRef = useRef(null);
  const listRef = useRef(null);
  const closeRef = useRef(onClose);
  const submitRef = useRef(onSubmit);
  closeRef.current = onClose;
  submitRef.current = onSubmit;

  // One controller per in-flight request, one monotonic sequence number to
  // decide which reply is still wanted, and a mounted flag so nothing sets
  // state after teardown.
  const abortRef = useRef(null);
  const seqRef = useRef(0);
  const mountedRef = useRef(true);
  const idRef = useRef(0);

  const chips = useMemo(() => normalizeSuggestions(suggestions), [suggestions]);
  const hasConversation = messages.length > 0 || pending;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Last line of defence: whatever is in flight dies with the component.
  useEffect(
    () => () => {
      if (abortRef.current) abortRef.current.abort();
      abortRef.current = null;
    },
    [],
  );

  const requestClose = useCallback(() => {
    if (typeof closeRef.current === "function") closeRef.current();
  }, []);

  const focusInput = useCallback(() => {
    if (isCoarsePointer()) return;
    const node = inputRef.current;
    if (node && typeof node.focus === "function") node.focus();
  }, []);

  const send = useCallback(
    async (text) => {
      const trimmed = String(text == null ? "" : text).trim();
      if (!trimmed) return;

      // The callback stays supported for other callers, but it is a notification
      // now — the overlay answers this question itself either way.
      if (typeof submitRef.current === "function") submitRef.current(trimmed);

      idRef.current += 1;
      const userId = idRef.current;
      setValue("");
      setMessages((prev) => prev.concat({ id: userId, role: "user", text: trimmed }));
      setPending(true);
      focusInput();

      // Supersede anything still running. The abort covers a request still on
      // the wire; the sequence bump covers one that already resolved and is
      // waiting to render, so a slow answer can never overwrite a newer one.
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      seqRef.current += 1;
      const seq = seqRef.current;

      let reply;
      try {
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: trimmed }),
          signal: controller.signal,
        });
        const data = await res.json().catch(() => null);
        if (res.ok && data && data.ok) {
          const answer = String(data.answer == null ? "" : data.answer).trim();
          reply = {
            role: "assistant",
            text: answer || EMPTY_ANSWER,
            intent: typeof data.intent === "string" ? data.intent.trim() : "",
          };
        } else {
          // A 400 here is usually deliberate guidance ("name a ticker…"), not a
          // crash, so every failure reads as an ordinary, quieter reply.
          const message =
            data && typeof data.error === "string" && data.error.trim()
              ? data.error.trim()
              : UNKNOWN_ERROR;
          reply = { role: "assistant", text: message, error: true };
        }
      } catch (e) {
        if (e && e.name === "AbortError") return; // closed, unmounted, or superseded
        reply = { role: "assistant", text: NETWORK_ERROR, error: true };
      }

      if (!mountedRef.current || seq !== seqRef.current) return;
      if (abortRef.current === controller) abortRef.current = null;
      idRef.current += 1;
      const replyId = idRef.current;
      setMessages((prev) => prev.concat({ id: replyId, ...reply }));
      setPending(false);
    },
    [focusInput],
  );

  const handleFormSubmit = useCallback(
    (event) => {
      event.preventDefault();
      if (pending) return;
      send(value);
    },
    [pending, send, value],
  );

  // Backdrop click: only when the press starts AND ends on the layer itself, so
  // a drag that began inside the panel never closes the overlay.
  const backdropPress = useRef(false);
  const onBackdropMouseDown = useCallback((event) => {
    backdropPress.current = event.target === event.currentTarget;
  }, []);
  const onBackdropClick = useCallback(
    (event) => {
      if (backdropPress.current && event.target === event.currentTarget) requestClose();
      backdropPress.current = false;
    },
    [requestClose],
  );

  // Greeting: computed after mount (and refreshed each time the overlay opens,
  // since a long-lived page can cross noon or 6pm between openings).
  useEffect(() => {
    setGreeting(timeGreeting(new Date().getHours()));
  }, [open]);

  // Escape to close. Listener exists only while open, removed on close/unmount.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        requestClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, requestClose]);

  // Body scroll lock. Previous inline values are captured and always restored,
  // including on unmount while still open.
  useEffect(() => {
    if (!open) return undefined;
    if (typeof document === "undefined") return undefined;
    const body = document.body;
    const prevOverflow = body.style.overflow;
    const prevPaddingRight = body.style.paddingRight;
    let gutter = 0;
    try {
      gutter = window.innerWidth - document.documentElement.clientWidth;
    } catch {
      gutter = 0;
    }
    body.style.overflow = "hidden";
    if (gutter > 0) body.style.paddingRight = `${gutter}px`;
    return () => {
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPaddingRight;
    };
  }, [open]);

  // Focus the input once the bloom has mostly settled. Skipped for coarse
  // pointers so touch devices do not get an unrequested on-screen keyboard.
  useEffect(() => {
    if (!open) return undefined;
    const timer = setTimeout(focusInput, reduce ? 60 : 420);
    return () => clearTimeout(timer);
  }, [open, reduce, focusInput]);

  // Force-visible fallback: if the entrance animation never runs, the panel is
  // revealed anyway. Cleared the moment `open` flips false so the exit
  // animation is not pinned open.
  useEffect(() => {
    if (!open) {
      setForced(false);
      setValue("");
      return undefined;
    }
    const timer = setTimeout(() => setForced(true), FORCE_REVEAL_MS);
    return () => clearTimeout(timer);
  }, [open]);

  // Closing ends the conversation: the in-flight request is aborted, its reply
  // is invalidated by the sequence bump, and the next opening starts fresh on
  // the greeting rather than on a stale transcript.
  useEffect(() => {
    if (open) return undefined;
    seqRef.current += 1;
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = null;
    setMessages([]);
    setPending(false);
    return undefined;
  }, [open]);

  // Follow the newest message. The transcript owns the scroll, so this never
  // touches the page behind the overlay (which is locked anyway).
  useEffect(() => {
    if (!open) return undefined;
    const node = listRef.current;
    if (!node) return undefined;
    const top = node.scrollHeight;
    if (typeof node.scrollTo === "function") {
      node.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
    } else {
      node.scrollTop = top;
    }
    return undefined;
  }, [open, messages, pending, reduce]);

  const panelInitial = reduce
    ? { opacity: 0 }
    : { opacity: 0, scale: 0.94, y: 18 };
  const panelAnimate = reduce
    ? { opacity: 1 }
    : { opacity: 1, scale: 1, y: 0 };
  const panelTransition = reduce
    ? { duration: 0.2, ease: "linear" }
    : { duration: 0.5, ease: BLOOM_EASE };

  // Messages land already visible under reduced motion — nothing to un-hide.
  const msgInitial = reduce ? { opacity: 1 } : { opacity: 0, y: 8 };
  const msgAnimate = reduce ? { opacity: 1 } : { opacity: 1, y: 0 };
  const msgTransition = reduce ? { duration: 0 } : { duration: 0.32, ease: BLOOM_EASE };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="cm-ask-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Ask ${greetingName}`}
          className="fixed inset-0 z-[8000] flex items-center justify-center overflow-y-auto overscroll-contain bg-cm-bg/95 px-4 py-14 backdrop-blur-xl sm:px-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3, ease: "easeOut" }}
          onMouseDown={onBackdropMouseDown}
          onClick={onBackdropClick}
        >
          {/* Ambient glow: two soft blobs, drifting only when motion is welcome. */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
            <motion.div
              className="absolute left-[8%] top-[6%] h-[52vmin] w-[52vmin] rounded-full blur-[80px] sm:blur-[110px]"
              style={{
                opacity: 0.16,
                backgroundImage:
                  "radial-gradient(circle at 50% 50%, var(--cm-accent), transparent 68%)",
              }}
              animate={
                reduce
                  ? undefined
                  : { x: [0, 46, -18, 0], y: [0, -30, 26, 0], scale: [1, 1.12, 0.96, 1] }
              }
              transition={
                reduce
                  ? undefined
                  : { duration: 22, ease: "easeInOut", repeat: Infinity, repeatType: "loop" }
              }
            />
            <motion.div
              className="absolute bottom-[4%] right-[6%] h-[46vmin] w-[46vmin] rounded-full blur-[80px] sm:blur-[120px]"
              style={{
                opacity: 0.12,
                backgroundImage:
                  "radial-gradient(circle at 50% 50%, var(--cm-accent-bright), transparent 70%)",
              }}
              animate={
                reduce
                  ? undefined
                  : { x: [0, -38, 22, 0], y: [0, 28, -20, 0], scale: [1, 0.94, 1.1, 1] }
              }
              transition={
                reduce
                  ? undefined
                  : { duration: 27, ease: "easeInOut", repeat: Infinity, repeatType: "loop" }
              }
            />
          </div>

          <button
            type="button"
            onClick={requestClose}
            aria-label="Close"
            className="absolute right-4 top-4 z-10 flex h-10 w-10 items-center justify-center rounded-full border border-cm-border text-cm-muted transition hover:text-cm-text sm:right-6 sm:top-6"
          >
            <IconClose size={16} />
          </button>

          {/* max-h subtracts 7rem — the backdrop's py-14 — so the panel can never
              outgrow the viewport and push the composer off a phone screen. */}
          <motion.div
            className="relative z-[1] flex max-h-[calc(100dvh_-_7rem)] w-full max-w-3xl flex-col"
            initial={panelInitial}
            animate={panelAnimate}
            exit={panelInitial}
            transition={panelTransition}
            style={forced ? { opacity: 1, transform: "none" } : undefined}
          >
            {hasConversation ? (
              // Transcript: the only scrolling region, so the composer below it
              // stays pinned and the page behind stays put.
              <div
                ref={listRef}
                aria-live="polite"
                className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain pb-2 pr-1 sm:pr-2"
              >
                {messages.map((message) =>
                  message.role === "user" ? (
                    <motion.div
                      key={message.id}
                      className="flex justify-end"
                      initial={msgInitial}
                      animate={msgAnimate}
                      transition={msgTransition}
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
                      transition={msgTransition}
                    >
                      <AssistantAvatar />
                      <div className="min-w-0 flex-1">
                        {message.intent ? (
                          <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-cm-faint">
                            {message.intent}
                          </p>
                        ) : null}
                        <AnswerBody
                          text={message.text}
                          className={`text-[15px] leading-relaxed ${
                            message.error ? "text-cm-muted" : "text-cm-subtle"
                          }`}
                        />
                      </div>
                    </motion.div>
                  ),
                )}

                {pending ? (
                  <div className="flex gap-3">
                    <AssistantAvatar />
                    <div className="flex min-h-[28px] items-center">
                      {reduce ? (
                        <span className="font-mono text-[12px] text-cm-muted">
                          Reading the chain…
                        </span>
                      ) : (
                        <span
                          role="status"
                          aria-label="Reading the chain"
                          className="flex items-center gap-1.5"
                        >
                          {[0, 1, 2].map((dot) => (
                            <motion.span
                              key={dot}
                              className="h-1.5 w-1.5 rounded-full bg-cm-accent"
                              animate={{ opacity: [0.25, 1, 0.25], scale: [0.85, 1, 0.85] }}
                              transition={{
                                duration: 1.1,
                                ease: "easeInOut",
                                repeat: Infinity,
                                delay: dot * 0.16,
                              }}
                            />
                          ))}
                        </span>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              // Short by design, but it still scrolls rather than spilling out
              // of the panel on a very short viewport.
              <div className="min-h-0 overflow-y-auto overscroll-contain">
                <h2 className="text-center text-[clamp(2rem,5vw,3.25rem)] font-semibold leading-[1.08] text-cm-text">
                  {greeting}
                </h2>

                <p className="mx-auto mt-4 max-w-xl text-center text-lg text-cm-muted sm:text-xl">
                  I am {greetingName} — ask me anything about Robinhood Chain.
                </p>

                <div className="mt-8 flex flex-wrap items-center justify-center gap-2 sm:gap-2.5">
                  {chips.map((chip) => (
                    <button
                      key={chip.text}
                      type="button"
                      onClick={() => send(chip.text)}
                      className="group flex items-center gap-2 rounded-full border border-cm-border bg-cm-surface/70 px-4 py-2 text-sm text-cm-subtle transition hover:border-cm-accent/50 hover:text-cm-text"
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
              </div>
            )}

            <form
              onSubmit={handleFormSubmit}
              className="mt-8 flex w-full shrink-0 items-center gap-3 rounded-2xl border border-cm-border bg-cm-surface/60 px-5 py-4 backdrop-blur"
            >
              <input
                ref={inputRef}
                type="text"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={
                  hasConversation ? "Ask a follow-up" : "Ask anything about the chain"
                }
                aria-label="Ask anything about the chain"
                autoComplete="off"
                spellCheck="false"
                className="min-w-0 flex-1 bg-transparent text-cm-text outline-none placeholder:text-cm-faint"
              />
              <button
                type="submit"
                aria-label="Send"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cm-accent text-cm-on-accent transition hover:opacity-90 disabled:opacity-40"
                disabled={pending || value.trim().length === 0}
              >
                <IconSend size={16} />
              </button>
            </form>

            <div className="mt-5 flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 font-mono text-[11px] text-cm-faint">
              <span>Reads live Robinhood Chain data</span>
              <span aria-hidden="true">·</span>
              <Link href={href} className="transition hover:text-cm-muted">
                Open full page
              </Link>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
