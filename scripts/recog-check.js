#!/usr/bin/env node
// Checks for the auto-recognition experiment. No API key needed. Exits 1 on any failure.
//   node scripts/recog-check.js
// 1. fixtures:   autoMatch on the 20 confirmed frames as read by Opus / Haiku / Sonnet (docs/recog-reads).
//                Hard rule: a strong suggestion is never the wrong card.
// 2. regression: manual search gives identical results with and without recog/automatch.js loaded.
// 3. strip:      in a temp copy, scripts/strip-recog.js restores index.html, bg.js, options.html and the
//                manifest to the base branch, and the stripped app still boots and searches.
// 4. capture:    the extension's capture code against a mock Whatnot page with a live <video>: video copy,
//                screenshot fallback when the canvas is blocked, no video, the 5 s automatic retry, the results page.
// Needs playwright (preinstalled in the cloud session; locally: npm i playwright && npx playwright install chromium).
const fs = require("fs"), path = require("path"), http = require("http"), os = require("os"), { execSync } = require("child_process");
let chromium; try { ({ chromium } = require("playwright")); } catch (_) { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
const ROOT = path.resolve(__dirname, "..");
const OUT = process.env.RECOG_OUT || os.tmpdir();
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? "  ok   " : "  FAIL ") + msg); if (!cond) fails++; };

function serve(dir, extra) {
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    if (extra && extra[u]) { res.writeHead(200, { "content-type": "text/html" }); return res.end(extra[u]); }
    const p = path.join(dir, u.replace(/^\/+/, "") || "index.html");
    if (!p.startsWith(dir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    const ct = p.endsWith(".json") ? "application/json" : p.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8";
    res.writeHead(200, { "content-type": ct }); fs.createReadStream(p).pipe(res);
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, base: "http://127.0.0.1:" + srv.address().port })));
}
async function appPage(browser, base, blockRecog) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  if (blockRecog) await page.route(/recog\/automatch\.js/, (r) => r.abort());
  await page.goto(base + "/index.html");
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
  page.errors = errors;
  return page;
}

(async () => {
  const browser = await chromium.launch();
  const { srv, base } = await serve(ROOT, { "/__mock": fs.readFileSync(path.join(__dirname, "recog-mock.html"), "utf8") });

  // ---------- 1. fixtures ----------
  console.log("1. fixtures: autoMatch on 20 confirmed frames");
  const truth = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/recog-reads/truth.json"), "utf8"));
  const app = await appPage(browser, base, false);
  const summary = [];
  const byModel = {};
  for (const model of ["opus", "haiku", "sonnet"]) {
    const reads = fs.readFileSync(path.join(ROOT, "docs/recog-reads", model + ".jsonl"), "utf8").split("\n").filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l));
    const res = await app.evaluate((reads) => reads.map((r) => { const m = autoMatch(r); return { shot: r.shot, kind: m.kind, strength: m.strength, suggestion: m.suggestion, top: m.cards.slice(0, 5).map((c) => c.id), note: m.note }; }), reads);
    const s = { strongRight: 0, strongWrong: 0, weakRight: 0, weakWrong: 0, pickInTop5: 0, pickMissing: 0, notInCatalogQuiet: 0, notInCatalogSuggested: 0 };
    const rows = [];
    for (const r of res) {
      const t = truth[r.shot]; if (!t) continue;
      const right = (id) => t.ids.includes(id);
      let v;
      if (!t.ids.length) { if (r.suggestion) { s.notInCatalogSuggested++; v = "suggested a card, real one not in catalog"; } else { s.notInCatalogQuiet++; v = "ok: no suggestion"; } }
      else if (r.suggestion) { const k = r.strength === "strong" ? "strong" : "weak"; if (right(r.suggestion)) { s[k + "Right"]++; v = k + " right"; } else { s[k + "Wrong"]++; v = k + " WRONG"; } }
      else if (r.top.some(right)) { s.pickInTop5++; v = "no suggestion, right card in top 5"; }
      else { s.pickMissing++; v = "no suggestion, right card not in top 5"; }
      rows.push(`    ${String(r.shot).padStart(2)} ${r.kind.padEnd(11)} ${(r.strength || "-").padEnd(6)} ${r.suggestion || "-"}  ${v}`);
    }
    byModel[model] = res;
    console.log(`  ${model}`); console.log(rows.join("\n"));
    summary.push({ model, ...s });
    ok(s.strongWrong === 0, `${model}: no strong suggestion is the wrong card (${s.strongRight} strong, all right)`);
  }
  console.table(summary);
  const op = Object.fromEntries(byModel.opus.map((r) => [r.shot, r]));
  ok(op[1].kind === "ambiguous" && op[1].top.slice(0, 2).every((id) => truth[1].ids.includes(id)), "Ursaring 061/070 JP: its 2 printings (regular, Mirror Holofoil) listed first");
  ok(byModel.haiku.find((r) => r.shot === 1).strength !== "strong", "Haiku's invented 063/090 is not a strong suggestion (set total does not fit)");
  ok(op[2].kind === "ambiguous" && op[2].top.slice(0, 3).every((id) => truth[2].ids.includes(id)), "Time-Space Distortion 012/012: the 3 Collection Packs listed first, no pick");
  ok(op[7].kind === "number-miss" && !op[7].suggestion && !op[7].top.some((id) => /mewtwo/i.test(id)), "Kyurem ex 157 (not in catalog): no suggestion, no Mewtwo ex #157");
  ok(op[8].kind === "near" && op[8].suggestion === "swsh9-162", "Honchkrow V read 161: weak suggestion #162");
  ok(!op[9].suggestion && !op[9].top.some((id) => /sinistcha/i.test(id)), "Cetitan ex 210 (not in catalog): no suggestion, no Sinistcha");
  ok(op[19].suggestion !== "sv10-232", "Garchomp read as full art: never the $185 SIR");
  ok(op[15].suggestion === "me2pt5-223" && op[16].suggestion === "me4-89", "IR reads with no number pick the one IR printing (Numel, Frogadier)");
  ok(byModel.sonnet.find((r) => r.shot === 19).suggestion !== "sv10-232", "Sonnet's SIR read on the Garchomp UR: no $185 SIR suggestion (price-spread guard)");
  ok(app.errors.length === 0, "no page errors (" + (app.errors[0] || "") + ")");

  // ---------- 2. regression ----------
  console.log("2. regression: manual search unchanged");
  const without = await appPage(browser, base, true);
  ok(await without.evaluate(() => typeof window.autoMatch === "undefined"), "blocked copy really has no autoMatch");
  const corpus = await app.evaluate(() => {
    const qs = ["charizard", "charizard 4/102", "mew", "mew ex", "pikachu", "zek", "goldengo", "sv promo", "1st shadowless charizard", "25th", "30th", "ereader", "sir pikachu", "dr", "base 2", "rocket's zapdos", "misty's poliwrath", "lightning energy", "maushold ex 233/182", "shining", "umbreon vmax", "giratina v alt art", "fire", "gx", "lugia 9/111"];
    const pk = CARDS.filter((c) => (c.game || "pkmn") === "pkmn" && !c.sealed);
    for (let i = 0; i < pk.length; i += 130) qs.push((pk[i].lang === "jp" ? "jp|" : "") + pk[i].n.toLowerCase());
    return qs;
  });
  const snap = (page) => page.evaluate((qs) => qs.map((q) => {
    const jp = q.startsWith("jp|"); setGame("pkmn"); setLang(jp ? "jp" : "en", true); run(jp ? q.slice(3) : q);
    return q + " => " + document.querySelector("#status").textContent + " :: " + [...document.querySelectorAll("#results .card")].map((e) => e.dataset.id).join(",");
  }), corpus);
  const a = await snap(app), b = await snap(without);
  const diff = a.filter((x, i) => x !== b[i]);
  ok(diff.length === 0, `${corpus.length} searches identical with and without the experiment` + (diff[0] ? " (first diff: " + diff[0].slice(0, 120) + ")" : ""));
  await without.close(); await app.close();

  // ---------- 3. strip ----------
  console.log("3. strip: removes cleanly and the app still works");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recog-strip-"));
  fs.cpSync(ROOT, tmp, { recursive: true, filter: (s) => !/[\\/](\.git|node_modules)$/.test(s) && !/[\\/](data|prices)\.json$/.test(s) });
  fs.symlinkSync(path.join(ROOT, "data.json"), path.join(tmp, "data.json"));
  execSync("node scripts/strip-recog.js", { cwd: tmp, stdio: "pipe" });
  let baseRef = process.env.RECOG_BASE || "";
  if (!baseRef) { try { execSync("git fetch -q origin main", { cwd: ROOT, stdio: "pipe" }); } catch (_) {} try { baseRef = execSync("git merge-base HEAD origin/main", { cwd: ROOT }).toString().trim(); } catch (_) {} }
  if (baseRef) {
    for (const f of ["index.html", "extension/bg.js", "extension/options.html", "extension/README.md", "CLAUDE.md"]) {
      const orig = execSync(`git show ${baseRef}:${f}`, { cwd: ROOT, maxBuffer: 64e6 }).toString();
      ok(fs.readFileSync(path.join(tmp, f), "utf8") === orig, `${f} identical to the base branch after strip`);
    }
    const om = JSON.parse(execSync(`git show ${baseRef}:extension/manifest.json`, { cwd: ROOT }).toString());
    const sm = JSON.parse(fs.readFileSync(path.join(tmp, "extension/manifest.json"), "utf8"));
    delete om.version; delete sm.version;
    ok(JSON.stringify(om) === JSON.stringify(sm), "manifest identical to the base branch after strip (version aside)");
  } else ok(false, "no origin/main to compare against");
  ok(!fs.existsSync(path.join(tmp, "recog")) && !fs.existsSync(path.join(tmp, "extension/recog")), "recog folders gone");
  for (const f of fs.readdirSync(path.join(tmp, "extension")).filter((f) => f.endsWith(".js"))) {
    try { execSync(`node --check extension/${f}`, { cwd: tmp, stdio: "pipe" }); } catch (e) { ok(false, "extension/" + f + " syntax after strip"); }
  }
  const s2 = await serve(tmp);
  const stripped = await appPage(browser, s2.base, false);
  const n = await stripped.evaluate(() => { setGame("pkmn"); setLang("en", true); run("charizard"); return document.querySelectorAll("#results .card").length; });
  ok(n > 0 && stripped.errors.length === 0 && await stripped.evaluate(() => typeof window.autoMatch === "undefined"), `stripped app boots and searches (charizard: ${n} cards, no errors)`);
  await stripped.close(); s2.srv.close(); fs.rmSync(tmp, { recursive: true, force: true });

  // ---------- 4. capture ----------
  console.log("4. capture: extension code against a mock Whatnot page");
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const scenario = async (mode) => {
    const page = await ctx.newPage();
    const errs = []; page.on("pageerror", (e) => errs.push(e.message));
    await page.goto(base + "/__mock?mode=" + mode);
    await page.waitForFunction(() => window.__mockReady === true);
    await page.addScriptTag({ path: path.join(ROOT, "extension/recog/recog-whatnot.js") });
    await page.addScriptTag({ path: path.join(ROOT, "extension/recog/recog-bg.js") });
    const shot = "data:image/jpeg;base64," + (await page.screenshot({ type: "jpeg", quality: 90 })).toString("base64");
    await page.evaluate((shot) => { window.__shot = shot; }, shot);
    await page.evaluate(() => recogGrab({ id: 1, windowId: 1, url: location.href }));
    await page.waitForTimeout(6500);
    const recs = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open("cardcomp-recog", 1); r.onsuccess = () => { const q = r.result.transaction("frames").objectStore("frames").getAll(); q.onsuccess = () => res(q.result); }; }));
    const toasts = await page.evaluate(() => window.__sent.map((m) => m.type));
    await page.close();
    return { rec: recs[recs.length - 1], toasts, errs };
  };
  const v = await scenario("video");
  ok(v.rec && v.rec.ok && v.rec.method === "video" && v.rec.w === 1000 && v.rec.luma > 12, `video copy: ${v.rec && v.rec.method} ${v.rec && v.rec.w}x${v.rec && v.rec.h}, ${v.rec && v.rec.kb} KB, brightness ${v.rec && v.rec.luma}`);
  ok(v.rec && /^ok \(video\)/.test(v.rec.later), "video copy: automatic retry 5 s later works (" + (v.rec && v.rec.later) + ")");
  ok(v.toasts.includes("recog-grab-result") && v.toasts.includes("recog-later-result") && !v.errs.length, "video copy: both results reach the page, no errors");
  const t = await scenario("tainted");
  ok(t.rec && t.rec.ok && t.rec.method === "screenshot" && /canvas blocked/.test(t.rec.tries.join()), `blocked canvas: falls back to screenshot (${t.rec && t.rec.w}x${t.rec && t.rec.h}, ${t.rec && t.rec.tries})`);
  ok(t.rec && Math.abs(t.rec.w / t.rec.h - 540 / 760) < 0.02, "blocked canvas: screenshot cropped to the video box (aspect " + (t.rec && (t.rec.w / t.rec.h).toFixed(3)) + ")");
  const nv = await scenario("novideo");
  ok(nv.rec && !nv.rec.ok && /no <video>/.test(nv.rec.tries.join()), "no video: reported as failed with the reason (" + (nv.rec && nv.rec.tries.join("; ")) + ")");
  const dbg = await ctx.newPage();
  await dbg.goto(base + "/extension/recog/debug.html");
  await dbg.waitForTimeout(800);
  const sumText = await dbg.textContent("#sum");
  ok(/3 grabs · 2 worked \(video copy 1, screenshot 1\)/.test(sumText), "results page summary: " + sumText);
  await dbg.screenshot({ path: path.join(OUT, "recog-debug-page.png"), fullPage: true });
  console.log("  results page screenshot: " + path.join(OUT, "recog-debug-page.png"));
  await ctx.close();

  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
