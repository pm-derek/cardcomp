// Orders list (sellerportal.tcgplayer.com/orders, a Vue app): every row seen (order, buyer, date, total) goes into the
// buyer history, and a repeat-buyer badge is drawn after each buyer name. Re-badges when the list re-renders (filters,
// pages, sorting). Read only.
// Two layouts (TCGplayer swapped them 2026-11-10): the old table (OrderIndex_Table_OrderLink, cells by position, dates
// "11/9/2026, 7:39:01 PM") and the grid (OrderIndex_Grid_OrderLink, every cell labeled data-grid-header-value =
// buyerName / orderDate / totalAmount, dates "Nov-09-2026" with no time). Grid cells clip their text at the column
// width, so a cell that gets a chip is allowed to wrap.
(() => {
  if (!/^\/orders\/?$/.test(location.pathname)) return;
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
  const money = (s) => { const m = /\$\s?([\d,]+\.?\d*)/.exec(s || ""); return m ? parseFloat(m[1].replace(/,/g, "")) : null; };
  const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const when = (s) => {
    s = String(s || "").trim();
    const g = /^([A-Za-z]{3})[a-z]*[- ](\d{1,2})[-, ]+(\d{4})$/.exec(s);   // the grid's "Nov-09-2026": a date, no time (local midnight)
    if (g && MON[g[1].toLowerCase()] != null) return new Date(+g[3], MON[g[1].toLowerCase()], +g[2]).getTime();
    const t = Date.parse(s.replace(/\s*\([A-Z]{2,4}\)\s*$/, "")); return isNaN(t) ? 0 : t;
  };
  const nameOf = (td) => { const c = td.cloneNode(true); c.querySelectorAll(".ccbuy").forEach((x) => x.remove()); return txt(c); };
  let busy = false, pending = false;
  async function pass() {
    if (busy) { pending = true; return; }
    busy = true;
    try {
      const rows = [...document.querySelectorAll('a[data-testid="OrderIndex_Grid_OrderLink"], a[data-testid="OrderIndex_Table_OrderLink"]')].map((a) => {
        const tr = a.closest("tr"); if (!tr) return null;
        const tds = [...tr.querySelectorAll("td")];
        const oi = tds.findIndex((td) => td.contains(a)); if (oi < 0) return null;
        const col = (k) => tr.querySelector('td[data-grid-header-value="' + k + '"]');   // grid: cells are labeled
        const buyerTd = col("buyerName") || tds[oi + 1], dateTd = col("orderDate") || tds[oi + 2], totalTd = col("totalAmount") || tds[oi + 7] || tds[tds.length - 2];
        if (!buyerTd) return null;
        return { buyerTd, host: buyerTd.querySelector(".tcg-grid-row-cell-content") || buyerTd, order: txt(a), buyer: nameOf(buyerTd), at: when(txt(dateTd)), total: money(txt(totalTd)) };
      }).filter((r) => r && r.order && r.buyer);
      if (!rows.length) return;
      await window.ccBuyer.merge(rows.map((r) => ({ order: r.order, buyer: r.buyer, at: r.at, total: r.total })));
      for (const r of rows) {
        const have = r.buyerTd.querySelector(".ccbuy");
        if (have && have.__cchtml) continue;
        if (have) have.remove();   // a re-render copied the chip as markup only (no hover card): draw it again
        const s = await window.ccBuyer.stats(r.buyer, r.at);
        const c = window.ccBuyer.chip(s, r.at);
        if (c && !r.buyerTd.querySelector(".ccbuy")) {
          r.host.appendChild(c);
          if (r.host !== r.buyerTd) { r.host.style.whiteSpace = "normal"; r.host.style.overflow = "visible"; }   // the grid clips at the column width: let this cell wrap
        }
      }
    } finally { busy = false; if (pending) { pending = false; setTimeout(pass, 50); } }
  }
  let t = null;
  const kick = () => { clearTimeout(t); t = setTimeout(pass, 250); };
  const start = () => { kick(); new MutationObserver(kick).observe(document.body, { childList: true, subtree: true }); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
