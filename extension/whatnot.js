// Runs on whatnot.com. Receives {type:"cardcomp-bid", amount, name} and types the amount into the
// Custom bid box. It never presses Place bid: you confirm in CardComp, you place in Whatnot.
//
// Whatnot's markup is not documented, so this works in layers:
//   1. a visible bid-looking input (type number / inputmode decimal / placeholder "bid", "amount", "max") -> fill it
//   2. no input yet -> click the "Custom bid" button, wait for the box, fill it
//   3. still nothing -> arm: the next input you tap on the page gets the amount (2 minutes)
// A small toast at the top of the page says which happened.

let pending = null;      // {amt, name, at}
const ARM_MS = 120000;

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.type !== "cardcomp-bid") return;
  const amt = String(Math.max(0, Math.floor(Number(msg.amount) || 0)));
  if (amt === "0") { reply({ ok: false, why: "no amount" }); return; }
  pending = { amt, name: msg.name || "", at: Date.now() };
  take(pending).then((how) => reply({ ok: true, how }));
  return true;
});

async function take(p) {
  let inp = findBidInput();
  if (inp) { fill(inp, p); return "filled"; }
  const btn = findCustomButton();
  if (btn) {
    btn.click();
    inp = await waitFor(findBidInput, 2500);
    if (inp) { fill(inp, p); return "opened+filled"; }
  }
  toast(`$${p.amt} ready${p.name ? " for " + p.name : ""}. Tap Whatnot's Custom bid box.`, "wait");
  return "armed";
}

// Armed fallback: the next input the user focuses gets the amount.
document.addEventListener("focusin", (e) => {
  if (!pending || Date.now() - pending.at > ARM_MS) return;
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || isChat(el)) return;
  if (el.dataset.cardcompFilled === pending.amt) return;
  setTimeout(() => fill(el, pending), 0);
}, true);

function visible(el) {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 20 || r.height < 10) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.display !== "none";
}
function text(el) { return ((el.getAttribute("aria-label") || "") + " " + (el.placeholder || "") + " " + (el.name || "") + " " + (el.id || "")).toLowerCase(); }
function isChat(el) { return /chat|message|comment|search|say something|email|password|code/i.test(text(el)); }

function findBidInput() {
  const inputs = [...document.querySelectorAll("input")].filter((el) => visible(el) && !el.disabled && !el.readOnly && !isChat(el));
  let best = null, bestScore = 0;
  for (const el of inputs) {
    const t = text(el), type = (el.type || "text").toLowerCase(), im = (el.inputMode || "").toLowerCase();
    if (!["text", "number", "tel", ""].includes(type)) continue;
    let s = 0;
    if (/bid|amount|max/.test(t)) s += 5;
    if (/\$/.test(el.placeholder || "") || /^\$?\s*\d*$/.test(el.value || "")) s += 1;
    if (type === "number" || im === "decimal" || im === "numeric") s += 3;
    if (el.closest("[role=dialog],[aria-modal=true]")) s += 2;
    if (s > bestScore) { bestScore = s; best = el; }
  }
  return bestScore >= 3 ? best : null;
}

function findCustomButton() {
  const els = [...document.querySelectorAll("button,[role=button],a")].filter(visible);
  return els.find((el) => /^\s*custom(\s+bid)?\s*$/i.test(el.textContent || "")) ||
         els.find((el) => /custom\s+bid/i.test(el.textContent || "") && (el.textContent || "").trim().length < 30) || null;
}

function waitFor(fn, ms) {
  return new Promise((res) => {
    const t0 = Date.now();
    const tick = () => { const v = fn(); if (v) return res(v); if (Date.now() - t0 > ms) return res(null); setTimeout(tick, 100); };
    tick();
  });
}

function fill(el, p) {
  const v = p.amt;
  el.focus();
  try { el.select(); } catch (_) {}
  let ok = false;
  try { ok = document.execCommand("insertText", false, v) && el.value === v; } catch (_) {}
  if (!ok) {
    // React controlled input: go through the native setter, then fire input/change.
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value") || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    desc.set.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    desc.set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  el.dataset.cardcompFilled = v;
  const landed = el.value.replace(/[^0-9]/g, "") === v;
  toast(landed ? `$${v} entered${p.name ? " for " + p.name : ""}. Place the bid when ready.` : `Could not enter $${v}. Type it: ${v}`, landed ? "ok" : "bad");
  if (landed) pending = null;
}

let toastEl = null, toastTimer = null;
function toast(msg, kind) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.style.cssText = "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:8px 14px;border-radius:8px;" +
      "font:600 14px/1.3 system-ui,sans-serif;color:#0b0d10;box-shadow:0 4px 16px rgba(0,0,0,.4);pointer-events:none;max-width:80vw";
    document.documentElement.appendChild(toastEl);
  }
  toastEl.textContent = "CardComp: " + msg;
  toastEl.style.background = kind === "ok" ? "#5fd6a0" : kind === "bad" ? "#ff6b6b" : "#f5b301";
  toastEl.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.style.display = "none"; }, kind === "wait" ? 8000 : 3500);
}

// ---- Lot reader: what the auction on screen is doing, sent to CardComp whenever it changes ----
// Reads: lot title, current bid, next quick-bid, bid count, timer, who is winning (and if it is you),
// the seller's shipping line, the seller. When a lot ends (sold, or the title changes) the last state
// goes to CardComp as a record, which adds the card you were bidding on and stores it.
const LOT_RX = {
  bids: /(\d+)\s+bids?\b/i, money: /^\$\s?([\d,]+(?:\.\d{2})?)$/, timer: /^\d{1,2}:\d{2}$/,
  ship: /shipping is \$([\d.]+)/i, win: /^(\S+)\s+is\s+winning!?$/i, winTail: /^is\s+winning!?$/i,
  me: /you(?:'re| are)\s+winning/i, next: /^bid:?\s*\$([\d,]+)/i, sold: /^sold to\s+(\S+)|^(\S+)\s+won\b/i, meWon: /^you won/i,
  joined: /^(\S+)\s+joined\b/i, giveaway: /giveaway with (\d+) entr/i, viewers: /^\d{1,6}$/,
  skip: /^condition|shipping|bids?$|^\$|^\d{1,2}:\d{2}$|winning|^bid\b|^custom/i
};
// Room: who has been seen (joined in chat, or led a lot) and when. Sent with every lot record.
const members = new Map();   // user -> {first, last, joins, leads}
function seen(user, how) {
  if (!user || user.length > 32 || user === "me") return;
  const m = members.get(user) || { first: Date.now(), last: 0, joins: 0, leads: 0 };
  m.last = Date.now(); m[how]++; members.set(user, m);
}
function roomSnapshot() { const cut = Date.now() - 30 * 60000; const out = {}; for (const [u, m] of members) if (m.last >= cut) out[u] = { leads: m.leads, joins: m.joins, min: Math.round((Date.now() - m.first) / 60000) }; return out; }
const leaves = (root) => [...root.querySelectorAll("*")].filter((el) => el.children.length === 0 && (el.textContent || "").trim().length && visible(el));
function sellerName() {
  const a = document.querySelector('a[href^="/user/"],a[href*="whatnot.com/user/"]');
  if (a) { const m = /\/user\/([^/?#]+)/.exec(a.getAttribute("href") || ""); if (m) return decodeURIComponent(m[1]); }
  return (document.title || "").replace(/\s*[|·-]\s*whatnot.*$/i, "").trim();
}
function readLot() {
  const all = leaves(document.body);
  const st = { title: "", cur: null, next: null, bids: null, timer: "", lead: "", me: false, ship: null, sold: "", seller: sellerName(), url: location.href, viewers: null, giveaway: null };
  const bidsEl = all.find((el) => LOT_RX.bids.test(el.textContent.trim()));
  let card = null;
  if (bidsEl) { let el = bidsEl.parentElement; for (let i = 0; i < 8 && el; i++, el = el.parentElement) { const t = el.textContent || ""; if (/\$\s?\d/.test(t) && t.length < 600) { card = el; break; } } }
  for (const el of (card ? leaves(card) : [])) {
    const t = el.textContent.trim(); let m;
    if ((m = LOT_RX.bids.exec(t))) st.bids = +m[1];
    else if ((m = LOT_RX.money.exec(t))) { if (st.cur == null) st.cur = parseFloat(m[1].replace(/,/g, "")); }
    else if (LOT_RX.timer.test(t)) st.timer = t;
    else if ((m = LOT_RX.ship.exec(t))) st.ship = parseFloat(m[1]);
    else if (!st.title && t.length > 2 && t.length < 120 && !LOT_RX.skip.test(t)) st.title = t;
  }
  for (let i = 0; i < all.length; i++) {
    const t = all[i].textContent.trim(); let m;
    if (LOT_RX.me.test(t)) st.me = true;
    else if ((m = LOT_RX.win.exec(t))) st.lead = m[1];
    else if (LOT_RX.winTail.test(t) && i > 0) st.lead = all[i - 1].textContent.trim();
    else if ((m = LOT_RX.next.exec(t)) && all[i].closest("button,[role=button]")) st.next = parseFloat(m[1].replace(/,/g, ""));
    else if (LOT_RX.meWon.test(t)) { st.sold = "me"; st.me = true; }
    else if ((m = LOT_RX.sold.exec(t))) st.sold = m[1] || m[2];
    else if ((m = LOT_RX.joined.exec(t))) { if (!joinedSeen.has(all[i])) { joinedSeen.add(all[i]); seen(m[1], "joins"); } }
    else if ((m = LOT_RX.giveaway.exec(t))) st.giveaway = +m[1];
    else if (st.viewers == null && LOT_RX.viewers.test(t) && !(card && card.contains(all[i]))) {   // viewer count: a bare number in the top band of the page
      const r = all[i].getBoundingClientRect(); if (r.top < 220 && r.top >= 0) st.viewers = +t;
    }
  }
  return st;
}
const joinedSeen = new WeakSet();
let lotLast = "", lot = null;   // lot: {title, leaders:Set, startedAt, ended}
function sendApp(msg) { try { chrome.runtime.sendMessage(msg, () => chrome.runtime.lastError); } catch (_) {} }
function endLot(st) {
  if (!lot || lot.ended) return;
  lot.ended = true;
  if (st.cur == null && st.bids == null) { sendApp({ type: "cardcomp-lot-end", rec: { empty: true, at: Date.now() } }); return; }   // never saw a price: tell the app to reset, log nothing
  sendApp({ type: "cardcomp-lot-end", rec: {
    v: 3, title: lot.title, start: lot.start, final: st.cur, bids: st.bids,
    winner: st.sold && st.sold !== "me" ? st.sold : (st.me ? "me" : st.lead), me: !!(st.me || st.sold === "me"),
    iLed: lot.iLed,                                       // Derek was the leader at some point: proof he actually bid, not just tapped
    leaders: [...lot.leaders], hist: lot.hist,            // hist: every lead change {t: s since lot start, u: user, a: amount}
    ship: st.ship, seller: st.seller, url: st.url, viewers: st.viewers, viewers0: lot.viewers0, giveaway: st.giveaway,
    room: roomSnapshot(), startedAt: lot.startedAt, at: Date.now(), hour: new Date().getHours(), dow: new Date().getDay()
  } });
}
const secs = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
function lotTick() {
  let st; try { st = readLot(); } catch (_) { return; }
  // A new lot starts when the title changes, or, for sellers who reuse one title ("$2 start") lot after
  // lot, when the bid count drops back (a new lot starts at 0) or the timer jumps back up after a sale.
  const tSec = secs(st.timer);
  const rolled = lot && st.title === lot.title && (
    (st.bids != null && lot.maxBids > 0 && st.bids < lot.maxBids) ||
    (lot.ended && !st.sold && tSec != null && lot.lastSec != null && tSec > lot.lastSec + 5));
  if ((st.title && (!lot || st.title !== lot.title)) || rolled) {
    if (lot && lotLastState) endLot(lotLastState);
    lot = { title: st.title, leaders: new Set(), hist: [], start: st.cur, viewers0: st.viewers, startedAt: Date.now(), ended: false, maxBids: 0, lastSec: null, iLed: false };
  }
  if (lot) {
    if (st.bids != null && st.bids > lot.maxBids) lot.maxBids = st.bids;
    if (tSec != null) lot.lastSec = tSec;
    if (st.me) lot.iLed = true;
  }
  if (lot && st.lead) {
    lot.leaders.add(st.lead); seen(st.lead, "leads");
    const h = lot.hist, last = h[h.length - 1];
    if (!last || last.u !== st.lead || last.a !== st.cur) h.push({ t: Math.round((Date.now() - lot.startedAt) / 1000), u: st.lead, a: st.cur });
    if (h.length > 400) h.shift();
  }
  if (lot && st.sold && !lot.ended) endLot(st);
  lotLastState = st;
  const key = JSON.stringify(st);
  if (key !== lotLast) { lotLast = key; sendApp(Object.assign({ type: "cardcomp-lot" }, st)); }
}
let lotLastState = null;
// Run on page changes, not a timer: Chrome throttles background-tab timers to once a minute, but
// mutation callbacks still fire, so a muted stream in another tab keeps reporting.
let lotBusy = false, lotQueued = false, lotLastRun = 0;
function lotRun() {
  if (lotBusy) { lotQueued = true; return; }
  lotBusy = true; lotLastRun = Date.now();
  try { lotTick(); } finally { lotBusy = false; }
  if (lotQueued) { lotQueued = false; setTimeout(lotRun, 250); }
}
new MutationObserver(() => { if (Date.now() - lotLastRun > 300) lotRun(); else { lotQueued = true; if (!lotBusy) setTimeout(lotRun, 300); } })
  .observe(document.documentElement, { childList: true, subtree: true, characterData: true });
setInterval(lotRun, 2000);   // timer fallback for the foreground tab (the timer, not the observer, counts the clock down)
