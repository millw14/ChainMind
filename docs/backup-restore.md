# Backup & restore — self-hosted libSQL

The production DB is self-hosted **libSQL** on Railway (`libsql-production-9bc3.up.railway.app`),
data on a single Railway volume. A volume loss = data loss, so back up regularly.

Auth token + URL: `data/.libsql-auth.json` (gitignored). Keep it safe — it's the DB credential.

## What's irreplaceable vs regenerable
- **Irreplaceable:** `investigation_cases` (saved cases), `groq_analysis_log` (verdict cache),
  `scope_baselines`, `mint_decimals`, `wallet_first_seen`.
- **Regenerable from chain:** `signatures`, `events`, `transfers`, `edges`, `signers`,
  `program_calls` — the worker rebuilds these by re-ingesting.

## Backup (logical dump → portable SQLite file)
Tested, read-only against the server. Produces a single `.db` file you can store anywhere.

```bash
# from repo root; token from data/.libsql-auth.json
LIBSQL_URL="https://libsql-production-9bc3.up.railway.app" \
LIBSQL_TOKEN="<jwt from data/.libsql-auth.json>" \
EXPORT_OUT_PATH="data/backups/libsql-$(date -u +%Y%m%dT%H%M%SZ).db" \
EXPORT_PAGE_SIZE=800 \
node scripts/export-turso-to-sqlite.mjs
```

**Store the resulting file off-Railway** (a volume backup that lives on the same volume is
useless). Options: download it locally, push to object storage, or commit-LFS to a private repo.

## Restore (into a fresh / replacement libSQL)
1. Stand up a new libSQL service (Railway → Docker image `ghcr.io/tursodatabase/libsql-server:latest`,
   volume at `/var/lib/sqld`, `SQLD_NODE=primary`, `SQLD_HTTP_LISTEN_ADDR=0.0.0.0:8080`,
   `SQLD_AUTH_JWT_KEY=<key>`; add a public domain on port 8080).
2. Apply schema: `LIBSQL_URL=… LIBSQL_TOKEN=… node scripts/apply-schema-libsql.mjs`
3. Load data: point `import-sqlite-to-libsql.mjs` at the backup file and run it
   (`LIBSQL_URL=… LIBSQL_TOKEN=… IMPORT_BATCH=500 node scripts/import-sqlite-to-libsql.mjs`,
   with `data/chainmind-export.db` = your backup, or adjust the path).
4. Flip `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` on Vercel + the Railway worker to the new instance.

This is the exact path used for the original Turso→libSQL migration, so it's proven.

## Recommended: continuous off-site backup (do when you can)
The robust long-term answer is sqld's **bottomless S3 replication** — continuous backup to an
S3-compatible bucket (e.g. Cloudflare R2, free tier). It needs a bucket + keys, then env on the
libSQL service. Until that's set up, run the logical dump above on a schedule (e.g. daily) and
keep the last few files off-Railway.

## Interim safety net
The original **Turso** instance still holds the migration snapshot (everything up to cutover) as a
warm fallback. Don't decommission it until off-site backups are in place.

## Off-site backup is configured (Cloudflare R2)
R2 creds live in `.env.local` (`R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`). One command dumps the critical tables and uploads them:

```bash
npm run backup        # critical tables only (small, fast) → R2 bucket/backups/critical-<ts>.db
npm run backup:full   # entire DB (large, slow over a flaky link)
```

Backups land in the `chainmindbackups` bucket under `backups/`. Schedule `npm run backup`
(e.g. daily via Task Scheduler / cron) for hands-off off-site durability.
