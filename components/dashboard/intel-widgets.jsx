"use client";

import Link from "next/link";

export function shortAddr(s) {
  if (!s || s.length < 12) return s || "—";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

export function formatRelativeTime(unixSec) {
  if (unixSec == null || !Number.isFinite(Number(unixSec))) return "—";
  const t = Number(unixSec);
  const d = Math.max(0, Date.now() / 1000 - t);
  if (d < 50) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

/** @typedef {{ id: string, severity: 'critical' | 'high' | 'medium' | 'low' | 'info', title: string, detail?: string }} IntelAlert */

/**
 * @param {{ inspect: any, score: any, ping: any }} param0
 * @returns {IntelAlert[]}
 */
export function buildAlerts({ inspect, score, ping }) {
  /** @type {IntelAlert[]} */
  const out = [];
  let k = 0;
  const id = () => `a-${k++}`;

  if (ping?.error) {
    out.push({
      id: id(),
      severity: "high",
      title: "RPC reachability",
      detail: String(ping.error),
    });
  }

  if (score?.database === "unconfigured") {
    out.push({
      id: id(),
      severity: "info",
      title: "Coordination channel offline",
      detail: "Sync events to Turso to unlock graph, timeline, and coordination risk for this scope.",
    });
  } else if (score?.ok && !score.empty && score.score != null) {
    const s = score.score;
    const w = score.windowMinutes ?? 5;
    if (s >= 18) {
      out.push({
        id: id(),
        severity: "critical",
        title: "Dense payer burst",
        detail: `${s} distinct fee payers in a single ${w}-minute bucket — worth manual review.`,
      });
    } else if (s >= 11) {
      out.push({
        id: id(),
        severity: "high",
        title: "Elevated co-activity",
        detail: `${s} distinct payers peaked in one ${w}-minute slice.`,
      });
    } else if (s >= 6) {
      out.push({
        id: id(),
        severity: "medium",
        title: "Coordination pressure",
        detail: `${s} payers in the busiest ${w}-minute window over the lookback.`,
      });
    }
  }

  if (inspect && inspect.ok === false && inspect.error) {
    out.push({
      id: id(),
      severity: "high",
      title: "Activity feed error",
      detail: String(inspect.error),
    });
  }

  if (inspect?.ok && Array.isArray(inspect.signatures) && inspect.signatures.length >= 4) {
    const sigs = inspect.signatures;
    const failed = sigs.filter((row) => row.err).length;
    const ratio = failed / sigs.length;
    if (ratio >= 0.35) {
      out.push({
        id: id(),
        severity: "medium",
        title: "On-chain failures spiking",
        detail: `${Math.round(ratio * 100)}% of sampled txs failed — could be congestion, routing, or program risk.`,
      });
    }
  }

  const hasActionable = out.some((a) => ["critical", "high", "medium"].includes(a.severity));
  const hasContext = out.some((a) => a.severity === "info");
  if (!hasActionable && !hasContext) {
    out.push({
      id: id(),
      severity: "low",
      title: "No automated anomalies",
      detail: "Alerts re-check on the live polling interval — tune windows if you need stricter signals.",
    });
  }

  return out;
}

const severityStyle = {
  critical:
    "border-l-4 border-l-cm-threat bg-gradient-to-r from-cm-threat-glow to-cm-bad/10 text-cm-subtle shadow-[inset_0_0_0_1px_rgba(244,63,94,0.2)]",
  high: "border-l-4 border-l-orange-400 bg-gradient-to-r from-orange-500/10 to-transparent text-cm-subtle",
  medium: "border-l-4 border-l-cm-warn bg-cm-warn/10 text-cm-subtle",
  low: "border-l-4 border-l-cm-border bg-cm-row/60 text-cm-muted",
  info: "border-l-4 border-l-cm-accent bg-cm-accent/8 text-cm-subtle",
};

const severityBadge = {
  critical: "bg-cm-threat/20 text-cm-bad ring-1 ring-cm-bad/40",
  high: "bg-orange-500/15 text-orange-200 ring-1 ring-orange-400/35",
  medium: "bg-cm-warn/15 text-cm-warn ring-1 ring-cm-warn/30",
  low: "bg-cm-row text-cm-muted ring-1 ring-cm-border",
  info: "bg-cm-accent/15 text-cm-accent-bright ring-1 ring-cm-accent/30",
};

const severityLabel = {
  critical: "SEV-1",
  high: "SEV-2",
  medium: "SEV-3",
  low: "INFO",
  info: "NOTE",
};

/**
 * @param {{ alerts: IntelAlert[] }} props
 */
export function AlertStrip({ alerts }) {
  if (!alerts?.length) return null;
  return (
    <div className="rounded-md border border-cm-border bg-cm-card/80 px-4 py-4 sm:px-5">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-cm-faint">Signal queue</p>
          <p className="mt-1 text-xs text-cm-muted">Automated triage · updates with live polling</p>
        </div>
        <span className="rounded border border-cm-border-subtle bg-cm-row/80 px-2 py-0.5 font-mono text-[10px] text-cm-terminal">
          {alerts.length} active
        </span>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {alerts.map((a) => (
          <li
            key={a.id}
            className={`cm-panel-edge min-w-0 rounded-md border border-y border-r border-cm-border/80 bg-cm-surface/90 px-4 py-3 ${severityStyle[a.severity]}`}
          >
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-semibold leading-snug text-cm-text">{a.title}</p>
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wide ${severityBadge[a.severity]}`}
              >
                {severityLabel[a.severity]}
              </span>
            </div>
            {a.detail ? <p className="mt-2 text-xs leading-relaxed text-cm-muted">{a.detail}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * @param {{ score: any }} props
 */
export function deriveRiskProfile(score) {
  if (!score || score.error) {
    return { tier: "unknown", score0_100: null, blurb: "Run coordination analysis when data is available." };
  }
  if (score.database === "unconfigured") {
    return {
      tier: "unknown",
      score0_100: null,
      blurb: "Ingest synced events to produce a coordination risk estimate for this token or wallet.",
    };
  }
  if (score.empty) {
    return {
      tier: "low",
      score0_100: 8,
      blurb: score.message || "No parsed events in this lookback — risk from coordination is not measurable yet.",
    };
  }
  const peak = Number(score.score ?? 0);
  const score0_100 = Math.min(100, Math.round(100 * (1 - Math.exp(-peak / 10))));
  let tier = "low";
  if (score0_100 >= 78) tier = "critical";
  else if (score0_100 >= 58) tier = "high";
  else if (score0_100 >= 38) tier = "elevated";
  return {
    tier,
    score0_100,
    peakPayers: peak,
    blurb: `Peak ${peak} distinct fee payers in one ${score.windowMinutes}-minute slice (coordination pressure index ${score0_100}/100).`,
  };
}

const tierColor = {
  critical: "text-cm-bad",
  high: "text-orange-300",
  elevated: "text-cm-warn",
  low: "text-cm-ok",
  unknown: "text-cm-muted",
};

const tierLabel = {
  critical: "CRITICAL",
  high: "HIGH",
  elevated: "ELEVATED",
  low: "NOMINAL",
  unknown: "NO DATA",
};

/**
 * @param {{ profile: ReturnType<typeof deriveRiskProfile>, scopeLabel: string }} props
 */
export function RiskHero({ profile, scopeLabel }) {
  const label = tierLabel[profile.tier] ?? profile.tier.toUpperCase();
  return (
    <div className="relative overflow-hidden rounded-md border border-cm-border bg-gradient-to-br from-cm-card via-cm-elevated to-cm-surface px-4 py-4 sm:px-5">
      <div className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-cm-threat/10 blur-2xl" aria-hidden />
      <div className="relative">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-cm-faint">Threat index</p>
          <span className="rounded border border-cm-border bg-cm-row/70 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-cm-muted">
            Coordination pressure
          </span>
        </div>
        <p className="mt-2 truncate font-mono text-xs text-cm-accent-bright">{scopeLabel}</p>
        <div className="mt-5 flex flex-wrap items-end gap-6">
          <div>
            <p className={`text-4xl font-bold tabular-nums tracking-tight ${tierColor[profile.tier] ?? "text-cm-text"}`}>
              {profile.score0_100 != null ? profile.score0_100 : "—"}
            </p>
            <p className="font-mono text-[10px] uppercase tracking-wider text-cm-faint">0–100 composite</p>
          </div>
          <div className="pb-0.5">
            <p className={`font-mono text-sm font-bold tracking-wide ${tierColor[profile.tier] ?? "text-cm-muted"}`}>
              {label}
            </p>
            <p className="mt-1 max-w-sm text-xs leading-relaxed text-cm-muted">{profile.blurb}</p>
          </div>
        </div>
        <div className="mt-4 h-2 overflow-hidden rounded-sm bg-cm-row ring-1 ring-cm-border/80">
          <div
            className={`h-full rounded-sm bg-gradient-to-r ${
              profile.tier === "critical" || profile.tier === "high"
                ? "from-cm-threat to-orange-400"
                : "from-cm-accent-dim to-cm-accent"
            }`}
            style={{ width: `${profile.score0_100 != null ? profile.score0_100 : 0}%` }}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * @param {{ rows: { signature: string, blockTime: number | null, err: any, slot: number | null }[], loading: boolean, solscanTx: (sig: string) => string }} props
 */
export function LiveActivityFeed({ rows, loading, solscanTx }) {
  if (loading && (!rows || rows.length === 0)) {
    return <p className="py-12 text-center text-sm text-cm-faint">Pulling mempool-adjacent confirmations…</p>;
  }
  if (!rows?.length) {
    return <p className="py-12 text-center text-sm text-cm-faint">No rows yet for this focus.</p>;
  }
  return (
    <div className="relative max-h-[28rem] space-y-0 overflow-y-auto rounded-md border border-cm-border bg-cm-row/25 pr-1 ring-1 ring-cm-border-subtle">
      <div className="absolute bottom-0 left-[7px] top-0 w-px bg-cm-border" aria-hidden />
      <ul className="space-y-0">
        {rows.map((row, i) => {
          const ok = !row.err;
          return (
            <li key={row.signature} className="relative flex gap-3 py-2.5 pl-5">
              <span
                className={`absolute left-[4px] top-1/2 z-[1] h-2.5 w-2.5 -translate-y-1/2 rounded-full ring-2 ring-cm-surface ${
                  ok ? "bg-cm-ok" : "bg-cm-bad"
                }`}
              />
              <div className="min-w-0 flex-1 rounded-md border border-cm-border-subtle bg-cm-row/40 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-cm-faint">
                    {i === 0 ? "Latest" : "Event"}
                  </span>
                  <span className="text-xs text-cm-muted">{formatRelativeTime(row.blockTime)}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      ok ? "bg-cm-ok/15 text-cm-ok" : "bg-cm-bad/15 text-cm-bad"
                    }`}
                  >
                    {ok ? "ok" : "fail"}
                  </span>
                </div>
                <p className="mt-1 font-[family-name:var(--font-mono)] text-[11px] text-cm-subtle">{shortAddr(row.signature)}</p>
                <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-cm-faint">
                  <span>slot {row.slot != null ? row.slot.toLocaleString() : "—"}</span>
                  <a
                    href={solscanTx(row.signature)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-cm-accent hover:text-cm-accent-bright"
                  >
                    Trace on Solscan →
                  </a>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Radial wallet graph — scope in center, payers or activity nodes on the rim.
 * @param {{ centerId: string, nodes: { id: string, kind: string }[], links?: { source: string, target: string }[] }} graph
 */
export function WalletGraphSvg({ graph }) {
  const w = 340;
  const h = 300;
  const cx = w / 2;
  const cy = h / 2;
  if (!graph?.nodes?.length) {
    return (
      <div className="flex h-[300px] items-center justify-center rounded-md border border-dashed border-cm-border px-4 text-center text-sm text-cm-faint">
        Set a watchlist address and load activity, or connect Turso to draw payer links from synced events.
      </div>
    );
  }

  const center = graph.nodes.find((n) => n.kind === "scope") ?? graph.nodes[0];
  const orbit = graph.nodes.filter((n) => n.id !== center?.id);
  const r = Math.min(w, h) * 0.36;
  const lines = [];

  for (let i = 0; i < orbit.length; i++) {
    const angle = (2 * Math.PI * i) / Math.max(orbit.length, 1) - Math.PI / 2;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    lines.push({ id: orbit[i].id, x, y, node: orbit[i] });
  }

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-[300px] w-full text-cm-muted" role="img" aria-label="Wallet link graph">
      <defs>
        <radialGradient id="cglow" cx="50%" cy="50%" r="55%">
          <stop offset="0%" stopColor="rgba(139, 92, 246, 0.35)" />
          <stop offset="100%" stopColor="rgba(139, 92, 246, 0)" />
        </radialGradient>
      </defs>
      <circle cx={cx} cy={cy} r={r + 28} fill="url(#cglow)" />
      {lines.map((p) => (
        <line
          key={`e-${p.id}`}
          x1={cx}
          y1={cy}
          x2={p.x}
          y2={p.y}
          stroke="rgba(139, 92, 246, 0.35)"
          strokeWidth={1}
        />
      ))}
      {lines.map((p) => (
        <g key={p.id}>
          <circle cx={p.x} cy={p.y} r={10} fill="#1a1620" stroke="rgba(255,255,255,0.12)" strokeWidth={1} />
          <title>{p.node.label ?? p.node.id}</title>
        </g>
      ))}
      <circle cx={cx} cy={cy} r={22} fill="#8b5cf6" opacity={0.95} />
      <circle cx={cx} cy={cy} r={32} fill="none" stroke="rgba(196, 181, 253, 0.35)" strokeWidth={1} />
      <text x={cx} y={cy + 4} textAnchor="middle" className="fill-cm-on-accent text-[10px] font-bold">
        FOCUS
      </text>
    </svg>
  );
}

/** Fallback graph: focus + recent tx nodes (no wallet graph from DB). */
export function inspectFallbackGraph(focusAddress, signatures) {
  if (!focusAddress?.trim() || !signatures?.length) return null;
  const cap = Math.min(11, signatures.length);
  const nodes = [{ id: focusAddress, kind: "scope", label: focusAddress }];
  for (let i = 0; i < cap; i++) {
    nodes.push({ id: `tx-${i}`, kind: "tx", label: shortAddr(signatures[i].signature) });
  }
  return { center: focusAddress, nodes, links: [] };
}

/**
 * @param {Array<{ startSec: number, walletCount: number, eventCount?: number }>} buckets
 */
export function CoordinationTimeline({ buckets }) {
  if (!buckets?.length) {
    return (
      <div className="flex h-32 items-center justify-center rounded-md border border-dashed border-cm-border text-xs text-cm-faint">
        Timeline fills when coordination buckets exist for this lookback.
      </div>
    );
  }
  const maxW = Math.max(1, ...buckets.map((b) => b.walletCount));
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-cm-faint">Distinct fee payers per time bucket (ingested events)</p>
      <div className="flex h-36 items-end gap-px overflow-x-auto rounded-md border border-cm-border bg-cm-row/30 px-1 pb-1 pt-2">
        {buckets.map((b, i) => {
          const hPct = 8 + (b.walletCount / maxW) * 92;
          return (
            <div key={`${b.startSec}-${i}`} className="group relative flex w-1.5 min-w-[3px] flex-1 flex-col justify-end">
              <div
                className="w-full rounded-t-sm bg-gradient-to-t from-cm-accent-dim to-cm-accent-bright opacity-90 group-hover:opacity-100"
                style={{ height: `${hPct}%` }}
                title={`${new Date(b.startSec * 1000).toLocaleString()} · ${b.walletCount} payers`}
              />
            </div>
          );
        })}
      </div>
      <p className="text-[10px] text-cm-faint">
        Tallest bars mark windows where many unique wallets paid fees into this scope — the same signal behind the
        coordination score.
      </p>
    </div>
  );
}

/**
 * RPC-only mini timeline from signature times.
 */
export function RpcActivityTimeline({ signatures }) {
  if (!signatures?.length) {
    return (
      <div className="flex h-32 items-center justify-center rounded-md border border-dashed border-cm-border text-xs text-cm-faint">
        Load activity to see a confirmation timeline from RPC.
      </div>
    );
  }
  const times = signatures.map((s) => s.blockTime).filter((t) => t != null);
  if (times.length === 0) {
    return <p className="py-6 text-center text-xs text-cm-faint">No block times on these signatures yet.</p>;
  }
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const span = Math.max(1, maxT - minT);
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-cm-faint">Recent confirmations (RPC sample)</p>
      <div className="relative h-14 rounded-md border border-cm-border bg-cm-row/30 px-2">
        {signatures.slice(0, 40).map((s, i) => {
          if (s.blockTime == null) return null;
          const x = ((s.blockTime - minT) / span) * 100;
          return (
            <span
              key={s.signature}
              className="absolute bottom-2 h-6 w-0.5 rounded-full bg-cm-accent/80"
              style={{ left: `calc(${x}% - 1px)` }}
              title={formatTimeIso(s.blockTime)}
            />
          );
        })}
      </div>
      <p className="text-[10px] text-cm-faint">
        Dense vertical marks mean many transactions confirmed close together — cross-check with the coordination chart
        when Turso is wired.
      </p>
    </div>
  );
}

function formatTimeIso(unix) {
  return new Date(unix * 1000).toLocaleString();
}

export function IntelDocsHint() {
  return (
    <p className="text-[11px] leading-relaxed text-cm-faint">
      Full wallet–wallet funding graphs and exports are on the roadmap — today&apos;s graph shows{" "}
      <strong className="text-cm-muted">scope → top payers</strong> from ingested events. See{" "}
      <Link href="/docs" className="text-cm-accent hover:underline">
        Docs
      </Link>{" "}
      to connect Turso.
    </p>
  );
}
