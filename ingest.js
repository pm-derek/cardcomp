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
const GH = "https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master";
const TC = "https://tcgcsv.com/tcgplayer";
const UA = "CardComp-Ingest/3.0 (East Bay Trader)";
const SLEEP = 120;
const FLOOR = 1.50;                 // keep only cards whose best printing >= this (USD)
const INCLUDE_JP = true;            // set false to skip Japanese
const INCLUDE_LORCANA = true;       // set false to skip Disney Lorcana
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

async function getJSON(url){
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error("HTTP " + res.status + " " + url);
  return res.json();
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
    let raw; try { raw = await getJSON(`${GH}/cards/en/${sm.id}.json`); } catch { continue; }
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
    } catch { continue; }
    const pm = priceMap(prices);
    const setId = claim[g.groupId] ? claim[g.groupId].setId : null;
    const gyear = parseInt((g.publishedOn||"0").slice(0,4)) || 0;
    let enr = 0, stand = 0, seal = 0;

    for (const p of products){
      const ext = {}; (p.extendedData||[]).forEach(d => ext[d.name] = d.value);
      const px = pm[p.productId]; if (!px) continue;
      if (!("Number" in ext)){                   // ---- SEALED (no card number) ----
        const kind = classifySealed(p.cleanName || p.name || "");
        if (!kind) continue;                     // unrecognized non-card product -> skip junk
        sealed.push({ id:`sl:${p.productId}`, n:(p.cleanName||p.name), s:g.name, c:g.abbreviation||"",
          y:gyear, o:g.groupId, kind, sealed:true, r:"", num:"", t:[], st:[], atk:"",
          img:p.imageUrl||"", lang:"en", pid:p.productId, px });
        seal++; continue;
      }
      const num = num0(ext.Number);
      const name = p.name || "";
      let prefix = "";
      if (/master ?ball/i.test(name)) prefix = "Master Ball ";
      else if (/pok[eé] ?ball/i.test(name)) prefix = "Poké Ball ";

      const card = setId ? byId[`${setId}-${num}`] : null;
      if (card){                                // ---- JOINED: enrich pokemon-tcg-data card ----
        card.o = g.groupId;
        if (prefix){                            // special holo pattern -> add as its own printing(s)
          card.px = card.px || {};
          for (const k in px) card.px[prefix + k] = px[k];
          if (!card.pid) card.pid = p.productId;
        } else {                                // the base product
          card.pid = p.productId;
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
    } catch { continue; }
    const pm = priceMap(prices);
    const gyear = parseInt((g.publishedOn||"0").slice(0,4))||0;
    for (const p of products){
      const ext = {}; (p.extendedData||[]).forEach(d => ext[d.name] = d.value);
      const px = pm[p.productId]; if (!px) continue;
      if (!("Number" in ext)){
        const kind = classifySealed(p.cleanName || p.name || "");
        if (!kind) continue;
        cards.push({ id:`sl:${p.productId}`, n:(p.cleanName||p.name), s:g.name, c:g.abbreviation||"",
          y:gyear, o:g.groupId, kind, sealed:true, r:"", num:"", t:[], st:[], atk:"",
          img:p.imageUrl||"", lang:"jp", pid:p.productId, px });
        continue;
      }
      cards.push({ id:`jp:${p.productId}`, n:p.cleanName||p.name, s:g.name, c:g.abbreviation||"",
        y:gyear, o:g.groupId, num:num0(ext.Number), r:ext.Rarity||"",
        hp:ext.HP||"", t:[], st:[], atk:"", img:p.imageUrl||"", lang:"jp", pid:p.productId, px });
    }
  }
  return cards;
}

// Disney Lorcana — same shape as the JP path, stamped game:"lorcana" (identity + price from TCGCSV).
async function lorcanaCards(){
  const cat = await categoryId("Lorcana");
  if (!cat){ console.log("Lorcana: category not found, skipping"); return []; }
  const groups = (await getJSON(`${TC}/${cat}/groups`)).results;
  console.log(`\nLorcana: category ${cat}, ${groups.length} sets`);
  const cards = [];
  for (const g of groups){
    let products, prices;
    try {
      products = (await getJSON(`${TC}/${cat}/${g.groupId}/products`)).results; await sleep(SLEEP);
      prices   = (await getJSON(`${TC}/${cat}/${g.groupId}/prices`)).results;   await sleep(SLEEP);
    } catch { continue; }
    const pm = priceMap(prices);
    const gyear = parseInt((g.publishedOn||"0").slice(0,4)) || 0;
    for (const p of products){
      const ext = {}; (p.extendedData||[]).forEach(d => ext[d.name] = d.value);
      const px = pm[p.productId]; if (!px) continue;
      if (!("Number" in ext)){
        const kind = classifySealed(p.cleanName || p.name || "");
        if (!kind) continue;
        cards.push({ id:`lc:${p.productId}`, n:(p.cleanName||p.name), s:g.name, c:g.abbreviation||"",
          y:gyear, o:g.groupId, kind, sealed:true, game:"lorcana", r:"", num:"", t:[], st:[], atk:"",
          img:p.imageUrl||"", lang:"en", pid:p.productId, px });
        continue;
      }
      cards.push({ id:`lc:${p.productId}`, n:p.cleanName||p.name, s:g.name, c:g.abbreviation||"",
        y:gyear, o:g.groupId, game:"lorcana", num:num0(ext.Number), r:ext.Rarity||"",
        hp:"", t:ext.Color?[ext.Color]:[], st:[], atk:"", img:p.imageUrl||"", lang:"en", pid:p.productId, px });
    }
  }
  return cards;
}

(async () => {
  let updated; try { updated = await getText("https://tcgcsv.com/last-updated.txt"); } catch { updated = new Date().toISOString(); }
  console.log("TCGCSV last updated:", updated);

  let all = await englishCards();
  if (INCLUDE_JP) all = all.concat(await japaneseCards());
  if (INCLUDE_LORCANA) all = all.concat(await lorcanaCards());

  const kept = all.filter(c => c.px && bestPrice(c.px) >= FLOOR);
  const en  = kept.filter(c => (c.game||"pkmn")==="pkmn" && c.lang === "en").length;
  const jp  = kept.filter(c => (c.game||"pkmn")==="pkmn" && c.lang === "jp").length;
  const lor = kept.filter(c => c.game === "lorcana").length;
  const sealedN = kept.filter(c => c.sealed).length;

  const out = { updated, floor: FLOOR, cards: kept };
  fs.writeFileSync("data.json", JSON.stringify(out));
  console.log(`\nWrote data.json — ${kept.length} entries >= $${FLOOR} (Pkmn EN ${en} / JP ${jp}; Lorcana ${lor}; ${sealedN} sealed) · ${Math.round(JSON.stringify(out).length/1048576*10)/10} MB`);
})();
