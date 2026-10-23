// The model call of the auto-recognition experiment, shared by the Chrome extension (imported by recog-bg.js) and the
// phone app (loaded by phone/bridge.js in the CardComp page): one frame in, a structured reading out. Nothing in here
// touches chrome.* or the DOM, so it runs in a service worker, a page and a WebView alike.
// RECOG experiment (docs/auto-recognition-handoff.md). Removed by scripts/strip-recog.js.
const RECOG_MODELS = { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" };
const RECOG_PRICE = { "claude-haiku-5-5": [0.10, 0.50], "claude-sonnet-5-5": [2, 10], "claude-opus-5-5": [4, 20] };   // $/MTok in, out (2026-10)
const RECOG_SYSTEM = "You identify Pokemon trading cards in frames of a Whatnot livestream. One card is shown to the camera, held in hand or in a sleeve or top-loader. Ignore cards on stands, in binders, in display cases or on the table behind it. Read only what is printed on the card held in front. Never guess a number you cannot read: return an empty string instead.";
const RECOG_ASK = `Return the card held in front:
- visible: false if no single card is being shown (seller's face, a pack, a stack, a blurred hand)
- name: the card name as printed, in English (for a Japanese card, the English name of that Pokemon or trainer card), with prefixes and suffixes such as Radiant, Shining, Mega, Team Rocket's, Cynthia's, ex, EX, GX, V, VMAX, VSTAR, LV.X, Prime
- lang: en, jp, zh (Chinese), ko (Korean) or other. Japanese text has kana (あ, ア); Chinese cards use only Chinese characters (Simplified 简体 or Traditional 繁體) with no kana; Korean uses Hangul (한)
- num: the collector number at the bottom (digits or code before the slash, e.g. 233, SV049, TG12), "" if unreadable
- total: the digits after the slash (e.g. 182), "" if none or unreadable
- rarity: the treatment you see, e.g. Illustration Rare (art past the frame, normal text box), Special Illustration Rare, Ultra Rare full art, Double Rare holo, Holo Rare, Reverse Holo, Common. Say "full art" when unsure which premium rarity it is
- stamp: look closely for a stamp, a small logo printed on the art or text box, often in a corner: a set logo on a stamped promo reprint (e.g. "Prismatic Evolutions", "Journey Together", "Mega Evolution"), a Pikachu anniversary logo (read whether it says 25th or 30th), Pokemon Center, Prerelease, Staff, 1st Edition, a Black Star promo mark. Sellers often circle a stamp or other detail with a marker: look inside any hand-drawn circle. Name what the stamp says; "" if there is none
- finish: where the foil shine is. holo = shiny artwork only; reverse holo = the card body around the art shines and the art is flat; poke ball pattern / master ball pattern = a reverse holo whose shiny body is covered in repeated Poke Ball icons / Master Ball icons (purple ball with an M); other pattern = any other repeated icon pattern (energy symbols, etc); non-holo = no shine anywhere; unknown when glare, the sleeve or the resolution hides it. Full art and illustration cards are holo
- set: the set if you can tell, else ""
- conf: 0 to 1 that the name is right
- box: where the card held in front is, as [left, top, right, bottom] in thousandths of the image width and height (0 to 1000); [] if no card`;
// Short keys in answer order: the reply streams, and name / lang / num / total come first so CardComp can fill the
// search before the rest is written (2026-10-20: ~70 output tokens, a third of them key names).
const RECOG_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["visible", "name", "lang", "num", "total", "rarity", "stamp", "finish", "set", "conf", "box"],
  properties: {
    visible: { type: "boolean" }, name: { type: "string" }, lang: { type: "string", enum: ["en", "jp", "zh", "ko", "other"] },
    num: { type: "string" }, total: { type: "string" }, rarity: { type: "string" }, stamp: { type: "string" },
    finish: { type: "string", enum: ["unknown", "non-holo", "holo", "reverse holo", "poke ball pattern", "master ball pattern", "other pattern"] },
    set: { type: "string" }, conf: { type: "number" }, box: { type: "array", items: { type: "integer" } }
  }
};
// short keys -> the names the rest of the experiment uses (older replies and the test mock may use the long ones)
function recogLong(o) {
  if (!o || typeof o !== "object") return o;
  const pick = (a, b) => (o[a] !== undefined ? o[a] : o[b]);
  return { card_visible: pick("visible", "card_visible"), name: o.name || "", number: pick("num", "number") || "", total: o.total || "", language: pick("lang", "language") || "",
    rarity: o.rarity || "", stamp: o.stamp || "", finish: o.finish || "", set: o.set || "", confidence: pick("conf", "confidence"), box: Array.isArray(o.box) ? o.box : [] };
}
// Name, language, number and total out of a reply still being written: enough to fill the search early.
function recogPartial(t) {
  if (/"visible"\s*:\s*false/.test(t)) return null;
  const g = (k) => { const m = new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"').exec(t); if (!m) return null; try { return JSON.parse('"' + m[1] + '"'); } catch (_) { return null; } };
  const name = g("name"), language = g("lang"), number = g("num"), total = g("total");
  if (!name || language == null || number == null || total == null) return null;
  return { card_visible: true, name, language, number, total, rarity: "", stamp: "", finish: "", set: "", confidence: null };
}
async function recogSSE(r, onText) {   // server-sent events -> { text, usage, stop, model, err }
  const rd = r.body.getReader(), dec = new TextDecoder(), u = {};
  let buf = "", text = "", stop = null, model = "", err = null;
  for (;;) {
    const { value, done } = await rd.read(); if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data:")); if (!line) continue;
      let ev; try { ev = JSON.parse(line.slice(5)); } catch (_) { continue; }
      if (ev.type === "message_start" && ev.message) { model = ev.message.model || ""; Object.assign(u, ev.message.usage || {}); }
      else if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") { text += ev.delta.text; try { onText(text); } catch (_) {} }
      else if (ev.type === "message_delta") { if (ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason; if (ev.usage) Object.assign(u, ev.usage); }
      else if (ev.type === "error") err = ev.error || { message: "stream error" };
    }
  }
  return { text, usage: u, stop, model, err };
}
function recogErr(status, txt) {
  if (status === 401) return "API key rejected (Options page)";
  if (status === 403) return "API key not allowed to use this model";
  if (status === 429) return "rate limited by the API";
  if (status === 529 || status >= 500) return "API busy (" + status + ")";
  if (status === 400 && /credit|balance/i.test(txt)) return "out of API credit";
  return "API error " + status + ": " + String(txt || "").slice(0, 120);
}
const RECOG_DROP = {};
async function recogRead(img, modelKey, apiKey, onPartial) {
  const model = RECOG_MODELS[modelKey] || RECOG_MODELS.haiku;
  const drop = RECOG_DROP[model] = RECOG_DROP[model] || {};   // options this model rejected once: never sent again
  let useFormat = !drop.format, useEffort = !drop.effort, netRetried = false;
  // Thinking off: Haiku takes "disabled", Sonnet 5.5 "between_tools"; Opus 5.5 cannot turn it off (low effort instead).
  let think = drop.thinking ? null : model === RECOG_MODELS.haiku ? { type: "disabled" } : model === RECOG_MODELS.sonnet ? { type: "between_tools" } : null;
  const data = String(img).replace(/^data:image\/\w+;base64,/, "");
  const t0 = Date.now();
  for (let attempt = 0; attempt < 5; attempt++) {
    const body = {
      model, max_tokens: 2000, system: RECOG_SYSTEM, stream: true,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
        { type: "text", text: RECOG_ASK + (useFormat ? "" : "\nAnswer with one JSON object only, with exactly those keys.") }
      ] }]
    };
    const oc = {};
    if (useEffort) oc.effort = "low";
    if (useFormat) oc.format = { type: "json_schema", schema: RECOG_SCHEMA };
    if (Object.keys(oc).length) body.output_config = oc;
    const headers = { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
    if (think) body.thinking = think;
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 25000);
    let r, txt = "", sse = null, sent = false;
    const early = (t) => { if (sent || !onPartial) return; const p = recogPartial(t); if (p) { sent = true; onPartial(p, Date.now() - t0); } };
    try {
      r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(body), signal: ctl.signal });
      if (r.ok && /event-stream/.test(r.headers.get("content-type") || "")) sse = await recogSSE(r, early); else txt = await r.text();
    }
    catch (e) {
      if (!(e && e.name === "AbortError") && !netRetried) { netRetried = true; await new Promise((s) => setTimeout(s, 600)); continue; }
      return { error: e && e.name === "AbortError" ? "timed out (25 s)" : "network: " + (e && e.message), ms: Date.now() - t0, model };
    }
    finally { clearTimeout(tm); }
    if (r.status === 400) {   // an option this model does not take: drop it and retry once each
      if (think && /thinking|between_tools|disabled/i.test(txt)) { think = null; drop.thinking = true; continue; }
      if (useEffort && /effort/i.test(txt)) { useEffort = false; drop.effort = true; continue; }
      if (useFormat && /output_config|format|schema/i.test(txt)) { useFormat = false; drop.format = true; continue; }
    }
    if ((r.status === 529 || r.status === 503) && attempt < 1) { await new Promise((s) => setTimeout(s, 800)); continue; }
    const ms = Date.now() - t0;
    if (!r.ok) return { error: recogErr(r.status, txt), status: r.status, ms, model };
    let j;
    if (sse) {
      if (sse.err) return { error: /overload/i.test(sse.err.type || sse.err.message || "") ? "API busy (529)" : "API error: " + String(sse.err.message || "stream").slice(0, 120), ms, model };
      j = { model: sse.model, usage: sse.usage, stop_reason: sse.stop, content: [{ type: "text", text: sse.text }] };
    } else { try { j = JSON.parse(txt); } catch (_) { return { error: "unreadable API reply", ms, model }; } }
    const u = j.usage || {}, p = RECOG_PRICE[j.model] || RECOG_PRICE[model] || [0, 0];
    const cost = ((u.input_tokens || 0) * p[0] + (u.output_tokens || 0) * p[1]) / 1e6;
    const base = { ms, model: j.model || model, inTok: u.input_tokens || 0, outTok: u.output_tokens || 0, cost, stop: j.stop_reason };
    if (j.stop_reason === "refusal") return Object.assign(base, { error: "the model declined this frame" });
    const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    let read = null;
    try { read = JSON.parse(text); } catch (_) { const m = text.match(/\{[\s\S]*\}/); if (m) { try { read = JSON.parse(m[0]); } catch (_) {} } }
    if (!read) return Object.assign(base, { error: j.stop_reason === "max_tokens" ? "reply cut off" : "no JSON in the reply", raw: text.slice(0, 200) });
    return Object.assign(base, { read: recogLong(read) });
  }
  return { error: "API options rejected", ms: Date.now() - t0, model };
}
