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
  const lim = Math.min(50, Math.max(1, Number(limit) || 10));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(/**  @type {string | null} */ (null));
  const [cases, setCases] = useState(/** @type {unknown[]} */ ([]));

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const r = await fetch(`/api/cases?limit=${lim}`, { cache: "no-store" });
        const j = await r.json();
        if (cancel) return;
        if (!r.ok || !j.ok) {
          setLoading(false);
          setError(j?.error || r.statusText || "Failed to load cases");
          setCases([]);
          return;
        }
        setLoading(false);
        setError(null);
        setCases(Array.isArray(j.cases) ? j.cases : []);
      } catch (e) {
        if (!cancel) {
          setLoading(false);
          setError(String(e?.message ?? e));
          setCases([]);
        }
      }
    })();
    return () => {
      cancel = true;
    };
  }, [lim]);

  useEffect(() => {
    const handler = () => {
      fetch(`/api/cases?limit=${lim}`)
        .then((r) => r.json())
        .then((d) => {
          if (d.ok) setCases(d.cases ?? []);
        })
        .catch(() => {});
    };
    window.addEventListener("chainmind:case-created", handler);
    return () => window.removeEventListener("chainmind:case-created", handler);
  }, [lim]);

  if (loading) {
    return (
      <section className="rounded-md border border-cm-border bg-cm-surface/80 px-4 py-6 sm:px-5">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-cm-faint">Case history</p>
        <p className="mt-2 text-xs text-cm-muted">Loading recent investigations…</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="rounded-md border border-cm-bad/40 bg-cm-bad/10 px-4 py-6 sm:px-5">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-cm-faint">Case history</p>
        <p className="mt-2 text-sm text-cm-subtle">{error}</p>
      </section>
    );
  }

  if (!cases.length) {
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
        {cases.map((c) => {
          const row = /** @type {{ id?: string, verdict?: string, confidence?: number, scope_address?: string, pattern?: string, created_at?: number }} */ (c);
          const v = String(row.verdict ?? "dismiss");
          const created = row.created_at ? new Date(Number(row.created_at) * 1000).toISOString() : "";
          return (
            <Link
              key={row.id}
              href={`/investigation/${row.id}`}
              className="flex flex-wrap items-center gap-3 px-4 py-3 transition-colors hover:bg-cm-surface/60 sm:px-5"
            >
              <span className={`rounded border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${verdictStyle(v)}`}>
                {v}
              </span>
              <span className="font-mono text-xs text-cm-accent-bright">{Math.round(Number(row.confidence ?? 0) * 100)}%</span>
              <span className="min-w-0 flex-1 font-mono text-xs text-cm-muted">
                <span className="text-cm-text">{shortAddr(row.scope_address ?? "")}</span>
                {row.pattern && row.pattern !== "unknown" ? (
                  <span className="ml-2 text-cm-faint">· {String(row.pattern).replace(/-/g, " ")}</span>
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
