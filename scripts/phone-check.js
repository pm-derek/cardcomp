#!/usr/bin/env node
// Checks phone/bridge.js against the real app in headless Chromium, with the Android side mocked. No API key needed.
//   node scripts/phone-check.js            (PHONE_OUT=dir for the screenshots, default the OS temp dir)
// 1. the handshake: the page gets ext-ready / auto-state / status, phone + card mode, a small panel height reported
// 2. read now: bubble -> Android.grab -> __phone.frame -> api (mocked) -> cardcomp-auto -> results filled, best guess marked,
//    the compact card shows it with its bid and the status line, ‹ › step through candidates, ▾ opens the list
// 3. the card's bid button taps the card's own chip: Android.bid gets the floored dollars, bid-ack flashes, stays compact
// 4. keyboard rule: focusing the search box -> Android.focus(true) + layout("typing"); blur -> focus(false) + the list
// 5. links: a TCGplayer link click goes to Android.open, never navigates
// Needs playwright (preinstalled in the cloud session; locally: npm i playwright && npx playwright install chromium).
const fs = require("fs"), path = require("path"), http = require("http"), os = require("os");
let chromium; try { ({ chromium } = require("playwright")); } catch (_) { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
const ROOT = path.resolve(__dirname, "..");
const OUT = process.env.PHONE_OUT || os.tmpdir();
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? "  ok   " : "  FAIL ") + msg); if (!cond) fails++; };

function serve(dir) {
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    const p = path.join(dir, u.replace(/^\/+/, "") || "index.html");
    if (!p.startsWith(dir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    const ct = p.endsWith(".json") ? "application/json" : p.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8";
    res.writeHead(200, { "content-type": ct }); fs.createReadStream(p).pipe(res);
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, base: "http://127.0.0.1:" + srv.address().port })));
}

const READ = { visible: true, name: "Charizard", lang: "en", num: "4", total: "102", rarity: "Holo Rare", stamp: "", finish: "holo", set: "Base Set", conf: 0.92, box: [] };

(async () => {
  const { srv, base } = await serve(ROOT);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 360, height: 240 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => {
    if (/tcgplayer-cdn|pokemontcg\.io/.test(r.request().url())) {   // card photos: a stand-in card, the sandbox cannot reach the CDNs
      return r.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="245" height="342"><rect width="245" height="342" rx="12" fill="#f0c419"/><rect x="14" y="40" width="217" height="140" fill="#e2583e"/><rect x="14" y="196" width="217" height="120" fill="#fff6d6"/><text x="20" y="28" font-size="20" font-family="sans-serif">Charizard</text></svg>' });
    }
    if (/api\.anthropic\.com\/v1\/messages/.test(r.request().url())) {
      return r.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" }, contentType: "application/json",
        body: JSON.stringify({ model: "claude-sonnet-5-5", usage: { input_tokens: 1500, output_tokens: 70 }, stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(READ) }] }) });
    }
    r.abort();
  });
  // the Android side: records every call
  await page.addInitScript(() => {
    const calls = [];
    const rec = (n, a) => { calls.push({ n, a: Array.from(a).map((x) => (typeof x === "string" && x.length > 80 ? x.slice(0, 40) + "…" : x)) }); };
    window.__calls = calls;
    window.Android = {
      cfg() { rec("cfg", []); return JSON.stringify({ ver: "0.1.0", build: "test", model: "sonnet", mode: window.__mode || "manual", hasKey: true, hasToken: false, reader: true, capture: true, w: 1080, h: 2340 }); },
      key(n) { rec("key", [n]); return n === "anthropic" ? "sk-ant-test" : ""; },
      setCfg(j) { rec("setCfg", [j]); },
      grab(req) { rec("grab", [req]); window.__lastReq = req; return "ok"; },
      reading(on) { rec("reading", [on]); },
      bid(a, n) { rec("bid", [a, n]); return JSON.stringify({ ok: false, why: "copied" }); },
      open(u) { rec("open", [u]); },
      focus(w) { rec("focus", [w]); },
      layout(s) { rec("layout", [s]); },
      size(h) { rec("size", [h]); window.__h = h; },
      collapse() { rec("collapse", []); },
      toast(t) { rec("toast", [t]); },
      log(s) { rec("log", [s]); },
      dump() { rec("dump", []); },
      copy(t) { rec("copy", [t]); },
      img(url, req) {   // a different solid color per photo, so the matcher has distinct templates
        rec("img", [url]);
        let h = 0; for (const ch of url) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        const cv = document.createElement("canvas"); cv.width = 60; cv.height = 84; const g = cv.getContext("2d");
        g.fillStyle = `hsl(${h % 360},70%,${30 + (h >> 9) % 40}%)`; g.fillRect(0, 0, 60, 84); g.fillStyle = `hsl(${(h >> 3) % 360},60%,60%)`; g.fillRect(8, 10, 44, 34);
        const d = cv.toDataURL("image/jpeg", 0.8); setTimeout(() => window.__phone.img(req, d), 5);
      },
      bundled() { rec("bundled", []); return window.__BUNDLE; },
      asset(n) { rec("asset", [n]); return ""; },
      http(req, method, url) { rec("http", [method, url]); setTimeout(() => window.__phone.http(req, 0, ""), 20); },   // TCGplayer unreachable here
      bundledVer() { return window.__BUNDLE_VER; }
    };
  });
  await page.goto(base + "/");
  await page.waitForFunction(() => typeof CARDS !== "undefined" && CARDS.length > 1000, null, { timeout: 60000 });
  // what OverlayService does after the page loads
  // what OverlayService does after each page load: its LOADER text, taken from the Kotlin source, with the APK's bundle
  const kt = fs.readFileSync(path.join(ROOT, "android/app/src/main/java/io/github/pmderek/cardcomp/OverlayService.kt"), "utf8");
  const LOADER = /val LOADER = """([\s\S]*?)"""/.exec(kt)[1].replace("$NATIVE_API", /NATIVE_API = (\d+)/.exec(kt)[1]);
  const bundle = ["extension/recog/recog-read.js", "extension/recog/imgmatch.js", "phone/bridge.js"].map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n;\n");
  const VER = /const VER = "([0-9.]+)"/.exec(bundle)[1];
  // the live site serves the same bridge version as the APK: the built-in copy must be used (no network needed)
  await page.evaluate(([b, v]) => { window.__BUNDLE = b; window.__BUNDLE_VER = v; }, [bundle, VER]);
  await page.evaluate(LOADER);
  await page.waitForFunction(() => !!window.__phone && typeof window.recogRead === "function", null, { timeout: 10000 });
  await page.waitForTimeout(400);
  const calls = () => page.evaluate(() => window.__calls);
  console.log("0. loader");
  ok((await calls()).some((x) => x.n === "bundled"), "same version on the live site: the APK's built-in bridge runs");
  {   // an older APK (bundled 0.0.1): the live site's newer bridge runs instead, fetched with the reader and the matcher
    const p2 = await ctx.newPage(); const e2 = []; p2.on("pageerror", (e) => e2.push(e.message));
    await p2.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
    await p2.addInitScript(() => { window.__c = []; window.Android = { bundled() { window.__c.push("bundled"); return ""; }, bundledVer() { return "0.0.1"; },
      cfg() { return "{}"; }, key() { return ""; }, log() {}, layout() {}, size() {}, focus() {}, setCfg() {}, grab() { return "ok"; }, bid() { return "{}"; }, open() {}, toast() {}, copy() {}, img() {}, collapse() {} }; });
    await p2.goto(base + "/");
    await p2.evaluate(LOADER);
    await p2.waitForFunction(() => !!window.__phone, null, { timeout: 10000 });
    const r = await p2.evaluate(() => ({ used: window.__c.slice(), ver: window.__phone.ver, im: typeof IM, rr: typeof recogRead }));
    ok(!r.used.includes("bundled") && r.ver === VER && r.im === "object" && r.rr === "function", `older APK: the live bridge ${r.ver} runs, with the reader and the matcher (${JSON.stringify(r)})`);
    ok(e2.length === 0, "no page errors on the live-bridge path" + (e2.length ? ": " + e2.join(" | ") : ""));
    await p2.close();
  }
  // small card ~60% of the phone's width (250 css px), full view the whole width (360)
  const fit = async (cap) => { await page.waitForTimeout(250); const h = await page.evaluate(() => window.__h || 100); await page.setViewportSize({ width: cap ? 360 : 250, height: Math.min(h, cap || 9999) }); await page.waitForTimeout(150); return h; };

  console.log("1. handshake");
  const h = await page.evaluate(() => ({
    phone: document.body.classList.contains("phone"), strip: document.body.classList.contains("ph-card"),
    
    readbtn: !!document.querySelector("#readbig") && getComputedStyle(document.querySelector("#readbig")).display !== "none",
    wnstat: (document.querySelector("#wnstat") || {}).innerHTML || "",
    bar: (document.querySelector("#phonebar") || {}).textContent || "",
    ext: typeof WN_EXT !== "undefined" && WN_EXT
  }));
  ok(h.phone && h.strip, "body has the phone + card classes");
  ok(h.ext, "the app heard cardcomp-ext-ready (WN_EXT)");
  ok(!h.readbtn, "the page's read button is hidden on the phone (the bubble reads)");
  ok(/Whatnot ✓/.test(h.wnstat), "status ack painted: " + h.wnstat.replace(/<[^>]+>/g, ""));
  ok(/no card yet/i.test(h.bar), "card line before any read: " + h.bar.trim());
  const h0 = await fit();
  ok(h0 > 30 && h0 < 110, "compact card asks for a small panel: " + h0 + " css px");
  await page.screenshot({ path: path.join(OUT, "phone-card-empty.png") });

  console.log("2. read now");
  await page.evaluate(() => window.__phone.readNow("bubble"));
  await page.waitForTimeout(100);
  let c = await calls();
  ok(c.some((x) => x.n === "grab"), "bubble -> Android.grab");
  // one read at a time: a second tap while reading grabs nothing and says so; the card dims under the reading bar
  await page.evaluate(() => window.__phone.readNow("bubble"));
  await page.waitForTimeout(250);
  const rb = await page.evaluate(() => ({ grabs: window.__calls.filter((x) => x.n === "grab").length, bar: (document.querySelector("#phoneread") || {}).textContent || "",
    still: document.querySelector("#phoneread").classList.contains("still"), dim: document.querySelector("#phonecard").classList.contains("reading"), busy: window.__calls.filter((x) => x.n === "reading").map((x) => x.a[0]).join() }));
  ok(rb.grabs === 1 && /still reading, one tap is enough/.test(rb.bar) && rb.still && rb.dim && rb.busy === "true", "second tap while reading: no second read, bar says so: " + rb.bar + " (app told: " + rb.busy + ")");
  await page.screenshot({ path: path.join(OUT, "phone-reading.png") });
  await page.evaluate(() => {
    const cv = document.createElement("canvas"); cv.width = 64; cv.height = 96; const g = cv.getContext("2d"); g.fillStyle = "#c33"; g.fillRect(0, 0, 64, 96);
    window.__phone.frame(window.__lastReq, cv.toDataURL("image/jpeg", 0.8), 720, 1560);
  });
  await page.waitForFunction(() => document.querySelectorAll("#results .card").length > 0, null, { timeout: 10000 });
  await page.waitForTimeout(500);
  const ra = await page.evaluate(() => ({ bar: (document.querySelector("#phoneread") || {}).className, dim: document.querySelector("#phonecard").classList.contains("reading"), last: window.__calls.filter((x) => x.n === "reading").map((x) => x.a[0]).pop() }));
  ok(!ra.bar && !ra.dim && ra.last === false, "reply in: bar gone, card back, app told the read is done");
  // not sure (a best guess, no picture agreement): the likely cards to pick from, no pricing yet
  const pk = await page.evaluate(() => ({ items: document.querySelectorAll("#phonebar .pki").length, first: (document.querySelector("#phonebar .pki em") || {}).textContent, guess: !!document.querySelector("#phonebar .pki.g"), priced: !!document.querySelector("#phonebar .pb"), head: (document.querySelector("#phonebar .pkh") || {}).textContent }));
  ok(pk.items > 1 && pk.guess && !pk.priced && /charizard/i.test(pk.first), `unsure read: ${pk.items} likely cards to pick, best guess first (${pk.first}), no pricing yet · "${(pk.head || "").trim()}"`);
  await fit(); await page.screenshot({ path: path.join(OUT, "phone-picker.png") });
  // a sure match (text and picture agree) goes straight to the priced card
  const sure = await page.evaluate(() => new Promise((res) => { const g = document.querySelector("#results .card.autosug"); g.classList.add("byboth"); setTimeout(() => { const ok = !!document.querySelector("#phonebar .pb") && !document.querySelector("#phonebar .pki"); g.classList.remove("byboth"); setTimeout(() => res(ok), 300); }, 300); }));
  ok(sure, "auto + picture agree: priced straight away");
  // Derek picks the best guess: priced, with ≡ back to the choices
  await page.evaluate(() => document.querySelector("#phonebar .pki.g").click()); await page.waitForTimeout(300);
  const picked = await page.evaluate(() => ({ priced: !!document.querySelector("#phonebar .pb"), back: !!document.querySelector('#phonebar [data-t="choices"]') }));
  ok(picked.priced && picked.back, "picked: priced, with ≡ back to the choices");
  await page.evaluate(() => document.querySelector('#phonebar [data-t="choices"]').click()); await page.waitForTimeout(200);
  ok(await page.evaluate(() => document.querySelectorAll("#phonebar .pki").length > 1), "≡ shows the choices again");
  await page.evaluate(() => document.querySelector("#phonebar .pki.g").click()); await page.waitForTimeout(300);
  const r2 = await page.evaluate(() => ({
    n: document.querySelectorAll("#results .card").length,
    first: (document.querySelector("#results .card .nm") || {}).textContent || "",
    sug: !!document.querySelector("#results .card.autosug"),
    msg: (document.querySelector("#automsg") || {}).textContent || "",
    bar: (document.querySelector("#phonebar") || {}).textContent || "",
    bid: (document.querySelector("#phonebar .pb") || {}).textContent || "",
    card: document.body.classList.contains("ph-card"),
    stat: (document.querySelector("#phonestat") || {}).textContent || "",
    q: document.querySelector("#q").value
  }));
  ok(r2.n > 0 && /charizard/i.test(r2.first), `results filled: ${r2.n} cards, first "${r2.first.trim()}"`);
  ok(r2.sug, "best guess marked (autosug)");
  ok(/charizard/i.test(r2.q), "search box shows the reading: " + r2.q);
  ok(/\$\d/.test(r2.bid), "strip line has the bid: " + r2.bid.trim() + " · " + r2.bar.replace(/\s+/g, " ").trim().slice(0, 80));
  c = await calls();
  ok(r2.card && c.some((x) => x.n === "layout" && x.a[0] === "card-show"), "after the read: compact card, panel shown (card-show unfolds it)");
  ok(r2.stat === "", "the small card stays quiet after a good read (the read line is in the full view)");
  const h2 = await fit();
  ok(h2 > 100 && h2 < 178, "small card with a result: card picture + condition pills + printing buttons, " + h2 + " css px tall at 250 px wide");
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll("#phonebar .pb")).map((r) => { const sm = r.querySelectorAll("small"); return { c: r.dataset.c, bid: r.querySelector("b").textContent.trim(), px: sm[0].textContent.replace("mkt", "").trim(), be: sm[1].textContent.replace("b/e", "").trim() }; }));
  ok(rows.length === 5 && rows[4].c === "DMG" && rows.every((x) => /^\$\d+$/.test(x.bid) && /^\$[\d,.]+$/.test(x.px)), "condition pills NM to DMG mirror the grid: " + rows.map((x) => `${x.c} ${x.bid} (mkt ${x.px}, b/e ${x.be})`).join(" | "));
  const beOK = await page.evaluate((rows) => rows.every((x) => { const m = +x.px.replace(/[$,]/g, ""), be = bidForMargin(m, 0); return x.be === "$" + (be >= 1000 ? Math.floor(be).toLocaleString("en-US") : be.toFixed(2)) && be >= +x.bid.slice(1).replace(/,/g, ""); }), rows);
  ok(beOK, "break-even on each pill = the app's bidForMargin(price, 0) with cents, never below the suggested bid: " + rows.map((x) => x.be).join(" "));
  const gridNM = await page.evaluate(() => { const b = document.querySelector("#results .card.open .condgrid .bd.cpy[data-cond='NM']"); return b ? b.dataset.bid : ""; });   // what a grid tap sends (whole dollars, rounded up when that keeps 75%+ of the profit)
  ok(gridNM && rows[0].bid === "$" + gridNM, "NM pill sends what the full grid's NM sends: $" + gridNM);
  await page.screenshot({ path: path.join(OUT, "phone-card.png") });
  const scr = await page.evaluate(() => { const p = document.querySelector("#phonebar .prow"); const vis = Array.from(p.children).filter((b) => b.getBoundingClientRect().right <= p.getBoundingClientRect().right + 1).length; p.scrollLeft = 9999; return { vis, scrolls: p.scrollLeft > 0 }; });
  ok(scr.vis === 2 && scr.scrolls, `pills scroll sideways: ${scr.vis} fully visible, swipe for the rest`);
  await page.evaluate(() => { document.querySelector("#phonebar .prow").scrollLeft = 0; });
  // the background TCGplayer read: started by itself for the card shown, once
  await page.waitForTimeout(900);
  const auto1 = (await calls()).filter((x) => x.n === "http" && /tcgplayer/.test(x.a[1])).length;
  await page.evaluate(() => window.__phone.setMode("card")); await page.waitForTimeout(900);
  const auto2 = (await calls()).filter((x) => x.n === "http" && /tcgplayer/.test(x.a[1])).length;
  const fr = await page.evaluate(() => typeof FAST_REQ !== "undefined" && FAST_REQ && FAST_REQ.pid);
  ok(auto1 > 0 && auto2 === auto1 && !!fr, `background read of every condition for the card shown, once (${auto1} requests, product ${fr}); repaint adds none`);
  // step through the candidates
  const step = await page.evaluate(() => { const a = document.querySelector("#phonebar .pn b").textContent + " " + document.querySelector("#phonebar .pn span").textContent; document.querySelector('#phonebar [data-t="next"]').click(); return new Promise((r) => setTimeout(() => r([a, document.querySelector("#phonebar .pn b").textContent + " " + document.querySelector("#phonebar .pn span").textContent, (document.querySelector("#phonebar .sn") || {}).textContent]), 50)); });
  ok(step[0] !== step[1] && step[2] === "2/" + r2.n, `› steps to the next candidate: ${step[1]} (${step[2]})`);
  await page.evaluate(() => document.querySelector('#phonebar [data-t="prev"]').click());
  // list mode: tap the name
  await page.evaluate(() => document.querySelector('#phonebar .pn').click());
  const lm = await page.evaluate(() => ({ list: document.body.classList.contains("ph-list"), res: getComputedStyle(document.querySelector("#results")).display !== "none", q: getComputedStyle(document.querySelector("#q")).display !== "none" }));
  ok(lm.list && lm.res && lm.q, "tapping the name opens the full view: search box and results shown");
  const st2 = await page.evaluate(() => (document.querySelector("#phonestat") || {}).textContent || "");
  ok(/charizard/i.test(st2) && /frame/.test(st2), "full view says what was read, with the frame link: " + st2.trim().slice(0, 80));
  const h3 = await fit(560);
  ok(h3 > h2 + 200, "list asks for a tall panel (native caps it): " + h3 + " css px");
  await page.screenshot({ path: path.join(OUT, "phone-list.png") });
  await page.evaluate(() => document.querySelector('#phonebar [data-t="toggle"]').click());
  await fit();

  console.log("3. bid from the strip");
  const before = (await calls()).length;
  await page.evaluate(() => document.querySelector("#phonebar .pb").click());   // a tap (page.click scrolls the snapping pill row first)
  await page.waitForTimeout(300);
  c = (await calls()).slice(before);
  const bid = c.find((x) => x.n === "bid");
  ok(bid && /^\d+$/.test(bid.a[0]), "Android.bid called with whole dollars: " + (bid ? bid.a.join(" / ") : "none"));
  ok(await page.evaluate(() => document.body.classList.contains("ph-card")), "still the compact card after the bid");
  const flash = await page.evaluate(() => (document.querySelector("#phonebar .pb") || {}).textContent || "");
  ok(/copied/.test(flash), "strip button flashes: " + flash);
  const tapped = await page.evaluate(() => typeof LAST_TAP !== "undefined" && LAST_TAP && LAST_TAP.n);
  ok(/charizard/i.test(String(tapped)), "the tap labeled the lot through the card's own chip: " + tapped);
  await page.screenshot({ path: path.join(OUT, "phone-card-copied.png") });
  await page.waitForTimeout(2700);

  // LP from the compact card: labelled LP, same number as the grid
  const b3 = (await calls()).length;
  await page.evaluate(() => document.querySelector('#phonebar .pb[data-c="LP"]').click());
  await page.waitForTimeout(300);
  const lpBid = (await calls()).slice(b3).find((x) => x.n === "bid");
  const lpTap = await page.evaluate(() => LAST_TAP && LAST_TAP.cond);
  ok(lpBid && lpTap === "LP" && rows[1].bid === "$" + lpBid.a[0], `LP bid button sends the grid's LP bid, labelled LP: $${lpBid && lpBid.a[0]} (${lpTap})`);
  await page.waitForTimeout(2700);

  console.log("3b. picture match, clipboard, long press");
  await page.waitForFunction(() => window.__calls.filter((x) => x.n === "img").length > 1, null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const pic = await page.evaluate(() => ({ imgs: window.__calls.filter((x) => x.n === "img").length, msg: (document.querySelector("#automsg") || {}).textContent || "" }));
  ok(pic.imgs > 1, `photos fetched through the app for the picture match: ${pic.imgs}`);
  ok(/picture/.test(pic.msg) && !/no reply|not on the phone|needs extension/.test(pic.msg), "picture match answered: " + (/picture[^·]*/.exec(pic.msg) || [""])[0].trim());
  const cp = await page.evaluate(() => window.__calls.filter((x) => x.n === "copy").map((x) => x.a[0]));
  ok(cp.length > 0 && cp.every((t) => /^\d+$/.test(t)), "page copies go through the app (no hidden textarea): " + cp.join(", "));
  ok(!(await calls()).some((x) => x.n === "focus" && x.a[0] === true), "no keyboard request from a bid tap");
  const readsBefore = (await calls()).filter((x) => x.n === "grab").length;
  await page.evaluate(() => document.querySelector("#phonebar .pn").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  await page.waitForTimeout(200);
  ok((await calls()).filter((x) => x.n === "grab").length === readsBefore, "a long press (contextmenu) does not read");
  const sel = await page.evaluate(() => Array.from(document.querySelectorAll("select")).filter((x) => getComputedStyle(x).display !== "none").length);
  ok(sel === 0, "no visible <select> (an overlay WebView crashes on dropdowns)");


  console.log("3c. speed: likely cards at the partial reading, photos fetched while the model finishes");
  await page.evaluate(() => {   // a streamed reply: name and number at 300 ms, the rest at 1.5 s
    window.__rr = window.recogRead;
    window.recogRead = (img, mk, key, onPartial) => new Promise((res) => {
      setTimeout(() => onPartial && onPartial({ name: "Pikachu", number: "58", total: "102", language: "en" }, 300), 300);
      setTimeout(() => res({ read: { card_visible: true, name: "Pikachu", number: "58", total: "102", language: "en", rarity: "Common", finish: "", set: "Base", confidence: 0.9, box: [] }, ms: 1500, model: "claude-sonnet-5-5", cost: 0 }), 1500);
    });
  });
  const img0 = (await calls()).filter((x) => x.n === "img").length;
  await page.evaluate(() => window.__phone.readNow("bubble"));
  await page.waitForTimeout(100);
  await page.evaluate(() => { const cv = document.createElement("canvas"); cv.width = 64; cv.height = 96; cv.getContext("2d").fillRect(0, 0, 64, 96); window.__phone.frame(window.__lastReq, cv.toDataURL("image/jpeg", 0.8), 720, 1560); });
  await page.waitForTimeout(800);
  const sp = await page.evaluate(() => ({ cls: document.querySelector("#phonecard").className, bar: document.querySelector("#phoneread").textContent, dim: getComputedStyle(document.querySelector("#phonebar")).opacity, imgs: window.__calls.filter((x) => x.n === "img").length }));
  ok(/partial/.test(sp.cls) && +sp.dim === 1 && /found Pikachu 58\/102, checking the rest/.test(sp.bar) && sp.imgs > img0, `at the partial reading the card is usable and photos are downloading (${sp.imgs - img0} so far, bar: ${sp.bar})`);
  await page.waitForTimeout(1500);
  const sf = await page.evaluate(() => ({ bar: document.querySelector("#phoneread").className, cls: document.querySelector("#phonecard").className }));
  ok(!sf.bar && !/reading/.test(sf.cls), "full reply: bar gone");
  await page.evaluate(() => { window.recogRead = window.__rr; });

  console.log("3d. Chinese copy price on the phone: TCGplayer requests through the app, price + bid on the small card");
  const zr = await page.evaluate(() => new Promise((res) => {
    const h = (e) => { if (e.data && e.data.type === "cardcomp-tcg-post-ack" && e.data.req === "zt1") { window.removeEventListener("message", h); res(e.data); } };
    window.addEventListener("message", h);
    window.postMessage({ type: "cardcomp-tcg-post", req: "zt1", url: "https://mp-search-api.tcgplayer.com/v1/product/42382/listings", body: { size: 50 } }, location.origin);
    setTimeout(() => res({ timeout: true }), 5000);
  }));
  const zc = (await calls()).filter((x) => x.n === "http" && /42382\/listings/.test(x.a[1] || "")).length;
  ok(!zr.timeout && zr.req === "zt1" && zc === 1, `listings request went through the app and was answered (here TCGplayer is unreachable: ${zr.err || "data"})`);
  await page.evaluate(() => {
    window.__zhClicked = 0; window.__phone.setMode("card");
    let am = document.querySelector("#automsg");
    if (!am) { const al = document.querySelector("#autoline") || document.body.appendChild(Object.assign(document.createElement("div"), { id: "autoline" })); am = al.appendChild(Object.assign(document.createElement("span"), { id: "automsg" })); }
    am.insertAdjacentHTML("beforeend", '<div class="zhauto"><div><b>Chinese sold ≈ $12.50</b> <span>avg of the 3 latest sales: $12 · $13 · $12.50</span> <button class="zhbid" data-bid="9">bid $9</button></div></div>');
    am.querySelector(".zhbid").addEventListener("click", () => window.__zhClicked++);
  });
  await page.waitForTimeout(300);
  const zb = await page.evaluate(() => { const b = document.querySelector('#phonealert [data-t="zhbid"]'); const t = (document.querySelector("#phonealert .pzh") || {}).textContent || ""; if (b) b.click(); return { t, has: !!b, clicked: window.__zhClicked }; });
  ok(zb.has && /Chinese sold ≈ \$12\.50/.test(zb.t) && zb.clicked === 1, "small card shows the Chinese price and its bid button sends it: " + zb.t);
  await page.evaluate(() => { const z = document.querySelector("#automsg .zhauto"); if (z) z.remove(); });

  // a Chinese read: the candidates' pictures, no lookups; the card tapped is looked up alone, then its bid
  const zids = await page.evaluate(() => CARDS.filter((c) => /^sylveon/i.test(c.n) && c.px).slice(0, 3).map((c) => c.id));
  await page.evaluate((ids) => {
    const now = Date.now();
    window.__zhCalls = []; window.__zhOrig = window.zhLookup;
    window.zhLookup = async (cands) => { window.__zhCalls.push(cands.map((c) => c.id)); await new Promise((r) => setTimeout(r, 150));
      const id = cands[0].id; return { ok: true, ids: cands.map((c) => c.id), checked: cands.length, errs: [], dbg: [],
        hits: [{ id, pid: 1, p: 14, title: "Sylveon Chinese" }, { id, pid: 1, p: 15, title: "S-Chinese" }],
        sold: [{ id, pid: 1, p: 12, at: now - 864e5 }, { id, pid: 1, p: 13, at: now - 2 * 864e5 }, { id, pid: 1, p: 12.5, at: now - 3 * 864e5 }] }; };
    window.ZH_LAST = { key: 1, at: now, ids };
    window.__phone.setMode("card"); window.dispatchEvent(new Event("cardcomp-zh"));
  }, zids);
  await page.waitForTimeout(300);
  const zp = await page.evaluate(() => ({ items: Array.from(document.querySelectorAll('#phonebar [data-t="zhpick"]')).map((x) => ({ id: x.dataset.id, t: x.textContent, img: !!x.querySelector("img") })), calls: window.__zhCalls.length }));
  ok(zp.items.length === zids.length && zp.items.every((x) => x.img) && zp.calls === 0, "Chinese read: the candidates' pictures to pick from, no price lookups yet: " + zp.items.map((x) => x.t).join(" | "));
  await page.screenshot({ path: path.join(OUT, "phone-zh-pick.png") });
  const nb0 = (await calls()).filter((x) => x.n === "bid").length;
  await page.evaluate(() => document.querySelectorAll('#phonebar [data-t="zhpick"]')[1].click());
  await page.waitForTimeout(80);
  const zw = await page.evaluate(() => document.querySelector("#phonebar").textContent);
  await page.waitForTimeout(400);
  const zv = await page.evaluate(() => ({ t: document.querySelector("#phonebar").textContent, bid: (document.querySelector('#phonebar [data-t="zhbid"]') || {}).dataset, calls: window.__zhCalls }));
  await page.screenshot({ path: path.join(OUT, "phone-zh-card.png") });
  await page.evaluate(() => document.querySelector('#phonebar [data-t="zhbid"]').click());
  await page.waitForTimeout(300);
  const nb = (await calls()).filter((x) => x.n === "bid");
  ok(/checking Chinese sales and listings for this card/.test(zw) && zv.calls.length === 1 && zv.calls[0][0] === zids[1], "tap a card: only that card is looked up (" + JSON.stringify(zv.calls) + ")");
  const zpl = await page.evaluate(() => Array.from(document.querySelectorAll("#phonebar .prow.zp .pb")).map((x) => ({ t: x.textContent, alt: x.classList.contains("alt") })));
  ok(zpl.length === 2 && /SOLD/.test(zpl[0].t) && !zpl[0].alt && zpl[1].alt && zpl.every((x) => /mkt\$[\d.]+b\/e\$\d+\.\d\d/.test(x.t)), "Chinese bids as pills like the conditions: sold first (used), listed dashed, each bid / mkt / b/e: " + zpl.map((x) => x.t).join(" | "));
  ok(/sold\s*\$12\.00 Oct/.test(zv.t) && /listed\s*\$14\.00 · \$15\.00/.test(zv.t) && /mkt\$12\.50/.test(zv.t) && /mkt\$14\.50/.test(zv.t) && zv.bid && zv.bid.nolabel === "1" && nb.length === nb0 + 1 && nb[nb.length - 1].a[0] === zv.bid.bid, `its Chinese sales, listings and bid $${zv.bid && zv.bid.bid} (sent, not labeled as the English card)`);
  await page.evaluate(() => { window.zhLookup = window.__zhOrig; });
  await page.evaluate(() => { window.ZH_LAST = null; window.dispatchEvent(new Event("cardcomp-zh")); });

  console.log("3e. read journal: every read saved to the private repo (text only): reading, match and pick");
  await page.evaluate(() => {
    window.__puts = []; const of = window.fetch;
    window.fetch = (u, o) => { if (/api\.github\.com\/repos\/pm-derek\/cardcomp-data\/contents\/phone-reads\//.test(String(u))) { window.__puts.push({ u: String(u), b: JSON.parse(o.body) }); return Promise.resolve({ ok: true, status: 201 }); } return of(u, o); };
    window.__keyOrig = window.Android.key; window.Android.key = (n) => (n === "github" ? "ghp_test" : n === "anthropic" ? "sk-ant-test" : "");
  });
  await page.evaluate(() => window.__phone.readNow("bubble")); await page.waitForTimeout(100);
  await page.evaluate(() => { const cv = document.createElement("canvas"); cv.width = 640; cv.height = 900; cv.getContext("2d").fillRect(0, 0, 640, 900); window.__phone.frame(window.__lastReq, cv.toDataURL("image/jpeg", 0.8), 640, 900); });
  await page.waitForTimeout(1800);
  await page.evaluate(() => window.__phone.journalNow()); await page.waitForTimeout(200);
  const jr = await page.evaluate(() => window.__puts.map((x) => ({ u: x.u, e: JSON.parse(decodeURIComponent(escape(atob(x.b.content)))) })));
  const jl = jr[jr.length - 1] || {}, je = jl.e || {};
  ok(jr.length >= 1 && /phone-reads\/\d{4}-\d\d-\d\d\/\d{6}-/.test(jl.u) && !je.frame && JSON.stringify(je).length < 4000 && je.read && je.read.name && je.match && je.match.kind && "shown" in je,
    `read saved (the previous read is saved when the next starts): ${jl.u ? jl.u.split("/contents/")[1] : "none"} (read ${je.read && je.read.name}, match ${je.match && je.match.kind}, ${JSON.stringify(je).length} bytes, no picture)`);
  await page.evaluate(() => { window.Android.key = window.__keyOrig; });

  await page.evaluate(() => { window.__phone.setMode("card"); window.__phone.bidAck({ ok: false, why: "exact" }); }); await page.waitForTimeout(250);
  const ex = await page.evaluate(() => ({ warn: (document.querySelector("#phonealert .pwarn") || {}).textContent || "", bg: (() => { const w = document.querySelector("#phonealert .pwarn"); return w ? getComputedStyle(w).backgroundColor : ""; })() }));
  ok(/Max Bid is OFF in Whatnot\. Nothing entered/.test(ex.warn) && /192, 57, 43/.test(ex.bg), "Max Bid off and could not be switched: nothing entered, big red warning: " + ex.warn);
  await page.screenshot({ path: path.join(OUT, "phone-maxoff.png") });
  await page.evaluate(() => window.__phone.bidAck({ ok: true, how: "typed", maxOn: true })); await page.waitForTimeout(250);
  const mo = await page.evaluate(() => ({ warn: !!document.querySelector("#phonealert .pwarn"), st: (document.querySelector("#phonestat") || {}).textContent || "" }));
  ok(!mo.warn && /switched it on/.test(mo.st), "Max Bid switched on by the app: the warning goes, a gold note says so: " + mo.st);

  // Android ended the capture (screen switching): reading state clears, the note says to tap start on the bubble
  await page.waitForTimeout(8200);
  await page.evaluate(() => window.__phone.captureLost()); await page.waitForTimeout(250);
  const cl = await page.evaluate(() => ({ st: (document.querySelector("#phonestat") || {}).textContent || "", rd: !!document.querySelector("#phoneread:not([hidden])") && getComputedStyle(document.querySelector("#phoneread")).display !== "none" }));
  ok(/tap start on the bubble/i.test(cl.st) && !cl.rd, "capture lost: reading bar gone, note says tap start on the bubble: " + cl.st);

  console.log("4. keyboard rule");
  const b4 = (await calls()).length;
  await page.evaluate(() => document.querySelector('#phonebar [data-t="search"]').click());   // 🔍 opens the list and focuses the box
  await page.waitForTimeout(100);
  c = (await calls()).slice(b4);
  ok(c.some((x) => x.n === "focus" && x.a[0] === true), "focus(true) when the search box takes focus");
  ok(c.findIndex((x) => x.n === "focus" && x.a[0] === true) < c.findIndex((x) => x.n === "layout" && x.a[0] === "list"), "🔍 makes the window focusable before it opens the full view");
  ok(c.some((x) => x.n === "layout" && x.a[0] === "typing"), "layout(typing)");
  await page.evaluate(() => document.querySelector("#q").blur());
  await page.waitForTimeout(300);
  c = (await calls()).slice(b4);
  ok(c.some((x) => x.n === "focus" && x.a[0] === false), "focus(false) on blur");
  ok(c.filter((x) => x.n === "layout").pop().a[0] === "list", "after typing with text in the box: the list");

  const b4b = (await calls()).length;
  await page.evaluate(() => document.querySelector("#q").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  ok((await calls()).slice(b4b).some((x) => x.n === "focus" && x.a[0] === true), "touch-down on a text field asks for focus (the panel is never focusable on its own)");
  const b4c = (await calls()).length;
  await page.evaluate(() => document.querySelector("#phonebar").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  ok(!(await calls()).slice(b4c).some((x) => x.n === "focus" && x.a[0] === true), "touch-down elsewhere does not");

  // typing a whole query: focus stays in the box, the text arrives whole, nothing is opened under the finger
  await page.evaluate(() => { const q = document.querySelector("#q"); q.value = ""; });
  await page.evaluate(() => document.querySelector('#phonebar [data-t="search"]').click());
  await page.keyboard.type("reshiram charizard sm247", { delay: 60 });
  await page.waitForTimeout(500);
  const ty = await page.evaluate(() => ({ v: document.querySelector("#q").value, f: document.activeElement && document.activeElement.id, top: (document.querySelector("#results .card .nm") || {}).textContent || "", open: document.querySelectorAll("#results .card.open").length }));
  ok(ty.v === "reshiram charizard sm247" && ty.f === "q", `typing keeps focus and every letter: "${ty.v}" (focus ${ty.f})`);
  ok(/SM247/.test(ty.top) && ty.open === 0, `top result ${ty.top.trim()}, no card opened while typing`);
  // a number that is not in the catalog: said plainly
  await page.evaluate(() => { const q = document.querySelector("#q"); q.value = "charizard sm999"; q.dispatchEvent(new Event("input", { bubbles: true })); q.blur(); });
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__phone.setMode("card"));
  await page.waitForTimeout(300);
  const miss = await page.evaluate(() => (document.querySelector("#phonebar .pmiss") || {}).textContent || "");
  ok(/no card #SM999/.test(miss), "no exact match is said plainly: " + miss);
  await page.screenshot({ path: path.join(OUT, "phone-card-miss.png") });

  console.log("6. lot reader (Android screen texts, from Derek's screenshots)");
  const W = 1080, H = 2340;
  const T = (t, l, y, r, b, c) => ({ t, l, y, r, b, c: c ? 1 : 0 });
  const head = [T("domvault_card", 210, 115, 460, 160), T("5.0", 260, 175, 300, 210), T("39", 870, 145, 915, 185)];
  const chat = [T("westoncon82064", 160, 1560, 430, 1600), T("pls boo", 160, 1605, 300, 1650), T("ag3nt_penoy06", 160, 1680, 400, 1720), T("joined 👋", 160, 1722, 330, 1765), T("Say something…", 80, 1775, 690, 1860, 1)];
  const live = (n, price, timer, lead, next) => [...head, ...chat,
    ...(lead ? [T(lead, 100, 1880, 560, 1925), T("is winning!", 570, 1880, 770, 1925)] : []),
    T(`Card on screen #${n}`, 260, 1935, 650, 1985), T("Mint", 260, 1995, 340, 2040), T("$0.38 Shipping + Taxes", 260, 2050, 610, 2095),
    T("$" + price, 980, 1935, 1035, 1985), T(timer, 940, 1995, 1035, 2040), T("Custom", 160, 2160, 330, 2210, 1), T(`Bid $${next}`, 590, 2160, 740, 2210, 1)];
  const sold = (n, price, who) => [...head, ...chat, T(who, 100, 1880, 400, 1925), T("won!", 410, 1880, 480, 1925),
    T(`Card on screen #${n}`, 260, 1935, 650, 1985), T("Mint", 260, 1995, 340, 2040), T("$0.38 Shipping + Taxes", 260, 2050, 610, 2095),
    T("$" + price, 980, 1935, 1035, 1985), T("Sold", 960, 1995, 1035, 2040), T("Awaiting Next Item", 360, 2160, 720, 2210, 1),
    T(who, 330, 860, 750, 920), T("Won the auction!", 370, 940, 710, 990)];
  const sheet = (n, price) => [...head, T(`Card on screen #${n}`, 45, 1555, 440, 1600), T("$" + price, 930, 1550, 1000, 1600), T("+Ship/Tax", 880, 1600, 1035, 1640),
    T("00:02", 455, 1640, 560, 1690), T("$" + (price + 1), 480, 1730, 620, 1820), T("Max Bid", 45, 1910, 190, 1950), T("When on, we'll automatically place bids for you, up to this price.", 45, 1955, 840, 2040), T("Submit Max Bid", 380, 2160, 700, 2210, 1)];
  await page.evaluate(() => { window.__lots = []; window.__saves = []; window.addEventListener("message", (e) => { const d = e.data || {}; if (d.type === "cardcomp-lot-end") window.__lots.push(d.rec); if (d.type === "cardcomp-log-save") window.__saves.push(d.rec); }); });
  const feed = (items) => page.evaluate(([i, w, h]) => window.__phone.screen(i, w, h), [items, W, H]);
  const st1 = await page.evaluate(([i, w, h]) => window.__phone.readLotPhone(i, w, h), [live(140, 2, "00:08", "onestop_collectables", 3), W, H]);
  ok(st1.title === "Card on screen #140" && st1.cur === 2 && st1.timer === "00:08" && st1.lead === "onestop_collectables" && st1.next === 3 && st1.seller === "domvault_card" && st1.viewers === 39 && st1.ship === 0.38 && st1.cond === "NM",
    "live lot read: " + JSON.stringify({ title: st1.title, cur: st1.cur, timer: st1.timer, lead: st1.lead, next: st1.next, seller: st1.seller, viewers: st1.viewers, ship: st1.ship, cond: st1.cond }));
  // chat minimized (Derek's screenshot, gamecitytcg 2026-10-28): no chat box, the leader line sits right above the title
  const mini = [T("gamecitytcg", 158, 95, 370, 142), T("5.0", 208, 168, 256, 213), T("57", 873, 145, 911, 184),
    T("mexicanjocker is winning!", 101, 1845, 640, 1895), T("$1 Start Singles #183", 259, 1920, 677, 1973), T("New • Card", 259, 1990, 447, 2030),
    T("$0.78 Shipping + Taxes", 259, 2050, 650, 2095), T("$2", 983, 1920, 1035, 1973), T("00:00", 936, 1990, 1035, 2035),
    T("Custom", 160, 2160, 330, 2210, 1), T("Bid $3", 590, 2160, 740, 2210, 1)];
  const stm = await page.evaluate(([i, w, h]) => window.__phone.readLotPhone(i, w, h), [mini, W, H]);
  ok(stm.title === "$1 Start Singles #183" && stm.cur === 2 && stm.lead === "mexicanjocker" && stm.next === 3 && stm.ship === 0.78 && stm.timer === "00:00" && stm.seller === "gamecitytcg" && stm.cond === "NM",
    "chat minimized: lot still read: " + JSON.stringify({ title: stm.title, cur: stm.cur, lead: stm.lead, next: stm.next, ship: stm.ship, timer: stm.timer, seller: stm.seller, cond: stm.cond }));
  await feed(live(140, 2, "00:08", "onestop_collectables", 3));
  await page.waitForTimeout(200);
  const strip = await page.evaluate(() => { const el = document.querySelector("#lotstrip"); return { t: el ? el.textContent : "", shown: !!el && getComputedStyle(el).display !== "none" }; });
  ok(!strip.shown && /\$2/.test(strip.t) && /onestop_collec/.test(strip.t), "lot strip is read but hidden on the small card (prices and alerts only)");
  // Derek taps the NM bid of the card on screen while the lot runs (the compact card shows Charizard from the read)
  await page.evaluate(() => { const q = document.querySelector("#q"); q.value = "charizard 4/102"; run("charizard 4/102"); window.__phone.setMode("card"); });
  await page.waitForTimeout(800);
  await page.evaluate(() => document.querySelector('#phonebar .pb[data-c="NM"]').click());
  // the price passes the max Derek tapped: the small card says so
  await feed(live(140, 999, "00:05", "onestop_collectables", 1000)); await page.waitForTimeout(300);
  const al = await page.evaluate(() => (document.querySelector("#phonealert") || {}).textContent || "");
  ok(/over your \$\d+/.test(al), "alert on the small card: " + al);
  await page.waitForTimeout(2800);
  await feed(sheet(140, 5));
  await feed(live(140, 6, "00:01", "caydenarterbury", 7));
  await feed(sold(140, 6, "caydenarterbury"));
  await page.waitForTimeout(3500);   // the app waits 2.5 s for late taps before logging
  await feed(live(141, 2, "00:10", "", 3));
  await page.waitForTimeout(300);
  const lots = await page.evaluate(() => window.__lots.filter((r) => !r.empty));
  const L = lots[0] || {};
  ok(lots.length === 1 && L.title === "Card on screen #140" && L.final === 6 && L.winner === "caydenarterbury" && L.sold === true && L.leaders.join() === "onestop_collectables,caydenarterbury",
    "lot ended once with winner, final and leaders: " + JSON.stringify({ n: lots.length, title: L.title, final: L.final, winner: L.winner, leaders: L.leaders, src: L.src }));
  const saves = await page.evaluate(() => window.__saves);
  ok(saves.length >= 1 && saves[0].card && /charizard/i.test(saves[0].card.n || "") && saves[0].card.cond === "NM", "logged with the tapped card: " + (saves[0] && saves[0].card ? `${saves[0].card.n} ${saves[0].card.cond} max $${saves[0].card.myMax}` : "none"));
  // Derek wins the next one: "You won" in the middle + "rewired won!" learns his name
  await feed([...sold(141, 9, "rewired"), T("You won", 400, 1000, 700, 1050)]);
  await page.waitForTimeout(3500);
  const me = await page.evaluate(() => ({ lots: window.__lots.filter((r) => !r.empty), user: localStorage.getItem("cardcomp_wn_user") }));
  const L2 = me.lots[1] || {};
  ok(L2.me === true && L2.final === 9 && me.user == null, `own win counted from "You won", no username learned (2026-10-31: the phone once stored another bidder as Derek): ${JSON.stringify({ me: L2.me, final: L2.final, user: me.user })}`);
  // automatic read: once, ~1 s after a new lot's timer starts, only in auto mode
  const g0 = (await calls()).filter((x) => x.n === "grab").length;
  await feed(live(142, 2, "00:12", "", 3)); await page.waitForTimeout(1400);
  const g1 = (await calls()).filter((x) => x.n === "grab").length;
  await page.evaluate(() => { window.__mode = "auto"; });
  await feed(sold(142, 4, "someone_else")); await page.waitForTimeout(200);
  await feed(live(143, 2, "00:12", "", 3)); await feed(live(143, 2, "00:11", "", 3)); await page.waitForTimeout(1400);
  const g2 = (await calls()).filter((x) => x.n === "grab").length;
  await page.evaluate(() => { window.__mode = "manual"; window.__phone.frameFail(window.__lastReq, "test: no frame"); });   // the mock never sends the frame
  ok(g1 === g0 && g2 === g1 + 1, `auto read: none in manual mode, exactly one per lot in auto mode (${g0} -> ${g1} -> ${g2})`);

  // a sold screen that flickers back to a timer restarts the same lot; it must not log twice (rudeboi75404 #79, 2026-10-23)
  await feed(live(144, 3, "00:02", "x_bidder", 4)); await feed(sold(144, 3, "x_bidder"));
  await feed(live(144, 3, "00:12", "", 4)); await feed(sold(144, 3, "x_bidder")); await feed(live(145, 2, "00:10", "", 3));
  await page.waitForTimeout(200);
  const g144 = await page.evaluate(() => window.__lots.filter((r) => !r.empty && r.title === "Card on screen #144").length);
  ok(g144 === 1, `same lot after a flicker of the sold screen: logged once (${g144})`);

  // 2026-10-31 audit (fixtures from real phone dumps, names made up)
  const rd = (items) => page.evaluate(([i, w, h]) => window.__phone.readLotPhone(i, w, h), [items, W, H]);
  // sudden death: "💀 00:14" on the lot card, "00:02 💀" / "+0s" / "What is Max Bid?" on the Custom sheet
  const sd = await rd(live(146, 2, "💀 00:14", "", 3));
  ok(sd.timer === "00:14" && sd.sub === "Mint" && sd.cond === "NM", `sudden death timer read: ${JSON.stringify({ timer: sd.timer, sub: sd.sub, cond: sd.cond })}`);
  const sheetSD = (title, price) => [...head, T(title, 45, 1554, 841, 1607), T("$" + price, 935, 1534, 987, 1587), T("+Ship/Tax", 886, 1587, 1035, 1626), T("+0s", 508, 1602, 572, 1649),
    T("00:02 💀", 456, 1649, 625, 1702), T("Decrement bid", 133, 1784, 172, 1790), T("$" + (price + 1), 259, 1720, 821, 1855, 1), T("Increment bid", 900, 1759, 956, 1815),
    T("Max Bid", 45, 1917, 165, 1964), T("What is Max Bid?", 165, 1873, 300, 1970, 1), T("When on, we'll automatically place bids for you, up to this price.", 45, 1970, 855, 2064), T("Submit Max Bid", 388, 2166, 693, 2219, 1)];
  const ss = await rd(sheetSD("$3 Max Ship Sudden Death Singles #18", 2));
  ok(ss.title === "$3 Max Ship Sudden Death Singles #18" && ss.sub === "" && ss.cond === "" && ss.timer === "00:02" && ss.cur === 2, `Custom sheet: timer, no sheet text as the condition line: ${JSON.stringify({ title: ss.title, sub: ss.sub, timer: ss.timer, cur: ss.cur })}`);
  // condition line by its first word ("Light Played • Card" was blank, then priced as NM)
  const condCases = [["Light Played • Card", "LP"], ["Lightly Played", "LP"], ["Moderately Played • Card", "MP"], ["Heavily Played", "HP"], ["Damaged • Card", "DMG"], ["Near Mint • Card", "NM"], ["New • Card", "NM"], ["Mint", "NM"], ["Card", ""], ["all sales final, condition shown on screen. Goodluck!", ""]];
  const condGot = [];
  for (const [c] of condCases) condGot.push((await rd(live(146, 2, "00:08", "", 3).map((x) => x.t === "Mint" ? Object.assign({}, x, { t: c }) : x))).cond);
  ok(condCases.every(([, want], i) => condGot[i] === want), "conditions: " + condCases.map(([c], i) => `${c.slice(0, 20)} -> ${condGot[i] || "-"}`).join(" | "));

  // opening the Custom sheet: one read with another title must not split the lot (domvault_card #83, rudeboi75404 #110)
  const meLead = (n, price, timer, next) => [...live(n, price, timer, "", next), T("You're winning!", 101, 1880, 364, 1925)];
  const soldMe = (n, price) => [...head, ...chat, T("You won!", 101, 1880, 261, 1925),
    T(`Card on screen #${n}`, 260, 1935, 650, 1985), T("Mint", 260, 1995, 340, 2040), T("$0.38 Shipping + Taxes", 260, 2050, 610, 2095),
    T("$" + price, 980, 1935, 1035, 1985), T("Sold", 960, 1995, 1035, 2040), T("Awaiting Next Item", 360, 2160, 720, 2210, 1)];
  await feed(sold(145, 2, "bidder_b")); await page.waitForTimeout(3000);
  await feed(live(150, 2, "00:09", "bidder_one", 3));
  await page.evaluate(() => { const q = document.querySelector("#q"); q.value = "charizard 4/102"; run("charizard 4/102"); window.__phone.setMode("card"); });
  await page.waitForTimeout(800);
  await page.evaluate(() => document.querySelector('#phonebar .pb[data-c="NM"]').click());
  await feed(live(150, 2, "00:08", "bidder_one", 3).map((x) => x.t === "Card on screen #150" ? Object.assign({}, x, { t: "Card on screen #1" }) : x));   // the sheet animating in
  await page.waitForTimeout(150);
  await feed(sheet(150, 3)); await feed(meLead(150, 4, "00:03", 5)); await feed(soldMe(150, 4));
  await page.waitForTimeout(3500);
  const l150 = await page.evaluate(() => ({ lots: window.__lots.filter((r) => !r.empty && /#(150|1)$/.test(r.title)), saves: window.__saves.filter((r) => /#150$/.test(r.title)) }));
  const W150 = l150.lots[0] || {};
  ok(l150.lots.length === 1 && W150.title === "Card on screen #150" && W150.me === true && W150.sold === true && W150.iLed === true && W150.hist.some((h) => h.u === "me") && W150.leaders.includes("me"),
    `a short-lived title while the sheet opens: one lot, won, Derek's lead in the hand history: ${JSON.stringify(l150.lots.map((r) => ({ t: r.title, me: r.me, sold: r.sold, iLed: r.iLed, hist: r.hist.map((h) => h.u) })))}`);
  ok(l150.saves.length === 1 && l150.saves[0].card && /charizard/i.test(l150.saves[0].card.n || ""), "the win keeps the tapped card: " + (l150.saves[0] && l150.saves[0].card ? l150.saves[0].card.n : "none"));
  // "You won!" alone is a win, not proof of a lead seen
  await feed(live(151, 2, "00:05", "bidder_two", 3)); await feed(soldMe(151, 6)); await page.waitForTimeout(300);
  const W151 = await page.evaluate(() => window.__lots.filter((r) => !r.empty && r.title === "Card on screen #151")[0] || {});
  ok(W151.me === true && W151.iLed === false && !W151.hist.some((h) => h.u === "me"), `win with no lead seen: me, iLed false: ${JSON.stringify({ me: W151.me, iLed: W151.iLed, hist: (W151.hist || []).map((h) => h.u) })}`);
  // no Sold seen (Derek left the stream while leading): no winner, not his, ends when last seen
  await page.waitForTimeout(3000);
  await feed(live(152, 5, "00:04", "bidder_three", 6)); await feed(meLead(152, 7, "00:02", 8));
  const t152 = await page.evaluate(() => Date.now());
  await page.waitForTimeout(700);
  await feed(live(153, 2, "00:10", "", 3)); await page.waitForTimeout(1100); await feed(live(153, 2, "00:09", "", 3));
  await page.waitForTimeout(200);
  const U152 = await page.evaluate(() => window.__lots.filter((r) => !r.empty && r.title === "Card on screen #152")[0] || {});
  ok(U152.sold === false && U152.winner === "" && U152.me === false && U152.iLed === true && U152.final === 7 && U152.at <= t152 + 50,
    `lot gone without a Sold: no winner, not a win, at = last seen: ${JSON.stringify({ sold: U152.sold, winner: U152.winner, me: U152.me, iLed: U152.iLed, final: U152.final, atLag: U152.at - t152 })}`);
  // the app sends only what is on screen (a hidden "Sold" under the keyboard read as a sale)
  const wkt = fs.readFileSync(path.join(ROOT, "android/app/src/main/java/io/github/pmderek/cardcomp/WhatnotReader.kt"), "utf8");
  const ps = wkt.slice(wkt.indexOf("private fun pushScreen"), wkt.indexOf("private val AUCTION"));
  ok(/if \(!n\.node\.isVisibleToUser\) continue/.test(ps), "pushScreen skips nodes not visible to the user");

  // condition link: fast read tried through the app first; the browser opens only because it failed here
  const b6 = (await calls()).length;
  await page.evaluate(() => { window.postMessage({ type: "cardcomp-tcg-fast", req: 1, pid: "42382", printing: "Holofoil", cond: "LP" }, location.origin); window.postMessage({ type: "cardcomp-open-bg", url: "https://www.tcgplayer.com/product/42382?Printing=Holofoil&Condition=Lightly+Played" }, location.origin); });
  await page.waitForTimeout(1500);
  const c6 = (await calls()).slice(b6);
  ok(c6.some((x) => x.n === "http" && /tcgplayer/.test(x.a[1])) && c6.some((x) => x.n === "open"), "condition link: fast read through the app, browser only after it failed (" + c6.filter((x) => x.n === "http").length + " requests)");

  console.log("9. printing chips (Holo / Reverse / Poké Ball / Master Ball)");
  await page.evaluate(() => { const q = document.querySelector("#q"); q.value = "sylveon 040/131"; run("sylveon 040/131"); window.__phone.setMode("card"); });
  await page.waitForTimeout(900);
  const pc0 = await page.evaluate(() => ({ chips: Array.from(document.querySelectorAll("#phonebar .pq")).map((x) => x.textContent), on: (document.querySelector("#phonebar .pq.on") || {}).textContent || "", name: (document.querySelector("#phonebar .pn b") || {}).textContent }));
  ok(pc0.name === "Sylveon" && pc0.chips.length === 4 && pc0.chips.some((t) => /^Reverse/.test(t)) && pc0.chips.some((t) => /^Master/.test(t)), "small card shows every printing as a chip: " + pc0.chips.join(" | ") + " (on: " + pc0.on + ")");
  // a reading that saw a reverse holo starts the card on Reverse
  await page.evaluate(() => { document.querySelector("#q").value = ""; run(""); });
  await page.waitForTimeout(200);
  await page.evaluate(() => { window.autoMatch({ name: "Sylveon", number: "040", total: "131", language: "en", rarity: "Common", finish: "reverse holo", set: "Prismatic Evolutions", card_visible: true, confidence: 0.9 }, {}); });
  await page.evaluate(() => { const q = document.querySelector("#q"); q.value = "sylveon 040/131"; run("sylveon 040/131"); window.__phone.setMode("card"); });
  await page.waitForTimeout(900);
  const pc2 = await page.evaluate(() => ({ on: (document.querySelector("#phonebar .pq.on") || {}).textContent || "", rd: (document.querySelector("#phonebar .pq.rd") || {}).textContent || "" }));
  ok(/^Reverse/.test(pc2.on), "a reverse-holo read starts the card on Reverse: " + JSON.stringify(pc2));
  ok(/^Reverse/.test(pc2.rd), "the printing the read saw is marked (dashed): " + pc2.rd);

  await page.evaluate(() => [...document.querySelectorAll("#phonebar .pq")].find((x) => /^Poké Ball/.test(x.textContent)).click());
  await page.waitForTimeout(400);
  const pc1 = await page.evaluate(() => ({ on: (document.querySelector("#phonebar .pq.on") || {}).textContent || "", open: (document.querySelector("#results .card.open .pchip.on") || {}).textContent || "",
    pill: (document.querySelector('#phonebar .pb[data-c="NM"] b') || {}).textContent, grid: (document.querySelector("#results .card.open .condgrid .bd.cpy[data-cond='NM']") || {}).dataset.bid }));
  await page.screenshot({ path: path.join(OUT, "phone-printing-chips.png") });
  ok(/^Poké Ball/.test(pc1.on) && /Pok/.test(pc1.open) && pc1.pill === "$" + pc1.grid, `tap Poké Ball: the open card switches and the NM pill reprices ($${pc1.grid}, ${pc1.open})`);
  console.log("8. zoom (Derek's screenshots: the page stayed magnified after the panel's width changed)");
  await page.evaluate(() => window.__phone.setMode("list")); await fit(560);
  await page.evaluate(() => window.__phone.setMode("card")); await fit();
  const vs = await page.evaluate(() => ({ scale: visualViewport.scale, vp: document.querySelector('meta[name="viewport"]').content }));
  ok(vs.scale === 1 && /maximum-scale=1/.test(vs.vp), `page scale stays 1 across full view -> small card (${vs.scale}; ${vs.vp})`);
  await page.screenshot({ path: path.join(OUT, "phone-card-after-resize.png") });
  // pinch with two fingers (DevTools touch events)
  const cdp = await ctx.newCDPSession(page);
  const touch = async (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i })) });
  const pinch = async (d0, d1) => { await touch("touchStart", [[125 - d0 / 2, 60], [125 + d0 / 2, 60]]); for (let k = 1; k <= 6; k++) { const d = d0 + (d1 - d0) * k / 6; await touch("touchMove", [[125 - d / 2, 60], [125 + d / 2, 60]]); } await touch("touchEnd", []); await page.waitForTimeout(250); };
  const hz0 = await page.evaluate(() => window.__h);
  await pinch(60, 90);
  const z1 = await page.evaluate(() => ({ z: window.__phone.zoom(), h: window.__h, saved: localStorage.getItem("cardcomp_phone_zoom") }));
  ok(z1.z > 1.3 && z1.h > hz0 * 1.3 && z1.saved == String(z1.z), `pinch apart: contents ${z1.z}x, panel ${hz0} -> ${z1.h} px, remembered`);
  const bc = (await calls()).filter((x) => x.n === "collapse").length;
  await pinch(120, 20);
  const z2 = await page.evaluate(() => window.__phone.zoom());
  ok((await calls()).filter((x) => x.n === "collapse").length === bc + 1 && z2 === z1.z, `pinch shut past the smallest size: folds into the bubble, size kept (${z2}x)`);
  await page.evaluate(() => { localStorage.setItem("cardcomp_phone_zoom", "1"); }); await pinch(90, 60); await page.evaluate(() => { while (window.__phone.zoom() > 1.02) break; });

  console.log("7. getting back to the small card");
  await page.evaluate(() => { window.__phone.setMode("list"); });
  await page.evaluate(() => { const r = document.querySelectorAll("#results .card .row")[1]; r.querySelector(".nm").click(); });
  await page.waitForTimeout(300);
  const back = await page.evaluate(() => ({ mode: window.__phone.mode(), name: document.querySelector("#phonebar .pn b").textContent, second: (document.querySelectorAll("#results .card .nm")[1] || {}).textContent }));
  ok(back.mode === "card" && back.second.startsWith(back.name), `a result tapped in the full view: small card showing it (${back.name})`);
  await page.evaluate(() => { window.__phone.setMode("list"); window.__phone.outside(); });
  ok(await page.evaluate(() => window.__phone.mode()) === "card", "a touch outside the panel: back to the small card");
  await page.evaluate(() => document.querySelector('#phonebar [data-t="search"]').click()); await page.waitForTimeout(100);
  await page.evaluate(() => { window.__phone.outside(); window.__phone.blur(); }); await page.waitForTimeout(300);
  ok(await page.evaluate(() => window.__phone.mode()) === "card", "a touch outside while typing: back to the small card too");

  console.log("5. links");
  const b5 = (await calls()).length;
  await page.evaluate(() => { const a = document.createElement("a"); a.href = "https://www.tcgplayer.com/product/42?Printing=Unlimited"; a.textContent = "x"; document.body.appendChild(a); a.click(); });
  await page.waitForTimeout(200);
  c = (await calls()).slice(b5);
  ok(c.some((x) => x.n === "open" && /tcgplayer\.com\/product\/42/.test(x.a[0])), "TCGplayer link -> Android.open");
  ok(page.url().startsWith(base), "page did not navigate");

  ok(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} FAILED` : "\nall ok");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
