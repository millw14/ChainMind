"use client";

import * as d3 from "d3";
import { useCallback, useEffect, useRef } from "react";

/**
 * Force-directed wallet graph.
 * Props:
 *   graph: { center: string, nodes: [{id, kind, label, eventCount}], links: [{source, target, events}] }
 *   onNodeClick: (address: string) => void
 */
export function WalletGraphForce({ graph, onNodeClick }) {
  const svgRef = useRef(null);
  const simRef = useRef(null);

  const draw = useCallback(() => {
    simRef.current?.stop();
    simRef.current = null;
    if (!svgRef.current || !graph?.nodes?.length) return;

    const container = svgRef.current.parentElement;
    const W = container?.clientWidth || 500;
    const H = 340;

    // Clear previous
    d3.select(svgRef.current).selectAll("*").remove();

    const nodes = graph.nodes.map((n) => ({ ...n }));
    const links = (graph.links || []).map((l) => ({ ...l }));

    const maxEvents = Math.max(1, ...nodes.map((n) => n.eventCount ?? 1));

    // Node radius by event count
    const nodeR = (n) => {
      if (n.kind === "scope") return 20;
      const e = n.eventCount ?? 1;
      return Math.max(6, Math.min(16, 6 + Math.sqrt(e / maxEvents) * 10));
    };

    // Node color by role
    const nodeColor = (n) => {
      if (n.kind === "scope") return "#8b5cf6";
      const e = n.eventCount ?? 1;
      if (e >= maxEvents * 0.6) return "#ef4444"; // top actor — red
      if (e >= maxEvents * 0.3) return "#f97316"; // mid actor — orange
      return "#3b2d6e"; // low actor — dim purple
    };

    const nodeBorder = (n) => {
      if (n.kind === "scope") return "#c4b5fd";
      const e = n.eventCount ?? 1;
      if (e >= maxEvents * 0.6) return "rgba(239,68,68,0.8)";
      if (e >= maxEvents * 0.3) return "rgba(249,115,22,0.6)";
      return "rgba(139,92,246,0.4)";
    };

    const maxLinkEvents = Math.max(1, ...links.map((l) => l.events ?? 1));
    const linkWidth = (l) => 0.5 + (l.events / maxLinkEvents) * 2.5;
    const linkColor = (l) => {
      const ratio = (l.events ?? 1) / maxLinkEvents;
      if (ratio > 0.6) return "rgba(239,68,68,0.5)";
      if (ratio > 0.3) return "rgba(249,115,22,0.35)";
      return "rgba(139,92,246,0.25)";
    };

    const svg = d3
      .select(svgRef.current)
      .attr("width", W)
      .attr("height", H)
      .attr("viewBox", `0 0 ${W} ${H}`);

    // Defs
    const defs = svg.append("defs");
    defs
      .append("radialGradient")
      .attr("id", "scopeGlow")
      .attr("cx", "50%")
      .attr("cy", "50%")
      .attr("r", "50%")
      .selectAll("stop")
      .data([
        { offset: "0%", color: "rgba(139,92,246,0.5)" },
        { offset: "100%", color: "rgba(139,92,246,0)" },
      ])
      .join("stop")
      .attr("offset", (d) => d.offset)
      .attr("stop-color", (d) => d.color);

    const glowFilter = defs.append("filter").attr("id", "nodeGlow");
    glowFilter.append("feGaussianBlur").attr("stdDeviation", "2").attr("result", "blur");
    const merge = glowFilter.append("feMerge");
    merge.append("feMergeNode").attr("in", "blur");
    merge.append("feMergeNode").attr("in", "SourceGraphic");

    // Zoom + pan
    const g = svg.append("g");
    svg.call(d3.zoom().scaleExtent([0.4, 3]).on("zoom", (event) => g.attr("transform", event.transform)));

    // Background glow at center
    g.append("circle").attr("cx", W / 2).attr("cy", H / 2).attr("r", 80).attr("fill", "url(#scopeGlow)");

    // Simulation
    const sim = d3
      .forceSimulation(nodes)
      .force(
        "link",
        d3
          .forceLink(links)
          .id((d) => d.id)
          .distance((l) => {
            const r = (l.events ?? 1) / maxLinkEvents;
            return 80 + (1 - r) * 60; // high-activity nodes closer to center
          })
          .strength(0.6),
      )
      .force("charge", d3.forceManyBody().strength(-120))
      .force("center", d3.forceCenter(W / 2, H / 2))
      .force("collision", d3.forceCollide().radius((n) => nodeR(n) + 14));

    simRef.current = sim;

    // Links
    const linkSel = g.append("g").selectAll("line").data(links).join("line").attr("stroke", linkColor).attr("stroke-width", linkWidth).attr("stroke-linecap", "round");

    // Node groups
    const nodeSel = g
      .append("g")
      .selectAll("g")
      .data(nodes)
      .join("g")
      .attr("cursor", (n) => (n.kind !== "scope" ? "pointer" : "default"))
      .call(
        d3
          .drag()
          .on("start", (event, d) => {
            if (!event.active) sim.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on("drag", (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on("end", (event, d) => {
            if (!event.active) sim.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          }),
      )
      .on("click", (event, d) => {
        if (d.kind !== "scope" && onNodeClick) {
          onNodeClick(d.id);
        }
      });

    // Pulse ring for high-activity nodes
    nodeSel
      .filter((n) => n.kind !== "scope" && (n.eventCount ?? 0) >= maxEvents * 0.6)
      .append("circle")
      .attr("r", (n) => nodeR(n) + 5)
      .attr("fill", "none")
      .attr("stroke", "rgba(239,68,68,0.4)")
      .attr("stroke-width", 1)
      .attr("class", "pulse-ring");

    // Main circle
    nodeSel
      .append("circle")
      .attr("r", nodeR)
      .attr("fill", nodeColor)
      .attr("stroke", nodeBorder)
      .attr("stroke-width", 1.5)
      .attr("filter", "url(#nodeGlow)");

    // Address label
    nodeSel
      .filter((n) => n.kind !== "scope")
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dy", (n) => nodeR(n) + 10)
      .attr("font-size", "7")
      .attr("fill", "rgba(196,181,253,0.55)")
      .text((n) => (n.id ? `${n.id.slice(0, 4)}…${n.id.slice(-3)}` : ""));

    // Scope label
    nodeSel
      .filter((n) => n.kind === "scope")
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dy", 4)
      .attr("font-size", "9")
      .attr("font-weight", "bold")
      .attr("fill", "white")
      .attr("letter-spacing", "1")
      .text("FOCUS");

    // Tooltip title
    nodeSel.append("title").text((n) => `${n.label ?? n.id}${n.eventCount ? ` · ${n.eventCount} events` : ""}`);

    // Tick
    sim.on("tick", () => {
      linkSel
        .attr("x1", (l) => l.source.x)
        .attr("y1", (l) => l.source.y)
        .attr("x2", (l) => l.target.x)
        .attr("y2", (l) => l.target.y);
      nodeSel.attr("transform", (n) => `translate(${n.x},${n.y})`);
    });

    // Fade in nodes after sim stabilizes
    nodeSel.attr("opacity", 0);
    linkSel.attr("opacity", 0);
    setTimeout(() => {
      nodeSel.transition().duration(600).attr("opacity", 1);
      linkSel.transition().duration(800).attr("opacity", 1);
    }, 300);
  }, [graph, onNodeClick]);

  useEffect(() => {
    draw();
    return () => simRef.current?.stop();
  }, [draw]);

  // Redraw on resize
  useEffect(() => {
    const ro = new ResizeObserver(() => draw());
    if (svgRef.current?.parentElement) ro.observe(svgRef.current.parentElement);
    return () => ro.disconnect();
  }, [draw]);

  if (!graph?.nodes?.length) {
    return (
      <div className="flex h-[340px] items-center justify-center rounded-md border border-dashed border-cm-border px-4 text-center text-sm text-cm-faint">
        Set a watchlist address and load activity, or connect Turso to draw payer links from synced events.
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-md border border-cm-border bg-[#0d0b14]">
      <svg ref={svgRef} className="w-full" style={{ height: 340 }} />
      <div className="absolute bottom-2 right-2 flex gap-3 font-mono text-[9px] text-cm-faint">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-red-500" /> high activity
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-orange-500" /> mid
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-purple-700" /> low
        </span>
        <span className="text-cm-faint/50">scroll to zoom · drag to pan</span>
      </div>
    </div>
  );
}
