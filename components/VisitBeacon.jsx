"use client";
import { useEffect } from "react";

/**
 * Fire one visit ping per browser session.
 *
 * Once per session, not once per page: this sits in the root layout so it mounts
 * on every route, and without the guard a normal click-around would count the same
 * person many times. sessionStorage clears when the tab closes, which is the
 * closest thing the browser has to "a visit". The server de-duplicates per UTC day
 * on top of this, so a double-fire costs nothing but a round trip.
 */
export default function VisitBeacon() {
  useEffect(() => {
    try {
      if (sessionStorage.getItem("cm_visited") === "1") return;
      sessionStorage.setItem("cm_visited", "1");
    } catch {
      // Private mode with storage disabled: just fire, the server dedupes by day.
    }
    fetch("/api/track/visit", { method: "POST", keepalive: true }).catch(() => {});
  }, []);
  return null;
}
