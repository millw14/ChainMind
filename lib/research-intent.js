/**
 * DOES THIS QUESTION WANT AN INVESTIGATION RATHER THAN AN ANSWER?
 *
 * WHY THE QUESTION IS WORTH ASKING AT ALL. "Is this a larp", "check this project out
 * properly", "full diligence on X" are all asking for the thing lib/site-analysis.js
 * structurally cannot do: one page, one pass, inside 24 seconds, with no way to decide
 * what to look at next. Answering them inside the request is answering a different, much
 * smaller question and not saying so. Starting a job is the honest move — the chain half
 * arrives now, the web half arrives in minutes, and the reply says which is which.
 *
 * THIS MODULE IS PURE: string analysis only, no network, no store, no imports from the
 * client or the gate. Same discipline as lib/ask-intent.js and for the same reasons — it
 * runs on every question, it must be unit-testable with nothing running, and a router
 * that can fail is a router that fails a question.
 *
 * TWO STRENGTHS, BECAUSE A FALSE POSITIVE COSTS A DAILY ALLOWANCE.
 *   STRONG   — the words name the act: "deep dive", "due diligence", "investigate this
 *              properly", "full audit". These start a job against a URL or an address.
 *   WEAK     — the words name the WORRY: "is this a larp", "is this legit", "what's the
 *              deal with this". These are the ordinary project_profile questions the
 *              product already answers on chain in seconds, so they only reach for a job
 *              when a URL is present, which is the one thing the chain half cannot read.
 *
 * AND THE HARD LIMIT THAT IS NOT NEGOTIABLE: A NAME IS NOT A SUBJECT. A ticker, a project
 * name or "that dog coin" never becomes a target here, however strongly the question is
 * worded. Nothing in this product finds a website by searching for a name, because
 * reporting on a business that merely shares a name with a token would be a claim about
 * the wrong people. A strong request with no URL and no address comes back `wanted` with
 * `subject: null` and a sentence saying exactly that.
 */

/** The strength of the request, when there is one. */
export const RESEARCH_WANT = Object.freeze({
  NONE: "none",
  WEAK: "weak",
  STRONG: "strong",
});

/**
 * The words that name the act itself. Deliberately narrow: every phrase here is one
 * somebody types when they want more than a paragraph back.
 */
const STRONG_RE =
  /\b(?:deep\s*(?:dive|dived|diving|research)|due\s+diligence|full\s+diligence|proper\s+diligence|diligence\s+on|investigate|investigation|investigating|research\s+(?:this|it|them|that)|dig\s+(?:in|into|deeper)|(?:look|looked|looking)\s+into\s+(?:this|it|them|that)|full\s+audit|background\s+check|thorough(?:ly)?\s*(?:check|review|look)?|properly\s+(?:check|research|investigate|look)|(?:check|look\s+at|review)\s+(?:this|it|them|that|out)?\s*(?:project|site|website|thing)?\s*(?:out\s+)?properly)\b/gi;

/**
 * The words that name the worry. These are the phrasings lib/ask-intent.js already routes
 * to project_profile, and they stay there — this only adds a WEB investigation beside the
 * chain answer, and only when there is a URL for it to read.
 */
const WEAK_RE =
  /\b(?:is\s+(?:this|it)\s+(?:a\s+)?(?:larp|larping|real|legit|legitimate|fake|genuine)|is\s+this\s+project\s+(?:real|legit|legitimate|fake)|what(?:'s|s|\s+is)\s+the\s+deal\s+with|should\s+i\s+trust|can\s+i\s+trust|vet\s+(?:this|it|them))\b/gi;

/**
 * A URL as people actually type one: with a scheme, or as a bare host.
 *
 * The bare-host form is not optional — "check csl.fun out properly" is the normal way a
 * URL arrives in a chat message — and it is the risky one, so it is bounded: a dotted
 * host, an alphabetic TLD, no spaces, and the extension deny-list below.
 */
const SCHEME_URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
const BARE_HOST_RE = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(\/[^\s<>"'`)\]]*)?/gi;

/**
 * Last labels that mean a FILE, not a host. "src/chain.js" and "README.md" both match the
 * bare-host shape exactly, and turning a filename in a question into an https:// target
 * would send this app off to fetch a domain nobody named.
 */
const NOT_A_TLD = new Set([
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "json", "md", "txt", "html", "htm", "css", "scss",
  "py", "rb", "go", "rs", "sol", "java", "php", "yml", "yaml", "toml", "lock", "env",
  "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "pdf", "zip", "tar", "gz", "csv", "xml",
  "sh", "bat", "exe", "dll", "log", "sql", "eth",
]);

const ADDRESS_RE = /(?:^|[^0-9a-fA-F])(0x[0-9a-fA-F]{40})(?![0-9a-fA-F])/g;

/**
 * Every URL and address in a piece of text, in the order they were typed.
 *
 * Returns CANDIDATES and nothing more. Whether any of them may actually be fetched is
 * lib/safe-fetch.js's question, asked by lib/research-client.js screenSubject — this
 * module never decides that, because there must be exactly one place that does.
 *
 * @param {unknown} text
 * @returns {Array<{ value: string, kind: "url"|"address" }>}
 */
export function extractSubjectCandidates(text) {
  const s = typeof text === "string" ? text : "";
  if (!s) return [];

  const out = [];
  const seen = new Set();
  const push = (value, kind) => {
    const key = `${kind}:${value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ value, kind });
  };

  for (const m of s.matchAll(SCHEME_URL_RE)) push(trimTrailing(m[0]), "url");
  for (const m of s.matchAll(ADDRESS_RE)) push(m[1], "address");

  for (const m of s.matchAll(BARE_HOST_RE)) {
    // Anything already inside a scheme URL was captured above; matching it again would
    // add the host on its own as a second, weaker candidate for the same site.
    if (out.some((c) => c.kind === "url" && c.value.toLowerCase().includes(m[1].toLowerCase()))) continue;
    const tld = m[1].slice(m[1].lastIndexOf(".") + 1).toLowerCase();
    if (NOT_A_TLD.has(tld)) continue;
    push(`https://${trimTrailing(m[0])}`, "url");
  }

  return out;
}

/**
 * DOES THIS QUESTION WANT A DEEP INVESTIGATION, AND OF WHAT?
 *
 * Pure and total: any input type, no throw.
 *
 * @param {unknown} question
 * @param {{ target?: unknown }} [options] the `target` field of the ask request, which is
 *   a subject the user named as deliberately as anything in the question text
 * @returns {{ want: string, wanted: boolean, matched: string[], subject: {given: string,
 *   kind: string}|null, refusal: string|null }}
 */
export function detectResearchRequest(question, options = {}) {
  const q = typeof question === "string" ? question : "";
  const strong = matches(q, STRONG_RE);
  const weak = matches(q, WEAK_RE);

  // The explicit `target` field first: a subject the user put in its own box is at least
  // as deliberate as one they typed mid-sentence.
  const targetCandidates = extractSubjectCandidates(typeof options.target === "string" ? options.target : "");
  const candidates = [...targetCandidates, ...extractSubjectCandidates(q)];
  const url = candidates.find((c) => c.kind === "url") ?? null;
  const address = candidates.find((c) => c.kind === "address") ?? null;

  if (!strong.length && !weak.length) {
    return { want: RESEARCH_WANT.NONE, wanted: false, matched: [], subject: null, refusal: null };
  }

  // A WEAK request with no URL is an ordinary project question. The chain half answers it
  // in seconds and a job would add minutes and spend an allowance for nothing.
  if (!strong.length && !url) {
    return { want: RESEARCH_WANT.NONE, wanted: false, matched: weak, subject: null, refusal: null };
  }

  const want = strong.length ? RESEARCH_WANT.STRONG : RESEARCH_WANT.WEAK;
  const matched = [...strong, ...weak];

  // A URL beats an address: the web investigation is the half being asked for, and the
  // chain half of the answer is already being produced by the ordinary lookup path.
  const chosen = url ?? address;
  if (!chosen) {
    return {
      want,
      wanted: true,
      matched,
      subject: null,
      refusal:
        "A deep investigation needs a URL or a 0x contract address. It will not go looking for a project's website by name — a business that merely shares a name with a token is a different party, and reporting on them would be reporting on the wrong people.",
    };
  }

  return { want, wanted: true, matched, subject: { given: chosen.value, kind: chosen.kind }, refusal: null };
}

/* --------------------------------- internals -------------------------------- */

/** Every distinct phrase a global pattern matched, lowercased and flattened. */
function matches(s, re) {
  const out = new Set();
  for (const m of s.matchAll(re)) {
    const w = m[0].trim().replace(/\s+/g, " ").toLowerCase();
    if (w) out.add(w);
  }
  return [...out];
}

/** Sentence punctuation is not part of a URL: "look at csl.fun." ends in a full stop. */
function trimTrailing(value) {
  return String(value).replace(/[.,;:!?'"“”’)\]}>]+$/, "");
}
