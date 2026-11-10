// Customers page (Derek, 2026-11-10: "a dashboard that shows a leaderboard of my top customers and relevant stats").
// Reads fbBuyers (orders, from the Options CSV import plus every Orders page seen) and fbFeedback (every Feedback tab
// row seen) from the background, computes everything here. Nothing leaves the browser.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const post = (m) => new Promise((res) => { try { chrome.runtime.sendMessage(m, (r) => { void chrome.runtime.lastError; res(r || null); }); } catch (_) { res(null); } });
  const usd = (v) => "$" + (Math.round((v || 0) * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const usd0 = (v) => "$" + Math.round(v || 0).toLocaleString("en-US");
  const day = (ms) => ms ? new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "?";
  const mon = (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  const key = (name) => String(name || "").toLowerCase().replace(/\s+/g, " ").trim();
  const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const stars = (n) => `<span class="stars ${n >= 4 ? "good" : "bad"}" title="${n} of 5">${"★".repeat(Math.max(0, Math.min(5, n)))}${"☆".repeat(Math.max(0, 5 - Math.min(5, n)))}</span>`;
  const DAY = 864e5;
  let DATA = null, SORT = { k: "spent", d: -1 }, SHOWALL = false;

  // One record per buyer: orders sorted by time, totals, first / last, gaps, feedback.
  function build(buyers, feedback) {
    const fbBy = {};
    for (const [order, v] of Object.entries(feedback || {})) { const k = key(v.u); if (!k) continue; (fbBy[k] = fbBy[k] || []).push({ order, at: v.at, r: v.r, c: v.c }); }
    const out = [];
    for (const [k, b] of Object.entries(buyers || {})) {
      const os = Object.entries(b.orders || {}).map(([id, o]) => ({ id, at: o.at || 0, total: o.total || 0 })).sort((x, y) => x.at - y.at);
      if (!os.length) continue;
      const gaps = []; for (let i = 1; i < os.length; i++) if (os[i].at && os[i - 1].at) gaps.push((os[i].at - os[i - 1].at) / DAY);
      const fb = (fbBy[k] || []).sort((x, y) => y.at - x.at);
      out.push({ k, name: b.name || k, os, n: os.length, spent: os.reduce((s, o) => s + o.total, 0), first: os[0].at, last: os[os.length - 1].at, gap: median(gaps), fb,
        fbAvg: fb.length ? fb.reduce((s, x) => s + x.r, 0) / fb.length : null });
    }
    return out;
  }

  function paint() {
    const B = DATA.buyers, now = Date.now();
    const orders = B.flatMap((b) => b.os.map((o) => Object.assign({ buyer: b }, o)));
    const rev = orders.reduce((s, o) => s + o.total, 0);
    const rep = B.filter((b) => b.n >= 2);
    const repRev = B.reduce((s, b) => s + b.os.slice(1).reduce((t, o) => t + o.total, 0), 0);   // 2nd and later orders
    const ats = orders.map((o) => o.at).filter(Boolean);
    const cohort = B.filter((b) => b.first && now - b.first >= 90 * DAY), back = cohort.filter((b) => b.os.some((o) => o.at - b.first > 0 && o.at - b.first <= 90 * DAY));
    const fbAll = Object.values(DATA.feedback || {}), worded = fbAll.filter((f) => f.c);
    $("sub").innerHTML = `${B.length.toLocaleString()} buyers · ${orders.length.toLocaleString()} orders · ${usd0(rev)} · ${ats.length ? day(Math.min(...ats)) + " to " + day(Math.max(...ats)) : "no dates"}`;
    const tile = (v, l, s) => `<div class="tile"><div class="v">${v}</div><div class="l">${l}</div>${s ? `<div class="s">${s}</div>` : ""}</div>`;
    $("tiles").innerHTML =
      tile(rep.length.toLocaleString(), "repeat buyers", B.length ? Math.round(rep.length / B.length * 100) + "% of buyers" : "") +
      tile(rev ? Math.round(repRev / rev * 100) + "%" : "–", "revenue from repeat orders", usd0(repRev) + " on 2nd+ orders") +
      tile(orders.length ? usd(rev / orders.length) : "–", "average order", rep.length ? "repeat buyers " + usd(rep.reduce((s, b) => s + b.spent, 0) / rep.reduce((s, b) => s + b.n, 0)) : "") +
      tile(rep.length ? Math.round(median(rep.map((b) => b.gap).filter(Boolean))) + " d" : "–", "median days between orders", "repeat buyers") +
      tile(cohort.length ? Math.round(back.length / cohort.length * 100) + "%" : "–", "came back within 90 days", cohort.length ? `of ${cohort.length.toLocaleString()} buyers whose first order is 90+ days old` : "needs 90 days of history") +
      tile(fbAll.length ? (fbAll.reduce((s, f) => s + f.r, 0) / fbAll.length).toFixed(2) + "★" : "–", "feedback average", fbAll.length ? `${fbAll.length.toLocaleString()} ratings · ${Math.round(worded.length / fbAll.length * 100)}% with words` : "load feedback history");
    paintChart(orders);
    paintQuiet(B, now);
    paintFb(fbAll);
    paintLb();
  }

  // Stacked columns: orders per month, new buyers (first order that month) vs returning. Two series: blue returning,
  // amber new (validated pair, light surface). Hover gives the month's numbers; "table" shows the same as rows.
  function paintChart(orders) {
    const byM = new Map();
    for (const o of orders) {
      if (!o.at) continue;
      const d = new Date(o.at), m = d.getFullYear() * 12 + d.getMonth();
      const e = byM.get(m) || { m, n: 0, r: 0, rev: 0 }; e.rev += o.total;
      if (o.at === o.buyer.first) e.n++; else e.r++;
      byM.set(m, e);
    }
    const have = [...byM.keys()].sort((a, b) => a - b); const ms = [];   // every month from the first to the last, empty ones kept, last 18
    if (have.length) for (let m = have[0]; m <= have[have.length - 1]; m++) ms.push(m);
    const rows = ms.slice(-18).map((m) => byM.get(m) || { m, n: 0, r: 0, rev: 0 });
    const c = $("chart");
    if (!rows.length) { c.innerHTML = '<div class="empty">No dated orders yet. Import the Order List CSV on the Options page.</div>'; return; }
    const W = 1000, H = 200, L = 36, Bt = 8, Bb = 24, max = Math.max(1, ...rows.map((r) => r.n + r.r)), cw = (W - L) / rows.length, bw = Math.min(40, cw * 0.7);
    const y = (v) => Bt + (H - Bt - Bb) * (1 - v / max);
    const lbl = (m) => mon(new Date(Math.floor(m / 12), m % 12, 1));
    let g = `<div class="leg"><span><i style="background:#1849a9"></i>returning buyers</span><span><i style="background:#d97706"></i>new buyers</span></div><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="orders per month">`;
    const ticks = [0, Math.round(max / 2), max];
    for (const t of ticks) g += `<line x1="${L}" x2="${W}" y1="${y(t)}" y2="${y(t)}" stroke="#eef1f5"/><text x="${L - 6}" y="${y(t) + 4}" font-size="11" fill="#5f6b7a" text-anchor="end">${t}</text>`;
    rows.forEach((r, i) => {
      const x = L + i * cw + (cw - bw) / 2, yr = y(r.r), yn = y(r.r + r.n);
      g += `<g data-i="${i}"><rect x="${x}" y="${yr}" width="${bw}" height="${Math.max(0, y(0) - yr)}" fill="#1849a9" rx="2"/>` +
        `<rect x="${x}" y="${yn}" width="${bw}" height="${Math.max(0, yr - yn - (r.r ? 2 : 0))}" fill="#d97706" rx="2"/>` +
        `<rect x="${L + i * cw}" y="0" width="${cw}" height="${H}" fill="transparent" class="hit"/>` +
        (rows.length <= 18 ? `<text x="${x + bw / 2}" y="${H - 8}" font-size="11" fill="#5f6b7a" text-anchor="middle">${lbl(r.m)}</text>` : "") + `</g>`;
    });
    g += `</svg><div class="tip" id="tip"></div><div class="rt" id="rt"><table><tr><th>Month</th><th class="n">Orders</th><th class="n">New</th><th class="n">Returning</th><th class="n">Revenue</th></tr>${rows.map((r) => `<tr><td>${lbl(r.m)}</td><td class="n">${r.n + r.r}</td><td class="n">${r.n}</td><td class="n">${r.r}</td><td class="n">${usd0(r.rev)}</td></tr>`).join("")}</table></div>`;
    c.innerHTML = g;
    const tip = $("tip");
    c.querySelectorAll("g[data-i]").forEach((gr) => {
      const r = rows[+gr.dataset.i];
      gr.addEventListener("mousemove", (e) => { tip.style.display = "block"; tip.innerHTML = `<b>${lbl(r.m)}</b> · ${r.n + r.r} orders · ${usd0(r.rev)}<br>${r.r} returning · ${r.n} new buyers`; const cr = c.getBoundingClientRect(); tip.style.left = Math.min(e.clientX - cr.left + 12, cr.width - 230) + "px"; tip.style.top = (e.clientY - cr.top - 40) + "px"; });
      gr.addEventListener("mouseleave", () => { tip.style.display = "none"; });
    });
    $("rtog").onclick = (e) => { e.preventDefault(); $("rt").classList.toggle("on"); };
  }

  // Repeat buyers (3+ orders) who are overdue: no order for longer than twice their usual gap, and 60+ days.
  function paintQuiet(B, now) {
    const q = B.filter((b) => b.n >= 3 && b.last && now - b.last > Math.max(60 * DAY, 2 * b.gap * DAY)).sort((a, b) => b.spent - a.spent).slice(0, 12);
    $("quiet").innerHTML = q.length ? `<ul class="quiet">${q.map((b) => `<li><b>${esc(b.name)}</b> <span class="dim">${b.n} orders · ${usd(b.spent)} · usually every ${Math.round(b.gap)} d · last ${day(b.last)} (${Math.round((now - b.last) / DAY)} d ago)</span></li>`).join("")}</ul>` : '<div class="dim">Nobody overdue: every regular (3+ orders) has ordered within twice their usual gap.</div>';
  }

  function paintFb(fbAll) {
    if (!fbAll.length) { $("fbsum").innerHTML = '<div class="dim">No feedback stored yet. "load feedback history" reads every page of your Feedback tab.</div>'; return; }
    const by = [5, 4, 3, 2, 1].map((r) => ({ r, n: fbAll.filter((f) => f.r === r).length }));
    const neg = fbAll.filter((f) => f.r <= 3 && f.c).sort((a, b) => b.at - a.at).slice(0, 5);
    $("fbsum").innerHTML = `<div class="bars">${by.map((x) => `<span>${x.r}★</span><div><div class="b${x.r <= 3 ? " lo" : ""}" style="width:${Math.round(x.n / fbAll.length * 100)}%"></div></div><span class="n">${x.n} <span class="dim">${Math.round(x.n / fbAll.length * 100)}%</span></span>`).join("")}</div>` +
      (neg.length ? `<div style="margin-top:10px"><b>Latest 1-3★ with words</b>${neg.map((f) => `<blockquote>${stars(f.r)} “${esc(f.c)}” <span class="dim">${esc(f.u)} · ${day(f.at)}</span></blockquote>`).join("")}</div>` : '<div class="dim" style="margin-top:10px">No worded 1-3★ feedback stored.</div>');
  }

  function paintLb() {
    const q = key($("q").value), now = Date.now();
    let rows = DATA.buyers.filter((b) => !q || b.k.includes(q));
    const v = (b) => SORT.k === "name" ? b.name.toLowerCase() : SORT.k === "since" ? (b.last ? now - b.last : Infinity) : SORT.k === "fb" ? (b.fbAvg == null ? -1 : b.fbAvg) : SORT.k === "avg" ? b.spent / b.n : b[SORT.k] || 0;
    rows.sort((a, b) => { const x = v(a), y = v(b); return (x < y ? -1 : x > y ? 1 : 0) * SORT.d || b.spent - a.spent; });
    const total = rows.length; if (!SHOWALL && !q) rows = rows.slice(0, 50);
    $("lbn").textContent = total ? `${rows.length} of ${total.toLocaleString()} buyers` + (!SHOWALL && !q && total > 50 ? " · " : "") : "";
    if (!SHOWALL && !q && total > 50) { const a = document.createElement("a"); a.href = "#"; a.textContent = "show all"; a.onclick = (e) => { e.preventDefault(); SHOWALL = true; paintLb(); }; $("lbn").appendChild(a); }
    const th = (k, l, n) => `<th class="${n ? "n" : ""}${SORT.k === k ? " on" : ""}" data-k="${k}">${l}${SORT.k === k ? (SORT.d < 0 ? " ↓" : " ↑") : ""}</th>`;
    $("lb").innerHTML = rows.length ? `<table><thead><tr><th>#</th>${th("name", "Buyer")}${th("n", "Orders", 1)}${th("spent", "Lifetime", 1)}${th("avg", "Avg order", 1)}${th("first", "First")}${th("last", "Last")}${th("since", "Since last", 1)}${th("fb", "Feedback")}</tr></thead><tbody>` +
      rows.map((b, i) => `<tr class="x" data-k="${esc(b.k)}"><td class="dim">${i + 1}</td><td><b>${esc(b.name)}</b>${b.n >= 2 ? `<span class="chip${b.n >= 5 ? " reg" : ""}">${b.n} orders</span>` : ""}</td><td class="n">${b.n}</td><td class="n">${usd(b.spent)}</td><td class="n">${usd(b.spent / b.n)}</td><td>${day(b.first)}</td><td>${day(b.last)}</td><td class="n">${b.last ? Math.round((now - b.last) / DAY) + " d" : ""}</td><td>${b.fb.length ? `${stars(Math.round(b.fbAvg))} <span class="dim">${b.fbAvg.toFixed(1)} · ${b.fb.length}${b.fb.some((f) => f.c) ? ' · “' + esc(b.fb.find((f) => f.c).c).slice(0, 40) + (b.fb.find((f) => f.c).c.length > 40 ? "…" : "") + '”' : ""}</span>` : '<span class="dim">–</span>'}</td></tr>`).join("") + "</tbody></table>" : '<div class="empty">No buyers match.</div>';
    $("lb").querySelectorAll("th[data-k]").forEach((h) => { h.onclick = () => { const k = h.dataset.k; SORT = SORT.k === k ? { k, d: -SORT.d } : { k, d: k === "name" || k === "first" ? 1 : -1 }; paintLb(); }; });
    $("lb").querySelectorAll("tr.x").forEach((tr) => { tr.onclick = () => toggleDetail(tr); });
  }
  // A buyer's row opens: their orders (date, order id, amount) and every feedback they left.
  function toggleDetail(tr) {
    const next = tr.nextElementSibling;
    if (next && next.classList.contains("det")) { next.remove(); return; }
    const b = DATA.buyers.find((x) => x.k === tr.dataset.k); if (!b) return;
    const d = document.createElement("tr"); d.className = "det";
    const fbOf = (id) => b.fb.find((f) => f.order === id);
    d.innerHTML = `<td colspan="9"><div><b>Orders</b> ${b.os.slice().reverse().map((o) => { const f = fbOf(o.id); return `<div>${day(o.at)} · <a href="https://sellerportal.tcgplayer.com/orders/${encodeURIComponent(o.id)}" target="_blank">${esc(o.id)}</a> · ${usd(o.total)}${f ? ` · ${stars(f.r)}${f.c ? ` “${esc(f.c)}”` : ""}` : ""}</div>`; }).join("")}</div>` +
      (b.fb.filter((f) => !b.os.some((o) => o.id === f.order)).length ? `<div style="margin-top:6px"><b>Feedback on orders not in the history</b> ${b.fb.filter((f) => !b.os.some((o) => o.id === f.order)).map((f) => `<div>${day(f.at)} · ${esc(f.order)} · ${stars(f.r)}${f.c ? ` “${esc(f.c)}”` : ""}</div>`).join("")}</div>` : "") + `</td>`;
    tr.insertAdjacentElement("afterend", d);
  }

  async function load() {
    const r = await post({ type: "cardcomp-fb-customers" });
    if (!r || !r.ok) { $("sub").textContent = "CardComp extension not reachable: reload the extension, then this page."; return; }
    DATA = { buyers: build(r.buyers, r.feedback), feedback: r.feedback || {} };
    paint();
  }
  async function loadFb(full) {
    const st = $("fbst"); $("loadfb").disabled = $("loadnew").disabled = true; st.textContent = full ? "reading every page of the Feedback tab…" : "reading new feedback…";
    const r = await post({ type: "cardcomp-fb-feedback-load", full });
    $("loadfb").disabled = $("loadnew").disabled = false;
    if (!r || !r.ok) { st.textContent = "failed: " + ((r && r.why) || "no answer"); return; }
    st.textContent = `${r.pages} page${r.pages === 1 ? "" : "s"} read, ${r.added} new, ${r.total} feedback stored` + (r.stopped ? ` · stopped: ${r.stopped}` : "");
    await load();
  }
  $("loadfb").onclick = () => loadFb(true);
  $("loadnew").onclick = () => loadFb(false);
  $("q").oninput = () => { if (DATA) paintLb(); };
  try { $("optlink").href = chrome.runtime.getURL("options.html"); } catch (_) {}
  load();
})();
