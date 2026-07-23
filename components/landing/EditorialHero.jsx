"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import HeroGridCanvas from "@/components/landing/HeroGridCanvas";

/** Slow, confident reveal — long travel, heavy ease-out. */
const LINE_EASE = [0.16, 1, 0.3, 1];

/**
 * MaskedLine — a line of display type that rises out of an overflow mask.
 * @param {{ children: import("react").ReactNode, delay?: number, className?: string, reduce?: boolean }} props
 */
function MaskedLine({ children, delay = 0, className = "", reduce = false }) {
  return (
    <span className="block overflow-hidden">
      <motion.span
        className={`block ${className}`}
        initial={reduce ? { y: 0 } : { y: "110%" }}
        animate={{ y: 0 }}
        transition={reduce ? { duration: 0 } : { duration: 1.05, delay, ease: LINE_EASE }}
      >
        {children}
      </motion.span>
    </span>
  );
}

/**
 * EditorialHero — full-viewport hero built on scale contrast: a 10px mono label
 * against a wordmark that fills the screen, with brutal whitespace between.
 */
export default function EditorialHero() {
  const reduce = useReducedMotion() ?? false;
  const fade = (delay) => ({
    initial: reduce ? { opacity: 1 } : { opacity: 0 },
    animate: { opacity: 1 },
    transition: reduce ? { duration: 0 } : { duration: 0.9, delay, ease: "easeOut" },
  });

  return (
    <section className="relative flex min-h-[94svh] flex-col overflow-hidden border-b border-cm-border-subtle bg-cm-bg">
      <HeroGridCanvas speed={0.6} density={0.8} />
      <div aria-hidden className="cm-ambient-orb cm-ambient-orb--breathe left-[-10rem] top-[10%] h-[26rem] w-[26rem] bg-cm-accent/12" />

      {/* top rule — tiny mono meta, maximum scale contrast against the wordmark */}
      <motion.div
        {...fade(0.1)}
        className="relative z-10 mx-auto flex w-full max-w-[100rem] items-center justify-between px-6 pt-8 font-mono text-[10px] uppercase tracking-[0.34em] text-cm-faint sm:px-10"
      >
        <span className="flex items-center gap-2 text-cm-terminal">
          <span className="cm-pulse-live inline-block h-1 w-1 rounded-full bg-cm-ok" />
          Robinhood Chain
        </span>
        <span className="hidden sm:block">AI Explorer</span>
      </motion.div>

      {/* the wordmark — the only thing that matters on this screen */}
      <div className="relative z-10 mx-auto flex w-full max-w-[100rem] flex-1 flex-col justify-center px-6 py-16 sm:px-10">
        <h1 className="font-semibold uppercase leading-[0.82] tracking-[-0.045em] text-cm-text">
          <MaskedLine
            reduce={reduce}
            delay={0.25}
            className="text-[clamp(3.25rem,15.5vw,13rem)]"
          >
            Ask the
          </MaskedLine>
          <MaskedLine
            reduce={reduce}
            delay={0.38}
            className="cm-text-outline text-[clamp(3.25rem,15.5vw,13rem)]"
          >
            Chain
          </MaskedLine>
        </h1>

        <motion.p
          {...fade(1.05)}
          className="mt-10 max-w-sm text-[0.95rem] leading-relaxed text-cm-muted sm:mt-14"
        >
          Wallets, tokens and transactions — read straight from the chain and explained in plain
          English.
        </motion.p>

        <motion.div {...fade(1.2)} className="mt-10 flex items-center gap-8">
          <Link
            href="/ask"
            className="group inline-flex items-center gap-3 border-b border-cm-accent pb-1 font-mono text-xs uppercase tracking-[0.24em] text-cm-accent transition-colors hover:text-cm-accent-bright"
          >
            Start asking
            <span aria-hidden className="transition-transform duration-300 group-hover:translate-x-1">
              →
            </span>
          </Link>
          <Link
            href="/how-it-works"
            className="font-mono text-xs uppercase tracking-[0.24em] text-cm-faint transition-colors hover:text-cm-text"
          >
            How it works
          </Link>
        </motion.div>
      </div>

      {/* bottom rule */}
      <motion.div
        {...fade(1.35)}
        className="relative z-10 mx-auto flex w-full max-w-[100rem] items-center justify-between border-t border-cm-border-subtle px-6 py-6 font-mono text-[10px] uppercase tracking-[0.34em] text-cm-faint sm:px-10"
      >
        <span>Scroll</span>
        <span className="hidden sm:block">No signup required</span>
      </motion.div>
    </section>
  );
}
