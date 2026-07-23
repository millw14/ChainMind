"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";

const EASE_OUT = [0.22, 1, 0.36, 1];

/**
 * CommandPill — a floating command-palette trigger anchored to the bottom-center
 * of the viewport. Renders a glowing gradient orb, a label, and a platform-aware
 * keyboard hint, and registers a global Cmd/Ctrl+K shortcut.
 *
 * The pill is visible by default: the entrance animation is purely additive and a
 * fallback timer force-reveals it if the animation never runs.
 *
 * @param {Object} props
 * @param {string} [props.href="/ask"] Destination for the pill link and for the
 *   keyboard shortcut when no `onTrigger` handler is supplied.
 * @param {string} [props.label="Ask anything"] Text shown in the middle of the pill.
 * @param {number} [props.delay=0.6] Seconds to wait before the entrance animation.
 * @param {() => void} [props.onTrigger] Called instead of navigating when the user
 *   presses Cmd/Ctrl+K.
 * @returns {JSX.Element} The fixed-position command pill.
 */
export default function CommandPill({
  href = "/ask",
  label = "Ask anything",
  delay = 0.6,
  onTrigger,
}) {
  const reduce = useReducedMotion();

  // Forced-visible fallback: flipped by a timer so the pill can never be
  // permanently hidden by an animation that failed to run.
  const [revealed, setRevealed] = useState(false);
  // "⌘K" on the server and on the first client render; corrected after mount.
  const [hint, setHint] = useState("⌘K");
  const [coarse, setCoarse] = useState(false);

  // Keep the latest handler/href without re-registering the key listener.
  const triggerRef = useRef(onTrigger);
  const hrefRef = useRef(href);
  triggerRef.current = onTrigger;
  hrefRef.current = href;

  // Platform + pointer detection, deferred to an effect so SSR markup and the
  // first client render agree (no hydration mismatch).
  useEffect(() => {
    let mac = false;
    try {
      const uaPlatform =
        (typeof navigator !== "undefined" &&
          navigator.userAgentData &&
          navigator.userAgentData.platform) ||
        (typeof navigator !== "undefined" && navigator.platform) ||
        "";
      const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
      mac = /mac|iphone|ipad|ipod/i.test(String(uaPlatform) + " " + ua);
    } catch {
      mac = false;
    }
    if (!mac) setHint("Ctrl K");

    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(pointer: coarse)");
    const sync = () => setCoarse(mq.matches);
    sync();
    if (mq.addEventListener) mq.addEventListener("change", sync);
    else if (mq.addListener) mq.addListener(sync);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", sync);
      else if (mq.removeListener) mq.removeListener(sync);
    };
  }, []);

  // Fallback reveal. Fires well after the entrance animation would have settled.
  useEffect(() => {
    const wait = reduce ? 0 : Math.max(0, Number(delay) || 0) * 1000 + 1200;
    if (wait === 0) {
      setRevealed(true);
      return;
    }
    const id = window.setTimeout(() => setRevealed(true), wait);
    return () => window.clearTimeout(id);
  }, [delay, reduce]);

  // Global ⌘K / Ctrl+K shortcut.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (!event || event.repeat) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
      if (key !== "k") return;
      event.preventDefault();
      const handler = triggerRef.current;
      if (typeof handler === "function") handler();
      else window.location.href = hrefRef.current;
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const animated = !reduce;
  const hoverable = animated && !coarse;

  return (
    <div className="fixed bottom-6 left-1/2 z-[65] -translate-x-1/2">
      <motion.div
        initial={animated ? { opacity: 0, y: 14 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          duration: 0.5,
          delay: animated ? Math.max(0, Number(delay) || 0) : 0,
          ease: EASE_OUT,
        }}
        // Hard override so the pill is visible even if the animation stalls.
        className={revealed ? "!translate-y-0 !opacity-100" : undefined}
      >
        <motion.div
          whileHover={
            hoverable
              ? { scale: 1.03, borderColor: "var(--cm-accent)" }
              : undefined
          }
          whileTap={animated ? { scale: 0.985 } : undefined}
          transition={{ type: "spring", stiffness: 420, damping: 30 }}
          className="rounded-full border border-cm-border bg-cm-surface/85 shadow-cm backdrop-blur-md"
        >
          <Link
            href={href}
            aria-label={`${label} (command palette)`}
            aria-keyshortcuts="Meta+K Control+K"
            className="flex select-none items-center gap-3 rounded-full px-5 py-3 outline-none ring-cm-accent/60 transition-colors focus-visible:ring-2"
          >
            <span className="relative h-6 w-6 shrink-0" aria-hidden="true">
              <motion.span
                className="pointer-events-none absolute -inset-1.5 rounded-full blur-md"
                style={{
                  background:
                    "radial-gradient(circle at 50% 50%, var(--cm-accent-bright), transparent 70%)",
                  opacity: 0.55,
                }}
                animate={
                  animated
                    ? { opacity: [0.35, 0.7, 0.35], scale: [0.92, 1.08, 0.92] }
                    : undefined
                }
                transition={
                  animated
                    ? { duration: 3.2, repeat: Infinity, ease: "easeInOut" }
                    : undefined
                }
              />
              <motion.span
                className="absolute inset-0 rounded-full"
                style={{
                  background:
                    "conic-gradient(from 0deg, var(--cm-accent) 0deg, var(--cm-accent-bright) 130deg, var(--cm-accent-dim) 250deg, var(--cm-accent) 360deg)",
                  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
                }}
                animate={animated ? { rotate: 360 } : undefined}
                transition={
                  animated
                    ? { duration: 9, repeat: Infinity, ease: "linear" }
                    : undefined
                }
              />
              <span
                className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cm-bg/80"
              />
            </span>

            <span className="text-sm text-cm-text">{label}</span>

            <span className="rounded border border-cm-border bg-cm-bg px-1.5 py-0.5 font-mono text-[10px] text-cm-faint">
              {hint}
            </span>
          </Link>
        </motion.div>
      </motion.div>
    </div>
  );
}
