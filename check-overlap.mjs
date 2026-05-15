import('./lib/db.js').then(({openDb}) => {
  const db = openDb();
  const scope = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const sql = 'SELECT e.to_address, COUNT(*) as edge_count FROM edges e INNER JOIN events ev ON ev.fee_payer = e.to_address AND ev.scope_address = e.scope_address WHERE e.scope_address = ? AND e.edge_type = ? GROUP BY e.to_address LIMIT 10';
  const rows = db.prepare(sql).all(scope, 'native_transfer');
  console.log(JSON.stringify(rows, null, 2));
  db.close();
}).catch(e => console.error(e.message));
