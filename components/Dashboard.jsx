"use client";

import { useCallback, useEffect, useState } from "react";

const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function Card({ title, subtitle, children, actions }) {
  return (
    <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-5 shadow-lg shadow-black/20 backdrop-blur-sm">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-sky-400">{title}</h2>
          {subtitle ? <p className="mt-1 text-sm text-zinc-400">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

function JsonBlock({ data, emptyText = "No data yet." }) {
  if (data == null) {
    return (
      <p className="rounded-xl border border-zinc-800 bg-zinc-950/80 px-4 py-8 text-center text-sm text-zinc-500">
        {emptyText}
      </p>
    );
  }
  return (
    <pre className="max-h-80 overflow-auto rounded-xl border border-zinc-800 bg-zinc-950/90 p-4 font-[family-name:var(--font-mono)] text-xs leading-relaxed text-zinc-300">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

export function Dashboard() {
  const [ping, setPing] = useState(null);
  const [inspectAddr, setInspectAddr] = useState(USDC_MAINNET);
  const [inspectLimit, setInspectLimit] = useState("12");
  const [inspect, setInspect] = useState(null);

  const [scoreScope, setScoreScope] = useState(USDC_MAINNET);
  const [scoreWindow, setScoreWindow] = useState("5");
  const [scoreHours, setScoreHours] = useState("168");
  const [score, setScore] = useState(null);

  const [dbStats, setDbStats] = useState(null);

  const [loading, setLoading] = useState({});

  const setLoad = (key, v) => setLoading((s) => ({ ...s, [key]: v }));

  const fetchJson = useCallback(async (url, key) => {
    setLoad(key, true);
    try {
      const r = await fetch(url);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.statusText || "Request failed");
      return j;
    } finally {
      setLoad(key, false);
    }
  }, []);

  const runPing = async () => {
    try {
      setPing(await fetchJson("/api/ping", "ping"));
    } catch (e) {
      setPing({ error: String(e.message) });
    }
  };

  const runInspect = async () => {
    const a = inspectAddr.trim();
    if (!a) return;
    const u = `/api/inspect?address=${encodeURIComponent(a)}&limit=${encodeURIComponent(inspectLimit || "12")}`;
    try {
      setInspect(await fetchJson(u, "inspect"));
    } catch (e) {
      setInspect({ ok: false, error: String(e.message) });
    }
  };

  const runDb = async () => {
    try {
      setDbStats(await fetchJson("/api/db-stats", "db"));
    } catch (e) {
      setDbStats({ ok: false, error: String(e.message) });
    }
  };

  useEffect(() => {
    void runPing();
    void runDb();
    // Initial load only; runPing/runDb intentionally omitted from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runScore = async () => {
    const s = scoreScope.trim();
    if (!s) return;
    const u = `/api/score?scope=${encodeURIComponent(s)}&window=${encodeURIComponent(scoreWindow || "5")}&hours=${encodeURIComponent(scoreHours || "24")}`;
    try {
      setScore(await fetchJson(u, "score"));
    } catch (e) {
      setScore({ ok: false, error: String(e.message) });
    }
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-zinc-800/80 bg-zinc-950/80">
        <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
          <p className="text-xs font-semibold uppercase tracking-widest text-sky-500">Solana · coordination proxy</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-white sm:text-4xl">ChainMind</h1>
          <p className="mt-3 max-w-2xl text-base text-zinc-400">
            Operational dashboard: ingest locally or via Turso, then inspect RPC health, pull recent signatures, and
            run the v1 co-activity score. This is a decision-support lab — not a court verdict.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={runPing}
              disabled={loading.ping}
              className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-sky-400 disabled:opacity-50"
            >
              {loading.ping ? "Pinging…" : "Ping RPC"}
            </button>
            <button
              type="button"
              onClick={runDb}
              disabled={loading.db}
              className="rounded-lg border border-zinc-600 bg-zinc-900 px-4 py-2 text-sm font-semibold text-zinc-100 transition hover:bg-zinc-800 disabled:opacity-50"
            >
              {loading.db ? "Loading…" : "Refresh DB stats"}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6">
        <Card
          title="RPC health"
          subtitle="Cluster, software version, and current slot"
          actions={
            <button
              type="button"
              onClick={runPing}
              className="text-xs font-medium text-sky-400 hover:text-sky-300"
            >
              Retry
            </button>
          }
        >
          <JsonBlock data={ping} emptyText="Click Ping RPC above to load." />
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card
            title="Inspect"
            subtitle="Recent signatures for any base58 address"
            actions={
              <button
                type="button"
                onClick={runInspect}
                disabled={loading.inspect}
                className="rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 disabled:opacity-50"
              >
                {loading.inspect ? "…" : "Load"}
              </button>
            }
          >
            <div className="mb-4 space-y-3">
              <div>
                <label className="mb-1 block text-xs text-zinc-500">Address</label>
                <input
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none ring-sky-500/30 focus:ring-2"
                  value={inspectAddr}
                  onChange={(e) => setInspectAddr(e.target.value)}
                  spellCheck={false}
                />
              </div>
              <div className="w-24">
                <label className="mb-1 block text-xs text-zinc-500">Limit</label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-2 focus:ring-sky-500/30"
                  value={inspectLimit}
                  onChange={(e) => setInspectLimit(e.target.value)}
                />
              </div>
            </div>
            <JsonBlock data={inspect} emptyText="Load signatures after setting an address." />
          </Card>

          <Card
            title="Co-activity score (v1)"
            subtitle="Needs Turso data ingested · max distinct fee payers per time bucket"
            actions={
              <button
                type="button"
                onClick={runScore}
                disabled={loading.score}
                className="rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 disabled:opacity-50"
              >
                {loading.score ? "…" : "Compute"}
              </button>
            }
          >
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <div className="sm:col-span-3">
                <label className="mb-1 block text-xs text-zinc-500">Scope</label>
                <input
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-2 focus:ring-sky-500/30"
                  value={scoreScope}
                  onChange={(e) => setScoreScope(e.target.value)}
                  spellCheck={false}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-500">Window (min)</label>
                <input
                  type="number"
                  min={1}
                  max={60}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sky-500/30"
                  value={scoreWindow}
                  onChange={(e) => setScoreWindow(e.target.value)}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-500">Lookback (h)</label>
                <input
                  type="number"
                  min={1}
                  max={720}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sky-500/30"
                  value={scoreHours}
                  onChange={(e) => setScoreHours(e.target.value)}
                />
              </div>
            </div>
            <JsonBlock data={score} emptyText="Run compute after Turso has `events` for this scope." />
          </Card>
        </div>

        <Card
          title="Database (Turso)"
          subtitle="Mirrors local SQLite when you run npm run turso:sync"
          actions={
            <button
              type="button"
              onClick={runDb}
              className="text-xs font-medium text-sky-400 hover:text-sky-300"
            >
              Refresh
            </button>
          }
        >
          <JsonBlock data={dbStats} emptyText="Refresh to load counts (Turso optional)." />
        </Card>
      </main>

      <footer className="border-t border-zinc-800/80 py-8 text-center text-xs text-zinc-600">
        ChainMind — internal intelligence surface. Set <code className="text-zinc-500">SOLANA_RPC_URL</code> on Vercel.
      </footer>
    </div>
  );
}
