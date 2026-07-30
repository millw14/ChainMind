// Live: the launchpad-listing rung, whose server sends an incomplete certificate chain.
import { projectProfile } from "./lib/project-profile.js";
import { renderPage } from "./lib/render-client.js";
const SECRET = "localtest-secret-0123456789abcdefghij";
const localTransport = async (_u, init) => { const r = await fetch("http://127.0.0.1:8080/render", init); return { status: r.status, json: () => r.json() }; };
const client = (url, opts = {}) => renderPage(url, { ...opts, env: { RENDER_SERVICE_URL: "https://render.example.com", RENDER_SHARED_SECRET: SECRET }, fetcher: localTransport });
const res = await projectProfile("0x0eb9960654d3661d551a4536d7d425184ec81756", {
  url: "https://www.ponsfamily.com/", client: null, tokenMarketData: async () => ({ status: "no_pool" }), renderPage: client,
});
const w = res.evidence.web, s = w.site;
console.log("web.status       :", w.status, "| examined:", res.evidence.websiteExamined, "| readBy:", s?.readBy);
console.log("fetch            :", JSON.stringify({ status: s?.fetch?.status, code: s?.fetch?.refusalCode }), (s?.fetch?.refusal ?? "").slice(0, 150));
console.log("render.status    :", w.render?.status, "| textUsed:", w.render?.textUsed, "| serviceMs:", w.render?.timing?.totalMs);
console.log("content          :", s?.content?.textSource, "|", s?.content?.textChars, "chars | painted", w.render?.paint?.paintedHtmlBytes, "bytes");
console.log("text             :", JSON.stringify((s?.content?.text ?? "").slice(0, 260)));
console.log("claims           :", JSON.stringify((s?.claims?.found ?? []).map((c) => c.kind)));
console.log("addressMentions  :", JSON.stringify(s?.content?.addressMentions ?? []));
console.log("requests         :", JSON.stringify({ total: w.render?.requests?.total, xhr: w.render?.requests?.xhrCount, thirdParty: (w.render?.requests?.thirdPartyHosts ?? []).slice(0, 5) }));
console.log("response.reading :", (s?.response?.reading ?? "").slice(0, 300));
console.log("websiteNotice    :", (res.evidence.websiteNotice ?? "").slice(-300));
console.log("evidence chars   :", JSON.stringify(res.evidence).length);
