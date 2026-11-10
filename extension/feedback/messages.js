// Feedback thank-yous: the Messages list (sellerportal.tcgplayer.com/messages, a Vue app). Each row carries the thread
// link (data-testid linkMessages_Home_Thread, /messages/<id>) and the order link; the list is read once it rendered and
// posted as cardcomp-fb-threads so the inbox can link "view message" to the thread itself (Derek, 2026-11-06: the
// order page was the wrong place). Read only; nothing here clicks or types.
(() => {
  if (!/^\/messages\/?$/.test(location.pathname)) return;
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function readRows() {
    const out = [];
    document.querySelectorAll('a[data-testid="linkMessages_Home_Thread"]').forEach((a) => {
      const tr = a.closest("tr"); if (!tr) return;
      const o = tr.querySelector('a[data-testid="linkMessages_Home_OrderDetailsSellerOrder"]');
      const url = a.href || "", id = (/\/messages\/(\d+)/.exec(url) || [])[1];
      if (!id) return;
      const cells = [...tr.querySelectorAll("td")].map(txt);
      out.push({ id, url, order: txt(o), subject: txt(a), members: cells[1] || "", created: cells[5] || "" });
    });
    return out;
  }
  (async () => {
    const t0 = Date.now(); let rows = [];
    while (Date.now() - t0 < 25000) { rows = readRows(); if (rows.length) break; await sleep(300); }
    if (!rows.length) return;
    await sleep(400); rows = readRows();   // let the first page finish rendering
    try { chrome.runtime.sendMessage({ type: "cardcomp-fb-threads", rows }, () => { void chrome.runtime.lastError; }); } catch (_) {}
    badges();
  })();
  // Repeat-buyer badge after the buyer's name in the Members cell ("Me, Andy Aguiar"); re-run when the list re-renders.
  async function badges() {
    if (!window.ccBuyer) return;
    for (const a of document.querySelectorAll('a[data-testid="linkMessages_Home_Thread"]')) {
      const tr = a.closest("tr"); if (!tr) continue;
      const cell = tr.querySelectorAll("td")[1]; if (!cell) continue;
      const have = cell.querySelector(".ccbuy"); if (have && have.__cchtml) continue; if (have) have.remove();   // markup-only copy after a re-render
      const names = txt(cell).split(",").map((s) => s.trim()).filter((s) => s && !/^me$/i.test(s) && !/tcgplayer/i.test(s));
      if (!names.length) continue;
      const s = await window.ccBuyer.stats(names[0], 0), chip = window.ccBuyer.chip(s, 0);
      if (chip && !cell.querySelector(".ccbuy")) cell.appendChild(chip);
    }
  }
  let bt = null; new MutationObserver(() => { clearTimeout(bt); bt = setTimeout(badges, 400); }).observe(document.body, { childList: true, subtree: true });
})();
