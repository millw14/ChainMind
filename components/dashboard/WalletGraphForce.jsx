"use client";

import { useEffect, useRef, useState, useCallback } from "react";

export function WalletGraphForce({ graph, onNodeClick }) {
  const canvasRef = useRef(null);
  const animRef = useRef(null);
  const angleRef = useRef(0);
  const blipsRef = useRef([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const drawFrame = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width;
    const H = canvas.height;
    if (W === 0 || H === 0) return;
    const cx = W / 2;
    const cy = H / 2;
    const maxR = Math.min(cx, cy) - 24;

    // Fade trail
    ctx.fillStyle = "rgba(8,6,18,0.2)";
    ctx.fillRect(0, 0, W, H);

    // Grid rings
    [0.25, 0.5, 0.75, 1.0].forEach((r, i) => {
      ctx.beginPath();
      ctx.arc(cx, cy, maxR * r, 0, Math.PI * 2);
      ctx.strokeStyle = i === 3 ? "rgba(139,92,246,0.2)" : "rgba(139,92,246,0.1)";
      ctx.lineWidth = i === 3 ? 1.5 : 1;
      ctx.stroke();
    });

    // Crosshairs
    ctx.strokeStyle = "rgba(139,92,246,0.07)";
    ctx.lineWidth = 1;
    [[cx, cy - maxR, cx, cy + maxR], [cx - maxR, cy, cx + maxR, cy]].forEach(([x1, y1, x2, y2]) => {
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    });
    const d = maxR * 0.707;
    [[cx-d,cy-d,cx+d,cy+d],[cx+d,cy-d,cx-d,cy+d]].forEach(([x1,y1,x2,y2]) => {
      ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    });

    // Sweep
    const sweep = angleRef.current;
    const sweepLen = Math.PI * 0.55;
    for (let s = 0; s < 50; s++) {
      const a = sweep - (s / 50) * sweepLen;
      const alpha = (1 - s / 50) * 0.3;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * maxR, cy + Math.sin(a) * maxR);
      ctx.strokeStyle = `rgba(139,92,246,${alpha})`;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    // Leading edge
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(sweep) * maxR, cy + Math.sin(sweep) * maxR);
    ctx.strokeStyle = "rgba(216,180,254,0.95)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Blips
    const now = Date.now();
    blipsRef.current.forEach((b) => {
      const bx = cx + Math.cos(b.angle) * (maxR * b.distRatio);
      const by = cy + Math.sin(b.angle) * (maxR * b.distRatio);

      // Hit detection
      const ns = ((sweep % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      const nb = ((b.angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      const diff = Math.abs(ns - nb);
      if (diff < 0.07 || diff > Math.PI * 2 - 0.07) b.lastHit = now;

      const age = now - b.lastHit;
      const hit = Math.max(0, 1 - age / 2200);
      const color = b.isHot ? "239,68,68" : b.isMid ? "249,115,22" : "139,92,246";

      // Glow on hit
      if (hit > 0.05) {
        const g = ctx.createRadialGradient(bx, by, 0, bx, by, b.size + hit * 14);
        g.addColorStop(0, `rgba(${color},${hit * 0.85})`);
        g.addColorStop(1, `rgba(${color},0)`);
        ctx.beginPath();
        ctx.arc(bx, by, b.size + hit * 14, 0, Math.PI * 2);
        ctx.fillStyle = g;
        ctx.fill();
      }

      // Core blip
      ctx.beginPath();
      ctx.arc(bx, by, b.size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${color},${0.35 + hit * 0.65})`;
      ctx.fill();

      // Label on hit
      if (hit > 0.25) {
        ctx.font = "7px monospace";
        ctx.fillStyle = `rgba(196,181,253,${hit * 0.9})`;
        ctx.fillText(b.label, bx + b.size + 3, by + 3);
      }
    });

    // Center node
    ctx.beginPath();
    ctx.arc(cx, cy, 18, 0, Math.PI * 2);
    const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, 18);
    cg.addColorStop(0, "#a78bfa");
    cg.addColorStop(1, "#7c3aed");
    ctx.fillStyle = cg;
    ctx.fill();
    ctx.strokeStyle = "rgba(196,181,253,0.6)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.font = "bold 7px monospace";
    ctx.fillStyle = "white";
    ctx.textAlign = "center";
    ctx.fillText("SCOPE", cx, cy + 3);
    ctx.textAlign = "left";

    // Ring labels
    ctx.font = "7px monospace";
    ctx.fillStyle = "rgba(139,92,246,0.45)";
    ctx.fillText("HIGH", cx + 4, cy - maxR * 0.22);
    ctx.fillText("MED", cx + 4, cy - maxR * 0.47);
    ctx.fillText("LOW", cx + 4, cy - maxR * 0.72);

    angleRef.current += 0.013;
    animRef.current = requestAnimationFrame(drawFrame);
  };

  // Build blips from graph data
  useEffect(() => {
    if (!graph?.nodes?.length) return;
    const nodes = graph.nodes.filter((n) => n.kind !== "scope");
    const maxEvents = Math.max(1, ...nodes.map((n) => n.eventCount ?? 1));
    blipsRef.current = nodes.map((n, i) => {
      const eventRatio = (n.eventCount ?? 1) / maxEvents;
      const distRatio = 0.15 + (1 - eventRatio) * 0.72;
      const angle = (2 * Math.PI * i) / Math.max(nodes.length, 1) + (i % 2 === 0 ? 0.15 : -0.15);
      return {
        id: n.id,
        label: n.id ? `${n.id.slice(0, 4)}…${n.id.slice(-3)}` : "",
        distRatio,
        angle,
        eventCount: n.eventCount ?? 1,
        isHot: eventRatio > 0.5,
        isMid: eventRatio > 0.25 && eventRatio <= 0.5,
        size: 2.5 + eventRatio * 4.5,
        lastHit: -9999,
      };
    });
  }, [graph]);

  useEffect(() => {
    if (!mounted) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const init = () => {
      const W = canvas.parentElement?.clientWidth || 340;
      const size = Math.min(W, 380);
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#080612";
      ctx.fillRect(0, 0, size, size);
    };

    init();
    if (animRef.current) cancelAnimationFrame(animRef.current);
    animRef.current = requestAnimationFrame(drawFrame);

    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  const handleClick = useCallback((e) => {
    if (!onNodeClick || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const scaleX = canvasRef.current.width / rect.width;
    const scaleY = canvasRef.current.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;
    const W = canvasRef.current.width;
    const H = canvasRef.current.height;
    const cx = W / 2;
    const cy = H / 2;
    const maxR = Math.min(cx, cy) - 24;

    for (const b of blipsRef.current) {
      const bx = cx + Math.cos(b.angle) * (maxR * b.distRatio);
      const by = cy + Math.sin(b.angle) * (maxR * b.distRatio);
      if (Math.sqrt((mx - bx) ** 2 + (my - by) ** 2) < 14) {
        onNodeClick(b.id);
        return;
      }
    }
  }, [onNodeClick]);

  if (!mounted) {
    return <div style={{ height: 340, background: "#080612", borderRadius: 6 }} />;
  }

  if (!graph?.nodes?.filter((n) => n.kind !== "scope").length) {
    return (
      <div className="flex h-[340px] items-center justify-center rounded-md border border-dashed border-cm-border px-4 text-center text-sm text-cm-faint">
        Load activity to render threat radar.
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-md border border-cm-border" style={{ background: "#080612" }}>
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        style={{ display: "block", width: "100%", cursor: "crosshair" }}
      />
      <div className="absolute bottom-2 left-2 right-2 flex justify-between font-mono" style={{ fontSize: 8, color: "rgba(139,92,246,0.5)" }}>
        <div style={{ display: "flex", gap: 10 }}>
          <span>● high risk</span>
          <span style={{ color: "rgba(249,115,22,0.6)" }}>● mid</span>
          <span style={{ color: "rgba(139,92,246,0.5)" }}>● low</span>
        </div>
        <span>click blip to scan</span>
      </div>
    </div>
  );
}
