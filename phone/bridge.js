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
  const VER = "0.8.0";          // bridge version (the app's loader runs the live site's copy when it is newer than its own)
  const PHONE_API = 5;          // the native Bridge this needs (OverlayService.NATIVE_API): img, copy, size, collapse
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
    FRAMES.set(String(p.src === "auto" && lot ? lot.startedAt : p.at), { img, box: null, at: Date.now() });   // the picture match ranks this frame (box once the reply names it)
    for (const [k, f] of FRAMES) if (Date.now() - f.at > 5 * 60e3) FRAMES.delete(k);
    const c = cfg(), modelKey = c.model || "sonnet", key = p.at;   // keyed by press time, like the extension's read now
    const auto = p.src === "auto", lk = auto && lot ? lot.startedAt : key;   // an automatic read belongs to its lot (auto-ui keys readings by lot)
    const head = { type: "cardcomp-auto", key: lk, n: 1, capAt: key, title: auto && lot ? lot.title : "", seller: auto ? SELLER : "", pre: false, manual: !auto };
    if (!(await loadReader())) { toApp(Object.assign(head, { error: "reader not loaded (extension/recog/recog-read.js)" })); return; }
    let apiKey = ""; try { apiKey = A.key("anthropic") || ""; } catch (_) {}
    if (!apiKey) { toApp(Object.assign(head, { error: "no API key: add it in the CardComp app" })); return; }
    const short = Math.min(w || 0, h || 0);
    const res = await recogRead(img, modelKey, apiKey, (read, ms) =>
      toApp(Object.assign({}, head, { partial: true, read, ms, model: RECOG_MODELS[modelKey] || "", short })));
    if (res.read && Array.isArray(res.read.box)) { const f = FRAMES.get(String(lk)); if (f) f.box = res.read.box; }   // before the app asks for the picture match
    toApp(Object.assign({}, head, { read: res.read || null, error: res.error || "", model: res.model || "", ms: res.ms || 0, cost: res.cost || 0, short }));
    log({ read: res.read || null, error: res.error || "", ms: res.ms, cost: res.cost, src: p.src });
    if (!auto || MODE === "card") setMode("card", true);   // the compact card shows the best guess (an automatic read never closes the full view)
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
    const sheet = it.find((x) => /^submit max bid$/i.test(x.t));
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
  function endLot(st) {
    if (!lot || lot.ended) return;
    lot.ended = true;
    if (st.cur == null && st.bids == null) { sendApp({ type: "cardcomp-lot-end", rec: { empty: true, at: Date.now() } }); return; }
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
  const FAST_OK = {};   // product id -> {ok, at}: the last fast read of it
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
    if (changed || show) { try { A.layout(m); } catch (_) {} }
    if (m === "card") window.scrollTo(0, 0);
    if (m === "list") setTimeout(() => { const o = $("#results .card.open"); if (o) o.scrollIntoView({ block: "start" }); }, 60);
    paintBar(); sizeSoon();
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
    "body.ph-card .searchrow{padding-bottom:0!important}body.ph-card{overflow:hidden}body.ph-card .searchrow>*:not(#phonecard){display:none!important}" +
    "#phonealert{font-size:10.5px;line-height:1.3;color:var(--red);display:flex;flex-wrap:wrap;align-items:center;gap:2px 8px;padding:1px 0}#phonealert:empty{display:none}" +
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
    "#phonebar .pmiss{font-size:10.5px;color:var(--red);line-height:1.2;margin:1px 0}" +
    // condition pills: a sideways scroller, about two at a time; swipe for MP / HP / DMG
    "#phonebar .prow{display:flex;gap:5px;margin-top:3px;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;-webkit-overflow-scrolling:touch;padding-bottom:1px}" +
    "#phonebar .prow::-webkit-scrollbar{display:none}" +
    "#phonebar .pb{flex:0 0 44%;scroll-snap-align:start;display:flex;flex-direction:column;align-items:center;justify-content:center;height:46px;border:1.5px solid var(--gold);border-radius:8px;background:rgba(245,179,1,.10);line-height:1.05}" +
    "#phonebar .pb em{font-style:normal;font-size:10px;font-weight:700}" +
    "#phonebar .pb b{font-size:17px;font-weight:800;color:var(--gold);font-variant-numeric:tabular-nums;white-space:nowrap}" +
    "#phonebar .pb small{font-size:9.5px;color:var(--dim);font-variant-numeric:tabular-nums;white-space:nowrap}" +
    "#phonebar .prow.dim .pb{opacity:.45;border-style:dashed}#phonebar .pb.wait{opacity:.55}#phonebar .pb.fl{background:var(--green);border-color:var(--green)}#phonebar .pb.fl b{color:#000;font-size:12px}#phonebar .pb.fl em,#phonebar .pb.fl small{color:#000!important}" +
    "#phonebar .pe{display:flex;align-items:center;gap:8px;padding:6px 0}#phonebar .pe>div:first-child{flex:1;min-width:0}" +
    "#phonebar .pe b{font-size:14px}#phonebar .pe span{display:block;font-size:12px;color:var(--dim);line-height:1.35}#phonebar .ptools{display:flex;gap:6px}" +
    "#phonestat{font-size:10.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:1px 0 2px;cursor:pointer}#phonestat:empty{display:none}#phonestat a{color:var(--blue)}#phonestat .bad{color:var(--red)}";
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
    wrapEl.innerHTML = '<div id="phonebar"></div><div id="phonealert"></div><div id="phonestat"></div>';
    sr.insertBefore(wrapEl, sr.firstChild);
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
    const miss = notExact(r);
    const fk = card.querySelector('.condgrid a.clink[href*="tcgplayer.com/product/"]'), fpid = fk ? (/\/product\/(\d+)/.exec(fk.href) || [])[1] : "";
    const fo = fpid && FAST_OK[fpid], live = fo ? (fo.ok ? '<i class="ok" title="every condition read from TCGplayer">TCG</i>' : '<i class="no" title="TCGplayer read failed: usual condition shares">TCG ✗</i>') : fpid && FAST_AUTO[Object.keys(FAST_AUTO).find((k) => k.startsWith(fpid + "|")) || ""] ? '<i class="wt" title="reading every condition on TCGplayer">TCG</i>' : "";
    const html =
      `<div class="pc">` +
        `<div class="pimg" data-t="open">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : ""}</div>` +
        `<div class="pmain">` +
          `<div class="pn" data-t="open"><b>${esc(r.n)}</b><span>${esc(r.s)} · #${esc(r.num)}${(r.lang || "en") === "jp" ? " · JP" : ""}${printing ? " · " + esc(printing) : ""}</span></div>` +
          `<div class="ph">` +
            (n > 1 && i >= 0 ? `<span class="st" data-t="prev">&#8249;</span><span class="sn">${i + 1}/${n}</span><span class="st" data-t="next">&#8250;</span>` : "") +
            `<span class="tg">${live || (tag ? `<i>${esc({ "best guess": "guess", "picture": "pic", "auto + picture": "pic ✓" }[tag] || tag)}</i>` : "")}</span>` +
            `<span class="st" data-t="search" title="search">&#128269;</span>` +
            (MODE !== "card" ? `<span class="st on" data-t="toggle" title="back to the small card">&#9652;</span>` : "") +
          `</div>` +
          (miss ? `<div class="pmiss">${esc(miss)}</div>` : "") +
          `<div class="prow${miss ? " dim" : ""}">` + rows.map((x) =>
            `<span class="pb${x.b ? "" : " wait"}${flash(x.c) ? " fl" : ""}" data-t="bid" data-c="${x.c}"><em style="color:${col(x.c)}">${x.c}</em>` +
            `<b>${esc(flash(x.c) || x.bid)}</b><small>${x.mkt > 0 ? money(x.mkt) : "–"}</small></span>`).join("") +
          `</div>` +
        `</div>` +
      `</div>`;
    if (el.innerHTML !== html) {
      const pr0 = el.querySelector(".prow"), sx = pr0 ? pr0.scrollLeft : 0, same = el.dataset.id === r.id;
      el.innerHTML = html; el.dataset.id = r.id; wire(el, card);
      const pr1 = el.querySelector(".prow"); if (pr1 && same) pr1.scrollLeft = sx;
    }
    paintStat(); sizeSoon();
  }
  function wire(el, card) {
    const on = (t, f) => el.querySelectorAll(`[data-t="${t}"]`).forEach((x) => { x.onclick = (e) => { e.preventDefault(); e.stopPropagation(); f(x); }; });
    on("open", () => { if (MODE !== "card") { setMode("card"); return; } OPENED = null; setMode("list"); });   // keep it open: Derek wants the full grid
    on("bid", (x) => {
      touched();
      const b = card && card.querySelector(`.condgrid .bd.cpy[data-cond="${x.dataset.c}"]`);
      if (b) b.click(); else setMode("list");
    });
    on("toggle", () => setMode(MODE === "card" ? "list" : "card"));
    on("search", () => { TOUCH_FIELD_AT = Date.now(); setMode("list"); const q = $("#q"); if (q) { q.focus(); q.select(); } });
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
    const html = [...new Set(out)].join("");
    if (al.innerHTML !== html) {
      al.innerHTML = html;
      const b = al.querySelector('[data-t="nudge"]'); if (b) b.onclick = (e) => { e.preventDefault(); touched(); const n = $("#lotstrip .lotnudge"); if (n) n.click(); };
      sizeSoon();
    }
  }
  { const ls = $("#lotstrip"); if (ls) new MutationObserver(() => paintAlerts()).observe(ls, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["style"] }); }

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
  };
  function flashBid(r) {
    const txt = r && r.ok ? "in Whatnot ✓" : r && r.why === "under" && r.min ? "need $" + r.min : r && r.why === "sold" ? "sold" : "copied ✓";
    if (r && !r.ok && r.why && !/^(copied|under|sold)$/.test(r.why)) log("custom fill: " + r.why);
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
