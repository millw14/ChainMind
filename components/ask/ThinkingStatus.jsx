"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { phrasesFor } from "@/lib/thinking-phrases";

/**
 * ThinkingStatus — the waiting state, and the only thing that renders it.
 *
 * A ticker question is ~5.6 seconds of measured indexer time before the first
 * word of the answer can exist. Three dots for five seconds is the product
 * looking stuck; a line that says "counting the float" while the holder list is
 * genuinely being read is the same wait, spent informed.
 *
 * Two guarantees, and they are why this is one component rather than two call
 * sites:
 *
 *  1. NEVER AN EMPTY STATUS ROW. With a progress event it shows the phrase; with
 *     none it shows the dots it always did. An older deployment that emits no
 *     progress events, a proxy that ate them, the plain-JSON fallback — every one
 *     of those lands in the second branch, not in a blank row.
 *  2. NEVER A PHRASE THAT DISAGREES WITH THE WORK. The pool is chosen by the
 *     event's `step`, so a holder lookup cannot claim to be reading the tape. The
 *     server's own label leads the rotation because it is the only one that can
 *     name the subject ("pulling NVDA"); the rest of the pool follows.
 *
 * Under reduced motion nothing animates: the phrase is swapped as plain text and
 * the dots become a written line. Nothing here can leave content invisible — the
 * fade starts at a legible opacity rather than at zero, so a failed animation is
 * a phrase that did not brighten, not a phrase nobody can read.
 */

/** How long each phrase holds before the next one. Long enough to finish reading. */
const ROTATE_MS = 2000;

/** The opacity a new phrase starts at. Deliberately not zero — see above. */
const FADE_FROM = 0.3;

/** Said when there is no progress event to say anything better. */
const FALLBACK_LINE = "Reading the chain…";

/** The animated dots, unchanged: the fallback for a stream that reports no steps. */
function Dots({ reduce }) {
  if (reduce) {
    return <span className="font-mono text-[12px] text-cm-muted">{FALLBACK_LINE}</span>;
  }
  return (
    <span role="status" aria-label="Reading the chain" className="flex items-center gap-1.5">
      {[0, 1, 2].map((dot) => (
        <motion.span
          key={dot}
          className="h-1.5 w-1.5 rounded-full bg-cm-accent"
          animate={{ opacity: [0.25, 1, 0.25], scale: [0.85, 1, 0.85] }}
          transition={{ duration: 1.1, ease: "easeInOut", repeat: Infinity, delay: dot * 0.16 }}
        />
      ))}
    </span>
  );
}

/** One live dot beside the phrase, so the row still reads as work in progress. */
function Pip({ reduce }) {
  const shape = "h-1.5 w-1.5 shrink-0 rounded-full bg-cm-accent";
  if (reduce) return <span aria-hidden="true" className={shape} />;
  return (
    <motion.span
      aria-hidden="true"
      className={shape}
      animate={{ opacity: [0.35, 1, 0.35] }}
      transition={{ duration: 1.4, ease: "easeInOut", repeat: Infinity }}
    />
  );
}

/**
 * @param {Object} props
 * @param {{ step: string, label?: string }|null} [props.status] The latest
 *   progress event, or null when none has arrived.
 * @param {boolean} props.reduce Whether motion is unwelcome.
 * @returns {JSX.Element} The status row. Never empty.
 */
export default function ThinkingStatus({ status = null, reduce = false }) {
  const step = typeof status?.step === "string" ? status.step : "";
  const label = typeof status?.label === "string" ? status.label.trim() : "";

  const phrases = useMemo(() => {
    if (!step) return [];
    const pool = phrasesFor(step);
    // The label leads, and is not repeated later in the rotation.
    return label ? [label, ...pool.filter((phrase) => phrase !== label)] : [...pool];
  }, [label, step]);

  // The rotation is keyed to the step it belongs to, so a new step starts at its
  // own lead phrase without a render showing the previous step's index.
  const key = step ? `${step}|${label}` : "";
  const [rot, setRot] = useState({ key, index: 0 });
  const index = rot.key === key ? rot.index : 0;

  useEffect(() => {
    if (!key || phrases.length < 2) return undefined;
    const timer = setInterval(() => {
      setRot((prev) => ({ key, index: prev.key === key ? prev.index + 1 : 1 }));
    }, ROTATE_MS);
    return () => clearInterval(timer);
  }, [key, phrases.length]);

  if (!step || phrases.length === 0) return <Dots reduce={reduce} />;

  const phrase = phrases[index % phrases.length];

  return (
    <span role="status" className="flex min-w-0 items-center gap-2">
      {/* Announced once per step. The visible phrase is hidden from assistive
          tech instead, so a rotation every two seconds is not read out five
          times over for one lookup. */}
      <span className="sr-only">{label || phrase}</span>
      <Pip reduce={reduce} />
      {reduce ? (
        <span aria-hidden="true" className="truncate font-mono text-[12px] text-cm-muted">
          {phrase}
        </span>
      ) : (
        <motion.span
          key={phrase}
          aria-hidden="true"
          className="truncate font-mono text-[12px] text-cm-muted"
          initial={{ opacity: FADE_FROM }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.34, ease: "easeOut" }}
        >
          {phrase}
        </motion.span>
      )}
    </span>
  );
}
