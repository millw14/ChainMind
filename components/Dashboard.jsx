"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { buildGroqEvidence } from "@/lib/groq-evidence.js";
import { GROQ_BRIEF_USER_FOCUS } from "@/lib/groq-brief-defaults.js";
import { staggerContainer, fadeUp, springGentle } from "@/components/motion/presets";

const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const INSPECT_DEBOUNCE_MS = 350;
const LIVE_POLL_MS = 42_000;
/** Minimum time between successful Groq reasoning calls (limits API usage during live polling). */
const GROQ_REASONING_MIN_INTERVAL_MS = 90_000;
function solscanTx(signature) {
  return `https://solscan.io/tx/${signature}`;
}

function shortSig(s) {
  if (!s || s.length < 12) return s || "—";
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function Panel({ kicker, title, subtitle, children, actions }) {
  return (
    <section className="cm-panel-edge rounded-md border border-cm-border bg-cm-surface/95 shadow-cm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-cm-border-subtle px-4 py-3 sm:px-5">
        <div className="min-w-0">
          {kicker ? (
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-cm-faint">{kicker}</p>
          ) : null}
          <h2 className={`text-sm font-semibold tracking-tight text-cm-text ${kicker ? "mt-1" : ""}`}>{title}</h2>
          {subtitle ? <p className="mt-1 text-xs text-cm-muted">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      <div className="p-4 sm:p-5">{children}</div>
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
      <p className="py-10 text-center font-mono text-xs text-cm-faint">
        Set a <span className="text-cm-muted">watch target</span> below — signatures stream here automatically.
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
      <p className="mt-4 border-t border-cm-border-subtle pt-4 font-mono text-[10px] leading-relaxed text-cm-faint">
        Funding-graph clustering and exportable case bundles ship next — counts below feed coordination scoring today.
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
      {data.limitation ? (
        <details className="mt-3 rounded border border-cm-border-subtle bg-cm-row/30">
          <summary className="cursor-pointer px-3 py-2 font-mono text-[10px] text-cm-faint hover:text-cm-muted">
            Interpretation note (expand)
          </summary>
          <p className="border-t border-cm-border-subtle px-3 py-2 text-xs leading-relaxed text-cm-muted">{data.limitation}</p>
        </details>
      ) : null}
      <ExpandableRaw data={data} />
    </div>
  );
}

const verdictStyle = {
  manipulation_detected: "bg-cm-threat/20 text-cm-bad ring-1 ring-cm-bad/35",
  suspicious: "bg-cm-warn/15 text-cm-warn ring-1 ring-cm-warn/30",
  clean: "bg-cm-ok/15 text-cm-ok ring-1 ring-cm-ok/25",
};

const riskStyle = {
  critical: "text-cm-bad",
  high: "text-orange-300",
  medium: "text-cm-warn",
  low: "text-cm-muted",
};

/**
 * @param {{ analysis: Record<string, unknown> | null, error: string | null, loading: boolean, webhookMeta?: object | null }} props
 */
function BriefBody({ analysis, error, loading, webhookMeta }) {
  if (loading) {
    return <p className="py-8 text-center text-sm text-cm-faint">Running ChainMind analyst…</p>;
  }
  if (error) {
    return <ErrorCallout message={error} />;
  }
  if (!analysis) {
    return (
      <p className="text-sm text-cm-muted">
        Live reasoning runs when panels have data (requires{" "}
        <code className="text-cm-accent-bright">GROQ_API_KEY</code>
        ). Analysis refreshes as the{" "}
        <span className="font-mono text-cm-muted">{(LIVE_POLL_MS / 1000).toFixed(0)}s</span> sweep updates
        evidence—at most about every {Math.ceil(GROQ_REASONING_MIN_INTERVAL_MS / 60_000)} minutes per scope. Webhooks:
        {" "}
        <Link href="/docs" className="font-medium text-cm-text underline underline-offset-2 hover:text-cm-accent">
          Docs
        </Link>
        .
      </p>
    );
  }

  const verdict = typeof analysis.verdict === "string" ? analysis.verdict : "—";
  const confidence =
    typeof analysis.confidence === "number" && Number.isFinite(analysis.confidence)
      ? analysis.confidence
      : null;
  const manipulationType =
    typeof analysis.manipulation_type === "string" ? analysis.manipulation_type : "none";
  const riskLevel = typeof analysis.risk_level === "string" ? analysis.risk_level : "—";
  const reasoning = Array.isArray(analysis.reasoning) ? analysis.reasoning : [];
  const nextSteps = Array.isArray(analysis.next_steps) ? analysis.next_steps : [];
  const confidenceReasoning =
    typeof analysis.confidence_reasoning === "string" ? analysis.confidence_reasoning.trim() : "";
  const namedEntities = Array.isArray(analysis.named_entities) ? analysis.named_entities : [];
  const manipulationVsBenign =
    typeof analysis.manipulation_vs_benign === "string" ? analysis.manipulation_vs_benign.trim() : "";

  const vClass = verdictStyle[verdict] ?? "bg-cm-row text-cm-muted ring-1 ring-cm-border";
  const rClass = riskStyle[riskLevel] ?? "text-cm-muted";

  return (
    <div className="space-y-4 rounded-md border border-cm-border-subtle bg-cm-row/30 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide ${vClass}`}
        >
          {verdict.replace(/_/g, " ")}
        </span>
        {confidence != null ? (
          <span className="font-mono text-xs tabular-nums text-cm-subtle">
            Confidence {(confidence * 100).toFixed(0)}%
          </span>
        ) : null}
        <span className="font-mono text-[10px] uppercase tracking-wider text-cm-faint">·</span>
        {manipulationType !== "none" ? (
          <>
            <span className="font-mono text-[10px] uppercase tracking-wider text-cm-muted">
              {manipulationType.replace(/_/g, " ")}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-wider text-cm-faint">·</span>
          </>
        ) : null}
        <span className={`font-mono text-[10px] font-bold uppercase tracking-wider ${rClass}`}>
          {riskLevel} risk
        </span>
      </div>
      {confidenceReasoning ? (
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-wide text-cm-faint">
            Confidence calibration
          </p>
          <p className="mt-2 text-sm leading-relaxed text-cm-subtle">{confidenceReasoning}</p>
        </div>
      ) : null}
      {namedEntities.length > 0 ? (
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-wide text-cm-faint">
            Named entities
          </p>
          <ul className="mt-2 list-inside list-disc space-y-1 font-[family-name:var(--font-mono)] text-[11px] leading-relaxed text-cm-accent-bright/95 break-all">
            {namedEntities.map((line, i) => (
              <li key={i}>{String(line)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {manipulationVsBenign ? (
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-wide text-cm-faint">
            Manipulation vs benign
          </p>
          <p className="mt-2 text-sm leading-relaxed text-cm-muted">{manipulationVsBenign}</p>
        </div>
      ) : null}
      {!confidenceReasoning && reasoning.length > 0 ? (
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-wide text-cm-faint">Reasoning</p>
          <ul className="mt-2 list-inside list-disc space-y-1.5 text-sm leading-relaxed text-cm-subtle">
            {reasoning.map((line, i) => (
              <li key={i}>{String(line)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {nextSteps.length > 0 ? (
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-wide text-cm-faint">
            Next steps
          </p>
          <ol className="mt-2 list-inside list-decimal space-y-1.5 text-sm leading-relaxed text-cm-accent-bright/90">
            {nextSteps.map((line, i) => (
              <li key={i}>{String(line)}</li>
            ))}
          </ol>
        </div>
      ) : null}
      {webhookMeta?.attempted && webhookMeta?.delivered ? (
        <p className="border-t border-cm-border-subtle pt-3 font-mono text-[10px] text-cm-terminal">
          Investigation webhook POST succeeded (high-confidence auto verdict).
        </p>
      ) : null}
      {webhookMeta?.attempted && webhookMeta?.skipped ? (
        <p className="border-t border-cm-border-subtle pt-3 font-mono text-[10px] text-cm-faint">
          High-confidence auto verdict — set{" "}
          <code className="text-cm-muted">CHAINMIND_VERDICT_WEBHOOK_URL</code> to notify Slack or your SOAR stack.
        </p>
      ) : null}
      {webhookMeta?.error ? (
        <p className="border-t border-cm-border-subtle pt-3 font-mono text-[10px] text-cm-bad">
          Webhook error: {String(webhookMeta.error)}
        </p>
      ) : null}
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

  const [groqAnalysis, setGroqAnalysis] = useState(null);
  const [groqErr, setGroqErr] = useState(null);
  const [groqWebhookMeta, setGroqWebhookMeta] = useState(null);

  const groqLastReasoningAtRef = useRef(0);
  const groqAutoInFlightRef = useRef(false);

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

  const runAllSync = useCallback(async () => {
    await runPing();
    await runDb();
    await runInspect();
    await runScore();
  }, [runPing, runDb, runInspect, runScore]);

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
      void runAllSync();
    };
    const id = setInterval(tick, LIVE_POLL_MS);
    return () => clearInterval(id);
  }, [focusAddress, runAllSync]);

  const intelAlerts = useMemo(() => buildAlerts({ inspect, score, ping }), [inspect, score, ping]);
  const risk = useMemo(() => deriveRiskProfile(score), [score]);

  const groqEvidence = useMemo(() => {
    const addr = focusAddress.trim();
    if (!addr) return null;
    return {
      ...buildGroqEvidence({
        address: focusAddress,
        score,
        inspect,
        risk,
      }),
      rpcCluster: ping?.ok ? { cluster: ping.cluster, slot: ping.slot } : { error: ping?.error ?? "RPC unknown" },
      inspectLimit: Number(inspectLimit) || null,
      automatedAlerts: intelAlerts.map((a) => ({
        severity: a.severity,
        title: a.title,
        detail: a.detail,
      })),
    };
  }, [focusAddress, score, inspect, risk, ping, inspectLimit, intelAlerts]);

  const runGroqAnalysis = useCallback(
    async (source) => {
      if (!groqEvidence?.address) return null;
      const r = await fetch("/api/groq-brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: groqEvidence,
          source,
          focus: GROQ_BRIEF_USER_FOCUS,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = typeof j?.error === "string" ? j.error : [r.status, r.statusText].filter(Boolean).join(" ").trim();
        throw new Error(msg || "Brief request failed");
      }
      return j;
    },
    [groqEvidence],
  );

  const runGroqAuto = useCallback(async () => {
    if (groqAutoInFlightRef.current || !groqEvidence?.address) return;
    const now = Date.now();
    if (
      groqLastReasoningAtRef.current !== 0 &&
      now - groqLastReasoningAtRef.current < GROQ_REASONING_MIN_INTERVAL_MS
    ) {
      return;
    }
    groqAutoInFlightRef.current = true;
    setLoadingGroq(true);
    setGroqErr(null);
    try {
      const j = await runGroqAnalysis("auto");
      if (j) {
        groqLastReasoningAtRef.current = Date.now();
        setGroqAnalysis(j.analysis ?? null);
        setGroqWebhookMeta(j.webhook ?? null);
      }
    } catch (e) {
      console.warn("[dashboard] groq auto", e);
      setGroqErr(`Reasoning failed: ${String(e.message)}`);
    } finally {
      setLoadingGroq(false);
      groqAutoInFlightRef.current = false;
    }
  }, [runGroqAnalysis, groqEvidence?.address]);

  const walletGraphVisual = useMemo(() => {
    if (score?.walletGraph?.nodes?.length > 1) return score.walletGraph;
    return inspectFallbackGraph(focusAddress.trim(), inspect?.ok ? inspect.signatures : null);
  }, [score?.walletGraph, focusAddress, inspect?.ok, inspect?.signatures]);

  useEffect(() => {
    groqLastReasoningAtRef.current = 0;
  }, [focusAddress]);

  useEffect(() => {
    if (!groqEvidence?.address || loading.inspect || loading.score) return;
    const id = setTimeout(() => {
      void runGroqAuto();
    }, 900);
    return () => clearTimeout(id);
  }, [groqEvidence, loading.inspect, loading.score, runGroqAuto]);

  const syncing = Boolean(loading.ping || loading.db || loading.inspect || loading.score);
  const reduceMotion = useReducedMotion() ?? false;
  const mainStagger = staggerContainer(reduceMotion, { stagger: 0.06, delayChildren: 0.03 });
  const panelV = fadeUp(reduceMotion);

  return (
    <div className="relative pb-24 cm-war-grid">
      <div className="border-b border-cm-border bg-cm-card/95 backdrop-blur-md">
        <div className="mx-auto flex max-w-[88rem] flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex min-w-0 flex-wrap items-center gap-4">
            <span className="relative flex h-3 w-3 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cm-terminal/50 opacity-35" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-cm-terminal shadow-[0_0_12px_rgba(74,222,128,0.45)]" />
            </span>
            <div className="min-w-0">
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-cm-faint">Chain · live</p>
              <p className="mt-0.5 truncate font-mono text-xs text-cm-muted">
                {ping?.error ? (
                  <span className="text-cm-bad">RPC unreachable — check endpoint</span>
                ) : ping?.ok ? (
                  <>
                    <span className="text-cm-text">{ping.cluster}</span>
                    <span className="text-cm-faint"> · slot </span>
                    <span className="tabular-nums text-cm-accent-bright">{ping.slot?.toLocaleString?.() ?? ping.slot}</span>
                  </>
                ) : (
                  <span className="text-cm-faint">Negotiating RPC…</span>
                )}
              </p>
            </div>
            <div className="hidden h-8 w-px bg-cm-border sm:block" />
            <p className="font-mono text-[10px] text-cm-faint">
              Auto sweep <span className="text-cm-muted">{LIVE_POLL_MS / 1000}s</span>
            </p>
          </div>
          <motion.button
            type="button"
            onClick={() => void runAllSync()}
            disabled={syncing}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-cm-accent/40 bg-cm-accent px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-cm-on-accent shadow-[0_0_24px_-4px_rgba(139,92,246,0.55)] transition hover:bg-cm-accent-bright disabled:opacity-45"
            whileHover={syncing || reduceMotion ? undefined : { scale: 1.04 }}
            whileTap={reduceMotion ? undefined : { scale: 0.96 }}
            animate={
              syncing || reduceMotion
                ? {}
                : {
                    boxShadow: [
                      "0 0 22px -4px rgba(139,92,246,0.5)",
                      "0 0 36px -2px rgba(196,181,253,0.45)",
                      "0 0 22px -4px rgba(139,92,246,0.5)",
                    ],
                  }
            }
            transition={{
              boxShadow: { duration: 2.4, repeat: Infinity, ease: "easeInOut" },
              layout: springGentle,
            }}
          >
            {syncing ? (
              <>
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-cm-on-accent border-t-transparent" />
                Pulling…
              </>
            ) : (
              <>Full resync</>
            )}
          </motion.button>
        </div>
      </div>

      <motion.main
        className="mx-auto max-w-[88rem] space-y-6 px-4 py-8 sm:px-6"
        initial="hidden"
        animate="show"
        variants={mainStagger}
      >
        <motion.div variants={panelV}>
          <AlertStrip alerts={intelAlerts} />
        </motion.div>

        <motion.div variants={panelV}>
        <Panel
          kicker="Investigation"
          title="Watch target & scan parameters"
          subtitle="Everything downstream keys off this pubkey — mint, wallet, or program."
        >
          <div className="grid gap-4 lg:grid-cols-12 lg:gap-6">
            <div className="lg:col-span-6">
              <label className="mb-1.5 block font-mono text-[10px] font-semibold uppercase tracking-wider text-cm-faint">
                Solana address (base58)
              </label>
              <input
                className="w-full rounded-md border border-cm-border bg-cm-row/80 px-3 py-2.5 font-mono text-sm text-cm-text outline-none ring-cm-accent-ring focus:ring-2"
                value={focusAddress}
                onChange={(e) => setFocusAddress(e.target.value)}
                placeholder="Mint · wallet · program"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <div className="grid grid-cols-3 gap-3 lg:col-span-6 lg:gap-4">
              <div>
                <label className="mb-1.5 block font-mono text-[10px] font-semibold uppercase tracking-wider text-cm-faint">
                  Sig depth
                </label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  className="w-full rounded-md border border-cm-border bg-cm-row/80 px-2 py-2 font-mono text-sm text-cm-text outline-none focus:ring-2 focus:ring-cm-accent-ring"
                  value={inspectLimit}
                  onChange={(e) => setInspectLimit(e.target.value)}
                />
              </div>
              <div>
                <label className="mb-1.5 block font-mono text-[10px] font-semibold uppercase tracking-wider text-cm-faint">
                  Window (m)
                </label>
                <input
                  type="number"
                  min={1}
                  max={60}
                  className="w-full rounded-md border border-cm-border bg-cm-row/80 px-2 py-2 font-mono text-sm text-cm-text outline-none focus:ring-2 focus:ring-cm-accent-ring"
                  value={scoreWindow}
                  onChange={(e) => setScoreWindow(e.target.value)}
                />
              </div>
              <div>
                <label className="mb-1.5 block font-mono text-[10px] font-semibold uppercase tracking-wider text-cm-faint">
                  Lookback (h)
                </label>
                <input
                  type="number"
                  min={1}
                  max={720}
                  className="w-full rounded-md border border-cm-border bg-cm-row/80 px-2 py-2 font-mono text-sm text-cm-text outline-none focus:ring-2 focus:ring-cm-accent-ring"
                  value={scoreHours}
                  onChange={(e) => setScoreHours(e.target.value)}
                />
              </div>
            </div>
          </div>
        </Panel>
        </motion.div>

        <motion.div variants={panelV} className="grid gap-6 lg:grid-cols-12">
          <div className="space-y-6 lg:col-span-8">
            <Panel
              kicker="Telemetry"
              title="Signature stream"
              subtitle={`RPC-backed tail · refreshes every ${LIVE_POLL_MS / 1000}s with network sweep`}
            >
              <InspectBody
                data={inspect}
                loading={loading.inspect}
                hasFocus={Boolean(focusAddress.trim())}
                solscanTx={solscanTx}
              />
            </Panel>
          </div>

          <div className="space-y-6 lg:col-span-4">
            <RiskHero profile={risk} scopeLabel={focusAddress.trim() ? shortSig(focusAddress.trim()) : "—"} />

            <Panel kicker="Topology" title="Scope graph" subtitle="Fee payers from ingest · RPC satellites fallback">
              <WalletGraphSvg graph={walletGraphVisual} />
              <IntelDocsHint />
            </Panel>

            <Panel kicker="Temporal" title="Activity density" subtitle="Ingest buckets or RPC confirmation density">
              {score?.timelineBuckets?.length ? (
                <CoordinationTimeline buckets={score.timelineBuckets} />
              ) : (
                <RpcActivityTimeline signatures={inspect?.signatures} />
              )}
            </Panel>

            <Panel kicker="Signals" title="Coordination decomposition" subtitle="Driver lines from scored windows">
              <ScoreBody data={score} loading={loading.score} hideMainScore />
            </Panel>
          </div>
        </motion.div>

        <motion.div variants={panelV} className="grid gap-6 lg:grid-cols-2">
          <Panel kicker="Corpus" title="Synced datastore" subtitle="Signatures & parsed events mirrored for analysis">
            <DbBody data={dbStats} loading={loading.db && dbStats == null} />
            {dbStats != null && loading.db ? (
              <p className="mt-3 text-center font-mono text-[10px] text-cm-faint">Refreshing counts…</p>
            ) : null}
          </Panel>

          <Panel
            kicker="Synthesis"
            title="Live reasoning"
            subtitle={`Groq re-analyzes the evidence snapshot as panels update (~${(LIVE_POLL_MS / 1000).toFixed(0)}s sweep), at most once per ${Math.round(GROQ_REASONING_MIN_INTERVAL_MS / 60_000)} min. High-confidence auto runs can POST webhooks.`}
            actions={
              <span className="rounded-md border border-cm-border-subtle bg-cm-row/50 px-2 py-1.5 font-mono text-[10px] uppercase tracking-wide text-cm-muted">
                {loadingGroq ? "Reasoning…" : "Idle"}
              </span>
            }
          >
            <BriefBody analysis={groqAnalysis} error={groqErr} loading={loadingGroq} webhookMeta={groqWebhookMeta} />
          </Panel>
        </motion.div>
      </motion.main>
    </div>
  );
}
