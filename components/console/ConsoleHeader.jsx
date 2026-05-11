import Link from "next/link";

export function ConsoleHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-cm-border-subtle bg-cm-surface/90 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/" className="flex items-center gap-2 text-sm font-semibold text-cm-text">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-cm-accent-bright to-cm-accent-dim text-xs font-bold text-cm-on-accent">
              CM
            </span>
            <span className="hidden sm:inline">ChainMind</span>
          </Link>
          <span className="hidden h-4 w-px bg-cm-border sm:block" />
          <span className="truncate text-xs font-medium uppercase tracking-wider text-cm-faint">Console</span>
        </div>
        <nav className="flex shrink-0 items-center gap-3 text-sm">
          <Link href="/how-it-works" className="text-cm-muted transition hover:text-cm-text">
            How it works
          </Link>
          <Link href="/" className="text-cm-muted transition hover:text-cm-text">
            Marketing site
          </Link>
        </nav>
      </div>
    </header>
  );
}
