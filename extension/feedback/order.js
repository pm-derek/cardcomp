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
    const products = [...document.querySelectorAll('[data-testid="OrderDetails_ProductList_ProductLink"]')].map(txt).filter(Boolean);
    if (!products.length) return null;
    const fb = $("OrderDetails_OrderFeedback");
    return { type: "cardcomp-fb-order-info", order: ORDER, products: [...new Set(products)], feedback: txt($("OrderDetails_OrderFeedback_Text")), fbDate: txt($("OrderDetails_OrderFeedback_Date")),
      hasFeedback: !!fb, buyer: txt($("OrderDetails_CustomerDetails_BuyerDetails")).replace(/^Buyer\s*/i, "").split(/View Messages|Contact Buyer/)[0].trim() };
  }
  const post = (m) => new Promise((res) => { try { chrome.runtime.sendMessage(m, (r) => { void chrome.runtime.lastError; res(r); }); } catch (_) { res(null); } });
  // Report once the product list is on the page (the app renders after its API calls).
  until(readOrder, 25000, 250).then((info) => { if (info) post(info); });

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
  async function fill(text) {
    if (!(await until(readOrder, 15000, 250))) return { ok: false, why: "order page not loaded" };
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
    // Sent = the drawer closed or the box emptied. Otherwise leave everything as is for Derek to look at.
    const done = await until(() => (!visible(drawer) || ta.value === "") ? true : null, 10000, 200);
    return done ? { ok: true } : { ok: false, why: "Send did not go through, check the order tab" };
  }
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg || msg.type !== "cardcomp-fb-fill") return;
    if (msg.order && msg.order !== ORDER) { reply({ ok: false, why: "tab shows another order" }); return; }
    fill(String(msg.text || "").trim()).then(reply, (e) => reply({ ok: false, why: e.message }));
    return true;
  });
})();
