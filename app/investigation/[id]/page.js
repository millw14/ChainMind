import Link from "next/link";
import { notFound } from "next/navigation";
import { getTursoClient, tursoFetchInvestigationCase } from "@/lib/turso.js";

export const runtime = "nodejs";

function VerdictBadge({ verdict, confidence }) {
  const colors = {
    escalate: "bg-red-500/20 text-red-400 border-red-500/40",
    monitor: "bg-yellow-500/20 text-yellow-400 border-yellow-500/40",
    dismiss: "bg-zinc-500/20 text-zinc-400 border-zinc-500/40",
  };
  return (
    <div className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-mono font-semibold uppercase tracking-widest ${colors[verdict] ?? colors.dismiss}`}>
      <span className={`h-2 w-2 rounded-full ${verdict === "escalate" ? "bg-red-400 animate-pulse" : verdict === "monitor" ? "bg-yellow-400" : "bg-zinc-400"}`} />
      {verdict} · {Math.round(confidence * 100)}%
    </div>
  );
}

function SignalBar({ weight }) {
  const pct = Math.round(weight * 100);
  const color = pct >= 70 ? "bg-red-500" : pct >= 40 ? "bg-yellow-500" : "bg-zinc-500";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 rounded-full bg-zinc-800">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono text-xs text-zinc-500">{pct}</span>
    </div>
  );
}

function WalletAddress({ address }) {
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
  return (
    <a
      href={`https://solscan.io/account/${address}`}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-xs text-cyan-400 hover:text-cyan-300 hover:underline"
      title={address}
    >
      {short}
    </a>
  );
}

function TxSignature({ signature }) {
  if (!signature || signature === "none") return <span className="font-mono text-xs text-zinc-600">—</span>;
  const short = `${signature.slice(0, 8)}…${signature.slice(-4)}`;
  return (
    <a
      href={`https://solscan.io/tx/${signature}`}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-xs text-cyan-400 hover:text-cyan-300 hover:underline"
      title={signature}
    >
      {short}
    </a>
  );
}

export default async function InvestigationPage({ params }) {
  const { id } = await params;
  const caseId = String(id ?? "").trim();
  if (!caseId) notFound();

  const client = getTursoClient();
  if (!client) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 text-zinc-200">
        <p>Turso is not configured on this deployment.</p>
      </main>
    );
  }

  const row = await tursoFetchInvestigationCase(client, caseId);
  if (!row) notFound();

  const payload = row.payload ?? {};
  const groq = payload.groqAnalysis?.analysis ?? null;
  const ai = payload.aiDetection ?? {};
  const fundingGraph = payload.fundingGraph ?? {};
  const evidenceRows = payload.evidenceRows ?? [];
  const createdAt = new Date((row.created_at ?? 0) * 1000).toISOString();

  const verdict = groq?.verdict ?? "dismiss";
  const confidence = groq?.confidence ?? 0;
  const pattern = groq?.pattern ?? "unknown";
  const signals = groq?.signals ?? [];
  const namedEntities = groq?.named_entities ?? [];
  const topEvidence = groq?.top_evidence ?? [];
  const nextAction = groq?.next_action ?? "";
  const nextSteps = groq?.next_steps ?? [];
  const limitingFactors = groq?.limiting_factors ?? [];
  const manipFor = groq?.manipulation_vs_benign?.for ?? (typeof groq?.manipulation_vs_benign === "string" ? groq.manipulation_vs_benign.split("|")[0]?.replace("FOR:", "").trim() : "");
  const manipAgainst = groq?.manipulation_vs_benign?.against ?? (typeof groq?.manipulation_vs_benign === "string" ? groq.manipulation_vs_benign.split("|")[1]?.replace("AGAINST:", "").trim() : "");
  const sharedFunders = fundingGraph?.sharedInboundFunders ?? [];
  const detectors = ai?.detectors ?? {};
  const composite = ai?.composite?.score0_100 ?? null;

  const riskColor = verdict === "escalate" ? "border-red-900/60 bg-red-950/20" : verdict === "monitor" ? "border-yellow-900/60 bg-yellow-950/20" : "border-zinc-800 bg-zinc-900/20";

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100" style={{ fontFamily: "'IBM Plex Mono', 'Courier New', monospace" }}>
      {/* Header */}
      <div className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur sticky top-0 z-10">
        <div className="mx-auto max-w-5xl px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/dashboard" className="text-zinc-500 hover:text-zinc-300 text-xs">← Dashboard</Link>
            <span className="text-zinc-700">·</span>
            <span className="text-xs text-zinc-500 uppercase tracking-widest">Case File</span>
          </div>
          <div className="flex gap-3 text-xs">
            <a href={`/api/cases/${caseId}`} target="_blank" rel="noreferrer" className="text-zinc-500 hover:text-cyan-400">JSON</a>
            <a href={`/api/cases/${caseId}?format=markdown`} target="_blank" rel="noreferrer" className="text-zinc-500 hover:text-cyan-400">Markdown</a>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-5xl px-4 py-10 space-y-8">

        {/* Hero */}
        <div className={`rounded-xl border p-6 ${riskColor}`}>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-widest text-zinc-500">Scope</p>
              <WalletAddress address={row.scope_address} />
              <p className="text-xs text-zinc-600 mt-1">{createdAt}</p>
            </div>
            <div className="space-y-2 text-right">
              <VerdictBadge verdict={verdict} confidence={confidence} />
              {pattern && pattern !== "unknown" && (
                <p className="text-xs text-zinc-500 uppercase tracking-wider">{pattern.replace(/-/g, " ")}</p>
              )}
              {composite !== null && (
                <p className="text-xs text-zinc-600">AI composite {composite}/100</p>
              )}
            </div>
          </div>
        </div>

        {/* Signals */}
        {signals.length > 0 && (
          <section>
            <h2 className="text-xs uppercase tracking-widest text-zinc-500 mb-4">Detection Signals</h2>
            <div className="space-y-3">
              {signals.filter(s => s.weight > 0).sort((a, b) => b.weight - a.weight).map((s, i) => (
                <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3 flex items-start gap-4">
                  <div className="min-w-[140px]">
                    <p className="text-xs font-semibold uppercase tracking-wider text-zinc-300">{s.type?.replace(/-/g, " ")}</p>
                    <SignalBar weight={s.weight} />
                  </div>
                  <p className="text-xs text-zinc-400 leading-relaxed">{s.detail}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Shared Funders */}
        {sharedFunders.length > 0 && (
          <section>
            <h2 className="text-xs uppercase tracking-widest text-zinc-500 mb-4">Shared Inbound Funders</h2>
            <div className="space-y-3">
              {sharedFunders.map((f, i) => (
                <div key={i} className="rounded-lg border border-red-900/40 bg-red-950/10 px-4 py-3">
                  <div className="flex items-center gap-3 mb-2">
                    <WalletAddress address={f.funder} />
                    <span className="text-xs text-red-400">funded {f.recipientCount} top payers</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {String(f.recipientPayers ?? "").split(" ").filter(Boolean).map((p, j) => (
                      <WalletAddress key={j} address={p} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Top Evidence */}
        {topEvidence.filter(e => e.signature && e.signature !== "none").length > 0 && (
          <section>
            <h2 className="text-xs uppercase tracking-widest text-zinc-500 mb-4">Top Evidence</h2>
            <div className="rounded-lg border border-zinc-800 overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-zinc-900 text-zinc-500 uppercase tracking-wider">
                  <tr>
                    <th className="px-4 py-2 text-left">Signature</th>
                    <th className="px-4 py-2 text-left">Actor</th>
                    <th className="px-4 py-2 text-left">Action</th>
                    <th className="px-4 py-2 text-left">Slot</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60">
                  {topEvidence.map((e, i) => (
                    <tr key={i} className="bg-zinc-900/30 hover:bg-zinc-900/60">
                      <td className="px-4 py-2"><TxSignature signature={e.signature} /></td>
                      <td className="px-4 py-2"><WalletAddress address={e.actor} /></td>
                      <td className="px-4 py-2 text-zinc-400">{e.action}</td>
                      <td className="px-4 py-2 text-zinc-600">{e.slot}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Named Entities */}
        {namedEntities.filter(e => !e.startsWith("(")).length > 0 && (
          <section>
            <h2 className="text-xs uppercase tracking-widest text-zinc-500 mb-4">Named Entities</h2>
            <div className="flex flex-wrap gap-2">
              {namedEntities.filter(e => !e.startsWith("(")).map((e, i) => (
                <div key={i} className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5">
                  <WalletAddress address={e} />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Detectors */}
        {Object.values(detectors).some(d => d.triggered) && (
          <section>
            <h2 className="text-xs uppercase tracking-widest text-zinc-500 mb-4">Triggered Detectors</h2>
            <div className="space-y-3">
              {Object.values(detectors).filter(d => d.triggered).map((d, i) => (
                <div key={i} className="rounded-lg border border-orange-900/40 bg-orange-950/10 px-4 py-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-semibold text-orange-400 uppercase tracking-wider">{d.name?.replace(/detect_/g, "").replace(/_/g, " ")}</span>
                    <span className={`text-xs px-2 py-0.5 rounded ${d.severity === "high" ? "bg-red-500/20 text-red-400" : "bg-yellow-500/20 text-yellow-400"}`}>{d.severity}</span>
                  </div>
                  <p className="text-xs text-zinc-400">{d.summary}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Adversarial Analysis */}
        {(manipFor || manipAgainst) && (
          <section>
            <h2 className="text-xs uppercase tracking-widest text-zinc-500 mb-4">Adversarial Analysis</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {manipFor && (
                <div className="rounded-lg border border-red-900/40 bg-red-950/10 px-4 py-3">
                  <p className="text-xs font-semibold text-red-400 uppercase tracking-wider mb-2">Case For Manipulation</p>
                  <p className="text-xs text-zinc-400 leading-relaxed">{manipFor}</p>
                </div>
              )}
              {manipAgainst && (
                <div className="rounded-lg border border-green-900/40 bg-green-950/10 px-4 py-3">
                  <p className="text-xs font-semibold text-green-400 uppercase tracking-wider mb-2">Case Against</p>
                  <p className="text-xs text-zinc-400 leading-relaxed">{manipAgainst}</p>
                </div>
              )}
            </div>
          </section>
        )}

        {/* Next Action */}
        {nextAction && (
          <section>
            <h2 className="text-xs uppercase tracking-widest text-zinc-500 mb-4">Recommended Action</h2>
            <div className="rounded-lg border border-cyan-900/40 bg-cyan-950/10 px-4 py-3">
              <p className="text-xs text-cyan-300 leading-relaxed">{nextAction}</p>
            </div>
          </section>
        )}

        {/* Next Steps + Limiting Factors */}
        <div className="grid gap-6 sm:grid-cols-2">
          {nextSteps.length > 0 && (
            <section>
              <h2 className="text-xs uppercase tracking-widest text-zinc-500 mb-4">Next Steps</h2>
              <ol className="space-y-2">
                {nextSteps.map((s, i) => (
                  <li key={i} className="flex gap-3 text-xs text-zinc-400">
                    <span className="text-zinc-600 font-mono">{i + 1}.</span>
                    <span className="leading-relaxed">{s}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}
          {limitingFactors.length > 0 && (
            <section>
              <h2 className="text-xs uppercase tracking-widest text-zinc-500 mb-4">Limiting Factors</h2>
              <ul className="space-y-2">
                {limitingFactors.map((f, i) => (
                  <li key={i} className="flex gap-3 text-xs text-zinc-500">
                    <span className="text-zinc-700">·</span>
                    <span className="leading-relaxed">{f}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {/* Evidence Rows Sample */}
        {evidenceRows.length > 0 && (
          <details className="group">
            <summary className="cursor-pointer list-none">
              <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3 hover:bg-zinc-800/60">
                <p className="font-mono text-xs uppercase tracking-widest text-zinc-500">
                  Transfer Evidence ({evidenceRows.length} rows)
                </p>
                <span className="text-xs text-zinc-600 group-open:hidden">▼ expand</span>
                <span className="hidden text-xs text-zinc-600 group-open:block">▲ collapse</span>
              </div>
            </summary>
            <div className="mt-2 rounded-lg border border-zinc-800 overflow-auto max-h-64">
              <table className="w-full text-xs">
                <thead className="bg-zinc-900 text-zinc-500 uppercase tracking-wider sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left">From</th>
                    <th className="px-3 py-2 text-left">To</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/40">
                  {evidenceRows.slice(0, 40).map((r, i) => (
                    <tr key={i} className="bg-zinc-900/20 hover:bg-zinc-900/50">
                      <td className="px-3 py-1.5"><WalletAddress address={r.from?.slice(0, 44) ?? ""} /></td>
                      <td className="px-3 py-1.5"><WalletAddress address={r.to?.slice(0, 44) ?? ""} /></td>
                      <td className="px-3 py-1.5 text-right text-zinc-500 font-mono">{Number(r.amt ?? r.amount ?? 0).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}

        {/* Footer */}
        <div className="border-t border-zinc-800 pt-6 text-xs text-zinc-600 flex justify-between items-center">
          <span>Case {caseId}</span>
          <span>Frozen snapshot · {createdAt}</span>
        </div>
      </div>
    </main>
  );
}
