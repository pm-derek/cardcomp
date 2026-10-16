// Relay: CardComp (tab or side panel) -> the Whatnot tab you are watching.
// Toolbar button opens CardComp in the side panel next to the Whatnot stream.
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg) return;
  if (msg.type === "cardcomp-tcg-price") {   // TCGplayer tab -> CardComp (side panel page + CardComp tabs)
    chrome.runtime.sendMessage(msg).catch(() => {});
    chrome.tabs.query({ url: "https://pm-derek.github.io/cardcomp/*" }, (tabs) => tabs.forEach((t) => chrome.tabs.sendMessage(t.id, msg).catch(() => {})));
    reply({ ok: true });
    return;
  }
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
