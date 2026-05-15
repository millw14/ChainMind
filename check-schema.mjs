import('./lib/db.js').then(({openDb}) => {
  const db = openDb();
  const rows = db.prepare('PRAGMA table_info(signatures)').all();
  console.log(rows.map(r => r.name).join(', '));
  db.close();
}).catch(e => console.error(e.message));
