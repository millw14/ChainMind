"use client";

import { useEffect, useRef, useState } from "react";

export function WalletGraphForce({ graph, onNodeClick }) {
  const canvasRef = useRef(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = 300;
    canvas.height = 300;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#8b5cf6";
    ctx.fillRect(50, 50, 200, 200);
    ctx.fillStyle = "white";
    ctx.font = "20px monospace";
    ctx.fillText("RADAR", 100, 155);
  }, [mounted]);

  if (!mounted) return <div style={{ height: 300, background: "#080612", borderRadius: 6 }} />;

  return (
    <div style={{ background: "#080612", borderRadius: 6, overflow: "hidden" }}>
      <canvas ref={canvasRef} style={{ display: "block", width: "100%" }} />
    </div>
  );
}
