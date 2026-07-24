import Link from "next/link";
import { listStockTokens } from "@/lib/stock-tokens";
import { StockTable } from "@/components/stocks/StockTable";

export const metadata = {
  title: "Stocks",
  description:
    "Every tokenized equity and ETF issued on Robinhood Chain, read live from the chain — symbol, price, market cap and holders.",
};

/**
 * Rebuilt at most once every five minutes. The list moves slowly (Robinhood
 * lists an equity, not a block), and caching keeps a crawl or a refresh loop
 * from turning into a page-walk of the Blockscout token index per visit.
 */
export const revalidate = 300;

export default async function StocksPage() {
  let items = [];
  let failed = false;
  let partial = false;

  try {
    const tokens = await listStockTokens();
    items = Array.isArray(tokens) ? tokens : [];
    // Set when the page-walk was cut short upstream — the list is then a prefix
    // of the truth, and saying so is cheaper than being quietly wrong.
    partial = Boolean(tokens?.partial);
  } catch {
    failed = true;
  }

  const empty = failed || items.length === 0;

  return (
    <div className="border-b border-cm-border-subtle">
      {/* pt clears the floating header, which is absolutely positioned so the
          landing hero can run full-bleed underneath it. */}
      <div className="mx-auto w-full max-w-5xl px-4 pb-16 pt-28 sm:px-6 sm:pb-24 sm:pt-32">
        <p className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-widest text-cm-faint">
          Tokenized equities
        </p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-cm-text sm:text-4xl">Stocks on Robinhood Chain</h1>
        <p className="mt-4 text-base leading-relaxed text-cm-muted sm:text-lg">
          {empty
            ? "Every equity and ETF Robinhood has tokenized on this chain, read live from the Blockscout index."
            : `${items.length} tokenized ${items.length === 1 ? "equity" : "equities"} and ETFs, read live from the chain. Pick one to ask about it.`}
        </p>

        {partial && !empty ? (
          <p className="mt-3 font-[family-name:var(--font-mono)] text-[11px] text-cm-warn">
            Partial list — the indexer cut the token walk short, so some listings may be missing.
          </p>
        ) : null}

        <div className="mt-10">
          {empty ? (
            <div className="border border-cm-border bg-cm-card px-5 py-10 text-center">
              <p className="text-sm text-cm-subtle">
                {failed
                  ? "Couldn't reach the chain indexer just now."
                  : "No tokenized equities came back from the chain indexer."}
              </p>
              <p className="mt-2 text-sm text-cm-muted">
                Nothing here is cached from a previous run, so rather than show a stale list this page shows none.
                Reload in a minute, or{" "}
                <Link href="/ask" className="font-medium text-cm-text underline-offset-4 hover:underline">
                  ask the explorer
                </Link>{" "}
                about a contract directly.
              </p>
            </div>
          ) : (
            <StockTable items={items} />
          )}
        </div>
      </div>
    </div>
  );
}
