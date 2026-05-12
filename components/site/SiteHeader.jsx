import Link from "next/link";

const nav = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#capabilities", label: "Capabilities" },
  { href: "/docs", label: "Docs" },
  { href: "/dashboard", label: "Dashboard" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-cm-border bg-cm-surface">
      <div className="mx-auto flex h-12 max-w-6xl items-center justify-between gap-3 px-4 sm:h-14 sm:px-6">
        <Link href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight text-cm-text">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-cm-accent font-[family-name:var(--font-mono)] text-[10px] font-bold text-cm-on-accent sm:h-8 sm:w-8 sm:text-xs">
            CM
          </span>
          ChainMind
        </Link>
        <nav className="hidden items-center gap-0.5 sm:flex">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-sm px-2.5 py-2 text-sm text-cm-muted hover:bg-cm-row-hover hover:text-cm-text"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <Link
          href="/dashboard"
          className="rounded-md bg-cm-accent px-3 py-1.5 text-sm font-semibold text-cm-on-accent hover:bg-cm-accent-bright sm:py-2"
        >
          Dashboard
        </Link>
      </div>
      <nav className="flex border-t border-cm-border-subtle px-3 py-2 sm:hidden">
        <div className="flex w-full flex-wrap justify-around gap-x-2 gap-y-1 text-[11px]">
          {nav.map((item) => (
            <Link key={item.href} href={item.href} className="text-cm-muted hover:text-cm-text">
              {item.label}
            </Link>
          ))}
        </div>
      </nav>
    </header>
  );
}
