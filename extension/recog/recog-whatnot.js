// RECOG experiment, page half (docs/auto-recognition-handoff.md). Removed by scripts/strip-recog.js.
// Finds the stream's <video>, copies its current frame, and shows the capture check result in a toast.
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
  function grab() {
    const all = document.querySelectorAll("video").length, v = streamVideo();
    if (!v) return { ok: false, why: all ? all + " video element(s), none showing a picture" : "no <video> on the page", video: { count: all, canvases: document.querySelectorAll("canvas").length } };
    const r = v.getBoundingClientRect();
    const rect = { x: r.left, y: r.top, w: r.width, h: r.height, iw: innerWidth, ih: innerHeight };
    const video = { count: all, vw: v.videoWidth, vh: v.videoHeight, shown: Math.round(r.width) + "x" + Math.round(r.height), fit: getComputedStyle(v).objectFit, src: (v.currentSrc || "").slice(0, 48) };
    try {
      const k = Math.min(1, 1000 / Math.max(v.videoWidth, v.videoHeight)), w = Math.round(v.videoWidth * k), h = Math.round(v.videoHeight * k);
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      const g = c.getContext("2d"); g.drawImage(v, 0, 0, w, h);
      const img = c.toDataURL("image/jpeg", 0.85);   // throws SecurityError when the stream is cross-origin without CORS
      const d = g.getImageData(0, 0, w, h).data; let s = 0, n = 0;
      for (let i = 0; i < d.length; i += 64) { s += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; n++; }
      return { ok: true, img, w, h, luma: Math.round(s / n), video, rect };
    } catch (e) {
      return { ok: false, why: e && e.name === "SecurityError" ? "stream is cross-origin (canvas blocked)" : String(e && e.message || e), video, rect };
    }
  }

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
    if (msg.type === "recog-grab") { reply(grab()); return; }
    if (msg.type === "recog-grab-result") {
      if (msg.ok) show(`Frame grabbed by ${msg.method === "video" ? "video copy" : "screenshot"}: ${msg.w}x${msg.h}, ${msg.kb} KB, ${msg.ms} ms.` +
        (msg.luma < 12 ? "\nWarning: the frame is black (protected video?)." : "") + "\nChecking automatic capture in 5 s...", msg.luma >= 12);
      else show("Could not grab a frame.\n" + (msg.tries || []).join("\n"), false);
    }
    if (msg.type === "recog-later-result") show(msg.ok ? "Automatic capture works: " + msg.later.replace(/^ok /, "") + ".\nResults: extension Options > Recognition test page." : "Automatic capture " + msg.later, msg.ok);
  });
})();
