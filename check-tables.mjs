import('./lib/db.js').then(({openDb}) => {
  const db = openDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log(tables.map(t => t.name).join(', '));
  db.close();
}).catch(e => console.error(e.message));
