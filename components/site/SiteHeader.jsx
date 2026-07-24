import Link from "next/link";
import LiveClock from "@/components/site/LiveClock";

/** Three words, not five. The page is the product; the header just orients you. */
const nav = [
  { href: "/stocks", label: "Stocks" },
  { href: "/#capabilities", label: "Work" },
  { href: "/docs", label: "Docs" },
];

export function SiteHeader() {
  return (
    <header className="pointer-events-none absolute inset-x-0 top-0 z-50 pt-[env(safe-area-inset-top,0px)]">
      <div className="mx-auto grid max-w-[100rem] grid-cols-[1fr_auto_1fr] items-center px-6 py-6 sm:px-10 sm:py-8">
        {/* left — the mark, set as type rather than a badge */}
        <Link
          href="/"
          className="pointer-events-auto justify-self-start font-semibold uppercase tracking-[0.14em] text-cm-text transition-colors hover:text-cm-accent"
        >
          ChainMind
        </Link>

        {/* centre — live network status */}
        <div className="hidden justify-self-center sm:block">
          <LiveClock />
        </div>

        {/* right — three words; tighter gap on phones so they clear the mark */}
        <nav className="pointer-events-auto flex items-center gap-5 justify-self-end sm:gap-7">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="font-mono text-xs uppercase tracking-[0.24em] text-cm-muted transition-colors hover:text-cm-text"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
