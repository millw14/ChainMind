"use client";

import { useEffect, useState } from "react";

/**
 * LiveClock — the header's centre zone: network name plus a ticking UTC clock.
 * Renders nothing on the server and fills in after mount, so the server and
 * first client render always agree (a clock rendered during SSR is guaranteed
 * to be stale by the time it hydrates).
 * @param {{ network?: string, className?: string }} props
 */
export default function LiveClock({ network = "Robinhood Chain", className = "" }) {
  const [time, setTime] = useState(null);

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const p = (n) => String(n).padStart(2, "0");
      setTime(`${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <span
      className={`font-mono text-[11px] tracking-[0.18em] text-cm-muted ${className}`}
      // The seconds change every tick; announcing that would be hostile.
      aria-live="off"
    >
      {network}
      {time ? <span className="text-cm-faint"> — {time}</span> : null}
    </span>
  );
}
