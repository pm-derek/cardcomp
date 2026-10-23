// RECOG experiment: API key field on the Options page. Removed by scripts/strip-recog.js.
(() => {
  const k = document.getElementById("rkey"), st = document.getElementById("rst");
  const show = () => chrome.storage.local.get("recogKey", (r) => { k.placeholder = r.recogKey ? "saved (" + r.recogKey.slice(0, 12) + "...)" : "sk-ant-..."; });
  show();
  document.getElementById("rsave").onclick = () => {
    const v = k.value.trim();
    if (!/^sk-ant-/.test(v)) { st.textContent = "That does not look like an Anthropic key (starts with sk-ant-)."; return; }
    chrome.storage.local.set({ recogKey: v }, () => { k.value = ""; show(); st.textContent = "Saved. Press Test to check it."; });
  };
  document.getElementById("rclear").onclick = () => chrome.storage.local.remove(["recogKey", "recogOn", "recogMode"], () => { show(); st.textContent = "Key removed, auto-recognition off."; });
  // CardSight, side by side (2026-10-23)
  const ck = document.getElementById("cskey"), cm = document.getElementById("csmonth"), cst = document.getElementById("csst");
  const csShow = () => chrome.storage.local.get(["csKey", "csMonthly", "csUse"], (r) => {
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
  document.getElementById("rtest").onclick = () => {
    st.textContent = "Testing (one tiny Haiku call, well under a cent)...";
    chrome.runtime.sendMessage({ type: "recog-key-test" }, (r) => { st.textContent = r && r.ok ? "Key works." : "Failed: " + ((r && r.why) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || "no answer"); });
  };
})();
