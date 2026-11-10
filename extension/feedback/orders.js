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
        return { buyerTd, host: buyerTd.querySelector(".tcg-grid-row-cell-content") || buyerTd, order: txt(a), buyer: nameOf(buyerTd), at: when(txt(dateTd)), total: money(txt(totalTd)),
          status: txt(col("orderStatus") || tds[oi + 3]), product: money(txt(col("productAmount") || tds[oi + 5])), shipping: money(txt(col("shippingAmount") || tds[oi + 6])) };
      }).filter((r) => r && r.order && r.buyer);
      openBar(rows);
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
  // Open-order totals (Derek, 2026-11-10: "a sum of the orders whose status is Ready to Ship: product, shipping, total,
  // as I generate a new pull sheet"). Sums the Ready to Ship rows on the page, one line above the list. The Orders
  // menu badge is the open-order count: when it is larger than the rows summed, the line says how many are on this page
  // (the list shows 25 a page), so a partial total is never read as the whole. Repainted only when its text changes
  // (the page observer would loop otherwise).
  const usd = (v) => "$" + (Math.round((v || 0) * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let barSig = "";
  function openBar(rows) {
    const seen = new Set(), open = rows.filter((r) => /ready to ship/i.test(r.status) && !seen.has(r.order) && seen.add(r.order));
    const badge = parseInt(txt(document.querySelector('[data-testid="linkOrders"] .tcg-badge')), 10) || 0;
    const anchor = document.querySelector('[data-testid="OrderIndex_QuickFilters_Container"]') || document.querySelector('[data-testid="OrderIndex_Grid"], [data-testid="OrderIndex_Table"]');
    let bar = document.getElementById("ccopen");
    if (!anchor || (!open.length && !badge)) { if (bar) { bar.remove(); barSig = ""; } return; }
    const sum = (k) => open.reduce((t, r) => t + (r[k] || 0), 0);
    const part = badge > open.length ? ` <span class="w">${open.length} of your ${badge} open orders are on this page: raise Rows Per Page or use the Ready to Ship filter to total them all</span>` : "";
    const html = open.length ? `<b>Ready to Ship</b> <span>${open.length} order${open.length === 1 ? "" : "s"}</span> <span>product <b>${usd(sum("product"))}</b></span> <span>shipping <b>${usd(sum("shipping"))}</b></span> <span>total <b>${usd(sum("total"))}</b></span>${part}`
      : `<b>Ready to Ship</b> <span class="w">none of your ${badge} open orders are on this page: use the Ready to Ship filter to total them</span>`;
    if (bar && bar.isConnected && html === barSig) return;
    if (!bar) {
      bar = document.createElement("div"); bar.id = "ccopen";
      const st = document.createElement("style"); st.textContent = `#ccopen{display:flex;flex-wrap:wrap;gap:6px 18px;align-items:baseline;margin:10px 0 14px;padding:9px 14px;background:#f3f7ff;border:1px solid #c7d7f5;border-left:4px solid #1849a9;border-radius:8px;font:14px/1.5 -apple-system,"Segoe UI",Roboto,Inter,Arial,sans-serif;color:#1f2a37;font-variant-numeric:tabular-nums}#ccopen b{font-weight:700}#ccopen .w{color:#8a5a00;flex-basis:100%;font-size:12.5px}`;
      document.head.appendChild(st);
    }
    bar.innerHTML = html; barSig = html;
    if (bar.previousElementSibling !== anchor) anchor.insertAdjacentElement(anchor.matches('[data-testid="OrderIndex_QuickFilters_Container"]') ? "afterend" : "beforebegin", bar);
  }
  let t = null;
  const kick = () => { clearTimeout(t); t = setTimeout(pass, 250); };
  const start = () => { kick(); new MutationObserver(kick).observe(document.body, { childList: true, subtree: true }); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
