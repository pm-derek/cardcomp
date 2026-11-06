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
  const sys = FB_SYSTEM + (neg ? "\n" + FB_NEG : "") + (style === "shorter" ? "\nKeep it to one short sentence." : "") + ((row.orders || 1) > 1 ? "\nThis buyer has ordered " + row.orders + " times in the last two weeks: a repeat buyer, say so briefly." : "");
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
  if (msg.type === "cardcomp-fb-draft") { fbDraft(msg.row || {}, msg.style || "").then(reply, (e) => reply({ ok: false, why: e.message })); return true; }
  if (msg.type === "cardcomp-fb-order-info") {   // order.js, on load: {order, products, feedback, fbDate, buyer}
    const w = FB_WAIT[msg.order]; delete FB_WAIT[msg.order];
    (w || []).forEach((f) => f(msg));
    reply({ ok: true }); return true;
  }
  if (msg.type === "cardcomp-fb-pending") { fbBadge(msg.n); reply({ ok: true }); return true; }   // the panel's own count
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
