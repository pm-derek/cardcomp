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
  const fit = async (cap) => { await page.waitForTimeout(250); const h = await page.evaluate(() => window.__h || 100); await page.setViewportSize({ width: 360, height: Math.min(h, cap || 9999) }); await page.waitForTimeout(150); return h; };

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
  await page.evaluate(() => {
    const cv = document.createElement("canvas"); cv.width = 64; cv.height = 96; const g = cv.getContext("2d"); g.fillStyle = "#c33"; g.fillRect(0, 0, 64, 96);
    window.__phone.frame(window.__lastReq, cv.toDataURL("image/jpeg", 0.8), 720, 1560);
  });
  await page.waitForFunction(() => document.querySelectorAll("#results .card").length > 0, null, { timeout: 10000 });
  await page.waitForTimeout(500);
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
  ok(r2.card && c.some((x) => x.n === "layout" && x.a[0] === "card"), "after the read: compact card, panel shown");
  ok(r2.stat === "", "the small card stays quiet after a good read (the read line is in the full view)");
  const h2 = await fit();
  ok(h2 > 60 && h2 < 120, "compact card with a result: thumbnail + 4 condition buttons, " + h2 + " css px");
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll("#phonebar .pb")).map((r) => ({ c: r.dataset.c, bid: r.querySelector("b").textContent.trim(), px: r.querySelector("small").textContent.trim() })));
  ok(rows.length === 4 && rows.every((x) => /^\$\d+$/.test(x.bid) && /^\$[\d,.]+$/.test(x.px)), "condition buttons mirror the grid: " + rows.map((x) => `${x.c} ${x.bid} (${x.px})`).join(" | "));
  const gridNM = await page.evaluate(() => { const b = document.querySelector("#results .card.open .condgrid .bd.cpy[data-cond='NM']"); return b ? b.textContent.trim() : ""; });
  ok(gridNM && rows[0].bid === "$" + Math.floor(parseFloat(gridNM.replace(/[^0-9.]/g, ""))), "NM bid equals the full grid's NM bid, whole dollars: " + gridNM);
  await page.screenshot({ path: path.join(OUT, "phone-card.png") });
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
  await page.click("#phonebar .pb");
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
  await page.click('#phonebar .pb[data-c="LP"]');
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


  console.log("4. keyboard rule");
  const b4 = (await calls()).length;
  await page.click('#phonebar [data-t="search"]');   // 🔍 opens the list and focuses the box
  await page.waitForTimeout(100);
  c = (await calls()).slice(b4);
  ok(c.some((x) => x.n === "focus" && x.a[0] === true), "focus(true) when the search box takes focus");
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
  await page.click('#phonebar [data-t="search"]');
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
  await feed(live(140, 2, "00:08", "onestop_collectables", 3));
  await page.waitForTimeout(200);
  const strip = await page.evaluate(() => { const el = document.querySelector("#lotstrip"); return { t: el ? el.textContent : "", shown: !!el && getComputedStyle(el).display !== "none" }; });
  ok(strip.shown && /\$2/.test(strip.t) && /onestop_collec/.test(strip.t), "lot strip shows on the small card: " + strip.t.replace(/\s+/g, " ").trim().slice(0, 100));
  // Derek taps the NM bid of the card on screen while the lot runs (the compact card shows Charizard from the read)
  await page.evaluate(() => { const q = document.querySelector("#q"); q.value = "charizard 4/102"; run("charizard 4/102"); window.__phone.setMode("card"); });
  await page.waitForTimeout(800);
  await page.click('#phonebar .pb[data-c="NM"]');
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
  ok(L2.me === true && L2.final === 9 && me.user === "rewired", `own win counted, username learned: ${JSON.stringify({ me: L2.me, final: L2.final, user: me.user })}`);
  // automatic read: once, ~1 s after a new lot's timer starts, only in auto mode
  const g0 = (await calls()).filter((x) => x.n === "grab").length;
  await feed(live(142, 2, "00:12", "", 3)); await page.waitForTimeout(1400);
  const g1 = (await calls()).filter((x) => x.n === "grab").length;
  await page.evaluate(() => { window.__mode = "auto"; });
  await feed(sold(142, 4, "someone_else")); await page.waitForTimeout(200);
  await feed(live(143, 2, "00:12", "", 3)); await feed(live(143, 2, "00:11", "", 3)); await page.waitForTimeout(1400);
  const g2 = (await calls()).filter((x) => x.n === "grab").length;
  await page.evaluate(() => { window.__mode = "manual"; });
  ok(g1 === g0 && g2 === g1 + 1, `auto read: none in manual mode, exactly one per lot in auto mode (${g0} -> ${g1} -> ${g2})`);

  // condition link: fast read tried through the app first; the browser opens only because it failed here
  const b6 = (await calls()).length;
  await page.evaluate(() => { window.postMessage({ type: "cardcomp-tcg-fast", req: 1, pid: "42382", printing: "Holofoil", cond: "LP" }, location.origin); window.postMessage({ type: "cardcomp-open-bg", url: "https://www.tcgplayer.com/product/42382?Printing=Holofoil&Condition=Lightly+Played" }, location.origin); });
  await page.waitForTimeout(1500);
  const c6 = (await calls()).slice(b6);
  ok(c6.some((x) => x.n === "http" && /tcgplayer/.test(x.a[1])) && c6.some((x) => x.n === "open"), "condition link: fast read through the app, browser only after it failed (" + c6.filter((x) => x.n === "http").length + " requests)");

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
