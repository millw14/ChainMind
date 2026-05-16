"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Threat Radar — wallets as blips on a rotating scanner.
 * High-event wallets appear closer to center (higher threat).
 * Scanner line rotates continuously.
 */
export function WalletGraphForce({ graph, onNodeClick }) {
  const canvasRef = useRef(null);
  const animRef = useRef(null);
  const angleRef = useRef(0);
  const blipsRef = useRef([]);
  const trailsRef = useRef([]);

  const buildBlips = useCallback(() => {
    if (!graph?.nodes?.length) return [];
    const nodes = graph.nodes.filter((n) => n.kind !== "scope");
    const maxEvents = Math.max(1, ...nodes.map((n) => n.eventCount ?? 1));

    return nodes.map((n, i) => {
      const eventRatio = (n.eventCount ?? 1) / maxEvents;
      // High activity = closer to center (more threatening)
      const distRatio = 0.2 + (1 - eventRatio) * 0.7;
      // Spread around the radar
      const angle = (2 * Math.PI * i) / nodes.length + Math.random() * 0.3;
      const isHot = eventRatio > 0.5;
      const isMid = eventRatio > 0.25;
      return {
        id: n.id,
        label: n.id ? `${n.id.slice(0, 4)}…${n.id.slice(-3)}` : "",
        distRatio,
        angle,
        eventCount: n.eventCount ?? 1,
        isHot,
        isMid,
        size: 2 + eventRatio * 4,
        // Track when scanner passes over this blip
        lastHit: -999,
      };
    });
  }, [graph]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width;
    const H = canvas.height;
    const cx = W / 2;
    const cy = H / 2;
    const maxR = Math.min(cx, cy) - 20;

    // Background — dark with fade trail
    ctx.fillStyle = "rgba(8, 6, 18, 0.18)";
    ctx.fillRect(0, 0, W, H);

    // Grid rings
    const rings = [0.25, 0.5, 0.75, 1.0];
    rings.forEach((r) => {
      ctx.beginPath();
      ctx.arc(cx, cy, maxR * r, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(139,92,246,0.12)";
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    // Cross hairs
    ctx.strokeStyle = "rgba(139,92,246,0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy - maxR);
    ctx.lineTo(cx, cy + maxR);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - maxR, cy);
    ctx.lineTo(cx + maxR, cy);
    ctx.stroke();

    // Diagonal cross hairs
    const d = maxR * 0.707;
    ctx.beginPath();
    ctx.moveTo(cx - d, cy - d);
    ctx.lineTo(cx + d, cy + d);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + d, cy - d);
    ctx.lineTo(cx - d, cy + d);
    ctx.stroke();

    // Scanner sweep — gradient arc
    const sweepAngle = angleRef.current;
    const sweepLen = Math.PI * 0.6;
    const grad = ctx.createConicalGradient
      ? null // not widely supported
      : null;

    // Draw sweep as multiple lines for gradient effect
    const steps = 40;
    for (let s = 0; s < steps; s++) {
      const a = sweepAngle - (s / steps) * sweepLen;
      const alpha = (1 - s / steps) * 0.35;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * maxR, cy + Math.sin(a) * maxR);
      ctx.strokeStyle = `rgba(139,92,246,${alpha})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Scanner leading edge
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(sweepAngle) * maxR, cy + Math.sin(sweepAngle) * maxR);
    ctx.strokeStyle = "rgba(196,181,253,0.9)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Center dot
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#8b5cf6";
    ctx.fill();

    // Blips
    blipsRef.current.forEach((b) => {
      const bx = cx + Math.cos(b.angle) * (maxR * b.distRatio);
      const by = cy + Math.sin(b.angle) * (maxR * b.distRatio);

      // Check if scanner just passed over this blip
      const normalizedSweep = ((sweepAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      const normalizedBlip = ((b.angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      const diff = Math.abs(normalizedSweep - normalizedBlip);
      if (diff < 0.08 || diff > Math.PI * 2 - 0.08) {
        b.lastHit = Date.now();
      }

      const timeSinceHit = Date.now() - b.lastHit;
      const hitAlpha = Math.max(0, 1 - timeSinceHit / 2000);

      // Blip glow when scanner hits
      if (hitAlpha > 0) {
        const glowR = b.size + hitAlpha * 12;
        const glowGrad = ctx.createRadialGradient(bx, by, 0, bx, by, glowR);
        const color = b.isHot ? "239,68,68" : b.isMid ? "249,115,22" : "139,92,246";
        glowGrad.addColorStop(0, `rgba(${color},${hitAlpha * 0.9})`);
        glowGrad.addColorStop(1, `rgba(${color},0)`);
        ctx.beginPath();
        ctx.arc(bx, by, glowR, 0, Math.PI * 2);
        ctx.fillStyle = glowGrad;
        ctx.fill();
      }

      // Blip core — always visible but dim
      const baseAlpha = 0.3 + hitAlpha * 0.7;
      ctx.beginPath();
      ctx.arc(bx, by, b.size, 0, Math.PI * 2);
      ctx.fillStyle = b.isHot
        ? `rgba(239,68,68,${baseAlpha})`
        : b.isMid
          ? `rgba(249,115,22,${baseAlpha})`
          : `rgba(139,92,246,${baseAlpha})`;
      ctx.fill();

      // Label on hit
      if (hitAlpha > 0.3) {
        ctx.font = "7px monospace";
        ctx.fillStyle = `rgba(196,181,253,${hitAlpha})`;
        ctx.fillText(b.label, bx + b.size + 3, by + 3);
      }
    });

    // SCOPE label at center
    ctx.font = "bold 8px monospace";
    ctx.fillStyle = "rgba(196,181,253,0.7)";
    ctx.textAlign = "center";
    ctx.fillText("SCOPE", cx, cy + 16);
    ctx.textAlign = "left";

    // Ring labels
    ctx.font = "7px monospace";
    ctx.fillStyle = "rgba(139,92,246,0.4)";
    ctx.fillText("HIGH", cx + 4, cy - maxR * 0.25 + 3);
    ctx.fillText("MED", cx + 4, cy - maxR * 0.5 + 3);
    ctx.fillText("LOW", cx + 4, cy - maxR * 0.75 + 3);
  }, []);

  const tick = useCallback(() => {
    angleRef.current += 0.012; // rotation speed
    draw();
    animRef.current = requestAnimationFrame(tick);
  }, [draw]);

  useEffect(() => {
    blipsRef.current = buildBlips();
  }, [buildBlips]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const container = canvas.parentElement;
    const size = Math.min(container?.clientWidth || 340, 340);
    canvas.width = size;
    canvas.height = size;

    // Fill background once
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#080612";
    ctx.fillRect(0, 0, size, size);

    animRef.current = requestAnimationFrame(tick);
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [tick]);

  // Click handler
  const handleClick = useCallback(
    (e) => {
      if (!onNodeClick || !canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const W = canvasRef.current.width;
      const H = canvasRef.current.height;
      const cx = W / 2;
      const cy = H / 2;
      const maxR = Math.min(cx, cy) - 20;

      for (const b of blipsRef.current) {
        const bx = cx + Math.cos(b.angle) * (maxR * b.distRatio);
        const by = cy + Math.sin(b.angle) * (maxR * b.distRatio);
        const dist = Math.sqrt((mx - bx) ** 2 + (my - by) ** 2);
        if (dist < 12) {
          onNodeClick(b.id);
          return;
        }
      }
    },
    [onNodeClick],
  );

  if (!graph?.nodes?.filter((n) => n.kind !== "scope").length) {
    return (
      <div className="flex h-[340px] items-center justify-center rounded-md border border-dashed border-cm-border px-4 text-center text-sm text-cm-faint">
        Load activity to render threat radar.
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-md border border-cm-border bg-[#080612]">
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        style={{ display: "block", width: "100%", cursor: "crosshair" }}
      />
      <div className="absolute bottom-2 left-2 right-2 flex justify-between font-mono text-[8px] text-cm-faint/60">
        <div className="flex gap-3">
          <span className="flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500" /> high risk
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-orange-500" /> mid
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-purple-600" /> low
          </span>
        </div>
        <span>click blip to investigate</span>
      </div>
    </div>
  );
}
