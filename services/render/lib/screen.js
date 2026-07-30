import { SAFE_FETCH_LIMITS, validateUrl } from "../../../lib/safe-fetch.js";

/**
 * WHETHER ONE THING THE BROWSER WANTS TO FETCH MAY BE FETCHED.
 *
 * THE PROBLEM THIS SOLVES, AND WHY IT IS NOT THE SAME PROBLEM lib/safe-fetch.js SOLVES.
 * An HTTP GET fetches one URL that this server chose to fetch. A BROWSER fetches one
 * URL and then, under the control of JavaScript written by the party under
 * investigation, fetches however many more it likes: images, fonts, XHR, fetch(),
 * `<iframe src>`, `import()`, a form post, a meta-refresh, `location =`, a service
 * worker, a WebSocket. Validating the URL the caller asked for screens exactly one of
 * those and none of the rest. A screenshot of an internal admin panel reached by
 * `fetch("http://10.0.0.5/")` inside an iframe is an exfiltration, and it would sail
 * past a check that only looked at the address bar.
 *
 * So EVERY request gets this function, at three layers, on purpose:
 *
 *   1. the top-level URL, before a browser is even started               (server.js)
 *   2. every request Chromium initiates, via a context-wide route handler (lib/render.js)
 *   3. every byte that actually leaves the process, at the proxy    (lib/egress-proxy.js)
 *
 * Layers 1 and 2 exist to produce EVIDENCE — a named, reasoned refusal attached to the
 * specific URL and resource type, which is what a reader needs. Layer 3 is the actual
 * boundary: it is the only one that cannot be bypassed by a Chromium behaviour we did
 * not anticipate, because it owns the socket. If those two ever disagree, layer 3 wins
 * and the request does not happen.
 *
 * THE PREDICATE ITSELF IS lib/safe-fetch.js validateUrl, NOT A NEW ONE. That module's
 * ladder — scheme, credentials, IP literals, internal suffixes, single-label hosts,
 * ports — was adversarially tested against a 56-URL battery, live DNS against nip.io
 * and localtest.me, fake resolvers, rebinding flips, redirect ladders and a hostile
 * origin bound on 127.0.0.1:80. Writing a second screen here would mean maintaining two
 * of them, and the weaker one would be the one that gets used. This file adds only what
 * validateUrl has no opinion about, because an HTTP fetcher never meets it: the
 * browser-internal schemes.
 *
 * PURE. Server-side only: no React.
 */

/**
 * Schemes that a browser resolves entirely inside itself and that therefore open no
 * socket at all.
 *
 * ALLOWED AS SUB-RESOURCES, REFUSED AS A TOP-LEVEL TARGET, and the asymmetry is the
 * point. A `data:` image or a `blob:` worker is how ordinary pages are built and
 * blocking them would break real sites while preventing nothing. But a *navigation* to
 * `data:text/html,...` is a page whose content came from nowhere this service can name
 * — there is no host, no certificate and no operator behind it — so a render of one
 * could not honestly be reported as "what this site shows".
 */
const NETWORKLESS_SCHEMES = Object.freeze(["data:", "blob:", "about:", "filesystem:"]);

/**
 * Schemes a page can name that are neither web nor networkless. Refused everywhere and
 * listed explicitly so the refusal can say which one it was: `file:` reads the
 * container's disk, `chrome:` and `devtools:` reach browser internals, `ws:`/`wss:` is
 * a socket that the route layer cannot intercept, and `javascript:` is not a fetch at
 * all.
 */
const NAMED_BAD_SCHEMES = Object.freeze({
  "file:": "reads this container's own filesystem",
  "chrome:": "reaches Chromium's internal pages",
  "chrome-extension:": "reaches a browser extension",
  "chrome-untrusted:": "reaches Chromium's internal pages",
  "devtools:": "reaches the browser's debugging interface",
  "view-source:": "reaches Chromium's internal pages",
  "javascript:": "is script, not a fetch",
  "ftp:": "is not a web protocol this service speaks",
  "ws:": "is a WebSocket, which carries a live channel this service has no way to read or bound",
  "wss:": "is a WebSocket, which carries a live channel this service has no way to read or bound",
});

/**
 * SCREEN ONE URL THE BROWSER WANTS.
 *
 * Never throws. Always names the rule that was broken, in a sentence, because these
 * refusals travel into the render's evidence and "blocked" on its own tells a reader
 * nothing about whether a site is broken, hostile or merely loading a font from an
 * address that happens to be private.
 *
 * @param {unknown} raw - the URL as the browser presented it
 * @param {{ topLevel?: boolean, resourceType?: string }} [context]
 * @returns {{ allow: boolean, code: string, reason: string|null, scheme: string|null, host: string|null, url: URL|null }}
 */
export function screenRequest(raw, context = {}) {
  const topLevel = context.topLevel === true;
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) {
    return { allow: false, code: "empty", reason: "The browser asked for an empty URL, which was refused.", scheme: null, host: null, url: null };
  }

  const scheme = schemeOf(text);

  if (NETWORKLESS_SCHEMES.includes(scheme)) {
    if (topLevel) {
      return {
        allow: false,
        code: "networkless_navigation",
        reason: `A top-level navigation to a ${scheme} URL was refused. It has no host, no certificate and no operator, so whatever it painted could not honestly be reported as what any site shows.`,
        scheme,
        host: null,
        url: null,
      };
    }
    return {
      allow: true,
      code: "networkless",
      reason: `A ${scheme} sub-resource, which the browser resolves inside itself and which opens no socket.`,
      scheme,
      host: null,
      url: null,
    };
  }

  if (Object.hasOwn(NAMED_BAD_SCHEMES, scheme)) {
    return {
      allow: false,
      code: "bad_scheme",
      reason: `A ${scheme} URL was refused: it ${NAMED_BAD_SCHEMES[scheme]}.`,
      scheme,
      host: null,
      url: null,
    };
  }

  if (scheme !== "http:" && scheme !== "https:") {
    return {
      allow: false,
      code: "bad_scheme",
      reason: `A ${scheme || "scheme-less"} URL was refused. Only http and https are fetched, plus data:/blob:/about: sub-resources that open no socket.`,
      scheme: scheme || null,
      host: null,
      url: null,
    };
  }

  // THE SAME LADDER THE HTTP FETCHER USES, unchanged and not reimplemented.
  if (topLevel) {
    const verdict = validateUrl(text);
    if (!verdict.ok) return { allow: false, code: verdict.code, reason: verdict.refusal, scheme, host: hostOf(text), url: null };
    return { allow: true, code: "allowed", reason: null, scheme, host: verdict.host, url: verdict.url };
  }
  return screenSubResource(text, scheme);
}

/**
 * A sub-resource is screened on its AUTHORITY, not on its whole URL string, and this
 * distinction was forced by a measurement rather than chosen.
 *
 * WHAT WENT WRONG WITH THE OBVIOUS IMPLEMENTATION. Running the caller's URL and every
 * sub-resource through the identical validateUrl looks like the careful thing to do, and
 * it broke real pages. lib/safe-fetch.js caps a URL at 512 characters — the right cap for
 * a URL a person pasted or a token declared on chain, where anything longer is a paste
 * accident or an attempt to hide the host past the end of a log line. It is the WRONG cap
 * for a URL a page issues to its own backend: measured against www.ponsfamily.com, the
 * site's own market and wallet-identity endpoints batch addresses into query strings of
 * 1,007, 2,669 and 5,757 characters. Screening those on length blocked the page's data
 * loading — so the render showed a shell where a visitor sees a populated site, which is
 * the exact failure this whole service exists to fix, reintroduced one layer down.
 *
 * WHY DROPPING THE QUERY IS NOT A WEAKENING. SSRF is decided entirely by four things:
 * the SCHEME, the CREDENTIALS, the HOST and the PORT. A query string is sent to a host
 * that has already been approved and cannot move a socket anywhere — there is no query
 * string that turns example.com into 169.254.169.254. So the authority is reconstructed
 * and passed through validateUrl WHOLE, with credentials included so its credential rule
 * still fires, and every security branch of that ladder runs exactly as before. What is
 * left outside is the part that has no bearing on where the connection goes.
 *
 * The whole string is still bounded, generously, because a megabyte of URL is a memory
 * problem even when it is a safe one.
 */
function screenSubResource(text, scheme) {
  if (text.length > SUBRESOURCE_URL_CHARS) {
    return {
      allow: false,
      code: "too_long",
      reason: `A sub-resource URL of ${text.length} characters was refused, past the ${SUBRESOURCE_URL_CHARS}-character cap. Pages legitimately issue long query strings, so this cap is far above the ${SAFE_FETCH_LIMITS.MAX_URL_CHARS}-character one applied to a URL somebody supplied — but it is still a cap.`,
      scheme,
      host: null,
      url: null,
    };
  }

  let parsed = null;
  try {
    parsed = new URL(text);
  } catch {
    return { allow: false, code: "unparseable", reason: "The browser asked for a URL this service cannot parse, so it was refused.", scheme, host: null, url: null };
  }

  // Credentials are carried into the reconstruction ON PURPOSE. Dropping them would let
  // `https://user:pass@internal.example/` past a rule that exists to catch it.
  const credentials = parsed.username || parsed.password ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ""}@` : "";
  const authority = `${parsed.protocol}//${credentials}${parsed.host}/`;

  const verdict = validateUrl(authority);
  if (!verdict.ok) {
    return { allow: false, code: verdict.code, reason: verdict.refusal, scheme, host: parsed.hostname.toLowerCase(), url: null };
  }
  return { allow: true, code: "allowed", reason: null, scheme, host: verdict.host, url: parsed };
}

/**
 * The ceiling on a sub-resource URL — sixteen times lib/safe-fetch.js's, and it is a
 * memory bound rather than a security one. See screenSubResource for why the two numbers
 * are different and why that is not a hole.
 */
export const SUBRESOURCE_URL_CHARS = 8_192;

/**
 * A NAVIGATION IS SCREENED AGAIN, FROM SCRATCH, EVERY TIME THE MAIN FRAME MOVES.
 *
 * Screening the URL the caller supplied is not screening the page that gets rendered.
 * Between the two sit a 302, a `<meta http-equiv="refresh">`, a `location.replace()` in
 * an inline script, a form auto-submit and a `window.open` — every one of which changes
 * what the address bar holds AFTER the only check a naive implementation performs. The
 * dangerous version of that is a perfectly ordinary public page that, once its script
 * runs, sends the browser to http://169.254.169.254/latest/meta-data/ and lets this
 * service screenshot the result.
 *
 * Separate from screenRequest only so the refusal can say WHICH kind of movement was
 * refused; the predicate underneath is identical.
 *
 * @param {unknown} raw
 * @param {{ from?: string|null }} [context]
 */
export function screenNavigation(raw, context = {}) {
  const verdict = screenRequest(raw, { topLevel: true });
  if (verdict.allow) return verdict;
  const from = typeof context.from === "string" && context.from ? context.from : null;
  return {
    ...verdict,
    code: verdict.code === "networkless_navigation" ? verdict.code : `navigation_${verdict.code}`,
    reason: from
      ? `${from} tried to send this browser to ${String(raw).slice(0, 160)}, which was refused: ${verdict.reason}`
      : verdict.reason,
  };
}

/** The scheme of a URL string, lowercased and including the colon, or "". */
export function schemeOf(raw) {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(String(raw ?? "").trim());
  return m ? `${m[1].toLowerCase()}:` : "";
}

/** The hostname of a URL string, or null when there is not one to be had. */
export function hostOf(raw) {
  try {
    return new URL(String(raw)).hostname.toLowerCase().replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

/**
 * Whether two URLs belong to the same registrable-ish site.
 *
 * DELIBERATELY CRUDE — last two labels, no public-suffix list — and used ONLY to label
 * a request as first- or third-party in the evidence summary. It would be wrong for a
 * security decision (it calls `a.co.uk` and `b.co.uk` the same site) and is never used
 * for one; the security decisions are all screenRequest, which does not care whose site
 * a URL belongs to. Shipping a public-suffix list to make a descriptive label 3% more
 * accurate is not worth the dependency.
 */
export function sameSite(a, b) {
  const ha = hostOf(a);
  const hb = hostOf(b);
  if (!ha || !hb) return false;
  if (ha === hb) return true;
  const tail = (h) => h.split(".").slice(-2).join(".");
  return tail(ha) === tail(hb);
}
