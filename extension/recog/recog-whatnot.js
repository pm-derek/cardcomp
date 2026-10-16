// RECOG experiment, page half (docs/auto-recognition-handoff.md). Removed by scripts/strip-recog.js.
// Finds the stream's <video> and copies its current frame:
//   - auto mode (switch in the CardComp panel): before the timer, when a new card holds still (scene watcher);
//     else ~1 s after the lot's timer starts. Full resolution, to recog-bg.js
//   - capture check: on the shortcut / right-click, then shows the result in a toast
// whatnot.js calls window.__recogTick(state, lot) on every lot read (one line tagged RECOG there); content
// scripts of one extension share a window, and without this file the call is skipped.
(() => {
  function streamVideo() {
    let best = null, area = 0;
    for (const v of document.querySelectorAll("video")) {
      if (!v.videoWidth) continue;
      const r = v.getBoundingClientRect();
      const a = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (a > area) { best = v; area = a; }
    }
    return best;
  }
  function grab(maxEdge) {
    const all = document.querySelectorAll("video").length, v = streamVideo();
    if (!v) return { ok: false, why: all ? all + " video element(s), none showing a picture" : "no <video> on the page", video: { count: all, canvases: document.querySelectorAll("canvas").length } };
    const r = v.getBoundingClientRect();
    const rect = { x: r.left, y: r.top, w: r.width, h: r.height, iw: innerWidth, ih: innerHeight };
    const video = { count: all, vw: v.videoWidth, vh: v.videoHeight, shown: Math.round(r.width) + "x" + Math.round(r.height), fit: getComputedStyle(v).objectFit, src: (v.currentSrc || "").slice(0, 48) };
    try {
      const k = Math.min(1, maxEdge / Math.max(v.videoWidth, v.videoHeight)), w = Math.round(v.videoWidth * k), h = Math.round(v.videoHeight * k);
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      const g = c.getContext("2d"); g.drawImage(v, 0, 0, w, h);
      const img = c.toDataURL("image/jpeg", 0.88);   // throws SecurityError when the stream is cross-origin without CORS
      const d = g.getImageData(0, 0, w, h).data; let s = 0, n = 0;
      for (let i = 0; i < d.length; i += 64) { s += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; n++; }
      return { ok: true, img, w, h, luma: Math.round(s / n), video, rect };
    } catch (e) {
      return { ok: false, why: e && e.name === "SecurityError" ? "stream is cross-origin (canvas blocked)" : String(e && e.message || e), video, rect };
    }
  }

  // ---------- auto mode
  let on = false;
  try {
    chrome.storage.local.get("recogOn", (r) => { on = !!(r && r.recogOn); });
    chrome.storage.onChanged.addListener((c, area) => { if (area === "local" && c.recogOn) on = !!c.recogOn.newValue; });
  } catch (_) {}
  const lots = new Map();   // lot.startedAt -> lot (whatnot.js's live object: .ended flips when it sells)
  const secs = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
  const seller = () => (typeof sellerName === "function" ? (() => { try { return sellerName(); } catch (_) { return ""; } })() : "");
  function post(key, n, extra) {
    const g = grab(1920);
    const msg = Object.assign({ type: "recog-frame", key, n, capAt: Date.now(), url: location.href, seller: seller(),
      ok: g.ok, why: g.why || "", img: g.img || "", w: g.w || 0, h: g.h || 0, luma: g.luma, video: g.video, rect: g.rect }, extra);
    try { chrome.runtime.sendMessage(msg, () => chrome.runtime.lastError); } catch (_) {}
  }
  function sendFrame(key, n) {
    const lot = lots.get(key);
    if (!on || !lot || lot.ended) return;
    post(key, n, { title: lot.title || "", sinceStart: Date.now() - key, trigger: "start", afterPre: !!PRE.at });
    REF = thumb() || REF;
  }

  // ---------- scene watcher: read a card shown before the timer starts (Derek, 2026-10: short / sudden-death
  // timers leave no time). Between lots, a 32x40 grayscale thumbnail of the middle of the video every 0.7 s (no API call).
  // When the picture changes and then holds still ~1.5 s, and it does not look like the last card read, that
  // frame is read. At timer start, if nothing changed since that read, the reading is reused for the lot.
  // The middle of the frame (where a card is held up), not the whole picture: on a 720p stream a card is a small
  // part of the frame, and a whole-frame thumbnail saw a new card in the same sleeve as "no change" (Derek, live).
  const TW = 32, TH = 40, TICK_MS = 700, CX = 0.2, CY = 0.15, CW = 0.6, CH = 0.75;
  // Two measures, 0-255: "mean" = average difference (is the picture still?), "peak" = average of the 15% most
  // changed pixels (did the card change?). A small card swapped in the same spot moves the mean by a few points but
  // the peak by 80+. Tune from the "diff" stored on each pre-start read.
  const CHANGE = 14, CHANGE_PEAK = 70, STILL = 5, SAME = 40, REUSE = 30;
  const PRE_MAX = 4, PRE_GAP_MS = 3000;      // pre-start reads per gap between lots, and the minimum spacing
  let tc = null;
  function thumb() {
    const v = streamVideo(); if (!v) return null;
    try {
      if (!tc) { tc = document.createElement("canvas"); tc.width = TW; tc.height = TH; }
      const g = tc.getContext("2d", { willReadFrequently: true }); g.drawImage(v, v.videoWidth * CX, v.videoHeight * CY, v.videoWidth * CW, v.videoHeight * CH, 0, 0, TW, TH);
      const d = g.getImageData(0, 0, TW, TH).data, out = new Uint8Array(TW * TH);
      for (let i = 0, j = 0; i < d.length; i += 4, j++) out[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
      return out;
    } catch (_) { return null; }   // cross-origin stream: no watcher, lot-start reads still work by screenshot
  }
  const diff = (a, b) => { if (!a || !b) return 255; let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
  const peak = (a, b) => {
    if (!a || !b) return 255;
    const d = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) d[i] = Math.abs(a[i] - b[i]);
    d.sort(); const k = Math.max(1, Math.round(d.length * 0.15)); let s = 0; for (let i = d.length - k; i < d.length; i++) s += d[i];
    return s / k;
  };
  let lastSt = null, lastLot = null, prevT = null, moved = false, still = 0, REF = null, PRE = { at: 0, n: 0, last: 0, thumb: null };
  const live = (st, lot) => !!(st && lot && !lot.ended && !st.ended && !st.sold && !st.waiting && (secs(st.timer) || 0) > 0);
  setInterval(() => {
    if (!on || document.hidden || live(lastSt, lastLot)) { prevT = null; still = 0; return; }
    const t = thumb(); if (!t) return;
    const step = diff(t, prevT), stepPeak = peak(t, prevT); prevT = t;
    if (step > CHANGE || stepPeak > CHANGE_PEAK) { moved = true; still = 0; return; }
    if (step < STILL) still++; else still = 0;
    if (still < 2) return;
    const vsRef = peak(t, REF);
    if (!moved && REF) return;                       // nothing new since the last read
    moved = false;
    if (vsRef < SAME) return;                        // the same card as last read (seller still holding the sold card)
    if (PRE.n >= PRE_MAX || Date.now() - PRE.last < PRE_GAP_MS) return;
    const key = Date.now();
    PRE = { at: key, n: PRE.n + 1, last: key, thumb: t };
    REF = t;
    post(key, 1, { title: "", sinceStart: 0, trigger: "pre", diff: Math.round(vsRef) });
  }, TICK_MS);

  // A lot goes live when its timer is running. Already read before the start and the picture has not changed:
  // reuse that reading. Else one frame ~1 s later, while the seller holds the card up.
  window.__recogTick = (st, lot) => {
    const wasLive = live(lastSt, lastLot);
    lastSt = st; lastLot = lot;
    if (wasLive && !live(st, lot)) PRE = { at: 0, n: 0, last: PRE.last, thumb: null };   // lot over: a new gap begins
    if (!on || !lot || lots.has(lot.startedAt) || !live(st, lot)) return;
    lots.set(lot.startedAt, lot);
    if (lots.size > 50) lots.delete(lots.keys().next().value);
    const now = thumb(), d = peak(now, PRE.thumb);
    if (PRE.at && d < REUSE && Date.now() - PRE.at < 10000) {
      try { chrome.runtime.sendMessage({ type: "recog-adopt", from: PRE.at, to: lot.startedAt, title: lot.title || "", diff: Math.round(d) }, () => chrome.runtime.lastError); } catch (_) {}
      PRE = { at: 0, n: 0, last: PRE.last, thumb: null };
      return;
    }
    setTimeout(() => { sendFrame(lot.startedAt, 1); PRE = { at: 0, n: 0, last: PRE.last, thumb: null }; }, 1000);
  };

  // ---------- capture check toast
  let el = null, timer = null;
  function show(text, good) {
    if (!el) {
      el = document.createElement("div");
      el.style.cssText = "position:fixed;bottom:16px;left:16px;z-index:2147483647;max-width:440px;padding:9px 13px;border-radius:8px;" +
        "font:13px/1.45 system-ui,sans-serif;background:#0b0d10;color:#e8edf2;border:1px solid #4a90d9;box-shadow:0 4px 18px rgba(0,0,0,.5);white-space:pre-line";
      document.documentElement.appendChild(el);
    }
    el.style.borderColor = good ? "#4a90d9" : "#ff6b6b";
    el.textContent = "Recognition test\n" + text;
    clearTimeout(timer); timer = setTimeout(() => { if (el) el.remove(); el = null; }, 12000);
  }

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg) return;
    if (msg.type === "recog-grab") { reply(grab(1000)); return; }
    if (msg.type === "recog-grab-again") { sendFrame(msg.key, msg.n || 2); return; }
    if (msg.type === "recog-grab-result") {
      if (msg.ok) show(`Frame grabbed by ${msg.method === "video" ? "video copy" : "screenshot"}: ${msg.w}x${msg.h}, ${msg.kb} KB, ${msg.ms} ms.` +
        (msg.luma < 12 ? "\nWarning: the frame is black (protected video?)." : "") + "\nChecking automatic capture in 5 s...", msg.luma >= 12);
      else show("Could not grab a frame.\n" + (msg.tries || []).join("\n"), false);
    }
    if (msg.type === "recog-later-result") show(msg.ok ? "Automatic capture works: " + msg.later.replace(/^ok /, "") + ".\nResults: extension Options > Recognition test page." : "Automatic capture " + msg.later, msg.ok);
  });
})();
