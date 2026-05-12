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
            v1 is intentionally narrow: one scalar co-activity score on ingested events—a trip wire, not a finished
            investigation. To back the positioning you care about—<strong className="font-medium text-cm-text">detect</strong>,{" "}
            <strong className="font-medium text-cm-text">explain</strong>, and{" "}
            <strong className="font-medium text-cm-text">get ahead</strong> of coordination—the roadmap clusters into
            three layers. Nothing below is implied to be fully shipped yet; it is the build target.
          </p>

          <div className="mt-10 space-y-10">
            <div className="border-l border-cm-border pl-5">
              <h3 className="text-base font-semibold text-cm-text">Detection layer</h3>
              <ul className="mt-3 list-inside list-disc space-y-2 text-sm leading-relaxed text-cm-muted">
                <li>
                  <strong className="font-medium text-cm-text">Wallet clustering</strong> — relate addresses by shared
                  funding paths, synchronized timing, and repeatable fee/Program patterns—not only “many payers in a
                  bucket.”
                </li>
                <li>
                  <strong className="font-medium text-cm-text">Named pattern library</strong> — curated detectors for
                  wash-like sequences, coordinated accumulation, pump-squad clustering, spoofing-shaped flow—each with
                  explicit definitions and false-positive notes.
                </li>
                <li>
                  <strong className="font-medium text-cm-text">Velocity scoring</strong> — track not just level but{" "}
                  <em>acceleration</em> (participation and concentration ramping into a window).
                </li>
              </ul>
            </div>

            <div className="border-l border-cm-border pl-5">
              <h3 className="text-base font-semibold text-cm-text">Evidence layer</h3>
              <ul className="mt-3 list-inside list-disc space-y-2 text-sm leading-relaxed text-cm-muted">
                <li>
                  <strong className="font-medium text-cm-text">Narrative output</strong> — compliance and investment
                  users need the story: which wallets, which linking transfers or behaviors, which time slices, how
                  often in the lookback—not a lone number.
                </li>
                <li>
                  <strong className="font-medium text-cm-text">Exportable reports</strong> — PDF/CSV bundles suitable for
                  internal review and audit trails, not only a live console.
                </li>
              </ul>
            </div>

            <div className="border-l border-cm-border pl-5">
              <h3 className="text-base font-semibold text-cm-text">Prediction / leading indicators</h3>
              <p className="mt-3 text-sm leading-relaxed text-cm-muted">
                “Before it becomes visible” requires features aimed at <em>pre</em>-tape signals: pre-positioning
                clusters, liquidity withdrawal or rotation patterns, unusual fee-payer compression ahead of volume
                spikes—features that deliberately move ChainMind away from being “another explorer with a chart.”
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
