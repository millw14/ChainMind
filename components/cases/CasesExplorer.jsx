"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { staggerContainer, fadeUp, springGentle } from "@/components/motion/presets";

function shortAddr(a, compact) {
  if (!a || a.length < 10) return a || "—";
  if (compact) return `${a.slice(0, 4)}…${a.slice(-4)}`;
  return `${a.slice(0, 6)}…${a.slice(-6)}`;
}

function timeAgo(unixSec) {
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function verdictStyle(v) {
  if (v === "escalate") return "bg-red-500/15 text-red-400 border-red-500/35";
  if (v === "monitor") return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  return "bg-zinc-500/10 text-zinc-400 border-zinc-600/40";
}

function riskDot(risk) {
  if (risk === "critical") return "bg-red-500";
  if (risk === "high") return "bg-orange-500";
  if (risk === "medium") return "bg-yellow-500";
  return "bg-zinc-500";
}

/** @param {{ cases: Array<{ id: string, scope_address: string, created_at: number, verdict: string, confidence: number, pattern: string, risk_level?: string }> }} props */
export function CasesExplorer({ cases }) {
  const reduceMotion = useReducedMotion() ?? false;
  const mainStagger = staggerContainer(reduceMotion, { stagger: 0.055, delayChildren: 0.04 });
  const rowV = fadeUp(reduceMotion);

  return (
    <motion.main
      className="relative mx-auto min-h-[65vh] max-w-[88rem] px-4 py-8 sm:px-8 sm:py-12 cm-war-grid"
      initial="hidden"
      animate="show"
      variants={mainStagger}
    >
      <motion.div
        variants={rowV}
        className="mb-8 flex flex-col gap-5 sm:mb-10 sm:flex-row sm:items-end sm:justify-between"
      >
        <div className="max-w-2xl">
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-cm-faint sm:text-xs">
            Case history
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-cm-text sm:text-3xl md:text-4xl">
            Investigations
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-cm-muted sm:text-base">
            Open a case to review AI verdicts, funding trees, and evidence captured from the live dashboard.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3 self-start rounded-xl border border-cm-border bg-cm-surface/90 px-4 py-3 shadow-[0_16px_48px_-20px_rgba(0,0,0,0.55)] ring-1 ring-cm-border-subtle sm:self-auto sm:px-5 sm:py-3.5">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cm-accent/45 opacity-40" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-cm-accent shadow-[0_0_14px_rgba(139,92,246,0.35)]" />
          </span>
          <span className="font-mono text-sm text-cm-text sm:text-base">
            <span className="tabular-nums font-semibold text-cm-accent-bright">{cases.length}</span>
            <span className="text-cm-faint"> stored</span>
          </span>
        </div>
      </motion.div>

      {cases.length === 0 ? (
        <motion.div
          variants={rowV}
          className="rounded-2xl border border-dashed border-cm-border bg-cm-surface/40 px-8 py-20 text-center shadow-inner sm:py-24"
        >
          <p className="mx-auto max-w-md text-base text-cm-muted sm:text-lg">
            No investigations yet — scan an address on the dashboard to create one.
          </p>
          <Link
            href="/dashboard"
            className="mt-6 inline-flex min-h-11 items-center justify-center rounded-lg border border-cm-accent/40 bg-cm-accent/10 px-5 font-mono text-sm font-medium text-cm-accent-bright transition hover:border-cm-accent/60 hover:bg-cm-accent/15"
          >
            Go to dashboard →
          </Link>
        </motion.div>
      ) : (
        <motion.div
          variants={rowV}
          className="overflow-hidden rounded-2xl border border-cm-border bg-cm-surface/90 shadow-[0_28px_90px_-28px_rgba(0,0,0,0.6)] ring-1 ring-cm-border-subtle"
        >
          <div className="bg-gradient-to-r from-cm-accent/12 via-transparent to-cm-terminal/10 px-1 py-1">
            <div className="rounded-[14px] bg-cm-surface/95">
              {/* Desktop header */}
              <div className="hidden grid-cols-[auto_1fr_auto_auto_auto] gap-6 border-b border-cm-border-subtle px-6 py-3.5 font-mono text-[11px] font-semibold uppercase tracking-widest text-cm-faint sm:grid lg:gap-8">
                <span>Verdict</span>
                <span>Address</span>
                <span>Pattern</span>
                <span>Confidence</span>
                <span className="text-right">Time</span>
              </div>

              {cases.map((c) => {
                const v = String(c.verdict ?? "dismiss");
                const created = c.created_at ? Number(c.created_at) : 0;
                return (
                  <motion.div
                    key={c.id}
                    variants={rowV}
                    whileHover={
                      reduceMotion ? undefined : { x: 6, transition: springGentle }
                    }
                    className="group border-t border-cm-border-subtle first:border-t-0"
                  >
                    <Link
                      href={`/investigation/${c.id}`}
                      className="block px-4 py-4 transition-colors hover:bg-cm-row-hover/85 active:bg-cm-row-hover sm:px-6 sm:py-5"
                    >
                      {/* Mobile */}
                      <div className="sm:hidden">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-3">
                            <span
                              className={`mt-1 h-2.5 w-2.5 flex-shrink-0 rounded-full ${riskDot(c.risk_level ?? "low")}`}
                            />
                            <span
                              className={`flex-shrink-0 rounded-lg border px-2.5 py-1 font-mono text-[11px] font-semibold uppercase tracking-wider ${verdictStyle(v)}`}
                            >
                              {v}
                            </span>
                          </div>
                          <span className="flex-shrink-0 font-mono text-[11px] text-cm-faint">
                            {created ? timeAgo(created) : "—"}
                          </span>
                        </div>
                        <p className="mt-3 pl-[22px] font-mono text-sm leading-snug text-cm-text">
                          {shortAddr(c.scope_address ?? "", true)}
                        </p>
                        <p className="mt-1 pl-[22px] font-mono text-[11px] text-cm-muted">
                          {c.pattern && c.pattern !== "unknown"
                            ? String(c.pattern).replace(/-/g, " ")
                            : "—"}{" "}
                          ·{" "}
                          <span className="text-cm-accent-bright">
                            {Math.round(Number(c.confidence ?? 0) * 100)}%
                          </span>
                        </p>
                      </div>

                      {/* Desktop */}
                      <div className="hidden sm:grid sm:grid-cols-[auto_1fr_auto_auto_auto] sm:items-center sm:gap-6 lg:gap-8">
                        <span
                          className={`inline-flex w-fit rounded-lg border px-2.5 py-1 font-mono text-xs font-semibold uppercase tracking-wider ${verdictStyle(v)}`}
                        >
                          {v}
                        </span>
                        <span className="min-w-0 font-mono text-base text-cm-text">
                          {shortAddr(c.scope_address ?? "", false)}
                        </span>
                        <span className="max-w-[200px] truncate font-mono text-sm text-cm-muted lg:max-w-[260px]">
                          {c.pattern && c.pattern !== "unknown"
                            ? String(c.pattern).replace(/-/g, " ")
                            : "—"}
                        </span>
                        <span className="font-mono text-base tabular-nums text-cm-accent-bright">
                          {Math.round(Number(c.confidence ?? 0) * 100)}%
                        </span>
                        <span className="text-right font-mono text-sm text-cm-faint lg:text-sm">
                          {created ? timeAgo(created) : "—"}
                        </span>
                      </div>
                    </Link>
                  </motion.div>
                );
              })}
            </div>
          </div>
        </motion.div>
      )}
    </motion.main>
  );
}
