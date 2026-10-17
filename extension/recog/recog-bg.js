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
// Capture check (step 1): Ctrl+Shift+Y or right-click > "Recognition test: grab a frame" grabs one frame
//   (store "frames"), then retries 5 s later with no key press.
// Nothing here bids or touches Whatnot. Calls go straight to api.anthropic.com with Derek's key.

const RECOG_DB = "cardcomp-recog";
const RECOG_MODELS = { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" };
const RECOG_PRICE = { "claude-haiku-5-5": [0.10, 0.50], "claude-sonnet-5-5": [2, 10], "claude-opus-5-5": [4, 20] };   // $/MTok in, out (2026-10)
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
const recogPut = (rec) => recogTx("frames", (st) => st.add(rec));
async function recogPatch(id, patch) {
  const db = await recogDb();
  return new Promise((res) => {
    const tx = db.transaction("frames", "readwrite"), st = tx.objectStore("frames"), g = st.get(id);
    g.onsuccess = () => { if (g.result) st.put(Object.assign(g.result, patch)); };
    tx.oncomplete = res; tx.onerror = res;
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
  return { card: c ? { id: c.id, n: c.n, s: c.s, num: c.num, label: c.label, cond: c.cond, printing: c.printing || "", multi: !!c.multi, myMax: c.myMax || null } : null,
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

// ---------------------------------------------------------------- the model call
const RECOG_SYSTEM = "You identify Pokemon trading cards in frames of a Whatnot livestream. One card is shown to the camera, held in hand or in a sleeve or top-loader. Ignore cards on stands, in binders, in display cases or on the table behind it. Read only what is printed on the card held in front. Never guess a number you cannot read: return an empty string instead.";
const RECOG_ASK = `Return the card held in front:
- card_visible: false if no single card is being shown (seller's face, a pack, a stack, a blurred hand)
- name: the card name as printed, in English (for a Japanese card, the English name of that Pokemon or trainer card), with prefixes and suffixes such as Radiant, Shining, Mega, Team Rocket's, Cynthia's, ex, EX, GX, V, VMAX, VSTAR, LV.X, Prime
- number: the collector number at the bottom (digits or code before the slash, e.g. 233, SV049, TG12), "" if unreadable
- total: the digits after the slash (e.g. 182), "" if none or unreadable
- language: en, jp, zh (Chinese), ko (Korean) or other. Japanese text has kana (あ, ア); Chinese cards use only Chinese characters (Simplified 简体 or Traditional 繁體) with no kana; Korean uses Hangul (한)
- rarity: the treatment you see, e.g. Illustration Rare (art past the frame, normal text box), Special Illustration Rare, Ultra Rare full art, Double Rare holo, Holo Rare, Reverse Holo, Common. Say "full art" when unsure which premium rarity it is
- stamp: look closely for a stamp, a small logo printed on the art or text box, often in a corner: a set logo on a stamped promo reprint (e.g. "Prismatic Evolutions", "Journey Together", "Mega Evolution"), a Pikachu anniversary logo (read whether it says 25th or 30th), Pokemon Center, Prerelease, Staff, 1st Edition, a Black Star promo mark. Sellers often circle a stamp or other detail with a marker: look inside any hand-drawn circle. Name what the stamp says; "" if there is none
- set: the set if you can tell, else ""
- confidence: 0 to 1 that the name is right`;
const RECOG_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["card_visible", "name", "number", "total", "language", "rarity", "stamp", "set", "confidence"],
  properties: {
    card_visible: { type: "boolean" }, name: { type: "string" }, number: { type: "string" }, total: { type: "string" },
    language: { type: "string", enum: ["en", "jp", "zh", "ko", "other"] }, rarity: { type: "string" }, stamp: { type: "string" }, set: { type: "string" }, confidence: { type: "number" }
  }
};
function recogErr(status, txt) {
  if (status === 401) return "API key rejected (Options page)";
  if (status === 403) return "API key not allowed to use this model";
  if (status === 429) return "rate limited by the API";
  if (status === 529 || status >= 500) return "API busy (" + status + ")";
  if (status === 400 && /credit|balance/i.test(txt)) return "out of API credit";
  return "API error " + status + ": " + String(txt || "").slice(0, 120);
}
const RECOG_DROP = {};
async function recogRead(img, modelKey, apiKey) {
  const model = RECOG_MODELS[modelKey] || RECOG_MODELS.haiku;
  const drop = RECOG_DROP[model] = RECOG_DROP[model] || {};   // options this model rejected once: never sent again
  let useFormat = !drop.format, useEffort = !drop.effort, netRetried = false;
  // Thinking off: Haiku takes "disabled", Sonnet 5.5 "between_tools"; Opus 5.5 cannot turn it off (low effort instead).
  let think = drop.thinking ? null : model === RECOG_MODELS.haiku ? { type: "disabled" } : model === RECOG_MODELS.sonnet ? { type: "between_tools" } : null;
  const data = String(img).replace(/^data:image\/\w+;base64,/, "");
  const t0 = Date.now();
  for (let attempt = 0; attempt < 5; attempt++) {
    const body = {
      model, max_tokens: 2000, system: RECOG_SYSTEM,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
        { type: "text", text: RECOG_ASK + (useFormat ? "" : "\nAnswer with one JSON object only, with exactly those keys.") }
      ] }]
    };
    const oc = {};
    if (useEffort) oc.effort = "low";
    if (useFormat) oc.format = { type: "json_schema", schema: RECOG_SCHEMA };
    if (Object.keys(oc).length) body.output_config = oc;
    const headers = { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
    if (think) body.thinking = think;
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 25000);
    let r, txt;
    try { r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(body), signal: ctl.signal }); txt = await r.text(); }
    catch (e) {
      if (!(e && e.name === "AbortError") && !netRetried) { netRetried = true; await new Promise((s) => setTimeout(s, 600)); continue; }
      return { error: e && e.name === "AbortError" ? "timed out (25 s)" : "network: " + (e && e.message), ms: Date.now() - t0, model };
    }
    finally { clearTimeout(tm); }
    if (r.status === 400) {   // an option this model does not take: drop it and retry once each
      if (think && /thinking|between_tools|disabled/i.test(txt)) { think = null; drop.thinking = true; continue; }
      if (useEffort && /effort/i.test(txt)) { useEffort = false; drop.effort = true; continue; }
      if (useFormat && /output_config|format|schema/i.test(txt)) { useFormat = false; drop.format = true; continue; }
    }
    if ((r.status === 529 || r.status === 503) && attempt < 1) { await new Promise((s) => setTimeout(s, 800)); continue; }
    const ms = Date.now() - t0;
    if (!r.ok) return { error: recogErr(r.status, txt), status: r.status, ms, model };
    let j; try { j = JSON.parse(txt); } catch (_) { return { error: "unreadable API reply", ms, model }; }
    const u = j.usage || {}, p = RECOG_PRICE[j.model] || RECOG_PRICE[model] || [0, 0];
    const cost = ((u.input_tokens || 0) * p[0] + (u.output_tokens || 0) * p[1]) / 1e6;
    const base = { ms, model: j.model || model, inTok: u.input_tokens || 0, outTok: u.output_tokens || 0, cost, stop: j.stop_reason };
    if (j.stop_reason === "refusal") return Object.assign(base, { error: "the model declined this frame" });
    const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    let read = null;
    try { read = JSON.parse(text); } catch (_) { const m = text.match(/\{[\s\S]*\}/); if (m) { try { read = JSON.parse(m[0]); } catch (_) {} } }
    if (!read) return Object.assign(base, { error: j.stop_reason === "max_tokens" ? "reply cut off" : "no JSON in the reply", raw: text.slice(0, 200) });
    return Object.assign(base, { read });
  }
  return { error: "API options rejected", ms: Date.now() - t0, model };
}

// ---------------------------------------------------------------- settings, cap, messages to CardComp
const recogGet = () => new Promise((res) => chrome.storage.local.get(["recogOn", "recogModel", "recogKey"], (r) => res(r || {})));
async function recogState() {
  const s = await recogGet();
  return { type: "cardcomp-auto-state", on: !!s.recogOn, model: s.recogModel || "sonnet", hasKey: !!s.recogKey };
}
function recogToApp(msg) {   // side panel page + any CardComp tab (same path as lot messages)
  try { const p = chrome.runtime.sendMessage(msg); if (p && p.catch) p.catch(() => {}); } catch (_) {}
  try { chrome.tabs.query({ url: "https://pm-derek.github.io/cardcomp/*" }, (tabs) => (tabs || []).forEach((t) => { const p = chrome.tabs.sendMessage(t.id, msg); if (p && p.catch) p.catch(() => {}); })); } catch (_) {}
}
let recogCalls = [];
function recogCapOK() {
  const now = Date.now();
  recogCalls = recogCalls.filter((t) => now - t < 3600e3);
  if (recogCalls.length >= RECOG_HOURLY_CAP) return false;
  recogCalls.push(now); return true;
}

// ---------------------------------------------------------------- auto mode: one frame per lot (two when unsure)
const recogPrev = {};   // tabId -> last reading, to spot a seller still holding the sold card
const sameCard = (a, b) => a && b && a.name && String(a.name).toLowerCase() === String(b.name).toLowerCase() && String(a.number || "") === String(b.number || "");
async function recogOnFrame(msg, tab) {
  const s = await recogGet();
  if (!s.recogOn) return;
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
    recogToApp(Object.assign(head, { error })); return;
  }
  const fr = { n, trigger: msg.trigger || "start", diff: msg.diff, sinceStart: msg.sinceStart, w: frame.w, h: frame.h, luma: frame.luma, method: frame.method, kb: Math.round(frame.img.length * 0.75 / 1024), img: frame.img };
  let res;
  if (!s.recogKey) res = { error: "no API key: add it on the extension's Options page" };
  else if (!recogCapOK()) res = { error: "hourly cap reached (" + RECOG_HOURLY_CAP + " reads)" };
  else res = await recogRead(frame.img, s.recogModel || "sonnet", s.recogKey);
  const prev = recogPrev[tab ? tab.id : 0];
  await recogLot(key, (rec) => { lotHead(rec); rec.frames.push(fr); rec.reads.push(Object.assign({ n, modelPicked: s.recogModel || "sonnet" }, res)); });
  recogToApp(Object.assign(head, { read: res.read || null, error: res.error || "", model: res.model || "", ms: res.ms || 0, cost: res.cost || 0, short: Math.min(frame.w || 0, frame.h || 0) }));
  if (res.read && tab) {
    const r = res.read, held = n === 1 && !msg.afterPre && sameCard(r, prev);
    if (n === 1) recogPrev[tab.id] = r;
    if (n === 1 && msg.trigger !== "pre" && msg.trigger !== "manual" && (r.card_visible === false || !r.number || (r.confidence || 0) < 0.6 || held)) {
      setTimeout(() => { const p = chrome.tabs.sendMessage(tab.id, { type: "recog-grab-again", key, n: 2, why: held ? "same card as the previous lot" : "unsure" }); if (p && p.catch) p.catch(() => {}); }, 2000);
    }
  }
}

// "Read now": the Whatnot tab Derek is watching (active first, else the one touched last) reads its frame right away.
async function recogReadNow() {
  const tabs = await chrome.tabs.query({ url: "https://*.whatnot.com/*" });
  if (!tabs.length) return { ok: false, why: "no Whatnot tab" };
  tabs.sort((a, b) => (b.active - a.active) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)));
  try { const r = await chrome.tabs.sendMessage(tabs[0].id, { type: "recog-read-now" }); return r && r.ok ? { ok: true } : { ok: false, why: "auto is off" }; }
  catch (_) { return { ok: false, why: "Whatnot tab not ready, reload it" }; }
}

async function recogAdopt(msg) {
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
  recogToApp({ type: "cardcomp-auto-adopt", from: msg.from, to: msg.to });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg.type !== "string") return;
  if (msg.type === "recog-frame") { recogOnFrame(msg, sender.tab); reply({ ok: true }); return; }
  if (msg.type === "recog-adopt") {   // a card read before the timer started, picture unchanged: it is this lot's reading
    recogAdopt(msg); reply({ ok: true }); return;
  }
  if (msg.type === "cardcomp-auto-watch") { if (sender.tab) recogToApp(msg); return; }   // watcher status -> CardComp
  if (msg.type === "cardcomp-auto-read") { recogReadNow().then((r) => { reply(r); recogToApp(Object.assign({ type: "cardcomp-auto-readack" }, r)); }); return true; }   // "read now" button
  if (msg.type === "cardcomp-auto-hello") { recogState().then(recogToApp); reply({ ok: true }); return; }
  if (msg.type === "cardcomp-auto-config") {
    const set = {}; if ("on" in msg) set.recogOn = !!msg.on; if (msg.model && RECOG_MODELS[msg.model]) set.recogModel = msg.model;
    chrome.storage.local.set(set, () => recogState().then(recogToApp)); reply({ ok: true }); return;
  }
  if (msg.type === "cardcomp-auto-match") {   // what CardComp made of a reading
    recogLot(msg.key, (rec) => { (rec.matches = rec.matches || []).push({ n: msg.n, kind: msg.kind, strength: msg.strength, suggestion: msg.suggestion, cards: msg.cards, note: msg.note, filled: msg.filled, why: msg.why }); });
    reply({ ok: true }); return;
  }
  if (msg.type === "cardcomp-auto-outcome") {   // lot ended: what Derek tapped or opened, the final price
    recogOutcome(msg.key, msg.outcome, false); reply({ ok: true }); return;
  }
  // The auction log row is the record (it is what stats use): copy its card onto the lot's reading too, so the
  // results page shows the same card, printing and max as the log. No reply: bg.js stores the row.
  if (msg.type === "cardcomp-log-save" && msg.rec && msg.rec.startedAt) { recogOutcome(msg.rec.startedAt, recogOutcomeOf(msg.rec), true); return; }
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

// ---------------------------------------------------------------- capture check (step 1)
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
      const c = await recogCrop(shot, r.rect, 1000);
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
  const s = await recogGet();
  if (s.recogOn) { chrome.tabs.sendMessage(tab.id, { type: "recog-read-now" }).catch(() => {}); return; }   // auto on: the hotkey means "read now"
  recogGrab(tab);
});
// Right-click menu: same grab, no key needed (Chrome keeps some keys for itself, e.g. Alt+Shift+R is Reading Mode).
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "recog-grab", title: "Recognition test: grab a frame", contexts: ["page", "video", "image", "link"],
    documentUrlPatterns: ["https://*.whatnot.com/*"] }, () => chrome.runtime.lastError);
});
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "recog-grab" || !tab || !tab.id) return;
  if ((await recogGet()).recogOn) { chrome.tabs.sendMessage(tab.id, { type: "recog-read-now" }).catch(() => {}); return; }
  recogGrab(tab);
});
