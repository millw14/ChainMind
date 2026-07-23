"use client";

import { useEffect, useRef } from "react";
import DotGrid from "@/components/landing/DotGrid";
import DraggableWordmark from "@/components/landing/DraggableWordmark";

/**
 * EditorialHero — full-viewport hero: a dot-grid field with the wordmark
 * presented as a selected object in the middle, framed by small mono type.
 */
export default function EditorialHero() {
  const rootRef = useRef(null);

  // Fail-visible net: the mono framing uses fill-mode "both", so a stalled
  // animation clock would leave it parked hidden. Force the resting state once
  // the longest delay has passed. Copy must never depend on an animation.
  useEffect(() => {
    const t = setTimeout(() => rootRef.current?.classList.add("cm-revealed"), 2400);
    return () => clearTimeout(t);
  }, []);

  return (
    <section
      ref={rootRef}
      className="relative flex min-h-[92svh] flex-col items-center justify-center overflow-hidden border-b border-cm-border-subtle bg-cm-bg px-6 py-24 sm:px-10"
    >
      <DotGrid gap={22} fade parallax />
      <div aria-hidden className="cm-ambient-orb cm-ambient-orb--breathe left-1/2 top-1/2 h-[34rem] w-[34rem] -translate-x-1/2 -translate-y-1/2 bg-cm-accent/8" />

      {/* small mono line above the wordmark — the scale contrast anchor */}
      <p
        className="cm-fade-in relative z-10 text-center font-mono text-[10px] uppercase tracking-[0.34em] text-cm-muted sm:text-xs sm:tracking-[0.42em]"
        style={{ animationDelay: "0.15s" }}
      >
        Reading the chain, block by block.
      </p>

      {/* the selected object */}
      <div className="relative z-10 mt-10 w-full sm:mt-14">
        <DraggableWordmark top="CHAIN" bottom="MIND" hint="Drag to move" />
      </div>

      <p
        className="cm-fade-in relative z-10 mt-12 max-w-md text-center text-base leading-relaxed text-cm-muted sm:mt-16 sm:text-lg"
        style={{ animationDelay: "0.5s" }}
      >
        Wallets, tokens and transactions on Robinhood Chain — explained in plain English.
      </p>
    </section>
  );
}
