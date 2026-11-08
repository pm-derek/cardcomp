// Issue replies (Derek, 2026-11-06: "help me structure responses to issues from buyers: condition issues first, lost
// orders, wrong item; input the card, the condition and what I sold it for, pull the lower-condition price, use it in
// the reply"). Runs on a message thread (sellerportal.tcgplayer.com/messages/<id>, a Vue app). A "CardComp reply"
// panel under the subject: the issue type (from the subject, changeable), the order's cards with what was charged, a
// condition pick per card with TCGplayer's market at that condition (the extension's fast read, tiers when no
// market), the refund each works out to, an "extra for the trouble" box (manual, Derek's call), and a draft from the
// playbook in feedback-bg.js. Send = countdown, then the thread's own Reply box is filled and its Send pressed. Same
// rules as the thank-yous: lock before sending, unknown outcome never retried, 10 a day.
(() => {
  const tidNow = () => (location.pathname.match(/^\/messages\/(\d+)/) || [])[1] || "";
  let TID = tidNow();
  const COUNTDOWN = window.__ccfbCountdown != null ? window.__ccfbCountdown : 3, DAY_CAP = 10, SMALL = 20;   // under $SMALL charged: one grade lower by default
  const post = (m) => new Promise((res) => { try { chrome.runtime.sendMessage(m, (r) => { void chrome.runtime.lastError; res(r || null); }); } catch (_) { res(null); } });
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(fn, ms, step) { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step || 150); } }
  const $ = (id, root) => (root || document).querySelector('[data-testid="' + id + '"]');
  const money = (n) => "$" + (Math.round(n * 100) / 100).toFixed(2);
  const CONDS = ["NM", "LP", "MP", "HP", "DMG"], COND_NAME = { NM: "Near Mint", LP: "Lightly Played", MP: "Moderately Played", HP: "Heavily Played", DMG: "Damaged" };
  const TIER = { LP: 0.74, MP: 0.58, HP: 0.44, DMG: 0.33 };   // mid-era shares of NM from CLAUDE.md's measured table, used only when TCGplayer has no market for the condition
  const TYPES = { condition: "Condition issue", missing: "Missing package", wrong: "Wrong card", missingcard: "Missing card", other: "Other" };
  // Thread as the page shows it: order, subject, messages oldest first.
  function readThread() {
    const link = $("linkMessages_Home_OrderDetailsSellerOrder"), order = (txt(link).match(/[\dA-Z]+-[\dA-Z]+-[\dA-Z]+/) || [])[0] || "";
    const h = document.querySelector("h3.typography-heading-lg"), subject = txt(h);
    const msgs = [...document.querySelectorAll("li.sp-messages-thread-message")].map((li) => {
      const head = li.querySelector(".sp-messages-thread-message__header"), from = (txt(head).match(/Message From <([^>]*)>/) || [])[1] || "";
      return { from, me: /^me$/i.test(from), when: txt(head.querySelector(".typography-detail")), text: txt(li.querySelector(".sp-messages-thread-message__body")) };
    }).reverse();
    return msgs.length && order ? { order, subject, msgs, h } : null;
  }
  const typeOf = (subject, msgs) => {
    const s = (subject + " " + msgs.filter((m) => !m.me).map((m) => m.text).join(" ")).toLowerCase();
    if (/wrong (card|item|version|variant|set|printing)|received the wrong|instead of the/.test(s)) return "wrong";
    if (/(missing|didn.?t (get|receive|include)|only (got|received)|wasn.?t in|not in the (package|envelope)|short)\b[^.]{0,40}\b(card|cards|one of)/.test(s) || /\b(card|cards) (was|were|is|are) missing/.test(s)) return "missingcard";
    if (/condition|damage|crease|scratch|bent|whiten|not nm|not near mint|played|dinged|ding/.test(s)) return "condition";
    if (/where is my order|package|never (arrived|came|received)|not (arrived|received|delivered)|hasn.?t (arrived|come|shown)|no sign of|lost/.test(s)) return "missing";
    return "other";
  };
  // "Pokemon - SM - Unbroken Bonds: Chikorita (53) - #53/214 - Near Mint" -> name "Chikorita (53)", printing from the last segment
  const nameOf = (p) => { const parts = String(p).split(" - "); let i = parts.findIndex((x, k) => k > 0 && /^#/.test(x.trim())); if (i < 1) i = Math.min(2, parts.length); return (parts[i - 1] || parts[0] || "").split(": ").pop().trim(); };
  const printingOf = (p) => { const last = String(p).split(" - ").pop() || ""; const pr = last.replace(/Near Mint|Lightly Played|Moderately Played|Heavily Played|Damaged|Unopened/gi, "").trim(); return pr || "Normal"; };
  const condOf = (p) => { const last = String(p).split(" - ").pop() || ""; return CONDS.find((c) => new RegExp(COND_NAME[c], "i").test(last)) || "NM"; };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const bizDays = (d, n) => { let x = new Date(d), k = 0; while (k < n) { x = addDays(x, 1); if (x.getDay() !== 0 && x.getDay() !== 6) k++; } return x; };
  const fmtDay = (d) => d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  const msgDate = (s) => { const t = Date.parse(String(s || "").replace(/,\s*(\d{1,2}:\d{2})/, " $1")); return isNaN(t) ? 0 : t; };   // "Oct 30, 2026, 11:23 AM"
  // Missing package under the current policy: reported on the estimated delivery date or within 2 business days after
  // it, Derek may ask the buyer to wait until estimated delivery + 2 business days; reported later, refund now.
  function missingFacts(info, msgs) {
    const edd = info && info.edd ? new Date(info.edd) : null; if (!edd || isNaN(edd)) return { waitUntil: "", late: false, reportedLate: false, eddMs: 0 };
    const until = bizDays(edd, 2), first = (msgs || []).find((m) => !m.me), at = first ? msgDate(first.when) : 0;
    const endOf = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x.getTime(); };
    return { waitUntil: fmtDay(until), late: Date.now() > endOf(until), reportedLate: !!at && at > endOf(until), eddMs: edd.getTime() };
  }
  // Amber flags on an issue draft, never blocking: amounts the panel never gave, photo made a condition, ratings talk.
  function issueFlags(text, picks, facts) {
    const f = [], low = String(text || "").toLowerCase();
    const given = new Set();
    ((picks || {}).cards || []).forEach((c) => [c.charged, c.value, c.refund].forEach((n) => { if (n != null) { given.add(Number(n).toFixed(2)); given.add(String(Math.round(Number(n)))); } }));
    if (picks && picks.total != null) { given.add(Number(picks.total).toFixed(2)); given.add(String(Math.round(picks.total))); }
    if (picks && picks.extra) { given.add(Number(picks.extra).toFixed(2)); given.add(String(Math.round(picks.extra))); }
    const odd = [...new Set((String(text || "").match(/\$\s?\d[\d,]*(?:\.\d{1,2})?/g) || []).map((m) => m.replace(/[$,\s]/g, "")))].filter((n) => !given.has(n) && !given.has(Number(n).toFixed(2)) && !given.has(String(Math.round(Number(n)))));
    if (odd.length) f.push("amount not from the panel: $" + odd.join(", $"));
    if (/(once|after|when) (i|we) (get|see|have|receive)[^.]{0,30}(picture|photo|pic)|(need|require)[^.]{0,20}(picture|photo|pic)[^.]{0,20}(before|first)|without (a )?(picture|photo)/.test(low)) f.push("makes a photo a condition (TCGplayer: photos cannot be required)");
    if (/\b(rating|feedback|review)\b/.test(low)) f.push("mentions ratings or feedback");
    // A ticked card the draft never names (live 2026-11-06: Slowking ticked, the draft apologised for a Ponyta from the thread).
    const unnamed = ((picks || {}).cards || []).map((c) => String(c.name || "").replace(/\s*\(.*?\)\s*/g, " ").trim().split(/\s+/)[0]).filter((w) => w && w.length > 2 && !low.includes(w.toLowerCase()));
    if (unnamed.length) f.push("does not name the ticked card" + (unnamed.length > 1 ? "s" : "") + ": " + unnamed.join(", "));
    if (/return to sender|refuse the package/.test(low) && !(facts && facts.cancel)) f.push("return-to-sender wording (only for a cancel after shipping)");
    if (low.length > 1500) f.push("long");
    return f;
  }

  const STYLE = `#ccir{font:14px/1.45 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;background:#fff;color:#1f2933;border:1px solid #d9dee5;border-radius:10px;padding:12px 16px;margin:8px 0 16px;box-shadow:0 1px 3px rgba(16,24,40,.06)}
#ccir h4{margin:0 0 6px;font-size:15px;font-weight:600;display:flex;gap:10px;align-items:center;flex-wrap:wrap}#ccir .dim{color:#5f6b7a;font-size:12.5px}#ccir .bad{color:#b42318}#ccir .ok{color:#067647}#ccir .warn{color:#b54708}
#ccir select,#ccir input{font:inherit;border:1px solid #c9d0d9;border-radius:6px;padding:4px 6px;background:#fff;color:#1f2933}#ccir input[type=number]{width:70px}
#ccir table{border-collapse:collapse;margin:6px 0;font-size:13.5px}#ccir td,#ccir th{padding:4px 8px 4px 0;text-align:left;vertical-align:middle}#ccir th{font-weight:600;color:#5f6b7a;font-size:12px}#ccir td.r,#ccir th.r{text-align:right}
#ccir .src{font-size:11.5px;color:#5f6b7a}#ccir .tot{font-weight:600}
#ccir textarea{width:100%;box-sizing:border-box;min-height:120px;background:#fff;border:1px solid #c9d0d9;border-radius:7px;color:#1f2933;font:inherit;padding:8px 10px;resize:vertical;margin-top:6px}
#ccir .act{display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap}#ccir .act .note{color:#5f6b7a;font-size:12.5px;margin-left:auto}
#ccir button{background:#fff;border:1px solid #c9d0d9;border-radius:7px;color:#1f2933;font:inherit;padding:7px 14px;cursor:pointer}#ccir button:hover{background:#f5f7fa}#ccir button:disabled{opacity:.5;cursor:default}
#ccir button.send{background:#0d6efd;border-color:#0d6efd;color:#fff;font-weight:600;min-width:96px}#ccir button.cancel{border-color:#b42318;color:#b42318}#ccir a{color:#0d6efd}
#ccir .facts{font-size:13px;margin:4px 0}#ccir .facts b{font-weight:600}#ccir .flags{font-size:12.5px;color:#b54708;margin-top:4px;min-height:1em}`;
  async function run() {
    const mine = TID;
    const th = await until(() => (tidNow() === mine ? readThread() : "gone"), 20000, 300); if (!th || th === "gone" || document.getElementById("ccir")) return;
    const st = document.createElement("style"); st.textContent = STYLE; document.head.appendChild(st);
    const box = document.createElement("div"); box.id = "ccir";
    th.h.insertAdjacentElement("afterend", box);
    const key = await post({ type: "cardcomp-fb-key" });
    if (!key || !key.ok) { box.innerHTML = '<h4>CardComp reply</h4><div class="bad">' + (key ? 'Add your Anthropic key on the <a href="' + esc(chrome.runtime.getURL("options.html")) + '" target="_blank">Options page</a>.' : "extension not reachable, reload it and this page.") + "</div>"; return; }
    let type = typeOf(th.subject, th.msgs);
    box.innerHTML = `<h4>CardComp reply <select data-type>${Object.keys(TYPES).map((k) => `<option value="${k}"${k === type ? " selected" : ""}>${TYPES[k]}</option>`).join("")}</select><span class="dim" data-st>reading the order…</span></h4><div data-facts></div><div data-cards></div><div data-draft></div>`;
    const S = { th, type, info: null, prices: {}, addr: "", picks: null, facts: null, draftFor: null };
    const settings = await new Promise((res) => chrome.storage.local.get(["fbAddress", "fbThreadSent"], (r) => res(r || {})));
    S.addr = settings.fbAddress || ""; S.sent = settings.fbThreadSent || {};
    const o = await post({ type: "cardcomp-fb-order", order: th.order });
    S.info = o && o.ok ? o.info : null;
    const stEl = box.querySelector("[data-st]"); stEl.textContent = S.info ? "" : "order page not read (" + (o && o.why || "no reply") + ")";
    paint();
    box.querySelector("[data-type]").onchange = (e) => { S.type = e.target.value; paint(); };
    if (S.info && S.type === "condition") pricesFor();
    function paint() {
      const f = box.querySelector("[data-facts]"), c = box.querySelector("[data-cards]"), d = box.querySelector("[data-draft]");
      const info = S.info;
      if (S.type === "missing" && info) {
        const mf = missingFacts(info, th.msgs);
        f.innerHTML = `<div class="facts">ordered <b>${esc(info.orderDate || "?")}</b> · shipped <b>${esc(info.shippedAt || "?")}</b> · ${esc(info.method || "")} · estimated delivery <b>${esc(info.edd || "?")}</b> · ${info.tracking ? "tracking " + esc(info.tracking) : "<b>no tracking</b>"}<br>TCGplayer policy: reported within 2 business days of the estimated delivery, you may ask them to wait until <b>${esc(mf.waitUntil || "?")}</b>; reported later, or past that date, the full refund goes out now.${mf.late ? ' <span class="bad">That date has passed: refund now.</span>' : mf.reportedLate ? ' <span class="bad">Reported more than 2 business days after the estimated delivery: refund now.</span>' : ' <span class="ok">Still inside the wait window.</span>'}${info.tracking ? " Tracking that says delivered: open it with TCGplayer customer service." : ""}</div>`;
        c.innerHTML = "";
      } else if (S.type === "missingcard" && info) {
        f.innerHTML = `<div class="facts dim">TCGplayer: reship the card if you still have it, else refund that card in full. Nothing is asked of the buyer. Cards on the order: ${(info.items || []).map((it) => esc(nameOf(it.name)) + " " + (it.price != null ? money(it.price) : "")).join(", ")}.</div>`; c.innerHTML = "";
      } else if (S.type === "condition" && info) {
        f.innerHTML = `<div class="facts dim">Tick the cards in question and pick the condition they arrived in. Refund = charged minus TCGplayer's market at that condition, rounded up to the dollar. Under $${SMALL} charged, one grade lower is picked for you (cheap goodwill); above, as described.</div>`;
        c.innerHTML = `<table><tr><th></th><th>card</th><th class="r">charged</th><th>arrived</th><th class="r">value</th><th class="r">refund</th></tr>${(info.items || []).map((it, i) => `<tr data-i="${i}"><td><input type="checkbox" data-on></td><td>${esc(nameOf(it.name))} <span class="src">${esc(printingOf(it.name))} · sold as ${condOf(it.name)}${it.qty > 1 ? " · qty " + it.qty + " (refund is per copy)" : ""}</span></td><td class="r">${it.price != null ? money(it.price) : "?"}</td><td><select data-cond>${CONDS.map((k) => `<option value="${k}">${k}</option>`).join("")}</select> <label class="src"><input type="checkbox" data-lower${(it.price || 0) < SMALL ? " checked" : ""}> one grade lower</label></td><td class="r" data-val>…</td><td class="r" data-ref></td></tr>`).join("")}<tr><td></td><td>extra for the trouble (your call)</td><td></td><td></td><td class="r">$<input type="number" data-extra value="0" min="0" step="1"></td><td class="r tot" data-total></td></tr></table>`;
        c.querySelectorAll("select,input").forEach((el) => { el.addEventListener("change", recompute); el.addEventListener("input", recompute); });
        c.querySelectorAll("[data-cond]").forEach((s) => { s.value = "DMG"; });
        recompute();
      } else if (S.type === "wrong" && info) {
        f.innerHTML = `<div class="facts dim">Options the draft will offer: keep it and refund the difference, return it (prestamped envelope) for the right card if in stock, or return for a full refund. Cards on the order: ${(info.items || []).map((it) => esc(nameOf(it.name)) + " " + (it.price != null ? money(it.price) : "")).join(", ")}.</div>`; c.innerHTML = "";
      } else { f.innerHTML = info ? "" : '<div class="dim">no order details; the draft works from the thread alone</div>'; c.innerHTML = ""; }
      if (!d.innerHTML) d.innerHTML = `<div class="act"><button data-draft-btn>Draft reply</button><span class="dim">${S.addr ? "" : 'no return address saved: add it on the <a href="' + esc(chrome.runtime.getURL("options.html")) + '" target="_blank">Options page</a> for the return option'}</span></div>`;
      d.querySelector("[data-draft-btn]").onclick = draft;
    }
    function recompute() {
      const c = box.querySelector("[data-cards]"); if (!c.querySelector("table")) return;
      let total = 0, any = false;
      c.querySelectorAll("tr[data-i]").forEach((tr) => {
        const it = S.info.items[+tr.dataset.i], on = tr.querySelector("[data-on]").checked, pick = tr.querySelector("[data-cond]").value, lowerBox = tr.querySelector("[data-lower]");
        lowerBox.disabled = pick === "DMG"; lowerBox.parentElement.style.opacity = pick === "DMG" ? ".45" : "";   // nothing below DMG
        const lower = lowerBox.checked && pick !== "DMG";
        const cond = lower ? CONDS[Math.min(4, CONDS.indexOf(pick) + 1)] : pick;
        const p = S.prices[it.pid], v = p ? valueAt(p, cond) : null;
        tr.querySelector("[data-val]").innerHTML = v ? `${money(v.v)} <span class="src">${cond} ${v.src}</span>` : (p === undefined ? '<span class="src">reading…</span>' : '<span class="src">no price</span>');
        let ref = null;
        if (on && v && it.price != null) { ref = Math.max(0, Math.ceil(it.price - v.v - 1e-9)); total += ref; any = true; }
        tr.querySelector("[data-ref]").textContent = on ? (ref != null ? "$" + ref : "?") : "";
        tr.dataset.cond = cond; tr.dataset.value = v ? v.v : ""; tr.dataset.ref = ref != null ? ref : ""; tr.dataset.src = v ? v.src : "";
      });
      const extra = Math.max(0, parseFloat(c.querySelector("[data-extra]").value) || 0);
      c.querySelector("[data-total]").textContent = any ? "$" + (total + extra) : "";
    }
    function valueAt(p, cond) {
      const m = p.conds && p.conds[cond] && p.conds[cond].market;
      if (m > 0) return { v: m, src: "TCG market" };
      const lo = p.conds && p.conds[cond] && p.conds[cond].low;   // a real listing of that condition beats a tier estimate
      if (lo > 0) return { v: lo, src: "cheapest listed" };
      const nm = p.conds && p.conds.NM && p.conds.NM.market;
      if (nm > 0 && TIER[cond]) return { v: Math.round(nm * TIER[cond] * 100) / 100, src: "est. NM×" + Math.round(TIER[cond] * 100) + "%" };
      return null;
    }
    async function pricesFor() {
      for (const it of S.info.items || []) {
        if (!it.pid || S.prices[it.pid] !== undefined) continue;
        S.prices[it.pid] = null;
        const r = await post({ type: "cardcomp-fb-price", pid: it.pid, printing: printingOf(it.name) });
        S.prices[it.pid] = r && r.conds ? r : null; recompute();
      }
    }
    function picks() {
      const c = box.querySelector("[data-cards]"), out = [];
      c.querySelectorAll("tr[data-i]").forEach((tr) => { if (!tr.querySelector("[data-on]").checked) return; const it = S.info.items[+tr.dataset.i];
        out.push({ name: nameOf(it.name), printing: printingOf(it.name), soldAs: condOf(it.name), charged: it.price, arrived: tr.dataset.cond, value: tr.dataset.value ? +tr.dataset.value : null, valueSrc: tr.dataset.src, refund: tr.dataset.ref ? +tr.dataset.ref : null }); });
      const extra = Math.max(0, parseFloat((c.querySelector("[data-extra]") || {}).value) || 0);
      return { cards: out, extra, total: out.reduce((s, x) => s + (x.refund || 0), 0) + extra };
    }
    async function draft() {
      const d = box.querySelector("[data-draft]"), info = S.info, p = S.type === "condition" && info ? picks() : { cards: [], extra: 0, total: 0 };
      let facts = {};
      if (S.type === "missing" && info) { const mf = missingFacts(info, th.msgs); facts = { edd: info.edd, shippedAt: info.shippedAt, tracking: info.tracking, method: info.method, waitUntil: mf.waitUntil, late: mf.late, reportedLate: mf.reportedLate }; }
      const cur = readThread(); S.draftFor = { tid: TID, order: th.order, n: cur ? cur.msgs.length : th.msgs.length };   // what this draft answers; checked again at send
      d.innerHTML = '<div class="dim">drafting…</div>';
      const r = await post({ type: "cardcomp-fb-issue", kind: S.type, thread: { subject: th.subject, msgs: th.msgs.slice(-12) }, order: info ? { order: th.order, items: (info.items || []).map((it) => ({ name: nameOf(it.name), printing: printingOf(it.name), soldAs: condOf(it.name), charged: it.price, qty: it.qty })), orderDate: info.orderDate, buyer: info.buyer } : { order: th.order }, picks: p, facts, address: S.addr });
      const text = r && r.ok ? r.text : "";
      S.picks = p; S.facts = facts;
      const fl = r && r.ok ? issueFlags(text, p, facts) : [];
      d.innerHTML = `<textarea data-text>${esc(text)}</textarea><div class="flags warn" data-flags>${fl.length ? "⚠ check: " + esc(fl.join(" · ")) : ""}</div><div class="act"><button class="send" data-send>Send</button><button data-redo>redo</button><button data-draft-btn>re-draft with new picks</button><span class="note ${r && r.ok ? "" : "bad"}">${esc(r && r.ok ? "draft" + (r.cost != null ? ", $" + r.cost.toFixed(3) : "") : "no draft: " + (r && r.why || "no reply"))}</span></div>`;
      d.querySelector("[data-redo]").onclick = draft; d.querySelector("[data-draft-btn]").onclick = draft;
      wireSend(d);
    }
    function wireSend(d) {
      const ta = d.querySelector("[data-text]"), send = d.querySelector("[data-send]"), note = d.querySelector(".note"), others = d.querySelectorAll("button:not(.send)");
      let timer = null; const lock = (on) => others.forEach((b) => { b.disabled = on; });
      ta.addEventListener("input", () => { const fl = issueFlags(ta.value, S.picks, S.facts); const el = d.querySelector("[data-flags]"); if (el) el.textContent = fl.length ? "⚠ check: " + fl.join(" · ") : ""; });
      send.onclick = async () => {
        if (timer) { clearInterval(timer); timer = null; send.textContent = "Send"; send.classList.remove("cancel"); lock(false); note.textContent = "cancelled"; return; }
        const text = ta.value.trim(); if (!text) { note.textContent = "nothing to send"; return; }
        let n = COUNTDOWN; lock(true); send.classList.add("cancel"); note.textContent = "";
        const tick = () => { send.textContent = n > 0 ? "sending in " + n + "… cancel" : "sending…"; }; tick();
        await new Promise((res) => { if (n <= 0) return res(); timer = setInterval(() => { n--; tick(); if (n <= 0) { clearInterval(timer); timer = null; res(); } }, 1000); });
        if (send.textContent === "Send") return;
        send.disabled = true; send.classList.remove("cancel"); send.textContent = "sending…";
        const cur = readThread(), nMsgs = cur ? cur.msgs.length : th.msgs.length;
        // Still the thread this draft answers? The page is an app: a click elsewhere can swap the thread under the panel.
        const nowTid = (location.pathname.match(/^\/messages\/(\d+)/) || [])[1];
        if (!S.draftFor || nowTid !== S.draftFor.tid || !cur || cur.order !== S.draftFor.order) return fail("the page moved to another thread since this draft; reload and draft again");
        if (nMsgs > S.draftFor.n) return fail("the buyer wrote since this draft (" + (nMsgs - S.draftFor.n) + " new): read it and re-draft");
        const sent = await new Promise((res) => chrome.storage.local.get("fbThreadSent", (r) => res((r && r.fbThreadSent) || {})));
        const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
        if (Object.values(sent).filter((x) => x.at >= midnight.getTime()).length >= DAY_CAP) return fail("daily cap of " + DAY_CAP + " thread sends reached");
        const k = TID + ":" + nMsgs;
        if (sent[k]) return fail("already " + sent[k].how + " at this point of the thread (" + new Date(sent[k].at).toLocaleTimeString() + ")");
        sent[k] = { at: Date.now(), how: "sending", text, order: th.order };
        Object.keys(sent).forEach((kk) => { if (sent[kk].at < Date.now() - 60 * 864e5) delete sent[kk]; });
        await new Promise((res) => chrome.storage.local.set({ fbThreadSent: sent }, res));
        const r = await fillAndSend(text, nMsgs);
        if (r.ok) { sent[k].how = "sent"; await new Promise((res) => chrome.storage.local.set({ fbThreadSent: sent }, res)); d.innerHTML = `<div class="ok">✓ sent: ${esc(text)}</div>` + nextStep(); }
        else if (r.clicked) { sent[k].how = "unsure"; await new Promise((res) => chrome.storage.local.set({ fbThreadSent: sent }, res)); d.innerHTML = `<div class="warn">Send was pressed but the page did not confirm (${esc(r.why)}). Reload the page and check the thread before sending again. The text is still in the box.</div>`; }
        else { delete sent[k]; await new Promise((res) => chrome.storage.local.set({ fbThreadSent: sent }, res)); fail("not sent: " + r.why); }
      };
      function fail(why) { send.disabled = false; send.classList.remove("cancel"); send.textContent = "Send"; lock(false); note.textContent = why; note.className = "note bad"; }
    }
    // After a send the message is out but the money is not: say what to do on the order page.
    function nextStep() {
      const url = "https://sellerportal.tcgplayer.com/orders/" + encodeURIComponent(th.order), p = S.picks || {}, f = S.facts || {};
      if (S.type === "condition" && p.total > 0) return `<div class="facts">Next, once they agree: <a href="${url}" target="_blank">open the order</a> › Partial Refund, $${esc(p.total)}, reason Product - Condition Issue. The message does not move money.</div>`;
      if (S.type === "missing" && (f.late || f.reportedLate)) return `<div class="facts">Next: <a href="${url}" target="_blank">open the order</a> › Full Refund. The message does not move money.</div>`;
      if (S.type === "missingcard") return `<div class="facts">Next: ship the card, or <a href="${url}" target="_blank">open the order</a> › Partial Refund for that card.</div>`;
      return "";
    }
    // The thread's own reply box: press the top message's Reply, the box appears above the list (class
    // sp-message-thread-drawer__thread-reply): a read-only subject, the textarea, a trash button and Send.
    async function fillAndSend(text, nMsgs) {
      const replyBox = () => document.querySelector('[class*="thread-reply"] textarea');
      let ta = replyBox();
      if (!ta) { const b = $("btnMessages_ThreadMessage_Reply"); if (!b) return { ok: false, why: "no Reply button on the page" }; b.click(); ta = await until(replyBox, 4000); if (!ta) return { ok: false, why: "the reply box did not open" }; }
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      ta.focus(); set.call(ta, text); ta.dispatchEvent(new Event("input", { bubbles: true })); ta.dispatchEvent(new Event("change", { bubbles: true }));
      if (ta.value !== text) return { ok: false, why: "could not type into the reply box" };
      await sleep(250);
      const wrap = ta.closest('[class*="thread-reply"]') || ta.parentElement, btn = [...wrap.querySelectorAll("button")].find((b) => /^\s*send\b/i.test(txt(b)));
      if (!btn) return { ok: false, why: "no Send button beside the reply box" };
      if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return { ok: false, why: "Send is disabled on the page" };
      btn.click();
      const done = await until(() => { const cur = readThread(); const t2 = replyBox(); return (cur && cur.msgs.length > nMsgs) || !t2 || t2.value === "" ? true : null; }, 10000, 200);
      return done ? { ok: true, clicked: true } : { ok: false, clicked: true, why: "no confirmation within 10 s" };
    }
  }
  // The Messages area is one app: opening a thread from the list changes the address without a page load, so the
  // panel mounts whenever a thread id appears and is dropped when it goes (a stale panel could send into the wrong thread).
  let ran = "";
  function tick() {
    const t = tidNow();
    if (t === ran) return;
    const old = document.getElementById("ccir"); if (old) old.remove();
    ran = t; TID = t;
    if (t) run();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", tick); else tick();
  setInterval(tick, 600);
  window.addEventListener("popstate", tick);
})();
