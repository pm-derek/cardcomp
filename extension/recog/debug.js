// RECOG experiment results page: reads IndexedDB "cardcomp-recog" (stores "lots" and "frames") written by recog-bg.js.
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("cardcomp-recog", 2);
    r.onupgradeneeded = () => { const d = r.result;
      if (!d.objectStoreNames.contains("frames")) d.createObjectStore("frames", { keyPath: "id", autoIncrement: true });
      if (!d.objectStoreNames.contains("lots")) d.createObjectStore("lots", { keyPath: "key" }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function all(store) { const d = await db(); return new Promise((res) => { const q = d.transaction(store).objectStore(store).getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); }); }
async function put(store, rec) { const d = await db(); return new Promise((res) => { const tx = d.transaction(store, "readwrite"); tx.objectStore(store).put(rec); tx.oncomplete = res; tx.onerror = res; }); }
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (x) => "$" + (x || 0).toFixed(x < 0.1 ? 4 : 2);
const pct = (a, b) => b ? Math.round(100 * a / b) + "%" : "-";
const q = (xs, p) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };

// The lot's verdict: compare the shown suggestion and candidates with the card Derek tapped / opened (or his review).
function verdict(L) {
  const m = (L.matches || []).filter((x) => x.filled !== false).pop() || (L.matches || []).slice(-1)[0];
  const truth = L.outcome && L.outcome.card && L.outcome.card.id && !L.outcome.card.multi ? L.outcome.card.id : null;
  const rv = L.review || "";
  if (!m) return { m, v: "none", label: L.reads && L.reads.some((r) => r.error) ? "error" : "no reading" };
  if (truth) {
    if (m.suggestion === truth) return { m, truth, v: "agree", label: (m.strength === "strong" ? "strong" : "guess") + " right" };
    if (m.suggestion) return { m, truth, v: "miss", label: (m.strength === "strong" ? "STRONG WRONG" : "guess wrong") + ((m.cards || []).some((c) => c.id === truth) ? ", right card listed" : "") };
    if ((m.cards || []).some((c) => c.id === truth)) return { m, truth, v: "listed", label: "no pick, right card listed" };
    return { m, truth, v: "miss", label: "right card not listed" };
  }
  if (rv === "right") return { m, v: "agree", label: "marked right" };
  if (rv === "listed") return { m, v: "listed", label: "marked: right card listed" };
  if (rv === "wrong") return { m, v: "miss", label: "marked wrong" };
  if (rv === "nocard") return { m, v: "none", label: "marked: no card on screen" };
  if (m.kind === "no-card") return { m, v: "none", label: "no card in view" };
  return { m, v: "todo", label: "to review" };
}

// Printing verdict: auto named a printing for the right card, and Derek picked one (tap or opened card).
function pv(L) {
  const m = L.V && L.V.m, c = L.outcome && L.outcome.card;
  if (!m || !m.printing || !c || !c.printing || L.V.v !== "agree") return "";
  return m.printing === c.printing ? "right" : "wrong (you: " + c.printing + ")";
}
async function paint() {
  const lots = (await all("lots")).filter((L) => (L.reads || []).length);
  const V = lots.map((L) => Object.assign(L, { V: verdict(L) }));
  const reads = lots.flatMap((L) => L.reads || []);
  const first = lots.map((L) => (L.reads || []).find((r) => r.n === 1)).filter((r) => r && r.ms);
  const cost = reads.reduce((a, r) => a + (r.cost || 0), 0);
  const labeled = V.filter((L) => L.V.v !== "none" && L.V.v !== "todo");
  const fromTaps = V.filter((L) => L.V.truth).length, todo = V.filter((L) => L.V.v === "todo").length;
  const strong = V.filter((L) => L.V.m && L.V.m.strength === "strong" && (L.V.truth || /marked/.test(L.V.label)));
  const strongWrong = strong.filter((L) => L.V.v === "miss").length;
  const kinds = {}; V.forEach((L) => { const k = L.V.m ? L.V.m.kind : "none"; kinds[k] = (kinds[k] || 0) + 1; });
  const models = {}; reads.forEach((r) => { if (r.model) models[r.model] = (models[r.model] || 0) + 1; });
  document.getElementById("sum").innerHTML = lots.length ? [
    `<b>${lots.length} lots read</b> · ${reads.length} frames (${lots.filter((L) => (L.reads || []).length > 1).length} lots needed a 2nd) · ${Object.entries(models).map(([m, n]) => esc(m) + " " + n).join(", ")}`,
    `<b>Strong suggestion wrong: <span class="${strongWrong ? "bad" : "ok"}">${strongWrong} of ${strong.length}</span></b> (the number to watch)`,
    `<b>To review: ${todo}</b> (at the top) · scored from the card you tapped or opened: ${fromTaps} · reviewed by hand: ${labeled.length - fromTaps}`,
    `Labeled ${labeled.length}: right pick <span class="ok">${pct(V.filter((L) => L.V.v === "agree").length, labeled.length)}</span> · right card listed, no pick ${pct(V.filter((L) => L.V.v === "listed").length, labeled.length)} · wrong or not listed <span class="bad">${pct(V.filter((L) => L.V.v === "miss").length, labeled.length)}</span>`,
    `Printing read (right card, you picked a printing): <span class="ok">${V.filter((L) => pv(L) === "right").length}</span> right of ${V.filter((L) => pv(L)).length}`,
    `Outcomes: ${Object.entries(kinds).map(([k, n]) => esc(k) + " " + n).join(" · ")}`,
    `Read before the timer: ${lots.filter((L) => (L.frames || []).some((f) => f.trigger === "pre")).length} lots (${lots.filter((L) => L.adopted).length} reused at start, no second call)`,
    `Time to reading (1st frame): median ${(q(first.map((r) => r.ms), 0.5) / 1000).toFixed(1)} s · slow (p90) ${(q(first.map((r) => r.ms), 0.9) / 1000).toFixed(1)} s · errors ${reads.filter((r) => r.error).length}`,
    `Spent ${money(cost)} · ${money(lots.length ? cost / lots.length : 0)} per lot`
  ].join("<br>") : "No lots yet. Turn auto on in the CardComp panel and watch a stream.";
  const order = { todo: 0, miss: 1, listed: 2, agree: 3, none: 4 };   // a backlog: lots still to review first
  V.sort((a, b) => (order[a.V.v] - order[b.V.v]) || (b.at - a.at));
  document.getElementById("list").innerHTML = V.map((L) => {
    const f = (L.frames || [])[0], m = L.V.m, o = L.outcome;
    const rd = (L.reads || []).map((r) => r.error ? `<div class="bad">frame ${r.n}: ${esc(r.error)}</div>` :
      `<div>${(() => { const f = (L.frames || []).find((x) => x.n === r.n && x.img) || {}; return f.trigger === "pre" ? "before start" + (L.adopted ? ", " + (L.adopted.earlyMs / 1000).toFixed(1) + " s early" : "") + (f.diff != null ? ", change " + f.diff : "") : "frame " + r.n + (f.sinceStart != null ? " (" + (f.sinceStart / 1000).toFixed(1) + " s in)" : ""); })()}: <b>${esc(r.read && r.read.card_visible === false ? "no card" : [r.read && r.read.name, r.read && r.read.number ? r.read.number + (r.read.total ? "/" + r.read.total : "") : ""].join(" "))}</b> <span class="k">${esc(r.read && r.read.rarity)}${r.read && r.read.finish && r.read.finish !== "unknown" ? " · " + esc(r.read.finish) : ""} · conf ${r.read ? r.read.confidence : "-"} · ${esc((r.model || "").replace("claude-", ""))} ${((r.ms || 0) / 1000).toFixed(1)} s ${money(r.cost)}</span></div>`).join("");
    const sug = m && m.suggestion && (m.cards || []).find((c) => c.id === m.suggestion);
    const mt = m ? `<div class="k">match: ${esc(m.kind)}${m.strength ? " · " + m.strength : ""}${sug ? " · <span class=gold>" + esc(sug.n) + " " + esc(sug.s) + " #" + esc(sug.num) + (m.printing ? " · " + esc(m.printing) : "") + "</span>" : ""}${pv(L) ? " · printing <span class=" + (pv(L) === "right" ? "ok" : "bad") + ">" + pv(L) + "</span>" : ""}${m.note ? " · " + esc(m.note) : ""}${m.filled === false ? " · not shown (you were typing)" : ""}</div>
      <div class="k">listed: ${(m.cards || []).slice(0, 4).map((c) => esc(c.n) + " #" + esc(c.num) + " $" + (c.m || 0).toFixed(2)).join(", ")}</div>` : "";
    const oc = o ? `<div class="k">lot: ${o.card ? "you " + (o.card.label === "tap" ? "bid on" : "opened") + " <b>" + esc(o.card.n) + " " + esc(o.card.s || "") + " #" + esc(o.card.num || "") + "</b>" + (o.card.printing ? " · " + esc(o.card.printing) : "") + (o.card.cond ? " " + esc(o.card.cond) : "") : "you did not tap or open a card"}${o.placedMax ? " · your max $" + esc(o.placedMax) : o.card && o.card.myMax ? " · your max $" + esc(o.card.myMax) : ""} · sold $${esc(o.final)}${o.me ? " to you" : ""}</div>` : `<div class="k">lot: no end recorded</div>`;
    const rv = L.V.truth ? "" : `<div><button class="sm" data-k="${L.key}" data-r="right">right</button><button class="sm" data-k="${L.key}" data-r="listed">listed, not picked</button><button class="sm" data-k="${L.key}" data-r="wrong">wrong</button><button class="sm" data-k="${L.key}" data-r="nocard">no card</button></div>`;
    return `<div class="row">${f ? `<img src="${f.img}" title="${f.w}x${f.h}, ${f.kb} KB">` : `<div style="width:150px" class="bad">no frame</div>`}<div>
      <div><span class="tag t-${L.V.v}">${esc(L.V.label)}</span>${[new Date(L.at).toLocaleString(), L.seller, L.title].filter(Boolean).map(esc).join(" · ")}</div>${rd}${mt}${oc}${rv}</div></div>`;
  }).join("");
  document.querySelectorAll("#list img").forEach((im) => im.onclick = () => im.classList.toggle("big"));
  document.querySelectorAll("button[data-k]").forEach((b) => b.onclick = async () => {
    const L = lots.find((x) => String(x.key) === b.dataset.k); if (!L) return;
    L.review = b.dataset.r; delete L.V; await put("lots", L); paint();
  });

  const rows = (await all("frames")).sort((a, b) => b.at - a.at);
  const by = (m) => rows.filter((r) => r.method === m).length;
  document.getElementById("fsum").textContent = rows.length ? `${rows.length} grabs · ${rows.filter((r) => r.ok).length} worked (video copy ${by("video")}, screenshot ${by("screenshot")}) · automatic 5 s later worked ${rows.filter((r) => /^ok/.test(r.later || "")).length} of ${rows.length}` : "No capture checks.";
  document.getElementById("flist").innerHTML = rows.slice(0, 20).map((r) => `<div class="row">${r.img ? `<img src="${r.img}">` : `<div style="width:150px" class="bad">no frame</div>`}<div>
    <div><b class="${r.ok ? "ok" : "bad"}">${r.ok ? "grabbed by " + (r.method === "video" ? "video copy" : "screenshot") : "failed"}</b> · ${new Date(r.at).toLocaleString()}</div>
    <div class="k">${r.w}x${r.h} · ${r.kb} KB · ${r.ms} ms · brightness ${r.luma == null ? "-" : r.luma} · 5 s later: ${esc(r.later)}</div>
    ${r.tries && r.tries.length ? `<div class="k">${r.tries.map(esc).join("<br>")}</div>` : ""}<div><code>${esc(JSON.stringify(r.video))}</code></div></div></div>`).join("");
}
document.getElementById("exp").onclick = async () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ lots: await all("lots"), frames: await all("frames") })], { type: "application/json" }));
  a.download = "cardcomp-recog-" + new Date().toISOString().slice(0, 10) + ".json"; a.click();
};
document.getElementById("wipe").onclick = () => {
  if (!confirm("Delete every recognition lot and frame?")) return;
  const r = indexedDB.deleteDatabase("cardcomp-recog"); r.onsuccess = r.onerror = r.onblocked = () => setTimeout(paint, 300);
};
paint(); setInterval(() => { if (!document.querySelector("img.big")) paint(); }, 8000);
