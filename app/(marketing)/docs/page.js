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
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-cm-text sm:text-3xl">Setup &amp; environment</h1>
        <p className="mt-3 text-sm leading-relaxed text-cm-muted">
          ChainMind is an AI explorer for Robinhood Chain. This page is the operator reference for running it. Copy{" "}
          <code className="rounded border border-cm-border bg-cm-elevated px-1 font-[family-name:var(--font-mono)] text-xs text-cm-subtle">
            .env.example
          </code>{" "}
          to <code className="font-mono text-xs text-cm-subtle">.env.local</code> and fill in the values below.
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
          Set these on the host (see <code className="font-mono text-xs text-cm-subtle">.env.example</code>). Only the
          Groq key is required to answer questions; the chain defaults work out of the box against the public RPC.
        </p>
        <ul className="mt-3 list-inside list-disc space-y-1.5 text-sm text-cm-muted">
          <li>
            <strong className="font-medium text-cm-text">GROQ_API_KEY</strong> — required. Powers the plain-English
            answers on <code className="font-mono text-xs">/ask</code> (via{" "}
            <code className="font-mono text-xs">POST /api/ask</code>).
          </li>
          <li>
            <strong className="font-medium text-cm-text">ROBINHOOD_NETWORK</strong> — optional;{" "}
            <code className="font-mono text-xs">mainnet</code> (default, chain 4663) or{" "}
            <code className="font-mono text-xs">testnet</code> (chain 46630).
          </li>
          <li>
            <strong className="font-medium text-cm-text">ROBINHOOD_RPC_URL</strong> — optional; a dedicated RPC
            (QuickNode / Chainstack / Alchemy) for higher limits. Falls back to the public RPC.
          </li>
          <li>
            <strong className="font-medium text-cm-text">BLOCKSCOUT_API_URL</strong> /{" "}
            <strong className="font-medium text-cm-text">BLOCKSCOUT_API_KEY</strong> — optional; override the indexer
            host or add a Blockscout Pro key to raise rate limits.
          </li>
        </ul>

        <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-cm-faint">Endpoints</h2>
        <div className="mt-4 overflow-x-auto border border-cm-border">
          <table className="w-full min-w-[20rem] text-left text-xs sm:text-sm">
            <thead className="border-b border-cm-border bg-cm-row">
              <tr>
                <th className="px-3 py-2 font-semibold uppercase tracking-wide text-cm-faint">Route</th>
                <th className="px-3 py-2 font-semibold uppercase tracking-wide text-cm-faint">Role</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cm-border text-cm-muted">
              <tr>
                <td className="px-3 py-2 font-[family-name:var(--font-mono)] text-cm-subtle">POST /api/ask</td>
                <td className="px-3 py-2">
                  Body <code className="font-mono text-[10px]">{`{ question, target }`}</code> — gathers evidence for a
                  0x address or tx hash and returns a grounded answer.
                </td>
              </tr>
              <tr>
                <td className="px-3 py-2 font-[family-name:var(--font-mono)] text-cm-subtle">GET /api/health</td>
                <td className="px-3 py-2">Liveness — confirms the app can reach Robinhood Chain over JSON-RPC.</td>
              </tr>
            </tbody>
          </table>
        </div>

        <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-cm-faint">Vercel</h2>
        <ul className="mt-3 list-inside list-disc space-y-1.5 text-sm text-cm-muted">
          <li>Framework preset: Next.js. Do not set Output Directory to <code className="font-mono text-xs">public</code>.</li>
          <li>Set production env: at minimum <code className="font-mono text-xs">GROQ_API_KEY</code>; add a dedicated RPC / Blockscout key for scale.</li>
        </ul>

        <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-cm-faint">Repo layout</h2>
        <ul className="mt-3 list-inside list-disc space-y-1.5 text-sm text-cm-muted">
          <li>
            <code className="font-mono text-xs">app/</code> — App Router; <code className="font-mono text-xs">app/(app)/ask</code> (explorer),{" "}
            <code className="font-mono text-xs">app/(marketing)</code> (site), <code className="font-mono text-xs">app/api/*</code>
          </li>
          <li>
            <code className="font-mono text-xs">components/</code> — UI (<code className="font-mono text-xs">ask/AskChat</code>, site, landing)
          </li>
          <li>
            <code className="font-mono text-xs">lib/</code> — <code className="font-mono text-xs">chain.js</code> (viem client),{" "}
            <code className="font-mono text-xs">blockscout.js</code> (indexer),{" "}
            <code className="font-mono text-xs">ask-evidence.js</code>, <code className="font-mono text-xs">geoq.js</code> (Groq)
          </li>
        </ul>

        <div className="mt-12 flex flex-wrap gap-3 border-t border-cm-border-subtle pt-8">
          <Link
            href="/ask"
            className="inline-flex h-9 items-center rounded-md bg-cm-accent px-4 text-sm font-semibold text-cm-on-accent hover:bg-cm-accent-bright"
          >
            Open the explorer
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
