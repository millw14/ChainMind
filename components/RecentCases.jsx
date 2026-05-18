"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

function shortAddr(a) {
  if (!a || a.length < 10) return a || "—";
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

function timeAgo(unixSec) {
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function verdictLabel(v) {
  if (v === "escalate") return "Manipulation Detected";
  if (v === "monitor") return "Anomaly Flagged";
  if (v === "dismiss") return "No Threat Found";
  return v;
}

function verdictStyle(v) {
  if (v === "escalate") return "bg-red-500/15 text-red-400 border-red-500/35";
  if (v === "monitor") return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  return "bg-zinc-500/10 text-zinc-400 border-zinc-600/40";
}

function riskDot(risk) {
  if (risk === "critical") return "bg-red-500 animate-pulse";
  if (risk === "high") return "bg-orange-500";
  if (risk === "medium") return "bg-yellow-500";
  return "bg-zinc-500";
}

export function RecentCases({ limit = 10 }) {
  const lim = Math.min(50, Math.max(1, Number(limit) || 10));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [cases, setCases] = useState([]);

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
        <p className="mt-2 text-xs text-cm-muted">No investigations yet — scan an address to create one.</p>
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
          const row = c;
          const v = String(row.verdict ?? "dismiss");
          const created = row.created_at ? Number(row.created_at) : 0;

          return (
            <Link
              key={row.id}
              href={`/investigation/${row.id}`}
              className="flex items-center gap-2 px-4 py-3 transition-colors hover:bg-cm-surface/60 sm:gap-3 sm:px-5"
            >
              {/* Risk dot */}
              <span className={`h-2 w-2 flex-shrink-0 rounded-full ${riskDot(row.risk_level ?? "low")}`} />

              {/* Verdict badge */}
              <span
                className={`flex-shrink-0 rounded border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${verdictStyle(v)}`}
              >
                {verdictLabel(v)}
              </span>

              {/* Confidence */}
              <span className="flex-shrink-0 font-mono text-xs text-cm-accent-bright">
                {Math.round(Number(row.confidence ?? 0) * 100)}%
              </span>

              {/* Address */}
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-cm-text">{shortAddr(row.scope_address ?? "")}</span>

              {/* Pattern — hidden on mobile */}
              {row.pattern && row.pattern !== "unknown" ? (
                <span className="hidden max-w-[120px] flex-shrink-0 truncate font-mono text-[10px] text-cm-faint sm:block">
                  {String(row.pattern).replace(/-/g, " ")}
                </span>
              ) : null}

              {/* Time */}
              {created ? (
                <span className="flex-shrink-0 whitespace-nowrap font-mono text-[10px] text-cm-faint">{timeAgo(created)}</span>
              ) : null}
            </Link>
          );
        })}
      </div>
    </section>
  );
}
