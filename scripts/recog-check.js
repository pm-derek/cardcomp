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
// 4. capture:    read now on a mock Whatnot page with a live <video>: video copy, screenshot fallback when the
//                canvas is blocked, no video.
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

  // ---------- 1d. Japanese name misread, number right (Derek, 2026-10-23: Mega Golurk ex 109/076 M6 read as Mega Metagross ex)
  {
    const r = await app.evaluate(() => {
      const g = autoMatch({ name: "Mega Metagross ex", number: "109", total: "076", rarity: "Special Illustration Rare", set: "Mega Brave (M6)", language: "jp", confidence: 0.93 }, { short: 720, model: "claude-sonnet-5-5" });
      const c = autoMatch({ name: "Calyrex VMAX", number: "", total: "", rarity: "Secret Rare gold full art", language: "en", confidence: 0.8 }, { model: "claude-sonnet-5-5" });
      const k = autoMatch({ name: "Kyurem ex", number: "157", total: "086", rarity: "full art", language: "en", confidence: 0.9 }, { model: "claude-opus-5-5" });
      return { g: [g.kind, g.suggestion, g.strength, (g.pool || []).length], c: c.cards.map((x) => x.n), k: [k.kind, k.suggestion] };
    });
    ok(r.g[0] === "number" && r.g[1] === "jp:709262" && r.g[2] === "weak" && r.g[3] >= 2, "Japanese name misread: #109/076 (M6) is Mega Golurk ex, suggested weak, Metagross still in the picture pool (" + r.g.join(", ") + ")");
    ok(r.c.some((n) => /^Ice Rider Calyrex VMAX/.test(n)), "name inside a longer name: Calyrex VMAX lists Ice Rider Calyrex VMAX (" + r.c.slice(0, 3).join(", ") + ")");
    ok(r.k[0] === "number-miss" && !r.k[1], "English name that fits the set size: a sister set's #157 is not offered (Kyurem ex 157/086 stays number-miss)");
  }

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
    // the manifest after strip = today's manifest without the experiment's parts (later non-experiment additions, such as
    // the fast TCGplayer read's permission and hosts, stay)
    const om = JSON.parse(fs.readFileSync(path.join(ROOT, "extension/manifest.json"), "utf8"));
    const sm = JSON.parse(fs.readFileSync(path.join(tmp, "extension/manifest.json"), "utf8"));
    const base = JSON.parse(execSync(`git show ${baseRef}:extension/manifest.json`, { cwd: ROOT }).toString());
    if (om.commands) { delete om.commands["recog-grab"]; if (!Object.keys(om.commands).length) delete om.commands; }
    om.content_scripts = (om.content_scripts || []).filter((c) => !(c.js || []).every((j) => j.startsWith("recog/")));
    om.permissions = (om.permissions || []).filter((p) => p !== "activeTab");
    om.host_permissions = (om.host_permissions || []).filter((h) => !/anthropic\.com|cardsight\.ai|tcgplayer-cdn\.tcgplayer\.com|images\.pokemontcg\.io/.test(h));
    const baseScripts = JSON.stringify((base.content_scripts || []).map((c) => c.js.join(",")));
    ok(JSON.stringify(om) === JSON.stringify(sm) && !/recog|anthropic/i.test(JSON.stringify(sm)) && JSON.stringify(sm.content_scripts.map((c) => c.js.join(","))) === baseScripts,
      "manifest after strip: the experiment's shortcut, content script and permissions gone, everything else kept");
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
  // the real read path (read now -> frame -> API): video copy, screenshot when the canvas is blocked, no video
  const scenario = async (mode) => {
    const page = await ctx.newPage();
    const errs = []; page.on("pageerror", (e) => errs.push(e.message));
    await page.route("https://api.anthropic.com/v1/messages", (r) => r.fulfill({ status: 401, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" }, contentType: "application/json", body: '{"type":"error","error":{"type":"authentication_error","message":"x"}}' }));
    await page.goto(base + "/__mock?mode=" + mode);
    await page.waitForFunction(() => window.__mockReady === true);
    await page.addScriptTag({ path: path.join(ROOT, "extension/recog/recog-whatnot.js") });
    await page.addScriptTag({ path: path.join(ROOT, "extension/recog/recog-read.js") });
    await page.addScriptTag({ path: path.join(ROOT, "extension/recog/recog-bg.js") });
    const shot = "data:image/jpeg;base64," + (await page.screenshot({ type: "jpeg", quality: 90 })).toString("base64");
    await page.evaluate((shot) => { window.__shot = shot; return new Promise((r) => chrome.storage.local.set({ recogMode: "manual", recogKey: "sk-ant-test" }, r)); }, shot);
    await page.waitForTimeout(200);
    await page.evaluate(() => window.__listeners.forEach((f) => f({ type: "recog-read-now" }, {}, () => {})));
    await page.waitForTimeout(2500);
    const lots = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open("cardcomp-recog", 2); r.onsuccess = () => { const q = r.result.transaction("lots").objectStore("lots").getAll(); q.onsuccess = () => res(q.result); }; }));
    await page.close();
    const L = lots[lots.length - 1] || {};
    return { frame: (L.frames || [])[0], read: (L.reads || [])[0], errs };
  };
  const v = await scenario("video");
  ok(v.frame && v.frame.method === "video" && v.frame.w === 1280 && v.frame.luma > 12 && !v.errs.length, `video copy: ${v.frame && v.frame.method} ${v.frame && v.frame.w}x${v.frame && v.frame.h}, ${v.frame && v.frame.kb} KB, brightness ${v.frame && v.frame.luma}`);
  const t = await scenario("tainted");
  ok(t.frame && t.frame.method === "screenshot", `blocked canvas: falls back to a screenshot (${t.frame && t.frame.w}x${t.frame && t.frame.h})`);
  ok(t.frame && Math.abs(t.frame.w / t.frame.h - 540 / 760) < 0.02, "blocked canvas: screenshot cropped to the video box (aspect " + (t.frame && (t.frame.w / t.frame.h).toFixed(3)) + ")");
  const nv = await scenario("novideo");
  ok(!nv.frame && nv.read && /no frame: .*no <video>/.test(nv.read.error || ""), "no video: reported as failed with the reason (" + (nv.read && nv.read.error) + ")");

  // ---------- 4b. picture match relays: the ack carries the reading's key / n, never the reply's fields
  {
    const vm = require("vm"), reply = { ok: true, ranked: [], v: {}, cands: 22, n: 22, key: 1 };
    const run = (file, ctx) => vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), vm.createContext(ctx));
    // side panel
    let onMsg = null; const got = [], cw = { postMessage: (m) => got.push(m) };
    run("extension/panel.js", { chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: (m, cb) => cb && cb(reply), lastError: null }, windows: { getCurrent: (cb) => cb({ id: 1 }) },
      tabs: { query: (q, cb) => cb([]), onCreated: { addListener() {} }, onRemoved: { addListener() {} }, onAttached: { addListener() {} }, onDetached: { addListener() {} }, onUpdated: { addListener() {} } } },
      window: { addEventListener: (t, f) => { if (t === "message") onMsg = f; } }, document: { getElementById: () => ({ contentWindow: cw, addEventListener() {} }) } });
    onMsg({ source: cw, data: { type: "cardcomp-auto-img", key: 777, n: 1, cands: [] } });
    // CardComp tab
    let onMsg2 = null; const got2 = [];
    const w2 = { addEventListener: (t, f) => { if (t === "message") onMsg2 = f; }, postMessage: (m) => got2.push(m) };
    run("extension/cardcomp.js", { chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: (m, cb) => cb && cb(reply), lastError: null } }, window: w2, location: { origin: "https://pm-derek.github.io" } });
    onMsg2({ source: w2, origin: "https://pm-derek.github.io", data: { type: "cardcomp-auto-img", key: 777, n: 1, cands: [] } });
    const a1 = got.find((m) => m.type === "cardcomp-auto-img-ack"), a2 = got2.find((m) => m.type === "cardcomp-auto-img-ack");
    ok(a1 && a1.key === 777 && a1.n === 1 && a2 && a2.key === 777 && a2.n === 1, "picture match relays: the ack keeps the reading's key and n (side panel and CardComp tab)");
  }

  // ---------- 4d. windows: a side panel keeps only its own window's lot, from the background relay (Derek 2026-10-23)
  {
    const vm = require("vm"), L = [], got = [];
    vm.runInContext(fs.readFileSync(path.join(ROOT, "extension/panel.js"), "utf8"), vm.createContext({
      chrome: { runtime: { onMessage: { addListener: (f) => L.push(f) }, sendMessage: () => {}, lastError: null }, windows: { getCurrent: (cb) => cb({ id: 1 }) },
        tabs: { query: (q, cb) => cb([{ id: 9, windowId: 1 }]), onCreated: { addListener() {} }, onRemoved: { addListener() {} }, onAttached: { addListener() {} }, onDetached: { addListener() {} }, onUpdated: { addListener() {} } } },
      window: { addEventListener() {} }, document: { getElementById: () => ({ contentWindow: { postMessage: (m) => got.push(m) }, addEventListener() {} }) } }));
    const fire = (msg, sender) => L.forEach((f) => f(msg, sender || {}));
    fire({ type: "cardcomp-lot", title: "other stream" }, { tab: { windowId: 2 } });            // straight from the other window's Whatnot page
    fire({ type: "cardcomp-lot", title: "own direct" }, { tab: { windowId: 1 } });              // straight from this window's page (the relay brings it)
    fire({ type: "cardcomp-lot", title: "other relayed", win: 2, primary: true });              // relayed, other window (main stream)
    fire({ type: "cardcomp-lot", title: "own relayed", win: 1, primary: false });               // relayed, this window
    fire({ type: "cardcomp-auto-watch", phase: "x", win: 2, primary: true }, { tab: { windowId: 2 } });
    ok(got.length === 1 && got[0].title === "own relayed", "windows: the side panel keeps only its own window's lot, once (" + got.map((m) => m.title || m.type).join(", ") + ")");
  }

  // ---------- 4c. fast TCGplayer read (extension/tcgfast.js, not part of the experiment): every condition from 4 requests
  {
    const calls = [], realFetch = global.fetch, J = (x) => ({ ok: true, json: async () => x });
    global.fetch = async (url, o) => { const u = String(url); calls.push(u);
      if (u.includes("/details")) return J({ skus: [{ sku: 11, condition: "Near Mint", variant: "Holofoil", language: "English" }, { sku: 12, condition: "Lightly Played", variant: "Holofoil", language: "English" }, { sku: 21, condition: "Near Mint", variant: "Reverse Holofoil", language: "English" }] });
      if (u.includes("marketprice")) return J(JSON.parse(o.body).skuIds.map((id) => ({ skuId: id, marketPrice: { 11: 39.05, 12: 18.53 }[id] })));
      if (u.includes("/listings")) return J({ results: [{ totalResults: 3, results: [{ condition: "Lightly Played", printing: "Holofoil", price: 29 }, { condition: "Near Mint", printing: "Holofoil", price: 41 }] }] });
      if (u.includes("latestsales")) return J({ data: [{ condition: "Lightly Played", variant: "Holofoil", language: "English", purchasePrice: 19.5, orderDate: "2026-10-12T10:00:00Z" }, { condition: "Near Mint", variant: "Reverse Holofoil", language: "English", purchasePrice: 99, orderDate: "2026-10-20T10:00:00Z" }] });
      return { ok: false, status: 404 }; };
    const { tcgFast } = require(path.join(ROOT, "extension/tcgfast.js"));
    const r = await tcgFast({ pid: "198772", printing: "Holofoil", cond: "LP" });
    global.fetch = realFetch;
    ok(r.conds.NM.market === 39.05 && r.conds.LP.market === 18.53 && r.conds.LP.low === 29 && r.conds.LP.sales[0].p === 19.5 && !r.conds.NM.sales && r.market === 18.53 && calls.length === 4,
      "fast TCGplayer read: every condition of the printing from 4 requests, other printings left out (" + r.errs.length + " errors)");
  }

  // ---------- 5. auto mode, extension side: lot timer -> frame -> API (mocked) -> CardComp message + lot record
  console.log("5. auto mode: lot start -> frame -> model (mocked API) -> CardComp, recorded per lot");
  let apiMode = "ok", apiCalls = [], zoomSeen = 0;
  const READS = { first: { card_visible: true, name: "Kyurem ex", number: "157", total: "086", language: "en", rarity: "Ultra Rare full art", set: "", confidence: 0.9 } };
  await ctx.route("https://api.anthropic.com/v1/messages", async (route) => {
    const req = route.request(), cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const body = JSON.parse(req.postData() || "{}"); apiCalls.push(body);
    if (apiMode === "nothink" && body.thinking) return route.fulfill({ status: 400, headers: cors, contentType: "application/json", body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "thinking.type: between_tools is not supported for this model" } }) });
    if (apiMode === "401") return route.fulfill({ status: 401, headers: cors, contentType: "application/json", body: JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }) });
    if (body.stream) {   // the real API streams: short keys in answer order, split into pieces like text deltas
      const far = apiMode === "zoom" && !(zoomSeen++ % 2);   // zoom mode: the frame gives no number and a small box, the enlarged crop gives the number
      const R = READS.first, txt = JSON.stringify({ visible: R.card_visible, name: R.name, lang: R.language, num: far ? "" : R.number, total: far ? "" : R.total, rarity: R.rarity, stamp: R.stamp || "", finish: R.finish || "unknown", set: R.set || "", conf: far ? 0.6 : R.confidence, box: far ? [300, 420, 700, 720] : [] });
      const ev = (o) => "event: " + o.type + "\ndata: " + JSON.stringify(o) + "\n\n", parts = [txt.slice(0, 20), txt.slice(20, 70), txt.slice(70)];
      return route.fulfill({ status: 200, headers: cors, contentType: "text/event-stream", body: ev({ type: "message_start", message: { model: body.model, usage: { input_tokens: 2900, output_tokens: 1 } } }) +
        parts.map((t) => ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } })).join("") +
        ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 60 } }) + ev({ type: "message_stop" }) });
    }
    return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ model: body.model, stop_reason: "end_turn",
      usage: { input_tokens: 2900, output_tokens: 120 }, content: [{ type: "text", text: JSON.stringify(READS.first) }] }) });
  });
  const mp = await ctx.newPage();
  const merr = []; mp.on("pageerror", (e) => merr.push(e.message));
  await mp.goto(base + "/__mock?mode=video");
  await mp.waitForFunction(() => window.__mockReady === true);
  await mp.addScriptTag({ path: path.join(ROOT, "extension/recog/recog-whatnot.js") });
  await mp.addScriptTag({ path: path.join(ROOT, "extension/recog/imgmatch.js") });
  await mp.addScriptTag({ path: path.join(ROOT, "extension/recog/recog-read.js") });
  await mp.addScriptTag({ path: path.join(ROOT, "extension/recog/recog-bg.js") });
  // a live lot: the timer counts down (whatnot.js calls __recogTick on every page change, so every second)
  const tick = (key) => mp.evaluate((key) => {
    clearInterval(window.__clock); const lot = { startedAt: key, title: "$1 START SINGLES #" + (key % 100), ended: false }; window.__lot = lot; let t = 30;
    const f = () => { if (lot.ended) return clearInterval(window.__clock); window.__recogTick({ timer: "00:" + String(t--).padStart(2, "0") }, lot); };
    f(); window.__clock = setInterval(f, 500);
  }, key);
  const sold = () => mp.evaluate(() => { clearInterval(window.__clock); window.__lot.ended = true; window.__recogTick({ timer: "", sold: "Sold", ended: true }, window.__lot); });
  const scene = (n) => mp.evaluate((n) => { window.__scene = n; }, n);
  const toAppAll = () => mp.evaluate(() => window.__runtime.filter((m) => m.type === "cardcomp-auto"));
  const toApp = () => mp.evaluate(() => window.__runtime.filter((m) => m.type === "cardcomp-auto" && !m.partial));   // full readings (early streamed ones checked on their own)
  const lotRec = (key) => mp.evaluate((key) => new Promise((res) => { const r = indexedDB.open("cardcomp-recog", 2); r.onsuccess = () => { const q = r.result.transaction("lots").objectStore("lots").get(key); q.onsuccess = () => res(q.result); }; }), key);
  // off: nothing happens
  await tick(Date.now()); await mp.waitForTimeout(1500);
  ok((await toApp()).length === 0 && apiCalls.length === 0, "switch off: no frame, no API call");
  await mp.evaluate(() => chrome.storage.local.set({ recogOn: true, recogKey: "sk-ant-test", recogModel: "haiku" }));
  const k1 = Date.now(); await tick(k1); await mp.waitForTimeout(2200);
  let msgs = await toAppAll(), r1 = await lotRec(k1);
  const fin = msgs.filter((m) => !m.partial), part = msgs.filter((m) => m.partial);
  ok(fin.length === 1 && fin[0].key === k1 && fin[0].read && fin[0].read.name === "Kyurem ex" && fin[0].read.number === "157" && fin[0].read.language === "en" && fin[0].model === "claude-haiku-5-5", "lot start: one reading sent to CardComp (" + (fin[0] && fin[0].read && fin[0].read.name) + ", short keys mapped back)");
  ok(part.length === 1 && msgs.indexOf(part[0]) < msgs.indexOf(fin[0]) && part[0].read.name === "Kyurem ex" && part[0].read.number === "157" && part[0].read.total === "086" && !part[0].read.rarity, "streamed reply: name / number / total sent early, before the rest is written");
  msgs = fin;
  const c0 = apiCalls[0] || {};
  ok(c0.model === "claude-haiku-5-5" && c0.output_config && c0.output_config.format && c0.output_config.effort === "low" && c0.messages[0].content[0].type === "image", "API request: Haiku, image first, structured output, low effort");
  ok(c0.thinking && c0.thinking.type === "disabled" && !c0.fallbacks, "API request: Haiku thinking off, no fallback option (faster)");
  ok(c0.stream === true && /zh/.test(JSON.stringify(c0.output_config.format.schema.properties.lang.enum)) && /stamp/.test(JSON.stringify(c0.output_config.format.schema.required)), "API request: streamed, asks for the stamp, allows Chinese / Korean");
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
  // far, small card with no number read: the card box from the same frame is enlarged and read again
  apiMode = "zoom"; zoomSeen = 0; let zb = apiCalls.length; const kz = Date.now(); await tick(kz); await mp.waitForTimeout(3000);
  const zm = (await toApp()).filter((m) => m.key === kz), zrec = await lotRec(kz), zcall = apiCalls[zb + 1];
  const zimg = zcall && zcall.messages[0].content[0].source.data, zdim = zimg ? await mp.evaluate(async (d) => { const b = await createImageBitmap(await (await fetch("data:image/jpeg;base64," + d)).blob()); return [b.width, b.height]; }, zimg) : null;
  ok(zm.length === 2 && !zm[0].read.number && zm[1].zoom > 1 && zm[1].read.number === "157" && zrec && zrec.frames.some((f) => f.trigger === "zoom") && zdim && Math.max(...zdim) >= 1300,
    "no number on a small card: zoomed re-read of the same frame (" + (zm[1] && zm[1].zoom) + "x, " + (zdim && zdim.join("x")) + ") finds #157");
  await sold(); apiMode = "ok";
  // manual mode: a lot starts, nothing is read; read now still reads
  await mp.evaluate(() => chrome.storage.local.set({ recogMode: "manual" })); await mp.waitForTimeout(100);
  let mb = apiCalls.length; const km = Date.now(); await tick(km); await mp.waitForTimeout(2500);
  ok(apiCalls.length === mb, "manual mode: a lot starts, no automatic read");
  await mp.evaluate(() => window.__listeners.forEach((f) => f({ type: "recog-read-now" }, {}, () => {}))); await mp.waitForTimeout(2000);
  ok(apiCalls.length === mb + 1, "manual mode: read now reads");
  await sold(); await mp.evaluate(() => chrome.storage.local.set({ recogMode: "auto" })); await mp.waitForTimeout(100);
  // auto used up its hour: automatic reads pause quietly, read now still works
  await mp.evaluate(() => { for (let i = 0; i < 240; i++) recogCalls.auto.push(Date.now()); });
  mb = apiCalls.length; const kc = Date.now(); await tick(kc); await mp.waitForTimeout(2500);
  const capMsgs = await mp.evaluate((k) => window.__runtime.filter((m) => (m.type === "cardcomp-auto" && m.key === k && m.error) || (m.type === "cardcomp-auto-watch" && /auto paused/.test(m.why || ""))), kc);
  ok(apiCalls.length === mb && capMsgs.length > 0 && capMsgs.every((m) => m.type === "cardcomp-auto-watch"), "auto cap reached: no read, 'auto paused' on the watcher line, no error over the results");
  await mp.evaluate(() => window.__listeners.forEach((f) => f({ type: "recog-read-now" }, {}, () => {}))); await mp.waitForTimeout(2000);
  ok(apiCalls.length === mb + 1, "auto cap reached: read now still reads (its own allowance)");
  await sold(); await mp.evaluate(() => { recogCalls.auto.length = 0; });
  // far camera: a small card swapped for another in the same spot (missed live by the old whole-frame check)
  await sold(); await scene(3); await mp.waitForTimeout(3600);
  let before = apiCalls.length;
  await scene(4); await mp.waitForTimeout(3600);
  const pre2 = (await toApp()).filter((m) => m.pre);
  ok(apiCalls.length === before + 1 && pre2.length >= 2, "far camera: a small card swapped in the same spot is seen as a new card and read");
  // Sonnet: thinking switched off with between_tools; an option the API rejects is dropped and never sent again
  await mp.evaluate(() => chrome.storage.local.set({ recogModel: "sonnet" }));
  { const kg = Date.now(); await tick(kg); await mp.waitForTimeout(1500); await sold(); await mp.waitForTimeout(300); }   // a fresh gap: 2 reads allowed before each timer
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
  before = apiCalls.length; const man0 = (await toApp()).filter((m) => m.manual).length;
  await mp.evaluate(() => window.__listeners.forEach((f) => f({ type: "recog-read-now" }, {}, () => {})));
  await mp.waitForTimeout(900);
  const man = (await toApp()).filter((m) => m.manual).slice(man0);
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
  // CardSight side by side (2026-10-23): read now also goes to CardSight (mocked); a coin picks which answer is shown, the
  // other is a shadow; an empty shown answer hands over to the other; the monthly allowance is spread over the days left
  {
    const csCalls = []; let csMode = "ok";
    await ctx.route("https://api.cardsight.ai/v1/identify/card/pokemon", async (route) => {
      const req = route.request(), cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      csCalls.push({ key: req.headers()["x-api-key"], ct: req.headers()["content-type"] || "", size: (req.postDataBuffer() || Buffer.alloc(0)).length });
      if (csMode === "500") return route.fulfill({ status: 500, headers: cors, contentType: "application/json", body: '{"error":"boom"}' });
      if (csMode === "none") return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ success: true, requestId: "r0", detections: [], detectedCount: 1, identifiedCount: 0, processingTime: 280 }) });
      return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ success: true, requestId: "r1", detectedCount: 1, identifiedCount: 1, processingTime: 310,
        detections: [{ confidence: "High", card: { id: "u1", name: "Mega Golurk ex", number: "109/076", setName: "Storm Emeralda", releaseName: "Mega Evolution", year: "2026", fields: [{ key: "CARD_LANGUAGE", value: "ja" }, { key: "Rarity", value: "Special Art Rare" }] } }] }) });
    });
    const csRead = async (force, mode) => {
      csMode = mode || "ok"; await mp.evaluate((f) => new Promise((r) => chrome.storage.local.set({ csKey: "cs_test_key_0123456789", csForce: f }, r)), force);
      const n0 = await mp.evaluate(() => window.__runtime.length), c0 = csCalls.length, a0 = apiCalls.length;
      await mp.evaluate(() => window.__listeners.forEach((f) => f({ type: "recog-read-now" }, {}, () => {}))); await mp.waitForTimeout(2600);
      const m = await mp.evaluate((n0) => window.__runtime.slice(n0).filter((x) => x.type === "cardcomp-auto"), n0);
      return { m, cs: csCalls.length - c0, claude: apiCalls.length - a0, shown: m.filter((x) => !x.shadow && !x.partial), shadow: m.filter((x) => x.shadow) };
    };
    await sold();
    let x = await csRead("cs");
    const sh = x.shown[0] || {}, csKey0 = sh.key;
    ok(x.cs === 1 && x.claude === 1 && x.shown.length === 1 && sh.src === "cardsight" && sh.read.name === "Mega Golurk ex" && sh.read.number === "109" && sh.read.total === "076" && sh.read.language === "jp" && sh.short === 0 &&
      x.shadow.length === 1 && x.shadow[0].src === "claude" && !x.m.some((y) => y.partial) && csCalls[csCalls.length - 1].key === "cs_test_key_0123456789" && /multipart\/form-data/.test(csCalls[csCalls.length - 1].ct) && csCalls[csCalls.length - 1].size > 5000,
      "CardSight drew the coin: its answer fills (Golurk 109/076, Japanese), Claude only recorded, no early Claude fill; multipart image + X-API-Key (" + x.shown.map((y) => y.src).join(",") + " / shadow " + x.shadow.map((y) => y.src).join(",") + ")");
    await sold(); x = await csRead("claude");
    ok(x.shown.length === 1 && x.shown[0].src === "claude" && x.shadow.length === 1 && x.shadow[0].src === "cardsight" && x.shadow[0].read.name === "Mega Golurk ex", "Claude drew the coin: Claude fills, CardSight recorded as the shadow");
    await sold(); x = await csRead("cs", "500");
    ok(x.shown.length === 1 && x.shown[0].src === "claude" && x.shadow.some((y) => y.src === "cardsight" && /CardSight error 500/.test(y.error)), "CardSight failed: Claude fills instead, the failure is recorded");
    await sold(); x = await csRead("cs", "none");
    ok(x.shown.length === 1 && x.shown[0].src === "claude", "CardSight found no card: Claude fills");
    // the free plan's 750 a month spread over the days left: once today's share is used, no CardSight call
    await sold();
    const share = await mp.evaluate(() => { const now = new Date(), dl = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate() - now.getUTCDate() + 1; return Math.floor(750 / dl); });
    await mp.evaluate((share) => new Promise((r) => { const now = new Date(); chrome.storage.local.set({ csMonthly: 750, csUse: { month: now.toISOString().slice(0, 7), day: now.toISOString().slice(0, 10), n: share, dn: share, n0: 0 } }, r); }), share);
    x = await csRead("cs");
    ok(x.cs === 0 && x.claude === 1 && x.shown.length === 1 && x.shown[0].src === "claude", "today's share of the month used (" + share + " calls): Claude only, no CardSight call");
    await sold();
    const rec = await lotRec(csKey0), csr = rec && rec.reads.find((y) => y.src === "cardsight");
    await mp.evaluate(() => new Promise((r) => chrome.storage.local.remove(["csKey", "csForce", "csUse", "csMonthly"], r)));
    ok(csr && csr.shown === true && csr.read && csr.read.name === "Mega Golurk ex" && csr.cs && csr.cs.top[0].lang === "ja" && rec.reads.some((y) => !y.src && y.read), "lot record keeps both readings, CardSight's raw answer included (results page)");
  }
  // CardComp reports its match and the lot outcome back
  await mp.evaluate((k) => { const send = (m) => window.__listeners.forEach((f) => f(m, {}, () => {}));
    send({ type: "cardcomp-auto-match", key: k, n: 1, kind: "number-miss", strength: null, suggestion: null, cards: [{ id: "sv10pt5-165", n: "Kyurem ex", s: "Black Bolt", num: "165", m: 68.9 }], note: "no #157", filled: true });
    send({ type: "cardcomp-auto-outcome", key: k, outcome: { card: { id: "sv10pt5-165", n: "Kyurem ex", s: "Black Bolt", num: "165", label: "view" }, final: 3, me: false } }); }, k1);
  await mp.waitForTimeout(400);
  r1 = await lotRec(k1);
  ok(r1.matches && r1.matches.length === 1 && r1.outcome && r1.outcome.card.id === "sv10pt5-165", "match and outcome saved on the lot");
  // two CardComp copies report the same lot: the one that saw nothing must not wipe the opened card; a tap beats a view;
  // the auction log row (cardcomp-log-save) also fills the outcome, but never creates a record for a lot that was not read
  await mp.evaluate((k) => { const send = (m) => window.__listeners.forEach((f) => f(m, {}, () => {}));
    send({ type: "cardcomp-auto-outcome", key: k, outcome: { card: null, final: 3, me: false } }); }, k1);
  await mp.waitForTimeout(300);
  ok(((await lotRec(k1)).outcome.card || {}).id === "sv10pt5-165", "outcome: a copy that saw nothing does not wipe the opened card");
  await mp.evaluate((k) => { const send = (m) => window.__listeners.forEach((f) => f(m, {}, () => {}));
    send({ type: "cardcomp-log-save", rec: { startedAt: k, at: k + 20000, final: 21, me: true, placedMax: 22, card: { id: "sv10pt5-165", n: "Kyurem ex", label: "tap", printing: "Holofoil", cond: "NM", myMax: 22 } } });
    send({ type: "cardcomp-log-save", rec: { startedAt: 12345, at: 12399, final: 1, card: null } }); }, k1);
  await mp.waitForTimeout(300);
  r1 = await lotRec(k1);
  ok(r1.outcome.card.label === "tap" && r1.outcome.card.printing === "Holofoil" && r1.outcome.placedMax === 22 && !(await lotRec(12345)), "outcome from the log row: tap with printing and max; unread lots get no record");
  ok(merr.length === 0, "no page errors (" + (merr[0] || "") + ")");
  // picture match, extension side: synthetic card pictures (served as TCGplayer photos), a frame showing one of them
  // smaller, shifted in color, with a decoy card beside it -> that card ranks first and is "sure"; a second ask for the
  // same candidates downloads nothing (templates cached); two ids with the same picture are left out
  const pics = await mp.evaluate(async () => {
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const card = () => { const c = new OffscreenCanvas(200, 279), g = c.getContext("2d"); g.fillStyle = `hsl(${rnd() * 360},50%,${40 + rnd() * 30}%)`; g.fillRect(0, 0, 200, 279);
      for (let i = 0; i < 14; i++) { g.fillStyle = `hsl(${rnd() * 360},${40 + rnd() * 50}%,${20 + rnd() * 60}%)`; g.beginPath(); g.arc(rnd() * 200, 30 + rnd() * 140, 10 + rnd() * 45, 0, 7); g.fill(); }
      g.fillStyle = "#eee"; g.fillRect(14, 180, 172, 80); return c; };
    const cards = Array.from({ length: 8 }, card), urls = [];
    for (const c of cards) { const b = await c.convertToBlob({ type: "image/jpeg", quality: 0.85 }); urls.push(await new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); })); }
    const fr = new OffscreenCanvas(720, 1280), g = fr.getContext("2d"); g.fillStyle = "#3b3b3b"; g.fillRect(0, 0, 720, 1280);
    for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(${rnd() * 255},${rnd() * 255},${rnd() * 255},.25)`; g.fillRect(rnd() * 720, rnd() * 1280, 30, 30); }
    g.filter = "brightness(1.15) saturate(0.85)"; g.drawImage(cards[3], 210, 430, 300, 419); g.filter = "none"; g.drawImage(cards[5], 560, 900, 140, 195);
    const fb = await fr.convertToBlob({ type: "image/jpeg", quality: 0.7 });
    const frame = await new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(fb); });
    return { urls, frame, box: [Math.round(200 / 720 * 1000), Math.round(410 / 1280 * 1000), Math.round(520 / 720 * 1000), Math.round(860 / 1280 * 1000)] };
  });
  let picHits = 0;
  await ctx.route(/^https:\/\/tcgplayer-cdn\.tcgplayer\.com\/product\/(\d+)_200w\.jpg/, (r) => { picHits++; const id = +r.request().url().match(/product\/(\d+)_/)[1];
    const i = id >= 900 ? 7 : id - 100; r.fulfill({ status: 200, headers: { "access-control-allow-origin": "*" }, contentType: "image/jpeg", body: Buffer.from(pics.urls[i].split(",")[1], "base64") }); });
  const pcands = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ id: "c" + i, u: `https://tcgplayer-cdn.tcgplayer.com/product/${100 + i}_200w.jpg` })).concat([900, 901, 902].map((p, i) => ({ id: "dup" + i, u: `https://tcgplayer-cdn.tcgplayer.com/product/${p}_200w.jpg` })));
  const pr1 = await mp.evaluate(async ({ pics, pcands }) => { picKeep(4242, 1, pics.frame, pics.box); return picRank({ key: 4242, n: 1, cands: pcands }); }, { pics, pcands });
  const hits1 = picHits;
  const pr2 = await mp.evaluate(async ({ pcands }) => picRank({ key: 4242, n: 1, cands: pcands }), { pcands });
  const pr3 = await mp.evaluate(async ({ pics, pcands }) => { picKeep(4243, 1, pics.frame, null); return picRank({ key: 4243, n: 1, cands: pcands }); }, { pics, pcands });
  ok(pr1.ok && pr1.v.top === "c3" && pr1.v.sure && !pr1.ranked.some((r) => /^dup/.test(r.id)) && pr1.pics === 7, "picture match: the card shown ranks first and sure (" + (pr1.ranked || []).slice(0, 3).map((r) => r.id + " " + r.s).join(", ") + ", " + pr1.ms + " ms); one photo under 3 ids left out " + JSON.stringify({ sure: pr1.v && pr1.v.sure, pics: pr1.pics, ids: (pr1.ranked || []).map((r) => r.id) }));
  ok(pr2.ok && pr2.v.top === "c3" && picHits === hits1, "picture match: second ask downloads nothing (" + hits1 + " pictures the first time, " + (picHits - hits1) + " now, " + pr2.ms + " ms)");
  ok(pr3.ok && pr3.v.top === "c3" && !pr3.box, "picture match without a card box (whole frame): still the shown card (" + pr3.ms + " ms)");
  ok(await mp.evaluate(() => PIC_FRAMES.size >= 3 && [...PIC_FRAMES.keys()].some((k) => !/^424[23]\|/.test(k))), "picture match: every reading keeps its frame for the ranking that follows");
  const lotPics = await mp.evaluate(() => new Promise((res) => { const r = indexedDB.open("cardcomp-recog", 2); r.onsuccess = () => { const g = r.result.transaction("lots").objectStore("lots").get(4242); g.onsuccess = () => res(g.result && g.result.pics); }; }));
  ok(lotPics && lotPics.length === 2 && lotPics[0].top === "c3", "picture match recorded on the lot for the results page");
  const dbg2 = await ctx.newPage();
  await dbg2.goto(base + "/extension/recog/debug.html"); await dbg2.waitForTimeout(900);
  const sum2 = await dbg2.textContent("#sum");
  ok(/\d+ lots read/.test(sum2) && /unscored \(no card picked/.test(sum2) && /Read before the timer: \d+ lots \(\d+ reused/.test(sum2) && /Strong suggestion wrong: 0 of 0/.test(sum2) && /Spent \$/.test(sum2), "results page summary: " + sum2.replace(/\s+/g, " ").slice(0, 160));
  const [dl] = await Promise.all([dbg2.waitForEvent("download"), dbg2.click("#exp")]);
  const ex = JSON.parse(fs.readFileSync(await dl.path(), "utf8")), exKB = Math.round(fs.statSync(await dl.path()).size / 1024);
  ok(ex.lots.length > 0 && ex.lots.every((L) => (L.frames || []).every((f) => !f.img)) && ex.lots.some((L) => /^data:image\/jpeg/.test(L.thumb || "")), "small export: no full frames, one small picture per lot (" + exKB + " KB for " + ex.lots.length + " lots)");
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
  ok((await posted()).some((m) => m.type === "cardcomp-auto-hello") && (await ap.evaluate(() => (document.querySelector("#automodes span.on") || {}).dataset.m)) === "off", "extension present: mode switch shows 'off' and asks for state");
  await send({ type: "cardcomp-auto-state", on: true, model: "haiku", hasKey: true }); await ap.waitForTimeout(100);
  ok((await ap.evaluate(() => (document.querySelector("#automodes span.on") || {}).dataset.m)) === "auto" && await ap.$("#automodel"), "state on (older extension, no mode): 'auto' selected, model picker");
  let key = Date.now();
  await send({ type: "cardcomp-auto", key, n: 1, read: { card_visible: true, name: "Fomantis", number: "085", total: "084", language: "en", rarity: "Illustration Rare", confidence: 0.9 }, model: "claude-haiku-5-5", ms: 1300 });
  await ap.waitForTimeout(300);
  let st = await ap.evaluate(() => ({ q: document.querySelector("#q").value, first: (document.querySelector("#results .card") || {}).dataset, badge: (document.querySelector("#results .card .autobadge") || {}).textContent, line: document.querySelector("#autoline").textContent }));
  ok(st.q === "Fomantis 085/084" && st.first && st.first.id === "me5-85" && /auto/.test(st.badge || "") && /✓ Fomantis/.test(st.line) && !/no match/.test(st.line), `exact read: search filled, Fomantis #85 first with the gold mark ("${st.badge}")`);
  // early (streamed) reading for the next lot: fills now, nothing logged; the full reply then marks the best guess
  await lotEnd(); const pk = Date.now();
  const nMatch = (await posted()).filter((m) => m.type === "cardcomp-auto-match").length;
  await send({ type: "cardcomp-auto", key: pk, capAt: pk, n: 1, partial: true, read: { card_visible: true, name: "Numel", number: "", total: "", language: "en", rarity: "", stamp: "", finish: "", set: "" }, model: "claude-sonnet-5-5", ms: 900 });
  await ap.waitForTimeout(250);
  st = await ap.evaluate(() => ({ q: document.querySelector("#q").value, line: document.querySelector("#autoline").textContent, first: (document.querySelector("#results .card") || {}).dataset }));
  ok(st.q === "Numel" && /reading Numel.*rest coming/.test(st.line) && st.first && (await posted()).filter((m) => m.type === "cardcomp-auto-match").length === nMatch, "early reading: search filled at once (" + st.line.replace(/\s+/g, " ").slice(0, 60) + "), not logged");
  await send({ type: "cardcomp-auto", key: pk, capAt: pk, n: 1, read: { card_visible: true, name: "Numel", number: "", total: "", language: "en", rarity: "Illustration Rare", confidence: 0.9 }, model: "claude-sonnet-5-5", ms: 1700 });
  await ap.waitForTimeout(250);
  st = await ap.evaluate(() => ({ first: (document.querySelector("#results .card") || {}).dataset, badge: (document.querySelector("#results .card .autobadge") || {}).textContent }));
  ok(st.first && st.first.id === "me2pt5-223" && /auto/.test(st.badge || ""), "full reply after it: Numel IR marked as the best guess");
  await lotEnd(); key = Date.now();
  await send({ type: "cardcomp-auto", key, n: 1, read: { card_visible: true, name: "Fomantis", number: "085", total: "084", language: "en", rarity: "Illustration Rare", confidence: 0.9 }, model: "claude-haiku-5-5", ms: 1300 });
  await ap.waitForTimeout(300);
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
  const lrec = await ap.evaluate((k) => { const rec = { startedAt: k, card: { id: "me5-85", n: "Fomantis", r: "Illustration Rare", label: "tap", cond: "NM" }, final: 3, me: true, title: "#8" }; window.recogLotDone(rec); return rec; }, key);
  await ap.waitForTimeout(150);
  const oc = (await posted()).filter((m) => m.type === "cardcomp-auto-outcome").pop();
  ok(oc && oc.key === key && oc.outcome.card.id === "me5-85" && oc.outcome.me === true && oc.outcome.card.r === "Illustration Rare", "lot end: tapped card reported as the outcome, with its rarity");
  ok(lrec.recog && lrec.recog.read.name === "Kyurem ex" && lrec.recog.read.number === "157" && lrec.recog.kind === "number-miss" && lrec.recog.sug === null && lrec.recog.ids.length > 0 && /opus/.test(lrec.recog.model), "the auction log row carries the lot's auto reading (Kyurem ex 157, no pick, listed ids)");
  // CardSight side by side, app: the shown answer fills (labelled CardSight), the shadow never touches the screen, the log
  // row carries both (rec.recog.src / rec.recog.alt)
  {
    await lotEnd(); await ap.waitForTimeout(1600); const ck = Date.now() + 20;
    await send({ type: "cardcomp-auto", key: ck, capAt: ck, n: 1, manual: true, src: "cardsight", model: "cardsight", ms: 420, short: 0, cs: { req: "r9", top: [{ conf: "High", name: "Fomantis" }] },
      read: { card_visible: true, name: "Fomantis", number: "085", total: "084", language: "en", rarity: "Illustration Rare", confidence: 0.95, box: [] } });
    await ap.waitForTimeout(250);
    await send({ type: "cardcomp-auto", key: ck, capAt: ck, n: 1, manual: true, shadow: true, src: "claude", model: "claude-sonnet-5-5", ms: 2100, short: 1080,
      read: { card_visible: true, name: "Honchkrow V", number: "161", total: "172", language: "en", rarity: "full art", confidence: 0.8 } });
    await ap.waitForTimeout(250);
    const cst = await ap.evaluate(() => ({ q: document.querySelector("#q").value, first: (document.querySelector("#results .card") || {}).dataset.id, line: document.querySelector("#autoline").textContent }));
    const crec = await ap.evaluate((k) => { const rec = { startedAt: k, at: k + 20000, card: { id: "me5-85", n: "Fomantis", label: "tap" }, final: 3, me: false }; window.recogLotDone(rec); return rec.recog; }, ck);
    const shm = (await posted()).filter((m) => m.type === "cardcomp-auto-match" && m.shadow).pop();
    ok(cst.q === "Fomantis 085/084" && cst.first === "me5-85" && /CardSight 0\.4s/.test(cst.line) && !/Honchkrow/.test(cst.line), "side by side: CardSight's answer fills and is labelled, Claude's shadow (Honchkrow) never shows (" + cst.line.replace(/\s+/g, " ").slice(0, 80) + ")");
    ok(crec && crec.src === "cardsight" && crec.sug && crec.sug.id === "me5-85" && crec.cs && crec.cs.req === "r9" && crec.alt && crec.alt.src === "claude" && crec.alt.read.name === "Honchkrow V" && crec.alt.sug && crec.alt.sug.id === "swsh9-162" && shm && shm.src === "claude",
      "side by side: the log row carries both answers (shown CardSight Fomantis, other Claude Honchkrow #162), the shadow match reported to the extension");
  }
  // read before the timer: shown as "before start"; the lot (created earlier, older key) reuses it; outcome maps to the lot
  await lotEnd(); await ap.waitForTimeout(50); const lotKey = Date.now(); await ap.waitForTimeout(30); const preKey = Date.now();
  await send({ type: "cardcomp-auto", key: preKey, capAt: preKey, n: 1, pre: true, read: { card_visible: true, name: "Numel", number: "", total: "", language: "en", rarity: "Illustration Rare", confidence: 0.9 }, model: "claude-haiku-5-5", ms: 1100 });
  await ap.waitForTimeout(250);
  st = await ap.evaluate(() => ({ line: document.querySelector("#autoline").textContent, first: (document.querySelector("#results .card") || {}).dataset }));
  ok(/before start: read Numel/.test(st.line.replace(/\s+/g, " ")) && st.first && st.first.id === "me2pt5-223", "read before the timer: shown as 'before start', Numel IR first");
  await send({ type: "cardcomp-auto-adopt", from: preKey, to: lotKey }); await ap.waitForTimeout(100);
  await ap.evaluate((k) => { const rec = { startedAt: k, card: { id: "me2pt5-223", n: "Numel", label: "view" }, final: 4, me: false }; window.recogLotDone(rec); window.__lastRecog = rec.recog; }, lotKey);
  await ap.waitForTimeout(150);
  const oc2 = (await posted()).filter((m) => m.type === "cardcomp-auto-outcome").pop();
  const lrec2 = await ap.evaluate(() => window.__lastRecog || null);
  ok(oc2 && oc2.key === lotKey && oc2.outcome.card.id === "me2pt5-223", "reused reading: the lot's outcome is reported under the lot");
  ok(lrec2 && lrec2.sug && lrec2.sug.id === "me2pt5-223" && /Illustration/.test(lrec2.sug.r) && lrec2.pre === true, "log row reading: suggested card with its rarity (" + (lrec2 && lrec2.sug ? lrec2.sug.n + ", " + lrec2.sug.r : "none") + "), read before the timer");
  // a read now before the timer that was never adopted (the seller moved the card): still this lot's reading at lot end
  await lotEnd(); const k7 = Date.now();
  await send({ type: "cardcomp-auto", key: k7, capAt: k7, n: 1, manual: true, read: { card_visible: true, name: "Numel", number: "", total: "", language: "en", rarity: "Illustration Rare", confidence: 0.9 }, model: "claude-sonnet-5-5", ms: 900 });
  await ap.waitForTimeout(250);
  const lr7 = await ap.evaluate((k) => { const rec = { startedAt: k + 4000, at: k + 30000, card: { id: "me2pt5-223", n: "Numel", label: "tap" }, final: 3, me: false }; window.recogLotDone(rec); return rec.recog || null; }, k7);
  await ap.waitForTimeout(150);
  const oc7 = (await posted()).filter((m) => m.type === "cardcomp-auto-outcome").pop();
  ok(lr7 && lr7.read.name === "Numel" && lr7.manual && oc7 && oc7.key === k7, "read now before the timer, never adopted: still logged as the lot's reading, outcome under the reading");
  await lotEnd();
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
  // a tap on a collapsed result records the printing its bid was priced from (the top printing), not ""
  await ap.fill("#q", "sylveon 040/131"); await ap.press("#q", "Enter"); await ap.waitForTimeout(400);
  const tp = await ap.evaluate(() => { const b = document.querySelector('#results .card[data-id="sv8pt5-40"]:not(.open) .bm b.cpy'); if (!b) return null; b.click(); return LAST_TAP && LAST_TAP.printing; });
  ok(tp === "Master Ball Holofoil", "collapsed tap: printing recorded (" + tp + ")");
  // a "Sold" flickering between lots must not wipe a bid tapped before the timer (gametower Sylveon, 2026-10-16)
  await ap.evaluate(() => { window.__logs = []; window.addEventListener("message", (e) => { if (e.data && e.data.type === "cardcomp-log-save") window.__logs.push(e.data.rec); }); });
  await send({ type: "cardcomp-lot-end", rec: { title: "#25", final: 5, bids: 6, startedAt: Date.now() - 30000, at: Date.now(), seller: "g" } });
  await send({ type: "cardcomp-lot", title: "#25", cur: 5, ended: true, sold: "x" }); await ap.waitForTimeout(2700);
  await ap.evaluate(() => document.querySelector('#results .card[data-id="sv8pt5-40"] .bm b.cpy').click()); await ap.waitForTimeout(150);
  await send({ type: "cardcomp-lot", title: "#25", cur: 5, ended: false }); await ap.waitForTimeout(80);
  await send({ type: "cardcomp-lot", title: "#25", cur: 5, ended: true, sold: "x" }); await ap.waitForTimeout(1800);
  await send({ type: "cardcomp-lot-end", rec: { title: "#26", final: 21, bids: 12, me: true, startedAt: Date.now(), at: Date.now() + 300, seller: "g" } }); await ap.waitForTimeout(3100);
  const fl = await ap.evaluate(() => window.__logs.filter((r) => r.title === "#26").pop());
  // finish read -> printing: mapped per card, warned when the tile bid is another printing, preselected on open
  const fk = await ap.evaluate(() => ["master ball pattern", "poke ball pattern", "reverse holo", "holo", "unknown"].map((f) => autoMatch({ card_visible: true, name: "Sylveon", number: "040", total: "131", language: "en", rarity: "Rare", stamp: "", finish: f, set: "Prismatic Evolutions", confidence: 0.9 }, { short: 1080, model: "claude-sonnet-5-5" }).printing));
  ok(fk.join("|") === "Master Ball Holofoil|Poké Ball Holofoil|Reverse Holofoil|Holofoil|", "finish read -> printing (" + fk.join(", ") + ")");
  await send({ type: "cardcomp-auto", key: Date.now(), capAt: Date.now(), n: 1, read: { card_visible: true, name: "Sylveon", number: "040", total: "131", language: "en", rarity: "Rare", stamp: "", finish: "reverse holo", set: "Prismatic Evolutions", confidence: 0.9 }, model: "claude-sonnet-5-5", ms: 1500, short: 1080 });
  await ap.waitForTimeout(300);
  const pl = await ap.textContent("#autoline");
  ok(/Reverse Holofoil/.test(pl) && /tile bid is Master Ball Holofoil \$[\d.]+, read Reverse Holofoil/.test(pl), "auto line names the printing read and warns the tile bid is the Master Ball price");
  await ap.click('#results .card[data-id="sv8pt5-40"] .row'); await ap.waitForTimeout(500);
  ok((await ap.evaluate(() => { const c = document.querySelector('#results .card[data-id="sv8pt5-40"] .pchip.on'); return c && c.dataset.k; })) === "Reverse Holofoil", "opening the card selects the printing read");
  await send({ type: "cardcomp-lot-end", rec: { empty: true, at: Date.now() } }); await ap.waitForTimeout(100);
  ok(fl && fl.card && fl.card.label === "tap" && fl.card.printing === "Master Ball Holofoil" && fl.bidsSent.length === 1, "Sold flicker between lots keeps the pre-start tap (Sylveon Master Ball)");
  // taps carry their lot (extension sends lotStart): a stray "Sold" while the next lot is live (pullsafaritcg) keeps them
  { const sA = Date.now() - 20000;
    await send({ type: "cardcomp-lot", title: "#40", cur: 2, bids: 3, ended: false, lotStart: sA, endSent: false });
    await send({ type: "cardcomp-lot-end", rec: { title: "#40", final: 2, bids: 3, startedAt: sA, at: Date.now(), seller: "p" } });
    await send({ type: "cardcomp-lot", title: "#40", cur: 2, ended: true, sold: "x", lotStart: sA, endSent: true }); await ap.waitForTimeout(2700);
    await ap.evaluate(() => document.querySelector('#results .card[data-id="sv8pt5-40"] .bm b.cpy').click()); await ap.waitForTimeout(100);   // between lots: for the next one
    const sB = Date.now();
    await send({ type: "cardcomp-lot", title: "#41", cur: 1, bids: 0, ended: false, lotStart: sB, endSent: false }); await ap.waitForTimeout(80);
    await send({ type: "cardcomp-lot", title: "#41", cur: 1, ended: true, sold: "x", lotStart: sB, endSent: false }); await ap.waitForTimeout(80);   // stray "Sold" mid-lot
    await send({ type: "cardcomp-lot", title: "#41", cur: 2, ended: false, lotStart: sB, endSent: false }); await ap.waitForTimeout(1700);
    await send({ type: "cardcomp-lot-end", rec: { title: "#41", final: 3, bids: 4, me: true, startedAt: sB, at: Date.now() + 200, seller: "p" } }); await ap.waitForTimeout(3000);
    const g = await ap.evaluate(() => window.__logs.filter((r) => r.title === "#41").pop());
    ok(g && g.card && g.card.label === "tap" && g.card.n === "Sylveon" && g.bidsSent.length === 1 && g.bidsSent[0].lot === "next", "tile bid tapped between lots keeps its lot through a stray 'Sold' (fast back-to-back lots)");
  }
  await ap.waitForTimeout(1700); await lotEnd();   // typing within 1.5 s of a frame counts as engaged
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
  // picture match, CardComp side: a reading with many printings asks for the ranking; a clear winner moves up, marked
  // language misread: an English set number read as Japanese switches to English (awholes, Mega Eelektross ex 266/217)
  await lotEnd();
  const kE = Date.now() + 18000;
  await send({ type: "cardcomp-auto", key: kE, capAt: kE, n: 1, manual: true, read: { card_visible: true, name: "Mega Eelektross ex", number: "266", total: "217", language: "jp", rarity: "Special Illustration Rare", confidence: 0.9 }, model: "claude-sonnet-5-5", ms: 1500, short: 1080 });
  await ap.waitForTimeout(300);
  st = await ap.evaluate(() => ({ first: (document.querySelector("#results .card") || {}).dataset.id, lang: LANG, badge: (document.querySelector("#results .card .autobadge") || {}).textContent }));
  ok(st.first === "me2pt5-266" && st.lang === "en" && st.badge === "auto?", "read as Japanese but 266/217 is only English: English Ascended Heroes #266 first, marked auto? (" + JSON.stringify(st) + ")");
  // an extension older than 0.7 (state without a version): nothing asked, the line says to reload it
  await lotEnd(); await ap.evaluate(() => { window.__posted.length = 0; });
  const rdChar = (k) => ({ type: "cardcomp-auto", key: k, capAt: k, n: 1, manual: true, read: { card_visible: true, name: "Charizard", number: "", total: "", language: "en", rarity: "", confidence: 0.9 }, model: "claude-sonnet-5-5", ms: 1200 });
  await send(rdChar(Date.now() + 19000)); await ap.waitForTimeout(300);
  ok(!(await posted()).some((m) => m.type === "cardcomp-auto-img") && /needs extension 0\.7/.test(await ap.textContent("#autoline")), "picture match with an old extension: not asked, the line says to reload it");
  await send({ type: "cardcomp-auto-state", on: true, mode: "auto", model: "sonnet", hasKey: true, ver: "0.7.1" });
  await lotEnd(); await ap.evaluate(() => { window.__posted.length = 0; });
  const pk2 = Date.now() + 20000; await send(rdChar(pk2)); await ap.waitForTimeout(300);
  ok(/picture: matching/.test(await ap.textContent("#autoline")), "picture match pending: the line says it is matching");
  const ask = (await posted()).find((m) => m.type === "cardcomp-auto-img");
  ok(ask && ask.key === pk2 && ask.cands.length > 8 && ask.cands.every((c) => /^https:\/\/(tcgplayer-cdn\.tcgplayer\.com|images\.pokemontcg\.io)\//.test(c.u)), "picture match: a reading with several printings asks for the ranking (" + (ask ? ask.cands.length : 0) + " pictures)");
  const ackFor = (k, want, other, sure) => ({ type: "cardcomp-auto-img-ack", key: k, n: 1, ok: true, ranked: [{ id: want, s: 0.71 }, { id: other, s: sure ? 0.52 : 0.69 }], v: { top: want, s: 0.71, group: [want], next: other, ns: sure ? 0.52 : 0.69, sure }, pics: 20, ms: 180, box: true });
  const want = ask.cands[7].id;
  // as extension 0.7.0-0.7.1 delivered it: the reply's own n (candidate count) over the reading's n
  await send(Object.assign(ackFor(pk2, want, ask.cands[0].id, true), { n: ask.cands.length })); await ap.waitForTimeout(250);
  st = await ap.evaluate(() => { const c = document.querySelector("#results .card"); return { first: (c || {}).dataset.id, badge: (document.querySelector("#results .card .autobadge") || {}).textContent, line: document.querySelector("#autoline").textContent, blue: c && c.classList.contains("bypic") && getComputedStyle(c).borderTopColor === "rgb(109, 181, 255)" }; });
  ok(st.blue, "picture-only pick: blue border");
  ok(st.first === want && st.badge === "picture" && /picture: Charizard/.test(st.line) && /best guess Charizard/.test(st.line) && !/no match/.test(st.line), "picture match: clear winner listed first, marked 'picture' (" + st.line.replace(/\s+/g, " ").slice(-70) + ")");
  // pointer over the results: nothing moves, "show" is offered
  await lotEnd(); await ap.evaluate(() => { window.__posted.length = 0; });
  const pk3 = Date.now() + 21000; await send(rdChar(pk3)); await ap.waitForTimeout(300);
  const ask3 = (await posted()).find((m) => m.type === "cardcomp-auto-img"), want3 = ask3.cands[9].id;
  const before3 = await ap.evaluate(() => document.querySelector("#results .card").dataset.id);
  await ap.hover("#results .card >> nth=1"); await ap.waitForTimeout(50);
  await send(ackFor(pk3, want3, ask3.cands[0].id, true)); await ap.waitForTimeout(250);
  st = await ap.evaluate(() => ({ first: document.querySelector("#results .card").dataset.id, show: !!document.querySelector("#autoshow") }));
  ok(st.first === before3 && st.show, "picture match: pointer over the results, no reorder under it, 'show' offered");
  await ap.click("#autoshow"); await ap.waitForTimeout(200);
  ok(await ap.evaluate(() => document.querySelector("#results .card").dataset.id) === want3, "picture match: 'show' puts the picture's pick first");
  // unsure: sorted by likeness, nothing marked as the picture's pick
  await ap.mouse.move(5, 5); await lotEnd(); await ap.evaluate(() => { window.__posted.length = 0; });
  const pk4 = Date.now() + 22000; await send(rdChar(pk4)); await ap.waitForTimeout(300);
  const ask4 = (await posted()).find((m) => m.type === "cardcomp-auto-img");
  await send(ackFor(pk4, ask4.cands[5].id, ask4.cands[6].id, false)); await ap.waitForTimeout(250);
  st = await ap.evaluate(() => ({ first: document.querySelector("#results .card").dataset.id, badge: (document.querySelector("#results .card .autobadge") || {}).textContent || "", line: document.querySelector("#autoline").textContent }));
  ok(st.first === ask4.cands[5].id && st.badge !== "picture" && /picture unsure/.test(st.line), "picture match unsure: sorted by likeness, no 'picture' mark");
  // the picture agrees with the auto pick: green border, "auto + picture"; the auto pick alone stays gold
  await lotEnd(); await ap.evaluate(() => { window.__posted.length = 0; });
  const pk5 = Date.now() + 23000;
  await send({ type: "cardcomp-auto", key: pk5, capAt: pk5, n: 1, manual: true, read: { card_visible: true, name: "Numel", number: "", total: "", language: "en", rarity: "Illustration Rare", confidence: 0.9 }, model: "claude-sonnet-5-5", ms: 900 });
  await ap.waitForTimeout(300);
  const sug5 = ((await posted()).find((m) => m.type === "cardcomp-auto-match") || {}).suggestion, ask5 = (await posted()).find((m) => m.type === "cardcomp-auto-img");
  const gold = await ap.evaluate(() => { const c = document.querySelector("#results .card.autosug"); return c && getComputedStyle(c).borderTopColor; });
  await send({ type: "cardcomp-auto-img-ack", key: pk5, n: 1, ok: true, cands: 3, ranked: [{ id: sug5, s: 0.7 }], v: { top: sug5, s: 0.7, group: [sug5], next: null, ns: null, sure: true }, pics: 3, ms: 90, box: true });
  await ap.waitForTimeout(250);
  st = await ap.evaluate(() => { const c = document.querySelector("#results .card.autosug"); return { id: c && c.dataset.id, both: c && c.classList.contains("byboth"), color: c && getComputedStyle(c).borderTopColor, badge: c && (c.querySelector(".autobadge") || {}).textContent }; });
  ok(sug5 && ask5 && gold === "rgb(245, 179, 1)" && st.id === sug5 && st.both && st.color === "rgb(95, 214, 160)" && st.badge === "auto + picture", "auto pick alone: gold border; picture agrees: green border, 'auto + picture' (" + JSON.stringify(st) + ")");
  await ap.screenshot({ path: path.join(OUT, "recog-pic-both.png") });
  await ap.click('#automodes span[data-m="manual"]'); await ap.waitForTimeout(100);
  ok((await posted()).some((m) => m.type === "cardcomp-auto-config" && m.mode === "manual"), "mode switch posts 'manual' to the extension");
  await send({ type: "cardcomp-auto-state", on: true, mode: "manual", model: "sonnet", hasKey: true }); await ap.waitForTimeout(100);
  ok(/press read/.test(await ap.textContent("#autoline")) && await ap.evaluate(() => { const b = document.querySelector("#readbig"); return b && getComputedStyle(b).display !== "none"; }), "manual mode: read button stays, line says to press read");
  await ap.click('#automodes span[data-m="off"]'); await ap.waitForTimeout(100);
  ok((await posted()).some((m) => m.type === "cardcomp-auto-config" && m.mode === "off"), "mode switch posts 'off' to the extension");
  // dashboard (not part of the experiment): made-up lots, two sellers, a win without a card
  const dash = await ap.evaluate(() => {
    const t = Date.now() - 3600e3, mk = (o) => Object.assign({ startedAt: o.at - 20000, bids: 5 }, o);
    localStorage.setItem("cardcomp_lots", "[]");
    storeLotRows([
      mk({ seller: "sellerA", at: t, final: 21, me: true, ship: 0.78, placedMax: 22, card: { id: "sv8pt5-40", n: "Sylveon", cond: "NM", printing: "Master Ball Holofoil", condMarket: 30.51, label: "tap", myMax: 22 } }),
      mk({ seller: "sellerA", at: t + 60000, final: 40, me: false, card: { id: "sv8pt5-40", n: "Sylveon", cond: "NM", printing: "Master Ball Holofoil", condMarket: 30.51, label: "view" } }),
      mk({ seller: "sellerB", at: t + 120000, final: 5, me: true, ship: 1.2 }),
    ].map(lotRow));
    DASH.per = "7"; dashOpen(true);
    const d = document.querySelector("#dash"), txt = d.innerText;
    const out = { open: getComputedStyle(d).display === "block", hash: location.hash, won: /Won\s+2/.test(txt), unl: /1 without a card/.test(txt),
      sellers: d.querySelectorAll("tr[data-s]").length, worth: (() => { const v = CARDS.find((c) => c.id === "sv8pt5-40").px["Master Ball Holofoil"]; return new RegExp("Worth today\\s+\\$" + (v.m != null ? v.m : v.l).toFixed(2).replace(".", "\\.")).test(txt); })(), best: /Sylveon/.test(d.querySelector(".d2").innerText) };
    d.querySelector('tr[data-s="sellerB"]').click(); out.filtered = /sellerB ✕/.test(d.innerText) && /Won\s+1/.test(d.innerText);
    return out;
  });
  ok(dash.open && dash.hash === "#dash" && dash.won && dash.unl && dash.sellers === 2 && dash.worth && dash.best && dash.filtered, "dashboard: tiles, worth today at the bought printing, streamers, seller filter " + JSON.stringify(dash));
  await ap.keyboard.press("Escape"); await ap.waitForTimeout(100);
  ok(await ap.evaluate(() => getComputedStyle(document.querySelector("#dash")).display === "none" && location.hash === ""), "dashboard: Esc closes it");
  // a win without a card: "+ card" from the dashboard, search, open, tap the condition -> stats row and log edit
  await ap.evaluate(() => { window.__edits = []; window.addEventListener("message", (e) => { if (e.data && e.data.type === "cardcomp-log-edit") window.__edits.push(e.data); }); dashOpen(true); });
  await ap.waitForTimeout(150); await ap.click("#dash .dadd"); await ap.waitForTimeout(200);
  await ap.fill("#q", "sylveon 040/131"); await ap.press("#q", "Enter"); await ap.waitForTimeout(400);
  await ap.click('#results .card[data-id="sv8pt5-40"] .row'); await ap.waitForTimeout(500);
  await ap.click('#results .card[data-id="sv8pt5-40"] .pickrow button[data-pc="LP"]'); await ap.waitForTimeout(300);
  const fx = await ap.evaluate(() => ({ row: loadLots().find((r) => r.s === "sellerB"), ed: window.__edits[0], dash: DASH.on, bar: document.querySelector("#pickbar").innerText }));
  ok(fx.row && fx.row.n === "Sylveon" && fx.row.c === "LP" && fx.row.lab === "fixed" && fx.row.m > 0 && fx.ed && fx.ed.key.seller === "sellerB" && fx.ed.card.label === "fixed" && fx.dash && /Added Sylveon LP/.test(fx.bar),
    "win without a card: + card, search, open, tap LP -> stats row and log edit (" + (fx.row && fx.row.n + " " + fx.row.c + " $" + fx.row.m) + ")");
  // a card put on the wrong win: "✕ card" clears it (stats row and log), "change" starts pick mode naming the current card
  ap.once("dialog", (dl) => dl.accept());
  await ap.evaluate(() => { window.__edits = []; DASH.per = "7"; DASH.seller = ""; dashOpen(true); }); await ap.waitForTimeout(150);
  await ap.evaluate(() => { const b = [...document.querySelectorAll("#dash .dclr")].find((x) => (loadLots().find((r) => r.k === x.dataset.k) || {}).s === "sellerB"); b.click(); });
  await ap.waitForTimeout(300);
  const cl = await ap.evaluate(() => ({ row: loadLots().find((r) => r.s === "sellerB"), ed: window.__edits[0], noCard: /no card/.test(document.querySelector("#dash").innerText) }));
  ok(cl.row && !cl.row.n && !(cl.row.m > 0) && cl.ed && cl.ed.clear === true && cl.ed.card === null && cl.noCard, "✕ card: the win is back to 'no card' here and the log gets the removal");
  await ap.evaluate(() => { const b = [...document.querySelectorAll("#dash .dchg")].find((x) => (loadLots().find((r) => r.k === x.dataset.k) || {}).s === "sellerA"); b.click(); });
  await ap.waitForTimeout(200);
  ok(/Changing the card on your \$21 win \(now Sylveon\)/.test(await ap.textContent("#pickbar")), "change: pick mode names the card it replaces");
  await ap.click("#pickbar .pickx"); await ap.evaluate(() => dashOpen(false));
  // buyers: 3 known-card wins at ~80% of market -> sharp; in the room and leading -> the strip says so
  const by = await ap.evaluate(() => {
    const t = Date.now() - 7200e3, rows = [0, 1, 2].map((i) => lotRow({ seller: "s9", startedAt: t + i * 60000 - 20000, at: t + i * 60000, final: 8, bids: 6, winner: "sharpie", me: false, card: { id: "sv8pt5-40", n: "Sylveon", cond: "NM", condMarket: 10, label: "view" } }));
    storeLotRows(rows); const b = buyerProfiles().get("sharpie"); return b && b.tags.join(",");
  });
  await send({ type: "cardcomp-lot-end", rec: { title: "#90", final: 2, bids: 2, startedAt: Date.now() - 20000, at: Date.now(), seller: "s9", room: { sharpie: { ago: 2 } }, leaders: [] } });
  await send({ type: "cardcomp-lot", title: "#91", cur: 3, bids: 2, timer: "00:10", lead: "sharpie", seller: "s9", ended: false, lotStart: Date.now() });
  await ap.waitForTimeout(200);
  const strip = await ap.evaluate(() => document.querySelector("#lotstrip").innerText.replace(/\s+/g, " "));
  ok(by === "sharp" && /sharp buyer leads: sharpie/.test(strip) && /here: sharp 1/.test(strip), "buyers: 3 wins at 80% of market tag 'sharp'; in the room and leading, the strip says so (" + strip.slice(0, 80) + ")");
  await send({ type: "cardcomp-lot-end", rec: { title: "#91", final: 3, bids: 2, startedAt: Date.now() - 20000, at: Date.now(), seller: "s9", room: {} } }); await ap.waitForTimeout(2800);
  // dashboard daily charts: lots on two days -> spent / net / running net charts and the "where lots sell" strip
  const dch = await ap.evaluate(() => {
    const d1 = Date.now() - 2 * 86400000, d2 = Date.now() - 86400000, mk = (o) => lotRow(Object.assign({ startedAt: o.at - 20000, bids: 3, seller: "sD" }, o));
    storeLotRows([mk({ at: d1, final: 5, me: true, card: { id: "sv8pt5-40", n: "Sylveon", cond: "NM", condMarket: 10, label: "tap" } }),
      mk({ at: d2, final: 9, me: true, card: { id: "sv8pt5-40", n: "Sylveon", cond: "NM", condMarket: 8, label: "tap" } })]);
    DASH.per = "7"; DASH.seller = "sD"; dashOpen(true);
    const svgs = document.querySelectorAll("#ddaily svg").length, strip = !!document.querySelector("#dstrip svg"), cols = document.querySelectorAll("#ddaily svg")[1].querySelectorAll("path").length;
    const hit = document.querySelectorAll("#ddaily .dhit"); hit[hit.length - 1].dispatchEvent(new PointerEvent("pointerenter"));
    const tip = document.querySelector("#ddaily .dtip").textContent;
    DASH.seller = ""; dashOpen(false); localStorage.setItem("cardcomp_lots", JSON.stringify(loadLots().filter((r) => r.s !== "sD")));
    return { svgs, strip, cols, tip };
  });
  ok(dch.svgs === 3 && dch.strip && dch.cols === 2 && /running net/.test(dch.tip), "dashboard: daily spent / net / running net charts and the where-lots-sell strip (" + dch.tip.replace(/\s+/g, " ").slice(0, 60) + ")");
  // wide window with stats open: the cart bar sits in the app column, not under the stats panel
  const cartPos = await ap.evaluate(async () => { addToCart({ id: "sv8pt5-40", n: "Sylveon", s: "Prismatic Evolutions", printing: "Holofoil", market: 5, cond: "NM", y: 2025, lang: "en", game: "pkmn", r: "Rare" }); LOTSTATS_OPEN = true; paintLotStats(); return 1; });
  await ap.setViewportSize({ width: 1180, height: 900 }); await ap.waitForTimeout(200);
  const cp = await ap.evaluate(() => ({ cart: document.querySelector("#cart").getBoundingClientRect().right, stats: document.querySelector("#lotstats").getBoundingClientRect().left }));
  ok(cartPos && cp.cart <= cp.stats, "wide window: cart bar ends at " + Math.round(cp.cart) + " px, stats panel starts at " + Math.round(cp.stats) + " px");
  await ap.evaluate(() => { LOTSTATS_OPEN = false; paintLotStats(); CART.length = 0; try { renderCart(); } catch (_) {} }); await ap.setViewportSize({ width: 660, height: 900 });
  ok(ap.errors.length === 0, "no page errors (" + (ap.errors[0] || "") + ")");
  console.log("  app screenshot: " + path.join(OUT, "recog-app-auto.png"));
  await ap.close();

  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
