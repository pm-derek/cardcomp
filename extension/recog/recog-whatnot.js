// RECOG experiment, page half (docs/auto-recognition-handoff.md). Removed by scripts/strip-recog.js.
// Finds the stream's <video> and copies its current frame:
//   - auto mode (switch in the CardComp panel): before the timer, when a new card holds still (scene watcher);
//     else ~1 s after the lot's timer starts. Full resolution, to recog-bg.js
//   - read now: CardComp's read button / right-click / ` key, or Ctrl+Shift+Y on the Whatnot tab
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
  // on = auto mode (the watcher reads lots by itself); canRead = manual or auto (read now works)
  let on = false, canRead = false, MODE_S = {};
  const setMode = () => { const m = ["off", "manual", "auto"].includes(MODE_S.recogMode) ? MODE_S.recogMode : MODE_S.recogOn ? "auto" : "off"; on = m === "auto"; canRead = m !== "off"; };
  try {
    chrome.storage.local.get(["recogOn", "recogMode"], (r) => { MODE_S = r || {}; setMode(); });
    chrome.storage.onChanged.addListener((c, area) => { if (area !== "local") return; if (c.recogOn) MODE_S.recogOn = c.recogOn.newValue; if (c.recogMode) MODE_S.recogMode = c.recogMode.newValue; setMode(); });
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
  const MANUAL = {};   // lot key -> time of a "read now" during that lot: no automatic read after it
  function sendFrame(key, n) {
    const lot = lots.get(key);
    if (!on || !lot || lot.ended || MANUAL[key]) return;
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
  const CHANGE = 14, CHANGE_PEAK = 70, STILL = 8, SAME = 40, REUSE = 30;
  const SETTLE_MS = 3500, STEADY = 14;   // a card held in a moving hand never goes fully still: read it anyway after 3.5 s if roughly steady
  const PRE_MAX = 2, PRE_GAP_MS = 3000;      // pre-start reads per gap between lots, and the minimum spacing
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
  let lastSt = null, lastLot = null, prevT = null, moved = 0, still = 0, REF = null, PRE = { at: 0, n: 0, last: 0, thumb: null, lot: null };
  // Live = the timer is counting down. Whatnot can show a lot's timer before the auction starts; a timer that has
  // not changed for 2.5 s is not live, so the watcher keeps looking for the card (Derek: "no reads before the timer").
  const TM = { lot: null, val: null, at: 0 };
  const running = () => TM.at > 0 && Date.now() - TM.at < 2500 && (TM.val || 0) > 0;
  const live = (st, lot) => !!(st && lot && !lot.ended && !st.ended && !st.sold && !st.waiting && running());
  let WATCH = { phase: "", why: "", mean: 0, peak: 0, at: 0 };
  function status(phase, why, m, pk) {
    WATCH = { phase, why, mean: Math.round(m || 0), peak: Math.round(pk || 0), at: Date.now() };
  }
  // what the watcher is doing, for the auto line in CardComp: checked every 2 s, sent when the words change (or every
  // 20 s), not every 2 s to every CardComp copy
  let watchSent = "", watchAt = 0;
  setInterval(() => {
    if (!on) return;
    const k = WATCH.phase + "|" + WATCH.why;
    if (k === watchSent && Date.now() - watchAt < 20000) return;
    watchSent = k; watchAt = Date.now();
    try { chrome.runtime.sendMessage(Object.assign({ type: "cardcomp-auto-watch" }, WATCH, { hidden: document.hidden }), () => chrome.runtime.lastError); } catch (_) {}
  }, 2000);
  function readNow(trigger, t, vsRef) {
    t = t || thumb();
    // "read now" while a lot is running: it is that lot's reading, and replaces any automatic one still to come
    if (trigger === "manual" && lastLot && !lastLot.ended && (live(lastSt, lastLot) || lots.has(lastLot.startedAt))) {
      const k = lastLot.startedAt; MANUAL[k] = Date.now(); lots.set(k, lastLot);
      REF = t; moved = 0; still = 0;
      post(k, 9, { title: lastLot.title || "", sinceStart: Date.now() - k, trigger });
      status("read now", "you asked");
      return;
    }
    const key = Date.now();
    PRE = { at: key, n: PRE.n + 1, last: key, thumb: t, lot: lastLot && lastLot.startedAt, manual: trigger === "manual" };
    REF = t; moved = 0; still = 0;
    post(key, 1, { title: "", sinceStart: 0, trigger, diff: vsRef == null ? null : Math.round(vsRef) });
    status(trigger === "manual" ? "read now" : "reading", trigger === "manual" ? "you asked" : "new card held up");
  }
  setInterval(() => {
    if (!on) return;
    if (document.hidden) { prevT = null; still = 0; status("paused", "Whatnot tab hidden"); return; }
    if (live(lastSt, lastLot)) { prevT = null; still = 0; status("live", "timer running: reads at the start"); return; }
    const t = thumb(); if (!t) { status("off", streamVideo() ? "video cannot be copied" : "no video"); return; }
    const step = diff(t, prevT), stepPeak = peak(t, prevT); prevT = t;
    if (step > CHANGE || stepPeak > CHANGE_PEAK) { if (!moved) moved = Date.now(); still = 0; status("watching", "picture changing", step, stepPeak); return; }
    if (step < STILL) still++; else still = 0;
    const vsRef = peak(t, REF);
    if (!moved && REF) { status("watching", "same picture as the last read", step, vsRef); return; }
    const settled = still >= 1 || (moved && Date.now() - moved > SETTLE_MS && step < STEADY);
    if (!settled) { status("watching", "waiting for the card to hold still", step, vsRef); return; }
    if (vsRef < SAME) { moved = 0; status("watching", "same card as the last read", step, vsRef); return; }
    if (PRE.n >= PRE_MAX) { status("watching", PRE_MAX + " reads this gap already", step, vsRef); return; }
    if (Date.now() - PRE.last < PRE_GAP_MS) { status("watching", "just read", step, vsRef); return; }
    readNow("pre", t, vsRef);
  }, TICK_MS);

  // A lot goes live when its timer is running. Already read before the start and the picture has not changed:
  // reuse that reading. Else one frame ~1 s later, while the seller holds the card up.
  window.__recogTick = (st, lot) => {
    const wasLive = live(lastSt, lastLot);
    if (lot && TM.lot !== lot.startedAt) { TM.lot = lot.startedAt; TM.val = secs(st.timer); TM.at = 0; }   // new lot: its timer must move to count
    else { const v = secs(st.timer); if (v != null && TM.val != null && v !== TM.val) TM.at = Date.now(); TM.val = v; }
    lastSt = st; lastLot = lot;
    // lot over, or a new lot object (a seller whose timer is never read still gets a fresh pre-start allowance)
    if (wasLive && !live(st, lot)) PRE = { at: 0, n: 0, last: PRE.last, thumb: null, lot: lot && lot.startedAt };
    else if (lot && PRE.lot !== lot.startedAt) { PRE.n = 0; PRE.lot = lot.startedAt; }   // a new lot: fresh pre-start allowance, keep a recent read for reuse
    // manual mode: nothing automatic, but a read-now made before the timer still becomes that lot's reading
    if (!(on || (canRead && PRE.manual && PRE.at)) || !lot || lots.has(lot.startedAt) || !live(st, lot)) return;
    lots.set(lot.startedAt, lot);
    if (lots.size > 50) lots.delete(lots.keys().next().value);
    const now = thumb(), d = peak(now, PRE.thumb);
    const reuse = PRE.manual ? d < SAME && Date.now() - PRE.at < 60000 : d < REUSE && Date.now() - PRE.at < 10000;
    if (PRE.at && reuse) {
      try { chrome.runtime.sendMessage({ type: "recog-adopt", from: PRE.at, to: lot.startedAt, title: lot.title || "", diff: Math.round(d) }, () => chrome.runtime.lastError); } catch (_) {}
      PRE = { at: 0, n: 0, last: PRE.last, thumb: null, lot: lot.startedAt };
      MANUAL[lot.startedAt] = Date.now();   // reused: no automatic read for this lot (also blocks the 2nd-frame retry)
      return;
    }
    if (!on) return;   // manual mode: the card changed since the read-now, so no reading for this lot unless asked
    setTimeout(() => { sendFrame(lot.startedAt, 1); PRE = { at: 0, n: 0, last: PRE.last, thumb: null, lot: lot.startedAt }; }, 600);   // live is seen ~1 s after the timer starts (it must tick once)
  };

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg) return;
    if (msg.type === "recog-grab-again") { sendFrame(msg.key, msg.n || 2); return; }
    if (msg.type === "recog-read-now") { if (canRead) readNow("manual"); reply({ ok: canRead }); return; }   // "read now" button / hotkey
  });
})();
