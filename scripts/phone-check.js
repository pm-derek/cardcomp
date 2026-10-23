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
      cfg() { rec("cfg", []); return JSON.stringify({ ver: "0.1.0", build: "test", model: "sonnet", mode: "manual", hasKey: true, hasToken: false, reader: true, capture: true, w: 1080, h: 2340 }); },
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
      dump() { rec("dump", []); }
    };
  });
  await page.goto(base + "/");
  await page.waitForFunction(() => typeof CARDS !== "undefined" && CARDS.length > 1000, null, { timeout: 60000 });
  // what OverlayService does after the page loads
  const bundle = fs.readFileSync(path.join(ROOT, "extension/recog/recog-read.js"), "utf8") + "\n;\n" + fs.readFileSync(path.join(ROOT, "phone/bridge.js"), "utf8");
  await page.addScriptTag({ content: bundle });   // what OverlayService injects (both files, top level)
  await page.waitForFunction(() => !!window.__phone && typeof window.recogRead === "function", null, { timeout: 10000 });
  await page.waitForTimeout(400);
  const calls = () => page.evaluate(() => window.__calls);
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
  ok(/no card yet/.test(h.bar), "card line before any read: " + h.bar.trim());
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
  ok(/charizard/i.test(r2.stat) && /frame/.test(r2.stat), "status line says what was read, with the frame link: " + r2.stat.trim().slice(0, 90));
  const h2 = await fit();
  ok(h2 < 140, "compact card with a result stays small: " + h2 + " css px");
  await page.screenshot({ path: path.join(OUT, "phone-card.png") });
  // step through the candidates
  const step = await page.evaluate(() => { const a = document.querySelector("#phonebar .pn b").textContent + " " + document.querySelector("#phonebar .pn span").textContent; document.querySelector('#phonebar [data-t="next"]').click(); return new Promise((r) => setTimeout(() => r([a, document.querySelector("#phonebar .pn b").textContent + " " + document.querySelector("#phonebar .pn span").textContent, (document.querySelector("#phonebar .sn") || {}).textContent]), 50)); });
  ok(step[0] !== step[1] && step[2] === "2/" + r2.n, `› steps to the next candidate: ${step[1]} (${step[2]})`);
  await page.evaluate(() => document.querySelector('#phonebar [data-t="prev"]').click());
  // list mode
  await page.evaluate(() => document.querySelector('#phonebar [data-t="toggle"]').click());
  const lm = await page.evaluate(() => ({ list: document.body.classList.contains("ph-list"), res: getComputedStyle(document.querySelector("#results")).display !== "none", q: getComputedStyle(document.querySelector("#q")).display !== "none" }));
  ok(lm.list && lm.res && lm.q, "▾ opens the list: search box and results shown");
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
