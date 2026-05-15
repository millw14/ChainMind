import('./lib/db.js').then(({openDb}) => {
  const db = openDb();
  const scope = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  db.prepare('DELETE FROM events WHERE scope_address = ?').run(scope);
  db.prepare('DELETE FROM edges WHERE scope_address = ?').run(scope);
  db.prepare('DELETE FROM transfers WHERE scope_address = ?').run(scope);
  db.prepare('DELETE FROM signatures WHERE scope_address = ?').run(scope);
  console.log('Cleared devnet USDC data');
  db.close();
}).catch(e => console.error(e.message));
