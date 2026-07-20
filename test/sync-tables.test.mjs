// Tests for the SQLite → Turso incremental sync core (lib/sync-tables.js): the
// high-water-mark resolution (local sync_state beats remote MAX), the >= boundary
// re-push, and the per-table REPLACE/IGNORE modes. The "Turso" side is a stub
// client backed by a second in-memory better-sqlite3. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SYNC_TABLES, ensureSyncState, localMarker, remoteMaxMarker, syncTable } from "../lib/sync-tables.js";

const SIGNATURES_DDL = `
  CREATE TABLE signatures (
    signature TEXT NOT NULL,
    scope_address TEXT NOT NULL,
    slot INTEGER,
    block_time INTEGER,
    err TEXT,
    summary_json TEXT,
    ingested_at TEXT NOT NULL,
    PRIMARY KEY (signature, scope_address)
  );
`;

const EDGES_DDL = `
  CREATE TABLE edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_address TEXT NOT NULL,
    from_address TEXT NOT NULL,
    to_address TEXT NOT NULL,
    tx_sig TEXT NOT NULL,
    slot INTEGER,
    edge_type TEXT NOT NULL,
    mint TEXT,
    ingested_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX idx_edges_natural_u
    ON edges (scope_address, tx_sig, from_address, to_address, edge_type, IFNULL(mint, ''));
`;

/** Stub Turso client: runs each pipeline statement against an in-memory sqlite and
 * answers in the /v2/pipeline result shape remoteMaxMarker parses. */
function makeStub(remoteDb) {
  return {
    remoteDb,
    async pipeline(stmts) {
      return stmts.map(({ sql, args = [] }) => {
        const stmt = remoteDb.prepare(sql);
        if (!stmt.reader) {
          stmt.run(...args);
          return { type: "ok", response: { result: { rows: [] } } };
        }
        const rows = stmt.raw(true).all(...args)
          .map((r) => r.map((v) => (v == null ? null : { value: String(v) })));
        return { type: "ok", response: { result: { rows } } };
      });
    },
  };
}

function makeLocal(ddl) {
  const db = new Database(":memory:");
  db.exec(ddl);
  ensureSyncState(db);
  return db;
}

const sigCols = SYNC_TABLES.find((t) => t.table === "signatures").columns;
const edgeCols = SYNC_TABLES.find((t) => t.table === "edges").columns;

const insertSig = (db, sig, at) =>
  db.prepare("INSERT INTO signatures (signature, scope_address, slot, block_time, err, summary_json, ingested_at) VALUES (?, 'SCOPE', 1, 1, NULL, NULL, ?)")
    .run(sig, at);

const remoteSigCount = (db) => db.prepare("SELECT COUNT(*) AS n FROM signatures").get().n;

test("first sync with no markers pushes every row and saves the local watermark", async () => {
  const local = makeLocal(SIGNATURES_DDL);
  const stub = makeStub(new Database(":memory:"));
  stub.remoteDb.exec(SIGNATURES_DDL);
  insertSig(local, "sigA", "2026-01-01T00:00:00.000Z");
  insertSig(local, "sigB", "2026-01-01T00:00:05.000Z");

  const n = await syncTable(local, stub, "signatures", sigCols, { log: () => {} });
  assert.equal(n, 2);
  assert.equal(remoteSigCount(stub.remoteDb), 2);
  assert.equal(localMarker(local, "signatures"), "2026-01-01T00:00:05.000Z");
});

test(">= boundary re-push is idempotent: re-sync with no new rows changes nothing", async () => {
  const local = makeLocal(SIGNATURES_DDL);
  const stub = makeStub(new Database(":memory:"));
  stub.remoteDb.exec(SIGNATURES_DDL);
  insertSig(local, "sigA", "2026-01-01T00:00:00.000Z");
  insertSig(local, "sigB", "2026-01-01T00:00:05.000Z");

  await syncTable(local, stub, "signatures", sigCols, { log: () => {} });
  // Second run: the >= filter re-selects the boundary row; INSERT OR REPLACE
  // must land on the same primary key instead of duplicating it.
  const n = await syncTable(local, stub, "signatures", sigCols, { log: () => {} });
  assert.equal(n, 1);
  assert.equal(remoteSigCount(stub.remoteDb), 2);
  assert.equal(localMarker(local, "signatures"), "2026-01-01T00:00:05.000Z");
});

test("new rows after the watermark are picked up incrementally", async () => {
  const local = makeLocal(SIGNATURES_DDL);
  const stub = makeStub(new Database(":memory:"));
  stub.remoteDb.exec(SIGNATURES_DDL);
  insertSig(local, "sigA", "2026-01-01T00:00:00.000Z");
  await syncTable(local, stub, "signatures", sigCols, { log: () => {} });

  insertSig(local, "sigB", "2026-01-01T00:00:10.000Z");
  await syncTable(local, stub, "signatures", sigCols, { log: () => {} });
  assert.equal(remoteSigCount(stub.remoteDb), 2);
  assert.equal(localMarker(local, "signatures"), "2026-01-01T00:00:10.000Z");
});

test("local marker beats remote MAX: another writer's newer rows don't skip ours", async () => {
  const local = makeLocal(SIGNATURES_DDL);
  const stub = makeStub(new Database(":memory:"));
  stub.remoteDb.exec(SIGNATURES_DDL);

  // Another writer (clock ahead of ours) already pushed a far-future row to Turso.
  stub.remoteDb
    .prepare("INSERT INTO signatures (signature, scope_address, slot, block_time, err, summary_json, ingested_at) VALUES ('other', 'SCOPE', 1, 1, NULL, NULL, '2026-06-01T00:00:00.000Z')")
    .run();
  // This host has synced up to T0 and then ingested an older-than-remote-MAX row.
  const saveMarker = local.prepare("INSERT OR REPLACE INTO sync_state (table_name, last_marker, updated_at) VALUES (?, ?, ?)");
  saveMarker.run("signatures", "2026-01-01T00:00:00.000Z", "x");
  insertSig(local, "ours", "2026-01-02T00:00:00.000Z");

  await syncTable(local, stub, "signatures", sigCols, { log: () => {} });
  const got = stub.remoteDb.prepare("SELECT COUNT(*) AS n FROM signatures WHERE signature = 'ours'").get().n;
  assert.equal(got, 1, "row between local marker and remote MAX must be pushed");
  assert.equal(localMarker(local, "signatures"), "2026-01-02T00:00:00.000Z");
});

test("no local marker falls back to remote MAX and only pushes newer rows", async () => {
  const local = makeLocal(SIGNATURES_DDL);
  const stub = makeStub(new Database(":memory:"));
  stub.remoteDb.exec(SIGNATURES_DDL);
  stub.remoteDb
    .prepare("INSERT INTO signatures (signature, scope_address, slot, block_time, err, summary_json, ingested_at) VALUES ('old', 'SCOPE', 1, 1, NULL, NULL, '2026-01-01T00:00:05.000Z')")
    .run();
  assert.equal(await remoteMaxMarker(stub, "signatures", "ingested_at"), "2026-01-01T00:00:05.000Z");

  insertSig(local, "before", "2026-01-01T00:00:00.000Z"); // older than remote MAX → skipped
  insertSig(local, "after", "2026-01-01T00:00:10.000Z");
  await syncTable(local, stub, "signatures", sigCols, { log: () => {} });
  assert.equal(stub.remoteDb.prepare("SELECT COUNT(*) AS n FROM signatures WHERE signature = 'before'").get().n, 0);
  assert.equal(stub.remoteDb.prepare("SELECT COUNT(*) AS n FROM signatures WHERE signature = 'after'").get().n, 1);
});

test("edges sync with INSERT OR IGNORE: re-push dedupes on the natural key, never clobbers ids", async () => {
  const local = makeLocal(EDGES_DDL);
  const stub = makeStub(new Database(":memory:"));
  stub.remoteDb.exec(EDGES_DDL);
  local
    .prepare("INSERT INTO edges (scope_address, from_address, to_address, tx_sig, slot, edge_type, mint, ingested_at) VALUES ('S', 'A', 'B', 'tx1', 1, 'transfer', NULL, '2026-01-01T00:00:00.000Z')")
    .run();

  await syncTable(local, stub, "edges", edgeCols, { orMode: "IGNORE", log: () => {} });
  const before = stub.remoteDb.prepare("SELECT id FROM edges").get().id;
  // Boundary re-push must be a no-op: same natural key → ignored, id untouched.
  await syncTable(local, stub, "edges", edgeCols, { orMode: "IGNORE", log: () => {} });
  assert.equal(stub.remoteDb.prepare("SELECT COUNT(*) AS n FROM edges").get().n, 1);
  assert.equal(stub.remoteDb.prepare("SELECT id FROM edges").get().id, before);
});

test("manifest includes program_calls and marks only edges as OR IGNORE", () => {
  const names = SYNC_TABLES.map((t) => t.table);
  assert.deepEqual(names, ["signatures", "events", "signers", "transfers", "program_calls", "edges"]);
  const pc = SYNC_TABLES.find((t) => t.table === "program_calls");
  assert.deepEqual(pc.columns, ["tx_sig", "scope_address", "idx", "program_id", "instruction_name", "slot", "ingested_at"]);
  for (const t of SYNC_TABLES) {
    assert.equal(t.orMode, t.table === "edges" ? "IGNORE" : undefined, t.table);
  }
});

test("batching splits pushes without losing rows", async () => {
  const local = makeLocal(SIGNATURES_DDL);
  const stub = makeStub(new Database(":memory:"));
  stub.remoteDb.exec(SIGNATURES_DDL);
  for (let i = 0; i < 7; i++) insertSig(local, `sig${i}`, `2026-01-01T00:00:0${i}.000Z`);

  const n = await syncTable(local, stub, "signatures", sigCols, { batchSize: 3, log: () => {} });
  assert.equal(n, 7);
  assert.equal(remoteSigCount(stub.remoteDb), 7);
});
