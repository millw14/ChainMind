ChainMind repo — Solana + Groq scaffold.

Open locally: C:\Users\LENOVO\Mami Projects\ChainMind (or your clone path)

=== Deploy to Vercel (GitHub) ===
1. Push this folder to GitHub (standalone repo, or monorepo with Root Directory = ChainMind).
2. Vercel → Add Project → import the repo.
3. If the repo root is NOT ChainMind, set Project Settings → General → Root Directory → ChainMind.
4. Environment Variables (Production + Preview):
   - SOLANA_RPC_URL = your RPC (Helius / QuickNode / etc.) — required for Ping + Inspect.
   Optional for DB stats + Score on the web:
   - TURSO_DATABASE_URL = from turso.tech (libsql URL)
   - TURSO_AUTH_TOKEN = Turso token
5. Deploy. Open the site URL — same UI as public/index.html.
6. First-time Turso: locally run  npm run turso:schema  (with TURSO_* in .env.local).
7. After local backfill + ingest-events, push data up:  npm run turso:sync

API routes (serverless): /api/ping  /api/inspect  /api/db-stats  /api/score

=== Local only ===
  npm run dashboard  → http://127.0.0.1:3847/

CLI (from repo root):
  npm run ping-solana
  npm run inspect -- <base58> [--verbose]
  npm run backfill -- <base58> [--max=200]
  npm run ingest-events -- <base58> [--limit=40] [--throttle=1500]
  npm run score-window -- <base58> [--window=5] [--hours=24]

Pipeline: backfill → ingest-events → score-window (local SQLite data/chainmind.db).
Then optional: npm run turso:sync  (copies SQLite → Turso for the live site).

Data: local SQLite data/chainmind.db | production mirror optional via Turso
