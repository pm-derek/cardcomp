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
  const VER = "0.4.0";          // bridge version (the app's loader runs the live site's copy when it is newer than its own)
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
  // The panel window is never focusable on its own (it would take the keyboard and Back from Whatnot): touching a text
  // field asks for focus first. Chromium may hold focus events until the window has focus, so this goes on pointerdown.
  document.addEventListener("pointerdown", (e) => { if (isField(e.target)) { try { A.focus(true); } catch (_) {} } }, true);
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
    "body.ph-card .searchrow{padding-bottom:0!important}body.ph-card{overflow:hidden}body.ph-card .searchrow>*:not(#phonecard):not(#lotstrip){display:none!important}" +
    "body.ph-card .searchrow~*,body.ph-card #autoline{display:none!important}" +
    "body.ph-list #phonestat,body.ph-typing #phonestat{display:none}body.ph-typing #read,body.ph-typing #status,body.ph-typing #autoline{display:none!important}" +
    "#phonecard{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:var(--ink)}" +
    "#phonebar .pc{display:flex;gap:10px;align-items:flex-start;padding:4px 0 2px}" +
    "#phonebar .pleft{flex:none;width:86px}#phonebar .pleft .ptools{display:flex;gap:6px;margin-top:6px}#phonebar .pleft .pt{flex:1;min-width:0}" +
    "#phonebar .pimg{width:86px;height:120px;border-radius:6px;overflow:hidden;background:var(--panel2);cursor:pointer}" +
    "#phonebar .pimg img{width:100%;height:100%;object-fit:contain;display:block}" +
    "#phonebar .pmain{flex:1;min-width:0}" +
    "#phonebar .ph{display:flex;align-items:flex-start;gap:6px}" +
    "#phonebar .pn{flex:1;min-width:0;cursor:pointer}" +
    "#phonebar .pn b{display:block;font-size:16px;font-weight:700;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    "#phonebar .pn span{display:block;font-size:12px;color:var(--dim);line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    "#phonebar .pn .pp{color:var(--faint);font-size:11px}#phonebar .pn .pp i{font-style:normal;color:var(--gold);margin-left:6px}" +
    "#phonebar .pstep{flex:none;display:flex;align-items:center;gap:2px}" +
    "#phonebar .st{border:1px solid var(--line);border-radius:7px;width:30px;height:30px;font-size:18px;display:flex;align-items:center;justify-content:center;color:var(--ink)}" +
    "#phonebar .sn{font-size:11px;color:var(--faint);min-width:28px;text-align:center;line-height:1.15}#phonebar .sn i{display:block;font-style:normal;color:var(--gold);font-size:10px;white-space:nowrap}" +
    "#phonebar .ptab{margin-top:4px}#phonebar .pth{display:flex;font-size:10px;color:var(--faint);padding-bottom:2px;border-bottom:1px solid var(--line)}" +
    "#phonebar .pth span:nth-child(1){width:34px}#phonebar .pth span:nth-child(2){flex:1;text-align:right;padding-right:10px}#phonebar .pth span:nth-child(3){min-width:58px;text-align:right}" +
    "#phonebar .pr{display:flex;align-items:center;height:30px;border-bottom:1px solid var(--line)}" +
    "#phonebar .pc1{width:34px;font-weight:700;font-size:13px}" +
    "#phonebar .pm{flex:1;text-align:right;font-size:14px;font-variant-numeric:tabular-nums;padding-right:10px}" +
    "#phonebar .pb{min-width:64px;text-align:center;font-weight:800;font-size:15px;color:var(--gold);border:1.5px solid var(--gold);border-radius:7px;padding:2px 8px;background:rgba(245,179,1,.12);font-variant-numeric:tabular-nums}" +
    "#phonebar .pb.wait{opacity:.55}#phonebar .pb.fl{color:#000;background:var(--green);border-color:var(--green);font-size:12px}" +
    "#phonebar .pfoot{display:flex;align-items:center;gap:6px;margin-top:4px}#phonebar .pfl{flex:1;font-size:10.5px;color:var(--faint)}" +
    "#phonebar .pt{flex:none;border:1px solid var(--line);color:var(--dim);border-radius:7px;min-width:36px;height:30px;font-size:14px;display:flex;align-items:center;justify-content:center}" +
    "body.ph-list #phonebar .pt.tg,body.ph-typing #phonebar .pt.tg{color:var(--gold);border-color:var(--gold)}" +
    "#phonebar .pe{display:flex;align-items:center;gap:8px;padding:6px 0}#phonebar .pe>div:first-child{flex:1;min-width:0}" +
    "#phonebar .pe b{font-size:14px}#phonebar .pe span{display:block;font-size:12px;color:var(--dim);line-height:1.35}#phonebar .ptools{display:flex;gap:6px}" +
    "#phonestat{font-size:11.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:1px 0 2px;cursor:pointer}#phonestat:empty{display:none}#phonestat a{color:var(--blue)}#phonestat .bad{color:var(--red)}";
  document.head.appendChild(css);
  document.body.classList.add("phone");
  document.addEventListener("click", (e) => { const a = e.target && e.target.closest && e.target.closest("#autoline"); if (a && !e.target.closest("a,select,.modes,.rn")) { a.classList.toggle("full"); sizeSoon(); } });

  // ---------------------------------------------------------------- the compact card (Derek, 2026-10-23: "show me the card picture", PalletTrade's layout)
  // Picture on the left; name, set and number; a table of NM / LP / MP / HP with the price bids use and the max bid as
  // a button. The card shown: the one stepped to with ‹ ›, else the open card, else the best guess of the last
  // reading, else the top result of a typed search (never the default list). The rows mirror that card's real
  // condition grid: the card is opened in the (hidden) results, and each bid button taps the grid's own button, so the
  // numbers, the cascade from verified prices, the lot label and the log are the same as in the full view.
  let wrapEl = null, FLASH = null, CUR = -1, OPENED = null;
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
  const money = (v) => "$" + (v >= 1000 ? Math.round(v).toLocaleString("en-US") : v.toFixed(2));
  const cands = () => Array.from(document.querySelectorAll("#results .card")).slice(0, 16);
  function focusCard() {
    const list = cands();
    if (CUR >= 0 && list[CUR]) return list[CUR];
    const open = $("#results .card.open"); if (open) return open;
    const q = $("#q"), typed = q && q.value.trim();
    return $("#results .card.autosug") || (typed ? list[0] : null);
  }
  // open the shown card in the hidden results so its condition grid exists; close the one this view opened before
  function ensureOpen(card) {
    if (OPENED && OPENED !== card && OPENED.isConnected && OPENED.classList.contains("open")) { const r = OPENED.querySelector(".row"); if (r) r.click(); }
    OPENED = null;
    if (card && !card.classList.contains("open")) { const r = card.querySelector(".row"); if (r) { r.click(); OPENED = card; } }
  }
  const SHOW = ["NM", "LP", "MP", "HP"];
  function paintBar() {
    const w = wrap(); if (!w) return;
    const el = w.querySelector("#phonebar");
    const tools = `<span class="pt" data-t="search" title="search">&#128269;</span><span class="pt tg" data-t="toggle" title="results and the full condition grid">${MODE === "card" ? "&#9662;" : "&#9652;"}</span>`;
    const card = focusCard(), id = card && card.dataset.id, r = id && typeof CARDS !== "undefined" ? CARDS.find((x) => x.id === id) : null;
    if (!r) {
      const html = `<div class="pe"><div><b>No card yet</b><span>Tap the gold <b>read</b> bubble when a card is on screen, or search.</span></div><div class="ptools">${tools}</div></div>`;
      if (el.innerHTML !== html) { el.innerHTML = html; wire(el, null); }
      paintStat(); sizeSoon(); return;
    }
    if (MODE === "card" || !card.classList.contains("open")) ensureOpen(card);
    const list = cands(), i = list.indexOf(card), n = list.length;
    const grid = card.querySelector(".condgrid");
    const btns = grid ? Array.from(grid.querySelectorAll(".bd.cpy[data-cond]")) : [];
    const pk = card.querySelector(".pchip.on"), printing = pk ? (typeof prettyPrinting === "function" ? prettyPrinting(pk.dataset.k) : pk.dataset.k) : "";
    let rows;
    if (btns.length) {
      const whole = (t) => { const v = Math.floor(parseFloat(String(t).replace(/[^0-9.]/g, "")) || 0); return v >= 1 ? "$" + v : "<$1"; };   // what copyAmt copies
      rows = SHOW.map((c) => { const b = btns.find((x) => x.dataset.cond === c); return b ? { c, mkt: +b.dataset.mkt || 0, bid: whole(b.dataset.bid || b.textContent), b } : null; }).filter(Boolean);
    } else {   // grid still loading: NM from the tile, the others from the usual condition shares
      const m = typeof bestMarket === "function" ? bestMarket(r) : 0, chip = card.querySelector(".bids .bm b.rounded");
      rows = SHOW.map((c) => ({ c, mkt: m * (typeof condMult === "function" ? condMult(c, r.y, m) : 1), bid: c === "NM" && chip ? chip.textContent.trim() : "…", b: null }));
    }
    const tag = card.classList.contains("autosug") ? (card.classList.contains("byboth") ? "auto + picture" : card.classList.contains("bypic") ? "picture" : "best guess") : "";
    const img = typeof imgOf === "function" ? imgOf(r) : "";
    const col = (c) => (typeof COND_COLORS !== "undefined" && COND_COLORS[c]) || "var(--ink)";
    const flash = (c) => FLASH && FLASH.until > Date.now() && FLASH.cond === c ? FLASH.txt : null;
    const html =
      `<div class="pc">` +
        `<div class="pleft"><div class="pimg" data-t="open">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : ""}</div><div class="ptools">${tools}</div></div>` +
        `<div class="pmain">` +
          `<div class="ph"><div class="pn" data-t="open"><b>${esc(r.n)}</b><span>${esc(r.s)} · #${esc(r.num)}${(r.lang || "en") === "jp" ? " · JP" : ""}${printing ? " · " + esc(printing) : ""}</span></div>` +
            (n > 1 && i >= 0 ? `<div class="pstep"><span class="st" data-t="prev">&#8249;</span><span class="sn">${tag ? `<i>${esc(tag)}</i>` : ""}${i + 1}/${n}</span><span class="st" data-t="next">&#8250;</span></div>`
              : tag ? `<div class="pstep"><span class="sn"><i>${esc(tag)}</i></span></div>` : "") +
          `</div>` +
          `<div class="ptab"><div class="pth"><span>cond</span><span>price</span><span>max bid · tap copies</span></div>` + rows.map((x) =>
            `<div class="pr"><span class="pc1" style="color:${col(x.c)}">${x.c}</span><span class="pm">${x.mkt > 0 ? money(x.mkt) : "–"}</span>` +
            `<span class="pb${x.b ? "" : " wait"}${flash(x.c) ? " fl" : ""}" data-t="bid" data-c="${x.c}">${esc(flash(x.c) || x.bid)}</span></div>`).join("") +
          `</div>` +
        `</div>` +
      `</div>`;
    if (el.innerHTML !== html) { el.innerHTML = html; wire(el, card); }
    paintStat(); sizeSoon();
  }
  function wire(el, card) {
    const on = (t, f) => el.querySelectorAll(`[data-t="${t}"]`).forEach((x) => { x.onclick = (e) => { e.preventDefault(); e.stopPropagation(); f(x); }; });
    on("open", () => { OPENED = null; setMode("list"); });   // keep it open: Derek wants the full grid
    on("bid", (x) => {
      touched();
      const b = card && card.querySelector(`.condgrid .bd.cpy[data-cond="${x.dataset.c}"]`);
      if (b) b.click(); else setMode("list");
    });
    on("toggle", () => setMode(MODE === "card" ? "list" : "card"));
    on("search", () => { setMode("list"); const q = $("#q"); if (q) { q.focus(); q.select(); } });
    const list = cands(), i = list.indexOf(card), n = list.length;
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
    const txt = r && r.ok ? "Whatnot ✓" : r && r.why === "under" && r.min ? "under $" + r.min : r && r.why === "sold" ? "sold" : "copied ✓";
    FLASH = { txt, cond: (typeof LAST_TAP !== "undefined" && LAST_TAP && LAST_TAP.cond) || "NM", until: Date.now() + 2500 }; paintBar(); setTimeout(paintBar, 2600);
  }
  let barTimer = 0;
  const results = $("#results");
  const mo = new MutationObserver((recs) => {
    if (recs.some((x) => x.type === "childList" && x.target === results)) { CUR = -1; OPENED = null; }   // new results: back to the best guess
    clearTimeout(barTimer); barTimer = setTimeout(paintBar, 120);
  });
  if (results) mo.observe(results, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  let statT = 0;
  new MutationObserver(() => { clearTimeout(statT); statT = setTimeout(() => { paintStat(); sizeSoon(); }, 80); })
    .observe(document.body, { childList: true, subtree: true, characterData: true });
  P.dumpNote = function (txt) { const w = wrap(); if (w) { const st = w.querySelector("#phonestat"); st.textContent = txt; sizeSoon(); } };

  // ---------------------------------------------------------------- hello
  function hello() {
    try { const q = $("#q"); if (q && document.activeElement === q) q.blur(); } catch (_) {}   // the page focuses the box at load: no keyboard until Derek taps it
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
