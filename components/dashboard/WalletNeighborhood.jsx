"use client";

/**
 * components/dashboard/WalletNeighborhood.jsx
 *
 * Phase 3 read-side UI: explore a wallet's graph neighborhood (GET /api/graph/neighborhood).
 * Shows ranked counterparties with edge-type breakdown + in/out direction, flags balanced
 * bidirectional flow (wash-like round-trips), and lets you drill into a neighbor.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

const TIMEOUT_MS = 30_000;

function shortAddr(a) {
  if (!a || a.length < 12) return a || "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** Balanced two-way flow with enough volume reads as a wash-like round-trip. */
function isRoundTrip(n) {
  if (!n || n.inbound <= 0 || n.outbound <= 0 || n.edges < 6) return false;
  const lo = Math.min(n.inbound, n.outbound);
  const hi = Math.max(n.inbound, n.outbound);
  return hi > 0 && lo / hi >= 0.6;
}

function DirBar({ inbound, outbound }) {
  const total = Math.max(1, inbound + outbound);
  const outPct = Math.round((outbound / total) * 100);
  return (
    <span className="inline-flex items-center gap-1.5" title={`${outbound} out · ${inbound} in`}>
      <span className="font-mono text-[10px] tabular-nums text-cm-faint">↑{outbound}</span>
      <span className="relative h-1.5 w-12 overflow-hidden rounded-full bg-cm-row">
        <span className="absolute inset-y-0 left-0 bg-cm-accent/70" style={{ width: `${outPct}%` }} />
      </span>
      <span className="font-mono text-[10px] tabular-nums text-cm-faint">↓{inbound}</span>
    </span>
  );
}

export function WalletNeighborhood({ address, onPickAddress }) {
  const [subject, setSubject] = useState(address || "");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Follow the dashboard's watch target when it changes.
  useEffect(() => {
    setSubject(address || "");
  }, [address]);

  const load = useCallback(async (addr) => {
    const a = String(addr ?? "").trim();
    if (!a) {
      setData(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/graph/neighborhood?address=${encodeURIComponent(a)}&limit=40`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      setData(j);
    } catch (e) {
      setError(e?.name === "TimeoutError" ? "Neighborhood query timed out." : String(e.message));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(subject);
  }, [subject, load]);

  const neighbors = data?.neighbors ?? [];
  const mode = data?.mode ?? "wallet";
  const isScope = mode === "scope";
  const roundTrips = useMemo(() => neighbors.filter(isRoundTrip).length, [neighbors]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Wallet address (base58)"
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 rounded-md border border-cm-border bg-cm-row/80 px-3 py-2 font-mono text-xs text-cm-text outline-none ring-cm-accent-ring focus:ring-2"
        />
        {address && subject !== address ? (
          <button
            type="button"
            onClick={() => setSubject(address)}
            className="rounded-md border border-cm-border bg-cm-elevated px-2.5 py-2 text-[11px] font-medium text-cm-muted transition hover:text-cm-text"
          >
            Use watch target
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void load(subject)}
          disabled={loading}
          className="rounded-md border border-cm-border bg-cm-elevated px-2.5 py-2 text-[11px] font-medium text-cm-muted transition hover:text-cm-text disabled:opacity-45"
        >
          {loading ? "…" : "↻"}
        </button>
      </div>

      {loading && !data ? (
        <p className="py-6 text-center text-sm text-cm-faint">Loading connections…</p>
      ) : error ? (
        <div className="rounded-md border border-cm-bad/50 bg-cm-bad/15 px-4 py-3 text-sm text-cm-subtle">{error}</div>
      ) : !data ? (
        <p className="py-6 text-center text-sm text-cm-faint">Enter a wallet, or click one in the graph / table.</p>
      ) : neighbors.length === 0 ? (
        <p className="py-6 text-center text-sm text-cm-faint">
          No graph edges found for this address yet — it has no ingested funding/transfer activity in the database.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 text-xs text-cm-muted">
            <span>
              <strong className="text-cm-text">{data.neighborCount}</strong>
              {data.neighborsTruncated ? ` of ${data.totalNeighbors}` : ""} {isScope ? "active wallets" : "connections"}
            </span>
            {roundTrips > 0 ? (
              <span className="rounded border border-cm-bad/40 bg-cm-bad/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-cm-bad">
                ⚠ {roundTrips} round-trip{roundTrips > 1 ? "s" : ""}
              </span>
            ) : null}
            {data.capped ? (
              <span className="text-[10px] text-cm-faint">scanned {data.edgesConsidered.toLocaleString()} most-recent edges</span>
            ) : null}
          </div>

          {isScope ? (
            <p className="text-[11px] text-cm-muted">
              Most active wallets in this token — click one to see who it’s connected to.
            </p>
          ) : null}

          <div className="overflow-hidden rounded-md border border-cm-border">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-cm-border bg-cm-row/80 font-mono text-[10px] uppercase tracking-wide text-cm-faint">
                <tr>
                  <th className="px-3 py-2">{isScope ? "Wallet" : "Counterparty"}</th>
                  <th className="px-3 py-2 text-right">Edges</th>
                  <th className="px-3 py-2">Direction</th>
                  <th className="px-3 py-2">Types</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-cm-border/60">
                {neighbors.map((n) => {
                  const wash = isRoundTrip(n);
                  return (
                    <tr key={n.address} className={`bg-cm-row/20 ${wash ? "ring-1 ring-inset ring-cm-bad/30" : ""}`}>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => setSubject(n.address)}
                          title="Explore this wallet's connections"
                          className="font-mono text-cm-accent-bright hover:underline"
                        >
                          {shortAddr(n.address)}
                        </button>
                        {wash ? <span className="ml-2 text-[10px] font-semibold text-cm-bad">round-trip</span> : null}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-cm-text">{n.edges.toLocaleString()}</td>
                      <td className="px-3 py-2">
                        <DirBar inbound={n.inbound} outbound={n.outbound} />
                      </td>
                      <td className="px-3 py-2 font-mono text-[10px] text-cm-muted">
                        {Object.entries(n.edgeTypes)
                          .map(([k, v]) => `${k.replace(/_/g, " ")}·${v}`)
                          .join("  ")}
                      </td>
                      <td className="px-2 py-2 text-right">
                        {onPickAddress ? (
                          <button
                            type="button"
                            onClick={() => onPickAddress(n.address)}
                            title="Set as watch target"
                            className="rounded border border-cm-border px-1.5 py-0.5 text-[10px] text-cm-faint transition hover:border-cm-accent/40 hover:text-cm-text"
                          >
                            ⌖
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-cm-faint">
            Click a wallet to explore its connections · <span className="text-cm-bad">round-trip</span> = balanced two-way
            flow (wash-like) · probabilistic signal, not proof.
          </p>
        </>
      )}
    </div>
  );
}

export default WalletNeighborhood;
