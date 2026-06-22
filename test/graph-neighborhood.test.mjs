// Golden tests for the neighborhood row-shaping (lib/graph-neighborhood.js). Pure logic —
// no DB. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeNeighborhood } from "../lib/graph-neighborhood.js";

const bounds = { edgeCap: 2000 };

test("aggregates edge types + direction per neighbor", () => {
  const rows = [
    { neighbor: "B", edge_type: "token_transfer", outbound: 1, n: 3, first_slot: 10, last_slot: 40 },
    { neighbor: "B", edge_type: "native_transfer", outbound: 0, n: 2, first_slot: 5, last_slot: 30 },
    { neighbor: "C", edge_type: "token_transfer", outbound: 1, n: 1, first_slot: 7, last_slot: 7 },
  ];
  const out = shapeNeighborhood("A", rows, bounds);
  assert.equal(out.center, "A");
  assert.equal(out.neighborCount, 2);
  assert.equal(out.edgesConsidered, 6);

  const b = out.neighbors.find((x) => x.address === "B");
  assert.equal(b.edges, 5);
  assert.equal(b.outbound, 3);
  assert.equal(b.inbound, 2);
  assert.deepEqual(b.edgeTypes, { token_transfer: 3, native_transfer: 2 });
  assert.equal(b.firstSlot, 5);
  assert.equal(b.lastSlot, 40);
});

test("sorts neighbors by total edges desc", () => {
  const rows = [
    { neighbor: "low", edge_type: "x", outbound: 1, n: 1, first_slot: 1, last_slot: 1 },
    { neighbor: "high", edge_type: "x", outbound: 1, n: 9, first_slot: 1, last_slot: 1 },
  ];
  const out = shapeNeighborhood("A", rows, bounds);
  assert.equal(out.neighbors[0].address, "high");
});

test("capped flag set when scan hits edgeCap", () => {
  const rows = [{ neighbor: "B", edge_type: "x", outbound: 1, n: 2000, first_slot: 1, last_slot: 1 }];
  assert.equal(shapeNeighborhood("A", rows, { edgeCap: 2000 }).capped, true);
  assert.equal(shapeNeighborhood("A", rows, { edgeCap: 5000 }).capped, false);
});

test("raw edge rows (slot, no n) count as one each", () => {
  const rows = [
    { neighbor: "B", edge_type: "token_transfer", outbound: 1, slot: 20 },
    { neighbor: "B", edge_type: "token_transfer", outbound: 1, slot: 10 },
    { neighbor: "C", edge_type: "native_transfer", outbound: 0, slot: 5 },
  ];
  const out = shapeNeighborhood("A", rows, bounds);
  assert.equal(out.edgesConsidered, 3);
  const b = out.neighbors.find((x) => x.address === "B");
  assert.equal(b.edges, 2);
  assert.equal(b.firstSlot, 10);
  assert.equal(b.lastSlot, 20);
});

test("neighborLimit keeps top-N distinct neighbors + sets truncated", () => {
  const rows = [
    { neighbor: "B", edge_type: "x", outbound: 1, n: 5 },
    { neighbor: "C", edge_type: "x", outbound: 1, n: 3 },
    { neighbor: "D", edge_type: "x", outbound: 1, n: 1 },
  ];
  const out = shapeNeighborhood("A", rows, { edgeCap: 2000, neighborLimit: 2 });
  assert.equal(out.neighborCount, 2);
  assert.equal(out.totalNeighbors, 3);
  assert.equal(out.neighborsTruncated, true);
  assert.deepEqual(out.neighbors.map((n) => n.address), ["B", "C"]);
});

test("empty + malformed rows are safe", () => {
  assert.equal(shapeNeighborhood("A", [], bounds).neighborCount, 0);
  assert.equal(shapeNeighborhood("A", null, bounds).neighborCount, 0);
  // row with no neighbor id is skipped
  assert.equal(shapeNeighborhood("A", [{ edge_type: "x", n: 1 }], bounds).neighborCount, 0);
});
