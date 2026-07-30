"use client";
import { useCallback, useEffect, useState } from "react";

const fmt = (n) => Number(n ?? 0).toLocaleString("en-US");

function timeAgo(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function Stat({ label, value, sub }) {
  return (
    <div className="rounded-lg border border-cm-border bg-cm-card p-4">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-cm-faint">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-cm-text">{value}</p>
      {sub != null && <p className="mt-0.5 font-mono text-[11px] text-cm-muted">{sub}</p>}
    </div>
  );
}

function LoginForm({ onSuccess }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        onSuccess();
      } else {
        setError(data.error || "Login failed.");
      }
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-cm-bg px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-cm-border bg-cm-card p-6">
        <h1 className="text-lg font-semibold text-cm-text">ChainMind admin</h1>
        <p className="mt-1 font-mono text-[11px] text-cm-muted">Enter the operator password.</p>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="mt-4 w-full rounded-md border border-cm-border bg-cm-bg px-3 py-2 text-sm text-cm-text outline-none focus:border-cm-accent"
        />
        {error && <p className="mt-2 font-mono text-[11px] text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy || !password}
          className="mt-4 w-full rounded-md bg-cm-accent px-3 py-2 text-sm font-semibold text-black disabled:opacity-50"
        >
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

function Dashboard({ usage, onReload, onLogout }) {
  const days = usage.days ?? [];
  const maxDay = Math.max(1, ...days.map((d) => d.questions));
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-cm-text">Admin · usage</h1>
          <p className="font-mono text-[11px] text-cm-muted">
            store: {usage.driver}
            {usage.configured ? "" : " · not durable — numbers are best-effort"}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={onReload} className="rounded-md border border-cm-border px-3 py-1.5 font-mono text-xs text-cm-muted hover:text-cm-text">
            Refresh
          </button>
          <button onClick={onLogout} className="rounded-md border border-cm-border px-3 py-1.5 font-mono text-xs text-cm-muted hover:text-cm-text">
            Log out
          </button>
        </div>
      </header>

      {!usage.configured && (usage.warnings?.length ?? 0) > 0 && (
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <p className="font-mono text-[11px] font-semibold uppercase tracking-widest text-amber-400">Store not persistent</p>
          {usage.warnings.map((w, i) => (
            <p key={i} className="mt-1 font-mono text-[11px] text-amber-200/80">{w}</p>
          ))}
        </div>
      )}

      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Questions" value={fmt(usage.questions?.total)} sub={`${fmt(usage.questions?.today)} today`} />
        <Stat label="Visitors" value={fmt(usage.visitors?.total)} sub={`${fmt(usage.visitors?.today)} today`} />
        <Stat label="Questions · today" value={fmt(usage.questions?.today)} />
        <Stat label="Visitors · today" value={fmt(usage.visitors?.today)} />
      </section>

      <section className="mt-8">
        <h2 className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-cm-faint">Last {days.length} days</h2>
        <div className="mt-3 space-y-1">
          {days.map((d) => (
            <div key={d.day} className="flex items-center gap-3">
              <span className="w-24 shrink-0 font-mono text-[11px] text-cm-muted">{d.day}</span>
              <div className="h-4 flex-1 overflow-hidden rounded bg-cm-bg">
                <div className="h-full rounded bg-cm-accent/70" style={{ width: `${(d.questions / maxDay) * 100}%` }} />
              </div>
              <span className="w-28 shrink-0 text-right font-mono text-[11px] text-cm-muted">
                {fmt(d.questions)} q · {fmt(d.visitors)} v
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-cm-faint">
          Recent searches ({usage.recent?.length ?? 0})
        </h2>
        <div className="mt-3 overflow-hidden rounded-lg border border-cm-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-cm-card">
              <tr className="font-mono text-[10px] uppercase tracking-widest text-cm-faint">
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Who</th>
                <th className="px-3 py-2 font-medium">Query</th>
                <th className="px-3 py-2 font-medium">Target</th>
              </tr>
            </thead>
            <tbody>
              {(usage.recent ?? []).length === 0 && (
                <tr><td colSpan={4} className="px-3 py-6 text-center font-mono text-[11px] text-cm-muted">No searches recorded yet.</td></tr>
              )}
              {(usage.recent ?? []).map((r, i) => (
                <tr key={i} className="border-t border-cm-border align-top">
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-cm-muted">{r.at ? timeAgo(r.at) : "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-cm-terminal">{r.who || "—"}</td>
                  <td className="px-3 py-2 text-cm-text">{r.q || <span className="text-cm-faint">(no question)</span>}</td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-cm-muted">{r.target || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export default function AdminPage() {
  const [state, setState] = useState({ status: "loading", usage: null });

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/stats", { cache: "no-store" });
      if (res.status === 401) return setState({ status: "login", usage: null });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) return setState({ status: "ready", usage: data.usage });
      setState({ status: "login", usage: null });
    } catch {
      setState({ status: "login", usage: null });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const logout = useCallback(async () => {
    await fetch("/api/admin/login", { method: "DELETE" }).catch(() => {});
    setState({ status: "login", usage: null });
  }, []);

  if (state.status === "loading") {
    return <div className="flex min-h-screen items-center justify-center bg-cm-bg font-mono text-sm text-cm-muted">Loading…</div>;
  }
  if (state.status === "login") {
    return <LoginForm onSuccess={load} />;
  }
  return (
    <div className="min-h-screen bg-cm-bg">
      <Dashboard usage={state.usage} onReload={load} onLogout={logout} />
    </div>
  );
}
