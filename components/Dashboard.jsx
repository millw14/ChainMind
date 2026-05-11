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
    <section className="rounded-2xl border border-cm-border bg-cm-card/50 p-5 shadow-lg shadow-black/20 backdrop-blur-sm">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-cm-accent-bright">{title}</h2>
          {subtitle ? <p className="mt-1 text-sm text-cm-muted">{subtitle}</p> : null}
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
    <details className="mt-4 rounded-lg border border-cm-border bg-cm-surface/60">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-cm-faint hover:text-cm-muted">
        {label}
      </summary>
      <pre className="max-h-48 overflow-auto border-t border-cm-border p-3 font-[family-name:var(--font-mono)] text-[11px] leading-relaxed text-cm-muted">
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  );
}

function ErrorCallout({ message }) {
  return (
    <div className="rounded-lg border border-cm-bad/50 bg-cm-bad/15 px-4 py-3 text-sm text-cm-subtle">
      {message}
    </div>
  );
}

function InfoCallout({ children }) {
  return (
    <div className="rounded-lg border border-cm-warn/40 bg-cm-warn/10 px-4 py-3 text-sm leading-relaxed text-cm-subtle">
      {children}
    </div>
  );
}

function PingBody({ data, loading }) {
  if (loading) {
    return <p className="py-8 text-center text-sm text-cm-faint">Checking connection…</p>;
  }
  if (!data) {
    return <p className="py-8 text-center text-sm text-cm-faint">No data yet. Use Refresh.</p>;
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
        <span className="rounded-full bg-cm-ok/15 px-3 py-1 text-xs font-semibold text-cm-ok">
          Connected
        </span>
        <span className="text-xs text-cm-faint">{data.cluster}</span>
      </div>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-cm-border bg-cm-row/60 px-4 py-3">
          <dt className="text-xs text-cm-faint">Current slot</dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums text-cm-text">{data.slot?.toLocaleString?.() ?? data.slot}</dd>
        </div>
        <div className="rounded-xl border border-cm-border bg-cm-row/60 px-4 py-3">
          <dt className="text-xs text-cm-faint">Solana version</dt>
          <dd className="mt-1 text-lg font-semibold text-cm-text">{data.version ?? "—"}</dd>
        </div>
        <div className="rounded-xl border border-cm-border bg-cm-row/60 px-4 py-3 sm:col-span-2">
          <dt className="text-xs text-cm-faint">RPC endpoint (redacted)</dt>
          <dd className="mt-1 break-all font-[family-name:var(--font-mono)] text-sm text-cm-subtle">{data.rpcUrl}</dd>
          <p className="mt-1 text-xs text-cm-faint">
            Host: <span className="text-cm-muted">{rpcHost(data.rpcUrl)}</span>
          </p>
        </div>
      </dl>
      <ExpandableRaw data={data} />
    </div>
  );
}

function InspectBody({ data, loading }) {
  if (loading) {
    return <p className="py-8 text-center text-sm text-cm-faint">Loading transactions…</p>;
  }
  if (!data) {
    return <p className="py-8 text-center text-sm text-cm-faint">Enter an address and tap Load.</p>;
  }
  if (data.error || data.ok === false) {
    return <ErrorCallout message={data.error || "Request failed."} />;
  }
  const rows = data.signatures ?? [];
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-cm-faint">No recent signatures for this address.</p>;
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-cm-muted">
        Showing <strong className="text-cm-text">{rows.length}</strong> recent transactions
        {data.address ? (
          <>
            {" "}
            for <span className="font-[family-name:var(--font-mono)] text-xs text-cm-subtle">{shortSig(data.address)}</span>
          </>
        ) : null}
        .
      </p>
      <div className="overflow-x-auto rounded-xl border border-cm-border">
        <table className="w-full min-w-[32rem] text-left text-sm">
          <thead className="border-b border-cm-border bg-cm-row/80 text-xs font-medium uppercase tracking-wide text-cm-faint">
            <tr>
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">Slot</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">View</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cm-border">
            {rows.map((row) => {
              const ok = !row.err;
              return (
                <tr key={row.signature} className="bg-cm-row/30 hover:bg-cm-row-hover/55">
                  <td className="whitespace-nowrap px-3 py-2 text-cm-subtle">{formatTime(row.blockTime)}</td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-cm-muted">
                    {row.slot != null ? row.slot.toLocaleString() : "—"}
                  </td>
                  <td className="px-3 py-2">
                    {ok ? (
                      <span className="text-cm-ok/90">Succeeded</span>
                    ) : (
                      <span className="text-cm-warn/90" title={JSON.stringify(row.err)}>
                        Failed
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <a
                      href={solscanTx(row.signature)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-cm-accent-bright hover:text-cm-accent hover:underline"
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
    return <p className="py-8 text-center text-sm text-cm-faint">Loading database info…</p>;
  }
  if (!data) {
    return <p className="py-8 text-center text-sm text-cm-faint">No data yet.</p>;
  }
  if (data.error) {
    return <ErrorCallout message={data.error} />;
  }
  if (data.database === "unconfigured") {
    return (
      <div className="space-y-3">
        <InfoCallout>
          <strong className="text-cm-warn">Cloud database not connected.</strong> Charts and scores on this site use a
          small Turso database. After you run the pipeline on your computer, sync once with{" "}
          <code className="rounded bg-cm-elevated px-1 text-cm-warn/90">npm run turso:sync</code> and add Turso keys in
          Vercel. Until then, RPC checks and transaction lookup still work above.
        </InfoCallout>
        {data.hint ? <p className="text-xs text-cm-faint">{data.hint}</p> : null}
        <ExpandableRaw data={data} />
      </div>
    );
  }
  const scopes = data.byScope ?? [];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-cm-border bg-cm-row/60 px-4 py-3">
          <dt className="text-xs text-cm-faint">Signatures stored</dt>
          <dd className="mt-1 text-xl font-semibold tabular-nums text-cm-text">
            {(data.signaturesTotal ?? 0).toLocaleString()}
          </dd>
        </div>
        <div className="rounded-xl border border-cm-border bg-cm-row/60 px-4 py-3">
          <dt className="text-xs text-cm-faint">Parsed events</dt>
          <dd className="mt-1 text-xl font-semibold tabular-nums text-cm-text">
            {(data.eventsTotal ?? 0).toLocaleString()}
          </dd>
        </div>
        <div className="col-span-2 rounded-xl border border-cm-border bg-cm-row/60 px-4 py-3 sm:col-span-1">
          <dt className="text-xs text-cm-faint">Backend</dt>
          <dd className="mt-1 text-sm font-medium capitalize text-cm-text">{data.database ?? "—"}</dd>
        </div>
      </div>
      {scopes.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-cm-border">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-cm-border bg-cm-row/80 text-xs font-medium uppercase tracking-wide text-cm-faint">
              <tr>
                <th className="px-3 py-2">Scope address</th>
                <th className="px-3 py-2">Signatures</th>
                <th className="px-3 py-2">Events</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cm-border">
              {scopes.map((s) => (
                <tr key={s.scope} className="bg-cm-row/30">
                  <td className="max-w-[12rem] truncate px-3 py-2 font-[family-name:var(--font-mono)] text-xs text-cm-subtle">
                    {s.scope}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-cm-muted">{(s.signatures ?? 0).toLocaleString()}</td>
                  <td className="px-3 py-2 tabular-nums text-cm-muted">{(s.events ?? 0).toLocaleString()}</td>
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
    return <p className="py-8 text-center text-sm text-cm-faint">Computing…</p>;
  }
  if (!data) {
    return <p className="py-8 text-center text-sm text-cm-faint">Set a scope and tap Compute.</p>;
  }
  if (data.error) {
    return <ErrorCallout message={data.error} />;
  }
  if (data.database === "unconfigured") {
    return (
      <InfoCallout>
        <strong className="text-cm-warn">Score needs cloud data.</strong> Connect Turso (see Database section), sync
        your events, then try again.
      </InfoCallout>
    );
  }
  if (data.empty) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-cm-muted">{data.message || "No events in this time window."}</p>
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
          <p className="text-xs uppercase tracking-wide text-cm-faint">Co-activity score (v1)</p>
          <p className="mt-1 text-4xl font-bold tracking-tight text-cm-text tabular-nums">{data.score ?? "—"}</p>
          <p className="mt-1 max-w-md text-xs text-cm-faint">
            Peak number of different fee-paying wallets in one {data.windowMinutes}-minute window (not proof of
            collusion).
          </p>
        </div>
        {data.peakBucketStartsIso ? (
          <div className="rounded-xl border border-cm-border bg-cm-row/60 px-4 py-3 text-sm">
            <span className="text-cm-faint">Busiest window started</span>
            <p className="mt-0.5 font-medium text-cm-text">{data.peakBucketStartsIso}</p>
            <p className="text-xs text-cm-faint">{data.peakBucketWalletCount} wallets in that slice</p>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {types.map(([k, v]) => (
          <span
            key={k}
            className="rounded-full border border-cm-border bg-cm-elevated/60 px-2.5 py-1 text-xs text-cm-subtle"
          >
            {k}: <strong className="text-cm-text">{v}</strong>
          </span>
        ))}
      </div>
      {data.drivers?.length ? (
        <div className="rounded-xl border border-cm-border bg-cm-row/40 px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-cm-faint">What this means</p>
        <ul className="mt-2 list-inside list-disc space-y-1.5 text-sm text-cm-subtle">
            {data.drivers.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {programs.length > 0 ? (
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-cm-faint">Common programs</p>
          <ul className="space-y-1.5 text-sm">
            {programs.slice(0, 5).map((p) => (
              <li key={p.program} className="flex justify-between gap-2 border-b border-cm-border/50 py-1.5 last:border-0">
                <span className="truncate font-[family-name:var(--font-mono)] text-xs text-cm-muted">{p.program}</span>
                <span className="shrink-0 tabular-nums text-cm-subtle">{p.count}×</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {data.limitation ? <p className="text-xs leading-relaxed text-cm-faint">{data.limitation}</p> : null}
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
    <div className="pb-16">
      <div className="border-b border-cm-border-subtle bg-cm-elevated/40">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-end gap-2 px-4 py-3 sm:px-6">
          <button
            type="button"
            onClick={runPing}
            disabled={loading.ping}
            className="rounded-lg border border-cm-border bg-cm-elevated px-3 py-2 text-xs font-semibold text-cm-text hover:bg-cm-card disabled:opacity-50"
          >
            {loading.ping ? "Checking…" : "Refresh network"}
          </button>
          <button
            type="button"
            onClick={runDb}
            disabled={loading.db}
            className="rounded-lg border border-cm-border bg-cm-elevated px-3 py-2 text-xs font-semibold text-cm-text hover:bg-cm-card disabled:opacity-50"
          >
            {loading.db ? "Refreshing…" : "Refresh database"}
          </button>
        </div>
      </div>

      <main className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6">
        <Card
          title="Network status"
          subtitle="Live read from your configured Solana RPC"
          actions={
            <button
              type="button"
              onClick={runPing}
              className="text-xs font-medium text-cm-accent-bright hover:text-cm-accent"
            >
              Refresh
            </button>
          }
        >
          <PingBody data={ping} loading={!!loading.ping && ping == null} />
          {ping != null && loading.ping ? (
            <p className="mt-2 text-center text-xs text-cm-faint">Refreshing…</p>
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
                className="rounded-lg bg-cm-accent px-3 py-1.5 text-xs font-semibold text-cm-on-accent transition hover:bg-cm-accent-bright disabled:opacity-50"
              >
                {loading.inspect ? "Loading…" : "Load"}
              </button>
            }
          >
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1">
                <label className="mb-1 block text-xs font-medium text-cm-faint">Solana address (base58)</label>
                <input
                  className="w-full rounded-lg border border-cm-border bg-cm-surface px-3 py-2 text-sm text-cm-text outline-none ring-cm-accent-ring focus:ring-2"
                  value={inspectAddr}
                  onChange={(e) => setInspectAddr(e.target.value)}
                  placeholder="Wallet, mint, or program id"
                  spellCheck={false}
                />
              </div>
              <div className="w-full sm:w-28">
                <label className="mb-1 block text-xs font-medium text-cm-faint">How many</label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  className="w-full rounded-lg border border-cm-border bg-cm-surface px-3 py-2 text-sm text-cm-text outline-none focus:ring-2 focus:ring-cm-accent-ring"
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
                className="rounded-lg bg-cm-accent px-3 py-1.5 text-xs font-semibold text-cm-on-accent transition hover:bg-cm-accent-bright disabled:opacity-50"
              >
                {loading.score ? "Working…" : "Compute"}
              </button>
            }
          >
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <div className="sm:col-span-3">
                <label className="mb-1 block text-xs font-medium text-cm-faint">Scope (same as your token or wallet)</label>
                <input
                  className="w-full rounded-lg border border-cm-border bg-cm-surface px-3 py-2 text-sm text-cm-text outline-none focus:ring-2 focus:ring-cm-accent-ring"
                  value={scoreScope}
                  onChange={(e) => setScoreScope(e.target.value)}
                  spellCheck={false}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-cm-faint">Window (minutes)</label>
                <input
                  type="number"
                  min={1}
                  max={60}
                  className="w-full rounded-lg border border-cm-border bg-cm-surface px-3 py-2 text-sm text-cm-text outline-none focus:ring-2 focus:ring-cm-accent-ring"
                  value={scoreWindow}
                  onChange={(e) => setScoreWindow(e.target.value)}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-cm-faint">Lookback (hours)</label>
                <input
                  type="number"
                  min={1}
                  max={720}
                  className="w-full rounded-lg border border-cm-border bg-cm-surface px-3 py-2 text-sm text-cm-text outline-none focus:ring-2 focus:ring-cm-accent-ring"
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
            <button type="button" onClick={runDb} className="text-xs font-medium text-cm-accent-bright hover:text-cm-accent">
              Refresh
            </button>
          }
        >
          <DbBody data={dbStats} loading={loading.db && dbStats == null} />
          {dbStats != null && loading.db ? (
            <p className="mt-2 text-center text-xs text-cm-faint">Refreshing…</p>
          ) : null}
        </Card>
      </main>
    </div>
  );
}
