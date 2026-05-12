# Strategic plan — data pipeline & scale

This document aligns engineering work with the coordination-intelligence vision. Phases build on each other; later phases assume earlier ones are stable in production.

## North-star outcomes

- **Continuous coverage:** watched scopes stay current without manual CLI steps.
- **Semantic events:** stored rows support analyst questions (“swap vs transfer vs LP”), not only “this tx touched this mint.”
- **Relationship intelligence:** wallet–wallet structure is queryable at scale (edges + time), not only scope→fee_payer aggregates.
- **Operate at cost:** RPC and database usage stay bounded under backoff, caps, and monitoring.

---

## Phase 0 — Baseline (shipped in repo)

- Local SQLite + optional Turso mirror for dashboard scoring.
- CLI: `backfill-address`, `ingest-events`, `sync-sqlite-to-turso`.
- Parsed `events` with coarse `event_type` (`swap_eligible`, `spl`, `other`, …).

## Phase 1 — Multi-scope orchestration (**in progress**)

**Goal:** one always-on loop over many scopes: **new signatures → parse → events**, with fair RPC use.

**Shipped in this repo:**

- Composite primary key on `signatures (signature, scope_address)` (local SQLite auto-migrates on open; Turso migration SQL provided).
- `config/watchlist.example.json` → copy to `config/watchlist.json` (gitignored).
- `lib/watchlist.js`, `lib/pipeline-sync.js` (head catch-up + parse batch).
- `scripts/pipeline-worker.mjs` + `npm run pipeline` / `npm run pipeline:once`.
- `backfill-address.mjs --resume` for deep historical pagination from `ingest_state`.
- Marketing docs + `.env.example` entries.

**Next (still open):**

- Ops packaging: systemd/Docker/hosted worker; structured logs; metrics (lag, backlog, 429s).
- Per-scope budgets in watchlist JSON; admin UI for watchlist edits.
- Phase 2–4 items in this document.

## Phase 2 — Event classification

**Goal:** types that match how analysts think (swap, transfer, LP add/remove, etc.), with testable parsers.

**Work:**

- Define a versioned event schema (columns + JSON for extras).
- Program-specific decoders for the DEX/LP stacks you commit to supporting—or ingest from an external decoder/indexer.
- Golden tests from real signatures per program.
- Backfill re-parse strategy (`events_v2` or migration + replay).

## Phase 3 — Graph / adjacency model

**Goal:** answer wallet–wallet questions (shared activity, funding-like flows, clusters) without full-table scans.

**Work:**

- `wallet_links` / `edges` table: `src`, `dst`, `kind`, `evidence_sig`, `block_time`, optional amount/mint; indexes on time + endpoint.
- Writers derived from classified events (same-tx participants, SPL transfers, etc.).
- API or SQL views for “neighbors,” “top counterparties in window,” bounded-depth path (with limits).

**Note:** Turso/libSQL can hold adjacency lists; move to a dedicated graph engine only if traversal patterns justify it.

## Phase 4 — Scale & reliability

**Goal:** grow scope count and history without surprise cost or outages.

**Work:**

- Measure: writes/day, row counts, p95 parse latency, RPC error budget.
- Queue (e.g. SQS / Redis / PG job table) between “discover sig” and “parse tx” if needed.
- Retention tiers (hot recent vs cold archive); optional warehouse for analytics.
- Evaluate Turso limits with real load; plan Postgres / split read replicas / batch export if needed.

---

## How to run Phase 1 today

1. Copy `config/watchlist.example.json` → `config/watchlist.json` and list base58 scopes.
2. Ensure `DATABASE_PATH` (optional) and RPC env from `.env.local`.
3. Initial deep history (per scope): `npm run backfill -- <addr> --max=2000`
4. Continuous loop: `npm run pipeline` (or `npm run pipeline:once` for a single round).
5. Optional: `npm run turso:sync` on a schedule to refresh cloud scoring.

---

## Decision log

- **Polling before streaming:** Yellowstone / dedicated indexer is Phase 4+ unless RPC becomes the blocker.
- **Composite PK on signatures:** required for correct multi-scope indexing.
- **Graph DB optional:** model edges relationally first; prove query shapes before Neo4j-style spend.
