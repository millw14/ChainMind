import { createServer } from "node:http";
import { readConfig } from "./lib/config.js";
import { checkAuth, AUTH_HEADER } from "./lib/auth.js";
import { envelope, OUTCOMES } from "./lib/outcome.js";
import { screenRequest } from "./lib/screen.js";
import { closeBrowser, getBrowser, renderUrl } from "./lib/render.js";

/**
 * THE SERVICE — one endpoint that renders a URL, one health check, and nothing else.
 *
 * THE SURFACE IS SMALL ON PURPOSE. This process runs a browser that executes the
 * investigated party's JavaScript, so every route it exposes is a route that a
 * compromised renderer could try to reach from inside. Two routes, one of which does
 * nothing and one of which needs the shared secret, is as small as this gets.
 *
 * WHAT IT HOLDS: one secret, RENDER_SHARED_SECRET, which authenticates ChainMind to this
 * service and grants nothing anywhere else. No chain keys, no LLM key, no Redis or
 * Postgres credentials, no session secret. CACHING IS DELIBERATELY NOT HERE — the
 * ChainMind side already has lib/store.js and can cache a render under the URL it asked
 * for, and moving that here would mean putting Redis credentials inside the process with
 * the hostile browser in it. A cache is not worth a credential.
 *
 * Server-side only: no React.
 */

const boot = readConfig();
if (!boot.ok) {
  for (const p of boot.problems) console.error(`[render] CONFIGURATION: ${p}`);
  console.error("[render] Refusing to start. See services/render/README.md.");
  process.exit(1);
}
const config = boot.config;

if (config.disableSandbox) {
  console.warn(
    "[render] RENDER_DISABLE_SANDBOX is set: Chromium's sandbox is OFF. This browser executes JavaScript written by the party under investigation, and the sandbox is the wall between that JavaScript and this process. The egress proxy still bounds what any escape could reach on the network, but this is a real downgrade — unset it if the host allows the sandbox.",
  );
}

/** The maximum body this endpoint will read. A URL is short; anything longer is not one. */
const MAX_BODY_BYTES = 4_096;

/**
 * THE CONCURRENCY CAP, and it is a hard refusal rather than a queue.
 *
 * Each render is a browser context, a proxy, and up to a few hundred megabytes of
 * Chromium under a page that may be actively trying to allocate. A queue would let a
 * caller stack requests until the container is killed by the platform, which loses the
 * work already in flight — the same failure lib/request-budget.js exists to prevent
 * upstream. Refusing at the door with a `Retry-After` and an outcome that says loudly
 * that NOTHING HERE IS A FACT ABOUT THE SITE is the honest alternative.
 */
let inFlight = 0;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://render.local");

  if (url.pathname === "/healthz") return health(req, res);
  if (url.pathname !== "/render") return send(res, 404, { ok: false, status: "not_found", reading: "This service has two routes: POST /render and GET /healthz." });

  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return send(res, 405, envelope("bad_request", { refusal: "POST a JSON body of { \"url\": \"https://…\" } to this route." }));
  }

  const auth = checkAuth(req.headers[AUTH_HEADER], config.secret);
  if (!auth.ok) {
    // The LOG says which check failed; the RESPONSE does not. Telling an unauthenticated
    // caller how close they got is telling them how to get closer.
    console.warn(`[render] 401: ${auth.reason}`);
    res.setHeader("www-authenticate", "Bearer");
    return send(res, 401, envelope("unauthorized", { refusal: "This service requires the shared secret as an Authorization: Bearer header." }));
  }

  let body = null;
  try {
    body = await readBody(req);
  } catch (e) {
    return send(res, 400, envelope("bad_request", { refusal: String(e?.message ?? e).slice(0, 200) }));
  }

  const target = typeof body?.url === "string" ? body.url.trim() : "";
  if (!target) {
    return send(res, 400, envelope("bad_request", { refusal: "The body must be JSON with a `url` string." }));
  }

  // Screened here as well as inside renderUrl, so a refused URL never reaches the
  // concurrency slot: a caller cannot occupy this service's capacity with addresses it
  // was never going to fetch.
  const gate = screenRequest(target, { topLevel: true });
  if (!gate.allow) {
    return send(res, OUTCOMES.refused_url.http, envelope("refused_url", { requestedUrl: target.slice(0, 300), refusalCode: gate.code, refusal: gate.reason }));
  }

  if (inFlight >= config.maxConcurrency) {
    res.setHeader("retry-after", "5");
    return send(res, OUTCOMES.at_capacity.http, envelope("at_capacity", { requestedUrl: target.slice(0, 300), refusal: `This service was already rendering ${inFlight} page(s), which is its cap. The site was NOT contacted.` }));
  }

  inFlight += 1;
  try {
    // The caller may ask for LESS time than this service's own ceiling, never more:
    // ChainMind's request budget (lib/request-budget.js, 24s for the whole question) is
    // tighter than a render's, and a leg that overruns its caller's budget produces a
    // gateway timeout instead of a degraded honest answer.
    const budgetMs = Number.isFinite(body?.budgetMs) ? Math.max(2_000, Math.min(config.totalTimeoutMs, Math.trunc(body.budgetMs))) : config.totalTimeoutMs;
    const result = await renderUrl(target, { ...config, totalTimeoutMs: budgetMs, navTimeoutMs: Math.min(config.navTimeoutMs, budgetMs) });
    const status = OUTCOMES[result.status]?.http ?? 200;
    send(res, status, result);
    console.log(`[render] ${result.status} ${target.slice(0, 120)} ${result.timing?.totalMs ?? "?"}ms text=${result.content?.textChars ?? 0} blocked=${result.egress?.blocked ?? 0}`);
  } catch (e) {
    // renderUrl is written never to throw. If it does anyway, the one thing that must
    // NOT happen is a bare 500 that a caller could read as a fact about the site.
    console.error("[render] unexpected:", e);
    send(res, 503, envelope("unavailable", { requestedUrl: target.slice(0, 300), refusal: `This service failed while rendering: ${String(e?.message ?? e).slice(0, 200)}. NOTHING here is a fact about the site.` }));
  } finally {
    inFlight -= 1;
  }
});

/**
 * The health check, and it deliberately does NOT start a browser.
 *
 * Railway polls this every few seconds. A health check that launched Chromium would
 * either keep a browser alive forever for no traffic or launch one per poll; either way
 * the check would be measuring itself rather than the service. It reports whether a
 * browser is already up, which is a different and more useful fact.
 *
 * UNAUTHENTICATED, so it must leak nothing: no secret, no configuration that would help
 * an attacker, no target URLs. Capacity and uptime are not secrets.
 */
function health(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("allow", "GET");
    return send(res, 405, { ok: false });
  }
  send(res, 200, {
    ok: true,
    service: "chainmind-render",
    inFlight,
    capacity: config.maxConcurrency,
    uptimeMs: Math.round(process.uptime() * 1_000),
    node: process.version,
    sandbox: config.disableSandbox ? "disabled" : "enabled",
  });
}

/** Read at most MAX_BODY_BYTES of JSON, and refuse anything longer without reading it. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return reject(new Error(`The request body declared ${declared} bytes, past the ${MAX_BODY_BYTES}-byte cap. The body of this endpoint is one URL.`));
    }
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        return reject(new Error(`The request body ran past the ${MAX_BODY_BYTES}-byte cap.`));
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return reject(new Error("The request body was empty; it must be JSON with a `url` string."));
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("The request body is not JSON."));
      }
    });
    req.on("error", (e) => reject(e));
  });
}

/** One JSON response shape, one place that sets the headers that keep it out of caches. */
function send(res, status, payload) {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    // A render is about a third party's page and has no business in any intermediary.
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    // Nothing this service returns is ever meant to be rendered as a page by a browser.
    "content-security-policy": "default-src 'none'; sandbox",
    "referrer-policy": "no-referrer",
  });
  res.end(body);
}

server.headersTimeout = 10_000;
server.requestTimeout = 120_000;
server.listen(config.port, () => {
  console.log(`[render] listening on :${config.port} — capacity ${config.maxConcurrency}, viewport ${config.viewport.width}x${config.viewport.height}, nav ${config.navTimeoutMs}ms, total ${config.totalTimeoutMs}ms`);
  // Warmed at boot rather than on the first request, so the first caller does not pay the
  // launch. A failure here is logged and NOT fatal: the service still answers, and every
  // answer says "this service could not start a browser" rather than anything about a site.
  getBrowser(config)
    .then(() => console.log("[render] browser ready"))
    .catch((e) => console.error(`[render] browser did NOT start: ${String(e?.message ?? e)}`));
});

// Railway sends SIGTERM on redeploy. Finishing in flight renders beats killing them.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(`[render] ${signal}: draining`);
    server.close(() => {
      closeBrowser().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
