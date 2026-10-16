// Runs on the CardComp page. copyAmt() posts {type:"cardcomp-bid", amount} to its own window;
// forward it to the extension and post the result back so the tapped bid can say "Whatnot $X".
window.addEventListener("message", (e) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const d = e.data;
  if (d && /^cardcomp-auto-(hello|config|match|outcome|read)$/.test(d.type || "")) { try { chrome.runtime.sendMessage(d, () => chrome.runtime.lastError); } catch (_) {} return; }   // RECOG app -> extension
  if (d && (d.type === "cardcomp-live-save" || d.type === "cardcomp-log-save" || d.type === "cardcomp-open-bg")) { try { chrome.runtime.sendMessage(d, () => chrome.runtime.lastError); } catch (_) {} return; }
  if (d && d.type === "cardcomp-snapshot") { try { chrome.runtime.sendMessage(d, (r) => window.postMessage(Object.assign({ type: "cardcomp-snapshot-ack" }, chrome.runtime.lastError ? { ok: false, why: chrome.runtime.lastError.message } : r), location.origin)); } catch (_) {} return; }
  if (d && (d.type === "cardcomp-log-prune" || d.type === "cardcomp-log-read")) {
    try { chrome.runtime.sendMessage(d, (r) => window.postMessage(Object.assign({ type: d.type + "-ack" }, chrome.runtime.lastError ? { ok: false, why: chrome.runtime.lastError.message } : r), location.origin)); } catch (_) {}
    return;
  }
  if (d && d.type === "cardcomp-status") {
    try { chrome.runtime.sendMessage(d, (r) => { if (!chrome.runtime.lastError && r) window.postMessage({ type: "cardcomp-status-ack", whatnot: !!r.whatnot, store: !!r.store }, location.origin); }); } catch (_) {}
    return;
  }
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
chrome.runtime.onMessage.addListener((msg) => { if (msg && /^cardcomp-(tcg-price|lot|lot-end)$/.test(msg.type)) window.postMessage(msg, location.origin); });
chrome.runtime.onMessage.addListener((msg) => { if (msg && /^cardcomp-auto(-state|-adopt|-watch|-readack)?$/.test(msg.type)) window.postMessage(msg, location.origin); });   // RECOG extension -> app
