import { openDb } from './lib/db.js';
const db = openDb();
const scope = 'Xqfwj8PrgpjksqgnopR9DwDuNZAXrqVHDbdcQ34pump';
const rows = db.prepare(
  'SELECT DISTINCT from_address, to_address, edge_type, COUNT(*) as cnt FROM edges WHERE scope_address = ? GROUP BY from_address, to_address, edge_type ORDER BY cnt DESC LIMIT 20'
).all(scope);
console.log(JSON.stringify(rows, null, 2));
db.close();
