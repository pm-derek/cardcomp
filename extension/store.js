// Live price store: merge verified condition prices into live.json on the "live" branch of
// pm-derek/cardcomp through the GitHub contents API. The app (desktop and phone) reads the file raw.
// Writes are batched (20 s) and retried once on a sha conflict. Needs a fine-grained token (options page).
const GH = { owner: "pm-derek", repo: "cardcomp", branch: "live", path: "live.json" };
const API = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${GH.path}`;
let pending = {}, timer = null;

function token() { return new Promise((res) => chrome.storage.local.get("ghToken", (r) => res(r.ghToken || ""))); }
const b64enc = (s) => btoa(unescape(encodeURIComponent(s)));
const b64dec = (s) => decodeURIComponent(escape(atob(s.replace(/\n/g, ""))));

async function ghGet(tok) {
  const r = await fetch(`${API}?ref=${GH.branch}&t=${Date.now()}`, { headers: { Authorization: "Bearer " + tok, Accept: "application/vnd.github+json" }, cache: "no-store" });
  if (r.status === 404) return { sha: null, data: {} };
  if (!r.ok) throw new Error("GitHub GET " + r.status);
  const j = await r.json();
  let data = {}; try { data = JSON.parse(b64dec(j.content)) || {}; } catch (_) {}
  return { sha: j.sha, data };
}

async function flush() {
  timer = null;
  const batch = pending; pending = {};
  const n = Object.keys(batch).length; if (!n) return;
  const tok = await token();
  if (!tok) { console.warn("CardComp: no GitHub token, live prices not stored"); return; }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { sha, data } = await ghGet(tok);
      Object.assign(data, batch);
      const body = { message: `Live prices: ${n} verified`, branch: GH.branch, content: b64enc(JSON.stringify(data)) };
      if (sha) body.sha = sha;
      const r = await fetch(API, { method: "PUT", headers: { Authorization: "Bearer " + tok, Accept: "application/vnd.github+json", "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (r.status === 409 || r.status === 422) continue;   // sha moved under us: refetch and retry once
      if (!r.ok) throw new Error("GitHub PUT " + r.status);
      return;
    } catch (e) { console.warn("CardComp live store:", e.message); if (attempt) Object.assign(pending, batch); }
  }
}

function queue(key, rec) {
  pending[key] = rec;
  if (!timer) timer = setTimeout(flush, 20000);
}

// Auction log: one array per day, log-YYYY-MM-DD.json, in a PRIVATE repo (pm-derek/cardcomp-data, branch
// main). The public cardcomp repo carries prices only; the log carries usernames and the purchase ledger.
// The token needs Contents read/write on both repos. Appended, batched 60 s.
const LOG = { owner: "pm-derek", repo: "cardcomp-data", branch: "main" };
let pendingLog = [], logTimer = null, inflight = [];   // inflight: the batch being written right now
// The queue is mirrored to chrome.storage.local on every change and restored when the service worker starts: MV3
// stops an idle worker ~30 s after the last message, before the 60 s flush, and the last lots of a stream were lost
// with it. A batch stays stored until GitHub has it; no token keeps the rows (they go out once a token is saved).
// The phone app runs this file with a chrome.storage shim that keeps nothing: there the queue is memory only, as before.
const LOG_KEY = "cardcomp_pendingLog", LOG_CAP = 1500;
let logRestored = null;
function restoreLog() {
  if (!logRestored) logRestored = new Promise((res) => {
    try {
      chrome.storage.local.get(LOG_KEY, (r) => {
        const saved = r && Array.isArray(r[LOG_KEY]) ? r[LOG_KEY] : [];
        if (saved.length) pendingLog = mergeRows(saved.concat(pendingLog)).slice(-LOG_CAP);
        res();
      });
    } catch (_) { res(); }
  });
  return logRestored;
}
function saveLog() {
  return restoreLog().then(() => {
    try { chrome.storage.local.set({ [LOG_KEY]: inflight.concat(pendingLog).slice(-LOG_CAP) }, () => { try { void chrome.runtime.lastError; } catch (_) {} }); } catch (_) {}
  });
}
function logApi(day) { return `https://api.github.com/repos/${LOG.owner}/${LOG.repo}/contents/log-${day}.json`; }
async function flushLog() {
  logTimer = null;
  await restoreLog();
  if (inflight.length) { if (!logTimer) logTimer = setTimeout(flushLog, 60000); return; }   // a write is still running
  if (!pendingLog.length) return;
  const batch = pendingLog; pendingLog = []; inflight = batch;   // still stored (saveLog writes inflight too) until GitHub has it
  const tok = await token();
  let done = false;
  if (!tok) console.warn("CardComp: no GitHub token, auction log kept until one is saved");
  else {
    const month = new Date().toISOString().slice(0, 10), api = logApi(month);   // one file per day: each write re-uploads the whole file
    const hdr = { Authorization: "Bearer " + tok, Accept: "application/vnd.github+json" };
    for (let attempt = 0; attempt < 2 && !done; attempt++) {
      try {
        const { sha, rows } = await logFile(api, hdr);
        const body = { message: `Auction log: ${batch.length} lots`, branch: LOG.branch, content: b64enc(JSON.stringify(mergeRows(rows.concat(batch)))) };   // also folds a copy written by another CardComp window
        if (sha) body.sha = sha;
        const r = await fetch(api, { method: "PUT", headers: Object.assign({ "Content-Type": "application/json" }, hdr), body: JSON.stringify(body) });
        if (r.status === 409 || r.status === 422) continue;
        if (!r.ok) throw new Error("GitHub PUT " + r.status);
        done = true;
      } catch (e) { console.warn("CardComp auction log:", e.message); }
    }
  }
  inflight = [];
  if (!done) {   // not written: keep the lots for the next flush (a new lot, the retry below, or the next worker start)
    pendingLog = mergeRows(batch.concat(pendingLog)).slice(-LOG_CAP);
    if (tok && !logTimer) logTimer = setTimeout(flushLog, 60000);
  }
  await saveLog();
}
const logDayApi = (name) => `https://api.github.com/repos/${LOG.owner}/${LOG.repo}/contents/${name}`;
async function logDays(hdr, fromDay) {   // the log's day files from fromDay on: [{name, day}]
  const list = await fetch(`https://api.github.com/repos/${LOG.owner}/${LOG.repo}/contents/?ref=${LOG.branch}&t=${Date.now()}`, { headers: hdr, cache: "no-store" });
  if (!list.ok) throw new Error("GitHub list " + list.status);
  return (await list.json()).filter((f) => /^log-\d{4}-\d{2}-\d{2}\.json$/.test(f.name) && f.name.slice(4, 14) >= fromDay).map((f) => ({ name: f.name, day: f.name.slice(4, 14) }));
}
// Rewrite one day file: mutate(rows) returns the new rows, or null when nothing changes. A sha conflict (409 / 422:
// another write landed first) re-reads the file and applies mutate again, like flushLog. del: an empty file is deleted.
async function rewriteDay(api, hdr, j, mutate, message, del) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt || !j) { try { j = await logFile(api, hdr); } catch (e) { return { ok: false, why: e.message }; } }
    const n0 = j.rows.length, rows = j.sha ? mutate(j.rows) : null;
    if (!rows) return { ok: true, changed: false, n0, n1: n0 };
    const gone = del && !rows.length, body = { message, branch: LOG.branch, sha: j.sha };
    if (!gone) body.content = b64enc(JSON.stringify(rows));
    const r = await fetch(api, { method: gone ? "DELETE" : "PUT", headers: Object.assign({ "Content-Type": "application/json" }, hdr), body: JSON.stringify(body) });
    if (r.status === 409 || r.status === 422) continue;
    return r.ok ? { ok: true, changed: true, n0, n1: rows.length } : { ok: false, why: `GitHub ${gone ? "DELETE" : "PUT"} ${r.status}` };
  }
  return { ok: false, why: "the file kept changing (3 sha conflicts)" };
}
// Delete every logged lot with since <= at < before (before defaults to forever): drops queued rows, rewrites day files
// that keep other rows, deletes day files left empty. Derek-triggered from the stats panel ("clear logged data", or "✕
// remove" on one lot: since = at, before = at + 1). Removing one lot also removes the other device's copy of it
// (phone + desktop log the same lot with their own at; sameLotAcross), or it came back folded from the twin.
// Reply: {ok, removed, files, failed: ["log-YYYY-MM-DD.json: why", ...], why}; ok only when every file was written.
async function pruneLog(since, before) {
  since = +since || 0; before = before == null ? Infinity : +before;
  const inRange = (r) => (r.at || 0) >= since && (r.at || 0) < before;
  const single = before - since <= 1000;
  await restoreLog();
  const tok = await token();
  const hdr = tok ? { Authorization: "Bearer " + tok, Accept: "application/vnd.github+json" } : null;
  const failed = [], files = [];
  let listErr = "";
  if (tok) {
    try {
      for (const f of await logDays(hdr, new Date(Math.max(0, single ? since - 120000 : since)).toISOString().slice(0, 10))) {
        const api = logDayApi(f.name);
        try { files.push({ name: f.name, api, j: await logFile(api, hdr) }); } catch (e) { failed.push(f.name + ": " + e.message); }
      }
    } catch (e) { listErr = e.message; }
  }
  const targets = inflight.concat(pendingLog, ...files.map((f) => f.j.rows)).filter(inRange);
  const gone = (r) => inRange(r) || (single && targets.some((t) => t !== r && sameLotAcross(t, r)));
  const queued = pendingLog.length;
  pendingLog = pendingLog.filter((r) => !gone(r));
  let removed = queued - pendingLog.length, nFiles = 0;
  if (removed) await saveLog();
  if (!tok) return { ok: false, why: "no GitHub token", removed, failed };
  if (listErr) return { ok: false, why: listErr, removed, failed };
  for (const f of files) {
    if (!f.j.rows.some(gone)) continue;
    const res = await rewriteDay(f.api, hdr, f.j, (rows) => { const keep = rows.filter((r) => !gone(r)); return keep.length === rows.length ? null : keep; },
      "Clear logged lots", true);
    if (!res.ok) { failed.push(f.name + ": " + res.why); continue; }
    if (res.changed) { removed += res.n0 - res.n1; nFiles++; }
  }
  const out = { ok: !failed.length, removed, files: nFiles, failed };
  if (failed.length) out.why = `${removed} removed, but not written: ${failed.join("; ")}`;
  return out;
}
// Put a card on a logged lot after the fact (Derek, 2026-10-20: wins where no card was registered). key = {seller,
// startedAt, at}. A lot sits in the day file of the UTC day it was flushed, so look at its day and the next (and the day
// before, for the other device's copy). patch: change only some fields of the card already there (condition change,
// 2026-10-23), keeping max bid, tap time. rowPatch: fields of the lot row itself (coupon), not its card.
// The phone and desktop can each have a row of the same lot (folded only when read, sameLotAcross): the edit goes to
// both, and an edited card wins over a tapped one when they fold (card.label "fixed" / condFixedAt, row.cardCleared).
async function editLog(key, card, clear, patch, rowPatch) {
  const k = lotKey(key); if (!k || (!card && !clear && !patch && !rowPatch)) return { ok: false, why: "bad request" };   // clear: card removed (it was put on the wrong win)
  if (clear) card = null;
  else if (card && !patch && !rowPatch) card = Object.assign({}, card, { label: "fixed", fixedAt: card.fixedAt || Date.now() });
  await restoreLog();
  const tok = await token();
  const hdr = tok ? { Authorization: "Bearer " + tok, Accept: "application/vnd.github+json" } : null;
  const at = +key.at, days = [...new Set([at - 120000, at, at + 864e5, at + 864e5 + 120000].map((t) => new Date(t).toISOString().slice(0, 10)))];
  const files = [];
  let readErr = "";
  if (tok) for (const day of days) { const api = logApi(day); try { files.push({ day, api, j: await logFile(api, hdr) }); } catch (e) { readErr = e.message; } }
  const queue = inflight.concat(pendingLog), all = queue.concat(...files.map((f) => f.j.rows));
  const target = all.find((r) => lotKey(r) === k);
  if (!target) return { ok: false, why: readErr || (tok ? "lot not found in the log" : "no GitHub token") };
  const ref = Object.assign({}, target);   // who / what / when of the lot, to find the other device's copy
  const mine = (r) => lotKey(r) === k || sameLotAcross(ref, r);
  const base = target.card || ((all.find((r) => r !== target && sameLotAcross(ref, r) && r.card) || {}).card);   // the card shown may have come from the twin
  if (patch && !rowPatch && !base) return { ok: false, why: "that lot has no card in the log" };
  const newCard = rowPatch ? null : patch ? Object.assign({}, base, patch) : card;
  const apply = (r) => {
    if (rowPatch) { Object.assign(r, rowPatch); return; }
    r.card = newCard ? JSON.parse(JSON.stringify(newCard)) : null;
    if (clear) r.cardCleared = Date.now(); else delete r.cardCleared;
  };
  let inQueue = false;
  queue.forEach((r) => { if (mine(r)) { apply(r); inQueue = true; } });
  if (inQueue) await saveLog();
  const message = rowPatch ? `Lot edited: ${Object.entries(rowPatch).map(([k, v]) => k + " " + v).join(", ")}` : patch ? `Lot card changed: ${(newCard && newCard.n) || "?"} ${patch.cond || ""}`.trim() : card ? `Card added to a lot: ${card.n || "?"}` : "Card removed from a lot";
  let file = "", why = "", twins = 0;
  for (const f of files) {
    if (!f.j.rows.some(mine)) continue;
    const hasTarget = f.j.rows.some((r) => lotKey(r) === k);
    const res = await rewriteDay(f.api, hdr, f.j, (rows) => { let ch = false; rows.forEach((r) => { if (mine(r)) { apply(r); ch = true; } }); return ch ? rows : null; }, message, false);
    if (!res.ok) { why = (why ? why + "; " : "") + "log-" + f.day + ".json: " + res.why; continue; }
    if (hasTarget) file = "log-" + f.day + ".json"; else twins++;
  }
  if (why) return { ok: false, why };
  return file ? { ok: true, file, twins } : { ok: true, queued: true, twins };
}
// Every logged lot with at >= since, for the app's stream stats (one list call + one GET per day file).
// failed: days whose file could not be read (["2026-10-30", ...]); the app keeps its own rows for them instead of
// replacing them with nothing. ok stays true when at least one file was read (or there was none to read).
async function readLog(since) {
  since = +since || 0;
  const tok = await token();
  if (!tok) return { ok: false, why: "no GitHub token" };
  await restoreLog();
  const hdr = { Authorization: "Bearer " + tok, Accept: "application/vnd.github+json" };
  let days; try { days = await logDays(hdr, new Date(since).toISOString().slice(0, 10)); } catch (e) { return { ok: false, why: e.message }; }
  let rows = [], read = 0;
  const failed = [];
  for (const f of days) {
    try { rows = rows.concat((await logFile(logDayApi(f.name), hdr)).rows); read++; }
    catch (e) { failed.push(f.day); console.warn("CardComp auction log read " + f.name + ":", e.message); }
  }
  const out = { ok: read > 0 || !failed.length, rows: mergeRows(rows.concat(inflight, pendingLog)).filter((r) => (r.at || 0) >= since), failed };
  if (!out.ok) out.why = "could not read the log (" + failed.length + " day file" + (failed.length === 1 ? "" : "s") + ")";
  return out;
}
// A day file's rows + sha. Over 1 MB the contents API sends no content, so fetch the raw file then; reading it
// as empty would make the next write replace the whole day with one batch.
async function logFile(api, hdr) {
  const g = await fetch(`${api}?ref=${LOG.branch}&t=${Date.now()}`, { headers: hdr, cache: "no-store" });
  if (g.status === 404) return { sha: null, rows: [] };
  if (!g.ok) throw new Error("GitHub GET " + g.status);
  const j = await g.json();
  let txt = j.content ? b64dec(j.content) : "";
  if (!txt && j.size > 0) {
    const r = await fetch(`${api}?ref=${LOG.branch}&t=${Date.now()}`, { headers: Object.assign({}, hdr, { Accept: "application/vnd.github.raw" }), cache: "no-store" });
    if (!r.ok) throw new Error("GitHub raw " + r.status);
    txt = await r.text();
  }
  return { sha: j.sha, rows: JSON.parse(txt || "[]") || [] };   // a parse error throws: never write over a file we could not read
}
// One row per lot. Every CardComp copy that is open (side panel, a CardComp tab) receives the same lot-end and
// logs it, which wrote each lot 2-4 times. A lot is identified by the extension's own timestamps (startedAt + at
// are set once in whatnot.js), and the copy that knows the card wins.
const lotKey = (r) => r && r.startedAt != null && r.at != null ? `${r.seller || ""}|${r.startedAt}|${r.at}` : null;
// A card Derek set or cleared by hand (editLog) beats any tapped / viewed card: it is the correction.
const editAt = (r) => Math.max((r && r.cardCleared) || 0, (r && r.card && (r.card.fixedAt || r.card.condFixedAt || (r.card.label === "fixed" ? 1 : 0))) || 0);
const richness = (r) => (editAt(r) ? 20 : 0) + (r.card ? 10 : 0) + (r.card && r.card.label === "tap" ? 5 : 0) + ((r.bidsSent || []).length ? 2 : 0);
// The same lot logged by the phone app and a desktop browser watching the same stream (2026-10-23, rudeboi75404:
// every lot twice, the desktop row "no card", the phone row with the card Derek tapped). Each device stamps its own
// startedAt / at, so the key above never matches: same seller, title, final and winner within 2 minutes, from two
// different sources, is one lot. The kept row is the richer one, filled in from the other (card, bids, history).
const devOf = (r) => (r && r.src === "phone" ? "phone" : "desktop");
function sameLotAcross(a, b) {
  return !!a && !!b && devOf(a) !== devOf(b) && !!a.seller && a.seller === b.seller && (a.title || "") === (b.title || "") &&
    a.final === b.final && (a.winner || "") === (b.winner || "") && Math.abs((a.at || 0) - (b.at || 0)) < 120000;
}
function mergeAcross(a, b) {
  const keep = richness(b) > richness(a) ? b : a, other = keep === a ? b : a, out = Object.assign({}, keep);
  for (const f of ["card", "recog", "placedMax", "ship", "viewers", "giveaway", "sub", "sellerCond", "coupon"]) if (out[f] == null && other[f] != null) out[f] = other[f];
  const ea = editAt(a), eb = editAt(b);
  if (ea || eb) {   // a hand edit on either copy decides the card: the latest edit, and a cleared card stays cleared
    const w = eb > ea ? b : a;
    out.card = w.card || null;
    if (w.cardCleared) out.cardCleared = w.cardCleared; else delete out.cardCleared;
  }
  if (out.bids == null && other.bids != null) out.bids = other.bids;
  if (!(out.bidsSent || []).length && (other.bidsSent || []).length) out.bidsSent = other.bidsSent;
  if ((other.hist || []).length > (out.hist || []).length) { out.hist = other.hist; out.leaders = other.leaders; }
  out.me = !!(a.me || b.me); out.iLed = !!(a.iLed || b.iLed);
  out.seenBy = [...new Set([devOf(a), devOf(b), ...(a.seenBy || []), ...(b.seenBy || [])])];
  return out;
}
function mergeRows(rows) {
  const out = [], at = new Map();
  for (const r of rows) {
    const k = lotKey(r);
    if (k == null || !at.has(k)) {
      const j = out.findIndex((o) => sameLotAcross(o, r));   // the other device's row of this lot
      if (j >= 0) { const m = mergeAcross(out[j], r); at.set(lotKey(m), j); if (k != null) at.set(k, j); out[j] = m; continue; }
      if (k != null) at.set(k, out.length); out.push(r); continue;
    }
    { const o = out[at.get(k)]; if (!r.recog && o.recog) r.recog = o.recog; else if (r.recog && !o.recog) o.recog = r.recog; }   // RECOG keep the auto reading whichever CardComp copy logged it, removed by scripts/strip-recog.js
    { const o = out[at.get(k)]; if (r.coupon == null && o.coupon != null) r.coupon = o.coupon; else if (o.coupon == null && r.coupon != null) o.coupon = r.coupon; }   // a coupon typed on either copy stays
    const i = at.get(k); if (richness(r) > richness(out[i])) out[i] = r;
  }
  return out;
}
function queueLog(rec) {
  pendingLog = mergeRows(pendingLog.concat([rec])).slice(-LOG_CAP);
  saveLog();
  if (!logTimer) logTimer = setTimeout(flushLog, 60000);
}
// Worker start: lots queued before the last stop go out now.
restoreLog().then(() => { if (pendingLog.length && !logTimer) logTimer = setTimeout(flushLog, 5000); });
try { chrome.storage.onChanged.addListener((ch) => { if (ch.ghToken && ch.ghToken.newValue && !logTimer) logTimer = setTimeout(flushLog, 2000); }); } catch (_) {}   // token saved: send what was kept

async function test() {
  const tok = await token();
  if (!tok) return { ok: false, why: "no token saved" };
  try { const { data } = await ghGet(tok); return { ok: true, n: Object.keys(data).length }; }
  catch (e) { return { ok: false, why: e.message }; }
}
