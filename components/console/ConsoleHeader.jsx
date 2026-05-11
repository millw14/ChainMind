import Link from "next/link";

export function ConsoleHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-white/5 bg-zinc-950/90 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/" className="flex items-center gap-2 text-sm font-semibold text-white">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-sky-400 to-sky-600 text-xs font-bold text-zinc-950">
              CM
            </span>
            <span className="hidden sm:inline">ChainMind</span>
          </Link>
          <span className="hidden h-4 w-px bg-zinc-700 sm:block" />
          <span className="truncate text-xs font-medium uppercase tracking-wider text-zinc-500">Console</span>
        </div>
        <nav className="flex shrink-0 items-center gap-3 text-sm">
          <Link href="/how-it-works" className="text-zinc-400 transition hover:text-white">
            How it works
          </Link>
          <Link href="/" className="text-zinc-400 transition hover:text-white">
            Marketing site
          </Link>
        </nav>
      </div>
    </header>
  );
}
