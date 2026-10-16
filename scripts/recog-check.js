#!/usr/bin/env node
// Checks for the auto-recognition experiment. No API key needed. Exits 1 on any failure.
//   node scripts/recog-check.js
// 1. fixtures:   autoMatch on the 20 confirmed frames as read by Opus / Haiku / Sonnet (docs/recog-reads).
//    1b: Derek's first live test, 23 lots: Haiku as streamed, Sonnet / Opus on the same frames.
//    1c: his second session, 33 lots, mostly Sonnet as streamed (stamped promos, anniversary reprints).
//                Hard rule: a strong suggestion is never the wrong card.
// 2. regression: manual search gives identical results with and without recog/automatch.js loaded.
// 3. strip:      in a temp copy, scripts/strip-recog.js restores every touched file to main as it was before the
//                experiment (apart from later unrelated changes), leaves nothing that mentions it, and the app still works.
// 4. capture:    the extension's capture code against a mock Whatnot page with a live <video>: video copy,
//                screenshot fallback when the canvas is blocked, no video, the 5 s automatic retry, the results page.
// 5. auto, extension side: lot timer -> frame -> API (mocked) -> CardComp message, second frame rules, errors, records;
//    reading a card held up before the timer, skipping a sold card still held, reusing the reading at timer start.
// 6. auto, CardComp side: the auto line, switch, filled results with the mark, typing respected, outcome reported.
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
    const res = await app.evaluate(({ reads, model }) => reads.map((r) => { const m = autoMatch(r, { model: "claude-" + model }); return { shot: r.shot, kind: m.kind, strength: m.strength, suggestion: m.suggestion, top: m.cards.slice(0, 5).map((c) => c.id), note: m.note }; }), { reads, model });
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
  const zh = await app.evaluate(() => autoMatch({ name: "Pikachu ex", number: "238", total: "191", language: "zh", rarity: "Special Illustration Rare" }));
  ok(zh.kind === "foreign" && !zh.suggestion && /Chinese/.test(zh.note) && zh.cards.length > 0, "Chinese reading: never matched as the English card (no suggestion, English listed for reference)");
  ok(app.errors.length === 0, "no page errors (" + (app.errors[0] || "") + ")");

  // ---------- 1b. Derek's first live test (2026-10-16): 23 lots, 3 sellers, Haiku live + Sonnet / Opus on the same frames
  console.log("1b. live lots: Haiku (as streamed), Sonnet and Opus (same frames)");
  const live = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/recog-reads/live-2026-10-16.json"), "utf8")).lots;
  const altReads = (m) => Object.fromEntries(fs.readFileSync(path.join(ROOT, "docs/recog-reads/live-" + m + ".jsonl"), "utf8").split("\n").filter((l) => l.trim().startsWith("{")).map((l) => { const j = JSON.parse(l); return [j.shot, j]; }));
  const liveRows = [];
  for (const model of ["haiku", "sonnet", "opus"]) {
    const alt = model === "haiku" ? null : altReads(model);
    const res = await app.evaluate(({ live, alt, model }) => {
      const RANK = { exact: 5, near: 4, unique: 3, ambiguous: 2, "number-miss": 1, none: 0 };
      return live.map((l) => {
        const short = l.frames[0] ? Math.min(...l.frames[0].split("x").map(Number)) : 0;
        const reads = alt ? (alt[l.shot] ? [alt[l.shot]] : []) : l.reads.filter((r) => r.name && r.card_visible !== false);
        let best = null;
        for (const r of reads) { const m = autoMatch(r, { short, model: "claude-" + model }); if (!best || (RANK[m.kind] || 0) >= (RANK[best.kind] || 0)) best = m; }
        return { shot: l.shot, truth: l.truth && l.truth.ids, sug: best && best.suggestion, strength: best && best.strength, ids: best ? best.cards.map((c) => c.id) : [] };
      });
    }, { live, alt, model });
    const t = res.filter((r) => r.truth);
    const row = { model, lots: t.length, strongRight: 0, strongWrong: 0, guessRight: 0, guessWrong: 0, listed: 0, notListed: 0 };
    for (const r of t) {
      if (r.sug) { const okk = r.truth.includes(r.sug); row[(r.strength === "strong" ? "strong" : "guess") + (okk ? "Right" : "Wrong")]++; }
      else if (r.ids.some((id) => r.truth.includes(id))) row.listed++; else row.notListed++;
    }
    liveRows.push(row);
    ok(row.strongWrong === 0, `${model}: no strong suggestion is the wrong card (${row.strongRight} strong)`);
    if (model !== "haiku") ok(row.guessWrong === 0 && row.notListed === 0, `${model}: no wrong guess, every right card listed (${row.strongRight + row.guessRight} of ${row.lots} picked right)`);
    else {
      ok(!res.some((r) => r.sug === "neo1-9"), "haiku: Lugia set guess 'Neo Genesis' never suggests the $1,300 Neo Genesis Lugia");
      ok(res.find((r) => r.shot === 4).sug === "tc:88750", "haiku: Rhyperior LV.X DP29 found (catalog spells it LVX)");
    }
  }
  console.table(liveRows);

  // ---------- 1c. second live session (lots 24-56), mostly Sonnet as streamed: stamped promos
  console.log("1c. second live session: stamped promos, anniversary reprints");
  const live2 = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/recog-reads/live-2026-10-16b.json"), "utf8")).lots;
  const sess2 = await app.evaluate((live2) => {
    const RANK = { exact: 5, near: 4, unique: 3, foreign: 2, ambiguous: 2, "number-miss": 1, none: 0 };
    return live2.map((l) => {
      const short = l.frames[0] ? Math.min(...l.frames[0].split("x").map(Number)) : 0;
      const reads = l.reads.filter((r) => r.name && r.card_visible !== false);
      let best = null;
      for (const r of reads) { const m = autoMatch(r, { short, model: r.model || "" }); if (!best || (RANK[m.kind] || 0) >= (RANK[best.kind] || 0)) best = m; }
      return { shot: l.shot, truth: l.truth && l.truth.ids, sug: best && best.suggestion, strength: best && best.strength, ids: best ? best.cards.map((c) => c.id) : [] };
    });
  }, live2);
  const t2 = sess2.filter((r) => r.truth), by2 = Object.fromEntries(sess2.map((r) => [r.shot, r]));
  const right2 = t2.filter((r) => r.sug && r.truth.includes(r.sug)).length, wrong2 = t2.filter((r) => r.sug && !r.truth.includes(r.sug)).length;
  ok(!t2.some((r) => r.strength === "strong" && !r.truth.includes(r.sug)), "session 2: no strong suggestion is the wrong card");
  ok(right2 >= 12 && wrong2 <= 1 && t2.every((r) => r.ids.some((id) => r.truth.includes(id))), `session 2: ${right2} of ${t2.length} picked right, ${wrong2} wrong (was 8 and 5), every right card listed`);
  ok(by2[37].sug === "tc:654703" && by2[53].sug === "tc:623594" && by2[56].sug === "tc:618107", "stamp names the stamped product (Bulbasaur Mega Evolution, N's Reshiram Journey Together, Leafeon Prismatic Evolutions)");
  ok(by2[34].sug === "me55c-106", "anniversary stamp read as 25th still finds the 30th Celebration Classic Collection Shining Celebi, not Neo Destiny");

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
  // Base = main just before the experiment was added. A stripped file must equal it, except for changes main made
  // later for other reasons (those lines must also be in the base..HEAD diff), and no leftover may mention recog.
  let baseRef = process.env.RECOG_BASE || "";
  if (!baseRef) { try { const add = execSync("git log --diff-filter=A --format=%H -- recog/automatch.js", { cwd: ROOT }).toString().trim().split("\n").pop(); if (add) baseRef = add + "^"; } catch (_) {} }
  const diffLines = (a, b) => { const r = (() => { try { return execSync(`git diff --no-index -U0 "${a}" "${b}"`, { cwd: ROOT, maxBuffer: 64e6 }).toString(); } catch (e) { return String(e.stdout || ""); } })();
    return r.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l)); };
  if (baseRef) {
    const files = ["index.html", "extension/bg.js", "extension/options.html", "extension/README.md", "CLAUDE.md", "extension/whatnot.js", "extension/panel.js", "extension/cardcomp.js"];
    for (const f of files) {
      const orig = path.join(tmp, "__base_" + f.replace(/\//g, "_"));
      fs.writeFileSync(orig, execSync(`git show ${baseRef}:${f}`, { cwd: ROOT, maxBuffer: 64e6 }));
      const left = diffLines(orig, path.join(tmp, f));
      const later = new Set(diffLines(orig, path.join(ROOT, f)));
      const bad = left.filter((l) => /recog|automatch|auto-ui|cardcomp-auto|__recog/i.test(l) || !later.has(l));
      ok(bad.length === 0, `${f}: ${left.length ? "matches the pre-experiment version apart from " + left.length + " line(s) main changed since" : "identical to the pre-experiment version"} after strip` + (bad[0] ? " (leftover: " + bad[0].slice(0, 100) + ")" : ""));
    }
    const om = JSON.parse(execSync(`git show ${baseRef}:extension/manifest.json`, { cwd: ROOT }).toString());
    const sm = JSON.parse(fs.readFileSync(path.join(tmp, "extension/manifest.json"), "utf8"));
    delete om.version; delete sm.version;
    ok(JSON.stringify(om) === JSON.stringify(sm), "manifest identical to the pre-experiment version after strip (version aside)");
  } else ok(false, "could not find the commit that added the experiment");
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
    const recs = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open("cardcomp-recog", 2); r.onsuccess = () => { const q = r.result.transaction("frames").objectStore("frames").getAll(); q.onsuccess = () => res(q.result); }; }));
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
  const sumText = await dbg.textContent("#fsum");
  ok(/3 grabs · 2 worked \(video copy 1, screenshot 1\)/.test(sumText), "results page, capture checks: " + sumText);
  await dbg.close();

  // ---------- 5. auto mode, extension side: lot timer -> frame -> API (mocked) -> CardComp message + lot record
  console.log("5. auto mode: lot start -> frame -> model (mocked API) -> CardComp, recorded per lot");
  let apiMode = "ok", apiCalls = [];
  const READS = { first: { card_visible: true, name: "Kyurem ex", number: "157", total: "086", language: "en", rarity: "Ultra Rare full art", set: "", confidence: 0.9 } };
  await ctx.route("https://api.anthropic.com/v1/messages", async (route) => {
    const req = route.request(), cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const body = JSON.parse(req.postData() || "{}"); apiCalls.push(body);
    if (apiMode === "nothink" && body.thinking) return route.fulfill({ status: 400, headers: cors, contentType: "application/json", body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "thinking.type: between_tools is not supported for this model" } }) });
    if (apiMode === "401") return route.fulfill({ status: 401, headers: cors, contentType: "application/json", body: JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }) });
    return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ model: body.model, stop_reason: "end_turn",
      usage: { input_tokens: 2900, output_tokens: 120 }, content: [{ type: "text", text: JSON.stringify(READS.first) }] }) });
  });
  const mp = await ctx.newPage();
  const merr = []; mp.on("pageerror", (e) => merr.push(e.message));
  await mp.goto(base + "/__mock?mode=video");
  await mp.waitForFunction(() => window.__mockReady === true);
  await mp.addScriptTag({ path: path.join(ROOT, "extension/recog/recog-whatnot.js") });
  await mp.addScriptTag({ path: path.join(ROOT, "extension/recog/recog-bg.js") });
  // a live lot: the timer counts down (whatnot.js calls __recogTick on every page change, so every second)
  const tick = (key) => mp.evaluate((key) => {
    clearInterval(window.__clock); const lot = { startedAt: key, title: "$1 START SINGLES #" + (key % 100), ended: false }; window.__lot = lot; let t = 30;
    const f = () => { if (lot.ended) return clearInterval(window.__clock); window.__recogTick({ timer: "00:" + String(t--).padStart(2, "0") }, lot); };
    f(); window.__clock = setInterval(f, 500);
  }, key);
  const sold = () => mp.evaluate(() => { clearInterval(window.__clock); window.__lot.ended = true; window.__recogTick({ timer: "", sold: "Sold", ended: true }, window.__lot); });
  const scene = (n) => mp.evaluate((n) => { window.__scene = n; }, n);
  const toApp = () => mp.evaluate(() => window.__runtime.filter((m) => m.type === "cardcomp-auto"));
  const lotRec = (key) => mp.evaluate((key) => new Promise((res) => { const r = indexedDB.open("cardcomp-recog", 2); r.onsuccess = () => { const q = r.result.transaction("lots").objectStore("lots").get(key); q.onsuccess = () => res(q.result); }; }), key);
  // off: nothing happens
  await tick(Date.now()); await mp.waitForTimeout(1500);
  ok((await toApp()).length === 0 && apiCalls.length === 0, "switch off: no frame, no API call");
  await mp.evaluate(() => chrome.storage.local.set({ recogOn: true, recogKey: "sk-ant-test", recogModel: "haiku" }));
  const k1 = Date.now(); await tick(k1); await mp.waitForTimeout(2200);
  let msgs = await toApp(), r1 = await lotRec(k1);
  ok(msgs.length === 1 && msgs[0].key === k1 && msgs[0].read && msgs[0].read.name === "Kyurem ex" && msgs[0].model === "claude-haiku-5-5", "lot start: one reading sent to CardComp (" + (msgs[0] && msgs[0].read && msgs[0].read.name) + ")");
  const c0 = apiCalls[0] || {};
  ok(c0.model === "claude-haiku-5-5" && c0.output_config && c0.output_config.format && c0.output_config.effort === "low" && c0.messages[0].content[0].type === "image", "API request: Haiku, image first, structured output, low effort");
  ok(c0.thinking && c0.thinking.type === "disabled" && !c0.fallbacks, "API request: Haiku thinking off, no fallback option (faster)");
  ok(/zh/.test(JSON.stringify(c0.output_config.format.schema.properties.language.enum)) && /stamp/.test(JSON.stringify(c0.output_config.format.schema.required)), "API request: asks for the stamp and allows Chinese / Korean");
  ok(r1 && r1.frames.length === 1 && r1.frames[0].w === 1280 && r1.frames[0].sinceStart >= 900 && r1.reads[0].cost > 0, `lot recorded: frame ${r1 && r1.frames[0].w}x${r1 && r1.frames[0].h} at ${r1 && r1.frames[0].sinceStart} ms, $${r1 && r1.reads[0].cost.toFixed(5)}`);
  await tick(k1); await mp.waitForTimeout(1500);
  ok(apiCalls.length === 1, "same lot ticking on: no second capture");
  // sold, seller keeps holding that card and talking: nothing new to read
  await sold(); await mp.waitForTimeout(3500);
  ok(apiCalls.length === 1, "sold, same card still held: no read");
  // a new card is held up before the timer: read it as soon as it holds still
  await scene(1); await mp.waitForTimeout(3600);
  msgs = await toApp();
  const pre = msgs.filter((m) => m.pre);
  ok(apiCalls.length === 2 && pre.length === 1, "new card held up before the timer: read once it holds still (" + pre.length + " pre-start read)");
  await mp.waitForTimeout(2200);
  ok(apiCalls.length === 2, "card keeps being held: no repeat reads");
  // timer starts on that same card: the pre-start reading is reused, no second call
  const k2 = Date.now(); await tick(k2); await mp.waitForTimeout(2200);
  const r2 = await lotRec(k2), adopt = await mp.evaluate(() => window.__runtime.find((m) => m.type === "cardcomp-auto-adopt"));
  ok(apiCalls.length === 2 && r2 && r2.adopted && r2.frames[0].trigger === "pre" && adopt && adopt.to === k2, "timer starts on that card: reading reused for the lot, no new call (" + (r2 && r2.adopted && (r2.adopted.earlyMs / 1000).toFixed(1)) + " s early)");
  ok(!(await lotRec(pre[0].key)), "pre-start record merged into the lot");
  // card swapped right as the timer starts (no time to hold still): read at the start, as before
  await sold(); await scene(2); const k3 = Date.now(); await tick(k3); await mp.waitForTimeout(5000);
  const r3 = await lotRec(k3);
  ok(r3 && r3.frames[0].trigger === "start" && r3.reads.length === 2 && apiCalls.length === 4, "new card right at the timer: read at start (" + (r3 && r3.reads.length) + " reads, 2nd because it read the same card as before)");
  // sold before the delay: no capture
  const k4 = Date.now(); await tick(k4); await mp.evaluate(() => { clearInterval(window.__clock); window.__lot.ended = true; }); await mp.waitForTimeout(1500);
  ok(apiCalls.length === 4, "lot sold within the first second: no API call");
  // API rejects the key: the error reaches CardComp, nothing breaks
  apiMode = "401"; const k5 = Date.now(); await tick(k5); await mp.waitForTimeout(2000);
  msgs = await toApp();
  ok(msgs.some((m) => m.key === k5 && /key rejected/.test(m.error)), "bad key: CardComp told 'API key rejected'");
  apiMode = "ok";
  // far camera: a small card swapped for another in the same spot (missed live by the old whole-frame check)
  await sold(); await scene(3); await mp.waitForTimeout(3600);
  let before = apiCalls.length;
  await scene(4); await mp.waitForTimeout(3600);
  const pre2 = (await toApp()).filter((m) => m.pre);
  ok(apiCalls.length === before + 1 && pre2.length >= 2, "far camera: a small card swapped in the same spot is seen as a new card and read");
  // Sonnet: thinking switched off with between_tools; an option the API rejects is dropped and never sent again
  await mp.evaluate(() => chrome.storage.local.set({ recogModel: "sonnet" }));
  apiMode = "nothink"; before = apiCalls.length;
  await scene(3); await mp.waitForTimeout(3600);
  const sc = apiCalls.slice(before);
  ok(sc.length === 2 && sc[0].model === "claude-sonnet-5-5" && sc[0].thinking && sc[0].thinking.type === "between_tools" && !sc[1].thinking, "Sonnet: thinking off (between_tools); rejected once, retried without");
  apiMode = "ok"; before = apiCalls.length;
  await scene(4); await mp.waitForTimeout(3600);
  ok(apiCalls.length === before + 1 && !apiCalls[apiCalls.length - 1].thinking, "a rejected option is not sent again (no extra round trip per read)");
  await mp.evaluate(() => chrome.storage.local.set({ recogModel: "haiku" }));
  // the next lot shows its timer before the auction starts (not counting): still "before the timer", so a new card is read
  await sold(); await mp.evaluate(() => { window.__lot = { startedAt: Date.now(), title: "$1 START SINGLES #77", ended: false }; window.__recogTick({ timer: "00:15" }, window.__lot); setTimeout(() => window.__recogTick({ timer: "00:15" }, window.__lot), 900); });
  before = apiCalls.length; await scene(1); await mp.waitForTimeout(3800);
  ok(apiCalls.length === before + 1, "timer shown but not counting: the card is read before the start");
  // "read now": reads right away, whatever the watcher thinks
  before = apiCalls.length;
  await mp.evaluate(() => window.__listeners.forEach((f) => f({ type: "recog-read-now" }, {}, () => {})));
  await mp.waitForTimeout(900);
  const man = (await toApp()).filter((m) => m.manual);
  ok(apiCalls.length === before + 1 && man.length === 1, "read now: one immediate read, marked manual");
  // the timer then starts on that same card: the read you asked for is the lot's reading, no automatic second read
  before = apiCalls.length; const k6 = Date.now() + 5; await tick(k6); await mp.waitForTimeout(2500);
  const r6 = await lotRec(k6);
  ok(apiCalls.length === before && r6 && r6.adopted && r6.frames[0].trigger === "manual", "read now, then the timer starts on that card: one reading for the lot, no automatic read");
  // read now while a lot is running: added to that lot, no separate entry, nothing automatic after it
  before = apiCalls.length;
  await mp.evaluate(() => window.__listeners.forEach((f) => f({ type: "recog-read-now" }, {}, () => {})));
  await mp.waitForTimeout(2500);
  const r6b = await lotRec(k6);
  ok(apiCalls.length === before + 1 && r6b.reads.length === 2 && r6b.frames.some((f) => f.trigger === "manual" && f.n === 9), "read now during a running lot: one more read on the same lot entry, nothing automatic after it");
  await sold();
  const watch = await mp.evaluate(() => window.__runtime.filter((m) => m.type === "cardcomp-auto-watch").map((m) => m.why));
  ok(watch.length > 0 && watch.some((w) => /same picture|same card|waiting|changing|just read/.test(w)), "watcher reports what it is doing (" + [...new Set(watch)].slice(0, 3).join(" / ") + ")");
  // CardComp reports its match and the lot outcome back
  await mp.evaluate((k) => { const send = (m) => window.__listeners.forEach((f) => f(m, {}, () => {}));
    send({ type: "cardcomp-auto-match", key: k, n: 1, kind: "number-miss", strength: null, suggestion: null, cards: [{ id: "sv10pt5-165", n: "Kyurem ex", s: "Black Bolt", num: "165", m: 68.9 }], note: "no #157", filled: true });
    send({ type: "cardcomp-auto-outcome", key: k, outcome: { card: { id: "sv10pt5-165", n: "Kyurem ex", s: "Black Bolt", num: "165", label: "view" }, final: 3, me: false } }); }, k1);
  await mp.waitForTimeout(400);
  r1 = await lotRec(k1);
  ok(r1.matches && r1.matches.length === 1 && r1.outcome && r1.outcome.card.id === "sv10pt5-165", "match and outcome saved on the lot");
  ok(merr.length === 0, "no page errors (" + (merr[0] || "") + ")");
  const dbg2 = await ctx.newPage();
  await dbg2.goto(base + "/extension/recog/debug.html"); await dbg2.waitForTimeout(900);
  const sum2 = await dbg2.textContent("#sum");
  ok(/\d+ lots read/.test(sum2) && /To review: \d+/.test(sum2) && /Read before the timer: \d+ lots \(\d+ reused/.test(sum2) && /Strong suggestion wrong: 0 of 0/.test(sum2) && /Spent \$/.test(sum2), "results page summary: " + sum2.replace(/\s+/g, " ").slice(0, 160));
  await dbg2.screenshot({ path: path.join(OUT, "recog-debug-page.png"), fullPage: true });
  console.log("  results page screenshot: " + path.join(OUT, "recog-debug-page.png"));
  await dbg2.close(); await mp.close();
  await ctx.close();

  // ---------- 6. auto mode, CardComp side: the auto line, filling the search, not overwriting Derek's typing
  console.log("6. auto mode in CardComp: line, switch, filled results, typing respected, outcome reported");
  const ap = await appPage(browser, base, false);
  await ap.setViewportSize({ width: 660, height: 900 });
  await ap.evaluate(() => { window.__posted = []; window.addEventListener("message", (e) => { if (e.data && /^cardcomp-auto-/.test(e.data.type) && e.data.type !== "cardcomp-auto-state") window.__posted.push(e.data); }); });
  const send = (m) => ap.evaluate((m) => window.postMessage(m, location.origin), m);
  const lotEnd = async () => { await send({ type: "cardcomp-lot-end", rec: { empty: true, at: Date.now() } }); await ap.waitForTimeout(80); };
  const posted = () => ap.evaluate(() => window.__posted);
  ok(await ap.evaluate(() => !document.querySelector("#autoline") || getComputedStyle(document.querySelector("#autoline")).display === "none"), "no extension: no auto line (phone / plain tab unchanged)");
  ok(await ap.evaluate(() => { const b = document.querySelector("#readbig"); return !b || getComputedStyle(b).display === "none"; }), "no extension: no read button, right-click stays normal");
  await send({ type: "cardcomp-ext-ready" }); await ap.waitForTimeout(200);
  ok((await posted()).some((m) => m.type === "cardcomp-auto-hello") && /auto off/.test(await ap.textContent("#autoline")), "extension present: line shows 'auto off' and asks for state");
  await send({ type: "cardcomp-auto-state", on: true, model: "haiku", hasKey: true }); await ap.waitForTimeout(100);
  ok(/auto on/.test(await ap.textContent("#autoline")) && await ap.$("#automodel"), "state on: switch and model picker");
  let key = Date.now();
  await send({ type: "cardcomp-auto", key, n: 1, read: { card_visible: true, name: "Fomantis", number: "085", total: "084", language: "en", rarity: "Illustration Rare", confidence: 0.9 }, model: "claude-haiku-5-5", ms: 1300 });
  await ap.waitForTimeout(300);
  let st = await ap.evaluate(() => ({ q: document.querySelector("#q").value, first: (document.querySelector("#results .card") || {}).dataset, badge: (document.querySelector("#results .card .autobadge") || {}).textContent, line: document.querySelector("#autoline").textContent }));
  ok(st.q === "Fomantis 085/084" && st.first && st.first.id === "me5-85" && /auto/.test(st.badge || "") && /Fomantis/.test(st.line), `exact read: search filled, Fomantis #85 first with the gold mark ("${st.badge}")`);
  let mp1 = (await posted()).filter((m) => m.type === "cardcomp-auto-match").pop();
  ok(mp1 && mp1.kind === "exact" && mp1.strength === "strong" && mp1.filled === true, "match reported to the extension (exact, strong, shown)");
  await ap.screenshot({ path: path.join(OUT, "recog-app-auto.png") });
  // Derek types after the lot starts: the reading must not replace his search
  key = Date.now(); await ap.fill("#q", "charizard"); await ap.waitForTimeout(400);
  await send({ type: "cardcomp-auto", key: key - 1, n: 1, read: { card_visible: true, name: "Honchkrow V", number: "161", total: "172", language: "en", rarity: "full art", confidence: 0.8 }, model: "claude-haiku-5-5", ms: 900 });
  await ap.waitForTimeout(300);
  st = await ap.evaluate(() => ({ q: document.querySelector("#q").value, line: document.querySelector("#autoline").textContent, show: !!document.querySelector("#autoshow") }));
  ok(st.q === "charizard" && st.show && /Honchkrow/.test(st.line), "typed this lot: search left alone, 'show' offered");
  await ap.click("#autoshow"); await ap.waitForTimeout(200);
  ok((await ap.evaluate(() => (document.querySelector("#results .card") || {}).dataset.id)) === "swsh9-162", "'show' fills it: Honchkrow V #162 first (read 161, one off)");
  // the not-in-catalog case shows the note, no pricier sibling picked (1.6 s after the typing above, so not "touched")
  await ap.waitForTimeout(1600); await lotEnd(); key = Date.now() + 10;
  await send({ type: "cardcomp-auto", key, n: 1, read: { card_visible: true, name: "Kyurem ex", number: "157", total: "086", language: "en", rarity: "full art", confidence: 0.9 }, model: "claude-opus-5-5", ms: 4100 });
  await ap.waitForTimeout(300);
  st = await ap.evaluate(() => ({ badge: !!document.querySelector("#results .autobadge"), line: document.querySelector("#autoline").textContent }));
  ok(!st.badge && /no #157/.test(st.line), "Kyurem ex 157 (not in catalog): note shown, nothing marked");
  await send({ type: "cardcomp-auto", key: key + 1, n: 1, error: "API key rejected (Options page)" }); await ap.waitForTimeout(150);
  ok(/key rejected/.test(await ap.textContent("#autoline")), "API error shown on the line");
  await ap.evaluate((k) => window.recogLotDone({ startedAt: k, card: { id: "me5-85", n: "Fomantis", label: "tap", cond: "NM" }, final: 3, me: true, title: "#8" }), key);
  await ap.waitForTimeout(150);
  const oc = (await posted()).filter((m) => m.type === "cardcomp-auto-outcome").pop();
  ok(oc && oc.key === key && oc.outcome.card.id === "me5-85" && oc.outcome.me === true, "lot end: tapped card reported as the outcome");
  // read before the timer: shown as "before start"; the lot (created earlier, older key) reuses it; outcome maps to the lot
  await lotEnd(); await ap.waitForTimeout(50); const lotKey = Date.now(); await ap.waitForTimeout(30); const preKey = Date.now();
  await send({ type: "cardcomp-auto", key: preKey, capAt: preKey, n: 1, pre: true, read: { card_visible: true, name: "Numel", number: "", total: "", language: "en", rarity: "Illustration Rare", confidence: 0.9 }, model: "claude-haiku-5-5", ms: 1100 });
  await ap.waitForTimeout(250);
  st = await ap.evaluate(() => ({ line: document.querySelector("#autoline").textContent, first: (document.querySelector("#results .card") || {}).dataset }));
  ok(/^auto on.*before start: read Numel/.test(st.line.replace(/\s+/g, " ")) && st.first && st.first.id === "me2pt5-223", "read before the timer: shown as 'before start', Numel IR first");
  await send({ type: "cardcomp-auto-adopt", from: preKey, to: lotKey }); await ap.waitForTimeout(100);
  await ap.evaluate((k) => window.recogLotDone({ startedAt: k, card: { id: "me2pt5-223", n: "Numel", label: "view" }, final: 4, me: false }), lotKey);
  await ap.waitForTimeout(150);
  const oc2 = (await posted()).filter((m) => m.type === "cardcomp-auto-outcome").pop();
  ok(oc2 && oc2.key === lotKey && oc2.outcome.card.id === "me2pt5-223", "reused reading: the lot's outcome is reported under the lot");
  const later = Date.now();
  await send({ type: "cardcomp-auto", key: lotKey, capAt: later, n: 1, read: { card_visible: true, name: "Carbink", number: "", total: "", language: "en", rarity: "Illustration Rare", confidence: 0.9 }, model: "claude-haiku-5-5", ms: 900 });
  await ap.waitForTimeout(250);
  ok((await ap.evaluate(() => (document.querySelector("#results .card") || {}).dataset.id)) === "me2pt5-242", "a newer frame wins even when its lot key is older than a pre-start read");
  // a tap on the previous card's result must not block the next card's reading (lot created earlier than the tap)
  const oldLot = Date.now() - 30000; await ap.evaluate(() => { const c = document.querySelector("#results .card"); if (c) c.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
  await ap.waitForTimeout(1700); await lotEnd(); const capNow = Date.now();
  await send({ type: "cardcomp-auto", key: oldLot, capAt: capNow, n: 1, read: { card_visible: true, name: "Frogadier", number: "", total: "", language: "en", rarity: "Illustration Rare", confidence: 0.9 }, model: "claude-sonnet-5-5", ms: 900 });
  await ap.waitForTimeout(250);
  ok((await ap.evaluate(() => (document.querySelector("#results .card") || {}).dataset.id)) === "me4-89", "a tap on the previous card does not block the next card (Frogadier IR filled)");
  await lotEnd();
  // Chinese card: English printings for reference, nothing marked, warning in red
  await send({ type: "cardcomp-auto", key: Date.now(), capAt: Date.now(), n: 1, read: { card_visible: true, name: "Pikachu ex", number: "", total: "", language: "zh", rarity: "Special Illustration Rare", stamp: "", confidence: 0.9 }, model: "claude-sonnet-5-5", ms: 1200 });
  await ap.waitForTimeout(250);
  st = await ap.evaluate(() => ({ line: document.querySelector("#autoline").textContent, status: document.querySelector("#status").textContent, color: document.querySelector("#status").style.color, badge: !!document.querySelector("#results .autobadge"), n: document.querySelectorAll("#results .card").length }));
  ok(/Chinese card/.test(st.line) && /Chinese card/.test(st.status) && /red/.test(st.color) && !st.badge && st.n > 0, "Chinese card: red warning, English printings listed for reference, nothing marked as the card");
  // read now button and watcher status on the line
  await send({ type: "cardcomp-auto-watch", phase: "watching", why: "waiting for the card to hold still", mean: 9, peak: 60 }); await ap.waitForTimeout(150);
  ok(/waiting for the card to hold still/.test(await ap.textContent("#autoline")), "watcher status shown on the auto line");
  // read triggers: the big button, right-click anywhere (not in a text field), the mouse thumb button, the ` key
  const reads = async () => (await posted()).filter((m) => m.type === "cardcomp-auto-read").length;
  let n0 = await reads();
  const rbBox = await ap.evaluate(() => { const b = document.querySelector("#readbig"), q = document.querySelector("#q"); const r = b && b.getBoundingClientRect(), rq = q.getBoundingClientRect(); return b ? { w: Math.round(r.width), h: Math.round(r.height), qh: Math.round(rq.height), left: r.right <= rq.left + 1, disp: getComputedStyle(b).display } : null; });
  ok(rbBox && rbBox.disp === "flex" && rbBox.w >= 60 && Math.abs(rbBox.h - rbBox.qh) <= 4 && rbBox.left, `read button left of the search box, ${rbBox && rbBox.w}x${rbBox && rbBox.h} (search box ${rbBox && rbBox.qh} tall)`);
  await ap.click("#readbig"); await ap.waitForTimeout(120);
  ok((await reads()) === n0 + 1 && /reading/.test(await ap.textContent("#readbig")), "read button asks the extension for a read and shows 'reading'");
  await send({ type: "cardcomp-auto", key: Date.now(), capAt: Date.now(), n: 1, manual: true, read: { card_visible: false, name: "" }, model: "claude-sonnet-5-5", ms: 800 }); await ap.waitForTimeout(150);
  ok(/read/.test(await ap.textContent("#readbig")) && !/reading/.test(await ap.textContent("#readbig")), "button returns to 'read' when the reading comes back (even 'no card')");
  await ap.waitForTimeout(1600); n0 = await reads();
  await ap.click("#results", { button: "right", position: { x: 120, y: 60 } }); await ap.waitForTimeout(120);
  const ringed = await ap.evaluate(() => !!document.querySelector(".readring"));
  ok((await reads()) === n0 + 1 && ringed, "right-click in the results reads (ring under the pointer)");
  await send({ type: "cardcomp-auto-readack", ok: true }); await ap.waitForTimeout(1600); n0 = await reads();
  await ap.click("#q", { button: "right" }); await ap.waitForTimeout(120);
  ok((await reads()) === n0, "right-click in the search box keeps its normal menu (no read)");
  await ap.evaluate(() => { const o = { bubbles: true, button: 3, clientX: 200, clientY: 300 }; document.querySelector("#results").dispatchEvent(new MouseEvent("mousedown", o)); document.querySelector("#results").dispatchEvent(new MouseEvent("mouseup", o)); });
  await ap.waitForTimeout(120);
  ok((await reads()) === n0 + 1, "mouse thumb (back) button reads");
  await ap.waitForTimeout(1600); n0 = await reads();
  await ap.fill("#q", "pika"); await ap.focus("#q"); await ap.keyboard.press("Backquote"); await ap.waitForTimeout(120);
  ok((await reads()) === n0 + 1 && (await ap.evaluate(() => document.querySelector("#q").value)) === "pika", "` key reads, even while typing, and types nothing");
  await ap.screenshot({ path: path.join(OUT, "recog-readbutton.png") });
  await ap.fill("#q", "typing something"); await ap.waitForTimeout(100);
  await send({ type: "cardcomp-auto", key: Date.now(), capAt: Date.now(), n: 1, manual: true, read: { card_visible: true, name: "Carbink", number: "", total: "", language: "en", rarity: "Illustration Rare", confidence: 0.9 }, model: "claude-sonnet-5-5", ms: 900 });
  await ap.waitForTimeout(250);
  st = await ap.evaluate(() => ({ q: document.querySelector("#q").value, first: (document.querySelector("#results .card") || {}).dataset.id, line: document.querySelector("#autoline").textContent }));
  ok(st.q === "Carbink" && st.first === "me2pt5-242" && /read now/.test(st.line), "a read you asked for fills the search even if you were typing");
  // after a read you asked for, an automatic reading in the same lot does not replace your results (or close a card
  // you opened); it offers "show". Once the lot ends, the next reading fills again.
  await ap.click("#results .card .nm"); await ap.waitForTimeout(200);
  await send({ type: "cardcomp-auto", key: Date.now(), capAt: Date.now() + 5000, n: 1, pre: true, read: { card_visible: true, name: "Numel", number: "", total: "", language: "en", rarity: "Illustration Rare", confidence: 0.9 }, model: "claude-sonnet-5-5", ms: 900 });
  await ap.waitForTimeout(250);
  st = await ap.evaluate(() => ({ q: document.querySelector("#q").value, open: !!document.querySelector("#results .card.open"), show: !!document.querySelector("#autoshow") }));
  ok(st.q === "Carbink" && st.open && st.show, "after read now, an automatic reading in the same lot leaves your results and open card alone ('show' offered)");
  await lotEnd();
  await send({ type: "cardcomp-auto", key: Date.now(), capAt: Date.now() + 6000, n: 1, pre: true, read: { card_visible: true, name: "Numel", number: "", total: "", language: "en", rarity: "Illustration Rare", confidence: 0.9 }, model: "claude-sonnet-5-5", ms: 900 });
  await ap.waitForTimeout(250);
  ok((await ap.evaluate(() => document.querySelector("#q").value)) === "Numel", "after the lot ends, the next card's reading fills again");
  await send({ type: "cardcomp-auto-readack", ok: false, why: "no Whatnot tab" }); await ap.waitForTimeout(100);
  ok(/read now: no Whatnot tab/.test(await ap.textContent("#autoline")), "read now failure is shown");
  await ap.click("#autosw"); await ap.waitForTimeout(100);
  ok((await posted()).some((m) => m.type === "cardcomp-auto-config" && m.on === false), "switch posts 'off' to the extension");
  ok(ap.errors.length === 0, "no page errors (" + (ap.errors[0] || "") + ")");
  console.log("  app screenshot: " + path.join(OUT, "recog-app-auto.png"));
  await ap.close();

  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
