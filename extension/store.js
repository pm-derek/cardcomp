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
let pendingLog = [], logTimer = null;
function logApi(day) { return `https://api.github.com/repos/${LOG.owner}/${LOG.repo}/contents/log-${day}.json`; }
async function flushLog() {
  logTimer = null;
  const batch = pendingLog; pendingLog = [];
  if (!batch.length) return;
  const tok = await token();
  if (!tok) return;
  const month = new Date().toISOString().slice(0, 10), api = logApi(month);   // one file per day: each write re-uploads the whole file
  const hdr = { Authorization: "Bearer " + tok, Accept: "application/vnd.github+json" };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { sha, rows } = await logFile(api, hdr);
      const body = { message: `Auction log: ${batch.length} lots`, branch: LOG.branch, content: b64enc(JSON.stringify(mergeRows(rows.concat(batch)))) };   // also folds a copy written by another CardComp window
      if (sha) body.sha = sha;
      const r = await fetch(api, { method: "PUT", headers: Object.assign({ "Content-Type": "application/json" }, hdr), body: JSON.stringify(body) });
      if (r.status === 409 || r.status === 422) continue;
      if (!r.ok) throw new Error("GitHub PUT " + r.status);
      return;
    } catch (e) { console.warn("CardComp auction log:", e.message); }
  }
  pendingLog = batch.concat(pendingLog);   // not written: keep the lots for the next flush
  if (!logTimer) logTimer = setTimeout(flushLog, 60000);
}
// Delete every logged lot with at >= since (0 = everything): drops queued rows, rewrites day files that keep
// older rows, deletes day files left empty. Derek-triggered from the stats panel ("clear logged data").
async function pruneLog(since, before) {   // deletes rows with since <= at < before (before defaults to forever)
  since = +since || 0; before = before == null ? Infinity : +before;
  const gone = (r) => (r.at || 0) >= since && (r.at || 0) < before;
  const queued = pendingLog.length;
  pendingLog = pendingLog.filter((r) => !gone(r));
  let removed = queued - pendingLog.length, files = 0;
  const tok = await token();
  if (!tok) return { ok: false, why: "no GitHub token", removed };
  const hdr = { Authorization: "Bearer " + tok, Accept: "application/vnd.github+json" };
  const list = await fetch(`https://api.github.com/repos/${LOG.owner}/${LOG.repo}/contents/?ref=${LOG.branch}&t=${Date.now()}`, { headers: hdr, cache: "no-store" });
  if (!list.ok) return { ok: false, why: "GitHub list " + list.status, removed };
  const sinceDay = new Date(since).toISOString().slice(0, 10);
  for (const f of (await list.json()).filter((f) => /^log-\d{4}-\d{2}-\d{2}\.json$/.test(f.name) && f.name.slice(4, 14) >= sinceDay)) {
    const api = `https://api.github.com/repos/${LOG.owner}/${LOG.repo}/contents/${f.name}`;
    let j; try { j = await logFile(api, hdr); } catch (_) { continue; }
    const rows = j.rows;
    const keep = rows.filter((r) => !gone(r));
    if (keep.length === rows.length) continue;
    removed += rows.length - keep.length; files++;
    const body = keep.length
      ? { message: `Clear ${rows.length - keep.length} logged lots`, branch: LOG.branch, sha: j.sha, content: b64enc(JSON.stringify(keep)) }
      : { message: `Clear ${rows.length} logged lots`, branch: LOG.branch, sha: j.sha };
    await fetch(api, { method: keep.length ? "PUT" : "DELETE", headers: Object.assign({ "Content-Type": "application/json" }, hdr), body: JSON.stringify(body) });
  }
  return { ok: true, removed, files };
}
// Put a card on a logged lot after the fact (Derek, 2026-10-20: wins where no card was registered). key = {seller,
// startedAt, at}. A lot sits in the day file of the UTC day it was flushed, so look at its day and the next.
// patch: change only some fields of the card already there (condition change, 2026-10-23), keeping max bid, tap time.
async function editLog(key, card, clear, patch, rowPatch) {   // rowPatch: fields of the lot row itself (coupon), not its card
  const k = lotKey(key); if (!k || (!card && !clear && !patch && !rowPatch)) return { ok: false, why: "bad request" };   // clear: card removed (it was put on the wrong win)
  if (clear) card = null;
  const next = (old) => patch ? (old ? Object.assign({}, old, patch) : old) : card;
  let hit = false;
  const apply = (r) => { if (rowPatch) Object.assign(r, rowPatch); else r.card = next(r.card); };
  pendingLog.forEach((r) => { if (lotKey(r) === k) { apply(r); hit = true; } });
  const tok = await token();
  if (!tok) return { ok: hit, why: hit ? "" : "no GitHub token" };
  const hdr = { Authorization: "Bearer " + tok, Accept: "application/vnd.github+json" };
  const day0 = new Date(+key.at).toISOString().slice(0, 10), day1 = new Date(+key.at + 864e5).toISOString().slice(0, 10);
  for (const day of [day0, day1]) {
    const api = logApi(day);
    for (let attempt = 0; attempt < 2; attempt++) {
      let j; try { j = await logFile(api, hdr); } catch (e) { return { ok: hit, why: e.message }; }
      const row = j.rows.find((r) => lotKey(r) === k); if (!row) break;
      if (patch && !rowPatch && !row.card) return { ok: false, why: "that lot has no card in the log" };
      apply(row);
      const r = await fetch(api, { method: "PUT", headers: Object.assign({ "Content-Type": "application/json" }, hdr),
        body: JSON.stringify({ message: rowPatch ? `Lot edited: ${Object.entries(rowPatch).map(([k, v]) => k + " " + v).join(", ")}` : patch ? `Lot card changed: ${(row.card && row.card.n) || "?"} ${patch.cond || ""}`.trim() : card ? `Card added to a lot: ${card.n || "?"}` : "Card removed from a lot", branch: LOG.branch, sha: j.sha, content: b64enc(JSON.stringify(j.rows)) }) });
      if (r.status === 409 || r.status === 422) continue;
      return r.ok ? { ok: true, file: "log-" + day + ".json" } : { ok: false, why: "GitHub PUT " + r.status };
    }
  }
  return hit ? { ok: true, queued: true } : { ok: false, why: "lot not found in the log" };
}
// Every logged lot with at >= since, for the app's stream stats (one list call + one GET per day file).
async function readLog(since) {
  since = +since || 0;
  const tok = await token();
  if (!tok) return { ok: false, why: "no GitHub token" };
  const hdr = { Authorization: "Bearer " + tok, Accept: "application/vnd.github+json" };
  const list = await fetch(`https://api.github.com/repos/${LOG.owner}/${LOG.repo}/contents/?ref=${LOG.branch}&t=${Date.now()}`, { headers: hdr, cache: "no-store" });
  if (!list.ok) return { ok: false, why: "GitHub list " + list.status };
  const sinceDay = new Date(since).toISOString().slice(0, 10);
  let rows = [];
  for (const f of (await list.json()).filter((f) => /^log-\d{4}-\d{2}-\d{2}\.json$/.test(f.name) && f.name.slice(4, 14) >= sinceDay)) {
    try { rows = rows.concat((await logFile(`https://api.github.com/repos/${LOG.owner}/${LOG.repo}/contents/${f.name}`, hdr)).rows); } catch (_) {}
  }
  return { ok: true, rows: mergeRows(rows.concat(pendingLog)).filter((r) => (r.at || 0) >= since) };
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
const richness = (r) => (r.card ? 10 : 0) + (r.card && r.card.label === "tap" ? 5 : 0) + ((r.bidsSent || []).length ? 2 : 0);
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
  pendingLog = mergeRows(pendingLog.concat([rec]));
  if (!logTimer) logTimer = setTimeout(flushLog, 60000);
}

async function test() {
  const tok = await token();
  if (!tok) return { ok: false, why: "no token saved" };
  try { const { data } = await ghGet(tok); return { ok: true, n: Object.keys(data).length }; }
  catch (e) { return { ok: false, why: e.message }; }
}
