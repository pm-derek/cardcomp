// Repeat-buyer badge (Derek, 2026-11-09: "keep track of repeat customers, a counter or 'new' next to each buyer's
// name"; 2026-11-10: "add total $ spent, like LTV; last order date and $; first order date and $"). Shared by the
// content scripts (listed before each in the manifest): asks the background for a buyer's history (fbBuyers, built
// from the Options page CSV import plus every Orders list / order page seen) and renders one small chip for repeat
// buyers only: "3 orders · $37.29" (on a list row: as of that order). Hover or tap opens a card with the lifetime
// total, first and last order (date, amount) and the average order. `detail(stats)` is the same as one plain line, for
// pages with room (order page, thread panel). Names are matched case-insensitively with spaces collapsed.
(() => {
  if (window.ccBuyer) return;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const post = (m) => new Promise((res) => { try { chrome.runtime.sendMessage(m, (r) => { void chrome.runtime.lastError; res(r || null); }); } catch (_) { res(null); } });
  const ord = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd", "th", "th", "th", "th", "th", "th"][n % 10]);
  const mon = (ms) => ms ? new Date(ms).toLocaleDateString("en-US", { month: "short", year: "numeric" }) : "?";
  const day = (ms) => ms ? new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "?";
  const usd = (v) => "$" + (Math.round((v || 0) * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let styled = false;
  function style() {
    if (styled) return; styled = true;
    const st = document.createElement("style");
    st.textContent = `.ccbuy{display:inline-block;font:600 11px/1.5 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;border-radius:999px;padding:0 7px;margin-left:6px;vertical-align:middle;white-space:nowrap;cursor:default}
.ccbuy.rep{background:#e0ecff;color:#1849a9}.ccbuy.reg{background:#fff1cc;color:#8a5a00}
.ccbuyd{font:12px/1.5 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#5f6b7a;margin-top:2px;white-space:nowrap}
#ccbuypop{position:fixed;z-index:2147483647;background:#fff;color:#1f2a37;border:1px solid #d5dbe3;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.14);padding:9px 12px;font:12px/1.55 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;min-width:230px;pointer-events:none}
#ccbuypop b{font-size:13px;color:#111}#ccbuypop table{border-collapse:collapse;margin-top:4px}#ccbuypop td{padding:1px 10px 1px 0;white-space:nowrap}#ccbuypop td:last-child{text-align:right;padding-right:0;font-variant-numeric:tabular-nums}
#ccbuypop .k{color:#5f6b7a}#ccbuypop .ltv{color:#1849a9;font-weight:700}#ccbuypop .nth{color:#8a5a00;margin-top:4px}
#ccbuypop .fbh,.ccsaid .fbh{margin-top:6px;padding-top:6px;border-top:1px solid #e6eaf0;color:#5f6b7a}#ccbuypop .fbq,.ccsaid .fbq{margin-top:2px;max-width:360px;white-space:normal}
.ccsaid{font:12px/1.5 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#1f2a37;margin-top:4px}.ccsaid .fbh{border:0;padding:0;margin:0}.ccsaid .k{color:#5f6b7a}
.good{color:#067647}.bad{color:#b54708}`;
    document.head.appendChild(st);
  }
  // The hover card: one shared element, placed under the chip (above it near the bottom edge), closed on leave.
  let pop = null, popFor = null, hideT = null;
  const starsOf = (n) => "★".repeat(Math.max(0, Math.min(5, n))) + "☆".repeat(Math.max(0, 5 - Math.min(5, n)));
  // The feedback they left (stats.fb, newest first): a line per worded one (up to max), else the ratings alone.
  function fbLines(fb, max) {
    fb = fb || []; if (!fb.length) return "";
    const worded = fb.filter((x) => x.c);
    const avg = fb.reduce((s, x) => s + (x.r || 0), 0) / fb.length;
    let h = `<div class="fbh">Feedback for you: ${fb.length} rating${fb.length === 1 ? "" : "s"} · avg ${avg.toFixed(1)}★${worded.length ? "" : " · no words"}</div>`;
    for (const x of worded.slice(0, max)) h += `<div class="fbq"><span class="${x.r >= 4 ? "good" : "bad"}">${starsOf(x.r)}</span> “${esc(x.c)}” <span class="k">${esc(day(x.at))}</span></div>`;
    if (worded.length > max) h += `<div class="k">+${worded.length - max} more</div>`;
    return h;
  }
  function popHTML(s, k) {
    const avg = s.n ? s.spent / s.n : 0;
    return `<b>${esc(s.name || "")}</b>` + (s.n ? `<div><span class="ltv">${usd(s.spent)}</span> <span class="k">lifetime · ${s.n} order${s.n === 1 ? "" : "s"} · avg ${usd(avg)}</span></div>
<table><tr><td class="k">First</td><td>${esc(day(s.first))}</td><td>${s.firstTotal != null ? usd(s.firstTotal) : ""}</td></tr>
<tr><td class="k">Last</td><td>${esc(day(s.last))}</td><td>${s.lastTotal != null ? usd(s.lastTotal) : ""}</td></tr></table>` : "") +
      (k && k !== s.n ? `<div class="nth">this order was their ${ord(k)} · ${usd(s.spentBefore != null ? s.spentBefore : s.spent)} by then</div>` : "") +
      fbLines(s.fb, 2);
  }
  function show(el) {
    clearTimeout(hideT);
    if (!pop) { pop = document.createElement("div"); pop.id = "ccbuypop"; document.body.appendChild(pop); }
    pop.innerHTML = el.__cchtml; popFor = el; pop.style.display = "block";
    const r = el.getBoundingClientRect(), ph = pop.offsetHeight, pw = pop.offsetWidth;
    const top = r.bottom + 6 + ph > window.innerHeight ? Math.max(4, r.top - 6 - ph) : r.bottom + 6;
    const left = Math.max(4, Math.min(r.left, window.innerWidth - pw - 8));
    pop.style.top = top + "px"; pop.style.left = left + "px";
  }
  function hide(el) { if (popFor !== el) return; hideT = setTimeout(() => { if (pop) pop.style.display = "none"; popFor = null; }, 120); }
  // stats: {n, first, last, firstTotal, lastTotal, spent, before, spentBefore, name} (before / spentBefore = as of atMs,
  // when given). Repeat buyers only (Derek: "just a count, most buyers are new"): nothing for a first order,
  // "3 orders · $37.29" otherwise, gold from 5 orders.
  function chip(stats, atMs) {
    if (!stats || !stats.n || stats.n < 2) return null;
    const k = atMs ? Math.max(1, stats.before || 1) : stats.n;
    if (k < 2) return null;   // on this order they were still new
    style();
    const spent = atMs && stats.spentBefore != null ? stats.spentBefore : stats.spent;
    const el = document.createElement("span");
    el.className = "ccbuy " + (k >= 5 ? "reg" : "rep");
    el.textContent = k + " orders · " + usd(spent);
    el.__cchtml = popHTML(stats, atMs ? k : 0);
    el.tabIndex = 0;
    el.addEventListener("mouseenter", () => show(el)); el.addEventListener("mouseleave", () => hide(el));
    el.addEventListener("focus", () => show(el)); el.addEventListener("blur", () => hide(el));
    el.addEventListener("click", (e) => { e.stopPropagation(); if (popFor === el && pop && pop.style.display !== "none") { popFor = null; pop.style.display = "none"; } else show(el); });
    return el;
  }
  // One plain line for pages with room: "first Oct 29, 2026 $5.39 · last Nov 9, 2026 $21.90 · avg $12.43".
  function detail(stats) {
    if (!stats || !stats.n || stats.n < 2) return null;
    style();
    const el = document.createElement("div"); el.className = "ccbuyd";
    el.textContent = `first ${day(stats.first)} ${stats.firstTotal != null ? usd(stats.firstTotal) : ""} · last ${day(stats.last)} ${stats.lastTotal != null ? usd(stats.lastTotal) : ""} · avg ${usd(stats.spent / stats.n)}`.replace(/\s+/g, " ");
    return el;
  }
  // "What they said about you" for pages with room (order page, thread panel): up to 3 worded feedbacks, else the ratings.
  function said(stats) {
    if (!stats || !stats.fb || !stats.fb.length) return null;
    style();
    const el = document.createElement("div"); el.className = "ccsaid"; el.innerHTML = fbLines(stats.fb, 3);
    return el;
  }
  async function stats(name, atMs) { const r = await post({ type: "cardcomp-fb-buyer", name, at: atMs || 0 }); return r && r.ok ? r.stats : null; }
  async function merge(orders) { return post({ type: "cardcomp-fb-buyers-merge", orders }); }
  // One line for the drafts: orders and spend, plus the newest worded feedback they left before this one.
  const line = (s, skipOrder) => {
    if (!s) return "";
    const parts = [];
    if (s.n >= 2) parts.push(`${s.n} orders since ${mon(s.first)}, ${usd(s.spent)} lifetime, first ${day(s.first)} (${usd(s.firstTotal)}), last ${day(s.last)} (${usd(s.lastTotal)})`);
    const past = (s.fb || []).filter((x) => x.order !== skipOrder);
    if (past.length) { const w = past.find((x) => x.c); parts.push(`${past.length} earlier feedback rating${past.length === 1 ? "" : "s"} for you, avg ${(past.reduce((a, x) => a + (x.r || 0), 0) / past.length).toFixed(1)} of 5` + (w ? `, newest with words (${day(w.at)}, ${w.r} of 5): "${w.c}"` : "")); }
    return parts.join("; ");
  };
  const customersURL = () => { try { return chrome.runtime.getURL("feedback/customers.html"); } catch (_) { return "#"; } };
  window.ccBuyer = { chip, detail, said, stats, merge, line, esc, customersURL };
})();
