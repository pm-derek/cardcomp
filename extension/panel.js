// Side panel: CardComp in an iframe. The iframe posts bids to its parent (this page); relay and ack.
const cc = document.getElementById("cc");
window.addEventListener("message", (e) => {
  const d = e.data;
  if (!d || d.type !== "cardcomp-bid" || e.source !== cc.contentWindow) return;
  chrome.runtime.sendMessage(d, (r) => {
    const err = chrome.runtime.lastError;
    cc.contentWindow.postMessage({ type: "cardcomp-bid-ack", ok: !!(r && r.ok) && !err, why: err ? err.message : (r && r.why) }, "*");
  });
});

cc.addEventListener("load", () => cc.contentWindow.postMessage({ type: "cardcomp-ext-ready" }, "*"));
chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === "cardcomp-tcg-price") cc.contentWindow.postMessage(msg, "*"); });
