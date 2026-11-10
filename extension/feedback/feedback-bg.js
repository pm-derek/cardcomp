// Feedback thank-yous, background half (Derek, 2026-11-06: "see all the feedback and generate a thank-you to send to
// each one; show what they said, a suggested response, approve or disapprove"). Worded, named feedback from the last
// 14 days on the Seller Portal Feedback tab (feedback.js) gets a draft from Claude here, Derek approves it on that page,
// and order.js sends it through the order's Contact Buyer drawer (replies to feedback are not public; a message to the
// buyer is). Key: the Anthropic key already on the Options page (recogKey). Nothing is sent without a tap on Send.
const FB_MODEL = "claude-opus-5-5";
const FB_SYSTEM = `You write short thank-you messages from Derek, who runs the TCGplayer store East Bay Trader, to buyers who left written feedback on an order. The message goes to the buyer directly through TCGplayer's order messages.
Voice: warm, casual, first person, one to three sentences. Exclamation marks are fine. No sign-off, no name, no emoji, no links. Plain text only.
Mention the card by its short name when the order lists one or two cards (e.g. "the Samurott V", not the full catalog line). With more cards, say "the cards". Never invent details that are not in the feedback or the order.
If the buyer describes a problem that was fixed, thank them for their patience and say you are glad it worked out. If they say they will order again, say you would be glad to see them back.
Never offer discounts or future favors, never ask them to change or add a rating, never mention that this message was drafted or automated. Do not repeat the buyer's words back at length.
Two real messages from Derek, for the voice:
- "Amazing, glad it arrived quickly! Thank you!!"
- "Aw, thank you for the very kind review! I'm glad we were able to sort it out, there's so much room for things to go wrong and I'm always relieved when there's a chance to make things right when things do inevitably go a tad south. Thanks again!"
Output only the message text.`;
const FB_NEG = `This feedback is 3 stars or lower. Different job: the buyer had a problem. Acknowledge what they said in one sentence, say you want to make it right, and ask them to reply with what would fix it (replacement, return, or a refund under TCGplayer's refund and return policy). Do not promise a specific refund amount, do not argue, do not mention ratings at all. Two to four sentences, calm and direct.`;
const fbKey = () => new Promise((res) => chrome.storage.local.get("recogKey", (r) => res((r && r.recogKey) || "")));
function fbErr(status, body) {
  let m = ""; try { m = JSON.parse(body).error.message; } catch (_) { m = String(body || "").slice(0, 160); }
  return status === 401 ? "key rejected (401)" : status === 429 ? "rate limited (429), try again in a minute" : "HTTP " + status + (m ? ": " + m : "");
}
// One draft. row: {order, user, rating, comment, date, products:[...catalog lines], fbDate}
async function fbDraft(row, style) {
  const key = await fbKey();
  if (!key) return { ok: false, why: "no key", nokey: true };
  const neg = (row.rating || 5) <= 3;
  const sys = FB_SYSTEM + (neg ? "\n" + FB_NEG : "") + (style === "shorter" ? "\nKeep it to one short sentence." : "") + (row.history ? "\nBuyer history: " + row.history + ". A repeat buyer: say so briefly and warmly, no discounts or favors." : (row.orders || 1) > 1 ? "\nThis buyer has ordered " + row.orders + " times in the last two weeks: a repeat buyer, say so briefly." : "");
  const lines = ["Buyer: " + (row.user || "unknown"), "Rating: " + (row.rating || "?") + " of 5", "Order date: " + (row.date || "?"),
    row.fbDate ? "Feedback left: " + row.fbDate : "", "Feedback: " + String(row.comment || "").trim(),
    "Cards in the order:" + ((row.products || []).length ? "\n" + row.products.map((p) => "- " + p).join("\n") : " (not read)")].filter(Boolean);
  let r;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-beta": "server-side-fallback-2026-07-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({ model: FB_MODEL, max_tokens: 400, fallbacks: "default", output_config: { effort: "low" }, system: sys,
        messages: [{ role: "user", content: lines.join("\n") }] }) });
  } catch (e) { return { ok: false, why: "network: " + e.message }; }
  if (!r.ok) return { ok: false, why: fbErr(r.status, await r.text()) };
  const j = await r.json();
  if (j.stop_reason === "refusal") return { ok: false, why: "the model declined this one, write it by hand" };
  const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim().replace(/^["“]|["”]$/g, "");
  if (!text) return { ok: false, why: "empty reply" };
  const u = j.usage || {}, cost = ((u.input_tokens || 0) * 4 + (u.output_tokens || 0) * 20) / 1e6;
  return { ok: true, text, model: j.model || FB_MODEL, cost };
}

// One background tab for order pages, reused. Opening an order and sending a message both go through it; order.js in
// that tab reports the order (cards, feedback, buyer) when it has loaded and does the Contact Buyer fill on request.
const FB_ORDER_URL = (o) => "https://sellerportal.tcgplayer.com/orders/" + o;
const FB_WAIT = {};   // order id -> [resolve]
async function fbTab(order, win) {
  const k = "fbTab";
  const cur = await new Promise((res) => chrome.storage.session.get(k, (r) => res(r && r[k])));
  if (cur != null) {
    try { const t = await chrome.tabs.get(cur); if (t) { await chrome.tabs.update(cur, { url: FB_ORDER_URL(order), active: false }); return cur; } } catch (_) {}
  }
  const t = await chrome.tabs.create(Object.assign({ url: FB_ORDER_URL(order), active: false }, win != null ? { windowId: win } : {}));
  chrome.storage.session.set({ [k]: t.id });
  return t.id;
}
function fbAwaitOrder(order, ms) {
  return new Promise((res) => {
    (FB_WAIT[order] = FB_WAIT[order] || []).push(res);
    setTimeout(() => { const i = (FB_WAIT[order] || []).indexOf(res); if (i >= 0) { FB_WAIT[order].splice(i, 1); res(null); } }, ms);
  });
}
async function fbOpenOrder(order, win) {
  const tabId = await fbTab(order, win);
  const info = await fbAwaitOrder(order, 30000);
  return { tabId, info };
}
// true when handled (reply is async). Hooked from bg.js.
function fbHandle(msg, sender, reply) {
  if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("cardcomp-fb-")) return false;
  const win = sender && sender.tab ? sender.tab.windowId : null;
  if (msg.type === "cardcomp-fb-key") { fbKey().then((k) => reply({ ok: !!k })); return true; }
  if (msg.type === "cardcomp-fb-key-test") {   // Options page: one tiny call proves the key
    fbKey().then(async (key) => {
      if (!key) return reply({ ok: false, why: "no key saved" });
      try {
        const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
          headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
          body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 16, messages: [{ role: "user", content: "Reply with: ok" }] }) });
        reply(r.ok ? { ok: true } : { ok: false, why: fbErr(r.status, await r.text()) });
      } catch (e) { reply({ ok: false, why: "network: " + e.message }); }
    });
    return true;
  }
  if (msg.type === "cardcomp-fb-issue") { fbIssueDraft(msg).then(reply, (e) => reply({ ok: false, why: e.message })); return true; }
  if (msg.type === "cardcomp-fb-price") {   // thread.js: every condition's market for a product (tcgfast.js)
    if (typeof tcgFast !== "function") { reply({ ok: false, why: "no price reader" }); return true; }
    tcgFast({ pid: msg.pid, printing: msg.printing || "", cond: "NM" }).then((r) => reply({ ok: true, conds: r.conds || {}, errs: r.errs || [] }), (e) => reply({ ok: false, why: e.message }));
    return true;
  }
  if (msg.type === "cardcomp-fb-draft") { fbDraft(msg.row || {}, msg.style || "").then(reply, (e) => reply({ ok: false, why: e.message })); return true; }
  if (msg.type === "cardcomp-fb-order-info") {   // order.js, on load: {order, products, feedback, fbDate, buyer}
    const w = FB_WAIT[msg.order]; delete FB_WAIT[msg.order];
    (w || []).forEach((f) => f(msg));
    reply({ ok: true }); return true;
  }
  if (msg.type === "cardcomp-fb-pending") { fbBadge(msg.n); reply({ ok: true }); return true; }   // the panel's own count
  if (msg.type === "cardcomp-fb-buyers-merge") { fbBuyersMerge(msg.orders || []).then((r) => reply(Object.assign({ ok: true }, r)), (e) => reply({ ok: false, why: e.message })); return true; }
  if (msg.type === "cardcomp-fb-buyers-import") { fbBuyersMerge(fbParseCSV(msg.csv || "")).then((r) => reply(Object.assign({ ok: true }, r)), (e) => reply({ ok: false, why: e.message })); return true; }
  if (msg.type === "cardcomp-fb-buyer") { fbBuyersGet().then((m) => reply({ ok: true, stats: fbBuyerStats(m, msg.name, msg.at || 0) })); return true; }
  if (msg.type === "cardcomp-fb-buyers-summary") {
    fbBuyersGet().then((m) => { const bs = Object.values(m), n = bs.reduce((s, b) => s + Object.keys(b.orders).length, 0), rep = bs.filter((b) => Object.keys(b.orders).length > 1).length;
      const ats = bs.flatMap((b) => Object.values(b.orders).map((o) => o.at || 0)).filter(Boolean);
      reply({ ok: true, buyers: bs.length, orders: n, repeat: rep, first: ats.length ? Math.min(...ats) : 0, last: ats.length ? Math.max(...ats) : 0 }); });
    return true;
  }
  if (msg.type === "cardcomp-fb-threads") {   // messages.js read the Messages list
    fbThreadsPut(msg.rows || []).then((m) => { FB_TWAIT.splice(0).forEach((w) => w.res(m)); reply({ ok: true }); });
    return true;
  }
  if (msg.type === "cardcomp-fb-thread") {   // panel: the thread url for an order (opens the Messages list when unknown)
    fbThread(msg.order, msg.since || 0, win).then((url) => reply(url ? { ok: true, url } : { ok: false }), (e) => reply({ ok: false, why: e.message }));
    return true;
  }
  if (msg.type === "cardcomp-fb-order") {   // feedback.js: open the order in the background tab, return what it shows
    fbOpenOrder(msg.order, win).then(({ info }) => reply(info ? { ok: true, info } : { ok: false, why: "the order page did not load in 30 s" }), (e) => reply({ ok: false, why: e.message }));
    return true;
  }
  if (msg.type === "cardcomp-fb-send") {   // feedback.js: Derek tapped Send on a draft
    (async () => {
      const { tabId, info } = await fbOpenOrder(msg.order, win);
      if (!info) return reply({ ok: false, why: "the order page did not load" });
      let r;
      try { r = await chrome.tabs.sendMessage(tabId, { type: "cardcomp-fb-fill", order: msg.order, text: msg.text, expect: msg.expect || null }); } catch (e) { r = { ok: false, why: "no reply from the order tab" }; }
      if (!r || !r.ok) { try { await chrome.tabs.update(tabId, { active: true }); } catch (_) {} }   // show Derek what happened
      reply(r || { ok: false, why: "no reply" });
    })().catch((e) => reply({ ok: false, why: e.message }));
    return true;
  }
  return false;
}

// Message threads (messages.js reads the Messages list): order -> rows, kept 300. A lookup after a send opens the list
// in the background tab and waits for the read; the newest General Inquiry thread of that order created on or after
// the send is the one (an order can also carry the buyer's own thread). Stored on fbDone[order].thread by the panel.
const FB_TWAIT = [];
const fbThreadsGet = () => new Promise((res) => chrome.storage.local.get("fbThreads", (r) => res((r && r.fbThreads) || {})));
async function fbThreadsPut(rows) {
  const m = await fbThreadsGet();
  rows.forEach((r) => { if (!r.order) return; const l = (m[r.order] = m[r.order] || []); if (!l.some((x) => x.id === r.id)) l.unshift({ id: r.id, url: r.url, subject: r.subject, members: r.members, created: r.created, seen: Date.now() }); });
  const keys = Object.keys(m); if (keys.length > 300) keys.sort((a, b) => Math.max(...m[b].map((x) => x.seen || 0)) - Math.max(...m[a].map((x) => x.seen || 0))).slice(300).forEach((k) => delete m[k]);
  await new Promise((res) => chrome.storage.local.set({ fbThreads: m }, res));
  return m;
}
function fbPickThread(list, since) {   // newest General Inquiry seen since the send, else the newest General Inquiry, else the newest row
  if (!list || !list.length) return null;
  const gi = list.filter((x) => /general inquiry/i.test(x.subject || ""));
  const fresh = gi.filter((x) => !since || (x.seen || 0) >= since);
  return (fresh[0] || gi[0] || list[0]).url;
}
async function fbThread(order, since, win) {
  let m = await fbThreadsGet();
  const have = fbPickThread(m[order], since);
  if (have && (!since || (m[order] || []).some((x) => (x.seen || 0) >= since))) return have;
  const got = new Promise((res) => { const w = { res }; FB_TWAIT.push(w); setTimeout(() => { const i = FB_TWAIT.indexOf(w); if (i >= 0) { FB_TWAIT.splice(i, 1); res(null); } }, 30000); });
  const k = "fbTab", cur = await new Promise((res) => chrome.storage.session.get(k, (r) => res(r && r[k])));
  const url = "https://sellerportal.tcgplayer.com/messages";
  try { if (cur != null) await chrome.tabs.update(cur, { url, active: false }); else { const t = await chrome.tabs.create(Object.assign({ url, active: false }, win != null ? { windowId: win } : {})); chrome.storage.session.set({ [k]: t.id }); } }
  catch (_) { const t = await chrome.tabs.create({ url, active: false }); chrome.storage.session.set({ [k]: t.id }); }
  m = (await got) || m;
  return fbPickThread(m[order], since) || null;
}

// Issue replies (thread.js): the playbook. Rules from TCGplayer's Refund and Return Policy (change log to 6/30/26) and
// the seller blog's "Order Issues and Prewritten Responses" / "Card Condition: Reduce Order Disputes", pasted by Derek
// 2026-11-06 (the help hosts are blocked from the build sandbox). Their wording is not copied; the rules are:
// - buyers must reach out within 30 calendar days of the estimated delivery; the seller has 2 business days to reply;
//   TCGplayer steps in when a seller is silent, when there is no agreement, when there is no valid tracking, or when
//   tracking says delivered.
// - missing order: reported on the estimated delivery date or within 2 business days after it, the seller may ask
//   the buyer to wait until estimated delivery + 2 business days; reported later than that, refund immediately.
//   Tracked and delivered: TCGplayer handles it. (The 2020 article's "8 business days from the order" is superseded.)
// - condition: three options, partial refund (TCGplayer suggests ~10% per condition step; Derek recomps at the
//   arrived condition from the market instead), a replacement in the right condition with a prepaid return, or a
//   prepaid return for a full refund. The seller always pays return shipping (label or self-addressed stamped
//   envelope). Sellers CANNOT require photos before resolving; asking is fine, conditioning on it is not.
// - wrong card: keep it and refund the difference (never charge extra when the wrong card is dearer), the right card
//   as a replacement once the buyer confirms (prepaid return of the wrong one if wanted), or return for a full refund.
//   Photos cannot be required here either.
// - missing card from the package: reship it if in stock, else refund that card in full.
// - returns must be authorized by the seller first ("return to sender" without contact earns no refund); a cancel
//   after shipping = refuse the unopened package, refund when it is back; package damaged in transit = refund with
//   the return, opened = refund the damaged items; suspected counterfeit = TCGplayer customer service runs it (their
//   prepaid label, full refund); buyer's remorse and price moves are not refundable; a wrong address given at
//   checkout is not refundable once shipped.
// - the blog's shape of a good reply: acknowledge, apologize, options, close with thanks; assume the mistake may be
//   yours even when sure; a return mailer for a 25-cent card is not worth it, refund and move on; valuable returns
//   with tracking; "Escalate This Thread" for a buyer acting in bad faith.
// Derek's practice on top: photos asked for (never required), both paths offered in the same message, recomp per
// card at the arrived condition, refund rounded up to the dollar, a prestamped envelope for returns, refund on receipt.
const FB_ISSUE_SYSTEM = `You draft Derek's next reply in a TCGplayer order message thread. Derek runs the store East Bay Trader and sells Pokemon singles. The message goes to the buyer inside TCGplayer's order messages (plain text only, blank lines between paragraphs are fine, no formatting).
Voice: warm, plain, direct, first person, no corporate phrasing, no sign-off, no emoji. Short sentences. "Oh no!" / "Ah sorry to hear that" / "Totally fair" / "Sounds good" are things Derek says. Assume the mistake may be Derek's, even when it may not be. Never blame the buyer, never argue, never mention ratings or feedback, never mention that this was drafted. Every reply: acknowledge what they said, say sorry for the hassle, give the options or the next step, and close warmly.
Real messages from Derek, for the voice:
- "Oh no! I must've missed that. Can you shoot me a picture? Can upload to dropbox/imgur or anything like that. Would you like to return these for a full refund (I'll send a stamped envelope, and once I receive the cards i'll fully refund)? Or I can recomp these against their lower conditions and then partial refund + extra for the inconvenience?"
- "Ah sorry to hear that. Ok here is more detail on the options we can pick from. Option 1 - Full refund where you wait for the stamped envelope. Option 2 - Partial refund based on condition. Misty's Wish - that crease is possibly HP but lets just consider it DMG. DMG goes for $6 and I had charged you $13, so I would refund $7. ==> Total refund of $9. Does that work for you?"
- "Totally fair. Your call if you'd like to mail it directly to me or wait for me to ship you an envelope. Following TCGP's policy, once I get ahold of the returned cards, I'll issue the full refund. If you decided to ship it yourself, best to keep them in the same toploader and taped up so that they dont slip out the top. A single forever stamp will usually work. I'm really sorry about the inconvenience!"
- "Ah I remember this, that was totally my mistake. So 3 options for you: 1. You keep the one you have and I'll refund you the difference in value 2. Return the one you have (I can send you a prestamped envelope if you'd like, just let me know), and I'll ship you the actual card you want 3. You just want a full refund by returning the card"
TCGplayer rules you must follow (do not quote them as rules; just comply):
- Photos can be asked for but never required: a resolution never waits on a picture. Ask once, lightly ("a quick picture helps me grade it, if it's easy"), and offer the options in the same message.
- Return shipping is always on Derek (a prestamped envelope or a label). Refunds go through TCGplayer. Returns must be agreed in the thread before the buyer mails anything.
- Missing order: if it was reported on the estimated delivery date or within 2 business days after, Derek may ask the buyer to allow until the given wait-until date; past that date, the full refund goes out now, no conditions. Tracking that says delivered: Derek opens it with TCGplayer customer service, who take it from there.
- Never promise a date or an amount you were not given. Buyers have 30 days from the estimated delivery to raise an issue; do not bring that up unless the thread is past it.
Playbook by issue type:
CONDITION ISSUE. Stage 1 (first reply): sorry, light ask for a picture, and the two paths in one message: (a) recomp at the condition it arrived in and partial refund plus a little for the trouble, (b) return for a full refund with a prestamped envelope, refund once the cards are back. If the panel gave refund numbers already, include them now. Stage 2 (numbers given): one line per card in Derek's shape ("X - charged $A, at DMG it goes for $B, so I'd refund $C"), the total, ask if that works, keep the return path on the table. Stage 3 (buyer chose): partial -> confirm the amount and that it goes through TCGplayer today; return -> the return address, keep the cards in the toploader and taped so they cannot slip out, one forever stamp usually works, or wait for the prestamped envelope; full refund on receipt. A replacement copy in the right condition can be offered only if the thread says Derek has one. Use only the refund numbers given; never invent a price. If no numbers were given and the stage needs them, write around "let me recomp these and come back with exact numbers".
MISSING PACKAGE. Reported early (before the wait-until date): sorry, ask them to check with household, roommates, neighbors, the mailroom or the post office (carriers sometimes scan early or leave it somewhere odd), name the wait-until date, promise the full refund then if it has not shown, and ask them to let you know either way; if it turns up after a refund, TCGplayer sorts the payment. Reported late (past the wait-until date) or no tracking and late: apologize and say the full refund is going out now, and to let you know if it turns up anyway. Tracking says delivered: ask them to check the same places and with the carrier, and say you are opening it with TCGplayer customer service, who will follow up with them.
WRONG CARD. Own the mistake plainly, light ask for a picture if there is none, then the three options: keep it and Derek refunds the difference in value (never ask for money if the wrong card is worth more), return it in a prestamped envelope and get the right card if Derek still has it, or return it for a full refund. Once they pick, follow through: address / envelope / refund timing.
MISSING CARD (a card left out of the package). Sorry, say you are checking stock: if it is still here it ships right away at no cost; if not, that card is refunded in full. Ask nothing of the buyer.
OTHER. Cancel after it shipped: no longer possible to stop it; write "refused" or "return to sender" on the unopened package and leave it for the carrier, full refund once it is back. Package damaged in transit: refund with the return, or refund the damaged cards if it was opened. Suspected counterfeit: Derek loops in TCGplayer customer service, they send a prepaid label and handle the refund. Changed their mind / price moved / wrong address given at checkout: kind, plain, and no refund is possible there. Anything else: answer what they asked in one message.
Output only the message text.`;
async function fbIssueDraft(q) {
  const key = await fbKey();
  if (!key) return { ok: false, why: "no key", nokey: true };
  const lines = ["Issue type: " + (q.kind || "other"), "Subject: " + ((q.thread || {}).subject || "")];
  const o = q.order || {};
  if (o.items && o.items.length) lines.push("Order " + (o.order || "") + (o.orderDate ? " placed " + o.orderDate : "") + ", cards: " + o.items.map((it) => `${it.name} (${it.printing}, sold as ${it.soldAs}, charged $${it.charged != null ? it.charged.toFixed(2) : "?"}${it.qty > 1 ? " x" + it.qty : ""})`).join("; "));
  if (o.history) lines.push("Buyer history: " + o.history + " (a repeat buyer: a little extra warmth is right, no discounts)");
  const p = q.picks || {};
  if (p.cards && p.cards.length) lines.push("Refund numbers (use these exactly): " + p.cards.map((c) => `${c.name}: charged $${(c.charged || 0).toFixed(2)}, at ${c.arrived} it goes for $${c.value != null ? c.value.toFixed(2) : "?"} (${c.valueSrc || ""}), refund $${c.refund != null ? c.refund : "?"}`).join("; ") + (p.extra ? `; extra for the trouble $${p.extra}` : "") + `; total refund $${p.total}`);
  else if (q.kind === "condition") lines.push("No refund numbers yet (no card picked in the panel).");
  const f = q.facts || {};
  if (q.kind === "missing") lines.push(`Shipping: ${f.method || "?"}, shipped ${f.shippedAt || "?"}, estimated delivery ${f.edd || "?"}, ${f.tracking ? "tracking " + f.tracking : "no tracking"}; wait-until date (estimated delivery + 2 business days) ${f.waitUntil || "?"}${f.late ? "; that date has passed: refund now" : "; not yet passed: may ask them to wait"}${f.reportedLate ? "; the buyer reported it more than 2 business days after the estimated delivery: refund now" : ""}.`);
  lines.push("Return address" + (q.address ? ": " + q.address : ": not on file, do not invent one; say you will send it"));
  lines.push("Thread, oldest first (Me = Derek):");
  ((q.thread || {}).msgs || []).forEach((m) => lines.push(`[${m.when}] ${m.me ? "Me" : m.from || "Buyer"}: ${String(m.text || "").slice(0, 1200)}`));
  lines.push("Write Derek's next message.");
  let r;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-beta": "server-side-fallback-2026-07-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({ model: FB_MODEL, max_tokens: 900, fallbacks: "default", output_config: { effort: "medium" }, system: FB_ISSUE_SYSTEM, messages: [{ role: "user", content: lines.join("\n") }] }) });
  } catch (e) { return { ok: false, why: "network: " + e.message }; }
  if (!r.ok) return { ok: false, why: fbErr(r.status, await r.text()) };
  const j = await r.json();
  if (j.stop_reason === "refusal") return { ok: false, why: "the model declined this one, write it by hand" };
  const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!text) return { ok: false, why: "empty reply" };
  const u = j.usage || {};
  return { ok: true, text, cost: ((u.input_tokens || 0) * 4 + (u.output_tokens || 0) * 20) / 1e6 };
}

// Buyer history (Derek, 2026-11-09: repeat customers). fbBuyers: key (name lowercased, spaces collapsed) -> {name,
// orders: {orderId: {at, total}}}. Fed by the Options page CSV import (TCGplayer's Order List export: Order #, Buyer
// Name, Order Date "Monday, 09 November 2026", Total Amt) and by every Orders list page / order page seen. Idempotent
// on order id. Stats: n, first, last, spent, before (orders on or before a date).
const fbBuyerKey = (name) => String(name || "").toLowerCase().replace(/\s+/g, " ").trim();
const fbBuyersGet = () => new Promise((res) => chrome.storage.local.get("fbBuyers", (r) => res((r && r.fbBuyers) || {})));
async function fbBuyersMerge(orders) {
  const m = await fbBuyersGet(); let added = 0;
  (orders || []).forEach((o) => {
    const k = fbBuyerKey(o.buyer), id = String(o.order || "").trim(); if (!k || !id) return;
    const b = (m[k] = m[k] || { name: String(o.buyer).trim(), orders: {} });
    if (!b.orders[id]) added++;
    const prev = b.orders[id] || {};
    b.orders[id] = { at: o.at || prev.at || 0, total: o.total != null ? o.total : (prev.total != null ? prev.total : null) };
    if (/[a-z]/.test(String(o.buyer)) && /[A-Z]/.test(String(o.buyer))) b.name = String(o.buyer).trim();   // prefer a mixed-case spelling
  });
  await new Promise((res) => chrome.storage.local.set({ fbBuyers: m }, res));
  return { added, buyers: Object.keys(m).length, orders: Object.values(m).reduce((s, b) => s + Object.keys(b.orders).length, 0) };
}
function fbBuyerStats(m, name, at) {
  const b = m[fbBuyerKey(name)]; if (!b) return null;
  const os = Object.values(b.orders); if (!os.length) return null;
  const ats = os.map((o) => o.at || 0).filter(Boolean);
  const endOfDay = (t) => { const d = new Date(t); d.setHours(23, 59, 59, 999); return d.getTime(); };
  return { n: os.length, first: ats.length ? Math.min(...ats) : 0, last: ats.length ? Math.max(...ats) : 0, spent: os.reduce((s, o) => s + (o.total || 0), 0),
    before: at ? os.filter((o) => !o.at || o.at <= endOfDay(at)).length : os.length, name: b.name };
}
// TCGplayer's Order List CSV (Options page import). Quoted fields, commas inside quotes, CRLF.
function fbParseCSV(text) {
  const rows = [], s = String(text || "").replace(/^﻿/, ""); let i = 0, row = [], cell = "", q = false;
  while (i < s.length) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && s[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
    i++;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase()), col = (rx) => head.findIndex((h) => rx.test(h));
  const iO = col(/^order\s*#|order number/), iB = col(/buyer name/), iD = col(/order date/), iT = col(/total am/);
  if (iO < 0 || iB < 0) return [];
  return rows.slice(1).filter((r) => r[iO] && r[iB]).map((r) => ({ order: r[iO].trim(), buyer: r[iB].trim(), at: iD >= 0 ? (Date.parse(r[iD]) || 0) : 0, total: iT >= 0 ? (parseFloat(r[iT]) || 0) : null }));
}

// Icon badge: how many worded, named feedbacks of the last 14 days are not yet replied to or skipped. The panel reports
// its own count; between visits the worker reads page 1 of the Feedback tab with Derek's login once an hour (regex,
// since a service worker has no DOMParser). A login page (no feedback table) clears the badge.
const FB_DAYS_BG = 14;
function fbBadge(n) {
  if (!chrome.action) return;
  chrome.action.setBadgeText({ text: n > 0 ? String(n) : "" }).catch(() => {});
  if (n > 0) chrome.action.setBadgeBackgroundColor({ color: "#0d6efd" }).catch(() => {});
}
const fbStrip = (h) => String(h).replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
function fbParseHTML(html) {   // rows of a Feedback tab page: {order, date, rating, comment, user}
  const out = [], tb = /<table class="display dTable">([\s\S]*?)<\/table>/.exec(html);
  if (!tb) return null;
  const rows = tb[1].split(/<tr[^>]*>/).slice(1);
  for (const tr of rows) {
    const td = tr.split(/<td[^>]*>/).slice(1).map((c) => c.split("</td>")[0]);
    if (td.length < 6) continue;
    out.push({ order: fbStrip(td[1]), date: fbStrip(td[2]), rating: parseInt(fbStrip(td[3]), 10) || 0, comment: /<i>\s*No Comment Left/i.test(td[4]) ? "" : fbStrip(td[4]), user: fbStrip(td[5]) });
  }
  return out;
}
function fbPendingOf(rows, done) {
  const d0 = new Date(); d0.setHours(0, 0, 0, 0); const cut = d0.getTime() - FB_DAYS_BG * 864e5;
  const dateOf = (s) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s || ""); return m ? new Date(+m[3], +m[1] - 1, +m[2]).getTime() : 0; };
  const seen = new Set();
  return rows.filter((r) => r.comment && r.user && r.order && dateOf(r.date) >= cut && !done[r.order] && !seen.has(r.order) && seen.add(r.order)).length;
}
async function fbCheck() {
  let html;
  try { const r = await fetch("https://store.tcgplayer.com/admin/Seller/Feedback", { credentials: "include" }); if (!r.ok) return; html = await r.text(); } catch (_) { return; }
  const rows = fbParseHTML(html);
  if (!rows) { fbBadge(0); return; }   // signed out
  const done = await new Promise((res) => chrome.storage.local.get("fbDone", (x) => res((x && x.fbDone) || {})));
  fbBadge(fbPendingOf(rows, done));
}
if (chrome.alarms) {
  chrome.alarms.get("fb-check", (a) => { if (!a) chrome.alarms.create("fb-check", { delayInMinutes: 1, periodInMinutes: 60 }); });
  chrome.alarms.onAlarm.addListener((a) => { if (a.name === "fb-check") fbCheck(); });
}
