import Link from "next/link";

export const metadata = {
  title: "Setup & docs",
};

export default function DocsPage() {
  return (
    <div className="border-b border-cm-border-subtle">
      <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
        <p className="font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-wide text-cm-faint">
          Reference
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-cm-text sm:text-3xl">Setup & environment</h1>
        <p className="mt-3 text-sm leading-relaxed text-cm-muted">
          ChainMind surfaces early coordination signals on Solana; this page is the operator reference for running the
          app and CLIs. Canonical copy also lives in{" "}
          <code className="rounded border border-cm-border bg-cm-elevated px-1 font-[family-name:var(--font-mono)] text-xs text-cm-subtle">
            readme.txt
          </code>{" "}
          at repo root.
        </p>

        <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-cm-faint">Local web app</h2>
        <ul className="mt-3 list-inside list-disc space-y-1.5 text-sm text-cm-muted">
          <li>
            <code className="font-[family-name:var(--font-mono)] text-xs text-cm-subtle">npm install</code>
          </li>
          <li>
            <code className="font-[family-name:var(--font-mono)] text-xs text-cm-subtle">npm run dev</code> →{" "}
            <span className="font-[family-name:var(--font-mono)] text-xs text-cm-subtle">http://localhost:3000</span>
          </li>
          <li>
            Production:{" "}
            <code className="font-[family-name:var(--font-mono)] text-xs text-cm-subtle">npm run build</code> ·{" "}
            <code className="font-[family-name:var(--font-mono)] text-xs text-cm-subtle">npm start</code>
          </li>
        </ul>

        <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-cm-faint">Environment variables</h2>
        <p className="mt-3 text-sm leading-relaxed text-cm-muted">
          Operators set these on the host (see <code className="font-mono text-xs text-cm-subtle">.env.example</code>);
          the dashboard UI does not surface variable names to end users.
        </p>
        <ul className="mt-3 list-inside list-disc space-y-1.5 text-sm text-cm-muted">
          <li>
            <strong className="font-medium text-cm-text">SOLANA_RPC_URL</strong> — required for{" "}
            <code className="font-mono text-xs">/api/ping</code>,{" "}
            <code className="font-mono text-xs">/api/inspect</code>, and related panels.
          </li>
          <li>
            <strong className="font-medium text-cm-text">TURSO_*</strong> — optional; without them, database counts and
            scores in the hosted dashboard stay unconfigured while RPC paths still run.
          </li>
          <li>
            <strong className="font-medium text-cm-text">DATABASE_PATH</strong> — optional path to SQLite (defaults to{" "}
            <code className="font-mono text-xs">data/chainmind.db</code>).
          </li>
          <li>
            <strong className="font-medium text-cm-text">CHAINMIND_WATCHLIST</strong> — optional path to a JSON
            watchlist; default <code className="font-mono text-xs">config/watchlist.json</code> (see example file in
            repo). Alternatively set <code className="font-mono text-xs">CHAINMIND_SCOPE</code> for a single address.
          </li>
          <li>
            <strong className="font-medium text-cm-text">GROQ_API_KEY</strong> — optional; enables{" "}
            <code className="font-mono text-xs">POST /api/groq-brief</code> and the &quot;Analyst brief&quot; panel on{" "}
            <code className="font-mono text-xs">/dashboard</code>.
          </li>
        </ul>

        <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-cm-faint">Vercel</h2>
        <ul className="mt-3 list-inside list-disc space-y-1.5 text-sm text-cm-muted">
          <li>Framework preset: Next.js. Do not set Output Directory to <code className="font-mono text-xs">public</code>.</li>
          <li>Set production env: at minimum <code className="font-mono text-xs">SOLANA_RPC_URL</code>; add Turso vars if you use cloud DB panels.</li>
        </ul>

        <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-cm-faint">CLI / pipeline</h2>
        <p className="mt-3 text-sm leading-relaxed text-cm-muted">
          Each parsed transaction writes graph rows{" "}
          <code className="font-mono text-xs">signers</code>,{" "}
          <code className="font-mono text-xs">transfers</code>,{" "}
          <code className="font-mono text-xs">program_calls</code>, and{" "}
          <code className="font-mono text-xs">edges</code> — see{" "}
          <code className="font-mono text-xs">lib/parse-tx-graph.js</code>. Roadmap for scaling ingestion and analytics:{" "}
          <code className="rounded border border-cm-border bg-cm-elevated px-1 font-[family-name:var(--font-mono)] text-xs text-cm-subtle">
            docs/strategic-plan-data-pipeline.md
          </code>
          . New <strong className="font-medium text-cm-text">Turso</strong> projects should apply{" "}
          <code className="font-mono text-xs">npm run turso:schema</code>; older databases may need{" "}
          <code className="font-mono text-xs">schema/migrations/001_signatures_composite_pk.sql</code> and{" "}
          <code className="font-mono text-xs">schema/migrations/002_graph_tables.sql</code> once each.
        </p>
        <div className="mt-4 overflow-x-auto border border-cm-border">
          <table className="w-full min-w-[20rem] text-left text-xs sm:text-sm">
            <thead className="border-b border-cm-border bg-cm-row">
              <tr>
                <th className="px-3 py-2 font-semibold uppercase tracking-wide text-cm-faint">Command</th>
                <th className="px-3 py-2 font-semibold uppercase tracking-wide text-cm-faint">Role</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cm-border text-cm-muted">
              <tr>
                <td className="px-3 py-2 font-[family-name:var(--font-mono)] text-cm-subtle">npm run ping-solana</td>
                <td className="px-3 py-2">RPC smoke test (CLI)</td>
              </tr>
              <tr>
                <td className="px-3 py-2 font-[family-name:var(--font-mono)] text-cm-subtle">npm run inspect -- &lt;base58&gt;</td>
                <td className="px-3 py-2">Address signatures (CLI)</td>
              </tr>
              <tr>
                <td className="px-3 py-2 font-[family-name:var(--font-mono)] text-cm-subtle">
                  npm run backfill -- &lt;base58&gt; [--resume]
                </td>
                <td className="px-3 py-2">Backfill signatures; <code className="font-mono text-[10px]">--resume</code> continues deep pagination from cursor</td>
              </tr>
              <tr>
                <td className="px-3 py-2 font-[family-name:var(--font-mono)] text-cm-subtle">npm run ingest-events -- &lt;base58&gt;</td>
                <td className="px-3 py-2">Parse txs → events</td>
              </tr>
              <tr>
                <td className="px-3 py-2 font-[family-name:var(--font-mono)] text-cm-subtle">npm run pipeline</td>
                <td className="px-3 py-2">
                  Continuous worker: all watchlist scopes → head signature catch-up → parse batch (add{" "}
                  <code className="font-mono text-[10px]">--turso-sync</code> to push each round)
                </td>
              </tr>
              <tr>
                <td className="px-3 py-2 font-[family-name:var(--font-mono)] text-cm-subtle">npm run pipeline:once</td>
                <td className="px-3 py-2">Single pipeline round (same as worker + --once)</td>
              </tr>
              <tr>
                <td className="px-3 py-2 font-[family-name:var(--font-mono)] text-cm-subtle">npm run score-window -- &lt;base58&gt;</td>
                <td className="px-3 py-2">Local v1 window score</td>
              </tr>
              <tr>
                <td className="px-3 py-2 font-[family-name:var(--font-mono)] text-cm-subtle">npm run turso:schema</td>
                <td className="px-3 py-2">Initialize Turso schema</td>
              </tr>
              <tr>
                <td className="px-3 py-2 font-[family-name:var(--font-mono)] text-cm-subtle">npm run turso:sync</td>
                <td className="px-3 py-2">SQLite → Turso mirror</td>
              </tr>
            </tbody>
          </table>
        </div>

        <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-cm-faint">Repo layout</h2>
        <ul className="mt-3 list-inside list-disc space-y-1.5 text-sm text-cm-muted">
          <li>
            <code className="font-mono text-xs">app/</code> — App Router, <code className="font-mono text-xs">app/api/*</code>
          </li>
          <li>
            <code className="font-mono text-xs">components/</code> — UI
          </li>
          <li>
            <code className="font-mono text-xs">lib/</code> — Shared Solana / Turso / scoring
          </li>
          <li>
            <code className="font-mono text-xs">scripts/</code> — CLIs
          </li>
        </ul>

        <div className="mt-12 flex flex-wrap gap-3 border-t border-cm-border-subtle pt-8">
          <Link
            href="/dashboard"
            className="inline-flex h-9 items-center rounded-md bg-cm-accent px-4 text-sm font-semibold text-cm-on-accent hover:bg-cm-accent-bright"
          >
            Dashboard
          </Link>
          <Link
            href="/"
            className="inline-flex h-9 items-center rounded-md border border-cm-border px-4 text-sm font-medium text-cm-text hover:bg-cm-row-hover"
          >
            Home
          </Link>
        </div>
      </div>
    </div>
  );
}
