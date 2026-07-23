"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import {
  motion,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
} from "framer-motion";

/* -------------------------------------------------------------------------- */
/* Visuals — original, geometric, accent-only mocks of each feature            */
/* -------------------------------------------------------------------------- */

const SVG_PROPS = {
  className: "h-full w-full",
  preserveAspectRatio: "xMidYMid meet",
  "aria-hidden": "true",
  focusable: "false",
};

/** Prompt bar + three ranked answer rows. */
function QueryMock() {
  const rows = [
    { w: 148, bar: 34 },
    { w: 112, bar: 22 },
    { w: 128, bar: 13 },
  ];
  return (
    <svg {...SVG_PROPS} viewBox="0 0 260 200">
      <rect
        x="18"
        y="20"
        width="224"
        height="34"
        rx="8"
        fill="var(--cm-surface)"
        stroke="var(--cm-border)"
      />
      <path
        d="M32 31 l7 6 -7 6"
        fill="none"
        stroke="var(--cm-accent)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="48" y="34" width="122" height="6" rx="3" fill="var(--cm-muted)" opacity="0.55" />
      <rect x="176" y="28" width="2" height="18" rx="1" fill="var(--cm-accent-bright)" />
      {rows.map((r, i) => (
        <g key={i} transform={`translate(18 ${74 + i * 38})`}>
          <rect width="224" height="28" rx="6" fill="var(--cm-row)" />
          <rect x="12" y="10" width="8" height="8" rx="2" fill="var(--cm-accent)" opacity={1 - i * 0.28} />
          <rect x="30" y="11" width={r.w} height="6" rx="3" fill="var(--cm-faint)" />
          <rect
            x={224 - 12 - r.bar}
            y="11"
            width={r.bar}
            height="6"
            rx="3"
            fill="var(--cm-accent)"
            opacity={0.9 - i * 0.25}
          />
        </g>
      ))}
    </svg>
  );
}

/** Central wallet node wired to counterparty satellites. */
function WalletMock() {
  const nodes = [
    { x: 52, y: 44, r: 7 },
    { x: 214, y: 58, r: 5 },
    { x: 40, y: 140, r: 5 },
    { x: 206, y: 150, r: 8 },
    { x: 130, y: 178, r: 4 },
    { x: 132, y: 24, r: 5 },
  ];
  return (
    <svg {...SVG_PROPS} viewBox="0 0 260 200">
      {nodes.map((n, i) => (
        <line
          key={`e${i}`}
          x1="130"
          y1="100"
          x2={n.x}
          y2={n.y}
          stroke="var(--cm-accent)"
          strokeWidth="1"
          opacity={0.22 + (i % 3) * 0.14}
        />
      ))}
      <circle cx="130" cy="100" r="26" fill="none" stroke="var(--cm-accent)" opacity="0.28" />
      <circle cx="130" cy="100" r="14" fill="var(--cm-accent)" opacity="0.16" />
      <circle cx="130" cy="100" r="7" fill="var(--cm-accent-bright)" />
      {nodes.map((n, i) => (
        <circle
          key={`n${i}`}
          cx={n.x}
          cy={n.y}
          r={n.r}
          fill="var(--cm-bg)"
          stroke="var(--cm-accent)"
          strokeWidth="1.5"
          opacity={0.5 + (i % 3) * 0.2}
        />
      ))}
    </svg>
  );
}

/** Holder concentration bars over a segmented liquidity meter. */
function ForensicsMock() {
  const bars = [0.92, 0.61, 0.44, 0.29, 0.17];
  return (
    <svg {...SVG_PROPS} viewBox="0 0 260 200">
      {bars.map((v, i) => (
        <g key={i} transform={`translate(24 ${26 + i * 22})`}>
          <rect width="212" height="10" rx="5" fill="var(--cm-row)" />
          <rect
            width={212 * v}
            height="10"
            rx="5"
            fill={i === 0 ? "var(--cm-warn)" : "var(--cm-accent)"}
            opacity={i === 0 ? 0.9 : 0.85 - i * 0.13}
          />
        </g>
      ))}
      <rect x="24" y="150" width="212" height="26" rx="6" fill="var(--cm-surface)" stroke="var(--cm-border)" />
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <rect
          key={i}
          x={34 + i * 28}
          y="158"
          width="18"
          height="10"
          rx="2"
          fill={i < 5 ? "var(--cm-accent)" : "var(--cm-faint)"}
          opacity={i < 5 ? 0.75 : 0.4}
        />
      ))}
    </svg>
  );
}

/** Sparkline with area fill and a volume strip. */
function PulseMock() {
  const gradientId = `cm-deck-pulse-${useId()}`;
  const line =
    "M20 122 L46 108 L72 118 L98 86 L124 96 L150 62 L176 74 L202 44 L236 52";
  return (
    <svg {...SVG_PROPS} viewBox="0 0 260 200">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--cm-accent)" stopOpacity="0.32" />
          <stop offset="100%" stopColor="var(--cm-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[52, 92, 132].map((y) => (
        <line key={y} x1="20" y1={y} x2="236" y2={y} stroke="var(--cm-border-subtle)" strokeWidth="1" />
      ))}
      <path d={`${line} L236 140 L20 140 Z`} fill={`url(#${gradientId})`} />
      <path
        d={line}
        fill="none"
        stroke="var(--cm-accent-bright)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="236" cy="52" r="4" fill="var(--cm-accent-bright)" />
      <circle cx="236" cy="52" r="9" fill="none" stroke="var(--cm-accent)" opacity="0.4" />
      {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
        <rect
          key={i}
          x={20 + i * 25}
          y={176 - (6 + ((i * 7) % 19))}
          width="14"
          height={6 + ((i * 7) % 19)}
          rx="2"
          fill="var(--cm-accent)"
          opacity={i > 6 ? 0.85 : 0.35}
        />
      ))}
    </svg>
  );
}

const VISUALS = {
  query: QueryMock,
  wallet: WalletMock,
  forensics: ForensicsMock,
  pulse: PulseMock,
};

/* -------------------------------------------------------------------------- */
/* Content                                                                     */
/* -------------------------------------------------------------------------- */

const DEFAULT_ITEMS = [
  {
    id: "ask",
    kicker: "ON-CHAIN  •  ANSWERS",
    title: "Ask anything on-chain",
    description:
      "Type the question the way you'd say it out loud. ChainMind resolves it against live Robinhood Chain state and answers with the rows it used, so you can check the work instead of trusting a number.",
    metrics: [
      { label: "Median answer", value: "1.4s" },
      { label: "Sourced rows", value: "100%" },
    ],
    cta: { label: "Try a query", href: "/ask" },
    visual: "query",
  },
  {
    id: "wallet",
    kicker: "TRACE  •  WALLETS",
    title: "Wallet x-ray",
    description:
      "Paste an address and get the shape of it immediately: what it holds, where it was funded from, who it trades against, and how its behavior has drifted over the last thousand transactions.",
    metrics: [
      { label: "Hops mapped", value: "4" },
      { label: "Counterparties", value: "218" },
      { label: "Refresh", value: "Live" },
    ],
    cta: { label: "Trace an address", href: "/ask" },
    visual: "wallet",
  },
  {
    id: "forensics",
    kicker: "RISK  •  TOKENS",
    title: "Token forensics",
    description:
      "Holder concentration, pool depth, unlock cliffs, and every contract the deployer has touched before — collapsed into one read so a thin float or a recycled rug pattern is obvious in seconds.",
    metrics: [
      { label: "Top 10 hold", value: "61%" },
      { label: "LP locked", value: "30d" },
      { label: "Deployer tokens", value: "7" },
    ],
    cta: { label: "Scan a token", href: "/ask" },
    visual: "forensics",
  },
  {
    id: "pulse",
    kicker: "FLOW  •  MARKETS",
    title: "Live market pulse",
    description:
      "Net flows, rotations, and whale prints ranked by what actually moved price — not a firehose of transfers. Each spike carries a one-line reason you can repeat to someone else.",
    metrics: [
      { label: "Net inflow 5m", value: "+$2.4M" },
      { label: "Whale prints", value: "12" },
    ],
    cta: { label: "Open the pulse", href: "/ask" },
    visual: "pulse",
  },
];

/* -------------------------------------------------------------------------- */
/* Pieces                                                                      */
/* -------------------------------------------------------------------------- */

const DOT_GRID = {
  backgroundImage:
    "radial-gradient(var(--cm-border) 1px, transparent 1px), radial-gradient(var(--cm-border-subtle) 1px, transparent 1px)",
  backgroundSize: "26px 26px, 26px 26px",
  backgroundPosition: "0 0, 13px 13px",
};

function Metrics({ metrics }) {
  if (!metrics || !metrics.length) return null;
  return (
    <div className="flex flex-wrap gap-9">
      {metrics.map((m) => (
        <div key={m.label}>
          <div className="font-mono text-[10px] uppercase tracking-wider text-cm-faint">
            {m.label}
          </div>
          <div className="mt-1 text-lg font-semibold text-cm-text">{m.value}</div>
        </div>
      ))}
    </div>
  );
}

function CardFace({ item }) {
  const Visual = VISUALS[item.visual] || VISUALS.query;
  const cta = item.cta;

  return (
    <div className="grid w-full overflow-hidden rounded-xl border border-cm-border bg-cm-card shadow-cm md:min-h-[62vh] md:grid-cols-[42%,1fr]">
      {/* LEFT — content */}
      <div
        className="relative flex flex-col justify-between gap-10 border-b border-cm-border bg-cm-surface md:border-b-0"
        style={{ padding: "clamp(2rem, 5vw, 4rem)" }}
      >
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-cm-muted">
            {item.kicker}
          </div>
          <h3 className="mt-5 text-[clamp(1.6rem,2.8vw,2.6rem)] font-semibold leading-[1.08] tracking-[-0.03em] text-cm-text">
            {item.title}
          </h3>
          <p className="mt-4 max-w-[46ch] text-[15px] leading-[1.65] text-cm-muted">
            {item.description}
          </p>
        </div>

        <div className="flex flex-col gap-7">
          <Metrics metrics={item.metrics} />
          {cta ? (
            <Link
              href={cta.href || "/ask"}
              className="group inline-flex w-fit items-center gap-2 font-mono text-xs uppercase tracking-[0.2em] text-cm-accent transition-colors hover:text-cm-accent-bright focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cm-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cm-surface"
            >
              {cta.label}
              <span
                aria-hidden="true"
                className="inline-block transition-transform duration-300 ease-out group-hover:translate-x-1 group-focus-visible:translate-x-1 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
              >
                &#8594;
              </span>
            </Link>
          ) : null}
        </div>

        {/* vertical hairline divider on the inner edge (desktop only) */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 hidden w-px md:block"
          style={{
            backgroundImage:
              "linear-gradient(to bottom, transparent, var(--cm-border) 30%, var(--cm-border) 70%, transparent)",
          }}
        />
      </div>

      {/* RIGHT — visual */}
      <div className="relative flex min-h-[220px] items-center justify-center bg-cm-bg p-6 sm:p-8">
        <div aria-hidden="true" className="absolute inset-0 opacity-70" style={DOT_GRID} />
        <div className="relative aspect-[13/10] w-full max-w-[420px]">
          <Visual />
        </div>
      </div>
    </div>
  );
}

/**
 * One pinned card. The wrapper is sticky and exactly one viewport tall, so the
 * next card scrolls up and covers it; meanwhile the card itself tilts back in
 * real 3D (perspective lives on the wrapper, rotateX on the card).
 */
function DeckCard({ item, isLast, tiltDeg, liftPx }) {
  const wrapperRef = useRef(null);
  const { scrollYProgress } = useScroll({
    target: wrapperRef,
    offset: ["start start", "end start"],
  });

  const spring = { stiffness: 120, damping: 26, restDelta: 0.0005 };
  const rotateX = useSpring(useTransform(scrollYProgress, [0, 1], [0, tiltDeg]), spring);
  const scale = useSpring(useTransform(scrollYProgress, [0, 1], [1, 0.9]), spring);
  const opacity = useSpring(useTransform(scrollYProgress, [0, 1], [1, 0.35]), spring);
  const y = useSpring(useTransform(scrollYProgress, [0, 1], [0, liftPx]), spring);

  // The final card stays at rest so the section lands flat.
  const style = isLast ? undefined : { rotateX, scale, opacity, y };

  return (
    <div
      ref={wrapperRef}
      className="sticky top-0 flex h-[100svh] items-center justify-center px-4 sm:px-6"
      style={{ perspective: "1200px", willChange: "transform, opacity" }}
    >
      <motion.div
        style={style}
        className="w-full max-w-5xl origin-top"
      >
        <CardFace item={item} />
      </motion.div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Root                                                                        */
/* -------------------------------------------------------------------------- */

/** Tracks coarse pointers so the tilt is softened on touch devices. */
function useCoarsePointer() {
  const [coarse, setCoarse] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(pointer: coarse)");
    const sync = () => setCoarse(mq.matches);
    sync();
    if (mq.addEventListener) {
      mq.addEventListener("change", sync);
      return () => mq.removeEventListener("change", sync);
    }
    mq.addListener(sync);
    return () => mq.removeListener(sync);
  }, []);

  return coarse;
}

/**
 * ScrollDeck — a scroll-pinned, true 3D card deck for the ChainMind landing page.
 *
 * Every card gets its own sticky, full-viewport wrapper that carries the CSS
 * `perspective`; the card inside rotates on X, scales, lifts, and dims as its
 * wrapper scrolls past, so the next card visibly slides over a receding one.
 * The last card is left untransformed so the section ends flat. Cards render
 * fully opaque and untransformed by default — if scroll never resolves (SSR,
 * JS disabled mid-hydration, reduced motion) the content is still readable.
 *
 * @param {Object} props
 * @param {Array<{id?:string,kicker?:string,title:string,description?:string,metrics?:Array<{label:string,value:string}>,cta?:{label:string,href?:string},visual?:("query"|"wallet"|"forensics"|"pulse")}>} [props.items]
 *   Cards to render, top to bottom. Defaults to the four product cards defined in this file.
 * @param {string} [props.className] Extra classes for the outer section element.
 * @returns {JSX.Element}
 */
export default function ScrollDeck({ items, className = "" }) {
  const reduce = useReducedMotion();
  const coarse = useCoarsePointer();
  const cards = items && items.length ? items : DEFAULT_ITEMS;

  // Calm, fully-visible fallback: a plain vertical stack, no pinning or 3D.
  if (reduce) {
    return (
      <section className={`relative w-full px-4 sm:px-6 ${className}`}>
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-16 py-16">
          {cards.map((item, i) => (
            <CardFace key={item.id || item.title || i} item={item} />
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className={`relative w-full pb-[10vh] ${className}`}>
      {cards.map((item, i) => (
        <DeckCard
          key={item.id || item.title || i}
          item={item}
          isLast={i === cards.length - 1}
          tiltDeg={coarse ? -4 : -9}
          liftPx={coarse ? -20 : -40}
        />
      ))}
    </section>
  );
}
