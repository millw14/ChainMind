import Link from "next/link";

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
      <section className="relative overflow-hidden border-b border-cm-border-subtle bg-cm-bg bg-cm-hero">
        <div className="relative mx-auto max-w-6xl px-4 pb-24 pt-16 sm:px-6 sm:pb-32 sm:pt-24">
          <div className="mx-auto max-w-3xl text-center">
            <Pill>Solana · operational intelligence</Pill>
            <h1 className="mt-6 text-4xl font-bold tracking-tight text-cm-text sm:text-5xl sm:leading-[1.1]">
              See when many wallets move <span className="text-cm-accent-bright">in the same beat</span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-cm-muted">
              ChainMind turns on-chain activity into clear checkpoints: live network health, recent signatures for any
              address, and a first-pass co-activity score when your data is connected. Built for people who read charts —
              not for automated witch-hunts.
            </p>
            <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4">
              <Link
                href="/console"
                className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-cm-accent px-8 text-sm font-semibold text-cm-on-accent transition hover:bg-cm-accent-bright sm:w-auto"
              >
                Open console
              </Link>
              <Link
                href="/how-it-works"
                className="inline-flex h-12 w-full items-center justify-center rounded-xl border border-cm-border bg-cm-elevated/50 px-8 text-sm font-semibold text-cm-text transition hover:border-cm-faint hover:bg-cm-row-hover/40 sm:w-auto"
              >
                How it works
              </Link>
            </div>
          </div>

          <div className="mx-auto mt-20 grid max-w-4xl gap-4 sm:grid-cols-3">
            {[
              { k: "Live slot", v: "Stream from your RPC", sub: "Know the chain is answering" },
              { k: "Address lens", v: "Signatures → Solscan", sub: "Replay what the market just did" },
              { k: "Cloud optional", v: "Turso + CLI sync", sub: "Scores when you’re ready" },
            ].map((item) => (
              <div
                key={item.k}
                className="rounded-2xl border border-cm-border bg-cm-card/50 p-5 text-left backdrop-blur-sm"
              >
                <p className="text-xs font-medium uppercase tracking-wide text-cm-accent-bright/90">{item.k}</p>
                <p className="mt-2 font-semibold text-cm-text">{item.v}</p>
                <p className="mt-1 text-sm text-cm-faint">{item.sub}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="capabilities" className="border-b border-cm-border-subtle py-20 sm:py-28">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="max-w-2xl">
            <h2 className="text-2xl font-bold tracking-tight text-cm-text sm:text-3xl">What you get today</h2>
            <p className="mt-4 text-base leading-relaxed text-cm-muted">
              Three layers that mirror how serious teams actually work: prove the pipe, inspect the object, then score
              patterns when you trust the data.
            </p>
          </div>
          <div className="mt-14 grid gap-8 md:grid-cols-3">
            <article className="rounded-2xl border border-cm-border bg-cm-elevated/40 p-6">
              <h3 className="text-lg font-semibold text-cm-text">Network certainty</h3>
              <p className="mt-3 text-sm leading-relaxed text-cm-muted">
                Slot, version, cluster — the boring stuff that has to be right before anyone trusts a downstream score.
              </p>
            </article>
            <article className="rounded-2xl border border-cm-border bg-cm-elevated/40 p-6">
              <h3 className="text-lg font-semibold text-cm-text">Per-address replay</h3>
              <p className="mt-3 text-sm leading-relaxed text-cm-muted">
                Pull recent activity for a mint, wallet, or program. Human-readable table with direct Solscan links — no
                copy-pasting signatures by hand.
              </p>
            </article>
            <article className="rounded-2xl border border-cm-border bg-cm-elevated/40 p-6">
              <h3 className="text-lg font-semibold text-cm-text">Co-activity (v1)</h3>
              <p className="mt-3 text-sm leading-relaxed text-cm-muted">
                A deliberately simple statistic: how concentrated activity is in short time windows. Calibrate before
                you bet the farm on it.
              </p>
            </article>
          </div>
        </div>
      </section>

      <section className="bg-cm-bg bg-cm-footer py-20 sm:py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="rounded-3xl border border-cm-warn/25 bg-cm-warn/10 px-6 py-10 sm:px-10 sm:py-14">
            <h2 className="text-xl font-bold text-cm-warn sm:text-2xl">Built with adult expectations</h2>
            <p className="mt-4 max-w-3xl text-sm leading-relaxed text-cm-muted sm:text-base">
              Busy tokens will spike any timing score. Public RPCs will throttle you. “Coordination” here means{" "}
              <strong className="font-semibold text-cm-text">statistical co-activity</strong>, not a court filing.
              ChainMind is a lab bench — wire your own RPC, sync your own dataset, and layer your human judgement on
              top.
            </p>
            <Link
              href="/console"
              className="mt-8 inline-flex rounded-xl bg-cm-warn px-6 py-3 text-sm font-semibold text-cm-bg transition hover:bg-cm-warn/90"
            >
              Go to console
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
