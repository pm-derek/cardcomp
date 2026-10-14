#!/usr/bin/env node
/*
  CardComp ingest  ->  data.json        (Node 18+, NO dependencies)

  Builds ONE lean file the app loads: every Pokemon card worth bidding on
  (English + Japanese), each with its identity AND its TCGplayer prices baked in.

  Sources:
    - English identity (name/set/number/attacks/hp/image) : pokemon-tcg-data on GitHub
    - English prices + promo/unmatched identity            : TCGCSV  (category: Pokemon)
    - Japanese identity + prices                           : TCGCSV  (category: Pokemon Japan)

  COVERAGE MODEL (v3):
    Every English TCGCSV *card* product becomes an entry. If it joins to a
    pokemon-tcg-data card (set mapped + number matches), it gets the rich
    identity (types/HP/attacks). If it does NOT join, it is emitted standalone
    straight from TCGCSV (name/set/number/rarity/image/price) — exactly like the
    Japanese path. Coverage no longer depends on the set-name matcher, so promos
    ("XY Promos", "McDonald's 25th Anniversary Promos") and older ex whose
    numbering doesn't line up stop getting silently dropped.

  Prune: a card is kept only if its best printing's market (or low) >= FLOOR.
  Set-agnostic and self-healing — a bulk card that spikes reappears next run.

  RUN:  node ingest.js     ->  writes ./data.json   (deploy beside index.html)
*/
const fs = require("fs");
const { execSync } = require("child_process");
const FORCE = process.env.FORCE === "1";   // accept a big coverage drop (manual run, "force" input)
const GH = "https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master";
const TC = "https://tcgcsv.com/tcgplayer";
const UA = "CardComp-Ingest/3.0 (East Bay Trader)";
const SLEEP = 120;
const FLOOR = 1.50;                 // keep only cards whose best printing >= this (USD)
const INCLUDE_JP = true;            // set false to skip Japanese
const INCLUDE_LORCANA = true;       // set false to skip Disney Lorcana
const INCLUDE_ONEPIECE = true;      // set false to skip One Piece Card Game
const EN_CAT = 3;                   // TCGCSV category id for English Pokemon

// Force an English set to a specific TCGCSV group if auto-match is wrong (see report).
// With v3 this only affects identity ENRICHMENT, not coverage — an unmatched set's
// cards still come through as TCGCSV standalones, just with less metadata.
const OVERRIDE = {
  "base1": "Base Set",
  "base4": "Base Set 2",
  "swshp": "SWSH: Sword & Shield Promo Cards",
  "svp": "SV: Scarlet & Violet Promo Cards",
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => (s||"").toLowerCase().replace(/[^a-z0-9]/g,"");
const setTail = n => { const p = n.split(/:\s|\s-\s/); return p[p.length-1].trim(); };
const r2 = c => c == null ? null : Math.round(c * 100) / 100;

async function getJSON(url){   // 3 tries with backoff: a transient TCGCSV hiccup must not silently drop a set
  let err;
  for (let i = 0; i < 3; i++){
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error("HTTP " + res.status + " " + url);
      return await res.json();
    } catch (e) { err = e; await sleep(1000 * (i + 1) * 2); }
  }
  throw err;
}
const FAILED = [];   // groups/sets we could not fetch even after retries; reported, and the guard fails the run on too many
// "4/102" -> set size. Collected per set name so the app can narrow "charizard 4/102" to sets printed out of 102.
const SZ = {};
function noteSize(setName, number){
  const m = String(number||"").match(/\/\s*0*(\d{1,3})\s*$/); if (!m) return;
  (SZ[setName] || (SZ[setName] = new Set())).add(+m[1]);
}
async function getText(url){
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  return (await res.text()).trim();
}

const GENERIC = new Set(["base","set","the","and","of","cards","series","pokemon","tcg"]);
const toks = s => (s.toLowerCase().match(/[a-z0-9]+/g)) || [];
function score(name, g){
  const Q = toks(name);
  const tailT = toks(setTail(g.name));
  // all of the set name's words appear in the group's set-name portion?
  if (Q.length && Q.every(t => tailT.includes(t))){
    const extra = tailT.filter(t => !Q.includes(t) && !GENERIC.has(t)); // distinctive extras = a DIFFERENT set
    if (extra.length === 0) return 100;   // the base/exact set
    if (extra.length === 1) return 70;
    return 50;
  }
  // fallbacks: whole-name substring, then token overlap
  if (norm(g.name).includes(norm(name))) return 45;
  const G = new Set(toks(g.name)); let i = 0; Q.forEach(t => { if (G.has(t)) i++; });
  return Q.length ? Math.round(i / Q.length * 40) : 0;
}

function priceMap(rows){            // productId -> {subTypeName: {m,l}}
  const pm = {};
  for (const row of rows){
    let m = row.marketPrice; if (m == null) m = row.midPrice;
    const l = row.lowPrice;
    if (m == null && l == null) continue;
    (pm[row.productId] || (pm[row.productId] = {}))[row.subTypeName] = { m: r2(m), l: r2(l) };
  }
  return pm;
}
function bestPrice(px){
  let best = 0;
  for (const k in px){ const v = px[k]; const p = (v.m != null ? v.m : v.l) || 0; if (p > best) best = p; }
  return best;
}
// normalised product/card name for matching: no accents, no punctuation, collapsed spaces
function pname(x){
  return String(x||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase().replace(/[^a-z0-9 ]+/g," ").replace(/\s+/g," ").trim();
}
function num0(s){
  let n = String(s).split("/")[0].trim().replace(/^SVP/i, "");
  if (/^\d+$/.test(n)) n = String(parseInt(n, 10));     // 029 -> 29
  return n;
}

// Sealed product kinds, matched on TCGCSV product name (first match wins). Add patterns freely.
const SEALED_KINDS = [
  ["Pokémon Center ETB", /pok[eé]mon center.*(?:elite trainer box|etb)/i],
  ["ETB",                /elite trainer box|\betb\b/i],
  ["UPC",                /ultra premium collection|\bupc\b/i],
  ["Booster Box",        /booster box/i],
  ["Booster Display",    /booster display/i],
  ["Booster Bundle",     /booster bundle/i],
  ["Sleeved Booster",    /sleeved booster|check\s?lane|blister/i],
  ["Booster Pack",       /booster pack/i],
  ["Build & Battle",     /build\s*&?\s*(?:and\s*)?battle/i],
  ["Premium Collection", /premium collection|premium figure/i],
  ["Special Collection", /special collection|collection box|figure collection|poster collection/i],
  ["Tin",                /\bmini tin\b|\btin\b/i],
  ["Pin Collection",     /pin collection|pin box/i],
  ["Box Set",            /box set|battle deck|theme deck|starter (?:set|deck)|gift box|holiday calendar|advent|trainer'?s toolkit|battle academy/i],
];
function classifySealed(name){
  for (const [kind, re] of SEALED_KINDS) if (re.test(name)) return kind;
  return null;
}

async function categoryId(want){
  const cats = (await getJSON(`${TC}/categories`)).results || [];
  const hit = cats.find(c => (c.name||"").toLowerCase() === want.toLowerCase())
           || cats.find(c => (c.name||"").toLowerCase().includes(want.toLowerCase()));
  return hit ? hit.categoryId : null;
}

async function englishCards(){
  // 1) pokemon-tcg-data identity ------------------------------------------------
  const sets = await getJSON(`${GH}/sets/en.json`);
  const byId = {}; const cards = [];
  for (const sm of sets){
    let raw; try { raw = await getJSON(`${GH}/cards/en/${sm.id}.json`); } catch { FAILED.push("pokemon-tcg-data " + sm.id); continue; }
    if (sm.printedTotal) (SZ[sm.name] || (SZ[sm.name] = new Set())).add(sm.printedTotal);
    const year = parseInt((sm.releaseDate||"0").split("/")[0]) || 0;
    for (const c of raw){
      const atk = [...(c.attacks||[]), ...(c.abilities||[])].map(a => a.name||"").join(" ");
      const card = { id:c.id, n:c.name, s:sm.name, c:sm.ptcgoCode||"", y:year, num:c.number,
        r:c.rarity||"", hp:c.hp||"", t:c.types||[], st:c.subtypes||[],
        atk, img:(c.images||{}).small||"", lang:"en" };
      cards.push(card); byId[c.id] = card;
    }
  }
  console.log(`EN identity: ${cards.length} cards / ${sets.length} sets`);

  // 2) which TCGCSV group does each pokemon-tcg-data set claim? -----------------
  const groups = (await getJSON(`${TC}/${EN_CAT}/groups`)).results;
  const claim = {};                 // groupId -> {setId, setName, score}
  for (const sm of sets){
    let g = null, sc = -1;
    if (OVERRIDE[sm.id]){
      g = groups.find(x => x.name === OVERRIDE[sm.id]); sc = 1000;
      if (!g){ console.log(`  ! OVERRIDE for ${sm.id} ("${OVERRIDE[sm.id]}") matched NO group — fix the name`); continue; }
    } else {
      let best = null, bs = -1; for (const x of groups){ const s = score(sm.name, x); if (s > bs){ bs = s; best = x; } }
      if (bs >= 35){ g = best; sc = bs; }
    }
    if (!g) continue;
    const cur = claim[g.groupId];
    if (!cur || sc > cur.score) claim[g.groupId] = { setId: sm.id, setName: sm.name, score: sc };
  }

  // 3) walk EVERY group; enrich on join, emit standalone otherwise --------------
  const standalones = [];
  const sealed = [];                // sealed product (ETBs, boxes, UPCs…), classified by kind
  const report = [];                // groups that produced only standalones (likely promos/specials)
  let totalEnriched = 0, totalStandalone = 0, totalSealed = 0;
  for (const g of groups){
    let products, prices;
    try {
      products = (await getJSON(`${TC}/${EN_CAT}/${g.groupId}/products`)).results; await sleep(SLEEP);
      prices   = (await getJSON(`${TC}/${EN_CAT}/${g.groupId}/prices`)).results;   await sleep(SLEEP);
    } catch { FAILED.push("EN " + g.name); continue; }
    const pm = priceMap(prices);
    const setId = claim[g.groupId] ? claim[g.groupId].setId : null;
    // sealed rows must share the joined set name so a set-scoped search (e.g. "chaos rising")
    // matches both singles and sealed; TCGCSV group names carry prefixes ("ME04: Chaos Rising")
    // that the enriched singles don't. Fall back to the group name when no set is claimed.
    const setName = claim[g.groupId] ? claim[g.groupId].setName : g.name;
    const gyear = parseInt((g.publishedOn||"0").slice(0,4)) || 0;
    // "(Shadowless)" groups fold into the matching base card as "Shadowless …" printings (Base Set etc.)
    const isShadowless = /\(shadowless\)/i.test(g.name);
    let shadowSetId = null;
    if (isShadowless){
      const baseName = g.name.replace(/\s*\(shadowless\)/i,"").trim();
      const bg = groups.find(x => x.name === baseName);
      shadowSetId = (bg && claim[bg.groupId]) ? claim[bg.groupId].setId : null;
    }
    let enr = 0, stand = 0, seal = 0;

    for (const p of products){
      const ext = {}; (p.extendedData||[]).forEach(d => ext[d.name] = d.value);
      const px = pm[p.productId]; if (!px) continue;
      if (!("Number" in ext)){                   // ---- SEALED (no card number) ----
        const kind = classifySealed(p.cleanName || p.name || "");
        if (!kind) continue;                     // unrecognized non-card product -> skip junk
        sealed.push({ id:`sl:${p.productId}`, n:(p.cleanName||p.name), s:setName, c:g.abbreviation||"",
          y:gyear, o:g.groupId, kind, sealed:true, r:"", num:"", t:[], st:[], atk:"",
          img:p.imageUrl||"", lang:"en", pid:p.productId, px });
        seal++; continue;
      }
      const num = num0(ext.Number);
      noteSize(setName, ext.Number);
      const name = p.name || "";
      if (isShadowless){                          // fold shadowless printings onto the base card
        const card = shadowSetId ? byId[`${shadowSetId}-${num}`] : null;
        // each folded printing keeps its own product id (p): the link must open the Shadowless product, not the base card
        if (card){ card.px = card.px || {}; for (const k in px) card.px["Shadowless " + k] = Object.assign({}, px[k], { p: p.productId }); if (!card.pid) card.pid = p.productId; if (!card.o) card.o = g.groupId; enr++; continue; }
        // no base match -> fall through and emit standalone below
      }
      let prefix = "";
      if (/master ?ball/i.test(name)) prefix = "Master Ball ";
      else if (/pok[eé] ?ball/i.test(name)) prefix = "Poké Ball ";

      const card = setId ? byId[`${setId}-${num}`] : null;
      if (card){                                // ---- JOINED: enrich pokemon-tcg-data card ----
        card.o = g.groupId;
        if (prefix){                            // special holo pattern -> add as its own printing(s)
          card.px = card.px || {};
          for (const k in px) card.px[prefix + k] = Object.assign({}, px[k], { p: p.productId });   // own product for the link
          if (!card.pid) card.pid = p.productId;
        } else {                                // the base product
          // Several products in a group can share a collector number (a later re-release, a
          // prerelease variant...). Last-writer-wins sent Base Set Charizard's link to product
          // 657516 while every other Base card sits at 42xxx. Prefer the product whose name IS
          // the card name; otherwise keep the first one seen instead of letting a stray win.
          const exact = pname(p.cleanName || name) === pname(card.n);
          if (card.pid == null || (exact && !card._pidExact)) { card.pid = p.productId; card._pidExact = exact; }
          card.px = Object.assign(px, card.px || {});   // keep any variant printings already attached
        }
        enr++;
      } else {                                  // ---- UNJOINED: emit straight from TCGCSV ----
        standalones.push({
          id: `tc:${p.productId}`, n: (p.cleanName || name), s: g.name, c: g.abbreviation || "",
          y: gyear, o: g.groupId, num, r: ext.Rarity || "", hp: ext.HP || "", t: [], st: [], atk: "",
          img: p.imageUrl || "", lang: "en", pid: p.productId, px
        });
        stand++;
      }
    }
    totalEnriched += enr; totalStandalone += stand; totalSealed += seal;
    if (stand && !enr) report.push(`${g.name}  (${stand} cards, no pokemon-tcg-data match)`);
  }

  console.log(`\nEN merge: ${totalEnriched} enriched · ${totalStandalone} TCGCSV-standalone · ${totalSealed} sealed`);
  if (report.length){
    console.log(`  groups served entirely from TCGCSV (promos/specials/unmatched):`);
    for (const line of report.slice(0, 40)) console.log(`   - ${line}`);
    if (report.length > 40) console.log(`   …and ${report.length - 40} more`);
  }
  return cards.concat(standalones, sealed);
}

async function japaneseCards(){
  const cat = await categoryId("Pokemon Japan");
  if (!cat){ console.log("JP: category not found, skipping"); return []; }
  const groups = (await getJSON(`${TC}/${cat}/groups`)).results;
  console.log(`\nJP: category ${cat}, ${groups.length} sets`);
  const cards = [];
  for (const g of groups){
    let products, prices;
    try {
      products = (await getJSON(`${TC}/${cat}/${g.groupId}/products`)).results; await sleep(SLEEP);
      prices   = (await getJSON(`${TC}/${cat}/${g.groupId}/prices`)).results;   await sleep(SLEEP);
    } catch { FAILED.push("JP " + g.name); continue; }
    const pm = priceMap(prices);
    const gyear = parseInt((g.publishedOn||"0").slice(0,4))||0;
    for (const p of products){
      const ext = {}; (p.extendedData||[]).forEach(d => ext[d.name] = d.value);
      const px = pm[p.productId]; if (!px) continue;
      // Vintage JP cards (Base through Neo, Gym, VS...) print no collector number, so no Number
      // does not mean sealed. Anything with card fields (Rarity/HP/Card Type) is still a single.
      const isCard = ext.Rarity || ext.HP || ext["Card Type"];
      noteSize(g.name, ext.Number);
      if (!("Number" in ext) && !isCard){
        const kind = classifySealed(p.cleanName || p.name || "");
        if (!kind) continue;
        cards.push({ id:`sl:${p.productId}`, n:(p.cleanName||p.name), s:g.name, c:g.abbreviation||"",
          y:gyear, o:g.groupId, kind, sealed:true, r:"", num:"", t:[], st:[], atk:"",
          img:p.imageUrl||"", lang:"jp", pid:p.productId, px });
        continue;
      }
      cards.push({ id:`jp:${p.productId}`, n:p.cleanName||p.name, s:g.name, c:g.abbreviation||"",
        y:gyear, o:g.groupId, num:ext.Number?num0(ext.Number):"", r:ext.Rarity||"",
        hp:ext.HP||"", t:[], st:[], atk:"", img:p.imageUrl||"", lang:"jp", pid:p.productId, px });
    }
  }
  return cards;
}

// Any single-category TCGCSV game (Lorcana, One Piece…) — identity + price straight from TCGCSV.
async function gameCards(catName, game, idPrefix){
  const cat = await categoryId(catName);
  if (!cat){ console.log(`${catName}: category not found, skipping`); return []; }
  const groups = (await getJSON(`${TC}/${cat}/groups`)).results;
  console.log(`\n${catName}: category ${cat}, ${groups.length} sets`);
  const cards = [];
  for (const g of groups){
    let products, prices;
    try {
      products = (await getJSON(`${TC}/${cat}/${g.groupId}/products`)).results; await sleep(SLEEP);
      prices   = (await getJSON(`${TC}/${cat}/${g.groupId}/prices`)).results;   await sleep(SLEEP);
    } catch { FAILED.push(catName + " " + g.name); continue; }
    const pm = priceMap(prices);
    const gyear = parseInt((g.publishedOn||"0").slice(0,4)) || 0;
    for (const p of products){
      const ext = {}; (p.extendedData||[]).forEach(d => ext[d.name] = d.value);
      const px = pm[p.productId]; if (!px) continue;
      if (!("Number" in ext)){
        const kind = classifySealed(p.cleanName || p.name || "");
        if (!kind) continue;
        cards.push({ id:`${idPrefix}:${p.productId}`, n:(p.cleanName||p.name), s:g.name, c:g.abbreviation||"",
          y:gyear, o:g.groupId, kind, sealed:true, game, r:"", num:"", t:[], st:[], atk:"",
          img:p.imageUrl||"", lang:"en", pid:p.productId, px });
        continue;
      }
      cards.push({ id:`${idPrefix}:${p.productId}`, n:p.cleanName||p.name, s:g.name, c:g.abbreviation||"",
        y:gyear, o:g.groupId, game, num:num0(ext.Number), r:ext.Rarity||"",
        hp:"", t:ext.Color?[ext.Color]:[], st:[], atk:"", img:p.imageUrl||"", lang:"en", pid:p.productId, px });
    }
  }
  return cards;
}
const lorcanaCards = () => gameCards("Lorcana", "lorcana", "lc");

// data.json as committed on or before `days` ago -> Map(id -> px). null outside git / no history.
function snapshot(days){
  try {
    const before = new Date(Date.now() - days * 864e5).toISOString();
    const sha = execSync(`git log -1 --format=%H --before="${before}" -- data.json`, { encoding: "utf8" }).trim();
    if (!sha) return null;
    const date = execSync(`git log -1 --format=%cs ${sha}`, { encoding: "utf8" }).trim();
    const d = JSON.parse(execSync(`git show ${sha}:data.json`, { encoding: "utf8", maxBuffer: 1 << 30 }));
    const m = new Map(); for (const c of d.cards || []) if (c.px) m.set(c.id, c.px);
    m.date = date; return m;
  } catch (e) { console.log("snapshot failed: " + e.message.split("\n")[0]); return null; }
}

// Compare against the data.json currently in the repo (yesterday's). A card is "lost" if its id is gone
// while it was worth >= $3 yesterday: prices do not fall from $3 to under the $1.50 floor overnight, so
// that is data loss, not the market. Ids survive set renames, so a renamed group is not a loss either.
function coverageProblems(kept){
  const out = [];
  if (FAILED.length > 3) out.push(`${FAILED.length} sets failed to download: ${FAILED.slice(0, 8).join(", ")}${FAILED.length > 8 ? " ..." : ""}`);
  else if (FAILED.length) console.log(`warning: ${FAILED.length} set(s) failed to download: ${FAILED.join(", ")}`);
  let prev; try { prev = JSON.parse(fs.readFileSync("data.json", "utf8")).cards || []; } catch { return out; }
  if (!prev.length) return out;
  const now = new Set(kept.map(c => c.id));
  const solid = prev.filter(c => bestPrice(c.px || {}) >= 3);
  const lost = solid.filter(c => !now.has(c.id));
  const seg = c => (c.game || "pkmn") === "pkmn" ? "Pokemon " + (c.lang || "en").toUpperCase() + (c.sealed ? " sealed" : "") : c.game;
  const count = (arr, f) => { const m = {}; for (const c of arr){ const k = f(c); m[k] = (m[k] || 0) + 1; } return m; };
  // Thresholds from replaying 30 days of real runs: normal churn (cards with no price that day) peaks
  // around 270 of ~29k $3+ cards (0.9%) and one Lorcana day at 12% of that segment.
  if (lost.length > solid.length * 0.03) out.push(`${lost.length} of ${solid.length} cards worth $3+ disappeared`);
  const sAll = count(solid, seg), sLost = count(lost, seg);
  for (const k in sLost) if (sAll[k] >= 200 && sLost[k] > sAll[k] * 0.2) out.push(`${k}: ${sLost[k]} of ${sAll[k]} cards worth $3+ disappeared`);
  // single sets come and go (renames, a new set's prices settling): log, don't fail
  const gAll = count(solid, c => seg(c) + " | " + c.s), gLost = count(lost, c => seg(c) + " | " + c.s);
  const sets = Object.keys(gLost).filter(k => gAll[k] >= 10 && gLost[k] > gAll[k] * 0.5);
  if (sets.length) console.log(`note: ${sets.length} set(s) lost over half their $3+ cards today: ${sets.slice(0, 8).map(k => `${k} (${gLost[k]}/${gAll[k]})`).join("; ")}`);
  return out;
}

(async () => {
  let updated; try { updated = await getText("https://tcgcsv.com/last-updated.txt"); } catch { updated = new Date().toISOString(); }
  console.log("TCGCSV last updated:", updated);

  let all = await englishCards();
  if (INCLUDE_JP) all = all.concat(await japaneseCards());
  if (INCLUDE_LORCANA) all = all.concat(await lorcanaCards());
  if (INCLUDE_ONEPIECE) all = all.concat(await gameCards("One Piece", "onepiece", "op"));

  const kept = all.filter(c => c.px && bestPrice(c.px) >= FLOOR);
  // The TCGplayer link is only as good as the product id, so say out loud how many joined cards
  // ended up on a product whose name is not the card name. Those are the ones that can open a
  // weird variant. Then drop the bookkeeping flag so it never reaches data.json.
  const joined = kept.filter(c => c.pid && !/^(tc|jp|lc|op|sl):/.test(c.id));
  const loose = joined.filter(c => !c._pidExact);
  console.log(`\nlink audit: ${joined.length} joined cards with a product id · ${loose.length} whose product name is not an exact match`);
  for (const c of loose.slice(0, 25)) console.log(`   ? ${c.s} #${c.num} ${c.n} -> product ${c.pid}`);
  if (loose.length > 25) console.log(`   …and ${loose.length - 25} more`);
  for (const c of all) delete c._pidExact;
  const en  = kept.filter(c => (c.game||"pkmn")==="pkmn" && c.lang === "en").length;
  const jp  = kept.filter(c => (c.game||"pkmn")==="pkmn" && c.lang === "jp").length;
  const lor = kept.filter(c => c.game === "lorcana").length;
  const op  = kept.filter(c => c.game === "onepiece").length;
  const sealedN = kept.filter(c => c.sealed).length;

  // ---- price trend: best price now vs the data.json committed ~7 and ~30 days ago (git history is the archive)
  for (const [key, days] of [["d7", 7], ["d30", 30]]){
    const old = snapshot(days); if (!old) { console.log(`trend ${key}: no snapshot that old in git history, skipped`); continue; }
    // Same printing on both days: the top-priced one with a real market price on both days. A price
    // equal to the low listing is a lone listing, not a trade (Base Charizard's $100k Shadowless 1st Ed),
    // so that card compares its Unlimited Holo instead.
    // Moves over 200% are almost always a data artifact on a thin card; show nothing rather than noise.
    const lone = v => !v || v.m == null || (v.l != null && Math.abs(v.m - v.l) < 0.005);
    let n = 0;
    for (const c of kept){
      const o = old.get(c.id); if (!o || !c.px) continue;
      let k = null, top = -1;
      for (const x in c.px){ const m = c.px[x].m; if (o[x] && !lone(c.px[x]) && !lone(o[x]) && m > top){ top = m; k = x; } }
      if (!k) continue;
      const pct = Math.round((c.px[k].m - o[k].m) / o[k].m * 100);
      if (Math.abs(pct) >= 1 && Math.abs(pct) <= 200){ c[key] = pct; n++; }
    }
    console.log(`trend ${key}: vs ${old.date}, ${n} cards moved >= 1%`);
  }

  // ---- loud-fail guard: never publish a catalog that silently lost a chunk of cards
  const problems = coverageProblems(kept);
  if (problems.length){
    console.log(`\n${FORCE ? "FORCED past" : "REFUSING to write data.json:"} ${problems.length} coverage problem(s)`);
    for (const p of problems) console.log("   x " + p);
    if (!FORCE){ console.log("\nIf this drop is real, re-run the Action manually with force = true."); process.exit(1); }
  }

  // ---- carry forward: a card whose product got NO price row today (TCGplayer gaps, mostly pricey
  // illiquid cards like Gold Stars) keeps yesterday's entry for up to 30 days, stamped `ps` = the date of
  // its last real price so the app can warn. Not carried: cards that are present but under the floor,
  // or whose product reappeared under a new id (set rename / newly joined).
  try {
    const prevOut = JSON.parse(fs.readFileSync("data.json", "utf8"));
    const prevDate = String(prevOut.updated || "").slice(0, 10);
    const priced = all.filter(c => c.px);   // pokemon-tcg-data cards are in `all` even with no price today
    const ids = new Set(priced.map(c => c.id)), pids = new Set(priced.map(c => c.pid).filter(Boolean));
    const cutoff = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    let carried = 0;
    for (const c of prevOut.cards || []){
      if (ids.has(c.id) || (c.pid && pids.has(c.pid))) continue;
      const ps = c.ps || prevDate;
      if (!ps || ps < cutoff) continue;
      const k = Object.assign({}, c, { ps }); delete k.d7; delete k.d30;
      kept.push(k); carried++;
    }
    console.log(`carried forward ${carried} cards with no price today (kept up to 30 days, flagged in the app)`);
  } catch (e) { console.log("carry-forward skipped: " + e.message.split("\n")[0]); }

  const sz = {}; for (const k in SZ) sz[k] = [...SZ[k]].sort((a,b)=>a-b);
  const out = { updated, floor: FLOOR, sz, cards: kept };
  fs.writeFileSync("data.json", JSON.stringify(out));
  console.log(`\nWrote data.json — ${kept.length} entries >= $${FLOOR} (Pkmn EN ${en} / JP ${jp}; Lorcana ${lor}; One Piece ${op}; ${sealedN} sealed) · ${Math.round(JSON.stringify(out).length/1048576*10)/10} MB`);
})();
