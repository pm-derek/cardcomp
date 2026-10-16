// Side panel: CardComp in an iframe. The iframe posts bids to its parent (this page); relay and ack.
const cc = document.getElementById("cc");
window.addEventListener("message", (e) => {
  const d = e.data;
  if (!d || e.source !== cc.contentWindow) return;
  if (d.type === "cardcomp-live-save" || d.type === "cardcomp-log-save" || d.type === "cardcomp-open-bg") { chrome.runtime.sendMessage(d, () => chrome.runtime.lastError); return; }
  if (d.type === "cardcomp-snapshot") { chrome.runtime.sendMessage(d, (r) => cc.contentWindow.postMessage(Object.assign({ type: "cardcomp-snapshot-ack" }, chrome.runtime.lastError ? { ok: false, why: chrome.runtime.lastError.message } : r), "*")); return; }
  if (d.type === "cardcomp-log-prune" || d.type === "cardcomp-log-read") {
    chrome.runtime.sendMessage(d, (r) => cc.contentWindow.postMessage(Object.assign({ type: d.type + "-ack" }, chrome.runtime.lastError ? { ok: false, why: chrome.runtime.lastError.message } : r), "*"));
    return;
  }
  if (d.type === "cardcomp-status") {
    chrome.runtime.sendMessage(d, (r) => { if (!chrome.runtime.lastError && r) cc.contentWindow.postMessage({ type: "cardcomp-status-ack", whatnot: !!r.whatnot, store: !!r.store }, "*"); });
    return;
  }
  if (d.type !== "cardcomp-bid") return;
  chrome.runtime.sendMessage(d, (r) => {
    const err = chrome.runtime.lastError;
    cc.contentWindow.postMessage({ type: "cardcomp-bid-ack", ok: !!(r && r.ok) && !err, why: err ? err.message : (r && r.why) }, "*");
  });
});

cc.addEventListener("load", () => cc.contentWindow.postMessage({ type: "cardcomp-ext-ready" }, "*"));
chrome.runtime.onMessage.addListener((msg) => { if (msg && /^cardcomp-(tcg-price|lot|lot-end)$/.test(msg.type)) cc.contentWindow.postMessage(msg, "*"); });
