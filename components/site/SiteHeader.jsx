import Link from "next/link";
import { ChainMindLogo } from "@/components/ChainMindLogo";

const nav = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#capabilities", label: "Features" },
  { href: "/docs", label: "Docs" },
  { href: "/ask", label: "Ask AI" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-cm-border bg-cm-card/90 pt-[env(safe-area-inset-top,0px)] backdrop-blur-md">
      <div className="mx-auto flex min-h-12 max-w-[88rem] items-center justify-between gap-2 px-3 sm:min-h-14 sm:gap-3 sm:px-6">
        <Link href="/" className="flex min-w-0 items-center gap-2.5 text-sm font-semibold tracking-tight text-cm-text">
          <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded border border-cm-accent/20 bg-cm-card shadow-[0_0_20px_-6px_rgba(0,200,5,0.75)]">
            <ChainMindLogo size={22} />
            <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-cm-terminal shadow-[0_0_8px_rgba(74,222,128,0.6)]" />
          </span>
          <span className="truncate">
            ChainMind <span className="hidden font-normal text-cm-faint sm:inline">· Robinhood Chain explorer</span>
          </span>
        </Link>
        <nav className="hidden items-center gap-0.5 md:flex">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-sm px-2.5 py-2 font-mono text-xs text-cm-muted hover:bg-cm-row-hover hover:text-cm-text"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <Link
          href="/ask"
          className="inline-flex min-h-[40px] shrink-0 items-center rounded-md border border-cm-accent/30 bg-cm-accent px-3 py-2 font-mono text-xs font-bold uppercase tracking-wide text-cm-on-accent hover:bg-cm-accent-bright sm:py-2"
        >
          Ask AI
        </Link>
      </div>
      <nav className="flex border-t border-cm-border-subtle px-2 py-2 sm:px-3 md:hidden">
        <div className="flex w-full flex-wrap justify-center gap-x-3 gap-y-2 font-mono text-[11px] leading-tight">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="inline-flex min-h-[40px] items-center px-2 text-cm-muted hover:text-cm-text"
            >
              {item.label}
            </Link>
          ))}
        </div>
      </nav>
    </header>
  );
}
