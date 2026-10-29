// CardComp proxy for the phone (Chinese copy prices). Phone browsers will not let pm-derek.github.io read TCGplayer's
// listings service directly; on desktop the extension does it. This Cloudflare Worker forwards one kind of request:
// the listings search or the latest sales of one TCGplayer product. Nothing is stored, no keys.
//
// Setup (free plan, ~5 minutes): dash.cloudflare.com -> Workers & Pages -> Create -> "Hello World" worker -> name it
// cardcomp-tcg -> Deploy -> Edit code -> paste this file -> Deploy. Copy the address it shows
// (https://cardcomp-tcg.<you>.workers.dev) into CardComp settings -> "proxy address" on the phone.
const ALLOW = ["https://pm-derek.github.io"];
const OK_URL = /^https:\/\/(mp-search-api\.tcgplayer\.com\/v1\/product\/\d+\/listings|mpapi\.tcgplayer\.com\/v2\/product\/\d+\/latestsales)$/;

export default {
  async fetch(req) {
    const origin = req.headers.get("origin") || "";
    const cors = { "Access-Control-Allow-Origin": ALLOW.includes(origin) ? origin : ALLOW[0], "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type", "Access-Control-Max-Age": "86400", "Vary": "Origin" };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return new Response("CardComp proxy: POST only", { status: 405, headers: cors });
    let q; try { q = await req.json(); } catch (_) { return new Response("bad json", { status: 400, headers: cors }); }
    if (!OK_URL.test(String(q.url || ""))) return new Response("TCGplayer listings / sales only", { status: 400, headers: cors });
    const r = await fetch(q.url, { method: "POST", body: JSON.stringify(q.body || {}), headers: {
      "content-type": "application/json", "accept": "application/json", "origin": "https://www.tcgplayer.com", "referer": "https://www.tcgplayer.com/",
      "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" } });
    return new Response(r.body, { status: r.status, headers: Object.assign({ "content-type": "application/json" }, cors) });
  },
};
