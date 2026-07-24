ChainMind — Next.js product surface + Solana CLI tools

Web app (Next.js):
  npm run dev  → http://localhost:3000  (marketing + navigation)
  /dashboard   — Solana analysis workspace
  /console     — redirects to /dashboard
  /docs        — setup, env vars, CLI table (operator reference)
  /how-it-works — product map for visitors

Production build:
  npm run build
  npm start

Vercel + GitHub:
  - Connect the repo; Vercel detects Next.js (vercel.json only carries the 2 cron entries).
  - Set SOLANA_RPC_URL (and optional TURSO_* for DB panels).
  - Framework Preset: Next.js
  - IMPORTANT: Do NOT set Output Directory to "public" (that was for the old static page).
    Next.js outputs to .next — leave Output Directory empty / default.

Deploy (Vercel Hobby + Turso + Railway worker):
  1. Turso (turso.tech): create a DB, grab TURSO_DATABASE_URL + TURSO_AUTH_TOKEN,
     then run npm run turso:schema (idempotent).
  2. Vercel env: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, SOLANA_RPC_URL, GROQ_API_KEY,
     CRON_SECRET (long random string), CHAINMIND_WATCHLIST_JSON, NEXT_PUBLIC_APP_URL
     (the public domain — self-fetching crons break behind Deployment Protection).
     Never set CHAINMIND_LOCAL_DB=1 on Vercel.
  3. vercel.json keeps 2 daily crons (Hobby limit): analyst-sweep + surface-scan
     (surface-scan includes the cross-mint recompute).
     .github/workflows/baseline.yml covers the daily baseline-update via the API
     route (secrets: APP_URL, CRON_SECRET).
  4. Railway runs the always-on ingest worker (nixpacks.toml:
     node scripts/pipeline-worker.mjs --turso-sync). Set the same TURSO_*,
     SOLANA_RPC_URL and CHAINMIND_WATCHLIST_JSON env there.
  5. Fallbacks if the Railway worker is down:
       .github/workflows/ingest.yml — manual dispatch: one pipeline round + sync
         (secrets: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, CHAINMIND_WATCHLIST_JSON,
         SOLANA_RPC_URL). Keep it manual-only while Railway runs.
       Locally: npm run mirror:up, or npm run pipeline -- --turso-sync.
  6. Monitoring: GET /api/health (no auth, cheap) reads the worker heartbeat the
     pipeline writes each round — 200 while fresh, 503 when the last ingest is
     >10 min old. Point UptimeRobot / healthchecks.io at it; the dashboard header
     shows the same data-live / data-stale badge.
  7. Backups: .github/workflows/backup.yml uploads a weekly critical-table dump
     to R2 (repo secrets: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, R2_ENDPOINT,
     R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY). npm run backup does the
     same by hand. See docs/backup-restore.md.

RPC provider (optional — the public RPC works out of the box):
  Robinhood Chain's public endpoint (https://rpc.mainnet.chain.robinhood.com) is
  the zero-config default and is fine for development. Move to a dedicated
  provider such as Alchemy when you want:
    - rate limits that survive real traffic (the public RPC throttles bursts,
      which shows up as slow/failed eth_* calls on the dashboard and /api/health)
    - websockets for push updates instead of polling every panel
    - webhooks (Alchemy Notify) to drive live updates without a poll loop
  To point the app at Alchemy, set ONE of these in .env.local / your host env:
    ALCHEMY_RPC_URL   — the full endpoint URL copied from the Alchemy dashboard
                        (key included). Used verbatim; preferred.
    ALCHEMY_RPC_TEMPLATE + ALCHEMY_API_KEY — when you would rather not put the
                        key in the URL. The template carries the host Alchemy
                        assigns to chain 4663, with {key} as the placeholder.
                        The app never guesses that host, so a wrong hostname can
                        never be baked in silently.
  Precedence is ROBINHOOD_RPC_URL > ALCHEMY_RPC_URL > template+key > public RPC,
  so ROBINHOOD_RPC_URL still overrides everything for any other provider.
  Blockscout (token lists, holders, transfers) is a separate service and is not
  affected by the RPC choice.

If the build says "No Output Directory named public found":
  Your Vercel project still has a static-site output override. Clear Output Directory
  and set Framework Preset to Next.js, then redeploy.

CLI / data pipeline (unchanged):
  npm run ping-solana
  npm run inspect -- <base58>
  npm run backfill -- <base58> [--max=200]
  npm run ingest-events -- <base58> [--limit=40] [--throttle=1500]
  npm run score-window -- <base58> [--window=5] [--hours=24]
  npm run turso:schema
  npm run turso:sync

Optional legacy Express dashboard (same APIs, no React):
  npm run dashboard-legacy  → http://127.0.0.1:3847/

Paths:
  app/          Next.js App Router (page + app/api/* routes)
  components/   React UI
  lib/          Shared Solana/Turso/scoring (used by API routes + scripts)
  scripts/      Node CLIs (SQLite local)

Data: data/chainmind.db local · Turso for serverless mirror (see .env.example)
