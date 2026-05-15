import('./lib/db.js').then(({openDb}) => {
  const db = openDb();
  const result = db.prepare('UPDATE signatures SET parsed = 0 WHERE scope_address = ?').run('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  console.log('Reset rows:', result.changes);
  db.close();
}).catch(e => console.error(e.message));
