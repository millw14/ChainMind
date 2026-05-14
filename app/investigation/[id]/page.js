import Link from "next/link";
import { notFound } from "next/navigation";
import { getTursoClient, tursoFetchInvestigationCase } from "@/lib/turso.js";

export const runtime = "nodejs";

/**
 * Frozen investigation viewer — loads snapshot from Turso (no live re-score).
 */
export default async function InvestigationPage({ params }) {
  const { id } = await params;
  const caseId = String(id ?? "").trim();
  if (!caseId) notFound();

  const client = getTursoClient();
  if (!client) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 text-zinc-200">
        <p>Turso is not configured on this deployment — frozen cases cannot be loaded.</p>
      </main>
    );
  }

  const row = await tursoFetchInvestigationCase(client, caseId);
  if (!row) notFound();

  const title =
    typeof row.payload?.title === "string"
      ? row.payload.title
      : `Investigation ${caseId.slice(0, 8)}…`;

  return (
    <main className="mx-auto max-w-4xl px-4 py-10 text-zinc-100">
      <div className="mb-6 flex flex-col gap-2 border-b border-zinc-800 pb-6">
        <p className="text-xs uppercase tracking-wide text-zinc-500">Frozen case file</p>
        <h1 className="text-2xl font-semibold text-white">{title}</h1>
        <p className="font-mono text-sm text-zinc-400">{caseId}</p>
        <p className="text-sm text-zinc-400">
          Scope <span className="font-mono text-zinc-200">{row.scope_address}</span> · created{" "}
          {new Date((row.created_at ?? 0) * 1000).toISOString()}
        </p>
        <div className="flex flex-wrap gap-3 pt-2 text-sm">
          <a
            className="text-cyan-400 underline"
            href={`/api/cases/${encodeURIComponent(caseId)}`}
            target="_blank"
            rel="noreferrer"
          >
            Raw JSON
          </a>
          <a
            className="text-cyan-400 underline"
            href={`/api/cases/${encodeURIComponent(caseId)}?format=markdown`}
            target="_blank"
            rel="noreferrer"
          >
            Markdown export
          </a>
          <Link href="/dashboard" className="text-zinc-500 underline">
            Dashboard
          </Link>
        </div>
      </div>

      <pre className="max-h-[70vh] overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-xs leading-relaxed text-zinc-300">
        {JSON.stringify(row.payload, null, 2)}
      </pre>
    </main>
  );
}
