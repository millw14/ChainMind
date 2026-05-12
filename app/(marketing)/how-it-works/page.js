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
