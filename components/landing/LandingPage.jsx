import Link from "next/link";

function Pill({ children }) {
  return (
    <span className="inline-flex items-center rounded-full border border-sky-500/20 bg-sky-500/10 px-3 py-1 text-xs font-medium text-sky-300">
      {children}
    </span>
  );
}

export function LandingPage() {
  return (
    <>
      <section className="relative overflow-hidden border-b border-white/5">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(56,189,248,0.18),transparent)]"
        />
        <div className="relative mx-auto max-w-6xl px-4 pb-24 pt-16 sm:px-6 sm:pb-32 sm:pt-24">
          <div className="mx-auto max-w-3xl text-center">
            <Pill>Solana · operational intelligence</Pill>
            <h1 className="mt-6 text-4xl font-bold tracking-tight text-white sm:text-5xl sm:leading-[1.1]">
              See when many wallets move <span className="text-sky-400">in the same beat</span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-zinc-400">
              ChainMind turns on-chain activity into clear checkpoints: live network health, recent signatures for any
              address, and a first-pass co-activity score when your data is connected. Built for people who read charts
              — not for automated witch-hunts.
            </p>
            <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4">
              <Link
                href="/console"
                className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-sky-500 px-8 text-sm font-semibold text-zinc-950 transition hover:bg-sky-400 sm:w-auto"
              >
                Open console
              </Link>
              <Link
                href="/how-it-works"
                className="inline-flex h-12 w-full items-center justify-center rounded-xl border border-zinc-600 bg-zinc-900/50 px-8 text-sm font-semibold text-zinc-100 transition hover:border-zinc-500 hover:bg-zinc-800/50 sm:w-auto"
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
                className="rounded-2xl border border-white/10 bg-zinc-900/40 p-5 text-left backdrop-blur-sm"
              >
                <p className="text-xs font-medium uppercase tracking-wide text-sky-400/90">{item.k}</p>
                <p className="mt-2 font-semibold text-white">{item.v}</p>
                <p className="mt-1 text-sm text-zinc-500">{item.sub}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="capabilities" className="border-b border-white/5 py-20 sm:py-28">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="max-w-2xl">
            <h2 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">What you get today</h2>
            <p className="mt-4 text-base leading-relaxed text-zinc-400">
              Three layers that mirror how serious teams actually work: prove the pipe, inspect the object, then score
              patterns when you trust the data.
            </p>
          </div>
          <div className="mt-14 grid gap-8 md:grid-cols-3">
            <article className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-6">
              <h3 className="text-lg font-semibold text-white">Network certainty</h3>
              <p className="mt-3 text-sm leading-relaxed text-zinc-400">
                Slot, version, cluster — the boring stuff that has to be right before anyone trusts a downstream score.
              </p>
            </article>
            <article className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-6">
              <h3 className="text-lg font-semibold text-white">Per-address replay</h3>
              <p className="mt-3 text-sm leading-relaxed text-zinc-400">
                Pull recent activity for a mint, wallet, or program. Human-readable table with direct Solscan links — no
                copy-pasting signatures by hand.
              </p>
            </article>
            <article className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-6">
              <h3 className="text-lg font-semibold text-white">Co-activity (v1)</h3>
              <p className="mt-3 text-sm leading-relaxed text-zinc-400">
                A deliberately simple statistic: how concentrated activity is in short time windows. Calibrate before
                you bet the farm on it.
              </p>
            </article>
          </div>
        </div>
      </section>

      <section className="py-20 sm:py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="rounded-3xl border border-amber-500/20 bg-amber-950/20 px-6 py-10 sm:px-10 sm:py-14">
            <h2 className="text-xl font-bold text-amber-100 sm:text-2xl">Built with adult expectations</h2>
            <p className="mt-4 max-w-3xl text-sm leading-relaxed text-amber-100/80 sm:text-base">
              Busy tokens will spike any timing score. Public RPCs will throttle you. “Coordination” here means{" "}
              <strong className="font-semibold text-amber-50">statistical co-activity</strong>, not a court filing.
              ChainMind is a lab bench — wire your own RPC, sync your own dataset, and layer your human judgement on
              top.
            </p>
            <Link
              href="/console"
              className="mt-8 inline-flex rounded-xl bg-amber-400 px-6 py-3 text-sm font-semibold text-amber-950 transition hover:bg-amber-300"
            >
              Go to console
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
