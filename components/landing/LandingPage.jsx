import Link from "next/link";

const shell = "mx-auto w-full max-w-6xl px-4 sm:px-6";

function HeroGraphDecor() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden opacity-[0.65]" aria-hidden>
      <svg className="absolute -right-8 top-8 h-72 w-72 text-cm-accent sm:right-12 sm:top-12 sm:h-96 sm:w-96" viewBox="0 0 200 200">
        <defs>
          <radialGradient id="hg" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(139, 92, 246, 0.35)" />
            <stop offset="100%" stopColor="rgba(139, 92, 246, 0)" />
          </radialGradient>
        </defs>
        <circle cx="100" cy="100" r="88" fill="url(#hg)" />
        {[0, 45, 90, 135, 180, 225, 270, 315].map((deg, i) => {
          const r = 72;
          const rad = (deg * Math.PI) / 180;
          const x = 100 + r * Math.cos(rad - Math.PI / 2);
          const y = 100 + r * Math.sin(rad - Math.PI / 2);
          return (
            <g key={deg}>
              <line x1="100" y1="100" x2={x} y2={y} stroke="rgba(139, 92, 246, 0.28)" strokeWidth="0.75" />
              <circle cx={x} cy={y} r={i % 2 === 0 ? 4 : 3} fill="rgba(244, 242, 248, 0.12)" stroke="rgba(139, 92, 246, 0.45)" strokeWidth="0.5" />
            </g>
          );
        })}
        <circle cx="100" cy="100" r="10" fill="#8b5cf6" opacity="0.95" />
        <circle cx="100" cy="100" r="16" fill="none" stroke="rgba(196, 181, 253, 0.4)" strokeWidth="0.75" />
      </svg>
    </div>
  );
}

export function LandingPage() {
  return (
    <>
      <section className="relative overflow-hidden border-b border-cm-border-subtle bg-cm-bg bg-cm-hero cm-war-grid">
        <HeroGraphDecor />
        <div className={`relative ${shell} pb-20 pt-14 sm:pb-24 sm:pt-20`}>
          <div className="relative grid gap-12 lg:grid-cols-[1fr,minmax(0,22rem)] lg:items-center lg:gap-16">
            <div>
              <div className="inline-flex items-center gap-2 rounded border border-cm-border bg-cm-surface/80 px-2.5 py-1 font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-cm-terminal">
                <span className="cm-pulse-live inline-block h-1.5 w-1.5 rounded-full bg-cm-ok" />
                Solana intelligence console
              </div>
              <h1 className="mt-6 max-w-3xl text-[1.75rem] font-semibold leading-[1.12] tracking-tight text-cm-text sm:text-4xl sm:leading-tight lg:text-[2.75rem]">
                Detect and prove coordinated manipulation before it becomes visible.
              </h1>
              <p className="mt-5 max-w-2xl text-base leading-relaxed text-cm-muted sm:text-lg">
                ChainMind watches funding graphs, fee-payer concentration, and time-clustered activity—so you see
                coordination forming while others are still reading the tape.
              </p>
              <div className="mt-8 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                <Link
                  href="/dashboard"
                  className="inline-flex h-11 items-center justify-center rounded-md bg-cm-accent px-6 text-sm font-semibold text-cm-on-accent transition-colors hover:bg-cm-accent-bright"
                >
                  Open investigation console
                </Link>
                <Link
                  href="/#how-it-works"
                  className="inline-flex h-11 items-center justify-center rounded-md border border-cm-border bg-cm-elevated/90 px-6 text-sm font-medium text-cm-text backdrop-blur-sm transition-colors hover:border-cm-accent/40 hover:bg-cm-row-hover"
                >
                  How signals are produced
                </Link>
                <Link href="/docs" className="px-2 text-sm font-medium text-cm-muted underline-offset-4 hover:text-cm-text hover:underline sm:px-4">
                  Operator setup
                </Link>
              </div>
            </div>

            <div className="relative">
              <div className="cm-panel-edge rounded-md border border-cm-border bg-cm-card/95 p-4 shadow-cm backdrop-blur-sm sm:p-5">
                <div className="flex items-center justify-between border-b border-cm-border-subtle pb-3 font-mono text-[10px] uppercase tracking-wider text-cm-faint">
                  <span>Live alert · preview</span>
                  <span className="text-cm-threat">SEV-2</span>
                </div>
                <pre className="mt-3 max-h-[14rem] overflow-hidden font-mono text-[10px] leading-relaxed text-cm-terminal/90 sm:text-[11px]">
                  {`{
  "flag": "coordinated-accumulation",
  "confidence": 0.84,
  "scope": "TOKEN_MINT…",
  "triggered_at": "2026-05-12T10:22:00Z",
  "evidence": [
    { "action": "3 linked wallets bought …", "slot": 123461 }
  ]
}`}
                </pre>
                <p className="mt-3 border-t border-cm-border-subtle pt-3 text-[11px] leading-snug text-cm-muted">
                  Push the same structure to Discord, Slack, or your stack via webhook—
                  <span className="text-cm-subtle"> the <code className="text-cm-accent-bright">watch</code> CLI.</span>
                </p>
              </div>
            </div>
          </div>

          <div className="relative mt-16 grid gap-3 sm:mt-20 sm:grid-cols-3 sm:gap-4">
            {[
              {
                k: "Graph + chain truth",
                v: "Funding trees & payers",
                sub: "Adjacency over ingested edges—not a toy table. RPC health checks before you trust reads.",
              },
              {
                k: "Pattern detectors",
                v: "Named manipulation signals",
                sub: "Wash rotation, Sybil-style pumps, coordination clusters—structured evidence, not a single scalar.",
              },
              {
                k: "Pre-tape alerts",
                v: "Webhook when confidence spikes",
                sub: "Run incremental ingest + detectors; get pushed when something crosses your threshold.",
              },
            ].map((item) => (
              <div key={item.k} className="cm-panel-edge border border-cm-border bg-cm-surface/90 p-4 sm:p-5">
                <p className="font-mono text-[10px] font-semibold uppercase tracking-widest text-cm-faint">{item.k}</p>
                <p className="mt-2 text-sm font-semibold text-cm-text">{item.v}</p>
                <p className="mt-2 text-xs leading-relaxed text-cm-muted">{item.sub}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="how-it-works" className="scroll-mt-16 border-b border-cm-border-subtle py-16 cm-war-grid sm:py-20">
        <div className={shell}>
          <div className="max-w-2xl">
            <h2 className="text-xl font-semibold tracking-tight text-cm-text sm:text-2xl">From chain noise to case file</h2>
            <p className="mt-2 text-sm leading-relaxed text-cm-muted sm:text-base">
              Four phases: connect, capture signatures, parse events into a graph, run detectors and scoring. Technical
              runbook:{" "}
              <Link href="/docs" className="font-medium text-cm-accent-bright underline-offset-4 hover:underline">
                Docs
              </Link>
              .
            </p>
          </div>

          <ol className="mt-12 grid list-none gap-3 p-0 sm:grid-cols-2 lg:grid-cols-4 lg:gap-4">
            {[
              { step: "01", title: "Link RPC", body: "Your endpoint. Confirm slot, version, and cluster before analysis." },
              { step: "02", title: "Capture flow", body: "Signatures for the mint or wallet under watch—fast reconstruct." },
              { step: "03", title: "Ingest & graph", body: "Parse txs into transfers, payers, edges; mirror to Turso if needed." },
              { step: "04", title: "Detect & alert", body: "Run coordination metrics + detectors; webhook on high confidence." },
            ].map((item) => (
              <li key={item.step} className="cm-panel-edge flex h-full flex-col border border-cm-border bg-cm-elevated/60 p-4 sm:p-5">
                <span className="font-mono text-xs tabular-nums text-cm-accent-bright">{item.step}</span>
                <h3 className="mt-2 text-sm font-semibold text-cm-text">{item.title}</h3>
                <p className="mt-2 text-xs leading-relaxed text-cm-muted">{item.body}</p>
              </li>
            ))}
          </ol>

          <p className="mt-10 text-xs text-cm-faint">
            <Link href="/how-it-works" className="font-medium text-cm-text underline-offset-4 hover:underline">
              Architecture & limits
            </Link>{" "}
            · Data pipeline depth.
          </p>
        </div>
      </section>

      <section id="capabilities" className="scroll-mt-16 border-b border-cm-border-subtle py-16 sm:py-20">
        <div className={shell}>
          <div className="max-w-2xl">
            <h2 className="text-xl font-semibold tracking-tight text-cm-text sm:text-2xl">Built for investigations</h2>
            <p className="mt-3 text-sm leading-relaxed text-cm-muted sm:text-base">
              Dense dashboards, graph previews, and threat-weighted alerts—the product shape matches what you are
              actually selling: early manipulation visibility.
            </p>
          </div>
          <div className="mt-10 grid gap-4 md:grid-cols-3 md:gap-5">
            {[
              {
                t: "Operator-grade RPC",
                d: "Know the cluster and block height you are reasoning over before you trust downstream panels.",
              },
              {
                t: "Evidence-shaped outputs",
                d: "Every flag returns confidence plus rows you can paste into a memo—not just a number in isolation.",
              },
              {
                t: "Watch mode",
                d: "Incremental ingest + detector pass + webhook when signals cross your risk line—without babysitting refresh buttons.",
              },
            ].map((x) => (
              <article key={x.t} className="cm-panel-edge flex h-full flex-col border border-cm-border bg-cm-surface p-5">
                <h3 className="text-sm font-semibold text-cm-text">{x.t}</h3>
                <p className="mt-2 text-xs leading-relaxed text-cm-muted">{x.d}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-cm-border-subtle bg-cm-surface/30 py-16 sm:py-20">
        <div className={shell}>
          <div className="flex flex-col items-start justify-between gap-8 border border-cm-border bg-cm-elevated/50 px-6 py-8 sm:flex-row sm:items-center sm:px-10 sm:py-10">
            <div className="max-w-xl">
              <h2 className="text-lg font-semibold text-cm-text sm:text-xl">Run your next investigation in the console</h2>
              <p className="mt-2 text-sm leading-relaxed text-cm-muted">
                Same engine as the CLI and webhooks—optimized for analysts who live in graphs and timestamps, not README
                pages.
              </p>
            </div>
            <div className="flex flex-shrink-0 flex-wrap gap-3">
              <Link
                href="/dashboard"
                className="inline-flex h-10 items-center justify-center rounded-md bg-cm-accent px-5 text-sm font-semibold text-cm-on-accent hover:bg-cm-accent-bright"
              >
                Launch console
              </Link>
              <Link
                href="/docs"
                className="inline-flex h-10 items-center justify-center rounded-md border border-cm-border bg-cm-surface px-5 text-sm font-medium text-cm-text hover:bg-cm-row-hover"
              >
                Deploy checklist
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
