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
