// Scan & Identify helper (Derek, 2026-11-10). Pain points: checking every scan against its catalog picture by eye, and
// re-matching five copies of one card one at a time. On sellerportal.tcgplayer.com/scan-identify (expanded view) each
// identified scan gets a likeness score (scan photo vs catalog photo, scan/scan-bg.js): green looks right, amber check,
// red likely wrong. A bar at the bottom counts them and steps through the flagged ones in a big side-by-side view
// (click a score, or "review"; arrows / j k move, Esc closes, F opens that scan's Find New Match). Scans that share one
// catalog match carry "xN same match"; when one of them is re-matched, the bar offers to open the next one's Find New
// Match with the new card's name already typed. The 1st Edition / Unlimited and cosmos-holo calls are not checked here:
// the photos needed to build that are not in hand yet.
(() => {
  if (!/^\/scan-identify/.test(location.pathname)) return;
  const OK = 0.70, CHK = 0.50;   // first guesses; tune from Derek's wrong-match scores
  const post = (m) => new Promise((res) => { try { chrome.runtime.sendMessage(m, (r) => { void chrome.runtime.lastError; res(r || null); }); } catch (_) { res(null); } });
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
  const SEL = ".manage-scans-identified-items-grid__expanded-container";
  const st = document.createElement("style");
  st.textContent = `.ccsc{display:inline-block;font:600 11px/1.6 -apple-system,"Segoe UI",Roboto,Inter,Arial,sans-serif;border-radius:999px;padding:0 8px;margin-left:8px;vertical-align:middle;cursor:pointer;white-space:nowrap}
.ccsc.ok{background:#dcfce7;color:#067647}.ccsc.chk{background:#fff1cc;color:#8a5a00}.ccsc.bad{background:#fee4e2;color:#b42318}.ccsc.wait,.ccsc.err{background:#eef2f6;color:#5f6b7a}
.ccgrp{display:inline-block;font:600 11px/1.6 -apple-system,"Segoe UI",Roboto,Inter,Arial,sans-serif;border-radius:999px;padding:0 8px;margin-left:6px;background:#e0ecff;color:#1849a9;cursor:pointer;vertical-align:middle}
${SEL}.ccbad{box-shadow:inset 4px 0 0 #e66767}${SEL}.ccchk{box-shadow:inset 4px 0 0 #d97706}${SEL}.cchl{outline:2px dashed #1849a9;outline-offset:2px}
#ccscanbar{position:fixed;left:16px;bottom:16px;z-index:2147483000;background:#14181d;color:#e6e9ee;border-radius:10px;padding:8px 12px;font:13px/1.5 -apple-system,"Segoe UI",Roboto,Inter,Arial,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.3);display:flex;gap:10px;align-items:center;flex-wrap:wrap;max-width:min(96vw,760px)}
#ccscanbar b{color:#fff}#ccscanbar .ok{color:#33a876}#ccscanbar .chk{color:#f0b429}#ccscanbar .bad{color:#ff7b7b}#ccscanbar button{font:inherit;background:#2a313a;color:#fff;border:0;border-radius:7px;padding:4px 10px;cursor:pointer}#ccscanbar button.pri{background:#3987e5}#ccscanbar .dim{color:#9aa5b5}
#ccscanview{position:fixed;inset:0;z-index:2147483100;background:rgba(10,12,16,.92);color:#e6e9ee;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;font:14px/1.5 -apple-system,"Segoe UI",Roboto,Inter,Arial,sans-serif}
#ccscanview .imgs{display:flex;gap:20px;align-items:flex-start}#ccscanview figure{margin:0;text-align:center}#ccscanview img{height:min(72vh,720px);width:auto;max-width:44vw;object-fit:contain;background:#222;border-radius:8px}#ccscanview figcaption{color:#9aa5b5;font-size:12px;margin-top:4px}
#ccscanview .meta{text-align:center}#ccscanview .meta b{font-size:16px}#ccscanview .act{display:flex;gap:8px}#ccscanview button{font:inherit;background:#2a313a;color:#fff;border:0;border-radius:7px;padding:6px 12px;cursor:pointer}#ccscanview button.pri{background:#3987e5}#ccscanview .x{position:absolute;top:14px;right:18px;font-size:22px;background:none}`;
  document.head.appendChild(st);

  const ROWS = new Map();   // container -> {scan, cat, name, num, set, variant, seq, s, cls, badge}
  const isReal = (img) => img && img.src && !/placeholder\.png|^data:image\/gif/.test(img.src) && !/^$/.test(img.src);
  function readRow(c) {
    const imgs = [...c.querySelectorAll("img.image-cell__image--expanded")];
    const byLabel = (lbl) => { const p = [...c.querySelectorAll("p.typography-detail")].find((x) => txt(x) === lbl); const box = p && p.parentElement; return box ? box.querySelector("img") : null; };
    const scan = byLabel("Scan Image") || imgs[0], cat = byLabel("Catalog Image") || imgs[1];
    const det = c.querySelector(".manage-scans-identified-items-grid__expanded-details-container") || c;
    const nameEl = det.querySelector("p.font-weight-700");
    const own = (el) => el ? [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ").replace(/\s+/g, " ").trim() : "";   // the page's text only, not our badges
    const name = own(nameEl) || txt(nameEl), lines = [...det.querySelectorAll("p.typography-detail")].map(txt);
    const pick = (re) => { const l = lines.find((x) => re.test(x)); return l ? l.replace(re, "").trim() : ""; };
    const seqEl = [...c.querySelectorAll("p")].find((p) => /Scan sequence #/.test(txt(p)));
    return { scan, cat, name, num: pick(/^Card #:\s*/), set: pick(/^Set:\s*/), variant: txt(c.querySelector(".manage-scans-identified-items-grid__variant-view-text")), seq: seqEl ? txt(seqEl).replace(/.*#:\s*/, "") : "", nameEl };
  }
  const groupKey = (r) => r.name && (r.name + "|" + r.variant);
  const cls = (s) => s >= OK ? "ok" : s >= CHK ? "chk" : "bad";

  let busy = false, pending = false;
  async function pass() {
    if (busy) { pending = true; return; } busy = true;
    try {
      const conts = [...document.querySelectorAll(SEL)];
      for (const c of conts) {
        const r = readRow(c), prev = ROWS.get(c);
        if (!r.name || !r.nameEl) continue;
        if (prev && prev.name !== r.name && prev.s != null) onRematch(prev, r, c);   // Derek picked a new match
        const rec = Object.assign(prev || {}, r); ROWS.set(c, rec);
        if (!rec.badge || !rec.badge.isConnected || prev && prev.name !== r.name) {
          if (rec.badge) rec.badge.remove();
          rec.badge = document.createElement("span"); rec.badge.className = "ccsc wait"; rec.badge.textContent = "…"; rec.badge.title = "comparing the scan with the catalog picture";
          rec.badge.onclick = (e) => { e.stopPropagation(); openView(c); };
          r.nameEl.appendChild(rec.badge); rec.s = undefined; rec.cls = ""; c.classList.remove("ccbad", "ccchk");
        }
        if (rec.s === undefined && isReal(rec.scan) && isReal(rec.cat) && !rec.inflight) {
          rec.inflight = true;
          post({ type: "cardcomp-scan-sim", scan: rec.scan.src, cat: rec.cat.src }).then((x) => {
            rec.inflight = false;
            if (!x) { rec.s = null; rec.badge.className = "ccsc err"; rec.badge.textContent = "no reply"; rec.badge.title = "CardComp extension not reachable: reload it"; }
            else if (!x.ok) { rec.s = null; rec.badge.className = "ccsc err"; rec.badge.textContent = "no score"; rec.badge.title = x.why || "failed"; }
            else { rec.s = x.s; rec.cls = cls(x.s); rec.badge.className = "ccsc " + rec.cls; rec.badge.textContent = (rec.cls === "ok" ? "match " : rec.cls === "chk" ? "check " : "⚠ ") + x.s.toFixed(2); rec.badge.title = (rec.cls === "ok" ? "scan and catalog picture look alike" : rec.cls === "chk" ? "some difference: look at both" : "the scan does not look like the catalog picture") + " (" + x.s.toFixed(3) + "); click for a big view"; c.classList.toggle("ccbad", rec.cls === "bad"); c.classList.toggle("ccchk", rec.cls === "chk"); }
            paintBar();
          });
        }
      }
      for (const c of [...ROWS.keys()]) if (!c.isConnected) ROWS.delete(c);
      groups(); paintBar();
    } finally { busy = false; if (pending) { pending = false; setTimeout(pass, 100); } }
  }
  // "xN same match": scans matched to the same card and variant.
  function groups() {
    const n = {}; for (const r of ROWS.values()) { const k = groupKey(r); if (k) n[k] = (n[k] || 0) + 1; }
    for (const [c, r] of ROWS) {
      const k = groupKey(r), old = r.nameEl.querySelector(".ccgrp");
      if (n[k] >= 2) { const g = old || document.createElement("span"); g.className = "ccgrp"; g.textContent = "×" + n[k] + " same match"; g.title = n[k] + " scans were matched to this card: fix one and the bar offers the rest"; g.onclick = (e) => { e.stopPropagation(); const on = !c.classList.contains("cchl"); for (const [c2, r2] of ROWS) c2.classList.toggle("cchl", on && groupKey(r2) === k); }; if (!old) r.nameEl.appendChild(g); }
      else if (old) old.remove();
    }
  }

  // Bar
  let bar = null, FIX = null;   // FIX: {oldKey, newName, newNum, left: [containers]}
  function paintBar() {
    if (!bar) { bar = document.createElement("div"); bar.id = "ccscanbar"; document.body.appendChild(bar); }
    const rs = [...ROWS.values()], scored = rs.filter((r) => r.s != null), ok = scored.filter((r) => r.cls === "ok").length, chk = scored.filter((r) => r.cls === "chk").length, bad = scored.filter((r) => r.cls === "bad").length, err = rs.filter((r) => r.s === null).length;
    if (!rs.length) { bar.innerHTML = '<b>CardComp</b> <span class="dim">no identified scans in view: this works in the expanded view (scan and catalog pictures side by side)</span>'; return; }
    bar.innerHTML = `<b>CardComp</b> <span>${rs.length} scans</span> <span class="ok">${ok} look right</span> <span class="chk">${chk} check</span> <span class="bad">${bad} likely wrong</span>${err ? ` <span class="dim">${err} no score</span>` : ""}${scored.length < rs.length - err ? ` <span class="dim">scoring…</span>` : ""} <button class="pri" data-review${chk + bad ? "" : " disabled"}>review ${chk + bad ? chk + bad : ""}</button> <span class="dim">scores are a first guess: tell me what wrong matches score</span>` +
      (FIX && FIX.left.length ? `<span style="flex-basis:100%"></span><span>${FIX.left.length} more scan${FIX.left.length === 1 ? "" : "s"} had <b>${esc(FIX.oldName)}</b></span> <button class="pri" data-fixnext>open the next one's Find New Match with “${esc(FIX.newName)}” typed</button> <button data-fixdrop>dismiss</button>` : "");
    const rv = bar.querySelector("[data-review]"); if (rv) rv.onclick = () => { const first = flagged()[0]; if (first) openView(first); };
    const fn = bar.querySelector("[data-fixnext]"); if (fn) fn.onclick = fixNext;
    const fd = bar.querySelector("[data-fixdrop]"); if (fd) fd.onclick = () => { FIX = null; paintBar(); };
  }
  const flagged = () => [...ROWS].filter(([, r]) => r.cls === "bad" || r.cls === "chk").sort((a, b) => (a[1].s || 0) - (b[1].s || 0)).map(([c]) => c);
  const ordered = () => { const f = flagged(); return f.length ? f : [...ROWS.keys()]; };

  // Derek re-matched a row: offer the same fix to the other scans that had the old match.
  function onRematch(prev, now, self) {
    const oldKey = groupKey(prev), left = [...ROWS].filter(([c, r]) => c !== self && groupKey(r) === oldKey && r.name === prev.name).map(([c]) => c);
    if (!left.length) { if (FIX && FIX.oldKey === oldKey) FIX = null; return; }
    FIX = { oldKey, oldName: prev.name, newName: now.name.replace(/\s*-\s*[\w/]+$/, ""), newNum: now.num, left };
  }
  async function fixNext() {
    if (!FIX) return;
    FIX.left = FIX.left.filter((c) => c.isConnected && ROWS.get(c) && groupKey(ROWS.get(c)) === FIX.oldKey);
    const c = FIX.left.shift(); paintBar(); if (!c) { FIX = null; paintBar(); return; }
    c.scrollIntoView({ block: "center" }); c.classList.add("cchl"); setTimeout(() => c.classList.remove("cchl"), 4000);
    const btn = c.querySelector('[data-testid="identified-item-find-new-match"]'); if (!btn) return;
    btn.click();
    const t0 = Date.now(); let inp = null;
    while (Date.now() - t0 < 5000 && !inp) { await new Promise((r) => setTimeout(r, 150)); const dr = document.querySelector(".find-catalog-match-drawer .tcg-drawer:not([style*='display: none'])") || document.querySelector(".find-catalog-match-drawer"); inp = dr && (dr.querySelector(".find-catalog-match-details__filter-search-bar input") || dr.querySelector("input[type=search], input[type=text]")); }
    if (!inp) return;
    const q = FIX.newName + (FIX.newNum ? " " + FIX.newNum.split("/")[0] : "");
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(inp, q); inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); inp.focus();
  }

  // Big side-by-side view
  let view = null, cur = null;
  function openView(c) {
    const r = ROWS.get(c); if (!r) return; cur = c;
    if (!view) { view = document.createElement("div"); view.id = "ccscanview"; document.body.appendChild(view); document.addEventListener("keydown", onKey, true); }
    const list = ordered(), i = list.indexOf(c);
    view.innerHTML = `<button class="x" data-close aria-label="close">✕</button><div class="imgs"><figure><img src="${esc(r.scan ? r.scan.src : "")}" alt="scan"><figcaption>scan #${esc(r.seq)}</figcaption></figure><figure><img src="${esc(r.cat ? r.cat.src : "")}" alt="catalog"><figcaption>catalog</figcaption></figure></div>` +
      `<div class="meta"><b>${esc(r.name)}</b> <span class="ccsc ${r.cls || "wait"}">${r.s != null ? r.s.toFixed(2) : "…"}</span><br><span class="dim">${esc(r.set)} · ${esc(r.variant)}</span></div>` +
      `<div class="act"><button data-prev>← prev</button><span class="dim" style="padding:6px 4px">${i + 1} of ${list.length}${flagged().length ? " flagged" : ""}</span><button data-next>next →</button><button class="pri" data-find>Find New Match (F)</button></div>`;
    view.querySelector("[data-close]").onclick = closeView;
    view.querySelector("[data-prev]").onclick = () => step(-1); view.querySelector("[data-next]").onclick = () => step(1);
    view.querySelector("[data-find]").onclick = findNew;
    view.onclick = (e) => { if (e.target === view) closeView(); };
  }
  function step(d) { const list = ordered(); if (!list.length) return; const i = list.indexOf(cur); openView(list[(i + d + list.length) % list.length]); }
  function findNew() { const b = cur && cur.querySelector('[data-testid="identified-item-find-new-match"]'); closeView(); if (b) { cur.scrollIntoView({ block: "center" }); b.click(); } }
  function closeView() { if (view) { view.remove(); view = null; document.removeEventListener("keydown", onKey, true); } }
  function onKey(e) { if (!view) return; if (e.key === "Escape") { closeView(); } else if (e.key === "ArrowRight" || e.key === "j") step(1); else if (e.key === "ArrowLeft" || e.key === "k") step(-1); else if (e.key === "f" || e.key === "F") findNew(); else return; e.preventDefault(); e.stopPropagation(); }

  let t = null;
  const kick = () => { clearTimeout(t); t = setTimeout(pass, 300); };
  new MutationObserver(kick).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["src", "lazy"] });
  kick(); setInterval(pass, 2000);
  window.__ccscan = { pass, rows: ROWS, OK, CHK };   // for the check script
})();
