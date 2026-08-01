#!/usr/bin/env node
/**
 * THE ROUTING BENCH — what the router actually does, measured, N times.
 *
 * The routing defect survived because nobody could see it: a question naming a
 * contract routed to a different tool on different days and sometimes to none at
 * all, and every observation of that was one person retyping one question. This
 * runs scripts/routing-corpus.mjs against the REAL model with the REAL
 * SYSTEM_PROMPT and the REAL TOOL_SCHEMAS, repeats every question, and prints
 * accuracy, the confusion pairs, the NO_TOOL rate and the instability.
 *
 * IT IS NOT IN `npm test`, AND MUST NOT BE. It costs money and needs the
 * network — `node --test` has to stay free, offline and deterministic. This is a
 * thing somebody runs deliberately, and it prints what the run cost before it
 * spends anything.
 *
 *   node scripts/route-bench.mjs --n 3 --temp 0.2
 *   node scripts/route-bench.mjs --n 3 --temp 0.2,0            # both, in order
 *   node scripts/route-bench.mjs --only live,notool --n 5      # id prefixes
 *   node scripts/route-bench.mjs --no-gates                    # isolate the model
 *   node scripts/route-bench.mjs --out old.jsonl --no-recover  # re-score, free
 *
 * RE-SCORING A LOG COSTS NOTHING AND IS HOW A CHANGE IS ARGUED. Every call is on
 * disk with its response, including the body of every refusal, so pointing --out
 * at a finished log spends nothing and prints its numbers again. `--no-recover`
 * then scores that same log the way the product scored it BEFORE
 * lib/ask-loop.js recoverRefusedToolCalls existed. The before and the after are
 * then the same calls rather than two samples of a stochastic endpoint, and the
 * difference between them is the change and nothing else.
 *
 * WHAT IT MEASURES, AND THE ONE THING IT DOES NOT. It measures the ROUTING TURN
 * only — the first completion of lib/ask-loop.js runToolLoop, with tools on
 * offer — and stops there. No lookup is dispatched, no chain is read, no prose
 * turn is bought. That is deliberate and it is what makes the numbers cheap
 * enough to rerun after every change: routing is a classification, and a
 * classifier is measured on the label it emits.
 *
 * THE PRE-MODEL GATES ARE PART OF THE PRODUCT AND ARE REPORTED AS SUCH.
 * lib/ask-runner.js answers three kinds of question before the model is ever
 * asked — small talk, off-chain knowledge, and lib/ask-loop.js fastPathRoute.
 * A row those intercept never reaches Groq in production, so by default it does
 * not reach Groq here either: it is resolved by the gate, costs nothing, and is
 * scored. The summary then reports accuracy TWICE — over the whole corpus (what
 * the product does) and over the model-routed rows alone (what the model does) —
 * because a fix aimed at the model must not be graded on rows the model never
 * saw. `--no-gates` forces every row through the model to isolate it.
 *
 * RESUMABLE, BECAUSE A FULL RUN IS AN HOUR. Every call is appended to a JSONL
 * file as it completes, keyed by temperature + row + repetition. Re-running with
 * the same --out skips what is already there, so a dropped connection costs the
 * remaining calls and not the whole bill.
 *
 * COMPARING A LATER RUN WITH THE BASELINE. Every run also writes a
 * `.summary.json` beside its log holding, per temperature, one entry per corpus
 * row: the accepted outcomes, the gate that answered it if any, how many of the
 * N repetitions were right, and the full distribution of what came back. That is
 * the diffable artefact — a claim that a change improved routing is a claim about
 * two of those files, and a row that moved from stable-correct to unstable is
 * visible in them even when the headline accuracy went up.
 *
 * Exit code is 0 whatever the accuracy. The failures are the point; a bench that
 * fails the build would just get deleted.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  fastPathRoute,
  buildUserContent,
  parseToolCalls,
  parseTextToolCalls,
  recoverRefusedToolCalls,
} from "../lib/ask-loop.js";
import { isOffChainKnowledge, isSmallTalk } from "../lib/ask-intent.js";
import { SYSTEM_PROMPT, resolveModel } from "../lib/ask-runner.js";
import { TOOL_NAMES, TOOL_SCHEMAS } from "../lib/ask-tools.js";
import { getChainConfig } from "../lib/chain.js";
import { CORPUS } from "./routing-corpus.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/* --------------------------------- config --------------------------------- */

/**
 * Groq's published per-million-token prices for the routing model, used ONLY to
 * turn measured token counts into an estimate. The token counts below are
 * measured — they come back in every response's `usage` — and the dollar figure
 * is arithmetic over them at this rate. If the rate has moved, set
 * ROUTE_BENCH_USD_IN / ROUTE_BENCH_USD_OUT rather than trusting these.
 */
const USD_PER_M_INPUT = Number(process.env.ROUTE_BENCH_USD_IN ?? 0.59);
const USD_PER_M_OUTPUT = Number(process.env.ROUTE_BENCH_USD_OUT ?? 0.79);

/**
 * Tokens-per-minute ceiling to pace against. Measured on this account the limit
 * is 300,000 TPM and one routing turn costs ~30,700 prompt tokens, so nine
 * requests a minute is the real throughput and there is no point pretending
 * otherwise. Left at 90% of the limit because the header is the account's, not
 * this process's — anything else using the key eats the same bucket.
 */
const TPM_CAP = Number(process.env.ROUTE_BENCH_TPM ?? 270_000);

/** What one routing turn costs, until a real measurement replaces it. */
const ASSUMED_PROMPT_TOKENS = 31_000;

/** The upstream. Same endpoint and payload shape as app/api/ask/route.js. */
const COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions";

/** One request's patience. A routing turn lands in ~2.5s; 60s is a stall. */
const REQUEST_TIMEOUT_MS = 60_000;

/** The marker for "the model called nothing at all". Not a tool name, on purpose. */
const NO_TOOL = "NO_TOOL";

/**
 * The marker for "the model chose a tool, the API refused to serialize it, and
 * NOTHING could be read back out of the refusal".
 *
 * A THIRD OUTCOME, AND IT IS NOT AN ERROR TO BE DISCARDED. Groq answers a
 * malformed tool call with HTTP 400 `tool_use_failed` / "tool call validation
 * failed" instead of a message. Three shapes were measured, and in all three the
 * model had ALREADY DECIDED correctly — what failed was the serialization:
 *   1. the whole call, name and arguments, crammed into the tool NAME slot;
 *   2. an opener the parser would not take (`<function=safety_check{…}`);
 *   3. a well-formed call whose ARGUMENT TYPE failed Groq's schema check
 *      (`"minutes": "60"`), which is the exact class of mistake lib/ask-tools.js
 *      coercion exists to absorb — and could not, because the API validates
 *      before the call ever reaches it.
 *
 * Before lib/ask-loop.js recoverRefusedToolCalls, that 400 landed in runToolLoop's
 * catch, where looksLikeToolsUnsupported(400, …) returned true, so the loop
 * DEGRADED to lib/ask-runner.js answerByKeywords. The user was never told. The
 * model's choice was thrown away and the keyword router answered instead.
 *
 * Now the call is recovered from the error body and run, so a refusal the loop can
 * read is scored as the tool it recovered — that is what the product does with it.
 * This marker is left for the refusals nothing could be read out of, which are
 * still the wrong answers they always were.
 */
const REJECTED = "TOOL_CALL_REJECTED";

/** Groq's two wordings for a tool call it would not accept. */
const REJECTED_RE = /tool[_ ]call[_ ]validation[_ ]failed|tool_use_failed|failed to call a function/i;

/* ------------------------------- environment ------------------------------- */

/**
 * Load .env.local the way `next dev` would.
 *
 * Deliberately NOT dotenv: this file is run by hand from a shell that has no
 * Next process around it, and the one variable it needs is the one the app
 * already keeps there. Existing environment always wins, so `GROQ_API_KEY=... node
 * scripts/route-bench.mjs` still does what it looks like it does.
 */
function loadEnvLocal() {
  const path = resolve(ROOT, ".env.local");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = value.replace(/^(['"])(.*)\1$/, "$2");
  }
}

/* ---------------------------------- args ---------------------------------- */

function parseArgs(argv) {
  const args = {
    n: 3,
    temps: [0.2],
    only: null,
    gates: true,
    recover: true,
    concurrency: 3,
    out: null,
    yes: false,
    model: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[(i += 1)];
    switch (flag) {
      case "--n":
        args.n = Math.max(1, Number(next()) || 1);
        break;
      case "--temp":
      case "--temperature":
        args.temps = String(next())
          .split(",")
          .map((t) => Number(t.trim()))
          .filter((t) => Number.isFinite(t));
        break;
      case "--only":
        args.only = String(next())
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--no-gates":
        args.gates = false;
        break;
      case "--no-recover":
        args.recover = false;
        break;
      case "--concurrency":
        args.concurrency = Math.max(1, Number(next()) || 1);
        break;
      case "--out":
        args.out = String(next());
        break;
      case "--model":
        args.model = String(next());
        break;
      case "--yes":
      case "-y":
        args.yes = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        console.error(`Unknown flag: ${flag}`);
        process.exit(2);
    }
  }
  if (!args.temps.length) args.temps = [0.2];
  return args;
}

/* --------------------------------- gates --------------------------------- */

/**
 * What lib/ask-runner.js would do with this question BEFORE the model.
 *
 * Mirrors answerQuestion's first three branches in the same order it runs them.
 * It is a mirror rather than a call because answerQuestion needs a chat client, a
 * dispatch table and a network; the branch conditions are three exported pure
 * functions and those are what decide whether the model is asked at all.
 *
 * @returns {{ gate: string, outcome: string[] } | null} null = the model routes it.
 */
function gateRoute(question, target) {
  const q = String(question ?? "").trim();
  const t = String(target ?? "").trim();
  if (q && !t && isSmallTalk(q)) return { gate: "smallTalk", outcome: [] };
  if (q && !t && isOffChainKnowledge(q)) return { gate: "offChain", outcome: [] };
  const fast = fastPathRoute(q, t);
  if (fast) return { gate: "fastPath", outcome: fast.toolCalls.map((c) => c.name) };
  return null;
}

/** The context line lib/ask-runner.js contextNote builds for a target-free question. */
function contextNote(target) {
  const cfg = getChainConfig();
  const lines = [`Network: ${cfg.name} (chain id ${cfg.id}).`];
  if (target) {
    lines.push(
      `The interface also supplied this target, which is what the user is looking at: ${target}. Treat it as the subject when the question names none. It does NOT narrow the question: if the question names other subjects as well, the answer must cover the relation between all of them, and this target is only one of them.`,
    );
  }
  return lines.join("\n");
}

/* -------------------------------- the model -------------------------------- */

/**
 * A token-per-minute pacer.
 *
 * Not a request-per-second limiter: the binding constraint on this account is
 * 300,000 tokens a minute against a ~30,700-token routing turn, so pacing on
 * requests would either crawl or 429. It holds a 60-second sliding window of
 * what was actually spent and makes a caller wait until its estimated cost fits.
 */
function createPacer(tpmCap) {
  /** @type {Array<{ at: number, tokens: number }>} */
  const spent = [];
  let estimate = ASSUMED_PROMPT_TOKENS;

  const prune = (now) => {
    while (spent.length && now - spent[0].at > 60_000) spent.shift();
  };
  const inWindow = (now) => {
    prune(now);
    return spent.reduce((sum, e) => sum + e.tokens, 0);
  };

  return {
    /**
     * Reserve room for one request. Returns the reservation, which the caller
     * hands back to `record` — the ticket matters because several workers are in
     * flight at once and correcting "the last reservation" would credit one
     * worker's real cost against another's slot.
     */
    async take() {
      for (;;) {
        const now = Date.now();
        if (inWindow(now) + estimate <= tpmCap) {
          const ticket = { at: now, tokens: estimate };
          spent.push(ticket);
          return ticket;
        }
        const oldest = spent[0];
        const wait = Math.max(250, 60_000 - (now - oldest.at) + 100);
        await sleep(wait);
      }
    },
    record(ticket, tokens) {
      if (!Number.isFinite(tokens) || tokens <= 0) return;
      // A rolling estimate beats a constant: it self-corrects if the prompt grows.
      estimate = Math.round(estimate * 0.8 + tokens * 0.2);
      if (ticket) ticket.tokens = tokens;
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ONE routing turn, byte for byte the payload lib/ask-loop.js sends on round 0.
 *
 * The only differences from production are the ones that would make the
 * measurement lie if they were not here: nothing is dispatched afterwards, and
 * a 429 is retried rather than surfaced, because a rate-limited request is not a
 * routing decision and counting it as one would put a hole in the corpus.
 */
async function routeOnce({ row, temperature, model, apiKey, pacer }) {
  const payload = {
    model,
    temperature,
    max_tokens: 700,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserContent(row.q, contextNote(row.target ?? "")) },
    ],
    tools: TOOL_SCHEMAS,
    tool_choice: "auto",
  };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const ticket = await pacer.take();
    const startedAt = Date.now();
    let res;
    try {
      res = await fetch(COMPLETIONS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      if (attempt === 4) return { error: `transport: ${String(e?.message ?? e)}` };
      await sleep(2_000 * (attempt + 1));
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5_000 * (attempt + 1);
      if (attempt === 4) return { error: `HTTP ${res.status} after 5 attempts` };
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // A refused tool call is a routing decision, not an outage. See REJECTED.
      // The recovery is the PRODUCT's, imported rather than reimplemented: if the
      // bench salvaged a call the loop would not, the number would be a claim about
      // this file instead of about what a reader gets.
      if (res.status === 400 && REJECTED_RE.test(detail)) {
        const recovered = recoverRefusedToolCalls(detail);
        return {
          rejected: true,
          recovered: recovered.length > 0,
          outcome: recovered.length ? recovered.map((c) => c.name) : null,
          intended: intendedToolName(detail),
          detail: detail.slice(0, 2_000),
          ms: Date.now() - startedAt,
        };
      }
      return { error: `HTTP ${res.status}: ${detail.slice(0, 200)}` };
    }

    const body = await res.json().catch(() => null);
    if (!body) return { error: "response was not JSON" };
    const usage = body.usage ?? {};
    pacer.record(ticket, Number(usage.total_tokens) || 0);

    const message = body?.choices?.[0]?.message ?? null;
    // The same two-step lib/ask-loop.js uses: the structured field first, then the
    // salvage for a model that wrote the call out as prose. Skipping the salvage
    // would report a routing decision the product would have honoured as NO_TOOL.
    let calls = parseToolCalls(message);
    let salvaged = false;
    if (!calls.length) {
      const text = typeof message?.content === "string" ? message.content : "";
      const recovered = text ? parseTextToolCalls(text) : [];
      if (recovered.length) {
        calls = recovered;
        salvaged = true;
      }
    }

    return {
      outcome: calls.map((c) => c.name).filter(Boolean),
      salvaged,
      promptTokens: Number(usage.prompt_tokens) || 0,
      completionTokens: Number(usage.completion_tokens) || 0,
      ms: Date.now() - startedAt,
    };
  }
  return { error: "exhausted retries" };
}

/**
 * Best-effort: which tool the model was TRYING to call, out of a 400 body.
 *
 * Labelled best-effort everywhere it is printed because it is read out of an
 * error string rather than a structured field, and a wrong guess here must not
 * be mistaken for a measurement. It is worth extracting anyway: "the model wanted
 * project_profile and the API refused it" and "the model wanted nothing" are
 * completely different defects with completely different fixes.
 */
function intendedToolName(detail) {
  const named = /attempted to call tool '([a-z_]+)/i.exec(detail);
  if (named && TOOL_NAMES.includes(named[1])) return named[1];
  const generated = /"failed_generation"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(detail);
  if (generated) {
    for (const name of TOOL_NAMES) {
      if (generated[1].includes(name)) return name;
    }
  }
  return null;
}

/* -------------------------------- scoring -------------------------------- */

/**
 * What one logged call counts as — the single place a stored entry becomes a score.
 *
 * THE RECOVERY IS RE-RUN HERE RATHER THAN READ BACK FROM THE LOG, and that is what
 * makes an old log comparable with a new one. Every refusal was stored with its
 * error body, so the same lib/ask-loop.js function the product now uses can be
 * applied to a run recorded before it existed: `--no-recover` scores that log the
 * way the product scored it then, and the default scores it the way the product
 * scores it now. The before and the after are then the SAME 618 calls rather than
 * two samples of a stochastic endpoint, and the difference between them is the
 * change and nothing else.
 *
 * @param {object} entry - one JSONL row
 * @param {boolean} recover - honour the refusal recovery
 */
function decide(entry, recover) {
  if (!entry.rejected) {
    return { outcome: entry.outcome, key: outcomeKey(entry.outcome), recovered: false };
  }
  const salvaged = recover ? recoverRefusedToolCalls(entry.rejectDetail ?? "") : [];
  if (!salvaged.length) return { outcome: [], key: REJECTED, recovered: false };
  const names = salvaged.map((c) => c.name);
  return { outcome: names, key: outcomeKey(names), recovered: true };
}

/** An outcome as a comparable, printable key. Order and repeats do not matter. */
function outcomeKey(names) {
  const unique = [...new Set(names.filter(Boolean))].sort();
  return unique.length ? unique.join("+") : NO_TOOL;
}

/** True when this outcome is one of the row's acceptable answers. */
function isAccepted(row, key) {
  return row.accept.some((entry) => outcomeKey(entry) === key);
}

/** The row's acceptable answers, printed. */
function acceptKeys(row) {
  return row.accept.map(outcomeKey);
}

/** Does the question name an on-chain target the answer cannot be honest without? */
function namesOnChainTarget(row) {
  return /0x[0-9a-fA-F]{40}/.test(row.q) || /0x[0-9a-fA-F]{64}/.test(row.q) || Boolean(row.target);
}

/* --------------------------------- report --------------------------------- */

function pct(numerator, denominator) {
  if (!denominator) return "n/a";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function bar(label, width = 78) {
  const line = "─".repeat(Math.max(0, width - label.length - 3));
  return `\n── ${label} ${line}`;
}

/**
 * Turn the flat call log into the four things the fix needs to be steered by.
 */
function summarise(results, { n, scope, gateOf }) {
  const byRow = new Map();
  // Seeded from the corpus, not from the results: a row whose every call failed
  // in transit must still appear, with a visible hole, rather than vanishing and
  // quietly shrinking the denominator.
  for (const row of scope) byRow.set(row.id, []);
  for (const r of results) byRow.get(r.id).push(r);

  const rows = [];
  for (const [id, calls] of byRow) {
    const row = scope.find((s) => s.id === id);
    if (!calls.length) {
      rows.push({
        id,
        row,
        calls: [],
        gate: gateOf(id),
        runs: 0,
        correctRuns: 0,
        distinct: 0,
        distribution: [],
        majorityKey: "NO_RESULT",
        majorityCorrect: false,
        majorityShare: 0,
        noToolRuns: 0,
        missingRuns: n,
      });
      continue;
    }
    const keys = calls.map((c) => c.key);
    const counts = new Map();
    for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
    const distribution = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const [majorityKey, majorityCount] = distribution[0];
    rows.push({
      id,
      row,
      calls,
      gate: calls[0].gate,
      runs: keys.length,
      correctRuns: calls.filter((c) => c.correct).length,
      distinct: distribution.length,
      distribution,
      majorityKey,
      majorityCorrect: isAccepted(row, majorityKey),
      majorityShare: majorityCount / keys.length,
      noToolRuns: keys.filter((k) => k === NO_TOOL).length,
      missingRuns: Math.max(0, n - keys.length),
    });
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));

  const modelRows = rows.filter((r) => !r.gate);
  const totalCalls = results.length;
  const correctCalls = results.filter((r) => r.correct).length;

  return { rows, modelRows, totalCalls, correctCalls, n };
}

function report(label, summary, spend) {
  const { rows, modelRows, totalCalls, correctCalls, n } = summary;

  console.log(bar(`RESULT — ${label}`));

  const modelCalls = rows.filter((r) => !r.gate).flatMap((r) => r.calls);
  const modelCorrect = modelCalls.filter((c) => c.correct).length;

  console.log(`  corpus rows           ${rows.length}   (${modelRows.length} routed by the model, ${rows.length - modelRows.length} answered by a pre-model gate)`);
  console.log(`  repetitions per row   ${n}`);
  console.log(`  calls scored          ${totalCalls}`);
  console.log("");
  console.log(`  ACCURACY, whole corpus, per call     ${pct(correctCalls, totalCalls)}   (${correctCalls}/${totalCalls})`);
  console.log(`  ACCURACY, model-routed rows only     ${pct(modelCorrect, modelCalls.length)}   (${modelCorrect}/${modelCalls.length})`);
  const majorityCorrect = rows.filter((r) => r.majorityCorrect).length;
  const modelMajority = modelRows.filter((r) => r.majorityCorrect).length;
  console.log(`  ACCURACY at majority vote            ${pct(majorityCorrect, rows.length)} whole corpus, ${pct(modelMajority, modelRows.length)} model-routed`);

  // THE SPREAD, not just the headline. One accuracy figure per repetition, so a
  // reader can see whether "62%" is a stable 62 or a 55/70 that averaged there.
  const perRun = [];
  for (let i = 0; i < n; i += 1) {
    const calls = rows.flatMap((r) => r.calls.filter((c) => c.run === i));
    if (calls.length) perRun.push(`run ${i + 1}: ${pct(calls.filter((c) => c.correct).length, calls.length)}`);
  }
  console.log(`  SPREAD across repetitions            ${perRun.join("  ·  ")}`);

  // A hole in the data is stated, never averaged over. A row with fewer calls
  // than repetitions was measured less than the others and its share of every
  // figure above is smaller by exactly that much.
  const holed = rows.filter((r) => r.missingRuns > 0);
  if (holed.length) {
    console.log(`  CALLS THAT NEVER RETURNED A DECISION ${holed.reduce((s, r) => s + r.missingRuns, 0)} across ${holed.length} rows — excluded, not counted as wrong:`);
    for (const r of holed) console.log(`      ${r.id.padEnd(18)} ${r.runs}/${n} usable`);
  }

  /* ---- NO_TOOL, the defect that matters most ---- */
  console.log(bar("NO_TOOL"));
  const noToolCalls = rows.flatMap((r) => r.calls.filter((c) => c.key === NO_TOOL));
  const wrongNoTool = noToolCalls.filter((c) => !c.correct);
  const onTarget = wrongNoTool.filter((c) => namesOnChainTarget(c.row));
  console.log(`  NO_TOOL calls                        ${noToolCalls.length}/${totalCalls}  (${pct(noToolCalls.length, totalCalls)})`);
  console.log(`  ...of which NO_TOOL was correct      ${noToolCalls.length - wrongNoTool.length}`);
  console.log(`  ...of which a lookup was required    ${wrongNoTool.length}`);
  console.log(`  ...ON A NAMED ON-CHAIN TARGET        ${onTarget.length}   <- answered about a 0x with no chain read`);
  const byRowNoTool = new Map();
  for (const c of onTarget) byRowNoTool.set(c.id, (byRowNoTool.get(c.id) ?? 0) + 1);
  for (const [id, count] of [...byRowNoTool.entries()].sort((a, b) => b[1] - a[1])) {
    const row = rows.find((r) => r.id === id);
    console.log(`      ${id.padEnd(18)} ${count}/${row.runs}   ${JSON.stringify(row.row.q.slice(0, 60))}`);
  }
  if (!onTarget.length) console.log("      (none)");

  /* ---- tool calls the API refused ---- */
  console.log(bar("TOOL_CALL_REFUSED — the model chose, and the API refused to serialize it"));
  const recoveredCalls = rows.flatMap((r) => r.calls.filter((c) => c.recovered));
  const recoveredRight = recoveredCalls.filter((c) => c.correct).length;
  console.log(`  refusals recovered and run           ${recoveredCalls.length}/${totalCalls}  (${pct(recoveredCalls.length, totalCalls)})`);
  console.log(`  ...of which the recovered tool was right ${recoveredRight}   (scored above as that tool, which is what the loop now runs)`);
  const rejectedCalls = rows.flatMap((r) => r.calls.filter((c) => c.key === REJECTED));
  console.log(`  refusals nothing could be read from  ${rejectedCalls.length}/${totalCalls}  (${pct(rejectedCalls.length, totalCalls)})`);
  if (rejectedCalls.length) {
    console.log("  These still degrade: lib/ask-loop.js reads a 400 it cannot salvage as \"this endpoint");
    console.log("  cannot do tool calling\" and falls back to lib/ask-runner.js answerByKeywords, so the");
    console.log("  model's choice is discarded and the keyword router answers instead — silently.");
    const byRowRejected = new Map();
    for (const c of rejectedCalls) {
      if (!byRowRejected.has(c.id)) byRowRejected.set(c.id, { count: 0, intended: new Set() });
      const e = byRowRejected.get(c.id);
      e.count += 1;
      if (c.intended) e.intended.add(c.intended);
    }
    for (const [id, e] of [...byRowRejected.entries()].sort((a, b) => b[1].count - a[1].count)) {
      const row = rows.find((r) => r.id === id);
      const meant = e.intended.size ? `wanted ${[...e.intended].join("/")} (best-effort, read from the error body)` : "intended tool not recoverable";
      console.log(`      ${id.padEnd(18)} ${e.count}/${row.runs}   ${meant}`);
      console.log(`      ${" ".repeat(18)} ${JSON.stringify(row.row.q.slice(0, 70))}`);
    }
  } else {
    console.log("      (none)");
  }

  /* ---- instability ---- */
  console.log(bar("INSTABILITY — same question, different answer"));
  const unstable = rows.filter((r) => r.distinct > 1);
  console.log(`  unstable rows                        ${unstable.length}/${rows.length}  (${pct(unstable.length, rows.length)})`);
  const unstableModel = modelRows.filter((r) => r.distinct > 1);
  console.log(`  ...among model-routed rows           ${unstableModel.length}/${modelRows.length}  (${pct(unstableModel.length, modelRows.length)})`);
  for (const r of unstable.sort((a, b) => b.distinct - a.distinct)) {
    const dist = r.distribution.map(([k, c]) => `${k}×${c}`).join("  ");
    console.log(`      ${r.id.padEnd(18)} ${dist}`);
    console.log(`      ${" ".repeat(18)} ${JSON.stringify(r.row.q.slice(0, 70))}`);
  }
  if (!unstable.length) console.log("      (none — every question answered the same way every time)");

  /* ---- confusion ---- */
  console.log(bar("CONFUSION — expected vs chosen, wrong calls only"));
  const confusion = new Map();
  for (const r of rows) {
    for (const c of r.calls) {
      if (c.correct) continue;
      const expected = acceptKeys(r.row).join(" | ") || NO_TOOL;
      const pair = `${expected}  ->  ${c.key}`;
      confusion.set(pair, (confusion.get(pair) ?? 0) + 1);
    }
  }
  const pairs = [...confusion.entries()].sort((a, b) => b[1] - a[1]);
  for (const [pair, count] of pairs) console.log(`  ${String(count).padStart(3)}×  ${pair}`);
  if (!pairs.length) console.log("  (none)");

  /* ---- per collision ---- */
  console.log(bar("BY COLLISION GROUP"));
  const groups = new Map();
  for (const r of rows) {
    const key = r.row.collision ?? "(uncontested)";
    if (!groups.has(key)) groups.set(key, { calls: 0, correct: 0, rows: 0 });
    const g = groups.get(key);
    g.rows += 1;
    g.calls += r.calls.length;
    g.correct += r.correctRuns;
  }
  for (const [key, g] of [...groups.entries()].sort((a, b) => a[1].correct / a[1].calls - b[1].correct / b[1].calls)) {
    console.log(`  ${key.padEnd(16)} ${pct(g.correct, g.calls).padStart(6)}  (${g.correct}/${g.calls} calls over ${g.rows} rows)`);
  }

  /* ---- per expected tool ---- */
  console.log(bar("BY TOOL THE ROW EXISTS TO EXERCISE"));
  const perTool = new Map();
  for (const r of rows) {
    const key = r.row.primary || "(no tool)";
    if (!perTool.has(key)) perTool.set(key, { calls: 0, correct: 0, rows: 0 });
    const t = perTool.get(key);
    t.rows += 1;
    t.calls += r.calls.length;
    t.correct += r.correctRuns;
  }
  for (const [key, t] of [...perTool.entries()].sort((a, b) => a[1].correct / a[1].calls - b[1].correct / b[1].calls)) {
    console.log(`  ${key.padEnd(24)} ${pct(t.correct, t.calls).padStart(6)}  (${t.correct}/${t.calls})`);
  }

  /* ---- tools never chosen ---- */
  const everChosen = new Set();
  for (const r of rows) for (const c of r.calls) for (const name of c.outcome) everChosen.add(name);
  const never = TOOL_NAMES.filter((name) => !everChosen.has(name));
  console.log(bar("TOOLS NEVER ONCE CHOSEN"));
  console.log(`  ${never.length ? never.join(", ") : "(none — every one of the 26 was reached at least once)"}`);

  /* ---- hallucinated names ---- */
  const invented = [...everChosen].filter((name) => !TOOL_NAMES.includes(name));
  if (invented.length) {
    console.log(bar("NAMES THE MODEL INVENTED"));
    console.log(`  ${invented.join(", ")}`);
  }

  /* ---- cost ---- */
  console.log(bar("WHAT THIS COST"));
  const usd = (tokens) => (tokens.prompt / 1e6) * USD_PER_M_INPUT + (tokens.completion / 1e6) * USD_PER_M_OUTPUT;
  const line = (name, s) => {
    console.log(`  ${name}`);
    console.log(`    requests               ${s.requests}`);
    console.log(`    prompt tokens          ${s.prompt.toLocaleString()}   (measured, from each response's usage)`);
    console.log(`    completion tokens      ${s.completion.toLocaleString()}   (measured)`);
    console.log(`    estimated spend        $${usd(s).toFixed(2)}   (measured tokens × $${USD_PER_M_INPUT}/M in, $${USD_PER_M_OUTPUT}/M out)`);
  };
  // BOTH FIGURES, because a resumed run would otherwise quote a price nobody paid.
  // The invocation's own bill is what this process spent; the log's is what the
  // numbers above actually cost, across however many invocations produced them.
  line("this invocation", {
    requests: spend.requests,
    prompt: spend.promptTokens,
    completion: spend.completionTokens,
  });
  if (spend.logRequests !== spend.requests) {
    line("the whole log (what the figures above rest on)", {
      requests: spend.logRequests,
      prompt: spend.logPromptTokens,
      completion: spend.logCompletionTokens,
    });
  }
  console.log("");
  console.log(`  tool calls refused (400) ${spend.rejected} this invocation   (billed, scored as TOOL_CALL_REJECTED above)`);
  if (spend.errors) console.log(`  transport/5xx failures   ${spend.errors}   (excluded from every accuracy figure above)`);
  console.log("  Spend covers every temperature this invocation ran — it is one process's bill, not one");
  console.log("  report's. Token counts are measured; the dollar figures are arithmetic over them.");
}

/* ---------------------------------- run ---------------------------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(readFileSync(new URL(import.meta.url)).toString().split("*/")[0]);
    return;
  }

  loadEnvLocal();
  const apiKey = process.env.GROQ_API_KEY || process.env.GEOQ_API_KEY;
  if (!apiKey) {
    console.error("No GROQ_API_KEY. This bench measures the real model; there is nothing to measure without one.");
    process.exit(1);
  }
  const model = args.model || resolveModel();

  let corpus = CORPUS;
  if (args.only) corpus = corpus.filter((row) => args.only.some((prefix) => row.id.startsWith(prefix)));
  if (!corpus.length) {
    console.error("--only matched no rows.");
    process.exit(2);
  }

  // Resolve the gates once. Free, deterministic, and it decides what gets bought.
  const prepared = corpus.map((row) => ({ row, gate: args.gates ? gateRoute(row.q, row.target ?? "") : null }));
  const modelRows = prepared.filter((p) => !p.gate);
  const plannedCalls = modelRows.length * args.n * args.temps.length;

  const outPath = resolve(args.out ?? resolve(ROOT, ".route-bench", `run-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`));
  mkdirSync(dirname(outPath), { recursive: true });

  // Anything already in the log is already paid for.
  /** @type {Map<string, object>} */
  const done = new Map();
  if (existsSync(outPath)) {
    for (const line of readFileSync(outPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        done.set(`${entry.temperature}|${entry.id}|${entry.run}`, entry);
      } catch {
        /* a half-written last line from a killed run; ignore it */
      }
    }
  }
  // Counted over the keys THIS invocation plans to buy, not over the log's size:
  // the same log may hold a wider --only scope or another temperature, and
  // subtracting those would quote a cost lower than the one about to be spent.
  let alreadyHave = 0;
  for (const temperature of args.temps) {
    for (const p of modelRows) {
      for (let run = 0; run < args.n; run += 1) {
        if (done.has(`${temperature}|${p.row.id}|${run}`)) alreadyHave += 1;
      }
    }
  }
  const toBuy = plannedCalls - alreadyHave;
  const estUsd = (toBuy * ASSUMED_PROMPT_TOKENS * USD_PER_M_INPUT) / 1e6;
  const estMinutes = (toBuy * ASSUMED_PROMPT_TOKENS) / TPM_CAP;

  console.log(bar("ROUTING BENCH"));
  console.log(`  model                 ${model}`);
  console.log(`  system prompt         ${SYSTEM_PROMPT.length.toLocaleString()} chars`);
  console.log(`  tools                 ${TOOL_SCHEMAS.length}, ${JSON.stringify(TOOL_SCHEMAS).length.toLocaleString()} chars, sent verbatim`);
  console.log(`  corpus                ${corpus.length} rows${args.only ? ` (--only ${args.only.join(",")})` : ""}`);
  console.log(`  pre-model gates       ${args.gates ? `on — ${corpus.length - modelRows.length} rows answered without a model call` : "OFF (--no-gates): every row goes to the model"}`);
  console.log(`  refusal recovery      ${args.recover ? "on — a refused call is read back out of the 400 and scored as the tool it named" : "OFF (--no-recover): a refused call scores as TOOL_CALL_REJECTED, as it did before the fix"}`);
  console.log(`  temperatures          ${args.temps.join(", ")}`);
  console.log(`  repetitions           ${args.n}`);
  console.log(`  calls to buy          ${toBuy}${alreadyHave ? ` (${alreadyHave} of the ${plannedCalls} planned are already in the log)` : ""}`);
  console.log(`  ESTIMATED COST        ~$${estUsd.toFixed(2)} and ~${Math.ceil(estMinutes)} min at ${TPM_CAP.toLocaleString()} TPM`);
  console.log(`  log                   ${outPath}`);

  // Nothing to buy means nothing to confirm. A complete log is a FILE, and
  // re-scoring one has to be free — that is the whole mechanism behind
  // `--no-recover`, which answers "what did this same run look like before the
  // fix" without spending a second bill on a stochastic endpoint.
  if (!args.yes && toBuy > 0) {
    console.log("\n  This spends real money. Re-run with --yes to go ahead.");
    return;
  }

  const pacer = createPacer(TPM_CAP);
  const spend = { requests: 0, promptTokens: 0, completionTokens: 0, errors: 0, rejected: 0 };

  for (const temperature of args.temps) {
    /** @type {Array<{ prepared: object, run: number }>} */
    const jobs = [];
    for (const p of modelRows) {
      for (let run = 0; run < args.n; run += 1) {
        if (done.has(`${temperature}|${p.row.id}|${run}`)) continue;
        jobs.push({ p, run });
      }
    }

    console.log(bar(`RUNNING — temperature ${temperature}, ${jobs.length} calls`));
    let finished = 0;
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= jobs.length) return;
        const { p, run } = jobs[index];
        const result = await routeOnce({ row: p.row, temperature, model, apiKey, pacer });
        finished += 1;
        spend.requests += 1;
        spend.promptTokens += result.promptTokens ?? 0;
        spend.completionTokens += result.completionTokens ?? 0;
        if (result.error) spend.errors += 1;
        if (result.rejected) spend.rejected += 1;
        const entry = {
          temperature,
          id: p.row.id,
          run,
          model,
          outcome: result.outcome ?? null,
          rejected: result.rejected ?? false,
          recovered: result.recovered ?? false,
          intended: result.intended ?? null,
          rejectDetail: result.detail ?? null,
          error: result.error ?? null,
          salvaged: result.salvaged ?? false,
          promptTokens: result.promptTokens ?? 0,
          completionTokens: result.completionTokens ?? 0,
          ms: result.ms ?? 0,
          at: new Date().toISOString(),
        };
        appendFileSync(outPath, `${JSON.stringify(entry)}\n`);
        done.set(`${temperature}|${p.row.id}|${run}`, entry);
        if (finished % 10 === 0 || finished === jobs.length) {
          process.stdout.write(`  ${finished}/${jobs.length} calls · ${spend.promptTokens.toLocaleString()} prompt tokens spent\n`);
        }
      }
    };
    await Promise.all(Array.from({ length: args.concurrency }, worker));
  }

  /* ---- score, per temperature ---- */
  // What the whole log cost, not just this process — see the cost block in report().
  spend.logRequests = 0;
  spend.logPromptTokens = 0;
  spend.logCompletionTokens = 0;
  for (const entry of done.values()) {
    spend.logRequests += 1;
    spend.logPromptTokens += entry.promptTokens ?? 0;
    spend.logCompletionTokens += entry.completionTokens ?? 0;
  }

  const summaries = {};
  for (const temperature of args.temps) {
    /** @type {Array<object>} */
    const results = [];
    for (const p of prepared) {
      if (p.gate) {
        // A gated row is deterministic: one outcome, no model, no variance. It is
        // still scored N times so accuracy is over the same denominator either way.
        const key = outcomeKey(p.gate.outcome);
        for (let run = 0; run < args.n; run += 1) {
          results.push({
            id: p.row.id,
            row: p.row,
            run,
            gate: p.gate.gate,
            outcome: p.gate.outcome,
            key,
            correct: isAccepted(p.row, key),
          });
        }
        continue;
      }
      for (let run = 0; run < args.n; run += 1) {
        const entry = done.get(`${temperature}|${p.row.id}|${run}`);
        if (!entry) continue;
        // A rejected tool call IS a routing outcome — see REJECTED. Only a
        // transport failure or an exhausted retry is dropped, and the count of
        // those is printed so the denominator is never quietly short.
        if (entry.error) continue;
        if (!entry.rejected && !entry.outcome) continue;
        const decided = decide(entry, args.recover);
        results.push({
          id: p.row.id,
          row: p.row,
          run,
          gate: null,
          outcome: decided.outcome,
          intended: entry.intended ?? null,
          recovered: decided.recovered,
          key: decided.key,
          correct: decided.key === REJECTED ? false : isAccepted(p.row, decided.key),
        });
      }
    }
    const summary = summarise(results, {
      n: args.n,
      scope: prepared.map((p) => p.row),
      gateOf: (id) => prepared.find((p) => p.row.id === id)?.gate?.gate ?? null,
    });
    report(`temperature ${temperature}`, summary, spend);
    summaries[temperature] = {
      rows: summary.rows.map((r) => ({
        id: r.id,
        question: r.row.q,
        primary: r.row.primary,
        accept: acceptKeys(r.row),
        collision: r.row.collision ?? null,
        gate: r.gate,
        runs: r.runs,
        correctRuns: r.correctRuns,
        distinct: r.distinct,
        distribution: Object.fromEntries(r.distribution),
        majority: r.majorityKey,
        majorityCorrect: r.majorityCorrect,
      })),
      calls: summary.totalCalls,
      correct: summary.correctCalls,
    };
  }

  const jsonPath = outPath.replace(/\.jsonl$/, ".summary.json");
  writeFileSync(
    jsonPath,
    `${JSON.stringify({ model, n: args.n, temperatures: args.temps, gates: args.gates, spend, summaries }, null, 2)}\n`,
  );
  console.log(`\n  machine-readable summary: ${jsonPath}`);
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exit(1);
});
