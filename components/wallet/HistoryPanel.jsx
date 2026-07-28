"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * HistoryPanel — the questions this wallet has asked, and the two ways to remove
 * them.
 *
 * SCOPE IS SERVER-SIDE. This component sends no address: /api/history reads the
 * session cookie and answers for that wallet only, and a delete names an id that
 * can only ever match inside that wallet's own list. There is nothing to render
 * here for anyone but the signed-in user, and no parameter this component could
 * pass that would change whose history it sees.
 *
 * DELETE MEANS DELETE. "Delete all" asks once — a two-step press rather than a
 * browser confirm, so the confirmation lives in the same surface as the thing it
 * is about — and then the entries are gone from the store, not flagged.
 */

/** `1 Jul, 14:32` — enough to find a conversation, short enough for a panel. */
function when(ms) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return "";
  try {
    return new Date(t).toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export default function HistoryPanel() {
  const [entries, setEntries] = useState(null);
  const [cap, setCap] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch("/api/history", { headers: { accept: "application/json" } });
      const data = await res.json().catch(() => null);
      if (!mountedRef.current) return;
      if (!res.ok || !data) {
        // A failed read is said out loud. An empty list here would be an outage
        // claiming this wallet has never asked anything.
        setError(data?.error ?? "Saved history is unavailable right now.");
        return;
      }
      setEntries(Array.isArray(data.entries) ? data.entries : []);
      setCap(Number(data.cap) || 0);
    } catch {
      if (mountedRef.current) setError("Could not reach the server for saved history.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const removeOne = useCallback(
    async (id) => {
      setBusy(true);
      setError("");
      try {
        const res = await fetch(`/api/history?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.deleted) {
          setError(data?.error ?? "Could not delete that entry.");
          return;
        }
        if (mountedRef.current) setEntries((prev) => (prev ?? []).filter((e) => e.id !== id));
      } catch {
        if (mountedRef.current) setError("Could not reach the server.");
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [],
  );

  const removeAll = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/history?all=1", { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.deleted) {
        setError(data?.error ?? "Could not delete your history.");
        return;
      }
      if (mountedRef.current) {
        setEntries([]);
        setConfirmAll(false);
      }
    } catch {
      if (mountedRef.current) setError("Could not reach the server.");
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, []);

  return (
    <div className="mt-3 border-t border-cm-border-subtle pt-3">
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.2em] text-cm-faint">
          Saved questions
        </p>
        {entries?.length ? (
          confirmAll ? (
            <span className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={removeAll}
                className="font-mono text-[10px] text-cm-bad hover:underline disabled:opacity-50"
              >
                Delete all?
              </button>
              <button
                type="button"
                onClick={() => setConfirmAll(false)}
                className="font-mono text-[10px] text-cm-faint hover:text-cm-muted"
              >
                Keep
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmAll(true)}
              className="font-mono text-[10px] text-cm-faint hover:text-cm-bad"
            >
              Delete all
            </button>
          )
        ) : null}
      </div>

      {error ? <p className="mt-2 text-[11px] leading-relaxed text-cm-bad">{error}</p> : null}

      {entries == null && !error ? (
        <p className="mt-2 font-mono text-[11px] text-cm-faint">Loading…</p>
      ) : null}

      {entries?.length === 0 ? (
        <p className="mt-2 text-[11px] leading-relaxed text-cm-muted">
          Nothing saved yet. Questions you ask while signed in are kept here.
        </p>
      ) : null}

      {entries?.length ? (
        <ul className="mt-2 max-h-64 space-y-1.5 overflow-y-auto pr-1">
          {entries.map((entry) => (
            <li key={entry.id} className="rounded-md border border-cm-border-subtle bg-cm-surface px-2.5 py-2">
              <div className="flex items-start justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setExpanded((id) => (id === entry.id ? null : entry.id))}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate text-[12px] text-cm-text">{entry.question}</p>
                  <p className="mt-0.5 font-mono text-[10px] text-cm-faint">
                    {when(entry.at)}
                    {entry.intent ? ` · ${entry.intent}` : ""}
                  </p>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => removeOne(entry.id)}
                  aria-label="Delete this entry"
                  className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] text-cm-faint transition-colors hover:bg-cm-row-hover hover:text-cm-bad disabled:opacity-50"
                >
                  ✕
                </button>
              </div>
              {expanded === entry.id ? (
                <p className="mt-2 whitespace-pre-wrap break-words border-t border-cm-border-subtle pt-2 text-[11px] leading-relaxed text-cm-muted">
                  {entry.answer}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {cap > 0 ? (
        <p className="mt-2 text-[10px] leading-relaxed text-cm-faint">
          The last {cap} are kept — older ones drop off as new questions arrive. Deleting here removes them
          from the server.
        </p>
      ) : null}
    </div>
  );
}
