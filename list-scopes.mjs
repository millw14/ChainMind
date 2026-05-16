import('./lib/db.js').then(({openDb}) => {
  const db = openDb();
  const rows = db.prepare('SELECT scope_address, COUNT(*) as c FROM events GROUP BY scope_address').all();
  console.log(JSON.stringify(rows, null, 2));
  db.close();
}).catch(e => console.error(e.message));
