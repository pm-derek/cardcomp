// RECOG experiment results page. Reads the frames recog-bg.js saved in IndexedDB "cardcomp-recog".
function all() {
  return new Promise((res) => {
    const r = indexedDB.open("cardcomp-recog", 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains("frames")) r.result.createObjectStore("frames", { keyPath: "id", autoIncrement: true }); };
    r.onerror = () => res([]);
    r.onsuccess = () => { const q = r.result.transaction("frames").objectStore("frames").getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); };
  });
}
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
async function paint() {
  const rows = (await all()).sort((a, b) => b.at - a.at);
  const n = rows.length, ok = rows.filter((r) => r.ok).length;
  const by = (m) => rows.filter((r) => r.method === m).length;
  const later = rows.filter((r) => /^ok/.test(r.later || "")).length;
  const black = rows.filter((r) => r.ok && r.luma < 12).length;
  document.getElementById("sum").innerHTML = n ? `${n} grabs · ${ok} worked (video copy ${by("video")}, screenshot ${by("screenshot")}) · automatic 5 s later worked ${later} of ${n}` + (black ? ` · <span class="bad">${black} black frames</span>` : "") : "No grabs yet.";
  document.getElementById("list").innerHTML = rows.map((r) => `<div class="row">${r.img ? `<img src="${r.img}">` : `<div style="width:260px" class="bad">no frame</div>`}<div>
    <div><b class="${r.ok ? "ok" : "bad"}">${r.ok ? "grabbed by " + (r.method === "video" ? "video copy" : "screenshot") : "failed"}</b> · ${new Date(r.at).toLocaleString()}</div>
    <div class="dim">${r.w}x${r.h} · ${r.kb} KB · ${r.ms} ms · brightness ${r.luma == null ? "-" : r.luma}${r.luma < 12 ? " (black)" : ""}</div>
    <div class="dim">5 s later, no key press: ${esc(r.later)}</div>
    ${r.tries && r.tries.length ? `<div class="dim">${r.tries.map(esc).join("<br>")}</div>` : ""}
    <div><code>${esc(JSON.stringify(r.video))}</code></div><div class="dim">${esc(r.url)}</div></div></div>`).join("");
}
document.getElementById("exp").onclick = async () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(await all())], { type: "application/json" }));
  a.download = "cardcomp-recog-" + new Date().toISOString().slice(0, 10) + ".json"; a.click();
};
document.getElementById("wipe").onclick = () => {
  if (!confirm("Delete every recognition test frame?")) return;
  const r = indexedDB.deleteDatabase("cardcomp-recog"); r.onsuccess = r.onerror = paint;
};
paint(); setInterval(paint, 5000);
