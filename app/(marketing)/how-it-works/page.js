import Link from "next/link";

export const metadata = {
  title: "How it works",
};

export default function HowItWorksPage() {
  return (
    <div className="border-b border-white/5">
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 sm:py-24">
        <p className="text-xs font-semibold uppercase tracking-widest text-sky-500">Guide</p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">How ChainMind fits together</h1>
        <p className="mt-4 text-lg text-zinc-400">
          A short map from “idea” to “number on screen” — no jargon wall.
        </p>

        <ol className="mt-14 space-y-12">
          <li className="border-l-2 border-sky-500/50 pl-6">
            <h2 className="text-lg font-semibold text-white">1. Console = control room</h2>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">
              The <Link href="/console" className="text-sky-400 hover:underline">console</Link> checks that your Solana
              RPC answers, lets you load recent signatures for any base58 you care about, and surfaces scores when data
              exists.
            </p>
          </li>
          <li className="border-l-2 border-sky-500/50 pl-6">
            <h2 className="text-lg font-semibold text-white">2. Pipeline = truth on disk</h2>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">
              On your machine, the CLI backfills signatures, parses transactions into events, and (optionally) syncs to
              Turso so the hosted console isn’t pretending SQLite lives on Vercel.
            </p>
          </li>
          <li className="border-l-2 border-sky-500/50 pl-6">
            <h2 className="text-lg font-semibold text-white">3. v1 score = one honest statistic</h2>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">
              Today’s score is “max distinct fee payers in a short time bucket” — useful for triage, dangerous if
              misread as legal proof. We say that loudly so adults can use it responsibly.
            </p>
          </li>
        </ol>

        <div className="mt-16 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/console"
            className="inline-flex h-12 items-center justify-center rounded-xl bg-sky-500 px-6 text-sm font-semibold text-zinc-950 hover:bg-sky-400"
          >
            Open console
          </Link>
          <Link
            href="/"
            className="inline-flex h-12 items-center justify-center rounded-xl border border-zinc-600 px-6 text-sm font-semibold text-zinc-200 hover:bg-zinc-800/50"
          >
            Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}
