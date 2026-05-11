import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="border-t border-cm-border-subtle bg-cm-bg bg-cm-footer">
      <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6">
        <div className="flex flex-col gap-10 md:flex-row md:items-start md:justify-between">
          <div className="max-w-sm">
            <p className="text-sm font-semibold text-cm-text">ChainMind</p>
            <p className="mt-2 text-sm leading-relaxed text-cm-faint">
              Solana monitoring, address history, and opt-in co-activity metrics. Built for teams that want structured
              outputs without trading legal claims for dashboard copy.
            </p>
          </div>
          <div className="flex flex-col gap-10 text-sm sm:flex-row sm:gap-16">
            <div>
              <p className="font-medium text-cm-subtle">Product</p>
              <ul className="mt-3 space-y-2 text-cm-faint">
                <li>
                  <Link href="/console" className="hover:text-cm-subtle">
                    Console
                  </Link>
                </li>
                <li>
                  <Link href="/#how-it-works" className="hover:text-cm-subtle">
                    How it works
                  </Link>
                </li>
                <li>
                  <Link href="/how-it-works" className="hover:text-cm-subtle">
                    Guide
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <p className="font-medium text-cm-subtle">Disclaimer</p>
              <p className="mt-3 max-w-xs text-cm-faint leading-relaxed">
                Scores are probabilistic summaries, not accusations.
              </p>
            </div>
          </div>
        </div>
        <p className="mt-12 border-t border-cm-border-subtle pt-8 text-center text-xs text-cm-faint">
          © {new Date().getFullYear()} ChainMind. Use a dedicated RPC in production.
        </p>
      </div>
    </footer>
  );
}
