// Feedback thank-yous: the Seller Portal Feedback tab (store.tcgplayer.com/admin/Seller/Feedback). A panel above the
// feedback list offers one draft per worded, named feedback from the last FB_DAYS days that has not been replied to or
// skipped from here (done list in chrome.storage.local fbDone). Pages 2.. are fetched with the same login until the
// rows are older than the window (the page is server-rendered, 25 rows a page, ?page=N). Drafts come from
// feedback-bg.js; Send goes through the order page (order.js). Nothing is sent without a tap.
(() => {
  if (!/\/admin\/Seller\/Feedback/i.test(location.pathname)) return;
  const FB_DAYS = 14, MAX_PAGES = 6, KEEP_DAYS = 90;
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
    return parseRows(new DOMParser().parseFromString(await r.text(), "text/html"));
  }
  async function recentRows(status) {
    let rows = parseRows(document), page = 1;
    const older = (rs) => rs.length && rs.every((r) => dateOf(r.date) < cutoff());
    while (!older(rows.slice(-25)) && page < MAX_PAGES) {
      page++; status("reading page " + page + "…");
      let more; try { more = await fetchPage(page); } catch (e) { status("could not read page " + page + " (" + e.message + ")"); break; }
      if (!more.length) break;
      rows = rows.concat(more);
      if (older(more)) break;
    }
    const seen = new Set();
    return rows.filter((r) => { if (!wanted(r) || seen.has(r.order)) return false; seen.add(r.order); return true; });
  }
  const getDone = () => new Promise((res) => chrome.storage.local.get("fbDone", (r) => res((r && r.fbDone) || {})));
  async function markDone(order, how, extra) {
    const d = await getDone(), cut = Date.now() - KEEP_DAYS * 864e5;
    d[order] = Object.assign({ at: Date.now(), how }, extra || {});
    Object.keys(d).forEach((k) => { if ((d[k].at || 0) < cut) delete d[k]; });
    await new Promise((res) => chrome.storage.local.set({ fbDone: d }, res));
  }
  // "Pokemon - SWSH: Crown Zenith: Galarian Gallery: Hisuian Samurott V - #GG51/GG70 - Near Mint Holofoil" -> "Hisuian Samurott V"
  const shortName = (p) => { const parts = String(p).split(" - "); const nm = (parts[1] || parts[0] || "").split(": ").pop(); return nm.trim() || String(p).slice(0, 40); };
  const cardsLine = (ps) => { const n = (ps || []).map(shortName); return n.length === 0 ? "" : n.length <= 2 ? n.join(", ") : n.slice(0, 2).join(", ") + " +" + (n.length - 2); };

  const STYLE = `#ccfb{font:14px/1.45 system-ui,sans-serif;background:#14181d;color:#e8edf2;border:1px solid #2a313a;border-radius:10px;padding:14px 16px;margin:10px 0 18px;max-width:1100px}
#ccfb h3{margin:0 0 4px;font-size:16px;color:#f5b301;font-weight:600}#ccfb .dim{color:#8b97a5;font-size:12.5px}#ccfb .st{margin:6px 0 10px;min-height:1.3em}
#ccfb .row{border-top:1px solid #2a313a;padding:12px 0 10px}#ccfb .hd{display:flex;gap:10px;flex-wrap:wrap;align-items:baseline}#ccfb .hd b{font-weight:600}#ccfb .hd .card{color:#9ec3ff}
#ccfb blockquote{margin:6px 0 8px;padding:6px 10px;border-left:3px solid #3a434e;color:#cfd6de;font-style:italic}
#ccfb textarea{width:100%;box-sizing:border-box;min-height:64px;background:#1b2026;border:1px solid #2a313a;border-radius:7px;color:#e8edf2;font:inherit;padding:8px 10px;resize:vertical}
#ccfb .act{display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap}#ccfb .act .note{color:#8b97a5;font-size:12.5px;margin-left:auto}
#ccfb button{background:#1b2026;border:1px solid #3a434e;border-radius:7px;color:#e8edf2;font:inherit;padding:7px 14px;cursor:pointer}#ccfb button:disabled{opacity:.5;cursor:default}
#ccfb button.send{background:rgba(245,179,1,.14);border-color:#f5b301;font-weight:600;min-width:84px}#ccfb .ok{color:#33a876}#ccfb .bad{color:#e66767}
#ccfb .done{color:#8b97a5}#ccfb .done b{color:#33a876;font-weight:600}#ccfb a{color:#f5b301}#ccfb .foot{margin-top:10px;font-size:12.5px;color:#8b97a5;display:flex;gap:14px;flex-wrap:wrap}`;
  function mount() {
    const anchor = document.querySelector("h4.blueHeader") || document.body.firstElementChild;
    const st = document.createElement("style"); st.textContent = STYLE; document.head.appendChild(st);
    const box = document.createElement("div"); box.id = "ccfb";
    box.innerHTML = '<h3>Thank-you replies</h3><div class="dim">Worded feedback with a buyer name from the last ' + FB_DAYS + ' days. Each draft goes to the buyer as an order message when you press Send. Edit the text first if you like.</div><div class="st dim" id="ccfbst">checking…</div><div id="ccfblist"></div><div class="foot" id="ccfbfoot"></div>';
    let after = anchor; while (after && after.nextSibling && after.nextSibling.nodeType === 3) after = after.nextSibling;   // past "Related Help Files" text
    const link = anchor && anchor.nextElementSibling && anchor.nextElementSibling.tagName === "A" ? anchor.nextElementSibling : null;
    const p = link && link.nextElementSibling && link.nextElementSibling.tagName === "P" ? link.nextElementSibling : null;
    (p || link || anchor).insertAdjacentElement("afterend", box);
    return box;
  }
  const rowHTML = (r) => `<div class="row" data-order="${esc(r.order)}"><div class="hd"><b>${esc(r.user)}</b><span class="dim">${r.rating}★ · ordered ${esc(r.date)} · ${esc(r.order)}</span><span class="card" data-card></span></div><blockquote>${esc(r.comment)}</blockquote><div data-body><span class="dim" data-wait>waiting…</span></div></div>`;
  function draftHTML(text, note) {
    return `<textarea data-text>${esc(text)}</textarea><div class="act"><button class="send" data-send>Send</button><button data-skip>Skip</button><button data-redo title="another draft">redo</button><span class="note">${esc(note || "")}</span></div>`;
  }
  async function run() {
    const box = mount(), stEl = box.querySelector("#ccfbst"), list = box.querySelector("#ccfblist"), foot = box.querySelector("#ccfbfoot");
    const status = (s, cls) => { stEl.textContent = s; stEl.className = "st " + (cls || "dim"); };
    const key = await post({ type: "cardcomp-fb-key" });
    if (!key) { status("CardComp extension not reachable: reload the extension, then this page.", "bad"); return; }
    if (!key.ok) { stEl.innerHTML = 'Add your Anthropic API key on the <a href="' + esc(chrome.runtime.getURL("options.html")) + '" target="_blank">extension\'s Options page</a> to get drafts.'; stEl.className = "st bad"; return; }
    const done = await getDone();
    const rows = await recentRows(status);
    const todo = rows.filter((r) => !done[r.order]);
    const nd = Object.values(done).filter((d) => d.how === "sent").length, ns = Object.values(done).filter((d) => d.how === "skip").length;
    foot.innerHTML = `<span>${rows.length} worded in the last ${FB_DAYS} days</span><span>replied from here: ${nd}</span><span>skipped: ${ns}${ns ? ' <a href="#" data-unskip>offer again</a>' : ""}</span>`;
    foot.querySelector("[data-unskip]") && (foot.querySelector("[data-unskip]").onclick = async (e) => { e.preventDefault(); const d = await getDone(); Object.keys(d).forEach((k) => { if (d[k].how === "skip") delete d[k]; }); chrome.storage.local.set({ fbDone: d }, () => location.reload()); });
    if (!todo.length) { status(rows.length ? "All caught up: every worded feedback of the last " + FB_DAYS + " days is replied to or skipped." : "No worded feedback with a buyer name in the last " + FB_DAYS + " days.", "ok"); return; }
    status(todo.length + " to reply to. Reading the orders one at a time…");
    list.innerHTML = todo.map(rowHTML).join("");
    for (const r of todo) {
      const el = list.querySelector('.row[data-order="' + CSS.escape(r.order) + '"]'); if (!el) continue;
      const body = el.querySelector("[data-body]"), card = el.querySelector("[data-card]");
      body.innerHTML = '<span class="dim">reading the order…</span>';
      const o = await post({ type: "cardcomp-fb-order", order: r.order });
      const info = o && o.ok ? o.info : null;
      if (info) { r.products = info.products; r.fbDate = info.fbDate; card.textContent = cardsLine(info.products); if (info.feedback) r.comment = info.feedback; }
      else body.innerHTML = '<span class="dim">order page not read (' + esc(o && o.why || "no reply") + '), drafting without the cards…</span>';
      await draft(r, el);
    }
    status(todo.length + " drafted. Send, edit, or skip each one.", "dim");
    async function draft(r, el) {
      const body = el.querySelector("[data-body]");
      body.innerHTML = '<span class="dim">drafting…</span>';
      const d = await post({ type: "cardcomp-fb-draft", row: r });
      if (!d || !d.ok) {
        body.innerHTML = draftHTML("", "no draft: " + (d && d.why || "no reply") + ". Write it here or skip.");
      } else body.innerHTML = draftHTML(d.text, "draft, " + (d.cost != null ? "$" + d.cost.toFixed(3) : ""));
      wire(r, el);
    }
    function wire(r, el) {
      const ta = el.querySelector("[data-text]"), send = el.querySelector("[data-send]"), skip = el.querySelector("[data-skip]"), redo = el.querySelector("[data-redo]"), note = el.querySelector(".note");
      send.onclick = async () => {
        const text = ta.value.trim(); if (!text) { note.textContent = "nothing to send"; return; }
        send.disabled = skip.disabled = redo.disabled = true; send.textContent = "sending…"; note.textContent = "";
        const res = await post({ type: "cardcomp-fb-send", order: r.order, text });
        if (res && res.ok) { await markDone(r.order, "sent", { user: r.user, text }); el.querySelector("[data-body]").innerHTML = '<div class="done"><b>✓ sent</b> to ' + esc(r.user) + ': ' + esc(text) + "</div>"; }
        else { send.disabled = skip.disabled = redo.disabled = false; send.textContent = "Send"; note.textContent = "not sent: " + (res && res.why || "no reply from the extension"); note.className = "note bad"; }
      };
      skip.onclick = async () => { await markDone(r.order, "skip", { user: r.user }); el.querySelector("[data-body]").innerHTML = '<div class="done">skipped</div>'; };
      redo.onclick = () => draft(r, el);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run();
})();
