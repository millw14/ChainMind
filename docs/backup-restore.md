# Backup & restore — Turso Cloud

The production DB is a **Turso Cloud** database (`TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`,
same values on Vercel, the Railway-hosted pipeline worker, and the GitHub Actions secrets).
The Vercel app reads it; the always-on worker on Railway (nixpacks.toml:
`node scripts/pipeline-worker.mjs --turso-sync`) writes to it every round.

> Historical note: an earlier iteration ran a self-hosted libSQL server on Railway as the
> primary DB. That instance is retired — the restore scripts below survive from that
> migration and work against any libSQL-protocol target, including Turso Cloud.

## What's irreplaceable vs regenerable
- **Irreplaceable:** `investigation_cases` (saved cases), `groq_analysis_log` (verdict cache),
  `scope_baselines`, `mint_decimals`, `wallet_first_seen`.
- **Regenerable from chain:** `signatures`, `events`, `transfers`, `edges`, `signers`,
  `program_calls` — the worker rebuilds these by re-ingesting.

## Scheduled off-site backup (Cloudflare R2)
`.github/workflows/backup.yml` runs weekly (Mondays 04:20 UTC, plus manual dispatch) and
executes `node scripts/backup-and-upload.mjs`: dump the irreplaceable tables to a
timestamped SQLite file, upload it to the R2 bucket under `backups/critical-<ts>.db`.
It needs these repository secrets (the first step fails loudly when any is missing):
`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`.

Note GitHub auto-disables scheduled workflows after 60 days without repo activity —
re-enable under the Actions tab if backups go quiet.

## Manual backup
Same path, by hand (R2\_\* + TURSO\_\* in `.env.local`):

```bash
npm run backup        # critical tables only (small, fast) → R2 bucket/backups/critical-<ts>.db
npm run backup:full   # entire DB (large, slow over a flaky link)
```

To keep a local file without uploading, run the dump step directly:

```bash
EXPORT_OUT_PATH="data/backups/turso-$(date -u +%Y%m%dT%H%M%SZ).db" \
SKIP_TABLES=signatures,events,transfers,edges,signers,program_calls \
node scripts/export-turso-to-sqlite.mjs
```

## Restore (into a fresh / replacement Turso DB)
1. Create a new Turso database (turso.tech) and grab its URL + auth token.
2. Apply schema:
   `LIBSQL_URL=libsql://<new-db>.turso.io LIBSQL_TOKEN=<token> node scripts/apply-schema-libsql.mjs`
   (idempotent — applies `schema/turso.sql`).
3. Load data: point `import-sqlite-to-libsql.mjs` at the backup file
   (it reads `data/chainmind-export.db` — copy/rename your downloaded backup there):
   `LIBSQL_URL=… LIBSQL_TOKEN=… IMPORT_BATCH=500 node scripts/import-sqlite-to-libsql.mjs`
4. Flip `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` everywhere they live: Vercel env, the
   Railway worker env, and the GitHub Actions secrets (backup + ingest workflows).
5. Let the worker re-ingest the regenerable tables; watch `/api/health` go fresh.

This is the exact script pair used for the original Turso→libSQL migration, so it's proven.
