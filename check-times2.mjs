import('./lib/db.js').then(({openDb}) => {
  const db = openDb();
  const scope = 'Xqfwj8PrgpjksqgnopR9DwDuNZAXrqVHDbdcQ34pump';
  const r = db.prepare('SELECT MIN(block_time) as min_bt, MAX(block_time) as max_bt FROM events WHERE scope_address = ?').get(scope);
  console.log('min block_time:', r.min_bt, new Date(r.min_bt * 1000).toISOString());
  console.log('max block_time:', r.max_bt, new Date(r.max_bt * 1000).toISOString());
  const cutoff = Math.floor(Date.now() / 1000) - 168 * 3600;
  console.log('cutoff:', cutoff, new Date(cutoff * 1000).toISOString());
  console.log('events in window:', db.prepare('SELECT COUNT(*) as c FROM events WHERE scope_address = ? AND block_time >= ?').get(scope, cutoff).c);
  db.close();
}).catch(e => console.error(e.message));
