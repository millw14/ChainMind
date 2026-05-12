import Link from "next/link";

const shell = "mx-auto w-full max-w-6xl px-4 sm:px-6";

export function LandingPage() {
  return (
    <>
      <section className="border-b border-cm-border-subtle bg-cm-bg bg-cm-hero">
        <div className={`${shell} pb-16 pt-12 sm:pb-20 sm:pt-16`}>
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-xs font-medium uppercase tracking-widest text-cm-faint">Solana · on-chain analytics</p>
            <h1 className="mt-5 text-3xl font-semibold tracking-tight text-cm-text sm:text-4xl sm:leading-snug">
              RPC checks, address history, and optional co-activity scores
            </h1>
            <p className="mt-5 text-base leading-relaxed text-cm-muted">
              Reads your Solana RPC for slot and version, fetches recent signatures for any base58, and—when Turso is
              configured—runs a v1 co-activity window. Outputs are analytical only; they do not establish intent or
              liability.
            </p>
            <div className="mt-8 flex flex-col items-stretch justify-center gap-2 sm:flex-row sm:items-center sm:justify-center sm:gap-3">
              <Link
                href="/dashboard"
                className="inline-flex h-10 items-center justify-center rounded-md bg-cm-accent px-6 text-sm font-semibold text-cm-on-accent transition-colors hover:bg-cm-accent-bright sm:min-w-[9rem]"
              >
                Open dashboard
              </Link>
              <Link
                href="/#how-it-works"
                className="inline-flex h-10 items-center justify-center rounded-md border border-cm-border bg-cm-elevated px-6 text-sm font-medium text-cm-text transition-colors hover:border-cm-border hover:bg-cm-row-hover sm:min-w-[9rem]"
              >
                How it works
              </Link>
              <Link
                href="/docs"
                className="inline-flex h-10 items-center justify-center rounded-md border border-transparent px-4 text-sm font-medium text-cm-muted underline-offset-4 hover:text-cm-text hover:underline"
              >
                Setup / Docs
              </Link>
            </div>
          </div>

          <div className="mt-14 grid gap-3 sm:mt-16 sm:grid-cols-3 sm:gap-4">
            {[
              {
                k: "RPC health",
                v: "Slot, version, cluster",
                sub: "Baseline checks from your endpoint.",
              },
              {
                k: "Address history",
                v: "Signatures + Solscan",
                sub: "Wallet, mint, or program id.",
              },
              {
                k: "Optional scoring",
                v: "CLI + Turso",
                sub: "v1 metric when events exist in DB.",
              },
            ].map((item) => (
              <div
                key={item.k}
                className="flex h-full flex-col border border-cm-border bg-cm-surface p-4 text-left"
              >
                <p className="text-[11px] font-semibold uppercase tracking-wide text-cm-faint">{item.k}</p>
                <p className="mt-2 text-sm font-medium text-cm-text">{item.v}</p>
                <p className="mt-1.5 text-xs leading-relaxed text-cm-muted">{item.sub}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="how-it-works" className="scroll-mt-16 border-b border-cm-border-subtle py-14 sm:py-16">
        <div className={shell}>
          <div className="max-w-2xl">
            <h2 className="text-xl font-semibold tracking-tight text-cm-text sm:text-2xl">How it works</h2>
            <p className="mt-2 text-sm leading-relaxed text-cm-muted">
              Four steps. RPC and address views need no account; scores require synced data. Details:{" "}
              <Link href="/docs" className="font-medium text-cm-text underline underline-offset-4 hover:text-cm-accent-bright">
                Docs
              </Link>
              .
            </p>
          </div>

          <ol className="mt-10 grid list-none gap-3 p-0 sm:grid-cols-2 lg:grid-cols-4 lg:gap-4">
            {[
              {
                step: "01",
                title: "Console",
                body: "Configure SOLANA_RPC_URL on the host. Ping RPC for slot and build identity.",
              },
              {
                step: "02",
                title: "Inspect",
                body: "Paste base58; call getSignaturesForAddress; table + Solscan links.",
              },
              {
                step: "03",
                title: "Pipeline",
                body: "Local CLI: backfill, ingest-events, optional turso:sync (see Docs).",
              },
              {
                step: "04",
                title: "Score",
                body: "With DB wired: scope, window minutes, lookback hours → /api/score v1.",
              },
            ].map((item) => (
              <li
                key={item.step}
                className="flex h-full flex-col border border-cm-border bg-cm-elevated/50 p-4 sm:p-5"
              >
                <span className="font-[family-name:var(--font-mono)] text-xs tabular-nums text-cm-faint">{item.step}</span>
                <h3 className="mt-2 text-sm font-semibold text-cm-text">{item.title}</h3>
                <p className="mt-2 text-xs leading-relaxed text-cm-muted">{item.body}</p>
              </li>
            ))}
          </ol>

          <p className="mt-8 text-xs text-cm-faint">
            <Link href="/how-it-works" className="font-medium text-cm-text underline-offset-4 hover:underline">
              Longer guide
            </Link>{" "}
            · Product narrative and caveats.
          </p>
        </div>
      </section>

      <section id="capabilities" className="scroll-mt-16 border-b border-cm-border-subtle py-14 sm:py-20">
        <div className={shell}>
          <div className="max-w-2xl">
            <h2 className="text-xl font-semibold tracking-tight text-cm-text sm:text-2xl">Capabilities</h2>
            <p className="mt-3 text-sm leading-relaxed text-cm-muted">
              Console-only use cases need only an RPC URL. Pipeline-backed metrics need local SQLite (CLI) and, for the
              hosted UI, Turso env vars on Vercel.
            </p>
          </div>
          <div className="mt-10 grid gap-4 md:grid-cols-3 md:gap-5">
            <article className="flex h-full flex-col border border-cm-border bg-cm-surface p-5">
              <h3 className="text-sm font-semibold text-cm-text">Network checks</h3>
              <p className="mt-2 text-xs leading-relaxed text-cm-muted">
                Confirms RPC responds with slot, Solana version, cluster. Run before trusting downstream panels.
              </p>
            </article>
            <article className="flex h-full flex-col border border-cm-border bg-cm-surface p-5">
              <h3 className="text-sm font-semibold text-cm-text">Ledger lookback</h3>
              <p className="mt-2 text-xs leading-relaxed text-cm-muted">
                One address → recent signatures, tabular layout, external tx links.
              </p>
            </article>
            <article className="flex h-full flex-col border border-cm-border bg-cm-surface p-5">
              <h3 className="text-sm font-semibold text-cm-text">Co-activity v1</h3>
              <p className="mt-2 text-xs leading-relaxed text-cm-muted">
                Max distinct fee-paying wallets in one configured time bucket over the lookback. Calibrate on liquidity
                and RPC limits.
              </p>
            </article>
          </div>
        </div>
      </section>

      <section className="border-t border-cm-border-subtle bg-cm-bg py-14 sm:py-16">
        <div className={shell}>
          <div className="max-w-3xl border border-cm-border bg-cm-surface px-5 py-7 sm:px-8 sm:py-8">
            <h2 className="text-lg font-semibold text-cm-text">Limits</h2>
            <p className="mt-3 text-xs leading-relaxed text-cm-muted sm:text-sm">
              Public RPCs throttle. High-volume mints bias bucket counts. The score is a concentration statistic, not
              evidence in a legal sense. Production: dedicated RPC + your own sync and QA.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href="/dashboard"
                className="inline-flex h-9 items-center justify-center rounded-md bg-cm-accent px-4 text-xs font-semibold text-cm-on-accent hover:bg-cm-accent-bright"
              >
                Open dashboard
              </Link>
              <Link
                href="/docs"
                className="inline-flex h-9 items-center justify-center rounded-md border border-cm-border px-4 text-xs font-medium text-cm-text hover:bg-cm-row-hover"
              >
                Setup / Docs
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
