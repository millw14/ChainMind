"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A DEEP INVESTIGATION, ON A PAGE.
 *
 * WHAT THIS COMPONENT DECIDES: nothing. Every sentence, every label, every "this is a
 * bound and not a measurement" is computed server-side in lib/research-view.js, which
 * `node --test` can load and this file cannot. The three rules that are easiest to break
 * exactly here — missing is not zero, an outage is not an absence, a bound is not exact —
 * are held there and rendered here.
 *
 * THE FOUR THINGS THAT MUST SURVIVE THE JOURNEY ONTO A SCREEN, because a report that
 * loses any of them is the summary this whole feature exists not to be:
 *
 *   1. EVERY FINDING SHOWS ITS SOURCE AND HOW THAT SOURCE WAS REACHED. A URL the user
 *      pasted and a URL found in the subject's own marketing are different evidence, and
 *      the difference is printed on every line rather than explained once at the top.
 *   2. QUOTED CONTENT IS VISIBLY THE INVESTIGATED PARTY'S OWN WORDS. It gets a mark, a
 *      rule down its left edge and a label. A quote that renders like the report's own
 *      prose is a claim wearing the report's authority.
 *   3. WHAT WAS NOT CHECKED IS AS LOUD AS WHAT WAS. It is a section, not a footnote: a
 *      page that lists findings and stops is read as exhaustive.
 *   4. THE CAPS ARE VISIBLE. A run that stopped at a ceiling stopped at a cap and not at
 *      an answer, and the banner says so above everything else.
 *
 * POLLING STOPS WHEN THE SERVER SAYS IT SHOULD, and never on a guess: `keepPolling` comes
 * from the status, so an outage of ours keeps polling (the job may still be running) while
 * a terminal state does not. A page that gave up on a running job would report our
 * impatience as the investigation's outcome.
 */

/** How often to ask again while a job is still moving. Minutes-long work; seconds-long UI. */
const POLL_MS = 6_000;
/** Backed off after a failed poll, so an outage is not hammered. */
const POLL_BACKOFF_MS = 15_000;

const TONE_CLASS = {
  waiting: "text-cm-accent",
  good: "text-cm-accent",
  partial: "text-cm-warn",
  bad: "text-cm-bad",
  unknown: "text-cm-muted",
};

export function ReportView({ id }) {
  const [state, setState] = useState({ loading: true, error: null, payload: null });
  const timerRef = useRef(null);
  const aliveRef = useRef(true);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/research/${encodeURIComponent(id)}`, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      const data = await res.json().catch(() => null);
      if (!aliveRef.current) return;
      if (!data) {
        setState((s) => ({ ...s, loading: false, error: "This page could not read a reply from the server. The investigation is unaffected by that." }));
        return POLL_BACKOFF_MS;
      }
      setState({ loading: false, error: null, payload: data });
      return data?.job?.keepPolling ? POLL_MS : null;
    } catch {
      if (!aliveRef.current) return null;
      // A failed poll is a fact about this browser's connection, never about the job.
      setState((s) => ({ ...s, loading: false, error: "Could not reach this site just now — the investigation is running on its own and is unaffected." }));
      return POLL_BACKOFF_MS;
    }
  }, [id]);

  useEffect(() => {
    aliveRef.current = true;
    let cancelled = false;
    const run = async () => {
      const next = await poll();
      if (cancelled || !aliveRef.current || !next) return;
      timerRef.current = setTimeout(run, next);
    };
    run();
    return () => {
      cancelled = true;
      aliveRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [poll]);

  const payload = state.payload;
  const job = payload?.job ?? null;
  const report = payload?.report ?? null;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 pb-24 pt-24 sm:px-6 sm:pt-28">
      <header>
        <Eyebrow>Deep investigation</Eyebrow>
        <h1 className="mt-3 break-all text-2xl font-bold tracking-tight text-cm-text sm:text-3xl">
          {job?.subject?.given ?? report?.subject?.given ?? "Investigation"}
        </h1>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className={`font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-widest ${TONE_CLASS[job?.tone] ?? "text-cm-muted"}`}>
            {state.loading && !job ? "Loading" : (job?.label ?? "Unknown")}
          </span>
          {job?.progress?.step != null ? (
            <span className="font-[family-name:var(--font-mono)] text-[11px] text-cm-faint">
              step {job.progress.step}
              {job.progress.findings != null ? ` · ${job.progress.findings} finding(s)` : ""}
              {job.progress.lastTool ? ` · ${job.progress.lastTool}` : ""}
            </span>
          ) : null}
        </div>

        {job?.blurb ? <p className="mt-3 max-w-2xl text-sm leading-relaxed text-cm-muted">{job.blurb}</p> : null}
        {payload?.reading && payload.reading !== job?.blurb ? (
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-cm-muted">{payload.reading}</p>
        ) : null}
        {job?.serviceReading && job.serviceReading !== job.blurb ? (
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-cm-faint">{job.serviceReading}</p>
        ) : null}
        {state.error ? <p className="mt-3 text-[13px] leading-relaxed text-cm-warn">{state.error}</p> : null}

        {job?.keepPolling ? (
          <p className="mt-4 font-[family-name:var(--font-mono)] text-[11px] text-cm-faint">
            This page refreshes itself every {Math.round(POLL_MS / 1000)}s. An investigation takes minutes — you can
            close it and come back.
          </p>
        ) : null}
      </header>

      {report ? <Report report={report} /> : null}

      {!report && !state.loading ? (
        <p className="mt-10 max-w-2xl text-sm leading-relaxed text-cm-muted">
          There is no report to show yet. That is a statement about this job and this deployment, and not a finding
          about anything it was pointed at.
        </p>
      ) : null}

      <div className="mt-14 border-t border-cm-border-subtle pt-8">
        <Link href="/ask" className="text-sm text-cm-muted underline-offset-4 transition-colors hover:text-cm-text hover:underline">
          Back to the explorer
        </Link>
      </div>
    </div>
  );
}

/* ------------------------------- the report -------------------------------- */

function Report({ report }) {
  return (
    <div className="mt-12 space-y-12 sm:space-y-16">
      {report.banner ? (
        <p
          className={`border-l-2 ${report.banner.tone === "partial" ? "border-cm-warn" : "border-cm-border"} bg-cm-elevated/50 py-3 pl-4 pr-3 text-[13px] leading-relaxed text-cm-subtle`}
        >
          {report.banner.text}
        </p>
      ) : null}

      {report.summary ? (
        <Section eyebrow="Summary" title="What this run found">
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-cm-subtle">{report.summary.text}</p>
          <p className="mt-3 max-w-2xl text-[12px] leading-relaxed text-cm-faint">{report.summary.note}</p>
        </Section>
      ) : null}

      <Section
        eyebrow="Findings"
        title={report.findingCount == null ? "Findings" : `${report.findingCount} finding${report.findingCount === 1 ? "" : "s"}`}
        lede={report.findingsNote}
      >
        {report.groups.length ? (
          <div className="mt-8 space-y-10">
            {report.groups.map((g) => (
              <div key={g.group ?? g.label}>
                <h3 className="font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-widest text-cm-accent-dim">
                  {g.label ?? g.group}
                  {g.count != null ? ` · ${g.count}` : ""}
                </h3>
                <ol className="mt-4 space-y-px border border-cm-border bg-cm-border">
                  {g.findings.map((f, i) => (
                    <li key={f.id ?? `${g.group}-${i}`} className="bg-cm-elevated/60 p-5 sm:p-6">
                      <p className="text-[15px] leading-relaxed text-cm-text">{f.statement}</p>
                      {f.restsOn ? (
                        <p className="mt-3 border-l border-cm-border pl-4 text-[12px] leading-relaxed text-cm-muted">
                          <span className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-widest text-cm-faint">
                            Rests on{" "}
                          </span>
                          {f.restsOn}
                        </p>
                      ) : null}
                      {f.evidence.length ? (
                        <ul className="mt-4 space-y-4">
                          {f.evidence.map((e, j) => (
                            <Evidence key={`${f.id ?? i}-${j}`} evidence={e} />
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-6 max-w-2xl text-sm leading-relaxed text-cm-muted">
            No findings were recorded on this run.
          </p>
        )}
      </Section>

      <Section
        eyebrow="Sources"
        title="Everything this run actually read"
        lede={report.checked.note}
      >
        <p className="mt-4 font-[family-name:var(--font-mono)] text-[11px] text-cm-faint">
          {report.checked.reached == null ? "reached: not reported" : `${report.checked.reached} reached`}
          {report.checked.proposed == null ? "" : ` of ${report.checked.proposed} proposed`}
        </p>
        {report.checked.targets.length ? (
          <Scroller>
            <table className="w-full min-w-[40rem] text-left text-xs sm:text-sm">
              <thead className="border-b border-cm-border bg-cm-row">
                <tr>
                  <Th>Address</Th>
                  <Th>How it became a target</Th>
                  <Th>Reached</Th>
                  <Th>Requests</Th>
                  <Th>Bytes</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cm-border text-cm-muted">
                {report.checked.targets.map((t) => (
                  <tr key={t.url}>
                    <td className="max-w-[18rem] break-all px-3 py-2 font-[family-name:var(--font-mono)] text-[11px] text-cm-subtle">
                      {t.url}
                    </td>
                    <td className="px-3 py-2 leading-relaxed">
                      {t.provenanceLabel ?? t.provenance ?? "not reported"}
                      {t.anchored ? " · anchor" : t.depth != null ? ` · depth ${t.depth}` : ""}
                      {t.foundIn ? <span className="block text-cm-faint">found in {t.foundIn}</span> : null}
                    </td>
                    <td className="px-3 py-2">{t.reached ? "yes" : "no"}</td>
                    <td className="px-3 py-2 tabular-nums">{t.requests ?? "—"}</td>
                    <td className="px-3 py-2 tabular-nums">{t.bytes ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroller>
        ) : null}
      </Section>

      <Section eyebrow="Boundary" title="What it refused to follow" lede={report.declined.note}>
        {report.declined.steeringNote ? (
          <p className="mt-4 border-l-2 border-cm-warn bg-cm-elevated/50 py-3 pl-4 pr-3 text-[13px] leading-relaxed text-cm-subtle">
            {report.declined.steeringNote}
          </p>
        ) : null}
        {report.declined.entries.length ? (
          <ul className="mt-6 space-y-px border border-cm-border bg-cm-border">
            {report.declined.entries.map((d, i) => (
              <li key={`${d.url}-${i}`} className="bg-cm-elevated/60 p-4">
                <p className="break-all font-[family-name:var(--font-mono)] text-[11px] text-cm-subtle">{d.url}</p>
                <p className="mt-1 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-widest text-cm-faint">
                  {d.code ?? "refused"}
                </p>
                {d.reason ? <p className="mt-2 text-[13px] leading-relaxed text-cm-muted">{d.reason}</p> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      {report.machineDirectedText.reading ? (
        <Section eyebrow="Content aimed at machines" title="Text addressed at an automated reviewer">
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-cm-muted">{report.machineDirectedText.reading}</p>
          {report.machineDirectedText.findings.length ? (
            <ul className="mt-6 space-y-3">
              {report.machineDirectedText.findings.map((m, i) => (
                <li key={i}>
                  <Quote
                    text={typeof m === "string" ? m : (m?.quote ?? JSON.stringify(m))}
                    label="THE INVESTIGATED PARTY'S OWN WORDS. Quoted as evidence; its instructions were not followed."
                    subjectsOwnWords
                  />
                  {typeof m === "object" && m?.where ? (
                    <p className="mt-1 text-[11px] text-cm-faint">found in {String(m.where)}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </Section>
      ) : null}

      {report.rejectedClaims.entries.length ? (
        <Section eyebrow="Citation check" title="Claims this run tried to record and could not">
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-cm-muted">{report.rejectedClaims.note}</p>
          <ul className="mt-6 space-y-2 text-[13px] leading-relaxed text-cm-muted">
            {report.rejectedClaims.entries.map((r, i) => (
              <li key={i} className="border-l border-cm-border pl-4">
                {typeof r === "string" ? r : (r?.reason ?? r?.statement ?? JSON.stringify(r))}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section eyebrow="Scope" title="What was NOT checked" lede={report.notCheckedNote}>
        <ul className="mt-6 space-y-3">
          {report.notChecked.map((n, i) => (
            <li key={i} className="border-l border-cm-border pl-4 text-sm leading-relaxed text-cm-muted">
              {n}
            </li>
          ))}
        </ul>
      </Section>

      <Section eyebrow="Bounds" title="What it was allowed to spend" lede={report.caps.reading ?? report.caps.absentNote}>
        {report.caps.rows.length ? (
          <Scroller>
            <table className="w-full min-w-[32rem] text-left text-xs sm:text-sm">
              <thead className="border-b border-cm-border bg-cm-row">
                <tr>
                  <Th>Resource</Th>
                  <Th>Used</Th>
                  <Th>Ceiling</Th>
                  <Th>Reading</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cm-border text-cm-muted">
                {report.caps.rows.map((r) => (
                  <tr key={r.resource}>
                    <td className="px-3 py-2 text-cm-subtle">{r.label}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {r.capped ? "at least " : ""}
                      {r.used ?? "not reported"}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{r.cap ?? "—"}</td>
                    <td className="px-3 py-2 leading-relaxed">{r.reading}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroller>
        ) : null}

        {report.cost.present ? (
          <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2 font-[family-name:var(--font-mono)] text-[11px] text-cm-faint">
            {report.cost.rows.map((c) => (
              <li key={c.label}>
                {c.label}: {c.value == null ? "not reported" : `${c.bound ? "at least " : ""}${c.value}`}
              </li>
            ))}
          </ul>
        ) : null}
        {report.cost.note ? <p className="mt-3 max-w-2xl text-[12px] leading-relaxed text-cm-faint">{report.cost.note}</p> : null}
      </Section>

      {report.languageScrubbed.length ? (
        <Section eyebrow="Edits" title="Words removed from this report">
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-cm-muted">{report.languageScrubbedNote}</p>
          <p className="mt-3 font-[family-name:var(--font-mono)] text-[11px] text-cm-faint">
            {report.languageScrubbed.join(", ")}
          </p>
        </Section>
      ) : null}

      {report.disclaimer ? (
        <p className="border-t border-cm-border-subtle pt-8 text-[13px] leading-relaxed text-cm-muted">
          {report.disclaimer}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------ small pieces ------------------------------- */

function Evidence({ evidence }) {
  const s = evidence.source ?? {};
  return (
    <li className="border-l border-cm-border-subtle pl-4">
      {evidence.what ? <p className="text-[13px] leading-relaxed text-cm-subtle">{evidence.what}</p> : null}
      {evidence.quoted ? (
        <Quote text={evidence.quoted.text} label={evidence.quoted.label} subjectsOwnWords={evidence.quoted.subjectsOwnWords} />
      ) : null}
      <p className="mt-2 break-all font-[family-name:var(--font-mono)] text-[10px] leading-relaxed text-cm-faint">
        {s.url ?? "source not reported"}
        {s.tool ? ` · ${s.tool}` : ""}
        {s.retrievedAt ? ` · ${s.retrievedAt}` : ""}
      </p>
      {s.provenanceLabel || s.howItWasReached ? (
        <p className="mt-1 text-[11px] leading-relaxed text-cm-faint">
          <span className="uppercase tracking-widest">{s.provenanceLabel ?? s.provenance}</span>
          {s.howItWasReached ? ` — ${s.howItWasReached}` : ""}
        </p>
      ) : null}
    </li>
  );
}

/**
 * A QUOTE, MARKED FOR WHOSE WORDS IT IS.
 *
 * The rule down the left edge and the label above it are the whole point: inside this
 * page, everything else is the report's own prose about what was measured, and this is
 * somebody else's writing being shown as evidence of what they wrote. A chain record gets
 * a different rule because it is the one class of source the subject did not author.
 */
function Quote({ text, label, subjectsOwnWords }) {
  if (!text) return null;
  return (
    <figure className={`mt-3 border-l-2 ${subjectsOwnWords ? "border-cm-warn" : "border-cm-accent-dim"} bg-cm-bg/60 py-2 pl-4 pr-3`}>
      <figcaption className="font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-[0.18em] text-cm-faint">
        {label}
      </figcaption>
      <blockquote className="mt-1.5 whitespace-pre-wrap break-words font-[family-name:var(--font-mono)] text-[12px] leading-relaxed text-cm-subtle">
        {text}
      </blockquote>
    </figure>
  );
}

function Eyebrow({ children }) {
  return (
    <p className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-widest text-cm-faint">{children}</p>
  );
}

function Section({ eyebrow, title, lede, children }) {
  return (
    <section className="border-t border-cm-border-subtle pt-10 sm:pt-12">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className="mt-3 text-xl font-bold tracking-tight text-cm-text sm:text-2xl">{title}</h2>
      {lede ? <p className="mt-4 max-w-2xl text-sm leading-relaxed text-cm-muted">{lede}</p> : null}
      {children}
    </section>
  );
}

function Th({ children }) {
  return <th className="px-3 py-2 font-semibold uppercase tracking-wide text-cm-faint">{children}</th>;
}

/** Wide content scrolls inside its own box — the page itself never does. */
function Scroller({ children }) {
  return <div className="mt-6 overflow-x-auto border border-cm-border">{children}</div>;
}
