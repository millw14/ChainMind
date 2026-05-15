"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

function shortAddr(a) {
  if (!a || a.length < 10) return a || "—";
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

function verdictStyle(v) {
  if (v === "escalate") return "bg-red-500/15 text-red-400 border-red-500/35";
  if (v === "monitor") return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  return "bg-zinc-500/10 text-zinc-400 border-zinc-600/40";
}

/**
 * @param {{ limit?: number }} props
 */
export function RecentCases({ limit = 10 }) {
  const [state, setState] = useState({ loading: true, error: null, cases: [] });

  useEffect(() => {
    let cancel = false;
    const lim = Math.min(50, Math.max(1, Number(limit) || 10));
    (async () => {
      try {
        const r = await fetch(`/api/cases?limit=${lim}`, { cache: "no-store" });
        const j = await r.json();
        if (cancel) return;
        if (!r.ok || !j.ok) {
          setState({ loading: false, error: j?.error || r.statusText || "Failed to load cases", cases: [] });
          return;
        }
        setState({ loading: false, error: null, cases: Array.isArray(j.cases) ? j.cases : [] });
      } catch (e) {
        if (!cancel) setState({ loading: false, error: String(e?.message ?? e), cases: [] });
      }
    })();
    return () => {
      cancel = true;
    };
  }, [limit]);

  if (state.loading) {
    return (
      <section className="rounded-md border border-cm-border bg-cm-surface/80 px-4 py-6 sm:px-5">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-cm-faint">Case history</p>
        <p className="mt-2 text-xs text-cm-muted">Loading recent investigations…</p>
      </section>
    );
  }

  if (state.error) {
    return (
      <section className="rounded-md border border-cm-bad/40 bg-cm-bad/10 px-4 py-6 sm:px-5">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-cm-faint">Case history</p>
        <p className="mt-2 text-sm text-cm-subtle">{state.error}</p>
      </section>
    );
  }

  if (state.cases.length === 0) {
    return (
      <section className="rounded-md border border-cm-border bg-cm-surface/80 px-4 py-6 sm:px-5">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-cm-faint">Case history</p>
        <p className="mt-2 text-xs text-cm-muted">No saved investigation cases yet. Create one via POST /api/cases.</p>
      </section>
    );
  }

  return (
    <section className="rounded-md border border-cm-border bg-cm-surface/95 shadow-cm">
      <div className="border-b border-cm-border-subtle px-4 py-3 sm:px-5">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-cm-faint">Case history</p>
        <h2 className="mt-1 text-sm font-semibold tracking-tight text-cm-text">Recent investigations</h2>
      </div>
      <div className="divide-y divide-cm-border-subtle">
        {state.cases.map((c) => {
          const v = String(c.verdict ?? "dismiss");
          const created = c.created_at ? new Date(Number(c.created_at) * 1000).toISOString() : "";
          return (
            <Link
              key={c.id}
              href={`/investigation/${c.id}`}
              className="flex flex-wrap items-center gap-3 px-4 py-3 transition-colors hover:bg-cm-surface/60 sm:px-5"
            >
              <span className={`rounded border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${verdictStyle(v)}`}>
                {v}
              </span>
              <span className="font-mono text-xs text-cm-accent-bright">{Math.round(Number(c.confidence ?? 0) * 100)}%</span>
              <span className="min-w-0 flex-1 font-mono text-xs text-cm-muted">
                <span className="text-cm-text">{shortAddr(c.scope_address)}</span>
                {c.pattern && c.pattern !== "unknown" ? (
                  <span className="ml-2 text-cm-faint">· {String(c.pattern).replace(/-/g, " ")}</span>
                ) : null}
              </span>
              {created ? <span className="font-mono text-[10px] text-cm-faint">{created.slice(0, 19).replace("T", " ")}</span> : null}
            </Link>
          );
        })}
      </div>
    </section>
  );
}
