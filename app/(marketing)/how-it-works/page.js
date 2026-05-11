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
          Console first, pipeline when you need your own event store and scored windows.
        </p>

        <ol className="mt-14 space-y-10">
          <li className="border-l border-cm-border pl-5">
            <h2 className="text-lg font-semibold text-cm-text">1. Console</h2>
            <p className="mt-2 text-sm leading-relaxed text-cm-muted">
              The{" "}
              <Link href="/console" className="font-medium text-cm-text underline-offset-4 hover:underline">
                console
              </Link>{" "}
              hits your configured RPC for health, loads recent signatures for any base58 you enter, and shows scores when
              cloud-backed data exists.
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
              Today’s metric is the maximum distinct fee-paying wallets in one time bucket over your lookback. Useful for
              triage; easy to misread as evidence if you skip the limits on the home page.
            </p>
          </li>
        </ol>

        <div className="mt-14 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Link
            href="/console"
            className="inline-flex h-12 items-center justify-center rounded-xl bg-cm-accent px-6 text-sm font-semibold text-cm-on-accent transition hover:bg-cm-accent-bright sm:min-w-[10.5rem]"
          >
            Open console
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
