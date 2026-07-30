// Live end-to-end: project_profile over the real Eska contract and the real eska.fun,
// through the real render service running locally.
//
// ONLY THE TRANSPORT HOP IS INJECTED, and it has to be: lib/safe-fetch.js refuses
// 127.0.0.1 outright, which is exactly what it is for. So the client is configured with a
// public-looking service URL (which passes validateUrl and is never contacted) and its
// `fetcher` posts to the local service. Everything else is the real path: real Chromium,
// real site, real stripping, real ladder.
import { projectProfile } from "./lib/project-profile.js";
import { renderPage } from "./lib/render-client.js";

const ADDRESS = "0x0eb9960654d3661d551a4536d7d425184ec81756";
const URL_ = "https://eska.fun/";
const SECRET = "localtest-secret-0123456789abcdefghij";
const NO_MARKET = async () => ({ status: "no_pool" });

const localTransport = async (_url, init) => {
  const res = await fetch("http://127.0.0.1:8080/render", init);
  return { status: res.status, json: () => res.json() };
};
const client = (url, opts = {}) =>
  renderPage(url, { ...opts, env: { RENDER_SERVICE_URL: "https://render.example.com", RENDER_SHARED_SECRET: SECRET }, fetcher: localTransport });

async function run(label) {
  const t = Date.now();
  const res = await projectProfile(ADDRESS, { url: URL_, client: null, tokenMarketData: NO_MARKET, renderPage: client });
  const ms = Date.now() - t;
  const w = res.evidence?.web;
  const s = w?.site;
  console.log(`\n================ ${label}  (${ms}ms) ================`);
  console.log("shell            :", JSON.stringify({ isShell: s?.shell?.isShell, textChars: s?.shell?.textChars, htmlBytes: s?.shell?.htmlBytes, renderedInstead: s?.shell?.renderedInstead }));
  console.log("render.status    :", w?.render?.status, "| textUsed:", w?.render?.textUsed, "| fromCache:", w?.render?.fromCache, "| serviceMs:", w?.render?.timing?.totalMs);
  console.log("render.reading   :", (w?.render?.reading ?? "").slice(0, 200));
  console.log("content.source   :", s?.content?.textSource, "| chars:", s?.content?.textChars, "| serverChars:", s?.content?.serverTextChars, "| paintedBytes:", w?.render?.paint?.paintedHtmlBytes);
  console.log("content.title    :", JSON.stringify(s?.content?.title));
  console.log("content.text     :", JSON.stringify((s?.content?.text ?? "").slice(0, 400)));
  console.log("serverText       :", JSON.stringify(s?.content?.serverText ?? null));
  console.log("claims           :", JSON.stringify((s?.claims?.found ?? []).map((c) => `${c.kind}: ${String(c.quote).slice(0, 60)}`)));
  console.log("addressMentions  :", JSON.stringify(s?.content?.addressMentions ?? []));
  console.log("requests         :", JSON.stringify(w?.render?.requests ? { total: w.render.requests.total, xhr: w.render.requests.xhrCount, blocked: w.render.requests.blockedCount, thirdParty: w.render.requests.thirdPartyHosts } : null));
  console.log("xhr sample       :", JSON.stringify((w?.render?.requests?.xhr ?? []).slice(0, 3)));
  console.log("console errors   :", w?.render?.console?.errorCount);
  console.log("screenshot       :", JSON.stringify(w?.render?.screenshot ?? null).slice(0, 200));
  console.log("directives       :", s?.machineDirectedText?.found, JSON.stringify((s?.machineDirectedText?.findings ?? []).map((f) => f.kind + " @ " + f.where)));
  console.log("contradictions   :", JSON.stringify(w?.contradictions));
  console.log("crossCheck       :", (w?.contradictionsReading ?? "").slice(0, 200));
  console.log("websiteNotice    :", (res.evidence?.websiteNotice ?? "").slice(-330));
  console.log("evidence chars   :", JSON.stringify(res.evidence).length);
  console.log("reading tail     :", (res.evidence?.reading ?? "").slice(-330));
}

await run("B. RENDER SERVICE LIVE (cold)");
await run("C. SAME QUESTION AGAIN (cached render)");
