import Link from "next/link";

export function ConsoleHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-cm-border bg-cm-card/95 backdrop-blur-md">
      <div className="mx-auto flex h-12 max-w-[88rem] items-center justify-between gap-3 px-4 sm:h-14 sm:px-6">
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
        <nav className="flex shrink-0 items-center gap-4 font-mono text-xs">
          <Link href="/docs" className="text-cm-muted hover:text-cm-text">
            Docs
          </Link>
          <Link href="/how-it-works" className="hidden text-cm-muted hover:text-cm-text sm:inline">
            Architecture
          </Link>
          <Link href="/" className="text-cm-muted hover:text-cm-text">
            Intel
          </Link>
        </nav>
      </div>
    </header>
  );
}
