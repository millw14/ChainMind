"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import Conversation, { AskGreeting, BLOOM_EASE } from "@/components/ask/Conversation";
import { IconClose } from "@/components/icons/AskIcons";

/** Fallback reveal delay (ms). If the panel animation never runs, force it visible. */
const FORCE_REVEAL_MS = 900;

/**
 * AskOverlay — a full-screen conversational surface that blooms open from a
 * trigger: the backdrop fades while the panel scales up on a long settle curve,
 * over two slowly drifting radial glows.
 *
 * It answers in place, and it answers in exactly the same component `/ask` does
 * — components/ask/Conversation.jsx owns the transcript, the composer, the
 * streaming, the intent tags and every abort and sequence guard. What is left
 * here is the OVERLAY: the backdrop, the entrance, the glows, the greeting, the
 * scroll lock, Escape, the close button, and the footer link. That split is why
 * "open full page" is now honest — the link leads to the same conversation on a
 * full-bleed page instead of to a different, stiffer one.
 *
 * Fully controlled. The overlay is mounted only while `open` is true; Escape,
 * the close button, and backdrop clicks all route through `onClose`. Body scroll
 * is locked while open and always restored on close or unmount. Closing unmounts
 * the conversation, which aborts whatever it had in flight and starts the next
 * opening on the greeting again.
 *
 * Safety behaviours: the panel is force-revealed by a fallback timer if its
 * entrance animation never runs, and `prefers-reduced-motion` collapses the
 * bloom to a plain fade with static glows.
 *
 * @param {Object} props
 * @param {boolean} props.open Whether the overlay is shown.
 * @param {() => void} [props.onClose] Called on Escape, backdrop click, or the X button.
 * @param {(text: string) => void} [props.onSubmit] Notified with each trimmed
 *   question; the overlay still answers in place regardless of what it does.
 * @param {Array<string|{icon?: string, Icon?: Function, text: string, question?: string}>} [props.suggestions]
 *   Chip prompts; falls back to Conversation's built-in set when omitted.
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
  const reduce = useReducedMotion() ?? false;
  const [forced, setForced] = useState(false);
  const [session, setSession] = useState(0);

  const closeRef = useRef(onClose);
  const submitRef = useRef(onSubmit);
  closeRef.current = onClose;
  submitRef.current = onSubmit;

  const requestClose = useCallback(() => {
    if (typeof closeRef.current === "function") closeRef.current();
  }, []);

  // The callback stays supported for other callers, but it is a notification —
  // the conversation answers the question itself either way.
  const notifySubmit = useCallback((text) => {
    if (typeof submitRef.current === "function") submitRef.current(text);
  }, []);

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

  // Force-visible fallback: if the entrance animation never runs, the panel is
  // revealed anyway. Cleared the moment `open` flips false so the exit
  // animation is not pinned open.
  useEffect(() => {
    if (!open) {
      setForced(false);
      return undefined;
    }
    const timer = setTimeout(() => setForced(true), FORCE_REVEAL_MS);
    return () => clearTimeout(timer);
  }, [open]);

  // Closing ends the conversation. A new session key is what guarantees it: the
  // exiting panel is not removed from the DOM until its fade finishes, and
  // AnimatePresence will hand the SAME element back if the overlay is reopened
  // before then — transcript, pending request and all. Remounting on close
  // drops the transcript AND aborts whatever was in flight, so the next opening
  // starts on the greeting exactly as it always did.
  useEffect(() => {
    if (open) return undefined;
    setSession((n) => n + 1);
    return undefined;
  }, [open]);

  const panelInitial = reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 18 };
  const panelAnimate = reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 };
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
            <Conversation
              key={session}
              className="min-h-0 flex-1"
              suggestions={suggestions}
              greeting={<AskGreeting name={greetingName} />}
              onSend={notifySubmit}
              autoFocus
              // Late enough that the focus lands after the bloom has settled,
              // rather than in the middle of it.
              autoFocusDelay={reduce ? 60 : 420}
              footer={
                <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 font-mono text-[11px] text-cm-faint">
                  <span>Reads live Robinhood Chain data</span>
                  <span aria-hidden="true">·</span>
                  {/* Kept, and now honest: /ask is this same conversation. */}
                  <Link href={href} className="transition hover:text-cm-muted">
                    Open full page
                  </Link>
                </div>
              }
            />
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
