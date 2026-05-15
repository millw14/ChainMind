import('./lib/db.js').then(({openDb}) => {
  const db = openDb();
  const scope = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const e = db.prepare('DELETE FROM events WHERE scope_address = ?').run(scope);
  const ed = db.prepare('DELETE FROM edges WHERE scope_address = ?').run(scope);
  const tr = db.prepare('DELETE FROM transfers WHERE scope_address = ?').run(scope);
  console.log('Deleted events:', e.changes, 'edges:', ed.changes, 'transfers:', tr.changes);
  db.close();
}).catch(e => console.error(e.message));
