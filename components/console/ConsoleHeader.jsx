import Link from "next/link";

export function ConsoleHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-cm-border bg-cm-surface">
      <div className="mx-auto flex h-12 max-w-6xl items-center justify-between gap-3 px-4 sm:h-14 sm:px-6">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <Link href="/" className="flex items-center gap-2 text-sm font-semibold text-cm-text">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-cm-accent font-[family-name:var(--font-mono)] text-[10px] font-bold text-cm-on-accent sm:h-8 sm:w-8 sm:text-xs">
              CM
            </span>
            <span className="hidden sm:inline">ChainMind</span>
          </Link>
          <span className="hidden h-3.5 w-px bg-cm-border sm:block" />
          <span className="truncate font-[family-name:var(--font-mono)] text-[10px] font-medium uppercase tracking-wide text-cm-faint sm:text-xs">
            Investigation
          </span>
        </div>
        <nav className="flex shrink-0 items-center gap-3 text-sm">
          <Link href="/docs" className="text-cm-muted hover:text-cm-text">
            Docs
          </Link>
          <Link href="/how-it-works" className="text-cm-muted hover:text-cm-text">
            Guide
          </Link>
          <Link href="/" className="text-cm-muted hover:text-cm-text">
            Home
          </Link>
        </nav>
      </div>
    </header>
  );
}
