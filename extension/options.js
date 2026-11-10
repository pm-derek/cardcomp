const tok = document.getElementById("tok"), st = document.getElementById("st");
chrome.storage.local.get("ghToken", (r) => { if (r && r.ghToken) tok.placeholder = "saved (" + r.ghToken.slice(0, 10) + "...)"; });
document.getElementById("save").onclick = () => {
  const v = tok.value.trim();
  if (!v) { st.textContent = "Nothing to save."; return; }
  chrome.storage.local.set({ ghToken: v }, () => { st.textContent = "Saved."; tok.value = ""; tok.placeholder = "saved (" + v.slice(0, 10) + "...)"; });
};
const wn = document.getElementById("wn"), stwn = document.getElementById("stwn");
chrome.storage.local.get("wnUser", (r) => { if (r && r.wnUser) wn.value = r.wnUser; });
document.getElementById("savewn").onclick = () => {
  const v = wn.value.trim().replace(/^@/, "");
  chrome.storage.local.set({ wnUser: v }, () => { stwn.textContent = v ? "Saved. Reload the Whatnot tab." : "Cleared."; });
};
document.getElementById("test").onclick = () => {
  st.textContent = "Testing...";
  chrome.runtime.sendMessage({ type: "cardcomp-live-test" }, (r) => { st.textContent = r && r.ok ? "OK: can read live.json (" + r.n + " entries)." : "Failed: " + (r && r.why || chrome.runtime.lastError && chrome.runtime.lastError.message); });
};
// Anthropic key (feedback thank-yous; auto-recognition reads the same key)
const rk = document.getElementById("rkey"), rst = document.getElementById("rst");
const rkShow = () => chrome.storage.local.get("recogKey", (r) => { rk.placeholder = r && r.recogKey ? "saved (" + r.recogKey.slice(0, 12) + "...)" : "sk-ant-..."; });
rkShow();
document.getElementById("rsave").onclick = () => {
  const v = rk.value.trim();
  if (!/^sk-ant-/.test(v)) { rst.textContent = "That does not look like an Anthropic key (starts with sk-ant-)."; return; }
  chrome.storage.local.set({ recogKey: v }, () => { rk.value = ""; rkShow(); rst.textContent = "Saved. Press Test to check it."; });
};
document.getElementById("rclear").onclick = () => chrome.storage.local.remove(["recogKey", "recogOn", "recogMode"], () => { rkShow(); rst.textContent = "Key removed."; });
document.getElementById("rtest").onclick = () => {
  rst.textContent = "Testing (one tiny call, well under a cent)...";
  chrome.runtime.sendMessage({ type: "cardcomp-fb-key-test" }, (r) => { rst.textContent = r && r.ok ? "Key works." : "Failed: " + ((r && r.why) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || "no answer"); });
};
// Return address (issue replies)
const fa = document.getElementById("fbaddr"), fast_ = document.getElementById("fbaddrst");
chrome.storage.local.get("fbAddress", (r) => { if (r && r.fbAddress) fa.value = r.fbAddress; });
document.getElementById("fbaddrsave").onclick = () => { const v = fa.value.trim(); chrome.storage.local.set({ fbAddress: v }, () => { fast_.textContent = v ? "Saved." : "Cleared."; }); };
// Order history CSV (repeat-buyer badges)
const fcsv = document.getElementById("fbcsv"), fcst = document.getElementById("fbcsvst");
const fbSummary = () => chrome.runtime.sendMessage({ type: "cardcomp-fb-buyers-summary" }, (r) => {
  if (!r || !r.ok || !r.orders) { fcst.textContent = "Nothing imported yet."; return; }
  const d = (ms) => ms ? new Date(ms).toLocaleDateString() : "?";
  fcst.textContent = r.orders + " orders from " + r.buyers + " buyers, " + r.repeat + " of them repeat, " + d(r.first) + " to " + d(r.last) + ".";
});
fbSummary();
document.getElementById("fbcsvgo").onclick = () => {
  const f = fcsv.files && fcsv.files[0]; if (!f) { fcst.textContent = "Pick the exported CSV first."; return; }
  fcst.textContent = "Importing…";
  const rd = new FileReader();
  rd.onload = () => chrome.runtime.sendMessage({ type: "cardcomp-fb-buyers-import", csv: String(rd.result || "") }, (r) => {
    if (!r || !r.ok) { fcst.textContent = "Failed: " + ((r && r.why) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || "no answer"); return; }
    fcst.textContent = r.added + " new orders added. "; fbSummary();
  });
  rd.readAsText(f);
};
