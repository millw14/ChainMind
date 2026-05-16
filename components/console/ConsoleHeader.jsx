import Link from "next/link";

export function ConsoleHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-cm-border bg-cm-card/95 pt-[env(safe-area-inset-top,0px)] backdrop-blur-md">
      <div className="mx-auto flex min-h-12 max-w-[88rem] items-center justify-between gap-2 px-3 sm:min-h-14 sm:gap-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <Link href="/" className="flex shrink-0 items-center gap-2 text-sm font-semibold text-cm-text">
            <span className="flex h-8 w-8 items-center justify-center rounded border border-cm-accent/35 bg-gradient-to-br from-cm-accent to-cm-accent-dim font-mono text-[11px] font-bold text-cm-on-accent">
              CM
            </span>
            <span className="hidden sm:inline">ChainMind</span>
          </Link>
          <span className="hidden h-4 w-px bg-cm-border sm:block" />
          <div className="min-w-0">
            <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.2em] text-cm-faint">Investigation</p>
            <p className="truncate font-mono text-[11px] text-cm-terminal">War room · live</p>
          </div>
        </div>
        <nav className="flex shrink-0 items-center gap-1 font-mono text-xs sm:gap-3">
          <Link
            href="/dashboard"
            className="rounded-md px-2 py-2.5 font-medium text-cm-accent-bright min-[360px]:px-3 hover:bg-cm-row-hover hover:text-cm-text active:bg-cm-row-hover sm:py-2"
          >
            Dashboard
          </Link>
          <Link href="/docs" className="rounded-md px-2 py-2.5 text-cm-muted min-[360px]:px-3 hover:bg-cm-row-hover hover:text-cm-text active:bg-cm-row-hover sm:py-2">
            Docs
          </Link>
          <Link
            href="/how-it-works"
            className="hidden rounded-md px-3 py-2 text-cm-muted hover:bg-cm-row-hover hover:text-cm-text sm:inline-block"
          >
            Architecture
          </Link>
          <Link href="/" className="rounded-md px-2 py-2.5 text-cm-muted min-[360px]:px-3 hover:bg-cm-row-hover hover:text-cm-text active:bg-cm-row-hover sm:py-2">
            Intel
          </Link>
        </nav>
      </div>
    </header>
  );
}
