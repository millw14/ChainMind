"use client";
import Link from "next/link";
import { useState } from "react";
import { ChainMindLogo } from "@/components/ChainMindLogo";
import WalletMenu from "@/components/wallet/WalletMenu";

export function ConsoleHeader() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-cm-border bg-cm-card/95 pt-[env(safe-area-inset-top,0px)] backdrop-blur-md">
      <div className="mx-auto flex min-h-12 max-w-[88rem] items-center justify-between gap-2 px-3 sm:min-h-14 sm:gap-3 sm:px-6">
        {/* Logo */}
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <Link href="/" className="flex shrink-0 items-center gap-2 text-sm font-semibold text-cm-text">
            <span className="flex h-8 w-8 items-center justify-center rounded border border-cm-accent/20 bg-cm-card">
              <ChainMindLogo size={22} />
            </span>
            <span className="hidden sm:inline">ChainMind</span>
          </Link>
          <span className="hidden h-4 w-px bg-cm-border sm:block" />
          <div className="hidden sm:block min-w-0">
            <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.2em] text-cm-faint">Robinhood Chain</p>
            <p className="truncate font-mono text-[11px] text-cm-terminal">AI explorer · live</p>
          </div>
        </div>

        {/* Desktop nav */}
        <nav className="hidden sm:flex shrink-0 items-center gap-1 font-mono text-xs sm:gap-3">
          <Link href="/ask" className="rounded-md px-3 py-2 font-medium text-cm-accent-bright hover:bg-cm-row-hover hover:text-cm-text">
            Ask AI
          </Link>
          <Link href="/docs" className="rounded-md px-3 py-2 text-cm-muted hover:bg-cm-row-hover hover:text-cm-text">
            Docs
          </Link>
          <Link href="/" className="rounded-md px-3 py-2 text-cm-muted hover:bg-cm-row-hover hover:text-cm-text">
            Home
          </Link>
          {/* The gate lives in the header because it is where a visitor looks for
              "who am I here" — and because the quota it shows applies to every
              question asked from any surface below it. */}
          <WalletMenu />
        </nav>

        {/* Mobile: the wallet stays out of the hamburger. A daily allowance the
            reader cannot see is one they only learn about by hitting it. */}
        <div className="flex items-center gap-2 sm:hidden">
          <WalletMenu />
          <button
            type="button"
            className="flex items-center justify-center h-10 w-10 rounded-md text-cm-muted hover:bg-cm-row-hover hover:text-cm-text"
            onClick={() => setOpen(o => !o)}
            aria-label="Menu"
          >
            {open ? (
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M2 2l14 14M16 2L2 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M2 4h14M2 9h14M2 14h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Mobile dropdown */}
      {open && (
        <div className="sm:hidden border-t border-cm-border bg-cm-card/98 px-3 py-2">
          <nav className="flex flex-col font-mono text-sm">
            <Link href="/ask" onClick={() => setOpen(false)} className="rounded-md px-3 py-3 font-medium text-cm-accent-bright hover:bg-cm-row-hover">
              Ask AI
            </Link>
            <Link href="/docs" onClick={() => setOpen(false)} className="rounded-md px-3 py-3 text-cm-muted hover:bg-cm-row-hover hover:text-cm-text">
              Docs
            </Link>
            <Link href="/" onClick={() => setOpen(false)} className="rounded-md px-3 py-3 text-cm-muted hover:bg-cm-row-hover hover:text-cm-text">
              Home
            </Link>
          </nav>
        </div>
      )}
    </header>
  );
}
