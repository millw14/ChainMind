"use client";

import { useEffect, useMemo, useRef } from "react";
import { useReducedMotion } from "framer-motion";

/** Maximum pointer-driven displacement, in CSS pixels, on each axis. */
const MAX_SHIFT = 12;
/** Overscan so the translated lattice never exposes a bare edge. */
const OVERSCAN = MAX_SHIFT + 8;
/** Per-frame easing factor for the lerp; lower = softer, longer glide. */
const EASE = 0.085;

/**
 * DotGrid — a subtle dot-lattice texture for dark surfaces, drawn with a single
 * repeating CSS radial-gradient (no canvas, no DOM nodes per dot).
 *
 * Fills its nearest positioned ancestor by default; pass `className` with
 * `fixed` to pin it to the viewport instead. The lattice is painted on first
 * render and never depends on JavaScript to become visible — parallax only
 * mutates a transform on a ref, so pointer movement never re-renders React.
 *
 * @param {Object} props
 * @param {number} [props.gap=22] Lattice spacing in CSS pixels (both axes).
 * @param {number} [props.dotSize=1] Dot radius in CSS pixels.
 * @param {string} [props.color] Dot color; defaults to `rgba(255,255,255,0.10)`. Use `rgba(16,185,129,0.14)` for the accent variant.
 * @param {string} [props.className=""] Extra classes on the wrapper (e.g. `fixed`, `z-0`, opacity).
 * @param {boolean} [props.parallax=true] Ease the lattice a few px toward the pointer. Ignored for coarse pointers and reduced motion.
 * @param {boolean} [props.fade=true] Radially mask the lattice so it fades toward the edges.
 * @returns {JSX.Element} An absolutely positioned, non-interactive, aria-hidden layer.
 */
export default function DotGrid({
  gap = 22,
  dotSize = 1,
  color,
  className = "",
  parallax = true,
  fade = true,
}) {
  const layerRef = useRef(null);
  const reduceMotion = useReducedMotion();

  const safeGap = Math.max(4, Number(gap) || 22);
  const safeDot = Math.max(0.5, Number(dotSize) || 1);
  const dotColor = color || "rgba(255,255,255,0.10)";

  const layerStyle = useMemo(() => {
    // A hair of feather on the outer stop keeps the dots from aliasing into squares.
    const image = `radial-gradient(circle, ${dotColor} ${safeDot}px, transparent ${safeDot + 0.5}px)`;
    return {
      position: "absolute",
      top: -OVERSCAN,
      right: -OVERSCAN,
      bottom: -OVERSCAN,
      left: -OVERSCAN,
      backgroundImage: image,
      backgroundSize: `${safeGap}px ${safeGap}px`,
      backgroundPosition: "0 0",
      backgroundRepeat: "repeat",
      transform: "translate3d(0, 0, 0)",
    };
  }, [dotColor, safeDot, safeGap]);

  const wrapperStyle = useMemo(() => {
    if (!fade) return undefined;
    const mask =
      "radial-gradient(ellipse 78% 72% at 50% 42%, #000 0%, rgba(0,0,0,0.72) 46%, rgba(0,0,0,0.18) 78%, transparent 100%)";
    return { maskImage: mask, WebkitMaskImage: mask };
  }, [fade]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || !parallax || reduceMotion) return;
    if (typeof window === "undefined") return;

    const coarse =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches;
    if (coarse) return;

    let raf = 0;
    let targetX = 0;
    let targetY = 0;
    let currentX = 0;
    let currentY = 0;

    const apply = () => {
      layer.style.transform = `translate3d(${currentX.toFixed(2)}px, ${currentY.toFixed(2)}px, 0)`;
    };

    const stop = () => {
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
    };

    const tick = () => {
      const dx = targetX - currentX;
      const dy = targetY - currentY;

      if (Math.abs(dx) < 0.02 && Math.abs(dy) < 0.02) {
        currentX = targetX;
        currentY = targetY;
        apply();
        raf = 0; // Settled — idle until the pointer moves again.
        return;
      }

      currentX += dx * EASE;
      currentY += dy * EASE;
      apply();
      raf = window.requestAnimationFrame(tick);
    };

    const start = () => {
      if (!raf && !document.hidden) raf = window.requestAnimationFrame(tick);
    };

    const onPointerMove = (event) => {
      // Fine pointers only; a stylus/touch contact should not drive the lattice.
      if (event.pointerType && event.pointerType !== "mouse") return;
      const w = window.innerWidth || 1;
      const h = window.innerHeight || 1;
      // -1..1 from viewport center, then damped to the max shift.
      targetX = ((event.clientX / w) * 2 - 1) * MAX_SHIFT;
      targetY = ((event.clientY / h) * 2 - 1) * MAX_SHIFT;
      start();
    };

    const onPointerOut = (event) => {
      if (event.relatedTarget) return; // Still inside the document.
      targetX = 0;
      targetY = 0;
      start();
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    layer.style.willChange = "transform";
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("blur", onPointerOut);
    document.addEventListener("pointerout", onPointerOut, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("blur", onPointerOut);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("visibilitychange", onVisibility);
      // Leave the lattice centered and cheap for the next mount.
      layer.style.willChange = "";
      layer.style.transform = "translate3d(0, 0, 0)";
    };
  }, [parallax, reduceMotion]);

  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}
      style={wrapperStyle}
    >
      <div ref={layerRef} style={layerStyle} />
    </div>
  );
}
