import Link from "next/link";

const shell = "mx-auto w-full max-w-6xl px-4 sm:px-6";

export function LandingPage() {
  return (
    <>
      <section className="border-b border-cm-border-subtle bg-cm-bg bg-cm-hero">
        <div className={`${shell} pb-16 pt-12 sm:pb-20 sm:pt-16`}>
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-xs font-medium uppercase tracking-widest text-cm-faint">Solana · manipulation intelligence</p>
            <h1 className="mt-5 text-3xl font-semibold tracking-tight text-cm-text sm:text-4xl sm:leading-snug">
              Detect coordinated manipulation on Solana before it moves the market
            </h1>
            <p className="mt-5 text-base leading-relaxed text-cm-muted">
              Coordinated wallets move in concert — same windows, same flow, same timing — before price reacts. ChainMind
              surfaces the concentration and clustering patterns that precede manipulation, so you're investigating
              while it&apos;s forming, not explaining it after the fact.
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
                k: "Live chain truth",
                v: "RPC you control",
                sub: "Confirm slot, version, and cluster before you trust downstream reads.",
              },
              {
                k: "Trace the flow",
                v: "Signatures in minutes",
                sub: "Wallet, mint, or program—recent touchpoints with one-click explorers.",
              },
              {
                k: "Spot coordination",
                v: "Time-boxed concentration",
                sub: "v1 co-activity windows on data you ingest and mirror to the cloud.",
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
              From first ping to scored windows—stand up signals in four moves. Technical setup:{" "}
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
                title: "Connect",
                body: "Point ChainMind at your Solana RPC. Ping for slot, version, and cluster identity.",
              },
              {
                step: "02",
                title: "Inspect",
                body: "Paste base58; call getSignaturesForAddress; table + Solscan links.",
              },
              {
                step: "03",
                title: "Ingest",
                body: "CLI backfill + event parse; mirror to Turso so production sees the same book.",
              },
              {
                step: "04",
                title: "Score",
                body: "Compute time-boxed co-activity on scope, window, and lookback you choose.",
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
              Deeper guide
            </Link>{" "}
            · Architecture and limits.
          </p>
        </div>
      </section>

      <section id="capabilities" className="scroll-mt-16 border-b border-cm-border-subtle py-14 sm:py-20">
        <div className={shell}>
          <div className="max-w-2xl">
            <h2 className="text-xl font-semibold tracking-tight text-cm-text sm:text-2xl">Capabilities</h2>
            <p className="mt-3 text-sm leading-relaxed text-cm-muted">
              Ship live reads with an RPC alone. Turn on scored coordination panels by running the CLI locally and
              syncing your event store to Turso for Vercel.
            </p>
          </div>
          <div className="mt-10 grid gap-4 md:grid-cols-3 md:gap-5">
            <article className="flex h-full flex-col border border-cm-border bg-cm-surface p-5">
              <h3 className="text-sm font-semibold text-cm-text">Network readiness</h3>
              <p className="mt-2 text-xs leading-relaxed text-cm-muted">
                Verify slot, version, and cluster from your endpoint—know the stack is real before you trade on the
                read.
              </p>
            </article>
            <article className="flex h-full flex-col border border-cm-border bg-cm-surface p-5">
              <h3 className="text-sm font-semibold text-cm-text">Flow reconstruction</h3>
              <p className="mt-2 text-xs leading-relaxed text-cm-muted">
                Pull recent signatures for any pubkey; table + explorer links to pressure-test sequencing fast.
              </p>
            </article>
            <article className="flex h-full flex-col border border-cm-border bg-cm-surface p-5">
              <h3 className="text-sm font-semibold text-cm-text">Coordination windows</h3>
              <p className="mt-2 text-xs leading-relaxed text-cm-muted">
                v1 score: peak distinct fee payers in a tunable minute bucket—calibrate on liquidity and your RPC
                headroom.
              </p>
            </article>
          </div>
        </div>
      </section>

      <section className="border-t border-cm-border-subtle bg-cm-bg py-14 sm:py-16">
        <div className={shell}>
          <div className="max-w-3xl border border-cm-border bg-cm-surface px-5 py-7 sm:px-8 sm:py-8">
            <h2 className="text-lg font-semibold text-cm-text">Operational reality</h2>
            <p className="mt-3 text-xs leading-relaxed text-cm-muted sm:text-sm">
              Public RPCs throttle; fat books distort naive buckets. Production means a dedicated endpoint, disciplined
              ingest, and your own QA. See the site footer for important limitations on outputs.{" "}
              <Link href="/how-it-works#roadmap" className="font-medium text-cm-text underline-offset-4 hover:underline">
                Product direction
              </Link>{" "}
              outlines detection, evidence, and leading-indicator layers beyond v1.
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
