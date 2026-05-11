import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="border-t border-white/5 bg-zinc-950">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <div className="flex flex-col gap-10 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-sm font-semibold text-white">ChainMind</p>
            <p className="mt-2 max-w-sm text-sm leading-relaxed text-zinc-500">
              Coordination-aware intelligence for Solana — built for analysts and teams who need structured signals,
              not hype.
            </p>
          </div>
          <div className="flex gap-16 text-sm">
            <div>
              <p className="font-medium text-zinc-300">Product</p>
              <ul className="mt-3 space-y-2 text-zinc-500">
                <li>
                  <Link href="/console" className="hover:text-zinc-300">
                    Console
                  </Link>
                </li>
                <li>
                  <Link href="/how-it-works" className="hover:text-zinc-300">
                    How it works
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <p className="font-medium text-zinc-300">Legal</p>
              <ul className="mt-3 space-y-2 text-zinc-500">
                <li className="text-zinc-600">Scores are probabilistic — not accusations.</li>
              </ul>
            </div>
          </div>
        </div>
        <p className="mt-12 border-t border-white/5 pt-8 text-center text-xs text-zinc-600">
          © {new Date().getFullYear()} ChainMind. Use a dedicated RPC in production.
        </p>
      </div>
    </footer>
  );
}
