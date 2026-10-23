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
      // not a listing row ("Add to Cart" / shipping): those carry a seller's asking price, not the market price
      return t.length < 160 && t.includes(condName) && /market/i.test(t) && money(t) != null && !/add to cart|shipping/i.test(t);
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

let reported = false;   // anything read since this page / filter loaded
// Wait for the page to settle (Pikachu EX XY174 Jumbo, 2026-10-22: the LP listings rendered before the market price, so the
// first report was "low $29" alone, CardComp showed it as the LP price, and the market $18.53 replaced it a moment later):
// report only when the same read holds for 2 ticks (1 s), and a listing price without a market only after 6 s.
let prevRead = "", stable = 0, t0 = Date.now();
function send(extra) {
  const c = ctx();
  try { chrome.runtime.sendMessage(Object.assign({ type: "cardcomp-tcg-price", pid: c.pid, printing: c.printing, cond: c.cond, href: location.href }, extra)); } catch (_) {}
}
function report() {
  const c = ctx();
  if (!c.pid) return false;
  const market = marketPrice(c.condName), low = lowestListing(c.condName);
  if (market == null && low == null) return false;
  const key = [c.pid, c.printing, c.cond, market, low].join("|");
  if (key !== prevRead) { prevRead = key; stable = 0; return true; }   // changed since the last tick: wait for it to hold
  if (++stable < 2) return true;
  if (market == null && Date.now() - t0 < 6000) return true;          // a listing alone: give the market price time to render
  if (key === last) return true;
  last = key;
  send({ market, low });
  reported = true;
  return true;
}

// Prices render after load, and the condition filter is client-side routing: poll, lightly.
let href = location.href, tries = 0;
const tick = () => {
  if (location.href !== href) { href = location.href; last = ""; tries = 0; reported = false; prevRead = ""; stable = 0; t0 = Date.now(); }
  report();
  tries++;
  if (tries === 16 && !reported) send({ none: true });   // 8 s and nothing read: tell CardComp so Derek knows the reader missed
  setTimeout(tick, tries < 20 ? 500 : 2000);
};
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", tick); else tick();
