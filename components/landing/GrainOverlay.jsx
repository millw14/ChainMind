"use client";

import { useEffect, useId, useRef } from "react";
import { useReducedMotion } from "framer-motion";

/** Slack around the viewport so the shimmer offset never exposes a bare edge. */
const PAD = 8;

/**
 * Discrete jitter offsets, in CSS px, kept inside ±PAD. Real film grain moves in
 * whole-frame jumps rather than sliding, so the animation steps between these.
 */
const OFFSETS = [
  [0, 0],
  [-5, 3],
  [4, -4],
  [-3, -5],
  [5, 2],
  [-6, -1],
  [2, 5],
  [-1, -3],
];

/**
 * GrainOverlay — full-page film-grain / noise texture layered over dark UI.
 *
 * PERFORMANCE CONTRACT — read before changing anything here.
 * The noise is rasterised ONCE (a 128px tile, tiled across an oversized canvas)
 * and thereafter the element is never repainted: the shimmer is a CSS keyframe
 * animation that steps the canvas between a handful of sub-pixel-ish offsets, so
 * it is compositor-only. An earlier revision regenerated 16k random pixels and
 * re-filled the whole viewport canvas 24x a second, which meant a full-viewport
 * texture re-upload every 42ms underneath a `mix-blend-mode` layer — one of the
 * biggest fixed costs on the landing page. Do not put this back on a rAF loop.
 *
 * Being a CSS animation also means the browser throttles it for free in a hidden
 * tab, so there is no `visibilitychange` bookkeeping and no rAF to cancel.
 *
 * @param {Object} props
 * @param {number} [props.opacity=0.045] Overlay opacity applied to the canvas element.
 * @param {number} [props.fps=10] Grain jitter rate — how many discrete offset steps per second.
 * @param {boolean} [props.monochrome=true] Luminance-only grain when true, per-channel RGB noise when false.
 * @param {string} [props.blendMode="overlay"] CSS mix-blend-mode for the canvas.
 * @returns {JSX.Element} A fixed, non-interactive, aria-hidden canvas overlay.
 */
export default function GrainOverlay({
  opacity = 0.045,
  fps = 10,
  monochrome = true,
  blendMode = "overlay",
}) {
  const canvasRef = useRef(null);
  const reduce = useReducedMotion();

  const animName = `cm-grain-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const stepRate = Math.min(Math.max(Number(fps) || 10, 1), 24);
  const durationMs = Math.round((OFFSETS.length / stepRate) * 1000);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;

    // Small offscreen tile kept near device-pixel scale for crisp, fine grain.
    const TILE = 128;
    const tile = document.createElement("canvas");
    tile.width = TILE;
    tile.height = TILE;
    const tileCtx = tile.getContext("2d");
    if (!tileCtx) return undefined;

    const image = tileCtx.createImageData(TILE, TILE);
    const buf = image.data;
    for (let i = 0; i < buf.length; i += 4) {
      if (monochrome) {
        const v = (Math.random() * 255) | 0;
        buf[i] = v;
        buf[i + 1] = v;
        buf[i + 2] = v;
      } else {
        buf[i] = (Math.random() * 255) | 0;
        buf[i + 1] = (Math.random() * 255) | 0;
        buf[i + 2] = (Math.random() * 255) | 0;
      }
      buf[i + 3] = 255;
    }
    tileCtx.putImageData(image, 0, 0);

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Integer-ish upscale so the tile draws as a fine grain on the visible canvas.
    const scale = Math.max(1, Math.round(dpr));

    const pattern = ctx.createPattern(tile, "repeat");

    let lastW = -1;
    let lastH = -1;
    let pending = 0;

    const paint = () => {
      if (!pattern) return;
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.scale(scale, scale);
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, canvas.width / scale, canvas.height / scale);
      ctx.restore();
    };

    const resize = () => {
      const w = window.innerWidth + PAD * 2;
      const h = window.innerHeight + PAD * 2;
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      // Resizing the backing store clears it, so it always needs a repaint.
      paint();
    };

    // Coalesce resize storms (window drags) into at most one repaint per frame.
    const onResize = () => {
      if (pending) return;
      pending = window.requestAnimationFrame(() => {
        pending = 0;
        resize();
      });
    };

    resize();

    window.addEventListener("resize", onResize, { passive: true });
    window.addEventListener("orientationchange", onResize, { passive: true });

    // Backstop for the cases a window `resize` never covers: mounting inside a
    // container that has not been laid out yet (innerWidth still 0), or the page
    // becoming visible after the fact. It fires far more often than the viewport
    // actually changes — every document height change trips it — which is
    // exactly why `resize()` is a no-op unless the viewport box really moved.
    let ro = null;
    if (typeof ResizeObserver === "function") {
      ro = new ResizeObserver(onResize);
      ro.observe(document.documentElement);
    }

    return () => {
      if (pending) window.cancelAnimationFrame(pending);
      if (ro) ro.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, [monochrome]);

  // Explicit 100% mirrors 0% so the implicit final keyframe (the element's own
  // untransformed value) can never flash between the last step and the wrap.
  const steps = OFFSETS.concat([OFFSETS[0]])
    .map((offset, i) => {
      const at = ((i / OFFSETS.length) * 100).toFixed(4);
      return `${at}% { transform: translate3d(${offset[0]}px, ${offset[1]}px, 0); }`;
    })
    .join("\n        ");

  return (
    <>
      <style>{`
        @keyframes ${animName} {
        ${steps}
        }
        .${animName} {
          animation: ${animName} ${durationMs}ms step-end infinite;
          will-change: transform;
        }
        @media (prefers-reduced-motion: reduce) {
          .${animName} { animation: none; will-change: auto; }
        }
      `}</style>
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        // Static single frame under reduced motion — no class, no animation.
        className={`pointer-events-none fixed z-[60] ${reduce ? "" : animName}`}
        style={{
          top: -PAD,
          left: -PAD,
          opacity,
          mixBlendMode: blendMode,
        }}
      />
    </>
  );
}
