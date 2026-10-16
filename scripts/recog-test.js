#!/usr/bin/env node
// Screenshot test for auto-recognition (docs/auto-recognition-handoff.md, "Suggested first step").
// Runs stream screenshots through Claude vision models, scores name / number / final CardComp match.
//
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/recog-test.js --shots ~/shots
//
// ~/shots holds the screenshots plus labels.csv:
//   file,name,number,total,lang,notes
//   IMG_0001.png,Maushold ex,233,182,en,sleeved
//   IMG_0002.png,Charizard,4,102,en,glare
//   IMG_0003.png,Pikachu,25,,jp,
// lang defaults to en. total may be blank (promos). notes is free text.
//
// Options
//   --models haiku,sonnet     short names or full ids (default: claude-haiku-5-5,claude-sonnet-5-5)
//   --crop x,y,w,h            fraction of the frame to keep, e.g. 0.25,0,0.5,1 (default: whole frame)
//   --max-edge 1000           downscale so the long edge is at most this (default 1000)
//   --effort low|medium|high  output_config.effort (default low: latency matters more than depth)
//   --concurrency 4
//   --fake                    no API call: feed the label back as the model answer (tests scoring + CardComp)
//   --dry-run                 print one request body (image data elided) and stop
//   --no-app                  skip the headless CardComp step (name/number only)
//
// Needs playwright (preinstalled in the cloud session; locally: npm i playwright && npx playwright install chromium).
// Writes results.md + results.json into the shots dir. No deps beyond playwright; raw fetch, same as bg.js will use.

const fs = require("fs"), path = require("path"), http = require("http");

const PRICES = {   // $/MTok in, out (claude-api skill, cached 2026-10-06)
  "claude-haiku-5-5": [0.10, 0.50], "claude-sonnet-5-5": [2, 10], "claude-opus-5-5": [4, 20]
};
const SHORT = { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" };

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf("--" + k); return i < 0 ? d : (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true); };
const SHOTS = opt("shots", "");
const MODELS = String(opt("models", "haiku,sonnet")).split(",").map(s => SHORT[s.trim()] || s.trim());
const CROP = opt("crop", "") ? String(opt("crop")).split(",").map(Number) : null;
const MAX_EDGE = +opt("max-edge", 1000);
const EFFORT = opt("effort", "low");
const CONC = +opt("concurrency", 4);
const FAKE = !!opt("fake", false), DRY = !!opt("dry-run", false), NOAPP = !!opt("no-app", false);
const API = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
const KEY = process.env.ANTHROPIC_API_KEY || "";
const REPO = path.resolve(__dirname, "..");

if (!SHOTS || !fs.existsSync(path.join(SHOTS, "labels.csv"))) die("need --shots <dir> containing labels.csv (see header of this script)");
if (!KEY && !FAKE && !DRY) die("ANTHROPIC_API_KEY not set (console.anthropic.com key; billed separately from the Claude subscription)");
if (!FAKE && !DRY) for (const m of MODELS) if (!PRICES[m]) console.warn("no price table for " + m + ", cost will show 0");

function die(m) { console.error(m); process.exit(1); }

// ---------- labels ----------
function parseCSV(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}
function loadLabels() {
  const rows = parseCSV(fs.readFileSync(path.join(SHOTS, "labels.csv"), "utf8"));
  const head = rows.shift().map(h => h.trim().toLowerCase());
  const col = n => head.indexOf(n);
  if (col("file") < 0 || col("name") < 0) die("labels.csv needs at least file,name columns (then number,total,lang,notes)");
  const out = [];
  for (const r of rows) {
    const g = n => (col(n) < 0 ? "" : (r[col(n)] || "")).trim();
    const file = g("file"); if (!file) continue;
    if (!fs.existsSync(path.join(SHOTS, file))) { console.warn("missing " + file + ", skipped"); continue; }
    out.push({ file, name: g("name"), number: g("number"), total: g("total"), lang: (g("lang") || "en").toLowerCase(), notes: g("notes") });
  }
  return out;
}

// ---------- normalisation + scoring ----------
const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/pokemon/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const depad = s => String(s || "").toLowerCase().trim().replace(/^0+(?=\d)/, "");
const nameOK = (got, exp) => !!norm(exp) && norm(got) === norm(exp);
const nameLoose = (got, exp) => { const g = " " + norm(got) + " ", e = " " + norm(exp) + " "; return !!norm(exp) && !!norm(got) && (g.includes(e) || e.includes(g)); };
const numOK = (got, exp) => !!depad(exp) && depad(got) === depad(exp);

// ---------- image prep (crop + downscale in a headless page; no image libs needed) ----------
async function prepImage(page, file) {
  const buf = fs.readFileSync(path.join(SHOTS, file));
  const ext = path.extname(file).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
  return page.evaluate(async ({ dataUrl, crop, maxEdge }) => {
    const img = new Image(); img.src = dataUrl; await img.decode();
    let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
    if (crop) { sx = Math.round(sw * crop[0]); sy = Math.round(sh * crop[1]); sw = Math.round(sw * crop[2]); sh = Math.round(sh * crop[3]); }
    const k = Math.min(1, maxEdge / Math.max(sw, sh));
    const w = Math.round(sw * k), h = Math.round(sh * k);
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
    const out = c.toDataURL("image/jpeg", 0.85);
    return { b64: out.slice(out.indexOf(",") + 1), w, h, srcW: img.naturalWidth, srcH: img.naturalHeight, tokens: Math.ceil(w / 28) * Math.ceil(h / 28) };   // one visual token per 28x28 patch (vision docs)
  }, { dataUrl, crop: CROP, maxEdge: MAX_EDGE });
}

// ---------- the vision call ----------
const SYSTEM = `You identify Pokemon trading cards in screenshots of a Whatnot livestream. Exactly one card is being shown to the camera, held in hand or in a sleeve or top-loader. Ignore cards on stands, in binders or on the table behind it, and ignore the chat and the page UI. Read only what is printed on the card held in front. Never guess a number you cannot read: return "" instead.`;
const ASK = `Return the card held in front:
- name: the card name exactly as printed, including a suffix like ex, EX, GX, V, VMAX, VSTAR, LV.X, or an owner prefix like "Team Rocket's" ("" if unreadable)
- number: the collector number printed at the bottom (digits or code before the slash, e.g. 233 or SV049 or TG12), "" if unreadable
- set_total: the digits after the slash (e.g. 182), "" if there is no slash or it is unreadable
- language: en, jp, or other
- foreground_card_confidence: 0 to 1, how sure you are the card you read is the one being shown and not a background card
- notes: at most 12 words (glare, finger over number, sleeve, etc.)`;
const SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["name", "number", "set_total", "language", "foreground_card_confidence", "notes"],
  properties: {
    name: { type: "string" }, number: { type: "string" }, set_total: { type: "string" },
    language: { type: "string", enum: ["en", "jp", "other"] },
    foreground_card_confidence: { type: "number" }, notes: { type: "string" }
  }
};
function body(model, img, structured, effort) {
  const b = {
    model, max_tokens: 300, system: SYSTEM,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: img.b64 } },
      { type: "text", text: ASK + (structured ? "" : "\nAnswer with one JSON object only, keys name, number, set_total, language, foreground_card_confidence, notes.") }
    ] }]
  };
  const oc = {};
  if (effort) oc.effort = effort;
  if (structured) oc.format = { type: "json_schema", schema: SCHEMA };   // output_config.format, GA, no beta header (structured-outputs docs)
  if (Object.keys(oc).length) b.output_config = oc;
  return b;
}
async function identify(model, img) {
  let structured = true, effort = EFFORT, tries = 0;
  for (;;) {
    const t0 = Date.now();
    const r = await fetch(API + "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body(model, img, structured, effort))
    });
    const ms = Date.now() - t0;
    const txt = await r.text();
    if (r.status === 400 && effort && /effort/i.test(txt)) { effort = ""; continue; }                                   // effort rejected on this model: drop it
    if (r.status === 400 && structured && /output_config|format|json_schema/i.test(txt)) { structured = false; continue; }   // structured outputs rejected: plain JSON in text
    if ((r.status === 429 || r.status >= 500) && tries++ < 2) { await new Promise(s => setTimeout(s, 1500 * tries)); continue; }
    if (!r.ok) return { error: `${r.status} ${txt.slice(0, 200)}`, ms };
    const j = JSON.parse(txt);
    const text = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    let out = null;
    try { out = JSON.parse(text); } catch (_) { const m = text.match(/\{[\s\S]*\}/); if (m) { try { out = JSON.parse(m[0]); } catch (_) {} } }
    const u = j.usage || {}, p = PRICES[model] || [0, 0];
    const cost = ((u.input_tokens || 0) * p[0] + (u.output_tokens || 0) * p[1]) / 1e6;
    return { out, ms, structured, stop: j.stop_reason, in: u.input_tokens || 0, outTok: u.output_tokens || 0, cost, raw: out ? undefined : text.slice(0, 200) };
  }
}

// ---------- headless CardComp (serves the repo, drives run() in the real app) ----------
async function startApp(chromium) {
  const srv = http.createServer((req, res) => {
    const p = path.join(REPO, decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html");
    if (!p.startsWith(REPO) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": p.endsWith(".json") ? "application/json" : "text/html; charset=utf-8" });
    fs.createReadStream(p).pipe(res);
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());   // no live.json / images from the sandbox
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  const query = async (q, lang) => page.evaluate(({ q, lang }) => {
    if (typeof setGame === "function") setGame("pkmn");
    if (typeof setLang === "function") setLang(lang === "jp" ? "jp" : "en", true);
    run(q);
    return [...document.querySelectorAll("#results .card")].slice(0, 3).map(el => {
      const c = CARDS.find(x => x.id === el.dataset.id) || {};
      return { id: c.id, n: c.n, s: c.s, num: c.num, lang: c.lang || "en", sz: (SET_SIZE[c.s] || []) };
    });
  }, { q, lang });
  return { query, close: async () => { await browser.close(); srv.close(); } };
}
const queryFor = (name, number, total) => [name, number ? (number + (total ? "/" + total : "")) : ""].filter(Boolean).join(" ").trim();
function cardMatches(c, exp) {
  if (!c) return false;
  if (!nameLoose(c.n, exp.name)) return false;
  if (depad(exp.number) && depad(c.num) !== depad(exp.number)) return false;
  if (exp.total && c.sz.length && !c.sz.includes(+exp.total)) return false;
  return true;
}

// ---------- run ----------
async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { for (;;) { const k = i++; if (k >= items.length) return; out[k] = await fn(items[k], k); } }));
  return out;
}
const pct = (a, b) => b ? Math.round(100 * a / b) + "%" : "n/a";
const med = xs => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const p90 = xs => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] : 0; };

(async () => {
  const labels = loadLabels();
  if (!labels.length) die("no usable rows in labels.csv");
  console.log(`${labels.length} shots, models ${MODELS.join(", ")}, crop ${CROP ? CROP.join(",") : "none"}, max edge ${MAX_EDGE}, effort ${EFFORT}${FAKE ? ", FAKE answers" : ""}`);

  let chromium; try { ({ chromium } = require("playwright")); } catch (_) { die("playwright not found: npm i playwright && npx playwright install chromium"); }
  const browser = await chromium.launch(); const prepPage = await browser.newPage();

  // images
  const imgs = {};
  if (!FAKE) for (const l of labels) { imgs[l.file] = await prepImage(prepPage, l.file); }
  await browser.close();
  const tokEst = Object.values(imgs).map(i => i.tokens);
  if (tokEst.length) console.log(`image tokens per shot ~${med(tokEst)} (median), sizes ${imgs[labels[0].file].w}x${imgs[labels[0].file].h} from ${imgs[labels[0].file].srcW}x${imgs[labels[0].file].srcH}`);

  if (DRY) {
    const b = body(MODELS[0], imgs[labels[0].file], true, EFFORT);
    b.messages[0].content[0].source.data = `<${imgs[labels[0].file].b64.length} base64 chars>`;
    console.log("POST " + API + "/v1/messages\n" + JSON.stringify(b, null, 2));
    return;
  }

  // the model calls
  const results = {};   // model -> file -> result
  for (const model of MODELS) {
    results[model] = {};
    const t0 = Date.now();
    await mapLimit(labels, CONC, async l => {
      results[model][l.file] = FAKE
        ? { out: { name: l.name, number: l.number, set_total: l.total, language: l.lang, foreground_card_confidence: 1, notes: "fake" }, ms: 0, in: 0, outTok: 0, cost: 0 }
        : await identify(model, imgs[l.file]);
    });
    console.log(`${model}: ${labels.length} calls in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }

  // CardComp match (the thing that actually matters): query the real app with the model's answer
  let app = null;
  if (!NOAPP) {
    app = await startApp(chromium);
    for (const l of labels) {
      const truth = await app.query(queryFor(l.name, l.number, l.total), l.lang);   // ceiling: does the correct label itself resolve?
      l.truthTop = truth[0] || null; l.truthOK = cardMatches(truth[0], l);
      for (const model of MODELS) {
        const r = results[model][l.file]; if (!r.out) continue;
        const lang = r.out.language === "jp" ? "jp" : r.out.language === "en" ? "en" : l.lang;
        const q = queryFor(r.out.name, r.out.number, r.out.set_total);
        r.query = q; r.top = q ? await app.query(q, lang) : [];
        r.top1 = cardMatches(r.top[0], l); r.top3 = r.top.some(c => cardMatches(c, l));
      }
    }
    await app.close();
  }

  // summary
  const lines = [];
  const P = s => { lines.push(s); console.log(s); };
  P(`# Recognition test  ${new Date().toISOString().slice(0, 16).replace("T", " ")}\n`);
  P(`${labels.length} shots · crop ${CROP ? CROP.join(",") : "none"} · max edge ${MAX_EDGE} · effort ${EFFORT}${FAKE ? " · FAKE (labels fed back as answers)" : ""}\n`);
  if (app) P(`Label resolves in CardComp (ceiling): ${pct(labels.filter(l => l.truthOK).length, labels.length)}${labels.some(l => !l.truthOK) ? "  (unresolved: " + labels.filter(l => !l.truthOK).map(l => l.file).join(", ") + ")" : ""}\n`);
  P(`| model | name | name loose | number | CardComp top 1 | top 3 | median s | p90 s | errors | $ total | $ per card |`);
  P(`|---|---|---|---|---|---|---|---|---|---|---|`);
  const summary = {};
  for (const model of MODELS) {
    const rs = labels.map(l => results[model][l.file]);
    const ok = rs.filter(r => r.out);
    const n = labels.length;
    const s = {
      name: ok.filter((r, i) => nameOK(r.out.name, labels[rs.indexOf(r)].name)).length,
      loose: ok.filter(r => nameLoose(r.out.name, labels[rs.indexOf(r)].name)).length,
      num: ok.filter(r => numOK(r.out.number, labels[rs.indexOf(r)].number)).length,
      top1: rs.filter(r => r.top1).length, top3: rs.filter(r => r.top3).length,
      errors: rs.filter(r => !r.out).length,
      ms: rs.filter(r => r.ms).map(r => r.ms), cost: rs.reduce((a, r) => a + (r.cost || 0), 0)
    };
    summary[model] = s;
    P(`| ${model} | ${pct(s.name, n)} | ${pct(s.loose, n)} | ${pct(s.num, n)} | ${app ? pct(s.top1, n) : "-"} | ${app ? pct(s.top3, n) : "-"} | ${(med(s.ms) / 1000).toFixed(1)} | ${(p90(s.ms) / 1000).toFixed(1)} | ${s.errors} | $${s.cost.toFixed(4)} | $${(s.cost / n).toFixed(5)} |`);
  }
  P(`\nBar from the handoff: right card in the top result 85%+. Monthly cost at ~2,600 lots = per card x 2600 (x frames per lot).\n`);
  P(`| shot | expected | ${MODELS.map(m => m.replace("claude-", "")).join(" | ")} |`);
  P(`|---|---|${MODELS.map(() => "---").join("|")}|`);
  for (const l of labels) {
    const cells = MODELS.map(m => {
      const r = results[m][l.file];
      if (!r.out) return "ERR " + (r.error || r.raw || "no JSON").replace(/\|/g, "/");
      const got = `${r.out.name || "?"} ${r.out.number || "?"}${r.out.set_total ? "/" + r.out.set_total : ""} ${r.out.language || ""}`;
      const mark = app ? (r.top1 ? "✓" : r.top3 ? "~3" : "✗") : (nameOK(r.out.name, l.name) && numOK(r.out.number, l.number) ? "✓" : "✗");
      const top = app && r.top && r.top[0] && !r.top1 ? ` → ${r.top[0].n} ${r.top[0].s} #${r.top[0].num}` : "";
      return `${mark} ${got}${top} (${(r.ms / 1000).toFixed(1)}s${r.out.notes ? ", " + r.out.notes : ""})`.replace(/\|/g, "/");
    });
    P(`| ${l.file} | ${l.name} ${l.number}${l.total ? "/" + l.total : ""} ${l.lang}${l.truthOK === false ? " (label unresolved)" : ""} | ${cells.join(" | ")} |`);
  }
  fs.writeFileSync(path.join(SHOTS, "results.md"), lines.join("\n") + "\n");
  fs.writeFileSync(path.join(SHOTS, "results.json"), JSON.stringify({ when: new Date().toISOString(), options: { models: MODELS, crop: CROP, maxEdge: MAX_EDGE, effort: EFFORT, fake: FAKE }, summary, labels, results }, null, 1));
  console.log(`\nwrote ${path.join(SHOTS, "results.md")} and results.json`);
})().catch(e => { console.error(e); process.exit(1); });
