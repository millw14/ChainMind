import('./lib/db.js').then(({openDb}) => {
  const db = openDb();
  const rows = db.prepare('PRAGMA table_info(cases)').all();
  console.log(rows.length ? rows.map(r => r.name).join(', ') : 'table does not exist');
  db.close();
}).catch(e => console.error(e.message));
