// Live end-to-end: project_profile over the real Eska contract with the real eska.fun,
// once with the render service configured and once without.
import { projectProfile } from "./lib/project-profile.js";

const ADDRESS = "0x0eb9960654d3661d551a4536d7d425184ec81756";
const URL_ = "https://eska.fun/";
const NO_MARKET = async () => ({ status: "no_pool" });

async function run(label) {
  const t = Date.now();
  const res = await projectProfile(ADDRESS, { url: URL_, client: null, tokenMarketData: NO_MARKET });
  const ms = Date.now() - t;
  const w = res.evidence?.web;
  const s = w?.site;
  console.log(`\n================ ${label}  (${ms}ms) ================`);
  console.log("scope            :", res.evidence?.scope, "| websiteExamined:", res.evidence?.websiteExamined);
  console.log("shell            :", JSON.stringify({ isShell: s?.shell?.isShell, clientRendered: s?.shell?.clientRendered, textChars: s?.shell?.textChars, htmlBytes: s?.shell?.htmlBytes, charsPerKb: s?.shell?.charsPerKb, markers: s?.shell?.markers }));
  console.log("render.status    :", w?.render?.status, "| textUsed:", w?.render?.textUsed, "| fromCache:", w?.render?.fromCache, "| ms:", w?.render?.timing?.totalMs);
  console.log("render.reading   :", (w?.render?.reading ?? "").slice(0, 300));
  console.log("content.source   :", s?.content?.textSource, "| chars:", s?.content?.textChars, "| serverChars:", s?.content?.serverTextChars);
  console.log("content.title    :", JSON.stringify(s?.content?.title));
  console.log("content.text     :", JSON.stringify((s?.content?.text ?? "").slice(0, 320)));
  console.log("serverText       :", JSON.stringify(s?.content?.serverText ?? null));
  console.log("sourceNote       :", (s?.content?.textSourceNote ?? "").slice(0, 260));
  console.log("claims           :", JSON.stringify((s?.claims?.found ?? []).map((c) => c.kind)), "| basedOn:", (s?.claims?.basedOn ?? "").slice(0, 120));
  console.log("addressMentions  :", JSON.stringify(s?.content?.addressMentions ?? []));
  console.log("requests         :", JSON.stringify(w?.render?.requests ? { total: w.render.requests.total, xhr: w.render.requests.xhrCount, thirdParty: w.render.requests.thirdPartyHosts } : null));
  console.log("screenshot       :", JSON.stringify(w?.render?.screenshot ? { available: w.render.screenshot.available, bytes: w.render.screenshot.bytes } : null));
  console.log("directives       :", s?.machineDirectedText?.found, JSON.stringify((s?.machineDirectedText?.findings ?? []).map((f) => f.kind)));
  console.log("contradictions   :", JSON.stringify(w?.contradictions));
  console.log("crossCheckReading:", (w?.contradictionsReading ?? "").slice(0, 220));
  console.log("websiteNotice    :", (res.evidence?.websiteNotice ?? "").slice(0, 420));
  console.log("evidence chars   :", JSON.stringify(res.evidence).length);
  console.log("reading tail     :", (res.evidence?.reading ?? "").slice(-420));
  return res;
}

process.env.RENDER_SERVICE_URL = "";
process.env.RENDER_SHARED_SECRET = "";
await run("A. NO RENDER SERVICE CONFIGURED");

process.env.RENDER_SERVICE_URL = "http://127.0.0.1:8080";
process.env.RENDER_SHARED_SECRET = "localtest-secret-0123456789abcdefghij";
await run("B. RENDER SERVICE CONFIGURED (cold)");
await run("C. SAME QUESTION AGAIN (cache)");
