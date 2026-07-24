"use client";

import { useEffect, useRef } from "react";
import { useReducedMotion } from "framer-motion";

/**
 * GrainOverlay — full-page animated film-grain / noise texture layered over dark UI.
 * @param {Object} props
 * @param {number} [props.opacity=0.045] Overlay opacity applied to the canvas element.
 * @param {number} [props.fps=24] Grain regeneration rate; the rAF loop is throttled to this.
 * @param {boolean} [props.monochrome=true] Luminance-only grain when true, per-channel RGB noise when false.
 * @param {string} [props.blendMode="overlay"] CSS mix-blend-mode for the canvas.
 * @returns {JSX.Element} A fixed, non-interactive, aria-hidden canvas overlay.
 */
export default function GrainOverlay({
  opacity = 0.045,
  fps = 24,
  monochrome = true,
  blendMode = "overlay",
}) {
  const canvasRef = useRef(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Small offscreen tile kept near device-pixel scale for crisp, fine grain.
    const TILE = 128;
    const tile = document.createElement("canvas");
    tile.width = TILE;
    tile.height = TILE;
    const tileCtx = tile.getContext("2d");
    const image = tileCtx.createImageData(TILE, TILE);
    const buf = image.data;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Integer-ish upscale so the tile draws as a fine grain on the visible canvas.
    const scale = Math.max(1, Math.round(dpr));

    let raf = 0;
    let last = 0;
    const interval = 1000 / Math.max(1, fps);

    const generateTile = () => {
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
    };

    const paint = () => {
      const pattern = ctx.createPattern(tile, "repeat");
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
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      // Static overlays need an immediate repaint after a resize clears the buffer.
      if (reduce) {
        generateTile();
        paint();
      }
    };

    resize();

    const ro = new ResizeObserver(resize);
    ro.observe(document.documentElement);

    if (reduce) {
      // Single static frame — no animation loop.
      generateTile();
      paint();
      return () => ro.disconnect();
    }

    const loop = (t) => {
      raf = window.requestAnimationFrame(loop);
      if (t - last < interval) return;
      last = t;
      generateTile();
      paint();
    };

    const onVisibility = () => {
      if (document.hidden) {
        if (raf) window.cancelAnimationFrame(raf);
        raf = 0;
      } else if (!raf) {
        last = 0;
        raf = window.requestAnimationFrame(loop);
      }
    };

    raf = window.requestAnimationFrame(loop);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
      ro.disconnect();
    };
  }, [opacity, fps, monochrome, blendMode, reduce]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[60]"
      style={{ opacity, mixBlendMode: blendMode }}
    />
  );
}
