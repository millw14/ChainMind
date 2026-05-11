ChainMind — Next.js product surface + Solana CLI tools

Local dev (main UI):
  npm install
  npm run dev
  Open http://localhost:3000

Production build:
  npm run build
  npm start

Vercel + GitHub:
  - Connect the repo; Vercel detects Next.js (no vercel.json needed).
  - Set SOLANA_RPC_URL (and optional TURSO_* for DB panels).
  - Framework Preset: Next.js

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
