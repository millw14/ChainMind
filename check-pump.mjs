import('./lib/db.js').then(({openDb}) => {
  const db = openDb();
  const scope = 'Xqfwj8PrgpjksqgnopR9DwDuNZAXrqVHDbdcQ34pump';
  const events = db.prepare('SELECT COUNT(*) as c FROM events WHERE scope_address = ?').get(scope);
  const edges = db.prepare('SELECT COUNT(*) as c FROM edges WHERE scope_address = ?').get(scope);
  const transfers = db.prepare('SELECT COUNT(*) as c FROM transfers WHERE scope_address = ?').get(scope);
  const overlap = db.prepare('SELECT COUNT(DISTINCT e.to_address) as c FROM edges e INNER JOIN events ev ON ev.fee_payer = e.to_address AND ev.scope_address = e.scope_address WHERE e.scope_address = ? AND e.edge_type = ?').get(scope, 'native_transfer');
  console.log('events:', events.c, '| edges:', edges.c, '| transfers:', transfers.c, '| fee_payer overlap:', overlap.c);
  db.close();
}).catch(e => console.error(e.message));
