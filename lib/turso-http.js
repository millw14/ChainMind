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
          args: args.map(a => typeof a === 'number'
            ? { type: 'integer', value: String(a) }
            : { type: 'text', value: String(a ?? '') })
        }
      }]
    })
  });
  const data = await res.json();
  return data.results?.[0]?.response?.result?.rows ?? [];
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
  } catch { return []; }
}

export async function tursoHttpMarkScanQueuePicked(address) {
  const client = getTursoHttp();
  if (!client) return;
  try {
    await tursoExecute(client,
      'UPDATE scan_queue SET status = ?, last_picked_at = unixepoch() WHERE address = ?',
      ['active', address]
    );
  } catch {}
}
