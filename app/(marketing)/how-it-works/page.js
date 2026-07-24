import Link from "next/link";

export const metadata = {
  title: "How it works",
};

export default function HowItWorksPage() {
  return (
    <div className="border-b border-cm-border-subtle">
      {/* pt clears the floating header (absolute, so the hero runs full-bleed). */}
      <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-28 sm:px-6 sm:pb-24 sm:pt-32">
        <p className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-widest text-cm-faint">Guide</p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-cm-text sm:text-4xl">How ChainMind works</h1>
        <p className="mt-4 text-lg leading-relaxed text-cm-muted">
          ChainMind is an AI explorer for Robinhood Chain—the Ethereum Layer-2 for tokenized stocks and real-world
          assets. Paste an address or transaction, ask a question, and get a plain-English answer grounded in live
          on-chain data.
        </p>

        <ol className="mt-14 space-y-10">
          <li className="border-l border-cm-border pl-5">
            <h2 className="text-lg font-semibold text-cm-text">1. You paste a target</h2>
            <p className="mt-2 text-sm leading-relaxed text-cm-muted">
              Any Robinhood Chain address (<code className="font-mono text-xs">0x…</code> 40 chars) or transaction hash
              (<code className="font-mono text-xs">0x…</code> 64 chars). No signup, no wallet connection. Try it in the{" "}
              <Link href="/ask" className="font-medium text-cm-text underline-offset-4 hover:underline">
                explorer
              </Link>
              .
            </p>
          </li>
          <li className="border-l border-cm-border pl-5">
            <h2 className="text-lg font-semibold text-cm-text">2. ChainMind reads the chain</h2>
            <p className="mt-2 text-sm leading-relaxed text-cm-muted">
              We pull the relevant facts live from the Robinhood Chain RPC and the Blockscout indexer: balances, token
              metadata, recent transfers, counterparties, transaction status, fees, and decoded logs. Only what&apos;s
              needed to answer your question—kept compact and factual.
            </p>
          </li>
          <li className="border-l border-cm-border pl-5">
            <h2 className="text-lg font-semibold text-cm-text">3. The AI explains it</h2>
            <p className="mt-2 text-sm leading-relaxed text-cm-muted">
              That evidence, plus your question, goes to a language model with strict instructions to ground every claim
              in the data and never invent balances, tokens, or transactions. You get a short, readable answer—with the
              exact evidence one click away so you can verify it.
            </p>
          </li>
        </ol>

        <section id="scope" className="mt-16 scroll-mt-20 border-t border-cm-border-subtle pt-14">
          <h2 className="text-xl font-semibold tracking-tight text-cm-text sm:text-2xl">What it can and can&apos;t answer</h2>
          <p className="mt-3 text-sm leading-relaxed text-cm-muted">
            ChainMind is an explainer, not an oracle. It&apos;s good at making on-chain activity legible; it will not
            predict prices or give financial advice.
          </p>

          <div className="mt-10 space-y-10">
            <div className="border-l border-cm-border pl-5">
              <h3 className="text-base font-semibold text-cm-text">Great at</h3>
              <ul className="mt-3 list-inside list-disc space-y-2 text-sm leading-relaxed text-cm-muted">
                <li>
                  <strong className="font-medium text-cm-text">Explaining a transaction</strong> — what it did, whether
                  it succeeded, the method called, tokens moved, and the fee paid.
                </li>
                <li>
                  <strong className="font-medium text-cm-text">Summarizing a wallet</strong> — its balance, the tokens
                  it holds and moves, how active it is, and who it interacts with.
                </li>
                <li>
                  <strong className="font-medium text-cm-text">Describing a token</strong> — name, symbol, type,
                  supply, and holder count for a contract address.
                </li>
              </ul>
            </div>

            <div className="border-l border-cm-border pl-5">
              <h3 className="text-base font-semibold text-cm-text">Not designed for</h3>
              <ul className="mt-3 list-inside list-disc space-y-2 text-sm leading-relaxed text-cm-muted">
                <li>
                  <strong className="font-medium text-cm-text">Price predictions or advice</strong> — it describes what
                  the chain shows, it doesn&apos;t tell you what to buy.
                </li>
                <li>
                  <strong className="font-medium text-cm-text">Off-chain context</strong> — news, social sentiment, or
                  anything not recorded on Robinhood Chain.
                </li>
                <li>
                  <strong className="font-medium text-cm-text">Guarantees</strong> — answers are AI-generated and can be
                  incomplete or wrong. The evidence panel is there so you can check.
                </li>
              </ul>
            </div>
          </div>
        </section>

        <div className="mt-14 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Link
            href="/ask"
            className="inline-flex h-12 items-center justify-center rounded-xl bg-cm-accent px-6 text-sm font-semibold text-cm-on-accent transition hover:bg-cm-accent-bright sm:min-w-[10.5rem]"
          >
            Open the explorer
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
