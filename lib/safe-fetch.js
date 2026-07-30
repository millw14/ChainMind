import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { clampTimeout } from "./request-budget.js";

/**
 * THE ONLY WAY THIS SERVER FETCHES A URL IT DID NOT CHOOSE.
 *
 * Everything above this module — a project's own declared website, a URL a user
 * pasted beside a contract address — is an address supplied by somebody else, and
 * one of those somebodies is the party under investigation. So this module's job is
 * not "fetch a page". It is to make it impossible to aim this server's socket at
 * this server's own network, and to make every refusal say why in words a reader
 * can act on.
 *
 * WHY IT IS BUILT ON node:http RATHER THAN fetch, and this is the load-bearing
 * design decision. `fetch` gives no control over the DNS resolution that precedes
 * the connect, so the only SSRF check available to it is "resolve the name, decide
 * it is fine, then call fetch and hope it resolves to the same thing" — the classic
 * DNS-rebinding hole, where an attacker's authoritative server answers 1.2.3.4 to
 * the check and 169.254.169.254 to the connect a millisecond later.
 * node:http.request accepts a `lookup` function, and the socket connects to
 * EXACTLY the addresses that function returns. So the validation and the connect
 * read the same bytes by construction, and there is no window between them. See
 * guardedLookup.
 *
 * WHAT IS ENFORCED, in the order it is enforced:
 *
 *   1. scheme is http or https, nothing else                          (validateUrl)
 *   2. no credentials in the URL                                      (validateUrl)
 *   3. host is a DNS name, not an IP literal                          (validateUrl)
 *   4. host is not a private/internal suffix and is not single-label   (validateUrl)
 *   5. port is 80 or 443                                              (validateUrl)
 *   6. every address the name resolves to is publicly routable      (guardedLookup)
 *   7. the socket connects only to those addresses                  (guardedLookup)
 *   8. 1-7 again, from scratch, on every redirect target                  (safeFetch)
 *   9. redirect count, wall-clock time and response bytes are capped     (safeFetch)
 *
 * Rules 6 and 8 together are what stops the interesting attack: a public host that
 * 302s to http://169.254.169.254/latest/meta-data/. The redirect target is a fresh
 * URL and gets the whole ladder again, including its own resolution, and a blocked
 * target ends the fetch with a refusal rather than being followed.
 *
 * WHAT IT IS NOT FOR. It has no POST, no request body, no cookie jar, no
 * credentials, no header passthrough and no caller-supplied headers. It cannot
 * carry this deployment's secrets anywhere, because it has no way to be given
 * them. A caller that needs any of that must not reach for this module.
 *
 * Never throws: every path returns `{ ok: true, ... }` or `{ ok: false, refusal }`.
 * Server-side only: no React.
 */

/* ------------------------------- the bounds ------------------------------- */

/**
 * The caps, together, because they are one budget and reading them apart invites
 * raising one of them alone.
 *
 * MAX_BYTES is 512KB against measured pages: the launchpad's own token page is
 * 56KB of HTML and its homepage 45KB, so 512KB is roughly ten times the largest
 * thing this is expected to meet — generous enough that a real page is never
 * truncated, small enough that a hostile endpoint streaming gigabytes costs this
 * process half a megabyte and a torn socket.
 *
 * MAX_REDIRECTS is 3. A canonicalising site spends two (apex -> www, http ->
 * https, and the measured ponsfamily.com spends one of those). A chain longer than
 * three is either a loop or somebody walking us somewhere.
 *
 * TIMEOUT_MS is the WHOLE fetch including every redirect hop, not per hop, because
 * a per-hop timeout multiplies by the redirect cap and the caller's budget does
 * not. 6s against a 24s request budget of which the chain legs already spend most.
 */
export const SAFE_FETCH_LIMITS = Object.freeze({
  MAX_BYTES: 512_000,
  MAX_REDIRECTS: 3,
  TIMEOUT_MS: 6_000,
  MAX_URL_CHARS: 512,
  ALLOWED_PORTS: Object.freeze(["", "80", "443"]),
});

/**
 * Hostname suffixes that name something inside a network rather than on the
 * internet. Refused BEFORE any DNS lookup, because a name that should never be
 * resolved should never be resolved — a split-horizon resolver would happily
 * return a private answer, and a public resolver's NXDOMAIN would leak the query.
 *
 * `.home.arpa` and `.internal` are the two that matter in a cloud deployment:
 * metadata.google.internal is the GCE metadata endpoint by name, and blocking the
 * suffix blocks it without needing to know the hostname.
 */
const INTERNAL_SUFFIXES = Object.freeze([
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".home.arpa",
  ".corp",
  ".private",
  ".onion",
  ".i2p",
  ".test",
  ".invalid",
  ".example",
]);

/** Whole hostnames that are never a project's website. */
const INTERNAL_NAMES = Object.freeze(["localhost", "instance-data", "metadata"]);

/**
 * Characters that must never appear in a URL this server is asked to fetch:
 * whitespace, C0/C1 controls, zero-width and bidi marks.
 *
 * REFUSED RATHER THAN STRIPPED. A zero-width space inside a hostname makes two
 * different strings look identical to a reader, and the two resolve differently —
 * so a server that helpfully removed it would fetch a URL nobody asked for and
 * then report on it under the name of the one that was asked for.
 */
const JUNK_RANGES = Object.freeze([
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0xfeff, 0xfeff],
]);

/**
 * The character class above, assembled from code points rather than written out —
 * a source file containing a literal zero-width space inside a regex is a source
 * file nobody can review.
 */
function junkPattern(extra, flags) {
  const body = JUNK_RANGES.map(([a, b]) =>
    a === b ? String.fromCharCode(a) : String.fromCharCode(a) + "-" + String.fromCharCode(b),
  ).join("");
  return new RegExp("[" + extra + body + "]", flags);
}

// Whitespace is in the URL class as well as the controls: a space in a URL is a
// pasting accident at best and a way to hide the real target at worst.
const URL_JUNK_RE = junkPattern(`${String.fromCharCode(92)}s`, "");

/** The same class, for flattening a response header into one safe line. */
const HEADER_JUNK_RE = junkPattern("", "g");


/* ------------------------------ IP classification ------------------------------ */

/**
 * IPv4 ranges that must never be connected to, as [firstOctet, mask, label].
 *
 * The list is longer than "the three RFC1918 ranges" on purpose. 169.254.0.0/16 is
 * the one that actually gets exploited — 169.254.169.254 is the instance metadata
 * endpoint on AWS, Azure, GCP, DigitalOcean and Oracle, and reaching it from a
 * server-side fetch hands over that instance's credentials. 100.64.0.0/10 is
 * carrier-grade NAT, which is where a container network commonly lives. The
 * documentation and benchmarking ranges are here not because they are dangerous
 * but because a URL pointing at one is never a real website, and refusing them is
 * free.
 */
const V4_BLOCKS = Object.freeze([
  ["0.0.0.0", 8, "the \"this network\" range"],
  ["10.0.0.0", 8, "a private range (RFC 1918)"],
  ["100.64.0.0", 10, "the carrier-grade NAT range, where container networks commonly live"],
  ["127.0.0.0", 8, "loopback — this server itself"],
  ["169.254.0.0", 16, "the link-local range, which contains the cloud instance metadata endpoint 169.254.169.254"],
  ["172.16.0.0", 12, "a private range (RFC 1918)"],
  ["192.0.0.0", 24, "an IETF protocol assignment range"],
  ["192.0.2.0", 24, "a documentation range"],
  ["192.88.99.0", 24, "the 6to4 relay anycast range"],
  ["192.168.0.0", 16, "a private range (RFC 1918)"],
  ["198.18.0.0", 15, "a benchmarking range"],
  ["198.51.100.0", 24, "a documentation range"],
  ["203.0.113.0", 24, "a documentation range"],
  ["224.0.0.0", 4, "the multicast range"],
  ["240.0.0.0", 4, "a reserved range"],
]);

/** Dotted quad -> 32-bit integer, or null when it is not one. */
function v4ToInt(s) {
  const parts = String(s).split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/**
 * An IPv6 address as eight 16-bit groups, or null when it is not one.
 *
 * Written out rather than delegated because the embedded-IPv4 forms are the whole
 * point: ::ffff:169.254.169.254 and 64:ff9b::a9fe:a9fe are both the metadata
 * endpoint wearing a v6 costume, and a classifier that only looked at the textual
 * prefix would pass both.
 */
function v6Groups(s) {
  let text = String(s).trim();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  // A zone index (%eth0) is not part of the address and must not defeat the parse.
  const pct = text.indexOf("%");
  if (pct >= 0) text = text.slice(0, pct);

  // A trailing dotted quad is the embedded-IPv4 form; fold it into two groups.
  const dotted = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const n = v4ToInt(dotted[1]);
    if (n === null) return null;
    const hi = (n >>> 16).toString(16);
    const lo = (n & 0xffff).toString(16);
    text = `${text.slice(0, dotted.index)}${hi}:${lo}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  const parse = (list) => {
    const out = [];
    for (const g of list) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const h = parse(head);
  if (h === null) return null;
  if (tail === null) return h.length === 8 ? h : null;
  const t = parse(tail);
  if (t === null) return null;
  const fill = 8 - h.length - t.length;
  if (fill < 0) return null;
  return [...h, ...new Array(fill).fill(0), ...t];
}

/**
 * WHETHER ONE RESOLVED ADDRESS MAY BE CONNECTED TO, and why not when it may not.
 *
 * PURE, exported, and tested directly against every range above, because this
 * function IS the SSRF control — everything else in this module is plumbing around
 * it, and a hole here is a hole in the whole feature.
 *
 * DEFAULT DENY. An address this function cannot parse is BLOCKED, not allowed: a
 * classifier that fell open on an input it did not understand would be defeated by
 * whichever encoding it did not understand.
 *
 * @param {unknown} ip
 * @returns {{ blocked: boolean, family: 4|6|null, reason: string|null }}
 */
export function classifyIp(ip) {
  const text = String(ip ?? "").trim();
  if (!text) return { blocked: true, family: null, reason: "an empty address" };

  const stripped = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  const zoneless = stripped.split("%")[0];

  if (isIP(zoneless) === 4 || v4ToInt(zoneless) !== null) {
    const n = v4ToInt(zoneless);
    if (n === null) return { blocked: true, family: 4, reason: "an IPv4 address that could not be parsed" };
    if (n === 0xffffffff) return { blocked: true, family: 4, reason: "the broadcast address" };
    for (const [base, bits, label] of V4_BLOCKS) {
      const b = v4ToInt(base);
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if (((n ^ b) & mask) === 0) return { blocked: true, family: 4, reason: label };
    }
    return { blocked: false, family: 4, reason: null };
  }

  const g = v6Groups(zoneless);
  if (g === null) return { blocked: true, family: null, reason: "an address that is neither IPv4 nor IPv6" };

  const allZero = g.every((x) => x === 0);
  if (allZero) return { blocked: true, family: 6, reason: "the IPv6 unspecified address ::" };
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) {
    return { blocked: true, family: 6, reason: "IPv6 loopback ::1 — this server itself" };
  }

  // The embedded-IPv4 forms, checked by recursing on the address they carry: an
  // IPv4-mapped or NAT64-translated private address is a private address.
  const embedded = `${(g[6] >> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >> 8) & 0xff}.${g[7] & 0xff}`;
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    const inner = classifyIp(embedded);
    return {
      blocked: true,
      family: 6,
      reason: `an IPv4-mapped IPv6 address carrying ${embedded}${inner.blocked ? ` — ${inner.reason}` : ""}`,
    };
  }
  if (g[0] === 0x0064 && g[1] === 0xff9b) {
    const inner = classifyIp(embedded);
    return {
      blocked: true,
      family: 6,
      reason: `a NAT64 address carrying ${embedded}${inner.blocked ? ` — ${inner.reason}` : ""}`,
    };
  }
  // 6to4 and Teredo both encode a v4 address inside the v6 one; rather than decode
  // each layout, both are refused outright. Neither hosts a project's website.
  if (g[0] === 0x2002) return { blocked: true, family: 6, reason: "a 6to4 address, which encodes an IPv4 address inside it" };
  if (g[0] === 0x2001 && g[1] === 0x0000) return { blocked: true, family: 6, reason: "a Teredo address, which encodes an IPv4 address inside it" };
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) {
    return { blocked: true, family: 6, reason: "the IPv6 discard-only range 100::/64" };
  }
  if (g[0] === 0x2001 && g[1] === 0x0db8) return { blocked: true, family: 6, reason: "the IPv6 documentation range" };
  if ((g[0] & 0xfe00) === 0xfc00) return { blocked: true, family: 6, reason: "a unique-local IPv6 range (fc00::/7) — the IPv6 equivalent of a private range" };
  if ((g[0] & 0xffc0) === 0xfe80) return { blocked: true, family: 6, reason: "an IPv6 link-local range (fe80::/10)" };
  if ((g[0] & 0xff00) === 0xff00) return { blocked: true, family: 6, reason: "an IPv6 multicast range" };
  if ((g[0] & 0xfff0) === 0x2010) return { blocked: true, family: 6, reason: "the ORCHID range" };

  return { blocked: false, family: 6, reason: null };
}

/* ------------------------------ URL validation ------------------------------ */

/**
 * WHETHER A URL MAY BE FETCHED AT ALL, from its text alone and before any DNS.
 *
 * PURE, so every refusal sentence is testable with no network. Called on the
 * caller's URL and again, from scratch, on every redirect target — see safeFetch.
 *
 * `refusal` IS THE OUTPUT. A boolean that a page could not be fetched is useless
 * to a reader deciding what a diligence report means, and worse than useless to
 * whoever has to debug it: "the URL's host is a bare IP address" and "the host
 * resolved into a private range" are different facts about a project. So every
 * branch names the rule it broke, in a sentence.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, url: URL, host: string } | { ok: false, code: string, refusal: string }}
 */
export function validateUrl(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { ok: false, code: "empty", refusal: "No URL was supplied, so nothing was fetched." };
  if (text.length > SAFE_FETCH_LIMITS.MAX_URL_CHARS) {
    return {
      ok: false,
      code: "too_long",
      refusal: `That URL is ${text.length} characters, past the ${SAFE_FETCH_LIMITS.MAX_URL_CHARS}-character cap, so it was not fetched.`,
    };
  }
  // Control, zero-width and bidi characters in a URL are either an encoding trick
  // or a copy-paste accident, and both are refused rather than silently stripped:
  // a URL this server rewrote is not the URL anyone asked for.
  if (URL_JUNK_RE.test(text)) {
    return {
      ok: false,
      code: "bad_characters",
      refusal: "That URL contains whitespace, control or invisible characters, so it was not fetched — a URL is taken exactly as given and never rewritten.",
    };
  }

  let url = null;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, code: "unparseable", refusal: "That is not a URL this server can parse, so nothing was fetched." };
  }

  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    return {
      ok: false,
      code: "scheme",
      refusal: `Only http and https URLs are fetched, and that one is "${scheme}". A file:, data:, gopher:, ftp: or ipfs: URL is refused outright.`,
    };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      code: "credentials",
      refusal: "That URL carries credentials before the host (user:pass@host), which is refused: this server never sends credentials to a third party, and the form is also used to disguise the real host.",
    };
  }
  if (!SAFE_FETCH_LIMITS.ALLOWED_PORTS.includes(url.port)) {
    return {
      ok: false,
      code: "port",
      refusal: `That URL asks for port ${url.port}, and only the default ports 80 and 443 are fetched. A project's public website is on one of those; other ports are how an internal service gets reached.`,
    };
  }

  // A trailing dot is a legal absolute FQDN and must not be a way past the
  // suffix checks below.
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, code: "no_host", refusal: "That URL has no host, so nothing was fetched." };

  if (isIP(host) || host.startsWith("[") || v4ToInt(host) !== null) {
    const cls = classifyIp(host);
    return {
      ok: false,
      code: "ip_literal",
      refusal: `That URL's host is a bare IP address (${host}${cls.reason ? `, ${cls.reason}` : ""}) rather than a domain name. A project's website has a name; an IP literal is refused whatever it points at.`,
    };
  }
  if (INTERNAL_NAMES.includes(host)) {
    return { ok: false, code: "internal_name", refusal: `"${host}" names something on this server or inside its network, not a website, so it was not fetched.` };
  }
  for (const suffix of INTERNAL_SUFFIXES) {
    if (host.endsWith(suffix)) {
      return {
        ok: false,
        code: "internal_suffix",
        refusal: `That host ends in "${suffix}", which names something inside a network rather than on the internet — it is refused before any DNS lookup, because a name that should never be resolved should never be resolved.`,
      };
    }
  }
  if (!host.includes(".")) {
    return {
      ok: false,
      code: "single_label",
      refusal: `"${host}" is a single-label host with no dot, which on a server resolves through internal search domains rather than to a website. Refused.`,
    };
  }
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes("..")) {
    return { ok: false, code: "bad_host", refusal: `"${host}" is not a shape of hostname this server will resolve.` };
  }

  return { ok: true, url, host };
}

/* --------------------------------- resolution --------------------------------- */

/**
 * THE DNS-REBINDING FIX, and it is the whole reason this module does not use fetch.
 *
 * node:http hands the hostname to this function and then connects to whatever
 * addresses it returns — so the addresses that were validated ARE the addresses
 * that are connected to, with no second resolution in between for an attacker's
 * authoritative server to answer differently. A check-then-fetch design cannot
 * make that guarantee no matter how careful the check is.
 *
 * ANY BLOCKED ADDRESS FAILS THE WHOLE NAME, rather than being filtered out of the
 * list. A hostname that resolves to one public address and one private one is not
 * a website with an odd DNS record; it is the shape of a rebinding attack, and
 * connecting to the "good" half of it would be co-operating with the attempt.
 *
 * `record` is an out-parameter so the caller can report which addresses were seen
 * without resolving the name a second time — which would reintroduce exactly the
 * window this function exists to close.
 *
 * @param {{ record?: object, resolve?: Function }} [deps]
 * @returns {Function} a node:dns-shaped lookup callback
 */
export function guardedLookup(deps = {}) {
  const record = deps.record && typeof deps.record === "object" ? deps.record : null;
  const resolve = typeof deps.resolve === "function" ? deps.resolve : dnsLookup;

  return function lookup(hostname, options, callback) {
    const opts = options && typeof options === "object" ? options : {};
    resolve(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) {
        if (record) record.error = String(err?.code ?? err?.message ?? err);
        return callback(err);
      }
      const list = Array.isArray(addresses) ? addresses : addresses ? [addresses] : [];
      if (!list.length) {
        const e = new Error(`${hostname} resolved to no addresses`);
        e.code = "ENOTFOUND";
        if (record) record.error = "no addresses";
        return callback(e);
      }

      const seen = [];
      for (const entry of list) {
        const address = typeof entry === "string" ? entry : entry?.address;
        const family = typeof entry === "string" ? (isIP(entry) === 6 ? 6 : 4) : (entry?.family ?? isIP(String(address)) ?? 4);
        const cls = classifyIp(address);
        seen.push({ address: String(address), family: Number(family) || cls.family || 4, blocked: cls.blocked, reason: cls.reason });
      }
      if (record) {
        record.hostname = hostname;
        record.addresses = seen;
      }

      const bad = seen.find((a) => a.blocked);
      if (bad) {
        const e = new Error(
          `${hostname} resolves to ${bad.address}, which is ${bad.reason}. Refused before connecting${
            seen.length > 1 ? " — and the whole name is refused, not just that one address, because a name resolving to both a public and a private address is the shape of a DNS-rebinding attempt" : ""
          }.`,
        );
        e.code = "EBLOCKEDADDRESS";
        e.blockedAddress = bad.address;
        e.blockedReason = bad.reason;
        if (record) record.blocked = bad;
        return callback(e);
      }

      // Honour both callback shapes. net.connect passes `all: true` when it is
      // selecting a family itself (the Node 20+ default) and `all: false` when it
      // is not, and a lookup that answered only one of the two would break
      // whichever it did not answer.
      if (opts.all) return callback(null, seen.map((a) => ({ address: a.address, family: a.family })));
      const first = opts.family === 6 ? seen.find((a) => a.family === 6) : opts.family === 4 ? seen.find((a) => a.family === 4) : seen[0];
      if (!first) {
        const e = new Error(`${hostname} resolved to no address in the requested family`);
        e.code = "ENOTFOUND";
        return callback(e);
      }
      return callback(null, first.address, first.family);
    });
  };
}

/* ---------------------------------- the fetch ---------------------------------- */

/**
 * Content types whose bytes are decoded to text. Anything else is reported by type
 * and size and left undecoded — a PDF or an image run through a text decoder
 * produces mojibake that a language model will cheerfully summarise as if it were
 * the page.
 */
const TEXTUAL_RE = /^(?:text\/|application\/(?:json|xml|xhtml\+xml|javascript|ld\+json|(?:[a-z0-9.+-]+\+json)))/i;

/** One hop's worth of node:http, promisified, with the caps applied to the stream. */
function hop(url, { lookupFn, timeoutMs, maxBytes, userAgent, signalDeadline }) {
  return new Promise((resolve) => {
    const isHttps = url.protocol === "https:";
    const send = isHttps ? httpsRequest : httpRequest;
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let req = null;
    try {
      req = send(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: "GET",
          lookup: lookupFn,
          // NOT `redirect: follow` by any other name: node:http never follows a
          // redirect, which is the point — the caller re-validates each target.
          headers: {
            host: url.host,
            "user-agent": userAgent,
            accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5",
            // IDENTITY ON PURPOSE. A gzip stream's decompressed size is not its
            // wire size, so a byte cap applied to compressed bytes is not a byte
            // cap at all — a few hundred KB of zip bomb becomes gigabytes of heap.
            "accept-encoding": "identity",
            connection: "close",
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = [];
          let size = 0;
          let truncated = false;

          // The declared length is checked before a byte is read, so an oversized
          // response costs one round trip rather than the whole cap.
          const declared = Number(res.headers["content-length"]);
          if (Number.isFinite(declared) && declared > maxBytes * 4) {
            res.destroy();
            return done({
              ok: false,
              code: "too_large",
              refusal: `That URL declared a ${declared}-byte response, far past the ${maxBytes}-byte cap, so it was not read.`,
            });
          }

          res.on("data", (c) => {
            if (size >= maxBytes) return;
            size += c.length;
            chunks.push(c);
            if (size >= maxBytes) {
              truncated = true;
              res.destroy();
            }
          });
          res.on("end", () => finish());
          res.on("close", () => finish());
          res.on("error", () => finish());

          let finished = false;
          function finish() {
            if (finished) return;
            finished = true;
            const buf = Buffer.concat(chunks).subarray(0, maxBytes);
            done({
              ok: true,
              status: res.statusCode ?? 0,
              headers: res.headers,
              location: typeof res.headers.location === "string" ? res.headers.location : null,
              bytes: buf.length,
              truncated,
              buffer: buf,
              remoteAddress: res.socket?.remoteAddress ?? null,
            });
          }
        },
      );
    } catch (e) {
      return done({ ok: false, code: "request_failed", refusal: `The request to ${url.host} could not be started: ${String(e?.message ?? e).slice(0, 160)}.` });
    }

    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (e) => {
      // A refusal from guardedLookup arrives here as a socket error, and it is the
      // one error whose text is worth surfacing verbatim: it names the address and
      // the range, which is exactly what a reader needs.
      if (e?.code === "EBLOCKEDADDRESS") {
        return done({ ok: false, code: "blocked_address", refusal: String(e.message) });
      }
      done({ ok: false, ...describeSocketError(url.host, e) });
    });

    // The overall deadline, shared across hops: whichever hop is in flight when it
    // fires is torn down, and safeFetch reports the whole fetch as timed out.
    const remaining = signalDeadline - Date.now();
    const timer = setTimeout(() => req.destroy(new Error("timeout")), Math.max(1, remaining));
    req.on("close", () => clearTimeout(timer));
    req.end();
  });
}

/**
 * OpenSSL's verification failures, told apart, because they are different facts about
 * a site and exactly ONE of them is fixable by reading the page a different way.
 *
 * MEASURED, AND THE MEASUREMENT IS THE POINT. https://www.ponsfamily.com/ intermittently
 * refuses this fetcher with UNABLE_TO_GET_ISSUER_CERT_LOCALLY while loading perfectly in
 * a browser, and https://incomplete-chain.badssl.com/ does it every time. That is not a
 * broken site and it is not a broken fetcher: it is a server sending an INCOMPLETE CHAIN.
 * A certificate names its issuer and carries an "Authority Information Access" pointer to
 * where that issuer's certificate can be downloaded; a browser follows that pointer and
 * completes the path itself (AIA chasing), and Node does not — it verifies only what the
 * peer actually sent. So the same server is trusted by Chrome and refused here.
 *
 * WHY THIS IS A SEPARATE CODE AND NOT JUST BETTER PROSE. "The site could not be reached"
 * is what this used to say, and it made an INCOMPLETE CHAIN — which the render service
 * fixes, because Chromium does chase AIA — indistinguishable from an EXPIRED certificate,
 * which nothing fixes and which is a real finding about a site. A caller that wants to
 * know "should I retry this through the browser?" needs the difference, and `chainFixable`
 * is that answer in a boolean beside the sentence.
 *
 * WHAT IS NOT DONE HERE, and must not be: verification is never disabled. Turning off
 * `rejectUnauthorized` to make these go away would trade a broken read for a silent
 * man-in-the-middle, and every observation this fetcher produced would stop being
 * attributable to the site it names.
 */
const TLS_FAILURES = Object.freeze({
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: {
    chainFixable: true,
    why: "sent an INCOMPLETE CERTIFICATE CHAIN — it omitted an intermediate certificate, so the path to a trusted root could not be built from what it sent. Browsers paper over this by downloading the missing certificate themselves (AIA chasing) and Node does not, which is why such a site loads in Chrome and is refused here. This is a server misconfiguration, NOT a finding that the site is unsafe",
  },
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: {
    chainFixable: true,
    why: "sent a certificate whose issuer was not included with it, so the chain could not be verified. That is an incomplete chain: browsers download the missing certificate themselves (AIA chasing) and Node does not. A server misconfiguration, NOT a finding that the site is unsafe",
  },
  UNABLE_TO_GET_ISSUER_CERT: { chainFixable: true, why: "sent a certificate chain that could not be completed to a trusted root from what it sent — an incomplete chain" },
  CERT_HAS_EXPIRED: { chainFixable: false, why: "presented an EXPIRED certificate. That is a real fact about the site's operation, and reading it a different way will not change it" },
  CERT_NOT_YET_VALID: { chainFixable: false, why: "presented a certificate that is not valid yet" },
  ERR_TLS_CERT_ALTNAME_INVALID: { chainFixable: false, why: "presented a certificate that does not cover this host name" },
  DEPTH_ZERO_SELF_SIGNED_CERT: { chainFixable: false, why: "presented a SELF-SIGNED certificate, which no trust store vouches for" },
  SELF_SIGNED_CERT_IN_CHAIN: { chainFixable: false, why: "presented a chain ending in a root that no public trust store contains" },
  CERT_REVOKED: { chainFixable: false, why: "presented a REVOKED certificate" },
});

/**
 * WHY A SOCKET FAILED, as a sentence a reader can act on.
 *
 * PURE and exported so every branch is testable with no network — which matters most for
 * the TLS branches, because reproducing a genuinely incomplete chain on demand means
 * depending on somebody else's misconfigured server staying misconfigured.
 *
 * @param {string} host
 * @param {{ code?: string, message?: string }} err
 * @returns {{ code: string, refusal: string, chainFixable?: boolean }}
 */
export function describeSocketError(host, err) {
  const name = String(host ?? "the host");
  const code = String(err?.code ?? "");
  const tls = Object.hasOwn(TLS_FAILURES, code) ? TLS_FAILURES[code] : null;

  if (tls) {
    return {
      code: "tls",
      tlsCode: code,
      chainFixable: tls.chainFixable,
      refusal: `${name}'s TLS certificate did not verify: the server ${tls.why} (${code}). VERIFICATION WAS NOT DISABLED AND WILL NOT BE — a page read over a connection that did not verify could not honestly be attributed to the site it names.${
        tls.chainFixable ? " A browser-based read of this URL would very likely succeed, because a browser completes the chain itself." : ""
      } This is a failure to READ the site, not a finding that the site is down or does not exist.`,
    };
  }
  if (code === "ENOTFOUND") {
    return { code: "dns", refusal: `${name} does not resolve. That is a failure to READ the site, not a finding that the site is down or does not exist.` };
  }
  if (code === "ETIMEDOUT" || err?.message === "timeout") {
    return { code: "network", refusal: `${name} did not answer in time. That is a failure to READ the site, not a finding that the site is down or does not exist.` };
  }
  return {
    code: "network",
    refusal: `${name} could not be reached (${code || String(err?.message ?? err).slice(0, 80)}). That is a failure to READ the site, not a finding that the site is down or does not exist.`,
  };
}

/**
 * The user-agent this server identifies itself as. Honest and contactable on
 * purpose: a diligence tool that fetched a third party's page while pretending to
 * be a browser would be indistinguishable from the scrapers that site operators
 * block, and this one wants to be identifiable so it can be blocked if unwanted.
 */
export function userAgent() {
  const override = process.env.SAFE_FETCH_USER_AGENT?.trim();
  if (override) return override.slice(0, 120);
  return "ChainMindBot/1.0 (+https://chainmind.fun; automated on-demand diligence read, one page per request)";
}

/**
 * FETCH ONE URL, SAFELY, AND SAY WHAT HAPPENED.
 *
 * Returns a flat record rather than a Response, because everything downstream of
 * this needs the provenance as much as the bytes: which URL was asked for, which
 * URL actually answered after redirects, what addresses it resolved to, whether
 * the body was cut off at the cap. A diligence finding that cites "the site" has
 * to be able to say WHICH site answered, and after a redirect chain those are not
 * the same string.
 *
 * @param {unknown} rawUrl
 * @param {{ timeoutMs?: number, maxBytes?: number, maxRedirects?: number,
 *   lookup?: Function, resolve?: Function, now?: () => number }} [options]
 * @returns {Promise<object>} `{ ok: true, ... }` or `{ ok: false, refusal, code }`
 */
export async function safeFetch(rawUrl, options = {}) {
  const first = validateUrl(rawUrl);
  if (!first.ok) return { ok: false, fetched: false, code: first.code, refusal: first.refusal, url: typeof rawUrl === "string" ? rawUrl.slice(0, 200) : null };

  const timeoutMs = clampTimeout(Number.isFinite(options.timeoutMs) ? options.timeoutMs : SAFE_FETCH_LIMITS.TIMEOUT_MS);
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? Math.min(options.maxBytes, SAFE_FETCH_LIMITS.MAX_BYTES) : SAFE_FETCH_LIMITS.MAX_BYTES;
  const maxRedirects = Number.isFinite(options.maxRedirects) && options.maxRedirects >= 0 ? Math.min(options.maxRedirects, SAFE_FETCH_LIMITS.MAX_REDIRECTS) : SAFE_FETCH_LIMITS.MAX_REDIRECTS;
  const clock = typeof options.now === "function" ? options.now : Date.now;
  const startedAt = clock();
  const signalDeadline = Date.now() + timeoutMs;

  const record = {};
  const lookupFn = typeof options.lookup === "function" ? options.lookup : guardedLookup({ record, resolve: options.resolve });

  /**
   * The transport seam, and it exists because the SSRF controls make this module
   * untestable any other way.
   *
   * A test cannot stand up a local server and point safeFetch at it: `localhost`,
   * `127.0.0.1` and every non-default port are refused by validateUrl, which is the
   * whole point of validateUrl. So the redirect ladder — the part where a public
   * host answers 302 Location: http://169.254.169.254/ and must be refused — has no
   * offline test unless the wire is injectable. Injecting it leaves every check in
   * safeFetch and guardedLookup in the path being tested; only the socket is faked.
   */
  const transport = typeof options.transport === "function" ? options.transport : hop;
  const chain = [];
  let url = first.url;
  let hops = 0;

  for (;;) {
    const res = await transport(url, { lookupFn, timeoutMs, maxBytes, userAgent: userAgent(), signalDeadline });
    if (!res.ok) {
      return {
        ok: false,
        fetched: false,
        code: res.code,
        refusal: res.refusal,
        // Carried up rather than left in the hop, because the caller's decision — retry
        // this URL through the render service, or report a real certificate problem —
        // turns on exactly these two fields. See describeSocketError.
        tlsCode: res.tlsCode ?? null,
        chainFixable: res.chainFixable ?? false,
        url: String(url),
        redirects: chain,
        resolved: record.addresses ?? null,
        elapsedMs: clock() - startedAt,
      };
    }

    const isRedirect = res.status >= 300 && res.status < 400 && res.location;
    if (!isRedirect) {
      const contentType = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase() || null;
      const textual = contentType ? TEXTUAL_RE.test(contentType) : false;
      return {
        ok: true,
        fetched: true,
        status: res.status,
        // BOTH URLS TRAVEL. A finding about a page must be able to name the page
        // that answered, and after a redirect that is not the URL anyone asked for.
        requestedUrl: String(first.url),
        finalUrl: String(url),
        redirects: chain,
        redirectCount: hops,
        contentType,
        headers: pickHeaders(res.headers),
        bytes: res.bytes,
        truncated: res.truncated,
        truncationNote: res.truncated
          ? `Only the first ${res.bytes} bytes of this response were read (the cap), so anything below that point in the page was NOT examined — unread, not absent.`
          : null,
        body: textual ? new TextDecoder("utf-8", { fatal: false }).decode(res.buffer) : null,
        bodyDecoded: textual,
        bodyNote: textual
          ? null
          : `The response is ${contentType ?? "of an unstated type"}, which is not text, so its bytes were NOT decoded or examined. Its size and type are all that is known about it.`,
        resolvedAddresses: record.addresses ?? null,
        remoteAddress: res.remoteAddress ?? null,
        elapsedMs: clock() - startedAt,
      };
    }

    if (hops >= maxRedirects) {
      return {
        ok: false,
        fetched: false,
        code: "redirect_cap",
        refusal: `That URL redirected more than ${maxRedirects} times, so the chain was abandoned. The hops that were followed are listed.`,
        url: String(url),
        redirects: chain,
        elapsedMs: clock() - startedAt,
      };
    }

    let next = null;
    try {
      next = new URL(res.location, url);
    } catch {
      return {
        ok: false,
        fetched: false,
        code: "bad_redirect",
        refusal: `${url.host} answered ${res.status} with a Location header this server cannot parse, so the redirect was not followed.`,
        url: String(url),
        redirects: chain,
        elapsedMs: clock() - startedAt,
      };
    }

    /**
     * THE WHOLE LADDER AGAIN, FROM THE TOP, ON THE REDIRECT TARGET.
     *
     * This is the check the interesting attack is aimed at: a perfectly ordinary
     * public host that answers 302 Location: http://169.254.169.254/latest/. The
     * target gets validateUrl (scheme, credentials, IP literal, internal suffix,
     * port) and then its own guardedLookup resolution on connect, so a redirect
     * into a blocked range ends the fetch with a refusal naming the range rather
     * than being followed.
     */
    const check = validateUrl(String(next));
    if (!check.ok) {
      chain.push({ from: String(url), status: res.status, to: String(next).slice(0, 200), followed: false });
      return {
        ok: false,
        fetched: false,
        code: "blocked_redirect",
        refusal: `${url.host} answered ${res.status} and tried to send this server to ${String(next).slice(0, 160)}, which was refused: ${check.refusal}`,
        url: String(url),
        redirects: chain,
        elapsedMs: clock() - startedAt,
      };
    }

    chain.push({ from: String(url), status: res.status, to: String(next), followed: true });
    url = check.url;
    hops += 1;
  }
}

/**
 * The response headers worth keeping, and only those.
 *
 * A whole header bag is both a size problem in an evidence blob and a place for a
 * hostile server to put text aimed at whatever reads it. These are the ones that
 * answer "whose infrastructure is this sitting on" — the question the reference
 * analysis turned on — plus the two dates.
 */
function pickHeaders(headers) {
  const keep = [
    "server",
    "x-powered-by",
    "via",
    "cf-ray",
    "x-vercel-id",
    "x-vercel-cache",
    "x-amz-cf-id",
    "x-github-request-id",
    "x-nf-request-id",
    "x-served-by",
    "x-cache",
    "content-type",
    "content-length",
    "date",
    "last-modified",
    "age",
    "x-robots-tag",
  ];
  const out = {};
  for (const k of keep) {
    const v = headers?.[k];
    if (typeof v === "string" && v) out[k] = v.replace(HEADER_JUNK_RE, " ").slice(0, 200);
  }
  return out;
}
