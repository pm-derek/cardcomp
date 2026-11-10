// Orders list (sellerportal.tcgplayer.com/orders, a Vue table): every row seen (order, buyer, date, total) goes into the
// buyer history, and a repeat-buyer badge is drawn after each buyer name. Re-badges when the table re-renders (filters,
// pages, sorting). Read only.
(() => {
  if (!/^\/orders\/?$/.test(location.pathname)) return;
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
  const money = (s) => { const m = /\$\s?([\d,]+\.?\d*)/.exec(s || ""); return m ? parseFloat(m[1].replace(/,/g, "")) : null; };
  const when = (s) => { const t = Date.parse(String(s || "").replace(/\s*\([A-Z]{2,4}\)\s*$/, "")); return isNaN(t) ? 0 : t; };
  const nameOf = (td) => { const c = td.cloneNode(true); c.querySelectorAll(".ccbuy").forEach((x) => x.remove()); return txt(c); };
  let busy = false, pending = false;
  async function pass() {
    if (busy) { pending = true; return; }
    busy = true;
    try {
      const rows = [...document.querySelectorAll('a[data-testid="OrderIndex_Table_OrderLink"]')].map((a) => {
        const tr = a.closest("tr"); if (!tr) return null;
        const tds = [...tr.querySelectorAll("td")];
        const oi = tds.findIndex((td) => td.contains(a)); if (oi < 0) return null;
        const buyerTd = tds[oi + 1], dateTd = tds[oi + 2], totalTd = tds[oi + 7] || tds[tds.length - 2];
        return { buyerTd, order: txt(a), buyer: nameOf(buyerTd), at: when(txt(dateTd)), total: money(txt(totalTd)) };
      }).filter((r) => r && r.order && r.buyer);
      if (!rows.length) return;
      await window.ccBuyer.merge(rows.map((r) => ({ order: r.order, buyer: r.buyer, at: r.at, total: r.total })));
      for (const r of rows) {
        if (r.buyerTd.querySelector(".ccbuy")) continue;
        const s = await window.ccBuyer.stats(r.buyer, r.at);
        const c = window.ccBuyer.chip(s, r.at);
        if (c && !r.buyerTd.querySelector(".ccbuy")) r.buyerTd.appendChild(c);
      }
    } finally { busy = false; if (pending) { pending = false; setTimeout(pass, 50); } }
  }
  let t = null;
  const kick = () => { clearTimeout(t); t = setTimeout(pass, 250); };
  const start = () => { kick(); new MutationObserver(kick).observe(document.body, { childList: true, subtree: true }); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
