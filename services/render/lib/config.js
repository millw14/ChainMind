import { userAgent } from "../../../lib/safe-fetch.js";

/**
 * EVERY KNOB THIS SERVICE HAS, IN ONE PLACE, AND THE ONE SECRET IT IS ALLOWED TO HOLD.
 *
 * THE THREAT MODEL THIS FILE ENCODES. This process runs a browser that EXECUTES
 * JavaScript written by the party under investigation. Assume that browser is fully
 * compromised — a renderer escape, a Chromium 0-day, whatever. What does the attacker
 * get? The answer has to be "the ability to render pages, and nothing else", and the
 * only way to guarantee that is for the process to hold nothing else. So:
 *
 *   - ONE credential, RENDER_SHARED_SECRET, which authenticates ChainMind TO this
 *     service. It grants nothing anywhere else. Stealing it buys the attacker the
 *     ability to ask this service to render a page, which they could already do.
 *   - NO chain keys, NO Groq/LLM key, NO Redis or Postgres credentials, NO session
 *     secret, NO Vercel token. If a future change needs one of those here, the change
 *     is wrong: caching belongs on the ChainMind side, which already has the store.
 *   - The process refuses to start without the secret rather than defaulting to open.
 *     A render service reachable by anyone is an open proxy, and an open proxy with a
 *     browser in it is an open proxy that runs the caller's JavaScript.
 *
 * WHAT IS DELIBERATELY NOT A KNOB. There is no RENDER_ALLOW_INSECURE_TLS, no
 * `ignoreHTTPSErrors`, and no way to reach `rejectUnauthorized: false` from the
 * environment. A certificate failure is a REPORTED OUTCOME (see lib/outcome.js), never
 * something to switch off: trading a broken read for a silent man-in-the-middle would
 * make every observation this service produces unattributable to the site it names.
 * See README.md "The TLS problem" for what to do instead.
 *
 * Server-side only: no React.
 */

/**
 * Read an integer from the environment, or the default when it is absent or junk.
 *
 * `env` IS A PARAMETER RATHER THAN `process.env` because the tests are the only thing
 * that can prove the clamps hold, and a reader that closed over the real environment
 * would silently ignore whatever a test passed in — which is exactly the bug this
 * signature was changed to fix, caught by test/render-auth.test.mjs.
 */
function intFrom(env, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/** Read a boolean. Only an explicit "1"/"true"/"yes" turns something on. */
function boolFrom(env, name) {
  const raw = String(env[name] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * The shortest shared secret this service will start with.
 *
 * 32 characters, and the check is on LENGTH rather than entropy because length is the
 * only property that can be checked honestly. A deployer who sets "changeme" gets a
 * refusal to boot with a sentence telling them how to generate one, which is a far
 * better outcome than a service that starts and is guessable.
 */
export const MIN_SECRET_CHARS = 32;

/**
 * THE BOUNDS, TOGETHER, BECAUSE THEY ARE ONE BUDGET.
 *
 * NAV_TIMEOUT_MS vs TOTAL_TIMEOUT_MS are two different failures and must stay two
 * different numbers. A page that never answers its first byte is a navigation timeout;
 * a page that answers, paints, and then keeps a spinner going forever is a total
 * timeout — and the second one still has a screenshot and a DOM worth returning. A
 * single timeout would collapse them and throw away the evidence in the second case.
 *
 * SETTLE_MS is the reason this service exists at all. `load` fires when the document's
 * subresources are done, which on a client-rendered SPA is BEFORE React has mounted
 * anything. Measured against eska.fun: the server sends 5.8KB of shell HTML containing
 * four characters of text, and the content appears only after the bundle executes. So
 * after the load state, the renderer waits for the DOM to stop changing (see
 * lib/render.js waitForPaint) with SETTLE_MS as the ceiling on that wait.
 *
 * MAX_HTML_BYTES is 2MB against safe-fetch's 512KB, and the difference is not
 * generosity: a painted SPA DOM is several times its shipped HTML, so the raw-fetch cap
 * would truncate exactly the pages this service is for.
 */
export const RENDER_LIMITS = Object.freeze({
  NAV_TIMEOUT_MS: 15_000,
  TOTAL_TIMEOUT_MS: 25_000,
  /**
   * MEASURED, not guessed. eska.fun's DOM stops changing 1,206ms after the load state;
   * www.ponsfamily.com — 138 requests, 45 of them XHR — takes 3,751ms. The first value
   * tried here was 2,000 and it was wrong in the expensive direction: ponsfamily came back
   * as `render_timeout` with a mid-flight capture on every request, which is honest but is
   * a worse answer than waiting another 1.7 seconds for a complete one.
   */
  SETTLE_MS: 5_000,
  MAX_HTML_BYTES: 2_000_000,
  MAX_TEXT_CHARS: 200_000,
  MAX_SCREENSHOT_BYTES: 2_000_000,
  MAX_REQUEST_RECORDS: 400,
  MAX_CONSOLE_RECORDS: 40,
  MAX_CONCURRENCY: 2,
  JS_HEAP_MB: 256,
});

/**
 * Read the whole configuration, or say exactly what is missing.
 *
 * Returns `{ ok: false, problems: [...] }` rather than throwing, so server.js can print
 * every problem at once. A deployer who has to restart four times to discover four
 * missing variables is a deployer who will guess at the fifth.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ ok: true, config: object } | { ok: false, problems: string[] }}
 */
export function readConfig(env = process.env) {
  const problems = [];

  const secret = typeof env.RENDER_SHARED_SECRET === "string" ? env.RENDER_SHARED_SECRET.trim() : "";
  if (!secret) {
    problems.push(
      "RENDER_SHARED_SECRET is not set. This service will not start without it: an unauthenticated render service is an open proxy that runs the caller's JavaScript. Generate one with `node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"` and set the SAME value on this service and on the ChainMind app.",
    );
  } else if (secret.length < MIN_SECRET_CHARS) {
    problems.push(
      `RENDER_SHARED_SECRET is ${secret.length} characters, under the ${MIN_SECRET_CHARS}-character minimum. Length is the only property of a secret that can be checked honestly, so it is the one that is enforced.`,
    );
  }

  const viewport = parseViewport(env.RENDER_VIEWPORT);
  if (env.RENDER_VIEWPORT && !viewport.parsed) {
    problems.push(`RENDER_VIEWPORT is "${String(env.RENDER_VIEWPORT).slice(0, 40)}", which is not WIDTHxHEIGHT (for example 1280x800). Refusing to guess.`);
  }

  if (problems.length) return { ok: false, problems };

  return {
    ok: true,
    config: Object.freeze({
      secret,
      port: intFrom(env, "PORT", 8080, { min: 1, max: 65_535 }),
      maxConcurrency: intFrom(env, "RENDER_MAX_CONCURRENCY", RENDER_LIMITS.MAX_CONCURRENCY, { min: 1, max: 16 }),
      navTimeoutMs: intFrom(env, "RENDER_NAV_TIMEOUT_MS", RENDER_LIMITS.NAV_TIMEOUT_MS, { min: 1_000, max: 60_000 }),
      totalTimeoutMs: intFrom(env, "RENDER_TOTAL_TIMEOUT_MS", RENDER_LIMITS.TOTAL_TIMEOUT_MS, { min: 2_000, max: 90_000 }),
      settleMs: intFrom(env, "RENDER_SETTLE_MS", RENDER_LIMITS.SETTLE_MS, { min: 0, max: 15_000 }),
      maxHtmlBytes: intFrom(env, "RENDER_MAX_HTML_BYTES", RENDER_LIMITS.MAX_HTML_BYTES, { min: 10_000, max: 20_000_000 }),
      maxTextChars: intFrom(env, "RENDER_MAX_TEXT_CHARS", RENDER_LIMITS.MAX_TEXT_CHARS, { min: 1_000, max: 2_000_000 }),
      maxScreenshotBytes: intFrom(env, "RENDER_MAX_SCREENSHOT_BYTES", RENDER_LIMITS.MAX_SCREENSHOT_BYTES, { min: 10_000, max: 20_000_000 }),
      maxRequestRecords: intFrom(env, "RENDER_MAX_REQUEST_RECORDS", RENDER_LIMITS.MAX_REQUEST_RECORDS, { min: 20, max: 5_000 }),
      jsHeapMb: intFrom(env, "RENDER_JS_HEAP_MB", RENDER_LIMITS.JS_HEAP_MB, { min: 64, max: 4_096 }),
      viewport: viewport.value,
      /**
       * THE SANDBOX STAYS ON BY DEFAULT, and this flag exists only because some
       * container hosts forbid the user namespaces Chromium's sandbox needs.
       *
       * `--no-sandbox` is the internet's standard answer to "Chromium will not start in
       * Docker", and it is a real downgrade HERE more than anywhere: the JavaScript this
       * browser runs is written by the party under investigation, and the sandbox is the
       * wall between that JavaScript and this process. So the default is on, turning it
       * off is explicit, and server.js logs a loud line when it is off. The egress proxy
       * (lib/egress-proxy.js) is what keeps even a full renderer escape from reaching an
       * internal address, which is why this is survivable at all — but survivable is not
       * the same as free.
       */
      disableSandbox: boolFrom(env, "RENDER_DISABLE_SANDBOX"),
      /**
       * The same honest, contactable user-agent the HTTP fetcher uses, unless
       * overridden. A diligence tool that renders a third party's page while pretending
       * to be an ordinary Chrome is indistinguishable from the scrapers operators block;
       * this one wants to be identifiable so it CAN be blocked if unwanted.
       */
      userAgent: (typeof env.RENDER_USER_AGENT === "string" && env.RENDER_USER_AGENT.trim() ? env.RENDER_USER_AGENT.trim() : userAgent()).slice(0, 200),
    }),
  };
}

/** "1280x800" -> { width, height }. Anything else keeps the default and says so. */
export function parseViewport(raw) {
  const text = String(raw ?? "").trim().toLowerCase();
  const m = /^(\d{2,5})\s*[x*]\s*(\d{2,5})$/.exec(text);
  if (!m) return { parsed: false, value: { width: 1_280, height: 800 } };
  return {
    parsed: true,
    value: {
      width: Math.max(320, Math.min(3_840, Number(m[1]))),
      height: Math.max(240, Math.min(3_840, Number(m[2]))),
    },
  };
}
