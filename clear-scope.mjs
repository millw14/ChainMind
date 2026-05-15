import('./lib/db.js').then(({openDb}) => {
  const db = openDb();
  const scope = 'Xqfwj8PrgpjksqgnopR9DwDuNZAXrqVHDbdcQ34pump';
  const e = db.prepare('DELETE FROM events WHERE scope_address = ?').run(scope);
  const ed = db.prepare('DELETE FROM edges WHERE scope_address = ?').run(scope);
  const tr = db.prepare('DELETE FROM transfers WHERE scope_address = ?').run(scope);
  const s = db.prepare('DELETE FROM signatures WHERE scope_address = ?').run(scope);
  console.log('Cleared - events:', e.changes, 'edges:', ed.changes, 'transfers:', tr.changes, 'signatures:', s.changes);
  db.close();
}).catch(e => console.error(e.message));
