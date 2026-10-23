// CardComp on the phone (docs/mobile-overlay-handoff.md): the page half of the Android app.
// The Android app shows CardComp in a WebView floating over the Whatnot app and injects this file. It plays the
// Chrome extension's part with the same messages (cardcomp-ext-ready, cardcomp-auto, cardcomp-bid-ack ...), posted
// to this window, so index.html and recog/auto-ui.js run unchanged. Native code is reached through the
// `Android` interface (OverlayService.Bridge in android/); native calls back through window.__phone.
// Does nothing without the app (no `Android` object): a phone browser or desktop tab never sees it.
(function () {
  if (!window.Android || window.__phone) return;
  const A = window.Android, P = (window.__phone = {});
  const $ = (s) => document.querySelector(s);
  const toApp = (m) => { try { window.postMessage(m, location.origin); } catch (_) {} };   // same path as the extension's content script
  const cfg = () => { try { return JSON.parse(A.cfg() || "{}") || {}; } catch (_) { return {}; } };
  const log = (o) => { try { A.log(typeof o === "string" ? o : JSON.stringify(o)); } catch (_) {} };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const VER = "0.1.0";          // bridge version
  const PROTO = "0.9.0";        // the extension version the app should treat us as (auto-ui gates the picture match on 0.7+)

  // ---------------------------------------------------------------- the reader (shared with the extension)
  let readerReady = null;
  function loadReader() {
    if (readerReady) return readerReady;
    readerReady = new Promise((res) => {
      if (typeof window.recogRead === "function") return res(true);
      const s = document.createElement("script"); s.src = "extension/recog/recog-read.js";
      s.onload = () => res(typeof window.recogRead === "function"); s.onerror = () => res(false);
      document.head.appendChild(s);
    });
    return readerReady;
  }

  // ---------------------------------------------------------------- state to the app
  function state() {
    const c = cfg(), mode = ["off", "manual", "auto"].includes(c.mode) ? c.mode : "manual";
    toApp({ type: "cardcomp-auto-state", on: mode !== "off", mode, model: c.model || "sonnet", hasKey: !!c.hasKey, ver: PROTO });
  }
  function status() {
    const c = cfg();
    toApp({ type: "cardcomp-status-ack", whatnot: !!c.reader, store: !!c.hasToken });
  }

  // ---------------------------------------------------------------- read now: frame from the screen capture -> model -> cardcomp-auto
  let REQ = 0; const PENDING = {};
  P.readNow = function (src) {
    const c = cfg();
    if (c.mode === "off") { toApp({ type: "cardcomp-auto-readack", ok: false, why: "auto is off" }); return; }
    if (!c.hasKey) { toApp({ type: "cardcomp-auto-readack", ok: false, why: "no API key: add it in the CardComp app" }); return; }
    const req = String(++REQ);
    PENDING[req] = { at: Date.now(), src: src || "app" };
    let r = ""; try { r = A.grab(req); } catch (e) { r = "error: " + e.message; }
    if (r && r !== "ok") { delete PENDING[req]; toApp({ type: "cardcomp-auto-readack", ok: false, why: r }); }
  };
  P.frame = function (req, img, w, h) { const p = PENDING[req]; delete PENDING[req]; if (p) runRead(img, w, h, p); };
  P.frameFail = function (req, why) { delete PENDING[req]; toApp({ type: "cardcomp-auto-readack", ok: false, why: why || "no frame" }); };

  async function runRead(img, w, h, p) {
    const c = cfg(), modelKey = c.model || "sonnet", key = p.at;   // keyed by press time, like the extension's read now
    const head = { type: "cardcomp-auto", key, n: 1, capAt: key, title: "", seller: "", pre: false, manual: true };
    if (!(await loadReader())) { toApp(Object.assign(head, { error: "reader not loaded (extension/recog/recog-read.js)" })); return; }
    let apiKey = ""; try { apiKey = A.key("anthropic") || ""; } catch (_) {}
    if (!apiKey) { toApp(Object.assign(head, { error: "no API key: add it in the CardComp app" })); return; }
    const short = Math.min(w || 0, h || 0);
    const res = await recogRead(img, modelKey, apiKey, (read, ms) =>
      toApp(Object.assign({}, head, { partial: true, read, ms, model: RECOG_MODELS[modelKey] || "", short })));
    toApp(Object.assign({}, head, { read: res.read || null, error: res.error || "", model: res.model || "", ms: res.ms || 0, cost: res.cost || 0, short }));
    log({ read: res.read || null, error: res.error || "", ms: res.ms, cost: res.cost, src: p.src });
    if (res.read && res.read.name) layout("panel");
    // no number read, or unsure: read the enlarged card from the same frame (CardComp keeps it only if it ranks higher)
    const r = res.read;
    if (r && r.card_visible !== false && r.name && (!r.number || (r.confidence || 0) < 0.7) && Array.isArray(r.box) && r.box.length === 4) {
      let zc = null; try { zc = await zoom(img, r.box); } catch (e) { log("zoom: " + e.message); }
      if (zc) {
        const zr = await recogRead(zc.img, modelKey, apiKey);
        if (zr.read) toApp(Object.assign({}, head, { zoom: zc.z, read: zr.read, error: "", model: zr.model || "", ms: zr.ms || 0, cost: zr.cost || 0, short }));
      }
    }
  }
  // the card box (thousandths) plus a 12% margin, enlarged to ~1400 px (at most 3x)
  function zoom(src, box) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => {
        const W = im.naturalWidth, H = im.naturalHeight;
        let x0 = box[0] / 1000 * W, y0 = box[1] / 1000 * H, x1 = box[2] / 1000 * W, y1 = box[3] / 1000 * H;
        const mw = (x1 - x0) * 0.12, mh = (y1 - y0) * 0.12;
        x0 = Math.max(0, x0 - mw); y0 = Math.max(0, y0 - mh); x1 = Math.min(W, x1 + mw); y1 = Math.min(H, y1 + mh);
        const cw = x1 - x0, ch = y1 - y0;
        if (cw < 40 || ch < 40 || cw * ch > W * H * 0.8) return res(null);   // no box, or the whole frame already
        const z = Math.min(3, 1400 / Math.max(cw, ch));
        if (z < 1.3) return res(null);
        const c = document.createElement("canvas"); c.width = Math.round(cw * z); c.height = Math.round(ch * z);
        c.getContext("2d").drawImage(im, x0, y0, cw, ch, 0, 0, c.width, c.height);
        res({ img: c.toDataURL("image/jpeg", 0.88), z: Math.round(z * 10) / 10, w: c.width, h: c.height });
      };
      im.onerror = () => rej(new Error("frame unreadable")); im.src = src;
    });
  }

  // ---------------------------------------------------------------- messages from the app (what the extension's background answers)
  const HANDLED = new Set(["cardcomp-status", "cardcomp-auto-hello", "cardcomp-auto-config", "cardcomp-auto-read", "cardcomp-bid", "cardcomp-open-bg",
    "cardcomp-auto-img", "cardcomp-auto-match", "cardcomp-auto-outcome", "cardcomp-log-save", "cardcomp-live-save", "cardcomp-log-read", "cardcomp-log-edit",
    "cardcomp-log-prune", "cardcomp-tcg-fast", "cardcomp-snapshot", "cardcomp-live-test"]);
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data; if (!d || typeof d.type !== "string" || !HANDLED.has(d.type)) return;
    try { handle(d); } catch (err) { log("handle " + d.type + ": " + err.message); }
  });
  function handle(d) {
    switch (d.type) {
      case "cardcomp-status": status(); break;
      case "cardcomp-auto-hello": state(); break;
      case "cardcomp-auto-config": A.setCfg(JSON.stringify({ mode: d.mode, model: d.model })); state(); break;
      case "cardcomp-auto-read": P.readNow("app"); break;
      case "cardcomp-bid": {   // phase 0: the whole-dollar bid goes to the clipboard; phase 1 fills Whatnot's Custom box
        let r = {}; try { r = JSON.parse(A.bid(String(d.amount), String(d.name || "")) || "{}"); } catch (e) { r = { ok: false, why: e.message }; }
        toApp(Object.assign({ type: "cardcomp-bid-ack" }, r));
        flashBid(r);
        layout("strip");
        break;
      }
      case "cardcomp-open-bg": A.open(String(d.url || "")); break;   // TCGplayer links open in the browser over Whatnot
      case "cardcomp-auto-img": toApp({ type: "cardcomp-auto-img-ack", key: d.key, n: d.n || 1, cands: [], ok: false, why: "not on the phone yet" }); break;
      case "cardcomp-tcg-fast": toApp({ type: "cardcomp-tcg-fast-ack", req: d.req, ok: false, errs: ["not on the phone yet: open the link"] }); break;
      case "cardcomp-snapshot": toApp({ type: "cardcomp-snapshot-ack", ok: false, why: "not on the phone yet" }); break;
      case "cardcomp-live-test": toApp({ type: "cardcomp-live-test-ack", ok: false, why: "not on the phone yet" }); break;
      default: log({ unhandled: d.type });   // log / live store: phase 1
    }
  }

  // ---------------------------------------------------------------- keyboard: the window is focusable only while a text field has focus
  const isField = (t) => !!(t && t.closest && t.closest("input:not([type=checkbox]):not([type=radio]),textarea,select,[contenteditable]"));
  let LAY = "strip", BEFORE_TYPING = "strip";
  document.addEventListener("focusin", (e) => { if (!isField(e.target)) return; try { A.focus(true); } catch (_) {} if (e.target.id === "q" && LAY !== "typing") { BEFORE_TYPING = LAY; layout("typing"); } }, true);
  document.addEventListener("focusout", (e) => {
    if (!isField(e.target)) return;
    setTimeout(() => { if (isField(document.activeElement)) return; try { A.focus(false); } catch (_) {} if (LAY === "typing") layout(BEFORE_TYPING === "typing" ? "strip" : BEFORE_TYPING); }, 150);
  }, true);
  P.blur = function () { try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (_) {} };

  // ---------------------------------------------------------------- layout: strip (top band), typing (top band, taller), panel (bottom band)
  function layout(s) {
    if (s !== "strip" && s !== "typing" && s !== "panel") return;
    LAY = s;
    document.body.classList.remove("ph-strip", "ph-typing", "ph-panel"); document.body.classList.add("ph-" + s);
    try { A.layout(s); } catch (_) {}
    if (s === "strip") window.scrollTo(0, 0);
    if (s === "panel") setTimeout(() => { const o = $("#results .card.open") || $("#results .card.autosug"); if (o) o.scrollIntoView({ block: "start" }); }, 50);
    paintBar();
  }
  P.layout = layout;
  P.state = () => LAY;

  const css = document.createElement("style");
  css.textContent =
    "body.phone{padding:0 6px 4px}body.phone h1,body.phone #gear,body.phone #settings,body.phone #filterbar,body.phone #filterwrap,body.phone #stale,body.phone #wnstat{display:none!important}" +
    "body.phone .searchrow{padding:4px 0;gap:4px}body.phone #q{padding:9px 10px;font-size:15px}body.phone #langbtn{padding:6px 8px;min-width:40px}body.phone #readbig{width:54px;max-height:40px}" +
    "body.phone #lotstrip{padding:3px 7px;font-size:11.5px}body.phone #readbig .k{display:none}" +
    "body.phone #autoline{padding:2px 6px;font-size:11px;display:-webkit-box!important;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}body.phone #autoline.full{-webkit-line-clamp:unset}" +
    "body.ph-strip #sug,body.ph-strip #read,body.ph-strip #status,body.ph-strip #results,body.ph-strip #cart,body.ph-strip #pickbar,body.ph-strip #autoline{display:none!important}" +
    "body.ph-typing #read,body.ph-typing #status,body.ph-typing #autoline{display:none!important}" +
    "#phonebar{display:flex;align-items:center;gap:6px;min-height:34px;padding:2px 0;font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.25}" +
    "#phonebar .pn{flex:1;min-width:0;overflow:hidden;cursor:pointer}#phonebar .pn b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink)}" +
    "#phonebar .pn span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dim);font-size:10.5px}" +
    "#phonebar .pb{flex:none;border:2px solid var(--gold);background:rgba(245,179,1,.14);color:var(--gold);border-radius:8px;padding:6px 10px;font-weight:700;font-size:16px;min-width:64px;text-align:center}" +
    "#phonebar .pb.none{border-color:var(--line);color:var(--faint);background:none}#phonebar .px{flex:none;color:var(--dim);font-size:10.5px;line-height:1.2;text-align:right;white-space:nowrap}" +
    "#phonebar .pt{flex:none;border:1px solid var(--line);color:var(--dim);border-radius:6px;padding:5px 7px;font-size:12px}body.ph-panel #phonebar .pt{color:var(--gold);border-color:var(--gold)}";
  document.head.appendChild(css);
  document.body.classList.add("phone");
  document.addEventListener("click", (e) => { const a = e.target && e.target.closest && e.target.closest("#autoline"); if (a && !e.target.closest("a,select,.modes,.rn")) a.classList.toggle("full"); });

  // ---------------------------------------------------------------- the strip's card line: name, the max bid, NM / LP / MP
  // The card shown: the open card, else the best guess of the last reading, else the first result. The bid button taps
  // the card's own bid chip (copyAmt), so the lot label, the taps and the log see the same tap as a tap on the tile.
  let barEl = null, FLASH = null;
  function bar() {
    if (barEl && barEl.isConnected) return barEl;
    const row = $("#q") && $("#q").parentElement && $("#q").parentElement.parentElement; if (!row) return null;
    barEl = document.createElement("div"); barEl.id = "phonebar";
    row.insertAdjacentElement("afterend", barEl);
    return barEl;
  }
  const money = (v) => "$" + (v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2));
  function focusCard() {   // the default list on load is not a card Derek asked about: only a search or a read puts one on the strip
    const q = $("#q"), typed = q && q.value.trim();
    return $("#results .card.open") || $("#results .card.autosug") || (typed ? $("#results .card") : null);
  }
  function paintBar() {
    const el = bar(); if (!el) return;
    const card = focusCard(), id = card && card.dataset.id, r = id && typeof CARDS !== "undefined" ? CARDS.find((x) => x.id === id) : null;
    if (!r) {
      el.innerHTML = `<div class="pn"><b style="color:var(--faint)">no card yet</b><span>tap read, or search</span></div><span class="pb none">bid</span><span class="pt" data-t="toggle">${LAY === "panel" ? "&#9650; strip" : "&#9660; more"}</span>`;
      wire(el, null, null); return;
    }
    const chip = card.querySelector(".bids .bm b.rounded") || card.querySelector(".bids .bm b");
    const bid = chip ? chip.textContent.trim() : "";
    const m = typeof bestMarket === "function" ? bestMarket(r) : 0;
    const mult = (c) => (typeof condMult === "function" ? condMult(c, r.y, m) : 1);
    const px = m > 0 ? `NM ${money(m)}<br>LP ${money(m * mult("LP"))} · MP ${money(m * mult("MP"))}` : "no market";
    const tag = card.classList.contains("open") ? "open" : card.classList.contains("autosug") ? "best guess" : "top result";
    el.innerHTML = `<div class="pn" title="open this card"><b>${esc(r.n)}</b><span>${esc(r.s)} #${esc(r.num)}${r.lang === "jp" ? " · JP" : ""} · ${tag}</span></div>` +
      `<span class="pb${bid ? "" : " none"}" data-t="bid" title="tap: bid to the clipboard">${bid ? esc(FLASH && FLASH.until > Date.now() ? FLASH.txt : bid) : "bid"}</span>` +
      `<span class="px">${px}</span><span class="pt" data-t="toggle">${LAY === "panel" ? "&#9650;" : "&#9660;"}</span>`;
    wire(el, card, chip);
  }
  function wire(el, card, chip) {
    const nm = el.querySelector(".pn"), pb = el.querySelector(".pb"), pt = el.querySelector(".pt");
    if (nm) nm.onclick = () => { if (card && !card.classList.contains("open")) { const row = card.querySelector(".row"); if (row) row.click(); } layout("panel"); };
    if (pb) pb.onclick = (e) => { e.preventDefault(); if (chip) chip.click(); else layout("panel"); };
    if (pt) pt.onclick = () => layout(LAY === "panel" ? "strip" : "panel");
  }
  function flashBid(r) {
    const txt = r && r.ok ? "Whatnot ✓" : r && r.why === "under" && r.min ? "under $" + r.min : r && r.why === "sold" ? "sold" : "copied";
    FLASH = { txt, until: Date.now() + 2500 }; paintBar(); setTimeout(paintBar, 2600);
  }
  let barTimer = 0;
  const mo = new MutationObserver(() => { clearTimeout(barTimer); barTimer = setTimeout(paintBar, 120); });
  const results = $("#results"); if (results) mo.observe(results, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  // the bid chips flash "copied $3" on the tile; the strip's own button shows the same
  P.dumpNote = function (txt) { const el = bar(); if (el) { const n = el.querySelector(".pn span"); if (n) n.textContent = txt; } };

  // ---------------------------------------------------------------- hello
  function hello() {
    toApp({ type: "cardcomp-ext-ready" });   // the app shows the auto line, asks for state and status, sends bids our way
    state(); status();
    layout("strip");
  }
  // CardComp needs its catalog before results can render; the handshake itself can go at once
  if (document.readyState === "complete") hello(); else window.addEventListener("load", hello);
  loadReader();
  P.ver = VER;
  log("bridge " + VER + " up");
})();
