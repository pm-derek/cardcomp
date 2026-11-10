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
    chrome: { storage: { local: { get: (k, cb) => cb(store), set: (o, cb) => { Object.assign(store, o); cb && cb(); } }, session: { get: (k, cb) => cb({}), set: () => {} } }, tabs: {}, action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} }, alarms: { get: (n, cb) => cb(null), create: () => {}, onAlarm: { addListener: () => {} } } } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(EXT, "feedback", "feedback-bg.js"), "utf8") + "\nthis.fbDraft = fbDraft; this.fbHandle = fbHandle; this.fbParseHTML = fbParseHTML; this.fbPendingOf = fbPendingOf; this.fbThreadsPut = fbThreadsPut; this.fbThreadsGet = fbThreadsGet; this.fbPickThread = fbPickThread; this.fbThread = fbThread; this.fbIssueDraft = fbIssueDraft; this.fbParseCSV = fbParseCSV; this.fbBuyersMerge = fbBuyersMerge; this.fbBuyerStats = fbBuyerStats; this.fbFeedbackMerge = fbFeedbackMerge; this.fbFeedbackFor = fbFeedbackFor; this.fbFeedbackLoad = fbFeedbackLoad;", ctx);
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
  reply = { stop_reason: "end_turn", content: [{ type: "text", text: "Sorry about that, tell me what would fix it." }] };
  await ctx.fbDraft(Object.assign({}, row, { rating: 2 })); let sys = JSON.parse(calls[calls.length - 1].opt.body).system;
  assert.ok(/3 stars or lower/.test(sys) && /refund and return policy/.test(sys)); ok("1-3 stars: the make-it-right prompt is added");
  await ctx.fbDraft(row, "shorter"); sys = JSON.parse(calls[calls.length - 1].opt.body).system; assert.ok(/one short sentence/.test(sys) && !/3 stars or lower/.test(sys)); ok("shorter: one-sentence instruction, no negative prompt on a 5");
  await ctx.fbDraft(Object.assign({}, row, { orders: 3 })); sys = JSON.parse(calls[calls.length - 1].opt.body).system; assert.ok(/ordered 3 times/.test(sys)); ok("repeat buyer named in the prompt");
  const tr = (o, date, rating, comment, user) => `<tr class="gradeA even"><td style="white-space: nowrap;">East Bay Trader</td><td><div><div><a href="https://store.tcgplayer.com/admin/Orders/ManageOrder/${o}">${o}</a></div></div></td><td style="text-align: right;">${date}</td><td style="text-align: center;">${rating}</td><td>${comment === null ? "<i>No Comment Left</i>" : comment}</td><td style="white-space: nowrap;">${user}</td></tr>`;
  const html = `<html><body><table class="display dTable"><thead><tr><th>Seller</th></tr></thead><tbody>${tr("P-1", daysAgo(1), 5, "Great &amp; fast", "amy a1")}${tr("P-2", daysAgo(2), 5, null, "bob b2")}${tr("P-3", daysAgo(3), 5, "Nice", "")}${tr("P-4", daysAgo(30), 5, "Old", "cy c3")}${tr("P-5", daysAgo(4), 4, "Good", "dee d4")}</tbody></table></body></html>`;
  const rows = ctx.fbParseHTML(html);
  assert.strictEqual(rows.length, 5); assert.strictEqual(rows[0].comment, "Great & fast"); assert.strictEqual(rows[1].comment, ""); assert.strictEqual(rows[0].order, "P-1"); ok("worker-side regex parser reads the feedback table");
  assert.strictEqual(ctx.fbPendingOf(rows, { "P-5": { how: "skip" } }), 1); ok("badge count: worded + named + recent minus done");
  assert.strictEqual(ctx.fbParseHTML("<html><body>Log in</body></html>"), null); ok("login page -> no table -> null");
  reply = { stop_reason: "end_turn", model: "claude-opus-5-5", usage: { input_tokens: 900, output_tokens: 120 }, content: [{ type: "text", text: "Ah sorry to hear that. Misty's Wish - charged $13.00, at DMG it goes for $6.00, so I'd refund $7. Does that work?" }] };
  const iq = { kind: "condition", thread: { subject: "Condition Issue", msgs: [{ from: "Daniel Davis", me: false, when: "Oct 30, 11:23 AM", text: "The misty's wish is damaged, large crease" }, { from: "Me", me: true, when: "Oct 30, 11:28 AM", text: "Oh no! Can you shoot me a picture?" }, { from: "Daniel Davis", me: false, when: "Oct 30, 11:49 AM", text: "https://drive.google.com/x I'd like a refund" }] },
    order: { order: "O-1", orderDate: "10/24/2026", items: [{ name: "Misty's Wish", printing: "Normal", soldAs: "NM", charged: 13, qty: 1 }] }, picks: { cards: [{ name: "Misty's Wish", printing: "Normal", soldAs: "NM", charged: 13, arrived: "DMG", value: 6, valueSrc: "TCG market", refund: 7 }], extra: 2, total: 9 }, facts: {}, address: "1 Main St, Union City, CA" };
  r = await ctx.fbIssueDraft(iq); assert.strictEqual(r.ok, true); assert.ok(/refund \$7/.test(r.text));
  const ib = JSON.parse(calls[calls.length - 1].opt.body);
  assert.strictEqual(ib.model, "claude-opus-5-5"); assert.deepStrictEqual(ib.output_config, { effort: "medium" }); assert.ok(/CONDITION ISSUE\. Stage 1/.test(ib.system) && /MISSING PACKAGE/.test(ib.system) && /WRONG CARD/.test(ib.system) && /MISSING CARD/.test(ib.system) && /never required/.test(ib.system) && /prestamped envelope/.test(ib.system) && /Return shipping is always on Derek/.test(ib.system));
  const iu = ib.messages[0].content;
  assert.ok(/Issue type: condition/.test(iu) && /Misty's Wish: charged \$13\.00, at DMG it goes for \$6\.00 \(TCG market\), refund \$7/.test(iu) && /extra for the trouble \$2/.test(iu) && /total refund \$9/.test(iu) && /Return address: 1 Main St/.test(iu) && /\[Oct 30, 11:49 AM\] Daniel Davis: https/.test(iu) && /Me: Oh no!/.test(iu));
  ok("issue draft: playbook system prompt, numbers / extra / total / address / thread in the user turn");
  r = await ctx.fbIssueDraft({ kind: "missing", thread: { subject: "Where Is My Order", msgs: [] }, order: { order: "O-2" }, picks: {}, facts: { edd: "November 6, 2026", shippedAt: "10/26/2026", tracking: "", method: "Standard", waitUntil: "November 10", late: false, reportedLate: true }, address: "" });
  const iu2 = JSON.parse(calls[calls.length - 1].opt.body).messages[0].content;
  assert.ok(/wait-until date \(estimated delivery \+ 2 business days\) November 10/.test(iu2) && /no tracking/.test(iu2) && /reported it more than 2 business days after/.test(iu2) && /not on file, do not invent one/.test(iu2)); ok("missing package facts (wait-until, reported late) and the no-address rule reach the prompt");
  // buyer history: TCGplayer's Order List export, case-folded names, ordinal as of a date
  const csv = 'Order #,Buyer Name,Order Date,Status,Shipping Type,Product Amt,Shipping Amt,Total Amt,Buyer Paid,Carrier Information\r\n"92588719-A","Chris Thomas","Monday, 09 November 2026","Ready to Ship","Standard","21.9","0.0","21.9","True"\r\n"92588719-B","CHRIS THOMAS","Thursday, 29 October 2026","Shipped","Standard","5.39","0.0","5.39","True"\r\n"92588719-C","danny lu","Monday, 09 November 2026","Ready to Ship","Standard","1.84","1.49","3.33","True"\r\n"92588719-D","Smith, Jr., Bob","Friday, 30 October 2025","Delivered","Standard","2","0","2","True"\r\n';
  const parsed = ctx.fbParseCSV(csv);
  assert.strictEqual(parsed.length, 4); assert.strictEqual(parsed[3].buyer, "Smith, Jr., Bob"); assert.strictEqual(parsed[0].total, 21.9); assert.strictEqual(new Date(parsed[1].at).getDate(), 29); ok("CSV: quoted commas, CRLF, dates like 'Thursday, 29 October 2026', totals");
  store.fbBuyers = {};
  let mr = await ctx.fbBuyersMerge(parsed); assert.deepStrictEqual([mr.added, mr.buyers, mr.orders], [4, 3, 4]); ok("merge: 4 orders, 3 buyers (Chris Thomas and CHRIS THOMAS are one)");
  mr = await ctx.fbBuyersMerge([{ order: "92588719-A", buyer: "chris thomas", at: parsed[0].at, total: 21.9 }, { order: "92588719-E", buyer: "Chris Thomas", at: Date.now(), total: 10 }]); assert.deepStrictEqual([mr.added, mr.orders], [1, 5]); ok("merge is idempotent on order id; a list-page row adds one");
  const bs = ctx.fbBuyerStats(store.fbBuyers, "CHRIS  thomas", 0); assert.strictEqual(bs.n, 3); assert.ok(Math.abs(bs.spent - 37.29) < 1e-9); assert.strictEqual(bs.name, "Chris Thomas"); ok("stats: 3 orders, $37.29, mixed-case spelling kept");
  assert.strictEqual(ctx.fbBuyerStats(store.fbBuyers, "Chris Thomas", parsed[1].at).before, 1); assert.strictEqual(ctx.fbBuyerStats(store.fbBuyers, "Chris Thomas", parsed[0].at).before, 2); ok("as of the Oct 29 order they had 1, as of Nov 9 they had 2");
  assert.strictEqual(ctx.fbBuyerStats(store.fbBuyers, "nobody", 0), null); ok("unknown buyer: null");
  // date-only rows (the grid's "Nov-09-2026") against stored exact times: a row always counts itself
  { const d = (s) => new Date(s).getTime(); const hist = { "danny lu": { name: "danny lu", orders: { O1: { at: d("2026-09-01T00:00:00"), total: 20 }, O2: { at: d("2026-09-20T00:00:00"), total: 30 }, O3: { at: d("2026-10-02T15:10:00"), total: 25 }, O4: { at: d("2026-10-20T00:00:00"), total: 39.33 }, O5: { at: d("2026-11-09T09:15:00"), total: 10 }, O6: { at: d("2026-11-09T19:39:01"), total: 21.9 }, O7: { at: d("2026-11-10T00:00:00"), total: 2.28 } } } };
    const mid9 = d("2026-11-09T00:00:00"), mid10 = d("2026-11-10T00:00:00");
    let s = ctx.fbBuyerStats(hist, "danny lu", mid9, "O6"); assert.deepStrictEqual([s.before, s.spentBefore], [6, 146.23]); ok("a grid row dated Nov 9 whose order is stored at 7:39 PM counts itself: 6 orders, not 5");
    s = ctx.fbBuyerStats(hist, "danny lu", mid9, "O5"); assert.strictEqual(s.before, 5); ok("the same day's earlier order (stored 9:15 AM) reads 5: exact times still order the day");
    s = ctx.fbBuyerStats(hist, "danny lu", mid10, "O7"); assert.deepStrictEqual([s.before, s.spentBefore], [7, 148.51]); ok("the Nov 10 row reads 7");
    s = ctx.fbBuyerStats(hist, "danny lu", mid9, ""); assert.strictEqual(s.before, 6); ok("a date-only question with no order id counts every order of that day");
    s = ctx.fbBuyerStats(hist, "danny lu", mid9, "NEW"); assert.strictEqual(s.before, 6); ok("an order id the history does not hold yet changes nothing"); }
  { const s = ctx.fbBuyerStats(store.fbBuyers, "Chris Thomas", 0);
    assert.strictEqual(s.first, parsed[1].at); assert.strictEqual(s.firstTotal, 5.39); assert.strictEqual(s.lastTotal, 10); assert.ok(s.last > parsed[0].at); ok("LTV: first order Oct 29 $5.39, last order (today) $10, lifetime $37.29");
    const asOf = ctx.fbBuyerStats(store.fbBuyers, "Chris Thomas", parsed[0].at); assert.strictEqual(asOf.before, 2); assert.strictEqual(asOf.spentBefore, 27.29); ok("as of the Nov 9 order: 2 orders, $27.29 spent by then"); }
  // two orders on one day: the Orders list's exact times break the tie, the import's midnight would not
  const d9 = parsed[0].at;   // Nov 9 midnight from the CSV (order A)
  await ctx.fbBuyersMerge([{ order: "92588719-A", buyer: "Chris Thomas", at: d9 + 13 * 36e5, total: 21.9 }, { order: "92588719-F", buyer: "Chris Thomas", at: d9 + 19 * 36e5 + 39 * 6e4, total: 3 }]);
  assert.strictEqual(store.fbBuyers["chris thomas"].orders["92588719-A"].at, d9 + 13 * 36e5); ok("a list row's exact time replaces the import's midnight for the same order");
  assert.strictEqual(ctx.fbBuyerStats(store.fbBuyers, "Chris Thomas", d9 + 13 * 36e5).before, 2); assert.strictEqual(ctx.fbBuyerStats(store.fbBuyers, "Chris Thomas", d9 + 19 * 36e5 + 39 * 6e4).before, 3); ok("same day, two orders: the 1 PM row counts 2, the 7:39 PM row counts 3");
  // feedback history: every Feedback tab row seen, by order; per buyer newest first; the loader with a mocked fetch
  store.fbFeedback = {};
  let fm = await ctx.fbFeedbackMerge([{ order: "FB-1", date: "10/03/2026", rating: 5, comment: "Fast shipping, great card", user: "Chris Thomas" }, { order: "FB-2", date: "10/20/2026", rating: 4, comment: "", user: "CHRIS THOMAS" }, { order: "FB-3", date: "11/01/2026", rating: 2, comment: "Card was bent", user: "Someone Else" }]);
  assert.deepStrictEqual([fm.added, fm.total], [3, 3]); fm = await ctx.fbFeedbackMerge([{ order: "FB-1", date: "10/03/2026", rating: 5, comment: "Fast shipping, great card", user: "Chris Thomas" }]); assert.deepStrictEqual([fm.added, fm.total], [0, 3]); ok("feedback history: merged by order, idempotent");
  const ff = ctx.fbFeedbackFor(store.fbFeedback, "chris thomas"); assert.strictEqual(ff.length, 2); assert.strictEqual(ff[0].order, "FB-2"); assert.strictEqual(ff[1].c, "Fast shipping, great card"); assert.strictEqual(new Date(ff[1].at).getMonth(), 9); ok("per buyer (case-folded), newest first, dates parsed");
  assert.deepStrictEqual(ctx.fbFeedbackFor(store.fbFeedback, "Robert Smith", ["FB-3", "FB-9"]).map((x) => x.order), ["FB-3"]); assert.strictEqual(ctx.fbFeedbackFor(store.fbFeedback, "Chris Thomas", ["FB-3"]).length, 3); ok("joined by order id too: a buyer's real name finds the feedback left under their username (single-order buyers included)");
  { const realFetch = ctx.fetch; const page = (rows) => '<table class="display dTable"><tr><th></th></tr>' + rows.map((r) => `<tr><td>East Bay Trader</td><td><a>${r[0]}</a></td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3] || "<i>No Comment Left</i>"}</td><td>${r[4]}</td></tr>`).join("") + "</table>";
    const pages = { 1: page([["FB-9", "11/09/2026", 5, "Thanks!", "New Buyer"], ["FB-3", "11/01/2026", 2, "Card was bent", "Someone Else"]]), 2: page([["FB-2", "10/20/2026", 4, "", "CHRIS THOMAS"], ["FB-1", "10/03/2026", 5, "Fast shipping, great card", "Chris Thomas"]]), 3: page([]) };
    const hits = []; ctx.fetch = async (u) => { const n = +/page=(\d+)/.exec(u)[1]; hits.push(n); return { ok: true, text: async () => pages[n] || page([]) }; };
    let r = await ctx.fbFeedbackLoad(true); assert.deepStrictEqual([r.pages, r.added, r.total, hits.join()], [3, 1, 4, "1,2,3"]); ok("load full: every page until an empty one, 1 new (FB-9)");
    hits.length = 0; r = await ctx.fbFeedbackLoad(false); assert.deepStrictEqual([r.pages, r.added, hits.join()], [1, 0, "1"]); ok("load new only: stops at the first page with nothing new");
    ctx.fetch = async () => ({ ok: true, text: async () => "<html>login</html>" }); r = await ctx.fbFeedbackLoad(true); assert.ok(/signed out/.test(r.stopped)); ok("no feedback table = signed out, reported");
    ctx.fetch = realFetch; }
  // threads: stored from the Messages list read, the newest General Inquiry since the send wins
  const t0 = Date.now();
  let m = await ctx.fbThreadsPut([{ id: "1", url: "u1", order: "O-1", subject: "Condition Issue", members: "Daniel, Me" }, { id: "2", url: "u2", order: "O-1", subject: "General Inquiry", members: "Me, Daniel" }, { id: "3", url: "u3", order: "O-2", subject: "General Inquiry" }]);
  assert.strictEqual(ctx.fbPickThread(m["O-1"], 0), "u2"); assert.strictEqual(ctx.fbPickThread(m["O-2"], 0), "u3"); assert.strictEqual(ctx.fbPickThread(m["O-9"], 0), null); ok("thread pick: General Inquiry over the buyer's own thread, null when unknown");
  assert.strictEqual(await ctx.fbThread("O-1", 0, null), "u2"); ok("known thread answered without opening a tab");
  let waited; ctx.fbHandle({ type: "cardcomp-fb-threads", rows: [{ id: "4", url: "u4", order: "O-1", subject: "General Inquiry" }] }, {}, (x) => { waited = x; }); await new Promise((r) => setTimeout(r, 10));
  m = await ctx.fbThreadsGet(); assert.strictEqual(m["O-1"][0].id, "4"); assert.strictEqual(ctx.fbPickThread(m["O-1"], t0), "u4"); ok("a new list read adds the newer thread first; since-filter picks it");
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
      tr("A-6", daysAgo(3), 2, "Card arrived bent in a plain envelope", "zed z9"),
      tr("A-4", daysAgo(5), 4, "The cards are exactly as described.", "andy a2133"),
      tr("A-7", daysAgo(6), 5, "Second order, great again", "andy a2133"),
      tr("A-5", daysAgo(6), 5, "Great seller", "done d1"),
      tr("A-1", daysAgo(1), 5, "Got here super fast and in great condition. Thank you!", "robert s78A1F72")])}</div></body></html>`;
    const page2 = `<!doctype html><html><body>${table([tr("B-1", daysAgo(9), 5, "Excellent seller, my order got messed up but they fixed it", "stevie r3006"), tr("B-2", daysAgo(20), 5, "Old one", "old o1")])}</body></html>`;
    const page3 = `<!doctype html><html><body>${table([tr("C-1", daysAgo(30), 5, "Older still", "older o2")])}</body></html>`;
    const login = `<!doctype html><html><body><form>Log in</form></body></html>`;
    const ctx = await browser.newContext();
    const log = { msgs: [], pages: [] }, store = { fbDone: { "A-5": { at: Date.now(), how: "sent", user: "done d1", text: "Thanks!" } } };
    let loginAt = 0;
    await ctx.exposeFunction("__msg", (m) => { log.msgs.push(m); });
    await ctx.route("**/admin/Seller/Feedback*", (route) => {
      const u = new URL(route.request().url()), p = u.searchParams.get("page") || "1"; log.pages.push(p);
      route.fulfill({ contentType: "text/html", body: loginAt && +p >= loginAt ? login : p === "1" ? page1 : p === "2" ? page2 : page3 });
    });
    const init = ({ store, countdown }) => {
      const S = store;
      window.__sendReply = { ok: true }; window.__ccfbCountdown = countdown;
      window.chrome = { runtime: { getURL: (p) => "chrome-extension://x/" + p, lastError: null,
        sendMessage: (m, cb) => { window.__msg(m); setTimeout(() => {
          if (m.type === "cardcomp-fb-key") return cb({ ok: true });
          if (m.type === "cardcomp-fb-pending") return cb({ ok: true });
          if (m.type === "cardcomp-fb-thread") return cb(m.order === "A-1" ? { ok: true, url: "https://sellerportal.tcgplayer.com/messages/62192274" } : { ok: false });
          if (m.type === "cardcomp-fb-order") return cb(m.order === "A-4" ? { ok: false, why: "did not load" } : { ok: true, info: { order: m.order, pids: ["478078"], products: ["Pokemon - SWSH: Crown Zenith: Galarian Gallery: Hisuian Samurott V - #GG51/GG70 - Near Mint Holofoil", "Pokemon - SV: Prismatic Evolutions: Umbreon ex - #161/131 - Near Mint Holofoil", "Pokemon - SM - Unbroken Bonds: Chikorita (53) - #53/214 - Near Mint", "Pokemon - Base Set: Charizard - #4/102 - Lightly Played Holofoil"], feedback: "", fbDate: new Date(Date.now() - 20 * 36e5).toLocaleString("en-US") + " (PST)", buyer: "X" } });
          if (m.type === "cardcomp-fb-draft") return cb({ ok: true, text: m.row.rating <= 3 ? "So sorry about the bent card. Tell me what would fix it and I will sort it out." : m.style === "shorter" ? "Thanks!" : "Thanks " + m.row.user + "!" + (m.row.order === "A-7" ? " Here is a 10% discount." : ""), cost: 0.004 });
          if (m.type === "cardcomp-fb-send") return cb(window.__sendReply);
          cb(null); }, 5); } },
        storage: { local: { get: (k, cb) => cb({ fbDone: S.fbDone }), set: (o, cb) => { Object.assign(S, o); cb && cb(); } } } };
      window.__store = S;
    };
    const page = await ctx.newPage();
    page.on("console", (m) => { if (process.env.DBG) console.log("  console:", m.text()); }); page.on("pageerror", (e) => console.log("  pageerror:", e.message));
    await page.addInitScript(init, { store, countdown: 0 });
    await page.goto("https://store.tcgplayer.com/admin/Seller/Feedback");
    await page.addScriptTag({ path: path.join(EXT, "feedback", "feedback.js") });
    try { await page.waitForFunction(() => /drafted/.test(document.querySelector("#ccfbst")?.textContent || ""), null, { timeout: 15000 }); }
    catch (e) { console.log("  status:", await page.evaluate(() => document.querySelector("#ccfbst")?.textContent), "msgs:", JSON.stringify(log.msgs.map((m) => m.type))); throw e; }
    const orders = await page.$$eval("#ccfb .row", (els) => els.map((e) => e.dataset.order));
    assert.deepStrictEqual(orders, ["A-6", "A-1", "A-4", "A-7", "B-1"]); ok("candidates: worded + named + last 14 days, done list and duplicates dropped, page 2 read, 2-star first (" + orders.join(", ") + ")");
    assert.deepStrictEqual(log.pages.filter((p) => p !== "1"), ["2", "3"]); ok("fetched page 2 and 3, stopped once a page was all old");
    assert.ok(await page.$eval('#ccfb .row[data-order="A-6"]', (e) => e.classList.contains("neg"))); assert.ok(/reply within 48h: 2[78]h left/.test(await page.$eval('#ccfb .row[data-order="A-6"] [data-tags]', (e) => e.textContent))); ok("negative row: red bar and the 48h clock from the feedback date");
    const card = await page.$eval('#ccfb .row[data-order="A-1"] [data-card]', (e) => e.textContent);
    assert.strictEqual(card, "Hisuian Samurott V, Umbreon ex +2"); ok("card line: short names, +N");
    assert.strictEqual(await page.$eval('#ccfb .row[data-order="A-1"] .hd a', (a) => a.getAttribute("href")), "https://sellerportal.tcgplayer.com/orders/A-1"); ok("order id links to the order page");
    assert.strictEqual(await page.$eval('#ccfb .row[data-order="A-1"] img', (e) => e.getAttribute("src")), "https://tcgplayer-cdn.tcgplayer.com/product/478078_200w.jpg"); ok("thumbnail from the order's product id");
    assert.ok(/2 orders in 14 days/.test(await page.$eval('#ccfb .row[data-order="A-7"] .hd', (e) => e.textContent))); ok("repeat buyer tag");
    const drafts = await page.$$eval("#ccfb textarea", (els) => els.map((e) => e.value));
    assert.strictEqual(drafts.length, 5); assert.strictEqual(drafts[1], "Thanks robert s78A1F72!"); assert.strictEqual(drafts[2], "Thanks andy a2133!"); ok("a draft per row, also when the order page did not load");
    assert.ok(/mentions discount/.test(await page.$eval('#ccfb .row[data-order="A-7"] .flags', (e) => e.textContent)) && await page.$eval('#ccfb .row[data-order="A-7"]', (e) => e.classList.contains("flag"))); ok("content flag: a discount the buyer never mentioned");
    assert.strictEqual(await page.$('#ccfb .row[data-order="A-1"] .flags'), null); ok("clean draft: no flag");
    const draftRow = log.msgs.find((m) => m.type === "cardcomp-fb-draft" && m.row.order === "A-1").row;
    assert.strictEqual(draftRow.products.length, 4); assert.ok(draftRow.fbDate); ok("draft request carries the order's cards and feedback date");
    assert.ok(/6 worded in the last 14 days/.test(await page.$eval("#ccfbfoot", (e) => e.textContent)) && /replied from here: 1/.test(await page.$eval("#ccfbfoot", (e) => e.textContent)) && /today: 1 of 10/.test(await page.$eval("#ccfbfoot", (e) => e.textContent))); ok("footer counts incl. today's sends");
    assert.strictEqual(log.msgs.filter((m) => m.type === "cardcomp-fb-pending").pop().n, 5); ok("pending count posted for the icon badge");
    await page.click('#ccfb .row[data-order="A-1"] [data-redo="shorter"]'); await page.waitForFunction(() => document.querySelector('#ccfb .row[data-order="A-1"] textarea')?.value === "Thanks!"); ok("shorter: redraft with the style");
    // edit then send A-1
    await page.fill('#ccfb .row[data-order="A-1"] textarea', "Edited thanks!");
    await page.click('#ccfb .row[data-order="A-1"] [data-send]');
    await page.waitForFunction(() => /✓ sent/.test(document.querySelector('#ccfb .row[data-order="A-1"]').textContent));
    const sent = log.msgs.find((m) => m.type === "cardcomp-fb-send");
    assert.deepStrictEqual(sent, { type: "cardcomp-fb-send", order: "A-1", text: "Edited thanks!", expect: { comment: "Got here super fast and in great condition. Thank you!", user: "robert s78A1F72" } }); ok("Send posts the edited text plus what the order page must show");
    let st = await page.evaluate(() => window.__store.fbDone);
    assert.strictEqual(st["A-1"].how, "sent"); assert.strictEqual(st["A-1"].text, "Edited thanks!"); ok("done list: sent");
    await page.waitForFunction(() => /view message/.test(document.querySelector('#ccfb .row[data-order="A-1"] .done')?.textContent || ""));
    assert.strictEqual(await page.$eval('#ccfb .row[data-order="A-1"] .done a', (a) => a.getAttribute("href")), "https://sellerportal.tcgplayer.com/messages/62192274"); ok("sent line links to the message thread found on the Messages list");
    assert.strictEqual((await page.evaluate(() => window.__store.fbDone))["A-1"].thread, "https://sellerportal.tcgplayer.com/messages/62192274"); ok("thread kept on the done entry");
    assert.ok(log.msgs.some((m) => m.type === "cardcomp-fb-thread" && m.order === "A-5" && m.since === 0)); ok("on load, earlier sends without a thread are looked up once");
    assert.strictEqual(log.msgs.filter((m) => m.type === "cardcomp-fb-pending").pop().n, 4); ok("badge count updated after the send");
    await page.click('#ccfb .row[data-order="A-4"] [data-skip]');
    await page.waitForFunction(() => /skipped/.test(document.querySelector('#ccfb .row[data-order="A-4"]').textContent));
    assert.strictEqual((await page.evaluate(() => window.__store.fbDone))["A-4"].how, "skip"); ok("Skip is remembered");
    await page.evaluate(() => { window.__sendReply = { ok: false, why: "the order page's feedback differs from the row" }; });
    await page.click('#ccfb .row[data-order="B-1"] [data-send]');
    await page.waitForFunction(() => /not sent: the order page/.test(document.querySelector('#ccfb .row[data-order="B-1"]').textContent));
    assert.strictEqual(await page.$eval('#ccfb .row[data-order="B-1"] [data-send]', (b) => b.disabled), false); ok("refused before typing: reason shown, buttons back");
    assert.ok(!(await page.evaluate(() => window.__store.fbDone))["B-1"]); ok("a refused send is not locked, can be retried");
    await page.evaluate(() => { window.__sendReply = { ok: false, clicked: true, why: "Send was pressed but the page did not confirm" }; });
    await page.click('#ccfb .row[data-order="B-1"] [data-send]');
    await page.waitForFunction(() => /unsure/.test(document.querySelector('#ccfb .row[data-order="B-1"]').textContent));
    st = await page.evaluate(() => window.__store.fbDone);
    assert.strictEqual(st["B-1"].how, "unsure"); assert.strictEqual(await page.$('#ccfb .row[data-order="B-1"] [data-send]'), null); assert.ok(/open Messages/.test(await page.$eval('#ccfb .row[data-order="B-1"]', (e) => e.textContent))); ok("Send pressed, no confirmation: locked as unsure, never offered again, link to Messages");
    await page.click("#ccfbfoot [data-hist]"); assert.ok(/Edited thanks!/.test(await page.$eval("#ccfbhist", (e) => e.textContent)) && /unsure/.test(await page.$eval("#ccfbhist", (e) => e.textContent))); ok("sent history lists what went out, unsure marked");
    const hl = await page.$$eval("#ccfbhist a", (as) => as.map((a) => a.getAttribute("href")));
    assert.ok(hl.includes("https://sellerportal.tcgplayer.com/messages/62192274") && hl.includes("https://sellerportal.tcgplayer.com/orders/A-1") && hl.includes("https://sellerportal.tcgplayer.com/messages")); ok("history: thread link when known, Messages list when not, order link always");
    // countdown with cancel
    const pc = await ctx.newPage(); await pc.addInitScript(init, { store: { fbDone: {} }, countdown: 2 });
    await pc.goto("https://store.tcgplayer.com/admin/Seller/Feedback"); await pc.addScriptTag({ path: path.join(EXT, "feedback", "feedback.js") });
    await pc.waitForFunction(() => /drafted/.test(document.querySelector("#ccfbst")?.textContent || ""), null, { timeout: 15000 });
    const before = log.msgs.filter((m) => m.type === "cardcomp-fb-send").length;
    await pc.click('#ccfb .row[data-order="A-1"] [data-send]');
    assert.ok(/sending in 2/.test(await pc.$eval('#ccfb .row[data-order="A-1"] [data-send]', (b) => b.textContent))); ok("Send counts down");
    await pc.click('#ccfb .row[data-order="A-1"] [data-send]');
    assert.strictEqual(await pc.$eval('#ccfb .row[data-order="A-1"] [data-send]', (b) => b.textContent), "Send"); await pc.waitForTimeout(2600);
    assert.strictEqual(log.msgs.filter((m) => m.type === "cardcomp-fb-send").length, before); ok("second tap cancels, nothing sent");
    await pc.close();
    // daily cap: ten sends today already
    const capDone = {}; for (let i = 0; i < 10; i++) capDone["X-" + i] = { at: Date.now() - i * 1000, how: "sent" };
    const pcap = await ctx.newPage(); await pcap.addInitScript(init, { store: { fbDone: capDone }, countdown: 0 });
    await pcap.goto("https://store.tcgplayer.com/admin/Seller/Feedback"); await pcap.addScriptTag({ path: path.join(EXT, "feedback", "feedback.js") });
    await pcap.waitForFunction(() => /drafted/.test(document.querySelector("#ccfbst")?.textContent || ""), null, { timeout: 15000 });
    await pcap.click('#ccfb .row[data-order="A-1"] [data-send]');
    await pcap.waitForFunction(() => /daily cap of 10/.test(document.querySelector('#ccfb .row[data-order="A-1"]').textContent));
    assert.strictEqual(log.msgs.filter((m) => m.type === "cardcomp-fb-send").length, before); ok("daily cap: refused before the extension is asked");
    await pcap.close();
    // signed out mid-way
    loginAt = 2;
    const pl = await ctx.newPage(); await pl.addInitScript(init, { store: { fbDone: {} }, countdown: 0 });
    await pl.goto("https://store.tcgplayer.com/admin/Seller/Feedback"); await pl.addScriptTag({ path: path.join(EXT, "feedback", "feedback.js") });
    await pl.waitForFunction(() => /Signed out/.test(document.querySelector("#ccfbst")?.textContent || ""), null, { timeout: 15000 });
    assert.strictEqual(await pl.$$eval("#ccfb .row", (e) => e.length), 0); ok("login page while reading: says signed out, offers nothing");
    loginAt = 0; await pl.close();
    // nothing to do: one quiet line
    const pq = await ctx.newPage(); await pq.addInitScript(init, { store: { fbDone: { "A-1": { how: "sent", at: 1 }, "A-6": { how: "skip", at: 1 }, "A-4": { how: "skip", at: 1 }, "A-7": { how: "sent", at: 1 }, "B-1": { how: "sent", at: 1 }, "A-5": { how: "sent", at: 1 } } }, countdown: 0 });
    await pq.goto("https://store.tcgplayer.com/admin/Seller/Feedback"); await pq.addScriptTag({ path: path.join(EXT, "feedback", "feedback.js") });
    await pq.waitForFunction(() => /All caught up/.test(document.querySelector("#ccfbst")?.textContent || ""));
    assert.ok(await pq.$eval("#ccfb", (e) => e.classList.contains("quiet"))); ok("all caught up: collapsed to one line");
    await pq.close();
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
      window.chrome = { runtime: { lastError: null, sendMessage: (m, cb) => { window.__msg(m); if (m.type === "cardcomp-fb-buyer") return cb && cb({ ok: true, stats: { n: 1, name: m.name, spent: 17.18, fb: [{ order: m.order, at: Date.parse("2026-11-05"), r: 5, c: "Excellent seller, great communication" }, { order: "OLD-1", at: Date.parse("2026-08-02"), r: 4, c: "Good" }] } }); cb && cb({ ok: true }); }, onMessage: { addListener: (f) => window.__handlers.push(f) } } };
      window.__send = (m) => new Promise((res) => { window.__handlers.forEach((f) => f(m, {}, res)); });
    });
    await c2.route("https://sellerportal.tcgplayer.com/orders/**", (route) => route.fulfill({ contentType: "text/html", body: orderHTML }));
    await p2.goto("https://sellerportal.tcgplayer.com/orders/92588719-TEST01-00001");
    await p2.addScriptTag({ path: path.join(EXT, "feedback", "badge.js") }); await p2.addScriptTag({ path: path.join(EXT, "feedback", "order.js") });
    await p2.waitForFunction(() => window.__mockReady);
    await p2.waitForTimeout(600);
    const info = posted.find((m) => m.type === "cardcomp-fb-order-info");
    assert.ok(info, "order info posted"); assert.strictEqual(info.order, "92588719-TEST01-00001");
    assert.deepStrictEqual(info.products, ["Pokemon - SWSH: Crown Zenith: Galarian Gallery: Hisuian Samurott V - #GG51/GG70 - Near Mint Holofoil", "Pokemon - Gym Heroes: Misty's Wish - #22/132 - Near Mint"]);
    assert.deepStrictEqual(info.items[1], { name: "Pokemon - Gym Heroes: Misty's Wish - #22/132 - Near Mint", pid: "90210", price: 13, qty: 1, ext: 13 }); assert.strictEqual(info.items[0].price, 17.18);
    assert.strictEqual(info.edd, "November 6, 2026"); assert.strictEqual(info.shippedAt, "10/26/2026, 12:10:46 AM (PDT)"); assert.strictEqual(info.tracking, ""); assert.strictEqual(info.orderDate, "10/24/2026, 3:17:47 PM (PDT)"); assert.strictEqual(info.status, "Completed - Paid"); assert.strictEqual(info.method, "Standard (7-10 days)");
    assert.strictEqual(info.items.length, 2); ok("order info: per-line price / qty / product id (the drawer's second copy of the table folded), estimated delivery, shipped, no tracking, order date, status");
    assert.strictEqual(info.feedback, "Excellent seller, great communication"); assert.strictEqual(info.fbDate, "11/5/2026, 4:17:12 PM (PST)"); assert.strictEqual(info.buyer, "Stevie Rogers"); assert.deepStrictEqual(info.pids, ["478078", "90210"]);
    ok("order info on load: order, cards, product id, feedback text + date, buyer (after the app rendered)");
    assert.strictEqual(info.fbRating, 5);
    await p2.waitForSelector(".ccsaid", { timeout: 5000 });
    const fbm = posted.find((m) => m.type === "cardcomp-fb-feedback-merge"); assert.deepStrictEqual(fbm.rows[0], { order: "92588719-TEST01-00001", date: "11/5/2026, 4:17:12 PM (PST)", rating: 5, comment: "Excellent seller, great communication", user: "Stevie Rogers" }); ok("the order's own feedback (rating from the hearts) joins the feedback history");
    const said = await p2.$eval(".ccsaid", (e) => e.textContent.replace(/\s+/g, " ")); assert.ok(/Feedback for you: 2 ratings · avg 4\.5★/.test(said) && /“Excellent seller, great communication” Nov 5, 2026 · this order/.test(said) && /“Good” Aug 2, 2026/.test(said), said);
    assert.ok(!(await p2.$(".ccbuy"))); ok("a single-order buyer with feedback: the visible 'Feedback for you' panel under their name (this order marked), no repeat chip");
    let r = await p2.evaluate(() => window.__send({ type: "cardcomp-fb-fill", order: "92588719-TEST01-00001", text: "x", expect: { comment: "Fast shipping", user: "stevie r3006" } }));
    assert.strictEqual(r.ok, false); assert.ok(/feedback differs/.test(r.why)); assert.ok(!r.clicked); assert.strictEqual(await p2.evaluate(() => window.__mock.drawerOpen), false); ok("row's feedback not on the order page: refused before the drawer opens");
    r = await p2.evaluate(() => window.__send({ type: "cardcomp-fb-fill", order: "92588719-TEST01-00001", text: "x", expect: { comment: "Excellent seller, great communication", user: "robert s78A1F72" } }));
    assert.strictEqual(r.ok, false); assert.ok(/does not look like robert/.test(r.why)); ok("buyer on the order does not look like the username: refused");
    r = await p2.evaluate(() => window.__send({ type: "cardcomp-fb-fill", order: "92588719-TEST01-00001", text: "x", expect: { comment: "excellent seller, great communication!", user: "xMissAlyssax" } }));
    assert.strictEqual(r.ok, true, JSON.stringify(r)); ok("username without a plain first word: only the feedback text is compared (punctuation and case ignored), sent");
    r = await p2.evaluate(() => window.__send({ type: "cardcomp-fb-fill", order: "other", text: "x" }));
    assert.strictEqual(r.ok, false); assert.ok(/another order/.test(r.why)); ok("refuses to fill another order's tab");
    r = await p2.evaluate(() => window.__send({ type: "cardcomp-fb-fill", order: "92588719-TEST01-00001", text: "Thanks for the kind words!", expect: { comment: "Excellent seller, great communication", user: "stevie r3006" } }));
    assert.deepStrictEqual(r, { ok: true, clicked: true });
    const m = await p2.evaluate(() => window.__mock);
    assert.strictEqual(m.subject, "General Inquiry"); assert.strictEqual(m.sentText, "Thanks for the kind words!"); assert.strictEqual(m.sent, 2); assert.strictEqual(m.drawerOpen, false);
    ok("fill: Contact Buyer opened, General Inquiry picked, v-model saw the text, Send pressed, drawer closed");
    await p2.evaluate(() => { window.__mockFail = "nosend"; });
    r = await p2.evaluate(() => window.__send({ type: "cardcomp-fb-fill", order: "92588719-TEST01-00001", text: "again" }));
    assert.strictEqual(r.ok, false); assert.strictEqual(r.clicked, true); assert.ok(/did not confirm/.test(r.why)); ok("Send that does nothing: clicked:true + reason, drawer left open for Derek");
    await p2.evaluate(() => { window.__mockFail = "nosubject"; window.__mock.subject = ""; document.querySelector("#subject span").textContent = "Select"; document.querySelectorAll("#subject-dropdown li").forEach((l) => l.setAttribute("aria-selected", "false")); document.querySelector('[data-testid="OrderDetails_ContactBuyerDrawer"]').style.display = "none"; });
    r = await p2.evaluate(() => window.__send({ type: "cardcomp-fb-fill", order: "92588719-TEST01-00001", text: "again" }));
    assert.strictEqual(r.ok, false); assert.ok(/subject/.test(r.why)); ok("subject that will not select: reported");
    await c2.close();
    console.log("4. messages.js on a mock Messages list");
    const c4 = await browser.newContext(), p4 = await c4.newPage(); const posted4 = [];
    await c4.exposeFunction("__msg", (m) => { posted4.push(m); });
    await p4.addInitScript(() => { window.chrome = { runtime: { lastError: null, sendMessage: (m, cb) => { window.__msg(m); cb && cb({ ok: true }); } } }; });
    const row = (id, order, subj, members, created) => `<tr><td></td><td><span>${members}</span></td><td><a href="https://sellerportal.tcgplayer.com/messages/${id}" data-testid="linkMessages_Home_Thread"><span>${subj}</span></a></td><td><a href="https://sellerportal.tcgplayer.com/orders/${order}" data-testid="linkMessages_Home_OrderDetailsSellerOrder"><span>${order}</span></a></td><td>Completed - Paid</td><td><span>${created}</span></td><td></td><td></td></tr>`;
    await c4.route("https://sellerportal.tcgplayer.com/messages**", (r) => r.fulfill({ contentType: "text/html", body: `<html><body><div id="app"></div><script>setTimeout(() => { document.getElementById("app").innerHTML = '<table><tbody>${row("62192274", "92588719-95D880-125F4", "General Inquiry", "Me, Andy Aguiar", "Nov 6, 2026")}${row("62176784", "92588719-FA4AB6-229FF", "Negative Experience", "Me, Cari Pennoyer", "Nov 5, 2026")}</tbody></table>'; }, 300);</script></body></html>` }));
    await p4.goto("https://sellerportal.tcgplayer.com/messages");
    await p4.addScriptTag({ path: path.join(EXT, "feedback", "messages.js") });
    await p4.waitForTimeout(1500);
    const th = posted4.find((m) => m.type === "cardcomp-fb-threads");
    assert.ok(th && th.rows.length === 2); assert.deepStrictEqual(th.rows[0], { id: "62192274", url: "https://sellerportal.tcgplayer.com/messages/62192274", order: "92588719-95D880-125F4", subject: "General Inquiry", members: "Me, Andy Aguiar", created: "Nov 6, 2026" }); ok("Messages list read: thread id, url, order, subject, members, created");
    const p4b = await c4.newPage(); const posted4b = []; await c4.exposeFunction("__msg2", (m) => { posted4b.push(m); });
    await p4b.addInitScript(() => { window.chrome = { runtime: { lastError: null, sendMessage: (m, cb) => { window.__msg2(m); cb && cb({ ok: true }); } } }; });
    await p4b.goto("https://sellerportal.tcgplayer.com/messages/62192274"); await p4b.addScriptTag({ path: path.join(EXT, "feedback", "messages.js") }); await p4b.waitForTimeout(800);
    assert.strictEqual(posted4b.length, 0); ok("a thread page is left alone");
    await c4.close();
    console.log("5. thread.js on a mock message thread");
    const threadHTML = fs.readFileSync(path.join(__dirname, "feedback-mock-thread.html"), "utf8");
    const c5 = await browser.newContext(), p5 = await c5.newPage(); const posted5 = [];
    await c5.exposeFunction("__msg", (m) => { posted5.push(m); });
    await p5.addInitScript(() => {
      window.__ccfbCountdown = 0; window.__store = { fbAddress: "2513 Example Dr, Union City, CA 94587", fbThreadSent: {} };
      window.chrome = { runtime: { lastError: null, getURL: (p) => "chrome-extension://x/" + p, sendMessage: (m, cb) => { window.__msg(m); setTimeout(() => {
        if (m.type === "cardcomp-fb-key") return cb({ ok: true });
        if (m.type === "cardcomp-fb-order") return cb({ ok: true, info: { order: m.order, buyer: "Daniel Davis", orderDate: "10/24/2026, 3:17:47 PM (PDT)", edd: "November 6, 2026", shippedAt: "10/26/2026", tracking: "", method: "Standard (7-10 days)", items: [{ name: "Pokemon - Gym Heroes: Misty's Wish - #22/132 - Near Mint", pid: "90210", price: 13, qty: 1 }, { name: "Pokemon - Gym Heroes: Erika's Jigglypuff - #7/132 - Near Mint Holofoil", pid: "90211", price: 2.44, qty: 1 }, { name: "Pokemon - SV: Prismatic Evolutions: Umbreon ex - #161/131 - Near Mint Holofoil", pid: "90212", price: 95, qty: 1 }] } });
        if (m.type === "cardcomp-fb-price") return cb(m.pid === "90210" ? { ok: true, conds: { NM: { market: 14 }, LP: { market: 9.5 }, MP: { market: 7.2 }, HP: { market: 6.6 }, DMG: { market: 6 } } } : m.pid === "90211" ? { ok: true, conds: { NM: { market: 2.5 }, DMG: { low: 0.85 } } } : { ok: true, conds: { NM: { market: 100 }, LP: { market: 80 }, MP: { market: 60 }, HP: { market: 40 }, DMG: { market: 30 } } });
        if (m.type === "cardcomp-fb-issue") return cb({ ok: true, text: "Ah sorry to hear that about " + (m.picks.cards || []).map((c) => c.name).join(" and ") + ". Total refund of $" + m.picks.total + ". Does that work?", cost: 0.02 });
        cb(null); }, 5); } },
        storage: { local: { get: (k, cb) => cb(window.__store), set: (o, cb) => { Object.assign(window.__store, o); cb && cb(); } } } };
    });
    await c5.route("https://sellerportal.tcgplayer.com/messages/**", (r) => r.fulfill({ contentType: "text/html", body: threadHTML }));
    await p5.goto("https://sellerportal.tcgplayer.com/messages/61545705");
    await p5.addScriptTag({ path: path.join(EXT, "feedback", "thread.js") });
    await p5.waitForFunction(() => document.querySelector("#ccir table") && ![...document.querySelectorAll("#ccir [data-val]")].some((e) => /reading/.test(e.textContent)), null, { timeout: 15000 });
    assert.strictEqual(await p5.$eval("#ccir [data-type]", (s) => s.value), "condition"); ok("issue type from the subject and the buyer's words");
    const vals = await p5.$$eval("#ccir tr[data-i]", (trs) => trs.map((tr) => ({ val: tr.querySelector("[data-val]").textContent.trim(), lower: tr.querySelector("[data-lower]").checked, cond: tr.dataset.cond })));
    assert.deepStrictEqual(vals.map((v) => v.cond), ["DMG", "DMG", "DMG"]); assert.deepStrictEqual(vals.map((v) => v.lower), [true, true, false]); ok("DMG by default, 'one grade lower' ticked only under $20 charged");
    await p5.selectOption('#ccir tr[data-i="0"] [data-cond]', "HP"); await p5.selectOption('#ccir tr[data-i="2"] [data-cond]', "LP");
    await p5.check('#ccir tr[data-i="0"] [data-on]'); await p5.check('#ccir tr[data-i="1"] [data-on]'); await p5.check('#ccir tr[data-i="2"] [data-on]');
    await p5.fill("#ccir [data-extra]", "2");
    const rows = await p5.$$eval("#ccir tr[data-i]", (trs) => trs.map((tr) => ({ cond: tr.dataset.cond, value: tr.dataset.value, ref: tr.dataset.ref, src: tr.dataset.src })));
    assert.deepStrictEqual(rows, [{ cond: "DMG", value: "6", ref: "7", src: "TCG market" }, { cond: "DMG", value: "0.85", ref: "2", src: "cheapest listed" }, { cond: "LP", value: "80", ref: "15", src: "TCG market" }]);
    ok("refund math: HP one lower -> DMG $6 of $13 = $7; $2.44 vs cheapest DMG listing $0.85 = $2; $95 card as described at LP $80 = $15");
    assert.strictEqual(await p5.$eval("#ccir [data-total]", (e) => e.textContent), "$26"); ok("total = refunds + extra ($24 + $2)");
    await p5.uncheck('#ccir tr[data-i="2"] [data-on]'); await p5.selectOption('#ccir tr[data-i="0"] [data-cond]', "MP"); await p5.uncheck('#ccir tr[data-i="0"] [data-lower]');
    assert.strictEqual(await p5.$eval('#ccir tr[data-i="0"]', (tr) => tr.dataset.value + "/" + tr.dataset.ref + "/" + tr.dataset.src), "7.2/6/TCG market"); ok("untick one grade lower: priced as picked (MP $7.20 -> $6 refund)");
    await p5.click("#ccir [data-draft-btn]"); await p5.waitForSelector("#ccir [data-text]");
    const iss = posted5.find((m) => m.type === "cardcomp-fb-issue");
    assert.strictEqual(iss.kind, "condition"); assert.strictEqual(iss.picks.cards.length, 2); assert.strictEqual(iss.picks.total, 10); assert.strictEqual(iss.picks.cards[0].arrived, "MP"); assert.strictEqual(iss.thread.msgs.length, 3); assert.strictEqual(iss.thread.msgs[0].me, false); assert.ok(/crease/.test(iss.thread.msgs[0].text)); assert.strictEqual(iss.address, "2513 Example Dr, Union City, CA 94587"); assert.strictEqual(iss.order.items[0].name, "Misty's Wish");
    ok("draft request: picks, total, thread oldest first with who said what, address, order items");
    assert.ok(/Total refund of \$10/.test(await p5.$eval("#ccir [data-text]", (t) => t.value))); ok("draft lands in the editable box");
    assert.strictEqual(await p5.$eval("#ccir [data-flags]", (e) => e.textContent), ""); ok("draft with only the panel's numbers: no flag");
    await p5.fill("#ccir [data-text]", "Once I get a picture I can refund $12. Thanks for the great rating!"); await p5.waitForTimeout(50);
    const fl = await p5.$eval("#ccir [data-flags]", (e) => e.textContent);
    assert.ok(/amount not from the panel: \$12/.test(fl) && /photo a condition/.test(fl) && /ratings/.test(fl) && /does not name the ticked cards: Misty's, Erika's/.test(fl)); ok("flags: invented amount, photo as a condition, ratings talk, ticked cards not named");
    await p5.fill("#ccir [data-text]", "Misty's Wish I'd refund $7 and Erika's Jigglypuff $2, so $10 total. Does that work?"); await p5.waitForTimeout(50);
    assert.strictEqual(await p5.$eval("#ccir [data-flags]", (e) => e.textContent), ""); ok("the panel's own numbers pass");
    // the buyer writes after the draft: refuse
    await p5.evaluate(() => { document.querySelector(".sp-messages-thread-drawer__messages-list").insertAdjacentHTML("afterbegin", '<li class="sp-messages-thread-message"><div class="sp-messages-thread-message__header"><div><div>Message From &lt;Daniel Davis&gt;</div><div class="typography-detail">Oct 30, 2026, 11:55 AM</div></div></div><div class="sp-messages-thread-message__body">Actually never mind</div></li>'); });
    await p5.click("#ccir [data-send]"); await p5.waitForFunction(() => /wrote since this draft/.test(document.querySelector("#ccir .note")?.textContent || ""));
    assert.strictEqual(await p5.evaluate(() => window.__mockThread.sentText), ""); ok("a new buyer message after the draft: send refused, nothing typed");
    await p5.evaluate(() => { document.querySelector("li.sp-messages-thread-message").remove(); });
    await p5.fill("#ccir [data-text]", "Edited reply for the thread");
    await p5.click("#ccir [data-send]");
    await p5.waitForFunction(() => /✓ sent/.test(document.querySelector("#ccir [data-draft]")?.textContent || ""), null, { timeout: 8000 });
    const mk = await p5.evaluate(() => window.__mockThread);
    assert.strictEqual(mk.sentText, "Edited reply for the thread"); assert.strictEqual(mk.replyOpened, 1); ok("send: Reply pressed, the thread's reply box filled through v-model, its Send pressed, new message seen");
    assert.ok(/Partial Refund, \$10, reason Product - Condition Issue/.test(await p5.$eval("#ccir [data-draft]", (e) => e.textContent))); ok("after the send: the next step on the order page is spelled out (the message moves no money)");
    const ts = await p5.evaluate(() => window.__store.fbThreadSent); const tk = Object.keys(ts)[0];
    assert.strictEqual(tk, "61545705:3"); assert.strictEqual(ts[tk].how, "sent"); ok("locked per thread + message count");
    // a second send at the same point is refused; after a new message it is allowed again
    await p5.evaluate(() => { document.querySelector("#ccir [data-draft]").innerHTML = ""; });
    await p5.evaluate(() => { document.querySelector("#ccir [data-type]").dispatchEvent(new Event("change")); }); await p5.click("#ccir [data-draft-btn]"); await p5.waitForSelector("#ccir [data-text]"); await p5.fill("#ccir [data-text]", "again");
    await p5.evaluate(() => { window.__mockThread.msgs = 3; });   // the mock's new message was appended to the list; pretend it was not, so the count is still 3
    await p5.evaluate(() => { const li = document.querySelector("li.sp-messages-thread-message"); li.remove(); });
    await p5.click("#ccir [data-send]"); await p5.waitForFunction(() => /already sent at this point/.test(document.querySelector("#ccir .note")?.textContent || ""));
    ok("same point of the thread: refused (no double send)");
    // missing-package facts
    await p5.selectOption("#ccir [data-type]", "missing");
    const facts = await p5.$eval("#ccir [data-facts]", (e) => e.textContent);
    assert.ok(/no tracking/.test(facts) && /wait until November 10/.test(facts) && /estimated delivery November 6, 2026/.test(facts)); ok("missing package: wait-until = estimated delivery + 2 business days (Fri Nov 6 -> Tue Nov 10), per the current policy");
    await p5.selectOption("#ccir [data-type]", "missingcard");
    assert.ok(/reship the card if you still have it/.test(await p5.$eval("#ccir [data-facts]", (e) => e.textContent))); ok("missing card: its own rule");
    // in-app navigation: the address changes without a page load
    await p5.evaluate(() => { history.pushState({}, "", "/messages"); }); await p5.waitForTimeout(900);
    assert.strictEqual(await p5.$("#ccir"), null); ok("back to the list without a reload: the panel is dropped");
    await p5.evaluate(() => { history.pushState({}, "", "/messages/61545705"); }); await p5.waitForSelector("#ccir table", { timeout: 8000 }); ok("a thread opened in-app: the panel mounts again");
    await c5.close();
    console.log("6. orders.js + badge.js on a mock Orders list");
    const c6 = await browser.newContext(), p6 = await c6.newPage(); const posted6 = [];
    await c6.exposeFunction("__msg", (m) => { posted6.push(m); });
    await p6.addInitScript(() => {
      const STATS = { "chris thomas": { name: "Chris Thomas", n: 3, first: Date.parse("2026-10-29"), last: Date.parse("2026-11-09"), firstTotal: 5.39, lastTotal: 21.9, spent: 37.29, spentBefore: 37.29 }, "brandon ayers": { name: "Brandon Ayers", n: 23, first: Date.parse("2025-11-02"), last: Date.parse("2026-11-01"), firstTotal: 8, lastTotal: 12, spent: 400, spentBefore: 400 } };
      window.chrome = { runtime: { lastError: null, sendMessage: (m, cb) => { window.__msg(m); setTimeout(() => {
        if (m.type === "cardcomp-fb-buyers-merge") return cb({ ok: true, added: m.orders.length });
        if (m.type === "cardcomp-fb-buyer") { const s = STATS[String(m.name).toLowerCase()]; return cb({ ok: true, stats: s ? Object.assign({}, s, { before: m.at && m.at < Date.parse("2026-11-01") ? 1 : s.n }) : null }); }
        cb(null); }, 5); } } };
    });
    const orow = (o, buyer, date, total) => `<tr><td class="tcg-table-body__select-cell"><input type="checkbox"></td><td><span><a href="https://sellerportal.tcgplayer.com/orders/${o}" data-testid="OrderIndex_Table_OrderLink">${o}</a></span></td><td>${buyer}</td><td><span>${date}</span></td><td>Ready to Ship</td><td>Standard</td><td>$${total}</td><td>$0.00</td><td>$${total}</td><td><button>…</button></td></tr>`;
    const ordersHTML = `<html><body><div id="app"></div><script>setTimeout(() => { document.getElementById("app").innerHTML = '<table data-testid="OrderIndex_Table"><tbody>${orow("92588719-1", "danny lu", "11/9/2026, 7:39:01 PM", "21.90")}${orow("92588719-2", "Chris Thomas", "11/9/2026, 1:00:00 PM", "9.38")}${orow("92588719-3", "CHRIS THOMAS", "10/29/2026, 1:00:00 PM", "5.39")}${orow("92588719-4", "Brandon Ayers", "11/1/2026, 1:00:00 PM", "12.00")}</tbody></table>'; }, 300);</script></body></html>`;
    await c6.route("https://sellerportal.tcgplayer.com/orders**", (r) => r.fulfill({ contentType: "text/html", body: ordersHTML }));
    await p6.goto("https://sellerportal.tcgplayer.com/orders");
    await p6.addScriptTag({ path: path.join(EXT, "feedback", "badge.js") }); await p6.addScriptTag({ path: path.join(EXT, "feedback", "orders.js") });
    await p6.waitForFunction(() => document.querySelectorAll(".ccbuy").length >= 2, null, { timeout: 8000 });
    await p6.waitForTimeout(400);
    const merged = posted6.find((m) => m.type === "cardcomp-fb-buyers-merge");
    assert.strictEqual(merged.orders.length, 4); assert.deepStrictEqual(merged.orders[0], { order: "92588719-1", buyer: "danny lu", at: Date.parse("11/9/2026, 7:39:01 PM"), total: 21.9 }); ok("Orders list: every row joins the buyer history (order, buyer, date, total)");
    const chips = await p6.$$eval("tr", (trs) => trs.map((tr) => { const c = tr.querySelector(".ccbuy"); return c ? c.textContent + "|" + c.className : ""; }));
    assert.deepStrictEqual(chips.filter(Boolean), ["3 orders · $37.29|ccbuy rep", "23 orders · $400.00|ccbuy reg"]); ok("badges: Chris Thomas '3 orders · $37.29' blue, Brandon Ayers '23 orders · $400.00' gold; danny lu (first order) and the Oct 29 Chris row (their first then) get nothing");
    assert.strictEqual(await p6.$$eval(".ccbuy", (e) => e.length), 2);
    assert.strictEqual(await p6.$eval("#ccopen", (e) => e.textContent.replace(/\s+/g, " ").trim()), "Ready to Ship 4 orders product $48.67 shipping $0.00 total $48.67"); ok("old table layout: open-order totals from the cell positions");
    await p6.evaluate(() => { const tb = document.querySelector("tbody"); tb.innerHTML = tb.innerHTML; });   // Vue re-render
    await p6.waitForTimeout(800);
    assert.strictEqual(await p6.$$eval(".ccbuy", (e) => e.length), 2); assert.ok(await p6.$$eval(".ccbuy", (es) => es.every((e) => e.__cchtml))); ok("re-render: badged again (live chips, not the copied markup), never twice");
    await p6.hover(".ccbuy"); await p6.waitForSelector("#ccbuypop", { state: "visible" });
    const popTxt = await p6.$eval("#ccbuypop", (e) => e.textContent.replace(/\s+/g, " "));
    assert.ok(/Chris Thomas/.test(popTxt) && /\$37\.29 lifetime · 3 orders · avg \$12\.43/.test(popTxt) && /First\s*Oct 29, 2026\s*\$5\.39/.test(popTxt) && /Last\s*Nov 9, 2026\s*\$21\.90/.test(popTxt), popTxt); ok("hover card: lifetime $, order count, average, first and last order with date and amount");
    await p6.mouse.move(0, 0); await p6.waitForTimeout(300); assert.strictEqual(await p6.$eval("#ccbuypop", (e) => e.style.display), "none"); ok("card closes when the pointer leaves");
    assert.ok(/first Oct 29, 2026 \$5\.39 · last Nov 9, 2026 \$21\.90 · avg \$12\.43/.test(await p6.evaluate(() => window.ccBuyer.detail({ n: 3, first: Date.parse("2026-10-29"), last: Date.parse("2026-11-09"), firstTotal: 5.39, lastTotal: 21.9, spent: 37.29 }).textContent))); ok("detail line (order page, thread panel): first, last, avg");
    // the grid layout TCGplayer switched to on 2026-11-10: new link label, labeled cells, "Nov-09-2026" dates, clipped cell content
    const p6g = p6, mark6 = posted6.length;   // same page: its init script (the mocked extension) runs again on navigation
    const gcell = (k, inner) => `<td data-grid-header-value="${k}" class="tcg-grid-row__cell" role="gridcell"><div class="tcg-grid-row-cell-content" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${inner}</div></td>`;
    const grow = (o, buyer, date, total) => `<tr class="tcg-grid-row" role="row">${gcell("__header_select", '<input type="checkbox">')}${gcell("orderNumber", `<span><a href="https://sellerportal.tcgplayer.com/orders/${o}" data-testid="OrderIndex_Grid_OrderLink">${o}</a></span>`)}${gcell("buyerName", `<span>${buyer}</span>`)}${gcell("orderDate", `<span><span>${date}</span></span>`)}${gcell("orderStatus", "Ready to Ship")}${gcell("shippingType", "Standard")}${gcell("productAmount", `<span>$${total}</span>`)}${gcell("shippingAmount", "<span>$1.49</span>")}${gcell("totalAmount", `<span>$${total}</span>`)}${gcell("rowActions", "<button>…</button>")}</tr>`;
    const gridHTML = `<html><body><div id="app"></div><script>setTimeout(() => { document.getElementById("app").innerHTML = '<div data-testid="OrderIndex_Grid"><table><tbody>${grow("92588719-1", "danny lu", "Nov-09-2026", "21.90")}${grow("92588719-2", "Chris Thomas", "Nov-09-2026", "9.38")}${grow("92588719-3", "CHRIS THOMAS", "Oct-29-2026", "5.39")}${grow("92588719-4", "Brandon Ayers", "Nov-01-2026", "12.00")}</tbody></table></div>'; }, 300);</script></body></html>`;
    await c6.unroute("https://sellerportal.tcgplayer.com/orders**"); await c6.route("https://sellerportal.tcgplayer.com/orders**", (r) => r.fulfill({ contentType: "text/html", body: gridHTML }));
    await p6g.goto("https://sellerportal.tcgplayer.com/orders?searchRange=LastThreeMonths&page=1&size=25");
    await p6g.addScriptTag({ path: path.join(EXT, "feedback", "badge.js") }); await p6g.addScriptTag({ path: path.join(EXT, "feedback", "orders.js") });
    await p6g.waitForFunction(() => document.querySelectorAll(".ccbuy").length >= 2, null, { timeout: 8000 }); await p6g.waitForTimeout(400);
    const mg = posted6.slice(mark6).find((m) => m.type === "cardcomp-fb-buyers-merge");
    assert.deepStrictEqual(mg.orders[0], { order: "92588719-1", buyer: "danny lu", at: new Date(2026, 10, 9).getTime(), total: 21.9 }); assert.strictEqual(mg.orders[2].at, new Date(2026, 9, 29).getTime()); assert.strictEqual(mg.orders.length, 4); ok("grid layout: rows read by their labeled cells (buyer, total), 'Nov-09-2026' = that date at local midnight");
    const gchips = await p6g.$$eval("tr", (trs) => trs.map((tr) => { const c = tr.querySelector(".ccbuy"); return c ? c.textContent + "|" + c.parentElement.className + "|" + c.parentElement.style.whiteSpace : ""; }));
    assert.deepStrictEqual(gchips.filter(Boolean), ["3 orders · $37.29|tcg-grid-row-cell-content|normal", "23 orders · $400.00|tcg-grid-row-cell-content|normal"]); ok("grid layout: chips inside the buyer cell's content, which is allowed to wrap (the grid clips at the column width); first-order rows get none");
    assert.strictEqual(await p6g.$$eval('td[data-grid-header-value="buyerName"]', (tds) => tds.filter((td) => !td.querySelector(".ccbuy")).every((td) => td.firstElementChild.style.whiteSpace === "nowrap")), true); ok("cells without a chip are left as the page drew them");
    const barTxt = () => p6g.$eval("#ccopen", (e) => e.textContent.replace(/\s+/g, " ").trim());
    assert.strictEqual(await barTxt(), "Ready to Ship 4 orders product $48.67 shipping $5.96 total $48.67"); assert.strictEqual(await p6g.$eval("#ccopen", (e) => e.nextElementSibling.getAttribute("data-testid")), "OrderIndex_Grid"); ok("open-order totals above the grid: 4 Ready to Ship rows, product / shipping / total summed from the labeled cells");
    await p6g.evaluate(() => { const tr = document.querySelectorAll("tr")[3]; tr.querySelector('td[data-grid-header-value="orderStatus"] div').textContent = "Shipped - In Transit"; const nav = document.createElement("a"); nav.setAttribute("data-testid", "linkOrders"); nav.innerHTML = '<span>Orders</span><span class="tcg-badge">9</span>'; document.body.prepend(nav); });
    await p6g.waitForFunction(() => /3 orders/.test(document.getElementById("ccopen").textContent), null, { timeout: 5000 });
    assert.strictEqual(await barTxt(), "Ready to Ship 3 orders product $36.67 shipping $4.47 total $36.67 3 of your 9 open orders are on this page: raise Rows Per Page or use the Ready to Ship filter to total them all"); ok("a shipped row leaves the sum; when the Orders badge says 9 open and 3 are on the page, the line says so");
    let reps = 0; await p6g.exposeFunction("__rep6", () => { reps++; }); await p6g.evaluate(() => new MutationObserver(() => window.__rep6()).observe(document.getElementById("ccopen"), { childList: true, subtree: true, characterData: true })); await p6g.waitForTimeout(900); assert.strictEqual(reps, 0); ok("the line is not repainted while nothing changes");
    await c6.close();
    console.log("7. customers.html: leaderboard, tiles, chart, quiet regulars, feedback");
    const c7 = await browser.newContext({ viewport: { width: 1280, height: 900 } }), p7 = await c7.newPage();
    await p7.addInitScript(() => {
      const d = (s) => Date.parse(s);
      const buyers = { "chris thomas": { name: "Chris Thomas", orders: { A: { at: d("2026-03-01"), total: 5.39 }, B: { at: d("2026-06-01"), total: 21.9 }, C: { at: d("2026-11-09"), total: 10 } } }, "danny lu": { name: "danny lu", orders: { D: { at: d("2026-11-09"), total: 3.33 } } }, "brandon ayers": { name: "Brandon Ayers", orders: Object.fromEntries([...Array(6)].map((_, i) => ["E" + i, { at: d("2026-0" + (i + 1) + "-15"), total: 20 }])) }, "old regular": { name: "Old Regular", orders: { F: { at: d("2025-12-01"), total: 30 }, G: { at: d("2026-01-01"), total: 30 }, H: { at: d("2026-02-01"), total: 40 } } } };
      const feedback = { A: { u: "Chris Thomas", r: 5, c: "Fast shipping, great card", at: d("2026-03-05") }, C: { u: "CHRIS THOMAS", r: 4, c: "", at: d("2026-11-10") }, X: { u: "Someone Else", r: 2, c: "Card was bent", at: d("2026-11-01") } };
      window.chrome = { runtime: { lastError: null, getURL: (p) => "chrome-extension://x/" + p, sendMessage: (m, cb) => setTimeout(() => { if (m.type === "cardcomp-fb-customers") return cb({ ok: true, buyers, feedback }); if (m.type === "cardcomp-fb-feedback-load") return cb({ ok: true, pages: 2, added: 1, total: 4 }); cb(null); }, 5) } };
    });
    await p7.goto("file://" + path.join(EXT, "feedback", "customers.html"));
    await p7.waitForSelector("#lb table");
    const sub = await p7.$eval("#sub", (e) => e.textContent); assert.ok(/4 buyers · 13 orders · \$261/.test(sub), sub); ok("summary: buyers, orders, revenue");
    const tiles = await p7.$$eval(".tile", (es) => es.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
    assert.ok(/^3 ?repeat buyers ?75% of buyers/.test(tiles[0]), tiles[0]); assert.ok(/revenue from repeat orders/.test(tiles[1]) && /\$202 on 2nd\+ orders/.test(tiles[1]), tiles[1]); assert.ok(/3\.67★ ?feedback average ?3 ratings · 67% with words/.test(tiles[5]), tiles[5]); ok("tiles: repeat buyers, repeat revenue, feedback average");
    const lb = await p7.$$eval("#lb tbody tr", (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.replace(/\s+/g, " ").trim())));
    assert.strictEqual(lb[0][1], "Brandon Ayers6 orders"); assert.strictEqual(lb[0][3], "$120.00"); assert.strictEqual(lb[1][1], "Old Regular3 orders"); assert.strictEqual(lb[2][1], "Chris Thomas3 orders"); assert.ok(/4\.5 · 2 · “Fast shipping, great card”/.test(lb[2][8]), lb[2][8]); assert.strictEqual(lb[3][1], "danny lu"); ok("leaderboard by lifetime spend, chips for repeat buyers, feedback column");
    await p7.click("#lb th[data-k=n]"); const lb2 = await p7.$$eval("#lb tbody tr", (trs) => trs.map((tr) => tr.children[1].textContent)); assert.strictEqual(lb2[0], "Brandon Ayers6 orders"); await p7.click("#lb th[data-k=n]"); assert.strictEqual(await p7.$eval("#lb tbody tr td:nth-child(2)", (e) => e.textContent), "danny lu"); ok("sortable columns (orders desc, then asc)");
    await p7.click('#lb tbody tr[data-k="brandon ayers"]'); assert.ok(/Orders.*E5/.test(await p7.$eval("#lb tr.det", (e) => e.textContent))); ok("a row opens its orders");
    const quiet = await p7.$eval("#quiet", (e) => e.textContent); assert.ok(/Old Regular/.test(quiet) && /Brandon/.test(quiet) && !/Chris/.test(quiet) && !/danny/.test(quiet), quiet); ok("regulars gone quiet: Old Regular (last Feb) and Brandon (monthly, last June), not Chris (ordered Nov 9), never a one-order buyer");
    assert.strictEqual(await p7.$$eval("#chart svg g[data-i]", (g) => g.length), 12); const rt = await p7.$eval("#rt", (e) => e.textContent.replace(/\s+/g, " ")); assert.ok(/Nov 26 ?2 ?1 ?1/.test(rt) && /Jul 26 ?0 ?0 ?0/.test(rt), rt); ok("chart: one column per month Dec 25 to Nov 26 (empty months kept), table view (Nov: 2 orders, 1 new, 1 returning; July empty)");
    await p7.hover("#chart svg g[data-i] rect.hit"); assert.ok(/orders/.test(await p7.$eval("#tip", (e) => e.textContent))); ok("chart hover tooltip");
    assert.ok(/Card was bent/.test(await p7.$eval("#fbsum", (e) => e.textContent))); ok("feedback: ratings bars and the latest low ratings with words");
    assert.strictEqual(tiles.length, 8); assert.ok(/needs 10\+ buyers/.test(tiles[6]), tiles[6]); assert.ok(/of orders get feedback/.test(tiles[7]) && /^15%/.test(tiles[7]) && /median 3 days/.test(tiles[7]), tiles[7]); ok("tiles: top-10% concentration (needs 10 buyers), feedback rate 2 of 13 orders, median 3 days to feedback");
    const coh = await p7.$$eval("#cohort tbody tr", (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim()).join("|")));
    assert.ok(coh.length >= 2 && coh.some((r) => /^Dec 25\|1\|0%\|100%\|100%\|100%/.test(r)) && coh.some((r) => /^Nov 26\|1\|–\|–\|–\|–/.test(r)), coh.join("\n")); ok("cohorts: Dec 25 cohort (Old Regular) back within 60 days, Nov 26 too young for any window");
    const lbq = await p7.$$eval("#lb tbody tr.x", (trs) => trs.map((tr) => tr.children[1].textContent.split(/\d/)[0].trim() + ":" + (tr.children[7].classList.contains("quiet") ? "quiet" : "") + ":" + (tr.querySelector("td.money i") ? tr.querySelector("td.money i").style.width : "")));
    assert.ok(lbq.includes("Old Regular:quiet:83%") && lbq.includes("Brandon Ayers:quiet:100%") && lbq.includes("Chris Thomas::31%"), lbq.join(" ")); ok("conditional formatting: lifetime bar scaled to the top buyer, quiet regulars tinted in 'since last'");
    assert.strictEqual(await p7.evaluate(() => document.documentElement.dataset.theme || ""), ""); await p7.click("#theme"); assert.strictEqual(await p7.evaluate(() => document.documentElement.dataset.theme), "dark"); assert.strictEqual(await p7.evaluate(() => localStorage.getItem("ccCustomersTheme")), "dark");
    assert.strictEqual(await p7.$eval("#chart .leg i", (e) => e.style.background), "rgb(57, 135, 229)"); await p7.click("#theme"); assert.strictEqual(await p7.evaluate(() => document.documentElement.dataset.theme), "light"); ok("theme toggle: dark (chart repainted in the dark pair, choice remembered), back to light");
    await p7.fill("#q", "chris"); assert.strictEqual(await p7.$$eval("#lb tbody tr", (t) => t.length), 1); ok("search filters the leaderboard");
    await p7.click("#loadnew"); await p7.waitForFunction(() => /2 pages read, 1 new, 4 feedback stored/.test(document.getElementById("fbst").textContent)); ok("load feedback: progress line from the background's reply");
    await p7.screenshot({ path: path.join(require("os").tmpdir(), "cc-customers.png") });
    await c7.close();

    console.log("8. scan.js on a mock Scan & Identify page");
    const c8 = await browser.newContext({ viewport: { width: 1280, height: 900 } }), p8 = await c8.newPage(); const posted8 = [];
    await c8.exposeFunction("__msg8", (m) => { posted8.push(m); });
    await p8.addInitScript(() => {
      const SIM = { s1: 0.91, s2: 0.42, s3: 0.93, s4: 0.63 };
      window.chrome = { runtime: { lastError: null, sendMessage: (m, cb) => { window.__msg8(m); setTimeout(() => { if (m.type === "cardcomp-scan-sim") { const k = /#(s\d)/.exec(m.scan)[1]; return cb({ ok: true, s: SIM[k] }); } cb(null); }, 10); } } };
    });
    const px = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const row8 = (id, seq, name, num, set, variant) => `<div class="manage-scans-identified-items-grid__expanded-container"><div class="manage-scans-identified-items-grid__expanded-images-container"><div><div class="image-cell"><img class="image-cell__image image-cell__image--expanded" lazy="loaded" src="${px}#${id}"></div><p class="typography-detail">Scan Image</p></div><div><div class="image-cell"><img class="image-cell__image image-cell__image--expanded" lazy="loaded" src="${px}#cat"></div><p class="typography-detail">Catalog Image</p></div></div><div class="manage-scans-identified-items-grid__expanded-body"><div class="manage-scans-identified-items-grid__expanded-details-container"><p class="typography-body font-weight-700 margin-0">${name}</p><p class="typography-detail font-weight-600 margin-0">Card #: <span>${num}</span></p><p class="typography-detail font-weight-600 margin-0">Set: <span>${set}</span></p><div class="manage-scans-identified-items-grid__variant-row"><span class="manage-scans-identified-items-grid__variant-view-text">${variant}</span></div><p class="typography-detail font-weight-600 margin-0">Scan sequence #: <span>${seq}</span></p></div><div class="manage-scans-identified-items-grid__expanded-actions-wrapper"><button data-testid="identified-item-find-new-match" onclick="document.querySelector('.find-catalog-match-drawer .tcg-drawer').style.display='block'">Find New Match</button></div></div></div>`;
    const scanHTML = `<html><body><h1>Scan &amp; Identify</h1><div id="grid">${row8("s1", 160, "Archaludon - 107/142", "107/142", "SV07: Stellar Crown", "Holofoil, Rare, Near Mint, English")}${row8("s2", 161, "Okidogi", "111/142", "SV07: Stellar Crown", "Holofoil, Rare, Near Mint, English")}${row8("s3", 162, "Okidogi", "111/142", "SV07: Stellar Crown", "Holofoil, Rare, Near Mint, English")}${row8("s4", 163, "Noivern", "150/182", "SV04: Paradox Rift", "Holofoil, Common, Near Mint, English")}</div><div class="find-catalog-match-drawer"><div class="tcg-drawer--right is-modal tcg-drawer" style="display: none;"><div class="find-catalog-match-details"><div class="find-catalog-match-details__filter-search-bar"><input type="text" placeholder="Search"></div></div></div></div></body></html>`;
    await c8.route("https://sellerportal.tcgplayer.com/scan-identify**", (r) => r.fulfill({ contentType: "text/html", body: scanHTML }));
    await p8.goto("https://sellerportal.tcgplayer.com/scan-identify");
    await p8.addScriptTag({ path: path.join(EXT, "scan", "scan.js") });
    await p8.waitForFunction(() => document.querySelectorAll(".ccsc.ok,.ccsc.chk,.ccsc.bad").length === 4, null, { timeout: 8000 });
    const badges = await p8.$$eval(".manage-scans-identified-items-grid__expanded-container", (cs) => cs.map((c) => c.querySelector(".ccsc").className.replace("ccsc ", "") + ":" + c.querySelector(".ccsc").textContent + (c.querySelector(".ccgrp") ? "|" + c.querySelector(".ccgrp").textContent : "")));
    assert.deepStrictEqual(badges, ["ok:match 0.91", "bad:⚠ 0.42|×2 same match", "ok:match 0.93|×2 same match", "chk:check 0.63"]); ok("scores: green / red / amber badges, both Okidogi rows carry '×2 same match'");
    assert.ok(posted8.filter((m) => m.type === "cardcomp-scan-sim").every((m) => /#cat$/.test(m.cat))); ok("each row sent its scan and catalog picture to the background");
    const bar = await p8.$eval("#ccscanbar", (e) => e.textContent.replace(/\s+/g, " ")); assert.ok(/4 scans 2 look right 1 check 1 likely wrong/.test(bar), bar); ok("bar counts");
    await p8.click("#ccscanbar [data-review]"); await p8.waitForSelector("#ccscanview"); let v = await p8.$eval("#ccscanview", (e) => e.textContent.replace(/\s+/g, " ")); assert.ok(/Okidogi/.test(v) && /0\.42/.test(v) && /1 of 2 flagged/.test(v), v); ok("review opens the big view on the worst flagged scan");
    await p8.keyboard.press("ArrowRight"); v = await p8.$eval("#ccscanview", (e) => e.textContent.replace(/\s+/g, " ")); assert.ok(/Noivern/.test(v) && /2 of 2/.test(v), v); await p8.keyboard.press("ArrowRight"); v = await p8.$eval("#ccscanview", (e) => e.textContent); assert.ok(/Okidogi/.test(v)); ok("arrow keys step through the flagged scans and wrap");
    await p8.keyboard.press("f"); await p8.waitForFunction(() => !document.getElementById("ccscanview")); assert.strictEqual(await p8.$eval(".find-catalog-match-drawer .tcg-drawer", (e) => e.style.display), "block"); ok("F closes the view and presses that scan's Find New Match");
    await p8.evaluate(() => { document.querySelector(".find-catalog-match-drawer .tcg-drawer").style.display = "none"; });
    // Derek re-matched the 2nd row (name changes): the bar offers the other Okidogi
    await p8.evaluate(() => { const c = document.querySelectorAll(".manage-scans-identified-items-grid__expanded-container")[1]; c.querySelector("p.font-weight-700").firstChild.textContent = "Okidogi ex - 111/142"; c.querySelector("img").src = c.querySelector("img").src.replace("#s2", "#s1"); });
    await p8.waitForFunction(() => /1 more scan had/.test(document.getElementById("ccscanbar").textContent), null, { timeout: 5000 });
    assert.ok(/Okidogi ex/.test(await p8.$eval("#ccscanbar [data-fixnext]", (e) => e.textContent))); ok("after a re-match the bar offers the remaining scan with the new card's name");
    await p8.click("#ccscanbar [data-fixnext]"); await p8.waitForFunction(() => document.querySelector(".find-catalog-match-drawer input").value !== "", null, { timeout: 6000 });
    assert.strictEqual(await p8.$eval(".find-catalog-match-drawer input", (e) => e.value), "Okidogi ex 111"); assert.ok(!/more scan/.test(await p8.$eval("#ccscanbar", (e) => e.textContent))); ok("fix next: opens the other scan's Find New Match with the name and number typed, offer cleared");
    await c8.close();
  } finally { await browser.close(); }
}
(async () => {
  await bgTests(); await pageTests();
  console.log("\n" + n + " checks passed");
})().catch((e) => { console.error("FAILED:", e && e.stack || e); process.exit(1); });
