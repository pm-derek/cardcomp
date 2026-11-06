// RECOG experiment: CardSight fields on the Options page (the Anthropic key field is wired in options.js). Removed by scripts/strip-recog.js.
(() => {
  // CardSight, side by side (2026-10-23)
  const ck = document.getElementById("cskey"), cm = document.getElementById("csmonth"), cst = document.getElementById("csst");
  const csShow = () => chrome.storage.local.get(["csKey", "csMonthly", "csUse"], (r) => {
    r = r || {};
    ck.placeholder = r.csKey ? "saved (" + r.csKey.slice(0, 6) + "...)" : "paste the key from cardsight.ai";
    cm.value = r.csMonthly || ""; const u = r.csUse; if (u && r.csKey) cst.textContent = "This month: " + u.n + " of " + (r.csMonthly || 750) + " calls used.";
  });
  csShow();
  document.getElementById("cssave").onclick = () => {
    const v = ck.value.trim(), mo = Math.max(0, parseInt(cm.value, 10) || 0), set = {};
    if (v) { if (v.length < 16 || /\s/.test(v)) { cst.textContent = "That does not look like a CardSight key."; return; } set.csKey = v; }
    if (mo) set.csMonthly = mo;
    if (!Object.keys(set).length) { cst.textContent = "Nothing to save."; return; }
    chrome.storage.local.set(set, () => { ck.value = ""; csShow(); cst.textContent = "Saved. Press Test to check it (free, does not use a call)."; });
  };
  document.getElementById("csclear").onclick = () => chrome.storage.local.remove(["csKey"], () => { csShow(); cst.textContent = "CardSight key removed: Claude only."; });
  document.getElementById("cstest").onclick = () => {
    cst.textContent = "Testing...";
    chrome.runtime.sendMessage({ type: "cs-key-test" }, (r) => { cst.textContent = r && r.ok ? "CardSight key works." : "Failed: " + ((r && r.why) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || "no answer"); });
  };
})();
