"use client";

import { useEffect, useRef } from "react";
import { useReducedMotion } from "framer-motion";

/**
 * HeroGridCanvas — decorative animated "on-chain data grid" background for the hero.
 * A perspective grid recedes toward a horizon, streaming toward the viewer, themed
 * Robinhood green, with a sweeping pulse band and drifting nodes near the horizon.
 * @param {{ speed?: number, density?: number, className?: string }} props
 *   speed (default 1) scales flow/pulse velocity; density (default 1) scales line count;
 *   className passes extra classes to the absolutely-positioned canvas.
 */
export default function HeroGridCanvas({ speed = 1, density = 1, className = "" }) {
  const canvasRef = useRef(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let dpr = 1;

    // Resolve theme colors from CSS vars (fallbacks match the design tokens).
    const styles = getComputedStyle(canvas);
    const cAccent = (styles.getPropertyValue("--cm-accent").trim() || "#10b981");
    const cBright = (styles.getPropertyValue("--cm-accent-bright").trim() || "#6ee7b7");

    const rgba = (hex, a) => {
      let h = hex.replace("#", "");
      if (h.length === 3) h = h.split("").map((c) => c + c).join("");
      const n = parseInt(h, 16);
      const r = (n >> 16) & 255;
      const g = (n >> 8) & 255;
      const b = n & 255;
      return `rgba(${r}, ${g}, ${b}, ${a})`;
    };

    // Drifting nodes near the horizon (seeded once).
    const nodeCount = Math.round(8 * Math.min(Math.max(density, 0.5), 2));
    const nodes = Array.from({ length: nodeCount }, () => ({
      x: Math.random(),
      y: Math.random(),
      vx: (Math.random() - 0.5) * 0.00006,
      vy: (Math.random() - 0.5) * 0.00004,
      r: 0.8 + Math.random() * 1.4,
      ph: Math.random() * Math.PI * 2,
    }));

    // Vanishing-point parallax (target follows pointer; eased toward).
    const px = { cur: 0, target: 0 };
    const py = { cur: 0, target: 0 };

    let scroll = 0; // horizontal-line flow phase (0..1)
    let pulse = 0; // pulse sweep phase (0..1, bottom->top)
    let raf = 0;
    let last = 0;
    let running = true;
    let visible = true;

    const resize = () => {
      const rect = parent.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = width + "px";
      canvas.style.height = height + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);

      const horizonY = height * 0.38;
      const vpBaseX = width * 0.5;
      // Eased parallax offset applied to the vanishing point.
      const vpX = vpBaseX + px.cur;
      const vpY = horizonY + py.cur;

      const bottom = height;
      const rows = Math.round(18 * Math.min(Math.max(density, 0.5), 2));
      const cols = Math.round(16 * Math.min(Math.max(density, 0.5), 2));

      // Perspective mapping: t in [0,1] from horizon(0) to bottom(1),
      // depth d compresses toward horizon so near-viewer rows are far apart.
      const depthAt = (t) => Math.pow(t, 2.4);

      // --- Horizontal lines (flowing toward viewer) ---
      for (let i = 0; i < rows; i++) {
        const base = (i + scroll) / rows; // 0..~1, animated
        const t = base % 1;
        if (t <= 0.0001) continue;
        const d = depthAt(t);
        const y = vpY + (bottom - vpY) * d;
        if (y < vpY || y > bottom) continue;

        // Fade in from horizon, fade out near the very top edge.
        const nearHorizon = 1 - t; // brighter close to horizon
        const alpha = 0.06 + nearHorizon * 0.32;
        const col = nearHorizon > 0.55 ? cBright : cAccent;

        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.strokeStyle = rgba(col, alpha);
        ctx.lineWidth = 0.5 + d * 1.1;
        ctx.stroke();
      }

      // --- Vertical lines (converging to vanishing point) ---
      for (let j = 0; j <= cols; j++) {
        const f = j / cols; // 0..1 across the bottom
        const xBottom = (f - 0.5) * width * 2 + width * 0.5;
        ctx.beginPath();
        ctx.moveTo(vpX, vpY);
        ctx.lineTo(xBottom, bottom);
        const edge = Math.abs(f - 0.5) * 2; // 0 center .. 1 edges
        const alpha = 0.05 + (1 - edge) * 0.14;
        ctx.strokeStyle = rgba(cAccent, alpha);
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }

      // --- Traveling pulse band (sweeps up the grid) ---
      if (!reduce) {
        const pt = 1 - pulse; // map phase to t so it moves horizon-ward
        const pd = depthAt(pt);
        const pyBand = vpY + (bottom - vpY) * pd;
        const bandH = 26 + pd * 40;
        const grad = ctx.createLinearGradient(0, pyBand - bandH, 0, pyBand + bandH);
        grad.addColorStop(0, rgba(cBright, 0));
        grad.addColorStop(0.5, rgba(cBright, 0.18 * (0.4 + pt * 0.6)));
        grad.addColorStop(1, rgba(cBright, 0));
        ctx.fillStyle = grad;
        ctx.fillRect(0, pyBand - bandH, width, bandH * 2);
      }

      // --- Drifting nodes + connecting lines near the horizon ---
      const bandTop = vpY - height * 0.06;
      const bandBot = vpY + height * 0.14;
      const nodePts = nodes.map((n) => ({
        x: n.x * width,
        y: bandTop + n.y * (bandBot - bandTop),
        r: n.r,
        ph: n.ph,
      }));

      ctx.lineWidth = 0.6;
      for (let a = 0; a < nodePts.length; a++) {
        for (let b = a + 1; b < nodePts.length; b++) {
          const dx = nodePts[a].x - nodePts[b].x;
          const dy = nodePts[a].y - nodePts[b].y;
          const dist = Math.hypot(dx, dy);
          if (dist < width * 0.16) {
            const al = (1 - dist / (width * 0.16)) * 0.14;
            ctx.beginPath();
            ctx.moveTo(nodePts[a].x, nodePts[a].y);
            ctx.lineTo(nodePts[b].x, nodePts[b].y);
            ctx.strokeStyle = rgba(cAccent, al);
            ctx.stroke();
          }
        }
      }
      for (let k = 0; k < nodePts.length; k++) {
        const np = nodePts[k];
        const tw = reduce ? 0.7 : 0.55 + Math.sin(np.ph) * 0.25;
        ctx.beginPath();
        ctx.arc(np.x, np.y, np.r, 0, Math.PI * 2);
        ctx.fillStyle = rgba(cBright, 0.5 * tw);
        ctx.fill();
      }

      // --- Top mask: fade the grid into the hero background ---
      const mask = ctx.createLinearGradient(0, 0, 0, height);
      const bg = (styles.getPropertyValue("--cm-bg").trim() || "#080a09");
      mask.addColorStop(0, rgba(bg, 1));
      mask.addColorStop(0.32, rgba(bg, 0.55));
      mask.addColorStop(0.5, rgba(bg, 0));
      // Keep composite simple: paint mask as a soft top fade.
      ctx.fillStyle = mask;
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillRect(0, 0, width, height * 0.5);
      ctx.globalCompositeOperation = "source-over";
    };

    const tick = (now) => {
      if (!running) return;
      raf = requestAnimationFrame(tick);
      const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
      last = now;

      const sp = Math.min(Math.max(speed, 0.1), 4);
      scroll = (scroll + dt * 0.12 * sp) % 1;
      pulse = (pulse + dt * 0.055 * sp) % 1;

      // Ease vanishing point toward pointer target.
      px.cur += (px.target - px.cur) * Math.min(dt * 4, 1);
      py.cur += (py.target - py.cur) * Math.min(dt * 4, 1);

      // Advance drifting nodes.
      for (const n of nodes) {
        n.x = (n.x + n.vx + 1) % 1;
        n.y = (n.y + n.vy + 1) % 1;
        n.ph += dt * 1.6;
      }

      draw();
    };

    const start = () => {
      if (reduce || raf || !running) return;
      last = 0;
      raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    const onPointerMove = (e) => {
      if (e.pointerType === "touch") return;
      const rect = parent.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / rect.width - 0.5;
      const ny = (e.clientY - rect.top) / rect.height - 0.5;
      px.target = nx * 14;
      py.target = ny * 8;
    };

    const onVisibility = () => {
      running = !document.hidden && visible;
      if (running) start();
      else stop();
    };

    const ro = new ResizeObserver(() => {
      resize();
      if (reduce || !running) draw();
    });
    ro.observe(parent);

    const io = new IntersectionObserver(
      (entries) => {
        visible = entries[0]?.isIntersecting ?? true;
        running = !document.hidden && visible;
        if (running) start();
        else stop();
      },
      { threshold: 0 }
    );
    io.observe(canvas);

    resize();

    if (reduce) {
      // Static single-frame render; no flow, pulse, or parallax.
      running = false;
      draw();
    } else {
      document.addEventListener("visibilitychange", onVisibility);
      parent.addEventListener("pointermove", onPointerMove);
      start();
    }

    return () => {
      running = false;
      stop();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      parent.removeEventListener("pointermove", onPointerMove);
    };
  }, [reduce, speed, density]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 h-full w-full ${className}`}
    />
  );
}
