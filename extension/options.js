const tok = document.getElementById("tok"), st = document.getElementById("st");
chrome.storage.local.get("ghToken", (r) => { if (r.ghToken) tok.placeholder = "saved (" + r.ghToken.slice(0, 10) + "...)"; });
document.getElementById("save").onclick = () => {
  const v = tok.value.trim();
  if (!v) { st.textContent = "Nothing to save."; return; }
  chrome.storage.local.set({ ghToken: v }, () => { st.textContent = "Saved."; tok.value = ""; tok.placeholder = "saved (" + v.slice(0, 10) + "...)"; });
};
const wn = document.getElementById("wn"), stwn = document.getElementById("stwn");
chrome.storage.local.get("wnUser", (r) => { if (r.wnUser) wn.value = r.wnUser; });
document.getElementById("savewn").onclick = () => {
  const v = wn.value.trim().replace(/^@/, "");
  chrome.storage.local.set({ wnUser: v }, () => { stwn.textContent = v ? "Saved. Reload the Whatnot tab." : "Cleared."; });
};
document.getElementById("test").onclick = () => {
  st.textContent = "Testing...";
  chrome.runtime.sendMessage({ type: "cardcomp-live-test" }, (r) => { st.textContent = r && r.ok ? "OK: can read live.json (" + r.n + " entries)." : "Failed: " + (r && r.why || chrome.runtime.lastError && chrome.runtime.lastError.message); });
};
