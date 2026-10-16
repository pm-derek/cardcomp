// Relay: CardComp (tab or side panel) -> the Whatnot tab you are watching.
// Toolbar button opens CardComp in the side panel next to the Whatnot stream.
importScripts("store.js");
const TO_APP = new Set(["cardcomp-tcg-price", "cardcomp-lot", "cardcomp-lot-end"]);
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg) return;
  if (TO_APP.has(msg.type)) {   // TCGplayer / Whatnot tab -> CardComp (side panel page + CardComp tabs)
    chrome.runtime.sendMessage(msg).catch(() => {});
    chrome.tabs.query({ url: "https://pm-derek.github.io/cardcomp/*" }, (tabs) => tabs.forEach((t) => chrome.tabs.sendMessage(t.id, msg).catch(() => {})));
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
    const create = () => chrome.tabs.create({ url: msg.url, active: false }).then((t) => chrome.storage.session.set({ tcgTab: t.id }));
    chrome.storage.session.get("tcgTab", (r) => {
      if (r && r.tcgTab != null) chrome.tabs.update(r.tcgTab, { url: msg.url, active: false }).catch(create);
      else create();
    });
    reply({ ok: true });
    return;
  }
  if (msg.type === "cardcomp-live-save") { queue(msg.key, msg.rec); reply({ ok: true }); return; }   // app -> GitHub live.json
  if (msg.type === "cardcomp-log-save") { queueLog(msg.rec); reply({ ok: true }); return; }
  if (msg.type === "cardcomp-snapshot") {   // "copy debug": ask the Whatnot tab for its lot row
    chrome.tabs.query({ url: "https://*.whatnot.com/*" }, (tabs) => {
      if (!tabs.length) { reply({ ok: false, why: "no Whatnot tab" }); return; }
      tabs.sort((a, b) => (b.active - a.active) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)));
      chrome.tabs.sendMessage(tabs[0].id, msg).then((r) => reply(r || { ok: false, why: "no reply" })).catch(() => reply({ ok: false, why: "reload the Whatnot tab" }));
    });
    return true;
  }
  if (msg.type === "cardcomp-log-prune") { pruneLog(msg.since, msg.before).then(reply, (e) => reply({ ok: false, why: e.message })); return true; }   // stats panel "clear logged data"
  if (msg.type === "cardcomp-live-test") { test().then(reply); return true; }
  if (msg.type !== "cardcomp-bid") return;
  chrome.tabs.query({ url: "https://*.whatnot.com/*" }, (tabs) => {
    if (!tabs.length) { reply({ ok: false, why: "no Whatnot tab" }); return; }
    // One stream only: the active Whatnot tab, else the one touched most recently.
    tabs.sort((a, b) => (b.active - a.active) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)));
    chrome.tabs.sendMessage(tabs[0].id, msg)
      .then((r) => reply(r || { ok: true }))
      .catch(() => reply({ ok: false, why: "Whatnot tab not ready, reload it" }));
  });
  return true; // async reply
});
