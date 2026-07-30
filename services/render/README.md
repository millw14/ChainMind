# ChainMind render service

A headless browser behind one authenticated endpoint. Give it a URL, get back what a
browser saw: the **painted** HTML after JavaScript ran, the visible text, a screenshot,
the final URL, the HTTP status, console errors, and a summary of every request the page
made.

It is a **separate Railway deployment**. The Next.js app at the repository root stays on
Vercel and is not affected by anything here.

---

## Why it exists, measured

`lib/safe-fetch.js` reads <https://eska.fun/> perfectly — HTTP 200, 5,782 bytes of HTML.
Run that HTML through `lib/site-analysis.js` `stripToText` and there are **4 characters**
of visible text: `ESKA`. The site is client-rendered; everything a person sees is painted
by JavaScript an HTTP GET never executes.

Through this service, same URL, same day, same machine:

| | raw fetch | rendered |
|---|---|---|
| HTML | 5,782 bytes | **76,266 bytes** |
| `stripToText` | **4 chars** (`"ESKA"`) | **343 chars** |
| browser `innerText` | — | 1,365 chars |
| title | *(none in shell)* | `ESKA` |
| requests seen | 1 | 20, of which 3 XHR/fetch |
| screenshot | — | 609,735-byte PNG, 1280×800 |
| time | 754 ms | **2,215 ms** (191 ms navigate, 1,034 ms settle) |

`https://www.ponsfamily.com/`, a heavier app: 45,067 bytes → **256,446 bytes painted**,
603 → **6,475 characters**, 136 requests of which 42 are XHR/fetch, in 6,002 ms.

That last column is the whole point. 4 characters is not a thin site; it is a read of a
different document than the one anybody looked at.

---

## The endpoint

### `POST /render`

```
Authorization: Bearer $RENDER_SHARED_SECRET
Content-Type: application/json

{ "url": "https://example.com/", "budgetMs": 20000 }
```

`budgetMs` is optional and may only make the render **shorter** than the service's own
ceiling — ChainMind's request budget (24 s for a whole question) is tighter than a
render's, and a leg that overruns its caller produces a gateway timeout instead of a
degraded honest answer.

Every response, success or failure, has the same envelope:

```jsonc
{
  "ok": true,
  "status": "rendered",          // one of the outcomes below — never "other"
  "fault": null,                 // null | "site" | "policy" | "service"
  "reading": "…",                // the finished sentence for this outcome
  "trust": "untrusted_third_party_content",
  "untrustedNotice": "…",
  "requestedUrl": "…", "finalUrl": "…", "httpStatus": 200, "redirected": false,
  "content":    { "html": "…", "htmlBytes": 0, "htmlTruncated": false,
                  "text": "…", "textChars": 0, "title": "…" },
  "screenshot": { "available": true, "format": "png", "bytes": 0, "base64": "…" },
  "requests":   { "total": 0, "byType": {}, "xhrCount": 0, "xhr": [], "hosts": [],
                  "thirdPartyHosts": [], "blocked": [], "reading": "…" },
  "console":    { "errorCount": 0, "errors": [], "reading": "…" },
  "egress":     { "bytesIn": 0, "bytesOut": 0, "connections": 0, "blocked": 0 },
  "timing":     { "totalMs": 0, "navigationMs": 0, "settleMs": 0, "settled": true },
  "notChecked": ["…"]
}
```

### `GET /healthz`

Unauthenticated, leaks nothing, and **does not start a browser** — Railway polls it every
few seconds, and a check that launched Chromium would be measuring itself.

```json
{ "ok": true, "service": "chainmind-render", "inFlight": 0, "capacity": 2,
  "uptimeMs": 20848, "node": "v22.17.0", "sandbox": "enabled" }
```

---

## The outcomes, and whose fault each one is

A navigation timeout, a DNS failure, a blocked target, a certificate that would not verify
and a page that rendered to nothing are five different facts about five different things.
They never collapse into "could not render".

| `status` | HTTP | `fault` | means |
|---|---|---|---|
| `rendered` | 200 | — | the browser ran the page and it painted |
| `empty_render` | 200 | site | it rendered, and to almost nothing (< 40 chars). An **observation**, not an error |
| `http_error` | 200 | site | it rendered, and the status was ≥ 400. The error page is evidence |
| `render_timeout` | 200 | site | captured **mid-flight**; the DOM was still changing |
| `dns` | 200 | site | the name did not resolve |
| `tls` | 200 | site | the certificate did not verify — expired, wrong host, untrusted issuer |
| `connection` | 200 | site | refused, reset, unreachable |
| `redirect_loop` | 200 | site | redirected in a loop |
| `navigation_timeout` | 200 | site | no page inside the navigation timeout |
| `crashed` | 200 | site | the tab died, usually memory |
| `refused_url` | 400 | **policy** | this service would not visit that URL. Nothing was observed |
| `blocked_target` | 200 | **policy** | the page was sent somewhere it may not go |
| `at_capacity` | 503 | **service** | already at the concurrency cap. **The site was not contacted** |
| `unavailable` | 503 | **service** | no browser could be started. **Nothing here is a fact about the site** |
| `unauthorized` | 401 | service | no shared secret |
| `bad_request` | 400 | service | unreadable body |

The three `fault: "service"` rows are the reason this table exists. *"We were busy"* must
never reach a reader as *"the project's website is down."*

---

## Security

The premise is that **the browser is hostile**: it executes JavaScript written by the party
under investigation. The design assumes a full renderer compromise and asks what the
attacker then has. The answer is: the ability to render pages.

**1 — SSRF is screened at three layers, all built on `lib/safe-fetch.js`.**
No second, weaker implementation exists; `services/render/lib/screen.js` calls the real
`validateUrl`, and the Dockerfile copies the real module in rather than vendoring a copy.

| layer | where | what it is for |
|---|---|---|
| the target URL | `server.js`, before a browser is touched | a refused URL never occupies a concurrency slot |
| every request Chromium makes | `context.route("**/*")` in `lib/render.js` | **evidence** — a reasoned refusal per URL and resource type |
| every byte that leaves | the loopback proxy in `lib/egress-proxy.js` | **the boundary** — it owns the socket |
| every main-frame navigation | `page.on("framenavigated")` | `data:`/`blob:`/`about:` navigations, which open no socket and so are invisible to the other layers |

The proxy is the load-bearing one. Chromium is launched with a **per-context proxy**, so it
performs **no DNS of its own** — it hands hostnames to the proxy, and `guardedLookup` is
once again the only resolver, which closes the check-then-connect window that request
interception alone would reopen. Verified live: `https://127-0-0-1.nip.io/` and
`http://10-0-0-5.nip.io/` are ordinary public names, and both come back as
`blocked_target` / `fault: policy` naming the address and the range.

It is **not** a MITM: `CONNECT` is tunnelled byte-for-byte, this process holds no key and
no forged certificate, and TLS stays end-to-end — which is also what keeps Chromium's own
certificate validation intact.

**2 — No shared state between targets.** A fresh `BrowserContext` per request: its own
cookie jar, storage, cache and service-worker registry, destroyed with the request. No
persistent profile, no `storageState`, no reuse. Service workers are blocked outright.

**3 — One secret and no others.** `RENDER_SHARED_SECRET` authenticates ChainMind to this
service and grants nothing anywhere else. No chain keys, no LLM key, no Redis or Postgres
credentials, no session secret. **Caching is deliberately not here** — ChainMind already
has `lib/store.js` and can cache a render under the URL it asked for; moving that here
would mean putting Redis credentials in the process with the hostile browser in it. A
cache is not worth a credential. The service refuses to boot without a ≥ 32-character
secret rather than defaulting to open.

**4 — Resource abuse.** Navigation and total timeouts; a hard concurrency cap that refuses
rather than queues; a renderer JS heap ceiling; a 48 MB whole-render byte budget across
*all* of a page's requests; a 120-connection cap; downloads disabled; dialogs dismissed
unanswered; popups closed; viewport-only screenshots (a full-page capture of a hostile
infinite scroll is an allocation attack); HTML, text and screenshot all capped.

**5 — The output is still untrusted content.** The envelope carries
`trust: "untrusted_third_party_content"` and the notice *before* the payload. Rendered text
is if anything **more** the investigated party's own than raw HTML was — it is the product
of running their JavaScript. The authoritative reduction is still
`lib/site-analysis.js` `stripToText` + `findDirectives` over `content.html`, applied by the
caller; `content.text` is a convenience.

---

## The TLS problem

`https://www.ponsfamily.com/` intermittently refuses `lib/safe-fetch.js` with
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY` while loading fine in a browser.

**What is actually happening.** Measured: the chain it normally presents is four
certificates — `www.ponsfamily.com ← YR2 ← Root YR ← ISRG Root X1`, ending in a
self-signed ISRG Root X1 that Node trusts. Node's bundled store (v22.17.0, 150 roots) has
ISRG Root X1 and X2 but **no "Root YR"**, so trust depends *entirely* on the server
including the `Root YR ← ISRG Root X1` cross-signature. When the edge omits it the chain
terminates at an issuer nothing knows, and that is exactly
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`: an **incomplete chain**. Browsers paper over this by
downloading the missing certificate themselves — the leaf carries an *Authority Information
Access* pointer (`http://yr2.i.lencr.org/`, then `http://yr.i.lencr.org/`) — which is
called **AIA chasing**. Node does not do it; it verifies only what the peer sent.

**The fix is to read such a URL through this service, and it is confirmed empirically.**
`https://incomplete-chain.badssl.com/` serves an incomplete chain every time:

| | raw fetch | rendered |
|---|---|---|
| `incomplete-chain.badssl.com` | refused, `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | **`rendered`, 272 chars** |
| `expired.badssl.com` | refused | `tls` — *"the certificate is expired or not yet valid"* |
| `wrong.host.badssl.com` | refused | `tls` — *"does not cover this host name"* |
| `untrusted-root.badssl.com` | refused | `tls` — *"chains to an issuer the browser does not trust"* |

So Chromium completes the **completable** case and still refuses everything else, each with
its own reason. **Verification is never disabled.** There is no
`RENDER_ALLOW_INSECURE_TLS`, no `ignoreHTTPSErrors`, and no path to
`rejectUnauthorized: false` — a page read over a connection that did not verify could not
honestly be attributed to the site it names. `services/render/test/render-auth.test.mjs`
asserts the *absence* of such a switch, because the absence is the feature.

**On the Node side**, `lib/safe-fetch.js` now reports these distinctly instead of the old
generic *"could not be reached"*: code `tls`, plus `tlsCode` and a **`chainFixable`**
boolean. `chainFixable: true` means "a browser-based read of this URL would very likely
succeed" — which makes the decision to fall back to this service mechanical rather than a
guess. An expired certificate is `chainFixable: false`, because it is a real fact about the
site and re-reading it changes nothing.

**Honest limits, both of them.**

*The failure is intermittent, and the render path is an improvement rather than a cure.*
`www.ponsfamily.com` was observed failing in **Chromium too**, in the same minute the raw
fetch failed. It was then measured healthy from every edge address it resolves to — 4 IPs
× 6 TLS handshakes each, all four certificates present every time — and 12/12 successful
raw fetches immediately afterwards. So the bad chain is served *sometimes*, by whichever
edge process answers, and not by a particular address. `incomplete-chain.badssl.com`,
which serves a genuinely incomplete chain every time, renders reliably; when the peer
instead sends a chain terminating in a root the browser's own store lacks, nothing
downstream can complete it. **That case is reported as `tls`, never hidden**, and
`chainFixable` on the Node side tells the caller which of the two it got.

*The operator escape hatch is additive, never subtractive.* Node's own
`NODE_EXTRA_CA_CERTS`, pointing at a PEM of publicly-audited roots (here that would be
ISRG's Root YR), **adds** a trust anchor. Node's bundled store will pick the root up on its
next refresh and the variable can then be dropped. Nothing anywhere removes verification.

---

## Deploying to Railway

Everything is already in the repository. Nothing here needs a Railway account to write, and
none of it guesses at values.

### What was removed

The repository root used to carry a `nixpacks.toml` left over from the pre-pivot
Solana/Turso era. Its start command was `node scripts/pipeline-worker.mjs --turso-sync` —
a script that no longer exists — and its install phase patched around `@libsql/client`, a
dependency that no longer exists either. **Anything deployed from this repository to
Railway would have booted that.** It is deleted and replaced by `railway.json` at the
repository root, which points unambiguously at this service.

### Step by step

1. **Railway → New Project → Deploy from GitHub repo →** `millw14/ChainMind`.
2. **Settings → Source → Root Directory:** leave it as `/` (the repository root).
   This is required, not cosmetic: the Docker build context must include the root `lib/`
   so the service imports the *real* `lib/safe-fetch.js` instead of a copy that would
   drift. `services/render/Dockerfile` copies exactly two files out of it.
3. **Settings → Build.** `railway.json` already selects
   `builder: DOCKERFILE`, `dockerfilePath: services/render/Dockerfile`. If Railway shows
   Nixpacks instead, set the builder to **Dockerfile** and the path to
   `services/render/Dockerfile` by hand.
4. **Variables →** add `RENDER_SHARED_SECRET` (below). Nothing else is required.
5. **Settings → Deploy → Health Check Path:** `/healthz`, timeout `60`. Already in
   `railway.json`.
6. **Settings → Networking → Generate Domain.** Note the `…up.railway.app` hostname.
7. **Settings → Resources:** memory **2 GB**, and leave `RENDER_MAX_CONCURRENCY` at 2.
   Chromium with one page uses roughly 300–600 MB; two concurrent renders plus Node plus
   headroom is what 2 GB buys. If you raise concurrency, raise memory with it — a container
   killed for OOM loses the renders already in flight.
8. On the **Vercel** side, set `RENDER_SERVICE_URL` to the Railway domain and
   `RENDER_SHARED_SECRET` to the *same* value.

### Generating the secret

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Set the identical string on Railway (`RENDER_SHARED_SECRET`) **and** on Vercel
(`RENDER_SHARED_SECRET`). The service refuses to start if it is missing or under 32
characters.

### Environment variables

| variable | required | default | what it does |
|---|---|---|---|
| `RENDER_SHARED_SECRET` | **yes** | — | the only credential. ≥ 32 chars or the service will not boot |
| `PORT` | no | `8080` | Railway sets this itself |
| `RENDER_MAX_CONCURRENCY` | no | `2` | simultaneous renders; over it, `503 at_capacity` |
| `RENDER_NAV_TIMEOUT_MS` | no | `15000` | first-byte-to-DOM ceiling |
| `RENDER_TOTAL_TIMEOUT_MS` | no | `25000` | whole render ceiling |
| `RENDER_SETTLE_MS` | no | `5000` | how long to wait for the DOM to stop changing. Measured: eska.fun settles in 1,034 ms, ponsfamily.com in 4,581 ms |
| `RENDER_VIEWPORT` | no | `1280x800` | screenshot size. Refuses to boot on junk rather than guessing |
| `RENDER_MAX_HTML_BYTES` | no | `2000000` | painted-DOM cap |
| `RENDER_MAX_TEXT_CHARS` | no | `200000` | visible-text cap |
| `RENDER_MAX_SCREENSHOT_BYTES` | no | `2000000` | over this the PNG is dropped, not truncated |
| `RENDER_MAX_REQUEST_RECORDS` | no | `400` | request-log cap |
| `RENDER_JS_HEAP_MB` | no | `256` | renderer JS heap ceiling |
| `RENDER_USER_AGENT` | no | the app's `ChainMindBot/1.0` UA | honest and contactable on purpose |
| `RENDER_DISABLE_SANDBOX` | no | *off* | **read the next section before setting this** |
| `NODE_EXTRA_CA_CERTS` | no | — | Node's own additive trust mechanism. Never needed for the browser path |

There is **no** variable that weakens TLS verification, and none should be added.

### If the browser will not start

The image runs as the non-root `pwuser` and keeps Chromium's sandbox **on**, which is the
wall between the investigated party's JavaScript and this process. If Railway's host
forbids the user namespaces the sandbox needs, `/healthz` stays up and every render answers
`unavailable` with a message naming the flag. Only then set `RENDER_DISABLE_SANDBOX=1`; the
service logs a loud warning while it is set. The egress proxy still bounds what any escape
could reach on the network, but this is a real downgrade — unset it if the host allows the
sandbox.

### Verifying a fresh deploy

```bash
curl https://<your-service>.up.railway.app/healthz

cd services/render
RENDER_URL=https://<your-service>.up.railway.app \
RENDER_SHARED_SECRET=<the secret> \
node scripts/probe.mjs
```

`scripts/probe.mjs` runs the raw fetch and the render for the same URL and prints both, so
the table at the top of this file is reproducible rather than a claim.

---

## Running it locally

```bash
cd services/render
npm install
npx playwright install chromium          # not needed in the container; the image ships it

RENDER_SHARED_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))") \
node server.js
```

## Tests

```bash
npm test          # from the repository root — runs the app's suite AND this service's
```

The service's tests are picked up by the root `node --test` and run **without a browser**:
URL and sub-resource screening, the egress proxy spoken to over its real wire protocol
(absolute-form `GET` and `CONNECT`) including DNS-rebinding refusal through an injected
resolver, auth, boot configuration, the response contract and every distinct failure
reason. Nothing here imports `playwright`, so the root suite needs no browser installed.
