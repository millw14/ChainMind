import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="border-t border-cm-border-subtle bg-cm-bg bg-cm-footer">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <div className="flex flex-col gap-10 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-sm font-semibold text-cm-text">ChainMind</p>
            <p className="mt-2 max-w-sm text-sm leading-relaxed text-cm-faint">
              Coordination-aware intelligence for Solana — built for analysts and teams who need structured signals, not
              hype.
            </p>
          </div>
          <div className="flex gap-16 text-sm">
            <div>
              <p className="font-medium text-cm-subtle">Product</p>
              <ul className="mt-3 space-y-2 text-cm-faint">
                <li>
                  <Link href="/console" className="hover:text-cm-subtle">
                    Console
                  </Link>
                </li>
                <li>
                  <Link href="/how-it-works" className="hover:text-cm-subtle">
                    How it works
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <p className="font-medium text-cm-subtle">Legal</p>
              <ul className="mt-3 space-y-2 text-cm-faint">
                <li className="text-cm-faint/90">Scores are probabilistic — not accusations.</li>
              </ul>
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
