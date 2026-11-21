// node scripts/pricing-check.js (2026-11-21): CardComp's port vs the Pull Sheet engine, spec cases, channel nets, CSV reader
const fs = require("fs"), vm = require("vm");
const path = require("path"), ROOT = path.join(__dirname, ".."), UP = path.join(ROOT, "docs/pricing") + "/";
const eng = require(UP + "engine.js"), SNAP = JSON.parse(fs.readFileSync(UP + "pricing-settings.snapshot.json", "utf8"));
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const a = html.indexOf("/* ---- List price and channel"), b = html.indexOf("function saleLine(");
const ctx = { console, chan: "low", localStorage: { getItem: () => null, setItem() {} }, fetch: async () => ({ ok: false }) };
vm.createContext(ctx);
vm.runInContext(`const getStr=()=>chan; function paintPricingSrc(){}
  function netProceeds(s){ return s*0.86575; } function buildSealedFeeTiers(){ return [{lo:0,hi:Infinity,A:0.86575,B:10.55}]; }
  ${html.slice(a, b)}; this.API={sheetList, saleOf, netRegular, netDirect, eraOf, pricingFromCSV, pricingOK, pricingUse, get P(){ return PRICING; }};`, ctx);
const A = ctx.API; let bad = 0; const ok = (c, m) => { if (!c) bad++; console.log((c ? "  ok   " : "  FAIL ") + m); };
// 1. parity with engine.js (copies 1, no cheapest, no Direct Low, no markdown)
const condW = { NM: "Near Mint", LP: "Lightly Played", MP: "Moderately Played", HP: "Heavily Played", DMG: "Damaged" };
const eraY = { WOTC: 2000, EX: 2005, DP: 2008, HGSS: 2010, BW: 2012, XY: 2015, SM: 2018, SWSH: 2021, SV: 2024, ME: 2026 };
let n = 0, diff = [];
for (const m of [0.2, 0.4, 0.41, 0.9, 1, 1.5, 1.8, 2, 2.49, 2.5, 3, 3.7, 4, 4.5, 5, 7, 9.99, 12, 20, 24.99, 38, 42, 43.4, 60, 99, 100, 140, 250, 700, 1500])
  for (const cond of Object.keys(condW)) for (const era of Object.keys(eraY)) {
    const want = eng.listPrice({ market: m, cond: condW[cond], lang: "EN", era, copies: 1 }, SNAP).price;
    const got = A.sheetList(m, { cond, y: eraY[era], s: "x", lang: "en", game: "pkmn" }); n++;
    if (Math.abs(want - got) > 0.001) diff.push(`${m} ${cond} ${era}: engine ${want} ours ${got}`);
  }
ok(!diff.length, `list price matches engine.js on ${n} cases` + (diff.length ? ": " + diff.slice(0, 5).join("; ") : ""));
// 2. spec test cases that do not need Direct / cheapest / copies
const L = (m, cond, y) => A.sheetList(m, { cond, y, s: "x", lang: "en", game: "pkmn" });
const cases = [[0.35, "NM", 2024, 0.5], [1.8, "NM", 2024, 2.34], [4, "NM", 2024, 4.99], [20, "NM", 2000, 27.5], [20, "MP", 2000, 20.6], [42, "NM", 2024, 49.99]];
for (const [m, c, y, w] of cases) ok(L(m, c, y) === w, `$${m} ${c} ${y}: lists $${L(m, c, y)} (spec $${w})`);
// 3. nets by channel (spec section 3 table)
for (const [s, r, d] of [[2.99, 2.77, 1.38], [3.99, 3.64, 2.26], [4.99, 4.5, 3.15]])
  ok(Math.abs(A.netRegular(s) - r) <= 0.011 && Math.abs(A.netDirect(s) - d) <= 0.011, `$${s}: regular $${A.netRegular(s).toFixed(2)} (spec ${r}), Direct $${A.netDirect(s).toFixed(2)} (spec ${d})`);
const s8 = 7.99, s20 = 20; console.log(`     $7.99: regular $${A.netRegular(s8).toFixed(2)}, Direct $${A.netDirect(s8).toFixed(2)} · $20: regular $${A.netRegular(s20).toFixed(2)} Direct $${A.netDirect(s20).toFixed(2)} · $60: regular $${A.netRegular(60).toFixed(2)} Direct $${A.netDirect(60).toFixed(2)}`);
// 4. channel rules
const so = (m, c, extra) => A.saleOf(m, Object.assign({ cond: c, y: 2024, s: "x", lang: "en", game: "pkmn" }, extra || {}));
ok(so(4, "NM").ch === "Direct" && so(4, "MP").ch === "regular" && so(4, "NM", { lang: "jp" }).ch === "regular" && so(1.5, "NM").ch === "regular" && so(4, "NM", { zh: true }).ch === "regular" && so(4, "sealed", { sealed: true }).ch === "regular",
  "Direct only for NM / LP English Pokemon singles listed $2.50+ (MP, JP, under $2.50, Chinese copies, sealed: regular)");
ctx.chan = "mix"; const mx = so(4, "NM"); ok(mx.ch === "mix" && Math.abs(mx.net - (mx.dir * 2 / 3 + mx.reg / 3)) < 1e-9, "mix setting: 2/3 Direct + 1/3 regular");
ctx.chan = "reg"; ok(so(4, "NM").net === so(4, "NM").reg, "regular-only setting"); ctx.chan = "low";
// 5. era by year + set name at boundary years
const E = (y, s) => A.eraOf({ y, s, lang: "en", game: "pkmn" });
ok(E(2003, "Skyridge") === "WOTC" && E(2003, "Ruby & Sapphire") === "EX" && E(2003, "EX Dragon") === "EX" && E(2007, "Power Keepers") === "EX" && E(2007, "Diamond & Pearl") === "DP" &&
   E(2011, "Call of Legends") === "HGSS" && E(2011, "Black & White") === "BW" && E(2025, "Black Bolt") === "SV" && E(2025, "Phantasmal Flames") === "ME" && E(2025, "Mega Evolution") === "ME" &&
   A.eraOf({ y: 1999, lang: "jp" }) === "other" && A.eraOf({ y: 1999, game: "lorcana" }) === "other", "era: boundary years by set name; Japanese and other games 'other'");
// 6. the CSV reader on a CSV in the spec's shape, built from the snapshot
const esc = (v) => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
const rows = [["group", "key", "value", "what it is"], ["meta", "format", "cardcomp-pricing-1", "format, don't change"], ["meta", "built", "2026-11-20 17:50", "when the tab was built, \"live\""]];
for (const [k, v] of Object.entries(SNAP.setting)) rows.push(["setting", k, v === false ? "FALSE" : v === true ? "TRUE" : v, "a setting, with, commas"]);
for (const t of ["markup", "nd_markup", "copies", "floor_copies"]) { for (const [k, v] of SNAP[t]) rows.push([t, k, v, ""]); rows.push([t, "", "", "unused row"]); }
for (const [k, v] of Object.entries(SNAP.era)) rows.push(["era", k, v, ""]);
for (const [L2, o] of Object.entries(SNAP.lang)) { rows.push(["lang_adjust", L2, o.adjust, ""]); rows.push(["lang_md_days", L2, o.md_days == null ? "" : o.md_days, "blank = no markdowns"]); rows.push(["lang_md_week", L2, o.md_week, ""]); rows.push(["lang_md_max", L2, o.md_max, ""]); }
const csv = rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
const S = A.pricingFromCSV(csv);
const same = JSON.stringify({ s: S.setting, m: S.markup, n: S.nd_markup, c: S.copies, f: S.floor_copies, e: S.era, l: S.lang }) === JSON.stringify({ s: SNAP.setting, m: SNAP.markup, n: SNAP.nd_markup, c: SNAP.copies, f: SNAP.floor_copies, e: SNAP.era, l: SNAP.lang });
ok(A.pricingOK(S) && same && S.built === "2026-11-20 17:50", "CSV reader: the spec's CSV shape reads back to the snapshot exactly (quoted commas, blank keys, blank md_days, TRUE/FALSE)");
ok(!A.pricingOK(Object.assign({}, S, { format: "x" })) && !A.pricingOK(Object.assign({}, S, { markup: [] })) && !A.pricingOK(Object.assign({}, S, { markup: [[1, 4]] })) && !A.pricingOK(Object.assign({}, S, { setting: Object.assign({}, S.setting, { dl_cap_x: 5 }) })),
  "a feed with the wrong format, no markup, a markup out of 0.5-3 or dl_cap_x out of 1-3 is refused");
ok(A.pricingUse(S, "test") && A.P.src === "test" && !A.pricingUse(Object.assign({}, S, { built: "2026-11-01" }), "older") && A.P.src === "test", "newest valid copy wins; an older one does not replace it");

console.log(bad ? bad + " FAILED" : "all ok");
