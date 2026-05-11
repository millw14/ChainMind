"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";

const nav = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#capabilities", label: "Capabilities" },
  { href: "/console", label: "Console" },
];

const easeOut = [0.22, 1, 0.36, 1];

export function SiteHeader() {
  const reduceMotion = useReducedMotion();

  return (
    <motion.header
      className="sticky top-0 z-50 border-b border-cm-border-subtle bg-cm-surface/80 backdrop-blur-md"
      initial={reduceMotion ? false : { y: -28, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.55, ease: easeOut }}
    >
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight text-cm-text">
          <motion.span
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-cm-accent-bright to-cm-accent-dim text-xs font-bold text-cm-on-accent"
            whileHover={reduceMotion ? undefined : { scale: 1.06, rotate: -2 }}
            whileTap={reduceMotion ? undefined : { scale: 0.96 }}
            transition={{ type: "spring", stiffness: 400, damping: 22 }}
          >
            CM
          </motion.span>
          ChainMind
        </Link>
        <nav className="hidden items-center gap-1 sm:flex">
          {nav.map((item, i) => (
            <motion.div
              key={item.href}
              initial={reduceMotion ? false : { opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: reduceMotion ? 0 : 0.08 + i * 0.07, duration: 0.45, ease: easeOut }}
            >
              <Link
                href={item.href}
                className="rounded-lg px-3 py-2 text-sm text-cm-muted transition-colors duration-200 hover:bg-cm-row-hover/50 hover:text-cm-text"
              >
                {item.label}
              </Link>
            </motion.div>
          ))}
        </nav>
        <motion.div
          className="flex items-center gap-2"
          initial={reduceMotion ? false : { opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: reduceMotion ? 0 : 0.22, type: "spring", stiffness: 380, damping: 24 }}
        >
          <motion.div whileHover={reduceMotion ? undefined : { scale: 1.03 }} whileTap={reduceMotion ? undefined : { scale: 0.97 }}>
            <Link
              href="/console"
              className="rounded-lg bg-cm-accent px-3 py-2 text-sm font-semibold text-cm-on-accent transition-colors duration-200 hover:bg-cm-accent-bright"
            >
              Open console
            </Link>
          </motion.div>
        </motion.div>
      </div>
      <nav className="flex border-t border-cm-border-subtle px-4 py-2 sm:hidden">
        <div className="flex w-full justify-around gap-2 text-xs">
          {nav.map((item) => (
            <Link key={item.href} href={item.href} className="text-cm-muted transition-colors hover:text-cm-text">
              {item.label}
            </Link>
          ))}
        </div>
      </nav>
    </motion.header>
  );
}
