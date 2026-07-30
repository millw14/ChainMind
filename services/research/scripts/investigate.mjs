/**
 * RUN ONE INVESTIGATION LOCALLY, END TO END, WITH NO SERVER AND NO QUEUE.
 *
 * The loop is the feature and the loop is also the thing whose behaviour cannot be argued
 * about in the abstract: how many steps it takes, what it decides to look at second, what
 * it declines and why, and what a report of it costs are all EMPIRICAL. This script is how
 * those numbers get produced and re-produced, which is why the README quotes it rather than
 * asserting anything.
 *
 *   cd services/research
 *   GROQ_API_KEY=… node scripts/investigate.mjs https://example.com/
 *   GROQ_API_KEY=… RESEARCH_MAX_STEPS=6 node scripts/investigate.mjs 0x…
 *
 * Optional, and each one adds a leg rather than being required:
 *   RENDER_SERVICE_URL + RENDER_SHARED_SECRET   the browser leg for JavaScript-built pages
 *   RESEARCH_GITHUB_TOKEN                       a read-only public-scope token, for the
 *                                               5,000/hour GitHub limit instead of 60
 *
 * It prints the live decision trail as the loop makes it, then the finished report as JSON.
 * `--json` prints only the report, for piping.
 *
 * Server-side only: no React.
 */
import { readFileSync } from "node:fs";
import { runInvestigation } from "../lib/loop.js";
import { createModelClient } from "../lib/model.js";
import { readConfig } from "../lib/config.js";

/**
 * STDOUT IS DATA HERE, SO EVERYTHING THAT IS NOT THE REPORT GOES TO STDERR.
 *
 * Not fastidiousness: lib/store.js announces its chosen driver on console.info the first
 * time anything touches it, which lands in the middle of a JSON document and makes
 * `node scripts/investigate.mjs … | jq` fail on a syntax error nobody wrote. The banner is
 * right to exist — an in-memory store in production is exactly the thing that must be
 * impossible to skim past — so it is redirected rather than silenced, and the one line this
 * script means as output is written to the real stdout at the end.
 */
const emit = (text) => process.stdout.write(`${text}\n`);
console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);

/**
 * The repository's own .env.local, if it is there.
 *
 * Read by hand rather than with dotenv: this package has one dependency and adding a second
 * so a development script can read a file is not a trade worth making. Values already in the
 * environment WIN — a script that overwrote an explicitly exported key would be surprising
 * in exactly the way credentials must not be.
 */
for (const file of ["../../../.env.local", "../../../.env"]) {
  try {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || m[1].startsWith("#")) continue;
      if (process.env[m[1]] != null && process.env[m[1]] !== "") continue;
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // Absent is fine: the environment may carry everything already.
  }
}

const args = process.argv.slice(2);
const jsonOnly = args.includes("--json");
const subject = args.find((a) => !a.startsWith("--"));

if (!subject) {
  console.error("Give a subject: a URL or a 0x contract address.\n  node scripts/investigate.mjs https://example.com/");
  process.exit(1);
}

// The service refuses to boot without a shared secret; a local run has no door to guard, so
// one is supplied here rather than making the operator invent one to read a report.
process.env.RESEARCH_SHARED_SECRET ??= "local-run-no-http-door-".padEnd(48, "x");

const boot = readConfig();
if (!boot.ok) {
  for (const p of boot.problems) console.error(`CONFIGURATION: ${p}`);
  process.exit(1);
}
const config = boot.config;

const started = Date.now();
if (!jsonOnly) {
  console.error(`# subject      ${subject}`);
  console.error(`# model        ${config.model}`);
  console.error(`# caps         ${config.limits.steps} steps, ${config.limits.toolCalls} tool calls, ${Math.round(config.limits.wallMs / 1000)}s, ${config.limits.modelTokens} tokens, ${config.limits.fetchedBytes} bytes`);
  console.error(`# render       ${config.renderAvailable ? config.renderUrl : "not configured — a JavaScript-built page will be read as the shell its server sends"}`);
  console.error(`# github       ${config.githubToken ? "token configured" : "anonymous (60 requests/hour)"}`);
  console.error("");
}

const { report, outcome } = await runInvestigation({
  subject: { given: subject },
  config,
  complete: createModelClient({ apiKey: process.env.GROQ_API_KEY || process.env.GEOQ_API_KEY }),
  onStep: (e) => {
    if (jsonOnly) return;
    if (e.phase === "step") console.error(`\n[step ${e.step}] ${e.findings} finding(s) so far, ${Math.round(e.remainingMs / 1000)}s left`);
    if (e.phase === "tool") console.error(`  -> ${e.tool}${e.subject ? ` ${e.subject}` : ""}`);
  },
});

if (!jsonOnly) {
  console.error("");
  console.error(`# outcome      ${outcome.status} after ${outcome.steps} step(s) in ${Math.round(outcome.elapsedMs / 1000)}s`);
  console.error(`# findings     ${report.findingCount} across ${report.findings.length} group(s)`);
  console.error(`# targets      ${report.checked.reached} reached of ${report.checked.proposed} proposed; ${report.declined.count} declined`);
  console.error(`# cost         ${outcome.modelCalls} model calls, ${report.cost.totalTokens} tokens, ${report.cost.fetchedBytes} bytes, ${report.cost.requests} request(s)`);
  console.error(`# caps hit     ${report.caps?.hit?.length ? report.caps.hit.map((h) => h.resource).join(", ") : "none"}`);
  console.error("");
}

emit(JSON.stringify(report, null, 2));
if (!jsonOnly) console.error(`\n# wall ${Date.now() - started}ms`);
