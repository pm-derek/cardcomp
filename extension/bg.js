// Relay: CardComp (tab or side panel) -> the Whatnot tab you are watching.
// Toolbar button opens CardComp in the side panel next to the Whatnot stream.
importScripts("store.js");
try { importScripts("recog/recog-bg.js"); } catch (_) {}   // RECOG auto-recognition experiment, removed by scripts/strip-recog.js
const TO_APP = new Set(["cardcomp-tcg-price", "cardcomp-lot", "cardcomp-lot-end"]);
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

// Windows (Derek, 2026-10-20: two Chrome windows, each with a stream and CardComp in the side panel; a scan in one
// filled the other, and a bid could go to the other window's stream). Each CardComp copy pairs with the Whatnot tab in
// its own window; a CardComp in a window with no Whatnot tab follows the main stream (the Whatnot tab used last).
// Messages from a tab carry win (its window) and primary (it is the main stream); side panels filter on them (panel.js),
// CardComp tabs are filtered here. One window: nothing changes.
const WN_URL = "https://*.whatnot.com/*", CC_URL = "https://pm-derek.github.io/cardcomp/*";
const byRecent = (tabs) => tabs.slice().sort((a, b) => ((b.lastAccessed || 0) - (a.lastAccessed || 0)) || (b.active - a.active));
async function toApps(msg, srcTab) {   // srcTab: the tab the message came from ({windowId} is enough); none = every copy
  if (!srcTab || srcTab.windowId == null) {
    chrome.runtime.sendMessage(msg).catch(() => {});
    chrome.tabs.query({ url: CC_URL }, (tabs) => tabs.forEach((t) => chrome.tabs.sendMessage(t.id, msg).catch(() => {})));
    return;
  }
  const wn = await chrome.tabs.query({ url: WN_URL }), wins = new Set(wn.map((t) => t.windowId));
  const main = byRecent(wn)[0], primary = !main || main.windowId === srcTab.windowId;
  const m = Object.assign({}, msg, { win: srcTab.windowId, primary });
  chrome.runtime.sendMessage(m).catch(() => {});   // side panels keep it only for their own window (panel.js)
  const cc = await chrome.tabs.query({ url: CC_URL });
  cc.filter((t) => t.windowId === srcTab.windowId || (primary && !wins.has(t.windowId))).forEach((t) => chrome.tabs.sendMessage(t.id, m).catch(() => {}));
}
// The Whatnot tab a CardComp copy talks to: the active one in its window, else the main stream.
async function wnFor(win) {
  const wn = await chrome.tabs.query({ url: WN_URL });
  const here = win != null ? wn.filter((t) => t.windowId === win) : [];
  if (here.length) return here.sort((a, b) => (b.active - a.active) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)))[0];
  return byRecent(wn)[0] || null;
}
const winOf = (msg, sender) => (sender && sender.tab ? sender.tab.windowId : msg && msg.win != null ? msg.win : null);

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg) return;
  if (TO_APP.has(msg.type)) {   // TCGplayer / Whatnot tab -> the CardComp copies paired with that tab's window
    toApps(msg, sender.tab);
    // No tab switching here. Click-outs open in a background tab, and an auto-return fired whenever Derek tabbed
    // over to TCGplayer himself (the page often first renders, and reads, when it becomes visible).
    reply({ ok: true });
    return;
  }
  if (msg.type === "cardcomp-status") {   // app footer: is a Whatnot tab open, is the store token saved
    chrome.tabs.query({ url: "https://*.whatnot.com/*" }, (tabs) => {
      chrome.storage.local.get("ghToken", (r) => reply({ whatnot: tabs.length > 0, store: !!r.ghToken }));
    });
    return true;
  }
  if (msg.type === "cardcomp-open-bg") {   // LP ↗ / market link: open behind the stream, reuse one CardComp-owned TCGplayer tab
    if (!/^https:\/\/www\.tcgplayer\.com\/product\//.test(msg.url || "")) { reply({ ok: false }); return; }
    const win = winOf(msg, sender), k = "tcgTab" + (win != null ? ":" + win : "");   // one reused TCGplayer tab per window, so its read comes back to that window
    const create = () => chrome.tabs.create(Object.assign({ url: msg.url, active: false }, win != null ? { windowId: win } : {})).then((t) => chrome.storage.session.set({ [k]: t.id }));
    chrome.storage.session.get(k, (r) => {
      if (r && r[k] != null) chrome.tabs.update(r[k], { url: msg.url, active: false }).catch(create);
      else create();
    });
    reply({ ok: true });
    return;
  }
  if (msg.type === "cardcomp-live-save") { queue(msg.key, msg.rec); reply({ ok: true }); return; }   // app -> GitHub live.json
  if (msg.type === "cardcomp-log-save") { queueLog(msg.rec); reply({ ok: true }); return; }
  if (msg.type === "cardcomp-snapshot") {   // "copy debug": ask this window's Whatnot tab for its lot row
    wnFor(winOf(msg, sender)).then((t) => {
      if (!t) { reply({ ok: false, why: "no Whatnot tab" }); return; }
      chrome.tabs.sendMessage(t.id, msg).then((r) => reply(r || { ok: false, why: "no reply" })).catch(() => reply({ ok: false, why: "reload the Whatnot tab" }));
    });
    return true;
  }
  if (msg.type === "cardcomp-log-prune") { pruneLog(msg.since, msg.before).then(reply, (e) => reply({ ok: false, why: e.message })); return true; }   // stats panel "clear logged data"
  if (msg.type === "cardcomp-log-edit") { editLog(msg.key, msg.card, !!msg.clear).then(reply, (e) => reply({ ok: false, why: e.message })); return true; }   // card added to a past lot
  if (msg.type === "cardcomp-log-read") { readLog(msg.since).then(reply, (e) => reply({ ok: false, why: e.message })); return true; }   // app load: log -> browser stats
  if (msg.type === "cardcomp-live-test") { test().then(reply); return true; }
  if (msg.type !== "cardcomp-bid") return;
  wnFor(winOf(msg, sender)).then((t) => {   // the stream in this CardComp's window (never another window's)
    if (!t) { reply({ ok: false, why: "no Whatnot tab" }); return; }
    chrome.tabs.sendMessage(t.id, msg)
      .then((r) => reply(r || { ok: true }))
      .catch(() => reply({ ok: false, why: "Whatnot tab not ready, reload it" }));
  });
  return true; // async reply
});
