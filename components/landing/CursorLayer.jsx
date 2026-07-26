"use client";

import { useEffect, useRef, useState } from "react";

/** Fallback ambient cursor used when no `bots` prop is supplied. */
const DEFAULT_BOTS = [{ label: "ChainMind AI", color: "var(--cm-accent-bright)" }];

/** Keeps wandering bots away from the very edge of the viewport (0..1). */
const EDGE_PAD = 0.05;

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/**
 * Arrow glyph — roughly 14x18, drawn from scratch so it reads as a
 * classic collaborative-tool pointer.
 */
function Arrow({ color }) {
  return (
    <svg
      width="14"
      height="18"
      viewBox="0 0 14 18"
      fill="none"
      focusable="false"
      style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.55))" }}
    >
      <path
        d="M1.2 0.9 L1.2 15.4 L4.9 12.1 L7.2 17.2 L9.6 16.1 L7.3 11.2 L12.3 10.9 Z"
        fill={color}
        stroke="var(--cm-bg)"
        strokeWidth="0.9"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * CursorLayer — a fixed, non-interactive overlay that renders ambient
 * "multiplayer" bot cursors wandering the viewport along summed-sine paths,
 * in the style of a collaborative design tool.
 *
 * DELIBERATELY NO USER CURSOR. An earlier revision hid the OS pointer
 * (`document.body.style.cursor = "none"`) and drew a lerped replacement in its
 * place. Because the drawn glyph only closes a fraction of the gap per frame it
 * always trailed the real pointer, so visitors aimed at the arrow they could
 * see while the actual hit point sat somewhere ahead of it — every click near a
 * small target became a near-miss. Pointing accuracy beats decoration, so the
 * native cursor is never touched and the visitor's own glyph and "You" label
 * are gone outright. A "soft glow instead of an arrow" variant was considered
 * and rejected: anything that tracks the pointer still reads as a thing to aim
 * with, which is exactly the failure mode. The bots stay — they drift on their
 * own schedule, are never aimed with, and carry the multiplayer feel by
 * themselves.
 *
 * All per-frame movement is written straight to DOM refs inside a single
 * shared requestAnimationFrame loop — no React state is touched while
 * animating. The layer renders nothing at all for coarse pointers or when the
 * visitor prefers reduced motion.
 *
 * @param {Object} props
 * @param {Array<{label: string, color: string}>} [props.bots] Ambient cursors (max 2).
 * @param {boolean} [props.enabled=true] Master switch; when false nothing renders.
 * @returns {JSX.Element|null} The cursor overlay, or null when inactive.
 */
export default function CursorLayer({ bots, enabled = true }) {
  const [active, setActive] = useState(false);

  const botRefs = useRef([]);

  const botList = (Array.isArray(bots) && bots.length > 0 ? bots : DEFAULT_BOTS).slice(0, 2);
  const botCount = botList.length;

  // Decide whether this environment should get animated cursors at all.
  useEffect(() => {
    if (!enabled || typeof window === "undefined" || !window.matchMedia) {
      setActive(false);
      return undefined;
    }

    const reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const coarseQuery = window.matchMedia("(pointer: coarse)");

    let alive = true;
    const evaluate = () => {
      if (!alive) return;
      setActive(!reduceQuery.matches && !coarseQuery.matches);
    };

    evaluate();

    const attach = (query) => {
      if (query.addEventListener) {
        query.addEventListener("change", evaluate);
        return () => query.removeEventListener("change", evaluate);
      }
      query.addListener(evaluate);
      return () => query.removeListener(evaluate);
    };

    const detachReduce = attach(reduceQuery);
    const detachCoarse = attach(coarseQuery);

    return () => {
      alive = false;
      detachReduce();
      detachCoarse();
      setActive(false);
    };
  }, [enabled]);

  // The one shared animation loop. No pointer listener: nothing here follows
  // the mouse any more, so the layer costs one rAF and nothing else.
  useEffect(() => {
    if (!active || typeof window === "undefined") return undefined;

    const botEls = botRefs.current.slice(0, botCount);

    let frame = 0;
    let lastTs = 0;
    let clock = 0; // seconds of "visible" time, so hidden tabs never jump

    let viewW = window.innerWidth;
    let viewH = window.innerHeight;

    const handleResize = () => {
      viewW = window.innerWidth;
      viewH = window.innerHeight;
    };

    const step = (ts) => {
      if (!lastTs) lastTs = ts;
      const deltaMs = Math.min(ts - lastTs, 100);
      lastTs = ts;
      clock += deltaMs / 1000;

      for (let i = 0; i < botEls.length; i += 1) {
        const el = botEls[i];
        if (!el) continue;
        const phase = 1.7 + i * 2.9;

        const nx =
          0.5 +
          0.27 * Math.sin(clock * 0.13 + phase) +
          0.13 * Math.sin(clock * 0.29 + phase * 1.7) +
          0.06 * Math.sin(clock * 0.57 + phase * 2.3);
        const ny =
          0.5 +
          0.25 * Math.sin(clock * 0.17 + phase * 1.3) +
          0.12 * Math.sin(clock * 0.23 + phase * 0.7) +
          0.05 * Math.sin(clock * 0.61 + phase * 3.1);

        const bx = clamp(nx, EDGE_PAD, 1 - EDGE_PAD) * viewW;
        const by = clamp(ny, EDGE_PAD, 1 - EDGE_PAD) * viewH;

        el.style.transform =
          "translate3d(" + bx.toFixed(2) + "px, " + by.toFixed(2) + "px, 0)";
      }

      frame = window.requestAnimationFrame(step);
    };

    const start = () => {
      if (frame) return;
      lastTs = 0;
      frame = window.requestAnimationFrame(step);
    };

    const stop = () => {
      if (!frame) return;
      window.cancelAnimationFrame(frame);
      frame = 0;
    };

    const handleVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    window.addEventListener("resize", handleResize, { passive: true });
    document.addEventListener("visibilitychange", handleVisibility);

    if (!document.hidden) start();

    return () => {
      stop();
      window.removeEventListener("resize", handleResize);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [active, botCount]);

  if (!active) return null;

  const centerX = typeof window === "undefined" ? 0 : window.innerWidth / 2;
  const centerY = typeof window === "undefined" ? 0 : window.innerHeight / 2;

  return (
    // z-[62] sits above the grain film (z-[60]) but below the command pill
    // (z-[65]) and the ask overlay (z-[8000]), so a drifting bot can never draw
    // over interactive chrome. `pointer-events-none` on the root means nothing
    // inside it can intercept a click regardless.
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-[62] overflow-hidden">
      {botList.map((bot, index) => (
        <div
          key={(bot && bot.label ? bot.label : "bot") + "-" + index}
          ref={(el) => {
            botRefs.current[index] = el;
          }}
          className="pointer-events-none absolute left-0 top-0 flex items-start gap-1 will-change-transform"
          style={{
            transform: "translate3d(" + centerX + "px, " + centerY + "px, 0)",
            opacity: 0.85,
          }}
        >
          <Arrow color={(bot && bot.color) || "var(--cm-accent-bright)"} />
          <span
            className="mt-2 whitespace-nowrap rounded-md px-2 py-0.5 font-mono text-[10px] leading-none"
            style={{
              backgroundColor: (bot && bot.color) || "var(--cm-accent-bright)",
              color: "var(--cm-on-accent)",
            }}
          >
            {(bot && bot.label) || "ChainMind AI"}
          </span>
        </div>
      ))}
    </div>
  );
}
