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
  const VER = "0.15.4";          // bridge version (the app's loader runs the live site's copy when it is newer than its own)
  const PHONE_API = 6;          // the native Bridge this needs (OverlayService.NATIVE_API): img, copy, size, collapse
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
    const c = cfg(), mode = c.mode === "off" ? "off" : c.mode === "auto" ? "auto" : "manual";   // auto = a read when each lot's timer starts (setup screen)
    toApp({ type: "cardcomp-auto-state", on: mode !== "off", mode, model: c.model || "sonnet", hasKey: !!c.hasKey, ver: PROTO });
  }
  function status() {
    const c = cfg();
    toApp({ type: "cardcomp-status-ack", whatnot: !!c.reader, store: !!c.hasToken });
  }

  // ---------------------------------------------------------------- read now: frame from the screen capture -> model -> cardcomp-auto
  let REQ = 0; const PENDING = {}, FRAMES = new Map();
  // One read at a time (Derek, 2026-10-29: "I need clearer feedback when a search is happening, sometimes I tap too many
  // times"): while a read runs the small card dims under a gold "reading the card" bar with a timer, the app's bubble
  // pulses (A.reading, APK 0.14+), and another tap only says "still reading". 25 s at most, in case a reply never comes.
  let READING = null;   // {at, phase: "frame" | "model" | "partial", what}
  let STILL = 0;        // until when the bar says "still reading"
  const readBusy = () => !!READING && Date.now() - READING.at < 25000;
  function readState(on, phase, what) {
    if (on && !READING) window.ZH_LAST = null;   // a new read: the last Chinese card's view goes
    if (on) READING = Object.assign(READING || { at: Date.now() }, { phase: phase || "frame" }, what ? { what } : {});
    else READING = null;
    try { if (typeof A.reading === "function") A.reading(!!on); } catch (_) {}
    paintReading();
  }
  P.stillReading = function () { STILL = Date.now() + 1800; paintReading(); };
  let readTick = 0;
  function paintReading() {
    const w = wrap(); if (!w) return;
    const el = w.querySelector("#phoneread"), on = readBusy();
    w.classList.toggle("reading", on);
    w.classList.toggle("partial", on && READING.phase === "partial");   // likely cards are listed: usable while the rest streams
    if (!on) { if (READING) READING = null; el.className = ""; el.innerHTML = ""; clearInterval(readTick); readTick = 0; sizeSoon(); return; }
    const secs = ((Date.now() - READING.at) / 1000).toFixed(1);
    const txt = READING.phase === "partial" && READING.what ? `found ${READING.what}, checking the rest` : READING.phase === "model" ? "reading the card" : "taking the picture";
    const html = STILL > Date.now() ? `<span class="sp"></span><b class="still">still reading, one tap is enough</b><span class="sec">${secs}s</span>`
      : `<span class="sp"></span><b>${esc(txt)}…</b><span class="sec">${secs}s</span>`;
    el.className = "on" + (STILL > Date.now() ? " still" : "");
    if (el.innerHTML !== html) el.innerHTML = html;
    if (!readTick) { readTick = setInterval(paintReading, 200); sizeSoon(); }
  }
  P.readNow = function (src) {
    if (readBusy()) { P.stillReading(); return; }
    const c = cfg();
    if (c.mode === "off") { toApp({ type: "cardcomp-auto-readack", ok: false, why: "auto is off" }); return; }
    if (!c.hasKey) { toApp({ type: "cardcomp-auto-readack", ok: false, why: "no API key: add it in the CardComp app" }); return; }
    const req = String(++REQ);
    PENDING[req] = { at: Date.now(), src: src || "app" };
    readState(true, "frame");
    let r = ""; try { r = A.grab(req); } catch (e) { r = "error: " + e.message; }
    if (r && r !== "ok") { delete PENDING[req]; readState(false); toApp({ type: "cardcomp-auto-readack", ok: false, why: r }); }
  };
  P.frame = function (req, img, w, h) {
    const p = PENDING[req]; delete PENDING[req]; if (!p) return;
    readState(true, "model");
    runRead(img, w, h, p).catch((e) => log("read: " + e.message)).finally(() => readState(false));
  };
  P.frameFail = function (req, why) { delete PENDING[req]; readState(false); toApp({ type: "cardcomp-auto-readack", ok: false, why: why || "no frame" }); };

  // ---------------------------------------------------------------- read journal (Derek, 2026-10-29: "the last few scans
  // on Latios were terrible, take a look", and nothing of them was kept: a read reaches the auction log only as the last
  // read of a lot that got logged). Every read is saved ~25 s later (or when the next read starts) to the private repo:
  // phone-reads/YYYY-MM-DD/HHMMSS-name.json with a 480 px picture of the frame, what the model read (and the zoomed
  // re-read), what CardComp suggested and listed, the picture match, the card on the small card and the last bid tapped.
  // Needs the GitHub token (same as the log). One file per read: nothing is read back or rewritten.
  let JOURNAL = null;
  function journalStart(p, img) {
    journalFlush();
    const e = JOURNAL = { v: 1, at: p.at, src: p.src, seller: SELLER || "", lot: lot ? lot.title : "", frame: "" };
    const im = new Image();
    im.onload = () => { try { const sc = Math.min(1, 480 / Math.max(im.naturalWidth, im.naturalHeight)), c = document.createElement("canvas"); c.width = Math.round(im.naturalWidth * sc); c.height = Math.round(im.naturalHeight * sc); c.getContext("2d").drawImage(im, 0, 0, c.width, c.height); e.frame = c.toDataURL("image/jpeg", 0.7); } catch (_) {} };
    im.src = img;
    clearTimeout(e.timer); e.timer = setTimeout(() => { if (JOURNAL === e) journalFlush(); }, 25000);
  }
  function journalFlush() {
    const e = JOURNAL; JOURNAL = null; if (!e || e.done) return; e.done = true; clearTimeout(e.timer); delete e.timer; delete e.done;
    try {
      if (e.read && e.read.name && typeof window.autoMatch === "function") {
        const m = window.autoMatch(e.read, { short: e.short || 0, model: e.model || "" });
        e.match = { kind: m.kind, strength: m.strength || null, sug: m.suggestion || null, printing: m.printing || "", note: m.note || "", ids: (m.cards || []).slice(0, 12).map((c) => c.id), pool: (m.pool || []).length };
      }
      const fc = typeof focusCard === "function" ? focusCard() : null;
      e.shown = fc ? fc.dataset.id : null;
      e.picked = typeof PICKED !== "undefined" ? !!PICKED : null;
      if (typeof LAST_TAP !== "undefined" && LAST_TAP && LAST_TAP.at >= e.at) e.tapped = { id: LAST_TAP.id || "", n: LAST_TAP.n || "", cond: LAST_TAP.cond || "", bid: LAST_TAP.bid };
      if (window.ZH_LAST && window.ZH_LAST.at >= e.at) e.zh = { ids: window.ZH_LAST.ids, pick: ZH_PICK || null };
    } catch (_) {}
    let tok = ""; try { tok = A.key("github") || ""; } catch (_) {}
    if (!tok) return;
    const d = new Date(e.at), pad = (n) => String(n).padStart(2, "0");
    const name = ((e.read && e.read.name) || e.err || "none").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30).replace(/^-|-$/g, "");
    const path = `phone-reads/${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}/${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${name || "read"}.json`;
    const body = JSON.stringify({ message: "phone read " + (e.read && e.read.name || ""), content: btoa(unescape(encodeURIComponent(JSON.stringify(e)))) });
    fetch("https://api.github.com/repos/pm-derek/cardcomp-data/contents/" + path, { method: "PUT", headers: { Authorization: "Bearer " + tok, Accept: "application/vnd.github+json", "Content-Type": "application/json" }, body })
      .then((r) => { if (!r.ok) log("read journal: " + r.status); }, (er) => log("read journal: " + er.message));
  }
  P.journalNow = journalFlush;   // tests

  async function runRead(img, w, h, p) {
    journalStart(p, img);
    const je = JOURNAL; je.fkey = String(p.src === "auto" && lot ? lot.startedAt : p.at);
    P.lastFrame = img;   // "frame" on the status line shows what was read
    const fr0 = { img, box: null, at: Date.now() };
    FRAMES.set(String(p.src === "auto" && lot ? lot.startedAt : p.at), fr0);   // the picture match ranks this frame (box once the reply names it)
    for (const [k, f] of FRAMES) if (Date.now() - f.at > 5 * 60e3) FRAMES.delete(k);
    const c = cfg(), modelKey = c.model || "sonnet", key = p.at;   // keyed by press time, like the extension's read now
    const auto = p.src === "auto", lk = auto && lot ? lot.startedAt : key;   // an automatic read belongs to its lot (auto-ui keys readings by lot)
    const head = { type: "cardcomp-auto", key: lk, n: 1, capAt: key, title: auto && lot ? lot.title : "", seller: auto ? SELLER : "", pre: false, manual: !auto };
    if (!(await loadReader())) { toApp(Object.assign(head, { error: "reader not loaded (extension/recog/recog-read.js)" })); return; }
    if (typeof IM !== "undefined" && !fr0.pxP) fr0.pxP = IM.load(img).then((px) => (fr0.px = px), () => null);   // decode the frame for the picture match while the model reads
    let apiKey = ""; try { apiKey = A.key("anthropic") || ""; } catch (_) {}
    if (!apiKey) { toApp(Object.assign(head, { error: "no API key: add it in the CardComp app" })); return; }
    const short = Math.min(w || 0, h || 0);
    const res = await recogRead(img, modelKey, apiKey, (read, ms) => {
      if (read && read.name) { readState(true, "partial", read.name + (read.number ? " " + read.number + (read.total ? "/" + read.total : "") : "")); warmPhotos(read); }
      toApp(Object.assign({}, head, { partial: true, read, ms, model: RECOG_MODELS[modelKey] || "", short }));
    });
    if (res.read && Array.isArray(res.read.box)) { const f = FRAMES.get(String(lk)); if (f) f.box = res.read.box; }   // before the app asks for the picture match
    toApp(Object.assign({}, head, { read: res.read || null, error: res.error || "", model: res.model || "", ms: res.ms || 0, cost: res.cost || 0, short }));
    log({ read: res.read || null, error: res.error || "", ms: res.ms, cost: res.cost, src: p.src });
    if (je) Object.assign(je, { read: res.read || null, err: res.error || "", model: res.model || modelKey, ms: res.ms || 0, short, tap2reply: Date.now() - p.at });
    readState(false);
    if (!auto || MODE === "card") setMode("card", true);   // the compact card shows the best guess (an automatic read never closes the full view)
    // no number read, or unsure: read the enlarged card from the same frame (CardComp keeps it only if it ranks higher)
    const r = res.read;
    if (r && r.card_visible !== false && r.name && (!r.number || (r.confidence || 0) < 0.7) && Array.isArray(r.box) && r.box.length === 4) {
      let zc = null; try { zc = await zoom(img, r.box); } catch (e) { log("zoom: " + e.message); }
      if (zc) {
        const zr = await recogRead(zc.img, modelKey, apiKey);
        if (zr.read) toApp(Object.assign({}, head, { zoom: zc.z, read: zr.read, error: "", model: zr.model || "", ms: zr.ms || 0, cost: zr.cost || 0, short }));
        if (je) je.zoom = { z: zc.z, read: zr.read || null, err: zr.error || "" };
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

  // ---------------------------------------------------------------- the extension's own files, run in the page
  // store.js (auction log + verified prices to GitHub) and tcgfast.js (every condition from TCGplayer's data services)
  // need only a token lookup and fetch: given a stand-in for each, they run unchanged. Source: the live site's copy,
  // else the one built into the APK.
  async function extFile(name, path) {
    try { const r = await fetch(path + "?t=" + Date.now(), { cache: "no-store" }); if (r.ok) return await r.text(); } catch (_) {}
    try { return A.asset(name) || ""; } catch (_) { return ""; }
  }
  const tokenShim = { storage: { local: { get: (k, cb) => { let t = ""; try { t = A.key("github") || ""; } catch (_) {} cb({ ghToken: t }); }, set: () => {} } } };
  let STORE = null;
  const storeReady = extFile("store.js", "extension/store.js").then((src) => {
    if (!src) return null;
    try { STORE = new Function("chrome", src + "\n;return { queue, queueLog, readLog, editLog, pruneLog, test };")(tokenShim); } catch (e) { log("store.js: " + e.message); }
    return STORE;
  });
  // fetch through the app for TCGplayer (its services allow no cross-origin page)
  const HTTPQ = {}; let HTTPN = 0;
  P.http = function (req, status, body) { const f = HTTPQ[req]; delete HTTPQ[req]; if (f) f(status, body); };
  const nativeFetch = (url, opt) => new Promise((res, rej) => {
    const r = "h" + (++HTTPN), o = opt || {};
    HTTPQ[r] = (status, body) => status ? res({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body), text: async () => body }) : rej(new Error(new URL(url).host + " unreachable"));
    try { A.http(r, o.method || "GET", String(url), o.body || ""); } catch (e) { delete HTTPQ[r]; rej(e); }
  });
  let TCGFAST = null;
  const fastReady = extFile("tcgfast.js", "extension/tcgfast.js").then((src) => {
    if (!src) return null;
    try { TCGFAST = new Function("fetch", src + "\n;return tcgFast;")(nativeFetch); } catch (e) { log("tcgfast.js: " + e.message); }
    return TCGFAST;
  });

  // ---------------------------------------------------------------- the lot reader (the phone twin of extension/whatnot.js)
  // The app's screen reader sends every text on Whatnot's screen with its bounds (__phone.screen). readLotPhone turns
  // that into the same lot state whatnot.js reads from the web page, and the state machine below is whatnot.js's
  // lotTick / endLot, unchanged apart from its input: same cardcomp-lot / cardcomp-lot-end messages, so the app's lot
  // strip, tap labels, stats, haul and the auction log work as on desktop.
  // Android layout (Derek's screenshots, 2026-10-23): seller top left, viewers top right; lot card above the buttons:
  // title "Card on screen #141", condition "Mint", "$0.38 Shipping + Taxes", price "$4" right with "00:01" or "Sold";
  // "X is winning!" / "X won!" above it; buttons "Custom" + "Bid $5" or "Awaiting Next Item"; Custom sheet: title,
  // "$9 +Ship/Tax", timer, − $10 +, "Submit Max Bid"; end screen "X" + "Won the auction!".
  const LRX = {
    money: /^\$\s?([\d,]+(?:\.\d{2})?)$/, timer: /^\d{1,2}:\d{2}$/, ship: /\$([\d.]+)\s*shipping/i, free: /^free shipping/i,
    win: /^(\S+)\s+is\s+winning!?$/i, winTail: /^is\s+winning!?$/i, me: /you(?:'re| are)\s+winning/i, next: /^bid:?\s*\$([\d,]+)/i,
    sold1: /^(\S+)\s+won!?$/i, wonTail: /^won!?$/i, auction: /^won the auction!?$/i, meWon: /^you won/i, joinedTail: /^joined\b/i,
    skip: /shipping|\bbids?$|^\$\s?[\d,.]+$|^\d{1,2}:\d{2}$|winning|won!?$|won the auction|^you won|^sold$|^qty\.|^bid\b|^custom$|^follow(ing)?$|^awaiting next item|^pre-bid|^max bid|^set max|^submit max|^say something|^\+ship|^earn more|^check here|^share$|^clip$|^boost$|^more$|^wallet$|^shop$|^giveaway$|^entries$|^show notes$|joined/i
  };
  const NOT_NAME = /^(entries|giveaway|follow|following|custom|chat|watching|shop|bid|bids|sold|winning|won|joined|pre-bid|products|more|boost|clip|share|wallet)$/i;
  const userLike = (s) => /^[A-Za-z0-9_.-]{2,32}$/.test(s || "") && /[A-Za-z]/.test(s) && !NOT_NAME.test(s);
  const COND_TXT = { "near mint": "NM", "lightly played": "LP", "moderately played": "MP", "heavily played": "HP", "damaged": "DMG", "mint": "NM", "new": "NM" };
  let ME = ""; try { ME = (localStorage.getItem("cardcomp_wn_user") || "").toLowerCase(); } catch (_) {}
  const isMe = (u) => !!ME && String(u || "").trim().toLowerCase() === ME;
  const members = new Map();
  function seen(user, how) { const m = members.get(user) || { first: Date.now(), last: 0, joins: 0, leads: 0, chats: 0, lastJoin: 0 }; m.last = Date.now(); if (how === "joins") { if (Date.now() - m.lastJoin < 5 * 60e3) { members.set(user, m); return; } m.lastJoin = Date.now(); } m[how] = (m[how] || 0) + 1; members.set(user, m); }
  function roomSnapshot() { const cut = Date.now() - 30 * 60000, out = {}; for (const [u, m] of members) if (m.last >= cut) out[u] = { leads: m.leads, joins: m.joins, min: Math.round((Date.now() - m.first) / 60000), ago: Math.round((Date.now() - m.last) / 60000) }; return out; }
  let SELLER = "";
  function readLotPhone(items, W, H) {
    const it = items.filter((x) => x.t).sort((a, b) => a.y - b.y || a.l - b.l);
    const st = { title: "", sub: "", cond: "", cur: null, next: null, bids: null, timer: "", lead: "", me: false, ship: null, sold: "", ended: false, waiting: false, seller: "", url: "whatnot-app", viewers: null, giveaway: null };
    const sameRow = (a, b) => b && Math.abs((a.y + a.b) / 2 - (b.y + b.b) / 2) < Math.max(a.b - a.y, b.b - b.y) * 0.8;
    const above = (a, b) => b && b.b <= a.y + 4 && a.y - b.b < (a.b - a.y) * 1.6 && Math.abs(a.l - b.l) < W * 0.25;   // b sits right above a
    // seller: the first name-like text in the header; viewers: a bare number top right
    for (const x of it) {
      if (x.y > H * 0.11) break;
      if (!st.seller && x.l < W * 0.6 && userLike(x.t)) st.seller = x.t;
      if (st.viewers == null && x.l > W * 0.6 && /^\d{1,6}$/.test(x.t)) st.viewers = +x.t;
    }
    if (st.seller) SELLER = st.seller; else st.seller = SELLER;
    st.url = "whatnot-app/" + (st.seller || "");
    // the button row (or the Custom sheet's Submit) anchors the lot card above it
    const sheet = it.find((x) => /^submit (max |exact )?bid$/i.test(x.t));   // "Submit Exact Bid" when the sheet's Max Bid switch is off
    const btn = it.filter((x) => x.y > H * 0.55 && (/^custom$/i.test(x.t) || LRX.next.test(x.t) || /^awaiting next item$/i.test(x.t) || /^max bid added/i.test(x.t)));
    const anchorY = sheet ? sheet.y : btn.length ? Math.min(...btn.map((x) => x.y)) : H * 0.94;
    const say = it.find((x) => /^say something/i.test(x.t));
    let topY = sheet ? anchorY - H * 0.36 : anchorY - H * 0.2;
    if (say && !sheet && say.b < anchorY) topY = Math.max(topY, say.b - 2);   // chat lines sit above the chat box: never a title
    const blk = it.filter((x) => x.y >= topY && x.b <= anchorY + 2);
    const leadRow = blk.filter((x) => /winning!?$|won!?$/i.test(x.t));   // "X is winning!" / "X won!" line: its name is not a title
    const texts = [];
    for (const x of blk) {
      let m;
      if (LRX.money.test(x.t) && x.l > W * 0.62) { if (st.cur == null) st.cur = parseFloat(LRX.money.exec(x.t)[1].replace(/,/g, "")); }
      else if (LRX.timer.test(x.t)) st.timer = x.t;
      else if ((m = LRX.ship.exec(x.t))) st.ship = parseFloat(m[1]);
      else if (LRX.free.test(x.t)) st.ship = 0;
      else if (/^sold$/i.test(x.t)) st.ended = true;
      else if (x.l < W * 0.62 && x.t.length > 1 && x.t.length < 120 && /[A-Za-z0-9]/.test(x.t) && !LRX.skip.test(x.t) && !leadRow.some((w) => w === x || sameRow(x, w))) texts.push(x.t);
    }
    st.title = texts[0] || ""; st.sub = texts[1] || "";
    st.cond = COND_TXT[(st.sub.split(/[·∙•|]/)[0] || "").trim().toLowerCase()] || "";
    let wonBy = "", meWon = false, wonUser = "";
    for (let i = 0; i < it.length; i++) {
      const x = it[i], t = x.t; let m;
      const left = it.slice(Math.max(0, i - 3), i).reverse().find((p) => sameRow(x, p) && p.r <= x.l + 8);   // the name beside it, same line
      const up = it.slice(Math.max(0, i - 4), i).reverse().find((p) => above(x, p));                         // the line right above
      if (LRX.me.test(t)) st.me = true;
      else if (LRX.meWon.test(t)) { meWon = true; st.me = true; }   // before "X won!": "You won" is not a user named You
      else if ((m = LRX.win.exec(t)) && userLike(m[1])) st.lead = m[1];
      else if (LRX.winTail.test(t) && left && userLike(left.t)) st.lead = left.t;
      else if (LRX.auction.test(t) && up && userLike(up.t)) { wonBy = up.t; wonUser = up.t; }       // "caydenarterbury" / "Won the auction!"
      else if (LRX.wonTail.test(t) && left && userLike(left.t)) { wonBy = left.t; wonUser = left.t; }   // "caydenarterbury" + "won!"
      else if ((m = LRX.sold1.exec(t)) && userLike(m[1])) { wonBy = m[1]; wonUser = m[1]; }            // "caydenarterbury won!"
      else if (/^awaiting next item$/i.test(t)) st.waiting = true;
      else if ((m = /^max bid added:?\s*\$([\d,]+)/i.exec(t))) st.placedMax = +m[1].replace(/,/g, "");
      else if ((m = LRX.next.exec(t))) st.next = parseFloat(m[1].replace(/,/g, ""));
      else if (LRX.joinedTail.test(t) && up && userLike(up.t)) seen(up.t, "joins");              // "turtle_hawk" / "joined 👋"
      else if (/^entries$/i.test(t) && up && /^\d{1,6}$/.test(up.t)) st.giveaway = +up.t;
      else if (/^entries$/i.test(t) && left && /^\d{1,6}$/.test(left.t)) st.giveaway = +left.t;
    }
    if (isMe(st.lead)) st.me = true;
    if (meWon && wonUser && !ME) { ME = wonUser.toLowerCase(); try { localStorage.setItem("cardcomp_wn_user", wonUser); } catch (_) {} }
    if (meWon) wonBy = "me";
    if (wonBy || st.ended) { st.ended = true; st.sold = (wonBy && wonBy !== "me" && isMe(wonBy)) ? "me" : (wonBy || "?"); if (st.sold === "me") st.me = true; }
    return st;
  }
  // ---- extension/whatnot.js lotTick / endLot, input swapped (keep in step with that file)
  let lotLast = "", lot = null, lotLastState = null;
  const sendApp = (m) => toApp(m);
  let prevEnd = null;
  function endLot(st) {
    if (!lot || lot.ended) return;
    lot.ended = true;
    // a sold screen that flickers can restart the same lot; with no bid seen since and the same price, it is that lot again
    const ghost = prevEnd && prevEnd.title === lot.title && prevEnd.final === st.cur && !lot.hist.length && lot.startedAt - prevEnd.at < 60000;
    if ((st.cur == null && st.bids == null) || ghost) { sendApp({ type: "cardcomp-lot-end", rec: { empty: true, at: Date.now() } }); return; }
    prevEnd = { title: lot.title, final: st.cur, at: Date.now() };
    sendApp({ type: "cardcomp-lot-end", rec: {
      v: 3, src: "phone", title: lot.title, sub: st.sub || lot.sub, sellerCond: st.cond || lot.cond, start: lot.start, final: st.cur, bids: st.bids,
      winner: st.sold && st.sold !== "me" && st.sold !== "?" ? st.sold : (st.me ? "me" : (st.lead || lot.lastLead || "")), me: !!(st.me || st.sold === "me"),
      sold: !!st.ended, iLed: lot.iLed, placedMax: lot.placedMax != null ? lot.placedMax : null,
      leaders: [...lot.leaders], hist: lot.hist,
      ship: st.ship, seller: st.seller, url: st.url, viewers: st.viewers, viewers0: lot.viewers0, giveaway: st.giveaway,
      room: roomSnapshot(), startedAt: lot.startedAt, at: Date.now(), hour: new Date().getHours(), dow: new Date().getDay()
    } });
  }
  const secs = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
  function lotTick(st) {
    const tSec = secs(st.timer);
    const lkey = st.title || (lot ? lot.title : ((st.cur != null || st.bids != null) ? "(untitled lot)" : ""));
    const rolled = lot && lkey === lot.title && (
      (st.bids != null && lot.maxBids > 0 && st.bids < lot.maxBids) ||
      (lot.ended && !st.sold && tSec != null && lot.lastSec != null && tSec > lot.lastSec + 5));
    if (lkey && lot && lkey !== lot.title && !rolled && !lot.ended && !lot.maxBids && !lot.hist.length) lot.title = lkey;
    if ((lkey && (!lot || lkey !== lot.title)) || rolled) {
      if (lot && lotLastState) endLot(lotLastState);
      lot = { title: lkey, sub: st.sub, cond: st.cond, leaders: new Set(), hist: [], start: st.cur, viewers0: st.viewers, startedAt: Date.now(), ended: false, maxBids: 0, lastSec: null, iLed: false, lastLead: "" };
    }
    if (lot) {
      if (st.lead) lot.lastLead = st.lead;
      if (st.bids != null && st.bids > lot.maxBids) lot.maxBids = st.bids;
      if (tSec != null) lot.lastSec = tSec;
      if (st.me) lot.iLed = true;
      if (st.placedMax != null) lot.placedMax = st.placedMax;
    }
    if (lot && st.lead) {
      lot.leaders.add(st.lead);
      const h = lot.hist, last = h[h.length - 1];
      if (!last || last.u !== st.lead || last.a !== st.cur) {
        h.push({ t: Math.round((Date.now() - lot.startedAt) / 1000), u: st.lead, a: st.cur });
        if (!last || last.u !== st.lead) seen(st.lead, "leads");
      }
      if (h.length > 400) h.shift();
    }
    if (lot && !lot.autoRead && tSec != null && !st.sold && !st.waiting) {
      lot.autoRead = true;
      if (cfg().mode === "auto") { const k = lot.startedAt; setTimeout(() => { if (lot && lot.startedAt === k && !lot.ended) P.readNow("auto"); }, 1000); }
    }
    if (lot && st.sold && !lot.ended) endLot(st);
    st.endSent = !!(lot && lot.ended);
    st.lotStart = lot ? lot.startedAt : null;
    lotLastState = st;
    const key = JSON.stringify(st);
    if (key !== lotLast) { lotLast = key; sendApp(Object.assign({ type: "cardcomp-lot" }, st)); }
  }
  P.screen = function (items, W, H) { try { lotTick(readLotPhone(items || [], W || 1080, H || 2340)); } catch (e) { log("lot reader: " + e.message); } };
  P.readLotPhone = readLotPhone;

  // ---------------------------------------------------------------- picture match (extension/recog/imgmatch.js, same as desktop)
  // The read frame is ranked against each candidate's TCGplayer photo; the photos come through the app (Android.img),
  // since the image CDN allows no cross-origin reads from a page. Templates are kept for the session.
  const IMGQ = {}; let IMGN = 0;
  P.img = function (req, data) { const f = IMGQ[req]; delete IMGQ[req]; if (f) f(data || ""); };
  const photo = (url) => new Promise((res) => { const r = "i" + (++IMGN); IMGQ[r] = res; try { A.img(url, r); } catch (_) { delete IMGQ[r]; res(""); } setTimeout(() => { if (IMGQ[r]) { delete IMGQ[r]; res(""); } }, 15000); });
  const TEMPS = new Map();   // photo url -> normalized cells, or null when there is no usable photo
  const INFLIGHT = new Map();   // photo url -> promise: a download already running (started at the partial reading) is shared
  function cells(url) {
    if (TEMPS.has(url)) return Promise.resolve(TEMPS.get(url));
    if (INFLIGHT.has(url)) return INFLIGHT.get(url);
    const p = (async () => {
      let t = null;
      const data = await photo(url);
      if (typeof IM === "undefined") { INFLIGHT.delete(url); return null; }   // matcher not loaded yet: do not remember "no photo"
      if (data) { try { t = IM.normalize(IM.cardCells(await IM.load(data, 300))); } catch (_) { t = null; } }
      if (TEMPS.size > 3000) TEMPS.clear();
      TEMPS.set(url, t); INFLIGHT.delete(url); return t;
    })();
    INFLIGHT.set(url, p); return p;
  }
  // Speed (Derek, 2026-10-29: "search is taking 5s each"): the picture match waited for the full reply, then downloaded
  // up to 80 photos (median 0.8 s, p90 2.7 s on the phone). The partial reading already names the card, so the photos
  // of every printing of that name start downloading then, while the model finishes.
  const picUrlOf = (c) => c && c.pid ? `https://tcgplayer-cdn.tcgplayer.com/product/${c.pid}_200w.jpg` : (typeof imgOf === "function" && c ? imgOf(c) : "");
  let WARMED = "";
  function warmPhotos(read) {
    try {
      const k = (read.name || "") + "|" + (read.language || read.lang || ""); if (!read.name || k === WARMED || typeof window.autoMatch !== "function") return;
      WARMED = k;
      const m = window.autoMatch(Object.assign({}, read, { finish: "" }), {});
      if (!m || m.kind === "foreign" || m.kind === "none") return;
      const urls = (m.pool || m.cards || []).slice(0, 80).map(picUrlOf).filter((u) => /^https:\/\/(tcgplayer-cdn\.tcgplayer\.com|images\.pokemontcg\.io)\//.test(u));
      (async () => { for (let i = 0; i < urls.length; i += 8) await Promise.all(urls.slice(i, i + 8).map(cells)); })();
    } catch (_) {}
  }
  async function picRank(msg) {
    if (typeof IM === "undefined") return { ok: false, why: "no picture matcher", cands: 0 };
    const f = FRAMES.get(String(msg.key));
    if (!f) return { ok: false, why: "frame gone", cands: 0 };
    const t0 = Date.now();
    if (!f.px) f.px = await (f.pxP || IM.load(f.img));
    const cands = (msg.cands || []).slice(0, 80).filter((c) => c && c.id && /^https:\/\/(tcgplayer-cdn\.tcgplayer\.com|images\.pokemontcg\.io)\//.test(c.u || ""));
    const got = [];
    for (let i = 0; i < cands.length; i += 8) got.push(...await Promise.all(cands.slice(i, i + 8).map(async (c) => ({ id: c.id, t: await cells(c.u) }))));
    const temps = got.filter((x) => x.t), dl = Date.now() - t0;
    for (const x of temps) x.same = temps.filter((y) => y === x || IM.sim(x.t, y.t) > 0.995).length;   // one photo under 3+ ids = "image coming soon"
    const usable = temps.filter((x) => x.same < 3);
    if (!usable.length) return { ok: false, why: "no pictures", cands: cands.length };
    const ranked = IM.match(f.px, f.box, usable), v = IM.verdict(ranked, usable);
    log({ pic: v.top, s: v.s, sure: v.sure, pics: usable.length, ms: Date.now() - t0 });
    if (JOURNAL && String(msg.key) === JOURNAL.fkey) JOURNAL.pic = { top: v.top, s: v.s, sure: v.sure, pics: usable.length, ms: Date.now() - t0, ranked: ranked.slice(0, 5).map((x) => [x.id, +(+x.s || 0).toFixed(3)]) };
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
  const FAST_OK = {};   // product id -> {ok, at}: the last fast read of it
  const HANDLED = new Set(["cardcomp-status", "cardcomp-auto-hello", "cardcomp-auto-config", "cardcomp-auto-read", "cardcomp-bid", "cardcomp-open-bg",
    "cardcomp-auto-img", "cardcomp-auto-match", "cardcomp-auto-outcome", "cardcomp-log-save", "cardcomp-live-save", "cardcomp-log-read", "cardcomp-log-edit",
    "cardcomp-log-prune", "cardcomp-tcg-fast", "cardcomp-snapshot", "cardcomp-live-test", "cardcomp-tcg-post"]);
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
      case "cardcomp-bid": {   // copied always; with the screen reader on, the app also opens Whatnot's Custom sheet and enters it
        let r = {}; try { r = JSON.parse(A.bid(String(d.amount), String(d.name || "")) || "{}"); } catch (e) { r = { ok: false, why: e.message }; }
        if (r.pending) { FLASH = { txt: "…", cond: (typeof LAST_TAP !== "undefined" && LAST_TAP && LAST_TAP.cond) || "NM", until: Date.now() + 4000 }; paintBar(); }
        else P.bidAck(r);
        if (MODE === "list") setTimeout(() => { if (MODE === "list") setMode("card"); }, 900);
        break;
      }
      case "cardcomp-open-bg": {   // a condition link: the fast read answers in ~1 s; the browser opens only when it cannot
        const url = String(d.url || ""), pid = (/\/product\/(\d+)/.exec(url) || [])[1] || "", t0 = Date.now();
        const wait = () => { const f = FAST_OK[pid]; if (f && f.at >= t0 - 500) { if (!f.ok) A.open(url); return; } if (Date.now() - t0 > 4000) { A.open(url); return; } setTimeout(wait, 150); };
        if (pid) wait(); else A.open(url);
        break;
      }
      case "cardcomp-auto-img": picRank(d).then((r) => toApp(Object.assign({ type: "cardcomp-auto-img-ack" }, r, { key: d.key, n: d.n || 1 })),
        (e) => toApp({ type: "cardcomp-auto-img-ack", key: d.key, n: d.n || 1, cands: 0, ok: false, why: e.message })); break;
      case "cardcomp-tcg-post": {   // Chinese copy prices: listings / latest sales of one product, through the app (no proxy needed)
        const url = String(d.url || "");
        if (!/^https:\/\/(mp-search-api\.tcgplayer\.com\/v1\/product\/\d+\/listings|mpapi\.tcgplayer\.com\/v2\/product\/\d+\/latestsales)$/.test(url)) { toApp({ type: "cardcomp-tcg-post-ack", req: d.req, ok: false, err: "not a TCGplayer listings address" }); break; }
        nativeFetch(url, { method: "POST", body: JSON.stringify(d.body || {}) })
          .then(async (r) => { if (!r.ok) throw new Error(new URL(url).host + " " + r.status); return r.json(); })
          .then((j) => toApp({ type: "cardcomp-tcg-post-ack", req: d.req, ok: true, j }), (e) => toApp({ type: "cardcomp-tcg-post-ack", req: d.req, ok: false, err: e.message }));
        break;
      }
      case "cardcomp-tcg-fast":   // every condition from TCGplayer's data services (extension/tcgfast.js through the app)
        fastReady.then(async (f) => {
          let r;
          if (!f) r = { ok: false, errs: ["fast read not loaded"] };
          else { try { r = await f(d); r.ok = Object.values(r.conds || {}).some((c) => c.market > 0); } catch (e) { r = { ok: false, errs: [e.message] }; } }
          FAST_OK[String(d.pid)] = { ok: !!r.ok, at: Date.now() };
          if (r.ok || !d.auto) toApp(Object.assign({}, r, { type: "cardcomp-tcg-fast-ack", req: d.req }));
          paintBar();
        });
        break;
      case "cardcomp-log-save": storeReady.then((S) => { if (S) S.queueLog(d.rec); }); break;
      case "cardcomp-live-save": storeReady.then((S) => { if (S) S.queue(d.key, d.rec); }); break;
      case "cardcomp-log-read": case "cardcomp-log-edit": case "cardcomp-log-prune":
        storeReady.then(async (S) => {
          let r;
          if (!S) r = { ok: false, why: "log store not loaded" };
          else try { r = d.type === "cardcomp-log-read" ? await S.readLog(d.since) : d.type === "cardcomp-log-edit" ? await S.editLog(d.key, d.card, !!d.clear, d.patch) : await S.pruneLog(d.since, d.before); }
          catch (e) { r = { ok: false, why: e.message }; }
          toApp(Object.assign({ type: d.type + "-ack" }, r));
        });
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
    if (changed || show) { try { A.layout(m === "card" && show ? "card-show" : m); } catch (_) {} }   // "card" alone never unfolds a folded panel
    if (m === "card") window.scrollTo(0, 0);
    if (m === "list") setTimeout(() => { const o = $("#results .card.open"); if (o) o.scrollIntoView({ block: "start" }); }, 60);
    try { paintBar(); } catch (e) { log("paintBar: " + e.message); }
    lastH = 0; sizeSoon();   // always report the height after a mode change (the panel's size follows it)
  }
  P.setMode = setMode; P.mode = () => MODE;
  // A touch on Whatnot outside the panel: the full view goes back to the small card (Derek: "couldn't shrink it").
  let OUT_TO_CARD = false;   // typing when the outside touch came: the box blurs first, then this sends it to the small card
  P.outside = function () { if (MODE === "list") setMode("card"); else if (MODE === "typing") OUT_TO_CARD = true; };
  // A result tapped in the full view: back to the small card, showing that card (its row click opens it first).
  document.addEventListener("click", (e) => {
    if (MODE !== "list") return;
    const row = e.target && e.target.closest && e.target.closest("#results .card .row");
    if (!row || e.target.closest(".bids,.cpy,a,.pchip,button,input")) return;
    const card = row.closest(".card");
    setTimeout(() => { const i = cands().indexOf(card); if (i >= 0) { CUR = i; OPENED = null; } setMode("card"); }, 0);
  });
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
  let TOUCH_FIELD_AT = 0;   // a focus without a touch on a field just before it is the page's own (a new lot selects the box on desktop): undone on the phone
  document.addEventListener("pointerdown", (e) => { if (isField(e.target)) { TOUCH_FIELD_AT = Date.now(); try { A.focus(true); } catch (_) {} if (e.target.id === "q" && document.activeElement === e.target && MODE !== "typing") { MODE_BEFORE_TYPING = MODE; setMode("typing"); } } }, true);
  P.wantFocus = () => { TOUCH_FIELD_AT = Date.now(); };
  document.addEventListener("focusin", (e) => {
    if (!isField(e.target)) return;
    if (MODE !== "typing" && Date.now() - TOUCH_FIELD_AT > 1500) { const t = e.target; setTimeout(() => { if (document.activeElement === t) t.blur(); }, 0); return; }
    try { A.focus(true); } catch (_) {}
    if (e.target.id === "q" && MODE !== "typing") { MODE_BEFORE_TYPING = MODE; setMode("typing"); }
  }, true);
  document.addEventListener("focusout", (e) => {
    if (!isField(e.target)) return;
    setTimeout(() => {
      if (isField(document.activeElement)) return;
      try { A.focus(false); } catch (_) {}
      if (MODE === "typing") setMode(OUT_TO_CARD ? "card" : ($("#q") && $("#q").value.trim()) ? "list" : MODE_BEFORE_TYPING === "typing" ? "card" : MODE_BEFORE_TYPING);
      OUT_TO_CARD = false;
    }, 150);
  }, true);
  P.blur = function () { try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (_) {} };

  // height: what the page shows, reported to the native panel (it caps it at 62% of the screen; the list scrolls inside)
  let sizeT = 0, lastH = 0;
  function sizeSoon() { clearTimeout(sizeT); sizeT = setTimeout(sizeNow, 60); }
  function sizeNow() {
    const w = $(".wrap"), el = w || document.body, z = ZOOM || 1;
    // CSS zoom on <html>: offsetHeight is in unzoomed CSS px, the window needs zoomed ones
    const h = Math.ceil(el.offsetHeight * z);
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
    "body.ph-card .searchrow{padding-bottom:0!important}body.ph-card{overflow:hidden}body.ph-card .searchrow>*:not(#phonecard){display:none!important}" +
    "#phonealert{font-size:10.5px;line-height:1.3;color:var(--red);display:flex;flex-wrap:wrap;align-items:center;gap:2px 8px;padding:1px 0}#phonealert:empty{display:none}" +
    "#phonealert .pzh{flex:1 1 100%;display:flex;align-items:center;gap:6px;color:var(--ink);font-size:11px;border:1px solid var(--red);border-radius:7px;padding:4px 6px;margin:2px 0}" +
    "#phonealert .pzh span{flex:1;min-width:0}#phonealert .pzh button{flex:none;font-size:14px;color:#000;background:var(--gold);border-color:var(--gold);padding:6px 10px}" +
    "#phonebar .zl{font-size:11px;line-height:1.3;color:var(--ink);margin-top:3px}#phonebar .zl small{color:var(--dim);font-size:10px}#phonebar .zl.on b{color:var(--gold)}" +
    "#phonebar .zhb{font:inherit;font-size:16px;font-weight:800;color:#000;background:var(--gold);border:0;border-radius:8px;padding:7px 14px}#phonebar .zl .bad{color:var(--red)}" +
    "#phonealert .na{color:var(--gold)}#phonealert button{font:inherit;font-size:11px;font-weight:700;color:var(--ink);background:rgba(255,107,107,.14);border:1px solid var(--red);border-radius:6px;padding:3px 8px}" +
    "body:not(.ph-card) #phonealert{display:none}" +
    "body.ph-card .searchrow~*,body.ph-card #autoline{display:none!important}" +
    "body.ph-typing #phonestat{display:none}body.ph-typing #read,body.ph-typing #status,body.ph-typing #autoline{display:none!important}" +
    "#phonecard{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:var(--ink)}" +
    "#phonebar .pc{display:flex;gap:8px;align-items:flex-start;padding:3px 0 2px}" +
    "#phonebar .pimg{flex:none;width:78px;height:109px;border-radius:5px;overflow:hidden;background:var(--panel2);cursor:pointer}" +
    "#phonebar .pimg img{width:100%;height:100%;object-fit:contain;display:block}" +
    "#phonebar .pmain{flex:1;min-width:0}" +
    "#phonebar .pn{cursor:pointer;line-height:1.15}" +
    "#phonebar .pn b{display:block;font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    "#phonebar .pn span{display:block;font-size:10px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    "#phonebar .ph{display:flex;align-items:center;gap:3px;height:28px;margin-top:2px}" +
    "#phonebar .tg{flex:1;min-width:0;font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-left:2px}#phonebar .tg i{font-style:normal;margin-right:5px;color:var(--gold)}" +
    "#phonebar .tg i.ok{color:var(--green);font-weight:700}#phonebar .tg i.no{color:var(--faint);text-decoration:line-through}#phonebar .tg i.wt{color:var(--faint);animation:tgp 1s ease-in-out infinite alternate}@keyframes tgp{from{opacity:1}to{opacity:.35}}" +
    "#phonebar .st{flex:none;border:1px solid var(--line);border-radius:7px;width:26px;height:26px;font-size:14px;display:flex;align-items:center;justify-content:center;color:var(--ink)}" +
    "#phonebar .st.on{color:var(--gold);border-color:var(--gold)}" +
    "#phonebar .sn{flex:none;font-size:10px;color:var(--faint);min-width:22px;text-align:center}" +
    // printing chips (Holo / Reverse / Poké Ball...): one tap reprices the pills; gold = the printing the pills show
    "#phonebar .pp{display:grid;grid-template-columns:repeat(auto-fit,minmax(58px,1fr));gap:4px;margin:2px 0 1px}" +
    "#phonebar .pq{display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:0;height:29px;border:1.5px solid var(--line);border-radius:8px;color:var(--ink);cursor:pointer;line-height:1.1;padding:0 2px}" +
    "#phonebar .pq b{font-size:11px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}#phonebar .pq i{font-style:normal;font-size:10px;color:var(--dim);font-variant-numeric:tabular-nums}" +
    "#phonebar .pp.n4 .pq b{font-size:10px;letter-spacing:-.2px}#phonebar .pp.n4 .pq i{font-size:9.5px}" +
    "#phonebar .pq.on{background:var(--gold);border-color:var(--gold);color:#000}#phonebar .pq.on i{color:#000}" +
    "#phonebar .pq.rd:not(.on){border-style:dashed;border-color:var(--gold)}" +
    "#phonebar .pmiss{font-size:10.5px;color:var(--red);line-height:1.2;margin:1px 0}" +
    // condition pills: a sideways scroller, about two at a time; swipe for MP / HP / DMG
    "#phonebar .prow{display:flex;gap:5px;margin-top:3px;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;-webkit-overflow-scrolling:touch;padding-bottom:1px}" +
    "#phonebar .prow::-webkit-scrollbar{display:none}" +
    "#phonebar .pb{flex:0 0 44%;min-width:0;overflow:hidden;scroll-snap-align:start;display:flex;flex-direction:column;align-items:center;justify-content:center;height:58px;border:1.5px solid var(--gold);border-radius:8px;background:rgba(245,179,1,.10);line-height:1.05}" +
    "#phonebar .pb em{font-style:normal;font-size:10px;font-weight:700}" +
    "#phonebar .pb b{font-size:17px;font-weight:800;color:var(--gold);font-variant-numeric:tabular-nums;white-space:nowrap}" +
    "#phonebar .pb small{font-size:9.5px;color:var(--dim);font-variant-numeric:tabular-nums;white-space:nowrap;line-height:1.15;max-width:100%;overflow:hidden;text-overflow:ellipsis}" +
    "#phonebar .pb small i{font-style:normal;color:var(--faint);margin-right:3px}" +
    "#phonebar .prow.dim .pb{opacity:.45;border-style:dashed}#phonebar .pb.wait{opacity:.55}#phonebar .pb.fl{background:var(--green);border-color:var(--green)}#phonebar .pb.fl b{color:#000;font-size:12px}#phonebar .pb.fl em,#phonebar .pb.fl small{color:#000!important}" +
    "#phonebar .pk{padding:3px 0 2px}#phonebar .pkh{font-size:10.5px;color:var(--dim)}#phonebar .pkh b{color:var(--gold);font-size:12px;margin-right:4px}" +
    "#phonebar .pkrow{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;padding:3px 0 1px;scroll-snap-type:x proximity}#phonebar .pkrow::-webkit-scrollbar{display:none}" +
    "#phonebar .pki{flex:0 0 74px;width:74px;min-width:0;overflow:hidden;box-sizing:border-box;scroll-snap-align:start;display:flex;flex-direction:column;gap:1px;cursor:pointer;border:1.5px solid var(--line);border-radius:7px;padding:3px}" +
    "#phonebar .pki.g{border-color:var(--gold)}#phonebar .pkim{display:block;width:100%;height:92px;border-radius:4px;overflow:hidden;background:var(--panel2)}" +
    "#phonebar .pkim img{width:100%;height:100%;object-fit:contain;display:block}" +
    "#phonebar .pki em{font-style:normal;font-size:10px;font-weight:700;line-height:1.15;color:var(--ink);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}" +
    "#phonebar .pki small{font-size:9px;color:var(--dim);line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#phonebar .pki .pkp{color:var(--gold)}" +
    "#phonebar .pe{display:flex;align-items:center;gap:8px;padding:6px 0}#phonebar .pe>div:first-child{flex:1;min-width:0}" +
    "#phonebar .pe b{font-size:14px}#phonebar .pe span{display:block;font-size:12px;color:var(--dim);line-height:1.35}#phonebar .ptools{display:flex;gap:6px}" +
    // reading bar: gold, spinner, timer; the card under it dims and takes no taps until the reply
    "#phoneread{display:none}#phoneread.on{display:flex;align-items:center;gap:6px;background:var(--gold);color:#000;border-radius:7px;padding:5px 8px;margin:2px 0 3px;font-size:11.5px;line-height:1.2;white-space:nowrap;overflow:hidden}" +
    "#phoneread b{overflow:hidden;text-overflow:ellipsis}#phoneread .sec{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:700}#phoneread .still{font-weight:700;color:#7a1010}" +
    "#phoneread .sp{flex:none;width:11px;height:11px;border:2px solid #000;border-right-color:transparent;border-radius:50%;animation:phsp .7s linear infinite}@keyframes phsp{to{transform:rotate(360deg)}}" +
    "#phoneread.still{animation:phsh .3s 2}@keyframes phsh{25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}" +
    "#phonecard.reading:not(.partial) #phonebar{opacity:.35;filter:grayscale(.6)}#phonecard.reading:not(.partial) #phonealert{opacity:.4}" +
    "#phonestat{font-size:10.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:1px 0 2px;cursor:pointer}#phonestat:empty{display:none}#phonestat a{color:var(--blue)}#phonestat .bad{color:var(--red)}";
  document.head.appendChild(css);
  document.body.classList.add("phone");
  // The browser's own zoom is off: a width change of the panel left the page magnified ~2.5x on the phone (Derek,
  // 2026-10-23). Scale 1, always; the size of the contents is ours to set (pinch, below).
  { let vp = document.querySelector('meta[name="viewport"]'); if (!vp) { vp = document.createElement("meta"); vp.name = "viewport"; document.head.appendChild(vp); }
    vp.content = "width=device-width,initial-scale=1,minimum-scale=1,maximum-scale=1,user-scalable=no"; }
  css.textContent += "html{-webkit-text-size-adjust:100%;text-size-adjust:100%}body.phone{touch-action:pan-x pan-y}";

  // ---------------------------------------------------------------- pinch: the size of the panel's contents (Derek, 2026-10-23)
  // Two fingers apart = bigger, together = smaller (60% to 160%, remembered). Pinching together past the smallest size
  // folds the panel into the bubble (and keeps the size it had).
  const ZMIN = 0.6, ZMAX = 1.6;
  let ZOOM = 1; try { ZOOM = Math.min(ZMAX, Math.max(ZMIN, +localStorage.getItem("cardcomp_phone_zoom") || 1)); } catch (_) {}
  const applyZoom = () => { document.documentElement.style.zoom = String(ZOOM); lastH = 0; sizeSoon(); };
  P.zoom = () => ZOOM;
  if (ZOOM !== 1) document.documentElement.style.zoom = String(ZOOM);
  let PINCH = null;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  document.addEventListener("touchstart", (e) => { if (e.touches.length === 2) PINCH = { d0: dist(e.touches), z0: ZOOM, fold: false }; }, { passive: true, capture: true });
  document.addEventListener("touchmove", (e) => {
    if (!PINCH || e.touches.length !== 2) return;
    e.preventDefault();
    const z = PINCH.z0 * dist(e.touches) / PINCH.d0;
    PINCH.fold = z < ZMIN * 0.85;
    const nz = Math.round(Math.min(ZMAX, Math.max(ZMIN, z)) * 100) / 100;
    if (nz !== ZOOM) { ZOOM = nz; applyZoom(); }
  }, { passive: false, capture: true });
  const pinchEnd = (e) => {
    if (!PINCH || e.touches.length >= 2) return;
    const p = PINCH; PINCH = null;
    if (p.fold) { ZOOM = p.z0; applyZoom(); try { A.collapse(); } catch (_) {} }   // pinched shut: into the bubble, size as it was
    try { localStorage.setItem("cardcomp_phone_zoom", String(ZOOM)); } catch (_) {}
  };
  document.addEventListener("touchend", pinchEnd, { capture: true });
  document.addEventListener("touchcancel", pinchEnd, { capture: true });
  document.addEventListener("click", (e) => { const a = e.target && e.target.closest && e.target.closest("#autoline"); if (a && !e.target.closest("a,select,.modes,.rn")) { a.classList.toggle("full"); sizeSoon(); } });

  // ---------------------------------------------------------------- the compact card (Derek, 2026-10-23: "show me the card picture", PalletTrade's layout)
  // Picture on the left; name, set and number; a table of NM / LP / MP / HP with the price bids use and the max bid as
  // a button. The card shown: the one stepped to with ‹ ›, else the open card, else the best guess of the last
  // reading, else the top result of a typed search (never the default list). The rows mirror that card's real
  // condition grid: the card is opened in the (hidden) results, and each bid button taps the grid's own button, so the
  // numbers, the cascade from verified prices, the lot label and the log are the same as in the full view.
  let wrapEl = null, FLASH = null, CUR = -1, OPENED = null, PICKED = false;
  // A read is only priced straight away when it is sure (Derek, 2026-10-23: "sometimes the wrong card is delivered"):
  // an exact strong match (✓ auto) or the text read and the picture agreeing (auto + picture). Otherwise the small card
  // shows the likely cards to pick from, best guess first; picking one prices it (≡ goes back to the choices).
  const fromRead = () => /·\s*auto\s*$/.test((($("#status") || {}).textContent || "").trim());
  const sureCard = (c) => !!c && c.classList.contains("autosug") && (c.classList.contains("byboth") || !!c.querySelector(".autobadge.strong"));
  const needPick = () => MODE === "card" && fromRead() && CUR < 0 && !PICKED && !sureCard($("#results .card.autosug"));
  function wrap() {
    if (wrapEl && wrapEl.isConnected) return wrapEl;
    const sr = $(".searchrow"); if (!sr) return null;
    wrapEl = document.createElement("div"); wrapEl.id = "phonecard";
    wrapEl.innerHTML = '<div id="phoneread"></div><div id="phonebar"></div><div id="phonealert"></div><div id="phonestat"></div>';
    sr.insertBefore(wrapEl, sr.firstChild);
    // a tap on the dimmed card while a read runs is not lost silently (Derek, 2026-10-29: "failed 5x in a row" with no
    // taps logged): the bar shakes and says still reading; the old card's bid is not sent
    wrapEl.addEventListener("click", (e) => {
      if (!wrapEl.classList.contains("reading") || wrapEl.classList.contains("partial") || !e.target.closest("#phonebar")) return;
      e.preventDefault(); e.stopPropagation(); P.stillReading();
    }, true);
    wrapEl.querySelector("#phonestat").onclick = (e) => {
      if (e.target.closest("a.fr")) { e.preventDefault(); if (P.lastFrame && typeof zoom === "function") { setMode("list"); zoom(P.lastFrame); } return; }
      setMode("list");
    };
    return wrapEl;
  }
  const money = (v) => "$" + (v >= 1000 ? Math.round(v).toLocaleString("en-US") : v >= 100 ? v.toFixed(0) : v.toFixed(2));
  // The number typed or read is not this card's: the card is likely not in the catalog (under $1.50, or not on
  // TCGplayer), and what is shown is only the closest by name. Said plainly instead of pricing a wrong card silently.
  const dePad = (x) => String(x || "").toLowerCase().replace(/^([a-z]*)0+(\d)/, "$1$2");
  function notExact(r) {
    const q = ($("#q") && $("#q").value || "").trim(); if (!q) return "";
    const nums = q.split(/\s+/).map((t) => t.split("/")[0]).filter((t) => /\d/.test(t) && /^[a-z]{0,6}\d{1,4}[a-z]?$/i.test(t) && !/^(19|20)\d\d$/.test(t));
    if (!nums.length) return "";
    const mine = dePad(r.num);
    if (nums.some((t) => dePad(t) === mine)) return "";
    return `no card #${nums[0].toUpperCase()} in the catalog (likely under $1.50 or not on TCGplayer): closest by name`;
  }
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
  const SHOW = ["NM", "LP", "MP", "HP", "DMG"];
  const USER_PRINT = {};   // card id -> printing Derek picked on the small card
  let READ_PRINT = null;   // {id, k, done}: the printing the last reading named for its suggested card
  // Printing buttons in words Derek uses (2026-10-29: "hard to navigate between first edition, shadow, unlimited and
  // non-holo"): 1st Ed / Shadowless / Unlimited on vintage, Holo / Non-holo on modern, then Reverse and the Ball patterns,
  // always in that order. TCGplayer's "Normal" / "Holofoil" on a card that also has 1st Edition or Shadowless printings
  // is the Unlimited one. Two keys landing on one word keep their full names.
  function printLabels(keys) {
    const ed = keys.some((k) => /1st|shadowless/i.test(k)), out = {};
    for (const k of keys) {
      const s = k.toLowerCase(); let t, rank;
      if (/master ball/.test(s)) { t = "Master Ball"; rank = 6; }
      else if (/pok[eé] ball/.test(s)) { t = "Poké Ball"; rank = 5; }
      else if (/reverse/.test(s)) { t = "Reverse"; rank = 4; }
      else if (/1st/.test(s)) { t = "1st Ed"; rank = 0; }
      else if (/shadowless/.test(s)) { t = "Shadowless"; rank = 1; }
      else if (/unlimited/.test(s) || (ed && /^(normal|holofoil)$/.test(s))) { t = "Unlimited"; rank = 2; }
      else if (/holo/.test(s)) { t = "Holo"; rank = 2; }
      else if (/normal/.test(s)) { t = "Non-holo"; rank = 3; }
      else { t = shortPrint(k); rank = 7; }
      out[k] = { t, rank };
    }
    const seen = {}; for (const k of keys) (seen[out[k].t] = seen[out[k].t] || []).push(k);
    for (const t in seen) if (seen[t].length > 1) for (const k of seen[t]) out[k].t = shortPrint(k);
    return out;
  }
  const shortPrint = (k) => { const s = typeof prettyPrinting === "function" ? prettyPrinting(k) : k;
    return s.replace(/^Reverse Holo$/i, "Reverse").replace(/^Normal$/i, "Non-holo").replace(/Unlimited/g, "Unl").replace(/Shadowless/g, "Shdl").replace(/\s*Pattern$/i, "").replace(/Pok[eé] Ball/i, "Poké Ball").replace(/(Ball) Holo$/, "$1"); };
  // wrap the matcher once (automatch.js loads before this file): remember the printing its finish read names
  if (typeof window.autoMatch === "function" && !window.autoMatch.__ph) {
    const am = window.autoMatch;
    window.autoMatch = function (read, ctx) { const m = am(read, ctx); try { if (m && m.suggestion && m.printing && (!READ_PRINT || READ_PRINT.id !== m.suggestion || READ_PRINT.k !== m.printing)) READ_PRINT = { id: m.suggestion, k: m.printing, done: false }; } catch (_) {} return m; };
    window.autoMatch.__ph = true;
  }
  // break-even: the most you can pay and not lose money (fees, shipping and your list markup, 0% margin): the app's own
  // bidForMargin at 0, what the desktop tiles call "b/e". Shown with cents.
  // with cents (Derek, 2026-10-29: "b/e needs to show cents"): it is a ceiling to judge against, not a bid to send
  const beOf = (mkt) => { try { const v = mkt > 0 && typeof bidForMargin === "function" ? bidForMargin(mkt, 0) : 0; return v > 0 ? "$" + (v >= 1000 ? Math.floor(v).toLocaleString("en-US") : v.toFixed(2)) : "–"; } catch (_) { return "–"; } };
  // Every card shown gets the TCGplayer fast read in the background (Derek, 2026-10-23): LP / MP / HP / DMG then come
  // from TCGplayer's own market, listings and sales instead of the usual shares of NM. Same request a condition link
  // sends (extension/tcgfast.js through the app); the app applies every condition and the grid, which the small card
  // mirrors, re-renders. Once per printing per 10 minutes; a failure is only marked, never opens the browser.
  const FAST_AUTO = {}; let fastT = 0, fastKey = "";
  function autoFast(card) {
    const a = card && card.querySelector('.condgrid a.clink[href*="tcgplayer.com/product/"]'); if (!a) return;
    let u; try { u = new URL(a.href); } catch (_) { return; }
    const pid = (/\/product\/(\d+)/.exec(u.pathname) || [])[1], printing = u.searchParams.get("Printing") || "";
    if (!pid) return;
    const k = pid + "|" + printing;
    if (k === fastKey || (FAST_AUTO[k] && Date.now() - FAST_AUTO[k] < 10 * 60e3)) return;
    fastKey = k; clearTimeout(fastT);
    fastT = setTimeout(() => {   // settle: stepping through candidates does not fire a read per step
      if (fastKey !== k) return;
      FAST_AUTO[k] = Date.now();
      const q = { req: Date.now(), pid, printing, cond: "NM" };
      try { FAST_REQ = q; } catch (_) {}   // the app's own request slot: its ack handler applies the reply
      handle(Object.assign({ type: "cardcomp-tcg-fast", auto: true }, q));
    }, 600);
  }
  function paintBar() {
    const w = wrap(); if (!w) return;
    const el = w.querySelector("#phonebar");
    const tools = `<span class="st" data-t="search" title="search">&#128269;</span>` + (MODE !== "card" ? `<span class="st on" data-t="toggle" title="back to the small card">&#9652;</span>` : "");
    if (MODE === "card" && zhActive()) { paintZh(el, tools); paintStat(); sizeSoon(); return; }
    if (needPick() && cands().length) { paintPicker(el, tools); paintStat(); sizeSoon(); return; }
    const card = focusCard(), id = card && card.dataset.id, r = id && typeof CARDS !== "undefined" ? CARDS.find((x) => x.id === id) : null;
    if (!r) {
      const html = `<div class="pe"><div><b>No card yet</b><span>Tap the gold <b>read</b> bubble when a card is on screen, or search.</span></div><div class="ptools">${tools}</div></div>`;
      if (el.innerHTML !== html) { el.innerHTML = html; wire(el, null); }
      paintStat(); sizeSoon(); return;
    }
    if (MODE === "card") ensureOpen(card);   // only in the compact view: opening a card blurs the search box
    const list = cands(), i = list.indexOf(card), n = list.length;
    const grid = card.querySelector(".condgrid");
    const btns = grid ? Array.from(grid.querySelectorAll(".bd.cpy[data-cond]")) : [];
    if (grid) autoFast(card);
    const pks = Array.from(card.querySelectorAll(".pchips .pchip"));
    // the read saw the finish (holo, reverse, Poké Ball...): start on that printing, once per reading, never over Derek's own tap
    if (READ_PRINT && READ_PRINT.id === r.id && !READ_PRINT.done && pks.length > 1) {
      READ_PRINT.done = true;
      const want = pks.find((c) => c.dataset.k === READ_PRINT.k);
      if (want && !want.classList.contains("on") && USER_PRINT[r.id] == null) want.click();
    }
    const pk = card.querySelector(".pchip.on"), printing = pk ? (typeof prettyPrinting === "function" ? prettyPrinting(pk.dataset.k) : pk.dataset.k) : "";
    const readK = READ_PRINT && READ_PRINT.id === r.id ? READ_PRINT.k : "";
    const labs = printLabels(pks.map((c) => c.dataset.k));
    const pchips = pks.length > 1 ? `<div class="pp${pks.length >= 4 ? " n4" : ""}" style="grid-template-columns:repeat(${Math.min(pks.length, 4)},minmax(0,1fr))">` + pks.map((c) => { const mm = /\$([\d,]+(?:\.\d+)?)/.exec(c.textContent || ""), v = mm ? +mm[1].replace(/,/g, "") : 0; return { c, v, l: labs[c.dataset.k] }; })
      .sort((a, b) => a.l.rank - b.l.rank || b.v - a.v).map(({ c, v, l }) =>
      `<span class="pq${c.classList.contains("on") ? " on" : ""}${c.dataset.k === readK ? " rd" : ""}" data-t="print" data-k="${esc(c.dataset.k)}" title="${esc(typeof prettyPrinting === "function" ? prettyPrinting(c.dataset.k) : c.dataset.k)}${c.dataset.k === readK ? " (the printing the read saw)" : ""}"><b>${esc(pks.length >= 4 && l.t === "Master Ball" ? "Master" : l.t)}</b><i>${v > 0 ? money(v).replace(/\.\d\d$/, (x) => (v >= 10 ? "" : x)) : "–"}</i></span>`).join("") + `</div>` : "";
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
    const miss = notExact(r);
    const fk = card.querySelector('.condgrid a.clink[href*="tcgplayer.com/product/"]'), fpid = fk ? (/\/product\/(\d+)/.exec(fk.href) || [])[1] : "";
    const fo = fpid && FAST_OK[fpid], live = fo ? (fo.ok ? '<i class="ok" title="every condition read from TCGplayer">TCG</i>' : '<i class="no" title="TCGplayer read failed: usual condition shares">TCG</i>') : fpid && FAST_AUTO[Object.keys(FAST_AUTO).find((k) => k.startsWith(fpid + "|")) || ""] ? '<i class="wt" title="reading every condition on TCGplayer">TCG</i>' : "";
    const html =
      `<div class="pc">` +
        `<div class="pimg" data-t="open">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : ""}</div>` +
        `<div class="pmain">` +
          `<div class="pn" data-t="open"><b>${esc(r.n)}</b><span>${esc(r.s)} · #${esc(r.num)}${(r.lang || "en") === "jp" ? " · JP" : ""}${printing && pks.length < 2 ? " · " + esc(printing) : ""}</span></div>` +
          `<div class="ph">` +
            (n > 1 && i >= 0 ? `<span class="st" data-t="prev">&#8249;</span><span class="sn">${i + 1}/${n}</span><span class="st" data-t="next">&#8250;</span>` : "") +
            `<span class="tg">${live || (tag ? `<i>${esc({ "best guess": "guess", "picture": "pic", "auto + picture": "pic ✓" }[tag] || tag)}</i>` : "")}</span>` +
            (PICKED || (fromRead() && !sureCard($("#results .card.autosug")) && MODE === "card") ? `<span class="st" data-t="choices" title="back to the likely cards">&#8801;</span>` : "") +
            `<span class="st" data-t="search" title="search">&#128269;</span>` +
            (MODE !== "card" ? `<span class="st on" data-t="toggle" title="back to the small card">&#9652;</span>` : "") +
          `</div>` +
          (miss ? `<div class="pmiss">${esc(miss)}</div>` : "") +
          `<div class="prow${miss ? " dim" : ""}">` + rows.map((x) =>
            `<span class="pb${x.b ? "" : " wait"}${flash(x.c) ? " fl" : ""}" data-t="bid" data-c="${x.c}"><em style="color:${col(x.c)}">${x.c}</em>` +
            `<b>${esc(flash(x.c) || x.bid)}</b>` +
            `<small><i>mkt</i>${x.mkt > 0 ? money(x.mkt) : "–"}</small><small><i>b/e</i>${esc(beOf(x.mkt))}</small></span>`).join("") +
          `</div>` +
        `</div>` +
      `</div>` + pchips;
    if (el.innerHTML !== html) {
      const pr0 = el.querySelector(".prow"), sx = pr0 ? pr0.scrollLeft : 0, same = el.dataset.id === r.id;
      el.innerHTML = html; el.dataset.id = r.id; wire(el, card);
      const pr1 = el.querySelector(".prow"); if (pr1 && same) pr1.scrollLeft = sx;
      const pp = el.querySelector(".pp"), pon = pp && pp.querySelector(".pq.on");   // the chosen printing stays in sight
      if (pon && (pon.offsetLeft + pon.offsetWidth > pp.scrollLeft + pp.clientWidth || pon.offsetLeft < pp.scrollLeft)) pp.scrollLeft = Math.max(0, pon.offsetLeft - pp.offsetLeft - 4);
    }
    paintStat(); sizeSoon();
  }
  // ---- Chinese card read (Derek, 2026-10-29: "it's not showing me which card it is calculating against; nest the Chinese
  // price in the card art and I select the right one" -> "not every card's Chinese price, once I pick the card"): the
  // small card shows the candidates' pictures; the one Derek taps is looked up alone (that card + its other-language twin,
  // index.html zhCandsOne) and shows its Chinese sales, listings and bid. The bid is sent like the Chinese line's
  // (data-nolabel: the lot is not labeled as the English card at its English price).
  let ZH_PICK = null, ZH_KEY = null;
  const ZH_ONE = {};   // card id -> {res} or {pending}
  const zhActive = () => { const Z = window.ZH_LAST; return !!Z && Date.now() - Z.at < 15 * 60e3; };
  const zhById = (id) => (typeof BY_ID !== "undefined" && BY_ID.get && BY_ID.get(id)) || (typeof CARDS !== "undefined" ? CARDS.find((c) => c.id === id) : null);
  const zm = (v) => (typeof zhMoney === "function" ? zhMoney(v) : money(v));
  function zhBidOf(est) {
    try { const mf = (typeof getNum === "function" ? getNum("tgtmargin", 10) : 10) / 100, np = netProceeds(listSale(est)), b = wholeBid(bidForMargin(est, mf), np); return b >= 1 ? b : 0; } catch (_) { return 0; }
  }
  function zhStart(id) {
    const c = zhById(id); if (!c || (ZH_ONE[id] && (ZH_ONE[id].pending || Date.now() - ZH_ONE[id].at < 10 * 60e3))) return;
    const hit = typeof ZH_CACHE !== "undefined" && ZH_CACHE.get(id);
    if (hit && Date.now() - hit.at < 10 * 60e3) { ZH_ONE[id] = { res: hit.res, at: hit.at }; return; }
    if (typeof zhLookup !== "function" || typeof zhCandsOne !== "function") { ZH_ONE[id] = { res: { ok: false, errs: ["Chinese price not loaded"], hits: [], sold: [] }, at: Date.now() }; return; }
    ZH_ONE[id] = { pending: true, at: Date.now() };
    zhLookup(zhCandsOne(c)).then((res) => { ZH_ONE[id] = { res, at: Date.now() }; try { ZH_CACHE.set(id, { res, at: Date.now() }); } catch (_) {} paintBar(); },
      (e) => { ZH_ONE[id] = { res: { ok: false, errs: [e.message], hits: [], sold: [] }, at: Date.now() }; paintBar(); });
  }
  function paintZh(el, tools) {
    const Z = window.ZH_LAST;
    if (Z.key !== ZH_KEY) { ZH_KEY = Z.key; ZH_PICK = null; }
    const ids = (Z.ids || []).filter((id) => zhById(id));
    const day = (t) => (t ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");
    let html;
    if (ZH_PICK) {
      const c = zhById(ZH_PICK), one = ZH_ONE[ZH_PICK] || {}, res = one.res, img = c && typeof imgOf === "function" ? imgOf(c) : "";
      let body;
      if (!res) body = `<div class="zl"><small>checking Chinese sales and listings for this card…</small></div>`;
      else if (!res.ok) body = `<div class="zl"><small class="bad">Chinese price: ${esc((res.errs || [])[0] || "failed")}</small></div>`;
      else {
        const pk = typeof zhPick === "function" ? zhPick(res) : null, est = pk && pk.use ? (pk.use === "sold" ? pk.sold.est : pk.list.est) : 0, b = est ? zhBidOf(est) : 0;
        body = (pk && pk.sold ? `<div class="zl${pk.use === "sold" ? " on" : ""}"><b>sold ≈ ${zm(pk.sold.est)}</b> <small>${res.sold.slice(0, 3).map((x) => `${zm(x.p)} ${day(x.at)}`).join(" · ")}</small></div>` : `<div class="zl"><small>no Chinese sale in the recent sales</small></div>`) +
          (pk && pk.list ? `<div class="zl${pk.use === "listed" ? " on" : ""}"><b>listed ≈ ${zm(pk.list.est)}</b> <small>${pk.list.all.map(zm).join(" · ")}</small></div>` : `<div class="zl"><small>no Chinese listing right now</small></div>`) +
          (b ? `<div class="zl"><button class="zhb" data-t="zhbid" data-nolabel="1" data-bid="${b}" title="max bid at ${zm(est)} from the ${pk.use === "sold" ? "sales" : "listings"}">bid $${b}</button> <small>from ${zm(est)} ${pk.use}</small></div>` : `<div class="zl"><small>nothing Chinese on TCGplayer for this card</small></div>`);
      }
      html = `<div class="pc"><div class="pimg" data-t="zhback">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : ""}</div><div class="pmain">` +
        `<div class="pn" data-t="zhback"><b>${esc(c ? c.n : ZH_PICK)}</b><span>中 Chinese copy · ${esc(c ? c.s : "")} · #${esc(c ? c.num : "")}${c && (c.lang || "en") === "jp" ? " · JP" : ""}</span></div>` +
        `<div class="ph"><span class="st" data-t="zhback" title="back to the cards">&#8801;</span><span class="tg">${res && res.ok ? `${res.sold.length} sold · ${res.hits.length} listed` : ""}</span>${tools}</div>` +
        body + `</div></div>`;
    } else {
      const items = ids.slice(0, 8).map((id) => {
        const c = zhById(id), img = typeof imgOf === "function" ? imgOf(c) : "";
        return `<span class="pki" data-t="zhpick" data-id="${esc(id)}"><span class="pkim">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : ""}</span>` +
          `<em>${esc(c.n)}</em><small>${esc(c.s)} #${esc(c.num)}${(c.lang || "en") === "jp" ? " JP" : ""}</small></span>`;
      }).join("");
      html = `<div class="pk"><div class="ph"><span class="tg pkh"><b>中 Which card?</b> tap it for its Chinese price</span>${tools}</div><div class="pkrow">${items}</div></div>`;
    }
    if (el.innerHTML !== html) {
      el.innerHTML = html; el.dataset.id = "";
      const on = (t, f) => el.querySelectorAll(`[data-t="${t}"]`).forEach((x) => { x.onclick = (e) => { e.preventDefault(); e.stopPropagation(); touched(); f(x); }; });
      on("zhpick", (x) => { ZH_PICK = x.dataset.id; zhStart(ZH_PICK); paintBar(); });
      on("zhback", () => { ZH_PICK = null; paintBar(); });
      on("zhbid", (x) => { if (typeof copyAmt === "function") copyAmt(x.dataset.bid, x); });
      const sx = el.querySelector('[data-t="search"]'); if (sx) sx.onclick = (e) => { e.preventDefault(); e.stopPropagation(); window.ZH_LAST = null; TOUCH_FIELD_AT = Date.now(); try { A.focus(true); } catch (_) {} setMode("list"); const q = $("#q"); if (q) { q.focus(); q.select(); } };
    }
  }
  window.addEventListener("cardcomp-zh", () => { paintBar(); paintAlerts(); });
  document.addEventListener("input", (e) => { if (e.target && e.target.id === "q" && window.ZH_LAST) { window.ZH_LAST = null; } }, true);   // typing a search leaves the Chinese view

  function paintPicker(el, tools) {
    if (OPENED && OPENED.isConnected && OPENED.classList.contains("open")) { const r0 = OPENED.querySelector(".row"); if (r0) r0.click(); } OPENED = null;
    const list = cands(), g = list.findIndex((c) => c.classList.contains("autosug"));
    const order = g > 0 ? [list[g], ...list.filter((_, i) => i !== g)] : list;   // the best guess first
    const read = (($("#q") || {}).value || "").trim();
    const items = order.slice(0, 10).map((c) => {
      const r = typeof CARDS !== "undefined" ? CARDS.find((x) => x.id === c.dataset.id) : null; if (!r) return "";
      const img = typeof imgOf === "function" ? imgOf(r) : "", m = typeof bestMarket === "function" ? bestMarket(r) : 0;
      return `<span class="pki${c.classList.contains("autosug") ? " g" : ""}" data-t="pick" data-id="${esc(r.id)}">` +
        `<span class="pkim">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : ""}</span>` +
        `<em>${esc(r.n)}</em><small>${esc(r.s)} #${esc(r.num)}</small><small class="pkp">${m > 0 ? money(m) : ""}</small></span>`;
    }).join("");
    const html = `<div class="pk"><div class="ph"><span class="tg pkh"><b>Which card?</b> read ${esc(read)}</span>${tools}</div><div class="pkrow">${items}</div></div>`;
    if (el.innerHTML !== html) {
      el.innerHTML = html; el.dataset.id = "";
      el.querySelectorAll('[data-t="pick"]').forEach((x) => { x.onclick = (e) => { e.preventDefault(); e.stopPropagation(); touched();
        const i = cands().findIndex((c) => c.dataset.id === x.dataset.id); if (i >= 0) { CUR = i; PICKED = true; paintBar(); } }; });
      const sx = el.querySelector('[data-t="search"]'); if (sx) sx.onclick = (e) => { e.preventDefault(); e.stopPropagation(); TOUCH_FIELD_AT = Date.now(); try { A.focus(true); } catch (_) {} setMode("list"); const q = $("#q"); if (q) { q.focus(); q.select(); } };
    }
  }
  function wire(el, card) {
    const on = (t, f) => el.querySelectorAll(`[data-t="${t}"]`).forEach((x) => { x.onclick = (e) => { e.preventDefault(); e.stopPropagation(); f(x); }; });
    on("open", () => { if (MODE !== "card") { setMode("card"); return; } OPENED = null; setMode("list"); });   // keep it open: Derek wants the full grid
    on("print", (x) => {   // the printing chip: picks that printing in the open card; the grid, pills and fast read follow
      touched();
      const c = card && Array.from(card.querySelectorAll(".pchips .pchip")).find((p) => p.dataset.k === x.dataset.k);
      if (c) { USER_PRINT[card.dataset.id] = x.dataset.k; c.click(); paintBar(); }
    });
    on("bid", (x) => {
      touched();
      const b = card && card.querySelector(`.condgrid .bd.cpy[data-cond="${x.dataset.c}"]`);
      if (b) b.click(); else setMode("list");
    });
    on("toggle", () => setMode(MODE === "card" ? "list" : "card"));
    on("choices", () => { touched(); CUR = -1; PICKED = false; paintBar(); });
    // focusable window first: Chromium holds focus events in an unfocused window, so the box would never take the keyboard
    on("search", () => { TOUCH_FIELD_AT = Date.now(); try { A.focus(true); } catch (_) {} setMode("list"); const q = $("#q"); if (q) { q.focus(); q.select(); } });
    const list = cands(), i = list.indexOf(card), n = list.length;
    on("prev", () => { touched(); CUR = (i - 1 + n) % n; paintBar(); });
    on("next", () => { touched(); CUR = (i + 1) % n; paintBar(); });
  }
  // alerts from the lot strip, the only part of it the small card shows: a tagged buyer leading, over your max, priced
  // out (with its "bid $N" button, which taps the strip's own), a late tap
  function paintAlerts() {
    const w = wrap(); if (!w) return;
    const al = w.querySelector("#phonealert"), ls = $("#lotstrip");
    const out = [];
    if (ls && ls.style.display !== "none") {
      for (const el of ls.querySelectorAll("span,div")) {
        const t = (el.childElementCount ? "" : el.textContent || "").replace(/\s+/g, " ").trim();
        if (/^⚠ /.test(t)) out.push(`<span class="na">${esc(t)}</span>`);
        else if (/^over your \$/.test(t) || /^priced out/.test(t)) out.push(`<span>${esc(t)}</span>`);
        else if (/^late tap/.test(t)) out.push(`<span class="na">late tap: counted for the card that just sold</span>`);
      }
      if (ls.querySelector(".lotnudge")) out.push(`<button data-t="nudge">${esc(ls.querySelector(".lotnudge").textContent.trim())}</button>`);
    }
    // Chinese card read: the Chinese copy price from the auto line (sold / listed average) with its bid, on the small card
    const am = $("#automsg"), zh = am && am.querySelector(".zhauto");
    if (window.ZH_LAST) { /* the small card shows each candidate with its own Chinese price (paintZh) */ }
    else if (zh) {
      const zb = zh.querySelector(".zhbid"), txt = (zh.textContent || "").replace(zb ? zb.textContent : "", "").replace(/\s+/g, " ").trim();
      out.push(`<div class="pzh"><span>中 ${esc(txt)}</span>${zb ? `<button data-t="zhbid">${esc(zb.textContent.trim())}</button>` : ""}</div>`);
    } else if (am && /chinese/i.test(am.textContent || "") && typeof window.zhLookup === "function" && fromRead()) out.push(`<div class="pzh"><span>中 Chinese card: checking Chinese copy prices on TCGplayer…</span></div>`);
    const html = [...new Set(out)].join("");
    if (al.innerHTML !== html) {
      al.innerHTML = html;
      const b = al.querySelector('[data-t="nudge"]'); if (b) b.onclick = (e) => { e.preventDefault(); touched(); const n = $("#lotstrip .lotnudge"); if (n) n.click(); };
      const zb = al.querySelector('[data-t="zhbid"]'); if (zb) zb.onclick = (e) => { e.preventDefault(); touched(); const o = $("#automsg .zhauto .zhbid"); if (o) o.click(); };
      sizeSoon();
    }
  }
  { const ls = $("#lotstrip"); if (ls) new MutationObserver(() => paintAlerts()).observe(ls, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["style"] }); }
  // the auto line is rebuilt on every paint (#automsg is replaced): watch its container, which auto-ui creates once
  { const watchLine = () => { const al = $("#autoline"); if (!al) return setTimeout(watchLine, 1000); new MutationObserver(() => paintAlerts()).observe(al, { childList: true, subtree: true, characterData: true }); paintAlerts(); }; watchLine(); }

  // status line under the card: what was read and how sure ("read Ralts · reverse holo → 3 of 27, no number"), and the frame
  function paintStat() {
    const w = wrap(); if (!w) return;
    const st = w.querySelector("#phonestat"), am = $("#automsg");
    let t = am ? am.textContent.replace(/\s+/g, " ").trim() : "";
    t = t.replace(/^read now: /, "").replace(/^press read.*$/, "").replace(/^waiting for the next lot$/, "");
    const b00 = am && am.querySelector(".bad");
    // the small card shows only what needs attention: a read in progress, no card seen, or an error; the full view shows all of it
    if (MODE === "card" && !/^(reading|no card)/i.test(t) && !(b00 && b00.textContent.trim() === (am.textContent || "").trim())) t = "";
    const b0 = am && am.querySelector(".bad"), bad = b0 && b0.textContent.trim() === am.textContent.trim();   // red only when the whole line is an error
    let html = t ? (bad ? `<span class="bad">${esc(t)}</span>` : esc(t)) + (P.lastFrame ? ' · <a class="fr" href="#">frame</a>' : "") : "";
    if (NOTE && NOTE.until > Date.now()) html = `<span class="bad">${esc(NOTE.txt)}</span>`;
    if (st.innerHTML !== html) st.innerHTML = html;   // only on change: this runs from a body observer
  }
  // the Custom sheet result from the app: {ok} entered (Derek presses Submit), {why:"under", min}, {why:"sold"}, or why it could not
  let NOTE = null;   // {txt, until}: a short message on the small card (why the Custom fill did not happen)
  P.bidAck = function (r) {
    r = r || {}; toApp(Object.assign({ type: "cardcomp-bid-ack" }, r)); flashBid(r);
    if (!r.ok && r.why && !/^(copied|under|sold)$/.test(r.why)) { NOTE = { txt: "Custom box: " + r.why + " (bid copied, paste it)", until: Date.now() + 9000 }; paintStat(); sizeSoon(); setTimeout(() => { paintStat(); sizeSoon(); }, 9100); }
    // the sheet's Max Bid switch is off: Submit would place the whole amount as an exact bid at once, not a max
    if (r.ok && r.exact) { NOTE = { txt: "Max Bid is OFF in Whatnot: Submit places an exact bid of the full amount. Turn Max Bid on first.", until: Date.now() + 9000 }; paintStat(); sizeSoon(); setTimeout(() => { paintStat(); sizeSoon(); }, 9100); }
  };
  function flashBid(r) {
    const txt = r && r.ok ? "in Whatnot ✓" : r && r.why === "under" && r.min ? "need $" + r.min : r && r.why === "sold" ? "sold" : "copied ✓";
    if (r && !r.ok && r.why && !/^(copied|under|sold)$/.test(r.why)) log("custom fill: " + r.why);
    FLASH = { txt, cond: (typeof LAST_TAP !== "undefined" && LAST_TAP && LAST_TAP.cond) || "NM", until: Date.now() + 2500 }; paintBar(); setTimeout(paintBar, 2600);
  }
  let barTimer = 0;
  const results = $("#results");
  const mo = new MutationObserver((recs) => {
    if (recs.some((x) => x.type === "childList" && x.target === results)) { CUR = -1; OPENED = null; PICKED = false; }   // new results: back to the best guess / the picker
    clearTimeout(barTimer); barTimer = setTimeout(paintBar, 120);
  });
  if (results) mo.observe(results, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  let statT = 0;
  new MutationObserver(() => { clearTimeout(statT); statT = setTimeout(() => { paintStat(); sizeSoon(); }, 80); })
    .observe(document.body, { childList: true, subtree: true, characterData: true });
  { const ls = $("#lotstats"); if (ls) new MutationObserver(() => { if (getComputedStyle(ls).display !== "none" && MODE === "card") setMode("list"); }).observe(ls, { attributes: true, attributeFilter: ["style", "class"] }); }
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
