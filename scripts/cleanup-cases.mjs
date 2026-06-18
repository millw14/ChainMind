// One-off: collapse duplicate investigation_cases on the new libSQL server.
// - Deletes cases for known entities (USDC etc.).
// - Keeps only the latest case per (scope, day); deletes the rest.
// Full original set remains in data/chainmind-export.db as backup.
import fs from "node:fs";
import { createClient } from "@libsql/client/web";
import { isKnownEntity } from "../lib/known-entities.js";

const { token } = JSON.parse(fs.readFileSync("data/.libsql-auth.json", "utf8"));
const c = createClient({ url: "https://libsql-production-9bc3.up.railway.app", authToken: token });

const before = Number((await c.execute("SELECT COUNT(*) c FROM investigation_cases")).rows[0].c);
const rows = (await c.execute("SELECT id, scope_address, created_at FROM investigation_cases")).rows.map((r) => ({
  id: String(r.id),
  scope: String(r.scope_address ?? ""),
  created: Number(r.created_at) || 0,
}));

const keep = new Map(); // key scope|day -> {id, created}
const toDelete = [];
for (const r of rows) {
  if (isKnownEntity(r.scope)) { toDelete.push(r.id); continue; } // drop USDC/infra entirely
  const day = new Date(r.created * 1000).toISOString().slice(0, 10);
  const key = `${r.scope}|${day}`;
  const cur = keep.get(key);
  if (!cur) { keep.set(key, r); continue; }
  // keep the newer; delete the older
  if (r.created > cur.created) { toDelete.push(cur.id); keep.set(key, r); }
  else { toDelete.push(r.id); }
}

console.log(`before: ${before} | keeping: ${keep.size} | deleting: ${toDelete.length}`);
for (let i = 0; i < toDelete.length; i += 100) {
  const batch = toDelete.slice(i, i + 100);
  await c.batch(batch.map((id) => ({ sql: "DELETE FROM investigation_cases WHERE id = ?", args: [id] })), "write");
  process.stdout.write(`  deleted ${Math.min(i + 100, toDelete.length)}/${toDelete.length}\r`);
}
const after = Number((await c.execute("SELECT COUNT(*) c FROM investigation_cases")).rows[0].c);
const byScope = await c.execute("SELECT scope_address, COUNT(*) c FROM investigation_cases GROUP BY scope_address ORDER BY c DESC");
console.log(`\nafter: ${after}`);
for (const r of byScope.rows) console.log(`  ${String(r.scope_address).slice(0, 16)}: ${r.c}`);
