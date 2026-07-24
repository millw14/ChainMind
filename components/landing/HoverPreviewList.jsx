"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import Link from "next/link";

const PANEL_W = 420;
const PANEL_H = (420 * 9) / 16;
const CURSOR_GAP = 24;
const EDGE = 12;
const LERP = 0.14;

const DEFAULT_ITEMS = [
  {
    label: "Wallets",
    meta: "Address intel",
    blurb: "Holdings, funding path, counterparties",
    viz: "cluster",
  },
  {
    label: "Tokens",
    meta: "Supply & holders",
    blurb: "Concentration, mint rights, liquidity",
    viz: "bars",
  },
  {
    label: "Transactions",
    meta: "Trace & decode",
    blurb: "Every hop, in plain language",
    viz: "trace",
  },
  {
    label: "Contracts",
    meta: "Bytecode & ABI",
    blurb: "Verified source, methods, permissions",
    viz: "grid",
  },
  {
    label: "Market flows",
    meta: "Flows & whales",
    blurb: "Net inflow, rotations, size clusters",
    viz: "flow",
  },
];

/* ------------------------------------------------------------------ *
 * Original abstract preview visuals — pure inline SVG, no assets.
 * All geometry is precomputed and deterministic (SSR-safe).
 * ------------------------------------------------------------------ */

const SATELLITES = [
  [58, 44],
  [252, 38],
  [286, 108],
  [206, 152],
  [92, 148],
  [36, 104],
];

const BAR_HEIGHTS = [0.94, 0.72, 0.61, 0.5, 0.44, 0.36, 0.31, 0.24, 0.19, 0.12];

const TRACE_STOPS = [38, 96, 154, 212, 270];

const FLOW_SERIES = [0.32, 0.46, 0.38, 0.55, 0.49, 0.68, 0.6, 0.79, 0.71, 0.9, 0.83, 0.97];

const FLOW_POINTS = FLOW_SERIES.map((v, i) => {
  const x = 24 + (i * (272 - 24)) / (FLOW_SERIES.length - 1);
  const y = 148 - v * 104;
  return `${x.toFixed(1)},${y.toFixed(1)}`;
}).join(" ");

const FLOW_AREA = `M24,148 L${FLOW_POINTS.split(" ").join(" L")} L272,148 Z`;

const GRID_CELLS = [];
for (let r = 0; r < 5; r += 1) {
  for (let c = 0; c < 12; c += 1) {
    // deterministic "hash" so the lit cells look scattered but stable
    const lit = (r * 7 + c * 5 + ((r * c) % 3)) % 6 === 0;
    const bright = lit && (r + c) % 4 === 0;
    GRID_CELLS.push({ r, c, lit, bright });
  }
}

function PreviewVisual({ kind }) {
  const common = {
    viewBox: "0 0 320 180",
    preserveAspectRatio: "xMidYMid meet",
    className: "h-full w-full",
    role: "presentation",
    focusable: "false",
  };

  if (kind === "cluster") {
    return (
      <svg {...common}>
        {SATELLITES.map(([x, y], i) => (
          <line
            key={`l${i}`}
            x1="160"
            y1="92"
            x2={x}
            y2={y}
            stroke="var(--cm-accent)"
            strokeOpacity={0.32}
            strokeWidth="1"
          />
        ))}
        {SATELLITES.map(([x, y], i) => (
          <circle
            key={`c${i}`}
            cx={x}
            cy={y}
            r={i % 3 === 0 ? 6 : 4}
            fill="var(--cm-accent-dim)"
            stroke="var(--cm-accent-bright)"
            strokeOpacity={0.7}
            strokeWidth="1"
          />
        ))}
        <circle cx="160" cy="92" r="15" fill="var(--cm-accent)" fillOpacity={0.16} />
        <circle cx="160" cy="92" r="7" fill="var(--cm-accent-bright)" />
      </svg>
    );
  }

  if (kind === "bars") {
    return (
      <svg {...common}>
        {BAR_HEIGHTS.map((h, i) => {
          const w = 18;
          const x = 22 + i * 28;
          const height = 12 + h * 128;
          return (
            <rect
              key={i}
              x={x}
              y={158 - height}
              width={w}
              height={height}
              rx="2"
              fill={i < 3 ? "var(--cm-accent-bright)" : "var(--cm-accent)"}
              fillOpacity={i < 3 ? 0.9 : 0.34}
            />
          );
        })}
        <line x1="18" y1="158" x2="302" y2="158" stroke="var(--cm-border)" strokeWidth="1" />
      </svg>
    );
  }

  if (kind === "trace") {
    return (
      <svg {...common}>
        <line x1="28" y1="90" x2="292" y2="90" stroke="var(--cm-accent)" strokeOpacity={0.28} strokeWidth="1" />
        {TRACE_STOPS.map((x, i) => (
          <g key={i}>
            <line
              x1={x}
              y1={i % 2 === 0 ? 56 : 90}
              x2={x}
              y2={i % 2 === 0 ? 90 : 124}
              stroke="var(--cm-accent)"
              strokeOpacity={0.4}
              strokeWidth="1"
            />
            <rect
              x={x - 20}
              y={i % 2 === 0 ? 44 : 116}
              width="40"
              height="16"
              rx="3"
              fill="var(--cm-accent)"
              fillOpacity={i === 2 ? 0.55 : 0.18}
            />
            <circle cx={x} cy="90" r={i === 2 ? 6 : 4} fill="var(--cm-accent-bright)" />
          </g>
        ))}
        <polygon points="292,90 282,85 282,95" fill="var(--cm-accent-bright)" />
      </svg>
    );
  }

  if (kind === "grid") {
    return (
      <svg {...common}>
        {GRID_CELLS.map(({ r, c, lit, bright }) => (
          <rect
            key={`${r}-${c}`}
            x={24 + c * 23}
            y={38 + r * 22}
            width="17"
            height="15"
            rx="2"
            fill={bright ? "var(--cm-accent-bright)" : lit ? "var(--cm-accent)" : "var(--cm-accent)"}
            fillOpacity={bright ? 0.95 : lit ? 0.55 : 0.1}
          />
        ))}
      </svg>
    );
  }

  // "flow" — default sparkline with area
  return (
    <svg {...common}>
      <path d={FLOW_AREA} fill="var(--cm-accent)" fillOpacity={0.14} />
      <polyline
        points={FLOW_POINTS}
        fill="none"
        stroke="var(--cm-accent-bright)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line x1="24" y1="148" x2="296" y2="148" stroke="var(--cm-border)" strokeWidth="1" />
      <circle cx="272" cy={(148 - 0.97 * 104).toFixed(1)} r="4.5" fill="var(--cm-accent-bright)" />
    </svg>
  );
}

/**
 * HoverPreviewList — an editorial "what you can explore" list for the ChainMind
 * landing page.
 *
 * Each row's label sits as an outline-only display word at rest and flips to a
 * filled accent word that slides right on hover. Hovering also summons a single
 * fixed preview panel that eases toward the pointer via a per-frame lerp inside
 * one rAF loop (position is written straight to the DOM node — never through
 * React state). The panel is disabled entirely for coarse pointers, narrow
 * viewports and reduced-motion users; rows and their hover styling still work.
 * Text is filled (visible) until the outline effect is confirmed supported, so
 * content is never invisible if an effect fails to run.
 *
 * @param {Object} props
 * @param {Array<{label:string,meta?:string,blurb?:string,viz?:("cluster"|"bars"|"trace"|"grid"|"flow"),href?:string}>} [props.items] - Rows to render; falls back to the built-in Robinhood Chain set.
 * @param {string} [props.heading] - Optional small mono heading above the list.
 * @param {string} [props.className] - Extra classes on the outer section.
 * @returns {JSX.Element}
 */
export default function HoverPreviewList({
  items,
  heading = "What you can explore",
  className = "",
}) {
  const reduce = useReducedMotion();
  const rows = items && items.length ? items : DEFAULT_ITEMS;

  const [interactive, setInteractive] = useState(false);
  const [strokeOk, setStrokeOk] = useState(false);
  const [hovered, setHovered] = useState(-1);
  const [focused, setFocused] = useState(-1);
  const [previewIndex, setPreviewIndex] = useState(0);

  const panelRef = useRef(null);
  const targetRef = useRef({ x: -9999, y: -9999 });
  const posRef = useRef({ x: -9999, y: -9999 });
  const seededRef = useRef(false);

  const activeIndex = hovered >= 0 ? hovered : focused;
  const panelOn = interactive && hovered >= 0;

  /* Outline text is only safe once we know the browser supports it. */
  useEffect(() => {
    if (
      typeof CSS !== "undefined" &&
      typeof CSS.supports === "function" &&
      (CSS.supports("-webkit-text-stroke-width", "1px") ||
        CSS.supports("-webkit-text-stroke", "1px #fff"))
    ) {
      setStrokeOk(true);
    }
  }, []);

  /* Only enable the floating preview on fine pointers + roomy viewports. */
  useEffect(() => {
    if (reduce) {
      setInteractive(false);
      return undefined;
    }
    const coarse = window.matchMedia("(pointer: coarse)");
    const apply = () => {
      setInteractive(!coarse.matches && window.innerWidth >= 900);
    };
    apply();
    if (coarse.addEventListener) coarse.addEventListener("change", apply);
    else if (coarse.addListener) coarse.addListener(apply);
    window.addEventListener("resize", apply);
    return () => {
      if (coarse.removeEventListener) coarse.removeEventListener("change", apply);
      else if (coarse.removeListener) coarse.removeListener(apply);
      window.removeEventListener("resize", apply);
    };
  }, [reduce]);

  /* Park the panel offscreen on mount so it can never flash at 0,0. */
  useEffect(() => {
    const el = panelRef.current;
    if (el) el.style.transform = "translate3d(-9999px, -9999px, 0) translateY(-50%)";
  }, []);

  /* Dismiss on window blur / tab hide. */
  useEffect(() => {
    const clear = () => {
      setHovered(-1);
      setFocused(-1);
    };
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", clear);
    return () => {
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", clear);
    };
  }, []);

  const setTargetFromPointer = useCallback((clientX, clientY) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = clientX + CURSOR_GAP;
    if (x + PANEL_W > vw - EDGE) x = clientX - CURSOR_GAP - PANEL_W;
    if (x < EDGE) x = EDGE;
    const half = PANEL_H / 2;
    let y = clientY;
    if (y < half + EDGE) y = half + EDGE;
    if (y > vh - half - EDGE) y = vh - half - EDGE;
    targetRef.current = { x, y };
  }, []);

  const handlePointerMove = useCallback(
    (event) => {
      if (!interactive) return;
      setTargetFromPointer(event.clientX, event.clientY);
    },
    [interactive, setTargetFromPointer]
  );

  const handlePointerLeave = useCallback(() => {
    setHovered(-1);
  }, []);

  /* Single rAF loop, alive only while a preview is showing. */
  useEffect(() => {
    if (!panelOn) {
      seededRef.current = false;
      return undefined;
    }
    const el = panelRef.current;
    if (!el) return undefined;

    if (!seededRef.current) {
      posRef.current = { ...targetRef.current };
      seededRef.current = true;
      el.style.transform = `translate3d(${posRef.current.x}px, ${posRef.current.y}px, 0) translateY(-50%)`;
    }

    let frame = requestAnimationFrame(function tick() {
      const pos = posRef.current;
      const target = targetRef.current;
      pos.x += (target.x - pos.x) * LERP;
      pos.y += (target.y - pos.y) * LERP;
      el.style.transform = `translate3d(${pos.x.toFixed(2)}px, ${pos.y.toFixed(
        2
      )}px, 0) translateY(-50%)`;
      frame = requestAnimationFrame(tick);
    });

    return () => cancelAnimationFrame(frame);
  }, [panelOn]);

  const labelTransition = reduce
    ? "none"
    : "color 0.3s ease, -webkit-text-stroke-color 0.3s ease, transform 0.3s ease, opacity 0.3s ease";

  const preview = rows[previewIndex] || rows[0];

  return (
    <section className={`relative w-full ${className}`}>
      <div className="mx-auto w-full max-w-5xl px-4">
        {heading ? (
          <h2 className="mb-6 font-mono text-[11px] uppercase tracking-[0.22em] text-cm-faint">
            {heading}
          </h2>
        ) : null}

        <ul
          className="list-none"
          onPointerMove={handlePointerMove}
          onPointerLeave={handlePointerLeave}
        >
          {rows.map((row, i) => {
            const on = activeIndex === i;
            const Wrapper = row.href ? Link : "div";
            const wrapperProps = row.href ? { href: row.href } : {};
            return (
              <li
                key={`${row.label}-${i}`}
                className={`border-t border-cm-border ${
                  i === rows.length - 1 ? "border-b" : ""
                }`}
              >
                <Wrapper
                  {...wrapperProps}
                  className={`grid w-full cursor-pointer grid-cols-1 items-baseline gap-2 px-5 py-9 outline-none transition-colors duration-[400ms] ease-out md:grid-cols-[1fr_220px] ${
                    on ? "bg-white/[0.016]" : "bg-transparent"
                  } focus-visible:ring-1 focus-visible:ring-cm-accent/50`}
                  onPointerEnter={(event) => {
                    setHovered(i);
                    setPreviewIndex(i);
                    if (interactive) setTargetFromPointer(event.clientX, event.clientY);
                  }}
                  onFocus={() => {
                    setFocused(i);
                    setPreviewIndex(i);
                  }}
                  onBlur={() => setFocused((prev) => (prev === i ? -1 : prev))}
                >
                  <span
                    className="block text-[clamp(1.5rem,3.4vw,2.75rem)] font-semibold uppercase leading-[1.05] tracking-[-0.02em] will-change-transform"
                    style={{
                      color: on
                        ? "var(--cm-accent)"
                        : strokeOk
                        ? "transparent"
                        : "var(--cm-text)",
                      WebkitTextStrokeWidth: strokeOk ? "1px" : "0",
                      WebkitTextStrokeColor:
                        on || !strokeOk ? "transparent" : "var(--cm-text)",
                      transform: on && !reduce ? "translateX(16px)" : "translateX(0px)",
                      transition: labelTransition,
                    }}
                  >
                    {row.label}
                  </span>

                  <span className="font-mono text-[13px] uppercase tracking-[0.04em] text-cm-muted md:text-right">
                    {row.meta}
                  </span>
                </Wrapper>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Single cursor-following preview panel. */}
      <div
        ref={panelRef}
        aria-hidden="true"
        className="pointer-events-none fixed left-0 top-0 z-50 aspect-[16/9] w-[420px] overflow-hidden rounded-lg border border-cm-border bg-cm-card"
        style={{
          opacity: panelOn ? 0.95 : 0,
          transition: "opacity 0.3s ease",
          willChange: "transform",
        }}
      >
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(120% 90% at 80% 0%, rgba(16, 185, 129, 0.12), transparent 70%)",
          }}
        />
        <div className="absolute inset-0 p-4">
          <PreviewVisual kind={preview?.viz} />
        </div>
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 border-t border-cm-border-subtle bg-cm-bg/70 px-4 py-2">
          <span className="truncate font-mono text-[11px] uppercase tracking-[0.18em] text-cm-accent">
            {preview?.label}
          </span>
          <span className="truncate font-mono text-[11px] tracking-[0.04em] text-cm-faint">
            {preview?.blurb || preview?.meta}
          </span>
        </div>
      </div>
    </section>
  );
}
