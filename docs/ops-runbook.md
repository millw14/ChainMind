# Ops runbook — keep Turso filled without living in the terminal

Your **hosted dashboard** reads **Turso**. New graph rows (`edges`) appear only after you **parse txs locally** and **upload** them. This doc is the shortest path to “set and forget.”

## One command to run after work on your machine

From the **ChainMind** repo root (with `.env.local` loaded — same folder you use for `npm run dev`):

```bash
npm run mirror:up
```

That runs **`pipeline:once`** (pull + parse scopes from your watchlist into local SQLite) then **`turso:sync`** (push signatures, events, **edges**, etc. to Turso).

Run it when you want the cloud DB to catch up, or put it on a schedule (below).

## First-time checklist

1. **Turso** — create DB, apply schema (`npm run turso:schema` or your usual SQL).
2. **Env** — in `.env.local`: `SOLANA_RPC_URL`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, optional `DATABASE_PATH`.
3. **Watchlist** — copy `config/watchlist.example.json` → `config/watchlist.json` and list the scopes you care about.
4. **Deep history (once per scope)** — e.g. `npm run backfill -- <ADDRESS> --max=2000` (or `--resume`) so you’re not only tailing the tip.
5. **Then** use `npm run mirror:up` (or `npm run pipeline` if you want a continuous loop on a dedicated machine).

## Schedule it (you don’t need to be at the keyboard)

**Linux / macOS cron** (every 15 minutes — adjust path and user):

```cron
*/15 * * * * cd /path/to/ChainMind && /usr/bin/npm run mirror:up >> /tmp/chainmind-mirror.log 2>&1
```

**Windows** — use **Task Scheduler**: action = `npm`, arguments = `run mirror:up`, start in = your ChainMind folder. Pick a sensible repeat interval (e.g. 15–30 minutes).

**Always-on small VPS** — same as cron; optionally use `npm run pipeline` instead of `mirror:up` so a single process keeps catching up between syncs (then sync on a timer, or add sync to a wrapper).

## Sanity check on the dashboard

After a successful **`mirror:up`**, open **Synced datastore**:

- **Edges** / **Funding-like** should be **> 0** for scopes that have ingested graph data.
- If they stay **0**, local ingest isn’t producing `edges` yet (no backfill / parsing issue) or sync isn’t reaching Turso.

## If something breaks

- **401 / Turso**: rotate `TURSO_AUTH_TOKEN`, confirm URL.
- **RPC 429**: raise throttle envs or use a better RPC tier; pipeline backs off but still needs capacity.
- **Empty graph**: confirm `config/watchlist.json` includes the same **scope** you’re scoring on the dashboard.

That’s the whole loop: **watchlist + pipeline + turso:sync**, preferably **on a timer** so you’re not doing it by hand.

## Autonomous surface scan (hosted)

1. Apply Turso migration **`schema/migrations/005_surface_hits.sql`** (or re-run full `schema/turso.sql`). In the **Turso web SQL** editor, run **one statement at a time** (paste only the `CREATE TABLE …` block, execute; then each `CREATE INDEX …` separately). Pasting the whole file often triggers a generic “syntax error”.
2. In Vercel env: **`CRON_SECRET`**, **`CHAINMIND_WATCHLIST_JSON`** (compact JSON string of `{ "scopes": [ { "address": "…" } ] }`), **`NEXT_PUBLIC_APP_URL`** (stable site URL for self-calls).
3. **`vercel.json`** schedules **`GET /api/cron/surface-scan`** (default every 20 minutes) with `Authorization: Bearer CRON_SECRET`.
4. Dashboard **Autonomous surfaces** reads **`GET /api/surface-feed`**. Click a row to set that scope as the watch target.

Rules today use **ingested** Turso data (co-activity, funding graph slice, event-rate proxy). **DEX volume, oracle price, and news correlation** are documented in API responses as **`rulesNotYetWired`** — add external feeds when you wire them.
