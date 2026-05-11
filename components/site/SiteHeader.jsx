import Link from "next/link";

const nav = [
  { href: "/#capabilities", label: "Capabilities" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/console", label: "Console" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-cm-border-subtle bg-cm-surface/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight text-cm-text">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-cm-accent-bright to-cm-accent-dim text-xs font-bold text-cm-on-accent">
            CM
          </span>
          ChainMind
        </Link>
        <nav className="hidden items-center gap-1 sm:flex">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-lg px-3 py-2 text-sm text-cm-muted transition hover:bg-cm-row-hover/50 hover:text-cm-text"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <Link
            href="/console"
            className="rounded-lg bg-cm-accent px-3 py-2 text-sm font-semibold text-cm-on-accent transition hover:bg-cm-accent-bright"
          >
            Open console
          </Link>
        </div>
      </div>
      <nav className="flex border-t border-cm-border-subtle px-4 py-2 sm:hidden">
        <div className="flex w-full justify-around gap-2 text-xs">
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
