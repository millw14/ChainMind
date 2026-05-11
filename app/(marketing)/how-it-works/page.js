import Link from "next/link";

export const metadata = {
  title: "How it works",
};

export default function HowItWorksPage() {
  return (
    <div className="border-b border-cm-border-subtle">
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 sm:py-24">
        <p className="text-xs font-semibold uppercase tracking-widest text-cm-accent">Guide</p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-cm-text sm:text-4xl">How ChainMind fits together</h1>
        <p className="mt-4 text-lg text-cm-muted">A short map from “idea” to “number on screen” — no jargon wall.</p>

        <ol className="mt-14 space-y-12">
          <li className="border-l-2 border-cm-accent/50 pl-6">
            <h2 className="text-lg font-semibold text-cm-text">1. Console = control room</h2>
            <p className="mt-2 text-sm leading-relaxed text-cm-muted">
              The{" "}
              <Link href="/console" className="text-cm-accent-bright hover:underline">
                console
              </Link>{" "}
              checks that your Solana RPC answers, lets you load recent signatures for any base58 you care about, and
              surfaces scores when data exists.
            </p>
          </li>
          <li className="border-l-2 border-cm-accent/50 pl-6">
            <h2 className="text-lg font-semibold text-cm-text">2. Pipeline = truth on disk</h2>
            <p className="mt-2 text-sm leading-relaxed text-cm-muted">
              On your machine, the CLI backfills signatures, parses transactions into events, and (optionally) syncs to
              Turso so the hosted console isn’t pretending SQLite lives on Vercel.
            </p>
          </li>
          <li className="border-l-2 border-cm-accent/50 pl-6">
            <h2 className="text-lg font-semibold text-cm-text">3. v1 score = one honest statistic</h2>
            <p className="mt-2 text-sm leading-relaxed text-cm-muted">
              Today’s score is “max distinct fee payers in a short time bucket” — useful for triage, dangerous if misread
              as legal proof. We say that loudly so adults can use it responsibly.
            </p>
          </li>
        </ol>

        <div className="mt-16 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/console"
            className="inline-flex h-12 items-center justify-center rounded-xl bg-cm-accent px-6 text-sm font-semibold text-cm-on-accent transition hover:bg-cm-accent-bright"
          >
            Open console
          </Link>
          <Link
            href="/"
            className="inline-flex h-12 items-center justify-center rounded-xl border border-cm-border px-6 text-sm font-semibold text-cm-text transition hover:bg-cm-row-hover/50"
          >
            Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}
