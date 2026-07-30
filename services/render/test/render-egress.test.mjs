// Tests for THE EGRESS BOUNDARY — services/render/lib/egress-proxy.js, the thing that
// actually owns the socket.
//
// WHAT IS BEING PROVED. Request interception inside a browser is a hook inside the thing
// being defended against; this proxy is a separate process boundary, and the claim it
// makes is that NOTHING reaches the network without passing lib/safe-fetch.js's ladder
// first. The tests below speak the proxy protocol directly — absolute-form GET and
// CONNECT, exactly as Chromium would — so no browser is needed to prove it.
//
// THE TWO SHAPES OF ATTACK, both covered:
//
//   1. THE ADDRESS IS OBVIOUS IN THE URL. `http://127.0.0.1/`, `http://[::1]/`,
//      `metadata.google.internal`, `example.com:6379`. Refused by validateUrl before a
//      socket exists.
//   2. THE ADDRESS IS HIDDEN BEHIND A NAME. A perfectly ordinary hostname whose DNS
//      answer is 169.254.169.254. This is the one a URL check alone cannot catch, and it
//      is caught by guardedLookup being the resolver the socket uses — proved here with
//      an injected resolver, which is the only way to prove it without depending on
//      somebody else's hostile DNS record.
//
// Sockets are opened, but only to 127.0.0.1 and only to the proxy under test: every
// upstream connection in this file is refused before it is attempted.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createEgressProxy } from "../lib/egress-proxy.js";

/** Speak to the proxy the way a client does: an absolute URL on the request line. */
function throughProxy(port, target, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path: target, headers: { host: safeHost(target), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Ask the proxy for a tunnel, the way every https:// request does.
 *
 * `established` is derived from the STATUS, not from the event firing. node:http emits
 * `connect` for any answer to a CONNECT request, refusals included — so a helper that
 * treated the event as success would report every refused tunnel as a tunnel, which is
 * the precise shape of a test that passes while the boundary is open.
 */
function connectThroughProxy(port, authority) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method: "CONNECT", path: authority });
    req.on("connect", (res, socket, head) => {
      socket.destroy();
      resolve({ status: res.statusCode, established: res.statusCode === 200, body: head?.toString("utf8") ?? "" });
    });
    req.on("error", reject);
    req.end();
  });
}

function safeHost(target) {
  try {
    return new URL(target).host;
  } catch {
    return "example.com";
  }
}

/* ============== 1. addresses that are obvious in the URL ============== */

test("the proxy refuses every plain-http request aimed at this container's own network", async () => {
  const proxy = await createEgressProxy();
  try {
    const cases = [
      ["http://127.0.0.1/admin", /bare IP address/i],
      ["http://169.254.169.254/latest/meta-data/", /bare IP address/i],
      ["http://10.0.0.5/", /bare IP address/i],
      ["http://[::1]/", /bare IP address/i],
      ["http://localhost/", /localhost/i],
      ["http://metadata.google.internal/computeMetadata/v1/", /\.internal/i],
      ["http://vault/", /single-label/i],
      ["http://example.com:6379/", /port 6379/i],
    ];
    for (const [target, why] of cases) {
      const res = await throughProxy(proxy.port, target);
      assert.equal(res.status, 403, `${target} was not refused (${res.status})`);
      assert.match(res.body, why, `${target} was refused without naming why`);
      assert.equal(res.headers["x-chainmind-render"], "egress-refused");
    }
    assert.equal(proxy.stats().blocked, cases.length, "every refusal should be recorded");
  } finally {
    await proxy.close();
  }
});

test("the proxy refuses a TLS tunnel to an internal host or a non-web port", async () => {
  const proxy = await createEgressProxy();
  try {
    const cases = [
      ["127.0.0.1:443", /bare IP address/i],
      ["169.254.169.254:443", /bare IP address/i],
      ["metadata.google.internal:443", /\.internal/i],
      ["localhost:443", /localhost/i],
      // The port rule doing real work at a layer where the path is invisible: a CONNECT
      // to host:22 or host:6379 is how a browser would be used to reach a database.
      ["example.com:22", /port 22/i],
      ["example.com:6379", /port 6379/i],
      ["example.com:8080", /port 8080/i],
    ];
    for (const [authority, why] of cases) {
      const res = await connectThroughProxy(proxy.port, authority);
      assert.equal(res.established, false, `${authority} was tunnelled`);
      assert.equal(res.status, 403, `${authority} answered ${res.status}`);
      assert.match(res.body, why, `${authority} was refused without naming why`);
    }
  } finally {
    await proxy.close();
  }
});

/* ============== 2. the address hidden behind a name ============== */

test("a public name that RESOLVES into a private range is refused before the connect", async () => {
  // The attack a URL check cannot see. The name is unremarkable; the DNS answer is the
  // cloud metadata endpoint. guardedLookup is the resolver the socket uses, so the
  // addresses that were validated are the addresses that would have been connected to —
  // there is no window between the two for a second, different answer.
  const resolve = (hostname, _opts, cb) => cb(null, [{ address: "169.254.169.254", family: 4 }]);
  const proxy = await createEgressProxy({ resolve });
  try {
    const res = await throughProxy(proxy.port, "http://totally-normal.example.com/");
    assert.equal(res.status, 403);
    assert.match(res.body, /169\.254\.169\.254/);
    assert.match(res.body, /metadata/i);
    assert.match(res.body, /Refused before connecting/i);
  } finally {
    await proxy.close();
  }
});

test("a name resolving to one public AND one private address fails as a whole", async () => {
  // Not filtered down to the "good" address: a name answering both is the shape of a
  // DNS-rebinding attempt, and connecting to half of it would be co-operating with it.
  const resolve = (hostname, _opts, cb) =>
    cb(null, [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
  const proxy = await createEgressProxy({ resolve });
  try {
    const res = await throughProxy(proxy.port, "http://split-horizon.example.com/");
    assert.equal(res.status, 403);
    assert.match(res.body, /127\.0\.0\.1/);
    assert.match(res.body, /rebinding/i);
  } finally {
    await proxy.close();
  }
});

test("the same resolution guard applies to TLS tunnels, not only to plain http", async () => {
  const resolve = (hostname, _opts, cb) => cb(null, [{ address: "10.1.2.3", family: 4 }]);
  const proxy = await createEgressProxy({ resolve });
  try {
    const res = await connectThroughProxy(proxy.port, "looks-fine.example.com:443");
    assert.equal(res.established, false);
    assert.equal(res.status, 403);
    assert.match(res.body, /10\.1\.2\.3/);
    assert.match(res.body, /private range/i);
  } finally {
    await proxy.close();
  }
});

/* ============== 3. the other things a page can try ============== */

test("a WebSocket upgrade is refused rather than forwarded", async () => {
  const proxy = await createEgressProxy();
  try {
    const res = await throughProxy(proxy.port, "http://example.com/socket", { headers: { upgrade: "websocket", connection: "Upgrade" } });
    assert.equal(res.status, 403);
    assert.match(res.body, /WebSocket upgrade was refused/i);
    assert.match(res.body, /rendering a page does not require one/i);
  } finally {
    await proxy.close();
  }
});

test("the connection cap refuses a flood without taking the proxy down", async () => {
  const proxy = await createEgressProxy({ limits: { MAX_CONNECTIONS: 0 } });
  try {
    const res = await throughProxy(proxy.port, "http://example.com/");
    assert.equal(res.status, 429);
    assert.match(res.body, /more than 0 connections/);
    // Still answering afterwards: a cap is a refusal, not a crash.
    const again = await throughProxy(proxy.port, "http://127.0.0.1/");
    assert.equal(again.status, 403);
  } finally {
    await proxy.close();
  }
});

/* ============== 4. the proxy's own posture ============== */

test("the proxy binds to loopback only — it must never be an open forward proxy", async () => {
  const proxy = await createEgressProxy();
  try {
    assert.equal(proxy.server.address().address, "127.0.0.1");
    assert.match(proxy.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    await proxy.close();
  }
});

test("every decision is recorded with a code and a sentence, so a render can report it", async () => {
  const seen = [];
  const proxy = await createEgressProxy({ onDecision: (d) => seen.push(d) });
  try {
    await throughProxy(proxy.port, "http://127.0.0.1/");
    await connectThroughProxy(proxy.port, "metadata.google.internal:443");
    assert.equal(seen.length, 2);
    for (const d of seen) {
      assert.equal(d.allowed, false);
      assert.ok(typeof d.code === "string" && d.code.length > 0);
      assert.ok(typeof d.reason === "string" && d.reason.length > 20);
      assert.ok(Number.isFinite(d.at));
    }
    assert.deepEqual(
      seen.map((d) => d.kind),
      ["http", "connect"],
    );
  } finally {
    await proxy.close();
  }
});

test("a listener that throws does not take the proxy down with it", async () => {
  const proxy = await createEgressProxy({
    onDecision: () => {
      throw new Error("a caller's bug");
    },
  });
  try {
    const res = await throughProxy(proxy.port, "http://127.0.0.1/");
    assert.equal(res.status, 403);
  } finally {
    await proxy.close();
  }
});

test("closing the proxy releases the port", async () => {
  const proxy = await createEgressProxy();
  const { port } = proxy;
  await proxy.close();
  await assert.rejects(() => throughProxy(port, "http://example.com/"), /ECONNREFUSED/);
});

test("a refusal is stamped with the sentinel header the renderer keys off", async () => {
  // THE COUPLING THIS PROTECTS, found by measuring. For an https:// target the proxy
  // refuses the CONNECT and the navigation throws, so the refusal is unmistakable. For an
  // http:// target the proxy answers a real 403 and Chromium RENDERS it — navigation
  // succeeds, the status is 403, and lib/render.js would report `http_error` with fault
  // "site": this service's own policy refusal presented as a fact about the site. It tells
  // the two apart by this header, so the string must stay identical on both sides.
  const proxy = await createEgressProxy();
  try {
    const res = await throughProxy(proxy.port, "http://10.0.0.5/");
    assert.equal(res.status, 403);
    assert.equal(res.headers["x-chainmind-render"], "egress-refused");
  } finally {
    await proxy.close();
  }
});
