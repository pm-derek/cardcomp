// Checks for the feedback thank-yous (extension/feedback/). No network. Run: node scripts/feedback-check.js
//  1. feedback-bg.js fbDraft against a mocked API: request shape (model, effort, fallbacks, system, the row) and the text / refusal / error paths.
//  2. feedback.js on a mock of the Seller Portal Feedback tab in headless Chromium (chrome.* stubbed): rows filtered to
//     worded + named + last 14 days, done list honoured, pages fetched until old, Send / Skip wiring, failure path.
//  3. order.js on a mock of the order page's Contact Buyer drawer (Vue-like: subject combobox, textarea, Send): reports
//     the order on load, fills and sends, reports the right failures.
const assert = require("assert"), fs = require("fs"), path = require("path"), vm = require("vm");
const EXT = path.join(__dirname, "..", "extension");
let n = 0; const ok = (name) => { n++; console.log("  ok  " + name); };
const today = new Date(), mdy = (d) => (d.getMonth() + 1) + "/" + d.getDate() + "/" + d.getFullYear();
const daysAgo = (k) => { const d = new Date(today); d.setDate(d.getDate() - k); return mdy(d); };

async function bgTests() {
  console.log("1. feedback-bg.js");
  const calls = [];
  let reply = { stop_reason: "end_turn", model: "claude-opus-5-5", usage: { input_tokens: 500, output_tokens: 40 }, content: [{ type: "thinking", thinking: "" }, { type: "text", text: "\"Thanks so much, glad the Samurott V got there fast!\"" }] };
  let status = 200;
  const store = { recogKey: "sk-ant-test" };
  const ctx = { console, setTimeout, clearTimeout, JSON, Object, Promise, String, Array, Error,
    fetch: async (url, opt) => { calls.push({ url, opt }); return { ok: status === 200, status, json: async () => reply, text: async () => JSON.stringify({ error: { message: "nope" } }) }; },
    chrome: { storage: { local: { get: (k, cb) => cb(store) }, session: { get: (k, cb) => cb({}), set: () => {} } }, tabs: {} } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(EXT, "feedback", "feedback-bg.js"), "utf8") + "\nthis.fbDraft = fbDraft; this.fbHandle = fbHandle;", ctx);
  const row = { order: "1-A", user: "david b0501", rating: 5, comment: "Card in excellent condition. Good packaging.", date: "10/27/2026", products: ["Pokemon - SWSH: Crown Zenith: Galarian Gallery: Hisuian Samurott V - #GG51/GG70 - Near Mint Holofoil"], fbDate: "11/2/2026" };
  let r = await ctx.fbDraft(row);
  assert.strictEqual(r.ok, true); assert.strictEqual(r.text, "Thanks so much, glad the Samurott V got there fast!"); ok("draft text (quotes stripped, thinking block ignored)");
  const b = JSON.parse(calls[0].opt.body), h = calls[0].opt.headers;
  assert.strictEqual(b.model, "claude-opus-5-5"); assert.deepStrictEqual(b.output_config, { effort: "low" }); assert.strictEqual(b.fallbacks, "default");
  assert.strictEqual(h["anthropic-beta"], "server-side-fallback-2026-07-01"); assert.strictEqual(h["x-api-key"], "sk-ant-test"); assert.ok(!("thinking" in b), "thinking omitted");
  ok("request: opus 5.5, effort low, fallbacks default + beta header, key");
  assert.ok(/East Bay Trader/.test(b.system) && /Amazing, glad it arrived quickly/.test(b.system)); assert.ok(/Feedback: Card in excellent condition/.test(b.messages[0].content) && /Hisuian Samurott V/.test(b.messages[0].content) && /Feedback left: 11\/2\/2026/.test(b.messages[0].content));
  ok("system carries the voice samples, user turn carries feedback + cards + dates");
  assert.ok(Math.abs(r.cost - (500 * 4 + 40 * 20) / 1e6) < 1e-9); ok("cost from usage");
  reply = { stop_reason: "refusal", content: [] }; r = await ctx.fbDraft(row); assert.strictEqual(r.ok, false); assert.ok(/declined/.test(r.why)); ok("refusal -> write by hand");
  status = 401; r = await ctx.fbDraft(row); assert.strictEqual(r.ok, false); assert.ok(/401/.test(r.why)); ok("HTTP 401 reported");
  status = 200; store.recogKey = ""; r = await ctx.fbDraft(row); assert.strictEqual(r.ok, false); assert.strictEqual(r.nokey, true); ok("no key -> nokey");
  // fbHandle: order-info resolves a waiting cardcomp-fb-order; key check
  store.recogKey = "sk-ant-test";
  let got; ctx.fbHandle({ type: "cardcomp-fb-key" }, {}, (x) => { got = x; }); await new Promise((r) => setTimeout(r, 5)); assert.strictEqual(JSON.stringify(got), JSON.stringify({ ok: true })); ok("cardcomp-fb-key");
  assert.strictEqual(ctx.fbHandle({ type: "cardcomp-bid" }, {}, () => {}), false); ok("other messages fall through");
}

async function pageTests() {
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  try {
    console.log("2. feedback.js on a mock Feedback tab");
    const tr = (o, date, rating, comment, user) => `<tr class="gradeA"><td style="white-space: nowrap;">East Bay Trader</td><td><div><div><a href="https://store.tcgplayer.com/admin/Orders/ManageOrder/${o}">${o}</a></div></div></td><td>${date}</td><td>${rating}</td><td>${comment === null ? "<i>No Comment Left</i>" : comment}</td><td>${user}</td></tr>`;
    const table = (rows) => `<div class="widget"><div class="title"><h6>Feedback List</h6></div><table class="display dTable"><thead><tr><th>Seller</th><th>Order Number</th><th>Order Date</th><th>Rating</th><th>Feedback</th><th>User</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
    const page1 = `<!doctype html><html><head><title>Feedback</title></head><body><div><h4 class="blueHeader">My Feedback</h4>Related Help Files: <a href="#">Feedback</a><p></p><div class="widget"><div class="title"><h6>Feedback Ratings</h6></div></div>${table([
      tr("A-1", daysAgo(1), 5, "Got here super fast and in great condition. Thank you!", "robert s78A1F72"),
      tr("A-2", daysAgo(2), 5, null, "tony g8253"),
      tr("A-3", daysAgo(3), 5, "Fast shipping", ""),
      tr("A-4", daysAgo(5), 4, "The cards are exactly as described.", "andy a2133"),
      tr("A-5", daysAgo(6), 5, "Great seller", "done d1"),
      tr("A-1", daysAgo(1), 5, "Got here super fast and in great condition. Thank you!", "robert s78A1F72")])}</div></body></html>`;
    const page2 = `<!doctype html><html><body>${table([tr("B-1", daysAgo(9), 5, "Excellent seller, my order got messed up but they fixed it", "stevie r3006"), tr("B-2", daysAgo(20), 5, "Old one", "old o1")])}</body></html>`;
    const page3 = `<!doctype html><html><body>${table([tr("C-1", daysAgo(30), 5, "Older still", "older o2")])}</body></html>`;
    const ctx = await browser.newContext();
    const log = { msgs: [], pages: [] }, store = { fbDone: { "A-5": { at: Date.now(), how: "sent" } } };
    await ctx.exposeFunction("__msg", (m) => { log.msgs.push(m); });
    await ctx.route("**/admin/Seller/Feedback*", (route) => {
      const u = new URL(route.request().url()), p = u.searchParams.get("page") || "1"; log.pages.push(p);
      route.fulfill({ contentType: "text/html", body: p === "1" ? page1 : p === "2" ? page2 : page3 });
    });
    const page = await ctx.newPage();
    page.on("console", (m) => { if (process.env.DBG) console.log("  console:", m.text()); }); page.on("pageerror", (e) => console.log("  pageerror:", e.message));
    await page.addInitScript(({ store }) => {
      const S = store, done = {};
      window.__sendFail = false;
      window.chrome = { runtime: { getURL: (p) => "chrome-extension://x/" + p, lastError: null,
        sendMessage: (m, cb) => { window.__msg(m); setTimeout(() => {
          if (m.type === "cardcomp-fb-key") return cb({ ok: true });
          if (m.type === "cardcomp-fb-order") return cb(m.order === "A-4" ? { ok: false, why: "did not load" } : { ok: true, info: { order: m.order, products: ["Pokemon - SWSH: Crown Zenith: Galarian Gallery: Hisuian Samurott V - #GG51/GG70 - Near Mint Holofoil", "Pokemon - SV: Prismatic Evolutions: Umbreon ex - #161/131 - Near Mint Holofoil", "Pokemon - Base Set: Charizard - #4/102 - Lightly Played Holofoil"], feedback: "", fbDate: "11/5/2026", buyer: "X" } });
          if (m.type === "cardcomp-fb-draft") return cb({ ok: true, text: "Thanks " + m.row.user + "!", cost: 0.004 });
          if (m.type === "cardcomp-fb-send") return cb(window.__sendFail ? { ok: false, why: "Send did not go through" } : { ok: true });
          cb(null); }, 5); } },
        storage: { local: { get: (k, cb) => cb({ fbDone: S.fbDone }), set: (o, cb) => { Object.assign(S, o); cb && cb(); } } } };
      window.__store = S;
    }, { store });
    await page.goto("https://store.tcgplayer.com/admin/Seller/Feedback");
    await page.addScriptTag({ path: path.join(EXT, "feedback", "feedback.js") });
    try { await page.waitForFunction(() => /drafted/.test(document.querySelector("#ccfbst")?.textContent || ""), null, { timeout: 15000 }); }
    catch (e) { console.log("  status:", await page.evaluate(() => document.querySelector("#ccfbst")?.textContent), "msgs:", JSON.stringify(log.msgs.map((m) => m.type))); throw e; }
    const orders = await page.$$eval("#ccfb .row", (els) => els.map((e) => e.dataset.order));
    assert.deepStrictEqual(orders, ["A-1", "A-4", "B-1"]); ok("candidates: worded + named + last 14 days, done list and duplicates dropped, page 2 read (" + orders.join(", ") + ")");
    assert.deepStrictEqual(log.pages.filter((p) => p !== "1"), ["2", "3"]); ok("fetched page 2 and 3, stopped once a page was all old");
    const card = await page.$eval('#ccfb .row[data-order="A-1"] [data-card]', (e) => e.textContent);
    assert.strictEqual(card, "Hisuian Samurott V, Umbreon ex +1"); ok("card line: short names, +N");
    const drafts = await page.$$eval("#ccfb textarea", (els) => els.map((e) => e.value));
    assert.deepStrictEqual(drafts, ["Thanks robert s78A1F72!", "Thanks andy a2133!", "Thanks stevie r3006!"]); ok("a draft per row, also when the order page did not load");
    const draftRow = log.msgs.find((m) => m.type === "cardcomp-fb-draft" && m.row.order === "A-1").row;
    assert.strictEqual(draftRow.products.length, 3); assert.strictEqual(draftRow.fbDate, "11/5/2026"); ok("draft request carries the order's cards and feedback date");
    assert.ok(/4 worded in the last 14 days/.test(await page.$eval("#ccfbfoot", (e) => e.textContent)) && /replied from here: 1/.test(await page.$eval("#ccfbfoot", (e) => e.textContent))); ok("footer counts");
    // edit then send A-1
    await page.fill('#ccfb .row[data-order="A-1"] textarea', "Edited thanks!");
    await page.click('#ccfb .row[data-order="A-1"] [data-send]');
    await page.waitForFunction(() => /✓ sent/.test(document.querySelector('#ccfb .row[data-order="A-1"]').textContent));
    const sent = log.msgs.find((m) => m.type === "cardcomp-fb-send");
    assert.deepStrictEqual(sent, { type: "cardcomp-fb-send", order: "A-1", text: "Edited thanks!" }); ok("Send posts the edited text for that order");
    const st = await page.evaluate(() => window.__store.fbDone);
    assert.strictEqual(st["A-1"].how, "sent"); assert.strictEqual(st["A-1"].text, "Edited thanks!"); ok("done list: sent");
    await page.click('#ccfb .row[data-order="A-4"] [data-skip]');
    await page.waitForFunction(() => /skipped/.test(document.querySelector('#ccfb .row[data-order="A-4"]').textContent));
    assert.strictEqual((await page.evaluate(() => window.__store.fbDone))["A-4"].how, "skip"); ok("Skip is remembered");
    await page.evaluate(() => { window.__sendFail = true; });
    await page.click('#ccfb .row[data-order="B-1"] [data-send]');
    await page.waitForFunction(() => /not sent: Send did not go through/.test(document.querySelector('#ccfb .row[data-order="B-1"]').textContent));
    assert.strictEqual(await page.$eval('#ccfb .row[data-order="B-1"] [data-send]', (b) => b.disabled), false); ok("failed send: reason shown, buttons back");
    assert.ok(!(await page.evaluate(() => window.__store.fbDone))["B-1"]); ok("failed send is not marked done");
    // no key
    const page2p = await ctx.newPage();
    await page2p.addInitScript(() => { window.chrome = { runtime: { getURL: (p) => "chrome-extension://x/" + p, sendMessage: (m, cb) => setTimeout(() => cb(m.type === "cardcomp-fb-key" ? { ok: false } : null), 5) }, storage: { local: { get: (k, cb) => cb({}), set: (o, cb) => cb && cb() } } }; });
    await page2p.goto("https://store.tcgplayer.com/admin/Seller/Feedback");
    await page2p.addScriptTag({ path: path.join(EXT, "feedback", "feedback.js") });
    await page2p.waitForFunction(() => /Options page/.test(document.querySelector("#ccfbst")?.textContent || ""));
    ok("no key: points to the Options page");
    await ctx.close();

    console.log("3. order.js on a mock order page");
    const orderHTML = fs.readFileSync(path.join(__dirname, "feedback-mock-order.html"), "utf8");
    const c2 = await browser.newContext(), p2 = await c2.newPage();
    const posted = [];
    await c2.exposeFunction("__msg", (m) => { posted.push(m); });
    await p2.addInitScript(() => {
      window.__handlers = [];
      window.chrome = { runtime: { lastError: null, sendMessage: (m, cb) => { window.__msg(m); cb && cb({ ok: true }); }, onMessage: { addListener: (f) => window.__handlers.push(f) } } };
      window.__send = (m) => new Promise((res) => { window.__handlers.forEach((f) => f(m, {}, res)); });
    });
    await c2.route("https://sellerportal.tcgplayer.com/orders/**", (route) => route.fulfill({ contentType: "text/html", body: orderHTML }));
    await p2.goto("https://sellerportal.tcgplayer.com/orders/92588719-TEST01-00001");
    await p2.addScriptTag({ path: path.join(EXT, "feedback", "order.js") });
    await p2.waitForFunction(() => window.__mockReady);
    await p2.waitForTimeout(600);
    const info = posted.find((m) => m.type === "cardcomp-fb-order-info");
    assert.ok(info, "order info posted"); assert.strictEqual(info.order, "92588719-TEST01-00001");
    assert.deepStrictEqual(info.products, ["Pokemon - SWSH: Crown Zenith: Galarian Gallery: Hisuian Samurott V - #GG51/GG70 - Near Mint Holofoil"]);
    assert.strictEqual(info.feedback, "Excellent seller, great communication"); assert.strictEqual(info.fbDate, "11/5/2026, 4:17:12 PM (PST)"); assert.strictEqual(info.buyer, "Stevie Rogers");
    ok("order info on load: order, cards, feedback text + date, buyer (after the app rendered)");
    let r = await p2.evaluate(() => window.__send({ type: "cardcomp-fb-fill", order: "other", text: "x" }));
    assert.strictEqual(r.ok, false); assert.ok(/another order/.test(r.why)); ok("refuses to fill another order's tab");
    r = await p2.evaluate(() => window.__send({ type: "cardcomp-fb-fill", order: "92588719-TEST01-00001", text: "Thanks for the kind words!" }));
    assert.deepStrictEqual(r, { ok: true });
    const m = await p2.evaluate(() => window.__mock);
    assert.strictEqual(m.subject, "General Inquiry"); assert.strictEqual(m.sentText, "Thanks for the kind words!"); assert.strictEqual(m.sent, 1); assert.strictEqual(m.drawerOpen, false);
    ok("fill: Contact Buyer opened, General Inquiry picked, v-model saw the text, Send pressed, drawer closed");
    await p2.evaluate(() => { window.__mockFail = "nosend"; });
    r = await p2.evaluate(() => window.__send({ type: "cardcomp-fb-fill", order: "92588719-TEST01-00001", text: "again" }));
    assert.strictEqual(r.ok, false); assert.ok(/did not go through/.test(r.why)); ok("Send that does nothing: reported, drawer left open for Derek");
    await p2.evaluate(() => { window.__mockFail = "nosubject"; window.__mock.subject = ""; document.querySelector("#subject span").textContent = "Select"; document.querySelectorAll("#subject-dropdown li").forEach((l) => l.setAttribute("aria-selected", "false")); document.querySelector('[data-testid="OrderDetails_ContactBuyerDrawer"]').style.display = "none"; });
    r = await p2.evaluate(() => window.__send({ type: "cardcomp-fb-fill", order: "92588719-TEST01-00001", text: "again" }));
    assert.strictEqual(r.ok, false); assert.ok(/subject/.test(r.why)); ok("subject that will not select: reported");
    await c2.close();
  } finally { await browser.close(); }
}
(async () => {
  await bgTests(); await pageTests();
  console.log("\n" + n + " checks passed");
})().catch((e) => { console.error("FAILED:", e && e.stack || e); process.exit(1); });
