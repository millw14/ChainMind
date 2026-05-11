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
          Operator notes for the Next app, Vercel, and the Node CLIs. Canonical copy also lives in{" "}
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
          See <code className="font-mono text-xs text-cm-subtle">.env.example</code> in the repository for names and
          hints.
        </p>
        <ul className="mt-3 list-inside list-disc space-y-1.5 text-sm text-cm-muted">
          <li>
            <strong className="font-medium text-cm-text">SOLANA_RPC_URL</strong> — required for{" "}
            <code className="font-mono text-xs">/api/ping</code>,{" "}
            <code className="font-mono text-xs">/api/inspect</code>, and related panels.
          </li>
          <li>
            <strong className="font-medium text-cm-text">TURSO_*</strong> — optional; without them, database counts and
            scores in the hosted console stay unconfigured while RPC paths still run.
          </li>
        </ul>

        <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-cm-faint">Vercel</h2>
        <ul className="mt-3 list-inside list-disc space-y-1.5 text-sm text-cm-muted">
          <li>Framework preset: Next.js. Do not set Output Directory to <code className="font-mono text-xs">public</code>.</li>
          <li>Set production env: at minimum <code className="font-mono text-xs">SOLANA_RPC_URL</code>; add Turso vars if you use cloud DB panels.</li>
        </ul>

        <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-cm-faint">CLI / pipeline</h2>
        <p className="mt-3 text-sm text-cm-muted">
          Local SQLite default: <code className="font-mono text-xs text-cm-subtle">data/chainmind.db</code>. Run from
          repo root after install.
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
                <td className="px-3 py-2 font-[family-name:var(--font-mono)] text-cm-subtle">npm run backfill -- &lt;base58&gt;</td>
                <td className="px-3 py-2">Backfill signatures into SQLite</td>
              </tr>
              <tr>
                <td className="px-3 py-2 font-[family-name:var(--font-mono)] text-cm-subtle">npm run ingest-events -- &lt;base58&gt;</td>
                <td className="px-3 py-2">Parse txs → events</td>
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
            href="/console"
            className="inline-flex h-9 items-center rounded-md bg-cm-accent px-4 text-sm font-semibold text-cm-on-accent hover:bg-cm-accent-bright"
          >
            Console
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
