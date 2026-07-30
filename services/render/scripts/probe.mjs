/**
 * POINT THIS AT A RUNNING RENDER SERVICE AND SEE WHAT IT ACTUALLY DOES.
 *
 * It exists because the whole justification for this service is a measurement — eska.fun
 * strips to FOUR characters of visible text through an HTTP GET — and a claim that a
 * headless browser fixes that is worth nothing unless somebody can re-run it. So this is
 * the runbook tool as well as the demo: the same command verifies a fresh Railway deploy
 * and reproduces the number in README.md.
 *
 *   RENDER_URL=http://127.0.0.1:8080 RENDER_SHARED_SECRET=… node scripts/probe.mjs
 *   RENDER_URL=https://…up.railway.app RENDER_SHARED_SECRET=… node scripts/probe.mjs https://example.com/
 *
 * It also runs the RAW fetch through lib/safe-fetch.js for the same URL, so the two
 * numbers sit side by side rather than requiring the reader to trust a comparison.
 *
 * Server-side only: no React.
 */
import { safeFetch } from "../../../lib/safe-fetch.js";
import { stripToText } from "../../../lib/site-analysis.js";

const base = (process.env.RENDER_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const secret = process.env.RENDER_SHARED_SECRET ?? "";
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ["https://eska.fun/", "https://www.ponsfamily.com/"];

if (!secret) {
  console.error("RENDER_SHARED_SECRET is not set. It must be the same value the service was started with.");
  process.exit(1);
}

const health = await fetch(`${base}/healthz`).then((r) => r.json()).catch((e) => ({ error: String(e?.message ?? e) }));
console.log("health:", JSON.stringify(health));
console.log("");

for (const url of targets) {
  // The baseline, through the same primitives the app uses today.
  const rawStart = Date.now();
  const raw = await safeFetch(url, { timeoutMs: 8_000 });
  const rawMs = Date.now() - rawStart;
  const rawText = raw.ok ? stripToText(raw.body ?? "") : null;

  const start = Date.now();
  let rendered = null;
  try {
    const res = await fetch(`${base}/render`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ url }),
    });
    rendered = await res.json();
    rendered.__http = res.status;
  } catch (e) {
    rendered = { status: "transport_failure", refusal: String(e?.message ?? e) };
  }
  const renderMs = Date.now() - start;

  const paintedText = rendered?.content?.text ? stripToText(rendered.content.html ?? "") : null;

  console.log(`=== ${url}`);
  console.log(`  RAW FETCH   : ${raw.ok ? `HTTP ${raw.status}, ${raw.bytes} bytes` : `REFUSED (${raw.code})`}  ${rawMs}ms`);
  console.log(`                stripToText -> ${rawText ? `${rawText.textChars} chars` : "n/a"}  ${rawText ? JSON.stringify(rawText.text.slice(0, 90)) : raw.refusal}`);
  console.log(`  RENDERED    : ${rendered?.status} (HTTP ${rendered?.__http})  ${renderMs}ms round trip, ${rendered?.timing?.totalMs ?? "?"}ms in the service`);
  if (rendered?.content) {
    console.log(`                painted HTML ${rendered.content.htmlBytes} bytes; innerText ${rendered.content.textChars} chars`);
    console.log(`                stripToText -> ${paintedText ? `${paintedText.textChars} chars` : "n/a"}  ${paintedText ? JSON.stringify(paintedText.text.slice(0, 120)) : ""}`);
    console.log(`                title ${JSON.stringify(rendered.content.title)}`);
  }
  if (rendered?.refusal) console.log(`                refusal: ${rendered.refusal}`);
  if (rendered?.screenshot) console.log(`  SCREENSHOT  : ${rendered.screenshot.available ? `${rendered.screenshot.bytes} bytes PNG ${rendered.screenshot.width}x${rendered.screenshot.height}` : rendered.screenshot.reason}`);
  if (rendered?.requests) console.log(`  REQUESTS    : ${rendered.requests.total} total, ${rendered.requests.xhrCount} XHR/fetch, ${rendered.requests.blockedCount} blocked, hosts: ${rendered.requests.hosts.map((h) => h.host).slice(0, 6).join(", ")}`);
  if (rendered?.console) console.log(`  CONSOLE     : ${rendered.console.errorCount} errors`);
  if (rendered?.egress) console.log(`  EGRESS      : ${JSON.stringify(rendered.egress)}`);
  if (rendered?.timing) console.log(`  TIMING      : ${JSON.stringify(rendered.timing)}`);
  console.log("");
}
