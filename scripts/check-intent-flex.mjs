#!/usr/bin/env node
/**
 * The baseline the tool path exists to beat.
 *
 * lib/ask-intent.js routes by regex and keyword list. This harness runs the
 * phrasings real users actually type through it and prints, case by case, what
 * the keyword router would have done with each one — nothing else. It makes no
 * model call, needs no GROQ_API_KEY, and touches no network, so the number it
 * prints is a fact about our own code rather than a benchmark of anyone's LLM.
 *
 * Two groups, kept separate on purpose:
 *
 *   MESSY     — sixteen phrasings of the kind people send: lowercase tickers,
 *               slang, typos, a bare company name, Spanish, "top 3". These are
 *               what the router was measured against and got wrong.
 *   CANONICAL — the ten shapes the keyword router was designed for. They are here
 *               so the baseline is honest: it is not that the router does nothing,
 *               it is that it only works when the question is already tidy.
 *
 * A case "routes" only if lib/ask-runner.js answerByKeywords would actually
 * answer it — which is stricter than classifyIntent returning something. The
 * sharpest example is "tsla vs nvda which is better": it classifies as a
 * comparison and extracts ZERO targets, because a bare ticker candidate has to be
 * uppercase to survive the stopword guard. The old route then returns "name at
 * least two things to compare". That is a miss, not a hit, and this harness
 * counts it as one.
 *
 * Exit code: 0 normally, even with failures — the failures are the point. It
 * exits 1 only if a case that used to route has STOPPED routing, which would be a
 * real regression in the keyword fallback.
 *
 * Run with: npm run flex:check
 */

import { INTENTS, classifyIntent, extractTargets } from "../lib/ask-intent.js";

/**
 * `want` is the route a correct router would pick, so a case that answers with
 * the wrong intent is not counted as a hit either. `routed` is what the keyword
 * router managed at the time of writing — the regression baseline.
 */
const CASES = [
  // ---- MESSY: what people type ----
  { group: "messy", q: "hows nvda doin", want: INTENTS.EXPLAIN_TARGET, routed: false },
  { group: "messy", q: "i wanna know about apple", want: INTENTS.EXPLAIN_TARGET, routed: false },
  { group: "messy", q: "nvda price", want: INTENTS.EXPLAIN_TARGET, routed: false },
  { group: "messy", q: "whos got the most bags", want: INTENTS.RANK_STOCKS, routed: false },
  { group: "messy", q: "show me whats poppin", want: INTENTS.MARKET_OVERVIEW, routed: false },
  { group: "messy", q: "any of these legit?", want: INTENTS.SAFETY_CHECK, routed: false },
  { group: "messy", q: "wut is robinhud chain", want: INTENTS.EXPLAIN_CHAIN, routed: false },
  { group: "messy", q: "que es nvda", want: INTENTS.EXPLAIN_TARGET, routed: false },
  { group: "messy", q: "how much apple", want: INTENTS.EXPLAIN_TARGET, routed: false },
  { group: "messy", q: "top 3", want: INTENTS.RANK_STOCKS, routed: false },
  { group: "messy", q: "nvidia", want: INTENTS.EXPLAIN_TARGET, routed: false },
  // Classifies as a comparison and extracts nothing — the worst kind of miss.
  { group: "messy", q: "tsla vs nvda which is better", want: INTENTS.COMPARE, routed: false },
  { group: "messy", q: "cual es mejor, tsla o nvda", want: INTENTS.COMPARE, routed: false },
  { group: "messy", q: "yo whats the deal with spy", want: INTENTS.EXPLAIN_TARGET, routed: false },
  { group: "messy", q: "tesla", want: INTENTS.EXPLAIN_TARGET, routed: false },
  { group: "messy", q: "nvdia", want: INTENTS.EXPLAIN_TARGET, routed: false },

  // ---- CANONICAL: what the keyword router was built for ----
  { group: "canonical", q: "NVDA", want: INTENTS.EXPLAIN_TARGET, routed: true },
  { group: "canonical", q: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", want: INTENTS.EXPLAIN_TARGET, routed: true },
  { group: "canonical", q: "what are the top 10 stocks by market cap", want: INTENTS.RANK_STOCKS, routed: true },
  { group: "canonical", q: "which stock has the most holders", want: INTENTS.RANK_STOCKS, routed: true },
  { group: "canonical", q: "cheapest ones", want: INTENTS.RANK_STOCKS, routed: true },
  { group: "canonical", q: "compare NVDA and TSLA", want: INTENTS.COMPARE, routed: true },
  { group: "canonical", q: "is 0x465834D5BA3af2169E49B70A139448e59e3CA492 legit", want: INTENTS.SAFETY_CHECK, routed: true },
  { group: "canonical", q: "is $nvda the real one", want: INTENTS.SAFETY_CHECK, routed: true },
  { group: "canonical", q: "what is trending", want: INTENTS.MARKET_OVERVIEW, routed: true },
  { group: "canonical", q: "what is Robinhood Chain", want: INTENTS.EXPLAIN_CHAIN, routed: true },
];

/**
 * What the keyword path would do with one phrasing, with no explicit target —
 * the same decisions lib/ask-runner.js answerByKeywords makes, in the same order.
 *
 * @param {string} question
 * @returns {{ intent: string, targets: string[], routes: boolean, why: string }}
 */
function keywordOutcome(question) {
  const t = extractTargets(question);
  const { intent } = classifyIntent(question, t);
  const targets = [...t.txs, ...t.addresses, ...t.symbols];
  const comparable = t.addresses.length + t.symbols.length;

  if (intent === INTENTS.UNKNOWN) {
    return { intent, targets, routes: false, why: "400 — couldn't tell what to look up" };
  }
  if (intent === INTENTS.COMPARE && comparable < 2) {
    return { intent, targets, routes: false, why: `400 — compare with ${comparable} target(s)` };
  }
  return { intent, targets, routes: true, why: "answers" };
}

/* ------------------------------ output ------------------------------ */

const COLUMNS = [
  { head: "phrasing", width: 50 },
  { head: "want", width: 16 },
  { head: "keyword router", width: 16 },
  { head: "targets found", width: 15 },
  { head: "outcome", width: 36 },
];

function cell(text, width) {
  const s = String(text);
  return (s.length > width ? `${s.slice(0, width - 1)}…` : s).padEnd(width);
}

function row(values) {
  return values.map((v, i) => cell(v, COLUMNS[i].width)).join(" ");
}

function rule() {
  return COLUMNS.map((c) => "-".repeat(c.width)).join(" ");
}

function section(title) {
  console.log(`\n${title}`);
  console.log(row(COLUMNS.map((c) => c.head)));
  console.log(rule());
}

/* ------------------------------ the run ------------------------------ */

const results = CASES.map((c) => ({ ...c, ...keywordOutcome(c.q) }));
// A hit means answered AND answered as the right kind of question.
const hit = (r) => r.routes && r.intent === r.want;

console.log("Keyword-router flexibility baseline — lib/ask-intent.js only.");
console.log("No model, no network, no API key. A case counts as routed only if the");
console.log("keyword path would actually answer it, with the right intent.");

for (const group of ["messy", "canonical"]) {
  const rows = results.filter((r) => r.group === group);
  section(
    group === "messy"
      ? "MESSY — how people actually ask"
      : "CANONICAL — the shapes the keyword router was designed for",
  );
  for (const r of rows) {
    const mark = hit(r) ? "PASS" : "FAIL";
    const why = hit(r) ? r.why : r.routes ? `wrong route — ${r.intent}` : r.why;
    console.log(row([`${mark}  ${r.q}`, r.want, r.intent, r.targets.join(", ") || "—", why]));
  }
  const passes = rows.filter(hit).length;
  console.log(`\n  ${group}: ${passes}/${rows.length} routed`);
}

const passes = results.filter(hit).length;
console.log(`\nTOTAL: ${passes}/${results.length} routed by the keyword router.`);
console.log(
  `Of the ${results.filter((r) => r.group === "messy").length} messy phrasings, ${
    results.filter((r) => r.group === "messy" && hit(r)).length
  } route. That is the gap the model-driven`,
);
console.log("tool path in lib/ask-tools.js and lib/ask-loop.js exists to close: the");
console.log("model reads the question and picks the tool, so no keyword list has to.");

// Regression check. Improvements are news, not failures — only a case that used
// to work and stopped is a problem.
const broke = results.filter((r) => r.routed && !hit(r));
const gained = results.filter((r) => !r.routed && hit(r));
if (gained.length) {
  console.log(`\nNEW: ${gained.length} case(s) now route that did not before: ${gained.map((r) => r.q).join("; ")}`);
  console.log("Update the `routed` baseline in this file to lock the improvement in.");
}
if (broke.length) {
  console.error(`\nREGRESSION: ${broke.length} case(s) stopped routing: ${broke.map((r) => r.q).join("; ")}`);
  process.exitCode = 1;
}
