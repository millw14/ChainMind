import { chromium } from "playwright";
import { createEgressProxy } from "./egress-proxy.js";
import { screenNavigation, screenRequest, hostOf } from "./screen.js";
import { EMPTY_TEXT_CHARS, classifyBrowserError, envelope, summariseConsole, summariseRequests } from "./outcome.js";
import { RENDER_LIMITS } from "./config.js";

/**
 * THE BROWSER HALF — and the reason the whole service exists.
 *
 * WHAT IT FIXES, MEASURED. lib/safe-fetch.js reads https://eska.fun/ perfectly: HTTP
 * 200, 5,782 bytes of HTML. Strip that to the words a visitor would see and there are
 * FOUR CHARACTERS of them — "ESKA". The site is client-rendered: everything a human sees
 * is painted by JavaScript that an HTTP GET never runs. A diligence read of a page like
 * that is not a thin read, it is a read of a different document than the one anybody
 * looked at.
 *
 * WHY PLAYWRIGHT AND NOT PUPPETEER. Four reasons, in the order they mattered here:
 *
 *   1. PER-CONTEXT PROXY. `browser.newContext({ proxy })` lets each render have its OWN
 *      screening proxy on its own port, so the egress boundary, its byte budget and its
 *      refusal log belong to exactly one investigated site. Puppeteer's proxy is a
 *      browser-launch argument, which would mean either one shared proxy for every target
 *      (shared accounting, and a bug away from shared state) or a whole browser launch per
 *      request — and a browser launch does not fit in lib/request-budget.js's 24s.
 *   2. CONTEXTS ARE REAL ISOLATION AND ARE CHEAP. A fresh BrowserContext has its own
 *      cookie jar, storage, cache and service-worker registry, costs tens of milliseconds,
 *      and is destroyed with the request. That is requirement 2 — no shared state between
 *      targets — satisfied by construction rather than by remembering to clear things.
 *   3. `serviceWorkers: "block"` IS ONE OPTION. A service worker survives the page,
 *      intercepts its own fetches and is the single most awkward thing to reason about in
 *      a hostile page. Playwright turns them off with a string.
 *   4. THE OFFICIAL CONTAINER IMAGE. Chromium needs a long list of shared libraries, and
 *      getting that wrong is the usual way this deployment fails.
 *      mcr.microsoft.com/playwright:v1.62.1-noble ships them, pinned to the same version
 *      as the npm package. See services/render/Dockerfile.
 *
 * THE BROWSER IS A SINGLETON; THE CONTEXT IS NOT. Launching Chromium costs ~300-900ms and
 * happens once per process; a context costs ~30ms and happens once per request. That is
 * what makes a render fit inside a request at all.
 *
 * Server-side only: no React.
 */

/**
 * The one browser, and the promise that is launching it.
 *
 * Held as a PROMISE rather than an instance so that two concurrent first requests share
 * one launch instead of racing into two browsers, one of which would then be leaked.
 */
let browserPromise = null;

/**
 * Chromium's flags, and every one of them is here for a stated reason.
 *
 * The container-shaped ones matter most: `--disable-dev-shm-usage` because Docker gives
 * /dev/shm 64MB by default and Chromium will crash a tab rather than tell you, which
 * would surface as `crashed` on every page heavier than a brochure.
 */
function launchArgs({ jsHeapMb, disableSandbox }) {
  const args = [
    // A hostile page allocating until the container dies is requirement 4's failure mode.
    // This bounds the RENDERER's JavaScript heap, which is where that allocation lands.
    `--js-flags=--max-old-space-size=${jsHeapMb}`,
    "--disable-dev-shm-usage",
    "--disable-gpu",
    // Nothing here should ever phone home: this process is supposed to make exactly the
    // requests the investigated page makes, so that the request log IS evidence about
    // that page. Chromium's own background traffic would be noise in it — and it would
    // also be traffic through the egress proxy that nobody asked for.
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
    "--disable-sync",
    "--no-first-run",
    "--no-default-browser-check",
    "--metrics-recording-only",
    "--disable-breakpad",
    "--disable-features=Translate,OptimizationHints,MediaRouter,InterestFeedContentSuggestions,AcceptCHFrame",
    // Downloads are disabled at the context level too; this stops the prompt as well.
    "--disable-prompt-on-repost",
  ];
  if (disableSandbox) {
    // See lib/config.js for why this is not the default and what it costs.
    args.push("--no-sandbox", "--disable-setuid-sandbox");
  }
  return args;
}

/**
 * The single browser, launched on first use.
 *
 * `proxy: { server: "http://per-context" }` is not a typo and not a real address.
 * Chromium only honours a per-context proxy when the browser was launched with SOME
 * proxy, so this placeholder exists to enable the feature; every context overrides it
 * with its own real one, and any traffic that somehow used this value would fail to
 * connect — which is the correct direction for a mistake in a screening layer to fail.
 */
export async function getBrowser(config) {
  if (browserPromise) {
    const b = await browserPromise;
    if (b.isConnected()) return b;
    browserPromise = null;
  }
  browserPromise = chromium
    .launch({
      headless: true,
      args: launchArgs(config),
      proxy: { server: "http://per-context" },
      timeout: 30_000,
    })
    .then((b) => {
      // A browser that dies takes its promise with it, so the next request relaunches
      // rather than awaiting a corpse forever.
      b.on("disconnected", () => {
        browserPromise = null;
      });
      return b;
    })
    .catch((e) => {
      browserPromise = null;
      throw e;
    });
  return browserPromise;
}

/** Shut the browser down. Used by the service's own shutdown path and by tests. */
export async function closeBrowser() {
  const p = browserPromise;
  browserPromise = null;
  if (!p) return;
  try {
    const b = await p;
    await b.close();
  } catch {
    // Closing a browser that is already gone is not a failure.
  }
}

/**
 * RENDER ONE URL AND SAY WHAT A BROWSER SAW.
 *
 * Never throws. Every path returns an `envelope()` naming one outcome and whose fault it
 * was.
 *
 * @param {string} rawUrl
 * @param {object} config - from lib/config.js readConfig
 * @returns {Promise<object>}
 */
export async function renderUrl(rawUrl, config) {
  const startedAt = Date.now();

  // Layer 1. Screened before a browser is touched, so a refused URL costs nothing and
  // reports as policy rather than as anything about a site.
  const gate = screenRequest(rawUrl, { topLevel: true });
  if (!gate.allow) {
    return envelope("refused_url", {
      requestedUrl: String(rawUrl ?? "").slice(0, 300),
      refusalCode: gate.code,
      refusal: gate.reason,
      timing: { totalMs: Date.now() - startedAt },
    });
  }

  let browser = null;
  try {
    browser = await getBrowser(config);
  } catch (e) {
    return envelope("unavailable", {
      requestedUrl: rawUrl,
      refusal: `A browser could not be started: ${String(e?.message ?? e).slice(0, 300)}${
        /sandbox|SUID|namespace|clone/i.test(String(e?.message ?? e)) ? " — this reads like the host forbidding Chromium's sandbox; see RENDER_DISABLE_SANDBOX in services/render/README.md before turning the sandbox off." : ""
      }`,
      timing: { totalMs: Date.now() - startedAt },
    });
  }

  /**
   * The refusal that explains a failed navigation, captured as it happens.
   *
   * Chromium describes a proxy refusal as `ERR_TUNNEL_CONNECTION_FAILED` and no more.
   * The proxy knows which address and which range, so its sentence is stashed here and
   * classifyBrowserError prefers it over Chromium's.
   */
  let mainFrameRefusal = null;
  const targetHost = hostOf(rawUrl);

  const proxy = await createEgressProxy({
    onDecision: (d) => {
      // Only a refusal aimed at the page's OWN host explains a failed navigation. A
      // blocked tracker on some other host is a fact about the page, not the reason it
      // did not load, and reporting it as the reason would be a wrong answer.
      if (d.allowed === false && !mainFrameRefusal && d.host && targetHost && d.host === targetHost) {
        mainFrameRefusal = d.reason;
      }
    },
  });

  const requests = [];
  const consoleEntries = [];
  let navigationRefusal = null;
  let context = null;

  try {
    /**
     * A FRESH CONTEXT, AND EVERY ISOLATION SWITCH SET DELIBERATELY.
     *
     * There is no `storageState`, no user data dir and no reuse: this context has never
     * seen another site and will not exist a second after this one. One investigated
     * party cannot read what another left behind because there is nothing left behind.
     *
     * `ignoreHTTPSErrors` IS ABSENT ON PURPOSE and must stay absent. Its default is
     * false. A render taken over a connection that did not verify could not honestly be
     * attributed to the site it names, and there is no configuration path to it — see
     * lib/config.js.
     */
    context = await browser.newContext({
      proxy: {
        server: proxy.url,
        // Chromium bypasses the proxy for loopback by DEFAULT. `<-loopback>` cancels
        // that: with it, even a request to 127.0.0.1 goes through the screen and is
        // refused there, rather than quietly reaching whatever is listening in this
        // container.
        bypass: "<-loopback>",
      },
      userAgent: config.userAgent,
      viewport: config.viewport,
      // A service worker outlives its page, serves its own fetches and would sit outside
      // the request log this service reports as evidence. Blocked outright.
      serviceWorkers: "block",
      // Requirement 4: a page must not be able to write to this container's disk.
      acceptDownloads: false,
      javaScriptEnabled: true,
      // The site's own Content-Security-Policy is left in force. Weakening a page's
      // defences to render it would mean rendering something the site does not serve.
      bypassCSP: false,
      locale: "en-US",
      timezoneId: "UTC",
    });
    context.setDefaultTimeout(config.navTimeoutMs);

    /**
     * LAYER 2: EVERY REQUEST THE PAGE INITIATES, SCREENED AND RECORDED.
     *
     * `context.route` rather than `page.route`, so an iframe or a popup that the page
     * opens is covered by the same handler rather than being a hole shaped like the
     * thing an attacker would reach for first.
     *
     * THIS LAYER IS FOR EVIDENCE. It is not the boundary — a redirect target may reach
     * the network without a second route event, and Chromium's own DNS would otherwise
     * reopen the rebinding window. The boundary is the proxy, which sees the redirect as
     * a new connection and screens it from scratch. Both run; when they disagree, the
     * proxy wins because it owns the socket.
     */
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = request.url();
      const verdict = screenRequest(url, { topLevel: false, resourceType: request.resourceType() });
      if (verdict.allow) {
        if (requests.length < config.maxRequestRecords) {
          requests.push({ url, host: verdict.host ?? hostOf(url), method: request.method(), resourceType: request.resourceType(), blocked: false });
        }
        try {
          await route.continue();
        } catch {
          // The page can be gone between the event and the continue; that is not an error.
        }
        return;
      }
      if (requests.length < config.maxRequestRecords) {
        requests.push({ url, host: verdict.host ?? hostOf(url), method: request.method(), resourceType: request.resourceType(), blocked: true, code: verdict.code, reason: verdict.reason });
      }
      if (request.isNavigationRequest() && request.frame().parentFrame() === null) {
        mainFrameRefusal = mainFrameRefusal ?? verdict.reason;
      }
      try {
        await route.abort("blockedbyclient");
      } catch {
        // Same: aborting a request whose page has gone is a no-op, not a failure.
      }
    });

    const page = await context.newPage();

    /**
     * LAYER 3 FOR THE ONE THING THE OTHER TWO CANNOT SEE.
     *
     * `data:`, `blob:` and `about:` navigations open no socket, so the proxy never meets
     * them and routing does not fire for them. A page that does
     * `location = "data:text/html,<h1>Audited and verified</h1>"` would otherwise be
     * screenshotted and reported under the site's name, with content that came from
     * nowhere this service can attribute. This is where that is caught.
     */
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      // `about:blank` is where every page starts and where an aborted load lands. It
      // carries no content and reaches no network, so treating it as a refused navigation
      // would close the page before it had been anywhere — which is what happens if this
      // handler is ever registered before the first newPage() rather than after it.
      if (frame.url() === "about:blank" || !frame.url()) return;
      const verdict = screenNavigation(frame.url(), { from: "the page" });
      if (!verdict.allow && !navigationRefusal) {
        navigationRefusal = verdict.reason;
        page.close({ runBeforeUnload: false }).catch(() => {});
      }
    });

    // Requirement 4: a modal dialog blocks the renderer until something answers it, and
    // nothing here will be answering, so every one is dismissed the moment it appears.
    page.on("dialog", (d) => {
      d.dismiss().catch(() => {});
    });
    // A popup is a second page outside the one being measured. Closed, and counted only
    // as the fact that the page opened one.
    page.on("popup", (p) => {
      consoleEntries.push({ type: "warning", text: `the page opened a popup window (${String(p.url()).slice(0, 200)}), which was closed without being rendered` });
      p.close().catch(() => {});
    });
    page.on("download", (d) => {
      consoleEntries.push({ type: "warning", text: `the page started a download (${String(d.suggestedFilename?.() ?? "unnamed").slice(0, 120)}), which was refused` });
      d.cancel().catch(() => {});
    });
    page.on("console", (msg) => {
      if (consoleEntries.length >= 200) return;
      consoleEntries.push({ type: msg.type(), text: msg.text() });
    });
    page.on("pageerror", (err) => {
      if (consoleEntries.length >= 200) return;
      consoleEntries.push({ type: "error", text: `uncaught ${String(err?.message ?? err)}` });
    });
    page.on("response", (res) => {
      const hit = requests.find((r) => r.url === res.url() && r.status == null);
      if (hit) hit.status = res.status();
    });
    page.on("requestfailed", (req) => {
      const hit = requests.find((r) => r.url === req.url());
      if (hit) hit.failed = true;
    });

    const deadline = startedAt + config.totalTimeoutMs;

    let response = null;
    try {
      response = await page.goto(rawUrl, {
        // `domcontentloaded` AND NOT `networkidle`. networkidle never fires on a page
        // holding an open analytics socket or a polling timer, which is most of them, so
        // waiting for it turns every live site into a navigation timeout. The settling is
        // done afterwards and separately, where a failure to settle is a DIFFERENT and
        // less severe outcome than a failure to navigate.
        waitUntil: "domcontentloaded",
        timeout: Math.max(1_000, Math.min(config.navTimeoutMs, deadline - Date.now())),
      });
    } catch (e) {
      const cls = classifyBrowserError(e, { proxyRefusal: navigationRefusal ?? mainFrameRefusal });
      return envelope(cls.code, {
        requestedUrl: rawUrl,
        finalUrl: safeUrl(page),
        refusalCode: cls.code,
        refusal: cls.reason,
        browserError: cls.raw,
        requests: summariseRequests(requests, safeUrl(page)),
        console: summariseConsole(consoleEntries, RENDER_LIMITS.MAX_CONSOLE_RECORDS),
        egress: proxy.stats(),
        timing: { totalMs: Date.now() - startedAt },
      });
    }

    /**
     * A REFUSAL THAT ARRIVED AS A PAGE, WHICH IS THE ONE THIS ALMOST GOT WRONG.
     *
     * For an https:// target the egress proxy refuses the CONNECT, no tunnel is built, and
     * `page.goto` throws — so the refusal is caught above. For an http:// target the proxy
     * answers with a real 403 response, and Chromium does what a browser does: it RENDERS
     * it. Navigation succeeds, the status is 403, and without this check the render came
     * back as `http_error` with fault "site" — this service's own policy refusal reported
     * as a fact about the site, which is the exact confusion the outcome taxonomy exists to
     * prevent. Measured against http://10-0-0-5.nip.io/, a public name resolving into
     * 10.0.0.0/8.
     *
     * The proxy stamps every refusal with a header nobody else sends, so the two are told
     * apart by evidence rather than by guessing from the status code.
     */
    const egressRefused = response?.headers?.()?.["x-chainmind-render"] === "egress-refused";
    if (navigationRefusal || egressRefused) {
      return envelope("blocked_target", {
        requestedUrl: rawUrl,
        finalUrl: safeUrl(page),
        refusalCode: "navigation_blocked",
        refusal:
          navigationRefusal ??
          mainFrameRefusal ??
          "The request for this page was refused by this service's egress screen before it reached the network.",
        requests: summariseRequests(requests, safeUrl(page)),
        console: summariseConsole(consoleEntries),
        egress: proxy.stats(),
        timing: { totalMs: Date.now() - startedAt },
      });
    }

    const settle = await waitForPaint(page, { settleMs: config.settleMs, deadline });

    // Captured one at a time rather than in parallel: three CDP round trips against a
    // page that may be actively fighting are cheaper to reason about in sequence, and a
    // screenshot that fails must not take the HTML down with it.
    const html = await page.content().catch(() => "");
    const text = await page
      .evaluate(() => (document.body ? document.body.innerText : ""))
      .catch(() => "");
    const shot = await captureScreenshot(page, config);

    const finalUrl = safeUrl(page) ?? rawUrl;
    const httpStatus = response?.status() ?? null;
    const htmlBytes = Buffer.byteLength(html, "utf8");
    const htmlTruncated = htmlBytes > config.maxHtmlBytes;
    const flatText = String(text).replace(/\s+/g, " ").trim();
    const textTruncated = flatText.length > config.maxTextChars;

    /**
     * The order matters and is not arbitrary. A capture taken mid-flight is reported as
     * such FIRST, because its status and its emptiness are both provisional — calling a
     * page empty when the budget simply ran out before it painted would be a finding
     * nobody made. Blocked targets have already returned above.
     */
    const code = !settle.settled
      ? "render_timeout"
      : httpStatus != null && httpStatus >= 400
        ? "http_error"
        : flatText.length < EMPTY_TEXT_CHARS
          ? "empty_render"
          : "rendered";

    return envelope(code, {
      requestedUrl: rawUrl,
      finalUrl,
      httpStatus,
      redirected: finalUrl !== rawUrl,
      content: {
        trust: "untrusted_third_party_text",
        /** THE PAINTED DOM — what the browser had after the page's own JavaScript ran,
         *  which is a different document from the bytes the server sent. */
        html: htmlTruncated ? html.slice(0, config.maxHtmlBytes) : html,
        htmlBytes,
        htmlTruncated,
        htmlNote: htmlTruncated
          ? `Only the first ${config.maxHtmlBytes} bytes of the painted DOM were kept (the cap), so anything past that point was NOT examined — unread, not absent.`
          : null,
        text: textTruncated ? `${flatText.slice(0, config.maxTextChars - 1)}…` : flatText,
        textChars: flatText.length,
        textTruncated,
        textNote:
          "`text` is the browser's own innerText of <body> — what a sighted visitor would read. It is offered as a convenience; the authoritative reduction is lib/site-analysis.js stripToText run over `html`, which additionally accounts for hidden elements, comments and metadata.",
        title: await page.title().catch(() => null),
      },
      screenshot: shot,
      requests: summariseRequests(requests, finalUrl),
      console: summariseConsole(consoleEntries),
      egress: proxy.stats(),
      timing: {
        totalMs: Date.now() - startedAt,
        navigationMs: settle.navigationMs,
        settleMs: settle.waitedMs,
        settled: settle.settled,
        settleNote: settle.settled
          ? "The DOM stopped changing before the budget ran out, so this capture is of a page that had finished painting."
          : "The DOM was STILL CHANGING when the budget ran out, so this capture is mid-flight. What is here was really on screen; what had not arrived is UNSEEN, not missing from the site.",
      },
      notChecked: [
        "Any page but this one: no crawl, no subpage, nothing behind a login, and no interaction — nothing was clicked, typed into, scrolled or dismissed except modal dialogs, which were dismissed unanswered.",
        "Whether anything the page says is true. The words were rendered and quoted, never verified.",
        "What the page's own API calls returned. Their method, host, path and status were recorded; no response body was read.",
        "Anything below the fold: the screenshot is the viewport, not the full page — a full-page capture of a hostile infinite scroll is an allocation attack.",
      ],
    });
  } catch (e) {
    const cls = classifyBrowserError(e, { proxyRefusal: navigationRefusal ?? mainFrameRefusal });
    return envelope(cls.code, {
      requestedUrl: rawUrl,
      refusalCode: cls.code,
      refusal: cls.reason,
      browserError: cls.raw,
      requests: summariseRequests(requests, null),
      console: summariseConsole(consoleEntries),
      egress: proxy.stats(),
      timing: { totalMs: Date.now() - startedAt },
    });
  } finally {
    // THE CONTEXT DIES WITH THE REQUEST, and so does the proxy that served it. This is
    // the whole of requirement 2: there is no cookie jar, cache or storage left for the
    // next investigated site to find, because there is nothing left at all.
    if (context) await context.close().catch(() => {});
    await proxy.close().catch(() => {});
  }
}

/**
 * WAIT FOR THE PAGE TO STOP CHANGING, WITHIN A BUDGET, AND SAY WHETHER IT DID.
 *
 * `load` is the wrong signal for the sites this service exists for: it fires when the
 * document's subresources are done, which on a client-rendered app is BEFORE the bundle
 * has mounted anything. Waiting a fixed sleep instead is worse — too short for a slow app
 * and wasted time on a fast one.
 *
 * So the DOM is sampled instead: when its size and its text length are the same twice in
 * a row, it has stopped painting. Two identical samples rather than one, because a React
 * mount commonly lands between them.
 *
 * WHETHER IT SETTLED IS PART OF THE ANSWER. A capture taken while the page was still
 * changing is real and usable, and it is NOT the same thing as a finished one; the caller
 * is told which it got rather than being left to assume.
 */
async function waitForPaint(page, { settleMs, deadline }) {
  const startedAt = Date.now();
  const loadStart = Date.now();
  await page.waitForLoadState("load", { timeout: Math.max(1, Math.min(settleMs, deadline - Date.now())) }).catch(() => {});
  const navigationMs = Date.now() - loadStart;

  let last = null;
  let stableFor = 0;
  const step = 200;
  while (Date.now() < deadline && Date.now() - startedAt < settleMs) {
    const size = await page
      .evaluate(() => {
        const body = document.body;
        return [document.documentElement?.outerHTML?.length ?? 0, body?.innerText?.length ?? 0, body?.childElementCount ?? 0];
      })
      .catch(() => null);
    if (size == null) break;
    const key = size.join(":");
    if (key === last) {
      stableFor += 1;
      // Two consecutive identical samples, and never before at least one full step has
      // passed — otherwise a page that has not started painting yet reads as settled.
      if (stableFor >= 2 && Date.now() - startedAt >= step) {
        return { settled: true, waitedMs: Date.now() - startedAt, navigationMs };
      }
    } else {
      stableFor = 0;
      last = key;
    }
    await page.waitForTimeout(step).catch(() => {});
  }
  return { settled: false, waitedMs: Date.now() - startedAt, navigationMs };
}

/**
 * The viewport as a PNG, or a stated reason there is not one.
 *
 * VIEWPORT AND NOT FULL PAGE. `fullPage: true` on a page with an infinite scroll or a
 * 200,000px container asks Chromium to allocate a bitmap of that size, which is the
 * cheapest way for a hostile page to take this container down. What is above the fold is
 * what a visitor sees first anyway.
 */
async function captureScreenshot(page, config) {
  try {
    const buf = await page.screenshot({ type: "png", timeout: 8_000, animations: "disabled", caret: "hide" });
    if (buf.length > config.maxScreenshotBytes) {
      return {
        available: false,
        reason: `The screenshot came to ${buf.length} bytes, past the ${config.maxScreenshotBytes}-byte cap, so it was DISCARDED rather than truncated — half a PNG is not a smaller picture, it is a corrupt file.`,
        bytes: buf.length,
      };
    }
    return { available: true, format: "png", bytes: buf.length, width: config.viewport.width, height: config.viewport.height, base64: buf.toString("base64") };
  } catch (e) {
    return { available: false, reason: `The screenshot could not be taken: ${String(e?.message ?? e).slice(0, 200)}. The HTML and text above are unaffected.`, bytes: 0 };
  }
}

/** The page's URL, or null if the page has already gone. */
function safeUrl(page) {
  try {
    const u = page.url();
    return u && u !== "about:blank" ? u : null;
  } catch {
    return null;
  }
}
