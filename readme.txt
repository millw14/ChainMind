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

Free deploy — no Railway (Vercel Hobby + Turso free + GitHub Actions):
  1. Turso (turso.tech): create a DB, grab TURSO_DATABASE_URL + TURSO_AUTH_TOKEN.
     Schema is applied automatically by the ingest workflow (or run npm run turso:schema).
  2. Vercel env: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, SOLANA_RPC_URL, GROQ_API_KEY,
     CRON_SECRET (long random string), CHAINMIND_WATCHLIST_JSON, NEXT_PUBLIC_APP_URL
     (the public domain — self-fetching crons break behind Deployment Protection).
     Never set CHAINMIND_LOCAL_DB=1 on Vercel.
  3. vercel.json keeps 2 daily crons (Hobby limit): analyst-sweep + surface-scan
     (surface-scan includes the cross-mint recompute).
  4. GitHub Actions replaces the always-on ingest worker:
       .github/workflows/ingest.yml   — every 30 min: one pipeline round + Turso sync.
         Secrets: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, CHAINMIND_WATCHLIST_JSON,
         SOLANA_RPC_URL.
       .github/workflows/baseline.yml — daily baseline-update via the API route.
         Secrets: APP_URL, CRON_SECRET.
     Note: GitHub disables schedules after 60 days without repo activity; private
     repos burn the 2000 free min/month fast — keep the repo public or lower cadence.
  5. Local alternative to (4): npm run mirror:up  (one ingest round + Turso sync),
     or npm run pipeline -- --turso-sync for a continuous loop while your PC is on.

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
