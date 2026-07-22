"use client";

import { useRef } from "react";
import { motion, useReducedMotion, useScroll, useTransform } from "framer-motion";

const DEFAULT_ITEMS = [
  {
    kicker: "01 / ASK",
    title: "Ask anything, on-chain",
    body: "Type a plain-English question and get a sourced answer. ChainMind reads Robinhood Chain state and explains it like a person, not a block explorer.",
    accent: "var(--cm-accent)",
    code: "> who bought $RHC in the last hour?",
  },
  {
    kicker: "02 / TRACE",
    title: "Wallet x-ray",
    body: "Paste any address to see holdings, first funding, counterparties, and behavior at a glance. Follow the money without opening ten tabs.",
    accent: "var(--cm-accent-bright)",
    code: "0x9f…c41 · 142 txns · 6 tokens",
  },
  {
    kicker: "03 / FORENSICS",
    title: "Token forensics",
    body: "Liquidity, holder concentration, mint authority, and deployer history scored in one view — so you spot the rug before it pulls.",
    accent: "var(--cm-accent-dim)",
    code: "top10 hold 61% · lp locked 30d",
  },
  {
    kicker: "04 / PULSE",
    title: "Live market pulse",
    body: "Streaming prices, flows, and whale moves across the chain, ranked by what actually matters right now instead of raw noise.",
    accent: "var(--cm-accent)",
    code: "net inflow +$2.4M · 5m",
  },
  {
    kicker: "05 / CLARITY",
    title: "No jargon",
    body: "Every metric comes with a one-line reason it moved. ChainMind turns raw ledger data into decisions you can defend.",
    accent: "var(--cm-accent-bright)",
    code: "why? → 3 wallets rotated out",
  },
];

/**
 * FeatureStack — sticky, stacked scroll cards for the ChainMind landing page.
 * Cards pin and stack as the user scrolls, each scaling down and dimming as the
 * next slides over it. Honors reduced-motion with a plain vertical stack.
 *
 * @param {Object} props
 * @param {Array<{kicker?:string,title:string,body:string,accent?:string,code?:string}>} [props.items] - Override the default feature cards.
 * @param {string} [props.className] - Extra classes on the outer section.
 * @returns {JSX.Element}
 */
export default function FeatureStack({ items, className = "" }) {
  const reduce = useReducedMotion();
  const cards = items && items.length ? items : DEFAULT_ITEMS;

  if (reduce) {
    return (
      <section className={`mx-auto w-full max-w-3xl px-4 ${className}`}>
        <div className="flex flex-col gap-6">
          {cards.map((card, i) => (
            <Card key={i} card={card} index={i} total={cards.length} />
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className={`mx-auto w-full max-w-3xl px-4 ${className}`}>
      {cards.map((card, i) => (
        <StickyCard
          key={i}
          card={card}
          index={i}
          total={cards.length}
        />
      ))}
    </section>
  );
}

function StickyCard({ card, index, total }) {
  const ref = useRef(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start start", "end start"],
  });

  // Drive the transforms as the NEXT card slides up over this one.
  const scale = useTransform(scrollYProgress, [0, 1], [1, 0.92]);
  const opacity = useTransform(scrollYProgress, [0, 1], [1, 0.55]);
  const y = useTransform(scrollYProgress, [0, 1], [0, -18]);

  const isLast = index === total - 1;
  const top = `calc(12vh + ${index * 14}px)`;

  return (
    <div
      ref={ref}
      className="sticky"
      style={{ top, marginBottom: isLast ? 0 : "6vh" }}
    >
      <motion.div style={isLast ? undefined : { scale, opacity, y }}>
        <Card card={card} index={index} total={total} />
      </motion.div>
    </div>
  );
}

function Card({ card, index, total }) {
  const accent = card.accent || "var(--cm-accent)";
  return (
    <article
      className="relative overflow-hidden rounded-xl border border-cm-border bg-cm-card/80 p-7 shadow-cm backdrop-blur-md sm:p-9"
    >
      {/* faint node motif */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full opacity-20 blur-2xl"
        style={{ background: accent }}
      />
      <div
        aria-hidden="true"
        className="absolute left-0 top-0 h-full w-px"
        style={{ background: `linear-gradient(to bottom, ${accent}, transparent)` }}
      />

      <div className="flex items-center justify-between">
        <span className="font-mono text-xs tracking-widest text-cm-faint">
          {card.kicker || `${String(index + 1).padStart(2, "0")} / 0${total}`}
        </span>
        <span
          aria-hidden="true"
          className="h-2 w-2 rounded-full"
          style={{ background: accent, boxShadow: `0 0 12px ${accent}` }}
        />
      </div>

      <h3 className="mt-5 text-2xl font-semibold tracking-tight text-cm-text sm:text-3xl">
        {card.title}
      </h3>

      {/* thin accent rule */}
      <div
        aria-hidden="true"
        className="mt-4 h-px w-16 rounded-full"
        style={{ background: accent }}
      />

      <p className="mt-4 max-w-prose text-sm leading-relaxed text-cm-muted sm:text-base">
        {card.body}
      </p>

      {card.code ? (
        <div className="mt-6 flex items-center gap-2 rounded-lg border border-cm-border-subtle bg-cm-bg/60 px-3 py-2">
          <span
            aria-hidden="true"
            className="font-mono text-xs"
            style={{ color: accent }}
          >
            ▸
          </span>
          <code className="truncate font-mono text-xs text-cm-terminal">
            {card.code}
          </code>
        </div>
      ) : null}
    </article>
  );
}
