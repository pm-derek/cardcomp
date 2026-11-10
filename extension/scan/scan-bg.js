// Scan & Identify check (Derek, 2026-11-10: "manually reviewing each scan image with the catalog image to make sure it's
// the right card"). The content script (scan/scan.js) sends the scan photo and the catalog photo of each identified
// scan; this compares them with the picture matcher (recog/imgmatch.js: 24 x 33 opponent-color cells, normalized
// correlation) and answers a likeness 0..1. Same card photographed twice lands high (holo / reverse of one art close to
// 1), a different card low. The photos are fetched here because a content script cannot read cross-origin pixels.
try { if (typeof IM === "undefined") importScripts("recog/imgmatch.js"); } catch (_) {}
const SCAN_CACHE = new Map();   // "scan|cat" -> {s} or {why}
async function scanTemplate(url) {
  const img = await IM.load(url, 320);
  return IM.normalize(IM.cardCells(img));
}
async function scanSim(scan, cat) {
  const k = scan + "|" + cat;
  if (SCAN_CACHE.has(k)) return SCAN_CACHE.get(k);
  let out;
  if (typeof IM === "undefined") out = { why: "picture matcher missing (recog/imgmatch.js)" };
  else {
    try { const [a, b] = await Promise.all([scanTemplate(scan), scanTemplate(cat)]); out = { s: Math.round(IM.sim(a, b) * 1000) / 1000 }; }
    catch (e) { const h = (u) => { try { return new URL(u).host; } catch (_) { return "?"; } }; out = { why: (e && e.message || "failed") + " (" + h(scan) + ", " + h(cat) + ")" }; }
  }
  if (SCAN_CACHE.size > 600) SCAN_CACHE.delete(SCAN_CACHE.keys().next().value);
  SCAN_CACHE.set(k, out);
  return out;
}
function scanHandle(msg, sender, reply) {
  if (!msg || msg.type !== "cardcomp-scan-sim") return false;
  scanSim(String(msg.scan || ""), String(msg.cat || "")).then((r) => reply(Object.assign({ ok: r.s != null }, r)), (e) => reply({ ok: false, why: e.message }));
  return true;
}
