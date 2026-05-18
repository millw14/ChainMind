import Link from "next/link";
import { getTursoClient, tursoFetchRecentCases } from "@/lib/turso.js";

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

export const runtime = "nodejs";
export const metadata = { title: "Investigations · ChainMind" };

export default async function CasesPage() {
  const client = getTursoClient();
  const cases = client ? await tursoFetchRecentCases(client, 50).catch(() => []) : [];

  return (
    <main className="mx-auto max-w-[88rem] px-3 py-6 sm:px-6 sm:py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-cm-faint">Case history</p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-cm-text">Investigations</h1>
        </div>
        <span className="font-mono text-xs text-cm-faint">{cases.length} cases</span>
      </div>

      {cases.length === 0 ? (
        <div className="rounded-md border border-dashed border-cm-border px-6 py-16 text-center">
          <p className="text-sm text-cm-faint">No investigations yet — scan an address on the dashboard to create one.</p>
          <Link href="/dashboard" className="mt-4 inline-block font-mono text-xs text-cm-accent-bright hover:underline">
            Go to dashboard →
          </Link>
        </div>
      ) : (
        <div className="rounded-md border border-cm-border bg-cm-surface/95 divide-y divide-cm-border-subtle">
          {/* Header row */}
          <div className="hidden sm:grid grid-cols-[auto_1fr_auto_auto_auto] gap-4 px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-cm-faint">
            <span>Verdict</span>
            <span>Address</span>
            <span>Pattern</span>
            <span>Confidence</span>
            <span>Time</span>
          </div>
          {cases.map((c) => {
            const v = String(c.verdict ?? "dismiss");
            const created = c.created_at ? Number(c.created_at) : 0;
            return (
              <Link
                key={c.id}
                href={`/investigation/${c.id}`}
                className="flex sm:grid sm:grid-cols-[auto_1fr_auto_auto_auto] items-center gap-2 sm:gap-4 px-4 py-3 hover:bg-cm-row-hover transition-colors"
              >
                {/* Risk dot — mobile only */}
                <span className={`sm:hidden h-2 w-2 flex-shrink-0 rounded-full ${riskDot(c.risk_level ?? "low")}`} />

                {/* Verdict badge */}
                <span className={`flex-shrink-0 rounded border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${verdictStyle(v)}`}>
                  {v}
                </span>

                {/* Address */}
                <span className="min-w-0 flex-1 font-mono text-xs text-cm-text truncate">
                  {shortAddr(c.scope_address ?? "")}
                </span>

                {/* Pattern — hidden on mobile */}
                <span className="hidden sm:block flex-shrink-0 font-mono text-[10px] text-cm-faint truncate max-w-[160px]">
                  {c.pattern && c.pattern !== "unknown" ? String(c.pattern).replace(/-/g, " ") : "—"}
                </span>

                {/* Confidence */}
                <span className="flex-shrink-0 font-mono text-xs text-cm-accent-bright">
                  {Math.round(Number(c.confidence ?? 0) * 100)}%
                </span>

                {/* Time */}
                <span className="flex-shrink-0 font-mono text-[10px] text-cm-faint whitespace-nowrap">
                  {created ? timeAgo(created) : "—"}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}
