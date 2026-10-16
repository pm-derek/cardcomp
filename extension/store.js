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

// Auction log: one array per month, log-YYYY-MM.json on the same branch. Appended, batched 60 s.
let pendingLog = [], logTimer = null;
function logApi(month) { return `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/log-${month}.json`; }
async function flushLog() {
  logTimer = null;
  const batch = pendingLog; pendingLog = [];
  if (!batch.length) return;
  const tok = await token();
  if (!tok) return;
  const month = new Date().toISOString().slice(0, 7), api = logApi(month);
  const hdr = { Authorization: "Bearer " + tok, Accept: "application/vnd.github+json" };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const g = await fetch(`${api}?ref=${GH.branch}&t=${Date.now()}`, { headers: hdr, cache: "no-store" });
      let sha = null, rows = [];
      if (g.ok) { const j = await g.json(); sha = j.sha; try { rows = JSON.parse(b64dec(j.content)) || []; } catch (_) {} }
      else if (g.status !== 404) throw new Error("GitHub GET " + g.status);
      const body = { message: `Auction log: ${batch.length} lots`, branch: GH.branch, content: b64enc(JSON.stringify(rows.concat(batch))) };
      if (sha) body.sha = sha;
      const r = await fetch(api, { method: "PUT", headers: Object.assign({ "Content-Type": "application/json" }, hdr), body: JSON.stringify(body) });
      if (r.status === 409 || r.status === 422) continue;
      if (!r.ok) throw new Error("GitHub PUT " + r.status);
      return;
    } catch (e) { console.warn("CardComp auction log:", e.message); if (attempt) pendingLog = batch.concat(pendingLog); }
  }
}
function queueLog(rec) {
  pendingLog.push(rec);
  if (!logTimer) logTimer = setTimeout(flushLog, 60000);
}

async function test() {
  const tok = await token();
  if (!tok) return { ok: false, why: "no token saved" };
  try { const { data } = await ghGet(tok); return { ok: true, n: Object.keys(data).length }; }
  catch (e) { return { ok: false, why: e.message }; }
}
