// Side panel: CardComp in an iframe. The iframe posts bids to its parent (this page); relay and ack.
const cc = document.getElementById("cc");
// Window pairing (see bg.js toApps): this panel talks to the stream in its own window, and keeps only messages from it.
// A window with no Whatnot tab follows the main stream (primary).
let WIN = null, HAS_WN = true;
const WN = "https://*.whatnot.com/*";
const hasWn = () => { if (WIN != null) chrome.tabs.query({ windowId: WIN, url: WN }, (t) => { HAS_WN = !chrome.runtime.lastError && t.length > 0; }); };
chrome.windows.getCurrent((w) => { WIN = w ? w.id : null; hasWn(); });
chrome.tabs.onCreated.addListener(hasWn); chrome.tabs.onRemoved.addListener(hasWn); chrome.tabs.onAttached.addListener(hasWn); chrome.tabs.onDetached.addListener(hasWn);
chrome.tabs.onUpdated.addListener((id, ch) => { if (ch.url || ch.status === "complete") hasWn(); });
// A content script's runtime message reaches every extension page, this panel included, untagged (Derek, 2026-10-23:
// the other window's lot showed here). Only the background's relay (toApps, tagged with win) counts: drop direct copies.
const mine = (msg, sender) => !(sender && sender.tab) && (msg.win == null || WIN == null || msg.win === WIN || (!HAS_WN && msg.primary));
const send = (d, cb) => chrome.runtime.sendMessage(Object.assign({}, d, WIN != null ? { win: WIN } : {}), cb || (() => chrome.runtime.lastError));
window.addEventListener("message", (e) => {
  const d = e.data;
  if (!d || e.source !== cc.contentWindow) return;
  if (/^cardcomp-auto-(hello|config|match|outcome|read)$/.test(d.type || "")) { send(d); return; }   // RECOG app -> extension
  if (d.type === "cardcomp-auto-img") { send(d, (r) => cc.contentWindow.postMessage(Object.assign({}, chrome.runtime.lastError ? { ok: false, why: chrome.runtime.lastError.message } : r, { type: "cardcomp-auto-img-ack", key: d.key, n: d.n }), "*")); return; }   // RECOG picture match (the reading's key / n win over the reply's fields)
  if (d.type === "cardcomp-tcg-post") { send(d, (r) => cc.contentWindow.postMessage(Object.assign({}, chrome.runtime.lastError ? { ok: false, err: chrome.runtime.lastError.message } : r, { type: "cardcomp-tcg-post-ack", req: d.req }), "*")); return; }   // Chinese copy prices
  if (d.type === "cardcomp-tcg-fast") { send(d, (r) => cc.contentWindow.postMessage(Object.assign({}, chrome.runtime.lastError ? { ok: false, errs: [chrome.runtime.lastError.message] } : r, { type: "cardcomp-tcg-fast-ack", req: d.req }), "*")); return; }
  if (d.type === "cardcomp-live-save" || d.type === "cardcomp-log-save" || d.type === "cardcomp-open-bg") { send(d); return; }
  if (d.type === "cardcomp-snapshot") { send(d, (r) => cc.contentWindow.postMessage(Object.assign({ type: "cardcomp-snapshot-ack" }, chrome.runtime.lastError ? { ok: false, why: chrome.runtime.lastError.message } : r), "*")); return; }
  if (d.type === "cardcomp-log-prune" || d.type === "cardcomp-log-read" || d.type === "cardcomp-log-edit") {
    send(d, (r) => cc.contentWindow.postMessage(Object.assign({ type: d.type + "-ack" }, chrome.runtime.lastError ? { ok: false, why: chrome.runtime.lastError.message } : r), "*"));
    return;
  }
  if (d.type === "cardcomp-status") {
    send(d, (r) => { if (!chrome.runtime.lastError && r) cc.contentWindow.postMessage({ type: "cardcomp-status-ack", whatnot: !!r.whatnot, store: !!r.store }, "*"); });
    return;
  }
  if (d.type !== "cardcomp-bid") return;
  send(d, (r) => {
    const err = chrome.runtime.lastError;
    cc.contentWindow.postMessage({ type: "cardcomp-bid-ack", ok: !!(r && r.ok) && !err, why: err ? err.message : (r && r.why) }, "*");
  });
});

cc.addEventListener("load", () => cc.contentWindow.postMessage({ type: "cardcomp-ext-ready" }, "*"));
chrome.runtime.onMessage.addListener((msg, sender) => { if (msg && /^cardcomp-(tcg-price|lot|lot-end)$/.test(msg.type) && mine(msg, sender)) cc.contentWindow.postMessage(msg, "*"); });
chrome.runtime.onMessage.addListener((msg, sender) => { if (msg && /^cardcomp-auto(-state|-adopt|-watch|-readack)?$/.test(msg.type) && mine(msg, sender)) cc.contentWindow.postMessage(msg, "*"); });   // RECOG extension -> app
