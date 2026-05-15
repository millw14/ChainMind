import('./lib/db.js').then(({openDb}) => {
  const db = openDb();
  const scope = 'Xqfwj8PrgpjksqgnopR9DwDuNZAXrqVHDbdcQ34pump';
  const r = db.prepare('SELECT COUNT(*) as total, COUNT(block_time) as with_time FROM events WHERE scope_address = ?').get(scope);
  console.log('total events:', r.total, '| with block_time:', r.with_time);
  db.close();
}).catch(e => console.error(e.message));
