// RECOG experiment, background half (docs/auto-recognition-handoff.md). Removed by scripts/strip-recog.js.
//
// Capture check: the keyboard shortcut (Alt+Shift+R by default, change it at chrome://extensions/shortcuts)
// on a Whatnot tab grabs one frame of the stream:
//   1. copy the <video> to a canvas in the page (needs no permission; fails if the stream is cross-origin)
//   2. else a screenshot of the visible tab, cropped to the video (the shortcut press grants activeTab)
// Then, 5 s later and without a key press, it tries the same method again: that says whether lots can be
// captured automatically once a stream is armed. Frames stay in this extension's IndexedDB; see recog/debug.html.

const RECOG_DB = "cardcomp-recog";
function recogDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(RECOG_DB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains("frames")) r.result.createObjectStore("frames", { keyPath: "id", autoIncrement: true }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function recogTx(fn) {
  const db = await recogDb();
  return new Promise((res, rej) => {
    const tx = db.transaction("frames", "readwrite"), st = tx.objectStore("frames");
    let out; const q = fn(st); if (q) q.onsuccess = () => { out = q.result; };
    tx.oncomplete = () => res(out); tx.onerror = () => rej(tx.error);
  });
}
const recogPut = (rec) => recogTx((st) => st.add(rec));
async function recogPatch(id, patch) {
  const db = await recogDb();
  return new Promise((res) => {
    const tx = db.transaction("frames", "readwrite"), st = tx.objectStore("frames"), g = st.get(id);
    g.onsuccess = () => { if (g.result) st.put(Object.assign(g.result, patch)); };
    tx.oncomplete = res; tx.onerror = res;
  });
}

async function recogDataUrl(blob) {
  return new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
}
// Screenshot (data URL of the whole visible tab) -> JPEG of just the video, long edge at most 1000 px.
async function recogCrop(shot, rect) {
  const bmp = await createImageBitmap(await (await fetch(shot)).blob());
  const k = bmp.width / rect.iw;   // device pixels per CSS pixel
  const sx = Math.max(0, rect.x * k), sy = Math.max(0, rect.y * k);
  const sw = Math.min(bmp.width - sx, rect.w * k), sh = Math.min(bmp.height - sy, rect.h * k);
  const z = Math.min(1, 1000 / Math.max(sw, sh)), w = Math.round(sw * z), h = Math.round(sh * z);
  const c = new OffscreenCanvas(w, h), g = c.getContext("2d");
  g.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data; let s = 0, n = 0;
  for (let i = 0; i < d.length; i += 64) { s += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; n++; }
  return { img: await recogDataUrl(await c.convertToBlob({ type: "image/jpeg", quality: 0.85 })), w, h, luma: Math.round(s / n) };
}

async function recogGrabOnce(tab) {
  const t0 = Date.now(), tries = [];
  let r;
  try { r = await chrome.tabs.sendMessage(tab.id, { type: "recog-grab" }); }
  catch (e) { r = { ok: false, why: "Whatnot tab not ready (reload it once after installing)" }; }
  if (r && r.ok) return { ok: true, method: "video", img: r.img, w: r.w, h: r.h, luma: r.luma, video: r.video, tries, ms: Date.now() - t0 };
  tries.push("video copy: " + ((r && r.why) || "no answer"));
  if (r && r.rect) {
    try {
      const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 90 });
      const c = await recogCrop(shot, r.rect);
      return Object.assign({ ok: true, method: "screenshot", video: r.video, tries, ms: Date.now() - t0 }, c);
    } catch (e) { tries.push("screenshot: " + e.message); }
  }
  return { ok: false, video: r && r.video, tries, ms: Date.now() - t0 };
}

async function recogGrab(tab) {
  const g = await recogGrabOnce(tab);
  const rec = { at: Date.now(), url: tab.url, trigger: "shortcut", ok: g.ok, method: g.method || "", w: g.w || 0, h: g.h || 0,
    luma: g.luma, kb: g.img ? Math.round(g.img.length * 0.75 / 1024) : 0, ms: g.ms, video: g.video || null, tries: g.tries, img: g.img || "", later: "pending" };
  let id = null;
  try { id = await recogPut(rec); } catch (e) { rec.tries.push("save: " + e.message); }
  chrome.tabs.sendMessage(tab.id, { type: "recog-grab-result", ok: rec.ok, method: rec.method, w: rec.w, h: rec.h, kb: rec.kb, luma: rec.luma, ms: rec.ms, tries: rec.tries }).catch(() => {});
  // Same capture again in 5 s with no key press: can later lots be captured on their own?
  setTimeout(async () => {
    const again = await recogGrabOnce(tab).catch((e) => ({ ok: false, tries: [e.message] }));
    const later = again.ok ? "ok (" + again.method + ")" : "failed: " + again.tries.join("; ");
    if (id != null) recogPatch(id, { later });
    chrome.tabs.sendMessage(tab.id, { type: "recog-later-result", ok: again.ok, later }).catch(() => {});
  }, 5000);
}

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd !== "recog-grab") return;
  if (!tab || !tab.id) tab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!tab || !/^https:\/\/([^/]*\.)?whatnot\.com\//.test(tab.url || "")) return;
  recogGrab(tab);
});
