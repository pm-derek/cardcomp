// CardComp auto-recognition, step 3: the "auto" line under the lot strip (switch, model, what was read),
// filling the search with the candidates, and reporting what Derek did at lot end.
// EXPERIMENT (docs/auto-recognition-handoff.md). Shows only when the extension says hello, so the phone and a
// plain browser tab never see it. Removed by scripts/strip-recog.js.
// Rules (Derek, 2026-10-16): pull up a normal-looking result list with the best guess marked (gold when the
// name and number match exactly), alternatives still listed; never overwrite a search Derek started this lot;
// never open a card, never bid.
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const post = (m) => { try { if (window.parent !== window) window.parent.postMessage(m, "*"); else window.postMessage(m, location.origin); } catch (_) {} };
  const fromExt = (e) => (e.source === window && e.origin === location.origin) || (window.parent !== window && e.source === window.parent);
  const MODELS = { haiku: "Haiku", sonnet: "Sonnet", opus: "Opus" };
  const RANK = { exact: 5, near: 4, unique: 3, foreign: 2, ambiguous: 2, "number-miss": 1, none: 0 };
  let EXT = false, STATE = { on: false, mode: "off", model: "sonnet", hasKey: false }, TOUCH = 0, LATEST = 0, MSG = "", SHOW = null, WATCH = null, HOVER = 0;
  // Engaged with this lot: typed, tapped or opened a result, or asked for "read now". Until the lot ends (not a
  // new title: it often appears with the timer, when the start read lands), automatic readings never replace the results, they only offer "show" (Derek: an auto read
  // after his read now collapsed the card he had open). 90 s cap in case no lot end ever arrives.
  let ENGAGED = 0, LOT_RESET = 0;
  const engaged = () => ENGAGED > LOT_RESET && Date.now() - ENGAGED < 90000;
  const AUTO = {};   // lot key (whatnot startedAt) -> { best: {m, r, d} }
  const ADOPT = {};  // pre-start reading key -> the lot that reused it (either message can arrive first)

  const css = document.createElement("style");
  css.textContent = "#autoline{display:none;font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.4;color:var(--dim);padding:4px 9px;margin-top:4px}" +
    "#autoline .modes{display:inline-flex;margin-right:6px;border:1px solid var(--line);border-radius:6px;overflow:hidden;vertical-align:middle}" +
    "#autoline .modes span{cursor:pointer;padding:3px 8px;color:var(--faint)}#autoline .modes span+span{border-left:1px solid var(--line)}" +
    "#autoline .modes span.on{color:#000;background:var(--green)}#autoline .modes span.on[data-m=off]{background:var(--line);color:var(--ink)}#autoline .modes span.on[data-m=manual]{background:var(--gold)}" +
    "#autoline select{background:var(--panel2);color:var(--dim);border:1px solid var(--line);border-radius:5px;font:inherit;margin-right:6px}" +
    "#autoline .rn{cursor:pointer;border:1px solid var(--gold);color:var(--gold);border-radius:5px;padding:0 6px;margin-right:6px}#autoline .wt{color:var(--faint)}" +
    "#autoline a{color:var(--blue);cursor:pointer}#autoline .bad{color:var(--red)}#autoline .gold{color:var(--gold)}" +
    ".autobadge{display:inline-block;margin-left:6px;padding:0 5px;border-radius:4px;font-size:11px;font-weight:700;vertical-align:middle}" +
    ".autobadge.strong{background:var(--gold);color:#000}.autobadge.weak{border:1px solid var(--gold);color:var(--gold)}.card.autosug{border-color:var(--gold)}" +
    ".autobadge.pic{background:rgba(245,179,1,.18);border:1px solid var(--gold);color:var(--gold)}";
  document.head.appendChild(css);

  function lineEl() {
    let el = $("#autoline");
    if (!el) { const ls = $("#lotstrip"); if (!ls) return null; el = document.createElement("div"); el.id = "autoline"; ls.insertAdjacentElement("afterend", el); }
    return el;
  }
  function paint() {
    const el = lineEl(); if (!el || !EXT) return;
    el.style.display = "block";
    const sel = `<select id="automodel" title="model that reads the card">${Object.keys(MODELS).map((k) => `<option value="${k}"${k === STATE.model ? " selected" : ""}>${MODELS[k]}</option>`).join("")}</select>`;
    let msg = MSG;
    if (!STATE.on) msg = "reads the card on stream (experiment): manual = only when you press read, auto = every lot";
    else if (STATE.mode === "manual" && !msg) msg = "press read (or right-click) for each card";
    else if (!STATE.hasKey) msg = '<span class="bad">add your API key on the extension\'s Options page</span>';
    else if (!msg) msg = "waiting for the next lot";
    const w = STATE.mode === "auto" && WATCH && Date.now() - WATCH.at < 30000 ? ` <span class="wt" title="what auto is doing between lots (picture change ${WATCH.mean} / ${WATCH.peak})">&middot; ${esc(WATCH.why)}</span>` : "";
    const modes = [["off", "off", "no reading"], ["manual", "manual", "reads only when you press read / right-click"], ["auto", "auto", "reads every lot by itself, plus read now"]];
    el.innerHTML = `<span class="modes" id="automodes">${modes.map(([m, l, t]) => `<span data-m="${m}" class="${STATE.mode === m ? "on" : ""}" title="${t}">${l}</span>`).join("")}</span>${STATE.on ? sel : ""}<span id="automsg">${msg}</span>${w}`;
    el.querySelectorAll("#automodes span").forEach((b) => b.onclick = () => { if (b.dataset.m !== STATE.mode) post({ type: "cardcomp-auto-config", mode: b.dataset.m }); });
    paintRead();
    const ms = $("#automodel"); if (ms) ms.onchange = () => post({ type: "cardcomp-auto-config", model: ms.value });
    const sh = $("#autoshow"); if (sh && SHOW) sh.onclick = () => { fill(SHOW.m, SHOW.r); };
  }

  const queryText = (r) => [r.name, r.number ? r.number + (r.total ? "/" + r.total : "") : ""].filter(Boolean).join(" ");
  function describe(m, r, d) {
    const read = esc(queryText(r)) + (r.rarity ? ` <span style="color:var(--faint)">${esc(r.rarity)}${r.stamp ? " · " + esc(r.stamp) : ""}</span>` : "");
    const sug = m.suggestion && m.cards.find((c) => c.id === m.suggestion);
    let what;
    if (m.kind === "exact" && m.strength === "strong") what = `<span class="gold">&#10003; ${esc(sug.n)} &middot; ${esc(sug.s)} #${esc(sug.num)}</span>`;
    else if (sug) what = `best guess ${esc(sug.n)} &middot; ${esc(sug.s)} #${esc(sug.num)}` + (m.kind === "near" ? " (number read one off)" : m.kind === "unique" ? " (no number read)" : "");
    if (sug && m.printing) {   // the finish read names a printing; warn when the collapsed bid is priced from another one
      const c = typeof CARDS !== "undefined" && CARDS.find((x) => x.id === sug.id), top = c && typeof topPrint === "function" ? topPrint(c) : "";
      const pm = (k) => { const v = c && c.px && c.px[k]; return v ? (v.m != null ? v.m : v.l) || 0 : 0; };
      what += ` &middot; <b>${esc(m.printing)}</b>`;
      if (top && top !== m.printing) what += ` <span class="bad">&middot; tile bid is ${esc(top)} $${pm(top).toFixed(2)}, read ${esc(m.printing)} $${pm(m.printing).toFixed(2)}: open the card</span>`;
    }
    else if (m.kind === "foreign") what = `<span class="bad">&#9888; ${esc(m.note)}</span>`;
    else what = esc(m.note || "no match");
    const t = `${MODELS[Object.keys(MODELS).find((k) => (d.model || "").includes(k))] || d.model || ""} ${((d.ms || 0) / 1000).toFixed(1)}s`;
    return `${d.pre ? "before start: " : d.manual ? "read now: " : ""}${d.zoom ? "zoomed " + d.zoom + "x: " : ""}read <span title="${esc(JSON.stringify(Object.assign({}, r, { why: m.why })))}">${read}</span> &rarr; ${what} <span style="color:var(--faint)">&middot; ${esc(t)}</span>`;
  }
  // The read button (Derek, 2026-10: "read now" was too small a target, and he presses it every lot because he is
  // faster than the automatic trigger). A tall button left of the search box, in the sticky row, so it never moves.
  // Backtick (the key under Esc) does the same from anywhere in CardComp, even while typing in the search box: no card
  // name has a backtick. Ctrl+Shift+Y does it from anywhere in Chrome (extension shortcut).
  let READING = 0;
  css.textContent += "#readbig{flex:none;align-self:stretch;width:66px;max-height:56px;overflow:hidden;border-radius:9px;border:2px solid var(--gold);background:rgba(245,179,1,.12);" +
    "color:var(--gold);font:700 12px/1 'JetBrains Mono',monospace;cursor:pointer;display:none;flex-direction:column;align-items:center;justify-content:center;gap:1px;padding:2px}" +
    "#readbig .ico{font-size:15px;line-height:1}#readbig .k{font-size:8px;font-weight:400;color:var(--dim)}#readbig:active{transform:scale(.96)}" +
    "#readbig.busy{background:var(--gold);color:#000;animation:rbpulse .8s ease-in-out infinite alternate}#readbig.busy .k{color:#000}" +
    "#readbig.bad{border-color:var(--red);color:var(--red)}@keyframes rbpulse{from{opacity:1}to{opacity:.55}}";
  function readBtn() {
    let b = $("#readbig");
    if (!b) {
      const q = $("#q"), box = q && q.parentElement, row = box && box.parentElement; if (!row) return null;
      b = document.createElement("button"); b.id = "readbig"; b.type = "button";
      b.title = "read the card on stream now. Also: right-click anywhere in CardComp, the mouse's thumb back button, or the ` key";
      b.addEventListener("click", (e) => { e.preventDefault(); readNow(); });
      row.insertBefore(b, box);
    }
    return b;
  }
  function paintRead(state) {
    const b = readBtn(); if (!b) return;
    const show = EXT && STATE.on && STATE.hasKey;
    b.style.display = show ? "flex" : "none";
    const busy = READING && Date.now() - READING < 12000;
    b.classList.toggle("busy", !!busy); b.classList.toggle("bad", state === "bad");
    b.innerHTML = busy ? '<span class="ico">&#9673;</span>reading' : state === "bad" ? '<span class="ico">!</span>retry<span class="k">right-click</span>' : '<span class="ico">&#9673;</span>read<span class="k">right-click</span>';
  }
  function readNow() {
    if (!(EXT && STATE.on && STATE.hasKey)) return;
    if (READING && Date.now() - READING < 1500) return;   // a double tap is one read
    READING = Date.now(); MSG = "reading the card on stream..."; paint();
    post({ type: "cardcomp-auto-read" });
    setTimeout(() => { if (READING && Date.now() - READING >= 12000) { READING = 0; paintRead(); } }, 12100);
  }
  // Zero-travel triggers (Derek: the mouse lives mid-screen on cards and prices; going to the top is slow, Ctrl+Shift+Y
  // is awkward): right-click anywhere in CardComp (not in a text field, which keeps its paste menu), or the mouse's
  // thumb "back" button. A ring under the pointer confirms the read without looking up.
  css.textContent += ".readring{position:fixed;z-index:2147483646;width:34px;height:34px;margin:-17px 0 0 -17px;border:3px solid var(--gold);border-radius:50%;" +
    "pointer-events:none;animation:readring .7s ease-out forwards}@keyframes readring{from{transform:scale(.4);opacity:1}to{transform:scale(1.6);opacity:0}}";
  function ring(x, y) { const r = document.createElement("div"); r.className = "readring"; r.style.left = x + "px"; r.style.top = y + "px"; document.body.appendChild(r); setTimeout(() => r.remove(), 750); }
  const armed = () => EXT && STATE.on && STATE.hasKey;
  const typingField = (t) => t && t.closest && t.closest("input,textarea,select,[contenteditable]");
  document.addEventListener("contextmenu", (e) => {
    if (!armed() || typingField(e.target) || e.shiftKey) return;   // Shift+right-click still opens the browser menu
    e.preventDefault(); ring(e.clientX, e.clientY); readNow();
  }, true);
  const thumb = (e) => e.button === 3 || e.button === 4;
  for (const ev of ["mousedown", "mouseup", "auxclick"]) document.addEventListener(ev, (e) => {
    if (!armed() || !thumb(e)) return;
    e.preventDefault(); e.stopPropagation();   // no back / forward navigation inside CardComp
    if (ev === "mouseup") { ring(e.clientX, e.clientY); readNow(); }
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "`" || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!(EXT && STATE.on && STATE.hasKey)) return;
    e.preventDefault(); readNow();
  }, true);

  function fill(m, r) {
    const q = $("#q"); if (!q || typeof render !== "function") return;
    q.value = queryText(r);
    const qc = $("#qclear"); if (qc) qc.style.display = "block";
    try { if (typeof LANG !== "undefined" && m.lang && m.lang !== LANG && typeof setLang === "function") setLang(m.lang, true); } catch (_) {}
    try { if (typeof PRINT_HINT !== "undefined") PRINT_HINT = (m.printing || "").toLowerCase(); } catch (_) {}   // opening the card selects the printing read
    render(m.cards.map((c, i) => Object.assign({}, c, { score: 1000 - i })), false, false);
    const rd = $("#read"); if (rd) rd.textContent = "";
    const st = $("#status");
    if (st) {
      st.textContent = (m.kind === "foreign" ? "⚠ " : "") + (m.cards.length ? (m.note || (m.cards.length + " match" + (m.cards.length > 1 ? "es" : ""))) : (m.note || "no match")) + " · auto";
      st.style.color = m.kind === "foreign" ? "var(--red)" : "";   // run() rewrites the text on the next manual search; the color is reset here and there
      if (m.kind === "foreign") { const q = $("#q"); if (q) q.addEventListener("input", () => { st.style.color = ""; }, { once: true }); }
    }
    if (m.suggestion) {
      const el = document.querySelector(`#results .card[data-id="${CSS.escape(m.suggestion)}"]`);
      if (el) {
        el.classList.add("autosug");
        const nm = el.querySelector(".nm");
        if (nm) nm.insertAdjacentHTML("beforeend", m.strength === "strong" ? '<span class="autobadge strong">&#10003; auto</span>' :
          m.pic === "agree" ? '<span class="autobadge pic">auto + picture</span>' : m.pic === "pick" ? '<span class="autobadge pic">picture</span>' : '<span class="autobadge weak">auto?</span>');
      }
    }
    if (document.activeElement === q) q.select();
  }

  // Early reading (streamed: name, language, number, total; rarity / stamp / set / finish still being written): fill
  // the search now, mark the best guess when the full reply lands. Never over a lot Derek is working, never logged.
  function onPartial(d) {
    const at = d.capAt || d.key || 0; if (at < LATEST) return;
    const ak = ADOPT[d.key] || d.key, a = AUTO[ak];
    if (!d.manual && a && a.best) return;   // this lot already shows a full reading
    const r = d.read; if (!r || !r.name || typeof window.autoMatch !== "function") return;
    if (/^(zh|ko|other)/.test(String(r.language || ""))) return;   // the foreign warning waits for the full reply
    if (!d.manual && (engaged() || TOUCH > at - 1500)) return;
    const m = window.autoMatch(r, { short: d.short || 0, model: d.model || "" });
    if (!m.cards.length) return;
    LATEST = Math.max(LATEST, at);
    fill(m, r);
    MSG = `${d.pre ? "before start: " : d.manual ? "read now: " : ""}reading <b>${esc(queryText(r))}</b> <span style="color:var(--faint)">&middot; ${((d.ms || 0) / 1000).toFixed(1)}s, rest coming</span>`;
    paint();
  }

  function onAuto(d) {
    if (d.partial) { onPartial(d); return; }
    if (d.manual) { READING = 0; paintRead(d.error ? "bad" : ""); }   // a read you asked for came back (any outcome)
    const at = d.capAt || d.key || 0;   // capture time: a lot's key can be older than a pre-start reading
    LATEST = Math.max(LATEST, at);
    if (at < LATEST) return;   // a late reply for an older frame
    const ak = ADOPT[d.key] || d.key, a = AUTO[ak] = AUTO[ak] || {};
    if (d.error) { if (!a.best) { MSG = `<span class="bad">${esc(d.error)}</span>`; paint(); } return; }
    const r = d.read;
    if (!r || r.card_visible === false || !r.name) {
      if (!a.best) { MSG = d.n === 1 ? "no card in view, looking again" : "no card in view"; paint(); }
      post({ type: "cardcomp-auto-match", key: d.key, n: d.n, kind: "no-card", filled: false });
      return;
    }
    if (typeof window.autoMatch !== "function") return;
    const m = window.autoMatch(r, { short: d.short || 0, model: d.model || "" });
    const cards = m.cards.slice(0, 8).map((c) => ({ id: c.id, n: c.n, s: c.s, num: c.num, r: c.r, m: typeof bestMarket === "function" ? bestMarket(c) : 0 }));
    // keep the better of a lot's readings (a read you asked for always shows; its zoomed re-read only when it ranks higher
    // or picks where the first could not)
    const zoomWorse = d.zoom && a.best && !((RANK[m.kind] || 0) > (RANK[a.best.m.kind] || 0) || (m.suggestion && !a.best.m.suggestion));
    if (zoomWorse || (!d.manual && a.best && (RANK[m.kind] || 0) < (RANK[a.best.m.kind] || 0))) {
      post({ type: "cardcomp-auto-match", key: d.key, n: d.n, kind: m.kind, strength: m.strength, suggestion: m.suggestion, printing: m.printing || "", note: m.note, why: m.why, cards, filled: false });
      return;
    }
    a.best = { m, r, d };
    // Derek typed or tapped a result for THIS card (within 1.5 s before the frame, or while it was being read):
    // leave his search alone. Measured from the frame, not the lot: the lot can exist well before its card is shown,
    // and a tap on the previous card then blocked the new one (live test).
    // a zoomed re-read fills unless Derek touched the results since the frame (the read-now that started it does not count)
    const touched = d.zoom ? TOUCH > (d.capAt || d.key) - 1500 : !d.manual && (engaged() || TOUCH > (d.capAt || d.key) - 1500);
    if (!touched) fill(m, r);
    a.filledAt = touched ? 0 : Date.now(); a.pic = null;
    askPic(d, m, a);
    if (d.manual) ENGAGED = Date.now();
    SHOW = touched ? { m, r } : null;
    MSG = describe(m, r, d) + (touched ? ' &middot; <a id="autoshow">show</a>' : "") + (a.picAsk && a.picAsk.key === d.key && !a.pic ? ' &middot; <span class="wt" id="picwait">' + picWaitTxt() + '</span>' : "");
    paint();
    post({ type: "cardcomp-auto-match", key: d.key, n: d.n, kind: m.kind, strength: m.strength, suggestion: m.suggestion, printing: m.printing || "", note: m.note, why: m.why, cards, filled: !touched });
  }

  // Picture match (Derek, 2026-10-20: too many results to scan by eye). The reading's candidates go to the extension,
  // which ranks the frame against each one's TCGplayer picture (extension/recog/imgmatch.js). The list is reordered by
  // picture (printings sharing the art stay together, the text clues order them), and a clear winner is marked
  // "picture". A number match stays the pick; a picture that disagrees with it is only named. Never reorders under
  // the pointer: once Derek touched or hovered the results since they were filled, it offers "show" instead.
  const picUrl = (c) => c.pid ? `https://tcgplayer-cdn.tcgplayer.com/product/${c.pid}_200w.jpg` : (typeof imgOf === "function" ? imgOf(c) : "");
  function askPic(d, m, a) {
    if (m.kind === "foreign" || m.kind === "none" || (m.kind === "exact" && m.strength === "strong")) return;
    const pool = (m.pool || m.cards).filter((c) => picUrl(c));
    if (pool.length < 2) return;
    a.picAsk = { key: d.key, n: d.n || 1 };
    if (!picExt()) return;   // the extension is older than the picture match: the line says to reload it
    post({ type: "cardcomp-auto-img", key: d.key, n: d.n || 1, cands: pool.map((c) => ({ id: c.id, u: picUrl(c) })) });
    // never silent (Derek, 2026-10-20: "where's the picture tag"): no answer in 12 s says so on the line
    const ask = a.picAsk;
    setTimeout(() => {
      if (a.picAsk !== ask || a.pic || !a.best || a.best.d.key !== ask.key) return;
      a.pic = { err: "no reply" };
      if ((a.best.d.capAt || a.best.d.key) >= LATEST) { MSG = describe(a.best.m, a.best.r, a.best.d) + ' &middot; <span class="bad">picture: no reply from the extension, reload it at chrome://extensions</span>'; paint(); }
    }, 12000);
  }
  // picture match needs extension 0.7+ (state carries the version from then on)
  const picExt = () => { const v = String(STATE.ver || "").split(".").map(Number); return v.length > 1 && (v[0] > 0 || v[1] >= 7); };
  const picWaitTxt = () => picExt() ? "picture: matching..." : '<span class="bad">picture match needs extension 0.7: reload it at chrome://extensions</span>';
  const cardTxt = (c) => c ? `${esc(c.n)} &middot; ${esc(c.s)} #${esc(c.num)}` : "";
  function onPic(d) {
    const ak = ADOPT[d.key] || d.key, a = AUTO[ak];
    // matched on the reading's key: extension 0.7.0-0.7.1 replied with n = the candidate count, which dropped every
    // ranking (Derek, live 2026-10-20: "no reply from the extension"); n is only checked on replies from 0.7.2+ (they carry cands)
    if (!a || !a.best || !a.picAsk || a.picAsk.key !== d.key || (d.cands != null && a.picAsk.n !== (d.n || 1))) return;
    const { m, r } = a.best, bd = a.best.d;
    if (!d.ok) { a.pic = { err: d.why || "failed" }; MSG = describe(m, r, bd) + ` <span style="color:var(--faint)">&middot; picture: ${esc(d.why || "failed")}</span>`; paint(); return; }
    const v = d.v, S = new Map(d.ranked.map((x) => [x.id, x.s])), grp = new Set(v.group), pool = m.pool || m.cards;
    const ti = new Map(pool.map((c, i) => [c.id, i])), sc = (c) => (S.has(c.id) ? S.get(c.id) : -9);
    const textSug = m.suggestion, numPick = !!(textSug && (m.kind === "exact" || m.kind === "near"));
    let ordered = pool.slice().sort((x, y) => (grp.has(y.id) - grp.has(x.id)) || (grp.has(x.id) ? ti.get(x.id) - ti.get(y.id) : sc(y) - sc(x)));
    let sug = textSug, pic = "unsure";
    if (v.sure) {
      const inGrp = !!(textSug && grp.has(textSug));
      if (numPick && !inGrp) pic = "disagree";
      else { sug = inGrp ? textSug : ordered[0].id; pic = inGrp ? "agree" : "pick"; }
    }
    if (sug && (numPick || !ordered.slice(0, 16).some((c) => c.id === sug))) ordered = [pool.find((c) => c.id === sug)].concat(ordered.filter((c) => c.id !== sug));
    const m2 = Object.assign({}, m, { cards: ordered.slice(0, 16), suggestion: sug, pic });
    const topC = pool.find((c) => c.id === v.top);
    a.pic = { top: v.top, s: v.s, sure: v.sure, next: v.next, ns: v.ns, group: v.group.slice(0, 4), sug, pic, pics: d.pics, box: d.box, ms: d.ms };
    const tip = esc(`picture ${v.s} vs next different ${v.ns == null ? "none" : v.ns} · ${d.pics} pictures · ${d.ms} ms${d.box ? "" : " · whole frame"}`);
    const note = pic === "pick" ? `picture: <b>${cardTxt(topC)}</b>` : pic === "agree" ? "picture agrees" :
      pic === "disagree" ? `<span class="bad">picture looks like ${cardTxt(topC)}</span>` : "picture unsure, sorted by likeness";
    const fresh = (bd.capAt || bd.key) >= LATEST, canFill = fresh && a.filledAt && TOUCH < a.filledAt && HOVER < a.filledAt;
    if (canFill) { fill(m2, r); a.filledAt = Date.now(); SHOW = null; }
    else if (fresh) SHOW = { m: m2, r };
    if (!fresh) return;
    MSG = describe(m2, r, bd) + ` &middot; <span title="${tip}">${note}</span>` + (!canFill ? ' &middot; <a id="autoshow">show</a>' : "");
    paint();
  }

  // Lot ended (called from finishLot): what Derek tapped or opened is the truth for the results page.
  window.recogLotDone = (rec) => {
    const key = rec && rec.startedAt; if (!key || !AUTO[key]) return;
    const c = rec.card || null, b = AUTO[key].best;
    // The auto reading rides on the auction log row (private log repo), so results are scored from the log: no
    // export to upload (it had reached 109 MB with frames) and no hand review for lots with a tapped / opened card.
    if (b) try {
      const sg = b.m.suggestion && b.m.cards.find((x) => x.id === b.m.suggestion), rd = b.r || {};
      rec.recog = { model: (b.d.model || "").replace("claude-", ""), ms: b.d.ms || 0, pre: !!b.d.pre, manual: !!b.d.manual, zoom: b.d.zoom || 0, short: b.d.short || 0,
        read: { name: rd.name || "", number: rd.number || "", total: rd.total || "", rarity: rd.rarity || "", finish: rd.finish || "", stamp: rd.stamp || "", set: rd.set || "", lang: rd.language || "", conf: rd.confidence },
        kind: b.m.kind, strength: b.m.strength || null, printing: b.m.printing || "",
        sug: sg ? { id: sg.id, n: sg.n, s: sg.s, num: sg.num, r: sg.r || "" } : null, ids: b.m.cards.slice(0, 8).map((x) => x.id),
        pic: AUTO[key].pic || null };
    } catch (_) {}
    post({ type: "cardcomp-auto-outcome", key, outcome: { card: c ? { id: c.id, n: c.n, s: c.s, num: c.num, r: c.r || "", label: c.label, cond: c.cond, printing: c.printing || "", multi: !!c.multi, myMax: c.myMax || null } : null, placedMax: rec.placedMax != null ? rec.placedMax : null,
      final: rec.final, winner: rec.winner || "", me: !!rec.me, bids: rec.bids, title: rec.title || "", at: rec.at || Date.now() } });
    delete AUTO[key];
  };

  document.addEventListener("input", (e) => { if (e.target && e.target.id === "q") TOUCH = ENGAGED = Date.now(); }, true);
  document.addEventListener("pointermove", (e) => { if (e.target && e.target.closest && e.target.closest("#results")) HOVER = Date.now(); }, true);
  document.addEventListener("pointerdown", (e) => { if (e.target && e.target.closest && e.target.closest("#results,#sug")) TOUCH = ENGAGED = Date.now(); }, true);
  window.addEventListener("message", (e) => {
    const d = e.data; if (!d || typeof d.type !== "string" || !fromExt(e)) return;
    if (d.type === "cardcomp-lot-end") { LOT_RESET = Date.now(); return; }
    if (d.type === "cardcomp-ext-ready") { EXT = true; post({ type: "cardcomp-auto-hello" }); paint(); }
    else if (d.type === "cardcomp-auto-state") { EXT = true; const m0 = STATE.mode; STATE = { on: !!d.on, mode: d.mode || (d.on ? "auto" : "off"), model: d.model || "sonnet", hasKey: !!d.hasKey, ver: d.ver || "" }; if (!STATE.on || STATE.mode !== m0) MSG = ""; paint(); }
    else if (d.type === "cardcomp-auto") { EXT = true; if (STATE.on) onAuto(d); }
    else if (d.type === "cardcomp-auto-watch") { WATCH = { why: d.phase === "watching" || d.phase === "live" || d.phase === "paused" || d.phase === "off" ? d.why : d.phase, mean: d.mean, peak: d.peak, at: Date.now() }; if (STATE.mode === "auto") { const m = $("#autoline .wt"); if (m) m.innerHTML = "&middot; " + esc(WATCH.why); else paint(); } }
    else if (d.type === "cardcomp-auto-img-ack") onPic(d);
    else if (d.type === "cardcomp-auto-readack" && !d.ok) { READING = 0; MSG = `<span class="bad">read now: ${esc(d.why || "failed")}</span>`; paint(); paintRead("bad"); }
    else if (d.type === "cardcomp-auto-adopt") {   // read before the timer: the same card is this lot's
      ADOPT[d.from] = d.to;
      if (AUTO[d.from]) { AUTO[d.to] = AUTO[d.from]; delete AUTO[d.from]; }
    }
  });
})();
