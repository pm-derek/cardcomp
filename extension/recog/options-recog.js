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
  document.getElementById("rtest").onclick = () => {
    st.textContent = "Testing (one tiny Haiku call, well under a cent)...";
    chrome.runtime.sendMessage({ type: "recog-key-test" }, (r) => { st.textContent = r && r.ok ? "Key works." : "Failed: " + ((r && r.why) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || "no answer"); });
  };
})();
