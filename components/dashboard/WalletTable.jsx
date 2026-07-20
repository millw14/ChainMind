"use client";

/**
 * components/dashboard/WalletTable.jsx
 *
 * Evidence panel — ranked wallet table with coordination flags and funding links.
 *
 * Props:
 *   scope      {string}   base58 address under investigation
 *   lookback   {number}   hours (passed to /api/evidence)
 *   className  {string}   optional wrapper class
 *
 * Add to your dashboard page:
 *   import WalletTable from "@/components/dashboard/WalletTable";
 *   <WalletTable scope={watchTarget} lookback={lookbackH} />
 *
 * The component also exports getRawEvidence() — call it from your dashboard
 * before POSTing to /api/groq-brief to merge wallet evidence into the Groq
 * data payload:
 *
 *   const evidence = await walletTableRef.current?.getRawEvidence();
 *   const groqData = { ...existingScorePayload, walletEvidence: evidence };
 *   await fetch("/api/groq-brief", { method: "POST", body: JSON.stringify({ data: groqData }) });
 */

import {
  useState,
  useEffect,
  useCallback,
  useImperativeHandle,
  useRef,
  forwardRef,
} from "react";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortAddr(addr) {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function fmtTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

const ROLE_STYLES = {
  fee_payer: { label: "Fee payer", color: "#6366f1" },
  sender:    { label: "Sender",    color: "#f59e0b" },
  recipient: { label: "Recipient", color: "#10b981" },
  multi:     { label: "Multi",     color: "#ef4444" },
  unknown:   { label: "Unknown",   color: "#6b7280" },
};

function RoleBadge({ role }) {
  const { label, color } = ROLE_STYLES[role] ?? ROLE_STYLES.unknown;
  return (
    <span style={{
      background: `${color}22`,
      color,
      border: `1px solid ${color}44`,
      borderRadius: 4,
      padding: "1px 6px",
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: "0.03em",
      whiteSpace: "nowrap",
    }}>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const TH = {
  padding: "8px 12px",
  textAlign: "left",
  fontSize: 11,
  fontWeight: 600,
  color: "#6b7280",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  borderBottom: "1px solid #1e293b",
  whiteSpace: "nowrap",
};

const TD = {
  padding: "9px 12px",
  fontSize: 13,
  color: "#e2e8f0",
  borderBottom: "1px solid #0f172a",
  verticalAlign: "middle",
};

// ---------------------------------------------------------------------------
// WalletRow
// ---------------------------------------------------------------------------

function WalletRow({ wallet, index }) {
  const [expanded, setExpanded] = useState(false);
  const flagged = wallet.coordinated_txs > 0;
  const hasLink = Boolean(wallet.funded_by);

  return (
    <>
      <tr
        onClick={() => setExpanded((v) => !v)}
        style={{
          cursor: "pointer",
          background: flagged
            ? "rgba(239,68,68,0.04)"
            : index % 2 === 0
            ? "rgba(255,255,255,0.02)"
            : "transparent",
          borderLeft: flagged
            ? "2px solid #ef444466"
            : "2px solid transparent",
        }}
      >
        {/* Rank */}
        <td style={{ ...TD, color: "#4b5563", width: 32 }}>{index + 1}</td>

        {/* Address */}
        <td style={{ ...TD, fontFamily: "monospace" }}>
          <a
            href={`https://solscan.io/account/${wallet.address}`}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={{ color: "#818cf8", textDecoration: "none" }}
          >
            {shortAddr(wallet.address)}
          </a>
        </td>

        {/* Role */}
        <td style={TD}><RoleBadge role={wallet.role} /></td>

        {/* Txs */}
        <td style={{ ...TD, textAlign: "right" }}>{wallet.tx_count}</td>

        {/* Coordinated */}
        <td style={{ ...TD, textAlign: "right" }}>
          {flagged
            ? <span style={{ color: "#ef4444", fontWeight: 700 }}>{wallet.coordinated_txs}</span>
            : <span style={{ color: "#374151" }}>0</span>
          }
        </td>

        {/* Funded by */}
        <td style={{ ...TD, fontFamily: "monospace", fontSize: 12 }}>
          {hasLink
            ? (
              <a
                href={wallet.funding_tx_url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                style={{ color: "#34d399", textDecoration: "none" }}
                title={`Funding tx: ${wallet.funding_tx_sig}`}
              >
                {shortAddr(wallet.funded_by)} ↗
              </a>
            )
            : <span style={{ color: "#1f2937" }}>—</span>
          }
        </td>

        {/* First seen */}
        <td style={{ ...TD, fontSize: 11, color: "#6b7280" }}>
          {fmtTime(wallet.first_seen)}
        </td>

        {/* Expand */}
        <td style={{ ...TD, color: "#374151", fontSize: 10, width: 20 }}>
          {expanded ? "▲" : "▼"}
        </td>
      </tr>

      {/* Expanded detail */}
      {expanded && (
        <tr style={{ background: "rgba(99,102,241,0.05)" }}>
          <td colSpan={8} style={{ padding: "10px 16px 12px" }}>
            <div style={{ fontSize: 12, color: "#94a3b8", lineHeight: 2 }}>
              <div>
                <span style={{ color: "#4b5563" }}>Full address: </span>
                <code style={{ color: "#c7d2fe", userSelect: "all" }}>{wallet.address}</code>
              </div>
              {hasLink && (
                <>
                  <div>
                    <span style={{ color: "#4b5563" }}>Funded by: </span>
                    <code style={{ color: "#c7d2fe" }}>{wallet.funded_by}</code>
                  </div>
                  <div>
                    <span style={{ color: "#4b5563" }}>Funding tx: </span>
                    <a
                      href={wallet.funding_tx_url}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "#34d399", fontFamily: "monospace" }}
                    >
                      {wallet.funding_tx_sig}
                    </a>
                  </div>
                </>
              )}
              <div>
                <span style={{ color: "#4b5563" }}>Active window: </span>
                {fmtTime(wallet.first_seen)} → {fmtTime(wallet.last_seen)}
              </div>
              <div>
                <span style={{ color: "#4b5563" }}>Coordinated txs: </span>
                <span style={{ color: flagged ? "#ef4444" : "#4b5563" }}>
                  {wallet.coordinated_txs} / {wallet.tx_count}
                </span>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// SharedFunderAlert
// Shows when multiple wallets share a funder — the top cluster signal.
// ---------------------------------------------------------------------------

function SharedFunderAlert({ sharedFunders }) {
  if (!sharedFunders?.length) return null;

  return (
    <div style={{
      margin: "0 16px 0",
      padding: "10px 14px",
      background: "rgba(239,68,68,0.07)",
      border: "1px solid rgba(239,68,68,0.25)",
      borderRadius: 6,
      fontSize: 12,
      color: "#fca5a5",
    }}>
      <span style={{ fontWeight: 700, color: "#ef4444" }}>
        ⚠ {sharedFunders.length} shared funder cluster{sharedFunders.length > 1 ? "s" : ""} detected
      </span>
      <div style={{ marginTop: 6, lineHeight: 1.9, color: "#94a3b8" }}>
        {sharedFunders.slice(0, 3).map((sf) => (
          <div key={sf.funder}>
            <code style={{ color: "#fca5a5" }}>{shortAddr(sf.funder)}</code>
            {" → funded "}
            <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{sf.funded.length} wallets</span>
            {sf.funding_tx_sigs?.[0] && (
              <>
                {" · "}
                <a
                  href={`https://solscan.io/tx/${sf.funding_tx_sigs[0]}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "#34d399", fontFamily: "monospace" }}
                >
                  {shortAddr(sf.funding_tx_sigs[0])} ↗
                </a>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chip
// ---------------------------------------------------------------------------

function Chip({ label, value, color }) {
  return (
    <div style={{
      display: "flex",
      gap: 5,
      alignItems: "center",
      background: `${color}11`,
      border: `1px solid ${color}33`,
      borderRadius: 4,
      padding: "2px 8px",
      fontSize: 11,
    }}>
      <span style={{ color: "#6b7280" }}>{label}</span>
      <span style={{ color, fontWeight: 700 }}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function Empty({ message, sub, isError }) {
  return (
    <div style={{
      padding: "36px 24px",
      textAlign: "center",
      color: isError ? "#ef4444" : "#4b5563",
    }}>
      <div style={{ fontSize: 13 }}>{message}</div>
      {sub && (
        <div style={{ fontSize: 11, marginTop: 6, color: "#374151" }}>{sub}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WalletTable (main)
// Exported as forwardRef so the dashboard can call getRawEvidence() to
// merge the payload into the groq-brief POST.
// ---------------------------------------------------------------------------

const SORT_OPTIONS = [
  { key: "coordinated_txs", label: "Coordination" },
  { key: "tx_count",        label: "Tx count"     },
  { key: "first_seen",      label: "First seen"   },
];

/** Client-side ceiling for the evidence build. Server maxDuration is 60s; abort a little
 *  past that so the panel shows a real timeout state instead of an endless "Building evidence…". */
const EVIDENCE_TIMEOUT_MS = 70_000;

const WalletTable = forwardRef(function WalletTable(
  { scope, lookback = 24, className = "", onStatus },
  ref
) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sortKey, setSortKey] = useState("coordinated_txs");
  const [filter, setFilter] = useState("");

  // Monotonic request id so a slow (up to 70s) build for a previous scope can't land
  // after a newer one and repopulate the table with old-scope rows.
  const reqSeqRef = useRef(0);

  const load = useCallback(async () => {
    if (!scope) return;
    const reqId = ++reqSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/evidence?scope=${encodeURIComponent(scope)}&lookback=${lookback}`,
        { signal: AbortSignal.timeout(EVIDENCE_TIMEOUT_MS) }
      );
      const json = await res.json().catch(() => ({}));
      if (reqId !== reqSeqRef.current) return; // superseded by a newer build — drop it
      if (!res.ok) throw new Error(json.error ?? `Request failed (HTTP ${res.status})`);
      setData(json);
    } catch (err) {
      if (reqId !== reqSeqRef.current) return;
      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
      setError(
        timedOut
          ? `Evidence build timed out after ${Math.round(EVIDENCE_TIMEOUT_MS / 1000)}s — this scope is very large. Try a shorter lookback, or Refresh to retry.`
          : err.message
      );
      // Don't leave the previous build's rows rendering under the error state.
      setData(null);
    } finally {
      if (reqId === reqSeqRef.current) setLoading(false);
    }
  }, [scope, lookback]);

  // A new scope's fetch can take up to 70s — clear the old scope's rows immediately so
  // they can't render (or feed getRawEvidence) under the new watch target.
  useEffect(() => {
    setData(null);
    setError(null);
  }, [scope]);

  useEffect(() => { load(); }, [load]);

  // Report load state up so the dashboard can drive the staged progress indicator.
  useEffect(() => {
    onStatus?.({ loading, hasData: Boolean(data), error, summary: data?.summary ?? null });
  }, [loading, data, error, onStatus]);

  // Expose raw evidence payload for groq-brief merging + a reload() the dashboard's
  // Re-Analyze button can call to force-refresh evidence.
  useImperativeHandle(ref, () => ({
    getRawEvidence: () => data,
    reload: load,
  }), [data, load]);

  // Sort + filter
  const wallets = data?.wallets ?? [];
  const displayed = wallets
    .filter((w) =>
      filter ? w.address.toLowerCase().includes(filter.toLowerCase()) : true
    )
    .slice()
    .sort((a, b) => {
      if (sortKey === "first_seen") {
        return new Date(a.first_seen) - new Date(b.first_seen);
      }
      return b[sortKey] - a[sortKey];
    });

  const flaggedCount = wallets.filter((w) => w.coordinated_txs > 0).length;
  const linkedCount  = wallets.filter((w) => w.funded_by).length;

  return (
    <section
      className={className}
      style={{
        background: "#0f172a",
        border: "1px solid #1e293b",
        borderRadius: 8,
        overflow: "hidden",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
      {/* Header */}
      <div style={{
        padding: "14px 16px",
        borderBottom: "1px solid #1e293b",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        flexWrap: "wrap",
      }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>
            Wallet table
          </div>
          <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>
            Evidence-ranked · {lookback}h lookback
          </div>
        </div>

        {data && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Chip label="Wallets"     value={wallets.length}                      color="#6366f1" />
            <Chip label="Flagged"     value={flaggedCount}                        color="#ef4444" />
            <Chip label="Linked"      value={linkedCount}                         color="#10b981" />
            <Chip label="Coord events" value={data.summary.coordinated_events}   color="#f59e0b" />
          </div>
        )}

        <button
          onClick={load}
          disabled={loading}
          style={{
            padding: "5px 12px",
            borderRadius: 4,
            border: "1px solid #334155",
            background: "transparent",
            color: loading ? "#374151" : "#94a3b8",
            fontSize: 12,
            cursor: loading ? "default" : "pointer",
          }}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {/* Shared funder alert */}
      {data?.shared_funders?.length > 0 && (
        <div style={{ padding: "12px 0 0" }}>
          <SharedFunderAlert sharedFunders={data.shared_funders} />
        </div>
      )}

      {/* Controls */}
      <div style={{
        padding: "10px 16px",
        borderBottom: "1px solid #1e293b",
        display: "flex",
        gap: 8,
        alignItems: "center",
        flexWrap: "wrap",
        marginTop: data?.shared_funders?.length > 0 ? 12 : 0,
      }}>
        <span style={{ fontSize: 11, color: "#6b7280", marginRight: 2 }}>Sort:</span>
        {SORT_OPTIONS.map((o) => (
          <button
            key={o.key}
            onClick={() => setSortKey(o.key)}
            style={{
              padding: "3px 10px",
              borderRadius: 4,
              border: "1px solid",
              borderColor: sortKey === o.key ? "#6366f1" : "#334155",
              background: sortKey === o.key ? "#6366f122" : "transparent",
              color: sortKey === o.key ? "#818cf8" : "#94a3b8",
              fontSize: 12,
              cursor: "pointer",
              fontWeight: sortKey === o.key ? 600 : 400,
            }}
          >
            {o.label}
          </button>
        ))}
        <input
          placeholder="Filter address…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{
            marginLeft: "auto",
            padding: "4px 10px",
            borderRadius: 4,
            border: "1px solid #334155",
            background: "#020617",
            color: "#e2e8f0",
            fontSize: 12,
            width: 180,
            outline: "none",
          }}
        />
      </div>

      {/* States */}
      {!scope && (
        <Empty message="Set a watch target above to load the wallet table." />
      )}
      {scope && loading && !data && (
        <Empty message="Building evidence…" />
      )}
      {error && (
        <Empty
          message={`Error: ${error}`}
          sub="Check that the pipeline has run and your DB is connected."
          isError
        />
      )}
      {data && wallets.length === 0 && (
        <Empty
          message="No wallets found in this lookback window."
          sub="Run npm run ingest-events -- <address> first."
        />
      )}

      {/* Table */}
      {displayed.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 680 }}>
            <thead>
              <tr>
                <th style={TH}>#</th>
                <th style={TH}>Address</th>
                <th style={TH}>Role</th>
                <th style={{ ...TH, textAlign: "right" }}>Txs</th>
                <th style={{ ...TH, textAlign: "right" }}>Coordinated</th>
                <th style={TH}>Funded by</th>
                <th style={TH}>First seen (UTC)</th>
                <th style={TH}></th>
              </tr>
            </thead>
            <tbody>
              {displayed.map((wallet, i) => (
                <WalletRow key={wallet.address} wallet={wallet} index={i} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer */}
      {data && (
        <div style={{
          padding: "8px 16px",
          borderTop: "1px solid #1e293b",
          fontSize: 11,
          color: "#1f2937",
          display: "flex",
          justifyContent: "space-between",
        }}>
          <span>
            Generated {new Date(data.generated_at).toUTCString()} ·{" "}
            {data.summary.edges_found} edges · Click row to expand
          </span>
          <span>Probabilistic signals — not legal findings</span>
        </div>
      )}
    </section>
  );
});

export default WalletTable;
