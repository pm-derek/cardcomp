// Feedback thank-yous: the Seller Portal Feedback tab (store.tcgplayer.com/admin/Seller/Feedback). An inbox above the
// feedback list offers one draft per worded, named feedback from the last FB_DAYS days that has not been replied to or
// skipped from here (done list in chrome.storage.local fbDone). Pages 2.. are fetched with the same login until the
// rows are older than the window (server-rendered, 25 rows a page, ?page=N). Drafts come from feedback-bg.js; Send goes
// through the order page (order.js). A message cannot be unsent (Derek, 2026-11-06), so before anything is typed the
// order page must show this row's feedback text; a send is locked in storage first and never retried automatically
// when its outcome is unknown; Send counts down 3 s with cancel; at most FB_DAY_CAP sends a day; no batch send.
(() => {
  // The manifest matches all of /admin/ because match patterns are case-sensitive and the portal links to
  // /admin/seller/feedback (lowercase) while the page is also served at /admin/Seller/Feedback (2026-11-06: the
  // script never attached from the nav link). This check is case-insensitive.
  if (!/^\/admin\/seller\/feedback\/?$/i.test(location.pathname)) return;
  const FB_DAYS = 14, MAX_PAGES = 6, KEEP_DAYS = 90, FB_DAY_CAP = 10, COUNTDOWN = window.__ccfbCountdown != null ? window.__ccfbCountdown : 3;
  const post = (m) => new Promise((res) => { try { chrome.runtime.sendMessage(m, (r) => { void chrome.runtime.lastError; res(r || null); }); } catch (_) { res(null); } });
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
  // Rows of one feedback page: {order, date, rating, comment, user}; comment "" when "No Comment Left".
  function parseRows(doc) {
    const out = [];
    doc.querySelectorAll("table.dTable tbody tr").forEach((tr) => {
      const td = tr.querySelectorAll("td"); if (td.length < 6) return;
      const a = td[1].querySelector("a"), order = txt(a) || txt(td[1]);
      const comment = td[4].querySelector("i") && /no comment/i.test(txt(td[4])) ? "" : txt(td[4]);
      out.push({ order, date: txt(td[2]), rating: parseInt(txt(td[3]), 10) || 0, comment, user: txt(td[5]) });
    });
    return out;
  }
  const dateOf = (s) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s || ""); return m ? new Date(+m[3], +m[1] - 1, +m[2]).getTime() : 0; };
  const cutoff = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() - FB_DAYS * 864e5; };
  // Worded, named, recent (Derek: "only people who leave worded reviews, not no-name, not no-text").
  const wanted = (r) => !!r.comment && !!r.user && r.order && dateOf(r.date) >= cutoff();
  async function fetchPage(n) {
    const r = await fetch(location.origin + "/admin/Seller/Feedback?page=" + n, { credentials: "same-origin" });
    if (!r.ok) throw new Error("page " + n + ": HTTP " + r.status);
    if (/login|signin|account\/logon/i.test(r.url || "")) throw new Error("signed out");
    const doc = new DOMParser().parseFromString(await r.text(), "text/html");
    if (!doc.querySelector("table.dTable")) throw new Error("signed out");   // the login page has no feedback table
    return parseRows(doc);
  }
  async function recentRows(status) {
    let rows = parseRows(document), page = 1;
    const older = (rs) => rs.length && rs.every((r) => dateOf(r.date) < cutoff());
    while (!older(rows.slice(-25)) && page < MAX_PAGES) {
      page++; status("reading page " + page + "…");
      let more; try { more = await fetchPage(page); } catch (e) { if (/signed out/.test(e.message)) throw e; status("could not read page " + page + " (" + e.message + ")"); break; }
      if (!more.length) break;
      rows = rows.concat(more);
      if (older(more)) break;
    }
    post({ type: "cardcomp-fb-feedback-merge", rows });   // every row read joins the feedback history (Customers page, order page)
    const seen = new Set(), rep = {}, uniq = rows.filter((r) => r.order && !seen.has(r.order) && seen.add(r.order));
    uniq.forEach((r) => { if (r.user && dateOf(r.date) >= cutoff()) rep[r.user] = (rep[r.user] || 0) + 1; });   // orders per buyer in the window, worded or not
    return uniq.filter(wanted).map((r) => { r.orders = rep[r.user] || 1; return r; });
  }
  const getDone = () => new Promise((res) => chrome.storage.local.get("fbDone", (r) => res((r && r.fbDone) || {})));
  async function markDone(order, how, extra) {
    const d = await getDone(), cut = Date.now() - KEEP_DAYS * 864e5;
    d[order] = Object.assign({ at: Date.now(), how }, extra || {});
    Object.keys(d).forEach((k) => { if ((d[k].at || 0) < cut) delete d[k]; });
    await new Promise((res) => chrome.storage.local.set({ fbDone: d }, res));
    return d;
  }
  async function unmark(order) { const d = await getDone(); delete d[order]; await new Promise((res) => chrome.storage.local.set({ fbDone: d }, res)); }
  const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const sentToday = (d) => Object.values(d).filter((x) => (x.how === "sent" || x.how === "unsure" || x.how === "sending") && x.at >= midnight()).length;
  // "Pokemon - SWSH: Crown Zenith: Galarian Gallery: Hisuian Samurott V - #GG51/GG70 - Near Mint Holofoil" -> "Hisuian Samurott V"
  // Set names can carry " - " too ("Pokemon - SM - Unbroken Bonds: Chikorita (53) - #53/214 - Near Mint" once read as
  // "SM"): the name is the segment just before the "#number" one, after its last ": ".
  const shortName = (p) => { const parts = String(p).split(" - "); let i = parts.findIndex((x, k) => k > 0 && /^#/.test(x.trim())); if (i < 1) i = Math.min(2, parts.length); const nm = (parts[i - 1] || parts[0] || "").split(": ").pop(); return nm.trim() || String(p).slice(0, 40); };
  const cardsLine = (ps) => { const n = (ps || []).map(shortName); return n.length === 0 ? "" : n.length <= 2 ? n.join(", ") : n.slice(0, 2).join(", ") + " +" + (n.length - 2); };
  // "11/5/2026, 4:17:12 PM (PST)" -> ms
  const fbWhen = (s) => { const t = Date.parse(String(s || "").replace(/\s*\([A-Z]{2,4}\)\s*$/, "")); return isNaN(t) ? 0 : t; };
  // Amber flags on a draft: things a thank-you should not contain unless the buyer brought them up. Never blocking.
  function flagsOf(text, r) {
    const f = [], low = String(text || "").toLowerCase(), fb = String(r.comment || "").toLowerCase();
    [["refund", /refund/], ["discount", /discount|coupon|promo|% off|free /], ["a dollar amount", /\$\s?\d/], ["a link", /https?:\/\/|www\./], ["store credit", /credit/]].forEach(([n, rx]) => { if (rx.test(low) && !rx.test(fb)) f.push("mentions " + n); });
    if (/\b(sorry|apolog)/.test(low) && r.rating >= 4 && !/\b(sorry|issue|problem|wrong|late|damage|missing)/.test(fb)) f.push("apologises for nothing in the feedback");
    if (low.length > 420) f.push("long for a thank-you");
    if (/\b(ai|automat|generated|bot)\b/.test(low)) f.push("mentions automation");
    return f;
  }

  const STYLE = `#ccfb{font:14px/1.45 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;background:#fff;color:#1f2933;border:1px solid #d9dee5;border-radius:10px;padding:14px 18px;margin:10px 0 18px;max-width:1120px;box-shadow:0 1px 3px rgba(16,24,40,.06)}
#ccfb h3{margin:0;font-size:16px;color:#1f2933;font-weight:600;display:flex;align-items:center;gap:10px}#ccfb h3 .n{background:#0d6efd;color:#fff;border-radius:999px;font-size:12px;padding:1px 8px;font-weight:600}
#ccfb .dim{color:#5f6b7a;font-size:12.5px}#ccfb .st{margin:4px 0 8px;min-height:1.2em}#ccfb .bad{color:#b42318}#ccfb .ok{color:#067647}#ccfb .warn{color:#b54708}
#ccfb .row{display:grid;grid-template-columns:56px 1fr;gap:12px;border-top:1px solid #e9edf2;padding:12px 0 10px;border-left:4px solid transparent;margin-left:-18px;padding-left:14px}
#ccfb .row.neg{border-left-color:#d92d20;background:#fff7f6}#ccfb .row.flag{border-left-color:#f79009}
#ccfb .pic{width:56px;height:78px;border-radius:5px;background:#f1f4f8;object-fit:cover;display:block}#ccfb .pic.none{visibility:hidden}
#ccfb .hd{display:flex;gap:10px;flex-wrap:wrap;align-items:baseline}#ccfb .hd b{font-weight:600}#ccfb .hd .stars{color:#b54708;letter-spacing:-1px}#ccfb .hd .stars.good{color:#067647}
#ccfb .hd .card{color:#0d6efd}#ccfb .past{font-size:12px;margin:-4px 0 6px}#ccfb .tag{font-size:11.5px;border-radius:999px;padding:1px 8px;background:#eef2f6;color:#3f4b5b}#ccfb .tag.red{background:#fee4e2;color:#b42318}#ccfb .tag.blue{background:#e0ecff;color:#1849a9}
#ccfb blockquote{margin:5px 0 8px;padding:5px 10px;border-left:3px solid #d9dee5;color:#3f4b5b}
#ccfb textarea{width:100%;box-sizing:border-box;min-height:60px;background:#fff;border:1px solid #c9d0d9;border-radius:7px;color:#1f2933;font:inherit;padding:8px 10px;resize:vertical}#ccfb textarea:focus{outline:2px solid #0d6efd33;border-color:#0d6efd}
#ccfb .act{display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap}#ccfb .act .note{color:#5f6b7a;font-size:12.5px;margin-left:auto}#ccfb .flags{font-size:12.5px;color:#b54708;margin-top:4px}
#ccfb button{background:#fff;border:1px solid #c9d0d9;border-radius:7px;color:#1f2933;font:inherit;padding:7px 14px;cursor:pointer}#ccfb button:hover{background:#f5f7fa}#ccfb button:disabled{opacity:.5;cursor:default}
#ccfb button.send{background:#0d6efd;border-color:#0d6efd;color:#fff;font-weight:600;min-width:96px}#ccfb button.send:hover{background:#0b5ed7}#ccfb button.cancel{border-color:#b42318;color:#b42318}
#ccfb .done{color:#5f6b7a}#ccfb .done b{color:#067647;font-weight:600}#ccfb .done b.un{color:#b54708}#ccfb a{color:#0d6efd}
#ccfb .foot{margin-top:10px;font-size:12.5px;color:#5f6b7a;display:flex;gap:14px;flex-wrap:wrap}#ccfb .hist{margin-top:6px;font-size:12.5px;color:#3f4b5b}#ccfb .hist div{padding:2px 0}
#ccfb.quiet{padding:10px 18px}#ccfb.quiet .st{margin:0}`;
  function mount() {
    const anchor = document.querySelector("h4.blueHeader") || document.body.firstElementChild;
    const st = document.createElement("style"); st.textContent = STYLE; document.head.appendChild(st);
    const box = document.createElement("div"); box.id = "ccfb";
    box.innerHTML = '<h3>Thank-you replies <span class="n" id="ccfbn" hidden></span></h3><div class="st dim" id="ccfbst">checking…</div><div id="ccfblist"></div><div class="foot" id="ccfbfoot"></div><div class="hist" id="ccfbhist" hidden></div>';
    const link = anchor && anchor.nextElementSibling && anchor.nextElementSibling.tagName === "A" ? anchor.nextElementSibling : null;
    const p = link && link.nextElementSibling && link.nextElementSibling.tagName === "P" ? link.nextElementSibling : null;
    (p || link || anchor).insertAdjacentElement("afterend", box);
    return box;
  }
  const orderURL = (o) => "https://sellerportal.tcgplayer.com/orders/" + encodeURIComponent(o);
  const MSGS = "https://sellerportal.tcgplayer.com/messages";
  // "view message": the thread itself (sellerportal .../messages/<id>, found from the Messages list after a send, kept on
  // the done entry), else the Messages list.
  const msgLink = (d, label) => `<a href="${esc(d && d.thread ? d.thread : MSGS)}" target="_blank" title="${d && d.thread ? "the message thread" : "the Messages list (thread not found yet)"}">${label || "view message"} ↗</a>`;
  const stars = (n) => `<span class="stars ${n >= 4 ? "good" : ""}" title="${n} of 5">${"★".repeat(Math.max(0, Math.min(5, n)))}${"☆".repeat(Math.max(0, 5 - n))}</span>`;
  const rowHTML = (r) => `<div class="row${r.rating <= 3 ? " neg" : ""}" data-order="${esc(r.order)}"><img class="pic none" alt="" data-pic><div><div class="hd"><b>${esc(r.user)}</b>${stars(r.rating)}<span class="dim">ordered ${esc(r.date)} · <a href="${orderURL(r.order)}" target="_blank" title="open the order">${esc(r.order)}</a></span><span class="card" data-card></span>${r.orders > 1 ? `<span class="tag blue">${r.orders} orders in ${FB_DAYS} days</span>` : ""}<span data-tags></span></div><blockquote>${esc(r.comment)}</blockquote><div data-body><span class="dim" data-wait>waiting…</span></div></div></div>`;
  function draftHTML(text, note, flags) {
    return `<textarea data-text>${esc(text)}</textarea>${flags && flags.length ? `<div class="flags">⚠ check: ${esc(flags.join(" · "))}</div>` : ""}<div class="act"><button class="send" data-send>Send</button><button data-skip>Skip</button><button data-redo title="another draft">redo</button><button data-redo="shorter" title="another draft, shorter">shorter</button><span class="note">${esc(note || "")}</span></div>`;
  }
  async function run() {
    const box = mount(), stEl = box.querySelector("#ccfbst"), list = box.querySelector("#ccfblist"), foot = box.querySelector("#ccfbfoot"), nEl = box.querySelector("#ccfbn"), hist = box.querySelector("#ccfbhist");
    const status = (s, cls) => { stEl.textContent = s; stEl.className = "st " + (cls || "dim"); };
    const key = await post({ type: "cardcomp-fb-key" });
    if (!key) { status("CardComp extension not reachable: reload the extension, then this page.", "bad"); return; }
    if (!key.ok) { stEl.innerHTML = 'Add your Anthropic API key on the <a href="' + esc(chrome.runtime.getURL("options.html")) + '" target="_blank">extension\'s Options page</a> to get drafts.'; stEl.className = "st bad"; return; }
    let done = await getDone();
    let rows; try { rows = await recentRows(status); } catch (e) { status(/signed out/.test(e.message) ? "Signed out of the Seller Portal: log in and reload this page." : e.message, "bad"); return; }
    const todo = rows.filter((r) => !done[r.order]).sort((a, b) => (a.rating <= 3 ? 0 : 1) - (b.rating <= 3 ? 0 : 1) || dateOf(b.date) - dateOf(a.date));   // negative first
    post({ type: "cardcomp-fb-pending", n: todo.length });   // icon badge
    const paintFoot = () => {
      const sent = Object.entries(done).filter(([, d]) => d.how === "sent" || d.how === "unsure"), ns = Object.values(done).filter((d) => d.how === "skip").length;
      foot.innerHTML = `<span>${rows.length} worded in the last ${FB_DAYS} days</span><span><a href="${esc(chrome.runtime.getURL("feedback/customers.html"))}" target="_blank" title="top buyers, repeat rate, feedback history">customers ↗</a></span><span><a href="#" data-hist>replied from here: ${sent.length}</a></span><span>skipped: ${ns}${ns ? ' <a href="#" data-unskip>offer again</a>' : ""}</span><span>today: ${sentToday(done)} of ${FB_DAY_CAP}</span>`;
      const u = foot.querySelector("[data-unskip]"); if (u) u.onclick = async (e) => { e.preventDefault(); const d = await getDone(); Object.keys(d).forEach((k) => { if (d[k].how === "skip") delete d[k]; }); chrome.storage.local.set({ fbDone: d }, () => location.reload()); };
      foot.querySelector("[data-hist]").onclick = (e) => {
        e.preventDefault(); hist.hidden = !hist.hidden; if (hist.hidden) return;
        const last = sent.sort((a, b) => b[1].at - a[1].at).slice(0, 15);
        hist.innerHTML = last.length ? last.map(([o, d]) => `<div>${new Date(d.at).toLocaleDateString()} · <b>${esc(d.user || "")}</b>${d.how === "unsure" ? ' <span class="tag red">unsure</span>' : ""} · ${esc(d.text || "")} <span class="dim">${msgLink(d, "message")} · <a href="${orderURL(o)}" target="_blank" title="the order page">order ↗</a></span></div>`).join("") : "<div>nothing yet</div>";
      };
    };
    paintFoot();
    const missing = Object.entries(done).filter(([, d]) => (d.how === "sent" || d.how === "unsure") && !d.thread && d.at > Date.now() - 30 * 864e5).map(([o]) => o);
    if (missing.length) (async () => {   // one Messages read fills every recent send's thread link
      for (const o of missing) { const t = await post({ type: "cardcomp-fb-thread", order: o, since: 0 }); if (t && t.ok) { done = await getDone(); if (done[o]) done[o].thread = t.url; } }
      await new Promise((res) => chrome.storage.local.set({ fbDone: done }, res)); paintFoot();
    })();
    if (!todo.length) { box.classList.add("quiet"); status(rows.length ? "All caught up." : "No worded feedback with a buyer name in the last " + FB_DAYS + " days.", "ok"); return; }
    nEl.textContent = todo.length; nEl.hidden = false;
    status(todo.length + " to reply to" + (todo.some((r) => r.rating <= 3) ? ", lower ratings first" : "") + ". Reading the orders one at a time…");
    list.innerHTML = todo.map(rowHTML).join("");
    for (const r of todo) {
      const el = list.querySelector('.row[data-order="' + CSS.escape(r.order) + '"]'); if (!el) continue;
      const body = el.querySelector("[data-body]"), card = el.querySelector("[data-card]"), pic = el.querySelector("[data-pic]"), tags = el.querySelector("[data-tags]");
      body.innerHTML = '<span class="dim">reading the order…</span>';
      const o = await post({ type: "cardcomp-fb-order", order: r.order });
      const info = o && o.ok ? o.info : null;
      if (info) {
        r.products = info.products; r.fbDate = info.fbDate; r.pageFeedback = info.feedback; r.buyer = info.buyer; card.textContent = cardsLine(info.products);
        if (window.ccBuyer && info.buyer) {   // the buyer history (Options import + pages seen) beats the 14-day guess
          const bs = await window.ccBuyer.stats(info.buyer, 0, r.order); r.history = window.ccBuyer.line(bs, r.order);
          const old = el.querySelector(".hd .tag.blue"); const chip = window.ccBuyer.chip(bs, 0);
          if (bs && bs.n) { if (old) old.remove(); if (chip) el.querySelector(".hd").insertBefore(chip, tags); }
          const past = bs && bs.fb ? bs.fb.filter((x) => x.order !== r.order && x.c) : [];   // what they said before this one
          if (past.length) { const q = document.createElement("div"); q.className = "dim past"; q.textContent = `earlier: ${past[0].r}★ “${past[0].c}” (${new Date(past[0].at).toLocaleDateString()})${past.length > 1 ? " +" + (past.length - 1) + " more" : ""}`; el.querySelector("blockquote").insertAdjacentElement("afterend", q); }
        }
        if (info.pids && info.pids[0]) { pic.src = "https://tcgplayer-cdn.tcgplayer.com/product/" + info.pids[0] + "_200w.jpg"; pic.onload = () => pic.classList.remove("none"); }
        if (r.rating <= 3 && fbWhen(info.fbDate)) { const left = Math.round((fbWhen(info.fbDate) + 48 * 36e5 - Date.now()) / 36e5); tags.innerHTML = `<span class="tag red">${left > 0 ? "reply within 48h: " + left + "h left" : "48h window passed"}</span>`; }
      } else body.innerHTML = '<span class="dim">order page not read (' + esc(o && o.why || "no reply") + '), drafting without the cards…</span>';
      await draft(r, el);
    }
    status(todo.length + " drafted. Read each one, edit if you like, then Send or Skip.", "dim");
    async function draft(r, el, style) {
      const body = el.querySelector("[data-body]");
      body.innerHTML = '<span class="dim">drafting…</span>';
      const d = await post({ type: "cardcomp-fb-draft", row: r, style: style || "" });
      if (!d || !d.ok) body.innerHTML = draftHTML("", "no draft: " + (d && d.why || "no reply") + ". Write it here or skip.", []);
      else { const f = flagsOf(d.text, r); body.innerHTML = draftHTML(d.text, "draft" + (d.cost != null ? ", $" + d.cost.toFixed(3) : ""), f); el.classList.toggle("flag", f.length > 0 && r.rating > 3); }
      wire(r, el);
    }
    function wire(r, el) {
      const ta = el.querySelector("[data-text]"), send = el.querySelector("[data-send]"), skip = el.querySelector("[data-skip]"), redos = el.querySelectorAll("[data-redo]"), note = el.querySelector(".note");
      const lock = (on) => { skip.disabled = on; redos.forEach((b) => { b.disabled = on; }); };
      let timer = null;
      ta.addEventListener("input", () => { const f = flagsOf(ta.value, r); let fl = el.querySelector(".flags"); if (f.length && !fl) { fl = document.createElement("div"); fl.className = "flags"; ta.insertAdjacentElement("afterend", fl); } if (fl) { fl.textContent = f.length ? "⚠ check: " + f.join(" · ") : ""; } });
      send.onclick = async () => {
        if (timer) { clearInterval(timer); timer = null; send.textContent = "Send"; send.classList.remove("cancel"); lock(false); note.textContent = "cancelled"; return; }
        const text = ta.value.trim(); if (!text) { note.textContent = "nothing to send"; return; }
        let n = COUNTDOWN; lock(true); send.classList.add("cancel"); note.textContent = "";
        const tick = () => { send.textContent = n > 0 ? "sending in " + n + "… cancel" : "sending…"; };
        tick();
        await new Promise((res) => { if (n <= 0) return res(); timer = setInterval(() => { n--; tick(); if (n <= 0) { clearInterval(timer); timer = null; res(); } }, 1000); });
        if (send.textContent === "Send") return;   // cancelled
        send.disabled = true; send.classList.remove("cancel"); send.textContent = "sending…";
        // Fresh look at storage: another panel may have sent it, and the day cap counts every send.
        done = await getDone();
        if (done[r.order]) { finish("already " + done[r.order].how + " from another tab", true); return; }
        if (sentToday(done) >= FB_DAY_CAP) { fail("daily cap of " + FB_DAY_CAP + " reached, try tomorrow"); return; }
        done = await markDone(r.order, "sending", { user: r.user, text });   // lock first: an unknown outcome is never retried automatically
        const res = await post({ type: "cardcomp-fb-send", order: r.order, text, expect: { comment: r.comment, user: r.user } });
        if (res && res.ok) { done = await markDone(r.order, "sent", { user: r.user, text }); finish("✓ sent", false); }
        else if (res && res.clicked) {   // Send was pressed but the page gave no confirmation: maybe sent. Never again automatically.
          done = await markDone(r.order, "unsure", { user: r.user, text, why: res.why });
          el.querySelector("[data-body]").innerHTML = `<div class="done"><b class="un">unsure</b> Send was pressed but the page did not confirm (${esc(res.why || "")}). <a href="${MSGS}" target="_blank">open Messages</a> and check the order's thread before sending by hand. Not offered again.</div>`;
          paintFoot(); post({ type: "cardcomp-fb-pending", n: list.querySelectorAll("[data-send]").length });
        } else { await unmark(r.order); done = await getDone(); fail("not sent: " + (res && res.why || "no reply from the extension") + (res && res.typed ? " (the order tab is in front with your text in the box)" : "")); }
      };
      function fail(why) { send.disabled = false; send.classList.remove("cancel"); send.textContent = "Send"; lock(false); note.textContent = why; note.className = "note bad"; }
      function finish(label, odd) { el.querySelector("[data-body]").innerHTML = `<div class="done"><b${odd ? ' class="un"' : ""}>${esc(label)}</b> to ${esc(r.user)}: ${esc(ta.value.trim())} <span data-msglink>${odd ? msgLink(done[r.order]) : '<span class="dim">finding the message…</span>'}</span></div>`;
        if (!odd) findThread(r, el); paintFoot(); const left = list.querySelectorAll("[data-send]").length; nEl.textContent = left; nEl.hidden = !left; post({ type: "cardcomp-fb-pending", n: left }); }
      async function findThread(r, el) {
        const t = await post({ type: "cardcomp-fb-thread", order: r.order, since: Date.now() - 90000 });
        if (t && t.ok) { done = await getDone(); if (done[r.order]) { done[r.order].thread = t.url; await new Promise((res) => chrome.storage.local.set({ fbDone: done }, res)); } }
        const sp = el.querySelector("[data-msglink]"); if (sp) sp.innerHTML = msgLink(t && t.ok ? { thread: t.url } : null);
      }
      skip.onclick = async () => { done = await markDone(r.order, "skip", { user: r.user }); el.querySelector("[data-body]").innerHTML = '<div class="done">skipped</div>'; paintFoot(); const left = list.querySelectorAll("[data-send]").length; nEl.textContent = left; nEl.hidden = !left; post({ type: "cardcomp-fb-pending", n: left }); };
      redos.forEach((b) => { b.onclick = () => draft(r, el, b.getAttribute("data-redo") || ""); });
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run();
})();
