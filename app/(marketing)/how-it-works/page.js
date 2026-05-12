import Link from "next/link";

export const metadata = {
  title: "How it works",
};

export default function HowItWorksPage() {
  return (
    <div className="border-b border-cm-border-subtle">
      <div className="mx-auto w-full max-w-3xl px-4 py-16 sm:px-6 sm:py-24">
        <p className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-widest text-cm-faint">Guide</p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-cm-text sm:text-4xl">How ChainMind fits together</h1>
        <p className="mt-4 text-lg leading-relaxed text-cm-muted">
          Stand up live Solana reads in minutes; turn on coordination scoring once your pipeline mirrors events to the
          cloud.
        </p>

        <ol className="mt-14 space-y-10">
          <li className="border-l border-cm-border pl-5">
            <h2 className="text-lg font-semibold text-cm-text">1. Solana dashboard</h2>
            <p className="mt-2 text-sm leading-relaxed text-cm-muted">
              The{" "}
              <Link href="/dashboard" className="font-medium text-cm-text underline-offset-4 hover:underline">
                dashboard
              </Link>{" "}
              validates RPC health, pulls recent signatures for any base58, and renders scored coordination windows
              when Turso holds your mirrored events.
            </p>
          </li>
          <li className="border-l border-cm-border pl-5">
            <h2 className="text-lg font-semibold text-cm-text">2. Pipeline</h2>
            <p className="mt-2 text-sm leading-relaxed text-cm-muted">
              On your machine, the CLI backfills signatures, parses transactions into events, and optionally syncs to
              Turso. The hosted UI does not pretend the database is local to Vercel.
            </p>
          </li>
          <li className="border-l border-cm-border pl-5">
            <h2 className="text-lg font-semibold text-cm-text">3. v1 score</h2>
            <p className="mt-2 text-sm leading-relaxed text-cm-muted">
              v1 measures peak distinct fee payers inside a minute bucket over your lookback—ideal for surfacing crowded
              windows fast. Pair with fundamentals and your compliance process; limitations are in the site footer.
            </p>
          </li>
        </ol>

        <section id="roadmap" className="mt-16 scroll-mt-20 border-t border-cm-border-subtle pt-14">
          <h2 className="text-xl font-semibold tracking-tight text-cm-text sm:text-2xl">Product direction</h2>
          <p className="mt-3 text-sm leading-relaxed text-cm-muted">
            v1 is narrow on purpose: one co-activity score on ingested events—a fast trip wire, not the full case file.
            The trajectory is <strong className="font-medium text-cm-text">detect</strong>,{" "}
            <strong className="font-medium text-cm-text">explain</strong>, and{" "}
            <strong className="font-medium text-cm-text">get ahead</strong>.{" "}
            <strong className="font-medium text-cm-text">This is what we&apos;re building toward.</strong>
          </p>

          <div className="mt-10 space-y-10">
            <div className="border-l border-cm-border pl-5">
              <h3 className="text-base font-semibold text-cm-text">Detection layer</h3>
              <ul className="mt-3 list-inside list-disc space-y-2 text-sm leading-relaxed text-cm-muted">
                <li>
                  <strong className="font-medium text-cm-text">Funding-graph clusters</strong> — link wallets with
                  explicit edges (shared funder, labeled transfer hops within N days, repeated small-route patterns) so
                  groups are evidence-backed, not single-address anecdotes.
                </li>
                <li>
                  <strong className="font-medium text-cm-text">Versioned pattern packs</strong> — named detectors (e.g.
                  wash-shaped round-trips, accumulation ladders, time-synchronized bursts) each shipped as a rule pack
                  with thresholds, changelog, and documented false-positive modes—not a black box “AI said so.”
                </li>
                <li>
                  <strong className="font-medium text-cm-text">Velocity &amp; acceleration</strong> — same windowed
                  counts as v1, plus week-over-week (or regime-normalized) deltas: rising unique payers, rising
                  programs touched, rising event rate into a bucket—<em>not</em> a static “high score” only.
                </li>
              </ul>
            </div>

            <div className="border-l border-cm-border pl-5">
              <h3 className="text-base font-semibold text-cm-text">Evidence layer</h3>
              <ul className="mt-3 list-inside list-disc space-y-2 text-sm leading-relaxed text-cm-muted">
                <li>
                  <strong className="font-medium text-cm-text">Case timeline &amp; wallet table</strong> — for each
                  scope: enumerated wallets, the linking funding txs (signatures + amounts + timestamps), each flagged
                  coordination window (UTC range, duration), and recurrence count inside the lookback.
                </li>
                <li>
                  <strong className="font-medium text-cm-text">Exports for review</strong> — CSV/JSON graph (nodes +
                  edges), evidence bundle zip (key txs + parsed fields), and a one-page PDF summary suitable for internal
                  committees—not screenshots of a console.
                </li>
              </ul>
            </div>

            <div className="border-l border-cm-border pl-5">
              <h3 className="text-base font-semibold text-cm-text">Prediction / leading indicators (“get ahead”)</h3>
              <p className="mt-3 text-sm leading-relaxed text-cm-muted">
                This layer is the hardest and the clearest differentiator: not <em>what the chain already printed</em> but
                what tends to show up <em>before</em> tape and narrative catch up. It requires per-asset rolling baselines,
                enough history to know “normal,” and tight definitions of “early”—otherwise you are selling astrology.
                Concretely, we are targeting:
              </p>
              <ul className="mt-3 list-inside list-disc space-y-2 text-sm leading-relaxed text-cm-muted">
                <li>
                  <strong className="font-medium text-cm-text">Pre-positioning clusters</strong> — rising normalized
                  participation from a stable wallet cohort <em>before</em> public volume or attention inflects; measure
                  divergence between stealth activity and headline-ready tape.
                </li>
                <li>
                  <strong className="font-medium text-cm-text">Liquidity &amp; route stress</strong> — DEX/pool depth
                  or route-mix shifts (withdrawal of resting liquidity, sudden venue/route concentration) in a bounded
                  pre-window vs trailing median.
                </li>
                <li>
                  <strong className="font-medium text-cm-text">Leading fee-payer compression</strong> — v1-style
                  crowding expressed as z-score or delta vs a rolling baseline for that asset and time-of-week regime—so
                  “spike” is <em>unusual for this name</em>, not globally arbitrary.
                </li>
              </ul>
              <p className="mt-4 text-sm leading-relaxed text-cm-muted">
                <strong className="font-medium text-cm-text">Cross-signal corroboration is the moat.</strong> Any single
                metric can be farmed or mistaken for alpha. When detection (who clusters), evidence (what chained
                on-chain), and leading indicators (what is early vs baseline) have to agree before ChainMind elevates a
                hypothesis—and when they don&apos;t, the product should stay quiet—that is both the anti-noise story and
                the anti-gaming story. Confidence bands and forced multi-signal agreement are how this stays credible in
                front of funds and compliance, not just another pretty explorer chart.
              </p>
            </div>
          </div>
        </section>

        <div className="mt-14 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Link
            href="/dashboard"
            className="inline-flex h-12 items-center justify-center rounded-xl bg-cm-accent px-6 text-sm font-semibold text-cm-on-accent transition hover:bg-cm-accent-bright sm:min-w-[10.5rem]"
          >
            Open dashboard
          </Link>
          <Link
            href="/"
            className="inline-flex h-12 items-center justify-center rounded-xl border border-cm-border px-6 text-sm font-semibold text-cm-text transition hover:bg-cm-row-hover/50 sm:min-w-[10.5rem]"
          >
            Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}
