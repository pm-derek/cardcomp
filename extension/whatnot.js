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
  // Lot already sold / "Awaiting next item": a late tap is for the card that sold. Never fill or arm anything,
  // or the next lot's Custom box would get the old card's bid.
  let now0 = null; try { now0 = readLot(); } catch (_) {}   // read the page now, not the last tick: a late tap lands right after "Sold"
  const st0 = now0 || lotLastState;
  if (st0 && (st0.ended || st0.waiting)) {
    toast(`Lot already sold. $${amt}${msg.name ? " for " + msg.name : ""} was not entered.`, "wait");
    reply({ ok: false, why: "sold" });
    return;
  }
  pending = { amt, name: msg.name || "", at: Date.now() };
  // Already priced out (the live lot's next bid is above this max): don't open Custom bid at all
  const min0 = minBid();
  if (min0 != null && +amt < min0) {
    toast(`Pass: your max $${amt}${pending.name ? " for " + pending.name : ""} is under the next bid $${min0}.`, "bad");
    pending = null;
    reply({ ok: false, why: "under", min: min0 });
    return;
  }
  take(pending).then((how) => {
    // Under the minimum (Custom bid shows "$2 $3 $4 $5" and "Enter an amount of $2 or more"): the box is
    // filled so Derek sees it, but Whatnot will refuse it, so say pass instead of "place the bid".
    setTimeout(() => {
      const min = minBid();
      if (min != null && +amt < min) {
        toast(`Pass: your max $${amt}${pending && pending.name ? " for " + pending.name : ""} is under the next bid $${min}.`, "bad");
        reply({ ok: false, why: "under", min });
      } else reply({ ok: true, how });
    }, 200);
  });
  return true;
});
function minBid() {   // the lowest bid Whatnot will take right now
  for (const el of document.querySelectorAll("*")) {
    if (el.children.length) continue;
    const m = /enter an amount of \$([\d,]+) or more/i.exec(el.textContent || "");
    if (m) return +m[1].replace(/,/g, "");
  }
  return lotLastState && lotLastState.next != null && !lotLastState.ended ? lotLastState.next : null;
}

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
function toast(msg, kind, sticky) {
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
  if (!sticky) toastTimer = setTimeout(() => { toastEl.style.display = "none"; }, kind === "wait" ? 8000 : 3500);
}

// ---- Lot reader: what the auction on screen is doing, sent to CardComp whenever it changes ----
// Reads: lot title, current bid, next quick-bid, bid count, timer, who is winning (and if it is you),
// the seller's shipping line, the seller. When a lot ends (sold, or the title changes) the last state
// goes to CardComp as a record, which adds the card you were bidding on and stores it.
const LOT_RX = {
  bids: /(\d+)\s+bids?\b/i, money: /^\$\s?([\d,]+(?:\.\d{2})?)$/, timer: /^\d{1,2}:\d{2}$/,
  ship: /shipping is (?:\$([\d.]+)|(free))/i, win: /^(\S+)\s+is\s+winning!?$/i, winTail: /^is\s+winning!?$/i,
  me: /you(?:'re| are)\s+winning/i, next: /^bid:?\s*\$([\d,]+)/i, sold: /^sold to\s+(\S+)|^(\S+)\s+won\b/i, meWon: /^you won/i,
  joined: /^(\S+)\s+joined\b/i, giveaway: /giveaway with (\d+) entr/i, viewers: /^\d{1,6}$/,
  skip: /shipping|\bbids?$|^\$\s?[\d,.]+$|^\d{1,2}:\d{2}$|winning|^won!?$|won the auction|^you won|^\S+\s+is$|^sold$|^qty\.|^bid\b|^custom|^follow(ing)?$|^awaiting next item|^pre-bid|^max bid|^set max/i
};
// Room: who has been seen (joined in chat, or led a lot) and when. Sent with every lot record.
const members = new Map();   // user -> {first, last, joins, leads, chats}
function seen(user, how) {   // one call per event: a join line, a chat message, a lead change
  if (!user || user.length > 32 || user === "me") return;
  const m = members.get(user) || { first: Date.now(), last: 0, joins: 0, leads: 0, chats: 0, lastJoin: 0 };
  if (how === "joins" && Date.now() - m.lastJoin < 5 * 60000) { m.last = Date.now(); return; }   // chat list re-renders: one join per 5 min
  if (how === "joins") m.lastJoin = Date.now();
  m.last = Date.now(); m[how]++; members.set(user, m);
}
// who was seen in the last 30 min: min = minutes since first seen, ago = minutes since last seen
function roomSnapshot() { const cut = Date.now() - 30 * 60000, now = Date.now(); const out = {}; for (const [u, m] of members) if (m.last >= cut) out[u] = { leads: m.leads, joins: m.joins, chats: m.chats, min: Math.round((now - m.first) / 60000), ago: Math.round((now - m.last) / 60000) }; return out; }
// Chat panel (side list in the wide layout, overlay on the video in the narrow one): rows are
// [avatar letter?] "primo_512" + "joined 👋", or "bigben1171" + "Any mega IRs?". Rooted at the "Say something" box.
const chatSeen = new WeakSet();
function chatRootEl() {
  const box = document.querySelector('[data-testid="chat-input"],input[placeholder^="Say something" i],textarea[placeholder^="Say something" i]');
  if (!box || !box.parentElement) return null;
  let root = box.parentElement;
  for (let i = 0; i < 6 && root.parentElement; i++) { if (root.querySelectorAll("*").length > 60) break; root = root.parentElement; }
  return root;
}
function readChat() {
  const root = chatRootEl();
  if (!root) return;
  const ls = leaves(root);
  for (let i = 0; i + 1 < ls.length; i++) {
    const u = ls[i].textContent.trim(), next = ls[i + 1].textContent.trim();
    if (!userLike(u) || chatSeen.has(ls[i + 1])) continue;
    if (/^joined\b/i.test(next)) { chatSeen.add(ls[i + 1]); seen(u, "joins"); i++; }
    else if (next.length && !userLike(next) && ls[i].getBoundingClientRect().left <= ls[i + 1].getBoundingClientRect().left + 4) { chatSeen.add(ls[i + 1]); seen(u, "chats"); i++; }
  }
}
// text leaves: any size counts ("kal", "32" are narrower than the 20 px input heuristic in visible())
const textShown = (el) => { const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; const cs = getComputedStyle(el); return cs.visibility !== "hidden" && cs.display !== "none"; };
const leaves = (root) => [...root.querySelectorAll("*")].filter((el) => el.children.length === 0 && (el.textContent || "").trim().length && textShown(el));
// elements with their own (direct) text, in document order: leaves plus mixed elements ("Title #87<svg/>")
function ownTexts(root) {
  const out = [];
  for (const el of [root, ...root.querySelectorAll("*")]) {
    let t = ""; for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    t = t.replace(/\s+/g, " ").trim();
    if (t && textShown(el)) out.push({ el, t });
  }
  return out;
}
const NOT_NAME = /^(entries|giveaway|follow|following|custom|chat|watching|shop|bid|bids|sold|winning|won|joined|pre-bid|products)$/i;
const userLike = (s) => /^[A-Za-z0-9_.-]{2,32}$/.test(s || "") && /[A-Za-z]/.test(s) && !NOT_NAME.test(s);   // Whatnot usernames: no spaces, has a letter
// A winner read off the page: 3+ characters and not a chat word. Chat lines like "I won!", "It won lol", "Finally won one"
// once ended lots within a second of starting (0 bids) and named "I" x5, "It", "Finally" as winners (log 2026-10-16 / 10-30).
const NOT_WINNER = /^(i|it|we|he|she|they|you|me|my|who|someone|somebody|nobody|everyone|finally|just|already|never|also|still|and|but|so|lol|omg|yay|yes|no|nice|wow|bro|dude|guess|almost|actually|totally)$/i;
const winnerLike = (s) => userLike(s) && s.length >= 3 && !NOT_WINNER.test(s);
// Giveaway screens replace the lot (title "Selecting Winner" / "Giveaway Winner" + "won the giveaway!" /
// "Randomizing spot for X..."): never a lot, never a lot end, and "X won the giveaway!" is no sale.
const GIVEAWAY_RX = /^(selecting winner|giveaway winner|randomizing spot\b)|won the giveaway/i;
const GIVEAWAY_TXT = /giveaway|randomizing spot|selecting winner/i;
// two text elements belong together ("garrubia" + "is Winning!") only if they share an ancestor within 4 levels;
// otherwise the giveaway widget's "27 Entries" once became a winner
const near = (a, b) => { for (let x = a, i = 0; i < 4 && x; i++, x = x.parentElement) if (x.contains(b)) return true; return false; };
// The streamer, over the top-left of the video: "zenzoogie" / "★" "5.0" / "Follow". Found by the Follow /
// Following button, else by the star rating beside the name (the button is gone once Derek follows the seller,
// and a /user/ link fallback then logged chat users as sellers: "stayvng", "lex30_"). Once found it sticks for
// this stream URL, so it can never flip to a chat name mid-stream.
const SELLER_AT = new Map();   // location.pathname -> seller
function sellerName(all) {
  const path = location.pathname, known = SELLER_AT.get(path);
  if (known) return known;
  const pick = (i, back) => { for (let j = i - 1; j >= Math.max(0, i - back); j--) if (userLike(all[j].t) && !isMe(all[j].t) && near(all[j].el, all[i].el)) return all[j].t; return ""; };
  let u = "";
  for (let i = 0; i < all.length && !u; i++) if (/^follow(ing)?$/i.test(all[i].t)) u = pick(i, 4);
  for (let i = 0; i < all.length && !u; i++) if (/^★?\s*[0-5]\.\d$/.test(all[i].t)) { const r = all[i].el.getBoundingClientRect(); if (r.top < 200) u = pick(i, 3); }
  if (u) SELLER_AT.set(path, u);
  return u;
}
// Layout read from live screenshots (2026-10): the lot row is
//   [thumb] "$1 START SINGLES 🔥 #76" / "Near Mint · Card" / "1 Bid" / "Shipping is $0.78 + Taxes"   [ "$1" / "00:07" or "Sold" ]
// with "darks_tcg" + "is Winning!" (or "daybreakfm" + "won!") above it, a "darks_tcg won the auction!" popup
// on the video, and "Bid: $2" / "Awaiting next item" below. Titles often start with "$", so only a bare "$1"
// counts as a price, and the lot row is the smallest ancestor of "N Bid" that holds a bare price.
let ME = "";   // Derek's Whatnot username (extension Options), so "derek won!" counts as a win
try { chrome.storage.local.get("wnUser", (r) => { ME = String((r && r.wnUser) || "").trim().toLowerCase(); }); } catch (_) {}
const isMe = (u) => !!ME && String(u || "").trim().toLowerCase() === ME;
const COND_TXT = { "near mint": "NM", "lightly played": "LP", "moderately played": "MP", "heavily played": "HP", "damaged": "DMG" };
// Condition by its first word, as on the phone (2026-10-31 audit: "Light Played" on 79 desktop lots was blank and priced as NM)
const COND_WORD = { light: "LP", lightly: "LP", moderate: "MP", moderately: "MP", heavy: "HP", heavily: "HP", damaged: "DMG" };
function condOf(sub) {
  const s = (String(sub || "").split(/[·∙•|]/)[0] || "").trim().toLowerCase();
  if (COND_TXT[s]) return COND_TXT[s];
  const w = s.split(/\s+/);
  if (w.length > 3) return "";   // a description, not a condition
  if (w[0] === "near" && w[1] === "mint") return "NM";
  return COND_WORD[w[0]] || "";
}
let lastRow = null;   // the lot row the reader used last, for the "copy debug" snapshot
// "copy debug" in CardComp's strip: the lot row's HTML (two levels up, scripts / images / svg paths stripped) and
// the text the reader saw, so a layout the reader misses can be fixed from a paste instead of a guess.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.type !== "cardcomp-snapshot") return;
  let root = lastRow; for (let i = 0; i < 2 && root && root.parentElement; i++) root = root.parentElement;
  let html = "";
  if (root) {
    const c = root.cloneNode(true);
    c.querySelectorAll("script,style,path,img,video,canvas").forEach((e) => e.remove());
    c.querySelectorAll("*").forEach((e) => { for (const at of [...e.attributes]) if (!/^(class|role|aria-label|data-testid|href)$/.test(at.name)) e.removeAttribute(at.name); });
    html = c.outerHTML.replace(/\s+/g, " ").slice(0, 20000);
  }
  let st = {}; try { st = readLot(); } catch (_) {}
  reply({ ok: true, snap: { at: new Date().toISOString(), url: location.href, read: { title: st.title, sub: st.sub, cur: st.cur, bids: st.bids, timer: st.timer, lead: st.lead, seller: st.seller, sold: st.sold }, texts: root ? ownTexts(root).map((x) => x.t).slice(0, 80) : [], html } });
});
function readLot() {
  const all = ownTexts(document.body);   // every element with its own text: {el, t}
  const st = { title: "", sub: "", cond: "", cur: null, next: null, bids: null, timer: "", lead: "", me: false, ship: null, sold: "", ended: false, waiting: false, seller: sellerName(all), url: location.href, viewers: null, giveaway: null };
  const bareMoney = (el) => LOT_RX.money.test(el.textContent.trim()) && !el.closest("button");   // role=button lot rows keep their price ($null finals in the log)
  // Several "N bids" can be on the page: the wide layout has a Shop panel ("$1 START SINGLES" / "$1" /
  // "0 bids" / "Qty. 115" / "Pre-bid") before the live lot. Score each candidate's row and keep the live one.
  let card = null, bidsEl = null, best = -99;
  for (const b of all.filter((x) => LOT_RX.bids.test(x.t)).map((x) => x.el)) {
    let row = null; for (let el = b.parentElement, i = 0; i < 8 && el; i++, el = el.parentElement) { if ((el.textContent || "").length > 800) break; if (leaves(el).some(bareMoney)) { row = el; break; } }
    const t = (row || b.parentElement || b).textContent || "";
    const score = (/shipping is/i.test(t) ? 3 : 0) + (/\d{1,2}:\d{2}|\bsold\b/i.test(t) ? 3 : 0) + (row ? 1 : 0) - (/qty\.|pre-bid/i.test(t) ? 6 : 0);
    if (score > best) { best = score; card = row; bidsEl = b; }
  }
  if (best < 0) { card = null; bidsEl = null; }   // only the shop tile: no live lot on screen
  if (!card && bidsEl) card = bidsEl.parentElement && bidsEl.parentElement.parentElement;   // price column not found: still read the text block
  lastRow = card;
  // The whole lot card can be one real <button> (zenzoogie, 2026-10: title, description and "5 Bids" inside it,
  // price and timer outside), so only skip text in a button that does not also hold the bid count.
  const inBtn = (el) => { const b = el.closest("button"); return !!b && !(bidsEl && b.contains(bidsEl)); };
  const texts = [];
  // Read every element that holds text of its own, not only childless leaves: a title like
  // "Card on Screen (NO REFUNDS) #87" can sit beside an icon or badge element (zenzoogie's layout), which made
  // it invisible to a leaves-only read, so no title, no lot, and an old tap kept labeling lots.
  for (const { el, t } of (card ? ownTexts(card) : [])) {
    let m;
    if ((m = LOT_RX.bids.exec(t))) st.bids = +m[1];
    else if (LOT_RX.money.test(t) && !el.closest("button")) { if (st.cur == null) st.cur = parseFloat(LOT_RX.money.exec(t)[1].replace(/,/g, "")); }
    else if (LOT_RX.timer.test(t)) st.timer = t;
    else if ((m = LOT_RX.ship.exec(t))) st.ship = m[2] ? 0 : parseFloat(m[1]);   // "Shipping is FREE" = $0 (blank stays unknown); the line is what this lot adds for you in this show
    else if (/^sold$/i.test(t)) st.ended = true;
    else if (t.length > 1 && t.length < 120 && /[A-Za-z0-9]/.test(t) && !LOT_RX.skip.test(t) && !inBtn(el)) texts.push(t);   // icon-only text ("💀") is not a title; a role=button lot row is fine
  }
  // Still no title: look one or two levels above the row, taking only multi-word lines (a bare "nick0217" is a name)
  for (let up = card && card.parentElement, k = 0; !texts.length && up && k < 2; up = up.parentElement, k++)
    for (const { el, t } of ownTexts(up)) if (!card.contains(el) && /\s/.test(t) && t.length < 120 && /[A-Za-z]/.test(t) && !LOT_RX.skip.test(t) && !el.closest("button")) texts.push(t);
  st.title = texts[0] || ""; st.sub = texts[1] || "";
  // Whatnot labels the title itself (data-testid="show-product-title"): use it when it is on screen.
  const tEl = document.querySelector('[data-testid="show-product-title"]');
  if (tEl && textShown(tEl) && tEl.textContent.trim()) {
    st.title = tEl.textContent.replace(/\s+/g, " ").trim().slice(0, 119);
    const nx = tEl.nextElementSibling, sub = nx && nx.textContent.replace(/\s+/g, " ").trim();
    if (sub && !LOT_RX.bids.test(sub)) st.sub = sub.slice(0, 119);
  }   // title, then the seller's condition / category line
  st.cond = condOf(st.sub);   // "Near Mint ∙ Card" uses U+2219, "Light Played • Card"
  // Giveaway screen in the lot's place: lotTick leaves the lot alone while it shows
  st.giveawayScreen = GIVEAWAY_RX.test(st.title) || GIVEAWAY_RX.test(st.sub);
  // Chat (Whatnot's chat-message rows, or the list around the "Say something" box) never says who won or leads:
  // only joins are read from it. The chat root is ignored if it holds the lot card or the video (the climb went too far).
  const cRoot = chatRootEl();
  const cRootOK = !!cRoot && !(card && cRoot.contains(card)) && !(bidsEl && cRoot.contains(bidsEl)) && !cRoot.querySelector("video");
  const inChat = (el) => !!el.closest('[data-testid="chat-message"]') || (cRootOK && cRoot.contains(el));
  let wonBy = "", meWon = false, wonUser = "";
  for (let i = 0; i < all.length; i++) {
    const t = all[i].t; let m;
    if (inChat(all[i].el) || GIVEAWAY_TXT.test(t)) {   // chat / giveaway text: joins and entry counts only
      if ((m = LOT_RX.joined.exec(t)) && userLike(m[1])) { if (!chatSeen.has(all[i].el)) { chatSeen.add(all[i].el); seen(m[1], "joins"); } }
      else if ((m = LOT_RX.giveaway.exec(t))) st.giveaway = +m[1];
      continue;
    }
    const prev = i > 0 && near(all[i].el, all[i - 1].el) && !inChat(all[i - 1].el) ? all[i - 1].t : "";   // the name must sit right beside "is Winning!" / "won!"
    if (LOT_RX.me.test(t)) st.me = true;
    else if ((m = LOT_RX.win.exec(t))) st.lead = m[1];
    else if (LOT_RX.winTail.test(t) && userLike(prev)) st.lead = prev;
    else if (/^winning!?$/i.test(t) && (m = /^(\S+)\s+is$/i.exec(prev)) && userLike(m[1])) st.lead = m[1];   // zenzoogie: "samiam1271 is" + "Winning!"
    else if (/^won!?$/i.test(t) && winnerLike(prev)) { wonBy = prev; wonUser = prev; }   // "daybreakfm" + "won!"
    else if (/^awaiting next item$/i.test(t)) st.waiting = true;
    else if ((m = /^max bid added:?\s*\$([\d,]+)/i.exec(t))) st.placedMax = +m[1].replace(/,/g, "");   // what Derek actually set, even if he edited the box by hand
    else if ((m = LOT_RX.next.exec(t)) && all[i].el.closest("button,[role=button]")) st.next = parseFloat(m[1].replace(/,/g, ""));
    else if (LOT_RX.meWon.test(t)) { meWon = true; st.me = true; }           // "You won" popup in the middle of the video
    else if ((m = LOT_RX.sold.exec(t))) { if (winnerLike(m[1] || m[2])) wonBy = wonBy || m[1] || m[2]; }   // "Sold to X", "darks_tcg won the auction!"
    else if ((m = LOT_RX.joined.exec(t)) && userLike(m[1])) { if (!chatSeen.has(all[i].el)) { chatSeen.add(all[i].el); seen(m[1], "joins"); } }   // one-leaf "X joined" variant
    else if ((m = LOT_RX.giveaway.exec(t))) st.giveaway = +m[1];
    else if (/^entries$/i.test(t) && /^\d{1,6}$/.test(prev)) st.giveaway = +prev;   // "27" + "Entries"
    else if (st.viewers == null && LOT_RX.viewers.test(t) && !(card && card.contains(all[i].el))) {   // viewer count: a bare number in the top band of the page
      const r = all[i].el.getBoundingClientRect(); if (r.top < 220 && r.top >= 0) st.viewers = +t;
    }
  }
  if (isMe(st.lead)) st.me = true;
  // "You won" in the middle + "rewired won!" bottom left on the same screen: rewired is Derek. Learn it
  // once, so later wins and "rewired is Winning!" count as his even when the popup is gone. Only when that name led
  // this lot: a stranger's "X won!" next to a "You won" must never become Derek.
  if (meWon && wonUser && !ME && lot && (lot.leaders.has(wonUser) || lot.lastLead === wonUser || st.lead === wonUser)) { ME = wonUser.toLowerCase(); try { chrome.storage.local.set({ wnUser: wonUser }); } catch (_) {} }
  if (meWon) wonBy = "me";
  if (wonBy || st.ended) { st.ended = true; st.sold = (wonBy && wonBy !== "me" && isMe(wonBy)) ? "me" : (wonBy || "?"); if (st.sold === "me") st.me = true; }
  return st;
}
let lotLast = "", lot = null;   // lot: {title, leaders:Set, startedAt, ended}
// After the extension is reloaded or updated, this copy of the script is orphaned: every send throws "Extension
// context invalidated" and logging stops without a word. Say so once in the Whatnot tab and stop reading.
let orphan = false;
function orphaned() {
  if (orphan) return true;
  let gone = false; try { gone = !chrome.runtime || !chrome.runtime.id; } catch (_) { gone = true; }
  if (gone) markOrphan();
  return orphan;
}
function markOrphan() {
  if (orphan) return;
  orphan = true;
  try { lotObserver.disconnect(); } catch (_) {}
  try { clearInterval(lotIv); } catch (_) {}
  toast("CardComp extension updated: reload this tab to keep logging", "bad", true);
}
function sendApp(msg) {
  if (orphaned()) return;
  try { chrome.runtime.sendMessage(msg, () => chrome.runtime.lastError); }
  catch (e) { if (/context invalidated/i.test((e && e.message) || "") || orphaned()) markOrphan(); }
}
function endLot(st) {
  if (!lot || lot.ended) return;
  lot.ended = true;
  if (st.cur == null && st.bids == null) { sendApp({ type: "cardcomp-lot-end", rec: { empty: true, at: Date.now() } }); return; }   // never saw a price: tell the app to reset, log nothing
  sendApp({ type: "cardcomp-lot-end", rec: {
    v: 3, title: lot.title, sub: st.sub || lot.sub, sellerCond: st.cond || lot.cond, start: lot.start, final: st.cur, bids: st.bids,
    winner: st.sold && st.sold !== "me" && st.sold !== "?" ? st.sold : (st.me ? "me" : (st.lead || lot.lastLead || "")), me: !!(st.me || st.sold === "me"),
    sold: !!st.ended,                                     // saw "Sold" / "won!" (false: the lot rolled over without an end screen)
    iLed: lot.iLed,                                       // Derek was the leader at some point: proof he actually bid, not just tapped
    placedMax: lot.placedMax != null ? lot.placedMax : null,   // from "Max bid added $13": the max really set in Whatnot (may differ from what CardComp sent)
    leaders: [...lot.leaders], hist: lot.hist,            // hist: every lead change {t: s since lot start, u: user, a: amount}
    ship: st.ship, seller: st.seller, url: st.url, viewers: st.viewers, viewers0: lot.viewers0, giveaway: st.giveaway,
    room: roomSnapshot(), startedAt: lot.startedAt, at: Date.now(), hour: new Date().getHours(), dow: new Date().getDay()
  } });
}
const secs = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
function lotTick() {
  try { readChat(); } catch (_) {}
  let st; try { st = readLot(); } catch (_) { return; }
  if (st.giveawayScreen) return;   // a giveaway in the lot's place: no new lot, no lot end, nothing sent (the app would read "Sold")
  // A new lot starts when the title changes, or, for sellers who reuse one title ("$2 start") lot after
  // lot, when the bid count drops back (a new lot starts at 0) or the timer jumps back up after a sale.
  const tSec = secs(st.timer);
  // A lot must exist even when no title is readable: otherwise nothing ever ends and an old tap labels every
  // later lot. No title -> keep the current lot's key (a flicker is not a new lot), or "(untitled lot)" if a
  // live price or bid count is on screen; boundaries then come from the rollover rules and "Sold".
  const lkey = st.title || (lot ? lot.title : ((st.cur != null || st.bids != null) ? "(untitled lot)" : ""));
  const rolled = lot && lkey === lot.title && (
    (st.bids != null && lot.maxBids > 0 && st.bids < lot.maxBids) ||
    (lot.ended && !st.sold && tSec != null && lot.lastSec != null && tSec > lot.lastSec + 5));
  // A title change before any bid is the same lot read better (zenzoogie: the title only became readable when the
  // Custom bid box opened, which ended a phantom $1 lot and took Derek's Kirlia tap with it): rename, do not end.
  if (lkey && lot && lkey !== lot.title && !rolled && !lot.ended && !lot.maxBids) lot.title = lkey;
  if ((lkey && (!lot || lkey !== lot.title)) || rolled) {
    if (lot && lotLastState) endLot(lotLastState);
    lot = { title: lkey, sub: st.sub, cond: st.cond, leaders: new Set(), hist: [], start: st.cur, viewers0: st.viewers, startedAt: Date.now(), ended: false, maxBids: 0, lastSec: null, iLed: false, lastLead: "" };
  }
  if (lot) {
    if (st.lead) lot.lastLead = st.lead;
    if (st.bids != null && st.bids > lot.maxBids) lot.maxBids = st.bids;
    if (tSec != null) lot.lastSec = tSec;
    if (st.me) lot.iLed = true;
    if (st.placedMax != null) lot.placedMax = st.placedMax;
  }
  if (lot && st.lead) {
    lot.leaders.add(st.lead);
    const h = lot.hist, last = h[h.length - 1];
    if (!last || last.u !== st.lead || last.a !== st.cur) {   // one lead change = one bid event
      h.push({ t: Math.round((Date.now() - lot.startedAt) / 1000), u: st.lead, a: st.cur });
      if (!last || last.u !== st.lead) seen(st.lead, "leads");
    }
    if (h.length > 400) h.shift();
  }
  if (lot && st.sold && !lot.ended) endLot(st);
  st.endSent = !!(lot && lot.ended);   // this lot's end was already sent: a "Sold" on screen now is not a missed sale
  st.lotStart = lot ? lot.startedAt : null;   // the lot's id (its lot-end carries the same startedAt): a bid tapped now belongs to it
  lotLastState = st;
  if (window.__recogTick) try { window.__recogTick(st, lot); } catch (_) {}   // RECOG auto-recognition experiment, removed by scripts/strip-recog.js
  const key = JSON.stringify(st);
  if (key !== lotLast) { lotLast = key; sendApp(Object.assign({ type: "cardcomp-lot" }, st)); }
}
let lotLastState = null;
// Run on page changes, not a timer: Chrome throttles background-tab timers to once a minute, but
// mutation callbacks still fire, so a muted stream in another tab keeps reporting.
let lotBusy = false, lotQueued = false, lotLastRun = 0;
function lotRun() {
  if (orphaned()) return;
  if (lotBusy) { lotQueued = true; return; }
  lotBusy = true; lotLastRun = Date.now();
  try { lotTick(); } finally { lotBusy = false; }
  if (lotQueued) { lotQueued = false; setTimeout(lotRun, 250); }
}
const lotObserver = new MutationObserver(() => { if (Date.now() - lotLastRun > 300) lotRun(); else { lotQueued = true; if (!lotBusy) setTimeout(lotRun, 300); } });
lotObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
const lotIv = setInterval(lotRun, 2000);   // timer fallback for the foreground tab (the timer, not the observer, counts the clock down)
