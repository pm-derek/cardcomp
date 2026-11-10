// Repeat-buyer badge (Derek, 2026-11-09: "keep track of repeat customers, a counter or 'new' next to each buyer's
// name"). Shared by the content scripts (listed before each in the manifest): asks the background for a buyer's
// history (fbBuyers, built from the Options page CSV import plus every Orders list / order page seen) and renders
// one small chip for repeat buyers only ("3 orders"; on a list row the count is as of that order's date). Names are
// matched case-insensitively with spaces collapsed. Hover: first, last, total spent.
(() => {
  if (window.ccBuyer) return;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const post = (m) => new Promise((res) => { try { chrome.runtime.sendMessage(m, (r) => { void chrome.runtime.lastError; res(r || null); }); } catch (_) { res(null); } });
  const ord = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd", "th", "th", "th", "th", "th", "th"][n % 10]);
  const mon = (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", year: "numeric" });
  const day = (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  let styled = false;
  function style() {
    if (styled) return; styled = true;
    const st = document.createElement("style");
    st.textContent = `.ccbuy{display:inline-block;font:600 11px/1.5 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;border-radius:999px;padding:0 7px;margin-left:6px;vertical-align:middle;white-space:nowrap;cursor:default}
.ccbuy.new{background:#eef2f6;color:#5f6b7a}.ccbuy.rep{background:#e0ecff;color:#1849a9}.ccbuy.reg{background:#fff1cc;color:#8a5a00}`;
    document.head.appendChild(st);
  }
  // stats: {n, first, last, spent, before} (before = orders on or before atMs, when atMs was given). Repeat buyers only
  // (Derek, 2026-11-09: "just a count, most buyers are new"): nothing for a first order, "3 orders" otherwise, gold from 5.
  function chip(stats, atMs) {
    if (!stats || !stats.n || stats.n < 2) return null;
    const k = atMs ? Math.max(1, stats.before || 1) : stats.n;
    if (k < 2) return null;   // on this order they were still new
    style();
    const el = document.createElement("span");
    el.className = "ccbuy " + (k >= 5 ? "reg" : "rep");
    el.textContent = k + " orders";
    el.title = `${stats.n} orders since ${mon(stats.first)} · last ${day(stats.last)} · $${(stats.spent || 0).toFixed(2)} total` + (atMs && k !== stats.n ? ` · this was their ${ord(k)}` : "");
    return el;
  }
  async function stats(name, atMs) { const r = await post({ type: "cardcomp-fb-buyer", name, at: atMs || 0 }); return r && r.ok ? r.stats : null; }
  async function merge(orders) { return post({ type: "cardcomp-fb-buyers-merge", orders }); }
  const line = (s) => !s || !s.n || s.n < 2 ? "" : `${s.n} orders since ${mon(s.first)}, $${(s.spent || 0).toFixed(2)} total, last ${day(s.last)}`;
  window.ccBuyer = { chip, stats, merge, line, esc };
})();
