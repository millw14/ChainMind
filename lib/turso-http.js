/**
 * Minimal Turso HTTP client for Railway pipeline worker.
 * Uses fetch instead of @libsql/client to avoid native binary issues.
 */

function getTursoHttp() {
  const url = process.env.TURSO_DATABASE_URL?.trim()?.replace('libsql://', 'https://');
  const token = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !token) return null;
  return { url, token };
}

async function tursoExecute(client, sql, args = []) {
  const res = await fetch(`${client.url}/v2/pipeline`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${client.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: [{
        type: 'execute',
        stmt: {
          sql,
          args: args.map(a => a == null
            ? { type: 'null' }
            : typeof a === 'number'
              ? { type: 'integer', value: String(a) }
              : { type: 'text', value: String(a) })
        }
      }]
    })
  });
  if (!res.ok) throw new Error(`Turso HTTP ${res.status}`);
  const data = await res.json();
  const r = data.results?.[0];
  if (r?.type === 'error') throw new Error(r.error?.message ?? 'Turso error');
  return r?.response?.result?.rows ?? [];
}

export async function tursoHttpFetchPendingScanQueue(limit = 10) {
  const client = getTursoHttp();
  if (!client) return [];
  // Recover ghost jobs: an 'active' row whose worker died mid-round never flips back,
  // so anything 'active' but not re-picked within the stale window is reclaimed here.
  const staleSeconds = Math.max(60, Number(process.env.SCAN_QUEUE_STALE_ACTIVE_SECONDS) || 3600);
  try {
    const rows = await tursoExecute(client,
      `SELECT address, added_at, note FROM scan_queue
       WHERE status = 'pending'
          OR (status = 'active' AND (last_picked_at IS NULL OR last_picked_at < unixepoch() - ?))
       ORDER BY added_at ASC LIMIT ?`,
      [staleSeconds, limit]
    );
    return rows.map(r => ({ address: String(r[0]?.value ?? ''), note: r[2]?.value ?? null }));
  } catch (e) {
    console.error('[scan-queue] fetch failed:', e?.message ?? e);
    return [];
  }
}

export async function tursoHttpAddToScanQueue(address, note = null) {
  const client = getTursoHttp();
  if (!client) return;
  try {
    await tursoExecute(client,
      `INSERT OR IGNORE INTO scan_queue (address, added_at, status, note) VALUES (?, unixepoch(), 'pending', ?)`,
      [address, note]
    );
  } catch (e) {
    console.error('[scan-queue] add failed:', e?.message ?? e);
  }
}

export async function tursoHttpMarkScanQueuePicked(address) {
  const client = getTursoHttp();
  if (!client) return;
  try {
    await tursoExecute(client,
      'UPDATE scan_queue SET status = ?, last_picked_at = unixepoch() WHERE address = ?',
      ['active', address]
    );
  } catch (e) {
    console.error('[scan-queue] mark-picked failed:', e?.message ?? e);
  }
}

/**
 * Drop-in, @libsql/client-compatible client built on pure fetch — same
 * `.execute({ sql, args })` shape, returning rows keyed by column name. Used by
 * code paths (e.g. baseline:update on Railway) that must NOT import
 * @libsql/client, whose native `libsql` dep fails to load in that environment.
 *
 * @returns {{ execute: (q: string | { sql: string, args?: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> } | null}
 */
export function getTursoHttpClient() {
  const client = getTursoHttp();
  if (!client) return null;
  return {
    async execute(q) {
      const sql = typeof q === "string" ? q : q.sql;
      const args = typeof q === "string" ? [] : q.args ?? [];
      const res = await fetch(`${client.url}/v2/pipeline`, {
        method: "POST",
        headers: { Authorization: `Bearer ${client.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [{
            type: "execute",
            stmt: {
              sql,
              args: args.map((a) =>
                a == null ? { type: "null" }
                // Non-integer numbers must use the float type — encoding e.g. 12.3456
                // as an integer makes Turso reject the request (HTTP 400). baseline
                // stats (mean/std) are floats, so this matters for persistBaseline.
                : typeof a === "number"
                  ? (Number.isInteger(a) ? { type: "integer", value: String(a) } : { type: "float", value: a })
                : typeof a === "bigint" ? { type: "integer", value: String(a) }
                : { type: "text", value: String(a) }),
            },
          }],
        }),
      });
      if (!res.ok) throw new Error(`Turso HTTP ${res.status}`);
      const data = await res.json();
      const r = data.results?.[0];
      if (r?.type === "error") throw new Error(r.error?.message ?? "Turso error");
      const result = r?.response?.result;
      const cols = (result?.cols ?? []).map((c) => c.name);
      const rows = (result?.rows ?? []).map((row) => {
        /** @type {Record<string, unknown>} */
        const obj = {};
        row.forEach((cell, i) => { obj[cols[i]] = cell?.value ?? null; });
        return obj;
      });
      return { rows };
    },
  };
}

/**
 * Events for a scope since cutoff, via the HTTP client — mirrors
 * fetchEventsForScope in lib/turso.js but without the @libsql/client import.
 * @param {ReturnType<typeof getTursoHttpClient>} client
 */
export async function fetchEventsForScopeHttp(client, scope, cutoffSec) {
  if (!client) return [];
  const result = await client.execute({
    sql: `SELECT fee_payer, block_time, programs_json, event_type
          FROM events
          WHERE scope_address = ? AND block_time IS NOT NULL
            AND block_time >= ? AND fee_payer IS NOT NULL
          ORDER BY block_time ASC`,
    args: [scope, cutoffSec],
  });
  return result.rows.map((row) => ({
    fee_payer: String(row.fee_payer ?? ""),
    block_time: Number(row.block_time),
    programs_json: String(row.programs_json ?? "[]"),
    event_type: String(row.event_type ?? "other"),
  }));
}
