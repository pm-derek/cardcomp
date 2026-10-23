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
  const VER = "0.3.0";          // bridge version (the app's loader runs the live site's copy when it is newer than its own)
  const PHONE_API = 3;          // the native Bridge this needs (OverlayService.NATIVE_API): img, copy, size, collapse
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
    const c = cfg(), mode = c.mode === "off" ? "off" : "manual";   // no automatic watcher on the phone yet: auto reads as manual
    toApp({ type: "cardcomp-auto-state", on: mode !== "off", mode, model: c.model || "sonnet", hasKey: !!c.hasKey, ver: PROTO });
  }
  function status() {
    const c = cfg();
    toApp({ type: "cardcomp-status-ack", whatnot: !!c.reader, store: !!c.hasToken });
  }

  // ---------------------------------------------------------------- read now: frame from the screen capture -> model -> cardcomp-auto
  let REQ = 0; const PENDING = {}, FRAMES = new Map();
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
    P.lastFrame = img;   // "frame" on the status line shows what was read
    FRAMES.set(String(p.at), { img, box: null, at: Date.now() });   // the picture match ranks this frame (box once the reply names it)
    for (const [k, f] of FRAMES) if (Date.now() - f.at > 5 * 60e3) FRAMES.delete(k);
    const c = cfg(), modelKey = c.model || "sonnet", key = p.at;   // keyed by press time, like the extension's read now
    const head = { type: "cardcomp-auto", key, n: 1, capAt: key, title: "", seller: "", pre: false, manual: true };
    if (!(await loadReader())) { toApp(Object.assign(head, { error: "reader not loaded (extension/recog/recog-read.js)" })); return; }
    let apiKey = ""; try { apiKey = A.key("anthropic") || ""; } catch (_) {}
    if (!apiKey) { toApp(Object.assign(head, { error: "no API key: add it in the CardComp app" })); return; }
    const short = Math.min(w || 0, h || 0);
    const res = await recogRead(img, modelKey, apiKey, (read, ms) =>
      toApp(Object.assign({}, head, { partial: true, read, ms, model: RECOG_MODELS[modelKey] || "", short })));
    if (res.read && Array.isArray(res.read.box)) { const f = FRAMES.get(String(key)); if (f) f.box = res.read.box; }   // before the app asks for the picture match
    toApp(Object.assign({}, head, { read: res.read || null, error: res.error || "", model: res.model || "", ms: res.ms || 0, cost: res.cost || 0, short }));
    log({ read: res.read || null, error: res.error || "", ms: res.ms, cost: res.cost, src: p.src });
    setMode("card", true);   // the compact card shows the best guess; the list is one tap away
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

  // ---------------------------------------------------------------- picture match (extension/recog/imgmatch.js, same as desktop)
  // The read frame is ranked against each candidate's TCGplayer photo; the photos come through the app (Android.img),
  // since the image CDN allows no cross-origin reads from a page. Templates are kept for the session.
  const IMGQ = {}; let IMGN = 0;
  P.img = function (req, data) { const f = IMGQ[req]; delete IMGQ[req]; if (f) f(data || ""); };
  const photo = (url) => new Promise((res) => { const r = "i" + (++IMGN); IMGQ[r] = res; try { A.img(url, r); } catch (_) { delete IMGQ[r]; res(""); } setTimeout(() => { if (IMGQ[r]) { delete IMGQ[r]; res(""); } }, 15000); });
  const TEMPS = new Map();   // photo url -> normalized cells, or null when there is no usable photo
  async function cells(url) {
    if (TEMPS.has(url)) return TEMPS.get(url);
    let t = null;
    const data = await photo(url);
    if (data) { try { t = IM.normalize(IM.cardCells(await IM.load(data, 300))); } catch (_) { t = null; } }
    if (TEMPS.size > 3000) TEMPS.clear();
    TEMPS.set(url, t); return t;
  }
  async function picRank(msg) {
    if (typeof IM === "undefined") return { ok: false, why: "no picture matcher", cands: 0 };
    const f = FRAMES.get(String(msg.key));
    if (!f) return { ok: false, why: "frame gone", cands: 0 };
    const t0 = Date.now();
    if (!f.px) f.px = await IM.load(f.img);
    const cands = (msg.cands || []).slice(0, 80).filter((c) => c && c.id && /^https:\/\/(tcgplayer-cdn\.tcgplayer\.com|images\.pokemontcg\.io)\//.test(c.u || ""));
    const got = [];
    for (let i = 0; i < cands.length; i += 8) got.push(...await Promise.all(cands.slice(i, i + 8).map(async (c) => ({ id: c.id, t: await cells(c.u) }))));
    const temps = got.filter((x) => x.t), dl = Date.now() - t0;
    for (const x of temps) x.same = temps.filter((y) => y === x || IM.sim(x.t, y.t) > 0.995).length;   // one photo under 3+ ids = "image coming soon"
    const usable = temps.filter((x) => x.same < 3);
    if (!usable.length) return { ok: false, why: "no pictures", cands: cands.length };
    const ranked = IM.match(f.px, f.box, usable), v = IM.verdict(ranked, usable);
    log({ pic: v.top, s: v.s, sure: v.sure, pics: usable.length, ms: Date.now() - t0 });
    return { ok: true, ranked: ranked.slice(0, 40), v, box: !!f.box, cands: cands.length, pics: usable.length, ms: Date.now() - t0, dl };
  }

  // ---------------------------------------------------------------- the page's own clipboard and shortcuts, phone versions
  // Copy: the WebView's navigator.clipboard is refused in an unfocused overlay and the page then falls back to focusing a
  // hidden textarea, which would flash the keyboard on every bid. The app copies instead.
  try {
    const cb = navigator.clipboard || {};
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: Object.assign(Object.create(Object.getPrototypeOf(cb) || null), { writeText: (t) => { try { A.copy(String(t)); return Promise.resolve(); } catch (e) { return Promise.reject(e); } }, readText: () => Promise.reject(new Error("no")) }) });
  } catch (_) {}
  // A long press fires "contextmenu", which the desktop maps to "read now" (right-click): on a phone that read cards by accident
  window.addEventListener("contextmenu", (e) => { e.stopImmediatePropagation(); }, true);
  // Taps on the card line count as touching the results (auto-ui then never reorders them under the finger)
  const touched = () => { const r = $("#results"); if (r) r.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); };

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
        if (MODE === "list") setTimeout(() => { if (MODE === "list") setMode("card"); }, 900);
        break;
      }
      case "cardcomp-open-bg": A.open(String(d.url || "")); break;   // TCGplayer links open in the browser over Whatnot
      case "cardcomp-auto-img": picRank(d).then((r) => toApp(Object.assign({ type: "cardcomp-auto-img-ack" }, r, { key: d.key, n: d.n || 1 })),
        (e) => toApp({ type: "cardcomp-auto-img-ack", key: d.key, n: d.n || 1, cands: 0, ok: false, why: e.message })); break;
      case "cardcomp-tcg-fast":   // no TCGplayer reader on the phone: the link opened in the browser, the price is read there by eye
        setTimeout(() => { try { if (typeof liveNote === "function") liveNote("opened on TCGplayer in your browser: check the price there, then come back"); } catch (_) {} }, 0);
        break;
      case "cardcomp-snapshot": toApp({ type: "cardcomp-snapshot-ack", ok: false, why: "not on the phone yet" }); break;
      case "cardcomp-live-test": toApp({ type: "cardcomp-live-test-ack", ok: false, why: "not on the phone yet" }); break;
      default: log({ unhandled: d.type });   // log / live store: phase 1
    }
  }

  // ---------------------------------------------------------------- modes
  // card   = the compact floating card: name, bid, NM / LP / MP, what was read (default, and after every read)
  // list   = search box, results and the open card's condition grid (tap the name, ▾ or the status line)
  // typing = list while the search box has focus (the panel moves to the top so the keyboard does not cover it)
  // The panel is as tall as what it shows (Android.size): no dead space, and it is dragged wherever the stream allows.
  let MODE = "card", MODE_BEFORE_TYPING = "card";
  function setMode(m, show) {
    if (m !== "card" && m !== "list" && m !== "typing") return;
    const changed = m !== MODE; MODE = m;
    document.body.classList.remove("ph-card", "ph-list", "ph-typing"); document.body.classList.add("ph-" + m);
    if (changed || show) { try { A.layout(m); } catch (_) {} }
    if (m === "card") window.scrollTo(0, 0);
    if (m === "list") setTimeout(() => { const o = $("#results .card.open"); if (o) o.scrollIntoView({ block: "start" }); }, 60);
    paintBar(); sizeSoon();
  }
  P.setMode = setMode; P.mode = () => MODE;
  P.back = function () {   // Android Back inside the panel
    if (MODE === "typing") P.blur();
    else if (MODE === "list") setMode("card");
    else { try { A.collapse(); } catch (_) {} }
  };

  // keyboard: the window is focusable only while a text field has focus (native drops it on any touch outside)
  const isField = (t) => !!(t && t.closest && t.closest("input:not([type=checkbox]):not([type=radio]),textarea,select,[contenteditable]")) &&
    getComputedStyle(t).opacity !== "0";   // the page's copy fallback focuses an invisible textarea: no keyboard for that
  document.addEventListener("focusin", (e) => {
    if (!isField(e.target)) return;
    try { A.focus(true); } catch (_) {}
    if (e.target.id === "q" && MODE !== "typing") { MODE_BEFORE_TYPING = MODE; setMode("typing"); }
  }, true);
  document.addEventListener("focusout", (e) => {
    if (!isField(e.target)) return;
    setTimeout(() => {
      if (isField(document.activeElement)) return;
      try { A.focus(false); } catch (_) {}
      if (MODE === "typing") setMode(($("#q") && $("#q").value.trim()) ? "list" : MODE_BEFORE_TYPING === "typing" ? "card" : MODE_BEFORE_TYPING);
    }, 150);
  }, true);
  P.blur = function () { try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (_) {} };

  // height: what the page shows, reported to the native panel (it caps it at 62% of the screen; the list scrolls inside)
  let sizeT = 0, lastH = 0;
  function sizeSoon() { clearTimeout(sizeT); sizeT = setTimeout(sizeNow, 60); }
  function sizeNow() {
    const w = $(".wrap"), h = Math.ceil((w || document.body).getBoundingClientRect().height);
    if (Math.abs(h - lastH) < 2) return;
    lastH = h; try { A.size(h); } catch (_) {}
  }
  P.sizeNow = () => { lastH = 0; sizeNow(); };

  const css = document.createElement("style");
  css.textContent =
    "html,body{min-height:0!important;height:auto!important}body.phone{padding:0}body.phone .wrap{padding:2px 8px 4px}body.ph-list .wrap,body.ph-typing .wrap{padding-bottom:12px}" +
    "body.phone h1,body.phone #gear,body.phone #settings,body.phone #filterbar,body.phone #filterwrap,body.phone #stale,body.phone #wnstat,body.phone #cart,body.phone #readbig{display:none!important}" +
    "body.phone .searchrow{position:static!important;padding:4px 0;gap:4px}body.phone #q{padding:9px 10px;font-size:15px}body.phone #langbtn{padding:6px 8px;min-width:40px}" +
    "body.phone #lotstrip{padding:3px 7px;font-size:11.5px}" +
    "body.phone #automodes,body.phone #automodel,body.phone #gamesel,body.phone select{display:none!important}" +
    "body.phone #autoline{padding:2px 6px;font-size:11px;display:-webkit-box!important;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}body.phone #autoline.full{-webkit-line-clamp:unset}" +
    // card: only the card line and the status line (plus the lot strip when phase 1 feeds it)
    "body.ph-card{overflow:hidden}body.ph-card .searchrow>*:not(#phonecard):not(#lotstrip){display:none!important}" +
    "body.ph-card .searchrow~*,body.ph-card #autoline{display:none!important}" +
    "body.ph-list #phonestat,body.ph-typing #phonestat{display:none}body.ph-typing #read,body.ph-typing #status,body.ph-typing #autoline{display:none!important}" +
    "#phonecard{font-family:'JetBrains Mono',monospace}" +
    "#phonebar{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;padding:2px 0;font-size:12px;line-height:1.25}" +
    "#phonebar .pnw{flex:1 1 150px;min-width:0;display:flex;align-items:center;gap:4px}" +
    "#phonebar .pn{flex:1;min-width:0;overflow:hidden;cursor:pointer}#phonebar .pn b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink);font-size:13px}" +
    "#phonebar .pn span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dim);font-size:10.5px}" +
    "#phonebar .st{flex:none;border:1px solid var(--line);color:var(--ink);border-radius:6px;min-width:30px;height:30px;font-size:15px;display:flex;align-items:center;justify-content:center}" +
    "#phonebar .sn{flex:none;color:var(--faint);font-size:10.5px;min-width:30px;text-align:center}" +
    "#phonebar .pr{flex:1 0 auto;display:flex;align-items:center;gap:6px;justify-content:flex-end}" +
    "#phonebar .pb{flex:none;border:2px solid var(--gold);background:rgba(245,179,1,.14);color:var(--gold);border-radius:8px;padding:6px 10px;font-weight:700;font-size:17px;min-width:62px;text-align:center}" +
    "#phonebar .pb.none{border-color:var(--line);color:var(--faint);background:none;font-size:13px}#phonebar .px{flex:none;color:var(--dim);font-size:10.5px;line-height:1.25;text-align:right;white-space:nowrap}" +
    "#phonebar .pt{flex:none;border:1px solid var(--line);color:var(--dim);border-radius:6px;min-width:34px;height:32px;font-size:14px;display:flex;align-items:center;justify-content:center}" +
    "body.ph-list #phonebar .pt.tg,body.ph-typing #phonebar .pt.tg{color:var(--gold);border-color:var(--gold)}" +
    "#phonestat{font-size:11px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:1px 0 2px;cursor:pointer}#phonestat:empty{display:none}#phonestat a{color:var(--blue)}#phonestat .bad{color:var(--red)}";
  document.head.appendChild(css);
  document.body.classList.add("phone");
  document.addEventListener("click", (e) => { const a = e.target && e.target.closest && e.target.closest("#autoline"); if (a && !e.target.closest("a,select,.modes,.rn")) { a.classList.toggle("full"); sizeSoon(); } });

  // ---------------------------------------------------------------- the card line: name (‹ › through the candidates), the max bid, NM / LP / MP
  // The card shown: the open card, else the one stepped to, else the best guess of the last reading, else the top result
  // of a typed search (never the default list). The bid button taps that card's own bid chip, so copyAmt, the lot label
  // and the log see the same tap as a tap on the tile.
  let wrapEl = null, FLASH = null, CUR = -1;
  function wrap() {
    if (wrapEl && wrapEl.isConnected) return wrapEl;
    const sr = $(".searchrow"); if (!sr) return null;
    wrapEl = document.createElement("div"); wrapEl.id = "phonecard";
    wrapEl.innerHTML = '<div id="phonebar"></div><div id="phonestat"></div>';
    sr.insertBefore(wrapEl, sr.firstChild);
    wrapEl.querySelector("#phonestat").onclick = (e) => {
      if (e.target.closest("a.fr")) { e.preventDefault(); if (P.lastFrame && typeof zoom === "function") { setMode("list"); zoom(P.lastFrame); } return; }
      setMode("list");
    };
    return wrapEl;
  }
  const money = (v) => "$" + (v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2));
  const cands = () => Array.from(document.querySelectorAll("#results .card")).slice(0, 16);
  function focusCard() {
    const open = $("#results .card.open"); if (open) return open;
    const list = cands();
    if (CUR >= 0 && list[CUR]) return list[CUR];
    const q = $("#q"), typed = q && q.value.trim();
    return $("#results .card.autosug") || (typed ? list[0] : null);
  }
  function paintBar() {
    const w = wrap(); if (!w) return;
    const el = w.querySelector("#phonebar");
    const card = focusCard(), id = card && card.dataset.id, r = id && typeof CARDS !== "undefined" ? CARDS.find((x) => x.id === id) : null;
    const tg = `<span class="pt tg" data-t="toggle" title="results and the condition grid">${MODE === "card" ? "&#9662;" : "&#9652;"}</span>`;
    const srch = '<span class="pt" data-t="search" title="search">&#128269;</span>';
    if (!r) {
      el.innerHTML = `<div class="pnw"><div class="pn"><b style="color:var(--faint)">no card yet</b><span>tap the gold read bubble, or search</span></div></div><div class="pr">${srch}${tg}</div>`;
      wire(el, null, null); paintStat(); sizeSoon(); return;
    }
    const list = cands(), i = list.indexOf(card), n = list.length, step = !card.classList.contains("open") && n > 1 && i >= 0;
    const chip = card.querySelector(".bids .bm b.rounded") || card.querySelector(".bids .bm b");
    const bid = chip ? chip.textContent.trim() : "";
    const m = typeof bestMarket === "function" ? bestMarket(r) : 0;
    const mult = (c) => (typeof condMult === "function" ? condMult(c, r.y, m) : 1);
    const px = m > 0 ? `NM ${money(m)}<br>LP ${money(m * mult("LP"))} · MP ${money(m * mult("MP"))}` : "no market";
    const tag = card.classList.contains("open") ? "open" : card.classList.contains("autosug") ? "best guess" : i === 0 ? "top result" : "";
    el.innerHTML = `<div class="pnw">${step ? '<span class="st" data-t="prev">&#8249;</span>' : ""}` +
      `<div class="pn" title="open: condition grid"><b>${esc(r.n)}</b><span>${esc(r.s)} #${esc(r.num)}${(r.lang || "en") === "jp" ? " · JP" : ""}${tag ? " · " + tag : ""}</span></div>` +
      (step ? `<span class="sn">${i + 1}/${n}</span><span class="st" data-t="next">&#8250;</span>` : "") + `</div>` +
      `<div class="pr"><span class="pb${bid ? "" : " none"}" data-t="bid" title="tap: bid to the clipboard">${bid ? esc(FLASH && FLASH.until > Date.now() ? FLASH.txt : bid) : "bid"}</span>` +
      `<span class="px">${px}</span>${srch}${tg}</div>`;
    wire(el, card, chip); paintStat(); sizeSoon();
  }
  function wire(el, card, chip) {
    const on = (t, f) => { const x = el.querySelector(`[data-t="${t}"]`); if (x) x.onclick = (e) => { e.preventDefault(); e.stopPropagation(); f(); }; };
    const nm = el.querySelector(".pn");
    if (nm) nm.onclick = () => { if (card && !card.classList.contains("open")) { const row = card.querySelector(".row"); if (row) row.click(); } setMode("list"); };
    on("bid", () => { touched(); if (chip) chip.click(); else setMode("list"); });
    on("toggle", () => setMode(MODE === "card" ? "list" : "card"));
    on("search", () => { setMode("list"); const q = $("#q"); if (q) { q.focus(); q.select(); } });
    const n = cands().length, i = cands().indexOf(card);
    on("prev", () => { touched(); CUR = (i - 1 + n) % n; paintBar(); });
    on("next", () => { touched(); CUR = (i + 1) % n; paintBar(); });
  }
  // status line under the card: what was read and how sure ("read Ralts · reverse holo → 3 of 27, no number"), and the frame
  function paintStat() {
    const w = wrap(); if (!w) return;
    const st = w.querySelector("#phonestat"), am = $("#automsg");
    let t = am ? am.textContent.replace(/\s+/g, " ").trim() : "";
    t = t.replace(/^read now: /, "").replace(/^press read.*$/, "").replace(/^waiting for the next lot$/, "");
    const b0 = am && am.querySelector(".bad"), bad = b0 && b0.textContent.trim() === am.textContent.trim();   // red only when the whole line is an error
    const html = t ? (bad ? `<span class="bad">${esc(t)}</span>` : esc(t)) + (P.lastFrame ? ' · <a class="fr" href="#">frame</a>' : "") : "";
    if (st.innerHTML !== html) st.innerHTML = html;   // only on change: this runs from a body observer
  }
  function flashBid(r) {
    const txt = r && r.ok ? "Whatnot ✓" : r && r.why === "under" && r.min ? "under $" + r.min : r && r.why === "sold" ? "sold" : "copied";
    FLASH = { txt, until: Date.now() + 2500 }; paintBar(); setTimeout(paintBar, 2600);
  }
  let barTimer = 0;
  const results = $("#results");
  const mo = new MutationObserver((recs) => {
    if (recs.some((x) => x.type === "childList" && x.target === results)) CUR = -1;   // new results: back to the best guess
    clearTimeout(barTimer); barTimer = setTimeout(paintBar, 120);
  });
  if (results) mo.observe(results, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  let statT = 0;
  new MutationObserver(() => { clearTimeout(statT); statT = setTimeout(() => { paintStat(); sizeSoon(); }, 80); })
    .observe(document.body, { childList: true, subtree: true, characterData: true });
  P.dumpNote = function (txt) { const w = wrap(); if (w) { const st = w.querySelector("#phonestat"); st.textContent = txt; sizeSoon(); } };

  // ---------------------------------------------------------------- hello
  function hello() {
    toApp({ type: "cardcomp-ext-ready" });   // the app shows the auto line, asks for state and status, sends bids our way
    state(); status();
    setMode("card", true);
  }
  // CardComp needs its catalog before results can render; the handshake itself can go at once
  if (document.readyState === "complete") hello(); else window.addEventListener("load", hello);
  loadReader();
  P.ver = VER;
  log("bridge " + VER + " up");
})();
