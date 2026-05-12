import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="border-t border-cm-border bg-cm-bg">
      <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
        <div className="flex flex-col gap-10 md:flex-row md:items-start md:justify-between">
          <div className="max-w-sm">
            <p className="text-sm font-semibold text-cm-text">ChainMind</p>
            <p className="mt-2 text-xs leading-relaxed text-cm-faint sm:text-sm">
              Early coordination intelligence on Solana—surface synchronized flows and concentration before the market
              fully prices them.
            </p>
          </div>
          <div className="flex flex-col gap-10 text-sm sm:flex-row sm:gap-14">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-cm-faint">Product</p>
              <ul className="mt-2 space-y-1.5 text-cm-muted">
                <li>
                  <Link href="/dashboard" className="hover:text-cm-text">
                    Solana dashboard
                  </Link>
                </li>
                <li>
                  <Link href="/docs" className="hover:text-cm-text">
                    Setup / Docs
                  </Link>
                </li>
                <li>
                  <Link href="/#how-it-works" className="hover:text-cm-text">
                    How it works
                  </Link>
                </li>
                <li>
                  <Link href="/how-it-works" className="hover:text-cm-text">
                    Guide
                  </Link>
                </li>
              </ul>
            </div>
            <div className="max-w-md">
              <p className="text-xs font-semibold uppercase tracking-wide text-cm-faint">Compliance & limitations</p>
              <p className="mt-2 text-xs leading-relaxed text-cm-muted">
                Outputs are probabilistic signals for investigation — not findings of fact or legal conclusions. Pair with
                your own diligence and counsel. Detail-level caveats appear alongside scores and exports in the console.
              </p>
            </div>
          </div>
        </div>
        <p className="mt-10 border-t border-cm-border-subtle pt-6 text-center text-[11px] leading-relaxed text-cm-faint">
          © {new Date().getFullYear()} ChainMind · Dedicated RPC recommended in production · See footer for usage
          limitations
        </p>
      </div>
    </footer>
  );
}
