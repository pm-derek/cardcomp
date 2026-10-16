// Runs on TCGplayer product pages opened from CardComp (the "LP ↗" / market links carry
// ?Printing=...&Condition=...). Reads the market price for that condition, and the lowest
// listing, and sends them back to CardComp, which swaps the row's market for the live number
// and recomputes the bid. Heuristic: TCGplayer's markup is undocumented.

const COND = { "Near Mint": "NM", "Lightly Played": "LP", "Moderately Played": "MP", "Heavily Played": "HP", "Damaged": "DMG" };
let last = "";

function ctx() {
  const pid = (location.pathname.match(/\/product\/(\d+)/) || [])[1];
  const q = new URLSearchParams(location.search);
  const condName = q.get("Condition") || "";
  return { pid, printing: q.get("Printing") || "", condName, cond: COND[condName] || "" };
}
const money = (s) => { const m = /\$\s?([\d,]+\.\d{2})/.exec(s || ""); return m ? parseFloat(m[1].replace(/,/g, "")) : null; };
const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

function marketPrice(condName) {
  // 1. a row / block that names the condition and carries a price (TCGplayer's per-condition price points)
  if (condName) {
    const rows = [...document.querySelectorAll("tr,li,div,section")].filter((el) => {
      const t = (el.textContent || "").trim();
      return t.length < 160 && t.includes(condName) && /market/i.test(t) && money(t) != null;
    });
    rows.sort((a, b) => a.textContent.length - b.textContent.length);
    if (rows[0]) return money(rows[0].textContent);
  }
  // 2. the "Market Price" label and the first $ amount next to it
  const labels = [...document.querySelectorAll("*")].filter((el) => el.children.length === 0 && /^\s*market price:?\s*$/i.test(el.textContent || ""));
  for (const lab of labels) {
    let el = lab;
    for (let i = 0; i < 4 && el; i++, el = el.parentElement) {
      const v = money(el.textContent.replace(/market price/i, ""));
      if (v != null && el.textContent.length < 400) return v;
    }
  }
  return null;
}

function lowestListing(condName) {
  // listing cards carry an "Add to Cart" button; take the first $ amount in a small ancestor that names the condition
  const btns = [...document.querySelectorAll("button,a,[role=button]")].filter((b) => /add to cart/i.test(b.textContent || "") && visible(b));
  let low = null;
  for (const b of btns) {
    let el = b;
    for (let i = 0; i < 8 && el; i++, el = el.parentElement) {
      const t = el.textContent || "";
      if (t.length > 1500) break;
      if ((!condName || t.includes(condName)) && money(t) != null && /shipping|free/i.test(t)) {
        const v = money(t);
        if (v != null && (low == null || v < low)) low = v;
        break;
      }
    }
  }
  return low;
}

function report() {
  const c = ctx();
  if (!c.pid) return;
  const market = marketPrice(c.condName), low = lowestListing(c.condName);
  if (market == null && low == null) return;
  const key = [c.pid, c.printing, c.cond, market, low].join("|");
  if (key === last) return;
  last = key;
  try { chrome.runtime.sendMessage({ type: "cardcomp-tcg-price", pid: c.pid, printing: c.printing, cond: c.cond, market, low, href: location.href }); } catch (_) {}
}

// Prices render after load, and the condition filter is client-side routing: poll, lightly.
let href = location.href, tries = 0;
const tick = () => {
  if (location.href !== href) { href = location.href; last = ""; tries = 0; }
  report();
  tries++;
  setTimeout(tick, tries < 20 ? 500 : 2000);
};
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", tick); else tick();
