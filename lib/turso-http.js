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
  const res = await fetch(${client.url}/v2/pipeline, {
    method: 'POST',
    headers: {
      'Authorization': Bearer ,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: [{
        type: 'execute',
        stmt: {
          sql,
          args: args.map(a => typeof a === 'number' ? { type: 'integer', value: String(a) } : { type: 'text', value: String(a ?? '') })
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
  try {
    const rows = await tursoExecute(client,
      'SELECT address, added_at, note FROM scan_queue WHERE status = ? ORDER BY added_at ASC LIMIT ?',
      ['pending', limit]
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
