// Runs on the CardComp page. copyAmt() posts {type:"cardcomp-bid", amount} to its own window;
// forward it to the extension and post the result back so the tapped bid can say "Whatnot $X".
window.addEventListener("message", (e) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const d = e.data;
  if (!d || d.type !== "cardcomp-bid") return;
  try {
    chrome.runtime.sendMessage(d, (r) => {
      const err = chrome.runtime.lastError;
      window.postMessage({ type: "cardcomp-bid-ack", ok: !!(r && r.ok) && !err, why: err ? err.message : (r && r.why) }, location.origin);
    });
  } catch (_) {
    window.postMessage({ type: "cardcomp-bid-ack", ok: false, why: "extension reloaded, refresh CardComp" }, location.origin);
  }
});

// Hello, so CardComp can label the bid chips "this bid goes into Whatnot".
window.postMessage({ type: "cardcomp-ext-ready" }, location.origin);
chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === "cardcomp-tcg-price") window.postMessage(msg, location.origin); });
