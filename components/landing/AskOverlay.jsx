"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

/** Signature "bloom" curve: fast out of the gate, long soft settle. */
const BLOOM_EASE = [0.16, 1, 0.3, 1];

/** Fallback reveal delay (ms). If the panel animation never runs, force it visible. */
const FORCE_REVEAL_MS = 900;

/** Default prompts. Kept short so the chip row wraps nicely on narrow screens. */
const DEFAULT_SUGGESTIONS = [
  { icon: "\u{1F9ED}", text: "Explain this wallet" },
  { icon: "\u{1F4C8}", text: "Why did this token move?" },
  { icon: "\u{1F50E}", text: "Trace this transaction" },
  { icon: "⚡", text: "What is Robinhood Chain?" },
];

/**
 * Accepts either `["a", "b"]` or `[{ icon, text }]` and normalises to the object
 * form so callers can pass the simplest thing that works.
 */
function normalizeSuggestions(list) {
  const source = Array.isArray(list) && list.length > 0 ? list : DEFAULT_SUGGESTIONS;
  const out = [];
  for (let i = 0; i < source.length; i += 1) {
    const item = source[i];
    if (typeof item === "string") {
      const text = item.trim();
      if (text) out.push({ icon: "", text });
    } else if (item && typeof item.text === "string") {
      const text = item.text.trim();
      if (text) out.push({ icon: typeof item.icon === "string" ? item.icon : "", text });
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

/**
 * AskOverlay — a full-screen conversational surface that blooms open from a
 * trigger: the backdrop fades while the panel scales up on a long settle curve,
 * over two slowly drifting radial glows.
 *
 * Fully controlled. The overlay is mounted only while `open` is true; Escape,
 * the close button, and backdrop clicks all route through `onClose`. Body scroll
 * is locked while open and always restored on close or unmount.
 *
 * Safety behaviours: the panel is force-revealed by a fallback timer if its
 * entrance animation never runs, `prefers-reduced-motion` collapses everything
 * to a plain fade with static glows, and autofocus is skipped on coarse pointers
 * so mobile keyboards do not slam open.
 *
 * @param {Object} props
 * @param {boolean} props.open Whether the overlay is shown.
 * @param {() => void} [props.onClose] Called on Escape, backdrop click, or the X button.
 * @param {(text: string) => void} [props.onSubmit] Receives the trimmed question
 *   from the input row or a suggestion chip.
 * @param {Array<string|{icon?: string, text: string}>} [props.suggestions] Chip
 *   prompts; falls back to a built-in set when omitted or empty.
 * @param {string} [props.greetingName="ChainMind"] Name the assistant introduces itself with.
 * @returns {JSX.Element} An `AnimatePresence` wrapper that renders the overlay while open.
 */
export default function AskOverlay({
  open,
  onClose,
  onSubmit,
  suggestions,
  greetingName = "ChainMind",
}) {
  const reduce = useReducedMotion();

  // Neutral on the server and on the first client render; the real time-aware
  // line is swapped in from an effect so SSR and hydration markup agree.
  const [greeting, setGreeting] = useState("Hello!");
  const [value, setValue] = useState("");
  const [forced, setForced] = useState(false);

  const inputRef = useRef(null);
  const closeRef = useRef(onClose);
  const submitRef = useRef(onSubmit);
  closeRef.current = onClose;
  submitRef.current = onSubmit;

  const chips = useMemo(() => normalizeSuggestions(suggestions), [suggestions]);

  const requestClose = useCallback(() => {
    if (typeof closeRef.current === "function") closeRef.current();
  }, []);

  const send = useCallback((text) => {
    const trimmed = String(text == null ? "" : text).trim();
    if (!trimmed) return;
    if (typeof submitRef.current === "function") submitRef.current(trimmed);
    setValue("");
  }, []);

  const handleFormSubmit = useCallback(
    (event) => {
      event.preventDefault();
      send(value);
    },
    [send, value],
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
    let coarse = false;
    try {
      coarse =
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(pointer: coarse)").matches;
    } catch {
      coarse = false;
    }
    if (coarse) return undefined;
    const timer = setTimeout(() => {
      const node = inputRef.current;
      if (node && typeof node.focus === "function") node.focus();
    }, reduce ? 60 : 420);
    return () => clearTimeout(timer);
  }, [open, reduce]);

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

  const panelInitial = reduce
    ? { opacity: 0 }
    : { opacity: 0, scale: 0.94, y: 18 };
  const panelAnimate = reduce
    ? { opacity: 1 }
    : { opacity: 1, scale: 1, y: 0 };
  const panelTransition = reduce
    ? { duration: 0.2, ease: "linear" }
    : { duration: 0.5, ease: BLOOM_EASE };

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
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>

          <motion.div
            className="relative z-[1] w-full max-w-3xl"
            initial={panelInitial}
            animate={panelAnimate}
            exit={panelInitial}
            transition={panelTransition}
            style={forced ? { opacity: 1, transform: "none" } : undefined}
          >
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
                  className="flex items-center gap-2 rounded-full border border-cm-border bg-cm-surface/70 px-4 py-2 text-sm text-cm-subtle transition hover:border-cm-accent/50 hover:text-cm-text"
                >
                  {chip.icon ? (
                    <span aria-hidden="true" className="text-[13px] leading-none">
                      {chip.icon}
                    </span>
                  ) : null}
                  <span>{chip.text}</span>
                </button>
              ))}
            </div>

            <form
              onSubmit={handleFormSubmit}
              className="mt-8 flex w-full items-center gap-3 rounded-2xl border border-cm-border bg-cm-surface/60 px-5 py-4 backdrop-blur"
            >
              <input
                ref={inputRef}
                type="text"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="Ask anything about the chain"
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
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
                  <path
                    d="M12 19V5M12 5l-6 6M12 5l6 6"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </form>

            <p className="mt-5 text-center font-mono text-[11px] text-cm-faint">
              Reads live Robinhood Chain data
            </p>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
