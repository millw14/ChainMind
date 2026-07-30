import { validateUrl } from "../../../lib/safe-fetch.js";
import { findDirectives, stripJunk } from "../../../lib/site-analysis.js";

/**
 * THE BOUNDARY — what this loop is allowed to look at, where each target came from, and
 * everything it declined to follow and why.
 *
 * THIS IS THE MODULE THE WHOLE FEATURE TURNS ON, and the reason is that the risk changed
 * shape when the analysis became a LOOP. In a single bounded pass a hostile page could only
 * LIE TO THE READER. In a loop, page content DECIDES WHAT HAPPENS NEXT: "full audit at
 * https://…", "our repo is github.com/…", "see /api/proof" are all things a page can say,
 * and a loop that reads them and follows them has handed the investigated party the
 * steering wheel of its own investigation. Everything below is one of four rules.
 *
 * RULE 1 — EVERYTHING DISCOVERED IN CONTENT IS RE-SCREENED, EXACTLY AS IF A USER HAD
 * PASTED IT. There is no "we already trust this origin" shortcut and no second, weaker
 * screen: `propose` runs lib/safe-fetch.js validateUrl, the same ladder that was
 * adversarially tested against a 56-URL battery, DNS rebinding, redirect ladders and a
 * hostile origin on 127.0.0.1:80. Redirects are re-validated by safeFetch itself on every
 * hop, and a redirect that lands on a NEW host is recorded here as a discovered target so
 * the wander cap sees it too.
 *
 * RULE 2 — PROVENANCE TRAVELS WITH EVERY TARGET, ALL THE WAY INTO THE REPORT. "The user
 * gave us this URL", "the launch transaction on chain declared it", "we found it written
 * on a page we were reading" and "the model proposed it" are four different strengths of
 * evidence, and the third and fourth are materially weaker than the first two. A report
 * that cited a finding from a page without saying HOW that page was reached would let the
 * investigated party choose its own corroboration.
 *
 * RULE 3 — CONTENT ADDS CANDIDATES, NEVER RULES. A target found in content enters a queue
 * and is screened. It cannot change a cap, disable robots.txt, add a header, widen the
 * allowed ports or authorise a host. There is no parameter anywhere in this service by
 * which fetched text could do any of those things — the tools simply have no such
 * argument. IMPERATIVE TEXT IN A PAGE IS A FINDING, NEVER AN INSTRUCTION.
 *
 * RULE 4 — THE LOOP MAY NOT WANDER FAR FROM WHAT THE USER ASKED ABOUT, and it says what it
 * declined. Three mechanisms, and they are deliberately different from one another:
 *
 *   a. AN INVENTED HOST IS REFUSED. The model may propose a PATH on a host the
 *      investigation has already legitimately reached — that is how `/api/vault` gets
 *      probed after the site named it — but it may NOT propose a host that appears nowhere
 *      in the evidence. A host the model produced from its own weights is a claim about
 *      the world dressed as a lookup, and following it would put a stranger's server in a
 *      report about somebody else.
 *   b. OFF-ANCHOR HOSTS ARE CAPPED. Hosts the user or the chain named are ANCHORS and are
 *      not counted. Everything else — a repository the site linked, an API on another
 *      domain — spends one of a small number of slots.
 *   c. DEPTH IS CAPPED. A target found on a page that was itself found on a page is at
 *      depth 2; past the cap the trail is not followed, and the report says where it
 *      stopped.
 *
 * AND THE STEERING RULE, which is rule 1 and rule 3 meeting. When the text that named a
 * target ALSO contained instructions addressed at an automated reviewer, following that
 * target is following the instruction. Such candidates are refused with `steering` and
 * reported — both the attempt and the refusal — because a page trying to route its own
 * audit is one of the more informative things a page can do.
 *
 * PURE apart from the clock. Never throws. Server-side only: no React.
 */

/**
 * HOW A TARGET CAME TO BE A TARGET. Ordered, and the order is the evidential strength.
 *
 * `strength` is carried into the report so a reader can weigh a finding by how its source
 * was reached, without having to reconstruct the chain themselves.
 */
export const PROVENANCE = Object.freeze({
  user_supplied: {
    strength: 4,
    label: "given by the user",
    reading: "This target is the one the person asking named. It is the strongest provenance available: nothing about the subject chose it.",
  },
  chain_declared: {
    strength: 4,
    label: "declared on chain in the launch transaction",
    reading:
      "This target was declared in the token's own launch calldata, which is a public, timestamped, immutable statement by whoever launched it. Strong provenance: the link between the subject and this target is on the chain rather than on a page that could have been written afterwards.",
  },
  found_in_content: {
    strength: 2,
    label: "found in content written by the party under examination",
    reading:
      "This target was found written inside a page or response served by the party under examination. MATERIALLY WEAKER than a user-supplied or chain-declared target: whoever wrote that page chose what it says, so the connection between the subject and this target is that party's own claim and nothing more. Anything found through it inherits that weakness.",
  },
  model_proposed: {
    strength: 1,
    label: "proposed by the model, on a site the investigation had already reached",
    reading:
      "No page named this exact address; the model proposed it as a likely path on — or subdomain of — a site the investigation had already legitimately reached (a conventional /health or /api/ route, a docs. subdomain). Whatever answered is real and is the subject's own output, but the DECISION to look there was the model's guess and nobody's statement. A site the model invented outright is refused rather than reaching this category.",
  },
  redirect: {
    strength: 2,
    label: "reached by a redirect from another target",
    reading:
      "This address was not asked for: another target redirected to it. It was re-screened through the whole SSRF ladder before it was followed, and it is reported separately because a report that cited only the URL that was asked for would name the wrong server.",
  },
});

/** The reasons a candidate is refused, and the sentence each one owes the reader. */
const DECLINE_READINGS = Object.freeze({
  steering:
    "REFUSED, AND THE ATTEMPT IS THE FINDING. The same text that named this target also carried instructions addressed at an automated reviewer. Following it would be obeying that instruction, so it was not followed. This is an observation about the page, not an accusation about anybody: the words are quoted in the machine-directed-text findings and the reader can weigh them.",
  invented_host:
    "REFUSED because no evidence anywhere in this investigation names this host. The model proposed it from its own knowledge, and a host produced that way is a claim about the world wearing the costume of a lookup — reporting on a server that nothing connected to the subject would be reporting on the wrong people.",
  wander_cap:
    "REFUSED by the wander cap: this investigation had already followed its allowance of hosts beyond the ones the user and the chain named. The trail is real and was not pursued; that is a limit of this run, NOT a finding that there was nothing there.",
  depth_cap:
    "REFUSED by the depth cap: this target was found on a page that was itself found on a page, past the number of hops this investigation follows. A limit of this run, not a finding.",
  host_requests:
    "REFUSED by the per-host request cap. This investigation had already made its allowance of requests to this host, and hammering a third party's server is not diligence. What was not requested is unread, not absent.",
  screen:
    "REFUSED by the URL screen, which every target passes through whoever named it — the user, the chain, a page, or the model.",
});

/** A URL reduced to the string two identical targets share, for de-duplication. */
function normalise(url) {
  try {
    const u = new URL(String(url));
    const host = u.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${u.protocol}//${host}${path}${u.search}`;
  } catch {
    return String(url ?? "").trim().toLowerCase();
  }
}

/** The registrable-ish host of a URL, lowercased, or null. Used for anchoring only. */
export function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

/**
 * Whether two hosts belong to the same site, crudely — last two labels, no public-suffix
 * list. Used ONLY to decide whether a host is anchored, never for a security decision:
 * every security decision here is validateUrl, which does not care whose site a URL is on.
 * The crudeness errs toward calling `api.example.com` and `example.com` the same site,
 * which is right for anchoring — a project's own API is not a wander.
 */
export function sameSite(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const tail = (h) => String(h).split(".").slice(-2).join(".");
  return tail(a) === tail(b);
}

/**
 * EVERY URL WRITTEN INSIDE A PIECE OF UNTRUSTED TEXT, with the steering flag attached.
 *
 * `steering` is set for EVERY candidate out of a text that contains directive-shaped
 * language anywhere in it, not only for the ones adjacent to it. That is deliberately
 * blunt: a page that is trying to steer its own review does not get to have the URL in the
 * clean paragraph followed and the one in the hidden div refused. The whole document is
 * the thing that is doing it.
 *
 * PURE.
 *
 * @param {unknown} text
 * @param {{ where?: string, max?: number }} [options]
 * @returns {{ urls: Array<{ url: string, steering: boolean }>, directives: Array<object> }}
 */
export function candidatesFromText(text, options = {}) {
  const raw = typeof text === "string" ? text : "";
  const max = Number.isFinite(options.max) && options.max > 0 ? options.max : 40;
  const directives = findDirectives(raw, { where: options.where ?? "third-party content" });
  const steering = directives.some((d) => d.kind === "directive");

  const seen = new Set();
  const urls = [];
  for (const m of raw.matchAll(/https?:\/\/[a-z0-9][a-z0-9._~:/?#[\]@!$&'()*+,;=%-]{3,400}/gi)) {
    // A URL at the end of a sentence collects the punctuation; trimming it here is the one
    // rewrite this file performs, and it is on the CANDIDATE rather than on a target — the
    // trimmed string still goes through the whole screen before anything touches it.
    const cleaned = stripJunk(m[0].replace(/[).,;:'"\]}>]+$/, ""));
    const key = normalise(cleaned);
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push({ url: cleaned, steering });
    if (urls.length >= max) break;
  }
  return { urls, directives };
}

/**
 * THE LEDGER OF TARGETS FOR ONE INVESTIGATION.
 *
 * Holds: the anchor hosts, every candidate ever proposed with its verdict, every refusal
 * with its reason, the per-host request budget, and the observed-in-content index that
 * decides a later proposal's provenance.
 *
 * @param {{ limits: object, now?: () => number }} input
 */
export function createTargetLedger({ limits, now = Date.now } = {}) {
  const maxDepth = numberOr(limits?.maxDepth, 2);
  const offAnchorCap = numberOr(limits?.offAnchorHosts, 3, true);
  const perHost = numberOr(limits?.perHostRequests, 20);
  const hostInterval = numberOr(limits?.hostIntervalMs, 800, true);

  /** Hosts the user or the chain named. Never counted against the wander cap. */
  const anchors = new Set();
  /** Hosts that have been reached at all — an invented host is one that is in neither. */
  const reachedHosts = new Set();
  /** Off-anchor hosts actually admitted, in order, capped. */
  const offAnchor = [];
  /** normalised url -> target record */
  const targets = new Map();
  /** normalised url -> { steering, depth, foundIn } for everything seen written in content */
  const observed = new Map();
  /** host -> { count, lastAt } */
  const hostState = new Map();
  const declined = [];

  function hostBudget(host) {
    let s = hostState.get(host);
    if (!s) {
      s = { count: 0, lastAt: 0 };
      hostState.set(host, s);
    }
    return s;
  }

  function isAnchored(host) {
    if (!host) return false;
    for (const a of anchors) if (sameSite(a, host)) return true;
    return false;
  }

  function refuse(candidate, code, detail) {
    const record = {
      url: typeof candidate?.url === "string" ? candidate.url.slice(0, 300) : String(candidate?.url ?? "").slice(0, 300),
      provenance: candidate?.provenance ?? "model_proposed",
      code,
      reason: detail ? `${DECLINE_READINGS[code] ?? "Refused."} ${detail}` : (DECLINE_READINGS[code] ?? "Refused."),
      at: now(),
    };
    declined.push(record);
    return { ok: false, declined: record };
  }

  return {
    /**
     * Register a host as an ANCHOR — a host the user named or the chain declared. Anchors
     * are exempt from the wander cap because they are the subject, not a detour.
     */
    anchor(url, provenance = "user_supplied") {
      const host = hostOf(url);
      if (!host) return null;
      anchors.add(host);
      reachedHosts.add(host);
      return { host, provenance };
    },

    anchorHosts() {
      return [...anchors];
    },

    /**
     * Index everything a piece of fetched content mentions, so that a LATER proposal of one
     * of those URLs is recognised as found-in-content rather than model-proposed.
     *
     * THE ORDERING IS THE POINT. The model never gets a "here are the links, pick one" API;
     * it reads the fenced text like a person and may then ask for a URL. This index is what
     * lets the ledger answer, honestly and after the fact, "was that written on the page, or
     * did you make it up?" — which is the difference between provenance `found_in_content`
     * and a refusal for an invented host.
     *
     * @returns {{ indexed: number, steering: boolean, directives: Array<object> }}
     */
    observe(text, { sourceUrl = null, sourceDepth = 0, where = "third-party content" } = {}) {
      const { urls, directives } = candidatesFromText(text, { where });
      for (const c of urls) {
        const key = normalise(c.url);
        const prior = observed.get(key);
        // A URL seen in two places keeps the WORST provenance it ever had: once it has
        // appeared inside steering text, it is a steered candidate wherever else it turns up.
        observed.set(key, {
          url: c.url,
          steering: c.steering || prior?.steering === true,
          depth: prior ? Math.min(prior.depth, sourceDepth + 1) : sourceDepth + 1,
          foundIn: prior?.foundIn ?? sourceUrl,
        });
      }
      return { indexed: urls.length, steering: directives.some((d) => d.kind === "directive"), directives };
    },

    /**
     * Register a set of links the CHAIN declared, so proposing one is chain-provenance.
     * These are anchors: a launch transaction naming a website makes that website part of
     * the subject rather than a detour from it.
     */
    declareFromChain(urls) {
      const out = [];
      for (const u of Array.isArray(urls) ? urls : []) {
        const url = typeof u === "string" ? u : u?.url;
        const key = normalise(url);
        if (!url || !key) continue;
        observed.set(key, { url, steering: false, depth: 0, foundIn: "the launch transaction on chain", chain: true });
        const host = hostOf(url);
        if (host) {
          anchors.add(host);
          out.push(host);
        }
      }
      return out;
    },

    /**
     * SCREEN ONE CANDIDATE AND EITHER ADMIT IT OR REFUSE IT IN WORDS.
     *
     * The whole boundary in one function, in the order the checks must happen: the URL
     * ladder first (a URL that is not fetchable is refused before any policy question about
     * it is asked), then steering, then the host rules, then depth, then the per-host
     * budget. Every refusal names the rule it broke.
     *
     * @param {unknown} rawUrl
     * @param {{ provenance?: string, why?: string }} [context]
     * @returns {{ ok: true, target: object } | { ok: false, declined: object }}
     */
    propose(rawUrl, context = {}) {
      const text = typeof rawUrl === "string" ? stripJunk(rawUrl).trim() : "";
      const key = normalise(text);
      const existing = targets.get(key);
      if (existing) return { ok: true, target: existing, repeat: true };

      // 1. THE SAME LADDER AS A URL A USER PASTED. No exemption for a URL we found
      //    ourselves: that is exactly the URL an attacker gets to choose.
      const screened = validateUrl(text);
      if (!screened.ok) {
        return refuse({ url: text, provenance: context.provenance }, "screen", screened.refusal);
      }
      const host = screened.host;

      // 2. WHERE DID THIS COME FROM. Decided from the evidence, not from what the caller
      //    claims: a model that asks for a URL cannot promote its own proposal to
      //    "chain-declared" by saying so, because this looks the URL up in the index.
      const seen = observed.get(key);
      let provenance = context.provenance ?? null;
      if (!provenance) {
        if (seen?.chain === true) provenance = "chain_declared";
        else if (seen) provenance = "found_in_content";
        else provenance = "model_proposed";
      }
      const depth = provenance === "user_supplied" || provenance === "chain_declared" ? 0 : (seen?.depth ?? 1);

      // 3. STEERING. The text that named it was also giving instructions to a reviewer.
      if (seen?.steering === true) {
        return refuse({ url: text, provenance }, "steering");
      }

      // 4. AN INVENTED HOST IS REFUSED. A path on — or a subdomain of — a site already
      //    reached is allowed, which is how a conventional /health, /api/config or a docs.
      //    subdomain gets probed. A host that appears nowhere in the evidence is the model
      //    asserting a fact about the world, and is refused. The `sameSite` test used here
      //    is the crude last-two-labels one ON PURPOSE: a project's own API and
      //    documentation subdomains are the subject, not a departure from it.
      const anchored = isAnchored(host);
      const known = anchored || reachedHosts.has(host) || [...reachedHosts].some((h) => sameSite(h, host));
      if (provenance === "model_proposed" && !known) {
        return refuse({ url: text, provenance }, "invented_host");
      }

      // 5. DEPTH, CHECKED BEFORE THE WANDER CAP. The order matters: admitting a host to the
      //    off-anchor list and THEN refusing the URL on depth would spend one of a small
      //    number of slots on a target that was never followed, and the next legitimate
      //    host would be refused for it.
      if (depth > maxDepth) {
        return refuse({ url: text, provenance }, "depth_cap", `This target is ${depth} hops from what the user asked about; the cap is ${maxDepth}.`);
      }

      // 6. THE WANDER CAP, on hosts rather than on URLs: reading twelve pages of the
      //    project's own site is not wandering, and reading one page each on twelve
      //    unrelated domains is.
      if (!anchored && !offAnchor.includes(host)) {
        if (offAnchor.length >= offAnchorCap) {
          return refuse({ url: text, provenance }, "wander_cap", `Hosts already followed beyond the anchors: ${offAnchor.join(", ") || "none"}.`);
        }
        offAnchor.push(host);
      }

      const target = {
        id: `t${targets.size + 1}`,
        url: String(screened.url),
        host,
        provenance,
        provenanceLabel: PROVENANCE[provenance]?.label ?? provenance,
        provenanceStrength: PROVENANCE[provenance]?.strength ?? 1,
        provenanceReading: PROVENANCE[provenance]?.reading ?? null,
        anchored,
        depth,
        foundIn: seen?.foundIn ?? context.why ?? null,
        proposedAt: now(),
        requests: 0,
        bytes: 0,
        outcomes: [],
      };
      targets.set(key, target);
      return { ok: true, target };
    },

    /**
     * WHETHER A REQUEST TO THIS HOST MAY GO OUT RIGHT NOW.
     *
     * Two separate limits with two separate answers, because they need two separate
     * behaviours: over the COUNT is a refusal (the investigation has read enough of this
     * server), under the INTERVAL is a wait (the request is fine, it is merely too soon).
     * Collapsing them would either hammer a host or refuse work that only needed a pause.
     *
     * @returns {{ ok: true, waitMs: number } | { ok: false, declined: object }}
     */
    mayRequest(url) {
      const host = hostOf(url);
      if (!host) return { ok: false, declined: refuse({ url }, "screen", "No host could be read from that URL.").declined };
      const s = hostBudget(host);
      if (s.count >= perHost) {
        return refuse({ url }, "host_requests", `${s.count} requests have already gone to ${host}, which is the cap.`);
      }
      const since = now() - s.lastAt;
      return { ok: true, waitMs: s.lastAt === 0 ? 0 : Math.max(0, hostInterval - since) };
    },

    /** Charge one request against a host, and record what it produced on the target. */
    noteRequest(url, { bytes = 0, outcome = null } = {}) {
      const host = hostOf(url);
      if (host) {
        const s = hostBudget(host);
        s.count += 1;
        s.lastAt = now();
        reachedHosts.add(host);
      }
      const t = targets.get(normalise(url));
      if (t) {
        t.requests += 1;
        t.bytes += Number.isFinite(bytes) ? bytes : 0;
        if (outcome) t.outcomes.push(String(outcome).slice(0, 120));
      }
    },

    /**
     * A REDIRECT LANDED SOMEWHERE ELSE, so that somewhere else is a target too.
     *
     * lib/safe-fetch.js already re-validated every hop through the whole ladder before
     * following it — this is not a second security check and must not be mistaken for one.
     * It exists so the REPORT names the server that actually answered, and so a redirect
     * onto a new host counts against the wander cap like any other discovered host rather
     * than being a free hop around it.
     */
    noteRedirect(fromUrl, finalUrl) {
      const from = hostOf(fromUrl);
      const to = hostOf(finalUrl);
      if (!to || (from && from === to)) return null;
      const key = normalise(finalUrl);
      if (targets.has(key)) return targets.get(key);
      observed.set(key, { url: finalUrl, steering: false, depth: 1, foundIn: `a redirect from ${fromUrl}` });
      const admitted = this.propose(finalUrl, { provenance: "redirect", why: `a redirect from ${fromUrl}` });
      return admitted.ok ? admitted.target : null;
    },

    /** Everything admitted, for the report's "what was looked at" section. */
    list() {
      return [...targets.values()].map((t) => ({ ...t }));
    },

    /** Everything refused, with the rule it broke. The report prints this in full. */
    declines() {
      return declined.map((d) => ({ ...d }));
    },

    /** The wander state, for the report's caps section. */
    wander() {
      return {
        anchorHosts: [...anchors],
        offAnchorHosts: [...offAnchor],
        offAnchorCap,
        maxDepth,
        perHostRequests: perHost,
        hostIntervalMs: hostInterval,
        hosts: [...hostState.entries()].map(([host, s]) => ({ host, requests: s.count })),
      };
    },
  };
}

function numberOr(value, fallback, allowZero = false) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return fallback;
  if (n === 0 && !allowZero) return fallback;
  return n;
}
