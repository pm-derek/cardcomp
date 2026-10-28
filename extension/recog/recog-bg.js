// RECOG experiment, background half (docs/auto-recognition-handoff.md). Removed by scripts/strip-recog.js.
//
// Auto mode (switch + model picker in the CardComp panel, API key on the Options page):
//   recog-whatnot.js sends a frame when a new card holds still between lots (pre-start), else ~1 s after a lot's
//   timer starts -> read it with Claude -> send the reading to
//   CardComp ("cardcomp-auto"), which matches it against the catalog (recog/automatch.js) and shows candidates.
//   One more frame 2 s later only when the first read is unsure (no card, no number, low confidence, or the same
//   card as the previous lot, i.e. the seller may still be holding the sold card).
//   Every lot is recorded in IndexedDB "cardcomp-recog" (store "lots"): frames sent, readings, model, latency,
//   cost, what CardComp matched, and what Derek tapped or opened. Results page: recog/debug.html.
// Nothing here bids or touches Whatnot. Calls go straight to api.anthropic.com with Derek's key.

try { importScripts("recog/imgmatch.js"); } catch (_) {}   // picture match (IM)
const RECOG_DB = "cardcomp-recog";
// model ids, prices, prompt, schema and recogRead live in recog-read.js (shared with the phone app)
if (typeof importScripts === "function") importScripts("recog/recog-read.js");   // the extension worker; the check script adds it as a page script instead
const RECOG_HOURLY_CAP = 240;          // model calls per rolling hour (a busy stream is ~100 lots an hour)
const RECOG_KEEP_DAYS = 30;            // lots and frames older than this are deleted

function recogDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(RECOG_DB, 2);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("frames")) db.createObjectStore("frames", { keyPath: "id", autoIncrement: true });
      if (!db.objectStoreNames.contains("lots")) db.createObjectStore("lots", { keyPath: "key" });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function recogTx(store, fn) {
  const db = await recogDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite"), st = tx.objectStore(store);
    let out; const q = fn(st); if (q) q.onsuccess = () => { out = q.result; };
    tx.oncomplete = () => res(out); tx.onerror = () => rej(tx.error);
  });
}
// Read-modify-write one lot record (created on first use). A pre-start reading reused by a lot redirects there.
const RECOG_ADOPT = {};   // pre-start key -> lot key
async function recogLot(key, fn) {
  key = RECOG_ADOPT[key] || key;
  const db = await recogDb();
  return new Promise((res) => {
    const tx = db.transaction("lots", "readwrite"), st = tx.objectStore("lots"), g = st.get(key);
    let out;
    g.onsuccess = () => { const rec = g.result || { key, at: key, frames: [], reads: [] }; fn(rec); st.put(rec); out = rec; };
    tx.oncomplete = () => res(out); tx.onerror = () => res(null);
  });
}
// Lot outcome on the reading's record. Every open CardComp copy (side panel, CardComp tabs) reports each lot, and
// only the copy Derek used knows the card: keep the richest report (tap > opened card > nothing) so a copy that saw
// nothing cannot wipe it (live 2026-10-16: the won Master Ball Sylveon showed "did not tap or open" here while the
// log had it). onlyExisting: never create a record for a lot that was not read.
const recogRank = (o) => !o ? -1 : !o.card ? 0 : o.card.label === "tap" ? 2 : 1;
function recogOutcomeOf(rec) {
  const c = rec.card || null;
  return { card: c ? { id: c.id, n: c.n, s: c.s, num: c.num, r: c.r || "", label: c.label, cond: c.cond, printing: c.printing || "", multi: !!c.multi, myMax: c.myMax || null } : null,
    placedMax: rec.placedMax != null ? rec.placedMax : null, final: rec.final, winner: rec.winner || "", me: !!rec.me, bids: rec.bids, title: rec.title || "", at: rec.at || Date.now() };
}
async function recogOutcome(key, outcome, onlyExisting) {
  key = RECOG_ADOPT[key] || key;
  const db = await recogDb();
  return new Promise((res) => {
    const tx = db.transaction("lots", "readwrite"), st = tx.objectStore("lots"), g = st.get(key);
    g.onsuccess = () => { const rec = g.result; if (!rec && onlyExisting) return;
      const r = rec || { key, at: key, frames: [], reads: [] };
      if (recogRank(outcome) >= recogRank(r.outcome)) { r.outcome = outcome; st.put(r); } };
    tx.oncomplete = () => res(); tx.onerror = () => res();
  });
}
async function recogPrune() {
  const cut = Date.now() - RECOG_KEEP_DAYS * 864e5;
  for (const store of ["lots", "frames"]) {
    await recogTx(store, (st) => { const c = st.openCursor(); c.onsuccess = () => { const cur = c.result; if (!cur) return; if ((cur.value.at || 0) < cut) cur.delete(); cur.continue(); }; }).catch(() => {});
  }
}
recogPrune();

async function recogDataUrl(blob) {
  return new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
}
// Screenshot (data URL of the whole visible tab) -> JPEG of just the video box.
async function recogCrop(shot, rect, maxEdge) {
  const bmp = await createImageBitmap(await (await fetch(shot)).blob());
  const k = bmp.width / rect.iw;   // device pixels per CSS pixel
  const sx = Math.max(0, rect.x * k), sy = Math.max(0, rect.y * k);
  const sw = Math.min(bmp.width - sx, rect.w * k), sh = Math.min(bmp.height - sy, rect.h * k);
  const z = Math.min(1, (maxEdge || 1000) / Math.max(sw, sh)), w = Math.round(sw * z), h = Math.round(sh * z);
  const c = new OffscreenCanvas(w, h), g = c.getContext("2d");
  g.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data; let s = 0, n = 0;
  for (let i = 0; i < d.length; i += 64) { s += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; n++; }
  return { img: await recogDataUrl(await c.convertToBlob({ type: "image/jpeg", quality: 0.88 })), w, h, luma: Math.round(s / n) };
}

// Zoom (pullsafaritcg 2026-10-20: the card was ~300 px wide in a 1080x1920 frame, in a toploader; numbers were read on
// 2 of 13 lots and names were guessed from the art): crop the card box the model reported, with a margin, from the
// same frame and enlarge it so its long edge is ~1400 px (at most 3x). null when the box is unusable or already big.
async function recogZoom(img, box) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  let [l, t, r, b] = box.map((v) => Math.max(0, Math.min(1000, +v || 0)));
  if (r - l < 30 || b - t < 30) return null;
  if ((r - l) * (b - t) > 500000) return null;   // the card already fills half the frame: zooming adds nothing
  const mx = (r - l) * 0.12, my = (b - t) * 0.12; l = Math.max(0, l - mx); t = Math.max(0, t - my); r = Math.min(1000, r + mx); b = Math.min(1000, b + my);
  const bmp = await createImageBitmap(await (await fetch(img)).blob());
  const sx = l / 1000 * bmp.width, sy = t / 1000 * bmp.height, sw = (r - l) / 1000 * bmp.width, sh = (b - t) / 1000 * bmp.height;
  const z = Math.min(3, 1400 / Math.max(sw, sh)), w = Math.round(sw * z), h = Math.round(sh * z);
  if (z < 1.2) return null;
  const c = new OffscreenCanvas(w, h), g = c.getContext("2d"); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
  g.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
  return { img: await recogDataUrl(await c.convertToBlob({ type: "image/jpeg", quality: 0.9 })), w, h, z: +z.toFixed(2) };
}
// a zoomed reading replaces the first one only when it knows more (a number, or a name where there was none)
const recogBetter = (z, a) => !!(z && z.card_visible !== false && z.name && (!a || !a.name || (z.number && !a.number) || ((z.confidence || 0) > (a.confidence || 0) + 0.2 && z.name.toLowerCase() === String(a.name).toLowerCase())));

// ---------------------------------------------------------------- the model call
// (in recog-read.js, shared with the phone app)

// ---------------------------------------------------------------- CardSight, side by side (Derek, 2026-10-23)
// "I don't want to switch between CardSight and ours; show me one or the other at random and compare in the
// background." On read-nows and lot-start reads, within a monthly allowance spread over the days left, the same frame
// also goes to CardSight (cardsight.ai, a card recognition API: POST /v1/identify/card/pokemon, multipart "image",
// X-API-Key). A coin decides which answer fills CardComp; the other one is sent as a "shadow" that CardComp only
// records, so the auction log carries both and scripts/recog-score-log.js scores each against the card Derek tapped.
// If the shown one comes back empty, the other one fills instead. Key and monthly calls on the Options page.
const CS_URL = "https://api.cardsight.ai/v1/identify/card/pokemon";
const csGet = () => new Promise((res) => chrome.storage.local.get(["csKey", "csMonthly", "csUse", "csForce"], (r) => res(r || {})));
// Calls allowed today: what is left of the month spread evenly over the days left (750 a month on the free plan = ~25 a day).
async function csBudget() {
  const s = await csGet(); if (!s.csKey) return { ok: false };
  const now = new Date(), month = now.toISOString().slice(0, 7), day = now.toISOString().slice(0, 10);
  let u = s.csUse && s.csUse.month === month ? s.csUse : { month, n: 0, day, dn: 0, n0: 0 };
  if (u.day !== day) u = Object.assign({}, u, { day, dn: 0, n0: u.n });
  const cap = Math.max(1, +s.csMonthly || 750);
  const daysLeft = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate() - now.getUTCDate() + 1;
  const today = Math.max(1, Math.floor((cap - u.n0) / daysLeft));
  if (u.n >= cap || u.dn >= today) return { ok: false, why: "CardSight: today's share of the month used" };
  u = Object.assign({}, u, { n: u.n + 1, dn: u.dn + 1 });
  await new Promise((r) => chrome.storage.local.set({ csUse: u }, r));
  return { ok: true, key: s.csKey, force: s.csForce || "" };
}
function csErr(status, txt) {
  if (status === 401 || status === 403) return "CardSight key rejected (Options page)";
  if (status === 402 || status === 429) return "CardSight: out of calls or rate limited";
  return "CardSight error " + status + ": " + String(txt || "").slice(0, 100);
}
// The best detection -> the same reading shape Claude returns, so autoMatch takes it as is.
const CS_CONF = { High: 0.95, Medium: 0.82, Low: 0.62 }, CS_RANK = { High: 3, Medium: 2, Low: 1 };
function csField(card, k) { const f = ((card && card.fields) || []).find((x) => x && String(x.key || "").toLowerCase() === k); return f && f.value != null ? String(f.value) : ""; }
function csToRead(j) {
  const d = ((j && j.detections) || []).filter((x) => x && x.card && x.card.name).sort((a, b) => (CS_RANK[b.confidence] || 0) - (CS_RANK[a.confidence] || 0))[0];
  if (!d) return { card_visible: !!(j && j.detectedCount > 0), name: "", number: "", total: "", language: "", rarity: "", stamp: "", finish: "", set: "", confidence: 0, box: [] };
  const c = d.card, m = String(c.number || "").match(/^\s*([^/\s]+)\s*(?:\/\s*(\S+))?/) || [];
  const lg = csField(c, "card_language").toLowerCase();
  return { card_visible: true, name: String(c.name), number: m[1] || "", total: m[2] || "", language: !lg || lg === "en" ? "en" : lg === "ja" ? "jp" : lg === "zh" ? "zh" : lg === "ko" ? "ko" : "other",
    rarity: csField(c, "rarity"), stamp: "", finish: "", set: c.setName || c.releaseName || "", confidence: CS_CONF[d.confidence] || 0.6, box: [] };
}
// What CardSight said, small enough to ride on the log row (for checking the mapping above against real replies).
function csBrief(j) {
  return { req: j.requestId || "", pt: j.processingTime || 0, det: j.detectedCount, ids: j.identifiedCount,
    top: ((j.detections || []).slice(0, 3)).map((d) => { const c = d.card || {}; return { conf: d.confidence, name: c.name || "", num: c.number || "", set: c.setName || "", rel: c.releaseName || "", year: c.year || "", id: c.id || "",
      lang: csField(c, "card_language"), rarity: csField(c, "rarity"), sugg: (c.suggestions || []).slice(0, 3).map((x) => [x.name || "", x.number || "", x.setName || ""].join(" | ")) }; }) };
}
async function csIdentify(img, key) {
  const t0 = Date.now(), ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 6000);
  try {
    const blob = await (await fetch(img)).blob(), fd = new FormData();
    fd.append("image", blob, "frame.jpg");
    const r = await fetch(CS_URL, { method: "POST", headers: { "X-API-Key": key }, body: fd, signal: ctl.signal });
    const txt = await r.text(), ms = Date.now() - t0;
    if (!r.ok) return { error: csErr(r.status, txt), status: r.status, ms, model: "cardsight" };
    let j; try { j = JSON.parse(txt); } catch (_) { return { error: "CardSight: unreadable reply", ms, model: "cardsight" }; }
    return { read: csToRead(j), cs: csBrief(j), ms, model: "cardsight" };
  } catch (e) { return { error: e && e.name === "AbortError" ? "CardSight timed out (6 s)" : "CardSight network: " + (e && e.message), ms: Date.now() - t0, model: "cardsight" }; }
  finally { clearTimeout(tm); }
}

// ---------------------------------------------------------------- settings, cap, messages to CardComp
// Mode (Derek, 2026-10-20: auto used up the hourly cap and blocked his read-nows): "off", "manual" (read now only,
// the watcher reads nothing) or "auto" (watcher + read now). Older installs only stored recogOn.
const recogGet = () => new Promise((res) => chrome.storage.local.get(["recogOn", "recogMode", "recogModel", "recogKey", "csKey"], (r) => res(r || {})));
const recogModeOf = (s) => (["off", "manual", "auto"].includes(s.recogMode) ? s.recogMode : s.recogOn ? "auto" : "off");
async function recogState() {
  const s = await recogGet(), mode = recogModeOf(s);
  return { type: "cardcomp-auto-state", on: mode !== "off", mode, model: s.recogModel || "sonnet", hasKey: !!s.recogKey, cs: !!s.csKey, ver: chrome.runtime.getManifest ? chrome.runtime.getManifest().version : "" };
}
function recogToApp(msg, tab) {   // to the CardComp copies paired with that tab's window (bg.js toApps); no tab = every copy
  if (typeof toApps === "function") { toApps(msg, tab); return; }
  try { const p = chrome.runtime.sendMessage(msg); if (p && p.catch) p.catch(() => {}); } catch (_) {}
  try { chrome.tabs.query({ url: "https://pm-derek.github.io/cardcomp/*" }, (tabs) => (tabs || []).forEach((t) => { const p = chrome.tabs.sendMessage(t.id, msg); if (p && p.catch) p.catch(() => {}); })); } catch (_) {}
}
// Separate hourly allowances: automatic reads can never use up the read-nows.
const recogCalls = { auto: [], manual: [] };
function recogCapOK(kind) {
  const now = Date.now(), k = kind === "manual" ? "manual" : "auto";
  recogCalls[k] = recogCalls[k].filter((t) => now - t < 3600e3);
  if (recogCalls[k].length >= RECOG_HOURLY_CAP) return false;
  recogCalls[k].push(now); return true;
}

// ---------------------------------------------------------------- auto mode: one frame per lot (two when unsure)
const recogPrev = {};   // tabId -> last reading, to spot a seller still holding the sold card
const sameCard = (a, b) => a && b && a.name && String(a.name).toLowerCase() === String(b.name).toLowerCase() && String(a.number || "") === String(b.number || "");
async function recogOnFrame(msg, tab) {
  const s = await recogGet(), mode = recogModeOf(s), kind = msg.trigger === "manual" ? "manual" : "auto";
  if (mode === "off" || (mode === "manual" && kind !== "manual")) return;
  const key = msg.key, n = msg.n || 1;
  const head = { type: "cardcomp-auto", key, n, capAt: msg.capAt || Date.now(), title: msg.title || "", seller: msg.seller || "", pre: msg.trigger === "pre", manual: msg.trigger === "manual" };
  let frame = msg.ok ? { img: msg.img, w: msg.w, h: msg.h, luma: msg.luma, method: "video" } : null;
  if (!frame && msg.rect && tab) {   // video copy blocked: a screenshot works once the tab was armed (shortcut / right-click)
    try { frame = Object.assign({ method: "screenshot" }, await recogCrop(await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 92 }), msg.rect, 1920)); }
    catch (e) { msg.why = (msg.why || "") + "; screenshot: " + e.message; }
  }
  const lotHead = (rec) => { rec.title = msg.title || rec.title || ""; rec.seller = msg.seller || rec.seller || ""; rec.url = msg.url || rec.url || ""; };
  if (!frame) {
    const error = "no frame: " + (msg.why || "unknown");
    await recogLot(key, (rec) => { lotHead(rec); rec.reads.push({ n, error }); });
    recogToApp(Object.assign(head, { error }), tab); return;
  }
  const fr = { n, trigger: msg.trigger || "start", diff: msg.diff, sinceStart: msg.sinceStart, w: frame.w, h: frame.h, luma: frame.luma, method: frame.method, kb: Math.round(frame.img.length * 0.75 / 1024), img: frame.img };
  // CardSight side by side: same frame, a coin for which answer fills CardComp (the other is a shadow, recorded only)
  let cs = null;
  if (msg.trigger === "manual" || (msg.trigger === "start" && n === 1)) {
    const b = await csBudget();
    if (b.ok) { cs = { shown: b.force === "cs" ? true : b.force === "claude" ? false : Math.random() < 0.5, done: null, sentShown: false }; cs.p = csIdentify(frame.img, b.key).then((r) => (cs.done = r)); }
  }
  const csUsable = () => !!(cs && cs.done && cs.done.read && cs.done.read.name && cs.done.read.card_visible !== false);
  const csMsg = (shadow) => Object.assign({}, head, { src: "cardsight", read: cs.done.read || null, error: cs.done.error || "", model: "cardsight", ms: cs.done.ms || 0, cost: 0, short: 0, cs: cs.done.cs || null, shadow, fallback: !!cs.fallback });
  const csShow = () => { if (cs.sentShown || !csUsable()) return; cs.sentShown = true; if (!PIC_FRAMES.has(key + "|" + n)) picKeep(key, n, frame.img, null); recogToApp(csMsg(false), tab); };
  if (cs) cs.p.then(async () => {
    await recogLot(key, (rec) => { lotHead(rec); rec.reads.push(Object.assign({ n, src: "cardsight", shown: cs.shown }, cs.done, { read: cs.done.read })); });
    if (cs.shown && csUsable()) csShow(); else if (!cs.sentShown) recogToApp(csMsg(true), tab);   // a failed or empty answer is still recorded
  });
  const claudeShadow = async () => { if (!cs || !cs.shown) return false; await cs.p; return csUsable(); };   // CardSight drew the coin and answered
  let res;
  if (!s.recogKey) res = { error: "no API key: add it on the extension's Options page" };
  else if (!recogCapOK(kind)) {
    if (kind === "auto") {   // pause quietly: say so on the watcher line, never over the results or a read-now
      recogToApp({ type: "cardcomp-auto-watch", phase: "paused", why: "auto paused: " + RECOG_HOURLY_CAP + " reads this hour (read now still works)" }, tab);
      return;
    }
    res = { error: "read-now limit reached (" + RECOG_HOURLY_CAP + " an hour)" };
  }
  else res = await recogRead(frame.img, s.recogModel || "sonnet", s.recogKey, (read, ms) => {
    if (cs && cs.shown && (!cs.done || csUsable())) return;   // CardSight fills this one: no early Claude fill
    recogToApp(Object.assign({}, head, { partial: true, read, ms, model: RECOG_MODELS[s.recogModel || "sonnet"] || "", short: Math.min(frame.w || 0, frame.h || 0) }), tab);
  });
  const prev = recogPrev[tab ? tab.id : 0];
  if (res.read) picKeep(key, n, frame.img, res.read.box);   // before CardComp hears of it: it asks for the picture match next
  await recogLot(key, (rec) => { lotHead(rec); rec.frames.push(fr); rec.reads.push(Object.assign({ n, modelPicked: s.recogModel || "sonnet" }, res)); });
  const shadow = await claudeShadow();
  recogToApp(Object.assign({}, head, { src: "claude", shadow, read: res.read || null, error: res.error || "", model: res.model || "", ms: res.ms || 0, cost: res.cost || 0, short: Math.min(frame.w || 0, frame.h || 0) }), tab);
  // Claude came back empty or failed while CardSight answered: CardSight fills instead (the coin only decides between two answers)
  if (cs && !cs.shown && !(res.read && res.read.name && res.read.card_visible !== false)) { await cs.p; if (csUsable()) { cs.shown = true; cs.fallback = true; csShow(); } }
  // no number (or unsure): read the enlarged card from the same frame; CardComp keeps it only if it is better
  let best = res.read;
  if (res.read && res.read.card_visible !== false && res.read.name && (!res.read.number || (res.read.confidence || 0) < 0.7) && s.recogKey) {
    let zc = null; try { zc = await recogZoom(frame.img, res.read.box); } catch (_) {}
    if (zc && recogCapOK(kind)) {
      const zr = await recogRead(zc.img, s.recogModel || "sonnet", s.recogKey);
      const zf = { n, trigger: "zoom", zoom: zc.z, box: res.read.box, w: zc.w, h: zc.h, kb: Math.round(zc.img.length * 0.75 / 1024), img: zc.img };
      await recogLot(key, (rec) => { rec.frames.push(zf); rec.reads.push(Object.assign({ n, zoom: zc.z, modelPicked: s.recogModel || "sonnet" }, zr)); });
      if (zr.read && recogBetter(zr.read, res.read)) {
        best = zr.read;
        recogToApp(Object.assign({}, head, { src: "claude", shadow, zoom: zc.z, read: zr.read, error: "", model: zr.model || "", ms: zr.ms || 0, cost: zr.cost || 0, short: Math.min(frame.w || 0, frame.h || 0) }), tab);
      }
    }
  }
  if (best && tab) {
    const r = best, held = n === 1 && !msg.afterPre && sameCard(r, prev);
    if (n === 1) recogPrev[tab.id] = r;
    if (n === 1 && msg.trigger !== "pre" && msg.trigger !== "manual" && !(cs && cs.shown && csUsable()) && (r.card_visible === false || !r.number || (r.confidence || 0) < 0.6 || held)) {
      setTimeout(() => { const p = chrome.tabs.sendMessage(tab.id, { type: "recog-grab-again", key, n: 2, why: held ? "same card as the previous lot" : "unsure" }); if (p && p.catch) p.catch(() => {}); }, 2000);
    }
  }
}

// "Read now": the stream in the asking CardComp's window (its active Whatnot tab first), else the one touched last.
async function recogReadNow(win) {
  const tabs = await chrome.tabs.query({ url: "https://*.whatnot.com/*" });
  if (!tabs.length) return { ok: false, why: "no Whatnot tab" };
  const here = win != null ? tabs.filter((t) => t.windowId === win) : [];
  const pick = (here.length ? here : tabs).sort((a, b) => (b.active - a.active) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)))[0];
  try { const r = await chrome.tabs.sendMessage(pick.id, { type: "recog-read-now" }); return r && r.ok ? { ok: true } : { ok: false, why: "auto is off" }; }
  catch (_) { return { ok: false, why: "Whatnot tab not ready, reload it" }; }
}

async function recogAdopt(msg, tab) {
  RECOG_ADOPT[msg.from] = msg.to;   // a reading still on its way lands on the lot
  const db = await recogDb();
  await new Promise((res) => {
    const tx = db.transaction("lots", "readwrite"), st = tx.objectStore("lots"), g = st.get(msg.from);
    g.onsuccess = () => {
      const pre = g.result; if (!pre) return;
      const h = st.get(msg.to);
      h.onsuccess = () => {
        const rec = h.result || { key: msg.to, at: msg.to, frames: [], reads: [] };
        rec.frames = (pre.frames || []).concat(rec.frames || []); rec.reads = (pre.reads || []).concat(rec.reads || []);
        rec.matches = (pre.matches || []).concat(rec.matches || []);
        rec.title = msg.title || rec.title || pre.title || ""; rec.seller = rec.seller || pre.seller || ""; rec.url = rec.url || pre.url || "";
        rec.adopted = { from: msg.from, diff: msg.diff, earlyMs: msg.to - msg.from };
        st.put(rec); st.delete(msg.from);
      };
    };
    tx.oncomplete = res; tx.onerror = res;
  });
  recogToApp({ type: "cardcomp-auto-adopt", from: msg.from, to: msg.to }, tab);
}

// ---------------------------------------------------------------- picture match
// CardComp sends the candidates of a reading ("cardcomp-auto-img"); the frame that was read is ranked against each
// candidate's TCGplayer picture (imgmatch.js) and the ranking goes back in the reply. Frames are kept in memory for a
// few minutes; candidate templates are kept in IndexedDB "cardcomp-pics" (about 9 KB a card) so a name seen before
// ranks with no download.
const PIC_FRAMES = new Map();   // "key|n" -> { img, box, at, px }
function picKeep(key, n, img, box) {
  PIC_FRAMES.set(key + "|" + n, { img, box: Array.isArray(box) && box.length === 4 ? box : null, at: Date.now() });
  for (const [k, f] of PIC_FRAMES) if (PIC_FRAMES.size > 12 || Date.now() - f.at > 5 * 60e3) PIC_FRAMES.delete(k); else break;
}
const PIC_MEM = new Map();      // picture URL -> normalized template (or null: no picture)
let picDbP = null;
function picDb() {
  return picDbP = picDbP || new Promise((res, rej) => {
    const r = indexedDB.open("cardcomp-pics", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("cells");
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function picCells(url) {
  if (PIC_MEM.has(url)) return PIC_MEM.get(url);
  const db = await picDb().catch(() => null);
  let cells = db ? await new Promise((res) => { const g = db.transaction("cells").objectStore("cells").get(url); g.onsuccess = () => res(g.result || null); g.onerror = () => res(null); }) : null;
  if (!cells) {
    try { cells = IM.cardCells(await IM.load(url, 300)); } catch (_) { cells = null; }
    if (cells && db) try { db.transaction("cells", "readwrite").objectStore("cells").put(cells, url); } catch (_) {}
  }
  const t = cells ? IM.normalize(cells) : null;
  if (PIC_MEM.size > 3000) PIC_MEM.clear();
  PIC_MEM.set(url, t);
  return t;
}
async function picRank(msg) {
  if (typeof IM === "undefined") return { ok: false, why: "no picture matcher" };
  const f = PIC_FRAMES.get(msg.key + "|" + (msg.n || 1));
  if (!f) return { ok: false, why: "frame gone" };
  const t0 = Date.now();
  if (!f.px) f.px = await IM.load(f.img);
  const cands = (msg.cands || []).slice(0, 80).filter((c) => c && c.id && /^https:\/\/(tcgplayer-cdn\.tcgplayer\.com|images\.pokemontcg\.io)\//.test(c.u || ""));
  const got = [];
  for (let i = 0; i < cands.length; i += 8) {   // 8 downloads at a time
    const part = await Promise.all(cands.slice(i, i + 8).map(async (c) => ({ id: c.id, t: await picCells(c.u) })));
    got.push(...part);
  }
  const temps = got.filter((x) => x.t), dl = Date.now() - t0;
  // One photo under 3+ ids is TCGplayer's "image coming soon": no information, left out (a pair can be a shared scan of
  // two real products; those just rank together)
  for (const x of temps) x.same = temps.filter((y) => y === x || IM.sim(x.t, y.t) > 0.995).length;
  const usable = temps.filter((x) => x.same < 3);
  if (!usable.length) return { ok: false, why: "no pictures" };
  const ranked = IM.match(f.px, f.box, usable);
  const v = IM.verdict(ranked, usable);
  const out = { ok: true, ranked: ranked.slice(0, 40), v, box: !!f.box, cands: cands.length, pics: usable.length, ms: Date.now() - t0, dl };   // no "n" / "key": the relays put the reading's own
  recogLot(msg.key, (rec) => { (rec.pics = rec.pics || []).push({ n: msg.n || 1, at: Date.now(), ms: out.ms, dl, box: out.box, cands: cands.length, pics: usable.length, top: v.top, s: v.s, sure: v.sure, group: v.group.slice(0, 6), next: v.next, ns: v.ns, ranked: ranked.slice(0, 8) }); });
  return out;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg.type !== "string") return;
  if (msg.type === "recog-frame") { recogOnFrame(msg, sender.tab); reply({ ok: true }); return; }
  if (msg.type === "recog-adopt") {   // a card read before the timer started, picture unchanged: it is this lot's reading
    recogAdopt(msg, sender.tab); reply({ ok: true }); return;
  }
  if (msg.type === "cardcomp-auto-zh") { tcgChinese(msg).then(reply, (e) => reply({ ok: false, errs: [e.message] })); return true; }   // Chinese card: cheapest listing that says Chinese (tcgfast.js)
  if (msg.type === "cardcomp-auto-img") { picRank(msg).then(reply, (e) => reply({ ok: false, why: e.message })); return true; }   // picture match for a reading
  if (msg.type === "cardcomp-auto-watch") { if (sender.tab) recogToApp(msg, sender.tab); return; }   // watcher status -> CardComp
  if (msg.type === "cardcomp-auto-read") {   // read the stream in the asking CardComp's window
    const win = sender.tab ? sender.tab.windowId : msg.win;
    recogReadNow(win).then((r) => { reply(r); recogToApp(Object.assign({ type: "cardcomp-auto-readack" }, r), win != null ? { windowId: win } : null); }); return true;
  }   // "read now" button
  if (msg.type === "cardcomp-auto-hello") { recogState().then(recogToApp); reply({ ok: true }); return; }
  if (msg.type === "cardcomp-auto-config") {
    const set = {};
    if (["off", "manual", "auto"].includes(msg.mode)) { set.recogMode = msg.mode; set.recogOn = msg.mode !== "off"; }
    else if ("on" in msg) { set.recogOn = !!msg.on; set.recogMode = msg.on ? "auto" : "off"; }
    if (msg.model && RECOG_MODELS[msg.model]) set.recogModel = msg.model;
    chrome.storage.local.set(set, () => recogState().then(recogToApp)); reply({ ok: true }); return;
  }
  if (msg.type === "cardcomp-auto-match") {   // what CardComp made of a reading
    recogLot(msg.key, (rec) => { (rec.matches = rec.matches || []).push({ n: msg.n, kind: msg.kind, strength: msg.strength, suggestion: msg.suggestion, printing: msg.printing || "", cards: msg.cards, note: msg.note, filled: msg.filled, why: msg.why }); });
    reply({ ok: true }); return;
  }
  if (msg.type === "cardcomp-auto-outcome") {   // lot ended: what Derek tapped or opened, the final price
    recogOutcome(msg.key, msg.outcome, false); reply({ ok: true }); return;
  }
  // The auction log row is the record (it is what stats use): copy its card onto the lot's reading too, so the
  // results page shows the same card, printing and max as the log. No reply: bg.js stores the row.
  if (msg.type === "cardcomp-log-save" && msg.rec && msg.rec.startedAt) { recogOutcome(msg.rec.startedAt, recogOutcomeOf(msg.rec), true); return; }
  if (msg.type === "cs-key-test") {   // Options page: a free CardSight call (the identifiable-sets list does not count toward usage)
    csGet().then(async (s) => {
      if (!s.csKey) return reply({ ok: false, why: "no key saved" });
      try { const r = await fetch("https://api.cardsight.ai/v1/identify/list/sets?take=1", { headers: { "X-API-Key": s.csKey } }); reply(r.ok ? { ok: true } : { ok: false, why: csErr(r.status, await r.text()) }); }
      catch (e) { reply({ ok: false, why: "network: " + e.message }); }
    });
    return true;
  }
  if (msg.type === "recog-key-test") {   // Options page: tiny text-only call to prove the key works
    recogGet().then(async (s) => {
      if (!s.recogKey) return reply({ ok: false, why: "no key saved" });
      try {
        const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
          headers: { "content-type": "application/json", "x-api-key": s.recogKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
          body: JSON.stringify({ model: RECOG_MODELS.haiku, max_tokens: 16, messages: [{ role: "user", content: "Reply with: ok" }] }) });
        reply(r.ok ? { ok: true } : { ok: false, why: recogErr(r.status, await r.text()) });
      } catch (e) { reply({ ok: false, why: "network: " + e.message }); }
    });
    return true;
  }
});

// Ctrl+Shift+Y on a Whatnot tab: read now (manual and auto modes). The step-1 capture check and its right-click menu
// are gone (2026-10-20): auto reads proved capture works, and read now covers a manual frame.
chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd !== "recog-grab") return;
  if (!tab || !tab.id) tab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!tab || !/^https:\/\/([^/]*\.)?whatnot\.com\//.test(tab.url || "")) return;
  const s = await recogGet();
  if (recogModeOf(s) !== "off") chrome.tabs.sendMessage(tab.id, { type: "recog-read-now" }).catch(() => {});
});
