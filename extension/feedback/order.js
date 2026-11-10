// Feedback thank-yous: the order page (sellerportal.tcgplayer.com/orders/<id>). On load it reports what the page shows
// (cards, feedback text and date, buyer) to the background; on "cardcomp-fb-fill" it opens Contact Buyer, picks the
// subject General Inquiry, types the approved message and presses Send, then reports whether the drawer closed. The
// page's own markup carries data-testid labels, used here over text heuristics (same rule as whatnot.js).
(() => {
  const ORDER = (location.pathname.match(/\/orders\/([^/?#]+)/) || [])[1] || "";
  if (!ORDER) return;
  const $ = (id) => document.querySelector('[data-testid="' + id + '"]');
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
  const visible = (el) => !!el && el.style.display !== "none" && el.getClientRects().length > 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(fn, ms, step) { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step || 150); } }
  function readOrder() {
    const links = [...document.querySelectorAll('[data-testid="OrderDetails_ProductList_ProductLink"]')], products = links.map(txt).filter(Boolean);
    if (!products.length) return null;
    const pids = [...new Set(links.map((a) => (/productSearch\/(\d+)/.exec(a.getAttribute("href") || "") || [])[1]).filter(Boolean))];   // TCGplayer product ids, for the thumbnail
    const fb = $("OrderDetails_OrderFeedback");
    // per line: name, product id, what was charged (TCG MP Price column), quantity (the issue helper's refund math)
    // The product table is on the page twice (the Products section and the Contact Buyer drawer, 2026-11-06: every card
    // showed twice in the thread panel), so one line per product id (else name).
    const seenItem = new Set();
    const items = [...new Set(links.map((a) => a.closest("tr")).filter(Boolean))].map((tr) => {
      const a = tr.querySelector('[data-testid="OrderDetails_ProductList_ProductLink"]'), tds = [...tr.querySelectorAll("td")].map(txt);
      const money = (s) => { const m = /\$\s?([\d,]+\.?\d*)/.exec(s || ""); return m ? parseFloat(m[1].replace(/,/g, "")) : null; };
      return { name: txt(a), pid: (/productSearch\/(\d+)/.exec(a.getAttribute("href") || "") || [])[1] || "", price: money(tds[1]), qty: parseInt(tds[2], 10) || 1, ext: money(tds[3]) };
    }).filter((it) => { const k = (it.pid || it.name) + "|" + it.name; if (seenItem.has(k)) return false; seenItem.add(k); return true; });
    const ship = txt($("OrderDetails_ShippingInformation")), gen = txt($("OrderDetails_GeneralInfo")) + " " + txt($("OrderDetails_CustomerDetails"));
    const edd = (/Estimated Delivery Date:?\s*([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(ship + " " + gen) || [])[1] || "";
    const shippedAt = (/SHIPPED\s*(\d{1,2}\/\d{1,2}\/\d{4}[^()]*\([A-Z]+\))/.exec(ship) || [])[1] || "";
    const tracking = /No Tracking Number/i.test(ship) ? "" : (txt($("OrderDetails_ShippingInformation_TrackingDetail")) || "");
    const orderDate = (/Order Date\s*(\d{1,2}\/\d{1,2}\/\d{4}[^(]*\([A-Z]+\))/.exec(gen) || [])[1] || "";
    return { type: "cardcomp-fb-order-info", order: ORDER, products: [...new Set(products)], pids, items, edd, shippedAt, tracking, orderDate, status: txt($("OrderDetails_OrderStatusBadges_OrderStatus")), method: (/Shipping Method\s*([^$]*?)\s*Estimated/.exec(gen) || [])[1] || "",
      feedback: txt($("OrderDetails_OrderFeedback_Text")), fbDate: txt($("OrderDetails_OrderFeedback_Date")),
      hasFeedback: !!fb, buyer: txt($("OrderDetails_CustomerDetails_BuyerDetails")).replace(/^Buyer\s*/i, "").split(/View Messages|Contact Buyer/)[0].trim() };
  }
  const post = (m) => new Promise((res) => { try { chrome.runtime.sendMessage(m, (r) => { void chrome.runtime.lastError; res(r); }); } catch (_) { res(null); } });
  // Report once the product list is on the page (the app renders after its API calls). The order also joins the buyer
  // history and the buyer's name gets the repeat-buyer badge (badge.js).
  until(readOrder, 25000, 250).then(async (info) => {
    if (!info) return;
    post(info);
    if (!window.ccBuyer || !info.buyer) return;
    const at = Date.parse(String(info.orderDate || "").replace(/\s*\([A-Z]{2,4}\)\s*$/, "")) || 0;
    const total = (() => { const t = txt($("OrderDetails_TransactionDetails")); const m = /Order Amount\s*\$\s?([\d,]+\.?\d*)/.exec(t); return m ? parseFloat(m[1].replace(/,/g, "")) : (info.items || []).reduce((s, it) => s + (it.ext || 0), 0); })();
    await window.ccBuyer.merge([{ order: ORDER, buyer: info.buyer, at, total }]);
    const s = await window.ccBuyer.stats(info.buyer, at), chip = window.ccBuyer.chip(s, at);
    const host = $("OrderDetails_CustomerDetails_BuyerDetails");
    if (chip && host && !host.querySelector(".ccbuy")) {
      const p = [...host.querySelectorAll("p,span,div")].find((el) => txt(el) === info.buyer) || host; p.appendChild(chip);
      const d = window.ccBuyer.detail(s); if (d) (p.parentElement || host).insertBefore(d, p.nextSibling);   // first / last / avg, in plain view
    }
  });

  // Set a Vue-bound textarea: native setter + input event, so v-model sees it.
  function setText(ta, text) {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    ta.focus(); set.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true })); ta.dispatchEvent(new Event("change", { bubbles: true }));
    return ta.value === text;
  }
  async function pickSubject(drawer, want) {
    const trig = drawer.querySelector("#subject, .tcg-input-select__trigger");
    if (!trig) return "no subject picker";
    if (txt(trig) === want) return "";
    trig.click();
    const li = await until(() => [...drawer.querySelectorAll('li[role="option"]')].find((l) => (l.getAttribute("aria-label") || txt(l)) === want), 2500);
    if (!li) return "subject list did not open";
    li.click();
    const ok = await until(() => txt(trig) === want || li.getAttribute("aria-selected") === "true", 2500);
    return ok ? "" : "could not pick the subject";
  }
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  // expect: {comment, user} from the Feedback tab row. The page must show that same feedback before anything is typed
  // (a message cannot be unsent): the order's feedback text must match the row's, and the buyer should look like the
  // username (first word) when the username has a plain first word at all.
  function matches(info, expect) {
    if (!expect) return "";
    if (!info.feedback) return "the order page shows no feedback";
    if (norm(info.feedback) !== norm(expect.comment)) return "the order page's feedback differs from the row (" + info.feedback.slice(0, 60) + ")";
    // TCGplayer usernames are mostly "firstname x1234" (robert s78A1F72); a one-word handle (xMissAlyssax, PKG_Collectibles) says nothing about the name
    const parts = norm(expect.user).split(" "), first = parts[0] || "", bfirst = (norm(info.buyer).split(" ")[0] || "");
    if (parts.length >= 2 && first.length >= 3 && bfirst.length >= 3 && /^[a-z]+$/.test(first) && first !== bfirst && !bfirst.startsWith(first) && !first.startsWith(bfirst)) return "buyer on the order (" + info.buyer + ") does not look like " + expect.user;
    return "";
  }
  async function fill(text, expect) {
    const info = await until(readOrder, 15000, 250);
    if (!info) return { ok: false, why: "order page not loaded" };
    const mm = matches(info, expect); if (mm) return { ok: false, why: mm };
    const btn = $("OrderDetails_CustomerDetails_btnContactBuyer");
    if (!btn) return { ok: false, why: "no Contact Buyer button (buyer blocked, or the page changed)" };
    const drawer = $("OrderDetails_ContactBuyerDrawer");
    if (!visible(drawer)) { btn.click(); if (!(await until(() => visible(drawer) ? drawer : null, 4000))) return { ok: false, why: "Contact Buyer drawer did not open" }; }
    await sleep(300);
    const why = await pickSubject(drawer, "General Inquiry"); if (why) return { ok: false, why };
    const ta = $("OrderDetails_ContactBuyer_TextareaMessage");
    if (!ta) return { ok: false, why: "no message box" };
    if (!setText(ta, text)) return { ok: false, why: "could not type the message" };
    await sleep(250);
    const send = $("OrderDetails_ContactBuyer_ButtonSendMessage");
    if (!send) return { ok: false, why: "no Send button" };
    if (send.disabled || send.getAttribute("aria-disabled") === "true") return { ok: false, why: "Send is disabled on the page" };
    send.click();
    // Sent = the drawer closed or the box emptied. Otherwise leave everything as is for Derek to look at; clicked:true
    // tells the panel the outcome is unknown (maybe sent), so it is never retried automatically.
    const done = await until(() => (!visible(drawer) || ta.value === "") ? true : null, 10000, 200);
    return done ? { ok: true, clicked: true } : { ok: false, clicked: true, why: "Send was pressed but the page did not confirm" };
  }
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg || msg.type !== "cardcomp-fb-fill") return;
    if (msg.order && msg.order !== ORDER) { reply({ ok: false, why: "tab shows another order" }); return; }
    fill(String(msg.text || "").trim(), msg.expect || null).then(reply, (e) => reply({ ok: false, why: e.message }));
    return true;
  });
})();
