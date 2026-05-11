import Link from "next/link";

const nav = [
  { href: "/#capabilities", label: "Capabilities" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/console", label: "Console" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-white/5 bg-zinc-950/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight text-white">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-sky-400 to-sky-600 text-xs font-bold text-zinc-950">
            CM
          </span>
          ChainMind
        </Link>
        <nav className="hidden items-center gap-1 sm:flex">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-lg px-3 py-2 text-sm text-zinc-400 transition hover:bg-white/5 hover:text-zinc-100"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <Link
            href="/console"
            className="rounded-lg bg-sky-500 px-3 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-sky-400"
          >
            Open console
          </Link>
        </div>
      </div>
      <nav className="flex border-t border-white/5 px-4 py-2 sm:hidden">
        <div className="flex w-full justify-around gap-2 text-xs">
          {nav.map((item) => (
            <Link key={item.href} href={item.href} className="text-zinc-400 hover:text-white">
              {item.label}
            </Link>
          ))}
        </div>
      </nav>
    </header>
  );
}
