"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import HeroGridCanvas from "@/components/landing/HeroGridCanvas";

/**
 * MaskedLine — a line of display type that rises out of an overflow mask.
 * The rise is a CSS animation, not a JS one: if a JS-driven reveal never gets
 * a frame, the line stays parked at its hidden start value and the headline
 * silently disappears. CSS keeps the copy independent of the JS thread.
 * @param {{ children: import("react").ReactNode, delay?: number, className?: string }} props
 */
function MaskedLine({ children, delay = 0, className = "" }) {
  return (
    <span className="block overflow-hidden pb-[0.06em]">
      <span className={`cm-line-rise block ${className}`} style={{ animationDelay: `${delay}s` }}>
        {children}
      </span>
    </span>
  );
}

/**
 * EditorialHero — full-viewport hero built on scale contrast: a 10px mono label
 * against a wordmark that fills the screen, with brutal whitespace between.
 */
export default function EditorialHero() {
  const rootRef = useRef(null);

  // Fail-visible net: the entrance animations use fill-mode "both", so a stalled
  // animation clock would leave the wordmark parked off-mask and invisible. Once
  // the longest delay + duration has passed, force the resting state regardless.
  useEffect(() => {
    const t = setTimeout(() => rootRef.current?.classList.add("cm-revealed"), 2600);
    return () => clearTimeout(t);
  }, []);

  return (
    <section
      ref={rootRef}
      className="relative flex min-h-[94svh] flex-col overflow-hidden border-b border-cm-border-subtle bg-cm-bg"
    >
      <HeroGridCanvas speed={0.6} density={0.8} />
      <div aria-hidden className="cm-ambient-orb cm-ambient-orb--breathe left-[-10rem] top-[10%] h-[26rem] w-[26rem] bg-cm-accent/12" />

      {/* top rule — tiny mono meta, maximum scale contrast against the wordmark */}
      <div
        className="cm-fade-in relative z-10 mx-auto flex w-full max-w-[100rem] items-center justify-between px-6 pt-8 font-mono text-[10px] uppercase tracking-[0.34em] text-cm-faint sm:px-10"
        style={{ animationDelay: "0.1s" }}
      >
        <span className="flex items-center gap-2 text-cm-terminal">
          <span className="cm-pulse-live inline-block h-1 w-1 rounded-full bg-cm-ok" />
          Robinhood Chain
        </span>
        <span className="hidden sm:block">AI Explorer</span>
      </div>

      {/* the wordmark — the only thing that matters on this screen */}
      <div className="relative z-10 mx-auto flex w-full max-w-[100rem] flex-1 flex-col justify-center px-6 py-16 sm:px-10">
        <h1 className="font-semibold uppercase leading-[0.82] tracking-[-0.045em] text-cm-text">
          <MaskedLine delay={0.25} className="text-[clamp(3.25rem,15.5vw,13rem)]">
            Ask the
          </MaskedLine>
          <MaskedLine delay={0.38} className="cm-text-outline text-[clamp(3.25rem,15.5vw,13rem)]">
            Chain
          </MaskedLine>
        </h1>

        <p
          className="cm-fade-in mt-10 max-w-sm text-[0.95rem] leading-relaxed text-cm-muted sm:mt-14"
          style={{ animationDelay: "1.05s" }}
        >
          Wallets, tokens and transactions — read straight from the chain and explained in plain
          English.
        </p>

        <div className="cm-fade-in mt-10 flex items-center gap-8" style={{ animationDelay: "1.2s" }}>
          <Link
            href="/ask"
            className="group inline-flex items-center gap-3 border-b border-cm-accent pb-1 font-mono text-xs uppercase tracking-[0.24em] text-cm-accent transition-colors hover:text-cm-accent-bright"
          >
            Start asking
            <span aria-hidden className="transition-transform duration-300 group-hover:translate-x-1">
              →
            </span>
          </Link>
          <Link
            href="/how-it-works"
            className="font-mono text-xs uppercase tracking-[0.24em] text-cm-faint transition-colors hover:text-cm-text"
          >
            How it works
          </Link>
        </div>
      </div>

      {/* bottom rule */}
      <div
        className="cm-fade-in relative z-10 mx-auto flex w-full max-w-[100rem] items-center justify-between border-t border-cm-border-subtle px-6 py-6 font-mono text-[10px] uppercase tracking-[0.34em] text-cm-faint sm:px-10"
        style={{ animationDelay: "1.35s" }}
      >
        <span>Scroll</span>
        <span className="hidden sm:block">No signup required</span>
      </div>
    </section>
  );
}
