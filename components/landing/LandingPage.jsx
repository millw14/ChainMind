import Link from "next/link";

const shell = "mx-auto w-full max-w-6xl px-4 sm:px-6";

function Pill({ children }) {
  return (
    <span className="inline-flex items-center rounded-full border border-cm-accent/20 bg-cm-accent/10 px-3 py-1 text-xs font-medium text-cm-accent-bright">
      {children}
    </span>
  );
}

export function LandingPage() {
  return (
    <>
      <section className="border-b border-cm-border-subtle bg-cm-bg bg-cm-hero">
        <div className={`${shell} pb-20 pt-14 sm:pb-28 sm:pt-20`}>
          <div className="mx-auto max-w-2xl text-center">
            <Pill>Solana · on-chain analytics</Pill>
            <h1 className="mt-6 text-4xl font-bold tracking-tight text-cm-text sm:text-5xl sm:leading-tight">
              RPC checks, address history, and optional co-activity scores
            </h1>
            <p className="mt-6 text-lg leading-relaxed text-cm-muted">
              ChainMind reads your Solana RPC for live status and recent signatures. Add the CLI and a synced database
              when you need windowed co-activity metrics. Outputs support analysis; they do not establish intent or
              wrongdoing.
            </p>
            <div className="mt-10 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center sm:justify-center">
              <Link
                href="/console"
                className="inline-flex h-12 items-center justify-center rounded-xl bg-cm-accent px-8 text-sm font-semibold text-cm-on-accent transition hover:bg-cm-accent-bright sm:min-w-[10rem]"
              >
                Open console
              </Link>
              <Link
                href="/#how-it-works"
                className="inline-flex h-12 items-center justify-center rounded-xl border border-cm-border bg-cm-elevated/50 px-8 text-sm font-semibold text-cm-text transition hover:border-cm-faint hover:bg-cm-row-hover/40 sm:min-w-[10rem]"
              >
                How it works
              </Link>
            </div>
          </div>

          <div className="mt-16 grid gap-4 sm:mt-20 sm:grid-cols-3 sm:gap-5">
            {[
              {
                k: "RPC health",
                v: "Slot, version, cluster",
                sub: "Baselines from your endpoint before you trust the rest.",
              },
              {
                k: "Address history",
                v: "Signatures and Solscan links",
                sub: "Wallet, mint, or program id in one table.",
              },
              {
                k: "Optional scoring",
                v: "CLI sync and Turso",
                sub: "v1 co-activity when your events are in the database.",
              },
            ].map((item) => (
              <div
                key={item.k}
                className="flex h-full flex-col rounded-2xl border border-cm-border bg-cm-card/50 p-5 text-left backdrop-blur-sm"
              >
                <p className="text-xs font-medium uppercase tracking-wide text-cm-accent-bright/90">{item.k}</p>
                <p className="mt-2 font-semibold text-cm-text">{item.v}</p>
                <p className="mt-2 text-sm leading-relaxed text-cm-faint">{item.sub}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="how-it-works" className="scroll-mt-20 border-b border-cm-border-subtle py-16 sm:py-20">
        <div className={shell}>
          <div className="max-w-2xl">
            <h2 className="text-2xl font-bold tracking-tight text-cm-text sm:text-3xl">How it works</h2>
            <p className="mt-3 text-base leading-relaxed text-cm-muted">
              If you are new here: four steps from login to a score. No account required for RPC and address lookup.
            </p>
          </div>

          <ol className="mt-12 grid list-none gap-6 p-0 sm:grid-cols-2 lg:grid-cols-4 lg:gap-5">
            {[
              {
                step: "1",
                title: "Open the console",
                body: "Point ChainMind at your RPC (environment on the host). Run a ping to confirm slot and version.",
              },
              {
                step: "2",
                title: "Inspect an address",
                body: "Paste a base58 address: wallet, token mint, or program. Load recent signatures and open Solscan from the table.",
              },
              {
                step: "3",
                title: "Sync your data",
                body: "Use the CLI to backfill signatures, parse events, and push to Turso if you want cloud-backed counts.",
              },
              {
                step: "4",
                title: "Run a score",
                body: "With data connected, set a scope, window, and lookback. v1 returns peak distinct fee payers in a bucket, with caveats.",
              },
            ].map((item) => (
              <li
                key={item.step}
                className="flex h-full flex-col rounded-xl border border-cm-border bg-cm-elevated/25 p-5 sm:p-6"
              >
                <span
                  className="flex h-9 w-9 items-center justify-center rounded-lg bg-cm-accent/15 text-sm font-semibold text-cm-accent-bright"
                  aria-hidden
                >
                  {item.step}
                </span>
                <h3 className="mt-4 font-semibold text-cm-text">{item.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-cm-muted">{item.body}</p>
              </li>
            ))}
          </ol>

          <p className="mt-10 text-sm text-cm-faint">
            <Link href="/how-it-works" className="font-medium text-cm-accent-bright underline-offset-4 hover:text-cm-accent hover:underline">
              Read the full guide
            </Link>{" "}
            for pipeline detail and score definitions.
          </p>
        </div>
      </section>

      <section id="capabilities" className="scroll-mt-20 border-b border-cm-border-subtle py-16 sm:py-24">
        <div className={shell}>
          <div className="max-w-2xl">
            <h2 className="text-2xl font-bold tracking-tight text-cm-text sm:text-3xl">Capabilities</h2>
            <p className="mt-4 text-base leading-relaxed text-cm-muted">
              Start with the hosted console only. Add the pipeline when you need metrics derived from your own event
              store, not generic block explorers alone.
            </p>
          </div>
          <div className="mt-12 grid gap-6 md:grid-cols-3 md:gap-8">
            <article className="flex h-full flex-col rounded-2xl border border-cm-border bg-cm-elevated/40 p-6">
              <h3 className="text-lg font-semibold text-cm-text">Network checks</h3>
              <p className="mt-3 text-sm leading-relaxed text-cm-muted">
                Confirms your RPC responds with current slot, software version, and cluster. Use it before relying on any
                downstream number.
              </p>
            </article>
            <article className="flex h-full flex-col rounded-2xl border border-cm-border bg-cm-elevated/40 p-6">
              <h3 className="text-lg font-semibold text-cm-text">Per-address ledger lookback</h3>
              <p className="mt-3 text-sm leading-relaxed text-cm-muted">
                Fetches recent signatures for a single address. Results are shown in a compact table with outbound links
                for each transaction.
              </p>
            </article>
            <article className="flex h-full flex-col rounded-2xl border border-cm-border bg-cm-elevated/40 p-6">
              <h3 className="text-lg font-semibold text-cm-text">Co-activity (v1)</h3>
              <p className="mt-3 text-sm leading-relaxed text-cm-muted">
                With synced events: maximum count of distinct fee-paying wallets in one time bucket over your lookback.
                Calibrate on liquid tokens and your RPC limits before you trust the headline.
              </p>
            </article>
          </div>
        </div>
      </section>

      <section className="bg-cm-bg bg-cm-footer py-16 sm:py-20">
        <div className={shell}>
          <div className="max-w-3xl rounded-2xl border border-cm-border bg-cm-elevated/30 px-6 py-9 sm:px-10 sm:py-11">
            <h2 className="text-xl font-bold text-cm-text sm:text-2xl">Limits</h2>
            <p className="mt-4 text-sm leading-relaxed text-cm-muted sm:text-base">
              Public RPCs throttle; busy mints skew timing windows. Co-activity is a concentration statistic over
              windows you configure. It is not proof of coordination in a legal sense. Use a dedicated RPC and your own
              sync for anything production-grade.
            </p>
            <Link
              href="/console"
              className="mt-8 inline-flex h-11 items-center justify-center rounded-xl bg-cm-accent px-6 text-sm font-semibold text-cm-on-accent transition hover:bg-cm-accent-bright"
            >
              Open console
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
