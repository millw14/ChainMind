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
  SurfaceFeedStrip,
  GlobalIntelFeedStrip,
} from "@/components/dashboard/intel-widgets";
import { WalletGraphForce } from "@/components/dashboard/WalletGraphForce";
import { buildEntityClassificationContext, classifyNamedEntityLine } from "@/lib/entity-classify.js";
import { buildGroqEvidence } from "@/lib/groq-evidence.js";
import { GROQ_BRIEF_USER_FOCUS } from "@/lib/groq-brief-defaults.js";
import { enrichAnalysisWithVerdictStructure, shortenIdCompact } from "@/lib/groq-verdict-card.js";
import { buildGroqUserEvidence } from "@/lib/groq-user-evidence.js";
import { MultiScopeComparePanel } from "@/components/dashboard/multi-scope-compare";
import WalletTable from "@/components/dashboard/WalletTable";
import { staggerContainer, fadeUp, springGentle } from "@/components/motion/presets";

const USDC_MAINNET = "Xqfwj8PrgpjksqgnopR9DwDuNZAXrqVHDbdcQ34pump";

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

/**
 * Groq free tier often returns long rate-limit bodies; surface a calm summary + optional retry hint.
 * @param {{ message: string | null | undefined }} props
 */
function GroqErrorCallout({ message }) {
  const raw = String(message ?? "");
  const lower = raw.toLowerCase();
  const looksLikeRateLimit =
    lower.includes("rate limit") || lower.includes("tokens per day") || lower.includes("tpd");
  if (looksLikeRateLimit) {
    const retry = raw.match(/try again in ([^\n.]+)/i);
    return (
      <div className="rounded-md border border-cm-warn/50 bg-cm-warn/10 px-4 py-3 text-sm leading-relaxed text-cm-subtle">
        <p className="font-medium text-cm-warn">Groq daily token budget exhausted</p>
        <p className="mt-2">
          Your key/org hit Groq’s <strong>tokens-per-day</strong> limit on this model tier. Nothing is wrong with
          ChainMind — the provider is refusing the call until the window resets or you raise the cap.
        </p>
        {retry ? (
          <p className="mt-2 font-mono text-[11px] text-cm-muted">Typical retry: ~{retry[1].trim()}</p>
        ) : null}
        <p className="mt-2 text-xs text-cm-faint">
          You can wait, adjust usage (e.g. less frequent reasoning), set a cheaper{" "}
          <code className="text-cm-muted">GROQ_MODEL</code>, or change billing tier in the Groq console.
        </p>
        <details className="mt-3 rounded border border-cm-border-subtle bg-cm-surface/40 px-2 py-1">
          <summary className="cursor-pointer select-none text-xs text-cm-faint">Provider message (full)</summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-cm-muted">
            {raw}
          </pre>
        </details>
      </div>
    );
  }
  return <ErrorCallout message={raw} />;
}

function InfoCallout({ children }) {
  return (
    <div className="rounded-md border border-cm-warn/40 bg-cm-warn/10 px-4 py-3 text-sm leading-relaxed text-cm-subtle">
      {children}
    </div>
  );
}

function ReasoningPanelStatus({ loadingGroq, lastGroqAt, nextSweepAt, sweepSec }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const nextInSec =
    nextSweepAt != null ? Math.max(0, Math.ceil((nextSweepAt - Date.now()) / 1000)) : null;
  const mm = nextInSec != null ? Math.floor(nextInSec / 60) : 0;
  const ss = nextInSec != null ? nextInSec % 60 : 0;
  const timeOpts = { hour: "2-digit", minute: "2-digit", second: "2-digit" };

  return (
    <div className="flex flex-col gap-0.5 font-mono text-left">
      {loadingGroq ? (
        <span className="text-[10px] font-bold uppercase tracking-wide text-cm-warn">Reasoning…</span>
      ) : (
        <span className="text-[10px] font-bold uppercase tracking-wide text-cm-terminal">Idle</span>
      )}
      <span className="text-[9px] normal-case leading-relaxed text-cm-faint">
        Last analysis{" "}
        <span className="text-cm-subtle">
          {lastGroqAt ? new Date(lastGroqAt).toLocaleTimeString(undefined, timeOpts) : "—"}
        </span>
      </span>
      <span className="text-[9px] normal-case leading-relaxed text-cm-faint">
        Next data sweep{" "}
        <span className="tabular-nums text-cm-accent-bright">
          {nextInSec != null ? `${mm}:${String(ss).padStart(2, "0")}` : "—"}
        </span>
        <span className="text-cm-faint"> · {sweepSec}s cadence</span>
      </span>
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

function DbBody({ data, loading, watchScope }) {
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
  const watch = typeof watchScope === "string" ? watchScope.trim() : "";
  const graphReady = data.edgesTotal != null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
        <div className="rounded-md border border-cm-border bg-cm-row/60 px-4 py-3">
          <dt className="text-xs text-cm-faint">Graph edges</dt>
          <dd className="mt-1 text-xl font-semibold tabular-nums text-cm-text">
            {graphReady ? (data.edgesTotal ?? 0).toLocaleString() : "—"}
          </dd>
          {!graphReady ? (
            <p className="mt-1 text-[10px] leading-snug text-cm-faint">
              Apply schema (<code className="text-cm-muted">edges</code>) + sync
            </p>
          ) : null}
        </div>
        <div className="rounded-md border border-cm-border bg-cm-row/60 px-4 py-3">
          <dt className="text-xs text-cm-faint">Store</dt>
          <dd className="mt-1 text-sm font-medium capitalize text-cm-text">{data.database ?? "—"}</dd>
        </div>
      </div>
      {watch && graphReady ? (
        <p className="text-xs text-cm-muted">
          Watch target{" "}
          <span className="font-[family-name:var(--font-mono)] text-cm-accent-bright">{shortSig(watch)}</span>
          {" — "}
          {(() => {
            const row = scopes.find((s) => s.scope === watch);
            if (!row) {
              return "no rows for this scope in Turso yet (backfill + turso:sync).";
            }
            const fe = row.fundingLikeEdges;
            const ed = row.edges ?? 0;
            const fl = typeof fe === "number" ? fe : 0;
            return `${ed.toLocaleString()} edges (${fl.toLocaleString()} funding-like) — Groq funding slice uses this.`;
          })()}
        </p>
      ) : null}
      {scopes.length > 0 ? (
        <div className="overflow-x-auto rounded-md border border-cm-border">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-cm-border bg-cm-row/80 text-xs font-medium uppercase tracking-wide text-cm-faint">
              <tr>
                <th className="px-3 py-2">Tracked address</th>
                <th className="px-3 py-2">Signatures</th>
                <th className="px-3 py-2">Events</th>
                <th className="px-3 py-2">Edges</th>
                <th className="px-3 py-2">Funding-like</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cm-border">
              {scopes.map((s) => (
                <tr
                  key={s.scope}
                  className={`bg-cm-row/30 ${watch && s.scope === watch ? "ring-1 ring-inset ring-cm-accent/40" : ""}`}
                >
                  <td className="max-w-[12rem] truncate px-3 py-2 font-[family-name:var(--font-mono)] text-xs text-cm-subtle">
                    {s.scope}
                    {watch && s.scope === watch ? (
                      <span className="ml-2 rounded bg-cm-accent/15 px-1 py-px text-[9px] font-semibold text-cm-accent-bright">
                        watch
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-cm-muted">{(s.signatures ?? 0).toLocaleString()}</td>
                  <td className="px-3 py-2 tabular-nums text-cm-muted">{(s.events ?? 0).toLocaleString()}</td>
                  <td className="px-3 py-2 tabular-nums text-cm-muted">
                    {typeof s.edges === "number" ? s.edges.toLocaleString() : "—"}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-cm-muted">
                    {typeof s.fundingLikeEdges === "number" ? s.fundingLikeEdges.toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="mt-4 border-t border-cm-border-subtle pt-4 font-mono text-[10px] leading-relaxed text-cm-faint">
        <strong className="font-semibold text-cm-muted">Funding-like edges</strong> (
        {(data.graphFundingEdgeTypes ?? ["token_transfer", "fee_payer_cosigner", "mint_to"]).join(", ")}) feed the Groq
        funding slice when payers match; zero here means backfill/sync has not populated graph rows for this scope.
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

const riskStyle = {
  critical: "text-cm-bad",
  high: "text-orange-300",
  medium: "text-cm-warn",
  low: "text-cm-muted",
};

const verdictTone = {
  escalate: "text-cm-bad",
  monitor: "text-cm-warn",
  dismiss: "text-cm-ok",
  manipulation_detected: "text-cm-bad",
  suspicious: "text-cm-warn",
  clean: "text-cm-ok",
};

function severityAccent(sev) {
  switch (String(sev).toUpperCase()) {
    case "HIGH":
      return "text-cm-bad";
    case "MEDIUM":
    case "MED":
      return "text-cm-warn";
    case "LOW":
      return "text-cm-muted";
    case "SKIPPED":
    case "NOT_FETCHED":
    case "NOT FETCHED":
      return "text-cm-faint";
    default:
      return "text-cm-muted";
  }
}

/**
 * @param {{
 *   analysis: Record<string, unknown> | null,
 *   error: string | null,
 *   loading: boolean,
 *   webhookMeta?: object | null,
 *   entityContext: ReturnType<typeof buildEntityClassificationContext> | null,
 *   evidenceSnapshot: Record<string, unknown> | null,
 * }} props
 */
function BriefBody({ analysis, error, loading, webhookMeta, entityContext, evidenceSnapshot }) {
  const enriched = useMemo(() => {
    if (!analysis) return null;
    if (!evidenceSnapshot) return /** @type {Record<string, unknown>} */ (analysis);
    try {
      return enrichAnalysisWithVerdictStructure(
        /** @type {Record<string, unknown>} */ (analysis),
        buildGroqUserEvidence(evidenceSnapshot),
      );
    } catch {
      return /** @type {Record<string, unknown>} */ (analysis);
    }
  }, [analysis, evidenceSnapshot]);

  if (loading) {
    return <p className="py-8 text-center text-sm text-cm-faint">Running ChainMind analyst…</p>;
  }
  if (error) {
    return <GroqErrorCallout message={error} />;
  }
  if (!enriched) {
    return (
      <p className="text-sm text-cm-muted">
        Live reasoning runs when panels have data (requires{" "}
        <code className="text-cm-accent-bright">GROQ_API_KEY</code>
        ). Analysis refreshes as the{" "}
        <span className="font-mono text-cm-muted">{(LIVE_POLL_MS / 1000).toFixed(0)}s</span> sweep updates
        evidence—at most about every {Math.ceil(GROQ_REASONING_MIN_INTERVAL_MS / 60_000)} minutes per scope. Webhooks:{" "}
        <Link href="/docs" className="font-medium text-cm-text underline underline-offset-2 hover:text-cm-accent">
          Docs
        </Link>
        .
      </p>
    );
  }

  const verdict = typeof enriched.verdict === "string" ? enriched.verdict : "monitor";
  const riskLevel = typeof enriched.risk_level === "string" ? enriched.risk_level : "medium";
  const pattern = typeof enriched.pattern === "string" ? enriched.pattern : "unknown";
  const scopeLabel = typeof enriched.scope === "string" ? enriched.scope.trim() : "";
  const windowObj = enriched.window && typeof enriched.window === "object" ? enriched.window : null;
  const topEvidence = Array.isArray(enriched.top_evidence) ? enriched.top_evidence : [];
  const flags = Array.isArray(enriched.flags) ? enriched.flags : [];
  const nextAction = typeof enriched.next_action === "string" ? enriched.next_action.trim() : "";
  const modelLine = typeof enriched.model === "string" ? enriched.model.trim() : "";
  const analyzedAt = typeof enriched.analyzed_at === "string" ? enriched.analyzed_at.trim() : "";
  const confPct =
    typeof enriched.confidence_pct === "number" && Number.isFinite(enriched.confidence_pct)
      ? enriched.confidence_pct
      : typeof enriched.confidence === "number" && Number.isFinite(enriched.confidence)
        ? Math.round(Number(enriched.confidence) * 100)
        : null;
  const signals = Array.isArray(enriched.signals) ? enriched.signals : [];
  const limiting = Array.isArray(enriched.limiting_factors) ? enriched.limiting_factors : [];
  const namedEntities = Array.isArray(enriched.named_entities) ? enriched.named_entities : [];
  const nextSteps = Array.isArray(enriched.next_steps) ? enriched.next_steps : [];
  const calibration =
    typeof enriched.confidence_reasoning === "string" ? enriched.confidence_reasoning.trim() : "";
  const manipVsBenign =
    typeof enriched.manipulation_vs_benign === "string" ? enriched.manipulation_vs_benign.trim() : "";

  const ctx = entityContext ?? buildEntityClassificationContext({});
  /** @type {{ fullId: string, shortId: string, role: string }[]} */
  const entityRows = [];
  const seenE = new Set();
  for (const line of namedEntities) {
    const raw = String(line ?? "").trim();
    if (!raw) continue;
    const { rows } = classifyNamedEntityLine(raw, ctx);
    if (rows.length > 0) {
      for (const r of rows) {
        if (seenE.has(r.fullId)) continue;
        seenE.add(r.fullId);
        entityRows.push({ ...r, shortId: shortenIdCompact(r.fullId) });
      }
    } else {
      const stub = raw.slice(0, 88);
      if (!seenE.has(stub)) {
        seenE.add(stub);
        entityRows.push({
          fullId: stub,
          shortId: shortenIdCompact(stub),
          role: "Analyst reference (non-id text)",
        });
      }
    }
  }

  const vTone = verdictTone[verdict] ?? "text-cm-muted";

  return (
    <div className="overflow-hidden rounded-lg border border-cm-border bg-cm-card/95 shadow-cm">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-cm-border-subtle bg-cm-row/35 px-4 py-5 sm:px-5">
        <h3 className={`max-w-[min(100%,28rem)] text-2xl font-black uppercase tracking-tight sm:text-3xl ${vTone}`}>
          {verdict.replace(/-/g, " ")}
        </h3>
        <div className="flex flex-wrap items-end justify-end gap-4 text-right">
          <p className={`font-mono text-sm font-bold uppercase tracking-wider ${riskStyle[riskLevel] ?? "text-cm-muted"}`}>
            {riskLevel.replace(/_/g, " ")} risk
          </p>
          {confPct != null ? (
            <p className="font-mono text-4xl font-black tabular-nums leading-none text-cm-text">{confPct}%</p>
          ) : (
            <p className="font-mono text-lg text-cm-faint">—</p>
          )}
        </div>
      </div>

      <div className="border-b border-cm-border-subtle px-4 py-3 sm:px-5 font-mono text-[10px] text-cm-subtle">
        <p>
          <span className="text-cm-faint">Pattern</span>{" "}
          <span className="text-cm-accent-bright">{pattern.replace(/-/g, " ")}</span>
        </p>
        {scopeLabel ? (
          <p className="mt-1">
            <span className="text-cm-faint">Scope</span>{" "}
            <span className="break-all text-cm-text">{shortSig(scopeLabel)}</span>
          </p>
        ) : null}
        {windowObj ? (
          <p className="mt-1 text-cm-faint">
            Window{" "}
            <span className="text-cm-muted">
              {String((/** @type {any} */ (windowObj)).start ?? "").slice(0, 19)} →{" "}
              {String((/** @type {any} */ (windowObj)).end ?? "").slice(0, 19)}
              {Number.isFinite(Number((/** @type {any} */ (windowObj)).duration_minutes)) &&
              Number((/** @type {any} */ (windowObj)).duration_minutes) > 0
                ? ` · ${Math.round(Number((/** @type {any} */ (windowObj)).duration_minutes))}m`
                : ""}
            </span>
          </p>
        ) : null}
        {flags.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {flags.map((f, i) => (
              <span
                key={`${String(f)}-${i}`}
                className="rounded border border-cm-border-subtle bg-cm-warn/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-cm-warn"
              >
                {String(f).replace(/-/g, " ")}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="border-b border-cm-border-subtle px-4 py-4 sm:px-5">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-cm-faint">Signals detected</p>
        <ul className="mt-3 divide-y divide-cm-border-subtle/60">
          {signals.length > 0 ? (
            signals.map((s, i) => {
              if (s && typeof s === "object" && "type" in s) {
                const row = /** @type {{ type?: string; weight?: number; detail?: string; name?: string; value?: string; severity?: string }} */ (s);
                if (row.detail != null || row.weight != null) {
                  const pct =
                    typeof row.weight === "number" && Number.isFinite(row.weight)
                      ? Math.round(row.weight * 100)
                      : null;
                  return (
                    <li
                      key={`${String(row.type)}-${i}`}
                      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 font-mono text-xs first:pt-0 last:pb-0"
                    >
                      <span className="text-cm-faint shrink-0">●</span>
                      <span className="min-w-[9rem] shrink-0 text-cm-muted">
                        {String(row.type ?? "signal").replace(/-/g, " ")}
                      </span>
                      <span className="min-w-0 flex-1 text-cm-text leading-snug">{String(row.detail ?? "—")}</span>
                      {pct != null ? (
                        <span className="shrink-0 tabular-nums text-[10px] font-bold text-cm-accent-bright">{pct}%</span>
                      ) : null}
                    </li>
                  );
                }
              }
              const row = /** @type {{ name?: string; value?: string; severity?: string }} */ (s);
              return (
                <li
                  key={`${String(row.name)}-${i}`}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 font-mono text-xs first:pt-0 last:pb-0"
                >
                  <span className="text-cm-faint shrink-0">●</span>
                  <span className="min-w-[10rem] shrink-0 text-cm-muted">{String(row.name ?? "—")}</span>
                  <span className="min-w-0 flex-1 tabular-nums text-cm-text">{String(row.value ?? "—")}</span>
                  <span className={`shrink-0 text-[10px] font-bold uppercase tracking-wide ${severityAccent(row.severity)}`}>
                    {String(row.severity ?? "").replace(/_/g, " ")}
                  </span>
                </li>
              );
            })
          ) : (
            <li className="py-2 text-sm text-cm-faint">No structured signals in this response.</li>
          )}
        </ul>
      </div>

      {limiting.length > 0 ? (
        <div className="border-b border-cm-border-subtle bg-cm-warn/[0.06] px-4 py-4 sm:px-5">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-cm-faint">
            Limiting factors
          </p>
          <ul className="mt-2 space-y-1.5 text-sm leading-snug text-cm-muted">
            {limiting.map((line, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-cm-warn">·</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] text-cm-faint">Confidence capped until these resolve or evidence deepens.</p>
        </div>
      ) : null}

      {entityRows.length > 0 ? (
        <div className="px-4 py-4 sm:px-5">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-cm-faint">
            Named entities
            <span className="ml-2 font-normal text-cm-muted">{entityRows.length} flagged</span>
          </p>
          <div className="mt-2 overflow-x-auto rounded-md border border-cm-border-subtle">
            <table className="w-full border-separate border-spacing-0 text-left font-mono text-[11px]">
              <thead>
                <tr className="border-b border-cm-border-subtle bg-cm-row/50 text-[10px] uppercase tracking-wide text-cm-faint">
                  <th className="px-3 py-2 font-medium">Id</th>
                  <th className="w-10 px-0 py-2 text-center font-medium sm:w-12" aria-hidden="true" />
                  <th className="px-3 py-2 font-medium">Classification</th>
                </tr>
              </thead>
              <tbody>
                {entityRows.map((r, i) => (
                  <tr key={`${r.fullId}-${i}`} className="border-t border-cm-border-subtle/80 bg-cm-row/20">
                    <td className="px-3 py-2 align-top">
                      <span className="text-cm-accent-bright" title={r.fullId}>
                        {r.shortId}
                      </span>
                    </td>
                    <td className="w-10 px-0 py-2 text-center text-cm-faint select-none sm:w-12">→</td>
                    <td className="px-3 py-2 align-top text-cm-subtle">{r.role}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {topEvidence.length > 0 ? (
        <div className="border-t border-cm-border-subtle px-4 py-4 sm:px-5">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-cm-faint">Top evidence</p>
          <div className="mt-2 overflow-x-auto rounded-md border border-cm-border-subtle">
            <table className="w-full border-separate border-spacing-0 text-left font-mono text-[10px]">
              <thead>
                <tr className="border-b border-cm-border-subtle bg-cm-row/50 text-[9px] uppercase tracking-wide text-cm-faint">
                  <th className="px-2 py-1.5 font-medium">Tx</th>
                  <th className="px-2 py-1.5 font-medium">Slot</th>
                  <th className="px-2 py-1.5 font-medium">Actor</th>
                  <th className="px-2 py-1.5 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {topEvidence.map((row, i) => {
                  const r = /** @type {Record<string, unknown>} */ (row && typeof row === "object" ? row : {});
                  const sig = String(r.signature ?? "").trim();
                  const href = sig ? `https://solscan.io/tx/${encodeURIComponent(sig)}` : "";
                  return (
                    <tr key={`${sig}-${i}`} className="border-t border-cm-border-subtle/80 bg-cm-row/15">
                      <td className="max-w-[7rem] truncate px-2 py-1.5 align-top">
                        {href ? (
                          <a href={href} target="_blank" rel="noreferrer" className="text-cm-accent-bright hover:underline">
                            {shortSig(sig)}
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-2 py-1.5 align-top text-cm-muted tabular-nums">{String(r.slot ?? "—")}</td>
                      <td className="max-w-[6rem] truncate px-2 py-1.5 align-top text-cm-subtle" title={String(r.actor ?? "")}>
                        {shortSig(String(r.actor ?? ""))}
                      </td>
                      <td className="px-2 py-1.5 align-top text-cm-subtle">{String(r.action ?? "—")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {nextAction ? (
        <div className="border-t border-cm-border-subtle bg-cm-accent/5 px-4 py-4 sm:px-5">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-cm-faint">Next action</p>
          <p className="mt-2 text-sm font-medium leading-relaxed text-cm-text">{nextAction}</p>
        </div>
      ) : null}

      {nextSteps.length > 0 ? (
        <div className="border-t border-cm-border-subtle px-4 py-4 sm:px-5">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-cm-faint">Next steps</p>
          <ol className="mt-2 list-inside list-decimal space-y-1.5 text-sm leading-relaxed text-cm-accent-bright/90">
            {nextSteps.map((line, i) => (
              <li key={i}>{String(line)}</li>
            ))}
          </ol>
        </div>
      ) : null}

      {calibration || manipVsBenign ? (
        <div className="border-t border-cm-border-subtle px-4 py-3 sm:px-5">
          {calibration ? (
            <details className="rounded-md bg-cm-surface/40">
              <summary className="cursor-pointer px-3 py-2 font-mono text-[10px] uppercase tracking-wide text-cm-faint hover:text-cm-muted">
                Confidence calibration (detail)
              </summary>
              <p className="border-t border-cm-border-subtle px-3 py-2 text-xs leading-relaxed text-cm-subtle">
                {calibration}
              </p>
            </details>
          ) : null}
          {manipVsBenign ? (
            <details className={`rounded-md bg-cm-surface/40 ${calibration ? "mt-2" : ""}`}>
              <summary className="cursor-pointer px-3 py-2 font-mono text-[10px] uppercase tracking-wide text-cm-faint hover:text-cm-muted">
                Manipulation vs benign
              </summary>
              <p className="border-t border-cm-border-subtle px-3 py-2 text-xs leading-relaxed text-cm-muted">
                {manipVsBenign}
              </p>
            </details>
          ) : null}
        </div>
      ) : null}

      {webhookMeta?.attempted && webhookMeta?.delivered ? (
        <p className="border-t border-cm-border-subtle px-4 py-3 font-mono text-[10px] text-cm-terminal sm:px-5">
          Investigation webhook POST succeeded (high-confidence auto verdict).
        </p>
      ) : null}
      {webhookMeta?.attempted && webhookMeta?.skipped ? (
        <p className="border-t border-cm-border-subtle px-4 py-3 font-mono text-[10px] text-cm-faint sm:px-5">
          High-confidence auto verdict — set{" "}
          <code className="text-cm-muted">CHAINMIND_VERDICT_WEBHOOK_URL</code> to notify Slack or your SOAR stack.
        </p>
      ) : null}
      {webhookMeta?.error ? (
        <p className="border-t border-cm-border-subtle px-4 py-3 font-mono text-[10px] text-cm-bad sm:px-5">
          Webhook error: {String(webhookMeta.error)}
        </p>
      ) : null}

      {modelLine || analyzedAt ? (
        <div className="border-t border-cm-border-subtle px-4 py-2 sm:px-5 font-mono text-[9px] text-cm-faint">
          {modelLine ? <p>Model · {modelLine}</p> : null}
          {analyzedAt ? <p className={modelLine ? "mt-0.5" : ""}>Analyzed · {analyzedAt}</p> : null}
        </div>
      ) : null}

      <ExpandableRaw label="Full analyst payload (JSON)" data={enriched} />
    </div>
  );
}

export function Dashboard() {
  const [ping, setPing] = useState(null);
  const [focusAddress, setFocusAddress] = useState(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const addr = params.get("address")?.trim();
      if (addr && addr.length >= 32 && addr.length <= 44) return addr;
    }
    return USDC_MAINNET;
  });
  const [inspectLimit, setInspectLimit] = useState("12");
  const [inspect, setInspect] = useState(null);

  const [scoreWindow, setScoreWindow] = useState("60");
  const [scoreHours, setScoreHours] = useState("24");
  const [score, setScore] = useState(null);

  const [dbStats, setDbStats] = useState(null);

  const [surfaceFeed, setSurfaceFeed] = useState(null);
  const [surfaceFeedHint, setSurfaceFeedHint] = useState(null);
  const [loadingSurfaceFeed, setLoadingSurfaceFeed] = useState(false);

  const [globalIntelFeed, setGlobalIntelFeed] = useState(null);
  const [globalIntelFeedHint, setGlobalIntelFeedHint] = useState(null);
  const [globalIntelFeedMeta, setGlobalIntelFeedMeta] = useState(null);
  const [loadingGlobalIntelFeed, setLoadingGlobalIntelFeed] = useState(false);

  const [watchlistScopes, setWatchlistScopes] = useState(/** @type {Array<{ address: string, note?: string | null }> | null} */ (null));
  const [compareScopes, setCompareScopes] = useState(/** @type {string[]} */ ([]));

  const [groqAnalysis, setGroqAnalysis] = useState(null);
  const [groqErr, setGroqErr] = useState(null);
  const [groqWebhookMeta, setGroqWebhookMeta] = useState(null);

  const [nextDataSweepAt, setNextDataSweepAt] = useState(null);
  const [groqLastCompletedAt, setGroqLastCompletedAt] = useState(null);

  const groqLastReasoningAtRef = useRef(0);
  const groqAutoInFlightRef = useRef(false);
  const walletTableRef = useRef(/** @type {{ getRawEvidence?: () => unknown } | null} */ (null));

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

  const runSurfaceFeed = useCallback(async () => {
    setLoadingSurfaceFeed(true);
    try {
      const r = await fetch(`/api/surface-feed?limit=${encodeURIComponent(28)}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setSurfaceFeed([]);
        setSurfaceFeedHint(typeof j?.error === "string" ? j.error : `HTTP ${r.status}`);
        return;
      }
      setSurfaceFeedHint(typeof j?.hint === "string" ? j.hint : null);
      setSurfaceFeed(Array.isArray(j.hits) ? j.hits : []);
    } catch (e) {
      setSurfaceFeed([]);
      setSurfaceFeedHint(String(e.message));
    } finally {
      setLoadingSurfaceFeed(false);
    }
  }, []);

  const runGlobalIntelFeed = useCallback(async () => {
    const hoursRaw = String(scoreHours || "168").trim();
    const lookback = /^\d+$/.test(hoursRaw) ? hoursRaw : "168";
    setLoadingGlobalIntelFeed(true);
    try {
      const r = await fetch(
        `/api/intel/global-feed?limit=${encodeURIComponent(32)}&lookbackHours=${encodeURIComponent(lookback)}`,
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setGlobalIntelFeed([]);
        setGlobalIntelFeedMeta(null);
        setGlobalIntelFeedHint(typeof j?.error === "string" ? j.error : `HTTP ${r.status}`);
        return;
      }
      setGlobalIntelFeedHint(typeof j?.hint === "string" ? j.hint : null);
      setGlobalIntelFeedMeta({
        generatedAt: typeof j?.generatedAt === "string" ? j.generatedAt : null,
        lookbackHoursUsed: j?.lookbackHoursUsed ?? null,
      });
      setGlobalIntelFeed(Array.isArray(j.entries) ? j.entries : []);
    } catch (e) {
      setGlobalIntelFeed([]);
      setGlobalIntelFeedMeta(null);
      setGlobalIntelFeedHint(String(e.message));
    } finally {
      setLoadingGlobalIntelFeed(false);
    }
  }, [scoreHours]);

  const runCreateCase = useCallback(async (scoreData) => {
    if (!scoreData || scoreData.empty || scoreData.ok === false) return;
    const s = focusAddress.trim();
    if (!s) return;
    try {
      const res = await fetch("/api/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: s,
          windowMinutes: Number(scoreWindow) || 5,
          lastHours: Number(scoreHours) || 24,
          autoGroq: true,
        }),
      });
      const json = await res.json();
      if (json.ok && json.caseId) {
        // Dispatch event so RecentCases panel refreshes
        window.dispatchEvent(new CustomEvent("chainmind:case-created", { detail: json }));
      }
    } catch {
      // Silent — case creation is best-effort
    }
  }, [focusAddress, scoreWindow, scoreHours]);

  const runScore = useCallback(async () => {
    const s = focusAddress.trim();
    if (!s) return;
    const hours = encodeURIComponent(scoreHours || "24");
    const buildUrl = (w) => `/api/score?scope=${encodeURIComponent(s)}&window=${w}&hours=${hours}`;
    try {
      // Try requested window first
      let result = await fetchJson(buildUrl(scoreWindow || "5"), "score");
      // Auto-widen if only 1 bucket — not enough to draw a chart
      if (result?.ok && !result?.empty && (result?.timelineBuckets?.length ?? 0) < 3) {
        const wider = [60, 360, 1440];
        for (const w of wider) {
          if (w <= Number(scoreWindow || "5")) continue;
          const retry = await fetchJson(buildUrl(w), "score");
          if ((retry?.timelineBuckets?.length ?? 0) > 1) {
            result = retry;
            break;
          }
        }
      }
      setScore(result);
      runCreateCase(result);
    } catch (e) {
      setScore({ ok: false, error: String(e.message) });
    }
  }, [focusAddress, scoreWindow, scoreHours, fetchJson, runCreateCase]);

  const runAllSync = useCallback(async () => {
    await runPing();
    await runDb();
    await runInspect();
    await runScore();
    // Queue address for background ingestion
    const s = focusAddress.trim();
    if (s) {
      fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: s, note: "dashboard scan" }),
      }).catch(() => {});
    }
    const t = Date.now();
    setNextDataSweepAt(t + LIVE_POLL_MS);
  }, [runPing, runDb, runInspect, runScore, focusAddress]);

  const toggleCompareScope = useCallback((addr) => {
    const a = String(addr ?? "").trim();
    const p = focusAddress.trim();
    if (!a || a === p) return;
    setCompareScopes((prev) => {
      if (prev.includes(a)) return prev.filter((x) => x !== a);
      if (prev.length >= 5) return [...prev.slice(1), a];
      return [...prev, a];
    });
  }, [focusAddress]);

  const removeCompareScope = useCallback((addr) => {
    setCompareScopes((prev) => prev.filter((x) => x !== addr));
  }, []);

  const clearCompareScopes = useCallback(() => setCompareScopes([]), []);

  useEffect(() => {
    void fetch("/api/watchlist")
      .then((r) => r.json())
      .then((j) => {
        if (j?.ok && Array.isArray(j.scopes)) setWatchlistScopes(j.scopes);
        else setWatchlistScopes([]);
      })
      .catch(() => setWatchlistScopes([]));
  }, []);

  useEffect(() => {
    const p = focusAddress.trim();
    if (!p) return;
    setCompareScopes((prev) => prev.filter((x) => x !== p));
  }, [focusAddress]);

  useEffect(() => {
    void runPing();
    void runDb();
    void runSurfaceFeed();
  }, [runPing, runDb, runSurfaceFeed]);

  useEffect(() => {
    void runGlobalIntelFeed();
  }, [runGlobalIntelFeed]);

  useEffect(() => {
    const id = setInterval(() => {
      void runSurfaceFeed();
      void runGlobalIntelFeed();
    }, LIVE_POLL_MS);
    return () => clearInterval(id);
  }, [runSurfaceFeed, runGlobalIntelFeed]);

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
    if (!a) {
      setNextDataSweepAt(null);
      return;
    }
    setNextDataSweepAt(Date.now() + LIVE_POLL_MS);
    const id = setInterval(() => {
      void runAllSync();
    }, LIVE_POLL_MS);
    return () => clearInterval(id);
  }, [focusAddress, runAllSync]);

  const intelAlerts = useMemo(() => buildAlerts({ inspect, score, ping }), [inspect, score, ping]);
  const risk = useMemo(() => deriveRiskProfile(score), [score]);

  const groqEvidence = useMemo(() => {
    const addr = focusAddress.trim();
    if (!addr) return null;
    const scopeHumanHint = null;
    const evidenceCore = buildGroqEvidence({
      address: focusAddress,
      score,
      inspect,
      risk,
    });
    // Prefer live inspect list if non-empty; fall back to ranked pickSuspiciousSignatures sample.
    // Cap matches ARRAY_CAPS.signatures in lib/groq-evidence.js — update both together.
    const inspectSigs =
      Array.isArray(inspect?.signatures) && inspect.signatures.length > 0
        ? inspect.signatures
        : Array.isArray(inspect?.data) && inspect.data.length > 0
          ? inspect.data
          : null;

    const signatures = (inspectSigs ?? evidenceCore.signatures ?? []).slice(0, 24);
    return {
      ...evidenceCore,
      signatures,
      scopeHumanHint: scopeHumanHint ?? undefined,
      rpcCluster: ping?.ok ? { cluster: ping.cluster, slot: ping.slot } : { error: ping?.error ?? "RPC unknown" },
      inspectLimit: Number(inspectLimit) || null,
      automatedAlerts: intelAlerts.map((a) => ({
        severity: a.severity,
        title: a.title,
        detail: a.detail,
      })),
    };
  }, [focusAddress, score, inspect, risk, ping, inspectLimit, intelAlerts]);

  const entityClassificationContext = useMemo(
    () => (groqEvidence ? buildEntityClassificationContext(groqEvidence) : null),
    [groqEvidence],
  );

  /** Matches GET /api/evidence lookback cap (168h). */
  const evidenceLookbackHours = useMemo(
    () => Math.min(168, Math.max(1, parseInt(String(scoreHours || "24").trim(), 10) || 24)),
    [scoreHours],
  );

  const runGroqAnalysis = useCallback(
    async (source) => {
      if (!groqEvidence?.address) return null;
      // Merge wallet table payload into Groq POST (see lib/integration-notes.js)
      const walletEvidence = walletTableRef.current?.getRawEvidence?.() ?? null;
      const groqData = { ...groqEvidence, walletEvidence: walletEvidence ?? null };
      const r = await fetch("/api/groq-brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: groqData,
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
        setGroqLastCompletedAt(Date.now());
        setGroqAnalysis(
          j.analysis && typeof j.analysis === "object"
            ? { ...j.analysis, ...(j.model ? { model: j.model } : {}) }
            : null,
        );
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
    setGroqLastCompletedAt(null);
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
    <div className="relative min-w-0 max-w-[100vw] overflow-x-clip pb-[max(6rem,calc(env(safe-area-inset-bottom,0px)+4rem))] cm-war-grid">
      <div className="sticky top-12 z-40 border-b border-cm-border bg-cm-card/95 backdrop-blur-md sm:top-14">
        <div className="mx-auto flex max-w-[88rem] flex-row items-center justify-between gap-3 px-3 py-2 sm:px-6 sm:py-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
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
          <button
            type="button"
            onClick={() => void runAllSync()}
            disabled={syncing}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-cm-border bg-cm-elevated px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-cm-muted transition hover:border-cm-accent/40 hover:text-cm-text disabled:opacity-45"
          >
            {syncing ? (
              <>
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-cm-border border-t-cm-accent" />
                Pulling…
              </>
            ) : (
              <>Full resync</>
            )}
          </button>
        </div>
      </div>

      <motion.main
        className="mx-auto max-w-[88rem] space-y-6 px-3 py-6 sm:px-6 sm:py-8"
        initial="hidden"
        animate="show"
        variants={mainStagger}
      >
        <motion.div variants={panelV}>
          <AlertStrip alerts={intelAlerts} />
        </motion.div>

        <motion.div variants={panelV} className="grid gap-4 lg:grid-cols-2">
          <SurfaceFeedStrip
            hits={surfaceFeed ?? []}
            loading={loadingSurfaceFeed}
            hint={surfaceFeedHint}
            onPickScope={(addr) => setFocusAddress(addr)}
            onPinCompare={toggleCompareScope}
          />
          <GlobalIntelFeedStrip
            entries={globalIntelFeed ?? []}
            loading={loadingGlobalIntelFeed}
            hint={globalIntelFeedHint}
            meta={globalIntelFeedMeta}
            onPickScope={(addr) => setFocusAddress(addr)}
            onPinCompare={toggleCompareScope}
          />
        </motion.div>

        <motion.div variants={panelV}>
          <MultiScopeComparePanel
            primary={focusAddress}
            compareScopes={compareScopes}
            scoreWindow={scoreWindow}
            scoreHours={scoreHours}
            watchlist={watchlistScopes}
            onSetPrimary={(addr) => setFocusAddress(addr)}
            onToggleCompare={toggleCompareScope}
            onRemoveCompare={removeCompareScope}
            onClearCompare={clearCompareScopes}
          />
        </motion.div>

        <motion.div variants={panelV}>
        <Panel
          kicker="Investigation"
          title="Watch target & scan parameters"
          subtitle="Everything downstream keys off this pubkey — mint, wallet, or program."
        >
          <div className="grid gap-4 lg:grid-cols-12 lg:gap-6">
            <div className="min-w-0 lg:col-span-6">
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:col-span-6 lg:gap-4">
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
              <WalletGraphForce graph={walletGraphVisual} onNodeClick={(addr) => setFocusAddress(addr)} />
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
            <DbBody data={dbStats} loading={loading.db && dbStats == null} watchScope={focusAddress} />
            {dbStats != null && loading.db ? (
              <p className="mt-3 text-center font-mono text-[10px] text-cm-faint">Refreshing counts…</p>
            ) : null}
          </Panel>

          <Panel
            kicker="Synthesis"
            title="Live reasoning"
            subtitle={`Groq re-analyzes the evidence snapshot as panels update (~${(LIVE_POLL_MS / 1000).toFixed(0)}s sweep), at most once per ${Math.round(GROQ_REASONING_MIN_INTERVAL_MS / 60_000)} min. High-confidence auto runs can POST webhooks.`}
          >
            <div className="mb-4 border-b border-cm-border-subtle pb-4">
              <ReasoningPanelStatus
                loadingGroq={loadingGroq}
                lastGroqAt={groqLastCompletedAt}
                nextSweepAt={nextDataSweepAt}
                sweepSec={LIVE_POLL_MS / 1000}
              />
            </div>
            <BriefBody
              analysis={groqAnalysis}
              error={groqErr}
              loading={loadingGroq}
              webhookMeta={groqWebhookMeta}
              entityContext={entityClassificationContext}
              evidenceSnapshot={groqEvidence}
            />
          </Panel>
        </motion.div>
        <motion.div variants={panelV}>
          <details className="group">
            <summary className="cursor-pointer list-none">
              <div className="flex min-h-[48px] items-center justify-between gap-3 rounded-xl border border-cm-border bg-cm-surface/40 px-4 py-3 transition-colors active:bg-cm-row-hover hover:bg-cm-row-hover sm:min-h-0 sm:px-5 sm:py-4">
                <div>
                  <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-cm-faint">Evidence</p>
                  <p className="mt-0.5 text-sm font-semibold text-cm-text">Wallet table</p>
                </div>
                <span className="font-mono text-xs text-cm-faint select-none group-open:hidden">▼ expand</span>
                <span className="hidden font-mono text-xs text-cm-faint select-none group-open:block">▲ collapse</span>
              </div>
            </summary>
            <div className="mt-2">
              <WalletTable
                ref={walletTableRef}
                scope={focusAddress.trim()}
                lookback={evidenceLookbackHours}
              />
            </div>
          </details>
        </motion.div>
      </motion.main>
    </div>
  );
}
