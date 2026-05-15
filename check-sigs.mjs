import('./lib/db.js').then(({openDb}) => {
  const db = openDb();
  const scope = 'Xqfwj8PrgpjksqgnopR9DwDuNZAXrqVHDbdcQ34pump';
  const r = db.prepare('SELECT COUNT(*) as total, COUNT(block_time) as with_time FROM signatures WHERE scope_address = ?').get(scope);
  console.log('signatures - total:', r.total, '| with block_time:', r.with_time);
  const t = db.prepare('SELECT COUNT(*) as total FROM transfers WHERE scope_address = ?').get(scope);
  console.log('transfers total:', t.total);
  db.close();
}).catch(e => console.error(e.message));
