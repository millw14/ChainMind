"use client";

import Link from "next/link";

/**
 * ONE LINE IN A TRANSCRIPT SAYING WHAT IS HAPPENING SOMEWHERE ELSE.
 *
 * A question that asked for a real investigation gets two things back: the chain half,
 * answered in the message above this, and a job that runs for minutes. This card is the
 * second half's only presence in the conversation, so it has exactly one job — say
 * truthfully what state that job is in and how to get back to it — and it must be able to
 * say "nothing started, and here is why" as clearly as it says "started".
 *
 * IT NEVER RENDERS A BUTTON THAT CANNOT WORK. A deployment with no research service, a
 * caller who is not signed in, an allowance already spent: each is a sentence, not a
 * disabled control with a tooltip. Every sentence comes from the server — see
 * lib/research-job.js — because the reason a job did not start is a fact the client does
 * not have.
 */

/** State → how the card should read. Anything unlisted falls back to `neutral`. */
const TONES = {
  started: { label: "Investigation started", accent: "text-cm-accent", border: "border-cm-accent-dim" },
  deduped: { label: "Investigation already running", accent: "text-cm-accent", border: "border-cm-accent-dim" },
  needs_sign_in: { label: "Sign in to investigate", accent: "text-cm-muted", border: "border-cm-border" },
  out_of_allowance: { label: "No investigations left today", accent: "text-cm-warn", border: "border-cm-border" },
  disabled: { label: "Investigations are off here", accent: "text-cm-muted", border: "border-cm-border" },
  not_configured: { label: "Not available on this deployment", accent: "text-cm-muted", border: "border-cm-border" },
  misconfigured: { label: "Research service misconfigured", accent: "text-cm-warn", border: "border-cm-border" },
  refused_subject: { label: "Nothing to investigate", accent: "text-cm-muted", border: "border-cm-border" },
  at_capacity: { label: "Research service is busy", accent: "text-cm-warn", border: "border-cm-border" },
  unavailable: { label: "Research service unreachable", accent: "text-cm-warn", border: "border-cm-border" },
  rejected: { label: "Submission refused", accent: "text-cm-warn", border: "border-cm-border" },
};

const NEUTRAL = { label: "Deep investigation", accent: "text-cm-muted", border: "border-cm-border" };

export function ResearchNotice({ block }) {
  if (!block || typeof block !== "object") return null;
  const tone = TONES[block.state] ?? NEUTRAL;
  const openable = Boolean(block.reportPath && (block.state === "started" || block.state === "deduped"));

  return (
    <section
      aria-label="Deep investigation"
      className={`mt-4 border-l ${tone.border} bg-cm-surface/40 py-3 pl-4 pr-3`}
    >
      <p className={`font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.18em] ${tone.accent}`}>
        {tone.label}
      </p>

      {block.subject?.given ? (
        <p className="mt-1.5 break-all font-[family-name:var(--font-mono)] text-[11px] text-cm-faint">
          {block.subject.given}
        </p>
      ) : null}

      {block.reading ? <p className="mt-2 text-[13px] leading-relaxed text-cm-muted">{block.reading}</p> : null}

      {/* Why a job started at all, in the reader's own words. Someone who did not mean to
          ask for one is entitled to see which phrase was read that way. */}
      {Array.isArray(block.matched) && block.matched.length && openable ? (
        <p className="mt-2 text-[12px] leading-relaxed text-cm-faint">
          Started because you asked to {block.matched.slice(0, 2).map((m) => `“${m}”`).join(" / ")}.
        </p>
      ) : null}

      {block.warning ? <p className="mt-2 text-[12px] leading-relaxed text-cm-warn">{block.warning}</p> : null}

      {openable ? (
        <Link
          href={block.reportPath}
          className="mt-3 inline-flex h-8 items-center rounded-lg border border-cm-border px-3 text-[12px] font-medium text-cm-text transition hover:bg-cm-row-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-accent"
        >
          Follow the investigation
        </Link>
      ) : null}

      {block.access && block.access.remaining != null && openable ? (
        <p className="mt-2 text-[11px] text-cm-faint">
          {block.access.remaining} of {block.access.limit} left today
          {block.access.degraded ? " (counted locally — this instance could not reach the shared counter)" : ""}.
        </p>
      ) : null}
    </section>
  );
}
