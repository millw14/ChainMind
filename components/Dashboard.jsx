"use client";

import { useCallback, useEffect, useState } from "react";

const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function solscanTx(signature) {
  return `https://solscan.io/tx/${signature}`;
}

function formatTime(unix) {
  if (unix == null || unix === "") return "—";
  const n = Number(unix);
  if (!Number.isFinite(n)) return "—";
  return new Date(n * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function shortSig(s) {
  if (!s || s.length < 12) return s || "—";
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function rpcHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "—";
  }
}

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

function ExpandableRaw({ label = "Technical details (JSON)", data }) {
  if (data == null) return null;
  return (
    <details className="mt-4 rounded-lg border border-zinc-800/80 bg-zinc-950/50">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-zinc-500 hover:text-zinc-400">
        {label}
      </summary>
      <pre className="max-h-48 overflow-auto border-t border-zinc-800/80 p-3 font-[family-name:var(--font-mono)] text-[11px] leading-relaxed text-zinc-400">
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  );
}

function ErrorCallout({ message }) {
  return (
    <div className="rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
      {message}
    </div>
  );
}

function InfoCallout({ children }) {
  return (
    <div className="rounded-lg border border-amber-900/40 bg-amber-950/25 px-4 py-3 text-sm leading-relaxed text-amber-100/90">
      {children}
    </div>
  );
}

function PingBody({ data, loading }) {
  if (loading) {
    return <p className="py-8 text-center text-sm text-zinc-500">Checking connection…</p>;
  }
  if (!data) {
    return <p className="py-8 text-center text-sm text-zinc-500">No data yet. Use Refresh.</p>;
  }
  if (data.error) {
    return <ErrorCallout message={data.error} />;
  }
  if (!data.ok) {
    return <ErrorCallout message="Something went wrong." />;
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-semibold text-emerald-400">
          Connected
        </span>
        <span className="text-xs text-zinc-500">{data.cluster}</span>
      </div>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 px-4 py-3">
          <dt className="text-xs text-zinc-500">Current slot</dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums text-white">{data.slot?.toLocaleString?.() ?? data.slot}</dd>
        </div>
        <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 px-4 py-3">
          <dt className="text-xs text-zinc-500">Solana version</dt>
          <dd className="mt-1 text-lg font-semibold text-white">{data.version ?? "—"}</dd>
        </div>
        <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 px-4 py-3 sm:col-span-2">
          <dt className="text-xs text-zinc-500">RPC endpoint (redacted)</dt>
          <dd className="mt-1 break-all font-[family-name:var(--font-mono)] text-sm text-zinc-300">{data.rpcUrl}</dd>
          <p className="mt-1 text-xs text-zinc-600">
            Host: <span className="text-zinc-400">{rpcHost(data.rpcUrl)}</span>
          </p>
        </div>
      </dl>
      <ExpandableRaw data={data} />
    </div>
  );
}

function InspectBody({ data, loading }) {
  if (loading) {
    return <p className="py-8 text-center text-sm text-zinc-500">Loading transactions…</p>;
  }
  if (!data) {
    return <p className="py-8 text-center text-sm text-zinc-500">Enter an address and tap Load.</p>;
  }
  if (data.error || data.ok === false) {
    return <ErrorCallout message={data.error || "Request failed."} />;
  }
  const rows = data.signatures ?? [];
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-zinc-500">No recent signatures for this address.</p>;
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-400">
        Showing <strong className="text-zinc-200">{rows.length}</strong> recent transactions
        {data.address ? (
          <>
            {" "}
            for <span className="font-[family-name:var(--font-mono)] text-xs text-zinc-300">{shortSig(data.address)}</span>
          </>
        ) : null}
        .
      </p>
      <div className="overflow-x-auto rounded-xl border border-zinc-800/80">
        <table className="w-full min-w-[32rem] text-left text-sm">
          <thead className="border-b border-zinc-800 bg-zinc-950/80 text-xs font-medium uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">Slot</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">View</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/80">
            {rows.map((row) => {
              const ok = !row.err;
              return (
                <tr key={row.signature} className="bg-zinc-950/30 hover:bg-zinc-900/50">
                  <td className="whitespace-nowrap px-3 py-2 text-zinc-300">{formatTime(row.blockTime)}</td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-zinc-400">
                    {row.slot != null ? row.slot.toLocaleString() : "—"}
                  </td>
                  <td className="px-3 py-2">
                    {ok ? (
                      <span className="text-emerald-400/90">Succeeded</span>
                    ) : (
                      <span className="text-amber-400/90" title={JSON.stringify(row.err)}>
                        Failed
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <a
                      href={solscanTx(row.signature)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sky-400 hover:text-sky-300 hover:underline"
                    >
                      Solscan ↗
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ExpandableRaw label="Raw API response" data={data} />
    </div>
  );
}

function DbBody({ data, loading }) {
  if (loading) {
    return <p className="py-8 text-center text-sm text-zinc-500">Loading database info…</p>;
  }
  if (!data) {
    return <p className="py-8 text-center text-sm text-zinc-500">No data yet.</p>;
  }
  if (data.error) {
    return <ErrorCallout message={data.error} />;
  }
  if (data.database === "unconfigured") {
    return (
      <div className="space-y-3">
        <InfoCallout>
          <strong className="text-amber-200">Cloud database not connected.</strong> Charts and scores on this site use a
          small Turso database. After you run the pipeline on your computer, sync once with{" "}
          <code className="rounded bg-zinc-900 px-1 text-amber-100/80">npm run turso:sync</code> and add Turso keys in
          Vercel. Until then, RPC checks and transaction lookup still work above.
        </InfoCallout>
        {data.hint ? <p className="text-xs text-zinc-500">{data.hint}</p> : null}
        <ExpandableRaw data={data} />
      </div>
    );
  }
  const scopes = data.byScope ?? [];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 px-4 py-3">
          <dt className="text-xs text-zinc-500">Signatures stored</dt>
          <dd className="mt-1 text-xl font-semibold tabular-nums text-white">
            {(data.signaturesTotal ?? 0).toLocaleString()}
          </dd>
        </div>
        <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 px-4 py-3">
          <dt className="text-xs text-zinc-500">Parsed events</dt>
          <dd className="mt-1 text-xl font-semibold tabular-nums text-white">
            {(data.eventsTotal ?? 0).toLocaleString()}
          </dd>
        </div>
        <div className="col-span-2 rounded-xl border border-zinc-800/80 bg-zinc-950/60 px-4 py-3 sm:col-span-1">
          <dt className="text-xs text-zinc-500">Backend</dt>
          <dd className="mt-1 text-sm font-medium capitalize text-zinc-200">{data.database ?? "—"}</dd>
        </div>
      </div>
      {scopes.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-zinc-800/80">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-800 bg-zinc-950/80 text-xs font-medium uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-3 py-2">Scope address</th>
                <th className="px-3 py-2">Signatures</th>
                <th className="px-3 py-2">Events</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/80">
              {scopes.map((s) => (
                <tr key={s.scope} className="bg-zinc-950/30">
                  <td className="max-w-[12rem] truncate px-3 py-2 font-[family-name:var(--font-mono)] text-xs text-zinc-300">
                    {s.scope}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-zinc-400">{(s.signatures ?? 0).toLocaleString()}</td>
                  <td className="px-3 py-2 tabular-nums text-zinc-400">{(s.events ?? 0).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <ExpandableRaw data={data} />
    </div>
  );
}

function ScoreBody({ data, loading }) {
  if (loading) {
    return <p className="py-8 text-center text-sm text-zinc-500">Computing…</p>;
  }
  if (!data) {
    return <p className="py-8 text-center text-sm text-zinc-500">Set a scope and tap Compute.</p>;
  }
  if (data.error) {
    return <ErrorCallout message={data.error} />;
  }
  if (data.database === "unconfigured") {
    return (
      <InfoCallout>
        <strong className="text-amber-200">Score needs cloud data.</strong> Connect Turso (see Database section), sync
        your events, then try again.
      </InfoCallout>
    );
  }
  if (data.empty) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-zinc-400">{data.message || "No events in this time window."}</p>
        <ExpandableRaw data={data} />
      </div>
    );
  }
  const types = data.typeBreakdown ? Object.entries(data.typeBreakdown) : [];
  const programs = data.topPrograms ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-zinc-500">Co-activity score (v1)</p>
          <p className="mt-1 text-4xl font-bold tracking-tight text-white tabular-nums">{data.score ?? "—"}</p>
          <p className="mt-1 max-w-md text-xs text-zinc-500">
            Peak number of different fee-paying wallets in one {data.windowMinutes}-minute window (not proof of
            collusion).
          </p>
        </div>
        {data.peakBucketStartsIso ? (
          <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 px-4 py-3 text-sm">
            <span className="text-zinc-500">Busiest window started</span>
            <p className="mt-0.5 font-medium text-zinc-200">{data.peakBucketStartsIso}</p>
            <p className="text-xs text-zinc-500">{data.peakBucketWalletCount} wallets in that slice</p>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {types.map(([k, v]) => (
          <span
            key={k}
            className="rounded-full border border-zinc-700 bg-zinc-900/60 px-2.5 py-1 text-xs text-zinc-300"
          >
            {k}: <strong className="text-zinc-100">{v}</strong>
          </span>
        ))}
      </div>
      {data.drivers?.length ? (
        <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/40 px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">What this means</p>
        <ul className="mt-2 list-inside list-disc space-y-1.5 text-sm text-zinc-300">
            {data.drivers.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {programs.length > 0 ? (
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Common programs</p>
          <ul className="space-y-1.5 text-sm">
            {programs.slice(0, 5).map((p) => (
              <li key={p.program} className="flex justify-between gap-2 border-b border-zinc-800/50 py-1.5 last:border-0">
                <span className="truncate font-[family-name:var(--font-mono)] text-xs text-zinc-400">{p.program}</span>
                <span className="shrink-0 tabular-nums text-zinc-300">{p.count}×</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {data.limitation ? <p className="text-xs leading-relaxed text-zinc-600">{data.limitation}</p> : null}
      <ExpandableRaw data={data} />
    </div>
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
          <p className="text-xs font-semibold uppercase tracking-widest text-sky-500">Solana intelligence</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-white sm:text-4xl">ChainMind</h1>
          <p className="mt-3 max-w-2xl text-base leading-relaxed text-zinc-400">
            See whether the chain is reachable, browse recent activity for an address, and (when your cloud database is
            connected) run a simple co-activity score. Numbers here are clues for analysts — not legal findings.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={runPing}
              disabled={loading.ping}
              className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-sky-400 disabled:opacity-50"
            >
              {loading.ping ? "Checking…" : "Check connection"}
            </button>
            <button
              type="button"
              onClick={runDb}
              disabled={loading.db}
              className="rounded-lg border border-zinc-600 bg-zinc-900 px-4 py-2 text-sm font-semibold text-zinc-100 transition hover:bg-zinc-800 disabled:opacity-50"
            >
              {loading.db ? "Refreshing…" : "Refresh database"}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6">
        <Card
          title="Network status"
          subtitle="Live read from your configured Solana RPC"
          actions={
            <button
              type="button"
              onClick={runPing}
              className="text-xs font-medium text-sky-400 hover:text-sky-300"
            >
              Refresh
            </button>
          }
        >
          <PingBody data={ping} loading={!!loading.ping && ping == null} />
          {ping != null && loading.ping ? (
            <p className="mt-2 text-center text-xs text-zinc-500">Refreshing…</p>
          ) : null}
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card
            title="Address activity"
            subtitle="Recent transactions touching a wallet, token, or program"
            actions={
              <button
                type="button"
                onClick={runInspect}
                disabled={loading.inspect}
                className="rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 disabled:opacity-50"
              >
                {loading.inspect ? "Loading…" : "Load"}
              </button>
            }
          >
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1">
                <label className="mb-1 block text-xs font-medium text-zinc-500">Solana address (base58)</label>
                <input
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none ring-sky-500/30 focus:ring-2"
                  value={inspectAddr}
                  onChange={(e) => setInspectAddr(e.target.value)}
                  placeholder="Wallet, mint, or program id"
                  spellCheck={false}
                />
              </div>
              <div className="w-full sm:w-28">
                <label className="mb-1 block text-xs font-medium text-zinc-500">How many</label>
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
            <InspectBody data={inspect} loading={loading.inspect} />
          </Card>

          <Card
            title="Co-activity score"
            subtitle="Needs synced data · compares wallet activity in time buckets"
            actions={
              <button
                type="button"
                onClick={runScore}
                disabled={loading.score}
                className="rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 disabled:opacity-50"
              >
                {loading.score ? "Working…" : "Compute"}
              </button>
            }
          >
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <div className="sm:col-span-3">
                <label className="mb-1 block text-xs font-medium text-zinc-500">Scope (same as your token or wallet)</label>
                <input
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-2 focus:ring-sky-500/30"
                  value={scoreScope}
                  onChange={(e) => setScoreScope(e.target.value)}
                  spellCheck={false}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-500">Window (minutes)</label>
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
                <label className="mb-1 block text-xs font-medium text-zinc-500">Lookback (hours)</label>
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
            <ScoreBody data={score} loading={loading.score} />
          </Card>
        </div>

        <Card
          title="Your data (cloud)"
          subtitle="Counts after you sync from the ChainMind CLI"
          actions={
            <button type="button" onClick={runDb} className="text-xs font-medium text-sky-400 hover:text-sky-300">
              Refresh
            </button>
          }
        >
          <DbBody data={dbStats} loading={loading.db && dbStats == null} />
          {dbStats != null && loading.db ? (
            <p className="mt-2 text-center text-xs text-zinc-500">Refreshing…</p>
          ) : null}
        </Card>
      </main>

      <footer className="border-t border-zinc-800/80 py-8 text-center text-xs leading-relaxed text-zinc-600">
        <p>
          For faster, more reliable lookups, set <code className="text-zinc-500">SOLANA_RPC_URL</code> in Vercel. Raw API
          responses stay available under “Technical details” on each card.
        </p>
      </footer>
    </div>
  );
}
