import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";
import { guardedLookup } from "../../../lib/safe-fetch.js";
import { screenRequest } from "./screen.js";

/**
 * THE ONLY WAY A BYTE LEAVES THIS PROCESS — a loopback HTTP proxy that Chromium is
 * forced through, screening every connection with lib/safe-fetch.js's primitives before
 * a socket is opened.
 *
 * WHY A PROXY AND NOT JUST REQUEST INTERCEPTION. Playwright's `context.route` is good
 * and this service uses it too, but it is not a boundary — it is a hook inside the
 * thing being defended against. Three specific gaps make it insufficient on its own:
 *
 *   1. CHROMIUM RESOLVES DNS ITSELF. A route handler sees a hostname, approves it, and
 *      then the NETWORK STACK resolves that name independently. That is precisely the
 *      check-then-connect window lib/safe-fetch.js was built on node:http to close, and
 *      routing reopens it: an authoritative server answering 1.2.3.4 to our check and
 *      169.254.169.254 to Chromium's connect wins. Behind a proxy, Chromium performs NO
 *      resolution at all — it hands the hostname to the proxy — so guardedLookup is once
 *      again the only resolver, and the addresses that were validated are the addresses
 *      the socket connects to, by construction.
 *   2. NOT EVERYTHING IS ROUTABLE. Service workers, some preload and prefetch paths,
 *      CSP and OCSP side-channels, and whatever the next Chromium version adds are not
 *      all guaranteed to surface as route events. A socket, by contrast, is a socket.
 *   3. A RENDERER ESCAPE IS ASSUMED. The whole premise of this service is that the page
 *      executes hostile JavaScript. If that JavaScript escapes the renderer sandbox, a
 *      hook living inside the browser is gone; a separate process holding the only route
 *      to the network is not.
 *
 * SO THE DIVISION OF LABOUR IS: routing produces EVIDENCE (which resource type, which
 * frame, a reasoned per-URL refusal), and this proxy produces the GUARANTEE. When they
 * disagree, this one wins, because it owns the socket.
 *
 * WHAT IT IS NOT. It is not a MITM. CONNECT is tunnelled byte-for-byte and this process
 * never holds a private key or a forged certificate, so TLS remains end-to-end between
 * Chromium and the site — which is also what keeps Chromium's own certificate
 * validation, and its AIA chasing, intact. See README.md "The TLS problem".
 *
 * ONE PROXY PER RENDER, torn down with the request. It is the accounting boundary as
 * well as the security one: total bytes, connection count and every refusal belong to
 * one investigated site and are never mixed with another's.
 *
 * Server-side only: no React.
 */

/** Headers that describe THIS hop and must never be forwarded to the next one. */
const HOP_BY_HOP = Object.freeze([
  "connection",
  "proxy-connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export const PROXY_LIMITS = Object.freeze({
  /**
   * The ceiling on everything one page is allowed to pull down, across every request it
   * makes. A per-response cap does not bound a page that issues ten thousand requests,
   * and "allocate until the container dies" is a cheaper attack than any single huge
   * response. 48MB is roughly ten times a heavy real site with video posters and web
   * fonts, and small enough that hitting it is a finding rather than an accident.
   */
  MAX_TOTAL_BYTES: 48_000_000,
  /** How many sockets one page may have open at once, against a connection flood. */
  MAX_CONNECTIONS: 120,
  /** Per-connection: how long to wait for the far end to answer at all. */
  CONNECT_TIMEOUT_MS: 8_000,
  /** Per-connection: how long a connection may sit idle before it is torn down. */
  IDLE_TIMEOUT_MS: 20_000,
});

/**
 * Start a screening proxy on loopback.
 *
 * BOUND TO 127.0.0.1 ON PURPOSE and not configurable. An open forward proxy on a public
 * interface is one of the more useful things a stranger can find, and this one would
 * additionally be inside whatever network Railway puts the container in. The only client
 * is a Chromium in the same container.
 *
 * @param {{ onDecision?: (d: object) => void, limits?: object }} [options]
 * @returns {Promise<{ port: number, server: object, url: string, decisions: object[], stats: () => object, close: () => Promise<void> }>}
 */
export function createEgressProxy(options = {}) {
  const limits = { ...PROXY_LIMITS, ...(options.limits && typeof options.limits === "object" ? options.limits : {}) };
  const onDecision = typeof options.onDecision === "function" ? options.onDecision : () => {};
  /**
   * The resolver seam, and it exists for the same reason lib/safe-fetch.js has a
   * transport seam: the controls make this untestable any other way.
   *
   * A test cannot prove "a public name that resolves into a private range is refused"
   * against real DNS without depending on somebody else's DNS record staying hostile. An
   * injected resolver leaves guardedLookup, classifyIp and every branch of this proxy in
   * the path being tested and fakes only the answer to the query.
   */
  const resolve = typeof options.resolve === "function" ? options.resolve : undefined;

  const decisions = [];
  const sockets = new Set();
  let bytesOut = 0;
  let bytesIn = 0;
  let connections = 0;
  let overBudget = null;

  /** Record a screening outcome once, and tell the caller. */
  const decide = (entry) => {
    const record = { at: Date.now(), ...entry };
    if (decisions.length < 2_000) decisions.push(record);
    try {
      onDecision(record);
    } catch {
      // A listener that throws must not take the proxy down with it.
    }
    return record;
  };

  /** Count bytes across the whole render and trip once, loudly, when the cap is hit. */
  const account = (n, direction) => {
    if (direction === "in") bytesIn += n;
    else bytesOut += n;
    if (!overBudget && bytesIn + bytesOut > limits.MAX_TOTAL_BYTES) {
      overBudget = `This page pulled more than ${limits.MAX_TOTAL_BYTES} bytes across all of its requests, which is the whole-render cap, so its remaining connections were torn down. What had already loaded was kept; what had not is UNREAD, not absent.`;
      decide({ kind: "budget", url: null, allowed: false, code: "byte_budget", reason: overBudget });
      for (const s of sockets) s.destroy();
    }
  };

  /**
   * The connection counter is incremented AT ADMISSION, not when a socket appears.
   *
   * Sockets are assigned asynchronously, so counting them on the `socket` event would let a
   * page fire two hundred requests in one tick and have every one of them pass a cap of
   * 120 — the counter would still be at zero when the last was admitted. Counting the
   * decision rather than its consequence is what makes the cap a cap.
   */
  const admit = () => {
    connections += 1;
  };

  /** Register a socket for the idle timeout and for teardown when the byte budget trips. */
  const track = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(limits.IDLE_TIMEOUT_MS, () => socket.destroy());
  };

  const server = createServer();

  /**
   * ORDINARY http:// REQUESTS, which arrive in absolute form (`GET http://host/path`)
   * because that is what a client says to a proxy.
   *
   * REDIRECTS ARE NOT FOLLOWED HERE. A 3xx is handed straight back to Chromium, which
   * issues a brand-new request for the target — and that request arrives here and is
   * screened from scratch, exactly as lib/safe-fetch.js re-validates each hop. Following
   * redirects inside the proxy would put a chain of unscreened targets behind one
   * approved one.
   */
  server.on("request", (req, res) => {
    const target = String(req.url ?? "");

    // A WebSocket upgrade over a plain-http proxy hop. Refused rather than forwarded:
    // an upgraded socket is a live bidirectional channel that this service has no way to
    // read, bound or attribute, and no page needs one to be rendered and photographed.
    if (String(req.headers.upgrade ?? "").toLowerCase() === "websocket") {
      const d = decide({
        kind: "upgrade",
        url: target.slice(0, 300),
        allowed: false,
        code: "websocket",
        reason: "A WebSocket upgrade was refused. The page's HTTP requests are screened, tunnelled and counted; a WebSocket is a live channel this service cannot do any of that to, and rendering a page does not require one.",
      });
      return refuse(res, 403, d.reason);
    }

    const verdict = screenRequest(target, { topLevel: false });
    if (!verdict.allow) {
      decide({ kind: "http", url: target.slice(0, 300), host: verdict.host, allowed: false, code: verdict.code, reason: verdict.reason });
      return refuse(res, 403, verdict.reason);
    }
    if (overBudget) return refuse(res, 509, overBudget);
    if (connections >= limits.MAX_CONNECTIONS) {
      const d = decide({ kind: "http", url: target.slice(0, 300), allowed: false, code: "connection_cap", reason: `This page tried to open more than ${limits.MAX_CONNECTIONS} connections at once, which is the cap, so the rest were refused.` });
      return refuse(res, 429, d.reason);
    }

    /**
     * THE URL OBJECT COMES FROM THE SCREEN, not from a second parse of the same string.
     *
     * Parsing twice is how a screen and a connection come to disagree: two parsers, or the
     * same parser on two slightly different strings, can resolve a host differently, and
     * the one that decides where the socket goes is the one that was not checked. So the
     * screen returns the URL it approved and this is the only URL used below.
     */
    const url = verdict.url;
    if (!url) {
      const reason = "The screen approved a request without producing a URL to connect to, which should be impossible; refusing rather than guessing.";
      decide({ kind: "http", url: target.slice(0, 300), allowed: false, code: "no_url", reason });
      return refuse(res, 500, reason);
    }

    admit();

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.includes(k.toLowerCase())) continue;
      headers[k] = v;
    }
    headers.host = url.host;

    const record = { hostname: null, addresses: null };
    const upstream = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: req.method,
        headers,
        // THE SAME RESOLVER THE HTTP FETCHER USES. Everything the name resolves to must
        // be publicly routable, and any blocked address fails the whole name — a host
        // answering one public and one private address is the shape of a rebinding
        // attempt, not a website with an odd DNS record.
        lookup: guardedLookup({ record, resolve }),
        timeout: limits.CONNECT_TIMEOUT_MS,
      },
      (up) => {
        decide({
          kind: "http",
          url: `${url.origin}${url.pathname}`.slice(0, 300),
          host: url.hostname,
          allowed: true,
          code: "allowed",
          status: up.statusCode ?? null,
          addresses: (record.addresses ?? []).map((a) => a.address).slice(0, 4),
        });
        res.writeHead(up.statusCode ?? 502, stripHopByHop(up.headers));
        up.on("data", (c) => account(c.length, "in"));
        up.pipe(res);
      },
    );

    upstream.on("error", (e) => {
      const code = String(e?.code ?? "");
      const reason =
        code === "EBLOCKEDADDRESS"
          ? String(e.message)
          : code === "ENOTFOUND"
            ? `${url.hostname} does not resolve.`
            : `${url.hostname} could not be reached (${code || String(e?.message ?? e).slice(0, 80)}).`;
      decide({ kind: "http", url: `${url.origin}${url.pathname}`.slice(0, 300), host: url.hostname, allowed: code === "EBLOCKEDADDRESS" ? false : true, code: code === "EBLOCKEDADDRESS" ? "blocked_address" : "upstream_error", reason });
      refuse(res, code === "EBLOCKEDADDRESS" ? 403 : 502, reason);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
    // TRACKED ON THE `socket` EVENT, not from `upstream.socket`. That property is still
    // undefined when http.request() returns — the socket is assigned asynchronously — so
    // reading it here yielded nothing to track, which meant the idle timeout never applied
    // to plain-http upstreams and the byte-budget teardown had no socket to destroy.
    upstream.on("socket", (socket) => track(socket));

    req.on("data", (c) => account(c.length, "out"));
    req.pipe(upstream);
  });

  /**
   * CONNECT — every https:// request and every wss:// WebSocket, because a client asks a
   * proxy to open a tunnel rather than sending it the URL.
   *
   * THE PATH IS INVISIBLE HERE, and that is fine: SSRF is a question about WHICH HOST
   * AND ADDRESS a socket reaches, and both are on the table. validateUrl's port rule
   * (443 and 80 only) does real work at this layer — it is what stops a tunnel to
   * host:6379 or host:22.
   *
   * The bytes are piped without inspection, so TLS stays end-to-end and this process
   * never becomes a man-in-the-middle of the site it is reporting on.
   */
  server.on("connect", (req, clientSocket, head) => {
    const authority = String(req.url ?? "");
    // `host:port` -> a URL validateUrl can read. https:// because a CONNECT tunnel on
    // 443 is a TLS connection; the scheme is only there to satisfy the parser.
    const asUrl = `https://${authority}`;
    const verdict = screenRequest(asUrl, { topLevel: false });
    if (!verdict.allow) {
      decide({ kind: "connect", url: authority.slice(0, 200), host: verdict.host, allowed: false, code: verdict.code, reason: verdict.reason });
      return refuseSocket(clientSocket, 403, verdict.reason);
    }
    if (overBudget) return refuseSocket(clientSocket, 509, overBudget);
    if (connections >= limits.MAX_CONNECTIONS) {
      const reason = `This page tried to open more than ${limits.MAX_CONNECTIONS} connections at once, which is the cap, so the rest were refused.`;
      decide({ kind: "connect", url: authority.slice(0, 200), allowed: false, code: "connection_cap", reason });
      return refuseSocket(clientSocket, 429, reason);
    }

    // Same rule as above: the host and port connected to are the ones the screen approved.
    const checked = verdict.url;
    if (!checked) {
      const reason = "The screen approved a tunnel without producing a host to connect to, which should be impossible; refusing rather than guessing.";
      decide({ kind: "connect", url: authority.slice(0, 200), allowed: false, code: "no_url", reason });
      return refuseSocket(clientSocket, 500, reason);
    }

    admit();

    const record = { hostname: null, addresses: null };
    const upstream = netConnect({
      host: checked.hostname,
      port: Number(checked.port || 443),
      lookup: guardedLookup({ record, resolve }),
    });
    track(upstream);
    track(clientSocket);

    const connectTimer = setTimeout(() => upstream.destroy(new Error("connect timeout")), limits.CONNECT_TIMEOUT_MS);

    upstream.once("connect", () => {
      clearTimeout(connectTimer);
      decide({
        kind: "connect",
        url: authority.slice(0, 200),
        host: checked.hostname,
        allowed: true,
        code: "allowed",
        addresses: (record.addresses ?? []).map((a) => a.address).slice(0, 4),
      });
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) {
        account(head.length, "out");
        upstream.write(head);
      }
      clientSocket.on("data", (c) => account(c.length, "out"));
      upstream.on("data", (c) => account(c.length, "in"));
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });

    upstream.on("error", (e) => {
      clearTimeout(connectTimer);
      const code = String(e?.code ?? "");
      const reason =
        code === "EBLOCKEDADDRESS"
          ? String(e.message)
          : code === "ENOTFOUND"
            ? `${checked.hostname} does not resolve.`
            : `${checked.hostname} could not be reached (${code || String(e?.message ?? e).slice(0, 80)}).`;
      decide({ kind: "connect", url: authority.slice(0, 200), host: checked.hostname, allowed: code === "EBLOCKEDADDRESS" ? false : true, code: code === "EBLOCKEDADDRESS" ? "blocked_address" : "upstream_error", reason });
      refuseSocket(clientSocket, code === "EBLOCKEDADDRESS" ? 403 : 502, reason);
    });
    clientSocket.on("error", () => upstream.destroy());
  });

  // A malformed request line must not take the process down with it.
  server.on("clientError", (_e, socket) => {
    if (socket && !socket.destroyed) socket.destroy();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        port,
        server,
        url: `http://127.0.0.1:${port}`,
        decisions,
        stats: () => ({
          bytesIn,
          bytesOut,
          connections,
          blocked: decisions.filter((d) => d.allowed === false).length,
          overBudget,
        }),
        close: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Hand the browser a refusal it can render, with the reason in the body for the log. */
function refuse(res, status, reason) {
  if (res.headersSent || res.destroyed) return;
  const body = `${reason}\n`;
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    // Named so that a reason showing up in a page's error console is traceable to this
    // proxy rather than looking like the site misbehaving.
    "x-chainmind-render": "egress-refused",
  });
  res.end(body);
}

/** The same, for a CONNECT that never became a tunnel. */
function refuseSocket(socket, status, reason) {
  if (!socket || socket.destroyed) return;
  try {
    socket.write(`HTTP/1.1 ${status} Forbidden\r\nx-chainmind-render: egress-refused\r\nconnection: close\r\n\r\n${reason}\n`);
  } catch {
    // The client may already be gone; the refusal stands either way.
  }
  socket.destroy();
}

/** Response headers minus the ones that describe the upstream hop. */
function stripHopByHop(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (HOP_BY_HOP.includes(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}
