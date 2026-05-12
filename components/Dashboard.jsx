"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertStrip,
  buildAlerts,
  CoordinationTimeline,
  deriveRiskProfile,
  inspectFallbackGraph,
  IntelDocsHint,
  LiveActivityFeed,
  RiskHero,
  RpcActivityTimeline,
  WalletGraphSvg,
} from "@/components/dashboard/intel-widgets";

const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const INSPECT_DEBOUNCE_MS = 350;
const LIVE_POLL_MS = 42_000;

function solscanTx(signature) {
  return `https://solscan.io/tx/${signature}`;
}

function shortSig(s) {
  if (!s || s.length < 12) return s || "—";
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function Card({ title, subtitle, children, actions }) {
  return (
    <section className="rounded-md border border-cm-border bg-cm-surface p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3 border-b border-cm-border-subtle pb-3">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-cm-faint">{title}</h2>
          {subtitle ? <p className="mt-1 text-xs text-cm-muted">{subtitle}</p> : null}
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
    <details className="mt-4 rounded-md border border-cm-border bg-cm-surface/60">
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
    <div className="rounded-md border border-cm-bad/50 bg-cm-bad/15 px-4 py-3 text-sm text-cm-subtle">
      {message}
    </div>
  );
}

function InfoCallout({ children }) {
  return (
    <div className="rounded-md border border-cm-warn/40 bg-cm-warn/10 px-4 py-3 text-sm leading-relaxed text-cm-subtle">
      {children}
    </div>
  );
}

function InspectBody({ data, loading, hasFocus, solscanTx }) {
  if (!hasFocus) {
    return (
      <p className="py-8 text-center text-sm text-cm-faint">
        Add a token, wallet, or program in <strong className="font-medium text-cm-muted">Watchlist target</strong>{" "}
        above—recent activity fills in automatically.
      </p>
    );
  }
  if (!data && !loading) {
    return (
      <p className="py-8 text-center text-sm text-cm-faint">
        Recent transactions for your focus address load on their own. If this stays empty, check the address above or
        click Refresh feed.
      </p>
    );
  }
  if (data && (data.error || data.ok === false)) {
    return <ErrorCallout message={data.error || "GET /api/inspect failed (no error body)."} />;
  }
  const rows = data?.signatures ?? [];
  if (!loading && rows.length === 0 && data?.ok) {
    return <p className="py-6 text-center text-sm text-cm-faint">RPC returned zero signatures for this address / limit.</p>;
  }
  return (
    <div className="space-y-3">
      <LiveActivityFeed rows={rows} loading={loading} solscanTx={solscanTx} />
      {data?.ok ? <ExpandableRaw label="Raw RPC sample (JSON)" data={data} /> : null}
    </div>
  );
}

function DbBody({ data, loading }) {
  if (loading) {
    return <p className="py-8 text-center text-sm text-cm-faint">Loading synced counts…</p>;
  }
  if (!data) {
    return <p className="py-8 text-center text-sm text-cm-faint">No counts yet. Refresh synced data.</p>;
  }
  if (data.error) {
    return <ErrorCallout message={data.error} />;
  }
  if (data.database === "unconfigured") {
    return (
      <div className="space-y-3">
        <InfoCallout>
          <strong className="text-cm-warn">Synced events not connected.</strong> Hosted counts and the coordination
          score need cloud storage wired from your machine. Follow{" "}
          <Link href="/docs" className="font-medium text-cm-text underline underline-offset-2 hover:text-cm-accent">
            Docs
          </Link>{" "}
          to connect and run a sync—live network and recent activity above still work without it.
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
        <div className="rounded-md border border-cm-border bg-cm-row/60 px-4 py-3">
          <dt className="text-xs text-cm-faint">Signatures stored</dt>
          <dd className="mt-1 text-xl font-semibold tabular-nums text-cm-text">
            {(data.signaturesTotal ?? 0).toLocaleString()}
          </dd>
        </div>
        <div className="rounded-md border border-cm-border bg-cm-row/60 px-4 py-3">
          <dt className="text-xs text-cm-faint">Parsed events</dt>
          <dd className="mt-1 text-xl font-semibold tabular-nums text-cm-text">
            {(data.eventsTotal ?? 0).toLocaleString()}
          </dd>
        </div>
        <div className="col-span-2 rounded-md border border-cm-border bg-cm-row/60 px-4 py-3 sm:col-span-1">
          <dt className="text-xs text-cm-faint">Store</dt>
          <dd className="mt-1 text-sm font-medium capitalize text-cm-text">{data.database ?? "—"}</dd>
        </div>
      </div>
      {scopes.length > 0 ? (
        <div className="overflow-x-auto rounded-md border border-cm-border">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-cm-border bg-cm-row/80 text-xs font-medium uppercase tracking-wide text-cm-faint">
              <tr>
                <th className="px-3 py-2">Tracked address</th>
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
      <p className="mt-4 text-xs leading-relaxed text-cm-faint">
        Funding-graph clustering, named pattern detectors, and exportable case files are on the roadmap—today these
        counts feed the coordination score and raw JSON below.
      </p>
      <ExpandableRaw data={data} />
    </div>
  );
}

function ScoreBody({ data, loading, hideMainScore }) {
  if (loading) {
    return <p className="py-8 text-center text-sm text-cm-faint">Computing coordination score…</p>;
  }
  if (!data) {
    return <p className="py-8 text-center text-sm text-cm-faint">Adjust lookback below; analysis runs automatically.</p>;
  }
  if (data.error) {
    return <ErrorCallout message={data.error} />;
  }
  if (data.database === "unconfigured") {
    return (
      <InfoCallout>
        <strong className="text-cm-warn">Coordination score needs synced events.</strong> Connect cloud storage and sync
        from your machine—see{" "}
        <Link href="/docs" className="font-medium text-cm-text underline underline-offset-2 hover:text-cm-accent">
          Docs
        </Link>
        .
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
      {!hideMainScore ? (
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-cm-faint">Coordination score (v1)</p>
            <p className="mt-1 text-4xl font-bold tracking-tight text-cm-text tabular-nums">{data.score ?? "—"}</p>
            <p className="mt-1 max-w-md text-xs text-cm-faint">
              Peak distinct fee-paying wallets in one {data.windowMinutes}-minute slice—dense windows deserve a second
              look before the tape catches up.
            </p>
          </div>
          {data.peakBucketStartsIso ? (
            <div className="rounded-md border border-cm-border bg-cm-row/60 px-4 py-3 text-sm">
              <span className="text-cm-faint">Busiest window started</span>
              <p className="mt-0.5 font-medium text-cm-text">{data.peakBucketStartsIso}</p>
              <p className="text-xs text-cm-faint">{data.peakBucketWalletCount} wallets in that slice</p>
            </div>
          ) : null}
        </div>
      ) : null}
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
        <div className="rounded-md border border-cm-border bg-cm-row/40 px-4 py-3">
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

function BriefBody({ text, error, loading }) {
  if (loading) {
    return <p className="py-8 text-center text-sm text-cm-faint">Generating brief…</p>;
  }
  if (error) {
    return <ErrorCallout message={error} />;
  }
  if (!text) {
    return (
      <p className="text-sm text-cm-muted">
        Optional AI summary of what&apos;s loaded above—enable in your environment using{" "}
        <Link href="/docs" className="font-medium text-cm-text underline underline-offset-2 hover:text-cm-accent">
          Docs
        </Link>
        . Load panels first, then Generate brief.
      </p>
    );
  }
  return (
    <div className="rounded-md border border-cm-border-subtle bg-cm-row/30 px-4 py-3">
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-cm-subtle">{text}</p>
    </div>
  );
}

export function Dashboard() {
  const [ping, setPing] = useState(null);
  const [focusAddress, setFocusAddress] = useState(USDC_MAINNET);
  const [inspectLimit, setInspectLimit] = useState("12");
  const [inspect, setInspect] = useState(null);

  const [scoreWindow, setScoreWindow] = useState("5");
  const [scoreHours, setScoreHours] = useState("168");
  const [score, setScore] = useState(null);

  const [dbStats, setDbStats] = useState(null);

  const [groqBrief, setGroqBrief] = useState(null);
  const [groqErr, setGroqErr] = useState(null);

  const [loading, setLoading] = useState({});
  const [loadingGroq, setLoadingGroq] = useState(false);

  const setLoad = (key, v) => setLoading((s) => ({ ...s, [key]: v }));

  const fetchJson = useCallback(async (url, key) => {
    setLoad(key, true);
    try {
      const r = await fetch(url);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const fromBody = typeof j?.error === "string" ? j.error : null;
        const statusLine = [r.status, r.statusText].filter(Boolean).join(" ").trim();
        throw new Error(fromBody || statusLine || "HTTP error");
      }
      return j;
    } finally {
      setLoad(key, false);
    }
  }, []);

  const runPing = useCallback(async () => {
    try {
      setPing(await fetchJson("/api/ping", "ping"));
    } catch (e) {
      setPing({ error: String(e.message) });
    }
  }, [fetchJson]);

  const runInspect = useCallback(async () => {
    const a = focusAddress.trim();
    if (!a) return;
    const u = `/api/inspect?address=${encodeURIComponent(a)}&limit=${encodeURIComponent(inspectLimit || "12")}`;
    try {
      setInspect(await fetchJson(u, "inspect"));
    } catch (e) {
      setInspect({ ok: false, error: String(e.message) });
    }
  }, [focusAddress, inspectLimit, fetchJson]);

  const runDb = useCallback(async () => {
    try {
      setDbStats(await fetchJson("/api/db-stats", "db"));
    } catch (e) {
      setDbStats({ ok: false, error: String(e.message) });
    }
  }, [fetchJson]);

  const runScore = useCallback(async () => {
    const s = focusAddress.trim();
    if (!s) return;
    const u = `/api/score?scope=${encodeURIComponent(s)}&window=${encodeURIComponent(scoreWindow || "5")}&hours=${encodeURIComponent(scoreHours || "24")}`;
    try {
      setScore(await fetchJson(u, "score"));
    } catch (e) {
      setScore({ ok: false, error: String(e.message) });
    }
  }, [focusAddress, scoreWindow, scoreHours, fetchJson]);

  useEffect(() => {
    void runPing();
    void runDb();
  }, [runPing, runDb]);

  useEffect(() => {
    const a = focusAddress.trim();
    if (!a) {
      setInspect(null);
      setLoad("inspect", false);
      return;
    }
    setLoad("inspect", true);
    const id = setTimeout(() => {
      void runInspect();
    }, INSPECT_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [focusAddress, inspectLimit, runInspect]);

  useEffect(() => {
    const a = focusAddress.trim();
    if (!a) {
      setScore(null);
      return;
    }
    const id = setTimeout(() => {
      void runScore();
    }, INSPECT_DEBOUNCE_MS + 120);
    return () => clearTimeout(id);
  }, [focusAddress, scoreWindow, scoreHours, runScore]);

  useEffect(() => {
    const a = focusAddress.trim();
    if (!a) return;
    const tick = () => {
      void runInspect();
      void runPing();
      void runDb();
      void runScore();
    };
    const id = setInterval(tick, LIVE_POLL_MS);
    return () => clearInterval(id);
  }, [focusAddress, runInspect, runPing, runDb, runScore]);

  const intelAlerts = useMemo(() => buildAlerts({ inspect, score, ping }), [inspect, score, ping]);
  const risk = useMemo(() => deriveRiskProfile(score), [score]);
  const walletGraphVisual = useMemo(() => {
    if (score?.walletGraph?.nodes?.length > 1) return score.walletGraph;
    return inspectFallbackGraph(focusAddress.trim(), inspect?.ok ? inspect.signatures : null);
  }, [score?.walletGraph, focusAddress, inspect?.ok, inspect?.signatures]);

  const runBrief = async () => {
    setGroqErr(null);
    setLoadingGroq(true);
    try {
      const snapshot = {
        generatedAt: new Date().toISOString(),
        network: ping,
        focusAddress: focusAddress.trim(),
        inspect: { limit: inspectLimit, result: inspect },
        score: {
          windowMinutes: scoreWindow,
          lookbackHours: scoreHours,
          result: score,
        },
        database: dbStats,
      };
      const r = await fetch("/api/groq-brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: snapshot,
          focus: "Solana coordination signals from ChainMind panels—hypotheses for analyst follow-up.",
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = typeof j?.error === "string" ? j.error : [r.status, r.statusText].filter(Boolean).join(" ").trim();
        throw new Error(msg || "Brief request failed");
      }
      setGroqBrief(j.text ?? "");
    } catch (e) {
      setGroqBrief(null);
      setGroqErr(String(e.message));
    } finally {
      setLoadingGroq(false);
    }
  };

  return (
    <div className="pb-20">
      <div className="border-b border-cm-border bg-cm-surface/95">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex flex-wrap items-center gap-3">
            <span className="relative flex h-2.5 w-2.5 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cm-ok opacity-40" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-cm-ok" />
            </span>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-cm-faint">Live operations</p>
              <p className="text-xs text-cm-muted">
                {ping?.error ? (
                  <span className="text-cm-bad">RPC fault — retry refresh</span>
                ) : ping?.ok ? (
                  <>
                    <span className="text-cm-text">{ping.cluster}</span>
                    <span className="text-cm-faint"> · slot </span>
                    <span className="tabular-nums text-cm-text">{ping.slot?.toLocaleString?.() ?? ping.slot}</span>
                  </>
                ) : (
                  "Warming RPC endpoint…"
                )}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={runPing}
              disabled={loading.ping}
              className="rounded-md border border-cm-border bg-cm-elevated px-3 py-2 text-xs font-medium text-cm-text hover:bg-cm-row-hover disabled:opacity-50"
            >
              {loading.ping ? "RPC…" : "Refresh RPC"}
            </button>
            <button
              type="button"
              onClick={runDb}
              disabled={loading.db}
              className="rounded-md border border-cm-border bg-cm-elevated px-3 py-2 text-xs font-medium text-cm-text hover:bg-cm-row-hover disabled:opacity-50"
            >
              {loading.db ? "Sync…" : "Sync stats"}
            </button>
          </div>
        </div>
      </div>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
        <AlertStrip alerts={intelAlerts} />

        <Card
          title="Watchlist target"
          subtitle="One mint, wallet, or program — every panel keys off this address."
        >
          <label className="mb-1 block text-xs font-medium text-cm-faint">Solana address</label>
          <input
            className="w-full rounded-md border border-cm-border bg-cm-surface px-3 py-2 text-sm text-cm-text outline-none ring-cm-accent-ring focus:ring-2"
            value={focusAddress}
            onChange={(e) => setFocusAddress(e.target.value)}
            placeholder="Token (mint), wallet, or program id"
            spellCheck={false}
            autoComplete="off"
          />
        </Card>

        <div className="grid gap-6 lg:grid-cols-12">
          <div className="space-y-6 lg:col-span-7">
            <Card
              title="Live activity feed"
              subtitle="RPC-backed tail · auto refresh on an interval"
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  <span className="hidden text-[10px] text-cm-faint sm:inline">{LIVE_POLL_MS / 1000}s poll</span>
                  <button
                    type="button"
                    onClick={runInspect}
                    disabled={loading.inspect}
                    className="rounded-md bg-cm-accent px-3 py-1.5 text-xs font-semibold text-cm-on-accent transition hover:bg-cm-accent-bright disabled:opacity-50"
                  >
                    {loading.inspect ? "Refreshing…" : "Refresh feed"}
                  </button>
                </div>
              }
            >
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="w-full sm:w-28">
                  <label className="mb-1 block text-xs font-medium text-cm-faint">Sample depth</label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    className="w-full rounded-md border border-cm-border bg-cm-surface px-3 py-2 text-sm text-cm-text outline-none focus:ring-2 focus:ring-cm-accent-ring"
                    value={inspectLimit}
                    onChange={(e) => setInspectLimit(e.target.value)}
                  />
                </div>
              </div>
              <InspectBody
                data={inspect}
                loading={loading.inspect}
                hasFocus={Boolean(focusAddress.trim())}
                solscanTx={solscanTx}
              />
            </Card>
          </div>

          <div className="space-y-6 lg:col-span-5">
            <RiskHero profile={risk} scopeLabel={shortSig(focusAddress.trim()) || "—"} />

            <Card
              title="Wallet graph"
              subtitle="Top fee payers linked to your scope — falls back to live tx satellites without Turso."
            >
              <WalletGraphSvg graph={walletGraphVisual} />
              <IntelDocsHint />
            </Card>

            <Card title="Coordination timeline" subtitle="Payer density by bucket, or RPC confirmation markers.">
              {score?.timelineBuckets?.length ? (
                <CoordinationTimeline buckets={score.timelineBuckets} />
              ) : (
                <RpcActivityTimeline signatures={inspect?.signatures} />
              )}
            </Card>

            <Card
              title="Coordination analysis"
              subtitle="Windowed scan of ingested events — refreshes with live polling"
              actions={
                <button
                  type="button"
                  onClick={runScore}
                  disabled={loading.score}
                  className="rounded-md bg-cm-accent px-3 py-1.5 text-xs font-semibold text-cm-on-accent transition hover:bg-cm-accent-bright disabled:opacity-50"
                >
                  {loading.score ? "Scanning…" : "Rescan now"}
                </button>
              }
            >
              <div className="mb-4 grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-cm-faint">Window (minutes)</label>
                  <input
                    type="number"
                    min={1}
                    max={60}
                    className="w-full rounded-md border border-cm-border bg-cm-surface px-3 py-2 text-sm text-cm-text outline-none focus:ring-2 focus:ring-cm-accent-ring"
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
                    className="w-full rounded-md border border-cm-border bg-cm-surface px-3 py-2 text-sm text-cm-text outline-none focus:ring-2 focus:ring-cm-accent-ring"
                    value={scoreHours}
                    onChange={(e) => setScoreHours(e.target.value)}
                  />
                </div>
              </div>
              <ScoreBody data={score} loading={loading.score} hideMainScore />
            </Card>
          </div>
        </div>

        <Card
          title="Synced corpus"
          subtitle="Mirrored signatures and parsed events in cloud storage."
          actions={
            <button type="button" onClick={runDb} className="text-xs font-medium text-cm-muted hover:text-cm-text">
              Refresh
            </button>
          }
        >
          <DbBody data={dbStats} loading={loading.db && dbStats == null} />
          {dbStats != null && loading.db ? (
            <p className="mt-2 text-center text-xs text-cm-faint">Refreshing synced counts…</p>
          ) : null}
        </Card>

        <Card
          title="Analyst brief"
          subtitle="Optional narrative across everything loaded — enable in Docs."
          actions={
            <button
              type="button"
              onClick={runBrief}
              disabled={loadingGroq}
              className="rounded-md border border-cm-border bg-cm-elevated px-3 py-1.5 text-xs font-semibold text-cm-text hover:bg-cm-row-hover disabled:opacity-50"
            >
              {loadingGroq ? "Generating…" : "Generate brief"}
            </button>
          }
        >
          <BriefBody text={groqBrief} error={groqErr} loading={loadingGroq} />
        </Card>
      </main>
    </div>
  );
}
