"use client";

import { useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";

import { springGentle } from "@/components/motion/presets";
import { deriveRiskProfile } from "@/lib/risk-profile.js";

function shortAddr(s) {
  if (!s || s.length < 12) return s || "—";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/** Debounce for the typed primary address — /api/score is the heaviest endpoint, so wait
 *  for a pause in typing instead of firing a burst of requests per keystroke. */
const PRIMARY_DEBOUNCE_MS = 450;
/** Plausible base58 Solana address (same 32-44 length check as the score API's PublicKey
 *  parse) — partial typed strings would just 400 out server-side and flash error tiles. */
const BASE58_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const tierColor = {
  critical: "text-cm-bad",
  high: "text-orange-300",
  elevated: "text-cm-warn",
  low: "text-cm-ok",
  unknown: "text-cm-muted",
};

/**
 * @param {{
 *   primary: string,
 *   compareScopes: string[],
 *   scoreWindow: string,
 *   scoreHours: string,
 *   watchlist: Array<{ address: string, note?: string | null }> | null,
 *   onSetPrimary: (addr: string) => void,
 *   onToggleCompare: (addr: string) => void,
 *   onRemoveCompare: (addr: string) => void,
 *   onClearCompare: () => void,
 * }} props
 */
export function MultiScopeComparePanel({
  primary,
  compareScopes,
  scoreWindow,
  scoreHours,
  watchlist,
  onSetPrimary,
  onToggleCompare,
  onRemoveCompare,
  onClearCompare,
}) {
  const reduce = useReducedMotion() ?? false;

  // The primary prop is the dashboard's raw, undebounced input value — settle it here.
  const [debouncedPrimary, setDebouncedPrimary] = useState(primary);
  useEffect(() => {
    const id = setTimeout(() => setDebouncedPrimary(primary), PRIMARY_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [primary]);

  const scopes = useMemo(() => {
    const p = debouncedPrimary.trim();
    const rest = compareScopes.map((s) => s.trim()).filter(Boolean);
    const head = BASE58_ADDR_RE.test(p) ? [p] : [];
    const u = [...new Set([...head, ...rest])].slice(0, 6);
    return u;
  }, [debouncedPrimary, compareScopes]);

  const [rows, setRows] = useState(/** @type {Record<string, { ok: boolean, body: any }>} */ ({}));
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (scopes.length === 0) {
      setRows({});
      return;
    }
    let cancel = false;
    setLoading(true);
    (async () => {
      const win = scoreWindow || "5";
      const hrs = scoreHours || "168";
      // Merge each result into the map as it lands — rebuilding from scratch would blank
      // already-loaded tiles for the duration of every refresh.
      await Promise.all(
        scopes.map(async (scope) => {
          try {
            const r = await fetch(
              `/api/score?scope=${encodeURIComponent(scope)}&window=${encodeURIComponent(win)}&hours=${encodeURIComponent(hrs)}`,
            );
            const j = await r.json().catch(() => ({}));
            if (!cancel) setRows((prev) => ({ ...prev, [scope]: { ok: r.ok, body: j } }));
          } catch {
            if (!cancel) setRows((prev) => ({ ...prev, [scope]: { ok: false, body: { error: "fetch failed" } } }));
          }
        }),
      );
      if (!cancel) setLoading(false);
    })();
    return () => {
      cancel = true;
    };
  }, [scopes, scoreWindow, scoreHours]);

  return (
    <motion.div
      className="rounded-md border border-cm-border bg-cm-card/80 px-4 py-4 sm:px-5"
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0 } : springGentle}
    >
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-cm-faint">Multi-focus</p>
          <p className="mt-1 text-xs text-cm-muted">
            Compare coordination scores across watch targets — primary drives the main panels; pins add up to five
            side scopes.
          </p>
        </div>
        {compareScopes.length > 0 ? (
          <button
            type="button"
            onClick={() => onClearCompare()}
            className="font-mono text-[10px] uppercase tracking-wide text-cm-accent-bright hover:underline"
          >
            Clear pins
          </button>
        ) : null}
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {watchlist === null ? (
          <span className="font-mono text-[10px] text-cm-faint">Loading watchlist…</span>
        ) : watchlist.length === 0 ? (
          <span className="font-mono text-[10px] text-cm-faint">
            No saved scopes yet — scan an address to add it to your watchlist.
          </span>
        ) : (
          watchlist.map(({ address, note }) => {
            const isPri = address === primary.trim();
            const pinned = compareScopes.includes(address);
            return (
              <div
                key={address}
                className="flex items-center gap-0.5 rounded-md border border-cm-border-subtle bg-cm-row/40 px-1 py-0.5"
              >
                <button
                  type="button"
                  title={note || address}
                  onClick={() => onSetPrimary(address)}
                  className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${isPri ? "bg-cm-accent/25 text-cm-accent-bright" : "text-cm-subtle hover:bg-cm-surface/60"}`}
                >
                  {shortAddr(address)}
                </button>
                <button
                  type="button"
                  title="Pin for compare"
                  onClick={() => onToggleCompare(address)}
                  className={`rounded px-1 font-mono text-[10px] ${pinned ? "text-cm-warn" : "text-cm-faint hover:text-cm-muted"}`}
                >
                  {pinned ? "★" : "+"}
                </button>
              </div>
            );
          })
        )}
      </div>

      {compareScopes.length > 0 ? (
        <div className="mb-3 flex flex-wrap gap-1.5 border-t border-cm-border-subtle pt-2">
          {compareScopes.map((a) => (
            <span
              key={a}
              className="inline-flex items-center gap-1 rounded-full border border-cm-warn/30 bg-cm-warn/10 px-2 py-0.5 font-mono text-[9px] text-cm-subtle"
            >
              {shortAddr(a)}
              <button type="button" className="text-cm-faint hover:text-cm-bad" onClick={() => onRemoveCompare(a)} aria-label="Remove pin">
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {scopes.length === 0 ? (
        <p className="text-sm text-cm-faint">Set a primary scope to load comparison scores.</p>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {scopes.map((scope) => {
            const pack = rows[scope];
            const isPrimary = scope === primary.trim();
            if (!pack) {
              return (
                <div key={scope} className="rounded-md border border-cm-border-subtle bg-cm-row/20 p-3">
                  <p className="font-mono text-[10px] text-cm-faint">{shortAddr(scope)}</p>
                  <p className="mt-1 text-[10px] text-cm-faint">…</p>
                </div>
              );
            }
            if (!pack.ok || !pack.body?.ok) {
              return (
                <div key={scope} className="rounded-md border border-cm-bad/30 bg-cm-bad/10 p-3">
                  <p className="font-mono text-[10px] font-semibold text-cm-subtle">
                    {shortAddr(scope)}
                    {isPrimary ? (
                      <span className="ml-1 text-cm-accent">· primary</span>
                    ) : null}
                  </p>
                  <p className="mt-1 text-[10px] text-cm-bad">{String(pack.body?.error ?? "Score unavailable")}</p>
                </div>
              );
            }
            const prof = deriveRiskProfile(pack.body);
            const col = tierColor[prof.tier] ?? "text-cm-text";
            return (
              <div
                key={scope}
                className={`rounded-md border p-3 ${isPrimary ? "border-cm-accent/50 bg-cm-accent/5" : "border-cm-border-subtle bg-cm-row/25"}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="font-mono text-[10px] font-semibold text-cm-subtle">
                    {shortAddr(scope)}
                    {isPrimary ? (
                      <span className="ml-1 text-cm-accent">· primary</span>
                    ) : null}
                  </p>
                  <span className={`font-mono text-lg font-bold tabular-nums ${col}`}>
                    {prof.score0_100 != null ? prof.score0_100 : "—"}
                  </span>
                </div>
                <p className="mt-1 font-mono text-[9px] uppercase tracking-wide text-cm-faint">{prof.tier}</p>
              </div>
            );
          })}
        </div>
      )}
      {loading ? <p className="mt-2 font-mono text-[9px] text-cm-faint">Refreshing scores…</p> : null}
    </motion.div>
  );
}
