"use client";

import { useEffect, useRef, useState } from "react";

export function WalletGraphForce({ graph, onNodeClick }) {
  const canvasRef = useRef(null);
  const stateRef = useRef({ angle: 0, blips: [], animId: null });
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Size the canvas
    const W = Math.min(canvas.parentElement?.clientWidth || 340, 380);
    canvas.width = W;
    canvas.height = W;

    // Build blips
    const nodes = (graph?.nodes || []).filter(n => n.kind !== "scope");
    const maxEv = Math.max(1, ...nodes.map(n => n.eventCount || 1));
    stateRef.current.blips = nodes.map((n, i) => {
      const ratio = (n.eventCount || 1) / maxEv;
      return {
        id: n.id,
        label: n.id ? `${n.id.slice(0,4)}…${n.id.slice(-3)}` : "",
        dist: 0.15 + (1 - ratio) * 0.72,
        angle: (2 * Math.PI * i) / Math.max(nodes.length, 1),
        size: 2.5 + ratio * 4.5,
        isHot: ratio > 0.5,
        isMid: ratio > 0.25,
        lastHit: -9999,
      };
    });

    // Initial fill
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#080612";
    ctx.fillRect(0, 0, W, W);

    // Animation loop
    const tick = () => {
      const s = stateRef.current;
      const ctx = canvas.getContext("2d");
      const W = canvas.width;
      const cx = W / 2;
      const cy = W / 2;
      const maxR = cx - 24;

      ctx.fillStyle = "rgba(8,6,18,0.18)";
      ctx.fillRect(0, 0, W, W);

      // Rings
      [0.25, 0.5, 0.75, 1].forEach((r, i) => {
        ctx.beginPath();
        ctx.arc(cx, cy, maxR * r, 0, Math.PI * 2);
        ctx.strokeStyle = i === 3 ? "rgba(139,92,246,0.22)" : "rgba(139,92,246,0.09)";
        ctx.lineWidth = 1;
        ctx.stroke();
      });

      // Cross
      ctx.strokeStyle = "rgba(139,92,246,0.07)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, cy-maxR); ctx.lineTo(cx, cy+maxR); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx-maxR, cy); ctx.lineTo(cx+maxR, cy); ctx.stroke();

      // Sweep trail
      for (let i = 0; i < 48; i++) {
        const a = s.angle - (i / 48) * Math.PI * 0.55;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * maxR, cy + Math.sin(a) * maxR);
        ctx.strokeStyle = `rgba(139,92,246,${(1 - i/48) * 0.28})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      // Leading edge
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(s.angle) * maxR, cy + Math.sin(s.angle) * maxR);
      ctx.strokeStyle = "rgba(216,180,254,0.9)";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Blips
      const now = Date.now();
      s.blips.forEach(b => {
        const bx = cx + Math.cos(b.angle) * (maxR * b.dist);
        const by = cy + Math.sin(b.angle) * (maxR * b.dist);

        // Hit check
        const ns = ((s.angle % (Math.PI*2)) + Math.PI*2) % (Math.PI*2);
        const nb = ((b.angle % (Math.PI*2)) + Math.PI*2) % (Math.PI*2);
        const diff = Math.abs(ns - nb);
        if (diff < 0.08 || diff > Math.PI*2 - 0.08) b.lastHit = now;

        const hit = Math.max(0, 1 - (now - b.lastHit) / 2200);
        const col = b.isHot ? "239,68,68" : b.isMid ? "249,115,22" : "139,92,246";

        if (hit > 0.05) {
          const g = ctx.createRadialGradient(bx, by, 0, bx, by, b.size + hit*14);
          g.addColorStop(0, `rgba(${col},${hit*0.8})`);
          g.addColorStop(1, `rgba(${col},0)`);
          ctx.beginPath();
          ctx.arc(bx, by, b.size + hit*14, 0, Math.PI*2);
          ctx.fillStyle = g;
          ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(bx, by, b.size, 0, Math.PI*2);
        ctx.fillStyle = `rgba(${col},${0.3 + hit*0.7})`;
        ctx.fill();

        if (hit > 0.2) {
          ctx.font = "7px monospace";
          ctx.fillStyle = `rgba(196,181,253,${hit})`;
          ctx.fillText(b.label, bx + b.size + 3, by + 3);
        }
      });

      // Center
      ctx.beginPath();
      ctx.arc(cx, cy, 18, 0, Math.PI*2);
      const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, 18);
      cg.addColorStop(0, "#a78bfa");
      cg.addColorStop(1, "#7c3aed");
      ctx.fillStyle = cg;
      ctx.fill();
      ctx.strokeStyle = "rgba(196,181,253,0.5)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.font = "bold 7px monospace";
      ctx.fillStyle = "white";
      ctx.textAlign = "center";
      ctx.fillText("SCOPE", cx, cy + 3);
      ctx.textAlign = "left";

      // Labels
      ctx.font = "7px monospace";
      ctx.fillStyle = "rgba(139,92,246,0.4)";
      ctx.fillText("HIGH", cx+4, cy - maxR*0.22);
      ctx.fillText("MED",  cx+4, cy - maxR*0.47);
      ctx.fillText("LOW",  cx+4, cy - maxR*0.72);

      s.angle += 0.013;
      s.animId = requestAnimationFrame(tick);
    };

    tick();

    return () => {
      if (stateRef.current.animId) cancelAnimationFrame(stateRef.current.animId);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, graph]);

  const handleClick = (e) => {
    if (!onNodeClick || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const scaleX = canvasRef.current.width / rect.width;
    const scaleY = canvasRef.current.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;
    const cx = canvasRef.current.width / 2;
    const cy = canvasRef.current.height / 2;
    const maxR = cx - 24;
    for (const b of stateRef.current.blips) {
      const bx = cx + Math.cos(b.angle) * (maxR * b.dist);
      const by = cy + Math.sin(b.angle) * (maxR * b.dist);
      if (Math.sqrt((mx-bx)**2 + (my-by)**2) < 14) { onNodeClick(b.id); return; }
    }
  };

  if (!mounted) return <div style={{ height: 340, background: "#080612", borderRadius: 6 }} />;

  if (!(graph?.nodes || []).filter(n => n.kind !== "scope").length) {
    return (
      <div className="flex h-[340px] items-center justify-center rounded-md border border-dashed border-cm-border px-4 text-center text-sm text-cm-faint">
        Load activity to render threat radar.
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-md border border-cm-border" style={{ background: "#080612" }}>
      <canvas ref={canvasRef} onClick={handleClick} style={{ display: "block", width: "100%", cursor: "crosshair" }} />
      <div style={{ position: "absolute", bottom: 8, left: 8, right: 8, display: "flex", justifyContent: "space-between", fontFamily: "monospace", fontSize: 8, color: "rgba(139,92,246,0.45)" }}>
        <span>
          <span style={{color:"rgba(239,68,68,0.7)"}}>● high</span>
          {"  "}<span style={{color:"rgba(249,115,22,0.6)"}}>● mid</span>
          {"  "}<span>● low</span>
        </span>
        <span>click blip to scan</span>
      </div>
    </div>
  );
}
