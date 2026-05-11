"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";

const easeOut = [0.22, 1, 0.36, 1];

export function ConsoleHeader() {
  const reduceMotion = useReducedMotion();

  return (
    <motion.header
      className="sticky top-0 z-50 border-b border-cm-border-subtle bg-cm-surface/90 backdrop-blur-md"
      initial={reduceMotion ? false : { y: -12, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.4, ease: easeOut }}
    >
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/" className="flex items-center gap-2 text-sm font-semibold text-cm-text">
            <motion.span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-cm-accent-bright to-cm-accent-dim text-xs font-bold text-cm-on-accent"
              whileHover={reduceMotion ? undefined : { scale: 1.05 }}
              whileTap={reduceMotion ? undefined : { scale: 0.96 }}
              transition={{ type: "spring", stiffness: 420, damping: 22 }}
            >
              CM
            </motion.span>
            <span className="hidden sm:inline">ChainMind</span>
          </Link>
          <span className="hidden h-4 w-px bg-cm-border sm:block" />
          <span className="truncate text-xs font-medium uppercase tracking-wider text-cm-faint">Console</span>
        </div>
        <nav className="flex shrink-0 items-center gap-3 text-sm">
          <Link
            href="/how-it-works"
            className="text-cm-muted transition-colors duration-200 hover:text-cm-text"
          >
            How it works
          </Link>
          <Link href="/" className="text-cm-muted transition-colors duration-200 hover:text-cm-text">
            Marketing site
          </Link>
        </nav>
      </div>
    </motion.header>
  );
}
